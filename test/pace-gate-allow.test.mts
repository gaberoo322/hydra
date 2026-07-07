/**
 * Regression tests for the composed-verdict (.allow) admission check in
 * pace-gate.sh (issue #1790).
 *
 * Observed live on 2026-06-12 (run d4a6af2a): /api/usage/eligibility returned
 * allow:false with reasons.weeklyEmergencyStop:true, but pace-gate.sh only
 * read paused / sessionBlockedUntil / emergencyStop / paceState — so every
 * ~15-min tick launched a full autopilot session that immediately hard-stopped
 * in decide.py, a relaunch churn loop lasting until the weekly reset.
 *
 * This suite pins:
 *   - weeklyEmergencyStop:true => skip with a reason-specific log line;
 *   - allow:false with NO specific reason set => the catch-all arm skips and
 *     logs the raw .reasons JSON (future-reason drift protection);
 *   - allow:true + paceState:"behind" => the eligible path is unchanged;
 *   - a missing .allow => fail safe (no launch) — and in particular the fix
 *     must NOT use jq's `.allow // true`, which treats false as falsy and
 *     would silently invert the check;
 *   - exec mode (--exec-autopilot, the unit's ExecStart wrapper) honors
 *     allow:false with a CLEAN exit 0 so Restart=on-failure disarms.
 *
 * Pure shell test: eligibilityServer fixture + spawn, no Redis needed.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PACE_GATE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "autopilot",
  "pace-gate.sh",
);

/** Serve a fixed eligibility JSON on an ephemeral port; resolve with url+close. */
function eligibilityServer(payload: unknown): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as any;
      resolve({
        url: `http://127.0.0.1:${addr.port}/api/usage/eligibility`,
        close: () => server.close(),
      });
    });
  });
}

function runPaceGate(
  eligibilityUrl: string,
  args: string[] = [],
  extraEnv: Record<string, string> = {},
): Promise<{ status: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [PACE_GATE, ...args], {
      env: {
        ...process.env,
        HYDRA_PACE_GATE_FORCE_SERVICE_INACTIVE: "1",
        HYDRA_PACE_GATE_DRY_RUN: "1",
        HYDRA_PACE_GATE_ELIGIBILITY_URL: eligibilityUrl,
        HYDRA_AUTOPILOT_STATE: "/tmp/hydra-pace-gate-allow-nonexistent.json",
        ...extraEnv,
      },
    });
    let stdout = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ status: code ?? -1, stdout }));
  });
}

const baseReasons = {
  emergencyStop: false,
  weeklyEmergencyStop: false,
  pacingShed: false,
  calibrated: true,
  paused: false,
  sessionBlockedUntil: null as string | null,
  worklessUntil: null as string | null,
};

describe("pace-gate.sh composed-verdict admission (issue #1790)", () => {
  test("weeklyEmergencyStop:true (allow:false, paceState:behind) => skip with reason-specific log, no launch", async () => {
    const srv = await eligibilityServer({
      allow: false,
      shed: [],
      reasons: { ...baseReasons, weeklyEmergencyStop: true },
      paceState: "behind",
    });
    try {
      const r = await runPaceGate(srv.url);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /weekly emergencyStop/);
      assert.doesNotMatch(r.stdout, /would-start/);
    } finally {
      srv.close();
    }
  });

  test("allow:false with NO specific reason set => catch-all skip logging the raw reasons JSON", async () => {
    // Simulates a FUTURE reason added to projectEligibility() that this
    // script has never heard of — the drift mode that caused #1790.
    const srv = await eligibilityServer({
      allow: false,
      shed: [],
      reasons: { ...baseReasons, someFutureReason: true },
      paceState: "behind",
    });
    try {
      const r = await runPaceGate(srv.url);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /eligibility allow=false/);
      assert.match(r.stdout, /someFutureReason/); // raw .reasons JSON in the log
      assert.doesNotMatch(r.stdout, /would-start/);
    } finally {
      srv.close();
    }
  });

  test("allow:true + paceState:behind => eligible path unchanged (would-start)", async () => {
    const srv = await eligibilityServer({
      allow: true,
      shed: [],
      reasons: { ...baseReasons },
      paceState: "behind",
    });
    try {
      const r = await runPaceGate(srv.url);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /would-start/);
    } finally {
      srv.close();
    }
  });

  test("missing .allow => fail safe (no launch) — guards against the jq `// true` inversion", async () => {
    // jq's `//` operator treats false as falsy: `.allow // true` would read
    // allow:false as eligible. The script must use bare `.allow` with strict
    // string matching, so a MISSING field ("null") fails safe, not eligible.
    const srv = await eligibilityServer({
      shed: [],
      reasons: { ...baseReasons },
      paceState: "behind",
    });
    try {
      const r = await runPaceGate(srv.url);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /\.allow missing or non-boolean/);
      assert.doesNotMatch(r.stdout, /would-start/);
    } finally {
      srv.close();
    }
  });

  test("exec mode (--exec-autopilot) + allow:false => clean exit 0, does NOT exec", async () => {
    const srv = await eligibilityServer({
      allow: false,
      shed: [],
      reasons: { ...baseReasons, weeklyEmergencyStop: true },
      paceState: "behind",
    });
    try {
      const r = await runPaceGate(srv.url, ["--exec-autopilot"], {
        HYDRA_PACE_GATE_EXEC_CMD: "echo exec-marker-should-not-appear",
      });
      assert.equal(r.status, 0); // CLEAN exit — Restart=on-failure must disarm
      assert.match(r.stdout, /weekly emergencyStop/);
      assert.doesNotMatch(r.stdout, /would-exec/);
      assert.doesNotMatch(r.stdout, /exec-marker-should-not-appear/);
    } finally {
      srv.close();
    }
  });

  test("exec mode eligible branch exports HYDRA_AUTOPILOT_TRIGGER=pace-gate to the exec'd command (issue #2955)", async () => {
    const srv = await eligibilityServer({
      allow: true,
      shed: [],
      reasons: { ...baseReasons },
      paceState: "behind",
    });
    try {
      const r = await runPaceGate(srv.url, ["--exec-autopilot"], {
        // The runPaceGate fixture defaults DRY_RUN=1, whose early-exit
        // precedes the EXEC_CMD hook — override to 0 so the hook execs.
        HYDRA_PACE_GATE_DRY_RUN: "0",
        // EXEC_CMD is intentionally word-split with NO quote re-parsing, so
        // keep it to plain words (`sh -c '...'` would shatter). printenv
        // observes exactly what the exec'd claude CLI would inherit.
        HYDRA_PACE_GATE_EXEC_CMD: "printenv HYDRA_AUTOPILOT_TRIGGER",
        // Prove the SCRIPT stamps the value (not env inheritance): seed a
        // decoy that the eligible branch's export must overwrite.
        HYDRA_AUTOPILOT_TRIGGER: "decoy-not-from-gate",
      });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /^pace-gate$/m);
      assert.doesNotMatch(r.stdout, /decoy-not-from-gate/);
    } finally {
      srv.close();
    }
  });

  test("workless-board hint in the FUTURE => skip (no launch), NOT flipping allow (#2956)", async () => {
    // allow stays TRUE (the workless hint is launcher-only advisory, never a
    // hard stop) but the future worklessUntil must still skip the launch.
    const future = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const srv = await eligibilityServer({
      allow: true,
      shed: [],
      reasons: { ...baseReasons, worklessUntil: future },
      paceState: "behind",
    });
    try {
      const r = await runPaceGate(srv.url);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /workless-board backoff/);
      assert.doesNotMatch(r.stdout, /would-start/);
    } finally {
      srv.close();
    }
  });

  test("workless-board hint in the PAST => launch normally (self-heals) (#2956)", async () => {
    // A stale hint (past instant) must fall through to launch — the belt-and-
    // braces read-side guard that pairs with the Redis TTL self-clear.
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    const srv = await eligibilityServer({
      allow: true,
      shed: [],
      reasons: { ...baseReasons, worklessUntil: past },
      paceState: "behind",
    });
    try {
      const r = await runPaceGate(srv.url);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /would-start/);
      assert.doesNotMatch(r.stdout, /workless-board backoff/);
    } finally {
      srv.close();
    }
  });

  test("exec mode ineligible exit does NOT reach the trigger export (issue #2955)", async () => {
    const srv = await eligibilityServer({
      allow: false,
      shed: [],
      reasons: { ...baseReasons, weeklyEmergencyStop: true },
      paceState: "behind",
    });
    try {
      // DRY_RUN=0 + a printenv EXEC_CMD: if the ineligible path ever fell
      // through to the export+exec, "pace-gate" would appear on stdout.
      const r = await runPaceGate(srv.url, ["--exec-autopilot"], {
        HYDRA_PACE_GATE_DRY_RUN: "0",
        HYDRA_PACE_GATE_EXEC_CMD: "printenv HYDRA_AUTOPILOT_TRIGGER",
      });
      assert.equal(r.status, 0); // still the clean skip exit
      assert.doesNotMatch(r.stdout, /^pace-gate$/m);
    } finally {
      srv.close();
    }
  });
});
