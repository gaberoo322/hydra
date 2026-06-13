/**
 * test/probe-search.test.mts — pin the pure argv-parsing + result-normalisation
 * of scripts/probe-search.ts (issue #1799) without spawning the probe CLI.
 *
 * The CLI invocation itself (npx -p @probelabs/probe ...) downloads a binary and
 * is exercised manually / by an agent at runtime; here we lock the agent-facing
 * contract: which flags are accepted, the defaults, and the stable normalised
 * JSON row shape (repo-relative path, score-DESC ordering) an agent consumes.
 * The recorded payload below mirrors the real `probe search --format json`
 * output shape observed against this tree.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { parseArgs, normaliseResults } = await import("../scripts/probe-search.ts");

describe("probe-search: parseArgs", () => {
  test("requires --query", () => {
    const r = parseArgs([]);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /Missing required --query/);
  });

  test("defaults path=src/ and max=10", () => {
    const r = parseArgs(["--query", "retry logic"]);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.args.query, "retry logic");
      assert.deepEqual(r.args.paths, ["src/"]);
      assert.equal(r.args.max, 10);
      assert.equal(r.args.textOnly, false);
    }
  });

  test("honours repeated --path, --max, and --text", () => {
    const r = parseArgs([
      "--query",
      "login OR auth",
      "--path",
      "src/api",
      "--path",
      "scripts",
      "--max",
      "3",
      "--text",
    ]);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.deepEqual(r.args.paths, ["src/api", "scripts"]);
      assert.equal(r.args.max, 3);
      assert.equal(r.args.textOnly, true);
    }
  });

  test("rejects a non-positive / non-integer --max", () => {
    for (const bad of ["0", "-2", "abc", "1.5"]) {
      const r = parseArgs(["--query", "x", "--max", bad]);
      assert.equal(r.ok, false, `expected --max ${bad} to be rejected`);
      if (!r.ok) assert.match(r.error, /--max must be a positive integer/);
    }
  });

  test("rejects an unknown flag", () => {
    const r = parseArgs(["--query", "x", "--bogus"]);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /Unknown argument: --bogus/);
  });
});

describe("probe-search: normaliseResults", () => {
  const REPO_ROOT = "/home/gabe/hydra";

  test("maps the upstream payload to the stable minimal row, repo-relative file", () => {
    const payload = {
      limits: { max_results: 1 },
      results: [
        {
          file: "/home/gabe/hydra/src/backlog/lanes.ts",
          lines: [21, 45],
          code: "export async function promoteToQueued(count = 1) {\n  // ...\n}",
          language: "typescript",
          bm25_score: 1.6674562044671228,
        },
      ],
    };
    const rows = normaliseResults(payload, REPO_ROOT);
    assert.deepEqual(rows, [
      {
        file: "src/backlog/lanes.ts",
        startLine: 21,
        endLine: 45,
        language: "typescript",
        score: 1.6674562044671228,
        code: "export async function promoteToQueued(count = 1) {\n  // ...\n}",
      },
    ]);
  });

  test("sorts by score DESC, tie-breaking on (file, startLine), tolerating missing fields", () => {
    const payload = {
      results: [
        { file: "/home/gabe/hydra/src/z.ts", lines: [5, 9], bm25_score: 1.0 },
        { file: "/home/gabe/hydra/src/a.ts", lines: [2, 4], bm25_score: 3.0 },
        { file: "/home/gabe/hydra/src/a.ts", lines: [10, 12], bm25_score: 1.0 },
        {}, // no file/lines/score — must not throw, sorts last (score 0)
      ],
    };
    const rows = normaliseResults(payload, REPO_ROOT);
    assert.deepEqual(
      rows.map((r) => [r.file, r.startLine, r.score]),
      [
        ["src/a.ts", 2, 3.0],
        ["src/a.ts", 10, 1.0],
        ["src/z.ts", 5, 1.0],
        ["", 0, 0],
      ],
    );
  });

  test("leaves an already-relative file path untouched", () => {
    const rows = normaliseResults(
      { results: [{ file: "src/rel.ts", lines: [1, 2], bm25_score: 0.5 }] },
      REPO_ROOT,
    );
    assert.equal(rows[0].file, "src/rel.ts");
  });

  test("empty / missing results yields empty array (no matches is not an error)", () => {
    assert.deepEqual(normaliseResults({ results: [] }, REPO_ROOT), []);
    assert.deepEqual(normaliseResults({}, REPO_ROOT), []);
  });
});
