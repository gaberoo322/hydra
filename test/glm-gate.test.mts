/**
 * Unit tests for the GLM dev-drainer's gate phase (issue #4682, ADR-0040
 * Decisions 1–3 — the "TypeScript owns the tick" tracer bullet).
 *
 * Two layers are pinned here:
 *
 *   - `src/glm/gate.ts` — the pure `decideGate` core over every case the
 *     issue enumerates (paused / cap-exhausted-at-exactly-dailyCap / future
 *     quota block / stale quota block / able, plus the check-precedence
 *     pins), and `runGate`'s orchestration with EVERY dependency injected:
 *     no live Redis, no filesystem, no clock. This is the port of the bash
 *     decision core the whole-script groups in test/glm-drainer-loop.test.mts
 *     could only exercise through a DRY_RUN process spawn (#4679: what
 *     replaces a ported phase's fake-binary bash tests is decided after this
 *     tracer lands; until then the gate slice ports its decision core to
 *     TypeScript unit tests and leaves the whole-script groups in place).
 *   - `src/glm/drainer-config.ts` — the env-name/defaults contract shared
 *     with `scripts/glm/drainer-loop.sh`, and the `$CAP_DIR` state-file path
 *     formats both layers must agree on mid-migration (ADR-0040 Decision 3:
 *     behaviour-preserving — a live quota block survives the cut-over tick).
 *
 * New top-level describes with trivial lifecycles — no shared Redis seam is
 * opened anywhere in this file (the injected `getAutopilotPaused` stubs make
 * that unnecessary), so nothing here piggybacks a sibling suite's teardown.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

import {
  decideGate,
  runGate,
  type GateDeps,
  type GateOutcome,
} from "../src/glm/gate.ts";
import { runDriverMode, type DriverDeps } from "../src/glm/drainer-driver.ts";
import {
  buildDrainerArgs,
  buildGlmEnv,
  preflightBeforePr,
  runGlmClaude,
} from "../src/glm/drainer-runner.ts";
import { setGlmDrainerHeartbeat } from "../src/redis/autopilot.ts";
import { defaultClaudeSpawn } from "../src/claude-cli/exec.ts";
import {
  dailyCapFilePath,
  epochToIsoUtc,
  quotaBlockFilePath,
  readDrainerConfig,
  todayUtc,
} from "../src/glm/drainer-config.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DRAINER_LOOP = join(REPO_ROOT, "scripts", "glm", "drainer-loop.sh");

function dirname(p: string): string {
  return p.slice(0, Math.max(p.lastIndexOf("/"), 0));
}

/** A fixed "now" (2027-01-15T00:00:00Z) so every case is deterministic. */
const NOW = 1_799_971_200;

function makeConfig(over: Partial<ReturnType<typeof readDrainerConfig>> = {}) {
  return { ...readDrainerConfig({}), capDir: "/gate-test-cap", ...over };
}

/**
 * Injectable deps for runGate: an in-memory state-file map, a recording
 * heartbeat, a recording pause seam, a recording log, and a fixed clock.
 */
function makeGateDeps(over: Partial<GateDeps> & { files?: Record<string, string> } = {}) {
  const files: Record<string, string> = over.files ?? {};
  const removed: string[] = [];
  const heartbeatCalls: number[] = [];
  const logs: string[] = [];
  const deps: GateDeps = {
    getAutopilotPaused: async () => ({ paused: false }),
    setGlmDrainerHeartbeat: async (nowMs?: number) => {
      heartbeatCalls.push(nowMs ?? -1);
      return { ok: true };
    },
    readFile: (path) => files[path] ?? "",
    removeFile: (path) => {
      removed.push(path);
      delete files[path];
    },
    now: () => NOW,
    config: makeConfig(),
    log: (message) => {
      logs.push(message);
    },
    ...over,
  };
  return { deps, files, removed, heartbeatCalls, logs };
}

// ---------------------------------------------------------------------------
// decideGate — the pure core
// ---------------------------------------------------------------------------

describe("src/glm/gate.ts — decideGate pure decision core (issue #4682)", () => {
  const base = {
    paused: false,
    capCount: 0,
    dailyCap: 5,
    quotaBlockedUntil: null as number | null,
    now: NOW,
  };

  test("paused => skip with reason paused", () => {
    assert.deepEqual(decideGate({ ...base, paused: true }), {
      able: false,
      reason: "paused",
    });
  });

  test("paused wins over cap-exhausted when both hold (bash check-order pin)", () => {
    // main() checked paused first, then cap, then quota — when several
    // exclusions hold at once the operator saw the FIRST one. Order is
    // load-bearing; this pins it.
    const d = decideGate({ ...base, paused: true, capCount: 99, quotaBlockedUntil: NOW + 1000 });
    assert.deepEqual(d, { able: false, reason: "paused" });
  });

  test("cap exhausted at EXACTLY dailyCap (count == cap, the -ge boundary)", () => {
    assert.deepEqual(decideGate({ ...base, capCount: 5, dailyCap: 5 }), {
      able: false,
      reason: "cap-exhausted",
    });
  });

  test("cap below dailyCap => not exhausted (count 4 of 5)", () => {
    assert.deepEqual(decideGate({ ...base, capCount: 4, dailyCap: 5 }), {
      able: true,
    });
  });

  test("cap-exhausted wins over quota-blocked when both hold (order pin 2)", () => {
    const d = decideGate({ ...base, capCount: 5, dailyCap: 5, quotaBlockedUntil: NOW + 1000 });
    assert.deepEqual(d, { able: false, reason: "cap-exhausted" });
  });

  test("quota block in the future => skip with reason quota-blocked", () => {
    assert.deepEqual(
      decideGate({ ...base, quotaBlockedUntil: NOW + 1, now: NOW }),
      { able: false, reason: "quota-blocked" },
    );
  });

  test("quota block in the past (stale) reads as NO block — able", () => {
    // quota_blocked_until_epoch deleted the stale file before deciding; the
    // core must independently treat a past instant as unblocked so the pure
    // verdict cannot disagree with the reader.
    assert.deepEqual(
      decideGate({ ...base, quotaBlockedUntil: NOW - 1, now: NOW }),
      { able: true },
    );
  });

  test("quota block exactly AT now is stale (strictly-future rule, `val -le now` pin)", () => {
    assert.deepEqual(
      decideGate({ ...base, quotaBlockedUntil: NOW, now: NOW }),
      { able: true },
    );
  });

  test("everything clear => able", () => {
    assert.deepEqual(decideGate(base), { able: true });
  });
});

// ---------------------------------------------------------------------------
// runGate — the orchestration over injected deps
// ---------------------------------------------------------------------------

describe("src/glm/gate.ts — runGate orchestration (issue #4682)", () => {
  test("a REJECTED pause read fails closed: {able:false, reason:'paused'}, heartbeat never called", async () => {
    const { deps, heartbeatCalls, logs } = makeGateDeps({
      getAutopilotPaused: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const r = await runGate(deps);
    assert.deepEqual(r, { able: false, reason: "paused" });
    assert.equal(heartbeatCalls.length, 0, "a skipped tick must never write the heartbeat");
    assert.ok(
      logs.some((l) => l.includes("failing safe") && l.includes("paused")),
      `expected a fail-safe WARN log, got: ${JSON.stringify(logs)}`,
    );
  });

  test("pause flag set => paused, heartbeat never called", async () => {
    const { deps, heartbeatCalls } = makeGateDeps({
      getAutopilotPaused: async () => ({ paused: true, since: 123 }),
    });
    assert.deepEqual(await runGate(deps), { able: false, reason: "paused" });
    assert.equal(heartbeatCalls.length, 0);
  });

  test("corrupt-blob verdict (the seam reads it as {paused:false}, autopilot-pause AC7) => gate proceeds", async () => {
    // The old bash curl arm failed CLOSED on an unparseable body; the Redis
    // seam's own corrupt-blob rule fails SAFE TO RUNNING, and the gate
    // inherits the seam's verdict — an intentional direction change recorded
    // in ADR-0040 Decision 2, not an accident. The whole-script suite pins
    // the same arm end-to-end against a real corrupt blob.
    const { deps, heartbeatCalls } = makeGateDeps({
      getAutopilotPaused: async () => ({ paused: false }),
    });
    assert.deepEqual(await runGate(deps), { able: true });
    assert.equal(heartbeatCalls.length, 1, "able must write the heartbeat exactly once");
  });

  test("cap file at exactly dailyCap => cap-exhausted outcome carries capCount/dailyCap; no heartbeat", async () => {
    const cfg = makeConfig({ capDir: "/gate-test-cap", dailyCap: 3 });
    const files = { [dailyCapFilePath(cfg.capDir, todayUtc(NOW * 1000))]: "3" };
    const { deps, heartbeatCalls } = makeGateDeps({ files, config: cfg });
    const r = await runGate(deps);
    assert.deepEqual(r, {
      able: false,
      reason: "cap-exhausted",
      capCount: 3,
      dailyCap: 3,
    });
    assert.equal(heartbeatCalls.length, 0);
  });

  test("missing or non-numeric cap file reads as 0 (fail-open, is_cap_exhausted pin)", async () => {
    for (const [name, files] of [
      ["missing", {}],
      ["garbage", { [dailyCapFilePath("/gate-test-cap", todayUtc(NOW * 1000))]: "not-a-number" }],
    ] as const) {
      const { deps, heartbeatCalls } = makeGateDeps({ files });
      const r = await runGate(deps);
      assert.deepEqual(r, { able: true }, `${name} cap file must not exhaust the cap`);
      assert.equal(heartbeatCalls.length, 1, `${name}: able writes the heartbeat`);
    }
  });

  test("future quota block => quota-blocked outcome with epoch + ISO; no heartbeat", async () => {
    const files = { [quotaBlockFilePath("/gate-test-cap")]: String(NOW + 900) };
    const { deps, heartbeatCalls } = makeGateDeps({ files });
    const r = await runGate(deps);
    const expectedIso = "2027-01-15T00:15:00Z";
    assert.equal(epochToIsoUtc(NOW + 900), expectedIso);
    assert.deepEqual(r, {
      able: false,
      reason: "quota-blocked",
      quotaBlockedUntil: NOW + 900,
      quotaBlockedUntilIso: expectedIso,
    });
    assert.equal(heartbeatCalls.length, 0);
    assert.match((r as any).quotaBlockedUntilIso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  test("PAST quota block => able AND the stale file is deleted (issue #4273 read-side rule)", async () => {
    const files = { [quotaBlockFilePath("/gate-test-cap")]: String(NOW - 1) };
    const { deps, removed, heartbeatCalls } = makeGateDeps({ files });
    const r = await runGate(deps);
    assert.deepEqual(r, { able: true });
    assert.deepEqual(removed, [quotaBlockFilePath("/gate-test-cap")]);
    assert.equal(heartbeatCalls.length, 1);
  });

  test("garbage / empty quota file => no block AND the file is deleted", async () => {
    for (const content of ["garbage", "", "  "]) {
      const files = { [quotaBlockFilePath("/gate-test-cap")]: content };
      const { deps, removed } = makeGateDeps({ files });
      const r = await runGate(deps);
      assert.deepEqual(r, { able: true }, `content ${JSON.stringify(content)} must read as no block`);
      assert.deepEqual(removed, [quotaBlockFilePath("/gate-test-cap")]);
    }
  });

  test("an ACTIVE (future) quota file is NOT deleted", async () => {
    const files = { [quotaBlockFilePath("/gate-test-cap")]: String(NOW + 900) };
    const { deps, removed } = makeGateDeps({ files });
    await runGate(deps);
    assert.deepEqual(removed, [], "an active block file must not be deleted");
  });

  test("DRY_RUN=1 + able: logs would-heartbeat, NEVER writes", async () => {
    const { deps, heartbeatCalls, logs } = makeGateDeps({
      config: makeConfig({ dryRun: true }),
    });
    assert.deepEqual(await runGate(deps), { able: true });
    assert.equal(heartbeatCalls.length, 0, "dry-run must never write the heartbeat");
    assert.ok(
      logs.includes("would-heartbeat (reason=able, DRY_RUN=1)"),
      `expected the would-heartbeat line, got: ${JSON.stringify(logs)}`,
    );
  });

  test("DRY_RUN=1 + paused: no would-heartbeat line, no write", async () => {
    const { deps, heartbeatCalls, logs } = makeGateDeps({
      config: makeConfig({ dryRun: true }),
      getAutopilotPaused: async () => ({ paused: true }),
    });
    assert.deepEqual(await runGate(deps), { able: false, reason: "paused" });
    assert.equal(heartbeatCalls.length, 0);
    assert.ok(!logs.some((l) => l.includes("would-heartbeat")));
  });

  test("heartbeat write failure does NOT un-able the tick (bash write_heartbeat parity: log WARN, continue)", async () => {
    const { deps, logs } = makeGateDeps({
      setGlmDrainerHeartbeat: async () => ({
        ok: false,
        code: "glm-heartbeat-write-failed",
        message: "redis down",
      }),
    });
    assert.deepEqual(await runGate(deps), { able: true });
    assert.ok(
      logs.some((l) => l.includes("WARN heartbeat write failed (reason=able)") && l.includes("redis down")),
      `expected the WARN line, got: ${JSON.stringify(logs)}`,
    );
  });

  test("an unreadable (non-ENOENT) state file logs a WARN and fails open", async () => {
    const { deps, logs } = makeGateDeps({
      readFile: (path) => {
        if (path.includes("daily-cap")) {
          const err = new Error("EACCES: permission denied") as Error & { code: string };
          err.code = "EACCES";
          throw err;
        }
        return "";
      },
    });
    const r = await runGate(deps);
    assert.deepEqual(r, { able: true }, "an unreadable cap counter must read as 0 (fail-open)");
    assert.ok(logs.some((l) => l.includes("daily-cap counter unreadable")));
  });
});

// ---------------------------------------------------------------------------
// drainer-driver.ts — the `gate` mode arm
// ---------------------------------------------------------------------------

describe("src/glm/drainer-driver.ts — gate mode (issue #4682, ADR-0040 gate phase)", () => {
  // The real (unoverridden) gate deps — the committed CLI entrypoint's path —
  // are NOT exercised here: they hit the live Redis seam. The whole-script
  // groups in test/glm-drainer-loop.test.mts drive that path through the bash
  // loop against the per-run Redis DB (redis-db-launch.mjs).

  /**
   * A full DriverDeps for the gate arm only: every non-gate field carries the
   * genuine seam reference (never called — the gate arm reads `deps.gate`
   * alone), so this stays type-safe with zero casts as DriverDeps grows.
   */
  function gateOnlyDriverDeps(gate: GateDeps): DriverDeps {
    return {
      setGlmDrainerHeartbeat,
      preflightBeforePr,
      buildGlmEnv,
      buildDrainerArgs,
      runGlmClaude,
      spawn: defaultClaudeSpawn,
      readFile: () => "",
      env: {},
      apiTimeoutMs: 0,
      gate,
    };
  }

  test("gate mode: verdict line on stdout, exit 0 even when the gate skips (a skip is a completed check)", async () => {
    const { deps } = makeGateDeps({
      getAutopilotPaused: async () => ({ paused: true }),
    });
    const outcome = await runDriverMode(["gate"], gateOnlyDriverDeps(deps));
    assert.ok(outcome.ok);
    if (outcome.ok && !("code" in outcome)) {
      assert.equal(outcome.exitCode, 0);
      assert.deepEqual(JSON.parse(outcome.line), { able: false, reason: "paused" });
    }
  });

  test("gate mode: able verdict line, exit 0", async () => {
    const { deps } = makeGateDeps({ config: makeConfig({ dryRun: true }) });
    const outcome = await runDriverMode(["gate"], gateOnlyDriverDeps(deps));
    assert.ok(outcome.ok);
    if (outcome.ok && !("code" in outcome)) {
      assert.equal(outcome.exitCode, 0);
      assert.deepEqual(JSON.parse(outcome.line) as GateOutcome, { able: true });
    }
  });

});

// ---------------------------------------------------------------------------
// drainer-config.ts — env contract + state-file path formats
// ---------------------------------------------------------------------------

describe("src/glm/drainer-config.ts — env names/defaults shared with the bash layer (issue #4682)", () => {
  test("defaults match scripts/glm/drainer-loop.sh's own defaults exactly", () => {
    const c = readDrainerConfig({});
    assert.equal(c.dryRun, false);
    assert.equal(c.dailyCap, 5);
    assert.equal(c.timeoutResumeCap, 2);
    assert.equal(c.capDir, "/tmp");
    assert.equal(c.lockfile, "/tmp/hydra-glm-drainer.lock");
    assert.equal(c.quotaResetTzOffset, "+0800");
    assert.equal(
      c.worktreeRoot,
      "/home/gabe/hydra/.claude/worktrees",
    );
    assert.equal(c.designConceptUrl, "http://localhost:4000/api/design-concepts");
    assert.equal(c.pausedUrl, "http://localhost:4000/api/autopilot/paused");
    assert.equal(c.repoRoot, "");
  });

  test("every HYDRA_GLM_DRAINER_* override is honoured (same names bash reads)", () => {
    const c = readDrainerConfig({
      HYDRA_GLM_DRAINER_REPO_ROOT: "/repo",
      HYDRA_GLM_DRAINER_DRY_RUN: "1",
      HYDRA_GLM_DRAINER_PAUSED_URL: "http://paused.example",
      HYDRA_GLM_DRAINER_DESIGN_CONCEPT_URL: "http://dc.example",
      HYDRA_GLM_DRAINER_LOCKFILE: "/lock",
      HYDRA_GLM_DRAINER_CAP_DIR: "/cap",
      HYDRA_GLM_DRAINER_DAILY_CAP: "9",
      HYDRA_GLM_DRAINER_TIMEOUT_RESUME_CAP: "7",
      HYDRA_GLM_DRAINER_WORKTREE_ROOT: "/wts",
      HYDRA_GLM_DRAINER_QUOTA_RESET_TZ_OFFSET: "+0530",
    });
    assert.equal(c.repoRoot, "/repo");
    assert.equal(c.dryRun, true);
    assert.equal(c.pausedUrl, "http://paused.example");
    assert.equal(c.designConceptUrl, "http://dc.example");
    assert.equal(c.lockfile, "/lock");
    assert.equal(c.capDir, "/cap");
    assert.equal(c.dailyCap, 9);
    assert.equal(c.timeoutResumeCap, 7);
    assert.equal(c.worktreeRoot, "/wts");
    assert.equal(c.quotaResetTzOffset, "+0530");
  });

  test("an unparseable numeric override fails OPEN to unbounded, not to the default", () => {
    // bash: `[[ 7 -ge abc ]]` is an arithmetic error (false) => never
    // exhausted. A misconfigured cap must not silently become the default
    // cap — it becomes no cap at all, exactly like the bash it replaces.
    const c = readDrainerConfig({ HYDRA_GLM_DRAINER_DAILY_CAP: "abc" });
    assert.equal(c.dailyCap, Number.POSITIVE_INFINITY);
  });
});

describe("src/glm/drainer-config.ts — $CAP_DIR state-file path/format helpers (ADR-0040 Decision 3)", () => {
  test("dailyCapFilePath is $CAP_DIR/hydra-glm-drainer-daily-cap-YYYY-MM-DD (UTC, date -u +%F)", () => {
    // 2027-01-15T00:00:00Z
    assert.equal(todayUtc(NOW * 1000), "2027-01-15");
    assert.equal(
      dailyCapFilePath("/cap", "2027-01-15"),
      "/cap/hydra-glm-drainer-daily-cap-2027-01-15",
    );
  });

  test("quotaBlockFilePath is $CAP_DIR/hydra-glm-drainer-quota-blocked-until", () => {
    assert.equal(
      quotaBlockFilePath("/cap"),
      "/cap/hydra-glm-drainer-quota-blocked-until",
    );
  });

  test("epochToIsoUtc is byte-compatible with `date -u -d @<epoch>` (no milliseconds)", () => {
    assert.equal(epochToIsoUtc(0), "1970-01-01T00:00:00Z");
    assert.equal(epochToIsoUtc(NOW), "2027-01-15T00:00:00Z");
    assert.equal(epochToIsoUtc(NOW + 3661), "2027-01-15T01:01:01Z");
  });

  test("cross-layer parity: the bash loop's KEPT writers still inline the same literals", () => {
    // The LOCKSTEP-comment replacement ADR-0040 Decision 5 prescribes: while
    // bash still writes the two state files (cap_increment /
    // record_quota_block_if_429 — they belong to the finish phase), a
    // source-string pin here fails the suite if either layer's path format
    // drifts. The complementary bash-side pin (the seven replaced functions
    // are gone, main() calls run_driver gate once) lives in
    // test/glm-drainer-loop.test.mts.
    const src = readFileSync(DRAINER_LOOP, "utf8");
    assert.match(
      src,
      /hydra-glm-drainer-daily-cap-\$\{?\(date -u \+%F\)\}?/,
      "cap_increment must keep writing today's date-stamped counter path",
    );
    assert.match(
      src,
      /hydra-glm-drainer-quota-blocked-until/,
      "record_quota_block_if_429 must keep writing the quota-block epoch file",
    );
  });
});
