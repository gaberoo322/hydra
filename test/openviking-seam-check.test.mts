/**
 * test/openviking-seam-check.test.mts — pin the OpenViking Request Adapter
 * seam-check grammar at the predicate level (no git scan, no process.exit),
 * issue #954.
 *
 * The CI gate at scripts/ci/openviking-seam-check.ts forbids a raw OpenViking
 * `fetch(...)` from any file outside `src/knowledge-base/ov-request.ts` (the
 * adapter Module itself). An "OpenViking fetch" is a `fetch(` whose line carries
 * an unambiguous OV signal (an `/api/v1/...` path or one of the OV base-URL
 * identifiers). The non-OV health probes (vikingdb on localhost:5000, the
 * generic `probe(url)` helper) must NOT trip it. Fourth boundary Seam, sibling
 * to github-seam-check / host-probe-seam-check.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { fileViolatesOpenVikingSeam } = await import(
  "../scripts/ci/openviking-seam-check.ts"
);

describe("openviking-seam-check: OV fetch grammar", () => {
  test("flags a fetch to an /api/v1 OpenViking path outside the adapter", () => {
    assert.equal(
      fileViolatesOpenVikingSeam(
        "src/api/openviking.ts",
        `const r = await fetch(\`\${ovUrl}/api/v1/search/find\`, { method: "POST" });`,
      ),
      true,
    );
  });

  test("flags a fetch built from an OV base-URL identifier", () => {
    assert.equal(
      fileViolatesOpenVikingSeam(
        "src/redis/work-queue.ts",
        `await fetch(\`\${OV_DEDUP_URL}/api/v1/resources\`, {});`,
      ),
      true,
    );
    assert.equal(
      fileViolatesOpenVikingSeam(
        "src/foo.ts",
        `await fetch(\`\${OPENVIKING_URL}/health\`);`,
      ),
      true,
    );
  });

  test("does NOT flag a non-OV health probe (vikingdb / generic probe)", () => {
    assert.equal(
      fileViolatesOpenVikingSeam(
        "src/api/health.ts",
        `const r = await fetch("http://localhost:5000/health", { signal });`,
      ),
      false,
    );
    assert.equal(
      fileViolatesOpenVikingSeam(
        "src/aggregators/service-strip.ts",
        `const r = await fetch(url, { signal: controller.signal });`,
      ),
      false,
    );
  });

  test("does NOT flag a file that routes through the adapter accessors", () => {
    assert.equal(
      fileViolatesOpenVikingSeam(
        "src/knowledge-base/ov-search.ts",
        `const result = await ovPostJson("/api/v1/search/find", body, { timeout: 5000 });`,
      ),
      false,
    );
  });
});

describe("openviking-seam-check: carve-out", () => {
  test("exempts the OpenViking Request Adapter Module itself", () => {
    assert.equal(
      fileViolatesOpenVikingSeam(
        "src/knowledge-base/ov-request.ts",
        `res = await fetch(url, { method: init.method ?? "GET" });`,
      ),
      false,
    );
  });
});
