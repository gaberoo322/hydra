/**
 * Pins the root-cause fix for issue #4518: `claude -p` (print mode) waits at
 * most CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS for background tasks after the
 * parent turn ends, then terminates the process — and every in-process
 * background dev_orch/dev_target child with it. At the harness default
 * (600000ms) six consecutive dev dispatches at #4510 died with uncommitted
 * work. The unit now sets the ceiling to decide.py's silent-wedge cap
 * (`subagent_max_wall_seconds`, default 3600s) — the two numbers both mean
 * "how long may a child run unattended" and must stay equal.
 *
 * Pure `fs` reads only — no systemd invocation, no python spawn.
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const unitText = readFileSync(
  path.join(REPO_ROOT, "scripts/systemd/hydra-autopilot.service"),
  "utf8",
);
const decideText = readFileSync(
  path.join(REPO_ROOT, "scripts/autopilot/decide.py"),
  "utf8",
);

/** Every live (uncommented) Environment= assignment of the ceiling var. */
function ceilingAssignments(): string[] {
  return unitText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => !l.startsWith("#"))
    .map((l) => /^Environment=CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1]!.trim());
}

/** The literal default returned by decide.py's _subagent_max_wall_seconds. */
function silentWedgeDefaultSeconds(): number {
  const fn = /def _subagent_max_wall_seconds\([\s\S]*?\n {4}return (\d+)\n/.exec(
    decideText,
  );
  assert.ok(fn, "could not locate _subagent_max_wall_seconds' default return");
  return Number(fn[1]);
}

describe("hydra-autopilot.service print-mode BG wait ceiling (issue #4518)", () => {
  test("the BG wait ceiling is set exactly once in the [Service] environment", () => {
    assert.equal(ceilingAssignments().length, 1);
  });

  test("the BG wait ceiling is never 0 (indefinite) and never the harness default 600000", () => {
    const [value] = ceilingAssignments();
    assert.notEqual(value, "0", "0 lets a wedged child pin the unit to RuntimeMaxSec (9h)");
    assert.notEqual(value, "600000", "the harness default kills every dev child at ~10 min");
    assert.match(value!, /^\d+$/, "must be a bare integer millisecond count");
  });

  test("a background dev child is not terminated before decide.py's silent-wedge cap", () => {
    const [value] = ceilingAssignments();
    const capMs = silentWedgeDefaultSeconds() * 1000;
    assert.equal(capMs, 3_600_000, "decide.py's default silent-wedge cap moved — re-align the unit");
    assert.equal(
      Number(value),
      capMs,
      "the print-mode ceiling and the silent-wedge cap must be one number",
    );
  });

  test("the unit comment names the coupling to subagent_max_wall_seconds", () => {
    assert.match(unitText, /subagent_max_wall_seconds/);
    assert.match(unitText, /HYDRA_AUTOPILOT_SUBAGENT_MAX_WALL_SECONDS/);
  });
});
