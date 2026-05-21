/**
 * Regression tests for the `hydra backlog move` CLI subcommand (issue #537).
 *
 * Before the fix:
 *   - `hydra backlog move <id> <lane>` PATCHed `/api/backlog/:id` (which
 *     routes to `updateItem`) with `{"lane": "<lane>"}`.
 *   - `updateItem` only honours `priority|description|labels|estimate|
 *     parentId|title` — `lane` is silently dropped. Every invocation
 *     returned `ok:true` while the backlog state was unchanged.
 *   - Subagents trying to move items between lanes (e.g. `inProgress` ->
 *     `done` from hydra-target-build) had to fall back to
 *     `hydra raw PATCH /backlog/<id>/move --json '{"lane":"<lane>"}'`.
 *
 * After the fix (bin/hydra):
 *   - `move` PATCHes `/backlog/<id>/move` (the dedicated move sub-route
 *     defined in `src/api/backlog.ts`).
 *   - The payload field stays `lane` (matching `moveItemToLane`'s
 *     handler at `src/api/backlog.ts:141`).
 *   - The bare `/backlog/<id>` PATCH is no longer used for lane changes.
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
 * Extract the body of the `cmd_backlog()` shell function. Anchoring the
 * regex matches inside this function prevents stray `_patch` calls
 * elsewhere in the script from accidentally passing the assertion.
 */
function extractCmdBacklog(text: string): string {
  const match = text.match(/cmd_backlog\(\)[\s\S]*?\n\}/);
  if (!match) throw new Error("cmd_backlog() not found in bin/hydra");
  return match[0];
}

describe("hydra CLI: backlog move (issue #537)", () => {
  test("move PATCHes /backlog/<id>/move, never the bare /backlog/<id>", async () => {
    const text = await readBin();
    const body = extractCmdBacklog(text);

    // The dedicated move sub-route is the only correct target.
    assert.match(
      body,
      /_patch\s+"\/backlog\/\$\{?1\}?\/move"/,
      "hydra backlog move must PATCH /backlog/<id>/move (the dedicated move handler)",
    );

    // Within the `move )` branch specifically, the bare /backlog/$1
    // PATCH path (the bug) must not appear — the path must always
    // include the /move suffix.
    const moveBranch = body.match(/move\s*\)[\s\S]*?;;/);
    assert.ok(moveBranch, "cmd_backlog() must define a `move )` branch");
    assert.doesNotMatch(
      moveBranch![0],
      /_patch\s+"\/backlog\/\$\{?1\}?"\s/,
      "hydra backlog move must NOT PATCH the bare /backlog/<id> path (silently drops lane)",
    );
    assert.doesNotMatch(
      moveBranch![0],
      /_patch\s+"\/backlog\/\$\{?1\}?"$/m,
      "hydra backlog move must NOT PATCH the bare /backlog/<id> path (silently drops lane)",
    );
  });

  test("move payload uses the `lane` field (not `to`)", async () => {
    const text = await readBin();
    const body = extractCmdBacklog(text);
    // The API's moveItemToLane reads `req.body.lane` (see
    // src/api/backlog.ts:143). Earlier draft of this bug also mentioned
    // a `to` vs `lane` mismatch — pin the field name down.
    const moveBranch = body.match(/move\s*\)[\s\S]*?;;/);
    assert.ok(moveBranch, "cmd_backlog() must define a `move )` branch");
    assert.match(
      moveBranch![0],
      /\{\\?"lane\\?":\\?"\$\{?2\}?\\?"\}/,
      "hydra backlog move must send {\"lane\": \"<lane>\"} (the field moveItemToLane reads)",
    );
    assert.doesNotMatch(
      moveBranch![0],
      /\{\\?"to\\?":/,
      "hydra backlog move must NOT use the `to` field (the API reads `lane`)",
    );
  });

  test("usage block documents the #537 fix so operators can find it", async () => {
    const text = await readBin();
    // Future readers need a breadcrumb from the script to the issue.
    // Match anywhere in the file (the rationale lives in the leading
    // comment block, not inside cmd_backlog).
    assert.match(
      text,
      /#537|issue 537|issue #537/i,
      "bin/hydra must reference issue #537 so readers can find the rationale",
    );
  });
});
