/**
 * Drift guard: the four sibling advisory workflows never swallow a tool exit
 * (issue #5701, follow-up of #5640). A tool that did not RUN is a red step; a
 * tool that ran and reported findings keeps its advisory contract.
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const wf = (name: string): string => readFileSync(join(root, `.github/workflows/${name}.yml`), "utf8");

const WORKFLOWS: Array<{ name: string; marker: string }> = [
  { name: "audit-nightly", marker: 'gh label create "$MARKER"' },
  { name: "deps-check", marker: "npx --yes taze@19" },
  { name: "osv-scan", marker: "bash scripts/osv-scan.sh" },
  { name: "stryker-check", marker: "npm run stryker:scan ||" },
];

describe("advisory workflows fail loud", () => {
  for (const { name, marker } of WORKFLOWS) {
    const text = wf(name);

    test(`${name}.yml has no swallowed || true anywhere`, () => {
      assert.equal(text.split("\n").filter((l) => /\|\| *true/.test(l)).length, 0);
    });

    test(`${name}.yml captures the tool exit and routes a failure to ::error + exit 1`, () => {
      const i = text.indexOf(marker);
      assert.ok(i > 0, `${marker} present`);
      const step = text.slice(i - 200, i + 1200);
      assert.match(step, /\|\| rc=\$\?/);
      assert.match(step, new RegExp(`::error title=${name}::[^\\n]*\\$rc`));
      assert.match(step, /exit 1/);
    });
  }

  test("audit-nightly run steps use errexit", () => {
    const text = wf("audit-nightly");
    assert.ok(!/set -uo pipefail/.test(text));
    assert.equal(text.split("set -euo pipefail").length - 1, 2);
  });

  test("osv-scan classifies on a parseable results object", () => {
    assert.match(wf("osv-scan"), /jq -e 'type == "object" and has\("results"\)'/);
  });
});
