/**
 * test/skill-size-ratchet.test.mts — pin the skill-size ratchet's measurement
 * (issue #2946, Ratchet module #5654): frontmatter split + description
 * extraction, whitespace word count, and the flattened counted rows the policy
 * hands to the Ratchet (`<path>` body, `<path>/description` only over 50).
 *
 * Verdict wording and the shrink-only compare are pinned once in
 * test/ratchet.test.mts; here synthetic skill trees run through
 * `verdict(tmpRoot)`. The last case runs the real ratchet over the real
 * playbooks and the committed baseline: that is the gate, enforced by the
 * required `test` job (#5631).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  measureSkillSource,
  countWords,
  measureSkillSources,
  skillSizeRatchet,
  DESCRIPTION_WORD_CAP,
} = await import("../scripts/ci/skill-size-ratchet.ts");

const PB = "docs/operator-playbooks/hydra-example.md";
const FRAG = "docs/operator-playbooks/_fragments/example-fragment.md";

const words = (n: number): string => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

/** A synthetic repo root holding the given files plus a baseline. */
function tree(files: Record<string, string>, baseline: Record<string, number>): { root: string; done(): void } {
  const root = mkdtempSync(join(tmpdir(), "skill-size-"));
  mkdirSync(join(root, "docs/operator-playbooks/_fragments"), { recursive: true });
  mkdirSync(join(root, "scripts/ci"), { recursive: true });
  for (const [rel, text] of Object.entries(files)) writeFileSync(join(root, rel), text);
  writeFileSync(join(root, "scripts/ci/skill-size-baseline.json"), JSON.stringify(baseline));
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

const playbook = (description: number, body: number): string =>
  `---\nname: hydra-example\ndescription: ${words(description)}\n---\n${words(body)}\n`;

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

describe("skill-size-ratchet: flattened counted rows", () => {
  test("one body row per source; a description at or under the cap emits no row", async () => {
    assert.equal(DESCRIPTION_WORD_CAP, 50);
    const t = tree({ [PB]: playbook(50, 7), [FRAG]: words(4) }, { [PB]: 7, [FRAG]: 4 });
    try {
      assert.deepEqual(Object.keys(await measureSkillSources(t.root)).sort(), [FRAG, PB]);
      const v = await skillSizeRatchet.verdict(t.root);
      assert.equal(v.ok, true, v.advice);
      assert.deepEqual(v.added, []);
      assert.equal(v.measured, 11);
    } finally {
      t.done();
    }
  });

  test("a description over 50 words is a new row and fails as growth", async () => {
    const t = tree({ [PB]: playbook(51, 7) }, { [PB]: 7 });
    try {
      const v = await skillSizeRatchet.verdict(t.root);
      assert.equal(v.ok, false);
      assert.deepEqual(v.added, [`${PB}/description`]);
    } finally {
      t.done();
    }
  });

  test("body growth past the row fails; a new skill source with no row fails", async () => {
    const t = tree({ [PB]: playbook(5, 9), [FRAG]: words(3) }, { [PB]: 7 });
    try {
      const v = await skillSizeRatchet.verdict(t.root);
      assert.equal(v.ok, false);
      assert.deepEqual(v.added, [FRAG, PB]);
    } finally {
      t.done();
    }
  });

  test("a shrunken body and a vanished file are hints, not failures", async () => {
    const t = tree({ [PB]: playbook(5, 5) }, { [PB]: 7, [FRAG]: 4 });
    try {
      const v = await skillSizeRatchet.verdict(t.root);
      assert.equal(v.ok, true, v.advice);
      assert.deepEqual(v.stale, [FRAG, PB]);
    } finally {
      t.done();
    }
  });

  test("malformed frontmatter surfaces as a crashed verdict naming the file", async () => {
    const t = tree({ [PB]: "---\nname: truncated\nno closing delimiter\n" }, {});
    try {
      const v = await skillSizeRatchet.verdict(t.root);
      assert.equal(v.ok, false);
      assert.equal(v.crashed, true);
      assert.match(v.advice, /hydra-example\.md: malformed frontmatter/);
    } finally {
      t.done();
    }
  });

  test("frontmatter-less docs and README.md are exempt", async () => {
    const t = tree(
      { [PB]: playbook(5, 3), "docs/operator-playbooks/README.md": words(9), "docs/operator-playbooks/stub.md": "# stub\n" },
      { [PB]: 3 },
    );
    try {
      assert.deepEqual(Object.keys(await measureSkillSources(t.root)), [PB]);
    } finally {
      t.done();
    }
  });
});

describe("skill-size-ratchet: the real playbooks", () => {
  test("no playbook or fragment grows past its baselined row, and every description is within cap", async () => {
    const v = await skillSizeRatchet.verdict();
    assert.ok(v.ok, v.advice);
  });
});
