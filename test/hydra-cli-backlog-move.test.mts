/**
 * Regression tests for the `hydra backlog move` CLI subcommand (issue #537).
 *
 * Bug (2026-05-20, reported by hydra-target-build during the item-304 build):
 *   `hydra backlog move <id> <lane>` returned `ok:true` but did not actually
 *   move the item between lanes. The CLI hit `PATCH /backlog/:id` (which
 *   routes to `updateItem`) instead of `PATCH /backlog/:id/move` (the lane
 *   transition handler in `src/api/backlog.ts`). updateItem silently ignores
 *   the `lane` field, so the response shape looked successful while the
 *   backlog state was unchanged. Subagents had to fall back to `hydra raw
 *   PATCH /backlog/:id/move --json '{"lane":"done"}'` to make progress.
 *
 * After the fix (bin/hydra):
 *   - `backlog move` builds the path as `/backlog/<id>/move`, matching the
 *     route mounted at `src/api/backlog.ts:141`.
 *   - The payload remains `{"lane": "<lane>"}` — never `{"to": ...}` (the
 *     followup comment on #537 noted that several callers had guessed the
 *     wrong field name).
 *
 * These tests are file-level assertions on `bin/hydra` (the same pattern
 * test/hydra-cli-cycle-reality.test.mts uses for issue #448) — they don't
 * spawn the CLI because it depends on a live API on port 4000, which we
 * can't assume in CI.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const BIN_PATH = new URL("../bin/hydra", import.meta.url);

async function readBin(): Promise<string> {
  return readFile(BIN_PATH, "utf8");
}

/**
 * Extract the body of `cmd_backlog()` from the CLI script so we can match
 * patterns scoped to the move branch without false-positive hits from
 * comments or other commands.
 */
function cmdBacklogBody(text: string): string {
  const match = text.match(/cmd_backlog\(\)[\s\S]*?\n\}/);
  assert.ok(match, "cmd_backlog() should exist in bin/hydra");
  return match![0];
}

describe("hydra CLI: backlog move (issue #537)", () => {
  test("move targets /backlog/:id/move, not the bare /backlog/:id update endpoint", async () => {
    const text = await readBin();
    const body = cmdBacklogBody(text);

    // The active _patch call inside cmd_backlog's move branch must build a
    // path that ends in /move. The variable name for the id is "$1" after
    // the shift.
    assert.match(
      body,
      /_patch\s+"\/backlog\/\$1\/move"/,
      "backlog move must PATCH /backlog/<id>/move (the lane-transition route)",
    );

    // And it must NOT PATCH the bare /backlog/<id> path — that would route
    // to updateItem, which silently ignores `lane` and returns ok:true.
    assert.doesNotMatch(
      body,
      /_patch\s+"\/backlog\/\$1"\s+"\{\\"lane\\":/,
      "backlog move must NOT PATCH the bare /backlog/<id> endpoint (silently no-ops the lane field)",
    );
  });

  test("move payload uses the `lane` field (not `to`)", async () => {
    const text = await readBin();
    const body = cmdBacklogBody(text);

    // The move handler at src/api/backlog.ts:141 expects `{lane}`. A
    // followup comment on #537 noted that several callers had guessed
    // `{to: "<lane>"}`, which the handler treats as missing-lane (400).
    assert.match(
      body,
      /_patch\s+"\/backlog\/\$1\/move"\s+"\{\\"lane\\":\\"\$2\\"\}"/,
      'backlog move must send {"lane":"<lane>"} as the JSON body',
    );

    assert.doesNotMatch(
      body,
      /"\{\\"to\\":/,
      'backlog move must NOT send {"to":...} — the API expects {"lane":...}',
    );
  });

  test("move still validates that both <id> and <lane> are supplied", async () => {
    const text = await readBin();
    const body = cmdBacklogBody(text);

    // The argument-count guard is what gives operators a useful error
    // when they forget the lane (instead of a curl-level 400). Keep it.
    assert.match(
      body,
      /\[\s*"\$#"\s+-ge\s+2\s*\][\s\S]*?need <id> <lane>/,
      "backlog move must reject missing positional args with a usage hint",
    );
  });

  test("help text documents the #537 fix and the {lane:...} payload contract", async () => {
    const text = await readBin();
    // Operators reading the script must see that the move subcommand
    // hits the /move sub-route and that the payload field is `lane`.
    assert.match(
      text,
      /#537|issue 537|issue #537/i,
      "Usage block must reference issue #537 so readers can find the rationale",
    );
    assert.match(
      text,
      /PATCH\s+\/backlog\/:id\/move/,
      "Usage block must document the actual move route shape",
    );
  });
});
