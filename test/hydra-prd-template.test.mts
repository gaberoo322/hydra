/**
 * Regression tests for the hydra-prd skill's rendering helpers (issue #514).
 *
 * `hydra-prd` is the non-interactive replacement for the retired Specs
 * subsystem's decomposition role (see issue #513 / ADR-0008 prose). It
 * converts a structured `PrdInput` into a parent epic body + N tracer-bullet
 * child bodies on `gaberoo322/hydra`. The parent must be parseable by
 * `hydra-epic-close` (so it can auto-close once every child closes); the
 * children must pass the issue-label-validation workflow (#396) and the
 * scope-check CI gate.
 *
 * These tests guard:
 *
 *   1. Input validation — at least 3 slices, every slice has filesInScope,
 *      dependsOn references point at earlier slices only.
 *   2. Parent rendering — `## Sub-issues` checklist is the exact format that
 *      `hydra-epic-close`'s parseEpicReferences() picks up.
 *   3. Child rendering — `## Parent`, `## What to build`, `## Acceptance
 *      criteria`, `## Files in scope`, `## Files out of scope`, `## Blocked
 *      by`, and `Expected tier: N` are all present and well-formed.
 *   4. Glossary vocabulary check — surfaces missing Hydra terms as a soft
 *      warning, not a hard error.
 *   5. Dependency-order rendering — children whose dependsOn entries have
 *      been created render `## Blocked by` with real issue numbers; later
 *      slices that reference earlier ones must resolve those refs.
 *   6. CLI arg parsing — dry-run is the default; `--apply` is the explicit
 *      opt-in.
 *
 * The renderer is pure — no fs/network/process — so these tests run in
 * milliseconds with zero setup. Cross-checked against the parseEpicReferences
 * helper in scripts/ci/epic-close.ts: the `- [ ] #N` form the parent emits
 * is exactly what that parser picks up, so a hydra-prd-generated epic is
 * automatically closeable by hydra-epic-close once every child closes.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  validatePrdInput,
  vocabularyCheck,
  renderParentBody,
  renderChildBody,
  childLabels,
  parentLabels,
  parseArgs,
  isTargetRepoPath,
  partitionScopeByRepo,
  riskSurfaceMatches,
  type PrdInput,
  type PrdSlice,
} from "../scripts/ci/hydra-prd-render.ts";
import { parseEpicReferences } from "../scripts/ci/epic-close.ts";
import { extractStrictBlockerRefs } from "../src/github/blockers.ts";

function slice(
  title: string,
  opts: Partial<PrdSlice> = {},
): PrdSlice {
  return {
    title,
    whatToBuild: opts.whatToBuild ?? `Build ${title} end to end.`,
    acceptanceCriteria: opts.acceptanceCriteria ?? [`${title} works`],
    filesInScope: opts.filesInScope ?? [`src/${title.toLowerCase()}.ts`],
    filesOutOfScope: opts.filesOutOfScope,
    dependsOn: opts.dependsOn,
    kind: opts.kind,
  };
}

function validInput(overrides: Partial<PrdInput> = {}): PrdInput {
  return {
    title: "Add foo to the Orchestrator",
    problem:
      "The Orchestrator cannot currently bar without manual operator " +
      "intervention. Every Target relying on bar-shaped Target Outcomes " +
      "stalls.",
    rationale:
      "Closing the gap removes an Operator-Required Intervention category " +
      "and unblocks the Modification Tier 2 holdback path for follow-on " +
      "changes.",
    slices: [slice("alpha"), slice("beta"), slice("gamma")],
    expectedGlossaryTerms: ["Orchestrator", "Target", "Outcome Holdback"],
    ...overrides,
  };
}

describe("validatePrdInput — required fields", () => {
  test("a well-formed input with 3 slices passes", () => {
    assert.deepEqual(validatePrdInput(validInput()), []);
  });

  test("missing title is a hard error", () => {
    const errs = validatePrdInput(validInput({ title: "" }));
    assert.ok(errs.some((e) => e.field === "title"));
  });

  test("missing problem is a hard error", () => {
    const errs = validatePrdInput(validInput({ problem: "" }));
    assert.ok(errs.some((e) => e.field === "problem"));
  });

  test("missing rationale is a hard error", () => {
    const errs = validatePrdInput(validInput({ rationale: "" }));
    assert.ok(errs.some((e) => e.field === "rationale"));
  });

  test("fewer than 3 slices is a hard error", () => {
    const errs = validatePrdInput(
      validInput({ slices: [slice("only-one"), slice("only-two")] }),
    );
    const sliceErr = errs.find((e) => e.field === "slices");
    assert.ok(sliceErr, "expected slices error");
    assert.match(sliceErr!.reason, /at least 3/);
  });
});

describe("validatePrdInput — per-slice rules", () => {
  test("a slice with no filesInScope fails issue-label-validation pre-check", () => {
    const bad = validInput({
      slices: [
        slice("a"),
        slice("b"),
        { ...slice("c"), filesInScope: [] },
      ],
    });
    const errs = validatePrdInput(bad);
    assert.ok(errs.some((e) => e.field === "slices[3].filesInScope"));
  });

  test("a slice depending on a later slice fails (must be in dependency order)", () => {
    const bad = validInput({
      slices: [
        { ...slice("a"), dependsOn: [2] },
        slice("b"),
        slice("c"),
      ],
    });
    const errs = validatePrdInput(bad);
    assert.ok(
      errs.some(
        (e) =>
          e.field === "slices[1].dependsOn" &&
          /later\/self/.test(e.reason),
      ),
    );
  });

  test("a slice depending on itself fails", () => {
    const bad = validInput({
      slices: [
        slice("a"),
        { ...slice("b"), dependsOn: [2] },
        slice("c"),
      ],
    });
    const errs = validatePrdInput(bad);
    assert.ok(errs.some((e) => e.field === "slices[2].dependsOn"));
  });

  test("a slice depending on an out-of-range index fails", () => {
    const bad = validInput({
      slices: [
        slice("a"),
        slice("b"),
        { ...slice("c"), dependsOn: [99] },
      ],
    });
    const errs = validatePrdInput(bad);
    assert.ok(
      errs.some(
        (e) => e.field === "slices[3].dependsOn" && /out of range/.test(e.reason),
      ),
    );
  });

  test("a slice with no acceptance criteria fails", () => {
    const bad = validInput({
      slices: [
        slice("a"),
        slice("b"),
        { ...slice("c"), acceptanceCriteria: [] },
      ],
    });
    const errs = validatePrdInput(bad);
    assert.ok(errs.some((e) => e.field === "slices[3].acceptanceCriteria"));
  });
});

describe("vocabularyCheck", () => {
  test("returns missing glossary terms from the parent narrative", () => {
    const narrative =
      "The Orchestrator handles foo. The Modification Tier classifier runs on every PR.";
    const missing = vocabularyCheck(narrative, [
      "Orchestrator",
      "Target",
      "Modification Tier",
      "Outcome Holdback",
    ]);
    assert.deepEqual(missing, ["Target", "Outcome Holdback"]);
  });

  test("returns [] when no expected terms are passed", () => {
    assert.deepEqual(vocabularyCheck("anything", undefined), []);
    assert.deepEqual(vocabularyCheck("anything", []), []);
  });

  test("is case-insensitive and whole-word", () => {
    // "Targeted" should NOT count as a match for "Target" — whole-word only.
    const narrative = "The orchestrator runs targeted attacks.";
    const missing = vocabularyCheck(narrative, ["Target"]);
    assert.deepEqual(missing, ["Target"]);
  });
});

describe("renderParentBody", () => {
  test("produces a ## Sub-issues section parseable by hydra-epic-close", () => {
    const input = validInput();
    const body = renderParentBody(input, [101, 102, 103]);
    assert.match(body, /## Sub-issues/);
    assert.match(body, /- \[ \] #101 — alpha/);
    assert.match(body, /- \[ \] #102 — beta/);
    assert.match(body, /- \[ \] #103 — gamma/);
    // The cross-skill contract: hydra-epic-close must be able to recover
    // every referenced sub-issue number from this body.
    assert.deepEqual(parseEpicReferences(body), [101, 102, 103]);
  });

  test("emits placeholders when child issue numbers are not yet known", () => {
    const input = validInput();
    const body = renderParentBody(input, []);
    assert.match(body, /\(slice 1: alpha\)/);
    assert.match(body, /\(slice 2: beta\)/);
    assert.match(body, /\(slice 3: gamma\)/);
    // Placeholders have NO `#N` form, so the parser must return [] — we
    // don't want a placeholder-parent to ever be classified as `close`.
    assert.deepEqual(parseEpicReferences(body), []);
  });

  test("includes Problem and Rationale sections", () => {
    const body = renderParentBody(validInput(), [1, 2, 3]);
    assert.match(body, /## Problem/);
    assert.match(body, /## Rationale/);
  });

  test("appends a source footer when sourceRef is set", () => {
    const body = renderParentBody(
      validInput({ sourceRef: "hydra:reports:research:2026-05-18T00:00:00Z" }),
      [1, 2, 3],
    );
    assert.match(body, /Source: `hydra:reports:research:/);
  });
});

describe("renderChildBody", () => {
  test("emits every section required by the agent-ready contract", () => {
    const input = validInput();
    const body = renderChildBody(input, 1, 42, new Map(), 3);
    assert.match(body, /## Parent\n\n#42/);
    assert.match(body, /## What to build/);
    assert.match(body, /## Acceptance criteria\n\n- \[ \] alpha works/);
    assert.match(body, /## Files in scope\n\n- `src\/alpha\.ts`/);
    assert.match(body, /## Files out of scope/);
    assert.match(body, /## Blocked by\n\n- _\(none\)_/);
    assert.match(body, /Expected tier: 3/);
  });

  test("resolves Blocked by from siblingIssueNumbers in dependency order", () => {
    const input = validInput({
      slices: [
        slice("a"),
        { ...slice("b"), dependsOn: [1] },
        { ...slice("c"), dependsOn: [1, 2] },
      ],
    });
    const siblings = new Map<number, number>([
      [1, 201],
      [2, 202],
    ]);
    const childC = renderChildBody(input, 3, 100, siblings, 2);
    // Issue #3425: each blocker bullet self-anchors the `Blocked by` phrase so
    // extractStrictBlockerRefs (STRICT_BLOCKER_PATTERNS) recovers the number —
    // the heading alone does not prime the contiguous parser pattern, and the
    // old bare `- #N` bullet parsed to [] (the #3059 dispatch-gate no-op bug).
    assert.match(childC, /## Blocked by\n\n- Blocked by #201\n- Blocked by #202/);
  });

  test("renders explicit Files out of scope when provided", () => {
    const input = validInput({
      slices: [
        { ...slice("a"), filesOutOfScope: ["src/forbidden.ts"] },
        slice("b"),
        slice("c"),
      ],
    });
    const body = renderChildBody(input, 1, 42);
    assert.match(body, /## Files out of scope\n\n- `src\/forbidden\.ts`/);
  });

  test("omits Expected tier line when no tier is provided", () => {
    const body = renderChildBody(validInput(), 1, 42);
    assert.doesNotMatch(body, /Expected tier:/);
  });

  test("throws on out-of-range sliceIndex", () => {
    assert.throws(() => renderChildBody(validInput(), 99, 42));
  });
});

// Issue #3425: the durable artifact renderChildBody produces must round-trip
// through extractStrictBlockerRefs (src/github/blockers.ts) — the exact parser
// #3059's deriveBoardState dispatch gate uses to exclude dependency-blocked
// issues from the ready-for-agent pool (ADR-0029 Decision 5). Before the fix,
// renderChildBody emitted a bare `- #N` bullet under `## Blocked by`, which the
// STRICT_BLOCKER_PATTERNS contiguous `blocked by … #N` regex could not match
// across the heading/blank-line gap — so every hydra-prd epic since #3059
// merged had silently non-functioning Blocked-by gating. This cross-seam guard
// bridges producer (renderer) and consumer (parser) so the seam can never
// desync again.
describe("renderChildBody → extractStrictBlockerRefs round-trip (#3425)", () => {
  test("a child with dependsOn round-trips to the resolved sibling numbers", () => {
    const input = validInput({
      slices: [
        slice("a"),
        { ...slice("b"), dependsOn: [1] },
        { ...slice("c"), dependsOn: [1, 2] },
      ],
    });
    const siblings = new Map<number, number>([
      [1, 201],
      [2, 202],
    ]);
    const childC = renderChildBody(input, 3, 100, siblings, 3);
    // The exact parser #3059's dispatch gate calls on the issue body must
    // recover the declared blocker numbers, in first-appearance order.
    assert.deepEqual(extractStrictBlockerRefs(childC), [201, 202]);
  });

  test("a child with a single blocker round-trips to that one number", () => {
    const input = validInput({
      slices: [slice("a"), { ...slice("b"), dependsOn: [1] }, slice("c")],
    });
    const childB = renderChildBody(input, 2, 100, new Map([[1, 55]]), 3);
    assert.deepEqual(extractStrictBlockerRefs(childB), [55]);
  });

  test("a child with no dependencies parses to no blockers", () => {
    // The `## Blocked by\n\n- _(none)_` empty form must NOT surface a spurious
    // blocker — an unblocked child stays dispatchable.
    const body = renderChildBody(validInput(), 1, 42, new Map(), 3);
    assert.match(body, /## Blocked by\n\n- _\(none\)_/);
    assert.deepEqual(extractStrictBlockerRefs(body), []);
  });
});

// Issue #2175: a cross-repo seam slice can list Target-repo (hydra-betting)
// siblings in filesInScope. Those must NOT land under `## Files in scope`,
// where scope-check would union them as in-scope and force the orchestrator
// dev PR to scope-justify files that cannot exist in this repo.
describe("isTargetRepoPath / partitionScopeByRepo (#2175)", () => {
  test("isTargetRepoPath matches conventional Target path forms", () => {
    assert.equal(isTargetRepoPath("hydra-betting/web/src/foo.ts"), true);
    assert.equal(isTargetRepoPath("gaberoo322/hydra-betting/web/x.ts"), true);
    assert.equal(isTargetRepoPath("/home/gabe/hydra-betting/web/y.ts"), true);
  });

  test("isTargetRepoPath leaves orchestrator paths (even ones naming the Target) alone", () => {
    assert.equal(isTargetRepoPath("src/foo.ts"), false);
    assert.equal(isTargetRepoPath("src/hydra-betting-adapter.ts"), false);
  });

  test("partitionScopeByRepo splits this-repo from Target-repo, preserving order", () => {
    const { thisRepo, targetRepo } = partitionScopeByRepo([
      "src/a.ts",
      "hydra-betting/web/b.ts",
      "src/c.ts",
      "gaberoo322/hydra-betting/d.ts",
    ]);
    assert.deepEqual(thisRepo, ["src/a.ts", "src/c.ts"]);
    assert.deepEqual(targetRepo, ["hydra-betting/web/b.ts", "gaberoo322/hydra-betting/d.ts"]);
  });
});

describe("renderChildBody — cross-repo scope partition (#2175)", () => {
  test("Target-repo siblings never appear under ## Files in scope", () => {
    const input = validInput({
      slices: [
        {
          ...slice("seam"),
          filesInScope: ["src/scope.ts", "hydra-betting/web/src/scope.ts"],
        },
        slice("b"),
        slice("c"),
      ],
    });
    const body = renderChildBody(input, 1, 42);

    // The orchestrator path is in scope; the Target path is not.
    const inScopeSection = body
      .split("## Files in scope")[1]
      .split("## ")[0];
    assert.match(inScopeSection, /- `src\/scope\.ts`/);
    assert.doesNotMatch(inScopeSection, /hydra-betting/);

    // The Target sibling is surfaced under a distinct related section that
    // scope-check (which parses only Files in/out of scope) never reads.
    assert.match(body, /## Related \(Target repo\)/);
    const relatedSection = body
      .split("## Related (Target repo)")[1]
      .split("## ")[0];
    assert.match(relatedSection, /- `hydra-betting\/web\/src\/scope\.ts`/);
  });

  test("no Related section when the slice has no Target-repo paths", () => {
    const body = renderChildBody(validInput(), 1, 42, new Map(), 3);
    assert.doesNotMatch(body, /## Related \(Target repo\)/);
    // Existing in-scope rendering is unchanged for the all-orchestrator case.
    assert.match(body, /## Files in scope\n\n- `src\/alpha\.ts`/);
  });

  test("an all-Target slice renders an explicit none-in-this-repo placeholder", () => {
    const input = validInput({
      slices: [
        { ...slice("a"), filesInScope: ["hydra-betting/web/only.ts"] },
        slice("b"),
        slice("c"),
      ],
    });
    const body = renderChildBody(input, 1, 42);
    assert.match(body, /## Files in scope\n\n- _\(none in this repo/);
    assert.match(body, /## Related \(Target repo\)/);
    assert.match(body, /- `hydra-betting\/web\/only\.ts`/);
  });
});

describe("label helpers", () => {
  test("childLabels defaults to enhancement + ready-for-agent", () => {
    assert.deepEqual(childLabels(slice("x")), ["ready-for-agent", "enhancement"]);
  });

  test("childLabels respects kind=bug", () => {
    assert.deepEqual(
      childLabels({ ...slice("x"), kind: "bug" }),
      ["ready-for-agent", "bug"],
    );
  });

  test("parentLabels reuses the existing enhancement vocabulary", () => {
    assert.deepEqual(parentLabels(), ["enhancement", "needs-triage"]);
  });

  test("parentLabels stamps needs-triage so a fresh epic is never born label-less (issue #3788)", () => {
    assert.ok(parentLabels().includes("needs-triage"));
  });
});

describe("parseArgs", () => {
  test("dry-run is the default", () => {
    assert.equal(parseArgs("").apply, false);
    assert.equal(parseArgs(null).apply, false);
    assert.equal(parseArgs(undefined).apply, false);
  });

  test("--apply opts in", () => {
    assert.equal(parseArgs("--apply").apply, true);
    assert.equal(parseArgs("apply=true").apply, true);
    assert.equal(parseArgs("apply=1").apply, true);
  });

  test("--dry-run is an explicit no-op override", () => {
    assert.equal(parseArgs("--dry-run").apply, false);
    assert.equal(parseArgs("--apply --dry-run").apply, false);
  });

  test("--input=<path> is captured", () => {
    assert.deepEqual(parseArgs("--input=/tmp/prd.json"), {
      apply: false,
      inputPath: "/tmp/prd.json",
    });
  });

  test("--apply --input=<path> works together", () => {
    assert.deepEqual(parseArgs("--apply --input=/tmp/prd.json"), {
      apply: true,
      inputPath: "/tmp/prd.json",
    });
  });
});

describe("end-to-end — parent + children round-trip with hydra-epic-close", () => {
  test("a 3-slice PRD renders a parent whose ## Sub-issues drives hydra-epic-close", () => {
    const input = validInput({
      slices: [
        slice("alpha"),
        { ...slice("beta"), dependsOn: [1] },
        { ...slice("gamma"), dependsOn: [1, 2] },
      ],
    });
    // Step 1: render parent with placeholders to mirror skill's bootstrap.
    const parentDraft = renderParentBody(input, []);
    assert.deepEqual(parseEpicReferences(parentDraft), []);

    // Step 2: pretend `gh issue create` returned numbers; render final parent.
    const childNumbers = [501, 502, 503];
    const parentFinal = renderParentBody(input, childNumbers);
    assert.deepEqual(parseEpicReferences(parentFinal), [501, 502, 503]);

    // Step 3: render each child body. Blocked by refs must resolve to real
    // sibling numbers since the skill creates children in dependency order.
    const siblings = new Map<number, number>();
    for (let i = 0; i < input.slices.length; i++) {
      const n = i + 1;
      const body = renderChildBody(input, n, 999, siblings, 3);
      // Every child must have Files in scope (issue-label-validation #396).
      assert.match(body, /## Files in scope/);
      // Every child must point back at the parent.
      assert.match(body, /## Parent\n\n#999/);
      siblings.set(n, childNumbers[i]);
    }
  });
});

describe("Target render scope (issue #5168)", () => {
  // The Target Manifest's riskCritical.surface shape ($TARGET_RISK_SURFACE_JSON):
  // directory prefixes end in "/", anything else is one exact file.
  const SURFACE = ["src/execution/", "src/risk/", "config/risk-template.json"];
  const target = { kind: "target", riskSurface: SURFACE } as const;
  const input = validInput({
    slices: [
      slice("dash", { filesInScope: ["src/app/strategies/page.tsx", "test/dash.test.ts"] }),
      slice("intent", { filesInScope: ["./src/execution/order-intent.ts", "src/risk/risk-core.ts", "src/execution/order-intent.ts"] }),
      slice("tmpl", { filesInScope: ["config/risk-template.json.bak", "config/risk-template.json"] }),
    ],
  });

  test("riskSurfaceMatches: prefix entries match by prefix, file entries exactly; ./ ignored; deduped", () => {
    assert.deepEqual(riskSurfaceMatches(input.slices[1].filesInScope, SURFACE), ["src/execution/order-intent.ts", "src/risk/risk-core.ts"]);
    assert.deepEqual(riskSurfaceMatches(input.slices[2].filesInScope, SURFACE), ["config/risk-template.json"]);
    assert.deepEqual(riskSurfaceMatches(input.slices[0].filesInScope, SURFACE), []);
    assert.deepEqual(riskSurfaceMatches(["src/executionist.ts"], SURFACE), [], "a prefix entry needs its trailing slash boundary");
  });

  test("a risk-surface slice gets a Money-critical line and never an Expected tier", () => {
    const body = renderChildBody(input, 2, 900, new Map(), 3, target);
    assert.match(body, /^Money-critical: yes — touches the Target risk surface \(src\/execution\/order-intent\.ts, src\/risk\/risk-core\.ts\)$/m);
    assert.doesNotMatch(body, /Expected tier/, "the tier ladder is Orchestrator-only");
  });

  test("a risk-free Target slice gets neither line", () => {
    const body = renderChildBody(input, 1, 900, new Map(), 3, target);
    assert.doesNotMatch(body, /Money-critical|Expected tier/);
  });

  test("Target scope keeps every declared path in scope (no repo partition)", () => {
    const t = validInput({ slices: [slice("a", { filesInScope: ["claw-street-bets/src/x.ts", "src/y.ts"] }), slice("b"), slice("c")] });
    const body = renderChildBody(t, 1, 900, new Map(), undefined, target);
    assert.match(body, /- `claw-street-bets\/src\/x\.ts`/);
    assert.doesNotMatch(body, /## Related \(Target repo\)/);
  });

  test("childLabels adds money-critical only for a Target slice on the surface", () => {
    assert.deepEqual(childLabels(input.slices[1], target), ["ready-for-agent", "enhancement", "money-critical"]);
    assert.deepEqual(childLabels(input.slices[0], target), ["ready-for-agent", "enhancement"]);
    assert.deepEqual(childLabels(input.slices[1]), ["ready-for-agent", "enhancement"], "orch scope is unchanged");
  });

  test("childLabels files a dependent Target slice blocked, never ready-for-agent", () => {
    const dependent = { ...input.slices[1], dependsOn: [1] };
    assert.deepEqual(childLabels(dependent, target), ["blocked", "enhancement", "money-critical"]);
    assert.deepEqual(childLabels(dependent), ["ready-for-agent", "enhancement"], "orch scope is unchanged");
  });

  test("riskSurfaceMatches normalises ./ on surface entries too", () => {
    assert.deepEqual(riskSurfaceMatches(["src/risk/a.ts"], ["./src/risk/", " "]), ["src/risk/a.ts"]);
  });

  test("orchestrator scope is byte-identical to the pre-#5168 default", () => {
    for (let i = 1; i <= input.slices.length; i++) {
      assert.equal(renderChildBody(input, i, 900, new Map(), 3, { kind: "orch" }), renderChildBody(input, i, 900, new Map(), 3));
    }
  });

  test("orch scope with the configured Target name partitions that Target's paths out", () => {
    assert.equal(isTargetRepoPath("claw-street-bets/src/x.ts"), false, "without the name, only the legacy Target is recognised");
    assert.equal(isTargetRepoPath("claw-street-bets/src/x.ts", "claw-street-bets"), true);
    assert.equal(isTargetRepoPath("gaberoo322/claw-street-bets/src/x.ts", "claw-street-bets"), true);
    assert.equal(isTargetRepoPath("src/claw-street-bets-adapter.ts", "claw-street-bets"), false, "segment-anchored");
    assert.equal(isTargetRepoPath("hydra-betting/web/x.ts", "claw-street-bets"), true, "the legacy Target still counts");
    const { thisRepo, targetRepo } = partitionScopeByRepo(["src/a.ts", "claw-street-bets/src/b.ts"], "claw-street-bets");
    assert.deepEqual(thisRepo, ["src/a.ts"]);
    assert.deepEqual(targetRepo, ["claw-street-bets/src/b.ts"]);
    const o = validInput({ slices: [slice("a", { filesInScope: ["src/a.ts", "claw-street-bets/src/b.ts"] }), slice("b"), slice("c")] });
    const body = renderChildBody(o, 1, 900, new Map(), 3, { kind: "orch", targetName: "claw-street-bets" });
    assert.match(body, /## Related \(Target repo\)\n\nThese sibling paths live in the Target repo \(`claw-street-bets`\)/);
    assert.match(body, /^Expected tier: 3$/m);
  });
});
