/**
 * scripts/ci/post-commit-status.ts — post a commit status, loudly and with
 * bounded retry (issue #4117).
 *
 * # Why this exists
 *
 * `.github/workflows/deep-qa-gate.yml` posted its verdict with a bare
 * `gh api --method POST /repos/{repo}/statuses/{sha}` under `set -euo
 * pipefail`. Two independent defects, neither about GitHub's uptime:
 *
 *  1. THE ERROR WAS SWALLOWED. The step logged no HTTP status and no response
 *     body — only `exit 1`. A 403 (permissions, cf. #860), a 422 (bad
 *     payload) and a 503 (outage) produced byte-identical logs, so diagnosing
 *     the real incident meant probing the API by hand from outside CI.
 *  2. ONE BAD CALL WEDGED A REQUIRED CHECK. `deep-qa-gate` is required for
 *     EVERY PR — including non-T4 ones, where it is a pure formality that
 *     reports success. A single transient 5xx therefore froze the merge queue
 *     repo-wide until a human noticed: the ambient-poison-pill shape already
 *     seen with the npm-audit required check (#3650).
 *
 * Observed on PR #4116: the gate computed `success`, PRINTED "Reporting
 * deep-qa-gate=success", then died on the POST. Querying
 * `/commits/<sha>/status` afterwards returned no `deep-qa-gate` context at
 * all, so the PR could not merge while the log claimed success.
 *
 * # Why the status comes from the RESPONSE BODY
 *
 * Measured against gh 2.96.0: on failure `gh api` exits 1, writes the JSON
 * error body to STDOUT — which always carries a `"status"` field — and writes
 * a human line to STDERR. The stderr form is NOT stable enough to parse
 * alone:
 *
 *   gh: No commit found for SHA: 000… (HTTP 422)
 *   gh: Validation failed: State is not included in the list (Validation Failed)
 *
 * The second names no HTTP code. So the body is the primary source and stderr
 * is only a fallback.
 *
 * # What retry can and cannot buy
 *
 * The backoff below spans well under a minute. That absorbs a BLIP, which is
 * the common case. It does NOT absorb a sustained outage — the #4116 incident
 * ran ~20 minutes and defeated seven manual reruns. So the terminal path is
 * as important as the retry: fail loudly, print the status and body, and name
 * the deterministic recovery (re-run once GitHub is healthy). Exiting 0
 * without posting would be worse than failing, because the required context
 * would still be absent and the job would now look green while the PR stayed
 * unmergeable.
 */

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** One POST attempt, reduced to what the classifier needs. */
export type Attempt = {
  ok: boolean;
  httpStatus: number | null;
  stdout: string;
  stderr: string;
};

export type Verdict = "posted" | "retry" | "fatal";

/**
 * Bounded backoff: FOUR attempts, 19s of waiting in total.
 *
 * Both bounds are set by the design-concept artifact's INV-4 — bounded in
 * attempt count AND total wall-clock (<=4 attempts, <=~60s) — because this
 * repo has a SINGLE self-hosted runner. A retry loop that squats holds the
 * runner and serialize-blocks every other PR's CI and deploy, so an outage
 * must fail fast rather than wait it out.
 */
export const RETRY_DELAYS_MS = [2_000, 5_000, 12_000];

/** Recover the HTTP status from a gh api failure. Body first, stderr second. */
export function parseHttpStatus(stdout: string, stderr: string): number | null {
  // The JSON error body carries `"status":"422"` (a STRING, not a number).
  const fromBody = /"status"\s*:\s*"?(\d{3})"?/.exec(stdout);
  if (fromBody) return Number(fromBody[1]);
  const fromErr = /\(HTTP (\d{3})\)/.exec(stderr);
  if (fromErr) return Number(fromErr[1]);
  return null;
}

/**
 * Retryable vs terminal.
 *
 * 5xx is the outage case this issue is about. 429 is a rate limit, equally
 * transient. A NULL status means gh never got an HTTP response at all (DNS,
 * TLS, connection reset) — also transient, and the case a status-code-only
 * rule would silently treat as fatal.
 *
 * Every other 4xx fails FAST and loud, per the issue's acceptance criteria: a
 * 403 is the #860 permissions bug and a 422 is a malformed payload. Retrying
 * either just delays a red that was always going to be red, and buries the
 * one line that says what is actually wrong.
 */
export function classifyAttempt(attempt: Attempt): Verdict {
  if (attempt.ok) return "posted";
  const s = attempt.httpStatus;
  if (s === null) return "retry";
  if (s >= 500) return "retry";
  if (s === 429) return "retry";
  return "fatal";
}

export type RetryDeps = {
  post: () => Attempt;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  delays?: number[];
};

export type RetryResult = {
  posted: boolean;
  attempts: number;
  last: Attempt;
  verdict: Verdict;
};

/** POST, retrying transient failures on a bounded backoff. */
export async function postWithRetry(deps: RetryDeps): Promise<RetryResult> {
  const delays = deps.delays ?? RETRY_DELAYS_MS;
  const maxAttempts = delays.length + 1;
  let last: Attempt = { ok: false, httpStatus: null, stdout: "", stderr: "never attempted" };
  let verdict: Verdict = "retry";

  for (let i = 0; i < maxAttempts; i++) {
    last = deps.post();
    verdict = classifyAttempt(last);
    if (verdict === "posted") return { posted: true, attempts: i + 1, last, verdict };
    if (verdict === "fatal") {
      deps.log(
        `[post-commit-status] TERMINAL failure on attempt ${i + 1}: HTTP ${last.httpStatus} — ` +
          `not retrying, this will not fix itself. body=${last.stdout.trim()} stderr=${last.stderr.trim()}`,
      );
      return { posted: false, attempts: i + 1, last, verdict };
    }
    const isLast = i === maxAttempts - 1;
    deps.log(
      `[post-commit-status] attempt ${i + 1}/${maxAttempts} failed with ` +
        `HTTP ${last.httpStatus ?? "no response"} (retryable)` +
        (isLast ? " — no attempts left." : ` — retrying in ${delays[i]}ms.`) +
        ` body=${last.stdout.trim()} stderr=${last.stderr.trim()}`,
    );
    if (!isLast) await deps.sleep(delays[i]);
  }
  return { posted: false, attempts: maxAttempts, last, verdict };
}

/** Build the `gh api` argv for a commit-status POST. */
export function statusPostArgs(
  repo: string,
  sha: string,
  state: string,
  context: string,
  description: string,
): string[] {
  return [
    "api",
    "--method",
    "POST",
    "-H",
    "Accept: application/vnd.github+json",
    `/repos/${repo}/statuses/${sha}`,
    "-f",
    `state=${state}`,
    "-f",
    `context=${context}`,
    "-f",
    `description=${description}`,
  ];
}

/** Run one real `gh api` POST. */
export function ghPost(args: string[]): Attempt {
  const r = spawnSync("gh", args, { encoding: "utf-8" });
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? (r.error ? String(r.error.message) : "");
  return {
    ok: r.status === 0,
    httpStatus: r.status === 0 ? 200 : parseHttpStatus(stdout, stderr),
    stdout,
    stderr,
  };
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const [sha, state, context, description] = process.argv.slice(2);
  const repo = process.env.REPO ?? "";
  if (!repo || !sha || !state || !context || description === undefined) {
    console.error(
      "usage: REPO=<owner/repo> post-commit-status.ts <sha> <state> <context> <description>",
    );
    process.exit(2);
  }
  const args = statusPostArgs(repo, sha, state, context, description);
  const result = await postWithRetry({
    post: () => ghPost(args),
    sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
    log: (line) => console.error(line),
  });
  if (result.posted) {
    console.error(
      `[post-commit-status] ${context}=${state} posted on ${sha} after ${result.attempts} attempt(s).`,
    );
    process.exit(0);
  }
  console.error(
    `[post-commit-status] FAILED to post ${context}=${state} on ${sha} after ${result.attempts} ` +
      `attempt(s); last HTTP ${result.last.httpStatus ?? "no response"}.`,
  );
  console.error(
    result.verdict === "fatal"
      ? "[post-commit-status] This is a TERMINAL error (4xx) — a re-run will not help. A 403 is " +
          "the workflow's token/permissions (see #860); a 422 is a malformed payload or an " +
          "unknown SHA. Fix the cause, then push or re-run."
      : "[post-commit-status] This is a TRANSIENT error (5xx / no response) that outlived the " +
          "retry budget — check githubstatus.com. RECOVERY: once GitHub is healthy, re-run this " +
          "workflow (`gh run rerun <run-id>`); the required context is posted on the head SHA, so " +
          "no push is needed. The job fails rather than exiting 0 deliberately: without the status " +
          "the PR is unmergeable either way, and a green job would hide that.",
  );
  process.exit(1);
}
