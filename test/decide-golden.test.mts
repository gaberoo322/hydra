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
  chmodSync,
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
  // ...and production reads: an ambient replay switch would make the
  // accessor raise on the fixtures' partial snapshots (#5083).
  delete env.HYDRA_AUTOPILOT_SNAPSHOT_REPLAY;
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

describe("decide CLI persists through the Run Ledger (#5074)", () => {
  test("INV-6/8: decide CLI persists through the ledger; crash before replace leaves the prior document intact", () => {
    const dir = mkdtempSync(join(tmpdir(), "decide-ledger-"));
    try {
      const g = join(GOLDEN_ROOT, "idle-triage-sweep");
      const meta = JSON.parse(readFileSync(join(g, "meta.json"), "utf-8"));
      const run = (statePath: string, env: Record<string, string> = {}) =>
        spawnSync(
          "python3",
          [DECIDE, `--now=${meta.now}`, "decide", statePath, join(g, "candidates.json"), join(g, "events.json")],
          {
            encoding: "utf-8",
            env: { PATH: process.env.PATH ?? "", HYDRA_AUTOPILOT_RUN_END_POST: "off", ...env },
          },
        );
      const sp = join(dir, "state.json");
      writeFileSync(sp, readFileSync(join(g, "state.json")));
      const before = JSON.parse(readFileSync(sp, "utf-8"));
      const ok = run(sp);
      assert.equal(ok.status, 0, ok.stderr);
      const after = JSON.parse(readFileSync(sp, "utf-8"));
      assert.equal(after.turn, before.turn + 1);
      assert.equal(readdirSync(dir).filter((f) => f.startsWith(".")).length, 0, "no stray temp files");
      assert.ok(readFileSync(sp, "utf-8").endsWith("\n"));

      // Crash seam (fires on the FIRST persist, the pre-decide turn bump): a
      // simulated crash is fatal (exit 1) and the prior document stays
      // byte-identical.
      const sp2 = join(dir, "state2.json");
      writeFileSync(sp2, readFileSync(join(g, "state.json")));
      const bytes = readFileSync(sp2, "utf-8");
      const crashed = run(sp2, { HYDRA_RUN_LEDGER_TEST_CRASH: "before-replace" });
      // The seam raises a RuntimeError (a true process crash, not an OSError),
      // so the CLI exits non-zero with the simulated-crash traceback.
      assert.equal(crashed.status, 1);
      assert.match(crashed.stderr, /SimulatedCrash: \[run-ledger\] simulated crash before replace/);
      assert.equal(readFileSync(sp2, "utf-8"), bytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("decide CLI Run Ledger seam: persistence + load contract (#5074 INV-5/6/7)", () => {
  const FIXTURE = join(GOLDEN_ROOT, "idle-triage-sweep");
  const FORWARD_FIX = join(GOLDEN_ROOT, "red-pr-forward-fix");

  /** Run the decide CLI over a mutated copy of a golden state; return result + parsed state after. */
  function runCli(fixtureDir: string, mutate: (s: Record<string, unknown>) => void = () => {}) {
    const dir = mkdtempSync(join(tmpdir(), "decide-seam-"));
    try {
      const meta = JSON.parse(readFileSync(join(fixtureDir, "meta.json"), "utf-8"));
      const before = JSON.parse(readFileSync(join(fixtureDir, "state.json"), "utf-8"));
      mutate(before);
      const sp = join(dir, "state.json");
      writeFileSync(sp, JSON.stringify(before, null, 2));
      const seeded = JSON.parse(readFileSync(sp, "utf-8"));
      const r = spawnSync(
        "python3",
        [DECIDE, `--now=${meta.now}`, "decide", sp, join(fixtureDir, "candidates.json"), join(fixtureDir, "events.json")],
        { encoding: "utf-8", env: pinnedEnv() },
      );
      return { r, before: seeded, after: JSON.parse(readFileSync(sp, "utf-8")) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("INV-5(a): a selector mutation of a decide-owned key persists through the decide CLI", () => {
    const { r, before, after } = runCli(FORWARD_FIX);
    assert.equal(r.status, 0, r.stderr);
    assert.notDeepEqual(after.red_forward_fix_attempts, before.red_forward_fix_attempts ?? {});
    assert.ok(Object.keys(after.red_forward_fix_attempts).length > 0);
  });

  test("INV-6: a crash on the post-decide persist leaves the bumped-turn document with none of decide()'s mutations", () => {
    const dir = mkdtempSync(join(tmpdir(), "decide-seam-crash-"));
    try {
      const meta = JSON.parse(readFileSync(join(FORWARD_FIX, "meta.json"), "utf-8"));
      const sp = join(dir, "state.json");
      writeFileSync(sp, readFileSync(join(FORWARD_FIX, "state.json")));
      const before = JSON.parse(readFileSync(sp, "utf-8"));
      const r = spawnSync(
        "python3",
        [DECIDE, `--now=${meta.now}`, "decide", sp, join(FORWARD_FIX, "candidates.json"), join(FORWARD_FIX, "events.json")],
        { encoding: "utf-8", env: { ...pinnedEnv(), HYDRA_RUN_LEDGER_TEST_CRASH: "before-replace-2nd" } },
      );
      assert.equal(r.status, 1);
      assert.match(r.stderr, /SimulatedCrash: \[run-ledger\] simulated crash before replace/);
      const after = JSON.parse(readFileSync(sp, "utf-8"));
      // The first (turn-bump) persist landed; the second (decide-owned) did not.
      assert.equal(after.turn, before.turn + 1);
      assert.deepEqual(after.red_forward_fix_attempts ?? {}, before.red_forward_fix_attempts ?? {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("INV-5(b) sibling pin: an untouched run writes no decide-owned key beyond the turn bump", () => {
    const { r, before, after } = runCli(FIXTURE);
    assert.equal(r.status, 0, r.stderr);
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
      (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
    );
    assert.deepEqual(changed, ["turn"]);
  });

  test("INV-6: an OSError on persist degrades to ONE loud stderr line and the turn still emits a plan (exit 0)", (t) => {
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      t.skip("root ignores directory permissions");
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "decide-ro-"));
    try {
      const meta = JSON.parse(readFileSync(join(FIXTURE, "meta.json"), "utf-8"));
      const sp = join(dir, "state.json");
      writeFileSync(sp, readFileSync(join(FIXTURE, "state.json")));
      const bytes = readFileSync(sp, "utf-8");
      chmodSync(dir, 0o500); // mkstemp in the state's directory now raises PermissionError
      const r = spawnSync(
        "python3",
        [DECIDE, `--now=${meta.now}`, "decide", sp, join(FIXTURE, "candidates.json"), join(FIXTURE, "events.json")],
        { encoding: "utf-8", env: pinnedEnv() },
      );
      chmodSync(dir, 0o700);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /ledger persist to .* failed .*turn-counter bump \(#1769\) NOT persisted this turn/);
      assert.ok(JSON.parse(r.stdout).actions, "a plan is still emitted");
      assert.equal(readFileSync(sp, "utf-8"), bytes, "the prior document is untouched");
    } finally {
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("INV-7: previously tolerated legacy shapes now exit 1 naming key + expected + actual (no catch around load)", () => {
    const cases: Array<[string, unknown, RegExp]> = [
      ["research_force_counter", 0, /type mismatch for research_force_counter: expected object, got int/],
      ["dev_resume_pending", null, /type mismatch for dev_resume_pending: expected array, got null/],
      ["dev_target_resume_inflight", "781401d5-t3-dev_target", /type mismatch for dev_target_resume_inflight: expected object, got str/],
    ];
    for (const [key, value, pattern] of cases) {
      const { r } = runCli(FIXTURE, (s) => {
        s[key] = value;
      });
      assert.equal(r.status, 1, `${key}=${JSON.stringify(value)} must abort the turn loudly`);
      assert.match(r.stderr, pattern);
      assert.equal(r.stdout, "", "no plan is emitted when the ledger load fails");
    }
  });

  test("INV-7 sibling pin: the four `any` blob rows are intentionally unvalidated (malformed blobs still load)", () => {
    const { r } = runCli(FIXTURE, (s) => {
      for (const k of ["usage_eligibility", "emergency_brake", "target_risk_surface", "class_stats"]) {
        s[k] = "not-an-object";
      }
    });
    assert.equal(r.status, 0, r.stderr);
  });

  test("INV-7 sibling pin: the well-typed shapes of the same keys load and exit 0", () => {
    const { r } = runCli(FIXTURE, (s) => {
      s.research_force_counter = {};
      s.dev_resume_pending = [];
      s.dev_target_resume_inflight = {};
    });
    assert.equal(r.status, 0, r.stderr);
  });
});
