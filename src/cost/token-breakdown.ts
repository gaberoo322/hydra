/**
 * src/cost/token-breakdown.ts — the pure **token-breakdown data-model** leaf of
 * the **Cost** Module's Subscription Usage Tracker (issue #3513).
 *
 * Extracted OUT of the `transcript-scan.ts` I/O coordinator (issue #1971) so the
 * token-breakdown data model's null-state, mutation, and vocabulary primitives
 * live in one focused pure leaf — NOT next to the JSONL filesystem walk. Before
 * this split, `snapshot-assembly.ts` (a self-described pure, no-I/O leaf) had to
 * import `EMPTY_BREAKDOWN` / `addBreakdown` / `emptyByModel` / `DISPATCH_KINDS`
 * FROM `transcript-scan.ts`, dragging a pure module into the transitive closure
 * of `node:fs/promises` + the OAuth cache machinery. This leaf makes that a
 * pure→pure edge instead.
 *
 * PURE: no filesystem I/O, no Redis, no `process.env` reads, no `Date.now()`.
 * The only imports are TYPE-only downward references to the sibling pure math
 * leaf `./token-math.ts` (`TokenBreakdown`, `ModelFamily`) — compile-erased, so
 * no runtime edge. `transcript-scan.ts` imports its accumulator + vocabulary
 * primitives FROM here and re-exports the ones its existing importers still
 * reach by name; `snapshot-assembly.ts` imports them directly from here.
 *
 * Owned primitives:
 *   - the breakdown accumulator cluster: {@link EMPTY_BREAKDOWN},
 *     {@link emptyByModel}, {@link addBreakdown}
 *   - the dispatch-kind vocabulary: {@link DISPATCH_KINDS}, {@link DispatchKind},
 *     {@link deriveDispatchKind}, {@link emptyByDispatchKind}
 *   - the pure skill classifier: {@link deriveSkill}, {@link SkillResolver},
 *     {@link INTERACTIVE_SKILL}, and the {@link parseSentinel} /
 *     {@link SentinelParse} dispatch-sentinel parser (issue #3969)
 */

import type { TokenBreakdown, ModelFamily } from "./token-math.ts";

/**
 * Residual bucket key for sessions whose first user message carries NEITHER a
 * `hydra-dispatch` sentinel NOR a leading `/command-name` slash marker — i.e. a
 * plain interactive operator session (or a legacy transcript predating the
 * sentinel). Tokens are still counted — they bucket here — so `bySkillByModel`
 * stays reconcilable to `byModel` and to the per-skill counters in
 * `src/redis/cost.ts`; nothing is dropped. (issue #693, #2402)
 *
 * Renamed from the former `"unattributed"` value (issue #2402): in-transcript
 * derivation makes "no attribution signal" mean exactly "interactive", not
 * "registry empty".
 */
export const INTERACTIVE_SKILL = "interactive";

/**
 * Resolves a transcript's FIRST user message text to the dispatching skill
 * (issue #2402). Derivation is pure and Redis-free: the precedence is
 * (1) `hydra-dispatch` sentinel `skill=` → (2) a leading `/command-name` slash
 * marker → (3) the literal residual bucket {@link INTERACTIVE_SKILL}. A TOTAL
 * function: always returns a non-empty string, so every contributing file
 * lands in exactly one bucket and the `Σ bySkillByModel === byModel`
 * reconciliation invariant holds.
 *
 * The argument is the first user message's text (or `null` when the transcript
 * has no readable first user message), which the scan already holds — no second
 * `readFile`, no Redis read. Injectable so tests can pin the cross-tab by
 * passing fixture text instead of standing up a registry. Replaces the former
 * `(sessionId)=>Promise<string|null>` registry-read resolver (issue #693) that
 * the dead SessionStart hook (issue #2401) left structurally empty.
 */
export type SkillResolver = (firstUserText: string | null) => string;

/**
 * The `hydra-dispatch` sentinel (issue #692): the hidden HTML comment
 * `<!-- hydra-dispatch v1 skill={skill} dispatchId={id} runId={runId} -->`
 * prepended to the FIRST user message of every Agent-tool dispatch. This is
 * the OPENER anchor: it detects the sentinel's presence and captures the
 * comment BODY (group 1) so per-field extraction can be scoped to the
 * comment — never the surrounding prompt prose. Anchored on the bare token,
 * not the full comment, so it matches whether the comment is the whole
 * message or embedded in a longer prompt body. (issue #2402; widened in
 * #3969 to carry `dispatchId`/`runId` through the attribution path. The
 * former inline `\bskill=([^\s>]+)` capture moved to {@link SENTINEL_SKILL_RE}
 * — `deriveSkill`/`deriveDispatchKind` keep their exact prior behaviour via
 * {@link parseSentinel}.)
 */
const SENTINEL_RE = /<!--\s*hydra-dispatch\s+v1\b([^>]*)/;

/**
 * Per-field extractors over the {@link SENTINEL_RE} comment body (issue
 * #3969). The emitter (`make_dispatch_sentinel` in scripts/autopilot/decide.py)
 * documents field ORDER as non-load-bearing — it keeps the canonical
 * skill/dispatchId/runId order only for readability — so each field is matched
 * by its OWN anchored regex rather than a fixed-position capture group. The
 * `([^\s>]+)` value class matches the emitter's verbatim clean tokens and
 * yields no match (→ `null`) for an absent or empty field, so an older
 * skill-only sentinel resolves `dispatchId`/`runId` to `null` without
 * throwing.
 */
const SENTINEL_SKILL_RE = /\bskill=([^\s>]+)/;
const SENTINEL_DISPATCH_ID_RE = /\bdispatchId=([^\s>]+)/;
const SENTINEL_RUN_ID_RE = /\brunId=([^\s>]+)/;

/**
 * The three join keys a `hydra-dispatch v1` sentinel carries (issue #3969) —
 * enough to join a transcript's tokens back to the dispatch that produced
 * them. Each field is `null` when its `field=value` token is absent from the
 * comment body. `skill` drives attribution (see {@link deriveSkill}); it is
 * `null` only for a malformed sentinel that omits `skill=` entirely, in which
 * case attribution falls through the precedence chain exactly as before.
 */
export interface SentinelParse {
  /** The dispatching skill — the highest-precedence attribution signal. */
  skill: string | null;
  /** The dispatch id emitted by decide.py; `null` when the field is absent. */
  dispatchId: string | null;
  /** The autopilot run id; `null` when absent (operator / legacy dispatch). */
  runId: string | null;
}

/**
 * Read the first capture group of `re` against `body`, or `null` when `re`
 * does not match. Keeps {@link parseSentinel} terse and guarantees an absent
 * field resolves to `null` — never `undefined`, never a coerced empty string.
 */
function fieldOrNull(re: RegExp, body: string): string | null {
  const m = re.exec(body);
  return m ? (m[1] ?? null) : null;
}

/**
 * Parse the `hydra-dispatch v1` sentinel in a transcript's first user message
 * (issue #3969). Returns the three join keys, or `null` when the sentinel
 * opener is absent. Field extraction is scoped to the comment body and is
 * order-independent (see {@link SENTINEL_SKILL_RE}). Pure, Redis-free. A
 * malformed or older-form sentinel never throws: absent fields are `null`.
 * Exported so the token-breakdown attribution path (and its callers) can join
 * a transcript's tokens to the dispatch that produced them.
 */
export function parseSentinel(firstUserText: string | null): SentinelParse | null {
  if (!firstUserText) return null;
  const open = SENTINEL_RE.exec(firstUserText);
  if (!open) return null;
  const body = open[1] ?? "";
  return {
    skill: fieldOrNull(SENTINEL_SKILL_RE, body),
    dispatchId: fieldOrNull(SENTINEL_DISPATCH_ID_RE, body),
    runId: fieldOrNull(SENTINEL_RUN_ID_RE, body),
  };
}

/**
 * The slash-command marker (issue #2402). Slash-command dispatches (the
 * autopilot's own `/hydra-autopilot`, an operator-invoked `/hydra-grill`, …)
 * record their first user message as `<command-name>/skill-name</command-name>`
 * (the leading `/` is optional in that tag), OR — for a raw typed slash command
 * — a leading `/skill-name`. Either form attributes to `skill-name`. The
 * `command-name` arm is checked first so a `<command-name>` wrapper is matched
 * even though it does not start the string. Supports the `plugin:skill`
 * namespaced form via the `:` in the character class.
 */
const COMMAND_NAME_RE = /<command-name>\s*\/?([a-z0-9][a-z0-9:_-]*)/i;
const LEADING_SLASH_RE = /^\s*\/([a-z0-9][a-z0-9:_-]*)/i;

/**
 * Derive the dispatching skill from a transcript's first user message text
 * (issue #2402). Total, deterministic, Redis-free — see {@link SkillResolver}
 * for the precedence contract. The sentinel branch now reads the parsed
 * {@link SentinelParse} but its behaviour is byte-for-byte unchanged: a
 * sentinel contributes its skill iff it carries a non-empty `skill=`,
 * otherwise attribution falls through the chain exactly as before (#3969).
 * Exported for direct unit test.
 */
export function deriveSkill(firstUserText: string | null): string {
  const sentinel = parseSentinel(firstUserText);
  if (sentinel?.skill) return sentinel.skill; // (1) hydra-dispatch sentinel skill=
  if (firstUserText) {
    const cmd = COMMAND_NAME_RE.exec(firstUserText);
    if (cmd) return cmd[1]; // (2a) <command-name>/skill</command-name> marker
    const slash = LEADING_SLASH_RE.exec(firstUserText);
    if (slash) return slash[1]; // (2b) leading /skill slash marker
  }
  return INTERACTIVE_SKILL; // (3) residual
}

/**
 * The three mutually-exclusive **dispatch kinds** (issue #2403). A PROJECTION
 * over WHICH branch of the {@link deriveSkill} precedence chain fired for a
 * session's first user message — NOT an independent re-derivation:
 *
 *   - `autopilot-dispatched` — the `hydra-dispatch` sentinel matched (a
 *     background Agent-tool dispatch; `runId` is structurally present iff the
 *     sentinel matched, so the sentinel branch IS this kind).
 *   - `operator-invoked` — a `<command-name>/skill</command-name>` marker or a
 *     leading `/skill` slash matched (the operator typed/ran a slash command).
 *   - `interactive` — neither matched (a plain interactive operator session, or
 *     a legacy transcript predating the sentinel). The SAME residual the
 *     `bySkillByModel` cross-tab buckets under {@link INTERACTIVE_SKILL}.
 *
 * The order of this tuple is the precedence order; it is also the canonical
 * render/iteration order for the dashboard kind split.
 */
export const DISPATCH_KINDS = [
  "autopilot-dispatched",
  "operator-invoked",
  "interactive",
] as const;
export type DispatchKind = (typeof DISPATCH_KINDS)[number];

/**
 * Resolves a transcript's first user message text to its **dispatch kind**
 * (issue #2403). Total, deterministic, Redis-free — partitions over the SAME
 * precedence chain as {@link deriveSkill} (sentinel → command/slash marker →
 * residual), so every contributing file lands in exactly one kind and the
 * `Σ_kind byDispatchKind[kind][f].total === byModel[f].total` invariant holds.
 *
 * Pure projection: no second `readFile`, no `runId` re-parse — the precedence
 * branch already IS the kind. Exported for direct unit test.
 */
export function deriveDispatchKind(firstUserText: string | null): DispatchKind {
  const sentinel = parseSentinel(firstUserText);
  if (sentinel?.skill) return "autopilot-dispatched"; // (1) sentinel carrying skill=
  if (firstUserText) {
    if (COMMAND_NAME_RE.test(firstUserText)) return "operator-invoked"; // (2a) <command-name>
    if (LEADING_SLASH_RE.test(firstUserText)) return "operator-invoked"; // (2b) leading /slash
  }
  return "interactive"; // (3) residual
}

export const EMPTY_BREAKDOWN: TokenBreakdown = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation: 0,
  total: 0,
};

export function emptyByModel(): Record<ModelFamily, TokenBreakdown> {
  return {
    opus: { ...EMPTY_BREAKDOWN },
    sonnet: { ...EMPTY_BREAKDOWN },
    haiku: { ...EMPTY_BREAKDOWN },
    unknown: { ...EMPTY_BREAKDOWN },
  };
}

export function addBreakdown(target: TokenBreakdown, src: TokenBreakdown): void {
  target.input += src.input;
  target.output += src.output;
  target.cacheRead += src.cacheRead;
  target.cacheCreation += src.cacheCreation;
  target.total += src.total;
}

/** Empty per-kind × per-family accumulator, all three kinds zero-valued. */
export function emptyByDispatchKind(): Record<DispatchKind, Record<ModelFamily, TokenBreakdown>> {
  return {
    "autopilot-dispatched": emptyByModel(),
    "operator-invoked": emptyByModel(),
    interactive: emptyByModel(),
  };
}
