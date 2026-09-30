/**
 * src/glm/gate.ts + src/glm/drainer-config.ts — the GLM drainer's gate phase
 * (issue #4682, ADR-0040 Decisions 1–3, epic #4681).
 *
 * Ports the bash-era whole-script groups D1 (operator-pause kill-switch), D2
 * (daily PR cap) and D3 (z.ai quota block) from test/glm-drainer-loop.test.mts
 * per the #4679 test-port rule: `decideGate` cases are a typed TABLE, and
 * `runGate`'s effect rules (rejected Redis read = paused, corrupt blob = not
 * paused, stale quota-block file deleted, heartbeat only on able,
 * would-heartbeat under dry-run) are fake-deps tests. No processes, no Redis,
 * no goldens. D4 (flock) stays whole-script in glm-drainer-loop.test.mts.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildDefaultGateDeps,
  capFilePath,
  decideGate,
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
  readDrainerConfig,
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
  logs: string[];
  removed: string[];
  heartbeats: number;
}

function makeDeps(opts: {
  paused?: boolean | "reject";
  files?: Record<string, string>;
  dryRun?: boolean;
  dailyCap?: number;
  heartbeat?: "ok" | "fail" | "reject";
} = {}): Harness {
  const h: Harness = { deps: undefined as unknown as GateDeps, logs: [], removed: [], heartbeats: 0 };
  const files = { ...(opts.files ?? {}) };
  h.deps = {
    config: {
      ...readDrainerConfig({}),
      capDir: CAP_DIR,
      dryRun: opts.dryRun ?? false,
      dailyCap: opts.dailyCap ?? 5,
    },
    now: () => NOW_MS,
    log: (m) => h.logs.push(m),
    readPaused: async () => {
      if (opts.paused === "reject") throw new Error("redis down");
      return { paused: opts.paused ?? false };
    },
    readFile: (p) => (p in files ? files[p] : null),
    removeFile: (p) => {
      h.removed.push(p);
      delete files[p];
    },
    writeHeartbeat: async () => {
      h.heartbeats += 1;
      if (opts.heartbeat === "reject") throw new Error("redis down");
      return { ok: opts.heartbeat !== "fail" };
    },
  };
  return h;
}

describe("runGate — effect rules over fake deps (issue #4682)", () => {
  test("able: writes the heartbeat once and logs it", async () => {
    const h = makeDeps();
    assert.deepEqual(await runGate(h.deps), { able: true });
    assert.equal(h.heartbeats, 1);
    assert.ok(h.logs.includes("heartbeat written (reason=able)"));
  });

  test("paused: no heartbeat, the kill-switch log line", async () => {
    const h = makeDeps({ paused: true });
    assert.deepEqual(await runGate(h.deps), { able: false, reason: "paused" });
    assert.equal(h.heartbeats, 0);
    assert.ok(h.logs.some((l) => /^operator paused — skip \(no heartbeat/.test(l)));
  });

  test("a rejected Redis pause read fails CLOSED to paused (no heartbeat)", async () => {
    const h = makeDeps({ paused: "reject" });
    assert.deepEqual(await runGate(h.deps), { able: false, reason: "paused" });
    assert.equal(h.heartbeats, 0);
    assert.ok(h.logs.some((l) => /pause read failed — failing safe/.test(l)));
  });

  test("a corrupt pause blob reads as not paused (via the real accessor contract)", async () => {
    // getAutopilotPaused() resolves {paused:false} for a corrupt blob; the
    // gate only trusts an explicit `paused === true`.
    const h = makeDeps();
    h.deps.readPaused = async () => ({ paused: "yes" as unknown as boolean });
    assert.deepEqual(await runGate(h.deps), { able: true });
  });

  test("cap exhausted at exactly the cap: no heartbeat, the cap log line", async () => {
    const h = makeDeps({ dailyCap: 3, files: { [CAP_FILE]: "3\n" } });
    assert.deepEqual(await runGate(h.deps), { able: false, reason: "cap-exhausted" });
    assert.equal(h.heartbeats, 0);
    assert.ok(h.logs.includes("daily PR cap reached (3/3) — skip (no heartbeat)"));
  });

  test("active quota block: no heartbeat, the file is kept", async () => {
    const h = makeDeps({ files: { [QUOTA_FILE]: String(NOW_SEC + 1000) } });
    assert.deepEqual(await runGate(h.deps), { able: false, reason: "quota-blocked" });
    assert.equal(h.heartbeats, 0);
    assert.deepEqual(h.removed, [], "an active block file must not be deleted");
    assert.ok(
      h.logs.includes(`quota block active until ${epochToIso(NOW_SEC + 1000)} — skip (no heartbeat)`),
    );
  });

  test("stale quota block: the file is deleted and the tick proceeds (able)", async () => {
    const h = makeDeps({ files: { [QUOTA_FILE]: String(NOW_SEC - 1000) } });
    assert.deepEqual(await runGate(h.deps), { able: true });
    assert.deepEqual(h.removed, [QUOTA_FILE]);
    assert.equal(h.heartbeats, 1);
  });

  test("unparseable quota-block file: deleted, reads as no block", async () => {
    const h = makeDeps({ files: { [QUOTA_FILE]: "garbage" } });
    assert.deepEqual(await runGate(h.deps), { able: true });
    assert.deepEqual(h.removed, [QUOTA_FILE]);
  });

  test("dry-run: able logs would-heartbeat and writes nothing", async () => {
    const h = makeDeps({ dryRun: true });
    assert.deepEqual(await runGate(h.deps), { able: true });
    assert.equal(h.heartbeats, 0);
    assert.ok(h.logs.includes("would-heartbeat (reason=able, DRY_RUN=1)"));
  });

  test("dry-run: a skip still skips (no would-heartbeat)", async () => {
    const h = makeDeps({ dryRun: true, paused: true });
    assert.deepEqual(await runGate(h.deps), { able: false, reason: "paused" });
    assert.ok(!h.logs.some((l) => /would-heartbeat/.test(l)));
  });

  test("a failed heartbeat write never blocks authoring (still able, WARN logged)", async () => {
    for (const mode of ["fail", "reject"] as const) {
      const h = makeDeps({ heartbeat: mode });
      assert.deepEqual(await runGate(h.deps), { able: true }, mode);
      assert.ok(h.logs.some((l) => /^WARN heartbeat write failed \(reason=able\)/.test(l)), mode);
    }
  });

  test("never throws: an unexpected fault resolves to paused (fail closed)", async () => {
    const h = makeDeps();
    h.deps.readFile = () => {
      throw new Error("boom");
    };
    assert.deepEqual(await runGate(h.deps), { able: false, reason: "paused" });
    assert.equal(h.heartbeats, 0);
  });
});

describe("buildDefaultGateDeps — real file effects against a tmp $CAP_DIR", () => {
  test("readFile returns null for a missing file and the content otherwise; removeFile deletes", () => {
    const dir = mkdtempSync(join(tmpdir(), "glm-gate-"));
    try {
      const deps = buildDefaultGateDeps({ HYDRA_GLM_DRAINER_CAP_DIR: dir });
      assert.equal(deps.config.capDir, dir);
      const f = quotaBlockFilePath(dir);
      assert.equal(deps.readFile(f), null);
      writeFileSync(f, "123");
      assert.equal(deps.readFile(f), "123");
      deps.removeFile(f);
      assert.equal(existsSync(f), false);
      deps.removeFile(f); // idempotent on a missing file
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a stale block file on disk is removed by a real-file gate run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "glm-gate-"));
    try {
      const real = buildDefaultGateDeps({ HYDRA_GLM_DRAINER_CAP_DIR: dir, HYDRA_GLM_DRAINER_DRY_RUN: "1" });
      const f = quotaBlockFilePath(dir);
      writeFileSync(f, String(Math.floor(Date.now() / 1000) - 1000));
      const logs: string[] = [];
      const v = await runGate({ ...real, readPaused: async () => ({ paused: false }), log: (m) => logs.push(m) });
      assert.deepEqual(v, { able: true });
      assert.equal(existsSync(f), false, "an expired block file must be deleted on read");
      assert.ok(logs.includes("would-heartbeat (reason=able, DRY_RUN=1)"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a live cap file on disk (today's UTC name) blocks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "glm-gate-"));
    try {
      const real = buildDefaultGateDeps({
        HYDRA_GLM_DRAINER_CAP_DIR: dir,
        HYDRA_GLM_DRAINER_DAILY_CAP: "2",
        HYDRA_GLM_DRAINER_DRY_RUN: "1",
      });
      writeFileSync(capFilePath(dir, Date.now()), "2");
      const v = await runGate({ ...real, readPaused: async () => ({ paused: false }), log: () => {} });
      assert.deepEqual(v, { able: false, reason: "cap-exhausted" });
      assert.equal(readFileSync(capFilePath(dir, Date.now()), "utf8"), "2", "the gate never writes the cap file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runDriverMode('gate') — one JSON line, exit 0 on able and on skip", () => {
  const base = {} as DriverDeps;
  test("able", async () => {
    const h = makeDeps();
    const out = await runDriverMode(["gate"], { ...base, env: {}, gate: h.deps });
    assert.deepEqual(out, { ok: true, line: JSON.stringify({ able: true }), exitCode: 0 });
  });
  test("skip", async () => {
    const h = makeDeps({ paused: true });
    const out = await runDriverMode(["gate"], { ...base, env: {}, gate: h.deps });
    assert.deepEqual(out, {
      ok: true,
      line: JSON.stringify({ able: false, reason: "paused" }),
      exitCode: 0,
    });
  });
});

describe("readDrainerConfig — same names and defaults as drainer-loop.sh", () => {
  test("defaults", () => {
    assert.deepEqual(readDrainerConfig({}), {
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
    const c = readDrainerConfig({
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
    assert.equal(readDrainerConfig({ HYDRA_GLM_DRAINER_DRY_RUN: "true" }).dryRun, false);
  });

  test("a non-integer numeric override falls back to its default", () => {
    const c = readDrainerConfig({
      HYDRA_GLM_DRAINER_DAILY_CAP: "lots",
      HYDRA_GLM_DRAINER_TIMEOUT_RESUME_CAP: "-3",
    });
    assert.equal(c.dailyCap, DEFAULT_DAILY_CAP);
    assert.equal(c.timeoutResumeCap, DEFAULT_TIMEOUT_RESUME_CAP);
  });
});
