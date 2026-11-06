/**
 * Dispatcher-written claim (ADR-0047 D4/D7, issue #5315): the seam `dispatch`
 * verb, the legacy-backfill takeover + script, `stamp-slot.py claim`, and the
 * reap release-outcome mapping. Offline: gh / Redis / clock are in-memory fakes;
 * the Python halves run as subprocesses with a stubbed `npx` on PATH.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatch, openClaim, releaseHeldClaim, rollbackDispatch, type LifecycleMode, type SeamDeps } from "../src/lifecycle/seam.ts";
import { runBackfill } from "../scripts/lifecycle-legacy-backfill.ts";
import { claimOutcomeOf } from "../src/glm/drainer-driver.ts";
import { entryContribution } from "../src/lifecycle/caps.ts";
import { claimBlocksPick } from "../src/glm/pick.ts";
import type { DispatchClaim, LifecycleJournalEntry } from "../src/redis/lifecycle-journal.ts";

const NOW = Date.parse("2026-11-05T12:00:00Z");

interface World {
  deps: SeamDeps;
  journal: LifecycleJournalEntry[];
  edits: Array<{ issue: number; remove: string[]; add: string[] }>;
  labels: string[];
  claim: DispatchClaim | null;
  dc: { exists: boolean; status: string; artifactHash?: string | null };
  claimOpens: number;
  /** The ttlSeconds each journal.openClaim call received. */
  claimTtls: Array<number | undefined>;
}

function world(mode: LifecycleMode, labels: string[], dc: World["dc"] = { exists: true, status: "approved", artifactHash: "abc123hash" }): World {
  const w: World = { journal: [], edits: [], labels: [...labels], claim: null, dc, claimOpens: 0, claimTtls: [], deps: undefined as unknown as SeamDeps };
  w.deps = {
    repo: "o/r",
    mode: async () => mode,
    view: async (n) => ({ ok: true, row: { number: n, title: "t", url: "", createdAt: "", labels: [...w.labels], body: "", state: "OPEN" } }),
    edit: async (issue, l) => {
      w.edits.push({ issue, remove: l.remove, add: l.add });
      w.labels = w.labels.filter((x) => !l.remove.includes(x)).concat(l.add);
      return { ok: true };
    },
    close: async () => ({ ok: true }),
    comment: async () => ({ ok: true }),
    env: () => ({}),
    fetch: {
      designConcept: async () => ({ ok: true, value: w.dc }),
      pr: async () => ({ ok: false }),
      comment: async () => ({ ok: false }),
      stateEntry: async () => ({ ok: true, value: { enteredAtMs: null } }),
      issueComments: async () => ({ ok: true, value: [] }),
      timeline: async () => ({ ok: true, value: [] }),
      prBodies: async () => ({ ok: true, value: [] }),
    },
    journal: {
      append: async (_r, _i, e) => (w.journal.push(e), { ok: true }),
      expireOnClose: async () => ({ ok: true }),
      openClaim: async (_r, _i, c, ttl) => {
        w.claimTtls.push(ttl);
        if (w.claim) return { ok: false, code: "claim-held", existing: w.claim };
        w.claim = c;
        w.claimOpens += 1;
        return { ok: true, claim: c };
      },
      closeClaim: async (_r, _i, id) => {
        if (w.claim && w.claim.dispatchId !== id) return { ok: false, error: "claim-owner-mismatch" };
        const prior = w.claim;
        w.claim = null;
        return { ok: true, prior };
      },
      read: async () => ({ ok: true, entries: [...w.journal] }),
      readClaim: async () => ({ ok: true, claim: w.claim }),
    },
    now: () => NOW,
  };
  return w;
}

const input = (over: Record<string, unknown> = {}) =>
  ({ issue: 42, dispatchId: "worktree-agent-aaaa-t1-dev_orch", class: "dev_orch", run: "run-1", ...over }) as any;

describe("dispatch composite verb (INV-1)", () => {
  test("dev class: claim then ready-for-agent -> in-progress, with dispatch evidence on the transition", async () => {
    const w = world("enforce", ["ready-for-agent"]);
    const res = await dispatch(input(), w.deps);
    assert.equal(res.ok, true);
    assert.deepEqual(w.edits, [{ issue: 42, remove: ["ready-for-agent"], add: ["in-progress"] }]);
    assert.equal(w.claim?.dispatchId, "worktree-agent-aaaa-t1-dev_orch");
    const t = w.journal.find((e) => e.kind === "transition")!;
    assert.deepEqual(t.evidence, { dispatch: "worktree-agent-aaaa-t1-dev_orch", class: "dev_orch", run: "run-1" });
  });

  test("needs-dev-resume is also advanced to in-progress", async () => {
    const w = world("enforce", ["needs-dev-resume"]);
    const res = await dispatch(input({ purpose: "resume" }), w.deps);
    assert.equal(res.ok, true);
    assert.deepEqual(w.edits, [{ issue: 42, remove: ["needs-dev-resume"], add: ["in-progress"] }]);
  });

  test("ttlSeconds reaches the journal claim open (dispatch and claim); absent stays no-TTL", async () => {
    const a = world("enforce", ["ready-for-agent"]);
    assert.equal((await dispatch(input({ ttlSeconds: 14400 }), a.deps)).ok, true);
    assert.deepEqual(a.claimTtls, [14400]);
    const b = world("enforce", ["ready-for-agent"]);
    assert.equal((await openClaim({ issue: 42, dispatchId: "q1", class: "qa_orch", run: "r", ttlSeconds: 7200 }, b.deps)).ok, true);
    assert.deepEqual(b.claimTtls, [7200]);
    // sibling shape: a claim opened without a ttl keeps the no-expiry behaviour
    const c = world("enforce", ["ready-for-agent"]);
    assert.equal((await dispatch(input(), c.deps)).ok, true);
    assert.deepEqual(c.claimTtls, [undefined]);
  });

  test("qa role opens a label-free claim: no label write", async () => {
    const w = world("enforce", ["needs-qa"]);
    const res = await dispatch(input({ class: "qa_orch", pr: 9 }), w.deps);
    assert.equal(res.ok, true);
    assert.equal(w.edits.length, 0);
    assert.ok(w.claim);
    assert.equal(res.ok && res.advanced, null);
  });

  test("dev claim on a non-dispatchable state label returns advanceSkipped (sibling: a single dispatchable label has none)", async () => {
    const w = world("enforce", ["in-progress"]);
    const res = await dispatch(input(), w.deps);
    assert.equal(res.ok, true);
    assert.equal(res.ok && res.advanced, null);
    assert.equal(res.ok && res.advanceSkipped, "non-dispatchable-state");
    const ok = await dispatch(input({ dispatchId: "d2" }), world("enforce", ["ready-for-agent"]).deps);
    assert.equal(ok.ok && ok.advanceSkipped, undefined);
  });

  test("enforce refusal releases the claim BEFORE returning (the claim never outlives a refused dispatch)", async () => {
    const w = world("enforce", ["ready-for-agent", "needs-design-concept"], { exists: true, status: "draft", artifactHash: "h" });
    const res = await dispatch(input(), w.deps);
    assert.equal(res.ok, false);
    assert.equal(!res.ok && res.code, "design-concept-draft");
    assert.equal(w.claim, null, "claim released");
    assert.equal(w.edits.length, 0, "no label write on a refused dispatch");
    const closedEntry = w.journal.find((e) => e.kind === "claim-closed")!;
    assert.equal(closedEntry.evidence.outcome, "released");
  });

  test("shadow still writes and reports wouldRefuse", async () => {
    const w = world("shadow", ["ready-for-agent", "needs-design-concept"], { exists: true, status: "draft", artifactHash: "h" });
    const res = await dispatch(input(), w.deps);
    assert.equal(res.ok, true);
    assert.equal(res.ok && res.wouldRefuse, "design-concept-draft");
    assert.deepEqual(w.edits, [{ issue: 42, remove: ["ready-for-agent"], add: ["in-progress"] }]);
    assert.ok(w.claim, "claim kept in shadow");
  });
});

describe("rollbackDispatch: a dispatcher-owned undo that works in enforce (QA round 4)", () => {
  test("enforce: fresh dispatch is rolled back to ready-for-agent, claim released, rollback tagged", async () => {
    const w = world("enforce", ["ready-for-agent"]);
    assert.equal((await dispatch(input(), w.deps)).ok, true);
    assert.deepEqual(w.labels, ["in-progress"]);
    const res = await rollbackDispatch({ issue: 42, dispatchId: "worktree-agent-aaaa-t1-dev_orch" }, w.deps);
    assert.equal(res.ok && res.restored, "ready-for-agent");
    assert.deepEqual(w.labels, ["ready-for-agent"]);
    assert.equal(w.claim, null);
    const last = w.journal[w.journal.length - 1];
    assert.equal(last.reason, "dispatch-rollback");
    assert.equal(last.written, true);
  });

  test("sibling: a resume dispatch is restored to needs-dev-resume (prior comes from the journal)", async () => {
    const w = world("enforce", ["needs-dev-resume"]);
    await dispatch(input({ purpose: "resume" }), w.deps);
    const res = await rollbackDispatch({ issue: 42, dispatchId: "worktree-agent-aaaa-t1-dev_orch" }, w.deps);
    assert.equal(res.ok && res.restored, "needs-dev-resume");
    assert.deepEqual(w.labels, ["needs-dev-resume"]);
  });

  test("a dispatch that never advanced (non-dispatchable state) only releases the claim, no label write", async () => {
    const w = world("enforce", ["in-progress"]);
    const d = await dispatch(input({ purpose: "resume" }), w.deps);
    assert.equal(d.ok && d.advanceSkipped, "non-dispatchable-state");
    const res = await rollbackDispatch({ issue: 42, dispatchId: "worktree-agent-aaaa-t1-dev_orch" }, w.deps);
    assert.equal(res.ok && res.restored, null);
    assert.equal(w.edits.length, 0);
    assert.deepEqual(w.labels, ["in-progress"]);
    assert.equal(w.claim, null);
  });

  test("another dispatch's claim is never released nor its label moved (ownership)", async () => {
    const w = world("enforce", ["ready-for-agent"]);
    await dispatch(input(), w.deps);
    const res = await rollbackDispatch({ issue: 42, dispatchId: "someone-else" }, w.deps);
    assert.equal(res.ok, false);
    assert.deepEqual(w.labels, ["in-progress"]);
  });

  test("a rollback entry does not count toward stale-requeue; a plain in-progress -> ready-for-agent does", () => {
    const base = { ts: 1, kind: "transition", from: "in-progress", to: "ready-for-agent", evidence: {}, result: "ok", written: true };
    assert.equal(entryContribution("stale-requeue", { ...base, reason: "dispatch-rollback" }), 0);
    assert.equal(entryContribution("stale-requeue", { ...base, reason: null }), 1);
  });

  test("releaseHeldClaim frees whichever claim is held (stall); no claim is a no-op", async () => {
    const w = world("enforce", ["in-progress"]);
    assert.deepEqual(await releaseHeldClaim(42, w.deps, "t", "stall"), { ok: true, prior: null });
    await openClaim({ issue: 42, dispatchId: "d1", class: "dev_orch", run: "r" }, w.deps);
    const r = await releaseHeldClaim(42, w.deps, "t", "stall");
    assert.equal(r.ok && r.prior?.dispatchId, "d1");
    assert.equal(w.claim, null);
    assert.equal(w.journal.find((e) => e.kind === "claim-closed")!.evidence.outcome, "stall");
  });
});

describe("recover-stale stale-requeue arm releases the claim (QA round 4)", () => {
  test("the requeue arm frees the held claim with outcome stall; the open-PR arm leaves it for its worker", () => {
    const sh = readFileSync(join(import.meta.dirname, "..", "scripts/autopilot/recover-stale.sh"), "utf8");
    const requeue = sh.slice(sh.indexOf("--add-label ready-for-agent"), sh.indexOf("re-queued in-progress"));
    assert.match(requeue, /scripts\/lifecycle\.ts release "\$ISSUE" --held --outcome stall/);
    const toQa = sh.slice(sh.indexOf("--add-label needs-qa"), sh.indexOf("routed in-progress"));
    assert.equal(/lifecycle\.ts release/.test(toQa), false);
  });
});

describe("GLM pick: claims that block a pick (QA round 4)", () => {
  const c = (cls: string): DispatchClaim => ({ dispatchId: "d", class: cls, run: "r", artifactHash: null, openedAt: 1 });
  test("a held legacy-backfill placeholder (takeover-able) does not block; a real dispatch claim does", () => {
    assert.equal(claimBlocksPick(c("legacy-backfill")), false);
    assert.equal(claimBlocksPick(c("dev_orch")), true);
    assert.equal(claimBlocksPick(null), false);
  });
});

describe("SET NX is the concurrency gate in both modes (INV-2)", () => {
  for (const mode of ["shadow", "enforce"] as const) {
    test(`${mode}: a second dispatcher is refused claim-held with no label write and no journal entry`, async () => {
      const w = world(mode, ["ready-for-agent"]);
      assert.equal((await dispatch(input(), w.deps)).ok, true);
      const journalBefore = w.journal.length;
      const editsBefore = w.edits.length;
      const second = await dispatch(input({ dispatchId: "other-dispatch" }), w.deps);
      assert.equal(second.ok, false);
      assert.equal(!second.ok && second.code, "claim-held");
      assert.equal(w.journal.length, journalBefore);
      assert.equal(w.edits.length, editsBefore);
      assert.equal(w.claim?.dispatchId, "worktree-agent-aaaa-t1-dev_orch");
    });
  }

  test("a held legacy-backfill claim is released (outcome released) and the new claim opened in the same call", async () => {
    const w = world("enforce", ["in-progress"]);
    w.claim = { dispatchId: "legacy-backfill-42", class: "legacy-backfill", run: "legacy-backfill-2026-11-05", artifactHash: null, openedAt: NOW - 1 };
    const res = await openClaim({ issue: 42, dispatchId: "real-1", class: "dev_orch", run: "r" }, w.deps);
    assert.equal(res.ok, true);
    assert.equal(w.claim?.dispatchId, "real-1");
    assert.equal(w.journal.find((e) => e.kind === "claim-closed")?.evidence.outcome, "released");
  });
});

describe("artifactHash is copied, never claimed (INV-8)", () => {
  test("an approved record's hash lands on the claim", async () => {
    const w = world("enforce", ["ready-for-agent"], { exists: true, status: "approved", artifactHash: "deadbeef" });
    await dispatch(input(), w.deps);
    assert.equal(w.claim?.artifactHash, "deadbeef");
  });

  test("a draft record's hash is NOT copied", async () => {
    const w = world("shadow", ["ready-for-agent"], { exists: true, status: "draft", artifactHash: "deadbeef" });
    await dispatch(input(), w.deps);
    assert.equal(w.claim?.artifactHash, null);
  });
});

describe("legacy-backfill script (INV-7)", () => {
  function backfillRig(inProgress: number[], held: Set<number>) {
    const opened: number[] = [];
    const deps = {
      repo: "o/r",
      listInProgress: async () => inProgress,
      readClaim: async (_r: string, n: number) => ({ ok: true as const, claim: held.has(n) ? ({ dispatchId: "x" } as DispatchClaim) : null }),
      open: async (n: number, id: string, run: string) => {
        assert.equal(id, `legacy-backfill-${n}`);
        assert.equal(run, "legacy-backfill-2026-11-05");
        if (held.has(n)) return { ok: false as const, code: "claim-held" as const };
        held.add(n);
        opened.push(n);
        return { ok: true as const, claim: { dispatchId: id } as DispatchClaim };
      },
      today: () => "2026-11-05",
    };
    return { deps, opened };
  }

  test("dry-run (default) writes nothing", async () => {
    const r = backfillRig([1, 2, 3], new Set([2]));
    const s = await runBackfill(false, r.deps);
    assert.deepEqual(s, { scanned: 3, claimed: 0, held: 1, failed: 0 });
    assert.deepEqual(r.opened, []);
  });

  test("--apply claims every unheld issue; a second run claims nothing (idempotent)", async () => {
    const r = backfillRig([1, 2, 3], new Set([2]));
    assert.deepEqual(await runBackfill(true, r.deps), { scanned: 3, claimed: 2, held: 1, failed: 0 });
    assert.deepEqual(r.opened, [1, 3]);
    assert.deepEqual(await runBackfill(true, r.deps), { scanned: 3, claimed: 0, held: 3, failed: 0 });
    assert.deepEqual(r.opened, [1, 3]);
  });

  test("an unreadable issue list is a failure, never an empty success", async () => {
    const r = backfillRig([], new Set());
    const s = await runBackfill(true, { ...r.deps, listInProgress: async () => null });
    assert.equal(s.failed, 1);
  });
});

describe("playbook + lint-ratchet shape (INV-5, INV-10)", () => {
  const ROOT = join(import.meta.dirname, "..");

  test("workers never add in-progress: parent flow step 4 only reads; the QA pick step opens a label-free claim", () => {
    const parent = readFileSync(join(ROOT, "docs/operator-playbooks/_fragments/hydra-dev-parent-flow.md"), "utf8");
    assert.equal(/--add-label in-progress/.test(parent), false);
    assert.match(parent, /scripts\/lifecycle\.ts dispatch \$issue_number --dispatch \$dispatch_id --class dev_orch --run \$run_id/);
    const qa = readFileSync(join(ROOT, "docs/operator-playbooks/hydra-qa.md"), "utf8");
    assert.match(qa, /scripts\/lifecycle\.ts claim \$issue_number --dispatch \$dispatch_id --class qa_orch --run \$run_id --pr \$pr_number/);
  });

  test("lint ratchet shrinks: the dev parent flow row is 3 and drainer-driver carries no direct state-write row", () => {
    const base = JSON.parse(readFileSync(join(ROOT, "test/fixtures/lifecycle-seam-baseline.json"), "utf8")) as {
      files: Record<string, number>;
    };
    // Shrink-only ratchet: a later legitimate shrink must not fail this guard.
    assert.ok(base.files["docs/operator-playbooks/_fragments/hydra-dev-parent-flow.md"] <= 3);
    assert.equal(base.files["src/glm/drainer-driver.ts"], undefined);
    assert.equal(base.files["docs/operator-playbooks/hydra-qa.md"], undefined, "qa sites migrated to the seam by #5317");
  });
});

describe("GLM finish action -> claim outcome (INV-6)", () => {
  test("open-pr -> pr-opened; keep-partial-for-resume -> stall; every other arm -> no-pr", () => {
    const f = (action: string) => ({ action }) as any;
    assert.equal(claimOutcomeOf(f("open-pr")), "pr-opened");
    assert.equal(claimOutcomeOf(f("keep-partial-for-resume")), "stall");
    for (const a of ["release-not-authored", "release-nothing-produced", "withhold-preflight-blocked", "release-after-failed-pr", "finish-fault"]) {
      assert.equal(claimOutcomeOf(f(a)), "no-pr", a);
    }
  });
});

// ---------------------------------------------------------------------------
// Python halves
// ---------------------------------------------------------------------------

const STAMP = join(import.meta.dirname, "..", "scripts", "autopilot", "stamp-slot.py");
const REAP_DIR = join(import.meta.dirname, "..", "scripts", "autopilot");

function claimRun(slots: Record<string, unknown>, action: Record<string, unknown> | null, slot: string, stubExit = 0) {
  const dir = mkdtempSync(join(tmpdir(), "stamp-claim-"));
  const statePath = join(dir, "state.json");
  const planPath = join(dir, "plan.json");
  const argvLog = join(dir, "npx-argv.txt");
  writeFileSync(statePath, JSON.stringify({ run_id: "abcdef12-0000", turn: 3, slots }));
  writeFileSync(planPath, JSON.stringify({ actions: action ? [{ type: "dispatch", slot, ...action }] : [] }));
  const bin = join(dir, "bin");
  spawnSync("mkdir", ["-p", bin]);
  writeFileSync(join(bin, "npx"), `#!/bin/sh\necho "$@" >> "${argvLog}"\necho '{"ok":${stubExit === 0}}'\nexit ${stubExit}\n`);
  chmodSync(join(bin, "npx"), 0o755);
  const r = spawnSync("python3", ["-I", STAMP, "claim", slot], {
    env: { PATH: `${bin}:${process.env.PATH}`, HYDRA_AUTOPILOT_STATE: statePath, HYDRA_AUTOPILOT_PLAN: planPath, HOME: process.env.HOME ?? "" },
    encoding: "utf8",
  });
  let argv = "";
  try { argv = readFileSync(argvLog, "utf8").trim(); } catch { /* intentional: stub never ran => skipped */ }
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr, argv };
}

describe("stamp-slot.py claim (INV-3, INV-4)", () => {
  const SLOTS = { dev_orch: null, qa_orch: null, dev_target: null };

  test("a pinned dev_orch dispatch runs the seam dispatch verb with branch as dispatchId, run id, purpose fresh", () => {
    const r = claimRun(SLOTS, { worktreeBranch: "worktree-agent-abcdef12-t3-dev_orch", prompt_args: { anchor: "issue-5315" } }, "dev_orch");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      r.argv,
      "tsx scripts/lifecycle.ts dispatch 5315 --dispatch worktree-agent-abcdef12-t3-dev_orch --class dev_orch --run abcdef12-0000 --purpose fresh --ttl 14400",
    );
  });

  test("resume and forward-fix purposes; forward-fix carries --pr", () => {
    const a = claimRun(SLOTS, { worktreeBranch: "b", prompt_args: { anchor: "issue-7", resume: true } }, "dev_orch");
    assert.match(a.argv, /--purpose resume --ttl 14400$/);
    const b = claimRun(SLOTS, { worktreeBranch: "b", prompt_args: { anchor: "issue-7", forward_fix_pr: 88 } }, "dev_orch");
    assert.match(b.argv, /--purpose forward-fix --ttl 14400 --pr 88$/);
  });

  test("skip matrix: unpinned, target scope, signal class, no dispatch action -> exit 0 skipped, seam never called", () => {
    const cases: Array<[string, Record<string, unknown> | null, string, string]> = [
      ["unpinned", { prompt_args: {} }, "dev_orch", "unpinned"],
      ["qa worker-claims", { prompt_args: { anchor: "unpinned" } }, "qa_orch", "worker-claims"],
      ["target", { prompt_args: { anchor: "issue-9" } }, "dev_target", "target-scope"],
      ["signal", { prompt_args: { anchor: "issue-9" } }, "sweep_orch", "signal-class"],
      ["no action", null, "dev_orch", "no-dispatch-action"],
    ];
    for (const [name, action, slot, reason] of cases) {
      const r = claimRun(SLOTS, action, slot);
      assert.equal(r.status, 0, name);
      assert.deepEqual(JSON.parse(r.stdout), { claim: "skipped", reason }, name);
      assert.equal(r.argv, "", `${name}: seam must not be called`);
    }
  });

  test("INV-6: non-dev/qa pinned classes open no claim (reap would never release it)", () => {
    for (const slot of ["design_concept_orch", "research_orch", "tickets_orch"]) {
      const r = claimRun({ ...SLOTS, [slot]: null }, { prompt_args: { anchor: "issue-9" } }, slot);
      assert.equal(r.status, 0, slot);
      assert.deepEqual(JSON.parse(r.stdout), { claim: "skipped", reason: "no-release-role" }, slot);
      assert.equal(r.argv, "", slot);
    }
  });

  test("qa_* is never claimed by the dispatcher (worker claims and releases its own review)", () => {
    for (const prompt_args of [{ issue: 77 }, { anchor: "issue-77" }]) {
      const r = claimRun(SLOTS, { worktreeBranch: "b", prompt_args }, "qa_orch");
      assert.equal(r.status, 0);
      assert.deepEqual(JSON.parse(r.stdout), { claim: "skipped", reason: "worker-claims" });
      assert.equal(r.argv, "");
    }
  });

  test("release-claim rolls back a dev claim with outcome released; qa is a no-op", () => {
    const run = (slot: string, action: Record<string, unknown>) => {
      const dir = mkdtempSync(join(tmpdir(), "stamp-rel-"));
      const statePath = join(dir, "state.json");
      const planPath = join(dir, "plan.json");
      const argvLog = join(dir, "argv.txt");
      writeFileSync(statePath, JSON.stringify({ run_id: "abcdef12-0000", turn: 3, slots: SLOTS }));
      writeFileSync(planPath, JSON.stringify({ actions: [{ type: "dispatch", slot, ...action }] }));
      const bin = join(dir, "bin");
      spawnSync("mkdir", ["-p", bin]);
      writeFileSync(join(bin, "npx"), `#!/bin/sh\necho "$@" >> "${argvLog}"\necho '{"ok":true}'\n`);
      chmodSync(join(bin, "npx"), 0o755);
      const r = spawnSync("python3", ["-I", STAMP, "release-claim", slot], {
        env: { PATH: `${bin}:${process.env.PATH}`, HYDRA_AUTOPILOT_STATE: statePath, HYDRA_AUTOPILOT_PLAN: planPath, HOME: process.env.HOME ?? "" },
        encoding: "utf8",
      });
      let argv = "";
      try { argv = readFileSync(argvLog, "utf8").trim(); } catch { /* intentional: stub never ran */ }
      return { status: r.status, argv };
    };
    const d = run("dev_orch", { worktreeBranch: "b1", prompt_args: { anchor: "issue-5" } });
    assert.equal(d.status, 0);
    // One seam verb: the label restored is read from the journal by the seam, never guessed here.
    assert.equal(d.argv, "tsx scripts/lifecycle.ts rollback 5 --dispatch b1");
    const rs = run("dev_orch", { worktreeBranch: "b3", prompt_args: { anchor: "issue-5", resume: true } });
    assert.equal(rs.status, 0);
    assert.equal(rs.argv, "tsx scripts/lifecycle.ts rollback 5 --dispatch b3");
    const q = run("qa_orch", { worktreeBranch: "b2", prompt_args: { anchor: "issue-5" } });
    assert.equal(q.status, 0);
    assert.equal(q.argv, "");
  });

  test("fail closed: seam exit 0 with silent or non-JSON or ok:false output exits 1", () => {
    for (const body of ["true", "echo not-json", "echo '{\"ok\":false}'"]) {
      const dir = mkdtempSync(join(tmpdir(), "stamp-claim-"));
      const statePath = join(dir, "state.json");
      const planPath = join(dir, "plan.json");
      writeFileSync(statePath, JSON.stringify({ run_id: "abcdef12-0000", turn: 3, slots: SLOTS }));
      writeFileSync(planPath, JSON.stringify({ actions: [{ type: "dispatch", slot: "dev_orch", worktreeBranch: "b", prompt_args: { anchor: "issue-5" } }] }));
      const bin = join(dir, "bin");
      spawnSync("mkdir", ["-p", bin]);
      writeFileSync(join(bin, "npx"), `#!/bin/sh\n${body}\nexit 0\n`);
      chmodSync(join(bin, "npx"), 0o755);
      const r = spawnSync("python3", ["-I", STAMP, "claim", "dev_orch"], {
        env: { PATH: `${bin}:${process.env.PATH}`, HYDRA_AUTOPILOT_STATE: statePath, HYDRA_AUTOPILOT_PLAN: planPath, HOME: process.env.HOME ?? "" },
        encoding: "utf8",
      });
      assert.equal(r.status, 1, `body=${JSON.stringify(body)}`);
      assert.match(r.stderr, /claim result unusable/);
    }
  });

  test("a refused claim (seam exit 1) exits 1 so the parent skips Agent and the stamp", () => {
    const r = claimRun(SLOTS, { worktreeBranch: "b", prompt_args: { anchor: "issue-5" } }, "dev_orch", 1);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /claim refused issue=#5/);
  });
});

describe("reap claim-release outcome mapping (INV-6)", () => {
  function outcome(cls: string, status: string, pr: string): string {
    const code = `import sys;sys.path.insert(0,${JSON.stringify(REAP_DIR)});import reap;` +
      `print(reap.claim_release_outcome(${JSON.stringify(cls)},${JSON.stringify(status)},${pr}))`;
    const r = spawnSync("python3", ["-c", code], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  }

  test("dev role: PR -> pr-opened; failed -> stall; completed/empty without PR -> no-pr", () => {
    assert.equal(outcome("dev_orch", "completed", "True"), "pr-opened");
    assert.equal(outcome("dev_orch", "completed", "False"), "no-pr");
    assert.equal(outcome("dev_orch", "empty", "False"), "no-pr");
    assert.equal(outcome("dev_orch", "failed", "False"), "stall");
    assert.equal(outcome("dev_orch", "completed", "None"), "no-pr");
  });

  test("qa role: completed -> verdict-posted; otherwise stall", () => {
    assert.equal(outcome("qa_orch", "completed", "None"), "verdict-posted");
    assert.equal(outcome("qa_orch", "failed", "None"), "stall");
  });

  test("other / target classes release nothing", () => {
    assert.equal(outcome("sweep_orch", "completed", "None"), "None");
    assert.equal(outcome("dev_target", "completed", "True"), "None");
  });
});
