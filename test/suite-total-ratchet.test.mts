/**
 * The suite-total floor ratchet (#5777, ADR-0038 Decision 2 amendment): the
 * scanned top-level total must stay at or above the committed floor, and a PR
 * that only adds tests never has to edit it. No Redis, pure filesystem.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suiteTotalRatchet } from "../scripts/ci/suite-total-ratchet.ts";

describe("suite-total floor ratchet (#5777)", () => {
  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  /** A temp checkout with `n` single-test files and a floor fixture of `floor`. */
  function fixtureRoot(n: number, floor: number): string {
    const root = mkdtempSync(join(tmpdir(), "suite-total-"));
    dirs.push(root);
    mkdirSync(join(root, "test", "fixtures"), { recursive: true });
    for (let i = 0; i < n; i++) {
      writeFileSync(join(root, "test", `f${i}.test.mts`), `test("t", () => {});\n`);
    }
    writeFileSync(
      join(root, "test/fixtures/suite-total-baseline.json"),
      JSON.stringify({ "test/*.test.mts": floor }),
    );
    return root;
  }

  test("a total below the floor fails and names the floor file", async () => {
    const v = await suiteTotalRatchet.verdict(fixtureRoot(2, 3));
    assert.equal(v.ok, false);
    assert.match(v.advice, /test\/fixtures\/suite-total-baseline\.json/);
  });

  test("a total above the floor passes without editing it (hint only)", async () => {
    const v = await suiteTotalRatchet.verdict(fixtureRoot(3, 2));
    assert.equal(v.ok, true);
  });
});
