/**
 * Deployed-build drift check — pure logic (issue #2663).
 *
 * Compares the SHA the *running* orchestrator reports it is deployed from
 * (`/api/health.deployedSha`) against `origin/master` HEAD, and classifies
 * the result as in-sync / drift / unknown. Surfaced by the `hydra-doctor`
 * playbook so a STALE production build is flagged LOUD instead of hiding
 * behind an "uptime 22h, status ok" line.
 *
 * Motivating incident (2026-07-02): production ran ~30h-stale code
 * (`POST /api/holdback/pending` 404'd — merged in #2626 but never live)
 * while the deploy-on-merge pipeline silently stopped restarting the
 * service. `hydra-doctor` reported "uptime 22h, status ok" and did NOT
 * notice, because it had no "deployed build vs master HEAD" drift check.
 * See operator memory `reference_deploy_concurrency_cancels_master` for the
 * upstream failure mode (back-to-back merges cancel each other's deploy).
 *
 * Relationship to the watchdog backstop (#734)
 * ---------------------------------------------
 * `scripts/hydra-watchdog.sh` already has a per-2-min DEPLOY DRIFT block
 * that can *auto-deploy* on sustained drift. This module is the
 * *operator-facing* half: the doctor is an on-demand report a human runs,
 * and it must render the drift as an explicit FAIL/WARN finding in its
 * output — the watchdog's journald WARN line is invisible to a `hydra
 * doctor` reader. The two are complementary: the watchdog acts, the doctor
 * reports.
 *
 * This module is the **pure-logic** half — SHA compare + verdict/severity
 * classification + report shaping. All I/O (the `git fetch`, the
 * `curl /api/health`, the `git rev-parse origin/master`, the dirty-tree
 * read) lives in `scripts/deploy-drift-check.ts`, the only production
 * caller. The split mirrors `scripts/tool-currency-logic.ts` /
 * `scripts/tool-currency-check.ts` so the test suite can exercise every
 * classification branch without touching git, the network, or a live
 * service. Co-located under `scripts/` because the driver is the sole
 * consumer — no cross-boundary reach from a `scripts/` CLI into `src/`.
 *
 * Read-only by contract: nothing here mutates any ref or working tree.
 */

/**
 * Verdict for the deployed-build drift check.
 *   - `in-sync`  — deployed SHA == origin/master HEAD (short-SHA match).
 *   - `drift`    — deployed SHA != origin/master and drift has persisted
 *                  past the grace window (LOUD — production is stale).
 *   - `settling` — deployed SHA != origin/master but still inside the grace
 *                  window (a deploy is likely mid-flight; not yet alarming).
 *   - `unknown`  — a SHA could not be resolved (API unreachable, detached
 *                  origin, git error). Information-only, never alarming.
 */
export type DriftVerdict = "in-sync" | "drift" | "settling" | "unknown";

export type DriftSeverity = "info" | "warning" | "critical";

export interface DriftReport {
  verdict: DriftVerdict;
  severity: DriftSeverity;
  /** Short deployed SHA (from /api/health.deployedSha), or "?" if unresolved. */
  deployedSha: string;
  /** Short origin/master HEAD SHA, or "?" if unresolved. */
  remoteSha: string;
  /** Seconds the drift has persisted (0 when in-sync/unknown). */
  driftAgeSeconds: number;
  /** One-line human summary rendered by the doctor playbook. */
  message: string;
  /** Optional context — the drift cause when detectable (e.g. dirty tree). */
  note?: string;
}

/** Default grace window: 15 min. A deploy mid-flight must not read as drift. */
export const DEFAULT_DRIFT_GRACE_SECONDS = 900;

/**
 * Normalise a raw SHA to a comparable short form. Trims whitespace, lowers
 * case, and truncates to 12 chars (git's default abbrev is 7; 12 is
 * collision-safe for this repo and keeps the compare cheap). Returns null
 * for empty / obviously-invalid input so the caller degrades to `unknown`.
 */
export function shortSha(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim().toLowerCase();
  // A git SHA is 40 hex chars; accept any all-hex prefix of length >= 7.
  if (!/^[0-9a-f]{7,40}$/.test(trimmed)) return null;
  return trimmed.slice(0, 12);
}

/**
 * True when the two short SHAs refer to the same commit. Because one side
 * may be a full 40-char SHA and the other an abbreviated form, we compare
 * on the shorter length (prefix match) after both have been normalised by
 * {@link shortSha}. Both inputs are already-normalised 12-char (or shorter)
 * strings from {@link shortSha}, so a direct prefix compare is safe.
 */
export function shasMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  const n = Math.min(a.length, b.length);
  return a.slice(0, n) === b.slice(0, n);
}

/**
 * Classify deployed-build drift from already-resolved inputs.
 *
 * Pure: the driver does the I/O (fetch, curl, rev-parse, dirty read) and
 * hands the results here. Every branch is unit-testable without a network,
 * a git process, or a live service.
 *
 * @param deployedRaw  raw `/api/health.deployedSha` (null if API unreachable
 *                     or the field was absent).
 * @param remoteRaw    raw `git rev-parse origin/master` (null on git/network
 *                     error or a detached/missing origin).
 * @param opts.driftAgeSeconds  how long drift has persisted (from a marker
 *                     file); ignored when SHAs match. Default 0.
 * @param opts.graceSeconds     grace window before drift is LOUD. Default
 *                     {@link DEFAULT_DRIFT_GRACE_SECONDS}.
 * @param opts.dirtyTreePaths   tracked-but-modified paths in $HYDRA_ROOT, if
 *                     detected — surfaced as the probable drift *cause*
 *                     (deploy.sh's dirty-tree guard blocks a deploy). Empty
 *                     / undefined when the tree is clean or not probed.
 */
export function classifyDrift(
  deployedRaw: string | null,
  remoteRaw: string | null,
  opts: {
    driftAgeSeconds?: number;
    graceSeconds?: number;
    dirtyTreePaths?: ReadonlyArray<string>;
  } = {},
): DriftReport {
  const graceSeconds = opts.graceSeconds ?? DEFAULT_DRIFT_GRACE_SECONDS;
  const driftAgeSeconds = Math.max(0, Math.trunc(opts.driftAgeSeconds ?? 0));

  const deployed = shortSha(deployedRaw);
  const remote = shortSha(remoteRaw);

  // --- Unknown: a SHA could not be resolved (never alarming) ---
  if (deployed === null || remote === null) {
    const reason =
      deployed === null && remote === null
        ? "neither the deployed SHA nor origin/master could be resolved"
        : deployed === null
          ? "the deployed SHA is unavailable (/api/health unreachable or field absent)"
          : "origin/master could not be resolved (detached origin or git/network error)";
    return {
      verdict: "unknown",
      severity: "info",
      deployedSha: deployed ?? "?",
      remoteSha: remote ?? "?",
      driftAgeSeconds: 0,
      message: `deploy drift: UNKNOWN — ${reason}; skipping compare (information-only)`,
    };
  }

  // --- In sync ---
  if (shasMatch(deployed, remote)) {
    return {
      verdict: "in-sync",
      severity: "info",
      deployedSha: deployed,
      remoteSha: remote,
      driftAgeSeconds: 0,
      message: `deploy drift: in sync (deployed=${deployed} == origin/master=${remote})`,
    };
  }

  // --- Drift within the grace window (a deploy is likely mid-flight) ---
  const cause = describeCause(opts.dirtyTreePaths);
  if (driftAgeSeconds < graceSeconds) {
    return {
      verdict: "settling",
      severity: "info",
      deployedSha: deployed,
      remoteSha: remote,
      driftAgeSeconds,
      message:
        `deploy drift: settling — deployed=${deployed} != origin/master=${remote}, ` +
        `but only ${driftAgeSeconds}s old (< ${graceSeconds}s grace); a deploy is likely mid-flight`,
      note: cause,
    };
  }

  // --- Sustained drift past the grace window — LOUD ---
  return {
    verdict: "drift",
    severity: "critical",
    deployedSha: deployed,
    remoteSha: remote,
    driftAgeSeconds,
    message:
      `deploy drift: DRIFT — production is running STALE code: deployed=${deployed} ` +
      `!= origin/master=${remote} for ${driftAgeSeconds}s (>= ${graceSeconds}s grace). ` +
      `Deploy-on-merge did not restart the service — run scripts/deploy.sh from the master checkout.`,
    note: cause,
  };
}

/**
 * Build the probable-cause note from dirty-tree paths. A spurious tracked
 * modification (e.g. `docker/ov.conf`) trips deploy.sh's dirty-tree guard,
 * which aborts the deploy and leaves prod stale — the exact class of cause
 * the issue #2663 durable-fix asks us to surface when detectable.
 */
function describeCause(dirtyTreePaths?: ReadonlyArray<string>): string | undefined {
  if (!dirtyTreePaths || dirtyTreePaths.length === 0) return undefined;
  const shown = dirtyTreePaths.slice(0, 5).join(", ");
  const more = dirtyTreePaths.length > 5 ? ` (+${dirtyTreePaths.length - 5} more)` : "";
  return (
    `probable cause: the master checkout has a dirty tree (${shown}${more}) — ` +
    `deploy.sh's dirty-tree guard aborts the deploy, leaving prod stale. ` +
    `Reset/commit the tracked change, then re-run scripts/deploy.sh.`
  );
}

/**
 * Build the Redis alert body when drift is sustained (verdict `drift`).
 * Short — operators read it truncated to ~90 chars in `hydra alerts ls`.
 */
export function buildDriftAlertMessage(report: DriftReport): string {
  return (
    `Prod build drift: deployed ${report.deployedSha} != origin/master ` +
    `${report.remoteSha} for ${report.driftAgeSeconds}s — production is running stale code`
  );
}
