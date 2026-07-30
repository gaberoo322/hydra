#!/usr/bin/env -S npx tsx
/**
 * Deployed-build drift check driver (issue #2663).
 *
 * The I/O half of the deployed-build drift check. Wires the pure classifier
 * in `scripts/deploy-drift-logic.ts` to real I/O: it (1) `git fetch`es
 * origin (bounded, no working-tree mutation), (2) reads the *running*
 * orchestrator's `/api/health.deployedSha`, (3) resolves `origin/master`
 * HEAD, (4) optionally reads the master checkout's dirty tree as a probable
 * drift cause, then emits a structured report.
 *
 * WHY THIS EXISTS
 *   2026-07-02: production ran ~30h-stale code (`POST /api/holdback/pending`
 *   404'd) while `hydra-doctor` reported "uptime 22h, status ok". The doctor
 *   had no "deployed build vs master HEAD" drift check — this closes that
 *   blind spot. The doctor playbook's Phase-1 collector calls this and
 *   renders the verdict as an explicit finding.
 *
 * Output modes:
 *   --json    print the DriftReport as JSON (default; consumed by the
 *             doctor playbook collector).
 *   --text    print a single human line (operator on the CLI).
 *   --alert   in addition, push a `severity: critical` alert into the Redis
 *             `hydra:alerts` list when drift is SUSTAINED (verdict `drift`).
 *
 * Read-only on the tree (HARD invariant): this NEVER mutates the master
 * checkout's working tree or any local branch. `git fetch` only updates
 * remote-tracking refs (origin/master); we never checkout/pull. Mirrors the
 * grounding.ts / hydra-watchdog.sh deploy-drift read-only rule.
 *
 * Fail-safe (HARD invariant): any git error, network failure, unreachable
 * API, or detached origin degrades to an `unknown` verdict and exits 0 — a
 * broken drift check must never make `hydra-doctor` itself report "failed".
 * Exit code is 0 unless an unexpected internal error occurs.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  buildDriftAlertMessage,
  classifyDrift,
  DEFAULT_DRIFT_GRACE_SECONDS,
  type DriftReport,
} from "./deploy-drift-logic.ts";
import { pushAlert } from "../src/redis/alerts.ts";

const execFileAsync = promisify(execFile);

/** $HYDRA_ROOT is the checkout deploy.sh keeps on master HEAD. */
const HYDRA_ROOT = process.env.HYDRA_ROOT || resolve(process.env.HOME || "/home/gabe", "hydra");

/** The running orchestrator's health endpoint (localhost data plane, :4000). */
const HEALTH_URL = process.env.HYDRA_HEALTH_URL || "http://localhost:4000/api/health";

/** Grace window (s) before drift is LOUD. Env-overridable for tests/tuning. */
const GRACE_SECONDS = Number(
  process.env.HYDRA_DEPLOY_DRIFT_GRACE_SECONDS || DEFAULT_DRIFT_GRACE_SECONDS,
);

/** Marker dir tracking when drift was first seen (grace-window bookkeeping). */
const STATE_DIR = process.env.HYDRA_DEPLOY_DRIFT_STATE_DIR || tmpdir();
const DRIFT_MARKER = join(STATE_DIR, "hydra-doctor-drift-since");

/** Bounded timeouts — a broken host must not pause the doctor for minutes. */
const GIT_TIMEOUT_MS = 8000;
const FETCH_TIMEOUT_MS = 5000;

/**
 * Read `/api/health.deployedSha` from the running service. Returns null on
 * any failure (service down, non-2xx, malformed JSON, field absent) — the
 * classifier treats null as `unknown`, which is the whole point: a dead
 * service is itself a drift-check "unknown", not a crash.
 */
async function readDeployedSha(): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(HEALTH_URL, { signal: ctrl.signal });
    if (!res.ok) return null;
    const body: any = await res.json();
    const sha = body?.deployedSha;
    return typeof sha === "string" && sha.length > 0 ? sha : null;
  } catch {
    /* intentional: service unreachable / abort / json parse -> unknown */
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * `git fetch` origin (remote-tracking refs only — NO working-tree mutation),
 * then resolve `origin/master` HEAD. Returns null on any git/network error
 * or a detached/missing origin — the classifier treats null as `unknown`.
 *
 * The fetch is best-effort: even if it fails (offline), we still try
 * `rev-parse origin/master` against the last-known remote-tracking ref. A
 * total failure degrades to null, never a throw.
 */
async function resolveRemoteSha(): Promise<string | null> {
  if (!existsSync(join(HYDRA_ROOT, ".git"))) return null;
  // Best-effort fetch. Never mutates the working tree or any local branch —
  // only origin/* remote-tracking refs. Swallow failures: an offline host
  // still falls through to the (possibly stale) rev-parse below.
  try {
    await execFileAsync("git", ["-C", HYDRA_ROOT, "fetch", "--quiet", "origin", "master"], {
      timeout: GIT_TIMEOUT_MS,
      encoding: "utf8",
    });
  } catch {
    /* intentional: offline / auth / timeout -> fall through to rev-parse */
  }
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", HYDRA_ROOT, "rev-parse", "origin/master"],
      { timeout: GIT_TIMEOUT_MS, encoding: "utf8" },
    );
    const sha = stdout.trim();
    return sha.length > 0 ? sha : null;
  } catch {
    /* intentional: detached origin / no origin/master ref -> unknown */
    return null;
  }
}

/**
 * Read tracked-but-modified paths in the master checkout (probable drift
 * cause: a dirty tree trips deploy.sh's guard and aborts the deploy). Returns
 * [] on any failure — the cause note is optional and never blocks the check.
 * `--porcelain -uno` excludes untracked files (only tracked modifications
 * block deploy.sh's dirty-tree guard).
 */
async function readDirtyTree(): Promise<string[]> {
  if (!existsSync(join(HYDRA_ROOT, ".git"))) return [];
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", HYDRA_ROOT, "status", "--porcelain", "-uno"],
      { timeout: GIT_TIMEOUT_MS, encoding: "utf8" },
    );
    return stdout
      .split("\n")
      .map(l => l.trim())
      .filter(Boolean)
      // porcelain lines are "XY path"; strip the 2-char status + space.
      .map(l => l.replace(/^\S{1,2}\s+/, ""))
      .filter(Boolean);
  } catch {
    /* intentional: git error -> no cause note */
    return [];
  }
}

/**
 * Drift-age bookkeeping via a marker file (mirrors the watchdog's
 * hydra-watchdog-drift-since marker). Returns how long drift has persisted.
 * `drifting=false` clears the marker (in-sync/unknown resets the clock).
 */
function driftAgeSeconds(drifting: boolean, now: number = Math.floor(Date.now() / 1000)): number {
  if (!drifting) {
    try {
      if (existsSync(DRIFT_MARKER)) rmSync(DRIFT_MARKER);
    } catch {
      /* intentional: marker cleanup best-effort */
    }
    return 0;
  }
  let firstSeen = now;
  try {
    if (existsSync(DRIFT_MARKER)) {
      const raw = readFileSync(DRIFT_MARKER, "utf8").trim();
      if (/^\d+$/.test(raw)) firstSeen = Number(raw);
    } else {
      writeFileSync(DRIFT_MARKER, String(now), "utf8");
    }
  } catch {
    /* intentional: marker read/write best-effort -> treat as first-seen now */
  }
  return Math.max(0, now - firstSeen);
}

/**
 * Push a critical-level alert into the Redis alerts list on sustained drift.
 *
 * Routed through the `pushAlert` seam (src/redis/alerts.ts) — NOT a redis-cli
 * shell-out. The prior shape passed `{ input: payload }` to the *async*
 * `execFile`, which has no `input` option (only the `*Sync` variants do): the
 * option was silently ignored, `redis-cli -x` read EOF, and every fire LPUSHed
 * the EMPTY string — dropping the real payload AND poisoning the list (#3743).
 * `pushAlert` pre-validates the payload against empty/unparseable input (#3609)
 * and pushes+trims atomically (#3619), so neither failure can recur.
 *
 * Best-effort: a Redis outage logs to stderr and never crashes the check.
 *
 * Exported so the regression test (test/deploy-drift.test.mts) can assert the
 * stored element parses and round-trips the payload — the exact assertion that
 * would have caught the silent empty-string push.
 */
export async function emitAlert(report: DriftReport): Promise<void> {
  const payload = JSON.stringify({
    id: `deploy-drift-${Date.now()}`,
    type: "deploy-drift",
    timestamp: new Date().toISOString(),
    message: buildDriftAlertMessage(report),
    severity: "critical",
    dismissed: false,
    payload: {
      deployedSha: report.deployedSha,
      remoteSha: report.remoteSha,
      driftAgeSeconds: report.driftAgeSeconds,
    },
  });
  try {
    await pushAlert(payload, 100);
  } catch (err: any) {
    console.error(`[deploy-drift] alert emit failed: ${err?.message ?? err}`);
  }
}

async function main(): Promise<number> {
  const args = new Set(process.argv.slice(2));
  const wantText = args.has("--text");
  const wantAlert = args.has("--alert");
  const wantJson = args.has("--json") || (!wantText && !wantAlert) || args.size === 0;

  const [deployedSha, remoteSha, dirtyTreePaths] = await Promise.all([
    readDeployedSha(),
    resolveRemoteSha(),
    readDirtyTree(),
  ]);

  // A first classify (age 0) tells us whether we're drifting; that decides
  // the marker bookkeeping, which then feeds the real (grace-aware) verdict.
  const provisional = classifyDrift(deployedSha, remoteSha, {
    driftAgeSeconds: 0,
    graceSeconds: GRACE_SECONDS,
    dirtyTreePaths,
  });
  const drifting = provisional.verdict === "drift" || provisional.verdict === "settling";
  const ageSeconds = driftAgeSeconds(drifting);

  const report = classifyDrift(deployedSha, remoteSha, {
    driftAgeSeconds: ageSeconds,
    graceSeconds: GRACE_SECONDS,
    dirtyTreePaths,
  });

  if (wantAlert && report.verdict === "drift") {
    await emitAlert(report);
  }

  if (wantText) {
    process.stdout.write(report.message + "\n");
    if (report.note) process.stdout.write("  " + report.note + "\n");
  }
  if (wantJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  }

  return 0;
}

// Only run the driver when invoked directly (shebang `npx tsx …`). Importing
// this module — e.g. from the regression test — must NOT trigger the git /
// network I/O or `process.exit` (mirrors the `isCliEntrypoint` guard every CI
// seam check uses).
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main()
    .then(code => process.exit(code))
    .catch(err => {
      console.error(`[deploy-drift] unexpected error: ${err?.stack ?? err}`);
      process.exit(1);
    });
}
