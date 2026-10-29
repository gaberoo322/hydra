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
 * Detection rules live in scripts/ci/test-source-read-scan.ts; the trailing
 * describe pins them against synthetic sources.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  READ_KINDS,
  RULE_ID,
  checkReadRatchet,
  isCodePathLiteral,
  readsCodePath,
  scanTestReaders,
} from "../scripts/ci/test-source-read-scan.ts";
import type { ReadBaseline } from "../scripts/ci/test-source-read-scan.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = "test/fixtures/test-source-read-baseline.json";

describe("test-source-read ratchet (live tree)", () => {
  const baseline = JSON.parse(readFileSync(join(ROOT, BASELINE_PATH), "utf8")) as ReadBaseline;
  const readers = scanTestReaders(ROOT);
  const violations = checkReadRatchet(readers, baseline, (p) => existsSync(join(ROOT, p)));

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

  it("the kind set is closed", () => {
    assert.deepEqual([...READ_KINDS], ["drift-guard", "invariant-lint", "dashboard-pin", "behaviour", "grandfathered"]);
  });
});
