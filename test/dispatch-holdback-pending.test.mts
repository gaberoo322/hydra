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
  function armPending(
    args: string[],
    extraEnv: Record<string, string> = {},
  ): { status: number; stderr: string; body?: Record<string, unknown> } {
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
        Object.assign(e, extraEnv);
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

  // Issue #3539: the worktree-branch (5th arg) overrides the task_id (3rd arg) as
  // the pending entry's cycleId, so the merge-watch enrichment keys on the SAME
  // `effective_cycle_id = worktree_branch or task_id` reap keyed its classified
  // cycle-record on (reap.py:650). This is the load-bearing part of the fix — the
  // enrichment now lands on reap's already-classified BRANCH hash instead of
  // minting an un-joinable bare-UUID first write that buckets `unclassified`.
  test("keys the pending entry on the worktree branch (5th arg) — the divergent-cycleId merge bump now joins reap's classified record (#3539)", () => {
    // 3rd arg is the bare autopilot task_id (a UUID); 5th arg is the synthesised
    // worktree branch. reap wrote its CLASSIFIED record under the BRANCH, so the
    // pending entry — and thus the merge-watch enrichment — must ALSO use it.
    const taskId = "fe21f30e-1234-4abc-9def-0123456789ab";
    const branch = "worktree-agent-a7101d965f686ea65-t5-dev_orch";
    const { status, body } = armPending([
      "3539",
      "3",
      taskId,
      "work-queue",
      branch,
    ]);
    assert.equal(status, 0);
    // The cycleId is the BRANCH, not the bare task_id — the whole #3539 fix.
    assert.equal(
      body!.cycleId,
      branch,
      "the worktree branch must override the task_id as the join key so the enrichment lands on reap's classified branch-keyed record",
    );
    assert.notEqual(
      body!.cycleId,
      taskId,
      "must NOT key on the bare-UUID task_id (the un-joinable twin that becomes an unclassified first write)",
    );
    // The anchorType backstop is still forwarded verbatim.
    assert.deepEqual(body, {
      prNumber: 3539,
      tier: 3,
      cycleId: branch,
      anchorType: "work-queue",
    });
  });

  // The branch-override is opt-in: a branch-less (signal-class) arm omits the 5th
  // arg and the cycleId stays the task_id — mirroring reap's own
  // `effective_cycle_id = worktree_branch or task_id` degradation. This proves the
  // fix does not disturb the branch-less path (no false override on an empty arg).
  test("a branch-less arm (empty 5th arg) keeps keying on the task_id (#3539 degradation)", () => {
    const taskId = "signal-class-task-id";
    const { status, body } = armPending(["3540", "null", taskId, "sweep", ""]);
    assert.equal(status, 0);
    assert.equal(
      body!.cycleId,
      taskId,
      "an empty worktree-branch arg must not override — the cycleId stays the task_id (its cycleId IS the task_id)",
    );
    assert.equal(body!.anchorType, "sweep");
    assert.equal(body!.tier, null);
  });

  // Issue #3579: when the 4th positional anchorType is empty but HYDRA_ARM_SKILL
  // names a mapped dispatch skill, the anchorType is RESOLVED through the shared
  // `resolve_anchor_type_from_skill` table — the same one `cycle-record` uses — so
  // the arming write and the reap-time first-write can never disagree on the lane.
  test("resolves anchorType from HYDRA_ARM_SKILL when the 4th arg is empty (#3579)", () => {
    const { status, body } = armPending(["3579", "2", "cycle-discover", ""], {
      HYDRA_ARM_SKILL: "hydra-discover",
    });
    assert.equal(status, 0);
    assert.equal(
      body!.anchorType,
      "discover",
      "the discover skill resolves to the discover lane via the shared mapping, not a blanket work-queue",
    );
    assert.deepEqual(body, { prNumber: 3579, tier: 2, cycleId: "cycle-discover", anchorType: "discover" });
  });

  test("an explicit 4th-arg anchorType takes precedence over HYDRA_ARM_SKILL (#3579)", () => {
    const { status, body } = armPending(["3580", "3", "cycle-explicit", "grill"], {
      HYDRA_ARM_SKILL: "hydra-discover",
    });
    assert.equal(status, 0);
    assert.equal(body!.anchorType, "grill", "the literal 4th positional wins over the env resolution");
  });

  // An unmapped skill must DROP to unclassified (omit the field) rather than write
  // a bogus `unmapped:*` lane — DEGRADE-TRUTHFULLY over NEVER-GUESS (#2822).
  test("omits anchorType (degrades to unclassified) for an unmapped HYDRA_ARM_SKILL (#3579)", () => {
    const { status, stderr, body } = armPending(["3581", "1", "cycle-unmapped", ""], {
      HYDRA_ARM_SKILL: "hydra-nonexistent-skill",
    });
    assert.equal(status, 0);
    assert.ok(!("anchorType" in body!), "an unmapped skill must omit anchorType, never write unmapped:*");
    assert.match(stderr, /no anchor_type mapping/);
    assert.deepEqual(body, { prNumber: 3581, tier: 1, cycleId: "cycle-unmapped" });
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
