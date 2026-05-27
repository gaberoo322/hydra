/**
 * Regression tests for the decision-queue aggregator (issue #617, PRD #615).
 *
 * Tests the pure aggregator with full dependency injection — no subprocesses,
 * no GitHub round-trips. Pure helpers (`mergeDecisionItems`,
 * `extractIssueRefs`, `parseDigestSearchOutput`, `parseLabeledIssuesOutput`,
 * `datedTitle`) are tested directly; integration shape is tested with an
 * exec stub that routes by command prefix.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  getDecisionQueue,
  mergeDecisionItems,
  extractIssueRefs,
  parseDigestSearchOutput,
  parseLabeledIssuesOutput,
  datedTitle,
} from "../src/aggregators/decision-queue.ts";

const NOW = new Date("2026-05-26T12:00:00.000Z");

function makeExecStub(routes: Record<string, { stdout: string; stderr?: string }>) {
  return async (cmd: string, args: readonly string[]) => {
    const key = `${cmd} ${args.join(" ")}`;
    for (const prefix of Object.keys(routes)) {
      if (key.includes(prefix)) {
        return { stdout: routes[prefix].stdout, stderr: routes[prefix].stderr ?? "" };
      }
    }
    throw new Error(`exec-stub: no route for "${key}"`);
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("datedTitle — pure helper", () => {
  test("formats YYYY-MM-DD in UTC", () => {
    assert.equal(datedTitle(NOW), "Operator decision queue 2026-05-26");
  });

  test("zero-pads month and day", () => {
    assert.equal(
      datedTitle(new Date("2026-01-03T00:00:00.000Z")),
      "Operator decision queue 2026-01-03",
    );
  });
});

describe("extractIssueRefs — pure helper", () => {
  test("returns [] on empty input", () => {
    assert.deepEqual(extractIssueRefs(""), []);
  });

  test("extracts #N references", () => {
    assert.deepEqual(extractIssueRefs("Review #1, #22, and #333"), [1, 22, 333]);
  });

  test("dedupes repeated references", () => {
    assert.deepEqual(extractIssueRefs("#5 then #5 again, then #6"), [5, 6]);
  });

  test("ignores references inside backtick code spans", () => {
    // A literal `#42` in code should not pollute the queue.
    assert.deepEqual(extractIssueRefs("Real ref #10. Code ref: `#42`."), [10]);
  });

  test("ignores tokens like abc#1 (only word-boundary #N)", () => {
    assert.deepEqual(extractIssueRefs("URL frag/abc#7. Real #8"), [8]);
  });
});

describe("parseLabeledIssuesOutput — pure helper", () => {
  test("returns [] on empty / non-JSON / non-array", () => {
    assert.deepEqual(parseLabeledIssuesOutput(""), []);
    assert.deepEqual(parseLabeledIssuesOutput("not json"), []);
    assert.deepEqual(parseLabeledIssuesOutput("{}"), []);
  });

  test("parses a typical gh issue list payload", () => {
    const stdout = JSON.stringify([
      {
        number: 101,
        title: "Pick a tier",
        url: "https://x/101",
        createdAt: "2026-05-26T01:00:00.000Z",
        labels: [{ name: "ready-for-human" }, { name: "tier:2" }],
      },
    ]);
    const items = parseLabeledIssuesOutput(stdout);
    assert.equal(items.length, 1);
    assert.equal(items[0].number, 101);
    assert.deepEqual(items[0].labels, ["ready-for-human", "tier:2"]);
  });

  test("skips items missing a number", () => {
    const stdout = JSON.stringify([{ title: "anon" }, { number: 5, title: "ok", url: "u", createdAt: "2026-05-26T01:00:00Z", labels: [] }]);
    const items = parseLabeledIssuesOutput(stdout);
    assert.equal(items.length, 1);
    assert.equal(items[0].number, 5);
  });
});

describe("parseDigestSearchOutput — pure helper", () => {
  test("returns [] when title doesn't match", () => {
    const stdout = JSON.stringify([
      { number: 1, title: "Some other digest", body: "Sees #100", labels: [], createdAt: "2026-05-26T00:00:00Z" },
    ]);
    assert.deepEqual(parseDigestSearchOutput(stdout, "Operator decision queue 2026-05-26"), []);
  });

  test("extracts referenced issues from the matching digest body", () => {
    const stdout = JSON.stringify([
      {
        number: 999,
        title: "Operator decision queue 2026-05-26",
        body: "Action items: #100, #101. Also #102.",
        createdAt: "2026-05-26T06:00:00.000Z",
        labels: [{ name: "operator-queue" }],
      },
    ]);
    const items = parseDigestSearchOutput(stdout, "Operator decision queue 2026-05-26");
    assert.equal(items.length, 3);
    assert.deepEqual(items.map((i) => i.number), [100, 101, 102]);
    assert.equal(items[0].createdAt, "2026-05-26T06:00:00.000Z");
  });

  test("returns [] when the digest exists but body has no refs", () => {
    const stdout = JSON.stringify([
      {
        number: 999,
        title: "Operator decision queue 2026-05-26",
        body: "No action items today!",
        createdAt: "2026-05-26T06:00:00.000Z",
        labels: [],
      },
    ]);
    assert.deepEqual(
      parseDigestSearchOutput(stdout, "Operator decision queue 2026-05-26"),
      [],
    );
  });
});

describe("mergeDecisionItems — pure helper", () => {
  test("preserves first source as primary; tracks all sources", () => {
    const merged = mergeDecisionItems({
      "operator-decision-queue": [
        { number: 10, title: "A", url: "ua", createdAt: "2026-05-26T01:00:00Z", labels: ["x"] },
      ],
      "ready-for-human": [
        { number: 10, title: "A-dup", url: "ua", createdAt: "2026-05-26T01:00:00Z", labels: ["y"] },
      ],
    });
    assert.equal(merged.length, 1);
    assert.equal(merged[0].source, "operator-decision-queue");
    assert.deepEqual(merged[0].sources, ["operator-decision-queue", "ready-for-human"]);
    // Labels from both sources are unioned.
    assert.deepEqual(merged[0].labels, ["x", "y"]);
  });

  test("sorts oldest-first", () => {
    const merged = mergeDecisionItems({
      "ready-for-human": [
        { number: 2, title: "young", url: "u2", createdAt: "2026-05-26T11:00:00Z", labels: [] },
        { number: 1, title: "old", url: "u1", createdAt: "2026-05-26T01:00:00Z", labels: [] },
      ],
    });
    assert.deepEqual(merged.map((i) => i.number), [1, 2]);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("getDecisionQueue — happy path", () => {
  test("merges digest refs, ready-for-human, and needs-info into one age-sorted list", async () => {
    const digestStdout = JSON.stringify([
      {
        number: 999,
        title: "Operator decision queue 2026-05-26",
        body: "Action items: #100",
        createdAt: "2026-05-26T06:00:00.000Z",
        labels: [],
      },
    ]);
    const readyStdout = JSON.stringify([
      {
        number: 200,
        title: "Decide tier",
        url: "https://x/200",
        createdAt: "2026-05-26T08:00:00.000Z",
        labels: [{ name: "ready-for-human" }],
      },
    ]);
    const infoStdout = JSON.stringify([
      {
        number: 50,
        title: "Old waiting",
        url: "https://x/50",
        createdAt: "2026-05-20T00:00:00.000Z",
        labels: [{ name: "needs-info" }],
      },
    ]);
    const exec = makeExecStub({
      "Operator decision queue 2026-05-26": { stdout: digestStdout },
      "Operator decision queue 2026-05-25": { stdout: JSON.stringify([]) },
      "--label ready-for-human": { stdout: readyStdout },
      "--label needs-info": { stdout: infoStdout },
    });

    const items = await getDecisionQueue({ now: NOW, execFileAsync: exec });
    // Oldest first: #50 (May 20), then #999-referenced #100 (May 26 06:00), then #200 (May 26 08:00).
    assert.deepEqual(
      items.map((i) => i.number),
      [50, 100, 200],
    );
    assert.equal(items[0].source, "needs-info");
    assert.equal(items[1].source, "operator-decision-queue");
    assert.equal(items[2].source, "ready-for-human");
  });
});

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe("getDecisionQueue — empty state", () => {
  test("returns [] when no source has items", async () => {
    const exec = makeExecStub({
      "Operator decision queue ": { stdout: JSON.stringify([]) },
      "--label ": { stdout: JSON.stringify([]) },
    });
    const items = await getDecisionQueue({ now: NOW, execFileAsync: exec });
    assert.deepEqual(items, []);
  });
});

// ---------------------------------------------------------------------------
// Boundary: one source fails, the rest still ship
// ---------------------------------------------------------------------------

describe("getDecisionQueue — sub-source failure isolation", () => {
  test("digest throws → labeled lists still produce the queue", async () => {
    const readyStdout = JSON.stringify([
      {
        number: 7,
        title: "still here",
        url: "u7",
        createdAt: "2026-05-26T01:00:00.000Z",
        labels: [],
      },
    ]);
    const infoStdout = JSON.stringify([]);
    const exec = async (cmd: string, args: readonly string[]) => {
      const key = `${cmd} ${args.join(" ")}`;
      if (key.includes("Operator decision queue")) {
        throw new Error("gh blew up");
      }
      if (key.includes("--label ready-for-human")) return { stdout: readyStdout, stderr: "" };
      if (key.includes("--label needs-info")) return { stdout: infoStdout, stderr: "" };
      throw new Error("unstubbed: " + key);
    };

    const items = await getDecisionQueue({ now: NOW, execFileAsync: exec });
    assert.equal(items.length, 1);
    assert.equal(items[0].number, 7);
  });
});
