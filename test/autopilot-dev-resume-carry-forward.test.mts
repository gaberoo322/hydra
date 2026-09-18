/**
 * Issue #4518 (INV-3) — `state.dev_resume_pending` survives a Pace Gate
 * relaunch.
 *
 * reap.py's no-PR-stall backstop (#3866) queues a resume record onto
 * `state.dev_resume_pending`, but bootstrap.sh rewrites
 * /tmp/hydra-autopilot-state.json from a heredoc on EVERY run and the Pace
 * Gate relaunches the autopilot every ~15 min — so a record queued by a run
 * that then hit its quota cap (run 4bbc46f5, 2026-09-17, anchor #4510) died
 * with the file before any turn could drain it. bootstrap now carries the
 * prior list forward — the same read-prior-state pattern as
 * `signal_last_fired` (#2575) and `research_force_counter` (#1666) —
 * deduplicated by anchor and FIFO-capped at DEV_RESUME_PENDING_CAP (20, the
 * cap reap_stall.py already enforces). A missing / unparseable prior file
 * seeds [] and never blocks bootstrap.
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPTS = join(REPO_ROOT, "scripts", "autopilot");
const BOOTSTRAP = join(SCRIPTS, "bootstrap.sh");
const DECIDE = join(SCRIPTS, "decide.py");
const REAP_STALL = join(SCRIPTS, "reap_stall.py");

interface Tmp { dir: string; state: string; heartbeat: string; log: string; cands: string; events: string }

function makeTmp(): Tmp {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-dev-resume-carry-"));
  return {
    dir,
    state: join(dir, "state.json"),
    heartbeat: join(dir, "heartbeat.txt"),
    log: join(dir, "nightly.log"),
    cands: join(dir, "cands.json"),
    events: join(dir, "events.json"),
  };
}

function runBootstrap(tmp: Tmp): { status: number; stderr: string } {
  const r = spawnSync(BOOTSTRAP, [], {
    env: {
      ...process.env,
      HYDRA_AUTOPILOT_STATE: tmp.state,
      HYDRA_AUTOPILOT_HEARTBEAT: tmp.heartbeat,
      HYDRA_AUTOPILOT_LOG: tmp.log,
      HYDRA_AUTOPILOT_SCOPE: "all",
      PATH: process.env.PATH ?? "",
    },
    encoding: "utf-8",
  });
  return { status: r.status ?? -1, stderr: r.stderr ?? "" };
}

function bootstrapWithPrior(prior: string): any {
  const tmp = makeTmp();
  try {
    writeFileSync(tmp.state, prior);
    const r = runBootstrap(tmp);
    assert.equal(r.status, 0, `bootstrap exited non-zero: ${r.stderr}`);
    return JSON.parse(readFileSync(tmp.state, "utf-8"));
  } finally {
    rmSync(tmp.dir, { recursive: true, force: true });
  }
}

function record(n: number, extra: Record<string, unknown> = {}) {
  return { anchor: `issue-${n}`, task_id: `t${n}`, branch: `worktree-agent-${n}`, stalled_epoch: 1_789_000_000 + n, ...extra };
}

describe("bootstrap.sh — dev_resume_pending carry-forward (issue #4518)", () => {
  test("a queued resume record survives the heredoc rewrite verbatim", () => {
    const prior = [record(4510), record(4511)];
    const s = bootstrapWithPrior(JSON.stringify({ pid: 0, dev_resume_pending: prior }));
    assert.deepEqual(s.dev_resume_pending, prior);
  });

  test("the carried list is deduplicated by anchor, keeping the latest record in FIFO position", () => {
    const s = bootstrapWithPrior(JSON.stringify({
      pid: 0,
      dev_resume_pending: [
        record(4510, { task_id: "old" }),
        record(4511),
        record(4510, { task_id: "new" }),
      ],
    }));
    assert.deepEqual(
      s.dev_resume_pending.map((e: any) => [e.anchor, e.task_id]),
      [["issue-4511", "t4511"], ["issue-4510", "new"]],
    );
  });

  test("the carried list is FIFO-capped at DEV_RESUME_PENDING_CAP, the same 20 reap_stall.py enforces", () => {
    const cap = Number(/^DEV_RESUME_PENDING_CAP = (\d+)$/m.exec(readFileSync(REAP_STALL, "utf-8"))?.[1]);
    assert.equal(cap, 20);
    assert.match(readFileSync(BOOTSTRAP, "utf-8"), /DEV_RESUME_PENDING_CAP=20\b/);
    const prior = Array.from({ length: 25 }, (_, i) => record(1000 + i));
    const s = bootstrapWithPrior(JSON.stringify({ pid: 0, dev_resume_pending: prior }));
    assert.equal(s.dev_resume_pending.length, cap);
    assert.equal(s.dev_resume_pending[0].anchor, "issue-1005", "the OLDEST records are the ones dropped");
    assert.equal(s.dev_resume_pending[cap - 1].anchor, "issue-1024");
  });

  test("malformed entries (non-object, missing/empty anchor) are dropped, never carried", () => {
    const s = bootstrapWithPrior(JSON.stringify({
      pid: 0,
      dev_resume_pending: ["junk", 7, null, { branch: "no-anchor" }, { anchor: "" }, { anchor: 42 }, record(4510)],
    }));
    assert.deepEqual(s.dev_resume_pending, [record(4510)]);
  });

  test("no prior state file seeds [] (a present, empty list — not a missing field)", () => {
    const tmp = makeTmp();
    try {
      const r = runBootstrap(tmp);
      assert.equal(r.status, 0, `bootstrap exited non-zero: ${r.stderr}`);
      assert.deepEqual(JSON.parse(readFileSync(tmp.state, "utf-8")).dev_resume_pending, []);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("an unparseable prior file or a non-list shape seeds [] and never blocks bootstrap", () => {
    assert.deepEqual(bootstrapWithPrior("not json at all").dev_resume_pending, []);
    assert.deepEqual(
      bootstrapWithPrior(JSON.stringify({ pid: 0, dev_resume_pending: "corrupt" })).dev_resume_pending,
      [],
    );
    assert.deepEqual(
      bootstrapWithPrior(JSON.stringify({ pid: 0, dev_resume_pending: { anchor: "issue-1" } })).dev_resume_pending,
      [],
    );
  });

  test("end to end: a record queued before a relaunch is drained by the next run's first dev_orch pick", () => {
    const tmp = makeTmp();
    try {
      writeFileSync(tmp.state, JSON.stringify({ pid: 0, dev_resume_pending: [record(4510)] }));
      const r = runBootstrap(tmp);
      assert.equal(r.status, 0, `bootstrap exited non-zero: ${r.stderr}`);
      writeFileSync(tmp.cands, JSON.stringify(null));
      writeFileSync(tmp.events, JSON.stringify([]));
      const d = spawnSync("python3", [DECIDE, "decide", tmp.state, tmp.cands, tmp.events], {
        encoding: "utf-8",
        env: { ...process.env, HYDRA_AUTOPILOT_RUN_END_POST: "off" },
      });
      assert.equal(d.status, 0, `decide.py exited ${d.status}: ${d.stderr}`);
      const plan = JSON.parse(d.stdout);
      const dev = (plan.actions ?? []).filter((a: any) => a.type === "dispatch" && a.slot === "dev_orch");
      assert.equal(dev.length, 1, JSON.stringify(plan.actions));
      assert.deepEqual(dev[0].prompt_args, {
        anchor: "issue-4510",
        resume: true,
        resume_branch: "worktree-agent-4510",
      });
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});
