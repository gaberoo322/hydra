/**
 * Lifecycle gate predicates (pure) and the writer-seam spine under shadow /
 * enforce with injected deps — no gh, no Redis (ADR-0047, issue #5310).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  advance,
  journalEntry,
  operatorAdvance,
  operatorReopen,
  gateAdr5,
  gateClose,
  gateDispatch,
  gateJudgment,
  gatePrOpen,
  evaluateGate,
  openClaim,
  releaseClaim,
  resolveLifecycleMode,
  loadLifecycleMode,
  type GateInput,
  type SeamDeps,
  type LifecycleMode,
} from "../src/lifecycle/index.ts";
import type { LifecycleJournalEntry } from "../src/redis/lifecycle-journal.ts";

function gi(over: Partial<GateInput> = {}): GateInput {
  return { issue: 10, from: "in-progress", to: "needs-qa", flags: [], evidence: {}, ...over };
}

describe("gate predicates (INV-7, INV-8)", () => {
  test("judgment requires reason in the target list and a rationale", () => {
    assert.equal(gateJudgment(gi({ to: "needs-info" })).code, "reason-required");
    assert.equal(gateJudgment(gi({ to: "needs-info", reason: "bogus", rationale: "x" })).code, "reason-not-allowed");
    assert.equal(gateJudgment(gi({ to: "needs-info", reason: "missing-repro" })).code, "rationale-required");
    assert.equal(gateJudgment(gi({ to: "needs-info", reason: "missing-repro", rationale: "  " })).code, "rationale-required");
    assert.equal(gateJudgment(gi({ to: "needs-info", reason: "missing-repro", rationale: "no steps" })).ok, true);
  });

  test("adr5 refuses any reason outside the closed enum", () => {
    assert.equal(gateAdr5(gi({ to: "ready-for-human", reason: "tired", rationale: "x" })).code, "reason-not-allowed");
    assert.equal(gateAdr5(gi({ to: "ready-for-human", reason: "credentials", rationale: "x" })).ok, true);
    assert.equal(gateAdr5(gi({ to: "ready-for-human" })).code, "reason-required");
  });

  test("dispatch passes without the flag and fails closed with it", () => {
    assert.equal(gateDispatch(gi(), {}).ok, true);
    const flagged = gi({ flags: ["needs-design-concept"] });
    assert.equal(gateDispatch(flagged, {}).code, "design-concept-fetch-failed");
    assert.equal(gateDispatch(flagged, { designConcept: { ok: false } }).code, "design-concept-fetch-failed");
    assert.equal(gateDispatch(flagged, { designConcept: { ok: true, value: { exists: false, status: "" } } }).code, "design-concept-missing");
    assert.equal(gateDispatch(flagged, { designConcept: { ok: true, value: { exists: true, status: "draft" } } }).code, "design-concept-draft");
    assert.equal(gateDispatch(flagged, { designConcept: { ok: true, value: { exists: true, status: "stale" } } }).code, "design-concept-expired");
    assert.equal(gateDispatch(flagged, { designConcept: { ok: true, value: { exists: true, status: "approved" } } }).ok, true);
  });

  test("pr-open needs an open PR, bound by number, that closes the issue", () => {
    const ev = { pr: "55" };
    const open = { ok: true as const, value: { number: 55, state: "OPEN", body: "Closes #10" } };
    assert.equal(gatePrOpen(gi(), {}).code, "evidence-required:pr");
    assert.equal(gatePrOpen(gi({ evidence: ev }), {}).code, "fetch-failed");
    assert.equal(gatePrOpen(gi({ evidence: ev }), { pr: { ok: false } }).code, "fetch-failed");
    assert.equal(gatePrOpen(gi({ evidence: { pr: "56" } }), { pr: open }).code, "record-binding-mismatch");
    assert.equal(gatePrOpen(gi({ evidence: ev }), { pr: { ok: true, value: { ...open.value, state: "MERGED" } } }).code, "pr-not-open");
    assert.equal(gatePrOpen(gi({ evidence: ev }), { pr: { ok: true, value: { ...open.value, body: "Refs #10" } } }).code, "pr-does-not-close-issue");
    assert.equal(gatePrOpen(gi({ evidence: ev }), { pr: open }).ok, true);
  });

  test("close: completed needs a merged PR; not planned needs superseded-by", () => {
    const merged = { ok: true as const, value: { number: 55, state: "MERGED", body: "closes #10" } };
    assert.equal(gateClose(gi({ to: "closed", closeReason: "completed", evidence: { pr: "55" } }), { pr: merged }).ok, true);
    assert.equal(
      gateClose(gi({ to: "closed", closeReason: "completed", evidence: { pr: "55" } }), { pr: { ok: true, value: { ...merged.value, state: "OPEN" } } }).code,
      "pr-not-merged",
    );
    assert.equal(gateClose(gi({ to: "closed", closeReason: "not planned" }), {}).code, "evidence-required:superseded-by");
    assert.equal(gateClose(gi({ to: "closed", closeReason: "not planned", evidence: { "superseded-by": "#99" } }), {}).ok, true);
    assert.equal(gateClose(gi({ to: "closed", closeReason: "weird" }), {}).code, "close-reason-not-allowed");
  });

  test("unimplemented gates refuse gate-unimplemented", () => {
    assert.deepEqual(evaluateGate("not-yet-implemented", gi(), {}), { ok: false, code: "gate-unimplemented" });
    assert.equal(evaluateGate("none", gi(), {}).ok, true);
  });
});

describe("mode resolution (INV-12)", () => {
  test("is total: only the literal 'enforce' enforces", () => {
    assert.deepEqual(resolveLifecycleMode(undefined), { mode: "shadow", reason: "config-missing" });
    assert.deepEqual(resolveLifecycleMode(null), { mode: "shadow", reason: "value-malformed" });
    assert.deepEqual(resolveLifecycleMode([]), { mode: "shadow", reason: "value-malformed" });
    assert.deepEqual(resolveLifecycleMode({}), { mode: "shadow", reason: "key-missing" });
    assert.deepEqual(resolveLifecycleMode({ "lifecycle-seam": "ENFORCE" }), { mode: "shadow", reason: "value-malformed" });
    assert.deepEqual(resolveLifecycleMode({ "lifecycle-seam": "shadow" }), { mode: "shadow", reason: null });
    assert.deepEqual(resolveLifecycleMode({ "lifecycle-seam": "enforce" }), { mode: "enforce", reason: null });
  });

  test("loader maps missing file and bad JSON to shadow, and the committed file says shadow", async () => {
    const enoent = async () => { throw Object.assign(new Error("nope"), { code: "ENOENT" }); };
    assert.deepEqual(await loadLifecycleMode("/x", { readFile: enoent }), { mode: "shadow", reason: "config-missing" });
    assert.deepEqual(await loadLifecycleMode("/x", { readFile: async () => "{oops" }), { mode: "shadow", reason: "value-malformed" });
    const real = await loadLifecycleMode(process.cwd());
    assert.deepEqual(real, { mode: "shadow", reason: null });
  });
});

// ---------------------------------------------------------------------------
// Seam spine with injected deps
// ---------------------------------------------------------------------------

interface Harness {
  deps: SeamDeps;
  journal: LifecycleJournalEntry[];
  edits: Array<{ issue: number; remove: string[]; add: string[] }>;
  closes: Array<{ issue: number; reason: string }>;
  state: { labels: string[]; state: string };
  expired: number[];
}

function harness(
  labels: string[],
  mode: LifecycleMode,
  opts: {
    viewFails?: boolean;
    writeFails?: boolean;
    noApply?: boolean;
    pr?: { number: number; state: string; body: string } | null;
    dc?: { exists: boolean; status: string } | null;
  } = {},
): Harness {
  const h: Harness = { deps: undefined as never, journal: [], edits: [], closes: [], state: { labels: [...labels], state: "OPEN" }, expired: [] };
  const row = () => ({
    number: 10, title: "t", url: "u", createdAt: "", body: "", labels: [...h.state.labels], state: h.state.state,
  });
  h.deps = {
    repo: "o/r",
    mode: async () => mode,
    view: async () => (opts.viewFails ? { ok: false, code: "gh-failed" } : { ok: true, row: row() }),
    edit: async (issue, l) => {
      h.edits.push({ issue, ...l });
      if (opts.writeFails) return { ok: false, code: "gh-failed", stderr: "boom" };
      if (!opts.noApply) h.state.labels = [...h.state.labels.filter((x) => !l.remove.includes(x)), ...l.add];
      return { ok: true };
    },
    close: async (issue, reason) => {
      h.closes.push({ issue, reason });
      h.state.state = "CLOSED";
      return { ok: true };
    },
    fetch: {
      designConcept: async () => (opts.dc ? { ok: true, value: opts.dc } : { ok: false }),
      pr: async () => (opts.pr ? { ok: true, value: opts.pr } : { ok: false }),
    },
    journal: {
      append: async (_r, _i, e) => { h.journal.push(e); return { ok: true }; },
      expireOnClose: async (_r, i) => { h.expired.push(i); return { ok: true }; },
      openClaim: async (_r, _i, claim) => ({ ok: true, claim }),
      closeClaim: async () => ({ ok: true, prior: null }),
    },
    now: () => 1000,
  };
  return h;
}

describe("seam spine (INV-3..6)", () => {
  test("legal ungated transition writes ONE edit, verifies and journals kind=transition", async () => {
    const h = harness(["ready-for-agent", "enhancement"], "shadow");
    const res = await advance({ issue: 10, to: "in-progress" }, h.deps);
    assert.deepEqual(res, {
      ok: true, issue: 10, from: "ready-for-agent", to: "in-progress", mode: "shadow",
      observed: { state: "OPEN", labels: ["enhancement", "in-progress"] },
    });
    assert.deepEqual(h.edits, [{ issue: 10, remove: ["ready-for-agent"], add: ["in-progress"] }]);
    assert.equal(h.journal.length, 1);
    assert.equal(h.journal[0].kind, "transition");
    assert.equal(h.journal[0].result, "ok");
    assert.equal(h.journal[0].source, "cli");
    assert.deepEqual(h.state.labels.sort(), ["enhancement", "in-progress"]);
  });

  test("shadow: an illegal transition STILL writes and journals one refused row", async () => {
    const h = harness(["needs-triage"], "shadow");
    const res = await advance({ issue: 10, to: "in-progress" }, h.deps);
    assert.equal(res.ok, true);
    assert.equal(res.ok && res.wouldRefuse, "illegal-transition");
    assert.equal(h.edits.length, 1);
    assert.equal(h.journal.length, 1);
    assert.equal(h.journal[0].kind, "refused");
    assert.equal(h.journal[0].result, "shadow-would-refuse:illegal-transition");
    assert.equal(h.journal[0].written, true);
  });

  test("enforce: the same transition is refused with no write", async () => {
    const h = harness(["needs-triage"], "enforce");
    const res = await advance({ issue: 10, to: "in-progress" }, h.deps);
    assert.deepEqual(res, { ok: false, issue: 10, code: "illegal-transition", mode: "enforce", written: false });
    assert.equal(h.edits.length, 0);
    assert.equal(h.journal[0].result, "refused:illegal-transition");
    assert.equal(h.journal[0].written, false);
  });

  for (const mode of ["shadow", "enforce"] as const) {
    for (const hold of ["ready-for-human", "parked", "hitl-grill", "needs-info"]) {
      test(`human-hold exit from ${hold} is refused in ${mode} with no write (INV-3)`, async () => {
        const h = harness([hold], mode);
        const res = await advance({ issue: 10, to: "ready-for-agent", reason: "scoped", rationale: "x" }, h.deps);
        assert.equal(res.ok, false);
        assert.equal("code" in res ? res.code : null, "human-hold-exit");
        assert.equal(h.edits.length, 0);
        assert.equal(h.closes.length, 0);
        assert.equal(h.journal[0].kind, "refused");
        assert.equal(h.journal[0].result, "refused:human-hold-exit");
      });
    }
  }

  test("a failed re-read refuses fetch-failed and never writes (INV-4)", async () => {
    const h = harness(["ready-for-agent"], "shadow", { viewFails: true });
    const res = await advance({ issue: 10, to: "in-progress" }, h.deps);
    assert.equal("code" in res ? res.code : null, "fetch-failed");
    assert.equal(h.edits.length, 0);
  });

  test("a failed gh write yields write-failed:<code>, written=false", async () => {
    const h = harness(["ready-for-agent"], "shadow", { writeFails: true });
    const res = await advance({ issue: 10, to: "in-progress" }, h.deps);
    assert.deepEqual(res, { ok: false, issue: 10, code: "write-failed:gh-failed", mode: "shadow", written: false });
    assert.equal(h.journal[0].result, "write-failed:gh-failed");
  });

  test("a write GitHub does not reflect yields write-unverified", async () => {
    const h = harness(["ready-for-agent"], "shadow", { noApply: true });
    const res = await advance({ issue: 10, to: "in-progress" }, h.deps);
    assert.equal("code" in res ? res.code : null, "write-unverified");
    assert.equal("written" in res ? res.written : null, true);
    assert.equal(h.journal[0].result, "write-unverified");
  });

  test("a gated transition's fetch failure is a would-refuse in shadow and a refusal in enforce", async () => {
    const shadow = harness(["in-progress"], "shadow");
    const s = await advance({ issue: 10, to: "needs-qa", evidence: { pr: "55" } }, shadow.deps);
    assert.equal(s.ok && s.wouldRefuse, "fetch-failed");
    const enforce = harness(["in-progress"], "enforce");
    const e = await advance({ issue: 10, to: "needs-qa", evidence: { pr: "55" } }, enforce.deps);
    assert.equal("code" in e ? e.code : null, "fetch-failed");
    assert.equal(enforce.edits.length, 0);
  });

  test("pr-open passes with a matching open PR", async () => {
    const h = harness(["in-progress"], "enforce", { pr: { number: 55, state: "OPEN", body: "Closes #10" } });
    const res = await advance({ issue: 10, to: "needs-qa", evidence: { pr: "55" } }, h.deps);
    assert.equal(res.ok, true);
    assert.equal(h.journal[0].kind, "transition");
    assert.deepEqual(h.journal[0].evidence, { pr: "55" });
  });

  test("dispatch with needs-design-concept and no artifact is refused in enforce", async () => {
    const h = harness(["ready-for-agent", "needs-design-concept"], "enforce", { dc: { exists: false, status: "" } });
    const res = await advance({ issue: 10, to: "in-progress" }, h.deps);
    assert.equal("code" in res ? res.code : null, "design-concept-missing");
  });

  test("closing uses ONE close call, verifies CLOSED, and starts journal retention", async () => {
    const h = harness(["in-progress"], "enforce", { pr: { number: 55, state: "MERGED", body: "Closes #10" } });
    const res = await advance({ issue: 10, to: "closed", evidence: { pr: "55" } }, h.deps);
    assert.equal(res.ok, true);
    assert.deepEqual(h.closes, [{ issue: 10, reason: "completed" }]);
    assert.equal(h.edits.length, 0);
    assert.deepEqual(h.expired, [10]);
  });

  test("a closed issue is refused in both modes; an unknown target is a usage refusal", async () => {
    const h = harness(["in-progress"], "shadow");
    h.state.state = "CLOSED";
    const res = await advance({ issue: 10, to: "needs-qa" }, h.deps);
    assert.equal("code" in res ? res.code : null, "issue-closed");
    const bad = await advance({ issue: 10, to: "nope" }, h.deps);
    assert.equal("code" in bad ? bad.code : null, "unknown-target-state");
  });

  test("two state labels are invalid: shadow writes and removes both, enforce refuses", async () => {
    const shadow = harness(["needs-qa", "in-progress"], "shadow");
    const s = await advance({ issue: 10, to: "needs-dev-resume" }, shadow.deps);
    assert.equal(s.ok && s.wouldRefuse, "state-ambiguous");
    assert.deepEqual(shadow.edits[0].remove.sort(), ["in-progress", "needs-qa"]);
    const enforce = harness(["needs-qa", "in-progress"], "enforce");
    const e = await advance({ issue: 10, to: "needs-dev-resume" }, enforce.deps);
    assert.equal("code" in e ? e.code : null, "state-ambiguous");
  });

  test("a judgment transition needs reason + rationale in enforce", async () => {
    const h = harness(["needs-triage"], "enforce");
    const bad = await advance({ issue: 10, to: "needs-research" }, h.deps);
    assert.equal("code" in bad ? bad.code : null, "reason-required");
    const ok = await advance({ issue: 10, to: "needs-research", reason: "unknown-root-cause", rationale: "cause unclear" }, h.deps);
    assert.equal(ok.ok, true);
  });
});

describe("claim / release (INV-11)", () => {
  test("claim journals claim-opened and changes no label; a held claim is reported", async () => {
    const h = harness(["in-progress"], "shadow");
    const res = await openClaim({ issue: 10, dispatchId: "d1", class: "dev_orch", run: "r1" }, h.deps);
    assert.equal(res.ok, true);
    assert.equal(h.journal[0].kind, "claim-opened");
    assert.equal(h.edits.length, 0);

    const held: SeamDeps = {
      ...h.deps,
      journal: { ...h.deps.journal, openClaim: async () => ({ ok: false, code: "claim-held", existing: null }) },
    };
    const second = await openClaim({ issue: 10, dispatchId: "d2", class: "dev_orch", run: "r1" }, held);
    assert.deepEqual(second, { ok: false, code: "claim-held", existing: null });
    assert.equal(h.journal.length, 1);
  });

  test("release journals claim-closed with the prior dispatch", async () => {
    const h = harness(["in-progress"], "shadow");
    const deps: SeamDeps = {
      ...h.deps,
      journal: {
        ...h.deps.journal,
        closeClaim: async () => ({ ok: true, prior: { dispatchId: "d1", class: "dev_orch", run: "r1", artifactHash: null, openedAt: 1 } }),
      },
    };
    const res = await releaseClaim(10, "d1", deps);
    assert.equal(res.ok, true);
    assert.equal(h.journal[0].kind, "claim-closed");
    assert.deepEqual(h.journal[0].evidence, { dispatch: "d1" });
  });
});

describe("QA round-1 fixes (#5310)", () => {
  test("close reason 'not-planned' (artifact spelling) is normalised and gated like 'not planned'", async () => {
    const h = harness(["in-progress"], "enforce");
    const refused = await advance({ issue: 10, to: "closed", closeReason: "not-planned" }, h.deps);
    assert.equal("code" in refused ? refused.code : null, "evidence-required:superseded-by");
    const ok = await advance({ issue: 10, to: "closed", closeReason: "not-planned", evidence: { "superseded-by": "#99" } }, h.deps);
    assert.equal(ok.ok, true);
    assert.deepEqual(h.closes, [{ issue: 10, reason: "not planned" }]);
  });

  test("sibling: an unknown close reason is still refused and 'completed' still needs a merged PR", async () => {
    const h = harness(["in-progress"], "enforce");
    const weird = await advance({ issue: 10, to: "closed", closeReason: "weird" }, h.deps);
    assert.equal("code" in weird ? weird.code : null, "close-reason-not-allowed");
    const noPr = await advance({ issue: 10, to: "closed", closeReason: "Completed" }, h.deps);
    assert.equal("code" in noPr ? noPr.code : null, "evidence-required:pr");
  });

  test("release forwards --dispatch ownership and surfaces an owner mismatch", async () => {
    const h = harness(["in-progress"], "shadow");
    const seen: string[] = [];
    const deps: SeamDeps = {
      ...h.deps,
      journal: {
        ...h.deps.journal,
        closeClaim: async (_r, _i, expected) => {
          seen.push(expected);
          return expected === "mine" ? { ok: true, prior: null } : { ok: false, error: "claim-owner-mismatch" };
        },
      },
    };
    assert.deepEqual(await releaseClaim(10, "other", deps, "cli"), { ok: false, code: "claim-owner-mismatch" });
    assert.equal(h.journal.length, 0);
    assert.equal((await releaseClaim(10, "mine", deps, "cli")).ok, true);
    assert.deepEqual(seen, ["other", "mine"]);
  });
});

describe("operator ruling round 4 (#5310): label-less issues", () => {
  test("enforce: a label-less issue moving to needs-triage passes the gate and writes", async () => {
    const h = harness(["enhancement"], "enforce");
    const res = await advance({ issue: 10, to: "needs-triage" }, h.deps);
    assert.deepEqual(res, {
      ok: true, issue: 10, from: null, to: "needs-triage", mode: "enforce",
      observed: { state: "OPEN", labels: ["enhancement", "needs-triage"] },
    });
    assert.deepEqual(h.edits, [{ issue: 10, remove: [], add: ["needs-triage"] }]);
    assert.equal(h.journal[0].kind, "transition");
    assert.equal(h.journal[0].result, "ok");
  });

  test("enforce: a label-less issue moving anywhere else is refused state-missing with no write", async () => {
    const h = harness(["enhancement"], "enforce");
    const res = await advance({ issue: 10, to: "in-progress" }, h.deps);
    assert.deepEqual(res, { ok: false, issue: 10, code: "state-missing", mode: "enforce", written: false });
    assert.equal(h.edits.length, 0);
    assert.equal(h.journal[0].result, "refused:state-missing");
  });

  test("enforce: more than one state label is refused state-ambiguous, even toward needs-triage", async () => {
    const h = harness(["needs-qa", "in-progress"], "enforce");
    const res = await advance({ issue: 10, to: "needs-triage" }, h.deps);
    assert.deepEqual(res, { ok: false, issue: 10, code: "state-ambiguous", mode: "enforce", written: false });
    assert.equal(h.edits.length, 0);
  });

  test("shadow: a label-less non-triage move writes through and reports wouldRefuse state-missing", async () => {
    const h = harness([], "shadow");
    const res = await advance({ issue: 10, to: "ready-for-agent" }, h.deps);
    assert.equal(res.ok && res.wouldRefuse, "state-missing");
    assert.equal(h.journal[0].result, "shadow-would-refuse:state-missing");
  });
});

// ---------------------------------------------------------------------------
// operatorAdvance / operatorReopen (ADR-0047 Decision 3, issue #5313)
// ---------------------------------------------------------------------------

function operatorHarness(labels: string[], mode: LifecycleMode, opts: { state?: string } = {}) {
  const h = harness(labels, mode);
  if (opts.state) h.state.state = opts.state;
  const indexed: Array<{ issue: number; e: LifecycleJournalEntry }> = [];
  const persisted: number[] = [];
  const reopens: number[] = [];
  h.deps.reopen = async (issue) => {
    reopens.push(issue);
    h.state.state = "OPEN";
    return { ok: true };
  };
  h.deps.journal.persist = async (_r, i) => { persisted.push(i); return { ok: true }; };
  h.deps.journal.recordHoldExit = async (_r, i, e) => { indexed.push({ issue: i, e }); return { ok: true }; };
  return { h, indexed, persisted, reopens };
}

describe("operatorAdvance — the operator-route entry point (#5313 INV-2..4, INV-8)", () => {
  for (const mode of ["shadow", "enforce"] as const) {
    test(`exits a human-hold state in ${mode} while advance() still refuses it`, async () => {
      const o = operatorHarness(["parked", "enhancement"], mode);
      const refused = await advance({ issue: 10, to: "ready-for-agent" }, o.h.deps);
      assert.equal(refused.ok, false);
      assert.equal((refused as any).code, "human-hold-exit");

      const res = await operatorAdvance({ issue: 10, to: "ready-for-agent", actor: "board:promote" }, o.h.deps);
      assert.equal(res.ok, true);
      assert.deepEqual(o.h.edits.at(-1), { issue: 10, remove: ["parked"], add: ["ready-for-agent"] });
      const last = o.h.journal.at(-1)!;
      assert.equal(last.kind, "transition");
      assert.equal(last.source, "operator-route");
      assert.equal(last.actor, "board:promote");
      assert.equal(last.from, "parked");
      // The sanctioned exit is never indexed as an unsanctioned hold exit.
      assert.equal(o.indexed.length, 0);
    });
  }

  test("agent-owned targets are illegal from the board, journaled as refused operator-route", async () => {
    const o = operatorHarness(["needs-triage"], "shadow");
    for (const to of ["in-progress", "needs-qa", "qa-passed", "parked"]) {
      const res = await operatorAdvance({ issue: 10, to, actor: "board:relabel" }, o.h.deps);
      assert.equal(res.ok, false, to);
      assert.equal((res as any).code, "illegal-transition", to);
    }
    assert.equal(o.h.edits.length, 0);
    assert.ok(o.h.journal.every((e) => e.kind === "refused" && e.source === "operator-route"));
  });

  test("repairs state-missing and state-ambiguous in ONE edit; journal from is comma-joined / null", async () => {
    const none = operatorHarness(["enhancement"], "enforce");
    const r0 = await operatorAdvance({ issue: 10, to: "needs-triage", actor: "board:relabel" }, none.h.deps);
    assert.equal(r0.ok, true);
    assert.deepEqual(none.h.edits, [{ issue: 10, remove: [], add: ["needs-triage"] }]);
    assert.equal(none.h.journal[0].from, null);

    const many = operatorHarness(["needs-triage", "in-progress", "bug"], "enforce");
    const r2 = await operatorAdvance({ issue: 10, to: "blocked", actor: "board:relabel" }, many.h.deps);
    assert.equal(r2.ok, true);
    assert.equal(many.h.edits.length, 1);
    assert.deepEqual(many.h.edits[0].remove, ["needs-triage", "in-progress"]);
    assert.equal(many.h.journal[0].from, "needs-triage,in-progress");
    assert.deepEqual(many.h.state.labels.sort(), ["blocked", "bug"]);
  });

  test("close performs no label write and retains labels; a closed issue is refused", async () => {
    const o = operatorHarness(["hitl-grill"], "enforce");
    const res = await operatorAdvance({ issue: 10, to: "closed", closeReason: "not-planned", actor: "board:close" }, o.h.deps);
    assert.equal(res.ok, true);
    assert.deepEqual(o.h.closes, [{ issue: 10, reason: "not planned" }]);
    assert.equal(o.h.edits.length, 0);
    assert.deepEqual(res.ok && res.observed, { state: "CLOSED", labels: ["hitl-grill"] });
    assert.deepEqual(o.h.expired, [10]);

    const again = await operatorAdvance({ issue: 10, to: "needs-triage", actor: "board:relabel" }, o.h.deps);
    assert.equal((again as any).code, "issue-closed");
  });

  test("a failed re-read refuses fetch-failed with no write", async () => {
    const h = harness(["parked"], "enforce", { viewFails: true });
    const res = await operatorAdvance({ issue: 10, to: "needs-triage", actor: "board:relabel" }, h.deps);
    assert.equal((res as any).code, "fetch-failed");
    assert.equal(h.edits.length, 0);
  });
});

describe("operatorReopen (#5313 INV-8)", () => {
  test("reopens, PERSISTS the journal, then journals from closed with source operator-route", async () => {
    const o = operatorHarness(["needs-triage"], "enforce", { state: "CLOSED" });
    const res = await operatorReopen({ issue: 10, actor: "board:reopen" }, o.h.deps);
    assert.equal(res.ok, true);
    assert.deepEqual(o.reopens, [10]);
    assert.deepEqual(o.persisted, [10]);
    assert.equal(o.h.journal[0].from, "closed");
    assert.equal(o.h.journal[0].to, "needs-triage");
    assert.equal(o.h.journal[0].source, "operator-route");
  });

  test("a reopen the re-read does not confirm is write-unverified", async () => {
    const o = operatorHarness(["needs-triage"], "enforce", { state: "CLOSED" });
    o.h.deps.reopen = async () => ({ ok: true });
    const res = await operatorReopen({ issue: 10, actor: "board:reopen" }, o.h.deps);
    assert.equal((res as any).code, "write-unverified");
  });
});

describe("journalEntry — the single append point indexes unsanctioned hold exits (#5313 INV-10)", () => {
  const base: LifecycleJournalEntry = {
    v: 1, ts: 5, kind: "external", from: "ready-for-human", to: "ready-for-agent", source: "external",
    actor: "x", evidence: {}, reason: null, rationale: null, result: "ok", written: true,
  };

  test("an external hold exit is appended AND indexed; operator-route and refused rows are not", async () => {
    const o = operatorHarness([], "enforce");
    await journalEntry(o.h.deps, 10, base);
    await journalEntry(o.h.deps, 10, { ...base, source: "operator-route", kind: "transition" });
    await journalEntry(o.h.deps, 10, { ...base, kind: "refused", written: false });
    await journalEntry(o.h.deps, 10, { ...base, from: "needs-triage" });
    assert.equal(o.h.journal.length, 4);
    assert.equal(o.indexed.length, 1);
    assert.equal(o.indexed[0].issue, 10);
  });
});
