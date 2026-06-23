/**
 * Regression tests for the subagent-dispatch REGISTRATION trigger (issue #2406).
 *
 * Root cause this guards against: the #692 `SessionStart` hook
 * (`scripts/hooks/session-start-capture.sh`) structurally cannot fire for
 * Agent-tool subagent dispatches (it's a top-level-session event), so
 * `hydra:dispatches:subagent:*` was empty and the live in-flight view was
 * blind. The fix is a NEW TRIGGER (not new storage): the PostToolUse hook
 * (`scripts/autopilot/hooks/on-subagent-tool-call.sh`) — the only event that
 * fires INSIDE an Agent-tool child — now ALSO scrapes the
 * `<!-- hydra-dispatch v1 ... -->` sentinel from the child's own transcript and
 * POSTs the unchanged `/api/dispatches/subagent` body.
 *
 * Two surfaces are pinned here, in two independent top-level suites (each owns
 * its own lifecycle per the CLAUDE.md "new top-level describe" + "beforeEach"
 * authoring rules — no piggy-backing on a sibling's Redis teardown):
 *
 *   A. The hook script itself (black-box, against a stub HTTP capture server so
 *      it never depends on the running orchestrator service):
 *        1. sentinel-bearing transcript → POSTs a well-formed registration body
 *        2. no sentinel (interactive operator session) → never POSTs
 *        3. API unreachable → exits 0, never propagates an error to the parent
 *        4. once-per-session marker → re-fire on a 2nd tool call does NOT re-POST
 *        5. shared sentinel grammar helper is sourceable + exposes its functions
 *
 *   B. The read-only consumers (`listActiveSubagentDispatches` →
 *      `deriveInflightSlotSeed`): given a populated registry, the in-flight slot
 *      seed is non-empty for a pipeline-class skill. These consumers are
 *      UNCHANGED by #2406 — this asserts the acceptance criterion that flows
 *      THROUGH them once the trigger populates the registry.
 */

import test, { describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  existsSync,
  statSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Redis from "ioredis";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const HOOK = join(REPO_ROOT, "scripts", "autopilot", "hooks", "on-subagent-tool-call.sh");
const HELPER = join(REPO_ROOT, "scripts", "hooks", "extract-dispatch-sentinel.sh");

const SENTINEL =
  "<!-- hydra-dispatch v1 skill=hydra-dev dispatchId=worktree-agent-deadbeefcafe-t1-dev_orch runId=run-2406 -->";

function writeTranscript(dir: string, sessionId: string, firstUserText: string): string {
  const path = join(dir, `${sessionId}.jsonl`);
  const lines = [
    JSON.stringify({ type: "user", message: { role: "user", content: firstUserText } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: "ok" } }),
  ].join("\n");
  writeFileSync(path, lines + "\n");
  return path;
}

/**
 * A throwaway HTTP capture server for POSTs to /api/dispatches/subagent, so the
 * hook test never depends on the live orchestrator service.
 *
 * It runs in a SEPARATE Node process (not in-process): the hook is invoked via
 * the synchronous `spawnSync`, which blocks the test's own event loop — an
 * in-process server could never accept+respond to curl during that window, so
 * `curl -fsS` would time out and the hook would (correctly) treat the POST as
 * failed. A separate process keeps responding regardless of what the test
 * thread is doing. Each captured POST body is appended as a JSON line to a
 * capture file the test reads back synchronously.
 */
const CAPTURE_SERVER_SRC = `
const http = require("node:http");
const fs = require("node:fs");
// node -e SRC <captureFile> → argv is [execPath, captureFile]
const captureFile = process.argv[1];
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (req.method === "POST" && (req.url || "").startsWith("/api/dispatches/subagent")) {
      fs.appendFileSync(captureFile, raw.replace(/\\n/g, " ") + "\\n");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ registered: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write("PORT=" + server.address().port + "\\n");
});
`;

interface CaptureServer {
  url: string;
  /** Synchronously read all captured POST bodies (parsed). */
  readBodies: () => any[];
  /** Resolves once at least `n` bodies have been captured (rejects after 5s). */
  waitForBodies: (n: number) => Promise<void>;
  close: () => void;
}

function startCaptureServer(dir: string): Promise<CaptureServer> {
  const captureFile = join(dir, "captured-posts.jsonl");
  writeFileSync(captureFile, "");
  const readBodies = (): any[] => {
    let raw = "";
    try {
      raw = readFileSync(captureFile, "utf-8");
    } catch {
      return [];
    }
    return raw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return { _unparseable: l };
        }
      });
  };

  return new Promise((resolveFn, rejectFn) => {
    const child: ChildProcess = spawn(process.execPath, ["-e", CAPTURE_SERVER_SRC, captureFile], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const t = setTimeout(() => {
      child.kill();
      rejectFn(new Error("capture server did not report a port within 5s"));
    }, 5000);
    let out = "";
    child.stdout!.on("data", (chunk) => {
      out += chunk.toString();
      const m = out.match(/PORT=(\d+)/);
      if (m) {
        clearTimeout(t);
        resolveFn({
          url: `http://127.0.0.1:${m[1]}`,
          readBodies,
          waitForBodies: (n: number) =>
            new Promise<void>((res2, rej2) => {
              const deadline = Date.now() + 5000;
              const tick = () => {
                if (readBodies().length >= n) return res2();
                if (Date.now() > deadline) {
                  return rej2(
                    new Error(`timed out waiting for ${n} POST(s); got ${readBodies().length}`),
                  );
                }
                setTimeout(tick, 25);
              };
              tick();
            }),
          close: () => child.kill(),
        });
      }
    });
    child.on("error", (err) => {
      clearTimeout(t);
      rejectFn(err);
    });
  });
}

function runHook(
  payload: object,
  opts: { apiBase: string; markerDir: string; stream: string },
): { status: number | null; stderr: string } {
  const r = spawnSync(HOOK, [], {
    input: JSON.stringify(payload),
    env: {
      ...process.env,
      HYDRA_API_BASE: opts.apiBase,
      HYDRA_DISPATCH_REGISTER_MARKER_DIR: opts.markerDir,
      HYDRA_AUTOPILOT_SLOT_EVENTS_STREAM: opts.stream,
      // Point the slot-event XADD at an unreachable Redis so the slot-event
      // side is a harmless no-op — we're exercising the registration side, and
      // the hook must still register even when the slot-event XADD fails.
      HYDRA_REDIS_HOST: "127.0.0.1",
      HYDRA_REDIS_PORT: "1",
    },
    encoding: "utf-8",
  });
  return { status: r.status, stderr: r.stderr ?? "" };
}

// ===========================================================================
// Suite A — the hook script (black-box against a stub capture server)
// ===========================================================================
describe("on-subagent-tool-call.sh — subagent-dispatch registration (#2406)", () => {
  let workdir: string;
  let markerDir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "hydra-2406-wd-"));
    markerDir = mkdtempSync(join(tmpdir(), "hydra-2406-marker-"));
  });

  after(() => {
    // Best-effort cleanup of the per-test temp roots created in beforeEach.
    try {
      rmSync(workdir, { recursive: true, force: true });
      rmSync(markerDir, { recursive: true, force: true });
    } catch {
      /* intentional: temp-dir cleanup is best-effort */
    }
  });

  test("sentinel-bearing transcript → POSTs a well-formed registration body", async () => {
    const srv = await startCaptureServer(workdir);
    try {
      const sessionId = "sess-2406-ok";
      const transcript = writeTranscript(workdir, sessionId, `${SENTINEL}\nDo the thing`);
      const r = runHook(
        {
          tool_name: "Read",
          session_id: sessionId,
          transcript_path: transcript,
          cwd: workdir,
          tool_input: { file_path: "/tmp/x" },
          task: { description: "dev_orch — work", subagent_type: "hydra-dev" },
        },
        { apiBase: srv.url, markerDir, stream: "hydra:autopilot:slot-events:test-2406-ok" },
      );
      assert.equal(r.status, 0, `hook exited ${r.status}: ${r.stderr}`);
      await srv.waitForBodies(1);
      const bodies = srv.readBodies();
      assert.equal(bodies.length, 1, "expected exactly one registration POST");
      const body = bodies[0];
      assert.equal(body.sessionId, sessionId);
      assert.equal(body.skill, "hydra-dev");
      assert.equal(body.dispatchId, "worktree-agent-deadbeefcafe-t1-dev_orch");
      assert.equal(body.runId, "run-2406");
      assert.equal(body.projectDir, workdir);
      assert.ok(typeof body.startedAt === "string" && body.startedAt.length > 0);
    } finally {
      srv.close();
    }
  });

  test("no sentinel (interactive operator session) → never POSTs", async () => {
    const srv = await startCaptureServer(workdir);
    try {
      const sessionId = "sess-2406-nosentinel";
      const transcript = writeTranscript(workdir, sessionId, "just a normal operator message");
      const r = runHook(
        {
          tool_name: "Read",
          session_id: sessionId,
          transcript_path: transcript,
          cwd: workdir,
          tool_input: { file_path: "/tmp/x" },
          task: { description: "operator session" },
        },
        { apiBase: srv.url, markerDir, stream: "hydra:autopilot:slot-events:test-2406-nos" },
      );
      assert.equal(r.status, 0);
      // Settle so a (mistaken) POST would have time to surface before we assert 0.
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(srv.readBodies().length, 0, "must NOT register a session that carries no sentinel");
    } finally {
      srv.close();
    }
  });

  test("API unreachable → exits 0, never propagates an error to the parent", () => {
    const sessionId = "sess-2406-apidown";
    const transcript = writeTranscript(workdir, sessionId, `${SENTINEL}\nwork`);
    // Port 1 is unreachable — the POST must fail, but the hook MUST exit 0.
    const r = runHook(
      {
        tool_name: "Read",
        session_id: sessionId,
        transcript_path: transcript,
        cwd: workdir,
        tool_input: { file_path: "/tmp/x" },
        task: { description: "dev_orch — work", subagent_type: "hydra-dev" },
      },
      { apiBase: "http://127.0.0.1:1", markerDir, stream: "hydra:autopilot:slot-events:test-2406-down" },
    );
    assert.equal(r.status, 0, "hook MUST exit 0 even when the registry API is unreachable");
  });

  test("once-per-session marker → a 2nd tool call does NOT re-POST", async () => {
    const srv = await startCaptureServer(workdir);
    try {
      const sessionId = "sess-2406-idem";
      const transcript = writeTranscript(workdir, sessionId, `${SENTINEL}\nwork`);
      const payload = {
        tool_name: "Read",
        session_id: sessionId,
        transcript_path: transcript,
        cwd: workdir,
        tool_input: { file_path: "/tmp/x" },
        task: { description: "dev_orch — work", subagent_type: "hydra-dev" },
      };
      const opts = {
        apiBase: srv.url,
        markerDir,
        stream: "hydra:autopilot:slot-events:test-2406-idem",
      };
      const r1 = runHook(payload, opts);
      await srv.waitForBodies(1); // first call registers + drops the marker
      const r2 = runHook(payload, opts);
      assert.equal(r1.status, 0);
      assert.equal(r2.status, 0);
      // Give a beat to surface any (incorrect) 2nd POST.
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(
        srv.readBodies().length,
        1,
        "the once-per-session marker must suppress the 2nd POST for the same session",
      );
    } finally {
      srv.close();
    }
  });

  test("shared sentinel helper is sourceable + exposes its three functions", () => {
    assert.ok(existsSync(HELPER), "extract-dispatch-sentinel.sh missing");
    // Source the helper, then probe each function in a bash subshell.
    const probe = `
      set -euo pipefail
      . "${HELPER}"
      type extract_first_user_text >/dev/null
      type extract_sentinel_line >/dev/null
      type extract_sentinel_field >/dev/null
      line="$(extract_sentinel_line '${SENTINEL}')"
      [ -n "$line" ] || { echo "no sentinel line" >&2; exit 1; }
      printf 'skill=%s dispatchId=%s runId=%s\n' \
        "$(extract_sentinel_field "$line" skill)" \
        "$(extract_sentinel_field "$line" dispatchId)" \
        "$(extract_sentinel_field "$line" runId)"
    `;
    const r = spawnSync("bash", ["-c", probe], { encoding: "utf-8" });
    assert.equal(r.status, 0, `helper probe failed: ${r.stderr}`);
    assert.match(r.stdout, /skill=hydra-dev/);
    assert.match(r.stdout, /dispatchId=worktree-agent-deadbeefcafe-t1-dev_orch/);
    assert.match(r.stdout, /runId=run-2406/);
  });

  test("hook script + helper have a bash shebang; hook is executable", () => {
    assert.ok((statSync(HOOK).mode & 0o100) !== 0, "hook must be executable");
    assert.match(readFileSync(HOOK, "utf-8").split("\n")[0], /^#!.*bash/);
    assert.match(readFileSync(HELPER, "utf-8").split("\n")[0], /^#!.*bash/);
  });
});

// ===========================================================================
// Suite B — read-only consumers over a populated registry (#2406 acceptance)
// ===========================================================================
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

const { registerSubagentDispatch, listActiveSubagentDispatches } = await import(
  "../src/redis/dispatches.ts"
);
const { deriveInflightSlotSeed } = await import("../src/autopilot/run-projections.ts");

describe("populated registry → in-flight slot seed is non-empty (#2406 acceptance)", () => {
  let redis: any;

  async function cleanKeys() {
    if (!redis) redis = new Redis(process.env.REDIS_URL);
    const keys = await redis.keys("hydra:dispatches:subagent:*");
    if (keys.length > 0) await redis.del(...keys);
  }

  beforeEach(async () => {
    await cleanKeys();
  });

  after(async () => {
    await cleanKeys();
    if (redis) redis.disconnect();
  });

  test("listActiveSubagentDispatches returns the row, deriveInflightSlotSeed seeds dev_orch", async () => {
    await registerSubagentDispatch({
      sessionId: "sess-2406-consumer",
      skill: "hydra-dev",
      dispatchId: "worktree-agent-feed-t1-dev_orch",
      startedAt: "2026-06-23T10:00:00.000Z",
      runId: "run-2406-consumer",
    });

    const dispatches = await listActiveSubagentDispatches();
    const mine = dispatches.find((d) => d.sessionId === "sess-2406-consumer");
    assert.ok(mine, "the registered row must come back from listActiveSubagentDispatches");
    assert.equal(mine.skill, "hydra-dev");

    const seed = deriveInflightSlotSeed(dispatches);
    assert.ok(seed.dev_orch, "dev_orch (the hydra-dev pipeline class) must be seeded");
    assert.equal(seed.dev_orch.skill, "hydra-dev");
    assert.equal(seed.dev_orch.task_id, "worktree-agent-feed-t1-dev_orch");
    assert.equal(seed.dev_orch._source, "inflight-seed");
  });
});
