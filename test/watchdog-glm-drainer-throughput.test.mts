/**
 * Regression test for issue #3868 — the ## GLM DRAINER ZERO-THROUGHPUT block
 * (`run_glm_drainer_throughput`) in the consolidated `scripts/hydra-watchdog.sh`.
 *
 * Motivating incident (2026-08-05 autopilot run 2bcba309): the GLM dev-drainer
 * (ADR-0032, issue #3689) was LIVE all night — fresh heartbeat, claims
 * proceeding — but broken at its final step (#3863, `gh pr create` failing on
 * every attempt), so it authored ~40 min per issue on z.ai's own quota and
 * shipped nothing, while ALSO keeping every `glm-eligible` issue excluded from
 * the Claude dev lane (the #3754 gate). No alarm fired: the existing liveness
 * check only asks "is the heartbeat fresh?", never "is the drainer landing
 * PRs?". This block closes that gap.
 *
 * Three states to tell apart, all pinned below:
 *   - "live but sterile"  — fresh heartbeat, >= N claim attempts, ZERO
 *                           successful PR creations in that window. FIRES.
 *   - "down"              — heartbeat absent/stale. Owned by the existing
 *                           #3754 fail-open liveness gate, NOT this alarm.
 *                           QUIET.
 *   - "no work queued"    — fresh heartbeat, too few claim attempts to judge.
 *                           QUIET.
 *   - "producing PRs"     — fresh heartbeat, a success line inside the last-N
 *                           claim window. QUIET.
 *
 * Isolation method (mirrors test/autopilot-watchdog.test.mts and
 * test/watchdog-launch-flow.test.mts): strip the top-level dispatch lines +
 * trailing `exit 0` from the script, source only the function definitions,
 * then call `run_glm_drainer_throughput` directly — this exercises ONLY the
 * new block, never the other blocks' real systemctl/docker/curl side effects.
 *
 * Redis and the drain log are both faked via `PATH`/env-var shims (a plain
 * script standing in for `redis-cli` and `journalctl`, respectively) — no
 * docker/live-Redis dependency, and critically NO risk of colliding with
 * production's real `hydra:glm:drainer:active` key (unlike a docker-redis
 * test against the shared dev/CI Redis, this suite never touches it).
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  GLM_DRAINER_ACTIVE_KEY,
  GLM_DRAINER_HEARTBEAT_STALE_MS,
} from "../src/redis/autopilot.ts";
import {
  WATCHDOG_SPAWN_TIMEOUT_MS,
  throwIfTimedOut,
} from "./_helpers/watchdog-timeouts.mts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const WATCHDOG = join(REPO_ROOT, "scripts", "hydra-watchdog.sh");

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "glm-drainer-throughput-test-"));
}

/** Write an executable shell shim that always prints `body` to stdout. */
function writeShim(path: string, body: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`, "utf-8");
  chmodSync(path, 0o755);
}

/** A redis-cli shim: any invocation just echoes `value` (empty => nothing printed, simulating an absent key). */
function makeRedisShim(dir: string, value: string | null): string {
  const path = join(dir, "redis-cli");
  writeShim(path, value === null ? "true" : `echo '${value}'`);
  return path;
}

/** A journalctl shim: any invocation prints `logText` verbatim, ignoring argv. */
function makeJournalShim(dir: string, logText: string): string {
  const path = join(dir, "journalctl-shim.sh");
  const heredoc = `cat <<'LOG'\n${logText}\nLOG\n`;
  writeShim(path, heredoc);
  return path;
}

/** A journalctl shim that fails (non-zero exit), simulating an unreadable drain log. */
function makeFailingJournalShim(dir: string): string {
  const path = join(dir, "journalctl-fail.sh");
  writeShim(path, "exit 1");
  return path;
}

const CLAIM = (n: number) =>
  `Aug 19 09:0${n}:00 host hydra-glm-drainer.service[1]: hydra-glm-drainer: claiming issue #${100 + n}`;
const FAIL = (n: number) =>
  `Aug 19 09:0${n}:30 host hydra-glm-drainer.service[1]: hydra-glm-drainer: ERROR gh pr create failed for issue #${100 + n} branch=b${n} and no existing PR found for that branch — genuine failure`;
const SUCCESS = (n: number) =>
  `Aug 19 09:0${n}:30 host hydra-glm-drainer.service[1]: hydra-glm-drainer: issue #${100 + n}: gh pr create succeeded: https://github.com/x/y/pull/${n}`;
const ADOPT = (n: number) =>
  `Aug 19 09:0${n}:30 host hydra-glm-drainer.service[1]: hydra-glm-drainer: ANOMALY issue #${100 + n}: gh pr create failed but PR #${n} (https://x) already exists for branch=b${n} — adopting it instead of releasing the claim (see issue #3900)`;

/** Three claim/no-PR cycles — the exact synthetic log shape the issue's acceptance criterion names. */
const THREE_STERILE_CYCLES = [CLAIM(1), FAIL(1), CLAIM(2), FAIL(2), CLAIM(3), FAIL(3)].join("\n");
/** Same three claims, but the last one lands a PR. */
const THIRD_CLAIM_SUCCEEDS = [CLAIM(1), FAIL(1), CLAIM(2), FAIL(2), CLAIM(3), SUCCESS(3)].join("\n");
/** Same three claims, but the first one adopts an existing PR (#3900 anomaly path) instead of a fresh success line. */
const FIRST_CLAIM_ADOPTS = [CLAIM(1), ADOPT(1), CLAIM(2), FAIL(2), CLAIM(3), FAIL(3)].join("\n");
/** Only two claim attempts — below the default N=3 threshold. */
const TWO_STERILE_CYCLES = [CLAIM(1), FAIL(1), CLAIM(2), FAIL(2)].join("\n");

interface RunResult {
  status: number;
  stdout: string;
}

function runBlock(env: Record<string, string>): RunResult {
  const driver = [
    "set -euo pipefail",
    `source <(sed -e '/^run_service_liveness$/d' -e '/^run_autopilot_wedge$/d' -e '/^run_deploy_drift$/d' -e '/^run_skill_mirror_drift$/d' -e '/^run_launch_flow$/d' -e '/^run_glm_drainer_throughput$/d' -e '/^exit 0$/d' ${JSON.stringify(WATCHDOG)})`,
    "run_glm_drainer_throughput",
  ].join("\n");
  const r = spawnSync("bash", ["-c", driver], {
    env: { ...process.env, ...env, PATH: env.PATH ?? process.env.PATH ?? "" },
    encoding: "utf-8",
    timeout: WATCHDOG_SPAWN_TIMEOUT_MS,
  });
  throwIfTimedOut(r, WATCHDOG_SPAWN_TIMEOUT_MS, "watchdog glm-drainer-throughput block");
  return { status: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
}

describe("scripts/hydra-watchdog.sh — GLM DRAINER ZERO-THROUGHPUT block (issue #3868)", () => {
  const NOW_MS = "2000000";
  const FRESH_HEARTBEAT_MS = "1990000"; // 10s old — well within any threshold
  const STALE_HEARTBEAT_MS = "1"; // ~2000s old — past the (test) threshold below

  test("drift guard: the block's key/threshold literals match src/redis/autopilot.ts", () => {
    const src = readFileSync(WATCHDOG, "utf-8");
    assert.ok(
      src.includes(GLM_DRAINER_ACTIVE_KEY),
      `hydra-watchdog.sh must reference the literal Redis key ${JSON.stringify(GLM_DRAINER_ACTIVE_KEY)} exactly as owned by src/redis/autopilot.ts`,
    );
    assert.ok(
      src.includes(String(GLM_DRAINER_HEARTBEAT_STALE_MS)),
      `hydra-watchdog.sh's default staleness window must match GLM_DRAINER_HEARTBEAT_STALE_MS (${GLM_DRAINER_HEARTBEAT_STALE_MS}ms)`,
    );
  });

  test("entry point: run_glm_drainer_throughput is dispatched on every direct-execution tick", () => {
    const src = readFileSync(WATCHDOG, "utf-8");
    const entryPoint = src.slice(src.lastIndexOf('if [[ "${BASH_SOURCE[0]}"'));
    assert.ok(
      entryPoint.includes("run_glm_drainer_throughput"),
      "the direct-execution entry point must call run_glm_drainer_throughput alongside the other blocks",
    );
  });

  test("FIRES: fresh heartbeat + 3 consecutive claim/no-PR cycles (the issue's exact acceptance scenario)", () => {
    const dir = makeTempDir();
    try {
      const redisShimDir = dir;
      makeRedisShim(redisShimDir, FRESH_HEARTBEAT_MS);
      const journal = makeJournalShim(dir, THREE_STERILE_CYCLES);
      const r = runBlock({
        PATH: `${redisShimDir}:${process.env.PATH ?? ""}`,
        HYDRA_REDIS_HOST: "test-host",
        HYDRA_REDIS_PORT: "0",
        HYDRA_WATCHDOG_GLM_JOURNAL_CMD: journal,
        HYDRA_WATCHDOG_GLM_NOW_MS: NOW_MS,
      });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /WARNING GLM DRAINER ZERO-THROUGHPUT/);
      assert.match(r.stdout, /#3868/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("QUIET: fresh heartbeat but the window includes a successful PR creation", () => {
    const dir = makeTempDir();
    try {
      makeRedisShim(dir, FRESH_HEARTBEAT_MS);
      const journal = makeJournalShim(dir, THIRD_CLAIM_SUCCEEDS);
      const r = runBlock({
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        HYDRA_REDIS_HOST: "test-host",
        HYDRA_WATCHDOG_GLM_JOURNAL_CMD: journal,
        HYDRA_WATCHDOG_GLM_NOW_MS: NOW_MS,
      });
      assert.equal(r.status, 0);
      assert.doesNotMatch(r.stdout, /WARNING GLM DRAINER ZERO-THROUGHPUT/);
      assert.match(r.stdout, /healthy/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("QUIET: a #3900 PR-adoption line counts as a successful outcome, not a failure", () => {
    const dir = makeTempDir();
    try {
      makeRedisShim(dir, FRESH_HEARTBEAT_MS);
      const journal = makeJournalShim(dir, FIRST_CLAIM_ADOPTS);
      const r = runBlock({
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        HYDRA_REDIS_HOST: "test-host",
        HYDRA_WATCHDOG_GLM_JOURNAL_CMD: journal,
        HYDRA_WATCHDOG_GLM_NOW_MS: NOW_MS,
      });
      assert.equal(r.status, 0);
      assert.doesNotMatch(r.stdout, /WARNING GLM DRAINER ZERO-THROUGHPUT/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("QUIET: stale heartbeat — presumed down, not this alarm's job (even with 3 sterile cycles in the log)", () => {
    const dir = makeTempDir();
    try {
      makeRedisShim(dir, STALE_HEARTBEAT_MS);
      const journal = makeJournalShim(dir, THREE_STERILE_CYCLES);
      const r = runBlock({
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        HYDRA_REDIS_HOST: "test-host",
        HYDRA_WATCHDOG_GLM_JOURNAL_CMD: journal,
        HYDRA_WATCHDOG_GLM_NOW_MS: NOW_MS,
        HYDRA_WATCHDOG_GLM_HEARTBEAT_STALE_MS: "10000", // 10s window so 1ms-epoch heartbeat reads STALE
      });
      assert.equal(r.status, 0);
      assert.doesNotMatch(r.stdout, /WARNING GLM DRAINER ZERO-THROUGHPUT/);
      assert.match(r.stdout, /STALE/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("QUIET: heartbeat absent/unreadable — the #3754 liveness gate's case, not this alarm's", () => {
    const dir = makeTempDir();
    try {
      makeRedisShim(dir, null);
      const journal = makeJournalShim(dir, THREE_STERILE_CYCLES);
      const r = runBlock({
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        HYDRA_REDIS_HOST: "test-host",
        HYDRA_WATCHDOG_GLM_JOURNAL_CMD: journal,
        HYDRA_WATCHDOG_GLM_NOW_MS: NOW_MS,
      });
      assert.equal(r.status, 0);
      assert.doesNotMatch(r.stdout, /WARNING GLM DRAINER ZERO-THROUGHPUT/);
      assert.match(r.stdout, /absent\/unreadable/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("QUIET: fresh heartbeat but fewer than N claim attempts in the window (no work queued)", () => {
    const dir = makeTempDir();
    try {
      makeRedisShim(dir, FRESH_HEARTBEAT_MS);
      const journal = makeJournalShim(dir, TWO_STERILE_CYCLES);
      const r = runBlock({
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        HYDRA_REDIS_HOST: "test-host",
        HYDRA_WATCHDOG_GLM_JOURNAL_CMD: journal,
        HYDRA_WATCHDOG_GLM_NOW_MS: NOW_MS,
      });
      assert.equal(r.status, 0);
      assert.doesNotMatch(r.stdout, /WARNING GLM DRAINER ZERO-THROUGHPUT/);
      assert.match(r.stdout, /no work queued/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("QUIET: drain log unreadable (journalctl exits non-zero) — never fabricate a verdict from a partial read", () => {
    const dir = makeTempDir();
    try {
      makeRedisShim(dir, FRESH_HEARTBEAT_MS);
      const journal = makeFailingJournalShim(dir);
      const r = runBlock({
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        HYDRA_REDIS_HOST: "test-host",
        HYDRA_WATCHDOG_GLM_JOURNAL_CMD: journal,
        HYDRA_WATCHDOG_GLM_NOW_MS: NOW_MS,
      });
      assert.equal(r.status, 0);
      assert.doesNotMatch(r.stdout, /WARNING GLM DRAINER ZERO-THROUGHPUT/);
      assert.match(r.stdout, /WARN could not read drain log/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("MIN_CLAIMS is configurable: N=2 fires on only 2 sterile cycles", () => {
    const dir = makeTempDir();
    try {
      makeRedisShim(dir, FRESH_HEARTBEAT_MS);
      const journal = makeJournalShim(dir, TWO_STERILE_CYCLES);
      const r = runBlock({
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        HYDRA_REDIS_HOST: "test-host",
        HYDRA_WATCHDOG_GLM_JOURNAL_CMD: journal,
        HYDRA_WATCHDOG_GLM_NOW_MS: NOW_MS,
        HYDRA_WATCHDOG_GLM_ZERO_THROUGHPUT_CLAIMS: "2",
      });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /WARNING GLM DRAINER ZERO-THROUGHPUT/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
