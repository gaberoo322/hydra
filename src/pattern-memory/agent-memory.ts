/**
 * learning/agent-memory.ts — Per-agent pattern memory + auto-promotion
 *
 * Extracted from learning.ts (issue #219). Owns the Redis-backed pattern
 * tier, promotion to feedback files, and stale-rule detection.
 *
 * Issue #900 — the promoted-rule effectiveness / auto-demotion lifecycle that
 * used to live here (effectiveness math, thresholds, cooldown, the
 * feedback-file demotion side-effect, and the rule-action audit log) was lifted
 * into the sibling module `rule-effectiveness.ts`, mirroring the escalation
 * split (#823). This module keeps the core store + promotion and shares its
 * `loadPatterns`/`savePatterns` internal storage helpers with that sibling.
 *
 * Public API used outside this module:
 *   recordPattern                  — POST /api/memory/:agent/pattern
 *   loadAgentMemory                — used by getContext()
 *   consolidateAgentPatterns       — daily prune driven by consolidate()
 *
 * Issue #2342 — the back-compat re-export relay was removed: external callers
 * now import `PROMOTION_THRESHOLD` from `./constants.ts` directly, so the import
 * path names the canonical owner.
 *
 * Issue #2962 — the promote→observe→demote lifecycle over
 * `config/feedback/to-*.md` was retired (write-only after the Codex consumers
 * were deleted — ADR-0006 / #710). Promotion now stamps `promoted/promotedAt` in
 * the Redis pattern store only; it no longer mirrors a rule block into a dead
 * markdown file, and `feedback-file.ts` was removed.
 */

import {
  loadPatternsRaw,
  savePatternsRaw,
} from "../redis/agent-memory.ts";
import {
  escalateIfNeeded,
  type EscalationInput,
  type EscalationResult,
} from "./escalation.ts";
// canonicalizeCue moved to the zero-IO cue-policy leaf (issue #2569).
import { canonicalizeCue } from "./cue-policy.ts";
// Issue #2178 — the promotion/escalation decision spine extracted from this
// file's `recordPattern` orchestration. `decideRecordActions` is a pure
// predicate: given a pattern's post-hit state it answers "promote? escalate?",
// so the "when to call the seams" choice is named and testable on its own
// instead of inlined across `recordPattern`'s branches. (Issue #2962 retired the
// third sub-decision, `writeFeedbackFile`, along with the dead feedback file.)
import { decideRecordActions } from "./decision.ts";
// Issue #2108 — the fuzzy cue-deduplication algorithm (stemming, tokenization,
// the overlap-coefficient `cueSimilarity`, the `findPatternForCue` resolver, and
// the `CUE_MERGE_THRESHOLD` constant) now lives in the sibling `cue-matcher.ts`
// Module — a self-contained pure-function cluster with no store/Redis deps.
// Import direction is one-way; `recordPattern`'s sole call site below resolves
// `findPatternForCue` from here.
import { findPatternForCue } from "./cue-matcher.ts";

// Issue #2117 — the promotion-policy constant `PROMOTION_THRESHOLD` (a public
// contract of the pattern-memory domain, not store implementation detail) lives
// in the leaf `constants.ts` Module. Used below by the promotion/escalation
// decision predicate; external display-tier consumers import it from
// `constants.ts` directly (issue #2342 dropped the back-compat re-export).
import { PROMOTION_THRESHOLD } from "./constants.ts";

// ===========================================================================
// Constants / types
// ===========================================================================

const MAX_PATTERNS = 15;
const MAX_EXAMPLES = 3;
/** Issue #1667 — cap on merged-spelling aliases retained per pattern. */
const MAX_ALIASES = 5;

export type MemoryPattern = {
  category: string;
  severity: "prevent" | "reinforce";
  hitCount: number;
  firstSeen: string;
  lastSeen: string;
  lastCycleId: string;
  action: string;
  examples: string[];
  promoted: boolean;
  /** ISO date (YYYY-MM-DD) the pattern was promoted to the feedback file. */
  promotedAt?: string;
  /** Hit count at the moment of promotion — baseline for post-promotion effectiveness. */
  hitsAtPromotion?: number;
  /**
   * ISO timestamp (full ISO, not date) when the effectiveness check last
   * evaluated this pattern. Used to throttle alert/demote actions so we don't
   * spam the operator with the same finding every cycle (issue #365).
   */
  lastEffectivenessCheckAt?: string;
  /** Set true when the pattern was previously promoted but later demoted. */
  demoted?: boolean;
  /** ISO date the pattern was auto-demoted. */
  demotedAt?: string;
  /** Short machine-readable reason: "ineffective" | "manual" | "stale". */
  demotedReason?: string;
  /**
   * Issue #392 — discriminator identifying which call path produced this
   * pattern. `codex-cycle` is the historical in-process control-loop writer
   * (retired with ADR-0006) and `subagent` covers Claude-driven autopilot
   * skills (hydra-dev / hydra-qa / hydra-target-build) that POST to
   * /api/memory/subagent-lesson. Metadata only — does not alter the
   * consolidation/promotion math.
   */
  source?: "codex-cycle" | "subagent";
  /**
   * Issue #843 — the **Escalation Outcome** of the most recent escalation that
   * actually fired for this pattern. Stamped by `recordPattern()` via a
   * best-effort SECOND save AFTER the GitHub-side dispatch, so it is written
   * ONLY when an escalation fired (below-threshold hits leave it untouched).
   *
   * `at` is a full ISO timestamp (not a date) so a column of `error` statuses
   * in the friction-patterns surface can be correlated with a systematic
   * gh/auth outage. Optional + additive: it rides the existing
   * `savePatternsRaw`/`loadPatternsRaw` JSON round-trip (no new key, no
   * migration); records written before #843 simply lack the field.
   */
  lastEscalation?: {
    status: EscalationResult["status"];
    issueNumber?: number;
    error?: string;
    at: string;
  };
  /**
   * Issue #1667 — alternate cue spellings that fuzzy-merged into this
   * pattern (write-side normalization in `recordPattern`). Subagents
   * free-author kebab-case cues, so the same gotcha used to land under
   * several spellings, each stuck at hitCount:1 — starving the
   * hitCount-based promotion/escalation machinery. The canonical spelling
   * stays `category` (the OLDER spelling wins); merged variants are kept
   * here, capped at MAX_ALIASES, purely for observability. Additive field:
   * pre-#1667 records simply lack it.
   */
  aliases?: string[];
};

/**
 * Signature of the escalation dependency folded into `recordPattern()`
 * (issue #823). Defaults to the real `escalateIfNeeded` from `escalation.ts`;
 * tests/callers override it with a spy/no-op to assert the escalation intent
 * without shelling out to `gh`. Matches `escalateIfNeeded`'s shape so the
 * default is a direct reference, not an adapter.
 */
export type EscalateFn = (
  escalation: EscalationInput | null,
  context: string,
) => Promise<EscalationResult | null>;

/**
 * Return shape of `recordPattern()`.
 *
 * Issue #823 folded the escalation DISPATCH into `recordPattern()` itself:
 * the record→promote→escalate lifecycle is now owned end-to-end in one
 * operation, so a caller can no longer record a hit and silently forget the
 * escalation seam (the exact fail-loud-violating footgun the prior two-step
 * `recordPattern()` + `escalateIfNeeded()` contract allowed). Escalation fires
 * by DEFAULT, after the Redis write commits, via an injected dependency that
 * defaults to the real `escalateIfNeeded`.
 *
 * The `escalation` field is RETAINED for observability and for direct-call
 * tests: it carries the computed `EscalationInput | null` (the escalation
 * *intent*) so callers can assert the decision even though the dispatch has
 * already been performed internally. It is no longer a to-do the caller must
 * action — `recordPattern` already actioned it.
 */
export type RecordPatternResult = {
  pattern: MemoryPattern;
  /** True when this call promoted the pattern to "cardinal" for the first time. */
  crossedThreshold: boolean;
  /**
   * The escalation intent computed for this hit: non-null when the hit count
   * merits a GitHub-side dispatch, null otherwise. Issue #823: `recordPattern`
   * has ALREADY dispatched this (via the injected `escalate` dep, default
   * `escalateIfNeeded`) before returning. The field stays for observability
   * and so direct-call tests can assert the decision without the dispatch
   * firing (tests neutralise the real dispatch via `HYDRA_ESCALATION_DISABLED`
   * or by injecting a no-op `escalate`).
   */
  escalation: EscalationInput | null;
  /**
   * Issue #843 — the **Escalation Outcome** of the dispatch `recordPattern`
   * performed for this hit: the `EscalationResult` returned by the injected
   * `escalate` dep (default `escalateIfNeeded`), or `null` when no escalation
   * fired (below threshold). Distinct from `escalation` (the *intent*): this is
   * the *result* of acting on that intent. The API route surfaces it so a
   * caller can observe a systematic gh/auth outage instead of a silent
   * `{ ok: true }`.
   */
  escalationResult: EscalationResult | null;
};

// ===========================================================================
// Pattern storage
// ===========================================================================

/**
 * Issue #512 — pattern namespace. The legacy planner/executor/skeptic
 * patterns live under `hydra:memory:{agent}:patterns` (namespace="memory").
 * Friction patterns from subagent friction-reports live under
 * `hydra:friction:{skill}:patterns` (namespace="friction"). The two share
 * schema and promotion math, but only `memory` patterns write to the
 * `config/feedback/to-{agent}.md` files. Both fire the GitHub escalation
 * hook when their hit count crosses PROMOTION_THRESHOLD.
 */
export type PatternNamespace = "memory" | "friction";

/**
 * Internal storage helper — load the raw pattern array for an agent/skill.
 *
 * Issue #900 — exported (alongside `savePatterns`) so the sibling
 * `rule-effectiveness.ts` lifecycle module can read/write the SAME
 * `hydra:memory:{agent}:patterns` JSON without duplicating the JSON
 * parse/sort/cap logic or re-declaring `MAX_PATTERNS`. Not part of the public
 * API surface — it is a module-internal seam shared between the two
 * pattern-memory siblings, the same way `escalation.ts` is folded in.
 */
export async function loadPatterns(
  agentName: string,
  namespace: PatternNamespace = "memory",
): Promise<MemoryPattern[]> {
  const raw = await loadPatternsRaw(agentName, namespace);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/** Internal storage helper — see `loadPatterns` (issue #900). Exported for the
 *  `rule-effectiveness.ts` sibling; not a public-API export. */
export async function savePatterns(
  agentName: string,
  patterns: MemoryPattern[],
  namespace: PatternNamespace = "memory",
) {
  const sorted = patterns
    .sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime())
    .slice(0, MAX_PATTERNS);
  await savePatternsRaw(agentName, JSON.stringify(sorted), namespace);
}

async function sweepStalePromotions(agentName: string) {
  const patterns = await loadPatterns(agentName);
  let changed = false;

  for (const p of patterns) {
    // Issue #2178 — the retroactive-promotion decision shares the same pure
    // predicate as `recordPattern`. Issue #2962 retired the feedback-file write:
    // promotion now only stamps the Redis pattern record (`promoted/promotedAt/
    // hitsAtPromotion`), which is what drives escalation and the effectiveness
    // API — nothing is mirrored into a markdown file any more.
    const decision = decideRecordActions(p, "memory", PROMOTION_THRESHOLD);
    if (decision.promote) {
      p.promoted = true;
      p.promotedAt = new Date().toISOString().split("T")[0];
      p.hitsAtPromotion = p.hitCount;
      changed = true;
      console.log(`[Learning] Retroactive promotion: "${p.category}" (${p.hitCount} hits)`);
    }
  }

  if (changed) {
    await savePatterns(agentName, patterns);
  }
}

// ===========================================================================
// Agent memory loading + formatting
// ===========================================================================

export async function loadAgentMemory(agentName: string): Promise<string> {
  await sweepStalePromotions(agentName);

  const patterns = await loadPatterns(agentName);
  const parts: string[] = [];

  if (patterns.length > 0) {
    parts.push(`# ${agentName} — Learned Patterns\n`);
    for (const p of patterns) {
      parts.push([
        `### [${p.severity}] ${p.category} (${p.hitCount}x)`,
        `ACTION: ${p.action}`,
        `LAST: ${p.lastCycleId} — ${p.examples[0] || ""}`,
        "",
      ].join("\n"));
    }
  }

  // Issue #804: the OpenViking memory search that used to be folded in HERE has
  // moved up to the composition seam (learning.ts::loadKnowledgeBaseBlock). It
  // was dishonest for the context trace to report `agent-memory: hit` when the
  // content was really Knowledge Base search results, and it hid the OV source
  // from /api/learning/context-trace. `loadAgentMemory` is now exactly what its
  // name says: promoted Pattern Memory for the agent, nothing more.
  return parts.join("\n");
}

// Issue #1937 — the prompt-rendering grammar (`formatMemoryForPrompt`: the
// `[prevent]`/`[reinforce]` section format, the frequency-rank sort, the caps,
// the PAST-OUTCOMES fallback, and the #804/#1455 `itemCount`-from-data
// contract) moved verbatim into the sibling `prompt-format.ts` Module. It was
// the most self-contained concern in this file — a pure string-in / struct-out
// transform with no store imports — so the split makes the grammar testable
// with a plain rendered-memory fixture and leaves this Module to its core
// store + promotion + stale-rule + migration concerns. The sole production
// caller (`src/learning.ts`) now imports `formatMemoryForPrompt` directly from
// `prompt-format.ts`.

// ===========================================================================
// recordPattern (with auto-promotion)
// ===========================================================================

/**
 * Record a pattern directly (for POST /api/memory/:agent/pattern).
 *
 * The optional `source` discriminator (issue #392) lets callers tag whether
 * the pattern came from the in-process codex cycle or from an autopilot
 * subagent. It is metadata only — the consolidation/promotion pipeline is
 * unchanged so existing 3-hit auto-promotion continues to apply regardless
 * of who recorded the hits.
 *
 * Issue #512 — `namespace` selects the Redis key family. `"memory"` (the
 * default) keeps the legacy behaviour: patterns land under
 * `hydra:memory:{agent}:patterns` and a promotion writes through to
 * `config/feedback/to-{agent}.md`. `"friction"` lands patterns under
 * `hydra:friction:{skill}:patterns` and skips the feedback-file write
 * (there is no `to-{skill}.md` for arbitrary subagent skills). Both
 * namespaces fire the GitHub-issue escalation hook on threshold-cross
 * and every multiple of 10 thereafter.
 *
 * Issue #823 — the escalation dispatch is now folded in: after the Redis
 * write commits, `recordPattern` itself calls `details.escalate` (default
 * `escalateIfNeeded`) with the computed `EscalationInput | null`. This makes
 * "record without escalate" structurally impossible — there is one operation,
 * not a returned intent the caller must remember to action. The dispatch
 * stays best-effort and never throws (the default `escalateIfNeeded` swallows
 * + logs, and `escalatePatternToIssue` honours `HYDRA_ESCALATION_DISABLED`).
 * Pass a no-op `escalate` to exercise pattern accounting in isolation.
 *
 * Issue #1667 — `category` is normalized write-side IN THE FRICTION
 * NAMESPACE ONLY: an incoming friction cue that fuzzy-matches an existing
 * pattern (see `findPatternForCue`) increments that pattern instead of
 * creating a fragment, with the older spelling kept canonical and the
 * variant retained in `aliases`. All downstream decisions (metadata-cue
 * classification, escalation threshold/cue/context) key on the canonical
 * `pattern.category`. The `memory` namespace stays exact-match: its cues
 * are deliberate identifiers (#524 metadata cues carry per-cue escalation
 * thresholds) and a fuzzy merge there would collapse distinct thresholds.
 */
export async function recordPattern(
  agentName: string,
  category: string,
  details: {
    severity?: "prevent" | "reinforce";
    action: string;
    example: string;
    cycleId: string;
    source?: "codex-cycle" | "subagent";
    namespace?: PatternNamespace;
    /**
     * Issue #823 — injected escalation dependency. Defaults to the real
     * `escalateIfNeeded`. Override with a spy/no-op in tests to assert the
     * escalation intent without dispatching. Production callers leave it unset
     * and get escalate-by-default (inert under `HYDRA_ESCALATION_DISABLED=1`).
     */
    escalate?: EscalateFn;
  },
): Promise<RecordPatternResult> {
  const namespace: PatternNamespace = details.namespace || "memory";
  const patterns = await loadPatterns(agentName, namespace);
  const today = new Date().toISOString().split("T")[0];

  // Issue #2527 — explicit alias normalization, FRICTION NAMESPACE ONLY.
  // `canonicalizeCue` maps lexically-distant variant cues (which score below
  // the 0.6 fuzzy-merge threshold in cue-matcher.ts) to a single canonical
  // cue BEFORE the fuzzy-merge step below. This collapses high-recurrence
  // clusters that fragmented because their members use different terminology
  // (e.g. the five worktree write-fence cues totalling ~135 hits, no single
  // one ever reaching PROMOTION_THRESHOLD). The memory namespace is exempt —
  // memory cues are deliberate identifiers with per-cue escalation thresholds.
  if (namespace === "friction") {
    category = canonicalizeCue(category);
  }

  // Issue #1667 — exact match first, then fuzzy (token-overlap) merge so
  // free-authored respellings of the same gotcha increment ONE pattern
  // instead of fragmenting into parallel hitCount:1 entries that never
  // reach PROMOTION_THRESHOLD. Fuzzy resolution applies to the FRICTION
  // namespace ONLY (design invariant 1): memory-namespace cues are
  // deliberately-spelled identifiers (e.g. the #524 metadata cue pair
  // acceptance-criterion-unmet / acceptance-criterion-deferred, which
  // token-overlap at 0.667 ≥ CUE_MERGE_THRESHOLD) whose per-cue escalation
  // thresholds would be corrupted by a fuzzy merge — they stay exact-match.
  const existing =
    namespace === "friction"
      ? findPatternForCue(patterns, category)
      : patterns.find(p => p.category === category);
  let crossedThreshold = false;
  let pattern: MemoryPattern;

  if (existing) {
    if (existing.category !== category) {
      // Fuzzy merge: the older spelling stays canonical; keep the variant
      // as an alias for observability.
      existing.aliases = [
        ...new Set([...(existing.aliases ?? []), category]),
      ].slice(0, MAX_ALIASES);
      console.log(
        `[Learning] Cue "${category}" fuzzy-merged into existing cue "${existing.category}" (${agentName}/${namespace})`,
      );
    }
    existing.hitCount++;
    existing.lastSeen = today;
    existing.lastCycleId = details.cycleId;
    // Design invariant 2 (issue #1667): an alias merge never overwrites the
    // canonical pattern's action — only exact-category hits keep the existing
    // action-update behaviour. Caps the blast radius of a false fuzzy merge
    // to hitCount/examples/aliases; the oldest spelling's fix prescription
    // survives later-arriving variants.
    if (existing.category === category) {
      existing.action = details.action;
    }
    existing.examples = [details.example, ...existing.examples].slice(0, MAX_EXAMPLES);
    if (details.source) existing.source = details.source;

    // Issue #2178 — the promotion decision moves to the named pure predicate.
    // `decision.promote` answers "crossed threshold, not yet promoted?". Judged
    // on the CANONICAL category (issue #1667) so a fuzzy-merged variant can't
    // dodge the classification. Issue #2962 retired the feedback-file write
    // that promotion used to gate: promotion now only stamps the Redis pattern
    // record (`promoted/promotedAt/hitsAtPromotion`) — the signal escalation and
    // the effectiveness API read — without mirroring a dead markdown file.
    const decision = decideRecordActions(existing, namespace, PROMOTION_THRESHOLD);
    if (decision.promote) {
      existing.promoted = true;
      existing.promotedAt = today;
      existing.hitsAtPromotion = existing.hitCount;
      crossedThreshold = true;
      console.log(`[Learning] Promoted "${existing.category}" (${existing.hitCount} hits)`);
    }
    pattern = existing;
  } else {
    pattern = {
      category,
      severity: details.severity || "prevent",
      hitCount: 1,
      firstSeen: today,
      lastSeen: today,
      lastCycleId: details.cycleId,
      action: details.action,
      examples: [details.example],
      promoted: false,
      source: details.source,
    };
    patterns.push(pattern);
  }

  await savePatterns(agentName, patterns, namespace);

  // Issue #512 — decide whether this hit merits a GitHub-issue escalation.
  // Threshold-cross plus every multiple of 10 thereafter (hitCount =
  // threshold, threshold+10, threshold+20, ...). Only the INPUT shaping lives
  // here now — issue #2178 moved the "should it fire?" predicate into
  // `decideRecordActions` (which folds in the #524 per-cue threshold override
  // and the #1789 never-escalate sentinel). Computed over the finalized
  // `pattern` so it covers both the existing-hit and new-pattern branches.
  //
  // Issue #1667 — escalation decisions key on the CANONICAL category
  // (pattern.category), so hits arriving under merged alias spellings count
  // toward — and are reported under — one cue.
  const escalationDecision = decideRecordActions(pattern, namespace, PROMOTION_THRESHOLD);
  const escalation: EscalationInput | null = escalationDecision.escalate
    ? {
        kind: namespace === "friction" ? "friction" : "lesson",
        cue: pattern.category,
        hitCount: pattern.hitCount,
        skills: [agentName],
        workarounds: pattern.examples.filter(e => typeof e === "string" && e.trim().length > 0),
        lastReference: pattern.lastCycleId,
      }
    : null;

  // Issue #823 — fold the dispatch in. Record-then-escalate ordering is
  // preserved (the savePatterns() above has already committed). The dispatch
  // is the injected dep (default escalateIfNeeded), which is best-effort and
  // never throws — a gh/network failure logs console.error and recordPattern
  // still resolves with its result object. The escalation field is retained
  // on the result for observability and direct-call test assertions.
  //
  // Issue #843 — capture the dispatch's **Escalation Outcome** so it can be
  // threaded up (returned as `escalationResult`) AND stamped on the durable
  // record. `escalate` resolves to an `EscalationResult` when an escalation
  // fired, or `null` when none did (intent was null / below threshold).
  const escalate = details.escalate ?? escalateIfNeeded;
  const escalationContext =
    namespace === "friction"
      ? `friction/${agentName}/${pattern.category}`
      : `${agentName}/${pattern.category}`;
  // The default `escalateIfNeeded` is best-effort and never throws, but a
  // misbehaving injected dep could. recordPattern must NEVER throw (the #823
  // invariant + AC), so a thrown dispatch becomes an error Escalation Outcome
  // when an escalation was due, or null when none fired.
  let escalationResult: EscalationResult | null;
  try {
    escalationResult = await escalate(escalation, escalationContext);
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error(
      `[Learning] recordPattern: escalate dispatch threw for ${escalationContext}: ${msg}`,
    );
    escalationResult = escalation ? { status: "error", error: msg } : null;
  }

  // Issue #843 — stamp the outcome on the pattern via a best-effort SECOND
  // save, ONLY when an escalation actually fired. The core record was already
  // committed above (record-then-escalate ordering), so a stamp-save failure
  // never loses the hit. Like the dispatch, this stays best-effort:
  // recordPattern must never throw, so a Redis blip on the stamp logs and is
  // swallowed. `at` is a full ISO timestamp.
  if (escalationResult) {
    pattern.lastEscalation = {
      status: escalationResult.status,
      ...(escalationResult.status === "created" ||
      escalationResult.status === "commented" ||
      escalationResult.status === "reopened"
        ? { issueNumber: escalationResult.issueNumber }
        : {}),
      ...(escalationResult.status === "error"
        ? { error: escalationResult.error }
        : {}),
      at: new Date().toISOString(),
    };
    try {
      await savePatterns(agentName, patterns, namespace);
    } catch (err: any) {
      console.error(
        `[Learning] recordPattern: lastEscalation stamp-save failed for ${escalationContext}: ${err?.message || err}`,
      );
    }
  }

  return { pattern, crossedThreshold, escalation, escalationResult };
}

/**
 * Issue #512 — list all friction patterns across all known skills.
 * Exported so the `/api/learning/friction-patterns` endpoint can render
 * an observability view without bespoke Redis access.
 */
export async function listFrictionPatterns(
  skill: string,
): Promise<MemoryPattern[]> {
  return loadPatterns(skill, "friction");
}

// ===========================================================================
// Issue #302 — One-time backfill of promotion metadata for legacy patterns
// ===========================================================================

/**
 * Pure helper — mutate-in-place backfill of `promotedAt` / `hitsAtPromotion`
 * for legacy promoted patterns. Exported for unit testing without Redis.
 *
 * Patterns promoted before issue #289 (commit 3fd70b4) have `promoted === true`
 * but lack the new metadata fields, which makes them invisible to
 * `evaluatePromotedPatternEffectiveness()`. These are exactly the patterns
 * worth flagging — they have been firing for weeks since promotion.
 *
 * Rules:
 *   - `promotedAt = firstSeen ?? lastSeen ?? today` (per AC3). Anchoring the
 *     promotion timestamp at pattern birth means `daysSincePromotion` covers
 *     the full lifetime, so the MIN_DAYS_POST_PROMOTION window is trivially
 *     satisfied and the detector can judge the pattern on its next call.
 *   - `hitsAtPromotion = 0` when `promotedAt` was missing. AC1 nominally
 *     says "use current hitCount as hitsAtPromotion", but combined with the
 *     birth-time `promotedAt` clamp (`daysToPromotion` becomes 1), that would
 *     produce an enormous `preRate` that no plausible post-rate could exceed,
 *     leaving the known offenders permanently invisible. Treating all
 *     historical hits as post-promotion is the only assignment consistent with
 *     AC3's "worst case: detector flags them immediately because they kept
 *     firing" and with the issue's stated goal that
 *     `/api/learning/ineffective-rules` should surface the existing 292/456-hit
 *     patterns after deploy.
 *   - When `promotedAt` is already present (partial-metadata case), preserve
 *     it and fall back to AC1's literal `hitsAtPromotion = hitCount` — the
 *     operator-set timestamp means `daysToPromotion` is meaningful and the
 *     standard math works.
 *
 * Returns the count of patterns mutated (0 when there is nothing to do, which
 * is the steady state after the first run).
 */
export function backfillPatternPromotionMetadata(
  patterns: MemoryPattern[],
  today: string = new Date().toISOString().split("T")[0],
): number {
  let mutated = 0;
  for (const p of patterns) {
    if (!p.promoted) continue;
    if (p.promotedAt && typeof p.hitsAtPromotion === "number") continue;

    const promotedAtWasMissing = !p.promotedAt;
    if (promotedAtWasMissing) {
      p.promotedAt = p.firstSeen || p.lastSeen || today;
    }
    if (typeof p.hitsAtPromotion !== "number") {
      // See doc comment above: 0 when we just synthesized promotedAt from
      // firstSeen, otherwise current hitCount per AC1.
      p.hitsAtPromotion = promotedAtWasMissing ? 0 : p.hitCount;
    }
    mutated++;
  }
  return mutated;
}

// ===========================================================================
// Daily consolidation
// ===========================================================================

/**
 * Prune stale patterns across all agents (called by consolidate()).
 * Keeps patterns that have hit count >=2, are recent, or have been promoted.
 */
export async function consolidateAgentPatterns(): Promise<void> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 14);
  const cutoffStr = cutoff.toISOString().split("T")[0];

  for (const agent of ["planner", "executor", "skeptic"]) {
    const patterns = await loadPatterns(agent);
    const before = patterns.length;

    const kept = patterns.filter(p =>
      p.hitCount >= 2 || p.lastSeen >= cutoffStr || p.promoted
    );

    if (kept.length < before) {
      await savePatterns(agent, kept);
      console.log(`[Learning] Consolidated ${agent}: ${before} → ${kept.length} patterns (${before - kept.length} stale pruned)`);
    }
  }
}
