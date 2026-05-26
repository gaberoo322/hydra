/**
 * Regression test for issue #410 — scripts/autopilot/args-parse.sh.
 *
 * /hydra-autopilot accepts both env-var and slash-arg invocation forms.
 * args-parse.sh translates recognised slash args into HYDRA_AUTOPILOT_*
 * env vars, with these invariants:
 *
 *   1. Each documented flag (and alias) is parsed into the correct env var.
 *   2. Args win over env vars (explicit > implicit).
 *   3. Unknown args warn but DO NOT abort (so trailing free-form tokens
 *      like `focus=codex-cli-removal` pass through to the operator log).
 *   4. With no args and no env, bootstrap.sh emits the documented defaults.
 *
 * Each assertion is pinned via end-to-end behaviour: we invoke
 * bootstrap.sh and read the resulting state.json `limits`, which is the
 * single observable contract the rest of the autopilot loop depends on.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPTS = join(REPO_ROOT, "scripts", "autopilot");

interface Tmp { dir: string; state: string; heartbeat: string; log: string }

function makeTempState(): Tmp {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-args-test-"));
  return {
    dir,
    state: join(dir, "state.json"),
    heartbeat: join(dir, "heartbeat.txt"),
    log: join(dir, "nightly.log"),
  };
}

interface BootstrapResult { status: number; stdout: string; stderr: string; limits?: Record<string, unknown> }

/**
 * Run bootstrap.sh with the given env and argv, isolated via
 * HYDRA_AUTOPILOT_STATE / HEARTBEAT / LOG so the test does not stomp the
 * live /tmp/hydra-autopilot-state.json or POST a bogus run to the live
 * /api/autopilot/run-start endpoint (the 2026-05-26 dashboard
 * ghost-outage root cause).
 */
function runBootstrap(env: Record<string, string>, argv: string[], tmp: Tmp): BootstrapResult {
  const isolatedEnv = {
    HYDRA_AUTOPILOT_STATE: tmp.state,
    HYDRA_AUTOPILOT_HEARTBEAT: tmp.heartbeat,
    HYDRA_AUTOPILOT_LOG: tmp.log,
  };
  const result = spawnSync(join(SCRIPTS, "bootstrap.sh"), argv, {
    env: { ...process.env, ...isolatedEnv, ...env, PATH: process.env.PATH ?? "" },
    encoding: "utf-8",
  });
  const out: BootstrapResult = {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
  if (out.status === 0 && existsSync(tmp.state)) {
    const raw = readFileSync(tmp.state, "utf-8");
    out.limits = JSON.parse(raw).limits;
  }
  return out;
}

describe("scripts/autopilot/args-parse.sh — slash-arg parsing", () => {
  test("no args, no env: bootstrap emits documented defaults", () => {
    const tmp = makeTempState();
    try {
      // Pin unattended explicitly so this test's expectation is stable
      // regardless of whether the test harness stdin is a TTY (it isn't,
      // in node:test, but we don't want to depend on that).
      const r = runBootstrap({ HYDRA_AUTOPILOT_UNATTENDED: "true" }, [], tmp);
      assert.equal(r.status, 0, `bootstrap failed: ${r.stderr}`);
      assert.deepEqual(r.limits, {
        token_budget: 2000000,
        wall_clock_max_sec: 28800,
        idle_drain_turns: 5,
        scope: "all",
        subagent_max_tokens: 400000,
        subagent_hard_max_tokens: 800000,
        unattended: true,
        // issue #434 — schema-version handshake. Bumped in lockstep with the
        // playbook's HYDRA_AUTOPILOT_PLAYBOOK_SCHEMA marker.
        schema_version: 2,
        // issue #532 — tool-scout cost-cap. Defaults: $50/day cap, 4% slice.
        // Operators override via HYDRA_AUTOPILOT_DAILY_SPEND_CAP_USD /
        // HYDRA_AUTOPILOT_SCOUT_COST_SHARE.
        daily_spend_cap_usd: 50,
        scout_cost_share: 0.04,
      });
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("--scope= is parsed into HYDRA_AUTOPILOT_SCOPE", () => {
    const tmp = makeTempState();
    try {
      const r = runBootstrap({}, ["--scope=orch-only"], tmp);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.limits?.scope, "orch-only");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("--tokens= is parsed into HYDRA_AUTOPILOT_TOKEN_BUDGET", () => {
    const tmp = makeTempState();
    try {
      const r = runBootstrap({}, ["--tokens=750000"], tmp);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.limits?.token_budget, 750000);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("--token-budget= is an alias of --tokens=", () => {
    const tmp = makeTempState();
    try {
      const r = runBootstrap({}, ["--token-budget=123456"], tmp);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.limits?.token_budget, 123456);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("--max-sec= is parsed into HYDRA_AUTOPILOT_MAX_SEC", () => {
    const tmp = makeTempState();
    try {
      const r = runBootstrap({}, ["--max-sec=3600"], tmp);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.limits?.wall_clock_max_sec, 3600);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("--max-seconds= is an alias of --max-sec=", () => {
    const tmp = makeTempState();
    try {
      const r = runBootstrap({}, ["--max-seconds=900"], tmp);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.limits?.wall_clock_max_sec, 900);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("--idle-turns= is parsed into HYDRA_AUTOPILOT_IDLE_TURNS", () => {
    const tmp = makeTempState();
    try {
      const r = runBootstrap({}, ["--idle-turns=9"], tmp);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.limits?.idle_drain_turns, 9);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("--subagent-soft= / --subagent-hard= are parsed into the soft/hard caps", () => {
    const tmp = makeTempState();
    try {
      const r = runBootstrap(
        {},
        ["--subagent-soft=150000", "--subagent-hard=300000"],
        tmp,
      );
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.limits?.subagent_max_tokens, 150000);
      assert.equal(r.limits?.subagent_hard_max_tokens, 300000);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("args win over env vars (explicit overrides implicit)", () => {
    const tmp = makeTempState();
    try {
      const r = runBootstrap(
        {
          HYDRA_AUTOPILOT_SCOPE: "target-only",
          HYDRA_AUTOPILOT_TOKEN_BUDGET: "100000",
          HYDRA_AUTOPILOT_MAX_SEC: "600",
        },
        ["--scope=orch-only", "--tokens=500000", "--max-sec=1800"],
        tmp,
      );
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.limits?.scope, "orch-only");
      assert.equal(r.limits?.token_budget, 500000);
      assert.equal(r.limits?.wall_clock_max_sec, 1800);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("env wins when no matching arg is supplied", () => {
    // Sanity check that absent slash args fall through to env — this
    // is what makes systemd Environment= lines still effective.
    const tmp = makeTempState();
    try {
      const r = runBootstrap(
        { HYDRA_AUTOPILOT_SCOPE: "target-only" },
        ["--tokens=999999"],
        tmp,
      );
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.limits?.scope, "target-only", "env scope should persist");
      assert.equal(r.limits?.token_budget, 999999, "arg tokens should apply");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("unknown arg warns but does not abort (free-form tokens tolerated)", () => {
    const tmp = makeTempState();
    try {
      const r = runBootstrap(
        {},
        ["--scope=orch-only", "focus=codex-cli-removal", "--bogus=x"],
        tmp,
      );
      assert.equal(r.status, 0, `bootstrap should not abort on unknown args, stderr=${r.stderr}`);
      // Both unknown tokens should be warned individually.
      assert.match(r.stderr, /\[autopilot\] WARN: unknown arg focus=codex-cli-removal/);
      assert.match(r.stderr, /\[autopilot\] WARN: unknown arg --bogus=x/);
      // The recognised arg still took effect.
      assert.equal(r.limits?.scope, "orch-only");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("invalid --scope= value is rejected by bootstrap's validator", () => {
    // args-parse.sh is intentionally a translation layer only; semantic
    // validation lives in bootstrap.sh so both forms share one
    // enforcement point. This pins that the validator still fires
    // when the bad value arrived via slash arg.
    const tmp = makeTempState();
    try {
      const r = runBootstrap({}, ["--scope=not-a-real-scope"], tmp);
      assert.notEqual(r.status, 0);
      assert.match(r.stdout + r.stderr, /FATAL.*SCOPE.*invalid/);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});

describe("scripts/autopilot/args-parse.sh — executable hygiene", () => {
  test("args-parse.sh exists, has shebang, is executable", () => {
    const path = join(SCRIPTS, "args-parse.sh");
    assert.ok(existsSync(path), "args-parse.sh missing");
    const first = readFileSync(path, "utf-8").split("\n", 1)[0];
    assert.match(first, /^#!/, "args-parse.sh missing shebang");
    const r = spawnSync("stat", ["-c", "%a", path], { encoding: "utf-8" });
    assert.equal(r.status, 0);
    assert.match((r.stdout ?? "").trim(), /^[7][0-9]{2}$/);
  });
});
