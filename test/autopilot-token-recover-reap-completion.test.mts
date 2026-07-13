/**
 * Regression test for issue #3250 — reap-time transcript token recovery.
 *
 * The autopilot's `cumulative_tokens` run field was permanently 0: the primary
 * reap path takes its count from the SubagentStop hook, which cannot carry the
 * subagent's token usage, so `run_completion` receives `total_tokens=0`. The fix
 * makes reap recover the REAL count from the completing dispatch's transcript by
 * calling `GET /api/metrics/session-tokens?session=<task_id>` (backed by the
 * `tokensForSession` transcript-scan seam) whenever the incoming count is
 * non-positive, then feeding the recovered value through the existing cumulative
 * increment + slot mirror + per-cycle token POST.
 *
 * These tests drive the real `reap.py completion` CLI against a LIVE stub HTTP
 * server (pinned via HYDRA_API_BASE) that answers the session-tokens route, so
 * we can assert the end-to-end recovery on the primary (0-token) path:
 *   - a 0-token completion whose transcript sums to N advances cumulative_tokens
 *     by N and logs `token_recovered ... tokens=N`;
 *   - a POSITIVE incoming count (the runaway/CLI path) is authoritative — the
 *     recovery route is NEVER consulted and the value is used verbatim;
 *   - an unresolvable session (route returns tokens:0) leaves cumulative at 0
 *     with NO `token_recovered` line (honest unknown, never a fabricated count);
 *   - the recovery runs once per task_id (a dup reap does not re-recover).
 */
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const REAP = join(REPO_ROOT, "scripts", "autopilot", "reap.py");

// The stub serves GET /api/metrics/session-tokens?session=<id> from this table.
// A session absent from the table answers tokens:0 (the unresolvable case). A
// hit here records that the recovery route WAS consulted for that session.
let tokensBySession: Record<string, number> = {};
let consultedSessions: string[] = [];
let server: Server;
let apiBase = "";

before(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url ?? "", "http://127.0.0.1");
    if (req.method === "GET" && u.pathname === "/api/metrics/session-tokens") {
      const session = u.searchParams.get("session") ?? "";
      consultedSessions.push(session);
      const tokens = tokensBySession[session] ?? 0;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ session, tokens }));
      return;
    }
    // Every other route (the token-record POST, cycle-record POST, …) 404s —
    // reap swallows those best-effort, matching the dead-port sibling test.
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  apiBase = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

interface Paths {
  dir: string;
  state: string;
  log: string;
}

function makeTmp(): Paths {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-reap-recover-"));
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
    slots: {
      dev_orch: null,
      qa_orch: null,
      research_orch: null,
      dev_target: null,
      qa_target: null,
      research_target: null,
    },
    signal_last_fired: {},
    failure_log: [],
  };
  writeFileSync(path, JSON.stringify({ ...base, ...patch }));
}

// Async spawn: the stub HTTP server runs in THIS process's event loop, so the
// reap subprocess must run non-blocking (spawnSync would deadlock — it blocks
// the loop the server needs to answer the recovery GET).
function runCompletion(args: string[], paths: Paths): Promise<{ status: number; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn("python3", [REAP, "completion", ...args], {
      env: {
        ...process.env,
        HYDRA_API_BASE: apiBase,
        HYDRA_BASE_URL: apiBase,
        HYDRA_AUTOPILOT_STATE: paths.state,
        HYDRA_AUTOPILOT_LOG: paths.log,
        HYDRA_REAP_WORKTREE_GC: "0",
      },
    });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", (code) => resolvePromise({ status: code ?? -1, stderr }));
  });
}

function readState(paths: Paths): Record<string, any> {
  return JSON.parse(readFileSync(paths.state, "utf-8"));
}

function runLog(paths: Paths): string {
  return existsSync(paths.log) ? readFileSync(paths.log, "utf-8") : "";
}

// A UUID-shaped session id — the route only sums UUID-shaped sessions, and the
// recovery passes task_id straight through as ?session=.
const SESSION_A = "38c78e5c-884f-47ae-acb4-5d48286776b3";
const SESSION_B = "aa11bb22-cc33-44dd-88ee-ff0011223344";

describe("reap.py completion → transcript token recovery (issue #3250)", () => {
  test("a 0-token completion recovers the transcript total into cumulative_tokens", async () => {
    tokensBySession = { [SESSION_A]: 54321 };
    consultedSessions = [];
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000),
            task_id: SESSION_A,
            anchor: "issue-3250",
          },
        },
      });

      // 0 tokens on the primary hook path → recovery kicks in.
      const r = await runCompletion(["dev_orch", SESSION_A, "0", "hydra-dev"], tmp);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const state = readState(tmp);
      assert.equal(
        state.cumulative_tokens,
        54321,
        "the recovered transcript total must be added to cumulative_tokens",
      );
      const log = runLog(tmp);
      assert.match(
        log,
        /token_recovered task_id=38c78e5c-884f-47ae-acb4-5d48286776b3 tokens=54321 source=transcript-scan/,
        "the recovery must be logged",
      );
      assert.match(
        log,
        /slot_complete .*tokens=54321 cumulative=54321/,
        "the slot_complete line carries the recovered count, not 0",
      );
      assert.deepEqual(
        consultedSessions,
        [SESSION_A],
        "the recovery route is consulted exactly once with the completing sessionId",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("a POSITIVE incoming count is authoritative — recovery is NOT consulted", async () => {
    tokensBySession = { [SESSION_A]: 999999 };
    consultedSessions = [];
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000),
            task_id: SESSION_A,
            anchor: "issue-3250",
          },
        },
      });

      // A real 12000-token count (e.g. the hard-cap CLI path) must be used verbatim.
      const r = await runCompletion(["dev_orch", SESSION_A, "12000", "hydra-dev"], tmp);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const state = readState(tmp);
      assert.equal(state.cumulative_tokens, 12000, "the authoritative count is used verbatim");
      assert.deepEqual(
        consultedSessions,
        [],
        "the recovery route must NOT be consulted when a positive count already exists",
      );
      const log = runLog(tmp);
      assert.doesNotMatch(log, /token_recovered/, "no recovery on a positive incoming count");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("an unresolvable session (route → tokens:0) leaves cumulative at 0, no recovery line", async () => {
    tokensBySession = {}; // SESSION_B is unknown to the stub → tokens:0
    consultedSessions = [];
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000),
            task_id: SESSION_B,
            anchor: "issue-3250",
          },
        },
      });

      const r = await runCompletion(["dev_orch", SESSION_B, "0", "hydra-dev"], tmp);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const state = readState(tmp);
      assert.equal(
        state.cumulative_tokens,
        0,
        "an unresolvable session must NOT fabricate a nonzero — cumulative stays 0",
      );
      const log = runLog(tmp);
      assert.doesNotMatch(log, /token_recovered/, "no recovery line when the route returns 0");
      assert.deepEqual(consultedSessions, [SESSION_B], "the route was still consulted once");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("a dup reap for the same task_id does NOT re-consult the recovery route", async () => {
    tokensBySession = { [SESSION_A]: 7777 };
    consultedSessions = [];
    const tmp = makeTmp();
    try {
      // Pre-seed the reaped ledger so this task_id is a dup on first invocation.
      writeState(tmp.state, {
        reaped_task_ids: [SESSION_A],
        cumulative_tokens: 7777, // already accounted for on the first reap
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000),
            task_id: SESSION_A,
            anchor: "issue-3250",
          },
        },
      });

      const r = await runCompletion(["dev_orch", SESSION_A, "0", "hydra-dev"], tmp);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const state = readState(tmp);
      assert.equal(state.cumulative_tokens, 7777, "a dup reap must not re-add the recovered count");
      const log = runLog(tmp);
      assert.match(log, /dup_skip task_id=38c78e5c/, "the dup-guard short-circuits");
      assert.deepEqual(
        consultedSessions,
        [],
        "a dup reap short-circuits before the recovery route is consulted",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});
