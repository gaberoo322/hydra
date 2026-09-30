/**
 * src/glm/gate.ts + src/glm/drainer-config.ts — the GLM drainer's gate phase
 * (issue #4682, ADR-0040 Decisions 1–3, epic #4681).
 *
 * Unit layer for the bash-era groups D1 (operator-pause kill-switch), D2
 * (daily PR cap) and D3 (z.ai quota block) per the #4679 test-port rule:
 * `decideGate` cases are a typed TABLE, and
 * `runGate`'s effect rules (rejected Redis read = paused, corrupt blob = not
 * paused, stale quota-block file deleted, heartbeat only on able,
 * would-write under dry-run, 10 s pause-read timeout) are fake-deps tests. No
 * processes, no Redis, no goldens. The four curl/jq-specific D1 cases
 * (unreachable endpoint, unparseable body, jq `//` trap, Anthropic-shaped
 * fields) are rewritten here as runGate cases; the whole-script D1–D4 groups
 * stay in glm-drainer-loop.test.mts against the real `gate` mode.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PAUSE_READ_TIMEOUT_MS,
  capFilePath,
  decideGate,
  defaultGateDeps,
  epochToIso,
  parseCapCount,
  parseQuotaBlock,
  quotaBlockFilePath,
  runGate,
  type GateDeps,
  type GateInput,
  type GateVerdict,
} from "../src/glm/gate.ts";
import {
  DEFAULT_DAILY_CAP,
  DEFAULT_TIMEOUT_RESUME_CAP,
  loadDrainerConfig,
} from "../src/glm/drainer-config.ts";
import { runDriverMode, type DriverDeps } from "../src/glm/drainer-driver.ts";

const NOW_MS = Date.parse("2026-09-30T12:00:00Z");
const NOW_SEC = Math.floor(NOW_MS / 1000);
const CAP_DIR = "/cap";
const CAP_FILE = `/cap/hydra-glm-drainer-daily-cap-2026-09-30`;
const QUOTA_FILE = `/cap/hydra-glm-drainer-quota-blocked-until`;

// ---------------------------------------------------------------------------
// decideGate — the pure verdict (D1–D3's decision core)
// ---------------------------------------------------------------------------

describe("decideGate — pure verdict table (issue #4682)", () => {
  const base: GateInput = {
    paused: false,
    capCount: 0,
    dailyCap: 5,
    quotaBlockedUntil: null,
    now: NOW_SEC,
  };
  const rows: Array<[string, Partial<GateInput>, GateVerdict]> = [
    ["able: nothing blocks", {}, { able: true }],
    ["paused", { paused: true }, { able: false, reason: "paused" }],
    ["cap below the limit is able", { capCount: 4 }, { able: true }],
    ["cap exhausted at exactly dailyCap", { capCount: 5 }, { able: false, reason: "cap-exhausted" }],
    ["cap above dailyCap", { capCount: 9 }, { able: false, reason: "cap-exhausted" }],
    ["dailyCap 0 always exhausts", { dailyCap: 0 }, { able: false, reason: "cap-exhausted" }],
    [
      "quota block in the future",
      { quotaBlockedUntil: NOW_SEC + 1000 },
      { able: false, reason: "quota-blocked" },
    ],
    ["quota block in the past (stale) is able", { quotaBlockedUntil: NOW_SEC - 1000 }, { able: true }],
    ["quota block at exactly now is not active", { quotaBlockedUntil: NOW_SEC }, { able: true }],
    [
      "precedence: paused beats cap and quota",
      { paused: true, capCount: 5, quotaBlockedUntil: NOW_SEC + 1000 },
      { able: false, reason: "paused" },
    ],
    [
      "precedence: cap beats quota",
      { capCount: 5, quotaBlockedUntil: NOW_SEC + 1000 },
      { able: false, reason: "cap-exhausted" },
    ],
  ];
  for (const [name, over, want] of rows) {
    test(name, () => {
      assert.deepEqual(decideGate({ ...base, ...over }), want);
    });
  }
});

describe("gate file helpers — today's $CAP_DIR paths and formats (ADR-0040 Decision 3)", () => {
  test("cap file is keyed by the UTC day", () => {
    assert.equal(capFilePath(CAP_DIR, NOW_MS), CAP_FILE);
    // The last second of the UTC day still names that UTC day — never local time.
    assert.equal(
      capFilePath(CAP_DIR, Date.parse("2026-09-30T23:59:59Z")),
      CAP_FILE,
    );
  });

  test("quota-block file path is fixed", () => {
    assert.equal(quotaBlockFilePath(CAP_DIR), QUOTA_FILE);
  });

  const capRows: Array<[string | null, number]> = [
    [null, 0],
    ["3", 3],
    ["3\n", 3],
    ["", 0],
    ["abc", 0],
    ["-1", 0],
  ];
  for (const [raw, want] of capRows) {
    test(`parseCapCount(${JSON.stringify(raw)}) = ${want}`, () => {
      assert.equal(parseCapCount(raw), want);
    });
  }

  const quotaRows: Array<[string | null, { until: number | null; stale: boolean }]> = [
    [null, { until: null, stale: false }],
    [String(NOW_SEC + 60), { until: NOW_SEC + 60, stale: false }],
    [`${NOW_SEC + 60}\n`, { until: NOW_SEC + 60, stale: false }],
    [String(NOW_SEC - 60), { until: null, stale: true }],
    [String(NOW_SEC), { until: null, stale: true }],
    ["garbage", { until: null, stale: true }],
    ["", { until: null, stale: true }],
  ];
  for (const [raw, want] of quotaRows) {
    test(`parseQuotaBlock(${JSON.stringify(raw)})`, () => {
      assert.deepEqual(parseQuotaBlock(raw, NOW_SEC), want);
    });
  }

  test("epochToIso drops milliseconds (the bash `date +%Y-%m-%dT%H:%M:%SZ` shape)", () => {
    assert.equal(epochToIso(NOW_SEC), "2026-09-30T12:00:00Z");
  });
});

// ---------------------------------------------------------------------------
// runGate — effects over fake deps
// ---------------------------------------------------------------------------

interface Harness {
  deps: GateDeps;
  unlinked: string[];
  heartbeats: number;
}

function makeGateDeps(opts: {
  paused?: boolean | "reject" | "hang";
  files?: Record<string, string>;
  dryRun?: boolean;
  dailyCap?: number;
  heartbeat?: "ok" | "fail" | "reject";
} = {}): Harness {
  const h: Harness = { deps: undefined as unknown as GateDeps, unlinked: [], heartbeats: 0 };
  const files = { ...(opts.files ?? {}) };
  h.deps = {
    config: {
      ...loadDrainerConfig({}),
      capDir: CAP_DIR,
      dryRun: opts.dryRun ?? false,
      dailyCap: opts.dailyCap ?? 5,
    },
    now: () => NOW_MS,
    getAutopilotPaused: () => {
      if (opts.paused === "reject") return Promise.reject(new Error("redis down"));
      if (opts.paused === "hang") return new Promise(() => {});
      return Promise.resolve({ paused: opts.paused ?? false });
    },
    readFileIfExists: (p: string) => (p in files ? files[p] : null),
    unlink: (p: string) => {
      h.unlinked.push(p);
      delete files[p];
    },
    setGlmDrainerHeartbeat: async () => {
      h.heartbeats += 1;
      if (opts.heartbeat === "reject") throw new Error("redis down");
      return opts.heartbeat === "fail"
        ? { ok: false, message: "SET failed" }
        : { ok: true };
    },
  };
  return h;
}

describe("runGate — effect rules over fake deps (issue #4682)", () => {
  test("able: writes the heartbeat once and reports heartbeat=written", async () => {
    const h = makeGateDeps();
    assert.deepEqual(await runGate(h.deps), { able: true, heartbeat: "written" });
    assert.equal(h.heartbeats, 1);
  });

  test("paused: no heartbeat", async () => {
    const h = makeGateDeps({ paused: true });
    assert.deepEqual(await runGate(h.deps), { able: false, reason: "paused" });
    assert.equal(h.heartbeats, 0);
  });

  test("a rejected pause read fails CLOSED to paused (no heartbeat)", async () => {
    // Replaces the whole-script D1 "unreachable pause endpoint" case.
    const h = makeGateDeps({ paused: "reject" });
    const line = await runGate(h.deps);
    assert.equal(line.able, false);
    assert.equal((line as { reason: string }).reason, "paused");
    assert.match(String(line.detail), /pause read failed: redis down/);
    assert.equal(h.heartbeats, 0);
  });

  test("a pause read that does not settle within 10 s fails CLOSED to paused", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = makeGateDeps({ paused: "hang" });
    const pending = runGate(h.deps);
    t.mock.timers.tick(PAUSE_READ_TIMEOUT_MS);
    const line = await pending;
    assert.equal(PAUSE_READ_TIMEOUT_MS, 10_000);
    assert.equal((line as { reason: string }).reason, "paused");
    assert.match(String(line.detail), /timed out after 10000ms/);
    assert.equal(h.heartbeats, 0);
  });

  test("a corrupt-blob-shaped {paused:false} read is able", async () => {
    // getAutopilotPaused() resolves {paused:false} for a corrupt blob.
    // Replaces the whole-script D1 "unparseable response" and jq `//` cases.
    const h = makeGateDeps({ paused: false });
    assert.deepEqual(await runGate(h.deps), { able: true, heartbeat: "written" });
  });

  test("only paused === true pauses (Anthropic-shaped fields are never consulted)", async () => {
    // Replaces the whole-script D1 "Anthropic-shaped fields" case.
    const h = makeGateDeps();
    h.deps.getAutopilotPaused = async () =>
      ({ paused: "yes", emergencyStop: true, weeklyEmergencyStop: true }) as unknown as { paused: boolean };
    assert.deepEqual(await runGate(h.deps), { able: true, heartbeat: "written" });
  });

  test("cap exhausted at exactly the cap: no heartbeat, detail N/M", async () => {
    const h = makeGateDeps({ dailyCap: 3, files: { [CAP_FILE]: "3\n" } });
    assert.deepEqual(await runGate(h.deps), { able: false, reason: "cap-exhausted", detail: "3/3" });
    assert.equal(h.heartbeats, 0);
  });

  test("active quota block: no heartbeat, detail is the ISO instant, the file is untouched", async () => {
    const h = makeGateDeps({ files: { [QUOTA_FILE]: String(NOW_SEC + 1000) } });
    assert.deepEqual(await runGate(h.deps), {
      able: false,
      reason: "quota-blocked",
      detail: epochToIso(NOW_SEC + 1000),
    });
    assert.equal(h.heartbeats, 0);
    assert.deepEqual(h.unlinked, [], "an active block file must not be deleted");
  });

  test("stale quota file is deleted and the tick proceeds (able)", async () => {
    const h = makeGateDeps({ files: { [QUOTA_FILE]: String(NOW_SEC - 1000) } });
    assert.deepEqual(await runGate(h.deps), { able: true, heartbeat: "written" });
    assert.deepEqual(h.unlinked, [QUOTA_FILE]);
  });

  test("non-numeric quota file is deleted and reads as no block", async () => {
    const h = makeGateDeps({ files: { [QUOTA_FILE]: "garbage" } });
    assert.deepEqual(await runGate(h.deps), { able: true, heartbeat: "written" });
    assert.deepEqual(h.unlinked, [QUOTA_FILE]);
  });

  test("dry-run writes nothing and reports would-write", async () => {
    const h = makeGateDeps({ dryRun: true });
    assert.deepEqual(await runGate(h.deps), { able: true, heartbeat: "would-write" });
    assert.equal(h.heartbeats, 0);
  });

  test("a heartbeat write failure stays able (write-failed + detail)", async () => {
    const failed = makeGateDeps({ heartbeat: "fail" });
    assert.deepEqual(await runGate(failed.deps), {
      able: true,
      heartbeat: "write-failed",
      detail: "SET failed",
    });
    const threw = makeGateDeps({ heartbeat: "reject" });
    assert.deepEqual(await runGate(threw.deps), {
      able: true,
      heartbeat: "write-failed",
      detail: "redis down",
    });
  });

  test("never throws: an unexpected fault resolves to paused (fail closed)", async () => {
    const h = makeGateDeps();
    h.deps.readFileIfExists = () => {
      throw new Error("boom");
    };
    const line = await runGate(h.deps);
    assert.equal((line as { reason: string }).reason, "paused");
    assert.equal(h.heartbeats, 0);
  });
});

describe("defaultGateDeps — real file effects against a tmp $CAP_DIR", () => {
  test("readFileIfExists returns null for a missing file; unlink is rm -f", () => {
    const dir = mkdtempSync(join(tmpdir(), "glm-gate-"));
    try {
      const deps = defaultGateDeps({ HYDRA_GLM_DRAINER_CAP_DIR: dir });
      assert.equal(deps.config.capDir, dir);
      const f = quotaBlockFilePath(dir);
      assert.equal(deps.readFileIfExists(f), null);
      writeFileSync(f, "123");
      assert.equal(deps.readFileIfExists(f), "123");
      deps.unlink(f);
      assert.equal(existsSync(f), false);
      deps.unlink(f); // ENOENT tolerated
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a stale block file on disk is removed by a real-file gate run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "glm-gate-"));
    try {
      const real = defaultGateDeps({ HYDRA_GLM_DRAINER_CAP_DIR: dir, HYDRA_GLM_DRAINER_DRY_RUN: "1" });
      const f = quotaBlockFilePath(dir);
      writeFileSync(f, String(Math.floor(Date.now() / 1000) - 1000));
      const line = await runGate({ ...real, getAutopilotPaused: async () => ({ paused: false }) });
      assert.deepEqual(line, { able: true, heartbeat: "would-write" });
      assert.equal(existsSync(f), false, "an expired block file must be deleted on read");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a live cap file on disk (today's UTC name) blocks and is never written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "glm-gate-"));
    try {
      const real = defaultGateDeps({
        HYDRA_GLM_DRAINER_CAP_DIR: dir,
        HYDRA_GLM_DRAINER_DAILY_CAP: "2",
        HYDRA_GLM_DRAINER_DRY_RUN: "1",
      });
      writeFileSync(capFilePath(dir, Date.now()), "2");
      const line = await runGate({ ...real, getAutopilotPaused: async () => ({ paused: false }) });
      assert.deepEqual(line, { able: false, reason: "cap-exhausted", detail: "2/2" });
      assert.equal(readFileSync(capFilePath(dir, Date.now()), "utf8"), "2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runDriverMode('gate') — one JSON line, exit 0 on able and on skip", () => {
  const base = { env: {} } as unknown as DriverDeps;
  test("able", async () => {
    const h = makeGateDeps();
    const out = await runDriverMode(["gate"], { ...base, gateDeps: h.deps });
    assert.deepEqual(out, {
      ok: true,
      line: JSON.stringify({ able: true, heartbeat: "written" }),
      exitCode: 0,
    });
  });
  test("skip", async () => {
    const h = makeGateDeps({ paused: true });
    const out = await runDriverMode(["gate"], { ...base, gateDeps: h.deps });
    assert.deepEqual(out, {
      ok: true,
      line: JSON.stringify({ able: false, reason: "paused" }),
      exitCode: 0,
    });
  });
});

describe("loadDrainerConfig — same names and defaults as drainer-loop.sh", () => {
  test("defaults", () => {
    assert.deepEqual(loadDrainerConfig({}), {
      repoRoot: null,
      repo: "gaberoo322/hydra",
      dryRun: false,
      lockfile: "/tmp/hydra-glm-drainer.lock",
      capDir: "/tmp",
      dailyCap: DEFAULT_DAILY_CAP,
      timeoutResumeCap: DEFAULT_TIMEOUT_RESUME_CAP,
      worktreeRoot: "/home/gabe/hydra/.claude/worktrees",
      quotaResetTzOffset: "+0800",
      designConceptUrl: "http://localhost:4000/api/design-concepts",
    });
  });

  test("overrides", () => {
    const c = loadDrainerConfig({
      HYDRA_GLM_DRAINER_REPO_ROOT: "/r",
      HYDRA_AUTOPILOT_REPO: "o/r",
      HYDRA_GLM_DRAINER_DRY_RUN: "1",
      HYDRA_GLM_DRAINER_LOCKFILE: "/l",
      HYDRA_GLM_DRAINER_CAP_DIR: "/c",
      HYDRA_GLM_DRAINER_DAILY_CAP: "7",
      HYDRA_GLM_DRAINER_TIMEOUT_RESUME_CAP: "4",
      HYDRA_GLM_DRAINER_WORKTREE_ROOT: "/w",
      HYDRA_GLM_DRAINER_QUOTA_RESET_TZ_OFFSET: "+0000",
      HYDRA_GLM_DRAINER_DESIGN_CONCEPT_URL: "http://x",
    });
    assert.deepEqual(c, {
      repoRoot: "/r",
      repo: "o/r",
      dryRun: true,
      lockfile: "/l",
      capDir: "/c",
      dailyCap: 7,
      timeoutResumeCap: 4,
      worktreeRoot: "/w",
      quotaResetTzOffset: "+0000",
      designConceptUrl: "http://x",
    });
  });

  test("dry-run is only the exact string '1'", () => {
    assert.equal(loadDrainerConfig({ HYDRA_GLM_DRAINER_DRY_RUN: "true" }).dryRun, false);
  });

  test("a non-integer numeric override falls back to its default", () => {
    const c = loadDrainerConfig({
      HYDRA_GLM_DRAINER_DAILY_CAP: "lots",
      HYDRA_GLM_DRAINER_TIMEOUT_RESUME_CAP: "-3",
    });
    assert.equal(c.dailyCap, DEFAULT_DAILY_CAP);
    assert.equal(c.timeoutResumeCap, DEFAULT_TIMEOUT_RESUME_CAP);
  });
});
