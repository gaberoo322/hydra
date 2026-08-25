/**
 * Regression tests for `scripts/autopilot/collect-state.sh`'s
 * `retro_run_available` + `retro_run_drillable` signals (issue #3871,
 * design-concept issue-3871).
 *
 * Issue #920 dispatches the ~115k-token `retro_orch` signal class whenever
 * ANY completed autopilot run exists — even a genuinely clean one whose
 * retro bundle has nothing to say. #3871 adds a cheap pre-check:
 * `retro_run_drillable`, computed from the SAME candidate run's retro bundle
 * (`GET /autopilot/runs/:runId/retro`, #918), so `decide.py` can skip the
 * dispatch for one extra HTTP GET instead of a full subagent session.
 *
 * These cases exercise the COMMITTED shell + embedded python3 reducers
 * verbatim — extracted from the real script and executed for real (the
 * `test/autopilot-collect-state-signals.test.mts` / `extractFilter()`
 * precedent, design-concept issue-3871's rejectedAlternatives) — rather than
 * a TypeScript re-derivation of their logic, which could silently drift from
 * what actually ships. Two layers are pinned separately:
 *
 *   1. The python3 reducer collect-state.sh pipes each HTTP response
 *      through (`avail+run_id` and `bundle→drillable`), run directly via
 *      `python3 -c <extracted program>` against synthetic JSON on stdin.
 *   2. The bash control flow around the bundle fetch — the `curl -sf` call,
 *      its `[ -z ... ]` empty-response fail-open guard, and the outer
 *      "no completed run" short-circuit — extracted as a shell snippet and
 *      run for real under `bash`, with a stub `curl` on PATH standing in for
 *      the network call so each of the three fail-open sub-cases (fetch
 *      fails / empty body / unparseable JSON) is independently reachable and
 *      independently asserted, per the issue's acceptance criteria.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const COLLECT_STATE = join(REPO_ROOT, "scripts", "autopilot", "collect-state.sh");
const SRC = readFileSync(COLLECT_STATE, "utf-8");

// ---------------------------------------------------------------------------
// Layer 1 — the two embedded python3 reducers, extracted verbatim.
// ---------------------------------------------------------------------------

/** Extract the program inside the FIRST `<<'PY' ... PY` heredoc found after
 *  `anchor` in the committed source. Mirrors autopilot-decide.test.mts's
 *  extractMapSelectionJq() shape, generalised to python heredocs. */
function extractHeredocAfter(anchor: string, occurrence: "first" | "last" = "first"): string {
  const anchorIdx = SRC.indexOf(anchor);
  assert.ok(anchorIdx >= 0, `anchor not found in collect-state.sh: ${anchor}`);
  const OPEN = "<<'PY'";
  const openIdx =
    occurrence === "first" ? SRC.indexOf(OPEN, anchorIdx) : SRC.lastIndexOf(OPEN, anchorIdx);
  assert.ok(openIdx >= 0, `no <<'PY' heredoc found relative to anchor: ${anchor}`);
  const bodyStart = openIdx + OPEN.length + 1; // +1 skips the newline right after <<'PY'
  const CLOSE = "\nPY\n";
  const bodyEnd = SRC.indexOf(CLOSE, bodyStart);
  assert.ok(bodyEnd > bodyStart, `unterminated <<'PY' heredoc for anchor: ${anchor}`);
  return SRC.slice(bodyStart, bodyEnd);
}

function runPython(prog: string, stdin: string): string {
  const r = spawnSync("python3", ["-c", prog], { input: stdin, encoding: "utf-8" });
  assert.equal(r.status, 0, `python3 reducer exited non-zero: ${r.stderr}`);
  return r.stdout;
}

describe("collect-state.sh — retro_run_available + run_id reducer (issue #3871 INV-4)", () => {
  const PROG = extractHeredocAfter('echo -n "retro_run_available="');

  test("finds the first (most-recent) terminal run and captures its run_id", () => {
    const out = runPython(
      PROG,
      JSON.stringify({
        runs: [
          { status: "running" },
          { status: "ended", run_id: "r-abc" },
          { status: "completed", run_id: "r-old" },
        ],
      }),
    );
    assert.equal(out, "true\nr-abc\n", "must skip the in-flight run and pick the newest terminal one");
  });

  test("no terminal run in the index -> false with an empty run_id line", () => {
    const out = runPython(PROG, JSON.stringify({ runs: [{ status: "running" }] }));
    assert.equal(out, "false\n\n");
  });

  test("empty runs list -> false", () => {
    const out = runPython(PROG, JSON.stringify({ runs: [] }));
    assert.equal(out, "false\n\n");
  });

  test("unparseable input -> false (fail-closed, mirrors retro_run_available's existing default)", () => {
    const out = runPython(PROG, "not json");
    assert.equal(out, "false\n\n");
  });
});

describe("collect-state.sh — retro bundle -> retro_run_drillable reducer (issue #3871)", () => {
  const PROG = extractHeredocAfter("Unreadable run (bundle assembler", "last");

  test("false ONLY on a successfully-parsed, run-found bundle with every drill input empty", () => {
    const out = runPython(
      PROG,
      JSON.stringify({ runFound: true, dispatches: [], reflections: [], stuckSignals: [], recommendations: [] }),
    );
    assert.equal(out, "false\n");
  });

  test("a flagged dispatch -> true", () => {
    const out = runPython(
      PROG,
      JSON.stringify({
        runFound: true,
        dispatches: [{ flagged: true }],
        reflections: [],
        stuckSignals: [],
        recommendations: [],
      }),
    );
    assert.equal(out, "true\n");
  });

  test("non-empty reflections -> true", () => {
    const out = runPython(
      PROG,
      JSON.stringify({
        runFound: true,
        dispatches: [],
        reflections: [{ anchorReference: "issue-1" }],
        stuckSignals: [],
        recommendations: [],
      }),
    );
    assert.equal(out, "true\n");
  });

  test("non-empty stuckSignals -> true", () => {
    const out = runPython(
      PROG,
      JSON.stringify({ runFound: true, dispatches: [], reflections: [], stuckSignals: [{ x: 1 }], recommendations: [] }),
    );
    assert.equal(out, "true\n");
  });

  test("non-empty recommendations -> true", () => {
    const out = runPython(
      PROG,
      JSON.stringify({ runFound: true, dispatches: [], reflections: [], stuckSignals: [], recommendations: [{ x: 1 }] }),
    );
    assert.equal(out, "true\n");
  });

  test("runFound:false (successfully parsed, but the run failed to resolve) -> true, correction (c)", () => {
    const out = runPython(PROG, JSON.stringify({ runFound: false }));
    assert.equal(out, "true\n");
  });

  test("unparseable JSON body -> true, correction (c)", () => {
    const out = runPython(PROG, "not json at all");
    assert.equal(out, "true\n");
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — the bash control flow around the bundle fetch, extracted as a
// snippet and run for real with a stub `curl` on PATH.
// ---------------------------------------------------------------------------

function extractDrillableBashBlock(): string {
  const START = 'echo -n "retro_run_drillable="';
  const start = SRC.indexOf(START);
  assert.ok(start >= 0, "retro_run_drillable emitter missing from collect-state.sh");
  const END = "\n\n# Wayfinder map frontier";
  const end = SRC.indexOf(END, start);
  assert.ok(end > start, "could not find the end of the retro_run_drillable block (section boundary moved?)");
  const block = SRC.slice(start, end);
  assert.ok(block.includes("curl -sf"), "extracted block lost its curl bundle fetch");
  return block;
}

/**
 * Run the extracted `retro_run_drillable` bash block for real, with a stub
 * `curl` standing in for the network call. `curlOutput === null` simulates a
 * hard fetch failure (stub exits 1, prints nothing) — everything else
 * simulates a successful HTTP round-trip whose body is `curlOutput`.
 */
function runDrillableBlock(opts: { available: string; runId: string; curlOutput: string | null }): string {
  const block = extractDrillableBashBlock();
  const dir = mkdtempSync(join(tmpdir(), "collect-state-drillable-"));
  try {
    const stubDir = join(dir, "stub");
    mkdirSync(stubDir);
    const curlPath = join(stubDir, "curl");
    const failed = opts.curlOutput === null;
    const body = (opts.curlOutput ?? "").replace(/'/g, `'\\''`);
    writeFileSync(
      curlPath,
      `#!/usr/bin/env bash\nprintf '%s' '${body}'\nexit ${failed ? 1 : 0}\n`,
    );
    chmodSync(curlPath, 0o755);
    const script = [
      "set -uo pipefail",
      `PATH="${stubDir}:$PATH"`,
      `_retro_available='${opts.available}'`,
      `_retro_target_run_id='${opts.runId}'`,
      block,
    ].join("\n");
    const scriptPath = join(dir, "run.sh");
    writeFileSync(scriptPath, script);
    const r = spawnSync("bash", [scriptPath], { encoding: "utf-8" });
    assert.equal(r.status, 0, `extracted retro_run_drillable block exited non-zero: ${r.stderr}`);
    return r.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("collect-state.sh — retro_run_drillable bash control flow (issue #3871 acceptance criteria)", () => {
  test("no completed run available -> false without ever calling curl", () => {
    const out = runDrillableBlock({ available: "false", runId: "", curlOutput: "should never be read" });
    assert.equal(out, "retro_run_drillable=false\n");
  });

  test("AC: bundle fetch FAILS (curl exits non-zero) -> true", () => {
    const out = runDrillableBlock({ available: "true", runId: "r-abc", curlOutput: null });
    assert.equal(out, "retro_run_drillable=true\n");
  });

  test("AC: bundle fetch returns an EMPTY body -> true", () => {
    const out = runDrillableBlock({ available: "true", runId: "r-abc", curlOutput: "" });
    assert.equal(out, "retro_run_drillable=true\n");
  });

  test("AC: bundle fetch returns UNPARSEABLE JSON -> true", () => {
    const out = runDrillableBlock({ available: "true", runId: "r-abc", curlOutput: "<html>502</html>" });
    assert.equal(out, "retro_run_drillable=true\n");
  });

  test("AC: a successfully-parsed, run-found, fully-empty bundle -> false (the only false case)", () => {
    const out = runDrillableBlock({
      available: "true",
      runId: "r-abc",
      curlOutput: JSON.stringify({
        runFound: true,
        dispatches: [],
        reflections: [],
        stuckSignals: [],
        recommendations: [],
      }),
    });
    assert.equal(out, "retro_run_drillable=false\n");
  });

  test("a successfully-parsed bundle with a flagged dispatch -> true (end-to-end through the real curl call site)", () => {
    const out = runDrillableBlock({
      available: "true",
      runId: "r-abc",
      curlOutput: JSON.stringify({
        runFound: true,
        dispatches: [{ flagged: true }],
        reflections: [],
        stuckSignals: [],
        recommendations: [],
      }),
    });
    assert.equal(out, "retro_run_drillable=true\n");
  });
});
