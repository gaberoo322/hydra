/**
 * test/anthropic-seam-check.test.mts — pin the Anthropic Request Adapter
 * seam-check grammar at the predicate level (no git scan, no process.exit),
 * issue #1959.
 *
 * The CI gate at scripts/ci/anthropic-seam-check.ts forbids a raw Anthropic
 * `fetch(...)` from any file outside `src/anthropic/request.ts` (the adapter
 * Module itself). An "Anthropic fetch" is a `fetch(` whose line carries an
 * unambiguous Anthropic signal (the `api.anthropic.com` host or the
 * `ANTHROPIC_MESSAGES_URL` identifier). Unrelated fetches (OpenViking,
 * OAuth-usage, health probes) must NOT trip it. Sixth boundary Seam, sibling to
 * openviking-seam-check / host-probe-seam-check.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { fileViolatesAnthropicSeam } = await import(
  "../scripts/ci/anthropic-seam-check.ts"
);

describe("anthropic-seam-check: Anthropic fetch grammar", () => {
  test("flags a fetch to the Anthropic API host outside the adapter", () => {
    assert.equal(
      fileViolatesAnthropicSeam(
        "src/autopilot/recommendation-engine.ts",
        `const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST" });`,
      ),
      true,
    );
  });

  test("flags a fetch built from the ANTHROPIC_MESSAGES_URL identifier", () => {
    assert.equal(
      fileViolatesAnthropicSeam(
        "src/foo.ts",
        `await fetch(ANTHROPIC_MESSAGES_URL, { headers });`,
      ),
      true,
    );
  });

  test("does NOT flag an unrelated fetch (OpenViking / generic probe)", () => {
    assert.equal(
      fileViolatesAnthropicSeam(
        "src/knowledge-base/ov-request.ts",
        `res = await fetch(url, { method: init.method ?? "GET" });`,
      ),
      false,
    );
    assert.equal(
      fileViolatesAnthropicSeam(
        "src/api/health.ts",
        `const r = await fetch("http://localhost:5000/health", { signal });`,
      ),
      false,
    );
  });

  test("does NOT flag a file that routes through the adapter accessor", () => {
    assert.equal(
      fileViolatesAnthropicSeam(
        "src/autopilot/recommendation-engine.ts",
        `const result = await anthropicMessages(body, { apiKey, costRates });`,
      ),
      false,
    );
  });
});

describe("anthropic-seam-check: carve-out", () => {
  test("exempts the Anthropic Request Adapter Module itself", () => {
    assert.equal(
      fileViolatesAnthropicSeam(
        "src/anthropic/request.ts",
        `res = await fetchImpl(ANTHROPIC_MESSAGES_URL, { method: "POST" });`,
      ),
      false,
    );
  });
});
