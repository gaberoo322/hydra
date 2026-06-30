/**
 * Regression tests for `scripts/hydra/footer.sh` (issue #2556).
 *
 * The `Source: <skill> | <ISO ts>` gh-issue provenance footer was hand-copied
 * across hydra-incident / hydra-research / hydra-discover (x3) /
 * hydra-target-discover. Downstream parsers (classes.json provenance labels,
 * retro/reconciler footer matching) split on the exact `Source: <skill> |`
 * shape, so the extracted helper MUST emit a byte-identical line. These tests
 * pin that contract: the prefix/suffix shape is exact, only the timestamp
 * varies.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "hydra", "footer.sh");

// RFC3339 UTC, second precision, no fractional/offset — matches
// `date -u +%Y-%m-%dT%H:%M:%SZ`, the exact format the inline footers used.
const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function run(args: string[]): { code: number; out: string } {
  const r = spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8" });
  assert.equal(r.error, undefined, `spawn error: ${r.error}`);
  return { code: r.status ?? -1, out: r.stdout };
}

describe("footer.sh — plain form (incident/research/target-discover)", () => {
  test("emits 'Source: <skill> | <ISO ts>' with no parenthetical", () => {
    const { code, out } = run(["hydra-incident"]);
    assert.equal(code, 0);
    const line = out.trimEnd();
    const m = line.match(/^Source: (\S+) \| (.+)$/);
    assert.ok(m, `unexpected footer shape: ${JSON.stringify(line)}`);
    assert.equal(m![1], "hydra-incident");
    assert.match(m![2], ISO_Z);
  });

  test("does not insert a parenthetical when no suffix is given", () => {
    const { out } = run(["hydra-research"]);
    assert.doesNotMatch(out, /\(/);
    assert.match(out.trimEnd(), /^Source: hydra-research \| /);
  });

  test("emits exactly one line (single trailing newline)", () => {
    const { out } = run(["hydra-target-discover"]);
    assert.equal(out.split("\n").filter((l) => l.length > 0).length, 1);
    assert.ok(out.endsWith("\n"));
  });
});

describe("footer.sh — suffix form (discover family)", () => {
  test("renders the suffix as ' (suffix)' before the pipe", () => {
    const { code, out } = run(["hydra-discover", "tier N"]);
    assert.equal(code, 0);
    const line = out.trimEnd();
    const m = line.match(/^Source: (\S+) \((.+)\) \| (.+)$/);
    assert.ok(m, `unexpected footer shape: ${JSON.stringify(line)}`);
    assert.equal(m![1], "hydra-discover");
    assert.equal(m![2], "tier N");
    assert.match(m![3], ISO_Z);
  });

  test("byte-matches the historical hand-written discover footer prefix", () => {
    const { out } = run(["hydra-discover", "tier N"]);
    assert.match(out.trimEnd(), /^Source: hydra-discover \(tier N\) \| /);
  });
});
