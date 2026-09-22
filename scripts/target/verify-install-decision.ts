/**
 * verify-install-decision.ts — the pure decision leaf behind
 * hydra-target-build Step 6's "does this Target worktree need a LOCAL npm
 * install?" question (issue #4526, design-concept INV-3/INV-6).
 *
 * # Why decided from the build RESULT, not a pre-probe
 *
 * #4177 removed the per-worktree `npm ci` on the grounds that Node's ancestor
 * node_modules walk resolves a worktree nested under the app dir. That holds
 * for Node — but NOT for every tool: a bundler may pin its resolution root to
 * the project directory (CSB's Next.js/Turbopack `next build` inside
 * `web/.worktrees/<id>` cannot see the serving tree's node_modules even
 * though `require.resolve` from the same cwd succeeds). A resolution PROBE
 * therefore passes exactly when the build fails, so the build's own exit code
 * + output is the only generic ground truth. This leaf turns that result into
 * one of four actions; the playbook only invokes it (never re-derives the
 * decision in bash).
 *
 * # The two triggers (INV-4 — at most ONE install per Step-6 pass)
 *
 *   1. lockfile-diff (the #4177 trigger, kept): the diff touches
 *      package.json/package-lock.json → install BEFORE typecheck/test/build.
 *   2. result-driven (#4526): the FIRST build failed with a module-resolution
 *      signature AND no worktree-local node_modules exists → install, then
 *      re-run ONLY the build, once. After that install a local node_modules
 *      exists, so the leaf can never return `install-then-retry` again for
 *      this pass — the once-only bound is structural, not a loop counter.
 *      Typecheck/test are not re-run on this path: the lockfile is unchanged
 *      (a changed lockfile took trigger 1), so the resolved dependency set is
 *      identical; only the resolver root differed.
 *
 * # The #4175 incident class is the FIRST rule
 *
 * If the worktree-local node_modules path is a SYMLINK, the answer is
 * `abort` — never `install` — regardless of the lockfile or the build
 * output. `npm ci` through a symlink writes through it into the serving tree
 * and wipes it (the 2026-08-19 incident). Step 0.6 never creates such a
 * symlink; a stale pre-#4177 one must abort the build, not install.
 *
 * An install itself is safe in the non-symlink case: npm installs into the
 * nearest package.json directory from cwd and never walks up, so it can only
 * create/write the worktree-local `$TARGET_WT/$APP_SUBDIR/node_modules`.
 *
 * # Shape (INV-6)
 *
 * Pure + stdlib-only (node:fs / node:path / node:process, plus the
 * `node:util`-only shared CLI-arg seam `src/cli-args.ts`, issue #4565) so it
 * ships in the gate mirror (scripts/sync-target-gate.sh GATE_FILES) and runs from
 * `$HYDRA_GATE_DIR` with plain `node` type stripping. Never throws for bad
 * input — CLI usage errors exit 2; every decided outcome is a single-line
 * JSON `{action, reason}` on stdout with exit 0, so the playbook captures it
 * with `$( … | jq -r '.action')`.
 */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCliArgs } from "../../src/cli-args.ts";

/**
 * The module-resolution failure signature: every resolver/bundler phrasing
 * Node, webpack/Next, and Vite emit when an import cannot be RESOLVED (as
 * opposed to a bad relative path in the target's own code). Matched
 * case-insensitively against the captured build output.
 */
export const MODULE_RESOLUTION_SIGNATURE =
  /Module not found|Cannot find module|ERR_MODULE_NOT_FOUND|Can't resolve|Could not find the Next\.js package/i;

/** Inputs to the install decision. All booleans are exact, never truthy. */
export interface InstallDecisionInput {
  /** The diff touches package.json / package-lock.json (the #4177 trigger). */
  lockfileChanged: boolean;
  /**
   * A REAL install exists in the worktree-local node_modules — never merely
   * "the directory exists" (issue #4533). A tool-cache-only node_modules
   * (e.g. holding only `.vite`, `.vite-temp`, `.cache`) must read as
   * `false`: {@link probeNodeModules} is the sole producer of this value.
   */
  localNodeModulesPresent: boolean;
  /** That node_modules path is a SYMLINK — the #4175 shape. Abort, never install. */
  localNodeModulesIsSymlink: boolean;
  /** The build's exit code; `null` when the build has not run yet. */
  buildExitCode: number | null;
  /** The captured build output (stdout+stderr). */
  buildOutput: string;
}

/** The decision. `reason` is one operator-readable line for logs/PR bodies. */
export interface InstallDecision {
  action: "proceed" | "install-then-retry" | "fail" | "abort";
  reason: string;
}

/**
 * Decide whether a Target worktree needs a local install, and what to do
 * about the build result. Pure: no fs, no env, no clock — the CLI wrapper
 * gathers the filesystem facts. Order is load-bearing:
 *
 *   1. symlink            → abort   (safety outranks everything, #4175)
 *   2. lockfileChanged    → install-then-retry (pre-typecheck, #4177)
 *   3. build green        → proceed
 *   4. build not yet run  → proceed (defer to the build result)
 *   5. build red          → install-then-retry ONLY on the resolution
 *                           signature with no local node_modules; else fail
 */
export function decideLocalInstall(input: InstallDecisionInput): InstallDecision {
  // 1. The #4175 serving-tree wipe class. Must outrank the lockfile trigger:
  // a changed lockfile makes an install MORE likely, which is exactly when
  // installing through a stale symlink would be catastrophic.
  if (input.localNodeModulesIsSymlink) {
    return {
      action: "abort",
      reason:
        "worktree-local node_modules is a SYMLINK — an install would write through it into the serving tree (the #4175 incident class); remove the stale link by hand",
    };
  }

  // 2. The lockfile-diff trigger (#4177, kept): install up front, before
  // typecheck/test/build, so the whole ladder runs against the declared
  // dependency set.
  if (input.lockfileChanged) {
    return {
      action: "install-then-retry",
      reason:
        "package.json/package-lock.json changed in this diff — install once before typecheck/test/build (issue #4177)",
    };
  }

  // 3. Green build: nothing to do.
  if (input.buildExitCode === 0) {
    return { action: "proceed", reason: "build passed — no local install needed" };
  }

  // 4. Build not run yet (the pre-typecheck call): no lockfile trigger, so
  // defer to the build result.
  if (input.buildExitCode === null) {
    return {
      action: "proceed",
      reason: "lockfile unchanged and build not yet run — defer to the build result",
    };
  }

  // 5. Red build: only a module-resolution failure with NO local
  // node_modules means an install would change the outcome.
  if (
    !input.localNodeModulesPresent &&
    MODULE_RESOLUTION_SIGNATURE.test(input.buildOutput)
  ) {
    return {
      action: "install-then-retry",
      reason:
        "build failed with module-resolution errors and no worktree-local node_modules exists — install once (worktree-local only) and re-run the build",
    };
  }
  if (input.localNodeModulesPresent) {
    return {
      action: "fail",
      reason:
        "build failed and a worktree-local node_modules already exists — a fresh install would not change the resolution; treat as a real build failure",
    };
  }
  return {
    action: "fail",
    reason:
      "build failed without the module-resolution signature — a local install would not change the outcome; treat as a real build failure",
  };
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

/** Usage text printed on -h / usage errors (stderr on error, exit 2). */
const USAGE = `verify-install-decision.ts — decide whether a Target worktree needs a local npm install (issue #4526)

Usage:
  verify-install-decision.ts --app-dir <dir> [--lockfile-changed true|false]
                             [--build-exit <code|none>] [--build-log <file>]

  --app-dir          the worktree app dir ($TARGET_WT/$APP_SUBDIR); the wrapper
                     probes <app-dir>/node_modules presence + symlink itself.
  --lockfile-changed whether the diff touches package.json/package-lock.json
                     (default false).
  --build-exit       the build exit code, or 'none' (default) when the build
                     has not run yet.
  --build-log        file holding the captured build output; REQUIRED whenever
                     --build-exit is a non-zero code.

Output: one JSON line {action, reason} on stdout; exit 0 for every decided
outcome (the action carries the verdict), exit 2 on a usage error.`;

interface CliArgs {
  appDir: string;
  lockfileChanged: boolean;
  buildExitCode: number | null;
  buildLog: string | null;
  /** `-h` / `--help` was passed — main() prints USAGE and exits 0. */
  help: boolean;
}

/**
 * Parse argv into {@link CliArgs}. Pure (issue #4565): returns a result union
 * and never prints or exits — main() prints the error + USAGE and exits 2 on
 * any bad shape. Flag mechanics come from the shared `src/cli-args.ts` seam;
 * the true|false / int|none coercion and cross-flag validation stay local.
 */
function parseArgs(argv: string[]): { ok: true; args: CliArgs } | { ok: false; error: string } {
  const parsed = parseCliArgs(argv, {
    "app-dir": { type: "string" },
    "lockfile-changed": { type: "string" },
    "build-exit": { type: "string" },
    "build-log": { type: "string" },
    help: { type: "boolean", short: "h" },
  });
  if (parsed.ok === false) return parsed;
  const v = parsed.values;
  const args: CliArgs = {
    appDir: v["app-dir"] ?? "",
    lockfileChanged: false,
    buildExitCode: null,
    buildLog: v["build-log"] ?? null,
    help: v.help === true,
  };
  if (args.help) return { ok: true, args };

  const lockfile = v["lockfile-changed"];
  if (lockfile !== undefined) {
    if (lockfile !== "true" && lockfile !== "false") {
      return { ok: false, error: `--lockfile-changed must be true|false (got '${lockfile}')` };
    }
    args.lockfileChanged = lockfile === "true";
  }

  const buildExit = v["build-exit"];
  if (buildExit !== undefined && buildExit !== "none") {
    const code = Number.parseInt(buildExit, 10);
    if (!Number.isInteger(code) || code < 0) {
      return {
        ok: false,
        error: `--build-exit must be an integer exit code or 'none' (got '${buildExit}')`,
      };
    }
    args.buildExitCode = code;
  }

  if (!args.appDir || !isAbsolute(args.appDir)) {
    return { ok: false, error: "--app-dir <absolute dir> is required" };
  }
  if (args.buildExitCode !== null && args.buildExitCode !== 0 && args.buildLog === null) {
    return {
      ok: false,
      error:
        "--build-log is required when --build-exit is a non-zero code (the decision reads the resolver signature from the captured output)",
    };
  }
  return { ok: true, args };
}

/**
 * Package-manager marker files that indicate a real install even though
 * they are dot-prefixed (issue #4533). npm/pnpm/yarn all also materialise
 * ordinary (non-dot) top-level package dirs, but a from-scratch install with
 * zero dependencies would otherwise leave a node_modules holding only one of
 * these — still a real install, and still meant to make the once-only
 * install bound (INV-4/INV-6) structural rather than a loop counter.
 */
export const INSTALL_MARKERS = [
  ".package-lock.json",
  ".modules.yaml",
  ".yarn-integrity",
  ".yarn-state.yml",
];

/**
 * Probe `<appDir>/node_modules`: present? symlink? Never throws.
 *
 * `present` means "a real install exists here", never merely "the directory
 * exists" (issue #4533, INV-1). A directory holding only dot-prefixed
 * tool-cache entries — `.vite`, `.vite-temp`, `.cache/jiti` — is exactly the
 * shape a `test`/`typecheck` rung leaves behind before the `build` rung ever
 * runs, and must read as `present: false` so a genuinely missing install
 * still triggers `install-then-retry`.
 *
 * The #4175 symlink safety rule stays FIRST and untouched: `lstat` (never
 * `stat`) sees the link itself, so a symlink — dangling or not — short-
 * circuits to `{present: true, isSymlink: true}` without ever `readdir`-ing
 * through it. `readdirSync` only ever runs against a confirmed real
 * directory. Any other odd shape (a plain file at `node_modules`, or an
 * unreadable directory) resolves to the conservative `present: true` — the
 * probe can only ever push the decision toward `fail`, never toward a new
 * `install`.
 */
export function probeNodeModules(appDir: string): {
  present: boolean;
  isSymlink: boolean;
} {
  const nodeModulesPath = join(appDir, "node_modules");
  let st;
  try {
    st = lstatSync(nodeModulesPath);
  } catch {
    return { present: false, isSymlink: false };
  }
  if (st.isSymbolicLink()) {
    return { present: true, isSymlink: true };
  }
  if (!st.isDirectory()) {
    // A plain file or other non-directory occupying node_modules is odd;
    // the conservative answer is 'present' so this can only ever fail, not
    // trigger a fresh install.
    return { present: true, isSymlink: false };
  }
  let entries: string[];
  try {
    entries = readdirSync(nodeModulesPath);
  } catch {
    // Unreadable directory (e.g. EACCES) — conservative 'present'.
    return { present: true, isSymlink: false };
  }
  const hasRealInstall = entries.some(
    (name) => !name.startsWith(".") || INSTALL_MARKERS.includes(name),
  );
  return { present: hasRealInstall, isSymlink: false };
}

/** Read the build log; a missing file is a loud usage error (never a silent "" decided on). */
function readBuildLog(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch (err) {
    process.stderr.write(
      `verify-install-decision: cannot read --build-log '${path}': ${(err as Error).message}\n`,
    );
    process.exit(2);
  }
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.ok === false) {
    process.stderr.write(`verify-install-decision: ${parsed.error}\n${USAGE}\n`);
    process.exit(2);
  }
  const args = parsed.args;
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  const probe = probeNodeModules(args.appDir);
  const decision = decideLocalInstall({
    lockfileChanged: args.lockfileChanged,
    localNodeModulesPresent: probe.present,
    localNodeModulesIsSymlink: probe.isSymlink,
    buildExitCode: args.buildExitCode,
    buildOutput: args.buildLog === null ? "" : readBuildLog(args.buildLog),
  });
  process.stdout.write(`${JSON.stringify(decision)}\n`);
}

// Run as CLI only when executed directly (not imported by the test suite).
const invokedAs = process.argv[1]
  ? fileURLToPath(import.meta.url) === process.argv[1] ||
    fileURLToPath(import.meta.url).endsWith(process.argv[1])
  : false;
if (invokedAs) {
  main();
}
