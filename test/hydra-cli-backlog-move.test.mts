/**
 * Regression tests for the `hydra backlog` CLI subcommand.
 *
 * History: `hydra backlog move <id> <lane>` used to PATCH the Redis backlog
 * API (issue #537 fixed the route, issue #1140 added lane-alias
 * normalization). The whole Redis backlog subsystem (`/api/backlog`) was
 * then retired by the ADR-0031 Target-tracking migration (#3439, PR #3455),
 * so `ls`/`counts`/`move` all 404'd — `_get`'s HTML/non-2xx guard (issue
 * #448) already failed loud, but the failure read as "server error", not
 * "this was intentionally retired".
 *
 * issue #3745 replaces `cmd_backlog()` with a stub that never calls the API:
 * it prints a pointer at the GitHub Issues board replacement and exits
 * nonzero, for EVERY invocation (`ls`, `counts`, `move <id> <lane>`, or no
 * args at all) — there is nothing left to repoint to.
 *
 * These tests are file-level assertions on `bin/hydra`, matching the
 * pattern established by `test/hydra-cli-cycle-reality.test.mts` for
 * issue #448. They don't spawn the CLI because it depends on a live API
 * on port 4000, which we can't assume in CI.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const BIN_PATH = new URL("../bin/hydra", import.meta.url);

async function readBin(): Promise<string> {
  return readFile(BIN_PATH, "utf8");
}

/**
 * Extract the body of the `cmd_backlog()` shell function.
 */
function extractCmdBacklog(text: string): string {
  const match = text.match(/cmd_backlog\(\)[\s\S]*?\n\}/);
  if (!match) throw new Error("cmd_backlog() not found in bin/hydra");
  return match[0];
}

describe("hydra CLI: backlog retirement (issue #3745)", () => {
  test("cmd_backlog never calls the retired /api/backlog routes", async () => {
    const text = await readBin();
    const body = extractCmdBacklog(text);

    // No live HTTP call of any kind — ls/counts/move all 404'd, so there is
    // nothing left to GET/PATCH.
    assert.doesNotMatch(
      body,
      /_get\s+"\/backlog/,
      "cmd_backlog must not GET any /backlog route (retired, issue #3745)",
    );
    assert.doesNotMatch(
      body,
      /_patch\s+"\/backlog/,
      "cmd_backlog must not PATCH any /backlog route (retired, issue #3745)",
    );
  });

  test("cmd_backlog exits nonzero with a pointer at the replacement", async () => {
    const text = await readBin();
    const body = extractCmdBacklog(text);

    assert.match(
      body,
      /exit 2/,
      "cmd_backlog must exit nonzero so a caller piping stdout through json.load fails loud, not silently",
    );
    // Points readers at the GitHub Issues board that replaced the Redis
    // backlog subsystem, not just "it's broken".
    assert.match(
      body,
      /gh issue list --repo gaberoo322\/hydra/,
      "cmd_backlog must name the GitHub Issues replacement command",
    );
    assert.match(
      body,
      /#3745/,
      "cmd_backlog must reference issue #3745 so readers can find the retirement rationale",
    );
  });

  test("cmd_backlog's message reaches stderr, not stdout (issue #448 lineage)", async () => {
    const text = await readBin();
    const body = extractCmdBacklog(text);
    // The retirement message must print via `cat >&2` (or an equivalent
    // stderr redirect) so a caller piping stdout through `json.load` sees an
    // empty stream and a nonzero exit, never the message parsed as data.
    assert.match(
      body,
      />&2/,
      "cmd_backlog must write its retirement message to stderr",
    );
  });

  test("usage block documents the retirement so operators can find it (issue #3745)", async () => {
    const text = await readBin();
    // Future readers need a breadcrumb from the script to the issue. Match
    // anywhere in the file (the rationale lives in the leading comment
    // block, not inside cmd_backlog).
    assert.match(
      text,
      /#3745|issue 3745|issue #3745/i,
      "bin/hydra must reference issue #3745 so readers can find the retirement rationale",
    );
    // The old ls|counts|move usage line must be gone — there is nothing to
    // repoint readers to.
    assert.doesNotMatch(
      text,
      /hydra backlog ls \| counts \| move/,
      "usage block must not still advertise ls|counts|move as live subcommands",
    );
  });
});
