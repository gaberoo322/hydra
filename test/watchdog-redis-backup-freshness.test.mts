/**
 * Regression test for issue #4604 — the `## REDIS BACKUP FRESHNESS` block in
 * scripts/hydra-watchdog.sh (`run_redis_backup_freshness`), plus the
 * deploy-install contract for the Redis backup units and the SSD-unmounted
 * guard in scripts/redis-backup.sh.
 *
 * Context: the nightly Redis backup shipped in #2742 as a repo-tracked script
 * plus a HAND-installed unit pair — the hand step was never done on this
 * host, so no scheduled Redis backup ran and nothing noticed. #4604 makes
 * deploy.sh install+enable the timer, seeds a first dump, adds this watchdog
 * block (missing/stale dump → once-per-episode alert onto
 * hydra:notifications, timer-not-enabled → advisory log), and extends
 * hydra-doctor. Hard invariants pinned here (from the gate-approved
 * design-concept for issue-4604):
 *
 *   1. Deploy installs the units + script copy and `enable --now`s the timer
 *      (same convergent shape as the reaper/drainer blocks).
 *   2. The units carry the pinned shape (Type=oneshot, ExecStart=%h path,
 *      OnFailure template; OnCalendar 03:15, Persistent, Unit, WantedBy).
 *   3. A backup problem must NEVER fail or abort deploy.sh — the seed stanza
 *      stays exit-0 under `set -euo pipefail` even when every command in it
 *      fails; a failed seed pages via OnFailure, not the deploy's exit code.
 *   4. redis-backup.sh refuses to run (exit 1, `[redis-backup] FAILED` on
 *      stderr) when /mnt/hydra-ssd/backups is absent, instead of mkdir-ing
 *      the tree onto the root filesystem.
 *   5. The watchdog block is advisory and fail-safe: STALE on missing/old
 *      dump, fires the in-band delivery ONCE per episode, DELs on recovery,
 *      and never exits non-zero — including when Redis itself is unreachable.
 *
 * Isolation, mirroring test/watchdog-node-modules-integrity.test.mts:
 *   - the extracted block COPY is rebound onto a per-run Redis key namespace,
 *     so a live production watchdog tick can neither rewrite our fixtures nor
 *     be disturbed by them;
 *   - in-band delivery is pointed at a per-run NOTIFY STREAM via the block's
 *     own HYDRA_WATCHDOG_BACKUP_NOTIFY_STREAM hook, so a behavioural case can
 *     NEVER write a real event onto the PRODUCTION hydra:notifications stream;
 *   - the backup dir is a synthetic temp dir via HYDRA_WATCHDOG_BACKUP_DIR —
 *     no case ever reads the real /mnt/hydra-ssd state;
 *   - the redis-backup.sh guard cases run a COPY with the SSD root rebound
 *     onto a temp path and a stubbed `docker`, so the real container is never
 *     touched.
 */

import test, { describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  rmSync,
  utimesSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

import { STREAMS } from "../src/event-bus-stream-keys.ts";
import {
  WATCHDOG_SPAWN_TIMEOUT_MS,
  WATCHDOG_REDIS_TIMEOUT_MS,
  throwIfTimedOut,
} from "./_helpers/watchdog-timeouts.mts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const WATCHDOG = join(REPO_ROOT, "scripts", "hydra-watchdog.sh");
const DEPLOY = join(REPO_ROOT, "scripts", "deploy.sh");
const BACKUP_SCRIPT = join(REPO_ROOT, "scripts", "redis-backup.sh");
const BACKUP_SERVICE = join(REPO_ROOT, "scripts", "systemd", "hydra-redis-backup.service");
const BACKUP_TIMER = join(REPO_ROOT, "scripts", "systemd", "hydra-redis-backup.timer");

const RB_KEY_PREFIX_LITERAL = "hydra:autopilot:redis-backup-freshness";

// Per-run key/stream namespace (see file header): nothing here may touch
// shared production keys/streams.
const RUN_NS = `hydra:test:rb-freshness-${process.pid}-${randomUUID().slice(0, 8)}`;
const TEST_RB_PREFIX = `${RUN_NS}:rb-freshness`;
const TEST_NOTIFY_STREAM = `${RUN_NS}:notifications`;

const SINCE_KEY = `${TEST_RB_PREFIX}:since`;
const FIRED_KEY = `${TEST_RB_PREFIX}:fired`;

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

/** One XADD'd in-band entry off the namespaced notify stream, fields folded
 * (mirrors test/watchdog-node-modules-integrity.test.mts). */
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
// Extract run_redis_backup_freshness() into a temp file, rebound onto this
// run's Redis key namespace (mirrors test/watchdog-node-modules-integrity
// .test.mts).
// ---------------------------------------------------------------------------

const BLOCK = join(tmpdir(), `hydra-rb-freshness-block-${process.pid}.sh`);

before(() => {
  const src = readFileSync(WATCHDOG, "utf-8");
  const start = src.indexOf("run_redis_backup_freshness()");
  assert.ok(start >= 0, "run_redis_backup_freshness() not found in hydra-watchdog.sh");
  const after = src.slice(start);
  const end = after.search(/^}/m);
  assert.ok(end >= 0, "run_redis_backup_freshness() closing brace not found");
  const body = after.slice(0, end + 1);
  assert.ok(body.includes("deliver_signal"), "extracted block missing deliver_signal");
  assert.ok(body.includes("rc_write"), "extracted block missing rc_write");

  const namespaced = body.split(`"${RB_KEY_PREFIX_LITERAL}"`).join(`"${TEST_RB_PREFIX}"`);
  assert.ok(
    namespaced.includes(`"${TEST_RB_PREFIX}"`),
    "failed to rebind RB_KEY_PREFIX onto the test namespace",
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

/**
 * Source the extracted block and call it once. `extra` wins over the pinned
 * isolation env (last-spread wins), so a case can point Redis elsewhere.
 */
function runBlock(extra: Record<string, string>): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("bash", ["-c", `set -euo pipefail; source '${BLOCK}'; run_redis_backup_freshness`], {
    env: {
      ...process.env,
      HYDRA_REDIS_HOST: "docker",
      // Pinned to "0" for the same reason as the node-modules-integrity
      // suite: this suite's own seed/read helpers (drc) are hardcoded to db 0
      // with no `-n` selector. scripts/test/redis-db-launch.mjs exports
      // HYDRA_REDIS_DB into the whole node:test process env, so an unpinned
      // `...process.env` would redirect the block to the launcher's per-run
      // DB while every assertion here kept reading db 0.
      HYDRA_REDIS_DB: "0",
      HYDRA_WATCHDOG_BACKUP_NOTIFY_STREAM: TEST_NOTIFY_STREAM,
      HYDRA_WATCHDOG_BACKUP_DIR: "/nonexistent-rb-freshness-dir",
      HYDRA_WATCHDOG_BACKUP_TIMER_STATE: "enabled",
      ...extra,
    },
    encoding: "utf-8",
    timeout: WATCHDOG_SPAWN_TIMEOUT_MS,
  });
  throwIfTimedOut(r, WATCHDOG_SPAWN_TIMEOUT_MS, "run_redis_backup_freshness block");
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function rbLines(stdout: string): string {
  return stdout
    .split("\n")
    .filter((l) => l.includes("hydra-redis-backup-freshness-watchdog:"))
    .join("\n");
}

/** Write a fixture dump with an explicit mtime (default: now). */
function makeDump(dir: string, ageHours: number): string {
  const p = join(dir, `hydra-redis-2026-09-${String(10 + Math.floor(Math.random() * 9)).padStart(2, "0")}_0315.rdb.gz`);
  writeFileSync(p, "fake-rdb");
  const when = new Date(Date.now() - ageHours * 3600 * 1000);
  utimesSync(p, when, when);
  return p;
}

// =============================================================================
// Structural cases — deploy.sh install contract, unit shape, wiring, the
// never-fail-the-deploy seed, and the SSD guard. No Redis needed.
// =============================================================================

describe("scripts/deploy.sh + units — Redis backup install (issue #4604)", () => {
  const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf-8");

  test("watchdog and deploy scripts parse under set -euo pipefail", () => {
    for (const sh of [WATCHDOG, DEPLOY, BACKUP_SCRIPT]) {
      const syntax = spawnSync("bash", ["-n", sh], { encoding: "utf-8" });
      assert.equal(syntax.status, 0, `bash -n failed for ${sh}: ${syntax.stderr}`);
    }
  });

  test("deploy.sh installs and enables the Redis backup units (issue #4604)", () => {
    const src = read("scripts/deploy.sh");
    assert.ok(
      src.includes('install -D -m 0755 scripts/redis-backup.sh "$HOME/.local/bin/hydra-redis-backup.sh"'),
      "deploy must install the script copy to ~/.local/bin (ExecStart target)",
    );
    assert.ok(
      src.includes('install -D -m 0644 scripts/systemd/hydra-redis-backup.service "$HOME/.config/systemd/user/hydra-redis-backup.service"'),
      "deploy must install the service unit",
    );
    assert.ok(
      src.includes('install -D -m 0644 scripts/systemd/hydra-redis-backup.timer "$HOME/.config/systemd/user/hydra-redis-backup.timer"'),
      "deploy must install the timer unit",
    );
    assert.ok(
      src.includes("systemctl --user enable --now hydra-redis-backup.timer"),
      "deploy must enable (and start) the timer — install alone let it sit never-installed for months",
    );
  });

  test("hydra-redis-backup.service/.timer carry the pinned unit shape (issue #4604)", () => {
    const svc = readFileSync(BACKUP_SERVICE, "utf-8");
    assert.match(svc, /^Type=oneshot$/m, "service must be Type=oneshot");
    assert.match(svc, /^ExecStart=%h\/\.local\/bin\/hydra-redis-backup\.sh$/m, "ExecStart must be the %h script copy");
    assert.match(
      svc, /^OnFailure=hydra-notify-failure@hydra-redis-backup\.service$/m,
      "a failed backup must page via the tracked Telegram template (#4284)",
    );
    const timer = readFileSync(BACKUP_TIMER, "utf-8");
    assert.match(timer, /^OnCalendar=\*-\*-\* 03:15:00$/m, "daily 03:15 schedule (docs/reference.md)");
    assert.match(timer, /^Persistent=true$/m, "catch up after downtime");
    assert.match(timer, /^Unit=hydra-redis-backup\.service$/m, "timer must trigger the backup service");
    assert.match(timer, /^WantedBy=timers\.target$/m, "install target");
  });

  test("run_redis_backup_freshness is wired into the entry point alongside run_deploy_drift", () => {
    const src = read("scripts/hydra-watchdog.sh");
    const defIdx = src.indexOf("run_redis_backup_freshness()");
    assert.ok(defIdx >= 0, "run_redis_backup_freshness() definition not found");
    const guard = 'if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then';
    const guardIdx = src.lastIndexOf(guard);
    assert.ok(guardIdx > defIdx, "the sourcing-guarded entry point must follow the block definition");
    const entry = src.slice(guardIdx);
    assert.match(entry, /^\s*run_redis_backup_freshness$/m, "block must run on every real tick");
    assert.match(
      entry, /run_deploy_drift\n\s*run_redis_backup_freshness/,
      "block must sit alongside run_deploy_drift in the main sequence",
    );
  });

  test("delivery envelope drift-guards the stream key and event type", () => {
    const src = read("scripts/hydra-watchdog.sh");
    const start = src.indexOf("run_redis_backup_freshness()");
    const block = src.slice(start, src.indexOf("# Entry point") > start ? src.indexOf("# Entry point") : undefined);
    assert.ok(block.includes(`:-${STREAMS.NOTIFICATIONS}}`), "in-band delivery default must be the TS-owned stream key");
    assert.ok(block.includes("infra:redis_backup_stale"), "must publish type infra:redis_backup_stale");
    assert.ok(block.includes("watchdog-redis-backup-freshness"), "source must be watchdog-redis-backup-freshness");
    assert.match(block, /rc_write XADD "\$NOTIFY_STREAM" '\*'/, "enveloped XADD onto the notify stream");
    for (const field of ["id", "type", "source", "timestamp", "correlationId", "payload"]) {
      assert.ok(new RegExp(`\\b${field}\\b `).test(block), `envelope must carry the '${field}' field`);
    }
  });

  test("a failing backup seed never fails deploy.sh (guarded under set -euo pipefail)", () => {
    // Extract the marked seed stanza from deploy.sh and execute it STANDALONE
    // under `set -euo pipefail` with every external command stubbed to FAIL
    // (systemctl) or to force the seed branch (find). The stanza must exit 0
    // in both configurations — a backup problem pages via the unit's
    // OnFailure= template, never via deploy's exit code (INV-3).
    const deploy = read("scripts/deploy.sh");
    const begin = deploy.indexOf("# --- redis-backup seed begin");
    const end = deploy.indexOf("# --- redis-backup seed end");
    assert.ok(begin >= 0 && end > begin, "seed stanza markers not found in deploy.sh");
    const stanza = deploy.slice(begin, end);

    const dir = mkdtempSync(join(tmpdir(), "hydra-rb-4604-seed-"));
    try {
      const seed = join(dir, "seed.sh");
      writeFileSync(seed, stanza);
      const stubBin = join(dir, "bin");
      mkdirSync(stubBin);

      // Config 1: find FAILS (unreadable backup dir) → the else branch fires
      // the seed start; systemctl FAILS → the || echo WARN fallback holds.
      writeFileSync(join(stubBin, "find"), "#!/usr/bin/env bash\nexit 1\n");
      writeFileSync(join(stubBin, "systemctl"), "#!/usr/bin/env bash\nexit 1\n");
      for (const f of [join(stubBin, "find"), join(stubBin, "systemctl")]) chmodSync(f, 0o755);
      const r1 = spawnSync(
        "bash", ["-c", `set -euo pipefail; source '${seed}'`],
        { env: { ...process.env, PATH: `${stubBin}:${process.env.PATH ?? ""}` }, encoding: "utf-8", timeout: WATCHDOG_SPAWN_TIMEOUT_MS },
      );
      throwIfTimedOut(r1, WATCHDOG_SPAWN_TIMEOUT_MS, "seed stanza (all-stubs-fail)");
      assert.equal(r1.status, 0, `seed stanza must stay exit-0 when every command fails: stderr=${r1.stderr}`);
      assert.match(r1.stdout ?? "", /WARN: could not queue the Redis backup seed/, "the refused start must surface as a WARN, not an abort");
      assert.match(r1.stdout ?? "", /--no-block/, "the seed start must be --no-block (never block the deploy)");

      // Config 2: find SUCCEEDS with a fresh dump → the no-seed branch; exit 0
      // without touching systemctl at all.
      writeFileSync(join(stubBin, "find"), "#!/usr/bin/env bash\necho /fake/hydra-redis-2026.rdb.gz\nexit 0\n");
      chmodSync(join(stubBin, "find"), 0o755);
      const r2 = spawnSync(
        "bash", ["-c", `set -euo pipefail; source '${seed}'`],
        { env: { ...process.env, PATH: `${stubBin}:${process.env.PATH ?? ""}` }, encoding: "utf-8", timeout: WATCHDOG_SPAWN_TIMEOUT_MS },
      );
      throwIfTimedOut(r2, WATCHDOG_SPAWN_TIMEOUT_MS, "seed stanza (fresh-dump path)");
      assert.equal(r2.status, 0, `the no-seed branch must also stay exit-0: stderr=${r2.stderr}`);
      assert.match(r2.stdout ?? "", /no seed needed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// redis-backup.sh SSD-unmounted guard — runs a COPY with the SSD root rebound
// onto a temp path and a stubbed docker, so the real container/SSD are never
// touched. No Redis needed.
// =============================================================================

describe("scripts/redis-backup.sh — SSD-unmounted guard (issue #4604)", () => {
  const SSD_ROOT_LITERAL = "/mnt/hydra-ssd/backups";
  let dir: string;
  let bin: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hydra-rb-4604-guard-"));
    bin = join(dir, "bin");
    mkdirSync(bin);
    // Stub docker to fail closed: anything past the guard that reaches the
    // container exits 1 without touching the real one.
    writeFileSync(join(bin, "docker"), "#!/usr/bin/env bash\necho '(stub) docker unavailable' >&2\nexit 1\n");
    chmodSync(join(bin, "docker"), 0o755);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function runRebound(): { status: number; stdout: string; stderr: string } {
    const src = readFileSync(BACKUP_SCRIPT, "utf-8");
    assert.ok(src.includes(SSD_ROOT_LITERAL), "script no longer references the SSD root — rebind needs updating");
    const root = join(dir, "ssd");
    const rebound = src.split(SSD_ROOT_LITERAL).join(root);
    const copy = join(dir, "redis-backup-rebound.sh");
    writeFileSync(copy, rebound);
    const r = spawnSync("bash", [copy], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      encoding: "utf-8",
      timeout: WATCHDOG_SPAWN_TIMEOUT_MS,
    });
    throwIfTimedOut(r, WATCHDOG_SPAWN_TIMEOUT_MS, "redis-backup.sh (rebound copy)");
    return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  test("redis-backup.sh refuses to run when the SSD backups root is absent", () => {
    // The rebound SSD root does not exist yet → the guard must exit 1 with
    // the FAILED refusal, BEFORE any docker call (INV-4: no silent mkdir -p
    // onto the root filesystem when the SSD is unmounted).
    const r = runRebound();
    assert.equal(r.status, 1, `guard must exit 1, got ${r.status}`);
    assert.match(r.stderr, /\[redis-backup\] FAILED/, "must fail loud on stderr");
    assert.match(r.stderr, /refusing to create it on the root filesystem/, "the refusal must name the reason");
    assert.ok(!existsSync(join(dir, "ssd")), "the SSD tree must NOT have been created");
  });

  test("with the SSD root present the guard passes and the leaf dir may be created", () => {
    mkdirSync(join(dir, "ssd"));
    const r = runRebound();
    // The guard passed: the script proceeded past it (mkdir'd the leaf) and
    // failed LATER, at the (stubbed) docker read — a different, later FAILED
    // message proves the guard specifically gated the absent-root case.
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stderr, /refusing to create it on the root filesystem/, "guard must not fire when the root exists");
    assert.match(r.stderr, /could not read rdb_last_save_time/, "script must proceed past the guard to the BGSAVE read");
    assert.ok(existsSync(join(dir, "ssd", "redis")), "the leaf redis/ dir may still be mkdir'd");
  });
});

// =============================================================================
// Behavioural cases — gated on the docker hydra-redis-1 container.
// =============================================================================

describe("run_redis_backup_freshness — detection + delivery (issue #4604)", { skip: !DOCKER }, () => {
  const SCRATCH = join(tmpdir(), `hydra-rb-freshness-scratch-${process.pid}`);
  let backupDir: string;

  beforeEach(() => {
    rmSync(SCRATCH, { recursive: true, force: true });
    backupDir = join(SCRATCH, "redis");
    mkdirSync(backupDir, { recursive: true });
    drc(["DEL", SINCE_KEY, FIRED_KEY]);
    drc(["DEL", TEST_NOTIFY_STREAM]);
  });

  after(() => {
    rmSync(SCRATCH, { recursive: true, force: true });
    drc(["DEL", SINCE_KEY, FIRED_KEY]);
    drc(["DEL", TEST_NOTIFY_STREAM]);
  });

  test("flags STALE when the newest dump is older than the threshold", () => {
    makeDump(backupDir, 48); // 48h old, default threshold 36h
    const r = runBlock({ HYDRA_WATCHDOG_BACKUP_DIR: backupDir });
    assert.equal(r.status, 0, `block must never exit non-zero: ${r.stderr}`);
    const lines = rbLines(r.stdout);
    assert.match(lines, /WARNING REDIS BACKUP STALE — stale/, "must warn on an old dump");
    assert.match(lines, /newest backup: hydra-redis-.*\.rdb\.gz/, "must name the newest dump");
    assert.equal(drc(["EXISTS", FIRED_KEY]), "1", "fired marker must be set");
    const entries = notifyEntriesSimple();
    assert.equal(entries.length, 1, "exactly one delivery per episode");
    assert.equal(entries[0].fields.type, "infra:redis_backup_stale");
    assert.equal(entries[0].fields.source, "watchdog-redis-backup-freshness");
    assert.match(entries[0].fields.payload, /"thresholdMs":129600000/, "36h threshold in the envelope");
  });

  test("flags STALE with reason=missing when the dir has no dumps", () => {
    const r = runBlock({ HYDRA_WATCHDOG_BACKUP_DIR: backupDir }); // empty dir
    assert.equal(r.status, 0, `block must never exit non-zero: ${r.stderr}`);
    assert.match(rbLines(r.stdout), /WARNING REDIS BACKUP STALE — missing/, "an empty backup dir is STALE");
    assert.equal(drc(["EXISTS", FIRED_KEY]), "1");
    assert.equal(notifyEntriesSimple().length, 1);
  });

  test("stays quiet against a fresh backup", () => {
    makeDump(backupDir, 1); // 1h old
    const r = runBlock({ HYDRA_WATCHDOG_BACKUP_DIR: backupDir });
    assert.equal(r.status, 0);
    assert.doesNotMatch(rbLines(r.stdout), /WARNING/, "a fresh backup must never warn");
    assert.equal(drc(["EXISTS", FIRED_KEY]), "0", "no fired marker");
    assert.equal(notifyEntriesSimple().length, 0, "no delivery for a fresh backup");
  });

  test("honours the stale-hours hook", () => {
    makeDump(backupDir, 2); // 2h old
    const r = runBlock({ HYDRA_WATCHDOG_BACKUP_DIR: backupDir, HYDRA_WATCHDOG_BACKUP_STALE_HOURS: "1" });
    assert.equal(r.status, 0);
    assert.match(rbLines(r.stdout), /WARNING REDIS BACKUP STALE/, "threshold override must apply");
  });

  test("dedup: a second consecutive stale tick does not re-deliver", () => {
    makeDump(backupDir, 48);
    runBlock({ HYDRA_WATCHDOG_BACKUP_DIR: backupDir });
    assert.equal(notifyEntriesSimple().length, 1);
    const r2 = runBlock({ HYDRA_WATCHDOG_BACKUP_DIR: backupDir });
    assert.equal(r2.status, 0);
    const lines2 = rbLines(r2.stdout);
    assert.match(lines2, /WARNING REDIS BACKUP STALE/, "the journal still flags every stale tick");
    assert.equal((lines2.match(/in-band delivery published/g) ?? []).length, 0, "the fired marker must suppress a re-delivery");
    assert.equal(notifyEntriesSimple().length, 1, "still exactly one delivery after the second tick");
  });

  test("recovery clears the episode, and a fresh streak re-delivers", () => {
    makeDump(backupDir, 48);
    runBlock({ HYDRA_WATCHDOG_BACKUP_DIR: backupDir });
    assert.equal(drc(["EXISTS", FIRED_KEY]), "1");

    // Recover: a fresh dump lands, next tick DELs both keys.
    makeDump(backupDir, 0);
    const r2 = runBlock({ HYDRA_WATCHDOG_BACKUP_DIR: backupDir });
    assert.equal(drc(["EXISTS", FIRED_KEY]), "0", "recovery must DEL the fired marker");
    assert.equal(drc(["EXISTS", SINCE_KEY]), "0", "recovery must DEL the since anchor too");
    assert.match(rbLines(r2.stdout), /fresh again/, "recovery is logged");

    // Recur: the dump ages out again — a fresh episode must re-deliver.
    // Clear the dir FIRST: adding another (older-mtime) file would leave the
    // fresh dump as the newest and the case would silently not recur.
    for (const f of readdirSync(backupDir)) rmSync(join(backupDir, f));
    makeDump(backupDir, 48);
    const r3 = runBlock({ HYDRA_WATCHDOG_BACKUP_DIR: backupDir });
    assert.match(rbLines(r3.stdout), /WARNING REDIS BACKUP STALE/, "a fresh streak must re-fire");
    assert.equal(notifyEntriesSimple().length, 2, "the fresh episode delivers a second event");
  });

  test("missing backup dir is STALE, not a wedged block", () => {
    const r = runBlock({ HYDRA_WATCHDOG_BACKUP_DIR: join(SCRATCH, "does-not-exist") });
    assert.equal(r.status, 0, `an absent dir must not break the block: ${r.stderr}`);
    assert.match(rbLines(r.stdout), /WARNING REDIS BACKUP STALE — missing/);
  });
});

// =============================================================================
// Fail-safe without Redis — Redis being down must not break the block
// (INV-6), and the off-by-default hooks must rebind everything a test needs
// (INV-7). No docker dependency: rc_* calls point at a dead local port and
// fail closed instantly; nothing lands anywhere.
// =============================================================================

describe("run_redis_backup_freshness — fail-safe without Redis (issue #4604)", () => {
  const SCRATCH = join(tmpdir(), `hydra-rb-freshness-noredis-${process.pid}`);
  const DEAD_REDIS = { HYDRA_REDIS_HOST: "127.0.0.1", HYDRA_REDIS_PORT: "9" };

  beforeEach(() => {
    rmSync(SCRATCH, { recursive: true, force: true });
    mkdirSync(SCRATCH, { recursive: true });
  });

  after(() => {
    rmSync(SCRATCH, { recursive: true, force: true });
  });

  test("never exits non-zero and still detects when Redis is unreachable", () => {
    makeDump(SCRATCH, 48);
    const r = runBlock({ ...DEAD_REDIS, HYDRA_WATCHDOG_BACKUP_DIR: SCRATCH });
    assert.equal(r.status, 0, `Redis being down must not break the block: ${r.stderr}`);
    const lines = rbLines(r.stdout);
    assert.match(lines, /WARNING REDIS BACKUP STALE — stale/, "detection must still work with Redis down");
    assert.match(lines, /in-band delivery published \(best-effort\)/, "delivery degrades to best-effort, never an abort");
  });

  test("off-by-default hooks rebind dir, stale hours, notify stream, and timer state", () => {
    makeDump(SCRATCH, 0); // fresh
    const r = runBlock({
      ...DEAD_REDIS,
      HYDRA_WATCHDOG_BACKUP_DIR: SCRATCH,
      HYDRA_WATCHDOG_BACKUP_STALE_HOURS: "36",
      HYDRA_WATCHDOG_BACKUP_TIMER_STATE: "disabled",
    });
    assert.equal(r.status, 0);
    const lines = rbLines(r.stdout);
    assert.match(lines, /not enabled \(state=disabled\)/, "a disabled timer is logged separately");
    assert.doesNotMatch(lines, /WARNING REDIS BACKUP STALE/, "the timer log is not the staleness signal");
    // And the fresh-path quiet behaviour via the rebound dir hook:
    assert.match(lines, /newest backup: hydra-redis-/);
  });
});
