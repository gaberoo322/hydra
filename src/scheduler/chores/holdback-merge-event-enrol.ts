/**
 * Merge-event holdback enrolment chore (issue #4632, ADR-0034 §8.1).
 *
 * One of the Housekeeping chore family (`src/scheduler/chores/`), registered in
 * `src/scheduler/housekeeping.ts`. Every OTHER merge-watch mechanism in this
 * repo only observes merges the autopilot itself set in motion:
 *
 *   - `holdback-merge-watch.ts` drains the **pending-enroll registry**, seeded
 *     by a `POST /holdback/pending` the autopilot session runs when it ARMS a
 *     PR for auto-merge.
 *   - `cycle-merge-reconcile.ts` self-arms a PR that skipped that POST, but
 *     only by scanning **cycle records** — and a cycle record exists only for
 *     a PR `reap.py` dispatched in the first place.
 *
 * Neither path can see a PR that never went through the autopilot at all: an
 * **operator merge** (`gh pr merge` run by hand) or a **hand-shepherded PR**
 * (built outside the autopilot loop, merged directly). Per ADR-0034 §8.1
 * ("Not a bucket: T2 holdback enrolment... merge-event enrolment covers
 * unregistered T2+ merges"), this chore is that closing mechanism: it scans
 * GitHub's own merged-PR list directly — the one source of truth no registry
 * or cycle record can be missing from — classifies each candidate from its
 * OWN changed files (never a self-asserted PR-body `Tier:` line, matching the
 * CLAUDE.md "the authoritative logic is `src/tier-classifier.ts`" rule), and
 * enrolls any unregistered T2+ merge exactly as the primary path would have,
 * keyed on the merge commit.
 *
 * **Never double-processes a PR the normal path already handled.** Before
 * attempting anything, a candidate is skipped if it is (a) still present in
 * the pending-enroll registry (the normal watcher will get to it) or (b)
 * already `wasEnrolledMarked` (the normal watcher, or a prior run of THIS
 * chore, already processed its landing) — both read through the SAME shared
 * marker `holdback-merge-watch.ts` uses, so the two mechanisms can never
 * double-enroll one PR.
 *
 * **A failure surfaces once and stays surfaced — it is never silently
 * retried.** Per §8.1, holdback enrolment is deliberately invisible
 * automation; only a *failure* is operator-visible, as a breakage-feed-style
 * row with a confirm-first "Enrol now" action (`POST
 * /holdback/merge-event-enrol/retry`). So once a candidate has ANY recorded
 * outcome (`enrolled` or `failed`) this chore skips it on every later tick —
 * re-attempting a durably-broken merge automatically would both spam retries
 * and defeat the "surfaces once, needs a human nod" design. The explicit
 * retry route is the only path back to `enrolled`.
 *
 * **Never throws (CLAUDE.md).** A `gh`/API failure for one candidate is
 * logged and that candidate is left unrecorded (retried next tick); a failure
 * never aborts the remaining candidates. Returns a summary object.
 *
 * **Bounded.** Scans at most `scanLimit` recently-merged PRs per tick (the
 * `gh` calls are the cost), mirroring `cycle-merge-reconcile`'s posture.
 */

import { ghJson } from "../../github/gh.ts";
import { isGhFailure } from "../../github/exec.ts";
import { resolveGithubRepo, viewPr, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_BUFFER } from "../../github/issues.ts";
import {
  pendingEnrollList,
  wasEnrolledMarked,
  markEnrolled,
  getMergeEventEnrolRecord,
  recordMergeEventEnrolResult,
} from "../../redis/holdback-merge-watch.ts";
import { enrollHoldback, type EnrollResult } from "../../holdback.ts";
import { isEnrolledTier } from "../../holdback-policy.ts";
import { classifyChange, type ClassifyResult } from "../../tier-classifier.ts";
import { logger } from "../../logger.ts";

/** How many recently-merged PRs to scan per tick (bounds the `gh` cost). */
const DEFAULT_SCAN_LIMIT = 30;

/** One merged-PR candidate as {@link listRecentMergedPrsViaGh} returns it. */
export interface MergeEventCandidate {
  prNumber: number;
  mergeCommitSha: string;
}

/** Raw `gh pr list --json number,mergeCommit` row shape. */
interface RawMergedPrRow {
  number?: unknown;
  mergeCommit?: { oid?: unknown } | null;
}

/**
 * List the `limit` most-recently-merged PRs on the orchestrator repo, oldest
 * filtering left to the caller (gh returns them in its own default order —
 * this chore treats the whole bounded window as an unordered candidate set,
 * matching `cycle-merge-reconcile`'s posture). Returns `null` on any `gh`
 * failure (never throws) so the caller can leave the whole tick for a retry
 * rather than guessing at a partial result.
 *
 * Exported (test-only) so a wired test can drive it through a fake `gh`
 * binary; production always binds the default.
 */
export async function listRecentMergedPrsViaGh(
  limit: number,
): Promise<MergeEventCandidate[] | null> {
  const repo = resolveGithubRepo();
  if (!repo) return null;
  const res = await ghJson<unknown>(
    ["pr", "list", "--repo", repo, "--state", "merged", "--limit", String(limit), "--json", "number,mergeCommit"],
    { timeout: DEFAULT_TIMEOUT_MS, maxBuffer: DEFAULT_MAX_BUFFER },
  );
  if (isGhFailure(res)) return null;
  const parsed = Array.isArray(res.data) ? (res.data as RawMergedPrRow[]) : [];
  const out: MergeEventCandidate[] = [];
  for (const row of parsed) {
    const number = typeof row.number === "number" ? row.number : NaN;
    const oid = row.mergeCommit && typeof row.mergeCommit === "object" ? row.mergeCommit.oid : undefined;
    if (!Number.isFinite(number) || number <= 0) continue;
    if (typeof oid !== "string" || oid.length === 0) continue;
    out.push({ prNumber: number, mergeCommitSha: oid });
  }
  return out;
}

/** Raw `gh pr view --json files` shape. */
interface RawPrFiles {
  files?: Array<{ path?: unknown }> | null;
}

/**
 * Fetch a PR's changed-file paths (the tier classifier's sole input) via
 * `gh pr view <n> --json files`. `files` is not on the REST inline-field map
 * (`view-pr.ts`), so this forces the GraphQL transport — mirroring
 * `holdback-merge-watch.ts`'s `fetchMergeStatusViaGh`, which does the same for
 * `mergeCommit`/`changedFiles`. Returns `null` on any failure (never throws).
 *
 * Exported (test-only) so a wired test can drive it through a fake `gh`
 * binary; production always binds the default.
 */
export async function fetchChangedFilesViaGh(prNumber: number): Promise<string[] | null> {
  const view = await viewPr<RawPrFiles>(prNumber, "files", { transport: "graphql" });
  if (view == null) return null;
  const files = Array.isArray(view.files) ? view.files : [];
  return files
    .map((f) => (f && typeof f.path === "string" ? f.path : null))
    .filter((p): p is string => p !== null);
}

/** External touchpoints of the chore (all injectable for tests so the
 * decision logic runs without gh / a live Redis). */
export interface HoldbackMergeEventEnrolDeps {
  /** List recently-merged candidate PRs. Defaults to `listRecentMergedPrsViaGh`. */
  listMergedCandidates?: (limit: number) => Promise<MergeEventCandidate[] | null>;
  /** Fetch a PR's changed-file paths. Defaults to `fetchChangedFilesViaGh`. */
  fetchChangedFiles?: (prNumber: number) => Promise<string[] | null>;
  /** Snapshot the pending-enroll registry once per tick. Defaults to `pendingEnrollList`. */
  listPending?: typeof pendingEnrollList;
  /** Has this PR's landing already been processed (by either watcher)? Defaults to `wasEnrolledMarked`. */
  wasEnrolled?: typeof wasEnrolledMarked;
  /** Mark this PR's landing processed. Defaults to `markEnrolled`. */
  mark?: typeof markEnrolled;
  /** Read this PR's prior merge-event-enrol outcome, if any. Defaults to `getMergeEventEnrolRecord`. */
  getRecord?: typeof getMergeEventEnrolRecord;
  /** Persist this PR's merge-event-enrol outcome. Defaults to `recordMergeEventEnrolResult`. */
  recordResult?: typeof recordMergeEventEnrolResult;
  /** Snapshot the pre-merge baseline. Defaults to `enrollHoldback`. */
  enroll?: typeof enrollHoldback;
  /** Classify a diff's tier from its changed files. Defaults to `classifyChange`. */
  classify?: (files: string[]) => ClassifyResult;
  /** Max recently-merged PRs to scan this tick. Defaults to 30. */
  scanLimit?: number;
}

/** Per-run summary the chore returns (never throws). */
export interface HoldbackMergeEventEnrolResult {
  /** Merged PRs examined this tick. */
  scanned: number;
  /** Unregistered candidates whose files were fetched for tier classification. */
  candidates: number;
  /** Unregistered T2+ merges successfully enrolled (or legitimately dropped —
   * ok:true with no signal — this tick). */
  enrolled: number;
  /** Unregistered T2+ merges whose enrol attempt failed — recorded, queryable,
   * and left for a confirm-first manual retry (never auto-retried). */
  failed: number;
  /** A step succeeded but a bookkeeping write (the shared marker) failed —
   * left wholly unrecorded so the next tick retries the whole attempt
   * (`enrollHoldback` is idempotent on the commit SHA). */
  retried: number;
  /** Skipped: already in the pending registry or already marker-processed —
   * the normal watcher owns (or already owned) this PR. */
  skippedRegistered: number;
  /** Skipped: classified tier is not T2+ (a normal, uninteresting merge). */
  skippedNotEligibleTier: number;
  /** Skipped: this chore already recorded an outcome for this PR — a failure
   * awaits its confirm-first retry, never an automatic re-attempt. */
  skippedAlreadyRecorded: number;
  /** Candidates whose changed-files fetch failed — retried next tick. */
  fetchFailed: number;
}

/**
 * Run one merge-event enrolment pass over recently-merged PRs.
 *
 * For each of the `scanLimit` most-recently-merged PRs:
 *   - skip if already registered (pending entry) or already processed (shared
 *     marker) — the normal watcher owns it;
 *   - skip if this chore already recorded an outcome for it (a failure awaits
 *     its confirm-first retry, never an automatic re-attempt);
 *   - fetch its changed files and classify the tier from THEM (never a
 *     self-asserted PR-body line); skip non-enrolled tiers (T1/unknown);
 *   - otherwise fire `enrollHoldback`, keyed on the merge commit, and record
 *     the outcome (`enrolled` or `failed`) plus, on success, the shared
 *     "landing processed" marker.
 *
 * Returns a summary; never throws.
 */
export async function runHoldbackMergeEventEnrol(
  deps: HoldbackMergeEventEnrolDeps = {},
): Promise<HoldbackMergeEventEnrolResult> {
  const listMergedCandidates = deps.listMergedCandidates ?? listRecentMergedPrsViaGh;
  const fetchChangedFiles = deps.fetchChangedFiles ?? fetchChangedFilesViaGh;
  const listPending = deps.listPending ?? pendingEnrollList;
  const wasEnrolled = deps.wasEnrolled ?? wasEnrolledMarked;
  const mark = deps.mark ?? markEnrolled;
  const getRecord = deps.getRecord ?? getMergeEventEnrolRecord;
  const recordResult = deps.recordResult ?? recordMergeEventEnrolResult;
  const enroll = deps.enroll ?? enrollHoldback;
  const classify = deps.classify ?? classifyChange;
  const scanLimit = deps.scanLimit ?? DEFAULT_SCAN_LIMIT;

  const result: HoldbackMergeEventEnrolResult = {
    scanned: 0,
    candidates: 0,
    enrolled: 0,
    failed: 0,
    retried: 0,
    skippedRegistered: 0,
    skippedNotEligibleTier: 0,
    skippedAlreadyRecorded: 0,
    fetchFailed: 0,
  };

  const merged = await listMergedCandidates(scanLimit);
  if (merged == null) {
    logger.error({}, "holdback-merge-event-enrol: listMergedCandidates failed");
    return result;
  }

  // Snapshot the pending-enroll registry ONCE per tick (cheaper than a
  // per-candidate read; mirrors cycle-merge-reconcile's arm-blind avoidance).
  // A read failure disables the registry-membership skip for this tick rather
  // than blocking the whole pass — the shared `wasEnrolled` marker still
  // prevents a double-enrol of any PR the normal watcher already finished.
  let pendingSet: Set<number>;
  try {
    const p = await listPending();
    if (p.ok === false) {
      logger.error(
        { err: { message: p.error } },
        "holdback-merge-event-enrol: pendingEnrollList failed; proceeding without registry-membership skip",
      );
      pendingSet = new Set();
    } else {
      pendingSet = new Set(p.entries.map((e) => e.prNumber));
    }
  } catch (err: any) {
    logger.error({ err }, "holdback-merge-event-enrol: pendingEnrollList threw");
    pendingSet = new Set();
  }

  for (const candidate of merged) {
    result.scanned += 1;
    const { prNumber, mergeCommitSha } = candidate;
    try {
      if (pendingSet.has(prNumber) || (await wasEnrolled(prNumber))) {
        result.skippedRegistered += 1;
        continue;
      }

      const existing = await getRecord(prNumber);
      if (existing != null) {
        // Already has a recorded outcome from a prior tick — `enrolled` needs
        // nothing further, and `failed` is retried ONLY via the explicit
        // confirm-first API route (never silently re-attempted here).
        result.skippedAlreadyRecorded += 1;
        continue;
      }

      result.candidates += 1;

      const files = await fetchChangedFiles(prNumber);
      if (files == null) {
        logger.error({ prNumber }, "holdback-merge-event-enrol: changed-files fetch failed; retrying next tick");
        result.fetchFailed += 1;
        continue;
      }

      const classification = classify(files);
      if (!isEnrolledTier(classification.tier)) {
        // T1/unknown — exempt, and not "unregistered T2+" in the first place.
        // Nothing to record: this is a normal, uninteresting merge.
        result.skippedNotEligibleTier += 1;
        continue;
      }

      const enrollRes: EnrollResult = await enroll({
        commitSha: mergeCommitSha,
        prNumber,
        tier: classification.tier,
      });

      if (enrollRes.ok === false) {
        logger.error(
          { prNumber, err: { message: enrollRes.error } },
          "holdback-merge-event-enrol: enroll failed",
        );
        await recordResult({
          prNumber,
          commitSha: mergeCommitSha,
          tier: classification.tier,
          status: "failed",
          error: enrollRes.error,
          recordedAt: Date.now(),
        });
        result.failed += 1;
        continue;
      }

      // ok:true (enrolled:true, or enrolled:false for "no signal") — both are
      // a legitimate handled outcome, mirroring holdback-merge-watch's
      // landed/droppedExempt split. Mark processed FIRST via the shared
      // marker so the normal watcher (and this chore, next tick) never
      // re-fires for this PR.
      const marked = await mark(prNumber, mergeCommitSha);
      if (marked.ok === false) {
        // Bookkeeping-only failure — the enrol itself succeeded (and
        // `enrollHoldback` is idempotent on the commit SHA), so leave this PR
        // WHOLLY unrecorded (no marker, no outcome record) and let the next
        // tick retry the attempt from scratch, rather than misreporting a
        // successful enrolment as a "failed" breakage row.
        logger.error({ prNumber }, "holdback-merge-event-enrol: markEnrolled failed; leaving for retry");
        result.retried += 1;
        continue;
      }

      await recordResult({
        prNumber,
        commitSha: mergeCommitSha,
        tier: classification.tier,
        status: "enrolled",
        recordedAt: Date.now(),
      });
      result.enrolled += 1;
    } catch (err: any) {
      // Defensive: no dep should throw (all are best-effort result-returning),
      // but if one does, log and leave the candidate unrecorded — never abort
      // the remaining candidates.
      logger.error({ prNumber, err }, "holdback-merge-event-enrol: unexpected error");
      result.retried += 1;
    }
  }

  if (result.enrolled > 0 || result.failed > 0) {
    logger.info(
      {
        scanned: result.scanned,
        candidates: result.candidates,
        enrolled: result.enrolled,
        failed: result.failed,
        retried: result.retried,
        skippedRegistered: result.skippedRegistered,
        skippedNotEligibleTier: result.skippedNotEligibleTier,
        skippedAlreadyRecorded: result.skippedAlreadyRecorded,
        fetchFailed: result.fetchFailed,
      },
      "holdback-merge-event-enrol: pass complete",
    );
  }

  return result;
}
