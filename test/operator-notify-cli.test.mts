/**
 * scripts/operator-notify.ts — the Operator Channel CLI (issue #5046, ADR-0045
 * Decision 6). Driven in-process with a fake transport and an in-memory (or
 * always-rejecting) store: no network, no real Telegram credentials, no Redis.
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { OperatorChannel, type OperatorChannelStore } from "../src/operator-channel/index.ts";
import { classifyUnitExit, runOperatorNotify } from "../scripts/operator-notify.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PATH = join(REPO_ROOT, "scripts/operator-notify.ts");

function memoryStore(): OperatorChannelStore & { briefs: Record<string, unknown>[] } {
  const dedup = new Map<string, any>();
  const briefs: Record<string, unknown>[] = [];
  return {
    briefs,
    readDedup: async (k) => dedup.get(k) ?? null,
    writeDedup: async (k, s) => void dedup.set(k, s),
    incrSuppressed: async (k) => {
      const s = dedup.get(k);
      if (s) s.suppressed++;
    },
    delDedup: async (k) => void dedup.delete(k),
    appendBrief: async (i) => void briefs.push(i),
    appendLog: async () => undefined,
  };
}

function rejectingStore(): OperatorChannelStore {
  const boom = async () => {
    throw new Error("redis down");
  };
  return {
    readDedup: boom,
    writeDedup: boom,
    incrSuppressed: boom,
    delDedup: boom,
    appendBrief: boom,
    appendLog: boom,
  } as OperatorChannelStore;
}

function harness(store: OperatorChannelStore = memoryStore()) {
  const sent: string[] = [];
  const logs: string[] = [];
  const channel = new OperatorChannel({
    store,
    transport: async (text) => {
      sent.push(text);
      return { ok: true, mode: "html" } as any;
    },
    timeoutMs: 50,
  });
  return { sent, logs, channel, log: (l: string) => void logs.push(l) };
}

const SIGTERM_SHOW = "Result=exit-code\nExecMainCode=1\nExecMainStatus=143\nNRestarts=0\n";
const FAILED_SHOW = "Result=exit-code\nExecMainCode=1\nExecMainStatus=1\nNRestarts=3\n";

describe("operator-notify CLI: page / resolve / brief", () => {
  test("page sends through the channel and prints one JSON line (exit 0)", async () => {
    const h = harness();
    const r = await runOperatorNotify(
      ["page", "--kind", "infra:redis_backup_stale", "--dedup-key", "infra:redis_backup_stale", "--title", "Backup stale", "--fact", "age=40h"],
      { channel: h.channel, log: h.log },
    );
    assert.equal(r.exitCode, 0);
    assert.equal(h.sent.length, 1);
    assert.match(h.sent[0], /Backup stale/);
    assert.deepEqual(JSON.parse(r.stdout).result, { sent: true, kind: "page" });
  });

  test("a Redis-down run still sends the page and exits 0 (fail open)", async () => {
    const h = harness(rejectingStore());
    const r = await runOperatorNotify(
      ["page", "--kind", "launch:fail_safe", "--dedup-key", "launch:fail_safe", "--title", "Launch flow: fail-safe"],
      { channel: h.channel, log: h.log },
    );
    assert.equal(r.exitCode, 0);
    assert.equal(h.sent.length, 1);
  });

  test("a transport failure still exits 0", async () => {
    const channel = new OperatorChannel({
      store: memoryStore(),
      transport: async () => ({ ok: false, reason: "network", error: "down" }) as any,
    });
    const r = await runOperatorNotify(
      ["page", "--kind", "launch:meter_dark", "--dedup-key", "launch:meter_dark", "--title", "t"],
      { channel, log: () => undefined },
    );
    assert.equal(r.exitCode, 0);
    assert.equal(JSON.parse(r.stdout).result.reason, "transport-failed");
  });

  test("page rejects a kind that is not on the closed page list (exit 2)", async () => {
    const h = harness();
    const r = await runOperatorNotify(
      ["page", "--kind", "cycle:completed", "--dedup-key", "x", "--title", "t"],
      { channel: h.channel, log: h.log },
    );
    assert.equal(r.exitCode, 2);
    assert.equal(h.sent.length, 0);
  });

  test("usage errors exit 2: unknown subcommand, missing --dedup-key", async () => {
    const h = harness();
    assert.equal((await runOperatorNotify(["frobnicate"], { channel: h.channel, log: h.log })).exitCode, 2);
    assert.equal(
      (await runOperatorNotify(["page", "--kind", "infra:redis_backup_stale", "--title", "t"], { channel: h.channel, log: h.log })).exitCode,
      2,
    );
    assert.equal((await runOperatorNotify([], { channel: h.channel, log: h.log })).exitCode, 2);
  });

  test("resolve sends exactly one 'recovered' after a page, then is a no-op", async () => {
    const h = harness();
    const page = ["page", "--kind", "infra:redis_backup_stale", "--dedup-key", "k1", "--title", "t"];
    await runOperatorNotify(page, { channel: h.channel, log: h.log });
    const first = await runOperatorNotify(["resolve", "--dedup-key", "k1", "--title", "fresh"], { channel: h.channel, log: h.log });
    const second = await runOperatorNotify(["resolve", "--dedup-key", "k1"], { channel: h.channel, log: h.log });
    assert.equal(first.exitCode, 0);
    assert.deepEqual(JSON.parse(first.stdout).result, { sent: true, kind: "recovered" });
    assert.equal(JSON.parse(second.stdout).result.reason, "not-bad");
    assert.equal(h.sent.length, 2);
  });

  test("brief appends to the Morning Brief store; a page kind is a usage error", async () => {
    const store = memoryStore();
    const h = harness(store);
    const ok = await runOperatorNotify(["brief", "--kind", "service:unit_failed", "--title", "t"], { channel: h.channel, log: h.log });
    assert.equal(ok.exitCode, 0);
    assert.equal(store.briefs.length, 1);
    const bad = await runOperatorNotify(["brief", "--kind", "service:tunnel_failed", "--title", "t"], { channel: h.channel, log: h.log });
    assert.equal(bad.exitCode, 2);
  });
});

describe("operator-notify CLI: classifyUnitExit (exit-code policy)", () => {
  test("clean SIGTERM shapes are 'clean'", () => {
    assert.equal(classifyUnitExit({ result: "exit-code", execMainCode: "1", execMainStatus: "143" }), "clean");
    assert.equal(classifyUnitExit({ result: "signal", execMainCode: "2", execMainStatus: "15" }), "clean");
  });

  test("every other combination, and an unreadable answer, is 'failed'", () => {
    assert.equal(classifyUnitExit({ result: "exit-code", execMainCode: "1", execMainStatus: "1" }), "failed");
    assert.equal(classifyUnitExit({ result: "timeout", execMainCode: "2", execMainStatus: "9" }), "failed");
    assert.equal(classifyUnitExit({}), "failed");
  });
});

describe("operator-notify CLI: service-failed", () => {
  test("a clean SIGTERM restart sends nothing (page or brief)", async () => {
    const store = memoryStore();
    const h = harness(store);
    const r = await runOperatorNotify(["service-failed", "--unit", "claw-street-bets-web"], {
      channel: h.channel,
      systemctl: async () => SIGTERM_SHOW,
      log: h.log,
    });
    assert.equal(r.exitCode, 0);
    assert.equal(h.sent.length, 0);
    assert.equal(store.briefs.length, 0);
  });

  test("a failing hydra-tunnel pages once per dedup window; the repeat is suppressed", async () => {
    const h = harness();
    const deps = { channel: h.channel, systemctl: async () => FAILED_SHOW, log: h.log };
    const a = await runOperatorNotify(["service-failed", "--unit", "hydra-tunnel.service"], deps);
    const b = await runOperatorNotify(["service-failed", "--unit", "hydra-tunnel"], deps);
    assert.equal(JSON.parse(a.stdout).kind, "service:tunnel_failed");
    assert.equal(JSON.parse(a.stdout).dedupKey, "service:hydra-tunnel");
    assert.equal(JSON.parse(a.stdout).result.sent, true);
    assert.equal(JSON.parse(b.stdout).result.reason, "suppressed");
    assert.equal(h.sent.length, 1);
  });

  test("backup units page as service:backup_failed with independent dedup", async () => {
    const h = harness();
    const deps = { channel: h.channel, systemctl: async () => FAILED_SHOW, log: h.log };
    await runOperatorNotify(["service-failed", "--unit", "hydra-redis-backup.service"], deps);
    await runOperatorNotify(["service-failed", "--unit", "hydra-pg-backup.service"], deps);
    assert.equal(h.sent.length, 2);
  });

  test("a Target/CSB unit failure goes to the Morning Brief, not a page", async () => {
    const store = memoryStore();
    const h = harness(store);
    await runOperatorNotify(["service-failed", "--unit", "claw-street-bets-web"], {
      channel: h.channel,
      systemctl: async () => FAILED_SHOW,
      log: h.log,
    });
    assert.equal(h.sent.length, 0);
    assert.equal(store.briefs.length, 1);
    assert.equal(store.briefs[0].kind, "service:unit_failed");
  });

  test("an unreadable systemctl answer fails toward paging", async () => {
    const h = harness();
    await runOperatorNotify(["service-failed", "--unit", "hydra-autopilot.service"], {
      channel: h.channel,
      systemctl: async () => {
        throw new Error("no bus");
      },
      log: h.log,
    });
    assert.equal(h.sent.length, 1);
  });
});

describe("operator-notify CLI: source invariants", () => {
  const src = readFileSync(CLI_PATH, "utf8");

  test("never contacts the orchestrator HTTP API", () => {
    assert.ok(!src.includes("localhost:4000"));
    assert.ok(!src.includes("/api/"));
  });

  test("strip-types entry point boots (--help)", () => {
    const r = spawnSync(process.execPath, ["--experimental-strip-types", CLI_PATH, "--help"], {
      encoding: "utf8",
      timeout: 20000,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /usage: operator-notify/);
  });
});
