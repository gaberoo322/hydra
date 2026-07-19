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
 *     {@link INTERACTIVE_SKILL}
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
 * The `hydra-dispatch` sentinel (issue #692): the hidden
 * `<!-- hydra-dispatch v1 ... skill={skill} ... -->` HTML comment prepended to
 * the FIRST user message of every Agent-tool dispatch. `skill=` is the
 * highest-precedence attribution signal. Anchored on the bare token, not the
 * full comment, so it matches whether the comment is the whole message or
 * embedded in a longer prompt body. (issue #2402)
 */
const SENTINEL_RE = /<!--\s*hydra-dispatch\s+v1\b[^>]*\bskill=([^\s>]+)/;

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
 * for the precedence contract. Exported for direct unit test.
 */
export function deriveSkill(firstUserText: string | null): string {
  if (firstUserText) {
    const sentinel = SENTINEL_RE.exec(firstUserText);
    if (sentinel) return sentinel[1]; // (1) hydra-dispatch sentinel skill=
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
  if (firstUserText) {
    if (SENTINEL_RE.test(firstUserText)) return "autopilot-dispatched"; // (1) sentinel
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
