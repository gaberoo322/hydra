/**
 * test/ast-search.test.mts — pin the pure argv-parsing + match-normalisation of
 * scripts/ast-search.ts (issue #1797) without spawning the ast-grep CLI.
 *
 * The CLI invocation itself (npx -p @ast-grep/cli ...) is integration-tested by
 * the ast-grep-lint workflow; here we lock the agent-facing contract: which
 * flags are accepted, the defaults, and the stable normalised JSON row shape an
 * agent consumes.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { parseArgs, normaliseMatches, buildCliArgs } = await import("../scripts/ast-search.ts");

describe("ast-search: parseArgs", () => {
  test("requires --pattern", () => {
    const r = parseArgs([]);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /Missing required --pattern/);
  });

  test("defaults lang=ts and path=src/", () => {
    const r = parseArgs(["--pattern", "new Redis($$$)"]);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.args.pattern, "new Redis($$$)");
      assert.equal(r.args.lang, "ts");
      assert.deepEqual(r.args.paths, ["src/"]);
      assert.equal(r.args.textOnly, false);
    }
  });

  test("honours --lang, repeated --path, and --text", () => {
    const r = parseArgs([
      "--pattern",
      "$_.then($$$)",
      "--lang",
      "tsx",
      "--path",
      "src/api",
      "--path",
      "scripts",
      "--text",
    ]);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.args.lang, "tsx");
      assert.deepEqual(r.args.paths, ["src/api", "scripts"]);
      assert.equal(r.args.textOnly, true);
    }
  });

  test("rejects an unknown flag", () => {
    const r = parseArgs(["--pattern", "x", "--bogus"]);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /Unknown argument: --bogus/);
  });
});

describe("ast-search: rule mode (issue #4732)", () => {
  test("--rule satisfies the pattern requirement and repeats --path", () => {
    const r = parseArgs(["--rule", "fail-loud-catch", "--path", "src/a.ts", "--path", "src/b.ts"]);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.args.rule, "fail-loud-catch");
      assert.equal(r.args.pattern, "");
      assert.deepEqual(r.args.paths, ["src/a.ts", "src/b.ts"]);
    }
  });

  test("pattern mode leaves rule null", () => {
    const r = parseArgs(["--pattern", "new Redis($$$)"]);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.args.rule, null);
  });

  test("--pattern and --rule are mutually exclusive", () => {
    const r = parseArgs(["--pattern", "x", "--rule", "fail-loud-catch"]);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /mutually exclusive/);
  });

  test("buildCliArgs: rule mode runs `ast-grep scan` with an anchored --filter", () => {
    const r = parseArgs(["--rule", "fail-loud-catch", "--path", "src/a.ts"]);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const argv = buildCliArgs(r.args);
    assert.deepEqual(argv.slice(3), ["ast-grep", "scan", "--filter", "^fail-loud-catch$", "--json=compact", "src/a.ts"]);
    assert.match(argv[2], /^@ast-grep\/cli@\d+\.\d+\.\d+$/);
  });

  test("buildCliArgs: pattern mode runs `ast-grep run --pattern`", () => {
    const r = parseArgs(["--pattern", "new Redis($$$)", "--path", "src/"]);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(buildCliArgs(r.args).slice(3), [
      "ast-grep",
      "run",
      "--pattern",
      "new Redis($$$)",
      "--lang",
      "ts",
      "--json=compact",
      "src/",
    ]);
  });
});

describe("ast-search: normaliseMatches", () => {
  test("maps the upstream compact shape to the stable minimal row", () => {
    const raw = [
      {
        text: 'new Redis("bad")',
        file: "src/foo/bad.ts",
        range: { start: { line: 0, column: 10 }, end: { line: 0, column: 26 } },
      },
    ];
    const rows = normaliseMatches(raw);
    assert.deepEqual(rows, [
      {
        file: "src/foo/bad.ts",
        line: 0,
        column: 10,
        endLine: 0,
        endColumn: 26,
        text: 'new Redis("bad")',
      },
    ]);
  });

  test("sorts by (file, line) and tolerates missing fields", () => {
    const raw = [
      { text: "b", file: "src/z.ts", range: { start: { line: 5 } } },
      { text: "a", file: "src/a.ts", range: { start: { line: 9 } } },
      { text: "c", file: "src/a.ts", range: { start: { line: 2 } } },
      { text: "d" }, // no file/range — must not throw
    ];
    const rows = normaliseMatches(raw);
    assert.deepEqual(
      rows.map((r) => [r.file, r.line]),
      [
        ["", 0],
        ["src/a.ts", 2],
        ["src/a.ts", 9],
        ["src/z.ts", 5],
      ],
    );
  });

  test("empty input yields empty array (no matches is not an error)", () => {
    assert.deepEqual(normaliseMatches([]), []);
  });
});
