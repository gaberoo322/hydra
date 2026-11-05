/**
 * The REDIS BACKUP FRESHNESS watchdog check (issue #4604; ported to TypeScript
 * in #5098), plus the deploy-install contract for the Redis backup units and the
 * SSD-unmounted guard in scripts/redis-backup.sh.
 *
 * The nightly Redis backup is the ONLY copy of all orchestrator state off the
 * hydra_redis-data docker volume. Hard invariants pinned here:
 *
 *   1. Deploy installs the units + script copy and `enable --now`s the timer.
 *   2. The units carry the pinned shape (Type=oneshot, ExecStart=%h path,
 *      OnFailure template; OnCalendar 03:15, Persistent, Unit, WantedBy).
 *   3. A backup problem must NEVER fail or abort deploy.sh.
 *   4. redis-backup.sh refuses to run when /mnt/hydra-ssd/backups is absent.
 *   5. The watchdog check is advisory and fail-safe: STALE on missing/old dump,
 *      fires ONCE per episode on the shared episode tracker (threshold 0),
 *      resolves on recovery, and never throws (#5098: now driven 1:1 over
 *      in-memory fake ports — no bash, docker or Redis).
 */

import test, { describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { WATCHDOG_CHECKS } from "../src/watchdog/checks.ts";
import { STREAMS } from "../src/event-bus-stream-keys.ts";
import { REDIS_BACKUP_KEY_PREFIX, redisBackupEpisodeKeys } from "../src/redis/watchdog-episodes.ts";
import {
  DEFAULT_REDIS_BACKUP_STALE_HOURS,
  REDIS_BACKUP_LOG_PREFIX,
  REDIS_BACKUP_STALE_KIND,
  decideRedisBackup,
  parseStaleHours,
  runRedisBackup,
} from "../src/watchdog/redis-backup.ts";
import { ALERT_TYPES } from "../src/notification/alert-grammar.ts";
import { isPageKind } from "../src/operator-channel/page-list.ts";
import {
  WATCHDOG_SPAWN_TIMEOUT_MS,
  throwIfTimedOut,
} from "./_helpers/watchdog-timeouts.mts";
import { NOW_MS, NOW_S, makeRedisBackupHarness } from "./_helpers/watchdog-drift-fakes.mts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const WATCHDOG = join(REPO_ROOT, "scripts", "hydra-watchdog.sh");
const DEPLOY = join(REPO_ROOT, "scripts", "deploy.sh");
const BACKUP_SCRIPT = join(REPO_ROOT, "scripts", "redis-backup.sh");
const BACKUP_SERVICE = join(REPO_ROOT, "scripts", "systemd", "hydra-redis-backup.service");
const BACKUP_TIMER = join(REPO_ROOT, "scripts", "systemd", "hydra-redis-backup.timer");

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
      svc, /^OnFailure=hydra-notify-failure@%n$/m,
      "a failed backup must page via the tracked Operator Channel template, normalised to @%n (#4284, #5046)",
    );
    const timer = readFileSync(BACKUP_TIMER, "utf-8");
    assert.match(timer, /^OnCalendar=\*-\*-\* 03:15:00$/m, "daily 03:15 schedule (docs/reference.md)");
    assert.match(timer, /^Persistent=true$/m, "catch up after downtime");
    assert.match(timer, /^Unit=hydra-redis-backup\.service$/m, "timer must trigger the backup service");
    assert.match(timer, /^WantedBy=timers\.target$/m, "install target");
  });

  test("WATCHDOG_CHECKS runs redis-backup (90s bound) between deploy-drift and skill-mirror", () => {
    const subs = WATCHDOG_CHECKS.map((c) => c.subcommand);
    const i = subs.indexOf("redis-backup");
    assert.deepEqual(subs.slice(i - 1, i + 2), ["deploy-drift", "redis-backup", "skill-mirror"]);
    assert.equal(WATCHDOG_CHECKS[i].timeoutS, 90);
    assert.equal(WATCHDOG_CHECKS[i].logPrefix, REDIS_BACKUP_LOG_PREFIX);
  });

  test("the event type stays a module constant, OUT of the alert vocabulary", () => {
    assert.equal(REDIS_BACKUP_STALE_KIND, "infra:redis_backup_stale");
    assert.equal(ALERT_TYPES.has(REDIS_BACKUP_STALE_KIND), false, "the alert surface does not change");
    assert.equal(STREAMS.NOTIFICATIONS, "hydra:notifications");
    assert.equal(isPageKind(REDIS_BACKUP_STALE_KIND), true, "the Page kind is a registered Operator Channel kind");
  });

  test("the episode keys keep the pre-cut-over Redis key names", () => {
    assert.equal(REDIS_BACKUP_KEY_PREFIX, "hydra:autopilot:redis-backup-freshness");
    assert.deepEqual(redisBackupEpisodeKeys(), {
      since: "hydra:autopilot:redis-backup-freshness:since",
      fired: "hydra:autopilot:redis-backup-freshness:fired",
    });
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
// Detection + delivery over fake ports (issue #4604, #5098)
// =============================================================================

const cfg = (over: Partial<{ backupDir: string; staleHours: number }> = {}) => ({
  backupDir: "/mnt/hydra-ssd/backups/redis",
  staleHours: 36,
  ...over,
});
const hoursAgo = (h: number) => ({ name: "hydra-redis-2026-09-10_0315.rdb.gz", mtimeS: NOW_S - h * 3600 });
const text = (logs: string[]): string => logs.join("\n");

describe("redis-backup freshness check — detection + delivery", () => {
  test("flags STALE when the newest dump is older than the threshold: event + Page + fired marker", async () => {
    const h = makeRedisBackupHarness();
    h.state.newest = hoursAgo(40);
    await runRedisBackup(h.deps, cfg());
    assert.match(text(h.logs), /WARNING REDIS BACKUP STALE — stale in \/mnt\/hydra-ssd\/backups\/redis \(threshold 36h\)/);
    assert.equal(h.published.length, 1);
    const ev = h.published[0];
    assert.equal(ev.stream, STREAMS.NOTIFICATIONS);
    assert.equal(ev.event.type, "infra:redis_backup_stale");
    assert.equal(ev.event.source, "watchdog-redis-backup-freshness");
    assert.equal(ev.event.correlationId, "redis-backup-freshness");
    assert.deepEqual(ev.event.payload, {
      signal: "redis-backup",
      reason: "stale",
      durationMs: 40 * 3600 * 1000,
      thresholdMs: 36 * 3600 * 1000,
    });
    assert.equal(h.pages.length, 1);
    assert.equal(h.pages[0].kind, REDIS_BACKUP_STALE_KIND);
    assert.equal(h.pages[0].dedupKey, REDIS_BACKUP_STALE_KIND, "dedupKey == kind");
    assert.ok(h.store.kv.has(`${REDIS_BACKUP_KEY_PREFIX}:fired`));
    assert.ok(h.logs.every((l) => l.startsWith(REDIS_BACKUP_LOG_PREFIX)));
  });

  test("flags STALE with reason=missing (age 0) when the dir has no dumps", async () => {
    const h = makeRedisBackupHarness();
    h.state.newest = null;
    await runRedisBackup(h.deps, cfg({ backupDir: "/nonexistent-rb-freshness-dir" }));
    assert.equal((h.published[0].event.payload as { reason: string; durationMs: number }).reason, "missing");
    assert.equal((h.published[0].event.payload as { durationMs: number }).durationMs, 0);
    assert.match(text(h.logs), /STALE — missing in \/nonexistent-rb-freshness-dir/);
  });

  test("stays quiet against a fresh backup", async () => {
    const h = makeRedisBackupHarness();
    h.state.newest = hoursAgo(1);
    await runRedisBackup(h.deps, cfg());
    assert.equal(h.published.length, 0);
    assert.equal(h.pages.length, 0);
    assert.equal(h.store.kv.size, 0);
    assert.match(text(h.logs), /newest backup: hydra-redis-2026-09-10_0315\.rdb\.gz \(age 3600s ≈ 1h; stale threshold 36h\)/);
  });

  test("honours the stale-hours knob (boundary is >=)", async () => {
    const h = makeRedisBackupHarness();
    h.state.newest = hoursAgo(2);
    await runRedisBackup(h.deps, cfg({ staleHours: 1 }));
    assert.equal(h.published.length, 1);
    assert.deepEqual(decideRedisBackup({ name: "x", mtimeS: NOW_S - 3600 }, NOW_S, 1), { stale: true, reason: "stale", ageS: 3600 });
    assert.equal(decideRedisBackup({ name: "x", mtimeS: NOW_S - 3599 }, NOW_S, 1).stale, false);
    assert.equal(parseStaleHours("abc"), DEFAULT_REDIS_BACKUP_STALE_HOURS);
    assert.equal(parseStaleHours("12"), 12);
    assert.equal(parseStaleHours(undefined), 36);
  });

  test("an mtime in the future clamps to age 0 (fresh)", () => {
    assert.deepEqual(decideRedisBackup({ name: "x", mtimeS: NOW_S + 999 }, NOW_S, 36), { stale: false, ageS: 0 });
  });

  test("dedup: a second consecutive stale tick does not re-deliver", async () => {
    const h = makeRedisBackupHarness();
    h.state.newest = hoursAgo(40);
    await runRedisBackup(h.deps, cfg());
    await runRedisBackup(h.deps, cfg());
    assert.equal(h.published.length, 1);
    assert.equal(h.pages.length, 1);
  });

  test("recovery resolves the Page and clears the episode, and a fresh streak re-delivers", async () => {
    const h = makeRedisBackupHarness();
    h.state.newest = hoursAgo(40);
    await runRedisBackup(h.deps, cfg());
    h.state.newest = hoursAgo(1);
    await runRedisBackup(h.deps, cfg());
    assert.deepEqual(h.resolves, [{ key: REDIS_BACKUP_STALE_KIND, title: "Redis backup fresh again" }]);
    assert.equal(h.store.kv.size, 0);
    assert.match(text(h.logs), /redis backup fresh again — clearing the staleness episode/);
    h.state.newest = hoursAgo(40);
    await runRedisBackup(h.deps, cfg());
    assert.equal(h.published.length, 2);
  });

  test("a fresh tick with no fired marker resolves nothing", async () => {
    const h = makeRedisBackupHarness();
    h.state.newest = hoursAgo(1);
    await runRedisBackup(h.deps, cfg());
    assert.equal(h.resolves.length, 0);
  });

  test("timer visibility is a WARN line only, never part of the stale signal", async () => {
    const h = makeRedisBackupHarness();
    h.state.newest = hoursAgo(1);
    h.state.timer = "disabled";
    await runRedisBackup(h.deps, cfg());
    assert.match(text(h.logs), /WARN hydra-redis-backup\.timer is not enabled \(state=disabled\)/);
    assert.equal(h.published.length, 0);
  });

  test("fail-safe: a failing publish is a WARN, the Page still goes out, the fired marker stays set", async () => {
    const h = makeRedisBackupHarness();
    h.state.newest = hoursAgo(40);
    h.state.failPublish = true;
    await runRedisBackup(h.deps, cfg());
    assert.match(text(h.logs), /WARN in-band delivery FAILED/);
    assert.equal(h.pages.length, 1);
    assert.ok(h.store.kv.has(`${REDIS_BACKUP_KEY_PREFIX}:fired`));
  });

  test("fail-safe: an unreachable Redis skips the signal and still detects (never throws)", async () => {
    const h = makeRedisBackupHarness();
    h.state.newest = hoursAgo(40);
    h.store.failReads = true;
    await runRedisBackup(h.deps, cfg());
    assert.match(text(h.logs), /WARNING REDIS BACKUP STALE/);
    assert.match(text(h.logs), /state read failed/);
    assert.equal(h.published.length, 0);
    assert.equal(NOW_MS > 0, true);
  });
});
