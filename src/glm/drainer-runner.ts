/**
 * GLM dev-drainer spawn wrapper (issue #3688, ADR-0032).
 *
 * The **dev-drainer** authors a bounded slice of `dev_orch` work on z.ai's
 * independent quota instead of Anthropic's subscription quota. This module is
 * the *spawn path* half of that lane: it builds the fenced environment, builds
 * the `claude` argv (pinned to the drainer `--settings` file), runs the
 * subprocess, and gates the run's output through the **pre-PR preflight** that
 * must abort before `gh pr create`.
 *
 * It deliberately mirrors `src/vlm/claude-cli-runner.ts` rather than importing
 * it: that leaf's `runClaude` hardcodes its spawn options and exposes no `env`
 * / `cwd` seam, and the whole point here is the environment override. The two
 * copies stay signature-compatible (`(spawnImpl, bin, args, timeoutMs, …)`) as
 * a named convergence target, exactly as that file does with the betting
 * fetcher.
 *
 * ADR-0032 invariants this module implements:
 *
 *   - **Invariant 4 (precise mechanism)** — `ANTHROPIC_BASE_URL` +
 *     `ANTHROPIC_AUTH_TOKEN` (never `ANTHROPIC_API_KEY`, never the Codex
 *     plugin), plus an explicitly-spelled `glm-*` model name — the base-URL
 *     override alone does NOT redirect an Anthropic slot alias (see
 *     `GLM_MODEL`). The env arrives from a systemd
 *     `EnvironmentFile`; `buildGlmEnv` reads only the base env object handed to
 *     it and NEVER loads a dotenv — `.env.local` reproduces the paper-LLM
 *     MODEL-override gotcha where a dotenv silently overrode `ExecStart` flags.
 *   - **Invariant 7 (fail-closed credentials)** — `ANTHROPIC_AUTH_TOKEN` has no
 *     default. An absent/blank token returns a `glm-auth-token-missing` result
 *     so the caller aborts, rather than silently falling back to Anthropic
 *     quota. The token value never appears in a log line, an argv entry, or an
 *     error message produced here.
 *   - **Invariant 8 (two-layer secret fence)** — the *input* side is
 *     `config/glm/drainer-settings.json`, whose fence is a **scoped
 *     `permissions.allow` list** under headless deny-by-default (a bare `Bash`
 *     grant would defeat every `Read(...)` deny rule, since those constrain the
 *     Read tool only — see that file's `_comment`); the *output* side is
 *     `preflightBeforePr`, which runs `scripts/ci/secret-scan.sh` over the diff
 *     AND rejects any Verifier-Core / T4 path, so the drainer can never author a
 *     fenced-out change.
 *
 * Nothing here throws: every failure mode is a discriminated result object, per
 * the never-throw-from-verification convention. `runGlmClaude` is the single
 * exception-shaped seam and it *rejects* (never throws synchronously), matching
 * the `runClaude` contract it mirrors.
 */

import { runClaudeCli, type SpawnFn } from "../claude-cli/exec.ts";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { execWithGroupCleanup } from "../exec-with-timeout.ts";
import { classifyChange } from "../tier-classifier.ts";
import { matchVerifierCore } from "../untouchable.ts";

/** Repo root, derived from this module's location (`src/glm/` → `../..`). */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * z.ai's Anthropic-compatible endpoint (ADR-0032 Decision 2). Overriding
 * `ANTHROPIC_BASE_URL` is the ONLY mechanism that moves authoring load off
 * Anthropic's quota — the Codex-plugin path cannot apply it.
 */
export const GLM_ANTHROPIC_BASE_URL = "https://api.z.ai/api/anthropic";

/**
 * `API_TIMEOUT_MS` handed to the CLI (50 min). GLM on z.ai is materially
 * slower per turn than Sonnet on Anthropic, and a drainer run is a full
 * headless authoring session, so the CLI's own per-request deadline is raised
 * well above its default. The wall-clock kill in `runGlmClaude` is the real
 * backstop.
 */
export const GLM_API_TIMEOUT_MS = 3_000_000;

/**
 * The model name handed to `claude --model`, and the load-bearing half of the
 * routing decision (issue #3758).
 *
 * ADR-0032 Decision 2 originally specified the **Sonnet slot** on the theory
 * that `ANTHROPIC_BASE_URL` redirects whatever the CLI is asked for. Measured
 * against the live endpoint, it does not: the CLI resolves an Anthropic slot
 * alias (`sonnet` / `opus` / `haiku`) locally to a first-party model id and
 * sends the request to **Anthropic**, ignoring the base-URL override — burning
 * the very quota this lane exists to relieve, at metered USD. Only an
 * explicitly-spelled `glm-*` name reaches z.ai.
 *
 * So the model name is a fence, not a preference. `assertGlmModel` enforces it.
 */
export const GLM_MODEL = "glm-5.2";

/**
 * Anthropic slot aliases. Passing one of these to a base-URL-overridden run is
 * the #3758 defect — it silently routes first-party instead of to z.ai.
 */
const ANTHROPIC_SLOT_ALIASES: readonly string[] = Object.freeze([
  "sonnet",
  "opus",
  "haiku",
]);

/**
 * Reject any model name that would route to Anthropic rather than z.ai.
 *
 * Returns a result rather than throwing, per the never-throw-from-verification
 * convention. Callers abort the run on `ok: false` — a misrouted run is worse
 * than no run, because it spends the quota the drainer exists to protect.
 */
export function assertGlmModel(
  model: string,
): { ok: true } | { ok: false; code: "glm-model-would-route-first-party"; message: string } {
  const normalized = model.trim().toLowerCase();
  if (normalized.startsWith("glm-")) return { ok: true };
  const alias = ANTHROPIC_SLOT_ALIASES.includes(normalized)
    ? ` "${normalized}" is an Anthropic slot alias.`
    : "";
  return {
    ok: false,
    code: "glm-model-would-route-first-party",
    message:
      `Refusing to run the GLM drainer with model "${model}": the base-URL override ` +
      `does NOT redirect a non-glm model name — the CLI resolves it locally and calls ` +
      `Anthropic, burning the quota this lane exists to relieve (issue #3758).${alias} ` +
      `Pass an explicit glm-* name, e.g. "${GLM_MODEL}".`,
  };
}

/** Repo-relative path of the drainer settings file (input-side secret fence). */
export const DRAINER_SETTINGS_RELATIVE_PATH = "config/glm/drainer-settings.json";

/** Absolute path of the drainer settings file, for `claude --settings`. */
export const DRAINER_SETTINGS_PATH = join(REPO_ROOT, DRAINER_SETTINGS_RELATIVE_PATH);

/** Repo-relative path of the output-side secret scanner. */
const SECRET_SCAN_RELATIVE_PATH = "scripts/ci/secret-scan.sh";

/**
 * Environment variables that must NEVER survive into the drainer's env.
 *
 * `ANTHROPIC_API_KEY` is the load-bearing one: if it leaked through, the CLI
 * could authenticate against Anthropic and quietly burn the very quota this
 * lane exists to relieve (and, on a metered key, real USD). Stripping it makes
 * the base-URL override fail-closed rather than fail-over.
 */
export const STRIPPED_ENV_KEYS: readonly string[] = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN_FILE",
]);

/**
 * Re-exported from the Claude CLI Adapter (`src/claude-cli/exec.ts`), the seam
 * that owns the one `node:child_process` import for the `claude` binary — so
 * existing importers need no edit (issue #3703, INV-6).
 */
export type { SpawnFn };

export type GlmEnvResult =
  | { ok: true; env: NodeJS.ProcessEnv }
  | { ok: false; code: "glm-auth-token-missing"; message: string };

/**
 * Build the fenced GLM environment from a base env (in production: the process
 * env systemd populated from an off-git `EnvironmentFile`).
 *
 * Fail-closed: a missing or blank `ANTHROPIC_AUTH_TOKEN` returns a failure
 * result — there is no default and no fallback. The returned message names the
 * variable but never its value.
 *
 * The input object is never mutated; a shallow copy is returned.
 */
export function buildGlmEnv(baseEnv: NodeJS.ProcessEnv = process.env): GlmEnvResult {
  const rawToken = baseEnv.ANTHROPIC_AUTH_TOKEN;
  const token = typeof rawToken === "string" ? rawToken.trim() : "";
  if (!token) {
    return {
      ok: false,
      code: "glm-auth-token-missing",
      message:
        "ANTHROPIC_AUTH_TOKEN is unset or blank — refusing to run the GLM drainer " +
        "(fail-closed: an absent token must abort, never fall back to Anthropic quota). " +
        "Supply it via the systemd EnvironmentFile, never .env.local.",
    };
  }

  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of STRIPPED_ENV_KEYS) {
    delete env[key];
  }
  env.ANTHROPIC_BASE_URL = GLM_ANTHROPIC_BASE_URL;
  env.ANTHROPIC_AUTH_TOKEN = token;
  env.API_TIMEOUT_MS = String(GLM_API_TIMEOUT_MS);
  return { ok: true, env };
}

export interface DrainerArgsSpec {
  /** The headless prompt handed to `claude -p`. */
  prompt: string;
  /** Absolute path to the drainer settings file. Defaults to the repo copy. */
  settingsPath?: string;
  /**
   * Model name. Defaults to {@link GLM_MODEL}. Must be an explicit `glm-*`
   * name — an Anthropic slot alias routes first-party and is rejected (#3758).
   */
  model?: string;
  /** Extra argv appended verbatim (the drainer loop's own flags). */
  extraArgs?: readonly string[];
}

export type DrainerArgsResult =
  | { ok: true; args: string[] }
  | { ok: false; code: "glm-model-would-route-first-party"; message: string };

/**
 * Build the `claude` argv for a drainer run.
 *
 * `--settings` is always present and always first among the flags: it is the
 * input-side half of the two-layer secret fence (ADR-0032 invariant 8), so a
 * run that somehow lost it must be visibly malformed rather than silently
 * unfenced. The auth token is NEVER an argv entry — argv is world-readable via
 * `/proc/<pid>/cmdline`; the token travels in the environment only.
 *
 * Returns a result rather than a bare argv because the model name is a routing
 * fence (#3758): building argv that would silently spend Anthropic quota is a
 * failure the caller must see, not a default it can drift past.
 */
export function buildDrainerArgs(spec: DrainerArgsSpec): DrainerArgsResult {
  const model = spec.model ?? GLM_MODEL;
  const modelCheck = assertGlmModel(model);
  if (modelCheck.ok !== true) {
    return { ok: false, code: modelCheck.code, message: modelCheck.message };
  }
  return {
    ok: true,
    args: [
      "--settings",
      spec.settingsPath ?? DRAINER_SETTINGS_PATH,
      "--model",
      model,
      ...(spec.extraArgs ?? []),
      "-p",
      spec.prompt,
    ],
  };
}

export type GlmClaudeRun = {
  code: number | null;
  stdout: string;
  stderr: string;
};

export interface RunGlmClaudeOptions {
  env: NodeJS.ProcessEnv;
  cwd?: string;
}

/**
 * Run `claude` under the GLM env and resolve on close REGARDLESS of exit code —
 * mirroring `src/vlm/claude-cli-runner.ts`'s `runClaude`. The CLI reports
 * model/auth/quota failures as an `is_error` envelope on STDOUT while exiting
 * non-zero, and that envelope carries the human message; rejecting on
 * `code !== 0` before the caller can read it would swallow the diagnosis.
 *
 * REJECTS on spawn-failure, a child `error` event, and timeout (after SIGKILL).
 * Never throws synchronously. stdin is ignored so the CLI never blocks on it.
 */
export function runGlmClaude(
  spawnImpl: SpawnFn,
  bin: string,
  args: readonly string[],
  timeoutMs: number,
  options: RunGlmClaudeOptions,
): Promise<GlmClaudeRun> {
  return runClaudeCli(spawnImpl, bin, args, timeoutMs, {
    label: "glm-drainer",
    env: options.env,
    cwd: options.cwd,
  });
}

export type PreflightViolation =
  | { kind: "verifier-core"; path: string; matched: string }
  | { kind: "tier-fence"; tier: number; reason: string }
  | { kind: "secret-scan"; detail: string };

export type PreflightResult =
  | { ok: true; checkedPaths: number }
  | {
      ok: false;
      code: "glm-preflight-blocked";
      violations: PreflightViolation[];
      message: string;
    };

/**
 * Verifier-Core / T4 diff scan (ADR-0032 Decision 3 + invariant 8).
 *
 * The drainer's fence is `dev_orch` at T2/T3 only. Verifier-Core paths are
 * exactly the T4 set (`src/untouchable.ts`), so a Verifier-Core hit on the diff
 * IS a T4 hit — matching is delegated to `matchVerifierCore` rather than
 * re-listing the paths here, so the fence can never drift from the canonical
 * list.
 */
export function scanVerifierCorePaths(
  changedPaths: readonly string[],
): PreflightViolation[] {
  const violations: PreflightViolation[] = [];
  for (const path of changedPaths) {
    const matched = matchVerifierCore(path);
    if (matched) {
      violations.push({ kind: "verifier-core", path, matched });
    }
  }
  return violations;
}

/**
 * Independent tier cross-check (ADR-0032 Decision 3; the design-concept
 * artifact's `classifyChange()` half of the preflight).
 *
 * `scanVerifierCorePaths` matches the canonical Verifier-Core path list
 * directly. This is the *second, independent* statement of the same fence: the
 * drainer is scoped to T2/T3, so ANY T4 verdict from the classifier blocks —
 * including one produced by a future T4 rule that is not a Verifier-Core path
 * match.
 *
 * Today `classifyOne`'s only T4 branch IS `matchVerifierCore`, so the two agree
 * by construction; the value here is that a later divergence fails CLOSED
 * instead of silently opening the fence. `preflightBeforePr` therefore reports
 * this violation only when the two checks *disagree* — otherwise the per-path
 * `verifier-core` violations already carry the (more actionable) detail.
 *
 * Returns `null` when the diff classifies at T1–T3, and for an empty diff.
 */
export function scanTierFence(
  changedPaths: readonly string[],
): PreflightViolation | null {
  if (changedPaths.length === 0) return null;
  const classified = classifyChange([...changedPaths]);
  if (classified.tier < 4) return null;
  return { kind: "tier-fence", tier: classified.tier, reason: classified.reason };
}

/** Injected runner seam so tests never shell out to the real scanner. */
type SecretScanRunner = (
  files: readonly string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/**
 * Default runner: invoke `scripts/ci/secret-scan.sh` over the explicit file
 * list. `bash` is used directly (not `shell: true`) so filenames are never
 * re-parsed by a shell.
 */
function defaultSecretScanRunner(repoRoot: string = REPO_ROOT): SecretScanRunner {
  const script = join(repoRoot, SECRET_SCAN_RELATIVE_PATH);
  return async (files) => {
    const result = await execWithGroupCleanup("bash", [script, ...files], {
      cwd: repoRoot,
      timeout: 120_000,
    });
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  };
}

export interface PreflightOptions {
  /** Repo-relative paths the drainer's run added or modified. */
  changedPaths: readonly string[];
  /** Injected scanner. Defaults to the real `scripts/ci/secret-scan.sh`. */
  secretScan?: SecretScanRunner;
}

/**
 * The pre-`gh pr create` gate. Runs ALL output-side checks and blocks on any of
 * them — the drainer must never open a PR that leaks a credential or that
 * touches the Verifier Core / T4:
 *
 *   1. `scanVerifierCorePaths` — canonical path-list match (per-path detail).
 *   2. `scanTierFence` — independent `classifyChange` corroboration, reported
 *      only when it disagrees with (1); see its docstring.
 *   3. `scripts/ci/secret-scan.sh` over the diff.
 *
 * Never throws: an unexpected scanner failure is itself a `secret-scan`
 * violation (fail-closed — an unreadable gate is a closed gate). A `secret-scan.sh`
 * exit code of 2 is a usage error, which is likewise treated as blocking.
 *
 * An empty `changedPaths` list short-circuits to a pass: there is no diff, so
 * there is nothing to leak and no fenced path to touch. The caller still owns
 * the decision not to open an empty PR.
 */
export async function preflightBeforePr(
  options: PreflightOptions,
): Promise<PreflightResult> {
  const changedPaths = options.changedPaths;
  const coreViolations = scanVerifierCorePaths(changedPaths);
  const violations: PreflightViolation[] = [...coreViolations];

  // Corroborating tier check. Only reported when it DISAGREES with the path
  // scan — i.e. the classifier calls the diff T4 for a reason that is not a
  // Verifier-Core path match. Today that cannot happen; if it ever can, the
  // fence closes rather than silently opening.
  if (coreViolations.length === 0) {
    const tierViolation = scanTierFence(changedPaths);
    if (tierViolation) violations.push(tierViolation);
  }

  if (changedPaths.length > 0) {
    const runScan = options.secretScan ?? defaultSecretScanRunner();
    try {
      const scan = await runScan(changedPaths);
      if (scan.exitCode !== 0) {
        // secret-scan.sh prints the offending FILE + line numbers but never the
        // matched value (the repo is public); forwarding its stderr verbatim is
        // therefore safe and is the only actionable detail the caller gets.
        violations.push({
          kind: "secret-scan",
          detail:
            `${SECRET_SCAN_RELATIVE_PATH} exited ${scan.exitCode}: ` +
            `${(scan.stderr || scan.stdout || "(no output)").trim()}`,
        });
      }
    } catch (error) {
      console.error(
        `[glm-drainer] secret-scan preflight failed to run: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      violations.push({
        kind: "secret-scan",
        detail: `${SECRET_SCAN_RELATIVE_PATH} could not be run: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }

  if (violations.length > 0) {
    return {
      ok: false,
      code: "glm-preflight-blocked",
      violations,
      message: `GLM drainer preflight BLOCKED (${violations.length} violation(s)): ${violations
        .map((v) => {
          if (v.kind === "verifier-core") {
            return `Verifier-Core/T4 path ${v.path} (matches ${v.matched})`;
          }
          if (v.kind === "tier-fence") {
            return `diff classifies as T${v.tier}, outside the drainer's T2/T3 fence (${v.reason})`;
          }
          return v.detail;
        })
        .join("; ")}`,
    };
  }

  return { ok: true, checkedPaths: changedPaths.length };
}
