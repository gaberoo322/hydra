/**
 * Regression test for issue #4175 — the `## NODE MODULES INTEGRITY` block in
 * scripts/hydra-watchdog.sh (`run_node_modules_integrity`), plus its TS
 * vocabulary wiring.
 *
 * Context: on 2026-08-19 a `/dev/shm` hydra-betting worktree's `web/node_modules`
 * symlink reached back through the main checkout, and a destructive install
 * step inside the worktree wiped `/home/gabe/hydra-betting/web/node_modules` —
 * taking down six money-critical Target services for ~70 minutes with no
 * signal to anything watching the main checkout. This block detects the
 * structural invariant the incident violated (a watched install root exists,
 * has `.bin/`, holds enough entries, and the referenced binary is present and
 * executable) and delivers via the SAME #3848 taxonomy `run_launch_flow`
 * established: an enveloped XADD onto `hydra:notifications`, reusing the
 * SET-NX-since/fired dedup design (own key prefix, own block).
 *
 * Two isolation mechanisms, mirroring test/launch-flow-delivery.test.mts:
 *   - the extracted block COPY is rebound onto a per-run Redis key namespace,
 *     so a live production watchdog tick can neither rewrite our fixtures nor
 *     be disturbed by them;
 *   - in-band delivery is pointed at a per-run NOTIFY STREAM via the block's
 *     own HYDRA_WATCHDOG_NM_NOTIFY_STREAM hook, so a behavioural case can
 *     NEVER write a real event onto the PRODUCTION hydra:notifications stream.
 * Watched roots are synthetic temp directories via HYDRA_WATCHDOG_NM_ROOTS —
 * no case ever points the check at a real, live install root.
 */

import test, { describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

import { STREAMS } from "../src/event-bus-stream-keys.ts";
import { NOTIFICATION_EVENT_TYPES as E } from "../src/event-bus-vocabulary.ts";
import { ALERT_TYPES } from "../src/notification/alert-grammar.ts";
import { CRITICAL_EVENT_TYPES } from "../src/digest.ts";
import {
  WATCHDOG_SPAWN_TIMEOUT_MS,
  WATCHDOG_REDIS_TIMEOUT_MS,
  throwIfTimedOut,
} from "./_helpers/watchdog-timeouts.mts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const WATCHDOG = join(REPO_ROOT, "scripts", "hydra-watchdog.sh");

const NM_KEY_PREFIX_LITERAL = "hydra:autopilot:node-modules-integrity";

// Per-run key/stream namespace (see file header + test/launch-flow-delivery
// .test.mts for why nothing here may touch shared production keys/streams).
const RUN_NS = `hydra:test:nm-integrity-${process.pid}-${randomUUID().slice(0, 8)}`;
const TEST_NM_PREFIX = `${RUN_NS}:nm-integrity`;
const TEST_NOTIFY_STREAM = `${RUN_NS}:notifications`;

const SINCE = (sig: string) => `${TEST_NM_PREFIX}:since:${sig}`;
const FIRED = (sig: string) => `${TEST_NM_PREFIX}:fired:${sig}`;

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

function sigForRoot(root: string): string {
  return root.replace(/[^a-zA-Z0-9]+/g, "_").replace(/_+/g, "_");
}

function cleanState(root: string): void {
  const sig = sigForRoot(root);
  drc(["DEL", SINCE(sig), FIRED(sig)]);
}

function getFired(root: string): boolean {
  return drc(["EXISTS", FIRED(sigForRoot(root))]) === "1";
}

/** One XADD'd in-band entry off the namespaced notify stream, fields folded
 * (mirrors test/launch-flow-delivery.test.mts's notifyEntriesSimple). */
function notifyEntriesSimple(): { fields: Record<string, string> }[] {
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
// Extract run_node_modules_integrity() into a temp file, rebound onto this
// run's Redis key namespace (mirrors test/launch-flow-delivery.test.mts).
// ---------------------------------------------------------------------------

const BLOCK = join(tmpdir(), `hydra-nm-integrity-block-${process.pid}.sh`);

before(() => {
  const src = readFileSync(WATCHDOG, "utf-8");
  const start = src.indexOf("run_node_modules_integrity()");
  assert.ok(start >= 0, "run_node_modules_integrity() not found in hydra-watchdog.sh");
  const after = src.slice(start);
  const end = after.search(/^}/m);
  assert.ok(end >= 0, "run_node_modules_integrity() closing brace not found");
  const body = after.slice(0, end + 1);
  assert.ok(body.includes("track_signal"), "extracted block missing track_signal");
  assert.ok(body.includes("deliver_signal"), "extracted block missing deliver_signal");

  const namespaced = body.split(`"${NM_KEY_PREFIX_LITERAL}"`).join(`"${TEST_NM_PREFIX}"`);
  assert.ok(
    namespaced.includes(`"${TEST_NM_PREFIX}"`),
    "failed to rebind NM_KEY_PREFIX onto the test namespace",
  );
  writeFileSync(BLOCK, namespaced);
});

after(() => {
  try {
    unlinkSync(BLOCK);
  } catch {
    /* best-effort cleanup */
  }
});

function runBlock(env: Record<string, string>): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("bash", ["-c", `set -euo pipefail; source '${BLOCK}'; run_node_modules_integrity`], {
    env: { ...process.env, HYDRA_REDIS_HOST: "docker", HYDRA_WATCHDOG_NM_NOTIFY_STREAM: TEST_NOTIFY_STREAM, ...env },
    encoding: "utf-8",
    timeout: WATCHDOG_SPAWN_TIMEOUT_MS,
  });
  throwIfTimedOut(r, WATCHDOG_SPAWN_TIMEOUT_MS, "run_node_modules_integrity block");
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function nmLines(stdout: string): string {
  return stdout
    .split("\n")
    .filter((l) => l.includes("hydra-node-modules-integrity-watchdog:"))
    .join("\n");
}

// =============================================================================
// Structural / drift-guard cases — run unconditionally (no Redis needed).
// =============================================================================

describe("issue #4175 — TypeScript vocabulary wiring", () => {
  test("event type exists in the vocabulary", () => {
    assert.equal(E.INFRA_NODE_MODULES_WIPED, "infra:node_modules_wiped");
  });

  test("is in BOTH ALERT_TYPES and CRITICAL_EVENT_TYPES", () => {
    assert.ok(
      ALERT_TYPES.has(E.INFRA_NODE_MODULES_WIPED),
      "a wiped node_modules must raise a dashboard alert",
    );
    assert.ok(
      CRITICAL_EVENT_TYPES.includes(E.INFRA_NODE_MODULES_WIPED),
      "a wiped node_modules must bypass the batched digest",
    );
  });
});

describe("scripts/hydra-watchdog.sh — node-modules-integrity structure (issue #4175)", () => {
  function blockSource(): string {
    const src = readFileSync(WATCHDOG, "utf-8");
    const start = src.indexOf("run_node_modules_integrity()");
    return src.slice(start, src.indexOf("# Entry point"));
  }

  test("bash script parses under set -euo pipefail", () => {
    const syntax = spawnSync("bash", ["-n", WATCHDOG], { encoding: "utf-8" });
    assert.equal(syntax.status, 0, `watchdog bash -n failed: ${syntax.stderr}`);
  });

  test("is wired into the entry point", () => {
    const src = readFileSync(WATCHDOG, "utf-8");
    const entry = src.slice(src.indexOf("if [[ \"${BASH_SOURCE[0]}\""));
    assert.ok(entry.includes("run_node_modules_integrity"), "must run on every real tick");
  });

  test("in-band event-type literal drift-guards the TS vocabulary", () => {
    const block = blockSource();
    assert.ok(
      block.includes(E.INFRA_NODE_MODULES_WIPED),
      `bash deliver_signal must publish '${E.INFRA_NODE_MODULES_WIPED}'`,
    );
  });

  test("NOTIFY_STREAM default drift-guards STREAMS.NOTIFICATIONS", () => {
    const block = blockSource();
    assert.ok(
      block.includes(`:-${STREAMS.NOTIFICATIONS}}`),
      `the in-band delivery default must be the TS-owned stream key '${STREAMS.NOTIFICATIONS}'`,
    );
  });

  test("watched roots are a list variable, not a literal buried in a condition", () => {
    const block = blockSource();
    assert.match(block, /WATCHED_ROOTS=\(/, "roots must be declared as an array");
    assert.match(block, /for root in "\$\{WATCHED_ROOTS\[@\]\}"/, "the check must iterate the array");
  });

  test("delivery is an enveloped XADD and carries every envelope field", () => {
    const block = blockSource();
    assert.match(block, /rc_write XADD "\$NOTIFY_STREAM" '\*'/, "enveloped XADD onto the notify stream");
    for (const field of ["id", "type", "source", "timestamp", "correlationId", "payload"]) {
      assert.ok(new RegExp(`\\b${field}\\b `).test(block), `envelope must carry the '${field}' field`);
    }
  });
});

// =============================================================================
// Behavioural cases — gated on the docker hydra-redis-1 container.
// =============================================================================

describe("run_node_modules_integrity — detection + delivery (issue #4175)", { skip: !DOCKER }, () => {
  const SCRATCH = join(tmpdir(), `hydra-nm-integrity-scratch-${process.pid}`);
  let wiped: string;
  let missingBin: string;
  let healthy: string;

  function makeHealthy(root: string, entries = 25): void {
    mkdirSync(join(root, ".bin"), { recursive: true });
    writeFileSync(join(root, ".bin", "tsx"), "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(join(root, ".bin", "tsx"), 0o755);
    for (let i = 0; i < entries; i++) mkdirSync(join(root, `pkg${i}`), { recursive: true });
  }

  beforeEach(() => {
    rmSync(SCRATCH, { recursive: true, force: true });
    wiped = join(SCRATCH, "wiped");
    missingBin = join(SCRATCH, "missing-bin");
    healthy = join(SCRATCH, "healthy");
    // "wiped": measured incident state — 24K, no .bin/, no packages.
    mkdirSync(wiped, { recursive: true });
    writeFileSync(join(wiped, "some-leftover-file"), "x");
    // "missing-bin": .bin/ exists and floor is met, but the referenced
    // binary itself is absent — the 203/EXEC symptom, asserted separately.
    mkdirSync(join(missingBin, ".bin"), { recursive: true });
    for (let i = 0; i < 25; i++) mkdirSync(join(missingBin, `pkg${i}`), { recursive: true });
    makeHealthy(healthy);
    cleanState(wiped);
    cleanState(missingBin);
    cleanState(healthy);
    drc(["DEL", TEST_NOTIFY_STREAM]);
  });

  after(() => {
    rmSync(SCRATCH, { recursive: true, force: true });
    cleanState(wiped);
    cleanState(missingBin);
    cleanState(healthy);
    drc(["DEL", TEST_NOTIFY_STREAM]);
  });

  test("fires on a synthetic wiped tree (no .bin/, below entry floor)", () => {
    const r = runBlock({ HYDRA_WATCHDOG_NM_ROOTS: wiped, HYDRA_WATCHDOG_NM_ENTRY_FLOOR: "20" });
    assert.equal(r.status, 0, `block must never exit non-zero: ${r.stderr}`);
    assert.match(nmLines(r.stdout), /WARNING NODE_MODULES INTEGRITY/, "must warn on a wiped tree");
    assert.match(nmLines(r.stdout), /no-bin-dir/, "reason must name the missing .bin/ dir");
    assert.ok(getFired(wiped), "fired marker must be set");
    const entries = notifyEntriesSimple();
    assert.equal(entries.length, 1, "exactly one delivery for the wiped root");
    assert.equal(entries[0].fields.type, E.INFRA_NODE_MODULES_WIPED);
  });

  test("fires separately when .bin/ exists but the referenced binary is missing (203/EXEC case)", () => {
    const r = runBlock({
      HYDRA_WATCHDOG_NM_ROOTS: missingBin,
      HYDRA_WATCHDOG_NM_ENTRY_FLOOR: "20",
      HYDRA_WATCHDOG_NM_REQUIRED_BIN: "tsx",
    });
    assert.equal(r.status, 0, `block must never exit non-zero: ${r.stderr}`);
    assert.match(nmLines(r.stdout), /WARNING NODE_MODULES INTEGRITY/, "must warn when the binary is missing");
    assert.match(nmLines(r.stdout), /missing-binary:tsx/, "reason must name the missing binary");
    assert.ok(getFired(missingBin));
  });

  test("stays quiet against a healthy install", () => {
    const r = runBlock({ HYDRA_WATCHDOG_NM_ROOTS: healthy, HYDRA_WATCHDOG_NM_ENTRY_FLOOR: "20" });
    assert.equal(r.status, 0);
    assert.doesNotMatch(nmLines(r.stdout), /WARNING/, "a healthy install must never warn");
    assert.ok(!getFired(healthy));
    assert.equal(notifyEntriesSimple().length, 0, "no delivery for a healthy root");
  });

  test("checks multiple watched roots independently (colon-separated list)", () => {
    const r = runBlock({
      HYDRA_WATCHDOG_NM_ROOTS: `${wiped}:${healthy}`,
      HYDRA_WATCHDOG_NM_ENTRY_FLOOR: "20",
    });
    assert.equal(r.status, 0);
    assert.match(nmLines(r.stdout), /2 root\(s\) watched/, "both roots must be processed");
    assert.ok(getFired(wiped), "the broken root must fire");
    assert.ok(!getFired(healthy), "the healthy root must not fire");
    assert.equal(notifyEntriesSimple().length, 1, "only the broken root delivers");
  });

  test("dedup: a second consecutive broken tick does not re-deliver", () => {
    runBlock({ HYDRA_WATCHDOG_NM_ROOTS: wiped, HYDRA_WATCHDOG_NM_ENTRY_FLOOR: "20" });
    assert.equal(notifyEntriesSimple().length, 1);
    const r2 = runBlock({ HYDRA_WATCHDOG_NM_ROOTS: wiped, HYDRA_WATCHDOG_NM_ENTRY_FLOOR: "20" });
    assert.equal(r2.status, 0);
    assert.doesNotMatch(nmLines(r2.stdout), /WARNING/, "the fired marker must suppress a re-warn");
    assert.equal(notifyEntriesSimple().length, 1, "still exactly one delivery after the second tick");
  });

  test("recovery clears the fired marker, and a fresh streak re-delivers", () => {
    runBlock({ HYDRA_WATCHDOG_NM_ROOTS: wiped, HYDRA_WATCHDOG_NM_ENTRY_FLOOR: "20" });
    assert.ok(getFired(wiped));

    // Recover the same path in place, then tick again onto that path.
    makeHealthy(wiped);
    runBlock({ HYDRA_WATCHDOG_NM_ROOTS: wiped, HYDRA_WATCHDOG_NM_ENTRY_FLOOR: "20" });
    assert.ok(!getFired(wiped), "recovery must DEL the fired marker");

    // Break it again — a fresh streak must re-fire (recurrence, never
    // acknowledgement, mirroring run_launch_flow's contract).
    rmSync(join(wiped, ".bin"), { recursive: true, force: true });
    const r3 = runBlock({ HYDRA_WATCHDOG_NM_ROOTS: wiped, HYDRA_WATCHDOG_NM_ENTRY_FLOOR: "20" });
    assert.match(nmLines(r3.stdout), /WARNING NODE_MODULES INTEGRITY/, "a fresh streak must re-fire");
    assert.equal(notifyEntriesSimple().length, 2, "the fresh streak delivers a second event");
  });

  test("never exits non-zero even against an unreadable root", () => {
    const r = runBlock({ HYDRA_WATCHDOG_NM_ROOTS: join(SCRATCH, "does-not-exist"), HYDRA_WATCHDOG_NM_ENTRY_FLOOR: "20" });
    assert.equal(r.status, 0, `block must be fail-safe: ${r.stderr}`);
    assert.match(nmLines(r.stdout), /root-absent/, "an absent root must be reported distinguishably");
  });
});
