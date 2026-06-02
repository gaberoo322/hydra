/**
 * Regression tests for the meta-friction GitHub Read seam (issue #864).
 *
 * `readMetaFrictionIssues` consolidates the previously-triplicated `gh issue
 * list --label meta-friction` read. These tests pin the behaviour the three
 * consumers (lessons-overnight, friction-patterns, lessons-trend) used to own
 * in their private copies: argv shape, exact-createdAt re-filter, newest-first
 * sort, and the never-throw / fail-loud contract. The sibling
 * `readFrictionPatterns` (Redis) is covered by the aggregator integration tests
 * that stub it.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { readMetaFrictionIssues } from "../src/aggregators/friction-source.ts";

const WINDOW_START = new Date("2026-05-25T00:00:00.000Z");

type ExecStub = (
  cmd: string,
  args: readonly string[],
  opts?: { cwd?: string; timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>;

describe("readMetaFrictionIssues — gh argv", () => {
  test("queries meta-friction with --limit 200 and the four JSON fields", async () => {
    let captured: readonly string[] = [];
    const exec: ExecStub = async (_cmd, args) => {
      captured = args;
      return { stdout: "[]", stderr: "" };
    };
    await readMetaFrictionIssues("seam-test", WINDOW_START, {
      execFileAsync: exec,
      githubRepo: "gaberoo322/hydra",
    });
    assert.equal(captured[0], "issue");
    assert.equal(captured[1], "list");
    assert.ok(captured.includes("meta-friction"));
    // Unified limit (was overnight=100 / friction-patterns=100 / trend=200).
    const limitIdx = captured.indexOf("--limit");
    assert.equal(captured[limitIdx + 1], "200");
    const jsonIdx = captured.indexOf("--json");
    assert.equal(captured[jsonIdx + 1], "number,title,url,createdAt");
    // Day-coarse created:>= search against the window start date.
    assert.ok(captured.includes("created:>=2026-05-25"));
  });
});

describe("readMetaFrictionIssues — parse / window / sort", () => {
  test("keeps in-window rows, drops pre-window, sorts newest-createdAt-first", async () => {
    const exec: ExecStub = async () => ({
      stdout: JSON.stringify([
        { number: 1, title: "older in", url: "u1", createdAt: "2026-05-25T01:00:00Z" },
        { number: 2, title: "newer in", url: "u2", createdAt: "2026-05-25T20:00:00Z" },
        { number: 3, title: "before", url: "u3", createdAt: "2026-05-24T23:00:00Z" },
      ]),
      stderr: "",
    });
    const out = await readMetaFrictionIssues("seam-test", WINDOW_START, {
      execFileAsync: exec,
    });
    assert.deepEqual(out.map((i) => i.number), [2, 1]);
    assert.equal(out[0].title, "newer in");
    assert.equal(out[0].url, "u2");
  });

  test("drops rows with non-positive / non-numeric number", async () => {
    const exec: ExecStub = async () => ({
      stdout: JSON.stringify([
        { number: 0, title: "zero", url: "u", createdAt: "2026-05-26T00:00:00Z" },
        { number: "x", title: "nan", url: "u", createdAt: "2026-05-26T00:00:00Z" },
        { number: 9, title: "ok", url: "u9", createdAt: "2026-05-26T00:00:00Z" },
      ]),
      stderr: "",
    });
    const out = await readMetaFrictionIssues("seam-test", WINDOW_START, {
      execFileAsync: exec,
    });
    assert.deepEqual(out.map((i) => i.number), [9]);
  });

  test("synthesizes title/url fallbacks from the issue number", async () => {
    const exec: ExecStub = async () => ({
      stdout: JSON.stringify([
        { number: 42, createdAt: "2026-05-26T00:00:00Z" },
      ]),
      stderr: "",
    });
    const out = await readMetaFrictionIssues("seam-test", WINDOW_START, {
      execFileAsync: exec,
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].title, "Issue #42");
    assert.equal(out[0].url, "https://github.com/gaberoo322/hydra/issues/42");
  });
});

describe("readMetaFrictionIssues — never throws / fail-loud", () => {
  test("empty stdout → []", async () => {
    const exec: ExecStub = async () => ({ stdout: "", stderr: "" });
    assert.deepEqual(
      await readMetaFrictionIssues("seam-test", WINDOW_START, { execFileAsync: exec }),
      [],
    );
  });

  test("non-array JSON payload → []", async () => {
    const exec: ExecStub = async () => ({ stdout: "{}", stderr: "" });
    assert.deepEqual(
      await readMetaFrictionIssues("seam-test", WINDOW_START, { execFileAsync: exec }),
      [],
    );
  });

  test("malformed JSON → [] (logged, not thrown)", async () => {
    const exec: ExecStub = async () => ({ stdout: "{not json", stderr: "" });
    const out = await readMetaFrictionIssues("seam-test", WINDOW_START, {
      execFileAsync: exec,
    });
    assert.deepEqual(out, []);
  });

  test("gh failure → [] (logged, not thrown)", async () => {
    const exec: ExecStub = async () => {
      throw new Error("gh broken");
    };
    const out = await readMetaFrictionIssues("seam-test", WINDOW_START, {
      execFileAsync: exec,
    });
    assert.deepEqual(out, []);
  });

  test("empty repo string → [] without shelling out", async () => {
    let called = false;
    const exec: ExecStub = async () => {
      called = true;
      return { stdout: "[]", stderr: "" };
    };
    const out = await readMetaFrictionIssues("seam-test", WINDOW_START, {
      execFileAsync: exec,
      githubRepo: "",
    });
    assert.deepEqual(out, []);
    assert.equal(called, false);
  });
});
