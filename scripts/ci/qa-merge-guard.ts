/**
 * scripts/ci/qa-merge-guard.ts — the QA merge guard (issue #4737, decision #4736 option 2).
 *
 * One question, answered from QA's own record: "may this PR merge now?"
 *
 * Before this guard, auto-merge was armed on a QA PASS and nothing ever
 * disarmed it. In #4380 a PASS armed auto-merge, a fix was pushed, the
 * re-review FAILed, and GitHub merged the PR 4 seconds after the FAIL posted.
 * The autopilot's INV-007 (`qa_verdict == PASS`) never checked that the PASS
 * was for the head that was actually merging.
 *
 * The guard is bound to the PR's CURRENT head SHA:
 *
 *   allowed  ⇔  latest `QA-Verdict:` trailer (#4729) naming this PR is
 *               PASS / PASS-pending-CI AND its `sha=` matches the current head
 *               (`qaVerdictShaMatches` — `sha=unknown` never matches)
 *           OR  the PR is exempt (every changed path under `docs/research/`
 *               or `docs/adr/`) and its latest verdict is not a FAIL at head.
 *
 * The exemption is "exempt from the QA *requirement*" (#4736): an exempt PR
 * needs no verdict, but a QA FAIL recorded against its current head still
 * holds it — letting a merge through a FAIL at the reviewed head is exactly
 * the #4380 shape this guard exists to stop.
 *
 * Layout: `evaluateQaMergeGuard` is pure (no fs/network, never throws);
 * `runQaMergeGuard` composes it with an injectable fetcher; the CLI at the
 * bottom wires the fetcher to REST `gh api` (not `gh --json` GraphQL, whose
 * budget a live autopilot exhausts).
 *
 * CLI:
 *   node --experimental-strip-types scripts/ci/qa-merge-guard.ts --pr <N> [--repo owner/name]
 * Prints the result JSON on stdout. Exit 0 = allowed, 1 = denied, 2 = usage error.
 */

import {
  isFailVerdict,
  parseQaVerdictTrailers,
  qaVerdictShaMatches,
  type FinalVerdict,
  type QaVerdictTrailer,
} from "./qa-verdict.ts";

/** Path prefixes whose changes are exempt from the QA requirement (#4736). */
export const QA_EXEMPT_PATH_PREFIXES: readonly string[] = [
  "docs/research/",
  "docs/adr/",
];

/** Machine-readable reason for a guard result. */
export type QaMergeGuardReason =
  /** Latest verdict is PASS/PASS-pending-CI for the current head. */
  | "verdict-at-head"
  /** Every changed path is exempt and no FAIL is recorded at the head. */
  | "exempt"
  /** No `QA-Verdict:` trailer names this PR. */
  | "not-reviewed"
  /** Latest verdict is a PASS for a different (or unknown) SHA. */
  | "stale-verdict"
  /** Latest verdict is FAIL / FAIL-pending-CI. */
  | "verdict-fail"
  /** The PR's head SHA or its QA record could not be read — fail closed. */
  | "fetch-failed";

export interface QaMergeGuardResult {
  allowed: boolean;
  reason: QaMergeGuardReason;
  /** Latest verdict literal naming this PR, or null when none. */
  verdict: FinalVerdict | null;
  /** That verdict's `sha=` field (possibly `unknown`), or null when none. */
  verdictSha: string | null;
  /** The PR's current head SHA as read ("" when unknown). */
  headSha: string;
  exempt: boolean;
}

export interface QaMergeGuardInput {
  pr: number;
  headSha: string;
  /** Repo-relative paths the PR changes. Empty ⇒ never exempt. */
  changedFiles: readonly string[];
  /**
   * The PR's comment + review bodies in CHRONOLOGICAL order (oldest first).
   * Trailers naming a different PR are ignored.
   */
  bodies: ReadonlyArray<string | null | undefined>;
}

/** True iff `path` lies under one of `QA_EXEMPT_PATH_PREFIXES`. */
export function isQaExemptPath(path: string): boolean {
  const p = String(path ?? "").trim().replace(/^\.\//, "");
  return QA_EXEMPT_PATH_PREFIXES.some((prefix) => p.startsWith(prefix));
}

/**
 * True iff the change is non-empty and EVERY path is exempt. An empty list
 * (unknown diff) is never exempt — fail closed.
 */
export function isQaExemptChange(paths: readonly string[]): boolean {
  return paths.length > 0 && paths.every(isQaExemptPath);
}

/** The LAST well-formed trailer naming `pr` across `bodies`, or null. */
export function latestQaVerdictTrailer(
  bodies: ReadonlyArray<string | null | undefined>,
  pr: number,
): QaVerdictTrailer | null {
  let latest: QaVerdictTrailer | null = null;
  for (const body of bodies) {
    for (const t of parseQaVerdictTrailers(body)) {
      if (t.pr === pr) latest = t;
    }
  }
  return latest;
}

/** Pure decision. Never throws. */
export function evaluateQaMergeGuard(input: QaMergeGuardInput): QaMergeGuardResult {
  const headSha = String(input.headSha ?? "").trim().toLowerCase();
  const exempt = isQaExemptChange(input.changedFiles ?? []);
  const latest = latestQaVerdictTrailer(input.bodies ?? [], input.pr);
  const result = (allowed: boolean, reason: QaMergeGuardReason): QaMergeGuardResult => ({
    allowed,
    reason,
    verdict: latest?.verdict ?? null,
    verdictSha: latest?.sha ?? null,
    headSha,
    exempt,
  });

  if (latest !== null && isFailVerdict(latest.verdict)) {
    // A FAIL at the current head holds even an exempt PR; a FAIL for an
    // older head still holds a non-exempt PR (no PASS has superseded it).
    const failAtHead = qaVerdictShaMatches(latest, headSha);
    return !exempt || failAtHead ? result(false, "verdict-fail") : result(true, "exempt");
  }
  if (exempt) return result(true, "exempt");
  if (latest === null) return result(false, "not-reviewed");
  if (qaVerdictShaMatches(latest, headSha)) return result(true, "verdict-at-head");
  return result(false, "stale-verdict");
}

/** What the guard needs from GitHub for one PR. */
export interface QaMergeGuardFetched {
  headSha: string;
  changedFiles: string[];
  /** Comment + review bodies, each with its ISO timestamp (any order). */
  entries: Array<{ body: string | null; at: string | null }>;
}

/** Fetcher seam — the CLI wires REST `gh api`; tests inject a fake. */
export type QaMergeGuardFetcher = (pr: number) => QaMergeGuardFetched | null;

/**
 * Fetch then evaluate. A fetcher returning null (or throwing) yields a
 * fail-closed `fetch-failed` denial — never an allow.
 */
export function runQaMergeGuard(
  pr: number,
  fetcher: QaMergeGuardFetcher,
): QaMergeGuardResult {
  let fetched: QaMergeGuardFetched | null = null;
  try {
    fetched = fetcher(pr);
  } catch (err) {
    console.error(`[qa-merge-guard] fetch for PR #${pr} threw:`, err);
    fetched = null;
  }
  if (fetched === null) {
    return {
      allowed: false,
      reason: "fetch-failed",
      verdict: null,
      verdictSha: null,
      headSha: "",
      exempt: false,
    };
  }
  // Chronological order; entries without a timestamp sort first (oldest).
  const ordered = [...fetched.entries].sort((a, b) =>
    String(a.at ?? "").localeCompare(String(b.at ?? "")),
  );
  return evaluateQaMergeGuard({
    pr,
    headSha: fetched.headSha,
    changedFiles: fetched.changedFiles,
    bodies: ordered.map((e) => e.body),
  });
}

// ---------------------------------------------------------------------------
// CLI — REST `gh api` only.
// ---------------------------------------------------------------------------

const isMain = (() => {
  try {
    return (
      typeof process !== "undefined" &&
      Array.isArray(process.argv) &&
      typeof import.meta.url === "string" &&
      process.argv[1] !== undefined &&
      import.meta.url === `file://${process.argv[1]}`
    );
  } catch {
    /* intentional: import.meta may be unavailable under some loaders; treat as not-main */
    return false;
  }
})();

if (isMain) {
  const { execFileSync } = await import("node:child_process");

  const parseArg = (flag: string, fallback: string): string => {
    const idx = process.argv.indexOf(flag);
    if (idx === -1 || idx === process.argv.length - 1) return fallback;
    return process.argv[idx + 1] as string;
  };

  const repo = parseArg("--repo", "gaberoo322/hydra");
  const pr = Number.parseInt(parseArg("--pr", ""), 10);
  if (!Number.isInteger(pr) || pr < 1) {
    console.error("usage: qa-merge-guard.ts --pr <N> [--repo owner/name]");
    process.exit(2);
  }

  /** `gh api` returning newline-delimited JSON values (one per --jq output). */
  const ghApiLines = (path: string, jq: string, paginate: boolean): unknown[] => {
    const args = ["api", ...(paginate ? ["--paginate"] : []), path, "--jq", jq];
    const out = execFileSync("gh", args, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 64,
    });
    return out
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as unknown);
  };

  const fetcher: QaMergeGuardFetcher = (n) => {
    try {
      const head = ghApiLines(`repos/${repo}/pulls/${n}`, ".head.sha | tojson", false);
      const files = ghApiLines(
        `repos/${repo}/pulls/${n}/files?per_page=100`,
        ".[].filename | tojson",
        true,
      );
      const comments = ghApiLines(
        `repos/${repo}/issues/${n}/comments?per_page=100`,
        ".[] | {body, at: .created_at} | tojson",
        true,
      );
      const reviews = ghApiLines(
        `repos/${repo}/pulls/${n}/reviews?per_page=100`,
        ".[] | {body, at: .submitted_at} | tojson",
        true,
      );
      return {
        headSha: String(head[0] ?? ""),
        changedFiles: files.map((f) => String(f)),
        entries: [...comments, ...reviews] as QaMergeGuardFetched["entries"],
      };
    } catch (err) {
      console.error(`[qa-merge-guard] gh api read failed for PR #${n} in ${repo}:`, err);
      return null;
    }
  };

  const result = runQaMergeGuard(pr, fetcher);
  console.log(JSON.stringify(result));
  process.exit(result.allowed ? 0 : 1);
}
