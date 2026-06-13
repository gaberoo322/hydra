// Agent-authored TypeScript scorer for the Hydra eval harness (issue #1803).
//
// THE evalite NICHE, DELIVERED IN THE NO-DEPENDENCY promptfoo LANE.
// =====================================================================
// tool-scout #1803 proposed evalite for "agents write a numeric TypeScript
// scorer (0/1) and the eval becomes a CI gate". That niche — an
// agent-authored, type-checked, numeric scorer — is the genuinely useful idea
// in #1803. But evalite cannot run in Hydra's established eval lane: it hard-
// requires a resolvable `vitest` package (`npx evalite run` dies with
// `Cannot find package 'vitest'`), so adopting it means adding `evalite` AND
// `vitest` + their large transitive trees as devDependencies — which trips the
// `allow-scripts` CI gate (committed lavamoat allowlist is empty: `allowScripts:
// {}`) and contradicts the pinned-`npx`, never-a-dependency rule docs/evals.md
// reaffirmed one day earlier when promptfoo (#1806) landed.
//
// promptfoo ALREADY supports TypeScript scorers via the `type: javascript`
// assertion with a `file://<path>.ts` value — promptfoo imports the file
// through its own esbuild loader, so no vitest, no build step, no new
// dependency. This file IS the #1803 capability, on the lane the operator
// reaffirmed. See docs/evals.md § "TypeScript scorers (the evalite niche)".
//
// SCORER CONTRACT (promptfoo `file://*.ts` javascript assertion):
//   default export = (output, context) => GradingResult
//   - `output`  is the model/provider output string under test.
//   - `context.vars` holds the per-test `vars` block from the YAML config.
//   - return { pass, score, reason } — `score` is the numeric 0..1 the issue
//     asked for; `pass` drives the advisory eval-gate verdict.
// The two-arg `(output, context)` shape is load-bearing: promptfoo does NOT
// pass an AssertionParams object to a default-exported function (verified
// against promptfoo@0.121.15 — destructuring `{ output }` yields undefined).

import type { AssertionValueFunctionContext, GradingResult } from "promptfoo";

/**
 * Scores 1 when `output` references the expected issue number as `#<n>`, else 0.
 * Stand-in for the #1803 example scorer: "does the PR open against the right
 * issue?". A hydra-dev dispatch's PR body must contain `closes #<issue>`, so a
 * golden replay of that body should score 1 here.
 */
export default function issueRefScorer(
  output: string,
  context: AssertionValueFunctionContext,
): GradingResult {
  const want = String((context?.vars as Record<string, unknown> | undefined)?.issue ?? "").trim();
  if (want.length === 0) {
    return { pass: false, score: 0, reason: "no `issue` var supplied to scorer" };
  }
  const pass = String(output).includes(`#${want}`);
  return {
    pass,
    score: pass ? 1 : 0,
    reason: pass ? `output references #${want}` : `output is missing the expected #${want} reference`,
  };
}
