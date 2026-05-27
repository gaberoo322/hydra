/**
 * Regression tests for the backlog-flow aggregator (issue #620, PRD #615).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  getBacklogFlow,
  classFromLabels,
  bucketByClass,
  clampWindowDays,
  iso8601DateOnly,
  parseRawIssues,
} from "../src/aggregators/backlog-flow.ts";

const NOW = new Date("2026-05-26T12:00:00.000Z");

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("classFromLabels", () => {
  test("returns the known class label", () => {
    assert.equal(classFromLabels(["dev_orch", "ready-for-agent"]), "dev_orch");
  });
  test("returns 'unclassified' when no known label is present", () => {
    assert.equal(classFromLabels(["bug", "needs-info"]), "unclassified");
  });
  test("returns 'unclassified' on empty labels", () => {
    assert.equal(classFromLabels([]), "unclassified");
  });
  test("first matching label wins", () => {
    assert.equal(classFromLabels(["qa", "dev_orch"]), "qa");
  });
});

describe("bucketByClass", () => {
  test("tallies into one row per class", () => {
    const added = [
      { number: 1, labels: ["dev_orch"] },
      { number: 2, labels: ["dev_orch"] },
      { number: 3, labels: ["qa"] },
    ];
    const closed = [{ number: 4, labels: ["dev_orch"] }];
    const blocked = [{ number: 5, labels: ["dev_target"] }];
    const rows = bucketByClass(added, closed, blocked);
    const dev_orch = rows.find((r) => r.class === "dev_orch");
    assert.deepEqual(dev_orch, { class: "dev_orch", added: 2, closed: 1, blocked: 0 });
    const qa = rows.find((r) => r.class === "qa");
    assert.deepEqual(qa, { class: "qa", added: 1, closed: 0, blocked: 0 });
    const dev_target = rows.find((r) => r.class === "dev_target");
    assert.deepEqual(dev_target, { class: "dev_target", added: 0, closed: 0, blocked: 1 });
  });

  test("unclassified bucket collects unlabelled issues", () => {
    const rows = bucketByClass(
      [{ number: 1, labels: [] }, { number: 2, labels: ["bug"] }],
      [],
      [],
    );
    const unc = rows.find((r) => r.class === "unclassified");
    assert.equal(unc?.added, 2);
  });

  test("rows sorted by total descending", () => {
    const added = [
      { number: 1, labels: ["qa"] },
      { number: 2, labels: ["dev_orch"] },
      { number: 3, labels: ["dev_orch"] },
      { number: 4, labels: ["dev_orch"] },
    ];
    const rows = bucketByClass(added, [], []);
    assert.equal(rows[0].class, "dev_orch");
  });
});

describe("clampWindowDays", () => {
  test("default for non-finite", () => {
    assert.equal(clampWindowDays(NaN), 7);
  });
  test("clamps to 1 below", () => {
    assert.equal(clampWindowDays(0), 1);
  });
  test("clamps to 30 above", () => {
    assert.equal(clampWindowDays(365), 30);
  });
});

describe("iso8601DateOnly", () => {
  test("strips the time portion", () => {
    assert.equal(iso8601DateOnly(new Date("2026-05-26T12:34:56.000Z")), "2026-05-26");
  });
});

describe("parseRawIssues", () => {
  test("returns [] on empty / non-array", () => {
    assert.deepEqual(parseRawIssues(""), []);
    assert.deepEqual(parseRawIssues("not-json"), []);
  });
  test("extracts label name strings", () => {
    const out = parseRawIssues(
      JSON.stringify([{ number: 1, labels: [{ name: "qa" }, { name: "ready-for-agent" }] }]),
    );
    assert.deepEqual(out[0].labels, ["qa", "ready-for-agent"]);
  });
});

// ---------------------------------------------------------------------------
// Integration shape
// ---------------------------------------------------------------------------

describe("getBacklogFlow — happy path", () => {
  test("invokes the three sub-sources and bundles per-class totals", async () => {
    const addedStdout = JSON.stringify([
      { number: 1, labels: [{ name: "dev_orch" }] },
      { number: 2, labels: [{ name: "qa" }] },
    ]);
    const closedStdout = JSON.stringify([
      { number: 3, labels: [{ name: "dev_orch" }] },
    ]);
    const blockedStdout = JSON.stringify([
      { number: 4, labels: [{ name: "dev_target" }, { name: "blocked" }] },
    ]);

    const exec = async (cmd: string, args: readonly string[]) => {
      const key = `${cmd} ${args.join(" ")}`;
      if (key.includes("issue list") && key.includes("created:>=")) {
        return { stdout: addedStdout, stderr: "" };
      }
      if (key.includes("issue list") && key.includes("closed:>=")) {
        return { stdout: closedStdout, stderr: "" };
      }
      if (key.includes("issue list") && key.includes("--label blocked")) {
        return { stdout: blockedStdout, stderr: "" };
      }
      throw new Error("unstubbed: " + key);
    };

    const result = await getBacklogFlow(7, { now: NOW, execFileAsync: exec });
    assert.equal(result.windowDays, 7);
    assert.equal(result.totals.added, 2);
    assert.equal(result.totals.closed, 1);
    assert.equal(result.totals.blocked, 1);
    const dev_orch = result.byClass.find((r) => r.class === "dev_orch");
    assert.equal(dev_orch?.added, 1);
    assert.equal(dev_orch?.closed, 1);
  });
});

describe("getBacklogFlow — sub-source failure isolation", () => {
  test("when one source fails, other columns still ship", async () => {
    const exec = async (cmd: string, args: readonly string[]) => {
      const key = `${cmd} ${args.join(" ")}`;
      if (key.includes("created:>=")) throw new Error("added broken");
      if (key.includes("closed:>=")) {
        return {
          stdout: JSON.stringify([{ number: 1, labels: [{ name: "qa" }] }]),
          stderr: "",
        };
      }
      return { stdout: JSON.stringify([]), stderr: "" };
    };
    const result = await getBacklogFlow(7, { now: NOW, execFileAsync: exec });
    assert.equal(result.totals.added, 0);
    assert.equal(result.totals.closed, 1);
  });
});
