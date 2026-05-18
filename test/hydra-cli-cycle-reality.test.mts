/**
 * Regression tests for the `hydra cycle reality` CLI subcommand (issue #448).
 *
 * Before the fix:
 *   - `hydra cycle reality` issued `GET /api/cycle/reality`, but no such
 *     route exists after the cycles-router refactor. The actual shape is
 *     `/api/cycle/:cycleId/reality`. Every invocation returned the Express
 *     default 404 HTML page, which `_get` printed to stdout as if it were
 *     the response body. Skills and operators saw HTML instead of an error.
 *   - The `reality` case didn't accept a positional `cycleId` — even if the
 *     path were fixed, there was no way to pass the ID.
 *   - `_get` set no expectation about HTTP status or content-type, so 404 /
 *     500 / HTML all flowed through unchecked.
 *
 * After the fix (bin/hydra):
 *   - `reality` accepts an optional `<cycleId>` positional argument.
 *   - When no argument is provided, it resolves the most recent cycle from
 *     `/cycle/history?limit=1` and uses its `cycleId`.
 *   - The path is `/cycle/$cid/reality` — matches the route defined in
 *     `src/api/cycles.ts:70`.
 *   - `_get` extracts the HTTP status via `curl -w`, refuses to print HTML
 *     bodies (even on 200), and exits non-zero when the response is not 2xx
 *     or looks like HTML.
 *
 * These tests are file-level assertions on `bin/hydra` (the same pattern
 * test/scheduler-stop-semantics.test.mts uses for AC4) — they don't spawn
 * the CLI because it depends on a live API on port 4000, which we can't
 * assume in CI.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const BIN_PATH = new URL("../bin/hydra", import.meta.url);

async function readBin(): Promise<string> {
  return readFile(BIN_PATH, "utf8");
}

describe("hydra CLI: cycle reality (issue #448)", () => {
  test("path uses /cycle/:cycleId/reality, never the legacy /cycle/reality", async () => {
    const text = await readBin();
    // The Express route in src/api/cycles.ts is /cycle/:cycleId/reality.
    // The CLI must build that path (with a variable in place of :cycleId)
    // and must NOT contain the legacy bare /cycle/reality path on its own.
    assert.match(
      text,
      /\/cycle\/\$\{?cid\}?\/reality|\/cycle\/\$\{?cycleId\}?\/reality/,
      "bin/hydra must GET /cycle/<cycleId>/reality (the actual route shape)",
    );
    // Allow the legacy path to appear only inside comments / docstrings as
    // a reference to the bug — but it must not appear as an active _get
    // call. The simplest way to assert that is to forbid `_get "/cycle/reality"`.
    assert.doesNotMatch(
      text,
      /_get\s+["']\/cycle\/reality["']/,
      "bin/hydra must NOT GET the legacy /cycle/reality path (404s silently)",
    );
  });

  test("reality subcommand accepts a positional cycleId", async () => {
    const text = await readBin();
    // The reality) branch should `shift` and read a positional arg into a
    // local variable (`cid` in the current implementation). Anchor the
    // match inside the cmd_cycle function so a stray shift elsewhere
    // doesn't pass the check.
    const cycleFn = text.match(/cmd_cycle\(\)[\s\S]*?\n\}/);
    assert.ok(cycleFn, "cmd_cycle() should exist in bin/hydra");
    const body = cycleFn![0];
    assert.match(
      body,
      /reality\)[\s\S]*?\bshift\b[\s\S]*?\$\{?(?:1|cid|cycleId)/,
      "reality) branch must shift and read a positional cycleId argument",
    );
  });

  test("reality subcommand resolves the latest cycleId when none given", async () => {
    const text = await readBin();
    // When the operator types `hydra cycle reality` with no arg, the CLI
    // should fall back to GET /cycle/history?limit=1 and extract the
    // first cycleId. This is the discovery/debugging path that operators
    // and /hydra-discover rely on — they shouldn't need to remember IDs.
    assert.match(
      text,
      /\/cycle\/history\?limit=1/,
      "reality) branch must call /cycle/history?limit=1 as the default resolver",
    );
    assert.match(
      text,
      /cycleId/,
      "reality) branch must reference the cycleId field when parsing history",
    );
  });

  test("_get detects non-2xx and exits non-zero", async () => {
    const text = await readBin();
    // After #448 the helper must capture the HTTP status (via curl -w) and
    // refuse to silently print 4xx/5xx bodies as if they were data. The
    // exact mechanism is curl -w '...%{http_code}' but we don't want to
    // pin the wire format; instead we assert the helper has BOTH a
    // status-capture and a non-zero exit path.
    assert.match(
      text,
      /%\{http_code\}/,
      "_get must capture the HTTP status via curl -w '%{http_code}'",
    );
    // _get must exit non-zero on failure (return 1 / exit 1) in the
    // status-not-2xx branch. We look for the pattern "2??)" (the case
    // arm for any 2xx code) followed downstream by a `return 1` or
    // `exit 1`.
    assert.match(
      text,
      /2\?\?\)[\s\S]*?(return 1|exit 1)/,
      "_get must return non-zero when the HTTP status is not 2xx",
    );
  });

  test("_get refuses to print HTML responses (the silent-404 fix)", async () => {
    const text = await readBin();
    // The whole point of #448 is that the Express 404 HTML page used to
    // flow through stdout. The hardened _get must explicitly refuse HTML.
    // We assert it checks for the common HTML opening tags AND emits a
    // diagnostic to stderr rather than stdout.
    assert.match(
      text,
      /<!DOCTYPE|<html|<HTML/,
      "_get must detect HTML response bodies (the Cannot GET 404 page)",
    );
    assert.match(
      text,
      /returned HTML[\s\S]*?>&2/,
      "_get must report HTML responses on stderr (not silently to stdout)",
    );
  });

  test("help text documents the new reality usage and the #448 fix", async () => {
    const text = await readBin();
    // Operators reading the script must see that `reality` takes a
    // cycleId and that the silent-404 bug was fixed.
    assert.match(
      text,
      /hydra cycle reality\s*\[\s*<cycleId>\s*\]/,
      "Usage block must show `hydra cycle reality [<cycleId>]`",
    );
    assert.match(
      text,
      /#448|issue 448|issue #448/i,
      "Usage block must reference issue #448 so readers can find the rationale",
    );
  });
});
