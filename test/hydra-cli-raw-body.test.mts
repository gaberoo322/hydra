/**
 * Regression tests for the `hydra raw` CLI body binding (issue #779).
 *
 * Before the fix (bin/hydra cmd_raw):
 *   - `cmd_raw` only bound the request body from the `--json` flag. A
 *     POSITIONAL body argument (`hydra raw POST /x '{"a":1}'`) fell into the
 *     `*) shift` arm of the argv loop and was silently discarded. curl then
 *     POSTed an EMPTY body.
 *   - All 14 `hydra raw POST` call-sites across docs/operator-playbooks/ use
 *     the positional form and ZERO use --json, so every `dev_target`
 *     state-sync write (`/cycle/register`, `/metrics/record`,
 *     `/events/publish`, ...) arrived with no body and 400'd with
 *     "Missing cycleId" — silently dropping every Claude target build from
 *     `hydra:cycle:*` / `/api/metrics` / `/api/cycle/history`.
 *   - The original issue's "multi-line JSON mangling" diagnosis was WRONG:
 *     reproduced live, single-line positional bodies failed identically and
 *     multi-line bodies WITH --json succeeded. The discriminator is the
 *     flag, not the line count — curl -d forwards newlines fine.
 *
 * After the fix (bin/hydra):
 *   - `cmd_raw` binds the body from EITHER `--json '<body>'` OR the first
 *     positional argument.
 *   - `--json` keeps working (backward-compatible).
 *   - A bodyless POST (e.g. /merge/unlock) is still valid — `POST` only
 *     attaches a body when `$body` is non-empty.
 *
 * These tests are file-level text assertions on `bin/hydra`, matching the
 * pattern in test/hydra-cli-backlog-move.test.mts (issue #537) and
 * test/hydra-cli-cycle-reality.test.mts (issue #448). They do NOT spawn the
 * CLI because it depends on a live API on port 4000, which CI cannot assume.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const BIN_PATH = new URL("../bin/hydra", import.meta.url);

async function readBin(): Promise<string> {
  return readFile(BIN_PATH, "utf8");
}

/**
 * Extract the body of the `cmd_raw()` shell function. Anchoring assertions
 * inside this function prevents stray `--json` / `body=` handling elsewhere
 * in the script from accidentally satisfying them.
 */
function extractCmdRaw(text: string): string {
  const match = text.match(/cmd_raw\(\)[\s\S]*?\n\}/);
  if (!match) throw new Error("cmd_raw() not found in bin/hydra");
  return match[0];
}

/**
 * Extract just the argv-parsing `case "$1" in ... esac` block inside
 * cmd_raw. Anchoring on `case "$1" in` (actual code) avoids matching
 * `*) shift` mentions inside the explanatory comment above the loop.
 */
function extractArgvCase(cmdRaw: string): string {
  const match = cmdRaw.match(/case\s+"\$1"\s+in[\s\S]*?esac/);
  if (!match) {
    throw new Error('argv `case "$1" in` block not found in cmd_raw()');
  }
  return match[0];
}

describe("hydra CLI: raw body binding (issue #779)", () => {
  test("cmd_raw binds the body from a positional argument, not only --json", async () => {
    const text = await readBin();
    const argvCase = extractArgvCase(extractCmdRaw(text));

    // The --json flag binding must still exist (backward compatibility).
    assert.match(
      argvCase,
      /--json\)\s*body="\$2"/,
      "cmd_raw must still bind body from the --json flag",
    );

    // The fix: the catch-all argv arm must assign the positional argument to
    // body when body is still empty — NOT a bare `*) shift` that drops it.
    const fallthroughArm = argvCase.match(/\*\)[\s\S]*?;;/);
    assert.ok(fallthroughArm, "cmd_raw must define a `*)` catch-all argv arm");
    assert.match(
      fallthroughArm![0],
      /body="\$1"/,
      "cmd_raw's catch-all argv arm must capture a positional body (body=\"$1\"), " +
        "not silently shift it away — that was the empty-POST bug",
    );
  });

  test("the catch-all argv arm is no longer a bare `*) shift` that drops the body", async () => {
    const text = await readBin();
    const argvCase = extractArgvCase(extractCmdRaw(text));
    const fallthroughArm = argvCase.match(/\*\)[\s\S]*?;;/);
    assert.ok(fallthroughArm, "cmd_raw must define a `*)` catch-all argv arm");
    // The exact pre-fix bug shape: `*) shift ;;` with nothing capturing $1.
    assert.doesNotMatch(
      fallthroughArm![0],
      /\*\)\s*shift\s*;;/,
      "cmd_raw must not silently `*) shift` the positional body away (issue #779 empty-POST bug)",
    );
  });

  test("POST only attaches a body when one is present (bodyless POST stays valid)", async () => {
    const text = await readBin();
    const body = extractCmdRaw(text);
    // /merge/unlock and similar bodyless endpoints must still work: the POST
    // arm must guard on a non-empty body before passing it to _post.
    assert.match(
      body,
      /POST\)\s+if\s+\[\s*-n\s+"\$body"\s*\]\s*;\s*then\s+_post\s+"\$path"\s+"\$body";\s+else\s+_post\s+"\$path";/,
      "POST must attach the body only when non-empty, else POST bodyless",
    );
  });

  test("bin/hydra references issue #779 so readers can find the rationale", async () => {
    const text = await readBin();
    assert.match(
      text,
      /#779|issue 779|issue #779/i,
      "bin/hydra must reference issue #779 so readers can find the rationale",
    );
  });
});
