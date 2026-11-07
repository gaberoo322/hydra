/**
 * Regression test for scripts/hydra-watchdog.sh — the part of the watchdog that
 * stays in bash after the #5099 collapse: the `## NODE MODULES INTEGRITY` check
 * (issue #4175), the check-table iteration (`plan`), and the CLI-start alarm.
 *
 * Context for the nm block: on 2026-08-19 a `/dev/shm` hydra-betting worktree's
 * `web/node_modules` symlink reached back through the main checkout and a
 * destructive install step wiped `/home/gabe/hydra-betting/web/node_modules`,
 * taking down six money-critical Target services for ~70 minutes with no signal.
 * The block asserts the structural invariant the incident violated (a watched
 * root exists, has `.bin/`, holds enough entries, the referenced binary is
 * executable) and delivers an enveloped in-band XADD plus an Operator Channel
 * page, with the SET-NX-since / fired dedup, threshold 0.
 *
 * Harness (env seams, never PATH shims, never source reads):
 *   - the WHOLE script is spawned (`bash scripts/hydra-watchdog.sh`);
 *   - HYDRA_WATCHDOG_NODE points at an argv-recording stub `node` that answers
 *     `plan` and records every subcommand it is asked to run;
 *   - HYDRA_WATCHDOG_OPERATOR_NOTIFY points at an argv-recording stub;
 *   - watched roots are synthetic temp dirs via HYDRA_WATCHDOG_NM_ROOTS (their
 *     path-derived signal names are unique per run, so no key can collide);
 *   - Redis cases use the launcher's run-OWNED DB and a per-run notify stream;
 *   - the one resolver case builds a PATH of symlinks to REAL coreutils with no
 *     node — it reproduces the systemd-unit PATH, it impersonates nothing.
 */

import test, { describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

import { NOTIFICATION_EVENT_TYPES as E } from "../src/event-bus-vocabulary.ts";
import { ALERT_TYPES, isPageKind } from "../src/operator-channel/page-list.ts";
import { WATCHDOG_CHECKS } from "../src/watchdog/checks.ts";
import { WATCHDOG_SPAWN_TIMEOUT_MS, WATCHDOG_REDIS_TIMEOUT_MS, throwIfTimedOut } from "./_helpers/watchdog-timeouts.mts";
import { ownedDbContext } from "./_helpers/owned-redis-db.mts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const WATCHDOG = join(REPO_ROOT, "scripts", "hydra-watchdog.sh");

/** The Redis key prefix the nm block uses (a persisted contract: a deploy mid-episode must not re-page). */
const NM_KEY_PREFIX = "hydra:autopilot:node-modules-integrity";
const NM_LOG = "hydra-node-modules-integrity-watchdog:";

const RUN_NS = `hydra:test:nm-integrity-${process.pid}-${randomUUID().slice(0, 8)}`;
const TEST_NOTIFY_STREAM = `${RUN_NS}:notifications`;

const { db: OWNED_DB, skip: OWNED_DB_SKIP } = ownedDbContext();

function dockerRedisAvailable(): boolean {
  const r = spawnSync("docker", ["exec", "hydra-redis-1", "redis-cli", "PING"], {
    encoding: "utf-8",
    timeout: WATCHDOG_REDIS_TIMEOUT_MS,
  });
  return (r.stdout ?? "").trim() === "PONG";
}
const DOCKER = dockerRedisAvailable();

function drc(args: string[]): string {
  const r = spawnSync("docker", ["exec", "hydra-redis-1", "redis-cli", "--raw", "-n", OWNED_DB ?? "0", ...args], {
    encoding: "utf-8",
    timeout: WATCHDOG_REDIS_TIMEOUT_MS,
  });
  return (r.stdout ?? "").trim();
}

const sigForRoot = (root: string): string => root.replace(/[^a-zA-Z0-9]+/g, "_").replace(/_+/g, "_");
const SINCE = (root: string): string => `${NM_KEY_PREFIX}:since:${sigForRoot(root)}`;
const FIRED = (root: string): string => `${NM_KEY_PREFIX}:fired:${sigForRoot(root)}`;
const getFired = (root: string): boolean => drc(["EXISTS", FIRED(root)]) === "1";

/** In-band entries off the per-run notify stream, envelope fields folded. */
function notifyEntries(): { fields: Record<string, string> }[] {
  const out = drc(["XRANGE", TEST_NOTIFY_STREAM, "-", "+"]);
  if (out === "") return [];
  const lines = out.split("\n");
  const FIELD_NAMES = ["id", "type", "source", "timestamp", "correlationId", "payload"];
  const entries: { fields: Record<string, string> }[] = [];
  let i = 0;
  while (i < lines.length) {
    i += 1; // skip entry-id line
    const fields: Record<string, string> = {};
    for (const name of FIELD_NAMES) {
      assert.equal(lines[i], name, `expected envelope field '${name}' at line ${i}: ${JSON.stringify(lines)}`);
      fields[name] = lines[i + 1];
      i += 2;
    }
    entries.push({ fields });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Harness: stub node + stub operator-notify, both recording argv.
// ---------------------------------------------------------------------------

const SCRATCH = mkdtempSync(join(tmpdir(), "hydra-watchdog-entry-"));
const NODE_STUB = join(SCRATCH, "node-stub");
const NODE_LOG = join(SCRATCH, "node-calls.log");
const NOTIFY_STUB = join(SCRATCH, "operator-notify-stub");
const NOTIFY_LOG = join(SCRATCH, "notify-calls.log");
const ALARM_DIR = join(SCRATCH, "alarm-state");
const ALARM_MARKER = join(ALARM_DIR, "hydra-watchdog-cli-failed.since");

writeFileSync(
  NODE_STUB,
  [
    "#!/bin/sh",
    '# argv: --experimental-strip-types <script> <subcommand>',
    'sub="$3"',
    'echo "$*" >> "$NODE_LOG"',
    'if [ "$sub" = plan ]; then',
    '  [ -n "$STUB_PLAN_RC" ] && exit "$STUB_PLAN_RC"',
    "  printf 'alpha\\thydra-alpha-watchdog:\\t11\\nbeta\\thydra-beta-watchdog:\\t22\\n'",
    "  exit 0",
    "fi",
    '[ "$sub" = beta ] && [ -n "$STUB_BETA_RC" ] && exit "$STUB_BETA_RC"',
    'echo "STUB-RAN $sub"',
    "",
  ].join("\n"),
);
writeFileSync(NOTIFY_STUB, ['#!/bin/sh', 'echo "$*" >> "$NOTIFY_LOG"', 'exit "${STUB_NOTIFY_RC:-0}"', ""].join("\n"));
chmodSync(NODE_STUB, 0o755);
chmodSync(NOTIFY_STUB, 0o755);

after(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

function lines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, "utf-8").trim().split("\n").filter(Boolean) : [];
}
const nodeCalls = (): string[] => lines(NODE_LOG);
const notifyCalls = (): string[] => lines(NOTIFY_LOG);

function resetLogs(): void {
  rmSync(NODE_LOG, { force: true });
  rmSync(NOTIFY_LOG, { force: true });
  rmSync(ALARM_DIR, { recursive: true, force: true });
  mkdirSync(ALARM_DIR, { recursive: true });
}

/** A healthy node_modules root (so the nm block is quiet on ticks that test something else). */
function makeHealthy(root: string, entries = 25): void {
  mkdirSync(join(root, ".bin"), { recursive: true });
  writeFileSync(join(root, ".bin", "tsx"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(join(root, ".bin", "tsx"), 0o755);
  for (let i = 0; i < entries; i++) mkdirSync(join(root, `pkg${i}`), { recursive: true });
}

const HEALTHY_ROOT = join(SCRATCH, "healthy-default");
makeHealthy(HEALTHY_ROOT);

function runScript(env: Record<string, string | undefined>, opts: { path?: string } = {}): { status: number; stdout: string; stderr: string } {
  const base: Record<string, string | undefined> = { ...process.env };
  const r = spawnSync("bash", [WATCHDOG], {
    env: {
      ...base,
      ...(opts.path !== undefined ? { PATH: opts.path } : {}),
      HYDRA_ROOT: REPO_ROOT,
      HYDRA_WATCHDOG_NODE: NODE_STUB,
      HYDRA_WATCHDOG_OPERATOR_NOTIFY: NOTIFY_STUB,
      HYDRA_WATCHDOG_CLI_ALARM_STATE_DIR: ALARM_DIR,
      HYDRA_WATCHDOG_NM_ROOTS: HEALTHY_ROOT,
      HYDRA_WATCHDOG_NM_NOTIFY_STREAM: TEST_NOTIFY_STREAM,
      HYDRA_REDIS_DB: OWNED_DB ?? "0",
      NODE_LOG,
      NOTIFY_LOG,
      ...env,
    },
    encoding: "utf-8",
    timeout: WATCHDOG_SPAWN_TIMEOUT_MS,
  });
  throwIfTimedOut(r, WATCHDOG_SPAWN_TIMEOUT_MS, "hydra-watchdog.sh tick");
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const nmLines = (stdout: string): string =>
  stdout
    .split("\n")
    .filter((l) => l.includes(NM_LOG))
    .join("\n");

// =============================================================================
// Vocabulary wiring (no Redis, no bash).
// =============================================================================

describe("issue #4175 — TypeScript vocabulary wiring", () => {
  test("event type exists in the vocabulary", () => {
    assert.equal(E.INFRA_NODE_MODULES_WIPED, "infra:node_modules_wiped");
  });

  test("is in BOTH ALERT_TYPES and the page list", () => {
    assert.ok(ALERT_TYPES.has(E.INFRA_NODE_MODULES_WIPED), "a wiped node_modules must raise a dashboard alert");
    assert.ok(isPageKind(E.INFRA_NODE_MODULES_WIPED), "a wiped node_modules must be a Page");
  });
});

// =============================================================================
// Entry point: the check-table iteration (no Redis).
// =============================================================================

describe("scripts/hydra-watchdog.sh — entry point iterates the `plan` table (issue #5099)", () => {
  beforeEach(resetLogs);

  test("sourcing the script runs nothing (entry-point guard) and exposes resolve_watchdog_node", () => {
    const r = spawnSync("bash", ["-c", `source ${JSON.stringify(WATCHDOG)}; resolve_watchdog_node`], {
      env: { ...process.env, HYDRA_WATCHDOG_NODE: NODE_STUB },
      encoding: "utf-8",
      timeout: WATCHDOG_SPAWN_TIMEOUT_MS,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), NODE_STUB, "only the resolver's path is printed; no tick ran");
  });

  test("asks the CLI for `plan`, then runs every row as its own subcommand process, in plan order", () => {
    const r = runScript({});
    assert.equal(r.status, 0, r.stderr);
    const calls = nodeCalls().map((c) => c.split(" "));
    for (const c of calls) {
      assert.equal(c[0], "--experimental-strip-types");
      assert.equal(c[1], join(REPO_ROOT, "scripts", "hydra-watchdog.ts"));
    }
    assert.deepEqual(calls.map((c) => c[2]), ["plan", "alpha", "beta"]);
    assert.match(r.stdout, /STUB-RAN alpha/);
    assert.match(r.stdout, /STUB-RAN beta/);
    assert.equal(notifyCalls().length, 0, "a clean tick pages nothing");
  });

  test("a single check's non-zero rc is ONE WARN line, never aborts the tick, and does NOT raise the CLI-start alarm", () => {
    const r = runScript({ STUB_BETA_RC: "7" });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /hydra-beta-watchdog: WARN beta CLI FAILED \(rc=7\) — beta check skipped this tick/);
    assert.equal(r.stdout.match(/CLI FAILED/g)?.length, 1, "exactly one WARN");
    assert.equal(notifyCalls().length, 0, "no page for a single check failing");
    assert.equal(existsSync(ALARM_MARKER), false);
    assert.match(nmLines(r.stdout), /tick processed/, "the nm block still ran");
  });

  test("the real plan names every WATCHDOG_CHECKS row (the CLI prints the table bash iterates)", () => {
    const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", join(REPO_ROOT, "scripts", "hydra-watchdog.ts"), "plan"], {
      encoding: "utf-8",
      timeout: WATCHDOG_SPAWN_TIMEOUT_MS,
    });
    throwIfTimedOut(r, WATCHDOG_SPAWN_TIMEOUT_MS, "hydra-watchdog.ts plan");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(
      r.stdout.trim().split("\n").map((l) => l.split("\t")[0]),
      WATCHDOG_CHECKS.map((c) => c.subcommand),
    );
  });
});

// =============================================================================
// The CLI-start alarm (no Redis).
// =============================================================================

describe("scripts/hydra-watchdog.sh — CLI-start alarm (issue #5099)", () => {
  beforeEach(resetLogs);

  test("a failing `plan` pages infra:watchdog_cli_failed ONCE, skips every check, still runs the nm block", () => {
    const r = runScript({ STUB_PLAN_RC: "7" });
    assert.equal(r.status, 0, "the script always exits 0");
    assert.match(r.stdout, /hydra-watchdog-cli: WARN watchdog CLI failed to start \(reason=plan-failed, rc=7\)/);
    assert.deepEqual(nodeCalls().map((c) => c.split(" ")[2]), ["plan"], "no check ran");
    const calls = notifyCalls();
    assert.equal(calls.length, 1);
    assert.match(
      calls[0],
      /^page --kind infra:watchdog_cli_failed --dedup-key infra:watchdog_cli_failed --title Watchdog CLI failed to start \(plan-failed\) --fact reason=plan-failed --fact rc=7$/,
    );
    assert.equal(existsSync(ALARM_MARKER), true, "marker written after the CLI exited 0");
    assert.match(nmLines(r.stdout), /tick processed/, "the nm block must not depend on the CLI");

    const again = runScript({ STUB_PLAN_RC: "7" });
    assert.equal(again.status, 0);
    assert.equal(notifyCalls().length, 1, "the marker holds the dedup: no second page");
  });

  test("an operator-notify failure leaves NO marker, so the next tick retries", () => {
    runScript({ STUB_PLAN_RC: "7", STUB_NOTIFY_RC: "1" });
    assert.equal(notifyCalls().length, 1);
    assert.equal(existsSync(ALARM_MARKER), false, "marker only written when the CLI exited 0");
    runScript({ STUB_PLAN_RC: "7" });
    assert.equal(notifyCalls().length, 2, "retried");
    assert.equal(existsSync(ALARM_MARKER), true);
  });

  test("the next tick whose plan succeeds resolves the page, then clears the marker", () => {
    runScript({ STUB_PLAN_RC: "7" });
    assert.equal(existsSync(ALARM_MARKER), true);
    const ok = runScript({});
    assert.equal(ok.status, 0);
    const calls = notifyCalls();
    assert.equal(calls.length, 2);
    assert.match(calls[1], /^resolve --dedup-key infra:watchdog_cli_failed --title Watchdog CLI starts again$/);
    assert.equal(existsSync(ALARM_MARKER), false);
    assert.deepEqual(nodeCalls().slice(-2).map((c) => c.split(" ")[2]), ["alpha", "beta"], "checks resume");

    runScript({});
    assert.equal(notifyCalls().length, 2, "a quiet healthy tick neither pages nor resolves");
  });

  test("a failed resolve keeps the marker (retry-until-delivered)", () => {
    runScript({ STUB_PLAN_RC: "7" });
    runScript({ STUB_NOTIFY_RC: "1" });
    assert.equal(existsSync(ALARM_MARKER), true);
  });

  test("nvm-only node, NO notify override: the page is delivered through the resolved node (not bare `node`)", () => {
    const bin = join(SCRATCH, "nvmonly-bin");
    mkdirSync(bin, { recursive: true });
    for (const tool of ["bash", "timeout", "ls", "sort", "tail", "dirname", "env", "date", "find", "wc", "tr", "mktemp", "rm", "grep", "cut", "cat", "head", "sh"]) {
      const found = spawnSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf-8" }).stdout.trim();
      if (found && !existsSync(join(bin, tool))) symlinkSync(found, join(bin, tool));
    }
    const home = join(SCRATCH, "nvmonly-home");
    const nvmBin = join(home, ".nvm", "versions", "node", "v99.0.0", "bin");
    mkdirSync(nvmBin, { recursive: true });
    symlinkSync(NODE_STUB, join(nvmBin, "node"));
    const r = runScript(
      { HYDRA_WATCHDOG_NODE: "", HYDRA_WATCHDOG_OPERATOR_NOTIFY: "", HOME: home, STUB_PLAN_RC: "7", HYDRA_REDIS_HOST: "127.0.0.1", HYDRA_REDIS_PORT: "9" },
      { path: bin },
    );
    assert.equal(r.status, 0, r.stderr);
    const calls = nodeCalls();
    const page = calls.find((c) => c.includes("operator-notify.ts"));
    assert.ok(page, `the page must run via the nvm node stub; node calls: ${calls.join(" | ")}`);
    assert.match(page, /operator-notify\.ts page --kind infra:watchdog_cli_failed /);
    assert.equal(existsSync(ALARM_MARKER), true, "page delivered => marker written");
  });

  test("no node anywhere (the unit's minimal PATH, no nvm) raises the alarm with reason node-missing", () => {
    const bin = join(SCRATCH, "nodeless-bin");
    mkdirSync(bin, { recursive: true });
    for (const tool of ["bash", "timeout", "ls", "sort", "tail", "dirname", "env", "date", "find", "wc", "tr", "mktemp", "rm", "grep", "cut", "cat", "head"]) {
      const found = spawnSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf-8" }).stdout.trim();
      if (found && !existsSync(join(bin, tool))) symlinkSync(found, join(bin, tool));
    }
    const home = join(SCRATCH, "nodeless-home");
    mkdirSync(home, { recursive: true });
    const r = runScript(
      { HYDRA_WATCHDOG_NODE: "", HOME: home, HYDRA_REDIS_HOST: "127.0.0.1", HYDRA_REDIS_PORT: "9" },
      { path: bin },
    );
    assert.equal(r.status, 0);
    assert.match(r.stdout, /watchdog CLI failed to start \(reason=node-missing, rc=127\)/);
    assert.match(notifyCalls()[0] ?? "", /^page --kind infra:watchdog_cli_failed .* --fact reason=node-missing --fact rc=127$/);
    assert.match(nmLines(r.stdout), /tick processed/, "the nm block still ran without node");
  });
});

// =============================================================================
// Behavioural cases for the nm block — gated on the docker Redis + an owned DB.
// =============================================================================

describe("node-modules-integrity — detection + delivery (issue #4175)", { skip: !DOCKER ? "docker hydra-redis-1 unavailable" : OWNED_DB_SKIP }, () => {
  let wiped: string;
  let missingBin: string;
  let healthy: string;
  let absent: string;

  function cleanState(): void {
    for (const root of [wiped, missingBin, healthy, absent]) if (root) drc(["DEL", SINCE(root), FIRED(root)]);
    drc(["DEL", TEST_NOTIFY_STREAM]);
  }

  beforeEach(() => {
    resetLogs();
    wiped = join(SCRATCH, "wiped");
    missingBin = join(SCRATCH, "missing-bin");
    healthy = join(SCRATCH, "healthy");
    absent = join(SCRATCH, "does-not-exist");
    for (const d of [wiped, missingBin, healthy]) rmSync(d, { recursive: true, force: true });
    // "wiped": measured incident state — 24K, no .bin/, no packages.
    mkdirSync(wiped, { recursive: true });
    writeFileSync(join(wiped, "some-leftover-file"), "x");
    // "missing-bin": .bin/ exists and the floor is met, but the referenced binary is absent (203/EXEC).
    mkdirSync(join(missingBin, ".bin"), { recursive: true });
    for (let i = 0; i < 25; i++) mkdirSync(join(missingBin, `pkg${i}`), { recursive: true });
    makeHealthy(healthy);
    cleanState();
  });

  after(() => {
    cleanState();
  });

  const tick = (roots: string, extra: Record<string, string> = {}) =>
    runScript({ HYDRA_WATCHDOG_NM_ROOTS: roots, HYDRA_WATCHDOG_NM_ENTRY_FLOOR: "20", ...extra });

  test("fires on a synthetic wiped tree (no .bin/, below entry floor): XADD envelope + page", () => {
    const r = tick(wiped);
    assert.equal(r.status, 0, `the script must never exit non-zero: ${r.stderr}`);
    assert.match(nmLines(r.stdout), /WARNING NODE_MODULES INTEGRITY/);
    assert.match(nmLines(r.stdout), /no-bin-dir/, "reason must name the missing .bin/ dir");
    assert.ok(getFired(wiped), "fired marker must be set");
    assert.equal(drc(["EXISTS", SINCE(wiped)]), "1", "since anchor set");
    const entries = notifyEntries();
    assert.equal(entries.length, 1, "exactly one in-band delivery for the wiped root");
    assert.equal(entries[0].fields.type, E.INFRA_NODE_MODULES_WIPED);
    assert.equal(entries[0].fields.source, "watchdog-node-modules-integrity");
    assert.match(entries[0].fields.correlationId, /^node-modules-integrity-/);
    const payload = JSON.parse(entries[0].fields.payload);
    assert.equal(payload.reason, "no-bin-dir");
    assert.equal(payload.thresholdMs, 0);
    const pages = notifyCalls().filter((c) => c.startsWith("page "));
    assert.equal(pages.length, 1);
    assert.match(pages[0], /^page --kind infra:node_modules_wiped --dedup-key infra:node_modules_wiped --title node_modules integrity: /);
    assert.match(pages[0], /--fact reason=no-bin-dir/);
  });

  test("fires separately when .bin/ exists but the referenced binary is missing (203/EXEC case)", () => {
    const r = tick(missingBin, { HYDRA_WATCHDOG_NM_REQUIRED_BIN: "tsx" });
    assert.equal(r.status, 0);
    assert.match(nmLines(r.stdout), /missing-binary:tsx/, "reason must name the missing binary");
    assert.ok(getFired(missingBin));
  });

  test("reports below-entry-floor with the measured count", () => {
    const r = tick(healthy, { HYDRA_WATCHDOG_NM_ENTRY_FLOOR: "999" });
    assert.match(nmLines(r.stdout), /below-entry-floor:\d+<999/);
  });

  test("stays quiet against a healthy install", () => {
    const r = tick(healthy);
    assert.equal(r.status, 0);
    assert.doesNotMatch(nmLines(r.stdout), /WARNING/, "a healthy install must never warn");
    assert.ok(!getFired(healthy));
    assert.equal(notifyEntries().length, 0);
    assert.equal(notifyCalls().filter((c) => c.startsWith("page ")).length, 0);
  });

  test("checks multiple watched roots independently (colon-separated list)", () => {
    const r = tick(`${wiped}:${healthy}`);
    assert.match(nmLines(r.stdout), /2 root\(s\) watched/);
    assert.ok(getFired(wiped), "the broken root must fire");
    assert.ok(!getFired(healthy), "the healthy root must not fire");
    assert.equal(notifyEntries().length, 1, "only the broken root delivers");
  });

  test("dedup: a second consecutive broken tick does not re-deliver", () => {
    tick(wiped);
    assert.equal(notifyEntries().length, 1);
    const r2 = tick(wiped);
    assert.equal(r2.status, 0);
    assert.doesNotMatch(nmLines(r2.stdout), /WARNING/, "the fired marker must suppress a re-warn");
    assert.equal(notifyEntries().length, 1);
    assert.equal(notifyCalls().filter((c) => c.startsWith("page ")).length, 1);
  });

  test("recovery resolves once, clears both markers, and a fresh streak re-delivers", () => {
    tick(wiped);
    assert.ok(getFired(wiped));

    makeHealthy(wiped); // recover the same path in place
    tick(wiped);
    assert.ok(!getFired(wiped), "recovery must DEL the fired marker");
    assert.equal(drc(["EXISTS", SINCE(wiped)]), "0", "recovery must DEL the since anchor");
    const resolves = notifyCalls().filter((c) => c.startsWith("resolve "));
    assert.equal(resolves.length, 1);
    assert.match(resolves[0], /^resolve --dedup-key infra:node_modules_wiped --title node_modules integrity recovered: /);

    tick(wiped);
    assert.equal(notifyCalls().filter((c) => c.startsWith("resolve ")).length, 1, "no second resolve on a quiet healthy tick");

    rmSync(join(wiped, ".bin"), { recursive: true, force: true });
    const r3 = tick(wiped);
    assert.match(nmLines(r3.stdout), /WARNING NODE_MODULES INTEGRITY/, "a fresh streak must re-fire");
    assert.equal(notifyEntries().length, 2);
  });

  test("never exits non-zero even against an absent root", () => {
    const r = tick(absent);
    assert.equal(r.status, 0, `the script must be fail-safe: ${r.stderr}`);
    assert.match(nmLines(r.stdout), /root-absent/);
  });

  test("HYDRA_REDIS_DB threads through: writes land in the selected DB, never db 0 (issue #4183)", () => {
    assert.ok(OWNED_DB !== null, "full-suite launcher run must export an owned HYDRA_REDIS_DB (#5062)");
    tick(wiped);
    assert.equal(drc(["EXISTS", FIRED(wiped)]), "1", "fired marker lands in the selected DB");
    const atZero = spawnSync("docker", ["exec", "hydra-redis-1", "redis-cli", "--raw", "-n", "0", "EXISTS", FIRED(wiped)], {
      encoding: "utf-8",
      timeout: WATCHDOG_REDIS_TIMEOUT_MS,
    });
    assert.equal((atZero.stdout ?? "").trim(), "0", "a write with HYDRA_REDIS_DB set must never land in db 0");
  });

  test("a non-numeric HYDRA_REDIS_DB falls back to db 0 (the documented default)", () => {
    tick(wiped, { HYDRA_REDIS_DB: "not-a-number" });
    const atZero = spawnSync("docker", ["exec", "hydra-redis-1", "redis-cli", "--raw", "-n", "0", "EXISTS", FIRED(wiped)], {
      encoding: "utf-8",
      timeout: WATCHDOG_REDIS_TIMEOUT_MS,
    });
    assert.equal((atZero.stdout ?? "").trim(), "1", "fallback DB must be 0");
    spawnSync("docker", ["exec", "hydra-redis-1", "redis-cli", "-n", "0", "DEL", FIRED(wiped), SINCE(wiped)], { timeout: WATCHDOG_REDIS_TIMEOUT_MS });
  });
});
