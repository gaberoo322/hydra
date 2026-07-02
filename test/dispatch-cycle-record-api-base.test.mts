/**
 * Regression test for issue #2635 —
 * `scripts/autopilot/dispatch.sh cycle-record` must honour HYDRA_API_BASE.
 *
 * The autopilot ecosystem (reap.py, heartbeat.py, term-check.py, decide.py,
 * bootstrap.sh, the hooks) resolves the orchestrator origin from HYDRA_API_BASE,
 * and the reap/test harness sets it to a DEAD socket (http://127.0.0.1:1) to
 * isolate test cycle-record writes from the live orchestrator on :4000.
 *
 * But dispatch.sh's two POST paths read *different* env vars:
 *   - the `hydra` CLI reads HYDRA_BASE_URL (default http://localhost:4000)
 *   - the curl fallback reads HYDRA_API   (default http://localhost:4000/api)
 * Neither honoured HYDRA_API_BASE, so a test that set only HYDRA_API_BASE would
 * still leak its fixture cycle ID to the live production API. These tests pin
 * the propagation fix on BOTH paths:
 *
 *   (1) `hydra` CLI path: a shim `hydra` on PATH records the HYDRA_BASE_URL it
 *       was invoked with; assert it equals HYDRA_API_BASE (not the :4000
 *       default).
 *   (2) curl fallback path (no `hydra` on PATH): a mock HTTP "live orchestrator"
 *       listens on an ephemeral port; HYDRA_API_BASE points at a DEAD port;
 *       assert the mock is NEVER contacted (the write went to the dead port,
 *       failed fast, and was swallowed non-fatally with exit 0).
 *
 * Tests are hermetic: no real orchestrator, no real `hydra` CLI (a PATH shim),
 * and the only real listener is the mock that MUST stay silent.
 */

import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, chmodSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "autopilot", "dispatch.sh");

// A closed port — any POST here fails fast and must be swallowed (exit 0).
const DEAD_API_BASE = "http://127.0.0.1:1";

// Common positional args for `dispatch.sh cycle-record`: a fixture cycle ID +
// a merged status + a code-writing skill (the exact shape that leaked in prod).
const CYCLE_ARGS = ["cycle-record", "tFIX", "merged", "hydra-dev"];

describe("dispatch.sh cycle-record → hydra CLI path honours HYDRA_API_BASE (issue #2635)", () => {
  let dir: string;
  let binDir: string;
  let capture: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "dispatch-2635-cli-"));
    binDir = join(dir, "bin");
    capture = join(dir, "hydra-base.txt");
    // Shim `hydra` on PATH: it just records the HYDRA_BASE_URL it saw and exits 0
    // so dispatch.sh's success branch is taken. This is what the `command -v
    // hydra` branch resolves to.
    const shim = join(binDir, "hydra");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      shim,
      `#!/usr/bin/env bash\nprintf '%s' "\${HYDRA_BASE_URL:-UNSET}" > ${JSON.stringify(capture)}\nexit 0\n`,
      "utf-8",
    );
    chmodSync(shim, 0o755);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("propagates HYDRA_API_BASE to the hydra CLI as HYDRA_BASE_URL", () => {
    const r = spawnSync("bash", [SCRIPT, ...CYCLE_ARGS], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        HYDRA_API_BASE: DEAD_API_BASE,
        // Deliberately DO NOT set HYDRA_BASE_URL — the whole bug is that tests
        // set only HYDRA_API_BASE and the old code fell back to :4000.
      },
      encoding: "utf-8",
    });
    assert.equal(r.status, 0, `dispatch.sh must exit 0; stderr=${r.stderr}`);
    assert.ok(existsSync(capture), "hydra shim must have been invoked");
    const seen = readFileSync(capture, "utf-8");
    assert.equal(
      seen,
      DEAD_API_BASE,
      `hydra CLI must be invoked with HYDRA_BASE_URL=${DEAD_API_BASE}, saw '${seen}'`,
    );
  });

  test("falls back to HYDRA_BASE_URL when HYDRA_API_BASE is unset", () => {
    const r = spawnSync("bash", [SCRIPT, ...CYCLE_ARGS], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        HYDRA_API_BASE: "",
        HYDRA_BASE_URL: "http://example.invalid:9",
      },
      encoding: "utf-8",
    });
    assert.equal(r.status, 0, `dispatch.sh must exit 0; stderr=${r.stderr}`);
    const seen = readFileSync(capture, "utf-8");
    assert.equal(
      seen,
      "http://example.invalid:9",
      `with HYDRA_API_BASE unset the pre-existing HYDRA_BASE_URL must win, saw '${seen}'`,
    );
  });
});

describe("dispatch.sh cycle-record → curl fallback never leaks to the live API (issue #2635)", () => {
  let dir: string;
  let binDir: string;
  let mock: ChildProcess;
  let hitFile: string;
  let liveBase: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "dispatch-2635-curl-"));
    binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    // NOTE: the mock "live orchestrator" MUST run OUT OF PROCESS. dispatch.sh is
    // driven here via the SYNCHRONOUS spawnSync, which blocks this process's
    // event loop for the whole child run — an in-process node:http mock could
    // never accept the connection (curl would hang → deadlock). So the sidecar
    // is its own node process that appends one byte per request to a hit file;
    // the test reads the file to count hits.
    hitFile = join(dir, "hits.log");
    const mockScript = join(dir, "mock.mjs");
    writeFileSync(
      mockScript,
      [
        `import { createServer } from "node:http";`,
        `import { appendFileSync } from "node:fs";`,
        `const s = createServer((_req, res) => {`,
        `  appendFileSync(${JSON.stringify(hitFile)}, "x");`,
        `  res.writeHead(200, { "Content-Type": "application/json" });`,
        `  res.end("{}");`,
        `});`,
        `s.listen(0, "127.0.0.1", () => { process.stdout.write(String(s.address().port)); });`,
      ].join("\n"),
      "utf-8",
    );
    mock = spawn("node", [mockScript], { stdio: ["ignore", "pipe", "inherit"] });
    const port = await new Promise<string>((res, rej) => {
      let buf = "";
      mock.stdout!.on("data", (d) => {
        buf += String(d);
        if (buf.trim()) res(buf.trim());
      });
      mock.on("error", rej);
      setTimeout(() => rej(new Error("mock did not report a port in time")), 5000);
    });
    liveBase = `http://127.0.0.1:${port}`;
  });

  after(() => {
    mock?.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  });

  function mockHits(): number {
    return existsSync(hitFile) ? readFileSync(hitFile, "utf-8").length : 0;
  }

  // Runs dispatch.sh with `hydra` NOT resolvable, so the curl fallback fires.
  // We keep the real PATH so bash/curl/python3 resolve, but strip every dir that
  // actually contains a `hydra` executable (~/.local/bin) so `command -v hydra`
  // inside dispatch.sh fails → the curl branch is taken. A hard timeout guards
  // against any spawn wedging the suite.
  function runCurlFallback(env: Record<string, string>) {
    const realPath = process.env.PATH ?? "";
    const keptDirs = realPath
      .split(":")
      .filter((d) => d && !existsSync(join(d, "hydra")));
    const trimmedPath = [binDir, ...keptDirs].join(":");
    return spawnSync("bash", [SCRIPT, ...CYCLE_ARGS], {
      // Start from process.env but SCRUB the two vars whose inherited presence
      // would otherwise steer the routing, so each case controls them explicitly.
      env: (() => {
        const e = { ...process.env, PATH: trimmedPath } as Record<string, string>;
        delete e.HYDRA_API_BASE;
        delete e.HYDRA_API;
        delete e.HYDRA_BASE_URL;
        return { ...e, ...env };
      })(),
      encoding: "utf-8",
      timeout: 15_000,
    });
  }

  test("routes the curl fallback POST to HYDRA_API_BASE, not the live :port", () => {
    const before = mockHits();
    const r = runCurlFallback({
      HYDRA_API_BASE: DEAD_API_BASE,
      // HYDRA_API (legacy) points at the LIVE mock — if the fix regresses and
      // HYDRA_API_BASE is ignored, the write lands on the mock and the hit
      // counter trips.
      HYDRA_API: `${liveBase}/api`,
    });
    // command -v hydra must have failed (trimmed PATH) → curl branch taken.
    assert.equal(r.status, 0, `dispatch.sh must exit 0 (POST swallowed); stderr=${r.stderr}`);
    assert.equal(
      mockHits(),
      before,
      "the live mock orchestrator must NEVER be contacted — cycle-record must go to the dead HYDRA_API_BASE port",
    );
  });

  test("still honours legacy HYDRA_API when HYDRA_API_BASE is unset", () => {
    // With HYDRA_API_BASE unset, the legacy HYDRA_API (→ the live mock) is used.
    // The mock SHOULD receive exactly one more hit, proving we didn't break the
    // pre-existing fallback contract.
    const before = mockHits();
    const r = runCurlFallback({
      HYDRA_API: `${liveBase}/api`,
    });
    assert.equal(r.status, 0, `dispatch.sh must exit 0; stderr=${r.stderr}`);
    assert.equal(
      mockHits(),
      before + 1,
      "with HYDRA_API_BASE unset the legacy HYDRA_API target must receive the write",
    );
  });
});
