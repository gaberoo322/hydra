/**
 * pattern-memory/demotion.ts — cue demotion on issue RESOLUTION (issue #3340).
 *
 * The inverse of the auto-escalation path (`escalation.ts`, issue #512). The
 * escalator promotes a chronic friction cue to a `meta-friction` GitHub issue
 * when its hit count crosses `PROMOTION_THRESHOLD` (and re-fires every +10
 * hits). But there was no inverse signal: once the operator (or a merged fix)
 * CLOSES that issue, the cue keeps its accumulated hit count, so the very next
 * hit lands at `threshold + N` and re-escalates the just-closed issue — a
 * "we solved it, stop re-filing" gap in the learning feedback loop.
 *
 * This module closes that loop. It:
 *   1. queries recently-CLOSED `meta-friction` issues via the `src/github/`
 *      seam,
 *   2. reverse-maps each closed issue's title back to its cue
 *      (`parseCueFromMetaTitle` — the inverse of `escalation.ts::buildTitle`),
 *   3. matches that cue to a friction-namespace pattern record across every
 *      known friction skill, and
 *   4. DEMOTES the matched pattern: `hitCount → hitCount % PROMOTION_THRESHOLD`
 *      so the cue must re-accumulate hits before it can re-threshold, and
 *      stamps `demoted/demotedAt/demotedReason` for observability.
 *
 * Idempotency
 * -----------
 * A per-issue Redis marker (`hydra:learning:demoted-issues`, a hash keyed by
 * issue number) records which closed issues have already driven a demotion, so
 * an hourly re-run does not re-demote (and drive `hitCount % 3` to churn) an
 * already-processed issue. Only the FIRST close of a given issue demotes.
 *
 * Namespace scope
 * ---------------
 * FRICTION NAMESPACE ONLY. The `meta-friction` label + the `meta(friction):` /
 * `meta(lesson):` title anchors identify friction-cue issues; the
 * memory-namespace patterns (planner/executor/skeptic) are deliberate
 * identifiers with per-cue escalation thresholds and are never demoted here.
 *
 * Never throws
 * ------------
 * Best-effort by design, on the same footing as the escalation adapter: a
 * missing `gh`, a network blip, or a Redis outage logs `console.error` with
 * context and returns a result object. The scheduler chore that drives this
 * (`src/scheduler/chores/pattern-cue-demotion.ts`) runs it through `runChore`,
 * which additionally guards against a thrown failure — but this function is
 * written to resolve, not raise.
 *
 * Test seam
 * ---------
 * All external touchpoints (the closed-issue query, the pattern load/save, the
 * idempotency marker read/write, the friction-skill list, the clock) are
 * injected via `CueDemotionDeps`, each defaulting to the real implementation, so
 * a unit test drives the whole demotion decision with plain fixtures and no
 * `gh`/Redis stood up.
 */

import { ghJson } from "../github/gh.ts";
import { isGhFailure } from "../github/exec.ts";
import { PROMOTION_THRESHOLD } from "./constants.ts";
import { logger } from "../logger.ts";
import {
  loadPatterns as loadPatternsReal,
  savePatterns as savePatternsReal,
  type MemoryPattern,
} from "./pattern-store.ts";
import {
  getDemotedIssueMarker as getDemotedIssueMarkerReal,
  setDemotedIssueMarker as setDemotedIssueMarkerReal,
} from "../redis/agent-memory.ts";

const REPO = process.env.HYDRA_GH_REPO || "gaberoo322/hydra";
const META_FRICTION_LABEL = "meta-friction";

/**
 * The friction skills whose pattern sets are scanned for a closed-issue cue
 * match. Mirrors the `FRICTION_SKILLS` list the friction-patterns diagnostic
 * (`src/api/pattern-memory.ts`) and the retro bundle scan — the three
 * autopilot skills that POST `/memory/subagent-friction`.
 *
 * ADR-0030 silent-rename seam (issue #3423, epic #3419, Decision 5). This is one
 * of the four non-derived seams that hardcode skill-name string literals and
 * would break SILENTLY on a stage rename — a renamed friction-producing class
 * dropped from this list without lock-stepping would stop having its resolved
 * cues demoted (they would keep re-escalating a just-closed issue). It is
 * migration-verified: the tickets-stage producer (`tickets_orch` → `to-tickets`,
 * ADR-0030 Decision 2) POSTs no `/memory/subagent-friction` — it RENDERS issues
 * and never runs the verification loop that emits friction — so `to-tickets` is
 * CORRECTLY absent here. The dev/qa fork skill names below stay until the epsilon
 * fork-identity retirement (#3424) and are updated in lock-step with any rename
 * that lands, keeping this list identical to the two mirror lists above.
 */
const DEFAULT_FRICTION_SKILLS = ["hydra-dev", "hydra-target-build", "hydra-qa"] as const;

/** How many recently-closed meta-friction issues to inspect per run. */
const CLOSED_ISSUE_LIMIT = 30;

/** Machine-readable demotion reason stamped on the pattern record. */
const DEMOTED_REASON_RESOLVED = "resolved";

/** One recently-closed meta-friction issue as read off the gh seam. */
export interface ClosedMetaIssue {
  number: number;
  title: string;
}

/**
 * Inverse of `escalation.ts::buildTitle`. Recovers the kebab-case cue from a
 * `meta-friction` issue title:
 *
 *   friction: `meta(friction): <cue> hit <n> times across <skills>`
 *   lesson:   `meta(lesson): <cue> hit <n> times`
 *
 * Returns the cue string, or `null` when the title does not match either
 * meta-friction title shape (a manually-filed meta-friction issue, or an
 * unrelated title that carried the label). Pure — exported for unit testing.
 */
export function parseCueFromMetaTitle(title: string): string | null {
  if (typeof title !== "string") return null;
  // Both shapes start with `meta(friction): ` / `meta(lesson): ` and place the
  // cue immediately before ` hit <n> times`. Capture the cue non-greedily up to
  // the ` hit <digits> times` anchor so a cue containing the word "hit" is not
  // truncated early.
  const m = title.match(/^meta\((?:friction|lesson)\):\s+(.+?)\s+hit\s+\d+\s+times\b/);
  if (!m) return null;
  const cue = m[1].trim();
  return cue.length > 0 ? cue : null;
}

/**
 * Pure demotion mutation. Given a matched friction pattern, reduce its hit
 * count modulo `PROMOTION_THRESHOLD` so the cue must re-accumulate before it can
 * re-threshold and re-escalate, and stamp the demotion metadata.
 *
 * `hitCount % PROMOTION_THRESHOLD` is the issue's prescribed math: a pattern at
 * exactly the threshold (3) or a multiple of it collapses to 0; a pattern at
 * `threshold + k` collapses to `k`, always strictly below the threshold, so the
 * NEXT hit cannot immediately re-cross. Mutates in place AND returns the same
 * reference for call-site convenience. Exported for unit testing.
 */
export function demotePattern(pattern: MemoryPattern, today: string): MemoryPattern {
  pattern.hitCount = pattern.hitCount % PROMOTION_THRESHOLD;
  pattern.promoted = false;
  pattern.demoted = true;
  pattern.demotedAt = today;
  pattern.demotedReason = DEMOTED_REASON_RESOLVED;
  return pattern;
}

/**
 * Injected touchpoints for `runCueDemotion`. Each defaults to the real
 * implementation; a unit test overrides just the ones it needs to drive the
 * demotion decision without `gh`/Redis.
 */
export interface CueDemotionDeps {
  /** Fetch recently-closed meta-friction issues. */
  fetchClosedIssues?: () => Promise<ClosedMetaIssue[]>;
  /** Load the friction-namespace pattern array for a skill. */
  loadPatterns?: (skill: string, namespace: "friction") => Promise<MemoryPattern[]>;
  /** Persist the friction-namespace pattern array for a skill. */
  savePatterns?: (
    skill: string,
    patterns: MemoryPattern[],
    namespace: "friction",
  ) => Promise<void>;
  /** Read the per-issue idempotency marker (null when unprocessed). */
  getMarker?: (issueNumber: string) => Promise<string | null>;
  /** Write the per-issue idempotency marker. */
  setMarker?: (issueNumber: string, value: string) => Promise<void>;
  /** The friction skills whose pattern sets are scanned for a cue match. */
  frictionSkills?: readonly string[];
  /** Clock (defaults to `Date.now`). */
  now?: () => number;
}

/** One demotion that actually fired, for the run summary. */
interface DemotionRecord {
  issueNumber: number;
  cue: string;
  skill: string;
  /** Hit count before the modulo demotion. */
  hitCountBefore: number;
  /** Hit count after the modulo demotion. */
  hitCountAfter: number;
}

/** Result of one demotion run. Never thrown — always returned. */
export interface CueDemotionResult {
  /** Closed meta-friction issues inspected this run. */
  scanned: number;
  /** Demotions applied this run (skips already-processed issues + no-match cues). */
  demotions: DemotionRecord[];
  /** Non-fatal error strings collected during the run (per-issue best-effort). */
  errors: string[];
}

/**
 * Default closed-issue query: the newest `CLOSED_ISSUE_LIMIT` CLOSED issues
 * carrying the `meta-friction` label. Uses the `src/github/` seam and degrades
 * an empty/malformed/failed result to `[]` (the demote-nothing path), mirroring
 * the escalation adapter's `findExistingIssue` degradation.
 */
async function fetchClosedMetaFrictionIssues(): Promise<ClosedMetaIssue[]> {
  const args = [
    "issue",
    "list",
    "--repo",
    REPO,
    "--label",
    META_FRICTION_LABEL,
    "--state",
    "closed",
    "--json",
    "number,title",
    "--limit",
    String(CLOSED_ISSUE_LIMIT),
  ];
  const result = await ghJson<Array<{ number: number; title: string }>>(args);
  if (isGhFailure(result)) {
    // gh-empty / gh-malformed-json → "no usable closed issues". A real process
    // failure (non-zero exit, timeout, missing binary) also degrades here rather
    // than throwing — the caller is best-effort and the seam already logged the
    // failure with context.
    return [];
  }
  const parsed = result.data;
  if (!Array.isArray(parsed)) return [];
  const out: ClosedMetaIssue[] = [];
  for (const row of parsed) {
    if (row && typeof row.number === "number" && typeof row.title === "string") {
      out.push({ number: row.number, title: row.title });
    }
  }
  return out;
}

/**
 * Run one cue-demotion pass — the inverse of the escalation path (issue #3340).
 *
 * For each recently-closed `meta-friction` issue not yet processed, recover its
 * cue, find the matching friction pattern across the known skills, and demote it
 * (`hitCount % PROMOTION_THRESHOLD` + demotion stamp). Idempotent via a per-issue
 * Redis marker so an hourly re-run does not re-demote an already-processed issue.
 *
 * Best-effort: never throws. Per-issue failures are collected into
 * `result.errors` and do not abort the remaining issues.
 */
export async function runCueDemotion(
  deps: CueDemotionDeps = {},
): Promise<CueDemotionResult> {
  const fetchClosedIssues = deps.fetchClosedIssues ?? fetchClosedMetaFrictionIssues;
  const loadPatterns = deps.loadPatterns ?? loadPatternsReal;
  const savePatterns = deps.savePatterns ?? savePatternsReal;
  const getMarker = deps.getMarker ?? getDemotedIssueMarkerReal;
  const setMarker = deps.setMarker ?? setDemotedIssueMarkerReal;
  const frictionSkills = deps.frictionSkills ?? DEFAULT_FRICTION_SKILLS;
  const nowFn = deps.now ?? Date.now;

  const result: CueDemotionResult = { scanned: 0, demotions: [], errors: [] };

  let closed: ClosedMetaIssue[];
  try {
    closed = await fetchClosedIssues();
  } catch (err: any) {
    const msg = err?.message || String(err);
    logger.error({ err }, "demotion: fetchClosedIssues failed");
    result.errors.push(msg);
    return result;
  }

  result.scanned = closed.length;
  const today = new Date(nowFn()).toISOString().split("T")[0];

  for (const issue of closed) {
    try {
      const marker = await getMarker(String(issue.number));
      if (marker) continue; // already demoted for this closed issue

      const cue = parseCueFromMetaTitle(issue.title);
      if (!cue) {
        // Manually-filed meta-friction issue or unparseable title: mark it so we
        // don't re-inspect it every hour, but record no demotion.
        await setMarker(String(issue.number), String(nowFn()));
        continue;
      }

      // Find the friction skill whose pattern set holds this cue (exact category
      // match — the canonical cue is what the escalation title carries).
      let demoted = false;
      for (const skill of frictionSkills) {
        const patterns = await loadPatterns(skill, "friction");
        const match = patterns.find(p => p.category === cue);
        if (!match) continue;
        const before = match.hitCount;
        demotePattern(match, today);
        await savePatterns(skill, patterns, "friction");
        result.demotions.push({
          issueNumber: issue.number,
          cue,
          skill,
          hitCountBefore: before,
          hitCountAfter: match.hitCount,
        });
        logger.info(
          { cue, skill, hitCountBefore: before, hitCountAfter: match.hitCount, issueNumber: issue.number },
          "demotion: cue demoted on issue close",
        );
        demoted = true;
        break; // one cue lives in one skill's set; stop after the match
      }

      // Mark the issue processed whether or not a pattern matched (a closed issue
      // whose cue no longer has a live pattern needs no re-inspection).
      await setMarker(String(issue.number), String(nowFn()));
      if (!demoted) continue; // no live pattern for this cue — nothing to demote
    } catch (err: any) {
      const msg = err?.message || String(err);
      logger.error({ err, issueNumber: issue.number }, "demotion: per-issue processing failed");
      result.errors.push(`#${issue.number}: ${msg}`);
    }
  }

  return result;
}
