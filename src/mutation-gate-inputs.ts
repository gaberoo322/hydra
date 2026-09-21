/**
 * mutation-gate-inputs.ts — the ONE shared leaf holding the pure input-parse
 * and shared-classification helpers common to the two mutation gates
 * (issue #4346).
 *
 * Consumers:
 *   - scripts/ci/mutation-check.ts     — the Orchestrator's own diff-scoped
 *     mutation gate (wired into .github/workflows/ci.yml).
 *   - scripts/target/mutation-check.ts — the Target's money-critical mutation
 *     gate, distributed by scripts/sync-target-gate.sh into the SIBLING gate
 *     dir `<target-wt>.hydra-gate` (issue #4526: outside the worktree, so no
 *     Target tool ever sees the mirror) as
 *     scripts/target/mutation-check.ts (this leaf is a member
 *     of that GATE_FILES closure; the layout-preserving mirror keeps the
 *     `./mutation.ts` type import resolving unchanged).
 *   - scripts/ci/scope-check.ts        — the required scope-enforcement gate
 *     (issue #4579: dropped its byte-identical local `readChangedFiles`).
 *   - scripts/ci/target-risk-core-check.ts — the Target risk-core guard
 *     (issue #4579: dropped its byte-identical local `readChangedFiles`).
 *   - scripts/ci/stryker-scan.ts       — the advisory Stryker scan gate
 *     (issue #4579: `readChangedFiles()` backs the env arm of its own
 *     `resolveChangedFiles(cwd, git)`, which keeps a caller-side git-diff
 *     fallback the other two consumers don't need).
 *
 * Before #4346 each gate hand-duplicated these helpers; the copies had already
 * drifted (the Orchestrator's CHANGED_FILES split was newline-only while the
 * Target's #3803 parser tokenizes on any whitespace run). This leaf is the
 * domain-neutral seam both gates import, so a fix lands once and the sync
 * mechanism carries it into the Target worktree automatically.
 *
 * DELIBERATELY NOT HERE: classifyNoSignal. The two gates' no-signal policies
 * are a genuine divergence, not drift — the Orchestrator threads a
 * Modification-Tier parameter (T1/T2 → neutral, tier>=3/non-finite → warn)
 * while the Target's risk model is a two-level money-critical boolean with no
 * tier ladder, so its copy is tier-less and always warns. Each gate keeps its
 * own classifyNoSignal next to its own policy.
 *
 * Everything here is pure / env-only — no runtime imports (the only import is
 * a TYPE from ./mutation.ts), no filesystem, no git, no Redis, no network.
 * Test it directly by passing arbitrary inputs
 * (test/mutation-gate-inputs.test.mts).
 */

import type { MutationTestReport } from "./mutation.ts";

// ---------------------------------------------------------------------------
// Quick-fix tag + env parsing (byte-for-byte unifications — the two gates'
// copies were identical before #4346)
// ---------------------------------------------------------------------------

/**
 * Whether a PR body carries the `[quick-fix]` tag that neutrally skips the
 * mutation gate (mirrors the historical in-cycle quick-fix exemption).
 * Case-insensitive; an empty/undefined body is tolerated (no match).
 *
 * Pure — takes the body as an argument; the caller sources it from PR_BODY.
 */
export function isQuickFix(body: string): boolean {
  return /\[quick-fix\]/i.test(body || "");
}

/**
 * Read a non-negative integer env var, falling back when it is unset, empty,
 * non-numeric (NaN after base-10 parseInt), or negative. Zero is accepted.
 * Shared by both gates' floor / tier / budget env reads
 * (`MUTATION_KILL_RATE_FLOOR`, `TARGET_MUTATION_KILL_FLOOR`,
 * `MUTATION_TIME_BUDGET_MS`, ...).
 */
export function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// ---------------------------------------------------------------------------
// CHANGED_FILES parsing (issue #3803)
// ---------------------------------------------------------------------------

/**
 * Parse a `CHANGED_FILES` value into one entry per real file path
 * (issue #3803).
 *
 * Splits on ANY run of whitespace — newlines, spaces, tabs, or a mix — then
 * trims each token and drops empties. The CI path feeds this
 * newline-separated `git diff --name-only` output, but an agent or manual
 * invocation that builds the value by hand naturally writes it
 * space-separated:
 *
 *     CHANGED_FILES="src/a.ts src/b.ts" npx tsx scripts/ci/mutation-check.ts
 *
 * A newline-only split collapses that single-line value into ONE array
 * element — the whole concatenated string — which silently corrupts BOTH
 * downstream branches (issue #3803 documents the full anatomy on the Target
 * gate: misreported skip counts, and a space-containing "path" blob that
 * matches a directory-prefix check then ENOENTs into a false no-signal warn).
 * Whitespace-tokenizing removes the trap: every parsed entry is a single
 * real, individually-addressable path, and no tracked path in either repo
 * contains a literal space.
 *
 * Additive and non-breaking: a newline-only input has no non-newline
 * whitespace runs to change the split, so the CI path parses byte-identically
 * to the pre-#4346 newline-only Orchestrator copy. Since #4346 BOTH gates
 * share this one parser (the Orchestrator gate's hand-invocation ergonomics
 * improve for free; its CI behaviour is unchanged).
 *
 * Pure — no filesystem, no git, no env. Test it by passing arbitrary strings.
 */
export function parseChangedFiles(raw: string): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(/[\s\r\n]+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Read the `CHANGED_FILES` env var through parseChangedFiles. The one-line
 * env seam both gates' main() call; the separator policy is unit-testable in
 * isolation (see parseChangedFiles above).
 */
export function readChangedFiles(): string[] {
  return parseChangedFiles(process.env.CHANGED_FILES ?? "");
}

// ---------------------------------------------------------------------------
// Timed-out classification (issues #2393 Orchestrator / #1821 Target)
// ---------------------------------------------------------------------------

/**
 * Result of the timed-out classification (issues #2393 Orchestrator / #1821
 * Target, unified by #4346).
 *
 * `status` is always `"warn"` — a gate that exhausted its time budget reached
 * NO verdict, so it must not present as a clean `pass`. `killRate` carries
 * the partial kill rate computed from whatever mutants finished before the
 * budget ran out (informational only, NEVER compared against the floor) so
 * the step-summary still shows progress; it is explicitly NOT a pass/fail
 * signal. `warn` is non-blocking (the caller keeps exit 0) — a slow gate
 * must not hard-block an otherwise-good diff, but it must stop masquerading
 * as a pass.
 *
 * Tier-independent: a budget-exhausted run has reached no verdict regardless
 * of tier, so the outcome is ALWAYS `warn`. There is no `neutral` sub-case —
 * a partial sample is never a pass on any tier.
 */
export type TimedOutClassification = {
  status: "warn";
  reason: string;
  timedOut: true;
  killRate: number | null;
};

/**
 * Classify a mutation report whose runner exhausted its time budget (issues
 * #2393 Orchestrator / #1821 Target, unified by #4346).
 *
 * The pre-fix gates computed `killRate` from whatever mutants finished before
 * the 540s budget and emitted `pass`/`fail` from that partial sample, so a
 * timed-out run looked identical to a complete one — a diff whose surviving
 * mutants land in the unevaluated tail could clear the floor. This helper is
 * the pure, unit-testable seam that turns a timed-out report into a DISTINCT
 * non-pass `warn` outcome with an explicit reason, instead of a
 * partial-sample verdict.
 *
 * Returns `null` when the runner did NOT time out (`report.timedOut ===
 * false`) — the caller then runs the normal kill-rate comparison. Only
 * `timedOut` yields a classification.
 *
 * The partial kill rate is surfaced for context (how far the gate got before
 * the budget ran out) but is informational: a timed-out gate has, by
 * definition, not evaluated the full mutant set, so a partial rate above the
 * floor is not proof the diff clears it. `killRate` is `null` when no mutant
 * produced testable signal before the timeout.
 *
 * Pure — no env, no IO, no git. Test it by passing arbitrary reports.
 */
export function classifyTimedOut(
  report: MutationTestReport,
): TimedOutClassification | null {
  if (!report.timedOut) return null;

  // Issue #4504: the partial rate's denominator is the CONCLUSIVE mutants only
  // (killed + survived) — inconclusive (per-mutant timeout / broken baseline)
  // and no-coverage mutants carry no signal. Mirrors conclusiveMutants() in
  // ./mutation.ts, inlined to keep this leaf free of runtime imports; for a
  // report without the #4504 opt-ins both counts are 0, so this is the
  // historical `totalMutants - skipped` (the Target gate is unchanged).
  const testable =
    report.totalMutants - report.skipped - report.inconclusive - report.noCoverage;
  const partialKillRate =
    testable > 0 ? Math.round((report.killed / testable) * 100) : null;

  const reason =
    `mutation gate timed out before evaluating all mutants ` +
    `(${report.totalMutants} of ${report.candidatesGenerated} candidate mutant(s) run; ` +
    `partial kill rate ` +
    (partialKillRate === null ? "n/a" : `${partialKillRate}%`) +
    `) — no complete verdict, treat as inconclusive (non-blocking)`;

  return { status: "warn", reason, timedOut: true, killRate: partialKillRate };
}
