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
 *     code is `0` iff `ok: true`, else `1`. Used by bash only on the
 *     lock-held path now; the able-path heartbeat is written by `gate`.
 *   - `gate` — `runGate()` (issue #4682) → line is
 *     `{able:true,heartbeat,detail?}` or `{able:false,reason,detail?}`, exit
 *     `0` either way.
 *   - `tick` (issue #4688, ADR-0040 Decision 1) — the whole drainer tick
 *     in-process: gate → (skip: stop) → pick → (idle: stop) → claim →
 *     worktree → `composePrompt` → author (the shared helper `author` mode
 *     also calls) → finish. Line is `{gate,pick,finish}` (`finish` null when
 *     not reached); exit `0` for every completed tick, `1` only for a driver
 *     fault. Journal prose goes to stderr via `deps.tick.log`.
 *   - `preflight <changed-files-file>` — read/trim/blank-filter the file,
 *     `preflightBeforePr({changedPaths})` → line is its result, exit `0`
 *     regardless of verdict.
 *   - `author <prompt-file> <cwd>` — `buildGlmEnv`/`buildDrainerArgs` failure
 *     short-circuits to `{ok:false,code,message}` with NO spawn; a
 *     `runGlmClaude` rejection carrying `code:"claude-cli-timeout"` maps to
 *     `{ok:true,code:null,timedOut:true,timeoutMs}` (issue #4337 INV-1: the
 *     session RAN and was cut off — an authoring outcome the loop salvages,
 *     never a driver fault); otherwise `runGlmClaude` runs and the line is
 *     `{ok:true,code,stdout,stderr}` with stdout/stderr tail-truncated to the
 *     last 4000 chars. Exit `0` either way (a driver fault is a DIFFERENT
 *     thing from an authoring failure the caller already reads via
 *     `.ok`/`.code`).
 *   - `finish <issue> <author-outcome-json-path> <author-exit-code>
 *     [<worktree> <branch>]` (issue #4685) — the finish phase: parse the
 *     author outcome, run the salvage ladder. Line is the `FinishResult`
 *     (`{action,issue,labels,pr,quotaBlockedUntil,dryRun}`), exit `0` whenever
 *     `runFinish` returned — every salvage arm (including
 *     `finish-fault`) is a COMPLETED finish, not a driver fault. A missing
 *     required positional, or a ran outcome without both `<worktree>` and
 *     `<branch>`, is `glm-driver-bad-argv` (exit 1). The author outcome file
 *     is read here, not in finish.ts: an unreadable file becomes the empty
 *     string, which `parseAuthorOutcome` classifies as the driver-fault ARM
 *     (delta d) — a salvage release, never a crash.
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

import { readFileSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { logger } from "../logger.ts";
import { ORCH_BOARD_LABELS } from "../board-labels.ts";
import { isGhFailure } from "../github/exec.ts";
import { gitExec } from "../github/git.ts";
import { editIssueLabels, viewIssue } from "../github/issue-actions.ts";
import { setGlmDrainerHeartbeat } from "../redis/autopilot.ts";
import { loadDrainerConfig, type DrainerConfig } from "./drainer-config.ts";
import { composePrompt } from "./prompt.ts";
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
import { defaultGateDeps, runGate, type GateDeps, type GateLine } from "./gate.ts";
import { buildDefaultPickDeps, runPick, type PickDeps, type PickResult } from "./pick.ts";
import {
  buildDefaultFinishDeps,
  parseAuthorOutcome,
  runFinish,
  type FinishDeps,
  type FinishResult,
} from "./finish.ts";

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
  /** Gate-phase deps (issue #4682); built lazily from `env` when absent. */
  gateDeps?: GateDeps;
  /** Pick-phase deps (issue #4686); built lazily from `env` when absent. */
  pick?: PickDeps;
  /** Finish-phase deps (issue #4685); built lazily from `env` when absent. */
  finish?: FinishDeps;
  /** Tick-phase deps (issue #4688); built lazily from `env` when absent. */
  tick?: TickDeps;
}

/** Real dependencies — what the committed CLI entrypoint uses. */
const defaultDriverDeps: DriverDeps = {
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

// ---------------------------------------------------------------------------
// Shared author helper
// ---------------------------------------------------------------------------

/**
 * Run one authoring session and return the ONE JSON outcome line `author`
 * mode prints (and `tick` hands to finish). An env/args build failure is a
 * returned `{ok:false,code,message}` line with NO spawn; a
 * `claude-cli-timeout` rejection is the `{ok:true,timedOut:true}` outcome
 * (issue #4337 INV-1 — the session RAN and was cut off, possibly after
 * committing and pushing real work; never a driver fault). Every OTHER
 * rejection propagates: `author` mode lets it reach the `glm-driver-fault`
 * boundary, `tick` maps it to the driver-fault arm.
 */
async function runAuthorSession(deps: DriverDeps, prompt: string, cwd: string): Promise<string> {
  const envResult = deps.buildGlmEnv(deps.env);
  if (isEnvFailure(envResult)) {
    return JSON.stringify({ ok: false, code: envResult.code, message: envResult.message });
  }
  const argsResult = deps.buildDrainerArgs({ prompt });
  if (isArgsFailure(argsResult)) {
    return JSON.stringify({ ok: false, code: argsResult.code, message: argsResult.message });
  }
  let run: Awaited<ReturnType<typeof runGlmClaude>>;
  try {
    run = await deps.runGlmClaude(deps.spawn, "claude", argsResult.args, deps.apiTimeoutMs, {
      env: envResult.env,
      cwd,
    });
  } catch (err) {
    // Discriminated on the rejection's `code` field, NEVER on its message
    // text (#756).
    const errCode = (err as { code?: unknown } | null | undefined)?.code;
    if (errCode === "claude-cli-timeout") {
      const carried = (err as { timeoutMs?: unknown } | null | undefined)?.timeoutMs;
      return JSON.stringify({
        ok: true,
        code: null,
        timedOut: true,
        timeoutMs: typeof carried === "number" ? carried : deps.apiTimeoutMs,
      });
    }
    throw err;
  }
  return JSON.stringify({
    ok: true,
    code: run.code,
    // Truncated: a log/diagnostic surface, not the source of truth for what
    // the session did (that's the git diff + .glm-drainer-pr-body.md).
    stdout: run.stdout.slice(-4000),
    stderr: run.stderr.slice(-4000),
  });
}

// ---------------------------------------------------------------------------
// tick (issue #4688)
// ---------------------------------------------------------------------------

/** Injected seam for the tick's own effects (claim, body read, worktree). */
export interface TickDeps {
  config: DrainerConfig;
  /** The checkout whose worktree base / node_modules this tick uses. */
  repoRoot: string;
  /** Epoch milliseconds. */
  now: () => number;
  /** Journal line sink (stderr, `hydra-glm-drainer:` prefixed by the default). */
  log: (msg: string) => void;
  /** `ready-for-agent` -> `in-progress`. */
  claimIssue: (issue: number) => Promise<{ ok: boolean; stderr?: string }>;
  /** The issue body, or `null` when the read fails (caller uses ""). */
  readIssueBody: (issue: number) => Promise<string | null>;
  /** Raw git argv from `cwd`; ok = exit 0. */
  git: (args: string[], cwd: string) => Promise<{ ok: boolean }>;
  /** `ln -sfn <repoRoot>/node_modules <wt>/node_modules`; failure is non-fatal. */
  linkNodeModules: (repoRoot: string, worktree: string) => void;
}

/** The `tick` line: each phase's verdict; `pick`/`finish` null when not reached. */
export interface TickResult {
  gate: GateLine;
  pick: PickResult | null;
  finish: FinishResult | null;
}

const DEFAULT_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Production tick deps for `env` (names match what bash read). */
export function buildDefaultTickDeps(env: NodeJS.ProcessEnv = process.env): TickDeps {
  const config = loadDrainerConfig(env);
  return {
    config,
    repoRoot: config.repoRoot ?? DEFAULT_REPO_ROOT,
    now: () => Date.now(),
    log: (msg) => {
      process.stderr.write(`hydra-glm-drainer: ${msg}\n`);
    },
    claimIssue: async (issue) => {
      const r = await editIssueLabels(
        issue,
        { remove: [ORCH_BOARD_LABELS.ready_for_agent], add: [ORCH_BOARD_LABELS.in_progress] },
        { repo: config.repo },
      );
      return { ok: r.ok };
    },
    readIssueBody: async (issue) => {
      const r = await viewIssue(issue, { repo: config.repo, fields: "number,body" });
      return r.ok ? r.row.body : null;
    },
    git: async (args, cwd) => {
      const r = await gitExec(args, { cwd });
      return { ok: !isGhFailure(r) };
    },
    linkNodeModules: (repoRoot, worktree) => {
      // /dev/shm and .claude/worktrees checkouts have no ancestor
      // node_modules — symlink immediately (CLAUDE.md worktree pitfall).
      const link = join(worktree, "node_modules");
      try {
        rmSync(link, { force: true });
        symlinkSync(join(repoRoot, "node_modules"), link);
      } catch (err) {
        logger.error({ err, link }, "[glm-tick] node_modules symlink failed (non-fatal)");
      }
    },
  };
}

/**
 * Journal prose for a gate verdict — moved verbatim from the bash `main()`
 * (INV-8) so the journal is byte-identical across the migration.
 */
function logGateLine(log: (msg: string) => void, line: GateLine): void {
  if (line.able === false) {
    if (line.reason === "paused") {
      if (line.detail) log(`WARN ${line.detail} — failing safe (treating as paused)`);
      log(
        "operator paused — skip (no heartbeat; kill-switch honors ONLY operator paused, ignoring Anthropic reasons per ADR-0032 Decision 6)",
      );
    } else if (line.reason === "cap-exhausted") {
      log(`daily PR cap reached (${line.detail}) — skip (no heartbeat)`);
    } else {
      log(`quota block active until ${line.detail} — skip (no heartbeat)`);
    }
    return;
  }
  if (line.heartbeat === "written") log("heartbeat written (reason=able)");
  else if (line.heartbeat === "would-write") log("would-heartbeat (reason=able, DRY_RUN=1)");
  else log(`WARN heartbeat write failed (reason=able): ${line.detail ?? ""}`);
}

/** Create the worktree (the three `create_worktree` arms). `true` = created. */
async function createWorktree(
  t: TickDeps,
  branch: string,
  worktree: string,
  resuming: boolean,
): Promise<boolean> {
  // Best-effort fetch (bash: `|| true`).
  await t.git(["fetch", "origin", "--quiet"], t.repoRoot);
  let added: { ok: boolean };
  if (!resuming) {
    added = await t.git(["worktree", "add", "-b", branch, worktree, "origin/master"], t.repoRoot);
  } else if (
    (await t.git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], t.repoRoot)).ok
  ) {
    added = await t.git(["worktree", "add", worktree, branch], t.repoRoot);
  } else {
    added = await t.git(
      ["worktree", "add", "-b", branch, "--track", worktree, `origin/${branch}`],
      t.repoRoot,
    );
  }
  if (!added.ok) return false;
  t.linkNodeModules(t.repoRoot, worktree);
  return true;
}

/**
 * One whole drainer tick, in-process. Phase modules never throw (each returns
 * a result); an unexpected exception propagates to `runDriverMode`'s boundary
 * as `glm-driver-fault`.
 */
async function runTick(deps: DriverDeps): Promise<TickResult> {
  const t = deps.tick ?? buildDefaultTickDeps(deps.env);
  const { log } = t;
  const dryRun = t.config.dryRun;

  // Gate: pause / cap / quota block; heartbeat on able.
  const gate = await runGate(deps.gateDeps ?? defaultGateDeps(deps.env));
  logGateLine(log, gate);
  if (gate.able === false) return { gate, pick: null, finish: null };

  // Pick: stale-claim recovery, candidate pick, resume detection.
  const pick = await runPick(deps.pick ?? buildDefaultPickDeps(deps.env));
  if (!("issue" in pick)) {
    log(
      "no glm-eligible + ready-for-agent issue that is grill-clear (approved design concept, cleanup-scan label, or Expected tier: T1 stamp) — idle",
    );
    return { gate, pick, finish: null };
  }
  const issue = pick.issue;
  const resumeBranch = pick.resumeBranch ?? "";
  const finishDeps = deps.finish ?? buildDefaultFinishDeps(deps.env);

  let body = "";
  let branch = "";
  let worktree = "";
  let prompt = "";
  // INV-4: everything between the claim and the author session is guarded —
  // a throw from claim/body-read/worktree/prompt routes to runFinish as a
  // driver fault so the claim is never stranded.
  try {
    // Claim (a failure is a WARN, non-fatal — claim_issue parity).
    log(`claiming issue #${issue}`);
    if (dryRun) {
      log(`would-claim issue #${issue} (ready-for-agent -> in-progress, DRY_RUN=1)`);
    } else {
      const claimed = await t.claimIssue(issue);
      if (!claimed.ok) log(`WARN failed to claim issue #${issue} (non-fatal, continuing)`);
    }

    // Dry-run makes no gh call at all (INV-7): the prompt is never spawned with.
    body = dryRun ? "" : ((await t.readIssueBody(issue)) ?? "");

    // Worktree.
    const ts = Math.floor(t.now() / 1000);
    branch = resumeBranch !== "" ? resumeBranch : `worktree-agent-glm-${issue}-${ts}`;
    worktree = join(t.config.worktreeRoot, `agent-glm-${issue}-${ts}`);
    let created = true;
    if (dryRun) {
      log(`would-create-worktree issue #${issue} branch=${branch} path=${worktree} (DRY_RUN=1)`);
    } else {
      created = await createWorktree(t, branch, worktree, resumeBranch !== "");
    }
    if (!created) {
      log(`ERROR failed to create worktree for issue #${issue} (branch=${branch})`);
      log(
        `ERROR could not create a worktree for issue #${issue} — handing a synthetic not-run outcome to the finish phase`,
      );
      // The synthetic not-run outcome (finish.ts's not-run arm) releases the
      // claim; no worktree/branch is passed, so nothing is removed.
      const finish = await runFinish(finishDeps, {
        issue,
        worktree: null,
        branch: null,
        authorRaw: JSON.stringify({
          ok: false,
          code: "glm-worktree-create-failed",
          message: "create_worktree failed — no worktree to salvage",
        }),
        authorExitCode: 0,
      });
      return { gate, pick, finish };
    }

    if (resumeBranch !== "") {
      log(
        `issue #${issue}: resuming pushed drainer branch ${branch} (${pick.resumeCommits ?? "?"} commit(s) ahead of origin/master)`,
      );
    }

    prompt = composePrompt(issue, body, resumeBranch, pick.resumeCommits);
  } catch (err) {
    logger.error({ err, issue }, "[glm-tick] pre-author step threw — routing to finish as a driver fault");
    const finish = await runFinish(finishDeps, {
      issue,
      worktree: null,
      branch: null,
      authorRaw: "",
      authorExitCode: 1,
    });
    return { gate, pick, finish };
  }

  // Author (in-process; the same helper `author` mode calls).
  log(`authoring issue #${issue} in ${worktree} (branch=${branch})`);
  let authorRaw: string;
  let authorExitCode = 0;
  if (dryRun) {
    log(`would-author issue #${issue} in ${worktree} (DRY_RUN=1)`);
    authorRaw = JSON.stringify({ ok: true, code: 0, stdout: "", stderr: "" });
  } else {
    try {
      authorRaw = await runAuthorSession(deps, prompt, worktree);
    } catch (err) {
      // A non-timeout rejection is the driver-fault ARM (empty outcome +
      // non-zero exit, per parseAuthorOutcome) — it still reaches runFinish,
      // so the claim is never stranded by an in-process error.
      logger.error({ err, issue }, "[glm-tick] author session threw — routing to finish as a driver fault");
      authorRaw = "";
      authorExitCode = 1;
    }
  }
  log(`authoring session finished: ${authorRaw.slice(0, 300)}`);

  const finish = await runFinish(finishDeps, {
    issue,
    worktree,
    branch,
    authorRaw,
    authorExitCode,
  });
  return { gate, pick, finish };
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

    if (mode === "gate") {
      // Prints exactly one JSON line: {able:true,heartbeat,detail?} or
      // {able:false,reason,detail?}. Exit 0 either way — a skip is a
      // completed decision, not a driver fault (preflight precedent). The
      // gate writes the heartbeat itself on `able`; bash logs the journal
      // prose from `reason`/`heartbeat`/`detail`.
      const r = await runGate(deps.gateDeps ?? defaultGateDeps(deps.env));
      return { ok: true, line: JSON.stringify(r), exitCode: 0 };
    }

    if (mode === "pick") {
      // Prints exactly one JSON line: {issue,reason,resumeBranch,resumeCommits}
      // or {idle:true,skipped}. Exit 0 either way (INV-10) — non-zero is
      // reserved for driver faults.
      const r = await runPick(deps.pick ?? buildDefaultPickDeps(deps.env));
      return { ok: true, line: JSON.stringify(r), exitCode: 0 };
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
      // The shared author helper (issue #4688): `tick` calls the same one
      // in-process, so both modes keep one timeout-to-outcome mapping. A
      // non-timeout rejection propagates to the glm-driver-fault boundary.
      return { ok: true, line: await runAuthorSession(deps, prompt, cwd), exitCode: 0 };
    }

    if (mode === "tick") {
      // The whole tick, in-process (issue #4688, ADR-0040 Decision 1): gate ->
      // pick -> claim -> worktree -> prompt -> author -> finish. Prints ONE
      // `{gate,pick,finish}` line; exit 0 for every completed tick (skip,
      // idle, finish-fault included) — a non-zero exit is a driver fault
      // (an exception caught by the outer boundary below).
      const r = await runTick(deps);
      return { ok: true, line: JSON.stringify(r), exitCode: 0 };
    }

    if (mode === "finish") {
      const issueArg = argv[1];
      const authorPath = argv[2];
      const exitCodeArg = argv[3];
      const worktree = argv[4] && argv[4].length > 0 ? argv[4] : null;
      const branch = argv[5] && argv[5].length > 0 ? argv[5] : null;
      if (
        !issueArg ||
        !authorPath ||
        exitCodeArg === undefined ||
        !/^\d+$/.test(issueArg) ||
        !/^-?\d+$/.test(exitCodeArg)
      ) {
        return {
          ok: false,
          code: "glm-driver-bad-argv",
          message:
            "finish mode requires <issue> <author-outcome-json-path> <author-exit-code> [<worktree> <branch>]",
        };
      }
      // Read HERE (INV-10): an unreadable outcome file is the empty string,
      // which parseAuthorOutcome classifies as the driver-fault ARM (delta d) —
      // the claim is salvaged, not crashed on. Never a thrown error.
      let authorRaw = "";
      try {
        authorRaw = deps.readFile(authorPath);
      } catch (err) {
        logger.warn(
          { err, path: authorPath },
          "[glm-drainer/driver] author outcome file unreadable — treating as empty (driver-fault arm)",
        );
      }
      const authorExitCode = Number(exitCodeArg);
      const outcome = parseAuthorOutcome(authorRaw, authorExitCode);
      if (outcome.kind === "ran" && (!worktree || !branch)) {
        return {
          ok: false,
          code: "glm-driver-bad-argv",
          message:
            "finish mode requires <worktree> <branch> for a ran author outcome",
        };
      }
      // runFinish never throws (its own top-level catch → action
      // "finish-fault"), so any completed salvage — including the fault arm —
      // is exit 0 at the driver level. Non-zero is reserved for driver
      // faults, and bash treats ANY non-zero finish exit as ERROR + skip.
      const r = await runFinish(
        deps.finish ?? buildDefaultFinishDeps(deps.env),
        {
          issue: Number(issueArg),
          worktree,
          branch,
          authorRaw,
          authorExitCode,
        },
      );
      return { ok: true, line: JSON.stringify(r), exitCode: 0 };
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
