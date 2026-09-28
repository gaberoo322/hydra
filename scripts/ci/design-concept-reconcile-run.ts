/**
 * scripts/ci/design-concept-reconcile-run.ts — the design-concept
 * reconciliation gate's CI adapter, as a standalone runner (issue #4132).
 *
 * # Why this exists
 *
 * This adapter used to be a `test()` case inside
 * `test/design-concept-reconcile-check.test.mts`, i.e. inside the required
 * `test` job. That made a lint on the PR *description* cost a full ~11-minute
 * suite run to report itself, and it was measurably the single largest source
 * of red CI: **12 of the 19 red `test` jobs** across a 60-run sample were this
 * one check, ~155 minutes of runner time spent reporting malformed PR bodies
 * (issue #4132).
 *
 * It also cannot self-clear on a GitHub re-run: the PR body is read from the
 * triggering webhook payload (`GITHUB_EVENT_PATH`), so a re-run replays the
 * ORIGINAL body. Only a new push produces a new payload. Paying 11 minutes per
 * attempt for a check that needs a push to clear is the worst possible pairing.
 *
 * Running it standalone turns that into ~30 seconds. The 46 pure-logic tests
 * over `checkReconciliation` and friends stay exactly where they are — this
 * moves the *adapter*, not the rules.
 *
 * # Fail-open contract (unchanged from the in-suite adapter)
 *
 * Every environmental uncertainty skips GREEN. Only a resolved, APPROVED
 * artifact whose invariants the PR body fails to reconcile exits non-zero:
 *
 *   - no `GITHUB_EVENT_PATH`, or an unreadable/parse-failing payload
 *   - a payload with no `pull_request` (push / schedule run)
 *   - a PR body with no `Closes/Fixes/Resolves #N`
 *   - HTTP 404, any non-OK status, or an unreachable orchestrator
 *   - an artifact that declares no invariants, has no hash, or is not approved
 *
 * The orchestrator being down MUST NOT redden the merge gate — that is state
 * outside the PR's own diff, the ambient-poison-pill class this repo routes
 * around elsewhere (`reference_npm_audit_required_check_ambient_poison_pill`).
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  checkReconciliation,
  extractAnchorRefFromPrBody,
  formatViolations,
  isSafeRepoRelativePath,
  resolveEnforceDecision,
  type FileReader,
} from "./design-concept-reconcile-check.ts";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** Repo-rooted, traversal-guarded reader. Returns null for anything unreadable. */
export function makeRepoFileReader(repoRoot: string = REPO_ROOT): FileReader {
  return (repoRelativePath) => {
    if (!isSafeRepoRelativePath(repoRelativePath)) return null;
    const abs = join(repoRoot, repoRelativePath);
    if (!abs.startsWith(repoRoot + sep)) return null;
    try {
      if (!existsSync(abs) || !statSync(abs).isFile()) return null;
      return readFileSync(abs, "utf8");
    } catch (err: any) {
      console.error(`[dc-reconcile] unreadable ${repoRelativePath}: ${err?.message ?? err}`);
      return null;
    }
  };
}

export type ReconcileRunResult =
  /** Nothing to enforce — always exit 0. `why` is logged, never thrown. */
  | { outcome: "skip"; why: string }
  | { outcome: "pass"; anchorRef: number }
  | { outcome: "violation"; anchorRef: number; message: string };

export type RunDeps = {
  /** Raw webhook payload text, or null when GITHUB_EVENT_PATH is absent/unreadable. */
  readEventPayload: () => string | null;
  /** Artifact fetch. Resolves `{status, body}`; rejects only on transport failure. */
  fetchArtifact: (anchorRef: number) => Promise<{ status: number; body: any }>;
  readFile: FileReader;
};

/**
 * The adapter, with every I/O edge injected so the skip ladder is unit-testable
 * without GITHUB_EVENT_PATH or a live orchestrator. Never throws.
 */
export async function runReconcileCheck(deps: RunDeps): Promise<ReconcileRunResult> {
  const raw = deps.readEventPayload();
  if (raw === null) return { outcome: "skip", why: "no readable GITHUB_EVENT_PATH (local run)" };

  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch (err: any) {
    return { outcome: "skip", why: `unreadable GITHUB_EVENT_PATH: ${err?.message ?? err}` };
  }
  if (!payload?.pull_request) {
    return { outcome: "skip", why: "event payload has no pull_request (push/schedule run)" };
  }

  const prBody: string = payload.pull_request.body ?? "";
  const anchorRef = extractAnchorRefFromPrBody(prBody);
  if (anchorRef === null) {
    return { outcome: "skip", why: "PR body has no Closes/Fixes/Resolves #N — not a dev PR" };
  }

  let artifact: any;
  try {
    const res = await deps.fetchArtifact(anchorRef);
    if (res.status === 404) {
      return { outcome: "skip", why: `no design-concept artifact for issue #${anchorRef}` };
    }
    if (res.status < 200 || res.status >= 300) {
      return {
        outcome: "skip",
        why: `artifact fetch returned HTTP ${res.status} for issue #${anchorRef}`,
      };
    }
    artifact = res.body;
  } catch (err: any) {
    // Orchestrator down / unreachable MUST NOT redden the merge gate.
    return {
      outcome: "skip",
      why: `artifact fetch failed for issue #${anchorRef}: ${err?.message ?? err}`,
    };
  }

  const decision = resolveEnforceDecision(artifact);
  if (!decision.enforce) {
    return { outcome: "skip", why: `artifact for issue #${anchorRef} ${decision.reason}` };
  }

  // Fail CLOSED from here on.
  const violations = checkReconciliation({
    prBody,
    invariants: artifact.invariants,
    artifactHash: artifact.artifactHash,
    readFile: deps.readFile,
  });
  if (violations.length === 0) return { outcome: "pass", anchorRef };
  return { outcome: "violation", anchorRef, message: formatViolations(violations, anchorRef) };
}

/** Default deps: real webhook payload + real orchestrator + real repo files. */
export function defaultDeps(env: NodeJS.ProcessEnv = process.env): RunDeps {
  return {
    readEventPayload: () => {
      const eventPath = env.GITHUB_EVENT_PATH;
      if (!eventPath) return null;
      try {
        return readFileSync(eventPath, "utf8");
      } catch (err: any) {
        console.error(`[dc-reconcile] could not read GITHUB_EVENT_PATH: ${err?.message ?? err}`);
        return null;
      }
    },
    fetchArtifact: async (anchorRef) => {
      const base = (env.HYDRA_API_BASE ?? "http://localhost:4000").replace(/\/$/, "");
      const res = await fetch(`${base}/api/design-concepts/${anchorRef}`, {
        signal: AbortSignal.timeout(5000),
      });
      // A 404 body is never read — status alone decides the skip.
      const body = res.ok ? await res.json() : null;
      return { status: res.status, body };
    },
    readFile: makeRepoFileReader(),
  };
}

// ---------------------------------------------------------------------------
// Local pre-PR dry-run mode (issue #4731)
// ---------------------------------------------------------------------------
//
// 7 of 13 purely mechanical QA FAIL rounds in a 150-PR audit were a missing,
// paraphrased or `...`-truncated reconciliation section — each one a dev
// resume plus a full re-review. The CI adapter above can only report them
// AFTER the PR exists (and only a new push clears them). This mode lets the
// hydra-dev child flow run the IDENTICAL check against the PR body file it is
// about to submit, before `gh pr create`:
//
//   npx tsx scripts/ci/design-concept-reconcile-run.ts --body-file <path> [--anchor <N>]
//
// It does not re-implement anything: the body is wrapped in a synthetic
// `pull_request` payload and fed through `runReconcileCheck`, so it exits
// non-zero on exactly the violations CI reports. `--anchor` (optional; a bare
// number or `issue-N`) cross-checks that the body's `Closes #N` names the
// anchor you implemented — CI binds to the body's ref, so a body that omits or
// misnames it would silently check the wrong artifact (or none).

export type LocalArgs =
  | { kind: "local"; bodyFile: string; anchorRef: number | null }
  | { kind: "ci" }
  | { kind: "error"; message: string };

/** Parse `--body-file <path> [--anchor <N|issue-N>]`. No flags → CI mode. */
export function parseLocalArgs(argv: string[]): LocalArgs {
  if (argv.length === 0) return { kind: "ci" };
  let bodyFile: string | null = null;
  let anchorRaw: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf("=");
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const inline = eq > 0 ? a.slice(eq + 1) : undefined;
    if (flag !== "--body-file" && flag !== "--anchor") {
      return { kind: "error", message: `unknown argument: ${a}` };
    }
    const value = inline ?? argv[++i];
    if (value === undefined || value === "") {
      return { kind: "error", message: `${flag} requires a value` };
    }
    if (flag === "--body-file") bodyFile = value;
    else anchorRaw = value;
  }
  if (bodyFile === null) return { kind: "error", message: "--body-file <path> is required" };
  let anchorRef: number | null = null;
  if (anchorRaw !== null) {
    const m = /^(?:issue-|#)?(\d+)$/.exec(anchorRaw.trim());
    if (!m) return { kind: "error", message: `--anchor must be N or issue-N, got: ${anchorRaw}` };
    anchorRef = Number(m[1]);
  }
  return { kind: "local", bodyFile, anchorRef };
}

/**
 * Dry-run the CI check against a PR body that has not been submitted yet.
 * Reuses `runReconcileCheck` verbatim via a synthetic payload; never throws.
 */
export async function runLocalReconcileCheck(
  input: { prBody: string; anchorRef: number | null },
  deps: Omit<RunDeps, "readEventPayload">,
): Promise<ReconcileRunResult> {
  const bodyRef = extractAnchorRefFromPrBody(input.prBody);
  if (input.anchorRef !== null && bodyRef !== input.anchorRef) {
    const saw = bodyRef === null ? "no Closes/Fixes/Resolves #N" : `Closes #${bodyRef}`;
    return {
      outcome: "violation",
      anchorRef: input.anchorRef,
      message:
        `design-concept reconciliation dry-run: PR body has ${saw}, expected Closes #${input.anchorRef}.\n` +
        "CI binds the artifact to the body's Closes/Fixes/Resolves ref — fix the body before opening the PR.",
    };
  }
  return runReconcileCheck({
    ...deps,
    readEventPayload: () => JSON.stringify({ pull_request: { body: input.prBody } }),
  });
}

/** Print a result and return the process exit code (0 skip/pass, 1 violation). */
function report(result: ReconcileRunResult, mode: "ci" | "local"): number {
  const tag = mode === "local" ? "[dc-reconcile:dry-run]" : "[dc-reconcile]";
  if (result.outcome === "skip") {
    console.error(`${tag} skipped (fail-open): ${result.why}`);
    return 0;
  }
  if (result.outcome === "pass") {
    console.error(`${tag} OK — issue #${result.anchorRef} reconciled`);
    return 0;
  }
  console.error(result.message);
  return 1;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const args = parseLocalArgs(process.argv.slice(2));
  if (args.kind === "error") {
    console.error(`[dc-reconcile:dry-run] ${args.message}`);
    console.error("usage: design-concept-reconcile-run.ts [--body-file <path> [--anchor <N|issue-N>]]");
    process.exit(2);
  } else if (args.kind === "ci") {
    process.exit(report(await runReconcileCheck(defaultDeps()), "ci"));
  } else {
    let prBody: string;
    try {
      prBody = readFileSync(args.bodyFile, "utf8");
    } catch (err: any) {
      console.error(`[dc-reconcile:dry-run] cannot read --body-file ${args.bodyFile}: ${err?.message ?? err}`);
      process.exit(2);
    }
    const { fetchArtifact, readFile } = defaultDeps();
    const result = await runLocalReconcileCheck({ prBody, anchorRef: args.anchorRef }, { fetchArtifact, readFile });
    process.exit(report(result, "local"));
  }
}
