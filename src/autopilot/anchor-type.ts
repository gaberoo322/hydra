/**
 * Anchor-type **classification policy** — a pure, zero-I/O leaf extracted from
 * the cycle-record write coordinator `cycle-close.ts` (issue #2858).
 *
 * These symbols are the anchor-type classification *policy*: they normalise,
 * infer, reject-malformed, and fall back to a sentinel — all with string inputs
 * alone. They touch no Redis (no `cycle-tracking`/`scheduler`/`cycle-metrics`
 * accessors), make no async calls, and carry no `deps` bag. That is what makes
 * this a leaf: a caller that only wants to know "is this anchorType string
 * malformed?" or "what anchorType does `dev_orch` map to?" imports THIS module,
 * not the write coordinator that stamps `hydra:cycle:<id>` hashes.
 *
 * The policy has three callers today: the write coordinator (`cycle-close.ts`,
 * which re-exports these for back-compat during migration), the metrics READ
 * path (`src/metrics/trend.ts`, which applies the identical malformed-value
 * rejection to pre-#2806 Redis rows), and the direct-write route
 * (`src/api/metrics.ts`, `POST /metrics/record`). Concentrating the policy in a
 * named leaf keeps the read and write paths from drifting apart and gives every
 * future read-side caller a domain home to import from.
 *
 * This mirrors the established pure-leaf-from-Redis-coordinator precedent in
 * this codebase: `src/outcome-regression.ts` (from `holdback.ts`, #2507),
 * `src/backlog/stale-escalation-policy.ts` (from `stale-escalation.ts`, #2678),
 * and `capacity-floor-classifier.ts` (from `capacity-floor.ts`, #2211).
 *
 * The one exception to the zero-Redis / pure-string contract: this leaf reads
 * the machine-readable dispatch-class alphabet (`DISPATCH_CLASSES` from
 * `src/taxonomy/classes.ts`, a synchronous file read at module import — issue
 * #3253). That import is what lets {@link SLOT_ANCHOR_TYPE} be DERIVED from the
 * single taxonomy alphabet rather than hand-maintained, so a class added to
 * `classes.json` can never again silently fall through to `unclassified`. It is
 * still zero-Redis and zero-async — `DISPATCH_CLASSES` is a frozen array loaded
 * once at import, no different from importing a constant.
 */

import { DISPATCH_CLASSES } from "../taxonomy/classes.ts";
import { InvariantViolationError } from "../errors.ts";

/**
 * Sentinel anchorType for a cycle-record whose caller supplied no explicit,
 * non-empty anchorType (issue #2689). Making classification EXPLICIT here is
 * the server-side backstop that stops a cycle from silently bucketing as
 * "unknown" in the metrics aggregator (`src/metrics/aggregate.ts`, which maps
 * an absent/empty/whitespace anchorType to the literal string "unknown").
 *
 * Before this, `recordCycle` passed `anchorType: body.anchorType` straight
 * through and the field-stripping loop below deleted it when absent — so any
 * cycle-record POST that arrived without an anchorType (the schema field is
 * `.optional()`) landed as "unknown", a data-quality black hole invisible to
 * metrics-driven decisions (24% of recent cycles). "unknown" is a data-quality
 * FAILURE, not a valid terminal state; an explicit "unclassified" sentinel
 * makes the gap visible and attributable (and distinct from the aggregator's
 * catch-all "unknown", so a post-fix "unknown" bucket now means the record
 * predates this fix, never that classification silently fell through).
 */
export const UNCLASSIFIED_ANCHOR_TYPE = "unclassified";

/**
 * The canonical anchorType (metrics lane label) for every dispatch class in the
 * taxonomy, keyed by class name (issue #3253).
 *
 * # Why this exists — the taxonomy-drift gap it closes
 *
 * Before #3253, {@link SLOT_ANCHOR_TYPE} was a HAND-MAINTAINED map covering only
 * the seven pipeline slots (`dev_*`, `qa_*`, `research_*`, `design_concept_orch`)
 * and mirroring `dispatch.sh`'s `case`. The dispatch-class alphabet
 * (`scripts/autopilot/classes.json`) meanwhile grew ~13 signal classes —
 * `discover_*`, `architecture_orch`, `retro_orch`, `cleanup_*`, `sweep_*`,
 * `scout_orch`, `wire_or_retire_target`, `design_qa_target`, `skill_prune`,
 * `health` — none of which had a `SLOT_ANCHOR_TYPE` entry. A cycle whose cycleId
 * embeds one of those slots (e.g. `worktree-agent-…-t2-cleanup_orch`) therefore
 * decoded to `undefined` in {@link inferAnchorTypeFromCycleId} and fell through
 * to the `unclassified` sentinel — the 34% unknown/unclassified rate the
 * architecture review flagged (issue #3253). Hand-maintaining a slot→lane map
 * beside a growing machine-readable alphabet is exactly the "silent fallthrough
 * to `other`/`unclassified`" drift the taxonomy leaf exists to kill.
 *
 * # The fix: derive from the single alphabet, force an explicit decision
 *
 * This map assigns an anchorType lane to EVERY class name in the taxonomy, and
 * the module-load invariant below fails loud if `DISPATCH_CLASSES` ever carries
 * a class with no entry here. So adding a class to `classes.json` now forces an
 * explicit anchorType decision at this seam instead of silently bucketing the
 * class's cycles as `unclassified`. This mirrors the identical
 * every-row-must-map completeness invariant in `src/cost/cost-attribution.ts`
 * (slice #1671) and `src/pattern-memory/subagent-capture.ts`.
 *
 * The seven historical pipeline-slot values are preserved verbatim
 * (`work-queue` / `qa-review` / `grill` / `research`) so existing metrics
 * buckets are unchanged; the new signal-class lanes are named after the class's
 * function (`cleanup`, `retro`, `discover`, …) so per-class merge-rate /
 * empty-rate / cost breakdowns become visible on the dashboard. These are
 * genuine (non-malformed) anchorType strings, so the metrics READ path
 * (`normalizeAnchorType` in `src/metrics/trend.ts`) passes them through
 * unchanged into their own buckets.
 */
export const ANCHOR_TYPE_BY_CLASS: Readonly<Record<string, string>> = {
  // Pipeline slots — historical values, preserved verbatim.
  dev_orch: "work-queue",
  dev_target: "work-queue",
  qa_orch: "qa-review",
  qa_target: "qa-review",
  research_orch: "research",
  research_target: "research",
  design_concept_orch: "grill",
  // Signal classes — the lanes that were missing pre-#3253.
  health: "health",
  sweep_orch: "sweep",
  sweep_target: "sweep",
  discover_orch: "discover",
  discover_target: "discover",
  scout_orch: "scout",
  architecture_orch: "architecture",
  retro_orch: "retro",
  cleanup_orch: "cleanup",
  cleanup_target: "cleanup",
  wire_or_retire_target: "wire-or-retire",
  design_qa_target: "design-qa",
  skill_prune: "skill-prune",
};

/**
 * Module-load completeness invariant (issue #3253): every dispatch-class row in
 * the taxonomy MUST have an anchorType lane in {@link ANCHOR_TYPE_BY_CLASS}, so
 * a class added to `classes.json` can never again decode to `undefined` and
 * fall through to the `unclassified` sentinel. Adding a class therefore forces
 * an explicit edit here instead of a silent data-quality gap. This is a
 * boundary/invariant guard, not merge/grounding/verification code, so throwing
 * is the documented convention (CLAUDE.md; mirrors the fail-loud contract in
 * `src/taxonomy/classes.ts` and the every-row-must-bucket invariant in
 * `src/cost/cost-attribution.ts`).
 */
for (const row of DISPATCH_CLASSES) {
  if (!(row.name in ANCHOR_TYPE_BY_CLASS)) {
    throw new InvariantViolationError(
      `anchor-type classification: dispatch class "${row.name}" has no ` +
        `anchorType lane — add an entry to ANCHOR_TYPE_BY_CLASS in ` +
        `src/autopilot/anchor-type.ts (issue #3253)`,
    );
  }
}

/**
 * Map a dispatch-class slot name to its canonical anchorType — the DERIVED view
 * over {@link ANCHOR_TYPE_BY_CLASS} restricted to the taxonomy's real class
 * names (issue #3253; previously a hand-maintained seven-entry literal).
 *
 * Used as a last-resort inference inside {@link classifyAnchorType} when the
 * caller did not supply an explicit anchorType but the cycleId embeds a slot
 * suffix we can decode (the `worktree-agent-*-{slot}` synthesised-branch
 * format that holdback-merge-watch.ts uses as its cycleId). Because it is now
 * built from `DISPATCH_CLASSES`, it covers EVERY class the autopilot dispatches
 * — the signal classes (`cleanup_orch`, `retro_orch`, `discover_*`, …) that
 * used to fall through to `unclassified` are all present.
 */
export const SLOT_ANCHOR_TYPE: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    DISPATCH_CLASSES.map((row) => [row.name, ANCHOR_TYPE_BY_CLASS[row.name]]),
  ),
);

/**
 * Attempt to infer an anchorType from a dispatch-relay cycleId. Returns the
 * mapped anchorType when the trailing slot is a known dispatch slot; returns
 * `undefined` when the cycleId does not match the pattern or the slot has no
 * mapping.
 *
 * Two accepted shapes share one parser (issue #3138):
 *   - the autopilot-synthesised worktree-branch id
 *     `worktree-agent-{runToken}-t{N}-{slot}` (holdback-merge-watch.ts), and
 *   - the PREFIX-LESS relay id `{runToken}-t{N}-{slot}` (e.g.
 *     `6fd1300b-t1-qa_orch`) that the cycle-merge-reconcile / qa_orch relay
 *     first-write path emits. The prefix-less form is already a first-class
 *     shape elsewhere — `producerClassFromCycleId` in `src/taxonomy/classes.ts`
 *     resolves it by trailing-slot suffix — so this leaf was the lone parser
 *     rejecting a shape the rest of the system accepts. Making the
 *     `worktree-agent-` prefix OPTIONAL brings the two parsers into agreement
 *     without rewriting any emitter (rejected alternatives: design-concept
 *     issue-3138).
 *
 * The `{runToken}` is `_synthesize_worktree_branch`'s (decide.py) shortened
 * runId — normally the first 8 hex chars of the run UUID, but the literal
 * `local` when `state.run_id` is absent (legacy/test callers). So the run-token
 * class is `[0-9a-z]+` (hex OR the `local` fallback), not hex-only.
 *
 * The regex is deliberately fenced so it can NEVER swallow a non-dispatch id
 * (#2822 invariants): the mandatory `-t{N}-` middle plus a slot tail anchored on
 * `_(orch|target)` are what exclude (a) bare-UUID / short-hex / `autopilot-…`
 * cycleIds — none of which carry that middle+tail — and (b) the harness's own
 * `worktree-agent-<longhash>` branch names, which carry no turn/slot suffix. The
 * slot vocabulary `[a-z][a-z0-9_]*_(orch|target)` mirrors `DISPATCH_CYCLE_ID`'s
 * class token in `src/taxonomy/classes.ts`, so the two cycleId parsers never
 * disagree on what a slot is.
 */
export function inferAnchorTypeFromCycleId(cycleId: string): string | undefined {
  // Pattern: [worktree-agent-]<runToken>-t<N>-<slot>, slot ending in _orch|_target.
  const m = /^(?:worktree-agent-)?[0-9a-z]+-t\d+-([a-z][a-z0-9_]*_(?:orch|target))$/.exec(
    cycleId,
  );
  if (!m) return undefined;
  return SLOT_ANCHOR_TYPE[m[1]];
}

/**
 * Recognise a non-empty-but-MALFORMED anchorType — a string that is technically
 * present yet carries no real classification and must NOT be trusted verbatim
 * (issue #2806). Two garbage forms surfaced in the 50-cycle telemetry sample:
 *
 *   - `"--status"` (and any `-`/`--`-prefixed token): a caller-side positional
 *     bug at a `dispatch.sh cycle-record` call site shifted a CLI flag into the
 *     anchor-type slot. A flag is never a valid anchorType.
 *   - `"unmapped:<skill>"` / bare `"unmapped"`: the SELF-DESCRIBING sentinel
 *     dispatch.sh emits when a skill has no first-class `anchor_type` mapping
 *     (its `*)` fallback). It is intentionally traceable, but it is a
 *     data-quality *gap marker*, not a real anchor lane — letting it through
 *     verbatim pollutes the anchorType distribution with per-skill garbage
 *     buckets (e.g. `unmapped:completed`, itself a symptom of a positional
 *     shift that put the *status* into the skill slot).
 *
 * Treating these as "no explicit value" lets {@link classifyAnchorType} fall
 * through to cycleId-slot inference and, failing that, the honest
 * `unclassified` sentinel — collapsing malformed rows into the single visible
 * data-quality bucket instead of a long tail of untrusted strings. Genuine
 * anchor types (`work-queue`, `qa-review`, `grill`, `research`, `backlog`, …)
 * are unaffected.
 *
 * Exported (issue #2824) so the metrics READ path — `normalizeAnchorType` in
 * `src/metrics/trend.ts` — can apply the IDENTICAL malformed-value rejection.
 * The write path (`classifyAnchorType`) collapses these malformed forms to
 * `unclassified`, but pre-fix rows already persisted in Redis carry the raw
 * `--status` / `unmapped:*` string; sharing this predicate as the single
 * source of truth keeps the read path from resurfacing them as distinct
 * garbage buckets and prevents write/read drift.
 *
 * @param trimmed a whitespace-trimmed anchorType candidate.
 */
export function isMalformedAnchorType(trimmed: string): boolean {
  // Flag-shaped: a leading `-` can only be a leaked CLI token.
  if (trimmed.startsWith("-")) return true;
  // dispatch.sh's unmapped-skill sentinel (`unmapped` or `unmapped:<skill>`).
  if (trimmed === "unmapped" || trimmed.startsWith("unmapped:")) return true;
  return false;
}

/**
 * Classify a cycle-record body's anchorType EXPLICITLY (issue #2689). Returns
 * the trimmed body value when the caller supplied a non-empty one; otherwise
 * tries to infer from the cycleId's slot suffix (issue #2762 — covers cycles
 * written by holdback-merge-watch.ts, which uses the synthesised worktreeBranch
 * as its cycleId and does not forward an anchorType). Falls back to
 * {@link UNCLASSIFIED_ANCHOR_TYPE} when neither source yields a value — never
 * `undefined`, so the metrics record always carries an explicit, non-empty
 * anchorType and can never fall into the aggregator's "unknown" bucket. A
 * `console.warn` surfaces the remaining gap (fail-loud convention) so a truly
 * unclassifiable cycle is still visible.
 *
 * Exported (issue #2803) so the direct-write path — POST /metrics/record in
 * `src/api/metrics.ts`, which calls `recordCycleMetrics` WITHOUT going through
 * `recordCycle` — can apply the identical classification and stop leaving its
 * cycles in the aggregator's "unknown" bucket (~30% of cycles).
 */
export function classifyAnchorType(cycleId: string, raw: unknown): string {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    // Issue #2806: a non-empty but MALFORMED value (a leaked `--flag`, or
    // dispatch.sh's `unmapped:<skill>` gap-marker sentinel) is NOT a real
    // anchorType — fall through to cycleId-slot inference / the `unclassified`
    // sentinel rather than persisting garbage into the metrics distribution.
    if (trimmed.length > 0 && !isMalformedAnchorType(trimmed)) return trimmed;
  }
  // Issue #2762: holdback-merge-watch.ts calls recordCycle({cycleId, prNumber,
  // filesChanged}) with no anchorType. Its cycleId is the autopilot's synthesised
  // worktreeBranch (`worktree-agent-{8hex}-t{N}-{slot}`), whose slot suffix
  // encodes the dispatch class. Decode it to recover the anchorType without
  // requiring the caller to forward the field.
  const inferred = inferAnchorTypeFromCycleId(cycleId);
  if (inferred !== undefined) return inferred;
  console.warn(
    `[autopilot] recordCycle: cycle '${cycleId}' has no explicit anchorType — recording '${UNCLASSIFIED_ANCHOR_TYPE}' (data-quality gap; the caller should send a mapped anchorType)`,
  );
  return UNCLASSIFIED_ANCHOR_TYPE;
}
