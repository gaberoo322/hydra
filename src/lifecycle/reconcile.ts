/**
 * Lifecycle reconcile pass (ADR-0047 Decisions 1, 2, 4, 5; issue #5316).
 *
 * One deterministic tick over the open board. It NEVER undoes an operator's
 * label edit: out-of-seam state changes are journaled as `external` and the
 * journal's notion of state becomes GitHub's. It only fires record-checked
 * transitions, and only through the seam's `advance()` with `actor: 'reconcile'`:
 *
 *   - `qa-passed` exits (read live at head by the shared `classifyQaPassedExit`)
 *   - zero state labels -> `needs-triage` (epics, `keep-open`, `wayfinder:*` exempt)
 *   - 2+ state labels -> journaled once as invalid, never edited, surfaced on attention
 *   - an external `parked ->` exit -> one `Hydra-Cap-Reset:` marker
 *   - external close / reopen -> journal entries (+ retention clock)
 *
 * Never throws (STD-VERIFY-NEVER-THROW): a failed open-board read aborts the
 * pass with zero writes; a per-issue failure is recorded and the loop goes on.
 * Every external effect is an injectable dep. `dryRun` runs the whole
 * classification with every write skipped.
 */
import { logger } from "../logger.ts";
import { declaresEpicChildren } from "../github/blockers.ts";
import type { IssueReadResult, IssueRow } from "../github/issues.ts";
import type {
  JournalWriteResult,
  LifecycleJournalEntry,
} from "../redis/lifecycle-journal.ts";
import { latestResetMs } from "./caps.ts";
import {
  bodyClosesIssue,
  classifyQaPassedExit,
  parsePrEvidence,
  type Fetched,
} from "./gates.ts";
import { latestCapParkPr, postCapReset } from "./park.ts";
import { advance, releaseClaim, type AdvanceInput, type AdvanceResult, type SeamDeps } from "./seam.ts";
import { externalMoves, lastKnownState } from "./timeline.ts";
import { stateLabelsOf } from "./transitions.ts";

export const MAX_TIMELINE_FETCHES = 25;
export const MAX_QA_EXIT_EVALS = 20;
export const RECENTLY_CLOSED_WINDOW_MS = 48 * 60 * 60 * 1000;
export const RECENTLY_CLOSED_LIMIT = 100;
export const REPORT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** A held dispatch claim at or past this age is closed by the stale arm (ADR-0047 D5); one value for every class. */
export const STALE_CLAIM_AGE_MS = 2 * 60 * 60 * 1000;
/** Bound on stale-claim closes per reconcile pass. */
export const MAX_STALE_CLAIM_CLOSES = 25;
export const RECONCILE_ACTOR = "reconcile";
export const INVALID_STATE_RESULT = "invalid:state-ambiguous";

export interface OpenPrRef {
  number: number;
  body: string;
}

export interface ReconcileDeps {
  seam: SeamDeps;
  listOpenIssues: () => Promise<IssueReadResult<IssueRow>>;
  /** The tick's ONE open-PR read. */
  listOpenPrs: () => Promise<Fetched<OpenPrRef[]>>;
  /** Issues closed since `sinceIso`, newest first, capped at {@link RECENTLY_CLOSED_LIMIT}. */
  listRecentlyClosed: (sinceIso: string) => Promise<IssueReadResult<IssueRow>>;
  persistJournal: (repo: string, issue: number) => Promise<JournalWriteResult>;
  writeReport: (report: ReconcileReport, ts: number) => Promise<JournalWriteResult>;
}

export interface ReconcileOptions {
  dryRun?: boolean;
  maxTimelineFetches?: number;
  maxQaExitEvals?: number;
}

export interface ReconcileReport {
  ts: number;
  repo: string;
  mode: "shadow" | "enforce" | null;
  dryRun: boolean;
  scanned: { open: number; recentlyClosed: number };
  invalid: Array<{ number: number; labels: string[] }>;
  zeroStateRelabeled: number[];
  zeroStateExempt: number;
  externalEntries: number;
  capResetsPosted: number;
  /**
   * Stale-claim arm: claims scanned; closed (in dry-run, would close); spared because
   * another dispatcher re-opened the issue first; deferred past the per-pass bound; failed.
   */
  staleClaims: { scanned: number; closed: number; spared: number; deferred: number; failed: number };
  qaExits: {
    "needs-dev-resume": number;
    "needs-qa": number;
    closed: number;
    "ready-for-agent": number;
    none: number;
    unresolved: number;
  };
  seamTransitions: number;
  wouldRefuseByReason: Record<string, number>;
  wouldParkByArm: Record<string, number>;
  errors: string[];
}

export function emptyReport(repo: string, ts: number, dryRun: boolean): ReconcileReport {
  return {
    ts,
    repo,
    mode: null,
    dryRun,
    scanned: { open: 0, recentlyClosed: 0 },
    invalid: [],
    zeroStateRelabeled: [],
    zeroStateExempt: 0,
    externalEntries: 0,
    capResetsPosted: 0,
    staleClaims: { scanned: 0, closed: 0, spared: 0, deferred: 0, failed: 0 },
    qaExits: { "needs-dev-resume": 0, "needs-qa": 0, closed: 0, "ready-for-agent": 0, none: 0, unresolved: 0 },
    seamTransitions: 0,
    wouldRefuseByReason: {},
    wouldParkByArm: {},
    errors: [],
  };
}

const SHADOW_REFUSE_PREFIX = "shadow-would-refuse:";
const SHADOW_PARK_PREFIX = "shadow-would-park:";

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

/**
 * Fold a journal's 7-day window into the report's seam-transition / would-refuse / would-park counts.
 * Scope (INV-10, deliberately narrowed): only OPEN issues' journals are tallied; issues closed
 * inside the window are not counted because no journal-wide SCAN accessor exists.
 */
function tallyJournal(report: ReconcileReport, entries: readonly LifecycleJournalEntry[], now: number): void {
  for (const e of entries) {
    if (typeof e.ts !== "number" || e.ts < now - REPORT_WINDOW_MS) continue;
    if (e.kind === "transition") report.seamTransitions++;
    if (e.kind === "refused" && typeof e.result === "string") {
      if (e.result.startsWith(SHADOW_REFUSE_PREFIX)) bump(report.wouldRefuseByReason, e.result.slice(SHADOW_REFUSE_PREFIX.length));
      if (e.result.startsWith(SHADOW_PARK_PREFIX)) bump(report.wouldParkByArm, e.result.slice(SHADOW_PARK_PREFIX.length));
    }
  }
}

/** True when the zero-state backstop must leave this issue alone (ADR-0047 D2). */
export function isZeroStateExempt(issue: Pick<IssueRow, "labels" | "body">): boolean {
  return (
    declaresEpicChildren(issue.body) ||
    issue.labels.includes("keep-open") ||
    issue.labels.some((l) => l.startsWith("wayfinder:"))
  );
}

/**
 * The qa-passed exit's PR, resolved from pointers and never guessed: the `pr`
 * evidence on the latest `to='qa-passed'` journal entry, else the single OPEN PR
 * whose body closes the issue. Null for zero or 2+ candidates.
 */
export function resolveQaPr(
  entries: readonly LifecycleJournalEntry[],
  issue: number,
  openPrs: readonly OpenPrRef[] | null,
): number | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].to !== "qa-passed") continue;
    const n = parsePrEvidence(entries[i].evidence ?? {});
    if (n !== null && n > 0) return n;
    break;
  }
  if (openPrs === null) return null;
  const candidates = openPrs.filter((p) => bodyClosesIssue(p.body, issue));
  return candidates.length === 1 ? candidates[0].number : null;
}

function externalEntry(
  ts: number,
  from: string | null,
  to: string,
  evidence: Record<string, string>,
  result: string,
): LifecycleJournalEntry {
  return {
    v: 1,
    ts,
    kind: "external",
    from,
    to,
    source: "external",
    actor: "external",
    evidence,
    reason: null,
    rationale: null,
    result,
    written: true,
  };
}

/** Run one reconcile tick. Never throws. */
export async function runReconcile(deps: ReconcileDeps, opts: ReconcileOptions = {}): Promise<ReconcileReport> {
  const dryRun = opts.dryRun === true;
  const maxTimeline = opts.maxTimelineFetches ?? MAX_TIMELINE_FETCHES;
  const maxQa = opts.maxQaExitEvals ?? MAX_QA_EXIT_EVALS;
  const repo = deps.seam.repo;
  const now = deps.seam.now();
  const report = emptyReport(repo, now, dryRun);
  try {
    report.mode = await deps.seam.mode();
    const open = await deps.listOpenIssues();
    if (open.ok === false) {
      report.errors.push("open-issues-read-failed");
      return report;
    }
    report.scanned.open = open.rows.length;

    const prsRead = await deps.listOpenPrs();
    const openPrs = prsRead.ok ? prsRead.value : null;
    if (!prsRead.ok) report.errors.push("open-prs-read-failed");

    const append = async (issue: number, e: LifecycleJournalEntry): Promise<void> => {
      if (dryRun) return;
      const res = await deps.seam.journal.append(repo, issue, e);
      if (res.ok === false) report.errors.push(`journal-append-failed:#${issue}`);
    };
    const apply = async (input: AdvanceInput): Promise<AdvanceResult | null> =>
      dryRun ? null : advance(input, deps.seam);

    let timelineFetches = 0;
    let qaEvals = 0;
    for (const issue of open.rows) {
      try {
        await reconcileOpenIssue(issue);
      } catch (err) {
        logger.error({ err, issue: issue.number }, "[lifecycle-reconcile] issue failed");
        report.errors.push(`issue-failed:#${issue.number}`);
      }
    }

    async function reconcileOpenIssue(issue: IssueRow): Promise<void> {
      if (issue.labels.includes("target-backlog")) return;
      const states = stateLabelsOf(issue.labels);
      const journalRead = await deps.seam.journal.read(repo, issue.number);
      if (journalRead.ok === false) report.errors.push(`journal-read-failed:#${issue.number}`);
      const entries = journalRead.ok ? journalRead.entries : [];
      tallyJournal(report, entries, now);
      const known = lastKnownState(entries);

      // An open issue the journal believes closed: external reopen.
      if (known === "closed") {
        await append(
          issue.number,
          externalEntry(now, "closed", states.length === 1 ? states[0] : "unknown", { labels: states.join(",") }, "external:reopened"),
        );
        if (!dryRun) {
          const persisted = await deps.persistJournal(repo, issue.number);
          if (persisted.ok === false) report.errors.push(`persist-failed:#${issue.number}`);
        }
        report.externalEntries++;
        return;
      }

      if (states.length > 1) {
        const labels = [...states].sort();
        const joined = labels.join(",");
        report.invalid.push({ number: issue.number, labels });
        if (!alreadyJournaledInvalid(entries, joined)) {
          await append(issue.number, {
            v: 1,
            ts: now,
            kind: "refused",
            from: null,
            to: null,
            source: "external",
            actor: RECONCILE_ACTOR,
            evidence: { labels: joined },
            reason: null,
            rationale: null,
            result: INVALID_STATE_RESULT,
            written: false,
          });
        }
        return;
      }

      if (states.length === 0) {
        if (isZeroStateExempt(issue)) {
          report.zeroStateExempt++;
          return;
        }
        const relabel = await apply({
          issue: issue.number,
          to: "needs-triage",
          actor: RECONCILE_ACTOR,
          reason: "rerouted",
          rationale: "zero-state backstop",
        });
        // Count only a relabel that was written (or, in dry-run, would be attempted).
        if (relabel !== null && relabel.ok === false) {
          report.errors.push(`zero-state-refused:#${issue.number}:${relabel.code}`);
        } else {
          report.zeroStateRelabeled.push(issue.number);
        }
        return;
      }

      const current = states[0];
      // Diff-first external detection (INV-8): fetch the timeline only on a mismatch.
      if (known !== null && known !== current && timelineFetches < maxTimeline) {
        timelineFetches++;
        const tl = await deps.seam.fetch.timeline(issue.number);
        if (tl.ok === false) {
          report.errors.push(`timeline-fetch-failed:#${issue.number}`);
        } else {
          const moves = externalMoves(tl.value, known, current);
          let parkExitMs: number | null = null;
          for (const m of moves) if (m.from === "parked" && m.tsMs > 0) parkExitMs = m.tsMs;
          // Marker first: if it cannot be confirmed, append nothing so the diff
          // (journal != GitHub) fires again next tick and the marker is retried.
          if (parkExitMs !== null && !(await postResetOnce(issue.number, parkExitMs))) return;
          for (const m of moves) {
            await append(
              issue.number,
              externalEntry(m.tsMs > 0 ? m.tsMs : now, m.from, m.to, { at: new Date(m.tsMs > 0 ? m.tsMs : now).toISOString() }, "external"),
            );
            report.externalEntries++;
          }
        }
      }

      if (current === "qa-passed" && qaEvals < maxQa) {
        qaEvals++;
        const pr = resolveQaPr(entries, issue.number, openPrs);
        if (pr === null) {
          report.qaExits.unresolved++;
          return;
        }
        const live = deps.seam.fetch.qaLive ? await deps.seam.fetch.qaLive(pr) : ({ ok: false } as const);
        if (live.ok === false) {
          report.errors.push(`qa-live-failed:#${issue.number}`);
          return;
        }
        const target = classifyQaPassedExit(live.value);
        if (target === "none") {
          report.qaExits.none++;
        } else {
          const exit = await apply({
            issue: issue.number,
            to: target,
            evidence: { pr: String(pr) },
            actor: RECONCILE_ACTOR,
            reason: "rerouted",
            rationale: `qa-passed exit read live at head of PR #${pr}`,
          });
          // Count the exit only once the seam wrote it (null = dry-run: would route).
          if (exit !== null && exit.ok === false) {
            report.errors.push(`qa-exit-refused:#${issue.number}:${exit.code}`);
          } else {
            report.qaExits[target]++;
          }
        }
      }
    }

    // One cap-reset marker per external un-park, keyed by the event's own timestamp.
    // Resolves true when the marker is posted or already present (safe to journal the move).
    async function postResetOnce(issue: number, eventMs: number): Promise<boolean> {
      const comments = await deps.seam.fetch.issueComments(issue);
      if (comments.ok === false) {
        report.errors.push(`cap-reset-comments-failed:#${issue}`);
        return false;
      }
      const issueNeeds = latestResetMs(comments.value) < eventMs;
      // The qa-fail-rounds arm reads PR bodies, so the PR needs its own marker
      // even when the operator already posted one on the issue.
      const found = await latestCapParkPr(issue, deps.seam);
      if (!found.ok) {
        // Unreadable park journal is unknown, not "no PR": fail closed and retry next pass.
        report.errors.push(`cap-reset-journal-failed:#${issue}`);
        return false;
      }
      const pr = found.pr;
      let prNeeds = false;
      if (pr !== null) {
        const bodies = await deps.seam.fetch.prBodies(pr);
        if (bodies.ok === false) {
          // PR side unknown: record it, but never let an unfetchable PR wedge the
          // entry every pass (unbounded) or block the issue-side marker. Post the
          // issue half, then resolve; the error surfaces the missing PR marker.
          report.errors.push(`cap-reset-pr-bodies-failed:#${issue}`);
        } else {
          prNeeds = latestResetMs(bodies.value) < eventMs;
        }
      }
      if (!issueNeeds && !prNeeds) return true;
      report.capResetsPosted++;
      if (dryRun) return true;
      const res = await postCapReset(
        issue,
        { by: "external", ts: new Date(eventMs).toISOString() },
        deps.seam,
        { issue: issueNeeds, pr: prNeeds },
      );
      if (res.ok === false || res.pr === "post-failed" || res.pr === "lookup-failed") {
        report.capResetsPosted--;
        report.errors.push(`cap-reset-failed:#${issue}`);
        return false;
      }
      return true;
    }

    // Stale-claim arm (ADR-0047 D5): compare-and-delete on each claim's OWN dispatchId,
    // so a claim re-opened by another dispatcher between list and close survives.
    async function closeStaleClaims(): Promise<void> {
      if (!deps.seam.journal.listClaims) return;
      const listed = await deps.seam.journal.listClaims(repo);
      if (listed.ok === false) {
        report.errors.push("stale-claims-list-failed");
        return;
      }
      const stats = report.staleClaims;
      stats.scanned = listed.claims.length;
      for (const { issue, claim } of listed.claims) {
        if (!(now - claim.openedAt >= STALE_CLAIM_AGE_MS)) continue;
        if (stats.closed + stats.spared + stats.failed >= MAX_STALE_CLAIM_CLOSES) {
          stats.deferred++;
          continue;
        }
        if (dryRun) {
          stats.closed++;
          continue;
        }
        try {
          const res = await releaseClaim(issue, claim.dispatchId, deps.seam, RECONCILE_ACTOR, "stale");
          if (res.ok === true) {
            stats.closed++;
          } else if (res.code === "claim-owner-mismatch") {
            stats.spared++;
          } else {
            stats.failed++;
            report.errors.push(`stale-claim-close-failed:#${issue}:${res.code}`);
          }
        } catch (err) {
          logger.error({ err, issue }, "[lifecycle-reconcile] stale claim close failed");
          stats.failed++;
          report.errors.push(`stale-claim-close-failed:#${issue}`);
        }
      }
    }

    // External close (INV-9): a recently closed issue whose journal has no terminal closed entry.
    const sinceIso = new Date(now - RECENTLY_CLOSED_WINDOW_MS).toISOString();
    const closed = await deps.listRecentlyClosed(sinceIso);
    if (closed.ok === false) {
      report.errors.push("recently-closed-read-failed");
    } else {
      report.scanned.recentlyClosed = closed.rows.length;
      for (const issue of closed.rows) {
        try {
          const j = await deps.seam.journal.read(repo, issue.number);
          if (j.ok === false || j.entries.length === 0) continue;
          if (j.entries.some((e) => e.to === "closed" && e.written === true)) continue;
          await append(
            issue.number,
            externalEntry(now, lastKnownState(j.entries), "closed", {}, "external:closed"),
          );
          if (!dryRun) {
            const expired = await deps.seam.journal.expireOnClose(repo, issue.number);
            if (expired.ok === false) report.errors.push(`expire-failed:#${issue.number}`);
          }
          report.externalEntries++;
        } catch (err) {
          logger.error({ err, issue: issue.number }, "[lifecycle-reconcile] closed-issue pass failed");
          report.errors.push(`issue-failed:#${issue.number}`);
        }
      }
    }

    await closeStaleClaims();

    if (!dryRun) {
      const written = await deps.writeReport(report, now);
      if (written.ok === false) report.errors.push("report-write-failed");
    }
    return report;
  } catch (err) {
    logger.error({ err }, "[lifecycle-reconcile] pass crashed");
    report.errors.push("reconcile-crashed");
    return report;
  }
}

/** True when the latest invalid entry already names exactly this label set and nothing has moved since. */
function alreadyJournaledInvalid(entries: readonly LifecycleJournalEntry[], joined: string): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.result === INVALID_STATE_RESULT) return e.evidence?.labels === joined;
    if (e.written === true && typeof e.to === "string" && e.to !== "") return false;
  }
  return false;
}
