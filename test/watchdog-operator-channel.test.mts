/**
 * Regression test for issue #5048 (ADR-0045 Decision 8) — the
 * `## MORNING BRIEF MISSING` block in scripts/hydra-watchdog.sh
 * (`run_brief_missing`): page ONCE when no Morning Brief has been delivered
 * for 26h, resolve on recovery, and do it INDEPENDENTLY of the scheduler's
 * running state (the brief rides the scheduler heartbeat tick, so a
 * deliberate `POST /scheduler/stop` silences it — the alarm must not share
 * that blind spot).
 *
 * Pinned here:
 *   1. Structure: the block is wired into the entry point, reads the
 *      TS-owned last-sent key name verbatim (drift guard against
 *      src/redis/operator-channel.ts), pages with the `brief:missing` kind
 *      that is on the closed page list (and in the ADR's Decision 3 list),
 *      and talks to NO orchestrator HTTP endpoint — redis-cli + the Operator
 *      Channel CLI only.
 *   2. Behaviour: cold-start grace (absent key → anchor, no page until the
 *      anchor is 26h old), stale key → one page per episode, a second stale
 *      tick re-pages nothing, a fresh key after a fired episode → one
 *      resolve + re-arm, the threshold hook, and the Redis-unreachable
 *      fail-safe (exit 0, no CLI call, no state).
 *
 * Isolation, mirroring test/watchdog-redis-backup-freshness.test.mts and
 * test/launch-flow-delivery.test.mts:
 *   - the extracted block COPY is rebound onto a per-run Redis key namespace
 *     (BOTH the last-sent key and the block's own anchor/fired prefix), so a
 *     live production tick can neither rewrite our fixtures nor be disturbed;
 *   - the Operator Channel CLI is intercepted through the block's
 *     HYDRA_WATCHDOG_OPERATOR_NOTIFY hook with an argv-recording stub — no
 *     network, no token, and no test ever boots the production CLI;
 *   - the clock is pinned through HYDRA_WATCHDOG_BRIEF_NOW_MS so no case sleeps.
 */

import test, { describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

import { BRIEF_LAST_SENT_KEY } from "../src/redis/operator-channel.ts";
import { PAGE_KINDS, isPageKind } from "../src/operator-channel/page-list.ts";
import {
  WATCHDOG_SPAWN_TIMEOUT_MS,
  WATCHDOG_REDIS_TIMEOUT_MS,
  throwIfTimedOut,
} from "./_helpers/watchdog-timeouts.mts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const WATCHDOG = join(REPO_ROOT, "scripts", "hydra-watchdog.sh");
const ADR = join(REPO_ROOT, "docs", "adr", "0045-operator-channel.md");

const BM_KEY_PREFIX_LITERAL = "hydra:autopilot:brief-missing";
const KIND = "brief:missing";
const HOUR_MS = 3600 * 1000;
const T0 = 1_760_000_000_000; // a fixed epoch ms; every case ages relative to it

// Per-run key namespace: nothing here may touch the production keys.
const RUN_NS = `hydra:test:brief-missing-${process.pid}-${randomUUID().slice(0, 8)}`;
const TEST_LAST_SENT_KEY = `${RUN_NS}:last-sent`;
const TEST_BM_PREFIX = `${RUN_NS}:bm`;
const ABSENT_KEY = `${TEST_BM_PREFIX}:absent-since`;
const FIRED_KEY = `${TEST_BM_PREFIX}:fired`;

function dockerRedisAvailable(): boolean {
  const r = spawnSync("docker", ["exec", "hydra-redis-1", "redis-cli", "PING"], {
    encoding: "utf-8",
    timeout: WATCHDOG_REDIS_TIMEOUT_MS,
  });
  return (r.stdout ?? "").trim() === "PONG";
}

const DOCKER = dockerRedisAvailable();

function drc(args: string[]): string {
  const r = spawnSync("docker", ["exec", "hydra-redis-1", "redis-cli", "--raw", ...args], {
    encoding: "utf-8",
    timeout: WATCHDOG_REDIS_TIMEOUT_MS,
  });
  return (r.stdout ?? "").trim();
}

// ---------------------------------------------------------------------------
// The block, extracted and rebound; the argv-recording CLI stub.
// ---------------------------------------------------------------------------

const SCRATCH = join(tmpdir(), `hydra-brief-missing-${process.pid}`);
const BLOCK = join(SCRATCH, "block.sh");
const NOTIFY_LOG = join(SCRATCH, "operator-notify-calls.log");
const NOTIFY_SHIM = join(SCRATCH, "operator-notify-stub");

function extractBlock(): string {
  const src = readFileSync(WATCHDOG, "utf-8");
  const start = src.indexOf("run_brief_missing()");
  assert.ok(start >= 0, "run_brief_missing() not found in hydra-watchdog.sh");
  const rest = src.slice(start);
  const end = rest.search(/^}/m);
  assert.ok(end >= 0, "run_brief_missing() closing brace not found");
  return rest.slice(0, end + 1);
}

before(() => {
  mkdirSync(SCRATCH, { recursive: true });
  const body = extractBlock();
  assert.ok(body.includes("deliver_page"), "extracted block missing deliver_page");
  assert.ok(body.includes("rc_write"), "extracted block missing rc_write");
  const rebound = body
    .split(`"${BRIEF_LAST_SENT_KEY}"`).join(`"${TEST_LAST_SENT_KEY}"`)
    .split(`"${BM_KEY_PREFIX_LITERAL}"`).join(`"${TEST_BM_PREFIX}"`);
  assert.ok(rebound.includes(`"${TEST_LAST_SENT_KEY}"`), "failed to rebind the last-sent key onto the test namespace");
  assert.ok(rebound.includes(`"${TEST_BM_PREFIX}"`), "failed to rebind the block's key prefix onto the test namespace");
  writeFileSync(BLOCK, rebound);
  // One invocation = one log line of the raw argv (newlines folded).
  writeFileSync(NOTIFY_SHIM, [
    "#!/usr/bin/env bash",
    `printf '%s' "$*" | tr '\\n' ' ' >> '${NOTIFY_LOG}'`,
    `printf '\\n' >> '${NOTIFY_LOG}'`,
    `printf '{"subcommand":"%s","kind":"${KIND}","dedupKey":"${KIND}","result":{"sent":true}}\\n' "$1"`,
    "exit 0",
    "",
  ].join("\n"));
  chmodSync(NOTIFY_SHIM, 0o755);
});

after(() => {
  try {
    unlinkSync(BLOCK);
  } catch {
    /* best-effort cleanup */
  }
  rmSync(SCRATCH, { recursive: true, force: true });
});

function notifyCalls(): string[] {
  if (!existsSync(NOTIFY_LOG)) return [];
  return readFileSync(NOTIFY_LOG, "utf-8").split("\n").filter((l) => l.trim() !== "");
}

function clearNotifyLog(): void {
  rmSync(NOTIFY_LOG, { force: true });
}

/** Source the extracted block and call it once. `extra` wins (last spread). */
function runBlock(extra: Record<string, string>): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("bash", ["-c", `set -euo pipefail; source '${BLOCK}'; run_brief_missing`], {
    env: {
      ...process.env,
      HYDRA_REDIS_HOST: "docker",
      // Pinned to "0": this suite's own drc seed/read helper is hardcoded to
      // db 0 with no `-n` selector (same reasoning as the sibling suites —
      // redis-db-launch.mjs exports HYDRA_REDIS_DB into the test env).
      HYDRA_REDIS_DB: "0",
      HYDRA_WATCHDOG_OPERATOR_NOTIFY: NOTIFY_SHIM,
      HYDRA_WATCHDOG_BRIEF_NOW_MS: String(T0),
      ...extra,
    },
    encoding: "utf-8",
    timeout: WATCHDOG_SPAWN_TIMEOUT_MS,
  });
  throwIfTimedOut(r, WATCHDOG_SPAWN_TIMEOUT_MS, "run_brief_missing block");
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function bmLines(stdout: string): string {
  return stdout
    .split("\n")
    .filter((l) => l.includes("hydra-brief-missing-watchdog:"))
    .join("\n");
}

// =============================================================================
// Structural cases — no Redis needed.
// =============================================================================

describe("run_brief_missing — structure (issue #5048, ADR-0045 Decision 8)", () => {
  const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf-8");

  test("hydra-watchdog.sh parses under bash -n", () => {
    const syntax = spawnSync("bash", ["-n", WATCHDOG], { encoding: "utf-8" });
    assert.equal(syntax.status, 0, `bash -n failed: ${syntax.stderr}`);
  });

  test("the block is wired into the entry point, just before run_origin_identity", () => {
    const src = read("scripts/hydra-watchdog.sh");
    const defIdx = src.indexOf("run_brief_missing()");
    const originIdx = src.indexOf("run_origin_identity() {");
    assert.ok(defIdx >= 0, "run_brief_missing() definition not found");
    // The origin-identity suite slices from ITS definition to the entry point
    // and pins `run_origin_identity` as the last call before `exit 0`, so this
    // block is defined before it and dispatched before it.
    assert.ok(originIdx > defIdx, "the block definition must precede run_origin_identity's (the origin-identity suite slices from there)");
    const guard = 'if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then';
    const guardIdx = src.lastIndexOf(guard);
    assert.ok(guardIdx > defIdx, "the sourcing-guarded entry point must follow the block definition");
    const entry = src.slice(guardIdx);
    assert.match(entry, /^\s*run_brief_missing$/m, "block must run on every real tick");
    assert.match(entry, /run_brief_missing\n\s*run_origin_identity\n\s*exit 0/, "block sits just before run_origin_identity in the main sequence");
  });

  test("reads the TS-owned last-sent key name verbatim (drift guard) and never writes it", () => {
    const block = extractBlock();
    assert.ok(block.includes(`LAST_SENT_KEY="${BRIEF_LAST_SENT_KEY}"`), `block must read ${BRIEF_LAST_SENT_KEY}`);
    // Only EXISTS / GET touch the key: the scheduler alone stamps it.
    const writes = block.match(/rc_write [A-Z]+ "\$LAST_SENT_KEY"/g) ?? [];
    assert.deepEqual(writes, [], "the watchdog must never write the last-sent key");
    assert.match(block, /rc_read EXISTS "\$LAST_SENT_KEY"/, "reachability probe is an EXISTS on the key");
    assert.match(block, /rc_read GET "\$LAST_SENT_KEY"/, "the stamp is read with GET");
  });

  test("pages with kind brief:missing, dedupKey == kind, and the kind is on the closed page list + the ADR", () => {
    const block = extractBlock();
    assert.ok(block.includes(`KIND="${KIND}"`), "the kind literal is pinned in the block");
    assert.match(block, /deliver_page page --kind "\$KIND" --dedup-key "\$KIND"/, "page call with dedupKey == kind");
    assert.match(block, /deliver_page resolve --dedup-key "\$KIND"/, "resolve call on the same dedupKey");
    assert.ok(isPageKind(KIND), `${KIND} must be on PAGE_KINDS (ADR-0045 Decision 3)`);
    assert.equal(PAGE_KINDS[PAGE_KINDS.length - 1], KIND, "appended at the END of the closed list (shared-file etiquette)");
    const adr = readFileSync(ADR, "utf-8");
    assert.match(adr, /no Morning Brief delivered for 26h/, "the ADR's Decision 3 list names the new page type");
  });

  test("is independent of the orchestrator: no HTTP call, no /api/ path, no scheduler read", () => {
    const block = extractBlock();
    assert.doesNotMatch(block, /\bcurl\b/, "the block must not call the orchestrator over HTTP");
    assert.doesNotMatch(block, /\/api\//, "the block must not reference an API route");
    assert.doesNotMatch(block, /scheduler\/status/, "the alarm must not depend on the scheduler's running state");
  });

  test("default threshold is 26h, overridable through HYDRA_WATCHDOG_BRIEF_STALE_HOURS; clock through HYDRA_WATCHDOG_BRIEF_NOW_MS", () => {
    const block = extractBlock();
    assert.ok(block.includes('STALE_HOURS="${HYDRA_WATCHDOG_BRIEF_STALE_HOURS:-26}"'), "26h default");
    assert.ok(block.includes("HYDRA_WATCHDOG_BRIEF_NOW_MS"), "deterministic clock hook");
  });

  test("deliver_page is the #5046 helper shape: CLI via HYDRA_WATCHDOG_OPERATOR_NOTIFY, strip-types, timeout 25, WARN on failure", () => {
    const block = extractBlock();
    const helperStart = block.indexOf("deliver_page() {");
    assert.ok(helperStart >= 0, "deliver_page helper present");
    const helper = block.slice(helperStart, block.indexOf("return 0", helperStart));
    assert.ok(helper.includes("HYDRA_WATCHDOG_OPERATOR_NOTIFY"), "binary resolves through the hook");
    assert.ok(helper.includes("scripts/operator-notify.ts"), "default binary is the repo CLI");
    assert.ok(helper.includes("--experimental-strip-types"), "default runtime is node --experimental-strip-types");
    assert.ok(!helper.includes("npx"), "never npx (a unit's PATH cannot see the global tsx)");
    assert.match(helper, /timeout 25/, "wrapped in timeout 25");
    assert.match(helper, /\|\| log "WARN/, "a failed CLI call degrades to a logged WARN");
  });

  test("resolve is gated on the fired marker having existed, and the marker is DELeted on the fresh path", () => {
    const block = extractBlock();
    const fresh = block.slice(block.indexOf("else\n    if [[ \"$reason\" == \"stale\" ]]"));
    assert.match(fresh, /EXISTS "\$fired_key"[^\n]*== "1" \]\]; then[\s\S]*deliver_page resolve/, "resolve only when fired existed");
    assert.match(fresh, /rc_write DEL "\$fired_key"/, "fresh path re-arms by deleting the marker");
  });
});

// =============================================================================
// Behavioural cases — gated on the docker hydra-redis-1 container.
// =============================================================================

describe("run_brief_missing — detection + delivery (issue #5048)", { skip: !DOCKER }, () => {
  beforeEach(() => {
    drc(["DEL", TEST_LAST_SENT_KEY, ABSENT_KEY, FIRED_KEY]);
    clearNotifyLog();
  });

  after(() => {
    drc(["DEL", TEST_LAST_SENT_KEY, ABSENT_KEY, FIRED_KEY]);
    clearNotifyLog();
  });

  test("cold start: an absent key anchors absent-since at the first tick and pages nothing", () => {
    const r = runBlock({});
    assert.equal(r.status, 0, `block must never exit non-zero: ${r.stderr}`);
    assert.match(bmLines(r.stdout), /never delivered yet: cold-start grace 0h of 26h/);
    assert.equal(drc(["GET", ABSENT_KEY]), String(T0), "absent-since anchored at the observing tick");
    assert.equal(drc(["EXISTS", FIRED_KEY]), "0", "no fired marker inside the grace window");
    assert.equal(notifyCalls().length, 0, "no CLI call inside the grace window");
  });

  test("cold start: the anchor older than 26h pages ONCE with reason never-delivered", () => {
    drc(["SET", ABSENT_KEY, String(T0)]);
    const r = runBlock({ HYDRA_WATCHDOG_BRIEF_NOW_MS: String(T0 + 27 * HOUR_MS) });
    assert.equal(r.status, 0);
    assert.match(bmLines(r.stdout), /WARNING MORNING BRIEF MISSING — never-delivered: no brief delivered for 27h/);
    assert.equal(drc(["EXISTS", FIRED_KEY]), "1", "fired marker set");
    const calls = notifyCalls();
    assert.equal(calls.length, 1, `exactly one CLI call, got ${JSON.stringify(calls)}`);
    assert.match(calls[0], /^page --kind brief:missing --dedup-key brief:missing --title No Morning Brief delivered for 27h/);
    assert.match(calls[0], /--fact reason=never-delivered/);
    assert.match(calls[0], /--fact threshold_h=26/);
    // The anchor is NOT re-stamped by the SET NX on a later tick.
    assert.equal(drc(["GET", ABSENT_KEY]), String(T0));
  });

  test("stale key: a last-sent stamp older than 26h pages ONCE with reason stale", () => {
    drc(["SET", TEST_LAST_SENT_KEY, String(T0 - 30 * HOUR_MS)]);
    const r = runBlock({});
    assert.equal(r.status, 0);
    assert.match(bmLines(r.stdout), /WARNING MORNING BRIEF MISSING — stale: no brief delivered for 30h/);
    assert.equal(drc(["EXISTS", FIRED_KEY]), "1");
    assert.equal(drc(["EXISTS", ABSENT_KEY]), "0", "a present key clears any cold-start anchor");
    const calls = notifyCalls();
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^page --kind brief:missing --dedup-key brief:missing --title No Morning Brief delivered for 30h/);
    assert.match(calls[0], /--fact reason=stale/);
  });

  test("dedup: a second consecutive stale tick does not call the CLI again", () => {
    drc(["SET", TEST_LAST_SENT_KEY, String(T0 - 30 * HOUR_MS)]);
    runBlock({});
    assert.equal(notifyCalls().length, 1);
    const r2 = runBlock({ HYDRA_WATCHDOG_BRIEF_NOW_MS: String(T0 + 2 * 60 * 1000) });
    assert.equal(r2.status, 0);
    assert.match(bmLines(r2.stdout), /still missing — already paged this episode/);
    assert.equal(notifyCalls().length, 1, "the fired marker must hold the dedup");
  });

  test("recovery: a fresh stamp after a fired episode resolves ONCE and re-arms", () => {
    drc(["SET", TEST_LAST_SENT_KEY, String(T0 - 30 * HOUR_MS)]);
    runBlock({});
    assert.equal(drc(["EXISTS", FIRED_KEY]), "1");
    clearNotifyLog();

    // The brief lands (the scheduler stamps last-sent 1h ago).
    drc(["SET", TEST_LAST_SENT_KEY, String(T0 - 1 * HOUR_MS)]);
    const r2 = runBlock({});
    assert.equal(r2.status, 0);
    assert.match(bmLines(r2.stdout), /morning brief delivered again — clearing the episode/);
    assert.match(bmLines(r2.stdout), /morning brief fresh: last delivered 1h ago/);
    assert.equal(drc(["EXISTS", FIRED_KEY]), "0", "recovery must DEL the fired marker");
    const calls = notifyCalls();
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^resolve --dedup-key brief:missing --title Morning Brief delivered again$/);

    // A quiet fresh tick afterwards neither pages nor resolves.
    clearNotifyLog();
    const r3 = runBlock({ HYDRA_WATCHDOG_BRIEF_NOW_MS: String(T0 + 2 * 60 * 1000) });
    assert.equal(r3.status, 0);
    assert.equal(notifyCalls().length, 0, "no CLI call on a quiet fresh tick");

    // A recurrence (the stamp ages out again) is a fresh episode and re-pages.
    const r4 = runBlock({ HYDRA_WATCHDOG_BRIEF_NOW_MS: String(T0 + 26 * HOUR_MS) });
    assert.equal(r4.status, 0);
    assert.match(bmLines(r4.stdout), /WARNING MORNING BRIEF MISSING — stale/);
    assert.equal(notifyCalls().length, 1, "the fresh episode delivers a second page");
    assert.match(notifyCalls()[0], /^page --kind brief:missing/);
  });

  test("a fresh stamp with no prior episode stays quiet", () => {
    drc(["SET", TEST_LAST_SENT_KEY, String(T0 - 2 * HOUR_MS)]);
    const r = runBlock({});
    assert.equal(r.status, 0);
    assert.doesNotMatch(bmLines(r.stdout), /WARNING/);
    assert.equal(notifyCalls().length, 0);
    assert.equal(drc(["EXISTS", FIRED_KEY]), "0");
  });

  test("honours the stale-hours hook", () => {
    drc(["SET", TEST_LAST_SENT_KEY, String(T0 - 30 * HOUR_MS)]);
    const r = runBlock({ HYDRA_WATCHDOG_BRIEF_STALE_HOURS: "48" });
    assert.equal(r.status, 0);
    assert.doesNotMatch(bmLines(r.stdout), /WARNING/, "30h is fresh against a 48h threshold");
    assert.equal(notifyCalls().length, 0);
    const r2 = runBlock({ HYDRA_WATCHDOG_BRIEF_STALE_HOURS: "24" });
    assert.match(bmLines(r2.stdout), /WARNING MORNING BRIEF MISSING — stale/, "30h is stale against a 24h threshold");
    assert.equal(notifyCalls().length, 1);
  });

  test("an unparseable stamp is treated as absent (cold-start path), never as fresh", () => {
    drc(["SET", TEST_LAST_SENT_KEY, "not-a-number"]);
    const r = runBlock({});
    assert.equal(r.status, 0);
    assert.match(bmLines(r.stdout), /never delivered yet/);
    assert.equal(drc(["GET", ABSENT_KEY]), String(T0), "the anchor is laid down for the garbage value");
    assert.equal(notifyCalls().length, 0);
  });
});

// =============================================================================
// Fail-safe without Redis — an unreachable store is NOT a missing brief.
// No docker dependency: rc_* calls point at a dead local port and fail closed
// instantly; nothing lands anywhere.
// =============================================================================

describe("run_brief_missing — fail-safe without Redis (issue #5048)", () => {
  const DEAD_REDIS = { HYDRA_REDIS_HOST: "127.0.0.1", HYDRA_REDIS_PORT: "9" };

  beforeEach(() => clearNotifyLog());

  test("never exits non-zero, pages nothing and leaves every state untouched when Redis is unreachable", () => {
    const r = runBlock({ ...DEAD_REDIS, HYDRA_WATCHDOG_BRIEF_NOW_MS: String(T0 + 100 * HOUR_MS) });
    assert.equal(r.status, 0, `Redis being down must not break the block: ${r.stderr}`);
    const lines = bmLines(r.stdout);
    assert.match(lines, /WARN Redis unreachable/, "the WARN names the cause");
    assert.doesNotMatch(lines, /WARNING MORNING BRIEF MISSING/, "an unreachable store must not masquerade as a missing brief");
    assert.doesNotMatch(lines, /tick processed/, "the block returns before the state machine runs");
    assert.equal(notifyCalls().length, 0, "no CLI call — nothing was measured");
  });
});

describe("run_brief_missing — redis timeout + DEL gating (issue #5115)", () => {
  const STUB_DIR = join(SCRATCH, "redis-stub-bin");
  const CALLS = join(SCRATCH, "redis-stub-calls.log");

  function installStub(body: string): void {
    mkdirSync(STUB_DIR, { recursive: true });
    const stub = join(STUB_DIR, "redis-cli");
    writeFileSync(stub, ["#!/usr/bin/env bash", body, ""].join("\n"));
    chmodSync(stub, 0o755);
    rmSync(CALLS, { force: true });
  }

  function healthyStub(): string {
    return [
      `echo "$*" >> '${CALLS}'`,
      'case "$*" in',
      `  *"EXISTS ${TEST_LAST_SENT_KEY}"*) echo 1 ;;`,
      `  *"GET ${TEST_LAST_SENT_KEY}"*) echo ${T0} ;;`,
      "  *EXISTS*) echo 0 ;;",
      "esac",
    ].join("\n");
  }

  function runWithStub(extra: Record<string, string>) {
    return runBlock({
      PATH: `${STUB_DIR}:${process.env.PATH ?? ""}`,
      HYDRA_REDIS_HOST: "127.0.0.1",
      HYDRA_REDIS_PORT: "6379",
      ...extra,
    });
  }

  after(() => rmSync(STUB_DIR, { recursive: true, force: true }));

  test("a hung redis-cli is bounded by timeout 5 and logs the unreachable WARN", () => {
    installStub("exec sleep 60");
    const started = Date.now();
    const r = runWithStub({});
    const elapsedMs = Date.now() - started;
    assert.equal(r.status, 0, `a hung Redis must not break the block: ${r.stderr}`);
    assert.match(bmLines(r.stdout), /WARN Redis unreachable/);
    assert.ok(elapsedMs < 20_000, `block must return near the 5s timeout, took ${elapsedMs}ms`);
  });

  test("a healthy tick issues no DEL when the absent-since key does not exist", () => {
    installStub(healthyStub());
    const r = runWithStub({});
    assert.equal(r.status, 0, r.stderr);
    const calls = existsSync(CALLS) ? readFileSync(CALLS, "utf-8") : "";
    assert.match(calls, /EXISTS/, "the stub was exercised");
    assert.doesNotMatch(calls, /DEL [^\n]*absent-since/, "no DEL of absent-since when nothing to delete");
  });

  test("a zero-padded stale-hours hook is read base-10, not octal", () => {
    installStub(healthyStub());
    const r = runWithStub({ HYDRA_WATCHDOG_BRIEF_STALE_HOURS: "08" });
    assert.equal(r.status, 0, `"08" must not abort under set -e: ${r.stderr}`);
  });
});
