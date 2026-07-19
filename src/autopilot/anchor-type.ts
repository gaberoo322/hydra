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
  // issue #3351, epic #3350, ADR-0029 — the wayfinder-map AFK working class.
  wayfinder_orch: "wayfinder",
  // issue #3421, epic #3419, ADR-0030 Decision 2 — the tickets-stage producer
  // class (dispatches the vendored upstream `to-tickets` skill + Hydra
  // overlay; hydra-prd demoted to the called renderer library).
  tickets_orch: "tickets",
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
 * The canonical anchorType keyed by the Claude Code SKILL a class dispatches
 * (`hydra-dev` → `work-queue`, `hydra-qa` → `qa-review`, …) — a second DERIVED
 * view over {@link ANCHOR_TYPE_BY_CLASS}, indexed on `DispatchClassRow.skill`
 * instead of `.name` (issue #3403).
 *
 * # Why this exists — the skill-name cycleId gap it closes
 *
 * The live 50-cycle telemetry sample (issue #3403) carried a cycleId that is the
 * bare SKILL name — literally `hydra-dev` (the merged-status enrichment write for
 * a `hydra-dev` dispatch that reap keyed on the skill token rather than a
 * slot-suffixed branch). The slot-suffix parser
 * ({@link inferAnchorTypeFromCycleId}) rejected it — `hydra-dev` carries no
 * `-t{N}-` fence and is not a class NAME (`dev_orch`/`dev_target` are) — so it
 * fell through to the `unclassified` sentinel even though the skill unambiguously
 * identifies the dispatch class. Deriving a skill→lane view from the same single
 * alphabet lets that shape decode without a hand-maintained second map. Every
 * skill in `classes.json` is unique (`src/taxonomy/classes.ts` fails loud on a
 * duplicate skill), so this map is total and unambiguous by construction.
 */
export const SKILL_ANCHOR_TYPE: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    DISPATCH_CLASSES.map((row) => [row.skill, ANCHOR_TYPE_BY_CLASS[row.name]]),
  ),
);

/**
 * The canonical anchorType keyed by a class-name PREFIX (the segment before the
 * first `_`, e.g. `dev` for `dev_orch`/`dev_target`) — but ONLY for prefixes
 * that resolve to a single lane across every class sharing them (issue #3403).
 *
 * # Why this exists — the class-prefix cycleId gap it closes
 *
 * The #3403 sample carried a cycleId like `dev-3291` — a `<class-prefix>-<issue>`
 * shape (reap keyed the enrichment on `dev-<issueNumber>` rather than the full
 * `dev_orch` slot). The tail token `dev` is not a class NAME, so
 * {@link inferAnchorTypeFromCycleId}'s exact-match and trailing-suffix legs both
 * missed it. But `dev` maps unambiguously to `work-queue` (both `dev_orch` and
 * `dev_target` share that lane), so the prefix alone is enough to decode.
 *
 * # Why UNAMBIGUOUS-only — the design fence
 *
 * A prefix is included ONLY when EVERY class sharing it maps to the SAME lane.
 * `design` is deliberately EXCLUDED because `design_concept_orch` (`grill`) and
 * `design_qa_target` (`design-qa`) disagree — decoding a bare `design-…` cycleId
 * would be a guess between two lanes, exactly the "never guess" invariant #2822
 * pinned for bare-UUID cycleIds. An ambiguous prefix therefore stays
 * unclassified (the honest sentinel) rather than picking a lane arbitrarily.
 */
export const PREFIX_ANCHOR_TYPE: Readonly<Record<string, string>> = (() => {
  // Group every class's lane by its name-prefix (segment before the first `_`).
  const lanesByPrefix = new Map<string, Set<string>>();
  for (const row of DISPATCH_CLASSES) {
    const underscore = row.name.indexOf("_");
    // A prefix-less class name (`health`, …) uses the whole name as its prefix;
    // that is fine — it is still a unique token that resolves to one lane.
    const prefix = underscore === -1 ? row.name : row.name.slice(0, underscore);
    const lane = ANCHOR_TYPE_BY_CLASS[row.name];
    let lanes = lanesByPrefix.get(prefix);
    if (!lanes) {
      lanes = new Set<string>();
      lanesByPrefix.set(prefix, lanes);
    }
    lanes.add(lane);
  }
  // Keep only prefixes that resolve to a single lane (unambiguous).
  const out: Record<string, string> = {};
  for (const [prefix, lanes] of lanesByPrefix) {
    if (lanes.size === 1) out[prefix] = [...lanes][0];
  }
  return Object.freeze(out);
})();

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
 * The parse is deliberately fenced so it can NEVER swallow a non-dispatch id
 * (#2822 invariants): the mandatory `-t{N}-` middle is what excludes (a)
 * bare-UUID / short-hex / `autopilot-…` cycleIds — none of which carry that
 * middle — and (b) the harness's own `worktree-agent-<longhash>` branch names,
 * which carry no turn/slot suffix.
 *
 * Issue #3390: the slot token is now validated against the taxonomy class
 * alphabet ({@link SLOT_ANCHOR_TYPE}, derived from `DISPATCH_CLASSES`) rather
 * than a structural `_(orch|target)$` suffix anchor. This closes two
 * un-inferrable-but-decodable gaps the live 50-cycle sample carried as
 * `unclassified`:
 *   - slot classes with NO `_orch`/`_target` suffix — `skill_prune`, `health`
 *     (e.g. `…-t2-skill_prune`) — which the old suffix-anchored regex rejected
 *     even though they are first-class taxonomy classes with a real lane; and
 *   - a trailing `-<suffix>` AFTER the slot (e.g. `…-t5-dev_orch-3170`,
 *     `a664419f-t1-dev_orch-3104`), which the old end-anchored `$` rejected.
 * The middle `-t{N}-` fence is unchanged, so the exclusion of non-dispatch ids
 * and the harness `worktree-agent-<longhash>` branch names is preserved.
 *
 * Issue #3403: two further fence-LESS shapes the live 50-cycle sample carried as
 * `unclassified` — even though each unambiguously names a dispatch class — now
 * decode via taxonomy-derived lookups that run BEFORE the `-t{N}-` fence:
 *   - the bare SKILL name as the whole cycleId (`hydra-dev`): matched against
 *     {@link SKILL_ANCHOR_TYPE}; and
 *   - a `<class-prefix>-<suffix>` id with no turn segment (`dev-3291`): the
 *     leading segment is matched against {@link PREFIX_ANCHOR_TYPE}, which only
 *     holds prefixes that resolve to ONE lane, so an ambiguous prefix (`design`)
 *     never guesses. The same {@link PREFIX_ANCHOR_TYPE} lookup is also the final
 *     leg of the fenced-tail resolution, so a fenced tail whose class token is a
 *     bare prefix (`…-t3-dev`) decodes too.
 * Neither leg can swallow a bare-UUID / short-hex / harness-branch cycleId
 * (#2822 invariant): each requires the token to be a REAL taxonomy skill or an
 * unambiguous class prefix, which a random hex/UUID segment is not.
 *
 * Issue #3486: the `hydra-target-build` cycleId shape `claude-cycle-YYYY-MM-DD-HHMM`
 * (and its inline-mode twin `inline-YYYY-MM-DD-HHMM`) carried NO class token in a
 * position the legs above inspect — its tail is a `date` timestamp, not a class
 * name/prefix — so ~22% of the live 50-cycle window fell through to the
 * `unclassified` sentinel. But the shape is unambiguous BY ITS LITERAL PREFIX:
 * `hydra-target-build` Step 0 (`docs/operator-playbooks/hydra-target-build.md`) is
 * the sole emitter of `claude-cycle-*`, registering it with `source: "claude"`,
 * and the inline-mode fragment is the sole emitter of `inline-*`. Both are a Target
 * build — the `dev_target` dispatch class, whose lane is `work-queue`.
 * {@link matchTargetBuildLane} decodes these via a LITERAL-prefix + timestamp-tail
 * match that runs before the fence. The timestamp anchor
 * (`\d{4}-\d{2}-\d{2}-\d{4}` from `date -u +%Y-%m-%d-%H%M`, optionally with a
 * trailing `-<suffix>` as `item284`-style runs append) keeps this from swallowing
 * a bare UUID or short-hex (#2822): only a real target-build timestamp tail
 * matches. The lane is DERIVED from `ANCHOR_TYPE_BY_CLASS.dev_target`, not
 * hard-coded, so it tracks the taxonomy alphabet like every other leg.
 */
export function inferAnchorTypeFromCycleId(cycleId: string): string | undefined {
  // Issue #3486 target-build leg: `hydra-target-build`'s cycleId
  // (`claude-cycle-YYYY-MM-DD-HHMM`, inline twin `inline-YYYY-MM-DD-HHMM`) has a
  // timestamp tail carrying no class token, so it misses every other leg. Its
  // literal prefix + timestamp anchor unambiguously names the `dev_target` class
  // (→ work-queue). Runs before the fence — the id carries no `-t{N}-` middle.
  const targetLane = matchTargetBuildLane(cycleId);
  if (targetLane !== undefined) return targetLane;
  // Issue #3403 skill-name leg: the whole cycleId is the bare skill name the
  // dispatch runs (`hydra-dev`, `hydra-qa`, …). Runs before the fence because a
  // skill name carries no `-t{N}-` middle. Only a REAL taxonomy skill matches,
  // so this cannot swallow a non-dispatch id.
  if (cycleId in SKILL_ANCHOR_TYPE) return SKILL_ANCHOR_TYPE[cycleId];
  // Fence: [worktree-agent-]<runToken>-t<N>-<tail>. The mandatory `-t{N}-`
  // middle is the safety anchor; the <tail> is resolved to a known class below
  // rather than pattern-anchored, so a real class without an _orch/_target
  // suffix (skill_prune, health) or a trailing -<suffix> after the slot still
  // decodes (#3390).
  const m = /^(?:worktree-agent-)?[0-9a-z][0-9a-z-]*-t\d+-([a-z][a-z0-9_-]*)$/.exec(
    cycleId,
  );
  if (m) {
    const tail = m[1];
    // Exact-match fast path: the tail IS a known class (e.g. `dev_orch`,
    // `skill_prune`). This is the common shape and avoids the prefix scan.
    if (tail in SLOT_ANCHOR_TYPE) return SLOT_ANCHOR_TYPE[tail];
    // Trailing-suffix path: the tail is `<class>-<suffix>` (e.g. `dev_orch-3170`).
    // Class names use underscores, never hyphens, so the class token is exactly
    // the segment before the first `-`; a trailing `-<issue>`/`-<pr>` suffix is
    // sliced off. Resolve that segment against the class alphabet, then fall to
    // the unambiguous-prefix map (#3403) so a fenced bare prefix (`…-t3-dev`)
    // still decodes.
    return resolveClassToken(tail);
  }
  // Issue #3403 prefix leg: a fence-LESS `<class-prefix>-<suffix>` id (`dev-3291`).
  // The first `-`-delimited segment is the candidate class prefix; a trailing
  // `-<issue>`/`-<pr>` suffix is sliced off. Only an UNAMBIGUOUS prefix in
  // PREFIX_ANCHOR_TYPE resolves — so a bare UUID (`b8a3071f-a783-…`, whose first
  // segment `b8a3071f` is no class prefix) still returns undefined.
  const hyphen = cycleId.indexOf("-");
  if (hyphen === -1) return undefined;
  const head = cycleId.slice(0, hyphen);
  return head in PREFIX_ANCHOR_TYPE ? PREFIX_ANCHOR_TYPE[head] : undefined;
}

/**
 * The literal-prefixed timestamp shape `hydra-target-build` emits for its cycleId
 * (issue #3486): `claude-cycle-2026-07-18-2101` and the inline-mode twin
 * `inline-2026-07-18-2101`. The timestamp is `date -u +%Y-%m-%d-%H%M`
 * (`\d{4}-\d{2}-\d{2}-\d{4}`); a trailing `-<suffix>` is allowed for the
 * `-itemNNN`-style manual runs the reports directory shows. Anchored `^…$` so it
 * only matches the WHOLE cycleId — it can never fire on a random hex segment.
 */
const TARGET_BUILD_CYCLE_ID =
  /^(?:claude-cycle|inline)-\d{4}-\d{2}-\d{2}-\d{4}(?:-[a-z0-9]+)?$/;

/**
 * Decode a `hydra-target-build` cycleId to its anchorType lane, or `undefined`
 * when the id is not a target-build cycleId (issue #3486).
 *
 * A `claude-cycle-*` / `inline-*` cycleId is emitted ONLY by `hydra-target-build`
 * (Step 0 of `docs/operator-playbooks/hydra-target-build.md`, and the inline-mode
 * fragment), which registers it with `source: "claude"`. Every such cycle is a
 * Target build — the `dev_target` dispatch class. The lane is DERIVED from
 * {@link ANCHOR_TYPE_BY_CLASS} (`dev_target` → `work-queue`) rather than
 * hard-coded, so if the taxonomy ever re-lanes `dev_target` this leg follows.
 *
 * The literal prefix + timestamp anchor is what makes this safe under the #2822
 * "never guess" invariant: a bare UUID / short-hex / harness-branch cycleId has no
 * `claude-cycle-`/`inline-` prefix and no `date`-shaped timestamp tail, so it can
 * never match.
 */
function matchTargetBuildLane(cycleId: string): string | undefined {
  return TARGET_BUILD_CYCLE_ID.test(cycleId)
    ? ANCHOR_TYPE_BY_CLASS.dev_target
    : undefined;
}

/**
 * Resolve a fenced cycleId TAIL token (the `<tail>` in `…-t{N}-<tail>`) to its
 * anchorType lane (issue #3403). Tries, in order: exact class name
 * ({@link SLOT_ANCHOR_TYPE}), the `<class>-<suffix>` trailing-suffix form, and
 * finally the unambiguous class PREFIX ({@link PREFIX_ANCHOR_TYPE}) so a fenced
 * bare prefix (`…-t3-dev`) decodes. Returns `undefined` when no leg matches.
 */
function resolveClassToken(tail: string): string | undefined {
  if (tail in SLOT_ANCHOR_TYPE) return SLOT_ANCHOR_TYPE[tail];
  const hyphen = tail.indexOf("-");
  const candidate = hyphen === -1 ? tail : tail.slice(0, hyphen);
  if (candidate in SLOT_ANCHOR_TYPE) return SLOT_ANCHOR_TYPE[candidate];
  // Final leg: the token is a bare unambiguous class prefix (`dev`) rather than
  // a full class name. PREFIX_ANCHOR_TYPE holds single-lane prefixes only, so
  // this never guesses across an ambiguous prefix (`design`).
  return candidate in PREFIX_ANCHOR_TYPE ? PREFIX_ANCHOR_TYPE[candidate] : undefined;
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
