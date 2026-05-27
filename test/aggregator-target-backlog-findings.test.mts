/**
 * Regression tests for the target-backlog-findings aggregator (issue #617).
 *
 * Pure helpers (`filterUnroutedFindings`, `excerptOf`) are tested directly.
 * Integration shape is tested with an exec stub.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  getNewTargetFindings,
  filterUnroutedFindings,
  excerptOf,
} from "../src/aggregators/target-backlog-findings.ts";

const NOW = new Date("2026-05-26T12:00:00.000Z");
const WINDOW_START = new Date(NOW.getTime() - 24 * 60 * 60 * 1000); // 24h

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("excerptOf — pure helper", () => {
  test("returns '' on empty input", () => {
    assert.equal(excerptOf(""), "");
  });

  test("returns the first non-empty paragraph", () => {
    const body = "\n\nFirst para.\n\nSecond para.\n";
    assert.equal(excerptOf(body), "First para.");
  });

  test("truncates paragraphs longer than 240 chars with an ellipsis", () => {
    const body = "x".repeat(300);
    const out = excerptOf(body);
    assert.equal(out.length, 240);
    assert.ok(out.endsWith("..."));
  });
});

describe("filterUnroutedFindings — pure helper", () => {
  test("returns [] on empty / non-array", () => {
    assert.deepEqual(filterUnroutedFindings("", WINDOW_START), []);
    assert.deepEqual(filterUnroutedFindings("not json", WINDOW_START), []);
    assert.deepEqual(filterUnroutedFindings("{}", WINDOW_START), []);
  });

  test("keeps OPEN, not-in-progress, in-window items", () => {
    const stdout = JSON.stringify([
      {
        number: 1,
        title: "fresh finding",
        url: "u1",
        createdAt: "2026-05-26T06:00:00Z",
        labels: [{ name: "target-backlog" }],
        body: "Found a latency regression in handlePick.",
        state: "OPEN",
      },
      {
        number: 2,
        title: "already in progress",
        url: "u2",
        createdAt: "2026-05-26T07:00:00Z",
        labels: [{ name: "target-backlog" }, { name: "in-progress" }],
        body: "",
        state: "OPEN",
      },
      {
        number: 3,
        title: "closed",
        url: "u3",
        createdAt: "2026-05-26T08:00:00Z",
        labels: [{ name: "target-backlog" }],
        body: "",
        state: "CLOSED",
      },
      {
        number: 4,
        title: "stale outside window",
        url: "u4",
        createdAt: "2026-05-20T00:00:00Z",
        labels: [{ name: "target-backlog" }],
        body: "",
        state: "OPEN",
      },
    ]);
    const out = filterUnroutedFindings(stdout, WINDOW_START);
    assert.equal(out.length, 1);
    assert.equal(out[0].number, 1);
    assert.ok(out[0].excerpt.startsWith("Found a latency regression"));
  });

  test("sorts newest-first", () => {
    const stdout = JSON.stringify([
      {
        number: 1,
        title: "older",
        url: "u1",
        createdAt: "2026-05-26T06:00:00Z",
        labels: [{ name: "target-backlog" }],
        body: "",
        state: "OPEN",
      },
      {
        number: 2,
        title: "newer",
        url: "u2",
        createdAt: "2026-05-26T10:00:00Z",
        labels: [{ name: "target-backlog" }],
        body: "",
        state: "OPEN",
      },
    ]);
    const out = filterUnroutedFindings(stdout, WINDOW_START);
    assert.deepEqual(out.map((i) => i.number), [2, 1]);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("getNewTargetFindings — happy path", () => {
  test("returns one finding when the gh stub produces one matching item", async () => {
    const stdout = JSON.stringify([
      {
        number: 42,
        title: "Latency spike in /handlePick",
        url: "https://x/42",
        createdAt: "2026-05-26T06:00:00Z",
        labels: [{ name: "target-backlog" }],
        body: "p99 spiked at 06:14 UTC.",
        state: "OPEN",
      },
    ]);
    const exec = async () => ({ stdout, stderr: "" });
    const findings = await getNewTargetFindings(24, { now: NOW, execFileAsync: exec });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].number, 42);
  });
});

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe("getNewTargetFindings — empty state", () => {
  test("no matches → []", async () => {
    const exec = async () => ({ stdout: JSON.stringify([]), stderr: "" });
    const findings = await getNewTargetFindings(24, { now: NOW, execFileAsync: exec });
    assert.deepEqual(findings, []);
  });

  test("exec throws → [] (degrades, doesn't reject)", async () => {
    const exec = async () => {
      throw new Error("gh down");
    };
    const findings = await getNewTargetFindings(24, { now: NOW, execFileAsync: exec });
    assert.deepEqual(findings, []);
  });
});

// ---------------------------------------------------------------------------
// Boundary: window edge — item exactly at windowStart counts as inside
// ---------------------------------------------------------------------------

describe("getNewTargetFindings — window boundary", () => {
  test("item at windowStart is INSIDE; one second earlier is OUTSIDE", async () => {
    const insideISO = WINDOW_START.toISOString();
    const outsideISO = new Date(WINDOW_START.getTime() - 1000).toISOString();
    const stdout = JSON.stringify([
      { number: 1, title: "inside", url: "u1", createdAt: insideISO, labels: [{ name: "target-backlog" }], body: "", state: "OPEN" },
      { number: 2, title: "outside", url: "u2", createdAt: outsideISO, labels: [{ name: "target-backlog" }], body: "", state: "OPEN" },
    ]);
    const exec = async () => ({ stdout, stderr: "" });
    const findings = await getNewTargetFindings(24, { now: NOW, execFileAsync: exec });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].number, 1);
  });
});
