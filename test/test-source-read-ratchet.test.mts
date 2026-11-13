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
 * Per-SITE pin counts (issue #5487): the fixture's `pinSites` map is shrink-only per file
 * and counter; a new regex / substring / indexOf pin over a code or playbook read fails
 * here as `pin-count-grew`.
 *
 * Detection rules live in scripts/ci/test-source-read-scan.ts; the trailing
 * describe pins them against synthetic sources.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROMPT_RULE_ID,
  READ_KINDS,
  RULE_ID,
  advisoryPromptSites,
  checkReadRatchet,
  isCodePathLiteral,
  pinSitesOf,
  readsCodePath,
  scanPinSites,
  scanTestReaders,
} from "../scripts/ci/test-source-read-scan.ts";
import type { ReadBaseline } from "../scripts/ci/test-source-read-scan.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = "test/fixtures/test-source-read-baseline.json";

describe("test-source-read ratchet (live tree)", () => {
  const baseline = JSON.parse(readFileSync(join(ROOT, BASELINE_PATH), "utf8")) as ReadBaseline;
  const readers = scanTestReaders(ROOT);
  const violations = checkReadRatchet(readers, baseline, (p) => existsSync(join(ROOT, p)), scanPinSites(ROOT));

  it("every code-reading test file is listed under a sanctioned kind, and no row is stale", () => {
    assert.deepEqual(
      violations.map((v) => v.message),
      [],
      `Fix per message above; rule ${RULE_ID}`,
    );
  });

  it("the ratchet test lists itself as invariant-lint", () => {
    assert.equal(baseline.files["test/test-source-read-ratchet.test.mts"], "invariant-lint");
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

  it("an unlisted reader, an unknown kind and stale rows are each reported with the rule id", () => {
    const v = checkReadRatchet(
      ["test/new.test.mts"],
      { files: { "test/gone.test.mts": "grandfathered", "test/bad.test.mts": "nope", "test/nolonger.test.mts": "behaviour" } },
      (p) => p !== "test/gone.test.mts",
    );
    const byCode = new Map(v.map((x) => [x.code + ":" + x.file, x.message]));
    assert.match(byCode.get("unlisted-reader:test/new.test.mts") ?? "", /"test\/new\.test\.mts": "behaviour"/);
    assert.match(byCode.get("unlisted-reader:test/new.test.mts") ?? "", new RegExp(RULE_ID));
    assert.ok(byCode.has("unknown-kind:test/bad.test.mts"));
    assert.ok(byCode.has("stale-missing-file:test/gone.test.mts"));
    assert.ok(byCode.has("stale-no-longer-reads:test/nolonger.test.mts"));
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

  it("pin counts are shrink-only per (file, counter): grew and stale name the rule and the command", () => {
    const baseline: ReadBaseline = { files: {}, pinSites: { "test/a.test.mts": { code: 2, prompt: 1 }, "test/gone.test.mts": { code: 1 } } };
    const v = checkReadRatchet(
      [],
      baseline,
      () => true,
      { "test/a.test.mts": { code: 3, prompt: 0 }, "test/new.test.mts": { code: 0, prompt: 1 } },
    );
    const grew = v.filter((x) => x.code === "pin-count-grew");
    const stale = v.filter((x) => x.code === "pin-count-stale");
    assert.deepEqual(grew.map((x) => x.file).sort(), ["test/a.test.mts", "test/new.test.mts"]);
    assert.match(grew.find((x) => x.file === "test/a.test.mts")?.message ?? "", new RegExp(RULE_ID));
    assert.match(grew.find((x) => x.file === "test/new.test.mts")?.message ?? "", new RegExp(PROMPT_RULE_ID));
    assert.deepEqual(stale.map((x) => x.file).sort(), ["test/a.test.mts", "test/gone.test.mts"]);
    assert.ok(stale.every((x) => x.message.includes("--write-baseline")));
    assert.deepEqual(checkReadRatchet([], baseline, () => true, { "test/a.test.mts": { code: 2, prompt: 1 }, "test/gone.test.mts": { code: 1, prompt: 0 } }), []);
  });

  it("the kind set is closed", () => {
    assert.deepEqual([...READ_KINDS], ["drift-guard", "invariant-lint", "dashboard-pin", "behaviour", "grandfathered"]);
  });
});
