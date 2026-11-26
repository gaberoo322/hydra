/**
 * test-source-read-ratchet — STD-TEST-RUN-THE-CODE, mechanically (issue #5262).
 *
 * A test file that READS a code path (src/, scripts/, bin/, dashboard/src/, or
 * *.sh / *.py / *.mjs) must be listed in test/fixtures/test-source-read-baseline.json
 * under a sanctioned kind. A new code-reading test fails here until a reviewer
 * accepts a one-line fixture diff.
 *
 * Grandfathered rows only shrink. This test cannot see history (no git state, no
 * GITHUB_EVENT_PATH, no Redis, no network - the coupling #4132 removed), so that
 * half of the rule is the Standards reviewer's under STD-TEST-RUN-THE-CODE; what
 * is enforced here is that every row names a known kind, an existing file, and a
 * file that still reads a code path.
 *
 * Per-SITE pin counts (issue #5487): the fixture's `pins` rows are shrink-only per file
 * and counter; a new regex / substring / indexOf pin over a code or playbook read is an
 * added `pins` row and fails here. The verdict is scripts/ci/ratchet.ts's (issue #5652).
 *
 * Detection rules live in scripts/ci/test-source-read-scan.ts; the trailing
 * describe pins them against synthetic sources.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  READ_KINDS,
  advisoryPromptSites,
  isCodePathLiteral,
  pinRow,
  pinSitesOf,
  readerRow,
  readsCodePath,
  testSourceReadRatchet,
} from "../scripts/ci/test-source-read-scan.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = "test/fixtures/test-source-read-baseline.json";

describe("test-source-read ratchet (baseline fixture)", () => {
  it("the ratchet test lists itself as invariant-lint", () => {
    const rows = JSON.parse(readFileSync(join(ROOT, BASELINE_PATH), "utf8")) as Record<string, number>;
    assert.equal(rows[readerRow("test/test-source-read-ratchet.test.mts", "invariant-lint")], 1);
  });
});

describe("test-source-read ratchet (detection rules, synthetic sources)", () => {
  it("a file is a code reader only with BOTH an fs read and a code-path literal", () => {
    assert.equal(readsCodePath('readFileSync(join(ROOT, "src/a.ts"), "utf8")'), true);
    assert.equal(readsCodePath('readFileSync(join(ROOT, "docs/a.md"), "utf8")'), false);
    assert.equal(readsCodePath('const p = "src/a.ts";'), false);
    assert.equal(readsCodePath('readFileSync(p); const s = "run.sh";'), true);
    assert.equal(readsCodePath('readdirSync(join(ROOT, "src", "api"))'), true);
  });

  it("docs, config, .github, markdown and fixtures are never gated", () => {
    for (const p of ["docs/x.md", "config/a.json", ".github/workflows/ci.yml", "CLAUDE.md", "test/fixtures/a.json"]) {
      assert.equal(isCodePathLiteral(p), false, p);
    }
  });

  it("import statements and comments never count as reads", () => {
    const src = [
      'import { a } from "../src/a.ts";',
      'const b = await import("../src/b.ts");',
      '// readFileSync("src/c.ts")',
      'readFileSync("docs/x.md");',
    ].join("\n");
    assert.equal(readsCodePath(src), false);
  });

  it("a code pin site needs a subject bound from a code-path read (one-statement, one-hop const, inline)", () => {
    const bound = ['const src = readFileSync("src/a.ts", "utf8");', "assert.match(src, /x/);", 'assert.ok(src.includes("y"));'];
    assert.deepEqual(pinSitesOf(bound.join("\n")), { code: 2, prompt: 0 });
    const hop = ['const P = "scripts/x.sh";', "const s = readFileSync(join(ROOT, P), 'utf8');", "assert.ok(s.indexOf('a') < s.indexOf('b'));"];
    assert.deepEqual(pinSitesOf(hop.join("\n")), { code: 2, prompt: 0 });
    const inline = ['assert.ok(readFileSync("scripts/x.sh", "utf8").includes("z"));', 'assert.match(readFileSync("src/a.ts", "utf8"), /q/);'];
    assert.deepEqual(pinSitesOf(inline.join("\n")), { code: 2, prompt: 0 });
    const destructured = ['const s = readFileSync("src/a.ts", "utf8");', "match(s, /x/);", "doesNotMatch(s, /y/);", "assert.ok(/z/.test(s));"];
    assert.deepEqual(pinSitesOf(destructured.join("\n")), { code: 3, prompt: 0 });
  });

  it("reads of docs / fixtures, comments, helper returns and loop variables are not counted", () => {
    const docs = ['const d = readFileSync("docs/a.md", "utf8");', "assert.match(d, /x/);"];
    assert.deepEqual(pinSitesOf(docs.join("\n")), { code: 0, prompt: 0 });
    const fixture = ['const f = readFileSync("test/fixtures/a.json", "utf8");', "assert.match(f, /x/);"];
    assert.deepEqual(pinSitesOf(fixture.join("\n")), { code: 0, prompt: 0 });
    const comment = ['const s = readFileSync("src/a.ts", "utf8");', "// assert.match(s, /x/);"];
    assert.deepEqual(pinSitesOf(comment.join("\n")), { code: 0, prompt: 0 });
    const helper = ["const s = load();", "assert.match(s, /x/);", "for (const f of files) { const t = readFileSync(f, 'utf8'); assert.match(t, /y/); }"];
    assert.deepEqual(pinSitesOf(helper.join("\n")), { code: 0, prompt: 0 });
  });

  it("a read call and its assertion inside string literals are never counted (self-scan stability)", () => {
    const quoted = ["const text = '" + 'const s = readFileSync("src/a.ts"); assert.match(s, /x/);' + "';"];
    assert.deepEqual(pinSitesOf(quoted.join("\n")), { code: 0, prompt: 0 });
  });

  it("a prompt pin site is an indexOf or a step-number assertion over a playbook read; sentence pins are advisory", () => {
    const pb = ['const pb = readFileSync("docs/operator-playbooks/x.md", "utf8");', "assert.ok(pb.indexOf('a') < pb.indexOf('b'));", "assert.match(pb, /step 9b/i);", "assert.match(pb, /plain/);"];
    assert.deepEqual(pinSitesOf(pb.join("\n")), { code: 0, prompt: 3 });
    const sentence = ["const pb = readFileSync('SKILL.md', 'utf8');", "assert.ok(pb.includes('one two three four five six seven eight nine ten eleven twelve'));"];
    assert.deepEqual(pinSitesOf(sentence.join("\n")), { code: 0, prompt: 0 });
    assert.equal(advisoryPromptSites(sentence.join("\n")), 1);
  });

  it("the kind set is closed", () => {
    assert.deepEqual([...READ_KINDS], ["drift-guard", "invariant-lint", "dashboard-pin", "behaviour", "grandfathered"]);
  });
});

describe("test-source-read ratchet (measure against a tmp root, INV-3)", () => {
  const READER = 'import { readFileSync } from "node:fs";\nreadFileSync("src/a.ts");\n';
  const PINNED = `${READER}const s = readFileSync("src/a.ts", "utf8");\nassert.match(s, /x/);\n`;

  function treeWith(files: Record<string, string>, baseline: Record<string, number>): string {
    const root = mkdtempSync(join(tmpdir(), "source-read-"));
    mkdirSync(join(root, "test", "fixtures"), { recursive: true });
    for (const [name, src] of Object.entries(files)) writeFileSync(join(root, "test", name), src);
    writeFileSync(join(root, BASELINE_PATH), `${JSON.stringify(baseline)}\n`);
    return root;
  }
  async function verdictFor(files: Record<string, string>, baseline: Record<string, number>) {
    const root = treeWith(files, baseline);
    try {
      return await testSourceReadRatchet.verdict(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("a listed reader keeps its baseline kind; an unlisted reader is an added behaviour row", async () => {
    const ok = await verdictFor({ "a.test.mts": READER }, { [readerRow("test/a.test.mts", "drift-guard")]: 1 });
    assert.equal(ok.ok, true, ok.advice);
    const added = await verdictFor({ "a.test.mts": READER }, {});
    assert.deepEqual(added.added, [readerRow("test/a.test.mts", "behaviour")]);
    assert.match(added.advice, /--write-baseline --allow-grow/);
  });

  it("a row whose file stopped reading code, or vanished, is stale and only hints", async () => {
    const v = await verdictFor(
      { "a.test.mts": "export {};\n" },
      { [readerRow("test/a.test.mts", "behaviour")]: 1, [readerRow("test/gone.test.mts", "behaviour")]: 1 },
    );
    assert.equal(v.ok, true, v.advice);
    assert.deepEqual(v.stale, [readerRow("test/a.test.mts", "behaviour"), readerRow("test/gone.test.mts", "behaviour")]);
  });

  it("an unknown kind is stale and its corrected behaviour row is added", async () => {
    const v = await verdictFor({ "a.test.mts": READER }, { [readerRow("test/a.test.mts", "nope")]: 1 });
    assert.deepEqual(v.stale, [readerRow("test/a.test.mts", "nope")]);
    assert.deepEqual(v.added, [readerRow("test/a.test.mts", "behaviour")]);
  });

  it("a new pin site is an added pins row; a removed pin site is stale", async () => {
    const kind = { [readerRow("test/a.test.mts", "behaviour")]: 1 };
    const grew = await verdictFor({ "a.test.mts": PINNED }, kind);
    assert.deepEqual(grew.added, [pinRow("test/a.test.mts", "code")]);
    const shrank = await verdictFor({ "a.test.mts": READER }, { ...kind, [pinRow("test/a.test.mts", "code")]: 1 });
    assert.deepEqual(shrank.stale, [pinRow("test/a.test.mts", "code")]);
    assert.equal(shrank.ok, true, shrank.advice);
  });
});
