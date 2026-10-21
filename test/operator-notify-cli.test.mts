/**
 * scripts/operator-notify.ts — the Operator Channel CLI (ADR-0045 Decision 2,
 * issue #5046), the one entry point bash and systemd use to reach the
 * operator's phone.
 *
 * Pinned here (the design-concept invariants for issue-5046):
 *   INV-1  orchestrator-independent: the CLI imports src/operator-channel/
 *          directly; its source never names the orchestrator HTTP service.
 *   INV-2  fail open, always terminate: a Redis-down run (every store method
 *          rejects) still sends the page; the shebang + runtime are
 *          node --experimental-strip-types.
 *   INV-3  exit 0 for every delivery outcome, 2 only for a usage error.
 *   INV-4  exit-code policy: (exited, 143) and (killed, SIGTERM/15) are clean
 *          and send nothing; everything else (incl. an unreadable systemctl
 *          answer) is failed — fail toward paging, never toward silence.
 *   INV-5  severity from the closed list, never the producer: the unit→kind
 *          map decides page vs. brief; `page` rejects a non-page kind.
 *   INV-6  dedup identity: service pages dedup on `service:<unit-base>`; a
 *          crash-looping unit yields exactly one page per window.
 *   INV-7  `%i` tolerance: one trailing `.service` is stripped.
 *
 * In-process through the exported `runOperatorNotify(argv, deps)` with a fake
 * transport, a rejecting / in-memory store and an injected `systemctl`; two
 * subprocess cases boot the real strip-types entry point (`--help`, and the
 * unit-shaped clean-exit path through a PATH-shim `systemctl`, the pattern
 * test/autopilot-watchdog.test.mts uses). No network, no real credentials.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { DedupState, DeliveryLogEntry } from "../src/redis/operator-channel.ts";
import type { OperatorChannelStore } from "../src/operator-channel/channel.ts";
import type { TelegramTransportFn } from "../src/notify.ts";
import { isPageKind } from "../src/operator-channel/page-list.ts";
import {
  runOperatorNotify,
  classifyUnitExit,
  parseSystemctlShow,
  stripUnitSuffix,
  parseArgs,
  UNIT_PAGE_KINDS,
  UNIT_FAILED_BRIEF_KIND,
  USAGE_EXIT_CODE,
  SYSTEMCTL_SHOW_PROPERTIES,
} from "../scripts/operator-notify.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const CLI = join(REPO_ROOT, "scripts", "operator-notify.ts");
const CLI_SOURCE = readFileSync(CLI, "utf-8");

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function fakeTransport(result: Awaited<ReturnType<TelegramTransportFn>> = { ok: true, mode: "HTML" }) {
  const sent: string[] = [];
  const transport: TelegramTransportFn = async (text) => {
    sent.push(text);
    return result;
  };
  return { sent, transport };
}

/** Every method rejects — Redis is down. */
function rejectingStore(): OperatorChannelStore {
  const down = async () => {
    throw new Error("ECONNREFUSED redis down");
  };
  return { readDedup: down, writeDedup: down, incrSuppressed: down, delDedup: down, appendBrief: down, appendLog: down };
}

/** In-memory store so dedup / brief / log effects can be asserted. */
function memoryStore() {
  const dedup = new Map<string, DedupState>();
  const briefs: Record<string, unknown>[] = [];
  const log: DeliveryLogEntry[] = [];
  const store: OperatorChannelStore = {
    async readDedup(k) {
      return dedup.get(k) ?? null;
    },
    async writeDedup(k, s) {
      dedup.set(k, s);
    },
    async incrSuppressed(k) {
      const s = dedup.get(k);
      if (s) dedup.set(k, { ...s, suppressed: s.suppressed + 1 });
    },
    async delDedup(k) {
      dedup.delete(k);
    },
    async appendBrief(item) {
      briefs.push(item);
    },
    async appendLog(entry) {
      log.push(entry);
    },
  };
  return { store, dedup, briefs, log };
}

function collectStdout() {
  const lines: string[] = [];
  return { lines, stdout: (l: string) => lines.push(l) };
}

const SHOW_CLEAN_143 = "Result=exit-code\nExecMainCode=exited\nExecMainStatus=143\nNRestarts=0\n";
const SHOW_CLEAN_SIGTERM = "Result=signal\nExecMainCode=killed\nExecMainStatus=15\nNRestarts=1\n";
const SHOW_FAILED_1 = "Result=exit-code\nExecMainCode=exited\nExecMainStatus=1\nNRestarts=3\n";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("operator-notify: exit-code policy (INV-4, ADR-0045 Decision 4)", () => {
  test("classifyUnitExit: (exited, 143) and (killed, SIGTERM/15) are clean", () => {
    assert.equal(classifyUnitExit({ execMainCode: "exited", execMainStatus: "143" }), "clean");
    assert.equal(classifyUnitExit({ execMainCode: "1", execMainStatus: "143" }), "clean");
    assert.equal(classifyUnitExit({ execMainCode: "killed", execMainStatus: "15" }), "clean");
    assert.equal(classifyUnitExit({ execMainCode: "killed", execMainStatus: "SIGTERM" }), "clean");
    assert.equal(classifyUnitExit({ execMainCode: "2", execMainStatus: "TERM" }), "clean");
  });

  test("classifyUnitExit: every other combination is failed — fail toward paging, never toward silence", () => {
    assert.equal(classifyUnitExit({ execMainCode: "exited", execMainStatus: "1" }), "failed");
    assert.equal(classifyUnitExit({ execMainCode: "exited", execMainStatus: "0", result: "timeout" }), "failed");
    assert.equal(classifyUnitExit({ execMainCode: "killed", execMainStatus: "9" }), "failed");
    assert.equal(classifyUnitExit({ execMainCode: "killed", execMainStatus: "SIGKILL" }), "failed");
    assert.equal(classifyUnitExit({ execMainCode: "exited", execMainStatus: "15" }), "failed", "exit CODE 15 is not a SIGTERM");
    assert.equal(classifyUnitExit({ result: "oom-kill" }), "failed", "an unreadable/absent answer is failed");
    assert.equal(classifyUnitExit({}), "failed");
  });

  test("classifyUnitExit: a unit-level failure Result wins over a clean-looking exit pair (start-limit-hit crash loop of 143s)", () => {
    assert.equal(classifyUnitExit({ result: "start-limit-hit", execMainCode: "exited", execMainStatus: "143" }), "failed");
    for (const result of ["watchdog", "oom-kill", "core-dump", "timeout", "resources", "protocol"]) {
      assert.equal(classifyUnitExit({ result, execMainCode: "killed", execMainStatus: "15" }), "failed", `Result=${result} must page`);
    }
    // The clean cases still hold with a benign Result.
    assert.equal(classifyUnitExit({ result: "exit-code", execMainCode: "exited", execMainStatus: "143" }), "clean");
    assert.equal(classifyUnitExit({ result: "signal", execMainCode: "killed", execMainStatus: "15" }), "clean");
  });

  test("parseSystemctlShow reads the four properties and ignores the rest", () => {
    const f = parseSystemctlShow("Result=exit-code\nExecMainCode=exited\nExecMainStatus=143\nNRestarts=2\nActiveState=failed\n");
    assert.deepEqual(f, { result: "exit-code", execMainCode: "exited", execMainStatus: "143", nRestarts: "2" });
    assert.deepEqual(parseSystemctlShow(""), {});
    assert.deepEqual(parseSystemctlShow("garbage without equals"), {});
  });

  test("stripUnitSuffix strips exactly one trailing .service (INV-7)", () => {
    assert.equal(stripUnitSuffix("hydra-autopilot.service"), "hydra-autopilot");
    assert.equal(stripUnitSuffix("claw-street-bets-web"), "claw-street-bets-web");
    assert.equal(stripUnitSuffix("hydra-autopilot.service.service"), "hydra-autopilot.service");
  });

  test("the unit→kind map covers exactly the Decision 3 service kinds and every target is a page kind (INV-5)", () => {
    assert.deepEqual(UNIT_PAGE_KINDS, {
      "hydra-orchestrator": "service:orchestrator_failed",
      "hydra-autopilot": "service:autopilot_failed",
      "hydra-tunnel": "service:tunnel_failed",
      "hydra-redis-backup": "service:backup_failed",
      "hydra-pg-backup": "service:backup_failed",
    });
    for (const kind of Object.values(UNIT_PAGE_KINDS)) assert.ok(isPageKind(kind), `${kind} must be on the closed list`);
    assert.equal(isPageKind(UNIT_FAILED_BRIEF_KIND), false, "the brief kind must never be a page");
  });

  test("parseArgs: repeated --fact / --link, --help anywhere, bare words rejected", () => {
    const p = parseArgs(["page", "--kind", "k", "--fact", "a=1", "--fact", "b=x=y", "--link", "Run=https://x/y"]);
    assert.equal(p.subcommand, "page");
    assert.deepEqual(p.facts, [{ label: "a", value: "1" }, { label: "b", value: "x=y" }]);
    assert.deepEqual(p.links, [{ label: "Run", url: "https://x/y" }]);
    assert.equal(parseArgs(["--help"]).help, true);
    assert.equal(parseArgs(["page", "--help"]).help, true);
    assert.throws(() => parseArgs(["page", "stray"]), /unexpected argument/);
    assert.throws(() => parseArgs(["page", "--kind"]), /needs a value/);
  });
});

// ---------------------------------------------------------------------------
// In-process runner
// ---------------------------------------------------------------------------

describe("operator-notify: page / resolve / brief through runOperatorNotify (INV-2, INV-3, INV-5)", () => {
  test("Redis down (every store call rejects): the page is still sent, exit 0, one JSON line", async () => {
    const { sent, transport } = fakeTransport();
    const { lines, stdout } = collectStdout();
    const r = await runOperatorNotify(
      ["page", "--kind", "infra:redis_backup_stale", "--dedup-key", "infra:redis_backup_stale", "--title", "Redis backup stale", "--fact", "age_ms=999", "--link", "Runbook=https://example.test/rb"],
      { transport, store: rejectingStore(), stdout, host: "testhost", timeoutMs: 50 },
    );
    assert.equal(r.exitCode, 0);
    assert.equal(sent.length, 1, "the page is sent despite Redis being down (fail open)");
    assert.match(sent[0], /Redis backup stale/);
    assert.match(sent[0], /age_ms: <code>999<\/code>/);
    assert.match(sent[0], /host: <code>testhost<\/code>/);
    assert.match(sent[0], /<a href="https:\/\/example.test\/rb">Runbook<\/a>/);
    assert.equal(lines.length, 1, "exactly one stdout line");
    const out = JSON.parse(lines[0]);
    assert.deepEqual(out, {
      subcommand: "page",
      kind: "infra:redis_backup_stale",
      dedupKey: "infra:redis_backup_stale",
      result: { sent: true, kind: "page" },
    });
  });

  test("a page kind not on the closed list is a usage error: exit 2, nothing sent (the CLI never decides severity)", async () => {
    const { sent, transport } = fakeTransport();
    const { lines, stdout } = collectStdout();
    const r = await runOperatorNotify(["page", "--kind", "cycle:completed", "--dedup-key", "x"], { transport, store: rejectingStore(), stdout });
    assert.equal(r.exitCode, USAGE_EXIT_CODE);
    assert.equal(sent.length, 0);
    assert.match(JSON.parse(lines[0]).result.usageError, /not on the closed page list/);
  });

  test("usage errors exit 2: unknown subcommand, no subcommand, missing --kind / --dedup-key / --unit", async () => {
    const { transport } = fakeTransport();
    const deps = { transport, store: rejectingStore(), stdout: () => {} };
    assert.equal((await runOperatorNotify(["bogus"], deps)).exitCode, USAGE_EXIT_CODE);
    assert.equal((await runOperatorNotify([], deps)).exitCode, USAGE_EXIT_CODE);
    assert.equal((await runOperatorNotify(["page", "--dedup-key", "k"], deps)).exitCode, USAGE_EXIT_CODE);
    assert.equal((await runOperatorNotify(["page", "--kind", "service:tunnel_failed"], deps)).exitCode, USAGE_EXIT_CODE);
    assert.equal((await runOperatorNotify(["resolve"], deps)).exitCode, USAGE_EXIT_CODE);
    assert.equal((await runOperatorNotify(["brief"], deps)).exitCode, USAGE_EXIT_CODE);
    assert.equal((await runOperatorNotify(["service-failed"], deps)).exitCode, USAGE_EXIT_CODE);
  });

  test("--help exits 0 and prints the usage without touching the store", async () => {
    const { lines, stdout } = collectStdout();
    const r = await runOperatorNotify(["--help"], { store: rejectingStore(), stdout });
    assert.equal(r.exitCode, 0);
    assert.match(lines.join("\n"), /operator-notify page/);
  });

  test("every delivery outcome exits 0: suppressed, no-credentials, transport-failed, not-bad", async () => {
    const mem = memoryStore();
    const { transport } = fakeTransport();
    const quiet = { stdout: () => {} };
    const first = await runOperatorNotify(["page", "--kind", "service:tunnel_failed", "--dedup-key", "service:hydra-tunnel"], { transport, store: mem.store, ...quiet });
    assert.deepEqual(first.output?.result, { sent: true, kind: "page" });
    const second = await runOperatorNotify(["page", "--kind", "service:tunnel_failed", "--dedup-key", "service:hydra-tunnel"], { transport, store: mem.store, ...quiet });
    assert.equal(second.exitCode, 0);
    assert.deepEqual(second.output?.result, { sent: false, reason: "suppressed" });

    const noCreds = fakeTransport({ ok: false, reason: "no-credentials", error: "missing" });
    const nc = await runOperatorNotify(["page", "--kind", "service:autopilot_failed", "--dedup-key", "service:hydra-autopilot"], { transport: noCreds.transport, store: rejectingStore(), ...quiet, timeoutMs: 50 });
    assert.equal(nc.exitCode, 0);
    assert.deepEqual(nc.output?.result, { sent: false, reason: "no-credentials" });

    const failing = fakeTransport({ ok: false, status: 502, error: "bad gateway" });
    const tf = await runOperatorNotify(["page", "--kind", "service:orchestrator_failed", "--dedup-key", "service:hydra-orchestrator"], { transport: failing.transport, store: rejectingStore(), ...quiet, timeoutMs: 50 });
    assert.equal(tf.exitCode, 0);
    assert.deepEqual(tf.output?.result, { sent: false, reason: "transport-failed" });

    const nb = await runOperatorNotify(["resolve", "--dedup-key", "never-bad"], { transport, store: mem.store, ...quiet });
    assert.equal(nb.exitCode, 0);
    assert.deepEqual(nb.output?.result, { sent: false, reason: "not-bad" });
  });

  test("resolve on a bad key sends one recovered message and clears the dedup state", async () => {
    const mem = memoryStore();
    const { sent, transport } = fakeTransport();
    const quiet = { stdout: () => {} };
    await runOperatorNotify(["page", "--kind", "launch:fail_safe", "--dedup-key", "launch:fail_safe", "--title", "Launch flow fail-safe"], { transport, store: mem.store, ...quiet });
    assert.ok(mem.dedup.has("launch:fail_safe"), "precondition: key is bad");
    const r = await runOperatorNotify(["resolve", "--dedup-key", "launch:fail_safe", "--title", "Launch flow fail-safe recovered"], { transport, store: mem.store, ...quiet });
    assert.equal(r.exitCode, 0);
    assert.deepEqual(r.output?.result, { sent: true, kind: "recovered" });
    assert.equal(sent.length, 2);
    assert.match(sent[1], /recovered — <b>Launch flow fail-safe recovered<\/b>/);
    assert.equal(mem.dedup.has("launch:fail_safe"), false, "resolve clears the key");
  });

  test("brief appends a Morning Brief item; a page kind handed to brief is a usage error", async () => {
    const mem = memoryStore();
    const { sent, transport } = fakeTransport();
    const quiet = { stdout: () => {} };
    const r = await runOperatorNotify(["brief", "--kind", "service:unit_failed", "--title", "Service failed: claw-street-bets-web", "--fact", "unit=claw-street-bets-web.service"], { transport, store: mem.store, host: "h", ...quiet });
    assert.equal(r.exitCode, 0);
    assert.deepEqual(r.output?.result, { appended: true });
    assert.equal(sent.length, 0, "a brief item is never sent immediately");
    assert.equal(mem.briefs.length, 1);
    assert.equal(mem.briefs[0].kind, "service:unit_failed");
    assert.equal(mem.briefs[0].severity, "brief");
    const bad = await runOperatorNotify(["brief", "--kind", "service:tunnel_failed", "--title", "x"], { transport, store: mem.store, ...quiet });
    assert.equal(bad.exitCode, USAGE_EXIT_CODE);
    assert.equal(mem.briefs.length, 1, "nothing appended for a page kind");
  });
});

describe("operator-notify: service-failed — exit-code policy, unit→kind map, dedup (INV-4..INV-7)", () => {
  const quiet = { stdout: () => {} };

  test("a clean SIGTERM restart (exit 143) sends nothing — page or brief — and only records the journal line", async () => {
    const mem = memoryStore();
    const { sent, transport } = fakeTransport();
    const seen: string[] = [];
    const systemctl = (u: string) => {
      seen.push(u);
      return SHOW_CLEAN_143;
    };
    const r = await runOperatorNotify(["service-failed", "--unit", "claw-street-bets-web"], { transport, store: mem.store, systemctl, ...quiet });
    assert.equal(r.exitCode, 0);
    assert.deepEqual(r.output, { subcommand: "service-failed", kind: null, dedupKey: "service:claw-street-bets-web", result: { skipped: "clean-exit" } });
    assert.equal(sent.length, 0);
    assert.equal(mem.briefs.length, 0);
    assert.equal(mem.log.length, 0);
    assert.deepEqual(seen, ["claw-street-bets-web.service"], "queries the unit with its .service suffix re-added");

    const sig = await runOperatorNotify(["service-failed", "--unit", "hydra-tunnel.service"], { transport, store: mem.store, systemctl: () => SHOW_CLEAN_SIGTERM, ...quiet });
    assert.deepEqual(sig.output?.result, { skipped: "clean-exit" });
    assert.equal(sent.length, 0, "a signal-killed SIGTERM is clean too");
  });

  test("a real failure of hydra-tunnel pages as service:tunnel_failed with dedupKey service:hydra-tunnel and the raw systemd facts", async () => {
    const mem = memoryStore();
    const { sent, transport } = fakeTransport();
    const r = await runOperatorNotify(["service-failed", "--unit", "hydra-tunnel.service"], { transport, store: mem.store, systemctl: () => SHOW_FAILED_1, host: "gabenuc", ...quiet });
    assert.equal(r.exitCode, 0);
    assert.equal(r.output?.kind, "service:tunnel_failed");
    assert.equal(r.output?.dedupKey, "service:hydra-tunnel");
    assert.deepEqual(r.output?.result, { sent: true, kind: "page" });
    assert.equal(sent.length, 1);
    assert.match(sent[0], /<b>Service failed: hydra-tunnel<\/b>/);
    assert.match(sent[0], /unit: <code>hydra-tunnel\.service<\/code>/);
    assert.match(sent[0], /Result: <code>exit-code<\/code>/);
    assert.match(sent[0], /ExecMainCode: <code>exited<\/code>/);
    assert.match(sent[0], /ExecMainStatus: <code>1<\/code>/);
    assert.match(sent[0], /NRestarts: <code>3<\/code>/);
    assert.match(sent[0], /host: <code>gabenuc<\/code>/);
  });

  test("%i tolerance: 'hydra-autopilot' and 'hydra-autopilot.service' resolve to the same unit and dedup key (INV-7)", async () => {
    const mem = memoryStore();
    const { sent, transport } = fakeTransport();
    const a = await runOperatorNotify(["service-failed", "--unit", "hydra-autopilot.service"], { transport, store: mem.store, systemctl: () => SHOW_FAILED_1, ...quiet });
    const b = await runOperatorNotify(["service-failed", "--unit", "hydra-autopilot"], { transport, store: mem.store, systemctl: () => SHOW_FAILED_1, ...quiet });
    assert.equal(a.output?.dedupKey, "service:hydra-autopilot");
    assert.equal(b.output?.dedupKey, "service:hydra-autopilot");
    assert.equal(a.output?.kind, "service:autopilot_failed");
    assert.deepEqual(b.output?.result, { sent: false, reason: "suppressed" }, "the second spelling dedups against the first");
    assert.equal(sent.length, 1);
  });

  test("a crash-looping hydra-tunnel yields exactly one page per 6h window; the second failure is suppressed; one reminder after 6h (INV-6)", async () => {
    const mem = memoryStore();
    const { sent, transport } = fakeTransport();
    let now = 1_700_000_000_000;
    const deps = { transport, store: mem.store, systemctl: () => SHOW_FAILED_1, now: () => now, ...quiet };
    const r1 = await runOperatorNotify(["service-failed", "--unit", "hydra-tunnel"], deps);
    assert.deepEqual(r1.output?.result, { sent: true, kind: "page" });
    now += 60_000;
    const r2 = await runOperatorNotify(["service-failed", "--unit", "hydra-tunnel"], deps);
    assert.equal(r2.exitCode, 0);
    assert.deepEqual(r2.output?.result, { sent: false, reason: "suppressed" });
    now += 3 * 60 * 60 * 1000;
    const r3 = await runOperatorNotify(["service-failed", "--unit", "hydra-tunnel"], deps);
    assert.deepEqual(r3.output?.result, { sent: false, reason: "suppressed" });
    assert.equal(sent.length, 1, "exactly one page in the window");
    now += 3 * 60 * 60 * 1000 + 1;
    const r4 = await runOperatorNotify(["service-failed", "--unit", "hydra-tunnel"], deps);
    assert.deepEqual(r4.output?.result, { sent: true, kind: "reminder" });
    assert.equal(sent.length, 2);
    assert.match(sent[1], /still failing/);
    assert.match(sent[1], /suppressed: <code>2 since/);
  });

  test("hydra-redis-backup and hydra-pg-backup both page as service:backup_failed but dedup independently", async () => {
    const mem = memoryStore();
    const { sent, transport } = fakeTransport();
    const a = await runOperatorNotify(["service-failed", "--unit", "hydra-redis-backup"], { transport, store: mem.store, systemctl: () => SHOW_FAILED_1, ...quiet });
    const b = await runOperatorNotify(["service-failed", "--unit", "hydra-pg-backup"], { transport, store: mem.store, systemctl: () => SHOW_FAILED_1, ...quiet });
    assert.equal(a.output?.kind, "service:backup_failed");
    assert.equal(b.output?.kind, "service:backup_failed");
    assert.equal(a.output?.dedupKey, "service:hydra-redis-backup");
    assert.equal(b.output?.dedupKey, "service:hydra-pg-backup");
    assert.deepEqual(b.output?.result, { sent: true, kind: "page" }, "a different unit is a different edge");
    assert.equal(sent.length, 2);
  });

  test("a Target/CSB unit failure becomes a Morning Brief item of kind service:unit_failed, never a page (INV-5)", async () => {
    const mem = memoryStore();
    const { sent, transport } = fakeTransport();
    for (const unit of ["claw-street-bets-web.service", "hydra-betting-web", "something-else"]) {
      const r = await runOperatorNotify(["service-failed", "--unit", unit], { transport, store: mem.store, systemctl: () => SHOW_FAILED_1, ...quiet });
      assert.equal(r.exitCode, 0);
      assert.equal(r.output?.kind, UNIT_FAILED_BRIEF_KIND);
      assert.deepEqual(r.output?.result, { appended: true });
    }
    assert.equal(sent.length, 0, "no immediate message for a brief-severity unit");
    assert.equal(mem.briefs.length, 3);
    assert.equal(mem.briefs[0].dedupKey, "service:claw-street-bets-web");
    assert.equal(mem.briefs[0].title, "Service failed: claw-street-bets-web");
  });

  test("an unreadable systemctl answer is failed — the page goes out with 'unreadable' facts (never silence)", async () => {
    const mem = memoryStore();
    const { sent, transport } = fakeTransport();
    const r = await runOperatorNotify(["service-failed", "--unit", "hydra-orchestrator"], {
      transport,
      store: mem.store,
      systemctl: () => {
        throw new Error("systemctl: command not found");
      },
      ...quiet,
    });
    assert.equal(r.exitCode, 0);
    assert.equal(r.output?.kind, "service:orchestrator_failed");
    assert.deepEqual(r.output?.result, { sent: true, kind: "page" });
    assert.match(sent[0], /ExecMainStatus: <code>unreadable<\/code>/);
    const garbage = await runOperatorNotify(["service-failed", "--unit", "hydra-tunnel"], { transport, store: mem.store, systemctl: () => "not=a\nreal answer", ...quiet });
    assert.deepEqual(garbage.output?.result, { sent: true, kind: "page" }, "an unparseable answer also fails toward paging");
  });

  test("Redis down on the OnFailure path: the tunnel page is still sent (fail open) and exits 0", async () => {
    const { sent, transport } = fakeTransport();
    const r = await runOperatorNotify(["service-failed", "--unit", "hydra-tunnel"], { transport, store: rejectingStore(), systemctl: () => SHOW_FAILED_1, timeoutMs: 50, ...quiet });
    assert.equal(r.exitCode, 0);
    assert.deepEqual(r.output?.result, { sent: true, kind: "page" });
    assert.equal(sent.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Source pins + the strip-types entry point (subprocess, no network)
// ---------------------------------------------------------------------------

describe("operator-notify: orchestrator-independent source and runtime (INV-1, INV-2, INV-10)", () => {
  test("INV-1: the CLI never names the orchestrator HTTP service", () => {
    assert.ok(!CLI_SOURCE.includes("localhost:4000"), "must not contain localhost:4000");
    assert.ok(!CLI_SOURCE.includes("/api/"), "must not contain an /api/ route string");
    assert.ok(!CLI_SOURCE.includes("http://"), "must not carry any http:// URL");
    assert.match(CLI_SOURCE, /from "\.\.\/src\/operator-channel\/index\.ts"/, "imports the channel module directly");
  });

  test("INV-10: shebang is node --experimental-strip-types; no npx / tsx; process.exit after the result + an unref'd 20s force-exit timer", () => {
    assert.equal(CLI_SOURCE.split("\n")[0], "#!/usr/bin/env -S node --experimental-strip-types");
    const code = CLI_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!/\bnpx\b/.test(code) && !/\btsx\b/.test(code), "no npx/tsx on a code line");
    assert.match(CLI_SOURCE, /FORCE_EXIT_MS = 20_000/);
    assert.match(CLI_SOURCE, /forceExit\.unref\(\)/);
    assert.match(CLI_SOURCE, /process\.exit\(exitCode\)/);
  });

  /** A scrubbed env: no TELEGRAM_*, Redis pointed at a closed port, deterministic logs. */
  function scrubbedEnv(extra: Record<string, string> = {}): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined || k.startsWith("TELEGRAM_")) continue;
      env[k] = v;
    }
    return { ...env, REDIS_URL: "redis://127.0.0.1:1", NODE_ENV: "test", ...extra };
  }

  test("the strip-types entry point boots: `node --experimental-strip-types scripts/operator-notify.ts --help` exits 0", () => {
    const r = spawnSync(process.execPath, ["--experimental-strip-types", CLI, "--help"], {
      encoding: "utf-8",
      timeout: 30_000,
      env: scrubbedEnv(),
    });
    assert.equal(r.status, 0, `exit ${r.status}; stderr=${r.stderr}`);
    assert.match(r.stdout, /operator-notify page/, "usage on stdout");
    assert.match(r.stdout, /service-failed --unit/);
  });

  test("unit-shaped: `service-failed --unit claw-street-bets-web.service` with a PATH-shim systemctl reporting exit 143 → clean-exit, exit 0, nothing sent", () => {
    const dir = mkdtempSync(join(tmpdir(), "hydra-operator-notify-"));
    try {
      const log = join(dir, "systemctl.log");
      const stub = join(dir, "systemctl");
      writeFileSync(stub, [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$*" >> '${log}'`,
        "printf 'Result=exit-code\\nExecMainCode=exited\\nExecMainStatus=143\\nNRestarts=0\\n'",
        "",
      ].join("\n"));
      chmodSync(stub, 0o755);
      const r = spawnSync(process.execPath, ["--experimental-strip-types", CLI, "service-failed", "--unit", "claw-street-bets-web.service"], {
        encoding: "utf-8",
        timeout: 30_000,
        env: scrubbedEnv({ PATH: `${dir}:${process.env.PATH ?? ""}` }),
      });
      assert.equal(r.status, 0, `exit ${r.status}; stderr=${r.stderr}`);
      const lines = r.stdout.split("\n").filter((l) => l !== "");
      assert.equal(lines.length, 1, `exactly one JSON line on stdout, got: ${JSON.stringify(lines)}`);
      assert.deepEqual(JSON.parse(lines[0]), {
        subcommand: "service-failed",
        kind: null,
        dedupKey: "service:claw-street-bets-web",
        result: { skipped: "clean-exit" },
      });
      assert.equal(
        readFileSync(log, "utf-8").trim(),
        `--user show claw-street-bets-web.service -p ${SYSTEMCTL_SHOW_PROPERTIES}`,
        "queries exactly the four properties of the suffixed unit",
      );
      assert.match(r.stderr, /clean SIGTERM \/ exit 143 stop/, "the journal line names the policy");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("usage error from the real entry point exits 2 with the JSON line and the usage on stderr", () => {
    const r = spawnSync(process.execPath, ["--experimental-strip-types", CLI, "page", "--kind", "not:a_page", "--dedup-key", "k"], {
      encoding: "utf-8",
      timeout: 30_000,
      env: scrubbedEnv(),
    });
    assert.equal(r.status, USAGE_EXIT_CODE, `exit ${r.status}; stderr=${r.stderr}`);
    assert.match(r.stdout, /"usageError"/);
    assert.match(r.stderr, /operator-notify page/);
  });
});
