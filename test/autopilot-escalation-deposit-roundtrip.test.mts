/**
 * Regression test for issue #3284 — the cascade-routing escalation-provenance
 * deposit WRITE→READ round-trip.
 *
 * Background (the 2nd QA bounce on PR #3293):
 *   The read side was complete — `scripts/autopilot/reap.py::_read_escalation_deposit`
 *   reads `${HYDRA_AUTOPILOT_REFL_DIR:-/tmp}/hydra-escalation-<task_id>`, forwards
 *   the blob as the 13th positional cycle-record arg, `dispatch.sh` parses it into
 *   `escalationAttempt`/`escalatedModel`, and `cycle-close.ts::recordCycle` threads
 *   them onto the durable `DispatchOutcomeRecord` (#2942). But NOTHING wrote the
 *   deposit, so `escalationAttempt`/`escalatedModel` were permanently null on every
 *   dispatch, and `/metrics/cascade-routing`'s cost-delta + postEscalationMergeRate
 *   (which filter on `escalationAttempt !== null`) were structurally 0 in production
 *   — not a timing lag but an un-closable gap.
 *
 * Fix (this PR):
 *   1. `scripts/reflection-deposit.sh` gains an `escalation` mode that the autopilot
 *      HARNESS invokes at escalation-dispatch time (task_id passed EXPLICITLY, since
 *      the harness is not inside the escalated worktree). It writes
 *      `hydra-escalation-<task_id>` = {"escalationAttempt":N,"escalatedModel":...,
 *      "priorAttemptStatus":...} only when the provenance is well-formed.
 *   2. `reap.py::_fire_cycle_record` now fires the cycle-record write even for a
 *      non-CYCLE_RECORD skill WHEN an escalation blob is present — the only class
 *      that cascade-escalates today is `cleanup_orch`/`hydra-cleanup`, a signal
 *      class outside CYCLE_RECORD_SKILLS, so without this the read blob would be
 *      re-dropped at the fire gate.
 *
 * These tests drive the REAL producer + reader end-to-end:
 *   (a) the writer (`reflection-deposit.sh escalation`) deposits the file, then
 *   (b) the reader (`reap.py completion` for a `cleanup_orch`/`hydra-cleanup`
 *       completion) forwards it through `dispatch.sh` into a captured cycle-record
 *       POST body — asserting `escalationAttempt`/`escalatedModel` land NON-NULL.
 *   The negative case (no deposit) asserts the fields are OMITTED (truthful null).
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const REAP = join(REPO_ROOT, "scripts", "autopilot", "reap.py");
const DEPOSIT = join(REPO_ROOT, "scripts", "reflection-deposit.sh");

interface Paths {
  dir: string;
  state: string;
  log: string;
}

function makeTmp(): Paths {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-escalation-"));
  return { dir, state: join(dir, "state.json"), log: join(dir, "nightly.log") };
}

function writeState(path: string, patch: Record<string, unknown>): void {
  const base: Record<string, unknown> = {
    started_epoch: Math.floor(Date.now() / 1000),
    limits: {
      token_budget: 2_000_000,
      subagent_max_tokens: 400_000,
      subagent_hard_max_tokens: 800_000,
    },
    cumulative_tokens: 0,
    dispatches: 0,
    idle_turns: 0,
    burned_classes: [],
    reaped_task_ids: [],
    slots: {},
    signal_last_fired: {},
    failure_log: [],
  };
  writeFileSync(path, JSON.stringify({ ...base, ...patch }));
}

/**
 * Start a one-shot capture server that records the first cycle-record POST body
 * it receives, then resolves. Returns the origin and a promise for the body.
 */
async function startCaptureServer(): Promise<{
  origin: string;
  bodyPromise: Promise<Record<string, unknown> | null>;
  close: () => void;
}> {
  let resolveBody!: (b: Record<string, unknown> | null) => void;
  const bodyPromise = new Promise<Record<string, unknown> | null>((r) => {
    resolveBody = r;
  });
  const server: Server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
      // Match ONLY the cycle-record write by its URL path — the per-cycle token
      // POST (`/api/metrics/tokens`, #2952) also fires on every completion and
      // ALSO carries a cycleId, so a body-shape filter alone would false-match it.
      if (!(req.url ?? "").includes("/autopilot/cycle-record")) return;
      try {
        resolveBody(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        /* intentional: a non-JSON body is not the cycle-record write */
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    bodyPromise,
    close: () => server.close(),
  };
}

function runCompletion(
  args: string[],
  paths: Paths,
  apiBase: string,
): { status: number; stderr: string } {
  const r = spawnSync("python3", [REAP, "completion", ...args], {
    env: {
      ...process.env,
      HYDRA_API_BASE: apiBase,
      HYDRA_BASE_URL: apiBase,
      HYDRA_API: `${apiBase}/api`,
      HYDRA_AUTOPILOT_STATE: paths.state,
      HYDRA_AUTOPILOT_LOG: paths.log,
      HYDRA_AUTOPILOT_REFL_DIR: paths.dir,
      HYDRA_REAP_WORKTREE_GC: "0",
    },
    encoding: "utf-8",
  });
  return { status: r.status ?? -1, stderr: r.stderr ?? "" };
}

describe("cascade-routing escalation deposit — write→read round-trip (issue #3284)", () => {
  test("the writer deposit → reap → dispatch.sh cycle-record POST carries NON-NULL escalationAttempt/escalatedModel", async () => {
    const tmp = makeTmp();
    const cap = await startCaptureServer();
    try {
      const taskId = "aEsc0123456789ab";

      // 1) WRITER — the harness deposits the escalation provenance for the
      //    EXPLICITLY-passed task_id (not derived from cwd).
      const w = spawnSync(
        "bash",
        [DEPOSIT, "escalation", "hydra-cleanup", taskId, "sonnet", "2", "no_op"],
        { env: { ...process.env, HYDRA_AUTOPILOT_REFL_DIR: tmp.dir }, encoding: "utf-8" },
      );
      assert.equal(w.status, 0, `writer must exit 0; stderr=${w.stderr}`);
      const deposited = readFileSync(
        join(tmp.dir, `hydra-escalation-${taskId}`),
        "utf-8",
      );
      assert.match(
        deposited,
        /"escalationAttempt":\s*2/,
        "the deposit file must carry escalationAttempt",
      );

      // 2) READER — a cascade-escalated `cleanup_orch` (skill hydra-cleanup, a
      //    SIGNAL class outside CYCLE_RECORD_SKILLS) completion. reap reads the
      //    deposit and forwards it on the cycle-record write.
      writeState(tmp.state, {
        slots: {
          cleanup_orch: {
            skill: "hydra-cleanup",
            started_epoch: Math.floor(Date.now() / 1000),
            task_id: taskId,
            attempt: 2,
          },
        },
      });

      const r = runCompletion(
        ["cleanup_orch", taskId, "5000", "hydra-cleanup"],
        tmp,
        cap.origin,
      );
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const body = await cap.bodyPromise;
      assert.ok(body, "a cycle-record POST must have been sent for the escalated cleanup completion");
      assert.equal(
        body!.escalationAttempt,
        2,
        "the round-tripped cycle-record body must carry the escalated attempt (NOT null)",
      );
      assert.equal(
        body!.escalatedModel,
        "sonnet",
        "the round-tripped cycle-record body must carry the escalated model (NOT null)",
      );
      assert.equal(body!.tokens, 5000, "the escalated attempt's ACTUAL tokens ride along (invariant 7)");
    } finally {
      cap.close();
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("no deposit → an escalation-less cleanup completion fires NO cycle-record (fields stay truthfully null)", async () => {
    const tmp = makeTmp();
    const cap = await startCaptureServer();
    let posted = false;
    cap.bodyPromise.then(() => {
      posted = true;
    });
    try {
      // No hydra-escalation-<task_id> deposit written.
      writeState(tmp.state, {
        slots: {
          cleanup_orch: {
            skill: "hydra-cleanup",
            started_epoch: Math.floor(Date.now() / 1000),
            task_id: "aNoEsc0123456789",
          },
        },
      });

      const r = runCompletion(
        ["cleanup_orch", "aNoEsc0123456789", "5000", "hydra-cleanup"],
        tmp,
        cap.origin,
      );
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      // Give any (erroneous) POST a moment to land before asserting absence.
      await new Promise((res) => setTimeout(res, 200));
      assert.equal(
        posted,
        false,
        "a non-escalated signal-class completion must NOT fire a cycle-record (hydra-cleanup is outside CYCLE_RECORD_SKILLS)",
      );
    } finally {
      cap.close();
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("the writer refuses to fabricate a marker on malformed provenance (non-positive attempt → no deposit)", () => {
    const tmp = makeTmp();
    try {
      const taskId = "aMalformed012345";
      const w = spawnSync(
        "bash",
        // attempt "0" is non-positive → nothing deposited.
        [DEPOSIT, "escalation", "hydra-cleanup", taskId, "sonnet", "0", "no_op"],
        { env: { ...process.env, HYDRA_AUTOPILOT_REFL_DIR: tmp.dir }, encoding: "utf-8" },
      );
      assert.equal(w.status, 0, "the writer is best-effort and always exits 0");
      assert.throws(
        () => readFileSync(join(tmp.dir, `hydra-escalation-${taskId}`), "utf-8"),
        "a non-positive attempt must deposit NOTHING (no fabricated escalation marker)",
      );
      assert.match(
        w.stderr,
        /escalation-deposit-malformed/,
        "the writer must FAIL-LOUD on malformed provenance",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});
