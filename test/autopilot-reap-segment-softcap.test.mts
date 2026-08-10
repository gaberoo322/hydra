/**
 * Regression test for issue #3839 — resumed dispatches must be capped against
 * their LATEST segment, not the summed cumulative total.
 *
 * A dispatch that stalls and is RESUMED (the prescribed recovery for the
 * documented stall-on-backgrounded-tests mode) has its per-segment token
 * counts summed into a single `reap.py completion` call. Before #3839 the soft
 * cap (limits.subagent_max_tokens, 400k) was compared against that SUM, so a
 * healthy two-segment resume of ~200k + ~200k measured as a 400k+ "runaway",
 * burned the class for the rest of the run, and stamped status="failed" —
 * inverting the incentive (resume = correct but punished; re-dispatch = wrong
 * but gets a fresh budget).
 *
 * The fix (design-concept #3839): `reap.py completion` accepts an OPTIONAL
 * trailing positional, last_segment_tokens — the LATEST segment's count. When
 * supplied, the soft cap bounds THAT segment (the cap bounds one subagent, the
 * most recent unit of work), while cost accounting still records the true
 * summed total (total_tokens). Omitted → byte-for-byte the legacy
 * cap-against-total path (a genuine single-segment runaway still burns).
 *
 * These tests drive the real `reap.py completion` CLI against a DEAD
 * orchestrator (HYDRA_API_BASE → a closed port) so the cycle-record POST fails
 * fast and must be swallowed — cap classification is correctness, the POST is
 * accounting. We assert on state.burned_classes, the `status=` + `last_seg=`
 * fields stamped on the slot_complete run-log line, and cumulative_tokens
 * (cost accounting must stay the true sum — issue #3839 criterion 4).
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const REAP = join(REPO_ROOT, "scripts", "autopilot", "reap.py");

// A closed port — the cycle-record POST fails fast and must be swallowed.
const DEAD_API_BASE = "http://127.0.0.1:1";

const SOFT_CAP = 400_000;

interface Paths {
  dir: string;
  state: string;
  log: string;
}

function makeTmp(): Paths {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-reap-segment-"));
  return { dir, state: join(dir, "state.json"), log: join(dir, "nightly.log") };
}

function writeState(path: string, patch: Record<string, unknown>): void {
  const base: Record<string, unknown> = {
    started_epoch: Math.floor(Date.now() / 1000),
    limits: {
      token_budget: 2_000_000,
      subagent_max_tokens: SOFT_CAP,
      subagent_hard_max_tokens: 800_000,
    },
    cumulative_tokens: 0,
    dispatches: 0,
    idle_turns: 0,
    burned_classes: [],
    reaped_task_ids: [],
    slots: {
      dev_orch: {
        skill: "hydra-dev",
        started_epoch: Math.floor(Date.now() / 1000),
        task_id: "tSeg",
        branch: "worktree-agent-seg-t0-dev_orch",
      },
      qa_orch: null,
      research_orch: null,
    },
    signal_last_fired: {},
    failure_log: [],
  };
  writeFileSync(path, JSON.stringify({ ...base, ...patch }));
}

function runCompletion(
  args: string[],
  paths: Paths,
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("python3", [REAP, "completion", ...args], {
    env: {
      ...process.env,
      HYDRA_API_BASE: DEAD_API_BASE,
      // Pin the alternate env vars dispatch.sh's `hydra` CLI / curl fallback
      // reads so the cycle-record POST can never leak to the live :4000.
      HYDRA_BASE_URL: DEAD_API_BASE,
      HYDRA_API: DEAD_API_BASE,
      HYDRA_AUTOPILOT_STATE: paths.state,
      HYDRA_AUTOPILOT_LOG: paths.log,
      // Keep the worktree-GC side-effect out of the test.
      HYDRA_REAP_WORKTREE_GC: "0",
    },
    encoding: "utf-8",
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function readState(paths: Paths): Record<string, unknown> {
  return JSON.parse(readFileSync(paths.state, "utf-8"));
}

function runLog(paths: Paths): string {
  return existsSync(paths.log) ? readFileSync(paths.log, "utf-8") : "";
}

describe("reap.py completion — resumed-dispatch latest-segment soft cap (issue #3839)", () => {
  test("criterion 1: a resumed dispatch whose latest segment is under the cap does NOT burn and is NOT failed", () => {
    const tmp = makeTmp();
    try {
      // The exact run from the issue: 205,819 (seg1) + 198,520 (latest seg2) =
      // 404,339 — 1.1% over the 400k soft cap as a SUM, but the LATEST segment
      // (198,520) is comfortably under it.
      writeState(tmp.state, {});
      const r = runCompletion(
        ["dev_orch", "tSeg", "404339", "hydra-dev", "198520"],
        tmp,
      );
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const st = readState(tmp);
      assert.deepEqual(
        st.burned_classes,
        [],
        "a resumed dispatch whose latest segment is under the cap must NOT burn its class",
      );

      const log = runLog(tmp);
      assert.match(
        log,
        /slot_complete .*status=completed/,
        "a healthy resumed dispatch must NOT be stamped status=failed",
      );
      assert.doesNotMatch(
        log,
        /status=failed/,
        "no part of the reap may classify a latest-segment-healthy resume as failed",
      );
      assert.match(
        log,
        /slot_complete .*last_seg=198520/,
        "the latest-segment count is stamped so a per-segment cap is observable",
      );

      // Criterion 4: cost accounting records the TRUE SUM, not the latest segment.
      assert.equal(
        st.cumulative_tokens,
        404339,
        "cost accounting must record the summed total even when the cap honours the latest segment",
      );
      // The slot is still released (the resume was healthy, not a wedged slot).
      assert.equal(
        (st.slots as Record<string, unknown>).dev_orch,
        null,
        "the pipeline slot is released on a healthy resume",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("criterion 2: a genuine single-segment runaway (last_segment_tokens omitted) still burns, exactly as today", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {});
      const r = runCompletion(["dev_orch", "tSeg", "450000", "hydra-dev"], tmp);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const st = readState(tmp);
      assert.deepEqual(
        st.burned_classes,
        ["dev_orch"],
        "a single-segment runaway over the cap still burns its class",
      );

      const log = runLog(tmp);
      assert.match(
        log,
        /slot_complete .*status=failed/,
        "a genuine runaway is still stamped status=failed",
      );
      assert.doesNotMatch(
        log,
        /last_seg=/,
        "the legacy omitted-argument path stamps no latest-segment field",
      );
      assert.equal(st.cumulative_tokens, 450000, "cost accounting records the true total");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("INV-5: a resumed dispatch whose LATEST segment is itself oversized still burns", () => {
    const tmp = makeTmp();
    try {
      // last_segment_tokens must not become a blanket exemption: if the LATEST
      // segment itself exceeds the cap, the dispatch genuinely ran one subagent
      // hot. 100,000 (seg1) + 450,000 (latest seg2) = 550,000 cumulative.
      writeState(tmp.state, {});
      const r = runCompletion(
        ["dev_orch", "tSeg", "550000", "hydra-dev", "450000"],
        tmp,
      );
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const st = readState(tmp);
      assert.deepEqual(
        st.burned_classes,
        ["dev_orch"],
        "a latest segment over the cap still burns even with last_segment_tokens supplied",
      );
      const log = runLog(tmp);
      assert.match(log, /slot_complete .*status=failed/);
      assert.match(log, /slot_complete .*last_seg=450000/);
      assert.equal(st.cumulative_tokens, 550000, "cost accounting records the true summed total");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("INV-4: a legitimately zero-token latest segment compares as 0 (no burn), never falls back to the cumulative sum", () => {
    const tmp = makeTmp();
    try {
      // The load-bearing is-not-None case: a 0 latest segment is a REAL value
      // that must compare as 0 >= soft (False). A bare truthiness check would
      // treat 0 as falsy and silently cap against the over-cap cumulative total
      // (404,339) instead — wrongly burning a healthy resume.
      writeState(tmp.state, {});
      const r = runCompletion(["dev_orch", "tSeg", "404339", "hydra-dev", "0"], tmp);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const st = readState(tmp);
      assert.deepEqual(
        st.burned_classes,
        [],
        "a zero latest segment must compare as 0 (under cap), not fall back to the cumulative sum",
      );
      const log = runLog(tmp);
      assert.match(log, /slot_complete .*status=completed/);
      // last_seg=0 is stamped — proving 0 was the supplied value, not 'omitted'.
      assert.match(log, /slot_complete .*last_seg=0(?=\s|$)/);
      assert.equal(st.cumulative_tokens, 404339);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("legacy path: last_segment_tokens omitted and a sub-cap total is a clean, unburned completion", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {});
      const r = runCompletion(["dev_orch", "tSeg", "300000", "hydra-dev"], tmp);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const st = readState(tmp);
      assert.deepEqual(st.burned_classes, [], "a sub-cap single-segment completion does not burn");
      const log = runLog(tmp);
      assert.match(log, /slot_complete .*status=completed/);
      assert.equal(st.cumulative_tokens, 300000);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("malformed last_segment_tokens fails safe: degrades to cap-against-total (never silently under-caps)", () => {
    const tmp = makeTmp();
    try {
      // A non-numeric latest-segment value must NOT be read as 0 (which would
      // exempt an over-cap dispatch). It fails safe: treated as omitted, so the
      // cap falls back to the cumulative total.
      writeState(tmp.state, {});
      const r = runCompletion(["dev_orch", "tSeg", "404339", "hydra-dev", "abc"], tmp);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);
      assert.match(
        r.stderr,
        /invalid last_segment_tokens/i,
        "a malformed value is reported on stderr",
      );

      const st = readState(tmp);
      assert.deepEqual(
        st.burned_classes,
        ["dev_orch"],
        "malformed last_segment_tokens must fail safe toward burning, not a silent exemption",
      );
      const log = runLog(tmp);
      assert.match(log, /slot_complete .*status=failed/);
      assert.doesNotMatch(log, /last_seg=/, "a malformed value stamps no latest-segment field");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});
