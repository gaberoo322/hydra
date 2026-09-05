/**
 * GLM dev-drainer bash↔TypeScript bridge (issue #4371).
 *
 * `scripts/glm/drainer-loop.sh` is bash and cannot import a TS module
 * directly. Until this change, the bridge program lived as a ~90-line
 * heredoc string inside `drainer-loop.sh` (`write_node_driver()`),
 * regenerated to a `/tmp` file on every tick — invisible to `tsc`, ast-grep,
 * and direct unit tests. This module hoists that program's LOGIC into a real,
 * committed, typechecked file (this one, inside `tsconfig.json`'s
 * `src/**\/*.ts` include, so the REQUIRED `npm run typecheck` covers it); the
 * thin CLI entrypoint lives at `scripts/glm/drainer-driver.ts` (the
 * `scripts/tier-classify.ts` → `src/tier-classifier.ts` precedent).
 *
 * `runDriverMode` NEVER throws (never-throw-from-verification convention,
 * CLAUDE.md) — every failure, including a rejecting dependency, is caught
 * into a `DriverOutcome` with `ok: false`. The entrypoint maps that to the
 * bash-facing `glm-drainer driver threw: ` stderr prefix + exit 1. For the
 * `glm-driver-fault` arm (a caught exception — an unexpected rejecting
 * dependency) the outcome also carries `stack`, populated the same way the
 * original heredoc's `main().catch((err) => ... err.stack ? err.stack :
 * String(err))` picked what to print — so the stderr text an on-call
 * engineer sees for that arm is unchanged. The `glm-driver-bad-argv` arm
 * (unknown mode / missing positional arg) was never a thrown `Error` in the
 * new never-throw design — it is a synthesized `DriverOutcome`, not a caught
 * exception — so it has no stack to carry; that arm's stderr text is exactly
 * `message`, same as before.
 *
 * Every mode's SUCCESSFUL outcome (`ok: true`) carries exactly one JSON line
 * to print on stdout — the driver-level exit code is independent of the
 * verdict that line carries (e.g. a blocked preflight is a completed check,
 * not a driver fault):
 *
 *   - `heartbeat` — `setGlmDrainerHeartbeat()` → line is its result, exit
 *     code is `0` iff `ok: true`, else `1`.
 *   - `preflight <changed-files-file>` — read/trim/blank-filter the file,
 *     `preflightBeforePr({changedPaths})` → line is its result, exit `0`
 *     regardless of verdict.
 *   - `author <prompt-file> <cwd>` — `buildGlmEnv`/`buildDrainerArgs` failure
 *     short-circuits to `{ok:false,code,message}` with NO spawn; otherwise
 *     `runGlmClaude` runs and the line is `{ok:true,code,stdout,stderr}` with
 *     stdout/stderr tail-truncated to the last 4000 chars. Exit `0` either
 *     way (a driver fault is a DIFFERENT thing from an authoring failure the
 *     caller already reads via `.ok`/`.code`).
 *
 * Imports are static and relative (`.ts`-suffixed, per repo convention —
 * `rewriteRelativeImportExtensions` resolves them) rather than the original
 * heredoc's template-literal `import(\`${REPO_ROOT}/...\`)` — those were
 * opaque to tsc/knip/ast-grep, exactly the invisibility this issue removes.
 * Import time stays side-effect free: `getRedisConnection()` is a lazy
 * singleton (`src/redis/connection.ts`) and `drainer-runner.ts` is pure, so
 * `heartbeat` mode never spawns a process and `author`/`preflight` never open
 * a Redis connection — the same isolation the dynamic imports gave, now
 * visible to static analysis.
 */

import { readFileSync } from "node:fs";

import { logger } from "../logger.ts";
import { setGlmDrainerHeartbeat } from "../redis/autopilot.ts";
import {
  buildDrainerArgs,
  buildGlmEnv,
  GLM_API_TIMEOUT_MS,
  preflightBeforePr,
  runGlmClaude,
  type DrainerArgsResult,
  type GlmEnvResult,
  type PreflightOptions,
} from "./drainer-runner.ts";
import { defaultClaudeSpawn, type SpawnFn } from "../claude-cli/exec.ts";

/**
 * Type guards for the two `ok: boolean`-discriminated result unions this
 * module reads a failure arm from. The orchestrator's `tsconfig.json` runs
 * `strict: false` (no `strictNullChecks`), so a plain `if (!result.ok)` does
 * NOT narrow a union on a boolean discriminant (it narrows string-literal and
 * user-guard discriminators only) — mirrors the `isGhFailure`/`isGhOk`
 * pattern documented in `src/github/exec.ts`.
 */
function isEnvFailure(
  r: GlmEnvResult,
): r is Extract<GlmEnvResult, { ok: false }> {
  return r.ok === false;
}
function isArgsFailure(
  r: DrainerArgsResult,
): r is Extract<DrainerArgsResult, { ok: false }> {
  return r.ok === false;
}

/** Injected seam so every mode is unit-testable with no live Redis/spawn. */
export interface DriverDeps {
  setGlmDrainerHeartbeat: typeof setGlmDrainerHeartbeat;
  preflightBeforePr: (options: PreflightOptions) => ReturnType<typeof preflightBeforePr>;
  buildGlmEnv: typeof buildGlmEnv;
  buildDrainerArgs: typeof buildDrainerArgs;
  runGlmClaude: typeof runGlmClaude;
  spawn: SpawnFn;
  readFile: (path: string) => string;
  env: NodeJS.ProcessEnv;
  apiTimeoutMs: number;
}

/** Real dependencies — what the committed CLI entrypoint uses. */
export const defaultDriverDeps: DriverDeps = {
  setGlmDrainerHeartbeat,
  preflightBeforePr,
  buildGlmEnv,
  buildDrainerArgs,
  runGlmClaude,
  spawn: defaultClaudeSpawn,
  readFile: (path: string) => readFileSync(path, "utf8"),
  env: process.env,
  apiTimeoutMs: GLM_API_TIMEOUT_MS,
};

export type DriverOutcome =
  | { ok: true; line: string; exitCode: 0 | 1 }
  | {
      ok: false;
      code: "glm-driver-bad-argv" | "glm-driver-fault";
      message: string;
      /**
       * Only set for `glm-driver-fault` (a genuinely caught exception). The
       * CLI entrypoint prefers this over `message` when present, matching
       * the original heredoc's `err && err.stack ? err.stack : String(err)`
       * stderr text byte-for-byte for that arm. `glm-driver-bad-argv` never
       * sets it — that arm was never a thrown `Error` under the new
       * never-throw design, so there is no stack to carry.
       */
      stack?: string;
    };

/**
 * Type guard narrowing a `DriverOutcome` to its failure arm — the CLI
 * entrypoint (`scripts/glm/drainer-driver.ts`) needs it for the same
 * `strict: false` reason documented on {@link isEnvFailure} above: a plain
 * `if (outcome.ok) {...} else {...}` does not narrow `outcome.message` in
 * the `else` branch.
 */
export function isDriverFailure(
  outcome: DriverOutcome,
): outcome is Extract<DriverOutcome, { ok: false }> {
  return outcome.ok === false;
}

/**
 * Run one driver mode. `argv[0]` is the mode; the rest are mode-specific
 * positional args (mirrors `process.argv.slice(2)` from the CLI entrypoint).
 *
 * Never throws — a bad-argv condition or a rejecting dependency both resolve
 * to `{ok:false, code, message}` rather than propagating.
 */
export async function runDriverMode(
  argv: readonly string[],
  deps: DriverDeps = defaultDriverDeps,
): Promise<DriverOutcome> {
  try {
    const mode = argv[0];

    if (mode === "heartbeat") {
      const r = await deps.setGlmDrainerHeartbeat();
      return { ok: true, line: JSON.stringify(r), exitCode: r.ok ? 0 : 1 };
    }

    if (mode === "preflight") {
      const changedFilesPath = argv[1];
      if (!changedFilesPath) {
        return {
          ok: false,
          code: "glm-driver-bad-argv",
          message: "preflight mode requires <changed-files-file>",
        };
      }
      const changedPaths = deps
        .readFile(changedFilesPath)
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      const r = await deps.preflightBeforePr({ changedPaths });
      // The CHECK completing is success at the driver level, regardless of
      // the verdict it carries (ok:true vs ok:false — a blocked diff is a
      // valid, completed preflight result, not a driver fault).
      return { ok: true, line: JSON.stringify(r), exitCode: 0 };
    }

    if (mode === "author") {
      const promptPath = argv[1];
      const cwd = argv[2];
      if (!promptPath || !cwd) {
        return {
          ok: false,
          code: "glm-driver-bad-argv",
          message: "author mode requires <prompt-file> <cwd>",
        };
      }
      const prompt = deps.readFile(promptPath);

      const envResult = deps.buildGlmEnv(deps.env);
      if (isEnvFailure(envResult)) {
        return {
          ok: true,
          line: JSON.stringify({ ok: false, code: envResult.code, message: envResult.message }),
          exitCode: 0,
        };
      }
      const argsResult = deps.buildDrainerArgs({ prompt });
      if (isArgsFailure(argsResult)) {
        return {
          ok: true,
          line: JSON.stringify({ ok: false, code: argsResult.code, message: argsResult.message }),
          exitCode: 0,
        };
      }
      const run = await deps.runGlmClaude(deps.spawn, "claude", argsResult.args, deps.apiTimeoutMs, {
        env: envResult.env,
        cwd,
      });
      return {
        ok: true,
        line: JSON.stringify({
          ok: true,
          code: run.code,
          // Truncated: this is a log/diagnostic surface, not the source of
          // truth for what the session did (that's the git diff + the
          // .glm-drainer-pr-body.md file it was told to write).
          stdout: run.stdout.slice(-4000),
          stderr: run.stderr.slice(-4000),
        }),
        exitCode: 0,
      };
    }

    return {
      ok: false,
      code: "glm-driver-bad-argv",
      message: `unknown mode: ${String(mode)}`,
    };
  } catch (err) {
    // Fail loud (CLAUDE.md): this is the never-throw boundary for the whole
    // driver, so a rejecting dependency or unexpected exception must be
    // logged here — nothing upstream of runDriverMode ever sees the raw err.
    logger.error(
      { err },
      "[glm-drainer/driver] runDriverMode threw — surfacing as glm-driver-fault",
    );
    return {
      ok: false,
      code: "glm-driver-fault",
      message: err instanceof Error ? err.message : String(err),
      // Matches the original heredoc's `err && err.stack ? err.stack :
      // String(err)` fallback exactly, so the CLI entrypoint's stderr output
      // for this arm is unchanged.
      stack: err instanceof Error && err.stack ? err.stack : String(err),
    };
  }
}
