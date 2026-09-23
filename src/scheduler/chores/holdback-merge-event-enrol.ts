/**
 * Merge-event holdback enrolment chore (issue #4632, ADR-0034 §8/§9, guidance-epic
 * 13/19; design-concept `issue-4632`).
 *
 * One of the Housekeeping chore family (`src/scheduler/chores/`), registered in
 * `src/scheduler/housekeeping.ts` AFTER both `holdback-merge-watch.ts` and
 * `cycle-merge-reconcile.ts` (INV-8) — registered PRs are processed by
 * merge-watch first, so a PR self-armed THIS tick is still in the pending
 * registry and skipped here until merge-watch handles it next tick.
 *
 * **The gap this closes.** The pending-enroll registry
 * (`hydra:holdback:pending-enroll`) is fed only by the autopilot's
 * `POST /holdback/pending` on auto-merge and by `cycle-merge-reconcile`'s
 * self-arm (which requires a cycle record). An operator/hand merge has
 * neither, so it never reaches `enrollHoldback` — a T2+ change that bypassed
 * the registry silently never gets an Outcome Holdback watch. Separately, a
 * self-armed entry carries `tier: null` (the #3078 path never resolves a
 * tier) and `enrollHoldback` drops a tier-null merge as "tier unknown" — so
 * even a self-armed T2+ PR never actually enrolled. Both close via the same
 * discover → classify → enrol path here.
 *
 * **Discovery (INV-1).** One `gh api repos/{repo}/pulls?state=closed&base=
 * master&sort=updated&direction=desc&per_page=100` call per tick (via
 * `ghJson`, `src/github/gh.ts`) — no GraphQL, no local git reads, orchestrator
 * repo only. A candidate is a listed PR with a non-null `merged_at` inside the
 * 48h lookback ({@link MERGE_EVENT_LOOKBACK_MS}) and a `merge_commit_sha`.
 *
 * **"Unregistered" is mechanical (INV-2).** A candidate is skipped when: (a)
 * its `prNumber` is in the pending-enroll registry (merge-watch owns it); (b)
 * an enrol-state record already exists for its merge SHA in a terminal state
 * (`enrolled`/`exempt`/`no-signal`/`failed` — NOT `retrying`, which is
 * retried); or (c) a holdback baseline already exists for the SHA — in which
 * case a `backfill`-sourced `'enrolled'` state record is written (so a later
 * tick's dedup check finds it) WITHOUT calling `enroll` again (a second enrol
 * would overwrite the pre-merge baseline with a post-merge one, INV-12). The
 * per-PR `enrolled-marker` (`hydra:holdback:enrolled-marker`) is deliberately
 * NOT a skip signal here — merge-watch sets it for tier-null entries it
 * dropped WITHOUT enrolling, which is exactly the gap this chore must still
 * pick up.
 *
 * **Tier derivation (INV-4).** `classifyChange(files).tier` — the SAME
 * classifier the tier-gate uses, imported read-only (`src/tier-classifier.ts`
 * is Verifier Core and is never edited here). `files` come from
 * `gh api repos/{repo}/pulls/{n}/files --paginate`. A files-fetch failure is
 * an attempt failure for that PR (INV-6), never a guessed tier. Classification
 * is bounded to {@link MERGE_EVENT_CONFIRM_LIMIT} per tick (the files call is
 * the cost) — the rest are counted `deferred` and drain on later ticks.
 *
 * **Failure accounting (INV-6).** A files-fetch failure or an `enroll`
 * `ok:false` increments the SHA's enrol-state `attempts` and writes
 * `'retrying'` — or `'failed'` once `HOLDBACK_ENROL_MAX_ATTEMPTS`
 * (`src/holdback-policy.ts`) is reached. The ladder arithmetic itself is the
 * pure `nextEnrolFailureRecord`/`nextEnrolOutcomeRecord` helpers in that same
 * module — shared with `src/holdback.ts`'s `recordEnrolAttemptFailure` /
 * `recordEnrolOutcome` (the writers `holdback-merge-watch.ts` and the manual
 * `POST /holdback/enroll` route use) — so the increment/threshold logic is
 * computed identically everywhere, while THIS chore reads/writes the record
 * through its own injected `getEnrolState`/`recordEnrolState` deps (never the
 * non-injectable `src/holdback.ts` coordinators) so the no-Redis decision-logic
 * test suite can exercise the full ladder without a live Redis. Only
 * `'failed'` is the operator-visible breakage signal (ADR-0034 §8.1 "not a
 * bucket"); `enrolled:false` outcomes (T1 → `'exempt'`, no outcome data →
 * `'no-signal'`) are healthy states, never failures.
 *
 * **Never throws, observable (INV-9).** A listing failure persists a health
 * snapshot with `listError` and returns immediately — chore health, not a
 * per-PR failure. Every other fault is per-PR: logged and left for a later
 * tick, never aborting the pass. Health snapshot at
 * `hydra:holdback:merge-event:health` (`src/redis/holdback-merge-watch.ts`).
 */

import { ghJson } from "../../github/gh.ts";
import { isGhFailure } from "../../github/exec.ts";
import { resolveGithubRepo } from "../../github/issues.ts";
import { classifyChange } from "../../tier-classifier.ts";
import { enrollHoldback, type EnrollResult } from "../../holdback.ts";
import {
  classifyEnrolNoEnrollState,
  nextEnrolFailureRecord,
  nextEnrolOutcomeRecord,
  HOLDBACK_ENROL_MAX_ATTEMPTS,
} from "../../holdback-policy.ts";
import { loadBaseline } from "../../redis/holdback.ts";
import {
  pendingEnrollList,
  getEnrolState,
  recordEnrolState,
  setMergeEventHealth,
  type PendingEnrollListResult,
  type EnrolStateReadResult,
  type EnrolStateWriteResult,
  type HoldbackEnrolState,
  type MergeEventHealthRecord,
} from "../../redis/holdback-merge-watch.ts";
import { logger } from "../../logger.ts";

/** Lookback window for the merge listing (issue #4632 INV-1): 48 hours. */
export const MERGE_EVENT_LOOKBACK_MS = 48 * 60 * 60 * 1000;

/** Max NEW candidates classified (one `gh` files call each) per tick (INV-4). */
export const MERGE_EVENT_CONFIRM_LIMIT = 10;

/** Automatic-attempt ceiling before a candidate's state becomes terminal
 * `'failed'` (INV-6) — re-exported from the shared policy constant so this
 * chore's own doc comments can name it directly. */
export const MERGE_EVENT_MAX_ATTEMPTS = HOLDBACK_ENROL_MAX_ATTEMPTS;

/** One merged-PR candidate as decoded off the `gh api pulls` listing. */
export interface MergedPrCandidate {
  number: number;
  /** ISO `merged_at` timestamp. */
  mergedAt: string;
  mergeCommitSha: string;
}

interface RawClosedPr {
  number?: unknown;
  merged_at?: unknown;
  merge_commit_sha?: unknown;
}

/**
 * Default merge listing: `gh api repos/{repo}/pulls?state=closed&base=master
 * &sort=updated&direction=desc&per_page=100`. Returns `null` on any failure
 * (never throws) — the caller treats `null` as "could not scan this tick".
 * Exported (test-only) so a wired test can drive it through a fake `gh`.
 */
export async function listMergedPrsViaGh(): Promise<MergedPrCandidate[] | null> {
  const repo = resolveGithubRepo();
  if (!repo) return null;
  const res = await ghJson<RawClosedPr[]>([
    "api",
    `repos/${repo}/pulls?state=closed&base=master&sort=updated&direction=desc&per_page=100`,
  ]);
  if (isGhFailure(res)) return null;
  if (!Array.isArray(res.data)) return null;
  const out: MergedPrCandidate[] = [];
  for (const raw of res.data) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as RawClosedPr;
    const number = typeof r.number === "number" ? r.number : NaN;
    const mergedAt = typeof r.merged_at === "string" ? r.merged_at : null;
    const sha = typeof r.merge_commit_sha === "string" ? r.merge_commit_sha : null;
    if (!Number.isFinite(number) || number <= 0 || !mergedAt || !sha) continue;
    out.push({ number, mergedAt, mergeCommitSha: sha });
  }
  return out;
}

interface RawPrFile {
  filename?: unknown;
}

/**
 * Default file-list fetch: `gh api repos/{repo}/pulls/{n}/files --paginate`.
 * Returns `null` on any failure (never throws). Exported (test-only) so a
 * wired test can drive it through a fake `gh` and count invocations.
 */
export async function fetchPrFilesViaGh(prNumber: number): Promise<string[] | null> {
  const repo = resolveGithubRepo();
  if (!repo) return null;
  const res = await ghJson<RawPrFile[]>(["api", `repos/${repo}/pulls/${prNumber}/files`, "--paginate"]);
  if (isGhFailure(res)) return null;
  if (!Array.isArray(res.data)) return null;
  return res.data
    .filter((f): f is RawPrFile => !!f && typeof f === "object")
    .map((f) => f.filename)
    .filter((f): f is string => typeof f === "string" && f.length > 0);
}

/** External touchpoints of the chore (all injectable for tests so the
 * decision logic runs without `gh` / a live Redis). */
export interface HoldbackMergeEventEnrolDeps {
  /** List recently-closed PRs. Defaults to {@link listMergedPrsViaGh}. */
  listMergedPrs?: () => Promise<MergedPrCandidate[] | null>;
  /** List a PR's changed files. Defaults to {@link fetchPrFilesViaGh}. */
  fetchPrFiles?: (prNumber: number) => Promise<string[] | null>;
  /** List the pending-enroll registry. Defaults to `pendingEnrollList`. */
  listPending?: () => Promise<PendingEnrollListResult>;
  /** Load a commit's holdback baseline, if any. Defaults to `loadBaseline`. */
  loadBaseline?: typeof loadBaseline;
  /** Snapshot the pre-merge baseline. Defaults to `enrollHoldback`. */
  enroll?: (input: { commitSha: string; prNumber: number; tier: number }) => Promise<EnrollResult>;
  /** Read a commit's enrol-state record. Defaults to `getEnrolState`. */
  getEnrolState?: (commitSha: string) => Promise<EnrolStateReadResult>;
  /** Upsert a commit's enrol-state record. Defaults to `recordEnrolState`. */
  recordEnrolState?: (record: HoldbackEnrolState) => Promise<EnrolStateWriteResult>;
  /** Persist the last-run health snapshot. Defaults to `setMergeEventHealth`. */
  setHealth?: (record: MergeEventHealthRecord) => Promise<void>;
  /** Injectable clock. Defaults to `Date.now`. */
  now?: () => number;
}

/** Per-run summary the chore returns (never throws). */
export interface HoldbackMergeEventEnrolResult {
  /** Closed PRs the listing returned this tick. */
  scanned: number;
  /** Of those, merged within the lookback with a merge commit SHA. */
  candidates: number;
  /** Newly enrolled this run. */
  enrolled: number;
  /** Classified T1 — exempt, no baseline. */
  exempt: number;
  /** Enrolled-tier but no outcome-adapter data. */
  noSignal: number;
  /** Hit an attempt failure this run and are retrying. */
  retrying: number;
  /** Exhausted attempts and are terminally failed. */
  failed: number;
  /** Already in the pending-enroll registry — merge-watch owns them. */
  skippedRegistered: number;
  /** Already had a terminal enrol-state row or an existing baseline. */
  skippedKnown: number;
  /** New candidates deferred past the per-tick classification limit. */
  deferred: number;
}

function emptyResult(): HoldbackMergeEventEnrolResult {
  return {
    scanned: 0,
    candidates: 0,
    enrolled: 0,
    exempt: 0,
    noSignal: 0,
    retrying: 0,
    failed: 0,
    skippedRegistered: 0,
    skippedKnown: 0,
    deferred: 0,
  };
}

/**
 * Run one merge-event enrolment pass. See the module doc for the full
 * discover → dedup → classify → enrol contract. Never throws (INV-9).
 */
export async function runMergeEventEnrol(
  deps: HoldbackMergeEventEnrolDeps = {},
): Promise<HoldbackMergeEventEnrolResult> {
  const listMergedPrs = deps.listMergedPrs ?? listMergedPrsViaGh;
  const fetchPrFiles = deps.fetchPrFiles ?? fetchPrFilesViaGh;
  const listPending = deps.listPending ?? pendingEnrollList;
  const doLoadBaseline = deps.loadBaseline ?? loadBaseline;
  const enroll = deps.enroll ?? enrollHoldback;
  const getState = deps.getEnrolState ?? getEnrolState;
  const recordState = deps.recordEnrolState ?? recordEnrolState;
  const setHealth = deps.setHealth ?? setMergeEventHealth;
  const now = deps.now ?? Date.now;

  const result = emptyResult();

  const listed = await listMergedPrs();
  if (listed == null) {
    logger.error({}, "merge-event-enrol: listMergedPrs failed");
    await persistHealth(setHealth, result, "listMergedPrs failed");
    return result;
  }
  result.scanned = listed.length;

  const pendingRes = await listPending();
  if (pendingRes.ok === false) {
    logger.error(
      { err: { message: pendingRes.error } },
      "merge-event-enrol: pendingEnrollList failed; proceeding with an empty skip-set",
    );
  }
  const pendingPrNumbers = new Set<number>(
    pendingRes.ok ? pendingRes.entries.map((e) => e.prNumber) : [],
  );

  const cutoff = now() - MERGE_EVENT_LOOKBACK_MS;
  const candidates = listed.filter((c) => {
    const t = Date.parse(c.mergedAt);
    return Number.isFinite(t) && t >= cutoff;
  });
  result.candidates = candidates.length;

  let classifiedThisTick = 0;

  for (const candidate of candidates) {
    if (pendingPrNumbers.has(candidate.number)) {
      result.skippedRegistered += 1;
      continue;
    }

    const stateRes = await getState(candidate.mergeCommitSha);
    const existing = stateRes.ok ? stateRes.state : null;

    // (b) A terminal enrol-state record already exists — never `'retrying'`,
    // which is retried below instead of skipped.
    if (existing && existing.state !== "retrying") {
      result.skippedKnown += 1;
      continue;
    }

    // (c) A holdback baseline already exists for this SHA — record the fact
    // (backfill) and never re-enrol (INV-12: a second enrol would overwrite
    // the pre-merge baseline with a post-merge one). Only checked when no
    // enrol-state record exists yet — a `'retrying'` record means we already
    // know this SHA and are mid-attempt-ladder, not newly discovering it.
    if (!existing) {
      const baselineRes = await doLoadBaseline(candidate.mergeCommitSha);
      if (baselineRes.ok && baselineRes.baseline) {
        await recordState({
          commitSha: candidate.mergeCommitSha,
          prNumber: candidate.number,
          tier: baselineRes.baseline.tier ?? null,
          source: "backfill",
          state: "enrolled",
          attempts: 0,
          mergedAt: candidate.mergedAt,
          firstSeenAt: new Date(now()).toISOString(),
          updatedAt: new Date(now()).toISOString(),
        });
        result.skippedKnown += 1;
        continue;
      }
    }

    if (classifiedThisTick >= MERGE_EVENT_CONFIRM_LIMIT) {
      result.deferred += 1;
      continue;
    }
    classifiedThisTick += 1;

    await processCandidate(candidate, existing, {
      fetchPrFiles,
      enroll,
      recordState,
      now,
      result,
    });
  }

  await persistHealth(setHealth, result);

  if (result.enrolled > 0 || result.failed > 0 || result.candidates > 0) {
    logger.info(
      {
        scanned: result.scanned,
        candidates: result.candidates,
        enrolled: result.enrolled,
        exempt: result.exempt,
        noSignal: result.noSignal,
        retrying: result.retrying,
        failed: result.failed,
        skippedRegistered: result.skippedRegistered,
        skippedKnown: result.skippedKnown,
        deferred: result.deferred,
      },
      "merge-event-enrol: pass complete",
    );
  }

  return result;
}

/**
 * Classify + enrol one newly-discovered candidate (bounded by the caller's
 * per-tick limit). Reads/writes the enrol-state record ONLY through the
 * caller's injected `recordState` (never the non-injectable `src/holdback.ts`
 * coordinators), computing the attempt ladder via the shared pure
 * `nextEnrolFailureRecord`/`nextEnrolOutcomeRecord` helpers — so a test can
 * drive this function's full retrying→failed ladder with a fake in-memory
 * store, no live Redis. Never throws — a `gh`/enroll failure routes to the
 * ladder instead of propagating.
 */
async function processCandidate(
  candidate: MergedPrCandidate,
  existing: HoldbackEnrolState | null,
  ctx: {
    fetchPrFiles: (prNumber: number) => Promise<string[] | null>;
    enroll: (input: { commitSha: string; prNumber: number; tier: number }) => Promise<EnrollResult>;
    recordState: (record: HoldbackEnrolState) => Promise<EnrolStateWriteResult>;
    now: () => number;
    result: HoldbackMergeEventEnrolResult;
  },
): Promise<void> {
  const nowIso = () => new Date(ctx.now()).toISOString();
  try {
    const files = await ctx.fetchPrFiles(candidate.number);
    if (files == null) {
      const next = nextEnrolFailureRecord(existing, nowIso());
      await ctx.recordState({
        commitSha: candidate.mergeCommitSha,
        prNumber: candidate.number,
        tier: existing?.tier ?? null,
        source: "merge-event",
        state: next.state,
        reason: "files fetch failed",
        attempts: next.attempts,
        mergedAt: candidate.mergedAt,
        firstSeenAt: next.firstSeenAt,
        updatedAt: nowIso(),
      });
      if (next.state === "failed") ctx.result.failed += 1;
      else ctx.result.retrying += 1;
      return;
    }

    const tier = classifyChange(files).tier;
    const enrollRes = await ctx.enroll({
      commitSha: candidate.mergeCommitSha,
      prNumber: candidate.number,
      tier,
    });

    if (enrollRes.ok === false) {
      const next = nextEnrolFailureRecord(existing, nowIso());
      await ctx.recordState({
        commitSha: candidate.mergeCommitSha,
        prNumber: candidate.number,
        tier,
        source: "merge-event",
        state: next.state,
        reason: enrollRes.error,
        attempts: next.attempts,
        mergedAt: candidate.mergedAt,
        firstSeenAt: next.firstSeenAt,
        updatedAt: nowIso(),
      });
      if (next.state === "failed") ctx.result.failed += 1;
      else ctx.result.retrying += 1;
      return;
    }

    const outcomeMeta = nextEnrolOutcomeRecord(existing, nowIso());
    if (enrollRes.enrolled === true) {
      await ctx.recordState({
        commitSha: candidate.mergeCommitSha,
        prNumber: candidate.number,
        tier,
        source: "merge-event",
        state: "enrolled",
        attempts: outcomeMeta.attempts,
        mergedAt: candidate.mergedAt,
        firstSeenAt: outcomeMeta.firstSeenAt,
        updatedAt: nowIso(),
      });
      ctx.result.enrolled += 1;
      return;
    }

    const state = classifyEnrolNoEnrollState(enrollRes.reason);
    await ctx.recordState({
      commitSha: candidate.mergeCommitSha,
      prNumber: candidate.number,
      tier,
      source: "merge-event",
      state,
      reason: enrollRes.reason,
      attempts: outcomeMeta.attempts,
      mergedAt: candidate.mergedAt,
      firstSeenAt: outcomeMeta.firstSeenAt,
      updatedAt: nowIso(),
    });
    if (state === "exempt") ctx.result.exempt += 1;
    else ctx.result.noSignal += 1;
  } catch (err: any) {
    // Defensive: no dep should throw (all are best-effort result-returning),
    // but if one does, log and leave the candidate for the next tick.
    logger.error({ prNumber: candidate.number, err }, "merge-event-enrol: unexpected error");
  }
}

/** Persist the last-run health snapshot (best-effort). */
async function persistHealth(
  setHealth: (record: MergeEventHealthRecord) => Promise<void>,
  result: HoldbackMergeEventEnrolResult,
  listError?: string,
): Promise<void> {
  try {
    const record: MergeEventHealthRecord = {
      ranAt: new Date().toISOString(),
      scanned: result.scanned,
      candidates: result.candidates,
      enrolled: result.enrolled,
      exempt: result.exempt,
      noSignal: result.noSignal,
      retrying: result.retrying,
      failed: result.failed,
      skippedRegistered: result.skippedRegistered,
      skippedKnown: result.skippedKnown,
      deferred: result.deferred,
    };
    if (listError) record.listError = listError;
    await setHealth(record);
  } catch (err: any) {
    logger.error({ err }, "merge-event-enrol: health persist failed");
  }
}
