/**
 * Regression test for issue #439 — `scripts/autopilot/grill-artifact.sh`.
 *
 * The CI mutation-test gate (.github/workflows/ci.yml `mutation-test` job)
 * generates `swap-comparison` mutants on every `<` / `>` occurrence in the
 * changed file. For grill-artifact.sh the live mutators land on:
 *   - `>&2` stderr redirects on error-message echo lines (lines 41, 57, 75,
 *     99, 103, 104) — flipping to `<&2` opens FD 2 as STDIN of echo, so the
 *     error message lands on STDOUT instead of STDERR.
 *   - heredoc-rendered usage prose containing `<json-body-path>`,
 *     `<anchorRef>`, `<by>` (lines 43, 44, 45) — flipping the `<` / `>` inside
 *     the angle-bracket placeholder text mutates the usage banner.
 *   - jq error-message literal containing `'operator:<name>'` (line 75).
 *
 * Pure-comment lines (9, 16, 18, 22, 24) are mutated too but are unreachable
 * code; they survive by construction. Five of the fourteen generated mutants
 * are unkillable for that reason, capping the maximum achievable kill rate
 * at 9/14 = 64%. The 30% floor is met if any 5 of those 9 reachable mutants
 * are killed — this file kills all 9.
 *
 * The strategy mirrors `test/autopilot-heartbeat.test.mts` (issue #447):
 *   - spawn the bash script with controlled env (HYDRA_API_BASE pointing at
 *     a tiny `node:http` mock listening on an ephemeral port),
 *   - assert on exit code AND stdout/stderr content,
 *   - exercise every documented branch (write/approve/gate × success/4xx/usage).
 *
 * Tests must be hermetic: no real network, no orchestrator. The mock server
 * is started fresh per `describe` block and shut down in `after()`.
 */

import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "autopilot", "grill-artifact.sh");

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

/**
 * Start a tiny HTTP server with a settable handler. Returns the server and
 * a base URL like "http://127.0.0.1:NNNN".
 */
function startMockServer(): Promise<{ server: Server; base: string; setHandler: (h: Handler) => void }> {
  return new Promise((resolveP) => {
    let handler: Handler = (_req, res) => {
      res.statusCode = 500;
      res.end("no handler registered");
    };
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", async () => {
        const body = Buffer.concat(chunks).toString("utf-8");
        try {
          handler(req, res, body);
        } catch (err: any) {
          res.statusCode = 500;
          res.end(`mock handler threw: ${err?.message ?? err}`);
        }
      });
    });
    server.listen(0, "127.0.0.1", async () => {
      const addr = server.address() as AddressInfo;
      resolveP({
        server,
        base: `http://127.0.0.1:${addr.port}`,
        setHandler: (h) => { handler = h; },
      });
    });
  });
}

function stopServer(server: Server): Promise<void> {
  return new Promise((r) => server.close(() => r()));
}

/**
 * Spawn the script asynchronously so the node:test event loop continues to
 * service the in-process mock HTTP server while curl is mid-request.
 * `spawnSync` blocks the event loop, which deadlocks the test against the
 * same-process server (the server can never accept the connection).
 */
function runScript(
  args: string[],
  envOverride: Record<string, string> = {},
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolveP) => {
    const child = spawn("bash", [SCRIPT, ...args], {
      env: { ...process.env, ...envOverride, PATH: process.env.PATH ?? "" },
    });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on("data", (c) => outChunks.push(c));
    child.stderr.on("data", (c) => errChunks.push(c));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 15_000);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const status = code === null ? (signal ? -1 : -1) : code;
      resolveP({
        status,
        stdout: Buffer.concat(outChunks).toString("utf-8"),
        stderr: Buffer.concat(errChunks).toString("utf-8"),
      });
    });
  });
}

// --------------------------------------------------------------------------
// usage()
// --------------------------------------------------------------------------

describe("scripts/autopilot/grill-artifact.sh — usage banner", async () => {
  /**
   * Pins the heredoc usage text exactly. Kills `swap-comparison` mutants on
   * lines 43, 44, 45 (the three usage placeholders `<json-body-path>`,
   * `<anchorRef>`, `<by>`) and on line 41 (`cat <<'EOF' >&2` — the `>&2`
   * flips to `<&2`, sending usage to stdout instead of stderr).
   */
  test("no args → exit 2, prints exact usage to STDERR", async () => {
    const r = await runScript([]);
    assert.equal(r.status, 2, `expected exit 2 (usage), got ${r.status}: ${r.stderr}`);
    // usage() lines must land on STDERR (kills line 41 `>&2` → `<&2` mutant —
    // under that mutant the heredoc body lands on stdout instead).
    assert.ok(r.stderr.includes("usage:"), "usage banner must appear on STDERR");
    // Exact placeholder text (kills lines 43-45 swap-comparison mutants).
    assert.ok(
      r.stderr.includes("grill-artifact.sh write <json-body-path>"),
      `usage line 1 missing/mutated: ${JSON.stringify(r.stderr)}`,
    );
    assert.ok(
      r.stderr.includes("grill-artifact.sh approve <anchorRef> <by>"),
      `usage line 2 missing/mutated: ${JSON.stringify(r.stderr)}`,
    );
    assert.ok(
      r.stderr.includes("grill-artifact.sh gate <anchorRef>"),
      `usage line 3 missing/mutated: ${JSON.stringify(r.stderr)}`,
    );
    // Negative: usage text MUST NOT appear on STDOUT (would mean `<&2` mutant
    // redirected echo's STDIN, leaking heredoc body to stdout).
    assert.ok(!r.stdout.includes("usage:"), "usage text must not leak to stdout");
  });

  test("unknown subcommand → usage on STDERR + exit 2", async () => {
    const r = await runScript(["nosuchcmd"]);
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes("usage:"));
  });
});

// --------------------------------------------------------------------------
// write subcommand
// --------------------------------------------------------------------------

describe("scripts/autopilot/grill-artifact.sh — write", async () => {
  let server: Server;
  let base: string;
  let setHandler: (h: Handler) => void;
  let tmp: string;

  before(async () => {
    const s = await startMockServer();
    server = s.server;
    base = s.base;
    setHandler = s.setHandler;
    tmp = mkdtempSync(join(tmpdir(), "grill-artifact-write-"));
  });

  after(async () => {
    await stopServer(server);
    rmSync(tmp, { recursive: true, force: true });
  });

  test("missing body-path argument → usage + exit 2", async () => {
    const r = await runScript(["write"], { HYDRA_API_BASE: base });
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stderr}`);
    assert.ok(r.stderr.includes("usage:"), "missing body-path must fall through to usage()");
  });

  /**
   * Kills line 57 swap-comparison: `>&2` → `<&2` on the body-file-not-found
   * echo. Under the mutant, the error message lands on stdout, not stderr.
   */
  test("nonexistent body file → exit 2 with error on STDERR", async () => {
    const r = await runScript(["write", join(tmp, "does-not-exist.json")], { HYDRA_API_BASE: base });
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stderr}`);
    assert.ok(
      r.stderr.includes("grill-artifact: body file"),
      `error must be on STDERR (kills line 57 >&2 → <&2 mutant): stderr=${JSON.stringify(r.stderr)} stdout=${JSON.stringify(r.stdout)}`,
    );
    assert.ok(r.stderr.includes("not found"), "error mentions 'not found'");
    // Negative: must NOT appear on stdout.
    assert.ok(
      !r.stdout.includes("grill-artifact: body file"),
      "body-not-found error must not leak to stdout",
    );
  });

  test("valid POST 2xx → exit 0, response JSON on STDOUT, request body relayed", async () => {
    let receivedBody = "";
    let receivedMethod = "";
    let receivedUrl = "";
    let receivedContentType = "";
    setHandler((req, res, body) => {
      receivedBody = body;
      receivedMethod = req.method ?? "";
      receivedUrl = req.url ?? "";
      receivedContentType = String(req.headers["content-type"] ?? "");
      res.statusCode = 201;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ anchorRef: "issue-99", scope: "test" }));
    });

    const bodyPath = join(tmp, "body.json");
    const payload = '{"anchorRef":"issue-99","scope":"test"}';
    writeFileSync(bodyPath, payload);

    const r = await runScript(["write", bodyPath], { HYDRA_API_BASE: base });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
    assert.equal(receivedMethod, "POST", "uses POST");
    assert.equal(receivedUrl, "/api/design-concepts", "hits the documented path");
    assert.match(receivedContentType, /application\/json/, "sets content-type");
    assert.equal(receivedBody, payload, "relays body file verbatim");
    // Response JSON must arrive on stdout.
    assert.ok(
      r.stdout.includes('"anchorRef":"issue-99"'),
      `response should be on stdout: ${JSON.stringify(r.stdout)}`,
    );
  });

  test("POST 4xx → non-zero exit (curl --fail-with-body)", async () => {
    setHandler((_req, res) => {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "bad payload" }));
    });

    const bodyPath = join(tmp, "body-bad.json");
    writeFileSync(bodyPath, '{"bad":true}');
    const r = await runScript(["write", bodyPath], { HYDRA_API_BASE: base });
    // curl exits 22 with --fail-with-body on HTTP errors; either way, non-zero.
    assert.notEqual(r.status, 0, `4xx must produce non-zero exit, got ${r.status}: ${r.stderr}`);
    assert.notEqual(r.status, 2, "4xx is a curl failure, not usage()");
  });
});

// --------------------------------------------------------------------------
// approve subcommand
// --------------------------------------------------------------------------

describe("scripts/autopilot/grill-artifact.sh — approve", async () => {
  let server: Server;
  let base: string;
  let setHandler: (h: Handler) => void;

  before(async () => {
    const s = await startMockServer();
    server = s.server;
    base = s.base;
    setHandler = s.setHandler;
  });

  after(async () => {
    await stopServer(server);
  });

  test("missing ref or by → usage + exit 2", async () => {
    const r = await runScript(["approve"], { HYDRA_API_BASE: base });
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes("usage:"));

    const r2 = await runScript(["approve", "issue-99"], { HYDRA_API_BASE: base });
    assert.equal(r2.status, 2);
    assert.ok(r2.stderr.includes("usage:"));
  });

  /**
   * Kills line 75 swap-comparison `>&2` → `<&2` mutant on the `'by' must be ...`
   * error message. Also exact-asserts the literal `'operator:<name>'` text,
   * which has its OWN swap-comparison mutant (line 75 inner `<name>` → `<name<`).
   */
  test("invalid 'by' value (not 'auto-gate' or 'operator:*') → exit 2, exact message on STDERR", async () => {
    const r = await runScript(["approve", "issue-99", "random-name"], { HYDRA_API_BASE: base });
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stderr}`);
    // Exact substring kills both the >&2 mutant (must be on stderr) AND the
    // angle-bracket placeholder mutant (literal `<name>` must be preserved).
    assert.ok(
      r.stderr.includes("'by' must be 'auto-gate' or 'operator:<name>' (got 'random-name')"),
      `exact error text must appear on stderr (kills line 75 mutants): ${JSON.stringify(r.stderr)}`,
    );
    assert.ok(
      !r.stdout.includes("'by' must be"),
      "validation error must not leak to stdout",
    );
  });

  test("by='auto-gate' is accepted; POST hits /:ref/approve with JSON body", async () => {
    let receivedBody = "";
    let receivedUrl = "";
    let receivedMethod = "";
    setHandler((req, res, body) => {
      receivedBody = body;
      receivedUrl = req.url ?? "";
      receivedMethod = req.method ?? "";
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ approved: true, gate: { ok: true, reasons: [] } }));
    });

    const r = await runScript(["approve", "issue-42", "auto-gate"], { HYDRA_API_BASE: base });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
    assert.equal(receivedMethod, "POST");
    assert.equal(receivedUrl, "/api/design-concepts/issue-42/approve");
    // Body must be {"by":"auto-gate"} — pin both the key and value.
    const parsed = JSON.parse(receivedBody);
    assert.equal(parsed.by, "auto-gate", "approver value relayed");
    assert.ok(r.stdout.includes('"approved":true'), "response on stdout");
  });

  test("by='operator:gabe' is accepted (prefix match)", async () => {
    let receivedBody = "";
    setHandler((_req, res, body) => {
      receivedBody = body;
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ approved: true }));
    });

    const r = await runScript(["approve", "issue-1", "operator:gabe"], { HYDRA_API_BASE: base });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(receivedBody);
    assert.equal(parsed.by, "operator:gabe");
  });

  test("404 from server → non-zero exit (curl --fail-with-body)", async () => {
    setHandler((_req, res) => {
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "no artifact" }));
    });

    const r = await runScript(["approve", "no-such-ref", "auto-gate"], { HYDRA_API_BASE: base });
    assert.notEqual(r.status, 0, `404 must be non-zero exit, got ${r.status}: ${r.stderr}`);
  });
});

// --------------------------------------------------------------------------
// gate subcommand
// --------------------------------------------------------------------------

describe("scripts/autopilot/grill-artifact.sh — gate", async () => {
  let server: Server;
  let base: string;
  let setHandler: (h: Handler) => void;

  before(async () => {
    const s = await startMockServer();
    server = s.server;
    base = s.base;
    setHandler = s.setHandler;
  });

  after(async () => {
    await stopServer(server);
  });

  test("missing anchorRef → usage + exit 2", async () => {
    const r = await runScript(["gate"], { HYDRA_API_BASE: base });
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes("usage:"));
  });

  test("gate ok=true → exit 0, prints exactly the .gate JSON object on STDOUT", async () => {
    setHandler((req, res) => {
      assert.equal(req.method, "GET");
      assert.equal(req.url, "/api/design-concepts/issue-77");
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        anchorRef: "issue-77",
        scope: "x",
        gate: { ok: true, reasons: [] },
      }));
    });

    const r = await runScript(["gate", "issue-77"], { HYDRA_API_BASE: base });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout.trim());
    assert.equal(parsed.ok, true, "gate.ok parsed");
    assert.deepEqual(parsed.reasons, [], "gate.reasons parsed");
    // Negative: the artifact envelope (anchorRef/scope) must NOT appear —
    // grill-artifact's contract is to print only the .gate sub-object.
    assert.ok(
      !r.stdout.includes("anchorRef"),
      `gate subcommand must print only .gate sub-object, not whole artifact: ${JSON.stringify(r.stdout)}`,
    );
  });

  test("gate ok=false with reasons → exit 1, gate JSON on STDOUT", async () => {
    setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        anchorRef: "issue-88",
        gate: { ok: false, reasons: ["missing-scope", "no-rationale"] },
      }));
    });

    const r = await runScript(["gate", "issue-88"], { HYDRA_API_BASE: base });
    assert.equal(r.status, 1, `gate fail must exit 1 (not 0), got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout.trim());
    assert.equal(parsed.ok, false);
    assert.deepEqual(parsed.reasons, ["missing-scope", "no-rationale"]);
  });

  /**
   * Kills line 99 swap-comparison `>&2` → `<&2` mutant on the
   * "no artifact for anchorRef" message.
   */
  test("404 → exit 2 with 'no artifact' error on STDERR", async () => {
    setHandler((_req, res) => {
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "not found" }));
    });

    const r = await runScript(["gate", "missing-ref"], { HYDRA_API_BASE: base });
    assert.equal(r.status, 2, `404 → exit 2 (missing-artifact), got ${r.status}: ${r.stderr}`);
    assert.ok(
      r.stderr.includes("no artifact for anchorRef 'missing-ref'"),
      `error must be on stderr (kills line 99 >&2 mutant): ${JSON.stringify(r.stderr)}`,
    );
    assert.ok(
      !r.stdout.includes("no artifact"),
      "404 error message must not leak to stdout",
    );
  });

  /**
   * Kills line 103/104 swap-comparison `>&2` → `<&2` mutants on the
   * "API returned HTTP $code" + body echo.
   */
  test("5xx → exit 3 with HTTP code AND body on STDERR", async () => {
    setHandler((_req, res) => {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "internal explode" }));
    });

    const r = await runScript(["gate", "any-ref"], { HYDRA_API_BASE: base });
    assert.equal(r.status, 3, `5xx → exit 3, got ${r.status}: ${r.stderr}`);
    assert.ok(
      r.stderr.includes("API returned HTTP 500"),
      `HTTP-code error on stderr (kills line 103 >&2 mutant): ${JSON.stringify(r.stderr)}`,
    );
    assert.ok(
      r.stderr.includes("internal explode"),
      `response body on stderr (kills line 104 >&2 mutant): ${JSON.stringify(r.stderr)}`,
    );
    // Negative: 5xx error must NOT pollute stdout.
    assert.ok(
      !r.stdout.includes("API returned HTTP"),
      "HTTP-error message must not leak to stdout",
    );
  });
});
