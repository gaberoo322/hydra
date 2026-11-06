/**
 * Lifecycle caps (ADR-0047 Decision 6, issue #5314).
 *
 * The cap table and the pure count predicates over the three count sources:
 * the lifecycle journal, the `QA-Verdict:` trailers on the PR, and the GitHub
 * label timeline. Every count runs from the latest `Hydra-Cap-Reset:` marker.
 *
 * Pure: no fs / network / Redis / clock. Env and `now` are inputs; the module
 * never throws and returns warnings for the caller to log. It imports only
 * the QA prior-round/trailer modules and lifecycle data modules, and
 * `src/qa/round-action.ts` imports it (one direction).
 *
 * One comparator for every arm: an attempt parks iff `count >= limit`, where
 * `count` is the number of PRIOR attempts already consumed on that arm since
 * the latest reset (never including the attempt being opened).
 */
import { priorFindingsSection, qaVerdictHistory } from "../qa/prior-round.ts";
import { isFailVerdict } from "../qa/verdict-trailer.ts";

// ---------------------------------------------------------------------------
// Cap table
// ---------------------------------------------------------------------------

export const CAP_ARMS = [
  "qa-fail-rounds",
  "dev-nopr-resume",
  "qa-stall",
  "red-ci-forward-fix",
  "stale-requeue",
  "needs-dev-resume-claims",
  "total-claims",
] as const;
export type CapArm = (typeof CAP_ARMS)[number];

export type CapUnit = "issue" | "pr";

export interface CapRow {
  readonly arm: CapArm;
  readonly unit: CapUnit;
  readonly limit: number;
}

/** Table order is the park-naming order: per-arm rows first, then the total. */
export const CAP_TABLE: readonly CapRow[] = [
  { arm: "qa-fail-rounds", unit: "pr", limit: 3 },
  { arm: "dev-nopr-resume", unit: "issue", limit: 2 },
  { arm: "qa-stall", unit: "issue", limit: 3 },
  { arm: "red-ci-forward-fix", unit: "pr", limit: 2 },
  { arm: "stale-requeue", unit: "issue", limit: 2 },
  { arm: "needs-dev-resume-claims", unit: "issue", limit: 4 },
  { arm: "total-claims", unit: "issue", limit: 10 },
];

export const CAP_DEFAULTS: Readonly<Record<CapArm, number>> = Object.fromEntries(
  CAP_TABLE.map((r) => [r.arm, r.limit]),
) as Record<CapArm, number>;

/** The arm whose limit is NOT env-overridable (seam, round-action and merge guard must agree). */
const NON_OVERRIDABLE: readonly CapArm[] = ["qa-fail-rounds"];

export const CAP_ENV_PREFIX = "HYDRA_LIFECYCLE_CAP_";

export function capEnvName(arm: CapArm): string {
  return CAP_ENV_PREFIX + arm.toUpperCase().replace(/-/g, "_");
}

export interface ResolvedLimits {
  limits: Record<CapArm, number>;
  /** One line per ignored (non positive-integer) override, for the caller to log. */
  warnings: string[];
}

export function resolveCapLimits(env: Readonly<Record<string, string | undefined>>): ResolvedLimits {
  const limits = { ...CAP_DEFAULTS };
  const warnings: string[] = [];
  for (const arm of CAP_ARMS) {
    if (NON_OVERRIDABLE.includes(arm)) continue;
    const name = capEnvName(arm);
    const raw = env[name];
    if (raw === undefined || raw === "") continue;
    if (/^[1-9]\d*$/.test(raw.trim())) {
      limits[arm] = Number(raw.trim());
    } else {
      warnings.push(`${name}=${JSON.stringify(raw)} is not a positive integer; using default ${CAP_DEFAULTS[arm]}`);
    }
  }
  return { limits, warnings };
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export type DispatchRole = "dev" | "qa" | "other";

/** Pure prefix rule: `dev_*` or `glm*` -> dev, `qa_*` -> qa, else other. */
export function classRole(cls: string): DispatchRole {
  if (cls.startsWith("dev_") || cls.startsWith("glm")) return "dev";
  if (cls.startsWith("qa_")) return "qa";
  return "other";
}

// ---------------------------------------------------------------------------
// Reset marker
// ---------------------------------------------------------------------------

export const CAP_RESET_PREFIX = "Hydra-Cap-Reset:";

const RESET_LINE_RE = /^Hydra-Cap-Reset:[ \t]+by=(\S+)[ \t]+ts=(\S+)[ \t]*\r?$/;

/** The latest VALID reset ts (epoch ms) in one body; a malformed marker line is ignored. */
export function parseCapResetTs(body: string | null | undefined): number | null {
  if (typeof body !== "string" || !body.includes(CAP_RESET_PREFIX)) return null;
  let latest: number | null = null;
  for (const line of body.split("\n")) {
    const m = RESET_LINE_RE.exec(line);
    if (!m) continue;
    const t = Date.parse(m[2]);
    if (Number.isNaN(t)) continue;
    if (latest === null || t > latest) latest = t;
  }
  return latest;
}

/** The latest valid reset across bodies (epoch ms), 0 when there is none. */
export function latestResetMs(bodies: ReadonlyArray<string | null | undefined>): number {
  let latest = 0;
  for (const b of bodies) {
    const t = parseCapResetTs(b);
    if (t !== null && t > latest) latest = t;
  }
  return latest;
}

/** True when the body carries a VALID reset line (same validity as the issue side). */
function hasResetLine(body: string | null | undefined): boolean {
  return parseCapResetTs(body) !== null;
}

/**
 * Reviewed FAIL rounds on `pr`, counting only `priorBodies` AFTER the last body
 * with a `Hydra-Cap-Reset:` line (positional: PR comments arrive chronological,
 * reviews after). A CI-only round (no findings table) reviewed nothing and never
 * counts. The one predicate behind both `decideQaRoundAction` and the seam's
 * `qa-fail-rounds` arm.
 */
export function countReviewedFailRoundsSinceReset(
  priorBodies: ReadonlyArray<string | null | undefined>,
  pr: number,
): number {
  let start = 0;
  priorBodies.forEach((b, i) => {
    if (hasResetLine(b)) start = i + 1;
  });
  const bodies = priorBodies.slice(start);
  return qaVerdictHistory(bodies, pr).filter(
    (t) => isFailVerdict(t.verdict) && priorFindingsSection(bodies, pr, t.round) !== "",
  ).length;
}

// ---------------------------------------------------------------------------
// Count sources
// ---------------------------------------------------------------------------

/** The structural subset of a lifecycle journal entry the counts read. */
export interface CapJournalEntry {
  ts: number;
  kind: string;
  from: string | null;
  to: string | null;
  evidence: Record<string, string>;
  reason: string | null;
  result: string;
  written: boolean;
}

/** One `labeled` / `unlabeled` event of the issue timeline. */
export interface TimelineLabelEvent {
  event: "labeled" | "unlabeled";
  label: string;
  tsMs: number;
}

export type CapSource = "journal" | "trailer" | "timeline-derived";

export interface CapCount {
  arm: CapArm;
  unit: CapUnit;
  count: number;
  limit: number;
  source: CapSource;
  /** Whether the arm can park the attempt being made. */
  applicable: boolean;
}

export const TIMELINE_ARMS = ["total-claims", "needs-dev-resume-claims", "stale-requeue"] as const;
export type TimelineArm = (typeof TIMELINE_ARMS)[number];
const PAIR_WINDOW_MS = 60_000;

/** Counts of the three timeline-derivable arms from events after `resetMs`. */
export function timelineArmCounts(
  events: readonly TimelineLabelEvent[],
  resetMs: number,
): Record<TimelineArm, number> {
  const ev = events.filter((e) => e.tsMs > resetMs);
  const labeledFor = (name: string) => ev.filter((e) => e.event === "labeled" && e.label === name);
  const requeues = ev.filter((e) => e.event === "unlabeled" && e.label === "in-progress");
  const readyAgain = labeledFor("ready-for-agent").map((e) => e.tsMs);
  let stale = 0;
  for (const u of requeues) {
    const i = readyAgain.findIndex((t) => Math.abs(t - u.tsMs) <= PAIR_WINDOW_MS);
    if (i < 0) continue;
    readyAgain.splice(i, 1);
    stale += 1;
  }
  return {
    "total-claims": labeledFor("in-progress").length,
    "needs-dev-resume-claims": labeledFor("needs-dev-resume").length,
    "stale-requeue": stale,
  };
}

function isStaleRequeueEntry(e: CapJournalEntry): boolean {
  return e.from === "in-progress" && e.to === "ready-for-agent" && e.written === true;
}

/** How many times `e` counts toward a timeline arm (also the seed contribution). */
export function entryContribution(arm: TimelineArm, e: CapJournalEntry): number {
  if (arm === "total-claims") return e.kind === "claim-opened" ? 1 : 0;
  if (arm === "needs-dev-resume-claims") {
    return e.kind === "claim-opened" && e.evidence.state === "needs-dev-resume" ? 1 : 0;
  }
  return isStaleRequeueEntry(e) ? 1 : 0;
}

function countJournalArm(arm: CapArm, entries: readonly CapJournalEntry[], pr: number | null): number {
  switch (arm) {
    case "total-claims":
    case "needs-dev-resume-claims":
    case "stale-requeue":
      return entries.reduce((n, e) => n + entryContribution(arm, e), 0);
    case "red-ci-forward-fix":
      return entries.filter(
        (e) =>
          e.kind === "claim-opened" &&
          e.evidence.purpose === "forward-fix" &&
          pr !== null &&
          e.evidence.pr === String(pr),
      ).length;
    case "qa-stall":
      return entries.filter(
        (e) => e.kind === "claim-closed" && classRole(e.evidence.class ?? "") === "qa" && e.evidence.outcome === "stall",
      ).length;
    case "dev-nopr-resume": {
      let n = 0;
      let lastClosed: string | null = null;
      for (const e of entries) {
        if (e.kind === "claim-closed" && classRole(e.evidence.class ?? "") === "dev") {
          lastClosed = e.evidence.outcome ?? "";
        } else if (e.kind === "claim-opened" && classRole(e.evidence.class ?? "") === "dev") {
          if (lastClosed === "no-pr") n += 1;
          lastClosed = null;
        }
      }
      return n;
    }
    case "qa-fail-rounds":
      return 0; // trailer-sourced; see evaluateCaps
  }
}

/** The outcome the most recent claim of `role` closed with, or null. */
function lastClosedOutcome(entries: readonly CapJournalEntry[], role: DispatchRole): string | null {
  let last: string | null = null;
  for (const e of entries) {
    if (classRole(e.evidence.class ?? "") !== role) continue;
    if (e.kind === "claim-closed") last = e.evidence.outcome ?? "";
    else if (e.kind === "claim-opened") last = null;
  }
  return last;
}

export type CapAttempt =
  | {
      kind: "claim";
      class: string;
      /** The re-read lifecycle state of the issue ("" when none/ambiguous). */
      state: string;
      pr: number | null;
      purpose: "fresh" | "resume" | "forward-fix" | null;
    }
  | { kind: "requeue" }
  /** A reviewed QA FAIL on `pr` is about to bounce `needs-qa -> needs-dev-resume` (#5317). */
  | { kind: "qa-fail"; pr: number };

export interface CapInput {
  attempt: CapAttempt;
  /** Journal entries in append order (all, unfiltered). */
  entries: readonly CapJournalEntry[];
  /** Whether the journal read itself failed (treated as a miss). */
  journalFailed?: boolean;
  resetMs: number;
  /** Timeline events; required when the journal missed (else ignored). */
  timeline: readonly TimelineLabelEvent[] | null;
  /** Reviewed FAIL rounds from trailers; null when the PR was not read. */
  trailerRounds: number | null;
  limits: Readonly<Record<CapArm, number>>;
}

export interface CapEvaluation {
  /** Every arm's count, in table order. */
  counts: CapCount[];
  /** The first applicable arm at or over its limit, or null. */
  over: CapCount | null;
  /** True when the journal had nothing since the reset and the timeline was used. */
  journalMiss: boolean;
  /** Timeline counts to seed into the first post-miss entry; null off a miss. */
  timelineCounts: Record<TimelineArm, number> | null;
}

export function isJournalMiss(
  entries: readonly CapJournalEntry[],
  resetMs: number,
  journalFailed = false,
): boolean {
  return journalFailed || !entries.some((e) => e.ts > resetMs);
}

/** Pure evaluation of every arm for one attempt. Never throws. */
export function evaluateCaps(input: CapInput): CapEvaluation {
  const post = input.journalFailed ? [] : input.entries.filter((e) => e.ts > input.resetMs);
  const miss = isJournalMiss(input.entries, input.resetMs, input.journalFailed);
  const timelineCounts = miss && input.timeline ? timelineArmCounts(input.timeline, input.resetMs) : null;
  const claim = input.attempt.kind === "claim" ? input.attempt : null;
  const qaFail = input.attempt.kind === "qa-fail";
  const role = claim ? classRole(claim.class) : "other";
  const pr = claim ? claim.pr : null;

  const applicable = (arm: CapArm): boolean => {
    if (qaFail) return arm === "qa-fail-rounds";
    if (!claim) return arm === "stale-requeue";
    switch (arm) {
      case "total-claims":
        return true;
      case "needs-dev-resume-claims":
        return claim.state === "needs-dev-resume";
      case "dev-nopr-resume":
        return role === "dev" && lastClosedOutcome(post, "dev") === "no-pr";
      case "qa-stall":
        return role === "qa" && lastClosedOutcome(post, "qa") === "stall";
      case "red-ci-forward-fix":
        return claim.purpose === "forward-fix" && pr !== null;
      case "qa-fail-rounds":
        return pr !== null;
      case "stale-requeue":
        return false;
    }
  };

  const counts: CapCount[] = CAP_TABLE.map((row) => {
    let count: number;
    let source: CapSource = "journal";
    if (row.arm === "qa-fail-rounds") {
      count = input.trailerRounds ?? 0;
      source = "trailer";
    } else if ((TIMELINE_ARMS as readonly string[]).includes(row.arm)) {
      const arm = row.arm as TimelineArm;
      // Latest baseline for this arm wins; entries AFTER it are added.
      let base = 0;
      let start = 0;
      for (let i = post.length - 1; i >= 0; i--) {
        const raw = post[i].evidence[`baseline.${arm}`];
        if (post[i].evidence["cap-baseline"] === "timeline-derived" && raw !== undefined && /^\d+$/.test(raw)) {
          base = Number(raw);
          start = i + 1;
          source = "timeline-derived";
          break;
        }
      }
      if (timelineCounts) {
        count = timelineCounts[arm];
        source = "timeline-derived";
      } else {
        count = base + countJournalArm(arm, post.slice(start), pr);
      }
    } else {
      count = countJournalArm(row.arm, post, pr);
    }
    return { arm: row.arm, unit: row.unit, count, limit: input.limits[row.arm], source, applicable: applicable(row.arm) };
  });
  const over = counts.find((c) => c.applicable && c.count >= c.limit) ?? null;
  return { counts, over, journalMiss: miss, timelineCounts };
}

/**
 * Evidence that seeds the first post-miss journal entry so later journal counts
 * are `baseline + entries after it`. The seeding entry's own contribution is
 * folded in (it is not counted again as an "entry after"). Returns {} when
 * every derived count is zero (an all-zero timeline equals no baseline).
 */
export function buildSeedEvidence(
  timelineCounts: Readonly<Record<TimelineArm, number>>,
  seedEntry: CapJournalEntry,
): Record<string, string> {
  const out: Record<string, string> = {};
  let any = false;
  for (const arm of TIMELINE_ARMS) {
    out[`baseline.${arm}`] = String(timelineCounts[arm] + entryContribution(arm, seedEntry));
    if (timelineCounts[arm] > 0) any = true;
  }
  return any ? { "cap-baseline": "timeline-derived", ...out } : {};
}

/** `arm=count/limit` pairs for the rationale and the park comment. */
export function renderCapCounts(counts: readonly CapCount[]): string {
  return counts.map((c) => `${c.arm}=${c.count}/${c.limit}`).join(" ");
}
