/**
 * test/headroom-eval-preservation.test.mts — pins the Headroom spike's golden
 * eval against being weakened (issue #4769).
 *
 * `evals/headroom-tap-preservation.yaml` runs only in the ADVISORY eval-gate, so
 * nothing in the required `test` job would notice someone loosening it to make a
 * red NO-GO result green. This suite reads the YAML as text (no YAML parser is a
 * runtime dependency — ADR-0005) and fails if the offline provider, the
 * control/compressed test pair, or the failing-test-name assertions disappear.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const evalPath = new URL("../evals/headroom-tap-preservation.yaml", import.meta.url);
const yaml = readFileSync(evalPath, "utf8");

describe("headroom TAP-preservation eval", () => {
  it("stays offline on the echo provider", () => {
    assert.match(yaml, /^providers:\s*\n\s*- id: echo\s*$/m);
    assert.doesNotMatch(yaml, /anthropic:|openai:|exec:/);
  });

  it("keeps a CONTROL and a COMPRESSED case", () => {
    assert.match(yaml, /- description: CONTROL/);
    assert.match(yaml, /- description: COMPRESSED/);
  });

  it("is never weakened: both cases assert the not-ok line and the failing test name", () => {
    const compressed = yaml.slice(yaml.indexOf("- description: COMPRESSED"));
    for (const section of [yaml.slice(0, yaml.indexOf("- description: COMPRESSED")), compressed]) {
      assert.ok(
        section.includes(
          'value: "not ok 300 - planted-failing-test-4769 detects the planted regression"',
        ),
        "not ok assertion missing",
      );
      assert.ok(
        section.includes(
          'value: "# Subtest: planted-failing-test-4769 detects the planted regression"',
        ),
        "# Subtest assertion missing",
      );
    }
    // No negated or lenient assertion type may creep in.
    assert.doesNotMatch(yaml, /type: (not-contains|icontains|llm-rubric|similar)/);
  });
});
