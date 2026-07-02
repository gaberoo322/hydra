/**
 * Regression test for issue #2689 —
 * `scripts/autopilot/dispatch.sh cycle-record` must emit an EXPLICIT, non-empty
 * anchorType for EVERY skill, so no cycle-record ever lands with an
 * absent/empty anchorType that the metrics aggregator (src/metrics/aggregate.ts)
 * buckets as "unknown" (the data-quality failure that hid 24% of cycles).
 *
 * The skill → anchor_type map (dispatch.sh, ~line 101):
 *   hydra-dev / hydra-target-build        → work-queue
 *   hydra-qa                              → qa-review
 *   hydra-grill                           → grill        (NEW in #2689)
 *   hydra-research / hydra-issue-research /
 *     hydra-target-research               → research
 *   <anything else>                       → unmapped:<skill>  (NEW in #2689 —
 *     was the bare `$skill`; now a self-describing, never-empty sentinel plus a
 *     stderr diagnostic, so an unmapped skill is traceable, never "unknown")
 *
 * Approach (mirrors dispatch-cycle-record-api-base.test.mts): drive dispatch.sh
 * with `hydra` NOT resolvable so the curl fallback fires, point HYDRA_API at an
 * out-of-process mock HTTP server that records each request BODY, then assert
 * the parsed `anchorType` in that body. Hermetic: no real orchestrator, no real
 * `hydra` CLI, the only listener is the body-capturing mock.
 */

import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "autopilot", "dispatch.sh");

describe("dispatch.sh cycle-record → anchorType is always explicit (issue #2689)", () => {
  let dir: string;
  let binDir: string;
  let mock: ChildProcess;
  let bodyFile: string;
  let liveBase: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "dispatch-2689-"));
    binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    // Out-of-process mock "orchestrator": appends each request's JSON body (one
    // per line) to a capture file, then 200s. Out-of-process because dispatch.sh
    // is driven via the synchronous spawnSync, which would deadlock an
    // in-process node:http listener.
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
  // hits the mock. HYDRA_API points at the mock; HYDRA_API_BASE is deliberately
  // left unset so the legacy HYDRA_API path is taken (that path appends nothing
  // extra and reaches the mock).
  function recordCycle(skill: string): Record<string, unknown> {
    const realPath = process.env.PATH ?? "";
    const keptDirs = realPath.split(":").filter((d) => d && !existsSync(join(d, "hydra")));
    const trimmedPath = [binDir, ...keptDirs].join(":");
    const before = mockBodyCount();
    const r = spawnSync(
      "bash",
      [SCRIPT, "cycle-record", `t-${skill}`, "completed", skill],
      {
        env: (() => {
          const e = { ...process.env, PATH: trimmedPath } as Record<string, string>;
          delete e.HYDRA_API_BASE;
          delete e.HYDRA_BASE_URL;
          e.HYDRA_API = `${liveBase}/api`;
          return e;
        })(),
        encoding: "utf-8",
        timeout: 15_000,
      },
    );
    assert.equal(r.status, 0, `dispatch.sh must exit 0; stderr=${r.stderr}`);
    // The mock is async; poll briefly for the new body line to land.
    const deadline = Date.now() + 5000;
    while (mockBodyCount() <= before && Date.now() < deadline) {
      spawnSync("sleep", ["0.05"]);
    }
    assert.ok(mockBodyCount() > before, `mock must have received a POST for skill=${skill}`);
    const lines = readFileSync(bodyFile, "utf-8").trim().split("\n");
    return JSON.parse(lines[lines.length - 1]);
  }

  function mockBodyCount(): number {
    return existsSync(bodyFile) ? readFileSync(bodyFile, "utf-8").trim().split("\n").filter(Boolean).length : 0;
  }

  test("hydra-dev → work-queue", () => {
    assert.equal(recordCycle("hydra-dev").anchorType, "work-queue");
  });

  test("hydra-target-build → work-queue", () => {
    assert.equal(recordCycle("hydra-target-build").anchorType, "work-queue");
  });

  test("hydra-qa → qa-review", () => {
    assert.equal(recordCycle("hydra-qa").anchorType, "qa-review");
  });

  test("hydra-grill → grill (first-class mapping added in #2689, was falling through)", () => {
    assert.equal(recordCycle("hydra-grill").anchorType, "grill");
  });

  test("hydra-research → research", () => {
    assert.equal(recordCycle("hydra-research").anchorType, "research");
  });

  test("an unmapped skill records 'unmapped:<skill>' — self-describing, never empty, never 'unknown'", () => {
    const body = recordCycle("hydra-some-new-skill");
    assert.equal(body.anchorType, "unmapped:hydra-some-new-skill");
    // The critical invariant of #2689: the fallback anchorType is NON-EMPTY and
    // is NOT the aggregator's catch-all "unknown".
    assert.ok(typeof body.anchorType === "string" && (body.anchorType as string).length > 0);
    assert.notEqual(body.anchorType, "unknown");
    assert.notEqual(body.anchorType, "");
  });

  test("EVERY recorded anchorType is a non-empty string (no cycle can bucket as 'unknown')", () => {
    for (const skill of [
      "hydra-dev",
      "hydra-qa",
      "hydra-grill",
      "hydra-research",
      "hydra-issue-research",
      "some-unmapped-skill",
    ]) {
      const at = recordCycle(skill).anchorType;
      assert.ok(
        typeof at === "string" && at.trim().length > 0,
        `skill=${skill} must record a non-empty anchorType, got ${JSON.stringify(at)}`,
      );
    }
  });
});
