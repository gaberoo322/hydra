/**
 * Isolated unit coverage for the read-only label-inventory seam sibling
 * (`src/github/labels.ts`, issue #4363).
 *
 * The GLM eligibility sweep's vocabulary preflight (issue #4363, INV-1/2/8)
 * consumes `listRepoLabels` to confirm its write vocabulary (`glm-eligible`,
 * `glm-ab-control`) actually exists on the repo before committing to a tick.
 * These cases pin the argv the seam assembles (in particular the `--limit`
 * floor from INV-8 — a default `gh label list` page is 30 rows, which would
 * silently omit `glm-*` labels on a 51-label repo), the parse of a `gh label
 * list --json name` payload into a flat name list, the never-throw failure
 * mapping, and the empty-repo skip-guard shared with the rest of the read
 * seam (`issues.ts`, `prs.ts`).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  listRepoLabels,
  isListRepoLabelsFailure,
  DEFAULT_LABEL_LIMIT,
  type LabelListTransport,
} from "../src/github/labels.ts";

describe("github/labels — listRepoLabels argv (issue #4363 INV-8)", () => {
  test("assembles `gh label list --repo <repo> --json name --limit <n>` against the resolved repo", async () => {
    const calls: string[][] = [];
    const transport: LabelListTransport = async (args) => {
      calls.push(args);
      return { ok: true, data: [{ name: "glm-eligible" }, { name: "glm-ab-control" }] };
    };

    const result = await listRepoLabels({ repo: "gaberoo322/hydra", transport });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], [
      "label",
      "list",
      "--repo",
      "gaberoo322/hydra",
      "--json",
      "name",
      "--limit",
      String(DEFAULT_LABEL_LIMIT),
    ]);
  });

  test("the default limit is >= 200 (issue #4363 INV-8: gh's own default page is 30, too small for a 51-label repo)", () => {
    assert.ok(
      DEFAULT_LABEL_LIMIT >= 200,
      `DEFAULT_LABEL_LIMIT (${DEFAULT_LABEL_LIMIT}) must stay >= 200`,
    );
  });

  test("a caller-supplied limit overrides the default but still appears as a numeric --limit arg", async () => {
    const calls: string[][] = [];
    const transport: LabelListTransport = async (args) => {
      calls.push(args);
      return { ok: true, data: [] };
    };

    await listRepoLabels({ repo: "gaberoo322/hydra", transport, limit: 300 });

    assert.deepEqual(calls[0].slice(-2), ["--limit", "300"]);
  });
});

describe("github/labels — listRepoLabels parsing + never-throw (issue #4363)", () => {
  test("flattens a `gh label list --json name` payload to a plain string array", async () => {
    const result = await listRepoLabels({
      repo: "gaberoo322/hydra",
      transport: async () => ({
        ok: true,
        data: [{ name: "glm-eligible" }, { name: "glm-ab-control" }, { name: "glm-withhold" }],
      }),
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.labels, ["glm-eligible", "glm-ab-control", "glm-withhold"]);
    }
  });

  test("drops malformed rows (missing/non-string name) rather than throwing", async () => {
    const result = await listRepoLabels({
      repo: "gaberoo322/hydra",
      transport: async () =>
        ({
          ok: true,
          data: [{ name: "glm-eligible" }, {}, { name: 42 }, { name: "glm-withhold" }],
        }) as any,
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.labels, ["glm-eligible", "glm-withhold"]);
    }
  });

  test("a non-array payload degrades to an empty label list, not a throw", async () => {
    const result = await listRepoLabels({
      repo: "gaberoo322/hydra",
      transport: async () => ({ ok: true, data: null }) as any,
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.labels, []);
    }
  });

  test("propagates a transport failure as the discriminated failure arm, never throws", async () => {
    const result = await listRepoLabels({
      repo: "gaberoo322/hydra",
      transport: async () => ({ ok: false, code: "gh-failed", stderr: "HTTP 500" }),
    });

    assert.equal(isListRepoLabelsFailure(result), true);
    if (isListRepoLabelsFailure(result)) {
      assert.equal(result.code, "gh-failed");
    }
  });

  test("an empty resolved repo short-circuits to ok:true with an empty label list, without calling the transport", async () => {
    let calls = 0;
    const result = await listRepoLabels({
      repo: "",
      transport: async () => {
        calls++;
        return { ok: true, data: [] };
      },
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.labels, []);
    }
    assert.equal(calls, 0, "the empty-repo skip-guard never reaches the transport");
  });
});
