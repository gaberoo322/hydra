/**
 * Regression suite for the shared CLI-arg seam `src/cli-args.ts` (issue #4565).
 *
 * The seam wraps node:util parseArgs in strict mode and NEVER throws: every
 * parse failure comes back as `{ ok: false, error }`, with unknown flags
 * normalised to the one repo-wide wording `Unknown argument: <flag>`.
 *
 * Run: npm run test:file -- test/cli-args.test.mts
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

const { parseCliArgs } = await import("../src/cli-args.ts");

const OPTIONS = {
  pattern: { type: "string" },
  path: { type: "string", multiple: true },
  text: { type: "boolean" },
  lang: { type: "string", default: "ts" },
} as const;

describe("cli-args: parseCliArgs", () => {
  test("accepts both --flag value and --flag=value forms", () => {
    const spaced = parseCliArgs(["--pattern", "new Redis($$$)"], OPTIONS);
    assert.equal(spaced.ok, true);
    if (spaced.ok) assert.equal(spaced.values.pattern, "new Redis($$$)");

    const eq = parseCliArgs(["--pattern=x", "--text"], OPTIONS);
    assert.equal(eq.ok, true);
    if (eq.ok) {
      assert.equal(eq.values.pattern, "x");
      assert.equal(eq.values.text, true);
    }
  });

  test("collects a repeated multiple:true flag in order and applies defaults", () => {
    const r = parseCliArgs(["--path", "a", "--path=b"], OPTIONS);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.deepEqual(r.values.path, ["a", "b"]);
      assert.equal(r.values.lang, "ts");
      assert.equal(r.values.pattern, undefined);
    }
  });

  test("rejects an unknown flag with the canonical wording", () => {
    const r = parseCliArgs(["--bogus"], OPTIONS);
    assert.deepEqual(r, { ok: false, error: "Unknown argument: --bogus" });
    const short = parseCliArgs(["-x"], OPTIONS);
    assert.deepEqual(short, { ok: false, error: "Unknown argument: -x" });
  });

  test("rejects a stray positional with the canonical wording", () => {
    assert.deepEqual(parseCliArgs(["stray"], OPTIONS), { ok: false, error: "Unknown argument: stray" });
  });

  test("a missing value is an error naming the flag", () => {
    const r = parseCliArgs(["--pattern"], OPTIONS);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /--pattern/);
  });

  test("a dash-leading value needs the --flag=-x form", () => {
    const ambiguous = parseCliArgs(["--pattern", "-x"], OPTIONS);
    assert.equal(ambiguous.ok, false);
    if (!ambiguous.ok) {
      assert.match(ambiguous.error, /--pattern/);
      assert.doesNotMatch(ambiguous.error, /\n/, "error is a single line");
    }
    const eq = parseCliArgs(["--pattern=-x"], OPTIONS);
    assert.equal(eq.ok, true);
    if (eq.ok) assert.equal(eq.values.pattern, "-x");
  });

  test("never throws on any malformed argv", () => {
    const cases: string[][] = [["--bogus"], ["--pattern"], ["--text=1"], ["--pattern", "--text"], ["x"], ["-"], ["--"]];
    for (const argv of cases) {
      assert.doesNotThrow(() => parseCliArgs(argv, OPTIONS), `threw on ${JSON.stringify(argv)}`);
      const r = parseCliArgs(argv, OPTIONS);
      assert.equal(typeof r.ok, "boolean");
    }
    const boolWithValue = parseCliArgs(["--text=1"], OPTIONS);
    assert.equal(boolWithValue.ok, false);
  });
});
