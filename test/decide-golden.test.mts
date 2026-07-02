/**
 * Golden-plan regression suite for `scripts/autopilot/decide.py` (issue #2713).
 *
 * The synthetic suites (test/autopilot-decide.test.mts and siblings) assert
 * *specific actions* over hand-authored fixtures. This suite is the missing
 * regression layer: verbatim `Plan` snapshots over REAL captured production
 * `(state, candidates, events)` triples, so a change to the L2 decision brain
 * (a T3 file that auto-merges on QA pass) diffs against the whole plan the
 * real input distribution produces — unexpected extra/missing actions, reason
 * drift, and event-emission changes all fail loudly.
 *
 * Reproducibility contract (the issue's precondition):
 *   - `now` is injected: `decide.py --now=<epoch> decide ...` freezes the
 *     decision clock (production behavior unchanged when the flag is absent —
 *     main() supplies real wall-clock time).
 *   - Env is pinned: HYDRA_AUTOPILOT_SUBAGENT_MAX_WALL_SECONDS is cleared
 *     (default 3600 applies), HYDRA_AUTOPILOT_EMIT_TURN_EVENTS is cleared
 *     (no Redis XADD), HYDRA_AUTOPILOT_RUN_END_POST=off (no run-end POST).
 *   - Assertions are on the returned Plan ONLY — decide() mutates `state` in
 *     place (slot_history, failure_log, signal stamps), so post-call state is
 *     deliberately never asserted. The CLI also write-backs a turn bump into
 *     the state file, which is why each run copies the fixture state into a
 *     tempdir first (the checked-in fixture must never be rewritten).
 *
 * Fixture layout — one directory per captured triple under
 * test/fixtures/decide-golden/<name>/:
 *   state.json          real production autopilot state snapshot
 *   candidates.json     real /api/anchor/candidates payload
 *   events.json         events list captured with the turn
 *   meta.json           { now: <frozen epoch>, capturedAt, note }
 *   expected-plan.json  the verbatim serialized Plan decide.py must emit
 *
 * Regenerating goldens after an INTENTIONAL decide.py behavior change:
 *   UPDATE_DECIDE_GOLDEN=1 node --experimental-strip-types --test \
 *     --test-force-exit test/decide-golden.test.mts
 * then review the golden diff like any other code change.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DECIDE = join(REPO_ROOT, "scripts", "autopilot", "decide.py");
const GOLDEN_ROOT = join(REPO_ROOT, "test", "fixtures", "decide-golden");
const UPDATE_GOLDEN = process.env.UPDATE_DECIDE_GOLDEN === "1";

/** Pinned environment: every ambient input decide.py could read is fixed. */
function pinnedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Pin the silent-wedge subagent wall to the built-in default (3600s) —
  // a host-set override would change wait_or_reap emission.
  delete env.HYDRA_AUTOPILOT_SUBAGENT_MAX_WALL_SECONDS;
  // Keep the CLI a pure JSON emitter: no Redis XADD of turn events...
  delete env.HYDRA_AUTOPILOT_EMIT_TURN_EVENTS;
  // ...and no run-end POST when a fixture's plan terminates (#1352).
  env.HYDRA_AUTOPILOT_RUN_END_POST = "off";
  // Guard against string-hash-order leaking into serialized output.
  env.PYTHONHASHSEED = "0";
  return env;
}

/**
 * Replay one captured triple through the decide CLI with a frozen clock.
 * Copies state.json to a tempdir first — the CLI persists a turn-counter
 * bump (#1769) into the state file it is given, and the checked-in fixture
 * must stay byte-identical across runs.
 */
function replayFixture(dir: string): { raw: string; plan: any } {
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8"));
  assert.equal(typeof meta.now, "number", `${dir}/meta.json must pin a numeric 'now'`);
  const tmp = mkdtempSync(join(tmpdir(), "decide-golden-"));
  try {
    const stateCopy = join(tmp, "state.json");
    copyFileSync(join(dir, "state.json"), stateCopy);
    const r = spawnSync(
      "python3",
      [
        DECIDE,
        `--now=${meta.now}`,
        "decide",
        stateCopy,
        join(dir, "candidates.json"),
        join(dir, "events.json"),
      ],
      { encoding: "utf-8", env: pinnedEnv() },
    );
    if (r.status !== 0) {
      throw new Error(`decide.py decide exited ${r.status}: ${r.stderr}`);
    }
    return { raw: r.stdout, plan: JSON.parse(r.stdout) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const fixtureNames = readdirSync(GOLDEN_ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

describe("decide.py — golden-plan regression suite (issue #2713)", () => {
  test("fixture corpus is present (a handful of real production triples)", () => {
    assert.ok(
      fixtureNames.length >= 3,
      `expected at least 3 golden fixtures under test/fixtures/decide-golden/, found ${fixtureNames.length}`,
    );
    for (const name of fixtureNames) {
      for (const f of ["state.json", "candidates.json", "events.json", "meta.json"]) {
        // Throws (fails the test) if the file is missing/unreadable.
        JSON.parse(readFileSync(join(GOLDEN_ROOT, name, f), "utf-8"));
      }
    }
  });

  for (const name of fixtureNames) {
    test(`golden plan: ${name}`, () => {
      const dir = join(GOLDEN_ROOT, name);
      const { plan } = replayFixture(dir);
      const goldenPath = join(dir, "expected-plan.json");
      if (UPDATE_GOLDEN) {
        writeFileSync(goldenPath, JSON.stringify(plan) + "\n");
        return;
      }
      const expected = JSON.parse(readFileSync(goldenPath, "utf-8"));
      // Verbatim whole-plan snapshot: actions, reasons, debug, events,
      // run_id, turn — everything the Plan serializes.
      assert.deepStrictEqual(
        plan,
        expected,
        `decide.py plan drifted from golden for fixture '${name}' — if the ` +
          `change is intentional, regenerate with UPDATE_DECIDE_GOLDEN=1 and ` +
          `review the golden diff`,
      );
    });
  }

  test("replay is deterministic: same triple + same frozen now → byte-identical plan", () => {
    // Guards the purity precondition itself — a new wall-clock / env / RNG
    // read inside decide() shows up here before it can flake the goldens.
    const dir = join(GOLDEN_ROOT, fixtureNames[0]);
    const a = replayFixture(dir);
    const b = replayFixture(dir);
    assert.equal(a.raw, b.raw, "two replays of the same fixture diverged — decide() gained a nondeterministic input");
  });

  test("--now with a non-integer value exits 2 with a loud error", () => {
    const dir = join(GOLDEN_ROOT, fixtureNames[0]);
    const r = spawnSync(
      "python3",
      [DECIDE, "--now=bogus", "decide", join(dir, "state.json")],
      { encoding: "utf-8", env: pinnedEnv() },
    );
    assert.equal(r.status, 2);
    assert.match(r.stderr, /invalid --now value/);
  });

  test("checked-in fixture state files are never rewritten by a replay", () => {
    const dir = join(GOLDEN_ROOT, fixtureNames[0]);
    const before = readFileSync(join(dir, "state.json"), "utf-8");
    replayFixture(dir);
    const after = readFileSync(join(dir, "state.json"), "utf-8");
    assert.equal(after, before, "replayFixture leaked the CLI turn-bump write-back into the checked-in fixture");
  });
});
