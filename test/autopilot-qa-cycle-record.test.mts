/**
 * Regression test for issue #4730 — a reaped `qa_orch` (skill `hydra-qa`)
 * dispatch is recorded in the cycle-derived ledgers.
 *
 * Before #4730, reap.py's `CYCLE_RECORD_SKILLS` was
 * `{hydra-dev, hydra-target-build, hydra-grill}`, so a hydra-qa completion
 * short-circuited at `_fire_cycle_record`'s gate: no cycle-record POST, hence
 * no durable dispatch-outcome record (#2942), hence qa_orch sat in
 * `coverage.classesNotRecorded` and the class scoreboard read it as
 * `insufficient-sample`. "Tokens per review" had to be hand-derived.
 *
 * These tests drive the REAL `reap.py completion` → `dispatch.sh cycle-record`
 * chain against an in-process capture server (no live orchestrator, no Redis
 * writes), then feed the captured POST body — validated through the same
 * `CycleRecordBodySchema` the live route uses — into
 * `writeDispatchOutcomeRecord` with fake deps, asserting the resulting durable
 * record carries `className=qa_orch`, the anchor ref and non-null tokens.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";

import { CycleRecordBodySchema } from "../src/autopilot/schemas.ts";
import {
  writeDispatchOutcomeRecord,
  type OutcomeRecordDeps,
} from "../src/autopilot/outcome-record.ts";
import type { DispatchOutcomeRecord } from "../src/redis/dispatch-outcomes.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const REAP = join(REPO_ROOT, "scripts", "autopilot", "reap.py");

interface Paths {
  dir: string;
  state: string;
  log: string;
}

function makeTmp(): Paths {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-qa-cycle-record-"));
  return { dir, state: join(dir, "state.json"), log: join(dir, "nightly.log") };
}

function writeState(path: string, slots: Record<string, unknown>): void {
  writeFileSync(
    path,
    JSON.stringify({
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
      slots,
      signal_last_fired: {},
      failure_log: [],
    }),
  );
}

/** One-shot server capturing the first `/autopilot/cycle-record` POST body. */
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
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
      if (req.method !== "POST") return;
      // Match ONLY the cycle-record write — the per-cycle token POST and the
      // cost-join POST also fire on every completion.
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
  return { origin: `http://127.0.0.1:${port}`, bodyPromise, close: () => server.close() };
}

/**
 * Async `spawn` (never `spawnSync`, issue #4503): the capture server lives in
 * this event loop, so a blocking spawn would starve it and every reap POST
 * would hang until its client-side timeout.
 */
function runCompletion(
  args: string[],
  paths: Paths,
  apiBase: string,
): Promise<{ status: number; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("python3", [REAP, "completion", ...args], {
      env: {
        ...process.env,
        HYDRA_API_BASE: apiBase,
        HYDRA_BASE_URL: apiBase,
        HYDRA_API: `${apiBase}/api`,
        HYDRA_AUTOPILOT_STATE: paths.state,
        HYDRA_AUTOPILOT_LOG: paths.log,
        HYDRA_AUTOPILOT_REFL_DIR: paths.dir,
        HYDRA_REAP_WORKTREE_GC: "0",
        // Keep the branch-recovery HGET off `docker exec` (live Redis).
        HYDRA_AUTOPILOT_REDIS_CLI: "true",
        // Any gh call reap makes must never reach the real repo.
        HYDRA_AUTOPILOT_REPO: "hydra-test/nonexistent-fixture",
        GH_TOKEN: "invalid-test-token",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf-8").on("data", (d: string) => (stderr += d));
    child.on("error", rejectRun);
    child.on("close", (code) => resolveRun({ status: code ?? -1, stderr }));
  });
}

/** In-memory dispatch-outcome facade — no Redis. */
function fakeDeps(store: DispatchOutcomeRecord[]): OutcomeRecordDeps {
  return {
    dispatchOutcomes: {
      async put(record) {
        store.push(record);
        return { ok: true as const };
      },
      async upgrade() {
        return { ok: true as const };
      },
      async readCycleTokens() {
        return null;
      },
    },
    now: () => 1_800_000_000_000,
  };
}

describe("reap.py — hydra-qa completion is cycle-recorded (issue #4730)", () => {
  test("a reaped qa_orch dispatch yields a dispatch-outcome record with className=qa_orch, tokens and anchor ref", async () => {
    const tmp = makeTmp();
    const cap = await startCaptureServer();
    try {
      const taskId = "aQa4730deadbeef0";
      const branch = "worktree-agent-4730aaaa-t2-qa_orch";
      writeState(tmp.state, {
        qa_orch: {
          skill: "hydra-qa",
          started_epoch: Math.floor(Date.now() / 1000) - 120,
          task_id: taskId,
          anchor: "issue-4730",
          branch,
        },
      });

      const r = await runCompletion(["qa_orch", taskId, "185000", "hydra-qa"], tmp, cap.origin);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      // reap has exited, so any cycle-record POST has already been answered;
      // bound the wait so a gated-out (unrecorded) completion fails fast
      // instead of hanging the suite.
      const body = await Promise.race([
        cap.bodyPromise,
        new Promise<null>((res) => setTimeout(() => res(null), 1000)),
      ]);
      assert.ok(body, "a hydra-qa completion must fire a cycle-record POST");
      assert.equal(body!.cycleId, branch, "keyed on the synthesised worktree branch");
      assert.equal(body!.anchorType, "qa-review", "QA completions bucket to the qa-review lane");
      assert.equal(body!.anchorReference, "issue-4730");
      assert.equal(body!.tokens, 185000);

      // The live route validates through this schema before recordCycle runs.
      const parsed = CycleRecordBodySchema.safeParse(body);
      assert.ok(parsed.success, `the captured body must validate: ${JSON.stringify(parsed)}`);

      const store: DispatchOutcomeRecord[] = [];
      await writeDispatchOutcomeRecord(
        parsed.data!,
        String(body!.cycleId),
        String(body!.status),
        fakeDeps(store),
      );
      assert.equal(store.length, 1, "exactly one durable dispatch-outcome record");
      const rec = store[0];
      assert.equal(rec.className, "qa_orch");
      assert.equal(rec.skill, "hydra-qa");
      assert.equal(rec.anchorReference, "issue-4730");
      assert.equal(rec.tokens, 185000, "tokens are non-null when reap reported them");
      assert.equal(rec.outcome, "completed", "QA has no merged outcome — it records completed");
      assert.ok(rec.durationMs !== null && rec.durationMs > 0, "duration is recorded");
    } finally {
      cap.close();
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});
