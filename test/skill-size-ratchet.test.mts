/**
 * test/skill-size-ratchet.test.mts — pin the skill-size ratchet's pure core
 * (issue #2946): frontmatter split + description extraction, whitespace word
 * count, and the shrink-only baseline comparison including the grandfathered
 * description cap (effective cap = max(50, baselined count)).
 *
 * Feeds synthetic playbook strings and synthetic baselines through the
 * exported pure functions — no filesystem walk, no process.exit (the script
 * only runs main() as a CLI entrypoint).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const {
  measureSkillSource,
  countWords,
  effectiveDescriptionCap,
  compareAgainstBaseline,
  formatShrinkHints,
  DESCRIPTION_WORD_CAP,
} = await import("../scripts/ci/skill-size-ratchet.ts");

const PB = "docs/operator-playbooks/hydra-example.md";
const FRAG = "docs/operator-playbooks/_fragments/example-fragment.md";

function baselineOf(files: Record<string, { body: number; description?: number }>) {
  return { note: "synthetic baseline for tests", files };
}

/** INV-1/INV-2: growth advice carries --allow-grow + Baseline-raise, no bare writer. */
function assertGrowthAdvice(msg: string): void {
  assert.match(msg, /--allow-grow/);
  assert.match(msg, /Baseline-raise:/);
  assert.match(msg, /STD-BASELINE-EDIT-ROWS/);
  for (const m of msg.matchAll(/--write-baseline(?! --allow-grow)/g)) {
    assert.fail(`bare --write-baseline at ${m.index} in: ${msg}`);
  }
}

/** INV-3: stale advice is hand-edit only, names no writer. */
function assertStaleAdvice(msg: string): void {
  assert.match(msg, /by hand/);
  assert.match(msg, /Do not regenerate/);
  assert.doesNotMatch(msg, /--write-baseline|--shape/);
}

describe("skill-size-ratchet: measureSkillSource (core grammar)", () => {
  test("splits frontmatter from body and counts both", () => {
    assert.deepEqual(
      measureSkillSource(
        "---\nname: hydra-example\ndescription: Does a thing.\n---\n# Title\n\nBody text here.\n",
      ),
      { body: 5, description: 3 },
    );
  });

  test("frontmatter-less doc is exempt (null), not an error", () => {
    assert.equal(measureSkillSource("# Ollama Recovery\n\nProse.\n"), null);
  });

  test("MALFORMED frontmatter (opens with --- but never closes) throws - fail loud", () => {
    assert.throws(
      () => measureSkillSource("---\nname: truncated\n# no closing delimiter\n"),
      /malformed frontmatter/,
    );
  });

  test("counts a quoted description without its quotes", () => {
    assert.equal(
      measureSkillSource('---\nname: x\ndescription: "Quoted words here."\n---\nb\n')!.description,
      3,
    );
  });

  test("unquoted description counted; absent description counts zero", () => {
    assert.equal(measureSkillSource("---\ndescription: Plain words.\n---\nb\n")!.description, 2);
    assert.equal(measureSkillSource("---\nname: x\nwhen_to_use: whenever\n---\nb\n")!.description, 0);
  });
});

describe("skill-size-ratchet: countWords", () => {
  test("counts whitespace tokens, dropping empties", () => {
    assert.equal(countWords("three little words"), 3);
    assert.equal(countWords("  leading\nand\ttrailing  \n\n"), 3);
    assert.equal(countWords(""), 0);
    assert.equal(countWords("  \n \t "), 0);
  });
});

describe("skill-size-ratchet: shrink-only baseline comparison", () => {
  test("equal-to-baseline passes (no violations, nothing shrunk)", () => {
    const { violations, shrunk } = compareAgainstBaseline(
      { [PB]: { body: 100, description: 20 } },
      baselineOf({ [PB]: { body: 100, description: 20 } }),
    );
    assert.deepEqual(violations, []);
    assert.deepEqual(shrunk, []);
  });

  test("GROW: body above baseline fails, names file + both counts + remediation", () => {
    const { violations } = compareAgainstBaseline(
      { [PB]: { body: 105, description: 20 } },
      baselineOf({ [PB]: { body: 100, description: 20 } }),
    );
    assert.equal(violations.length, 1);
    assert.equal(violations[0].rule, "body-grew");
    assert.equal(violations[0].path, PB);
    assert.equal(violations[0].current, 105);
    assert.equal(violations[0].allowed, 100);
    assertGrowthAdvice(violations[0].message);
  });

  test("SHRINK: body below baseline passes green, listed as tightenable", () => {
    const { violations, shrunk } = compareAgainstBaseline(
      { [PB]: { body: 80, description: 20 } },
      baselineOf({ [PB]: { body: 100, description: 20 } }),
    );
    assert.deepEqual(violations, []);
    assert.deepEqual(shrunk, [{ path: PB, current: 80, baseline: 100 }]);
  });

  test("NEW PLAYBOOK: skill source missing from baseline fails with a seed instruction", () => {
    const { violations } = compareAgainstBaseline(
      { [PB]: { body: 50, description: 10 } },
      baselineOf({}),
    );
    assert.equal(violations.length, 1);
    assert.equal(violations[0].rule, "missing-baseline-entry");
    assert.equal(violations[0].path, PB);
    assertGrowthAdvice(violations[0].message);
  });

  test("MISSING BASELINE: null baseline fails with the seed command", () => {
    const { violations } = compareAgainstBaseline(
      { [PB]: { body: 50, description: 10 } },
      null,
    );
    assert.equal(violations.length, 1);
    assert.equal(violations[0].rule, "baseline-missing");
    assert.match(violations[0].message, /--write-baseline/);
  });

  test("STALE ENTRY: baseline entry whose file is gone fails with a prune instruction", () => {
    const { violations } = compareAgainstBaseline(
      {},
      baselineOf({ [PB]: { body: 100, description: 20 } }),
    );
    assert.equal(violations.length, 1);
    assert.equal(violations[0].rule, "stale-baseline-entry");
    assert.equal(violations[0].path, PB);
    assertStaleAdvice(violations[0].message);
  });

  test("fragments (no description field) ratchet on body only", () => {
    const grow = compareAgainstBaseline(
      { [FRAG]: { body: 201 } },
      baselineOf({ [FRAG]: { body: 200 } }),
    );
    assert.equal(grow.violations.length, 1);
    assert.equal(grow.violations[0].rule, "body-grew");

    const ok = compareAgainstBaseline(
      { [FRAG]: { body: 200 } },
      baselineOf({ [FRAG]: { body: 200 } }),
    );
    assert.deepEqual(ok.violations, []);
  });
});

describe("skill-size-ratchet: description cap with grandfathering", () => {
  test("effective cap is max(50, baselined count)", () => {
    assert.equal(DESCRIPTION_WORD_CAP, 50);
    assert.equal(effectiveDescriptionCap(undefined), 50);
    assert.equal(effectiveDescriptionCap({ body: 1, description: 20 }), 50);
    assert.equal(effectiveDescriptionCap({ body: 1, description: 116 }), 116);
    assert.equal(effectiveDescriptionCap({ body: 1 }), 50);
  });

  test("at/below-50 description passes; above 50 fails for a non-grandfathered playbook", () => {
    const ok = compareAgainstBaseline(
      { [PB]: { body: 100, description: 50 } },
      baselineOf({ [PB]: { body: 100, description: 40 } }),
    );
    assert.deepEqual(ok.violations, []);

    const over = compareAgainstBaseline(
      { [PB]: { body: 100, description: 51 } },
      baselineOf({ [PB]: { body: 100, description: 40 } }),
    );
    assert.equal(over.violations.length, 1);
    assert.equal(over.violations[0].rule, "description-over-cap");
    assert.equal(over.violations[0].allowed, 50);
  });

  test("GRANDFATHER: over-50 baselined description may hold or shrink but not grow", () => {
    const base = baselineOf({ [PB]: { body: 100, description: 116 } });

    // Holding at the grandfathered count passes.
    const hold = compareAgainstBaseline({ [PB]: { body: 100, description: 116 } }, base);
    assert.deepEqual(hold.violations, []);

    // Shrinking below (even while still over 50) passes.
    const shrink = compareAgainstBaseline({ [PB]: { body: 100, description: 80 } }, base);
    assert.deepEqual(shrink.violations, []);

    // Growing past the grandfathered count fails at the baselined cap.
    const grow = compareAgainstBaseline({ [PB]: { body: 100, description: 120 } }, base);
    assert.equal(grow.violations.length, 1);
    assert.equal(grow.violations[0].rule, "description-over-cap");
    assert.equal(grow.violations[0].allowed, 116);
    assert.match(grow.violations[0].message, /grandfathered/);
  });

  test("a NEW playbook's description is hard-capped at 50 even while its missing baseline entry also fails", () => {
    const { violations } = compareAgainstBaseline(
      { [PB]: { body: 100, description: 60 } },
      baselineOf({}),
    );
    const rules = violations.map((v) => v.rule).sort();
    assert.deepEqual(rules, ["description-over-cap", "missing-baseline-entry"]);
    const cap = violations.find((v) => v.rule === "description-over-cap")!;
    assert.equal(cap.allowed, 50);
  });
});

describe("shared advice formatters + shrink hints (#5552)", () => {
  test("formatGrowthAdvice / formatStaleAdvice satisfy INV-2 / INV-3", async () => {
    const { formatGrowthAdvice, formatStaleAdvice } = await import("../scripts/ci/seam-check-lib.ts");
    const g = formatGrowthAdvice({ cmd: "npm run x -- --write-baseline", baselineRel: "b.json", rowKey: "count", fixVerb: "fix it", current: 7 });
    assertGrowthAdvice(g);
    assert.match(g, /Baseline-raise: b\.json count/);
    assertStaleAdvice(formatStaleAdvice({ baselineRel: "b.json", rowAction: "lower the row" }));
  });

  const shrunk = [
    { path: PB, current: 80, baseline: 100 },
    { path: FRAG, current: 5, baseline: 9 },
  ];

  test("in-diff row gets a hint; out-of-diff row gets none", () => {
    const lines = formatShrinkHints(shrunk, new Set([PB]));
    assert.equal(lines.length, 1);
    assert.match(lines[0], new RegExp(`hint: ${PB} row can drop 100 -> 80 in scripts/ci/skill-size-baseline.json`));
    assert.doesNotMatch(lines[0], /example-fragment/);
  });

  test("null diff set yields the single skipped line", () => {
    const lines = formatShrinkHints(shrunk, null, "origin/master: gone");
    assert.deepEqual(lines, [
      "[skill-size-ratchet] hint: diff base unresolvable (origin/master: gone) — shrink hints skipped",
    ]);
  });
});
