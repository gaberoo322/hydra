/**
 * Contract test for issue #3078 —
 * `scripts/autopilot/dispatch.sh holdback-pending` must POST the documented
 * `POST /api/holdback/pending` body shape ({prNumber, tier, cycleId[, anchorType]})
 * so the Outcome Attribution Spine ledger (hydra:holdback:pending-enroll) is fed
 * by a single AUDITED subcommand instead of the drop-prone inlined `curl … | jq …`
 * step that left the ledger dark for 7+ days (#3078). It mirrors the schema the
 * server validates (HoldbackPendingBodySchema): prNumber a positive int, tier an
 * int 1–4 OR null, cycleId a non-empty string, anchorType an optional string.
 *
 * Approach (mirrors dispatch-cycle-record-anchor-type.test.mts): drive dispatch.sh
 * with `hydra` NOT resolvable so the curl fallback fires, point HYDRA_API at an
 * out-of-process mock HTTP server that records each request BODY, then assert the
 * parsed body. Hermetic: no real orchestrator, no real `hydra` CLI.
 */

import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "autopilot", "dispatch.sh");

describe("dispatch.sh holdback-pending → arms the pending-enroll registry (issue #3078)", () => {
  let dir: string;
  let binDir: string;
  let mock: ChildProcess;
  let bodyFile: string;
  let liveBase: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "dispatch-3078-"));
    binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    bodyFile = join(dir, "bodies.jsonl");
    const mockScript = join(dir, "mock.mjs");
    writeFileSync(
      mockScript,
      [
        `import { createServer } from "node:http";`,
        `import { appendFileSync } from "node:fs";`,
        `const s = createServer((req, res) => {`,
        `  let buf = "";`,
        `  req.on("data", (d) => { buf += d; });`,
        `  req.on("end", () => {`,
        `    appendFileSync(${JSON.stringify(bodyFile)}, buf.replace(/\\n/g, " ") + "\\n");`,
        `    res.writeHead(200, { "Content-Type": "application/json" });`,
        `    res.end("{}");`,
        `  });`,
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

  // Run dispatch.sh with `hydra` NOT resolvable so the curl fallback fires and
  // hits the mock. HYDRA_API points at the mock; HYDRA_API_BASE / HYDRA_BASE_URL
  // are unset so the legacy HYDRA_API path is taken.
  function armPending(args: string[]): { status: number; stderr: string; body?: Record<string, unknown> } {
    const realPath = process.env.PATH ?? "";
    const keptDirs = realPath.split(":").filter((d) => d && !existsSync(join(d, "hydra")));
    const trimmedPath = [binDir, ...keptDirs].join(":");
    const beforeCount = mockBodyCount();
    const r = spawnSync("bash", [SCRIPT, "holdback-pending", ...args], {
      env: (() => {
        const e = { ...process.env, PATH: trimmedPath } as Record<string, string>;
        delete e.HYDRA_API_BASE;
        delete e.HYDRA_BASE_URL;
        e.HYDRA_API = `${liveBase}/api`;
        return e;
      })(),
      encoding: "utf-8",
      timeout: 15_000,
    });
    if (r.status !== 0) return { status: r.status ?? -1, stderr: r.stderr ?? "" };
    // The mock is async; poll briefly for the new body line to land.
    const deadline = Date.now() + 5000;
    while (mockBodyCount() <= beforeCount && Date.now() < deadline) {
      spawnSync("sleep", ["0.05"]);
    }
    assert.ok(mockBodyCount() > beforeCount, "mock must have received a POST");
    const lines = readFileSync(bodyFile, "utf-8").trim().split("\n");
    return { status: 0, stderr: r.stderr ?? "", body: JSON.parse(lines[lines.length - 1]) };
  }

  function mockBodyCount(): number {
    return existsSync(bodyFile)
      ? readFileSync(bodyFile, "utf-8").trim().split("\n").filter(Boolean).length
      : 0;
  }

  test("POSTs {prNumber, tier, cycleId, anchorType} with an integer tier", () => {
    const { status, body } = armPending(["4242", "3", "cycle-abc", "work-queue"]);
    assert.equal(status, 0);
    assert.deepEqual(body, {
      prNumber: 4242,
      tier: 3,
      cycleId: "cycle-abc",
      anchorType: "work-queue",
    });
    // prNumber is a JSON NUMBER (not a string) — the schema is z.number().int().
    assert.equal(typeof body!.prNumber, "number");
    assert.equal(typeof body!.tier, "number");
  });

  test("emits a JSON null tier for the literal 'null' (unknown-tier, exempt server-side)", () => {
    const { status, body } = armPending(["4243", "null", "cycle-def", "work-queue"]);
    assert.equal(status, 0);
    assert.equal(body!.tier, null);
    assert.equal(body!.prNumber, 4243);
  });

  test("emits a JSON null tier for an empty tier arg", () => {
    const { status, body } = armPending(["4244", "", "cycle-ghi"]);
    assert.equal(status, 0);
    assert.equal(body!.tier, null);
  });

  test("omits anchorType when the 4th arg is absent (legacy-caller degradation)", () => {
    const { status, body } = armPending(["4245", "2", "cycle-jkl"]);
    assert.equal(status, 0);
    assert.ok(!("anchorType" in body!), "anchorType must be omitted, not empty-string");
    assert.deepEqual(body, { prNumber: 4245, tier: 2, cycleId: "cycle-jkl" });
  });

  test("exits non-zero (usage error) when prNumber is missing", () => {
    // Only two positional args → cycle_id resolves empty → usage guard fires.
    const { status, stderr } = armPending(["", "3"]);
    assert.notEqual(status, 0);
    assert.match(stderr, /holdback-pending requires/);
  });

  test("exits non-zero when prNumber is not an integer (never POSTs garbage)", () => {
    const beforeCount = mockBodyCount();
    const { status, stderr } = armPending(["not-a-number", "3", "cycle-xyz"]);
    assert.notEqual(status, 0);
    assert.match(stderr, /pr_number must be an integer/);
    assert.equal(mockBodyCount(), beforeCount, "no POST fires on a malformed prNumber");
  });
});
