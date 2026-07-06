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
  splitFrontmatter,
  extractDescription,
  countWords,
  effectiveDescriptionCap,
  compareAgainstBaseline,
  DESCRIPTION_WORD_CAP,
} = await import("../scripts/ci/skill-size-ratchet.ts");

const PB = "docs/operator-playbooks/hydra-example.md";
const FRAG = "docs/operator-playbooks/_fragments/example-fragment.md";

function baselineOf(files: Record<string, { body: number; description?: number }>) {
  return { note: "synthetic baseline for tests", files };
}

describe("skill-size-ratchet: frontmatter split + description extraction", () => {
  test("splits frontmatter from body (sync-skills grammar)", () => {
    const { frontmatter, body } = splitFrontmatter(
      "---\nname: hydra-example\ndescription: Does a thing.\n---\n# Title\n\nBody text here.\n",
    );
    assert.ok(frontmatter !== null);
    assert.match(frontmatter!, /name: hydra-example/);
    assert.equal(body, "# Title\n\nBody text here.\n");
  });

  test("frontmatter-less doc returns null frontmatter (exempt, not an error)", () => {
    const { frontmatter, body } = splitFrontmatter("# Ollama Recovery\n\nProse.\n");
    assert.equal(frontmatter, null);
    assert.equal(body, "# Ollama Recovery\n\nProse.\n");
  });

  test("MALFORMED frontmatter (opens with --- but never closes) throws — fail loud", () => {
    assert.throws(
      () => splitFrontmatter("---\nname: truncated\n# no closing delimiter\n"),
      /malformed frontmatter/,
    );
  });

  test("extracts a quoted description and strips the quotes", () => {
    assert.equal(
      extractDescription('name: x\ndescription: "Quoted words here."\nclaude_only: true'),
      "Quoted words here.",
    );
  });

  test("extracts an unquoted description; absent description yields empty string", () => {
    assert.equal(extractDescription("description: Plain words."), "Plain words.");
    assert.equal(extractDescription("name: x\nwhen_to_use: whenever"), "");
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
    assert.match(violations[0].message, /--write-baseline/);
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
    assert.match(violations[0].message, /--write-baseline/);
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
    assert.match(violations[0].message, /prune/);
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
