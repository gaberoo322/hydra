/**
 * The `qa-verdict` gate and the `needs-qa -> qa-passed | needs-dev-resume |
 * ready-for-agent` transitions (ADR-0047 D2/D4/D6, issue #5317): the pure
 * classifier, the gate, the transition table rows, and the seam wiring
 * (including the trailer-sourced `qa-fail-rounds` park) — all offline.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  advance,
  classifyQaVerdictTarget,
  evaluateGate,
  findTransition,
  gateQaVerdict,
  recordsNeeded,
  type GateInput,
  type LifecycleMode,
  type QaLivePr,
  type SeamDeps,
} from "../src/lifecycle/index.ts";
import { isPassVerdict } from "../src/qa/verdict-trailer.ts";
import type { LifecycleJournalEntry } from "../src/redis/lifecycle-journal.ts";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const SHA12 = HEAD.slice(0, 12);
const ENTERED = Date.parse("2026-11-04T10:00:00Z");
const AFTER = ENTERED + 60_000;
const BEFORE = ENTERED - 60_000;
const NOW = Date.parse("2026-11-04T12:00:00Z");

const trailer = (verdict: string, round = 1, sha = SHA12, pr = 7) =>
  `QA-Verdict: ${verdict} pr=${pr} round=${round} sha=${sha} blockers=1 max_severity=high`;
/** A reviewed FAIL round body: a findings table plus the trailer. */
const failBody = (round: number) => `### Findings\n| x |\n\n## Standards\n${trailer("FAIL", round)}`;

function live(over: Partial<QaLivePr> = {}): QaLivePr {
  return {
    number: 7, state: "OPEN", isDraft: false, mergeStateStatus: "CLEAN", headSha: HEAD, checks: "green",
    bodies: [], timedBodies: [], ...over,
  };
}
const timed = (body: string, createdAtMs: number | null = AFTER) => ({ body, createdAtMs });

describe("isPassVerdict", () => {
  test("PASS and PASS-pending-CI are passes; the FAIL literals are not", () => {
    assert.equal(isPassVerdict("PASS"), true);
    assert.equal(isPassVerdict("PASS-pending-CI"), true);
    assert.equal(isPassVerdict("FAIL"), false);
    assert.equal(isPassVerdict("FAIL-pending-CI"), false);
  });
});

describe("classifyQaVerdictTarget (INV-3)", () => {
  test("PASS and PASS-pending-CI at head on an OPEN PR route to qa-passed", () => {
    for (const v of ["PASS", "PASS-pending-CI"]) {
      assert.deepEqual(classifyQaVerdictTarget(live({ timedBodies: [timed(trailer(v))] }), ENTERED), { ok: true, target: "qa-passed" });
    }
  });

  test("FAIL at head: OPEN -> needs-dev-resume, CLOSED unmerged -> ready-for-agent", () => {
    for (const v of ["FAIL", "FAIL-pending-CI"]) {
      const t = [timed(trailer(v))];
      assert.deepEqual(classifyQaVerdictTarget(live({ timedBodies: t }), ENTERED), { ok: true, target: "needs-dev-resume" });
      assert.deepEqual(classifyQaVerdictTarget(live({ state: "CLOSED", timedBodies: t }), ENTERED), { ok: true, target: "ready-for-agent" });
    }
  });

  test("MERGED refuses pr-merged (reconcile owns it)", () => {
    assert.deepEqual(classifyQaVerdictTarget(live({ state: "MERGED", timedBodies: [timed(trailer("PASS"))] }), ENTERED), { ok: false, code: "pr-merged" });
  });

  test("no trailer, a trailer at another sha, or one naming another PR is qa-verdict-missing", () => {
    assert.deepEqual(classifyQaVerdictTarget(live(), ENTERED), { ok: false, code: "qa-verdict-missing" });
    assert.deepEqual(classifyQaVerdictTarget(live({ timedBodies: [timed(trailer("PASS", 1, "ffffffffffff"))] }), ENTERED), { ok: false, code: "qa-verdict-missing" });
    assert.deepEqual(classifyQaVerdictTarget(live({ timedBodies: [timed(trailer("PASS", 1, SHA12, 8))] }), ENTERED), { ok: false, code: "qa-verdict-missing" });
    assert.deepEqual(classifyQaVerdictTarget(live({ timedBodies: [timed(trailer("PASS", 1, "unknown"))] }), ENTERED), { ok: false, code: "qa-verdict-missing" });
  });

  test("a verdict at head that predates entry into needs-qa (or has no readable time) is qa-verdict-stale", () => {
    assert.deepEqual(classifyQaVerdictTarget(live({ timedBodies: [timed(trailer("PASS"), BEFORE)] }), ENTERED), { ok: false, code: "qa-verdict-stale" });
    assert.deepEqual(classifyQaVerdictTarget(live({ timedBodies: [timed(trailer("PASS"), ENTERED)] }), ENTERED), { ok: false, code: "qa-verdict-stale" });
    assert.deepEqual(classifyQaVerdictTarget(live({ timedBodies: [timed(trailer("PASS"), null)] }), ENTERED), { ok: false, code: "qa-verdict-stale" });
  });

  test("the LATEST trailer at head decides", () => {
    const t = [timed(trailer("FAIL", 1)), timed(trailer("PASS", 2))];
    assert.deepEqual(classifyQaVerdictTarget(live({ timedBodies: t }), ENTERED), { ok: true, target: "qa-passed" });
    const t2 = [timed(trailer("PASS", 1)), timed(trailer("FAIL", 2))];
    assert.deepEqual(classifyQaVerdictTarget(live({ timedBodies: t2 }), ENTERED), { ok: true, target: "needs-dev-resume" });
  });

  test("absent timedBodies (an older fetcher) fails closed as missing", () => {
    const l = live();
    delete l.timedBodies;
    assert.deepEqual(classifyQaVerdictTarget(l, ENTERED), { ok: false, code: "qa-verdict-missing" });
  });
});

describe("gateQaVerdict (INV-3, INV-12)", () => {
  const input = (over: Partial<GateInput> = {}): GateInput => ({
    issue: 10, from: "needs-qa", to: "qa-passed", flags: [], evidence: { pr: "7" }, ...over,
  });
  const recs = (over: Record<string, unknown> = {}) => ({
    qaLive: { ok: true as const, value: live({ timedBodies: [timed(trailer("PASS"))] }) },
    stateEntry: { ok: true as const, value: { enteredAtMs: ENTERED } },
    ...over,
  });

  test("passes on a PASS at head after entry", () => {
    assert.deepEqual(gateQaVerdict(input(), recs()), { ok: true, code: "ok" });
  });

  test("refusal codes", () => {
    assert.equal(gateQaVerdict(input({ evidence: {} }), recs()).code, "evidence-required:pr");
    assert.equal(gateQaVerdict(input(), recs({ qaLive: undefined })).code, "fetch-failed");
    assert.equal(gateQaVerdict(input(), recs({ qaLive: { ok: false } })).code, "fetch-failed");
    assert.equal(gateQaVerdict(input(), recs({ stateEntry: { ok: false } })).code, "fetch-failed");
    assert.equal(gateQaVerdict(input({ evidence: { pr: "8" } }), recs()).code, "record-binding-mismatch");
    assert.equal(gateQaVerdict(input(), recs({ stateEntry: { ok: true, value: { enteredAtMs: null } } })).code, "state-entry-unknown");
    assert.equal(gateQaVerdict(input(), recs({ qaLive: { ok: true, value: live() } })).code, "qa-verdict-missing");
    assert.equal(gateQaVerdict(input(), recs({ qaLive: { ok: true, value: live({ timedBodies: [timed(trailer("PASS"), BEFORE)] }) } })).code, "qa-verdict-stale");
  });

  test("a requested target that differs from the classified one is qa-verdict-mismatch", () => {
    assert.equal(gateQaVerdict(input({ to: "needs-dev-resume" }), recs()).code, "qa-verdict-mismatch");
  });

  test("evaluateGate dispatches the id and recordsNeeded asks for qaLive + stateEntry", () => {
    assert.equal(evaluateGate("qa-verdict", input(), recs()).ok, true);
    const n = recordsNeeded("qa-verdict");
    assert.equal(n.qaLive && n.stateEntry, true);
    assert.equal(recordsNeeded("qa-exit").stateEntry, false);
  });
});

describe("transition table rows (INV-4)", () => {
  test("the three needs-qa verdict exits are agent-fired through the qa-verdict gate", () => {
    for (const to of ["qa-passed", "needs-dev-resume", "ready-for-agent"] as const) {
      const t = findTransition("needs-qa", to);
      assert.equal(t?.gate, "qa-verdict", to);
      assert.equal(t?.firedBy, "agent", to);
    }
  });

  test("qa-passed exits stay reconcile-fired via qa-exit", () => {
    for (const to of ["needs-dev-resume", "needs-qa", "ready-for-agent"] as const) {
      assert.equal(findTransition("qa-passed", to)?.gate, "qa-exit", to);
    }
  });
});

// ---------------------------------------------------------------------------
// Seam wiring
// ---------------------------------------------------------------------------

interface World {
  deps: SeamDeps;
  journal: LifecycleJournalEntry[];
  edits: Array<{ issue: number; remove: string[]; add: string[] }>;
  comments: Array<{ number: number; body: string }>;
  labels: string[];
  pr: QaLivePr;
  prBodies: string[];
}

function world(mode: LifecycleMode, pr: QaLivePr, prBodies: string[] = []): World {
  const w: World = { journal: [], edits: [], comments: [], labels: ["needs-qa"], pr, prBodies, deps: undefined as unknown as SeamDeps };
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
    comment: async (number, body) => (w.comments.push({ number, body }), { ok: true }),
    env: () => ({}),
    fetch: {
      designConcept: async () => ({ ok: true, value: { exists: true, status: "approved" } }),
      pr: async () => ({ ok: false }),
      comment: async () => ({ ok: false }),
      stateEntry: async () => ({ ok: true, value: { enteredAtMs: ENTERED } }),
      issueComments: async () => ({ ok: true, value: [] }),
      timeline: async () => ({ ok: true, value: [] }),
      prBodies: async () => ({ ok: true, value: w.prBodies }),
      qaLive: async () => ({ ok: true, value: w.pr }),
    },
    journal: {
      append: async (_r, _i, e) => (w.journal.push(e), { ok: true }),
      expireOnClose: async () => ({ ok: true }),
      openClaim: async (_r, _i, c) => ({ ok: true, claim: c }),
      closeClaim: async () => ({ ok: true, prior: null }),
      read: async () => ({ ok: true, entries: [...w.journal] }),
      readClaim: async () => ({ ok: true, claim: null }),
    },
    now: () => NOW,
  };
  return w;
}

describe("advance needs-qa -> verdict targets", () => {
  test("PASS in enforce: writes qa-passed (never in-progress)", async () => {
    const w = world("enforce", live({ timedBodies: [timed(trailer("PASS"))] }));
    const res = await advance({ issue: 10, to: "qa-passed", evidence: { pr: "7" }, actor: "hydra-qa" }, w.deps);
    assert.equal(res.ok, true);
    assert.deepEqual(w.edits, [{ issue: 10, remove: ["needs-qa"], add: ["qa-passed"] }]);
  });

  test("enforce without a trailer at head refuses qa-verdict-missing and writes nothing", async () => {
    const w = world("enforce", live());
    const res = await advance({ issue: 10, to: "qa-passed", evidence: { pr: "7" } }, w.deps);
    assert.deepEqual({ ok: res.ok, code: (res as { code?: string }).code }, { ok: false, code: "qa-verdict-missing" });
    assert.deepEqual(w.edits, []);
  });

  test("shadow without a trailer still writes and journals shadow-would-refuse", async () => {
    const w = world("shadow", live());
    const res = await advance({ issue: 10, to: "qa-passed", evidence: { pr: "7" } }, w.deps);
    assert.equal(res.ok, true);
    assert.equal((res as { wouldRefuse?: string }).wouldRefuse, "qa-verdict-missing");
    assert.equal(w.journal.at(-1)!.result, "shadow-would-refuse:qa-verdict-missing");
  });

  test("a 1st reviewed FAIL bounces to needs-dev-resume with no cap park", async () => {
    const w = world("enforce", live({ timedBodies: [timed(failBody(1))] }), [failBody(1)]);
    const res = await advance({ issue: 10, to: "needs-dev-resume", evidence: { pr: "7" } }, w.deps);
    assert.equal(res.ok, true);
    assert.equal((res as { wouldPark?: string }).wouldPark, undefined);
    assert.deepEqual(w.edits, [{ issue: 10, remove: ["needs-qa"], add: ["needs-dev-resume"] }]);
  });

  test("FAIL with the PR CLOSED unmerged routes to ready-for-agent", async () => {
    const w = world("enforce", live({ state: "CLOSED", timedBodies: [timed(failBody(1))] }), [failBody(1)]);
    const res = await advance({ issue: 10, to: "ready-for-agent", evidence: { pr: "7" } }, w.deps);
    assert.equal(res.ok, true);
    assert.deepEqual(w.edits, [{ issue: 10, remove: ["needs-qa"], add: ["ready-for-agent"] }]);
  });
});

describe("the 3rd reviewed FAIL parks through the seam (INV-5, INV-6)", () => {
  const three = [failBody(1), failBody(2), failBody(3)];
  const liveThree = () => live({ timedBodies: [timed(failBody(3))] });

  test("enforce: parks needs-qa -> parked in the same call with the unified comment; needs-dev-resume is never written", async () => {
    const w = world("enforce", liveThree(), three);
    const res = await advance({ issue: 10, to: "needs-dev-resume", evidence: { pr: "7" }, actor: "hydra-qa" }, w.deps);
    assert.deepEqual(
      { ok: res.ok, code: (res as { code?: string }).code, written: (res as { written?: boolean }).written },
      { ok: false, code: "parked:qa-fail-rounds", written: true },
    );
    assert.deepEqual(w.edits, [{ issue: 10, remove: ["needs-qa"], add: ["parked"] }]);
    assert.ok(w.comments.some((c) => c.number === 10 && c.body.includes("## Hydra cap park")));
    assert.ok(!w.labels.includes("ready-for-human"));
  });

  test("shadow: bounces, reports wouldPark, and journals shadow-would-park for the PR", async () => {
    const w = world("shadow", liveThree(), three);
    const res = await advance({ issue: 10, to: "needs-dev-resume", evidence: { pr: "7" } }, w.deps);
    assert.equal(res.ok, true);
    assert.equal((res as { wouldPark?: string }).wouldPark, "qa-fail-rounds");
    assert.deepEqual(w.edits, [{ issue: 10, remove: ["needs-qa"], add: ["needs-dev-resume"] }]);
    const shadow = w.journal.find((e) => e.result === "shadow-would-park:qa-fail-rounds")!;
    assert.equal(shadow.evidence.pr, "7");
  });

  test("the playbook's explicit shadow follow-up (needs-dev-resume -> parked, cap: reason) is a legal transition", async () => {
    const w = world("shadow", liveThree(), three);
    w.labels = ["needs-dev-resume"];
    const res = await advance({ issue: 10, to: "parked", reason: "cap:qa-fail-rounds", rationale: "3 reviewed FAIL rounds" }, w.deps);
    assert.equal(res.ok, true);
    assert.deepEqual(w.edits, [{ issue: 10, remove: ["needs-dev-resume"], add: ["parked"] }]);
  });

  test("a CI-only FAIL round (no findings table) never counts toward the cap", async () => {
    const ciOnly = (r: number) => trailer("FAIL-pending-CI", r);
    const w = world("enforce", live({ timedBodies: [timed(ciOnly(3))] }), [ciOnly(1), ciOnly(2), ciOnly(3)]);
    const res = await advance({ issue: 10, to: "needs-dev-resume", evidence: { pr: "7" } }, w.deps);
    assert.equal(res.ok, true);
    assert.deepEqual(w.edits, [{ issue: 10, remove: ["needs-qa"], add: ["needs-dev-resume"] }]);
  });

  test("a Hydra-Cap-Reset marker restarts the count", async () => {
    const bodies = [failBody(1), failBody(2), "Hydra-Cap-Reset: by=op ts=2026-11-04T09:00:00Z", failBody(3)];
    const w = world("enforce", liveThree(), bodies);
    const res = await advance({ issue: 10, to: "needs-dev-resume", evidence: { pr: "7" } }, w.deps);
    assert.equal(res.ok, true);
    assert.equal(w.edits[0].add[0], "needs-dev-resume");
  });
});

describe("QA-FAIL round-1 fixes (#5317 PR #5377)", () => {
  test("INV-3 latest trailer is chosen by post time, not array order", () => {
    // newer comment FAIL listed first, stale review PASS listed last
    const t = [timed(trailer("FAIL", 2), AFTER + 5000), timed(trailer("PASS", 1), AFTER)];
    assert.deepEqual(classifyQaVerdictTarget(live({ timedBodies: t }), ENTERED), { ok: true, target: "needs-dev-resume" });
    // sibling shape: ordered input keeps its old verdict
    const ordered = [timed(trailer("FAIL", 1), AFTER), timed(trailer("PASS", 2), AFTER + 5000)];
    assert.deepEqual(classifyQaVerdictTarget(live({ timedBodies: ordered }), ENTERED), { ok: true, target: "qa-passed" });
  });

  test("defer arm: trailer-less advance in enforce routes by live PR state (red without the defer gate)", async () => {
    const w = world("enforce", live());
    const res = await advance({ issue: 10, to: "needs-dev-resume", evidence: { pr: "7", defer: "1" }, actor: "hydra-qa" }, w.deps);
    assert.equal(res.ok, true);
    assert.deepEqual(w.edits, [{ issue: 10, remove: ["needs-qa"], add: ["needs-dev-resume"] }]);
    const w2 = world("enforce", live({ state: "CLOSED" }));
    assert.equal((await advance({ issue: 10, to: "ready-for-agent", evidence: { pr: "7", defer: "1" } }, w2.deps)).ok, true);
  });

  test("defer evidence never admits qa-passed, a wrong lane, or a merged PR; no defer still needs a trailer", async () => {
    const w = world("enforce", live());
    const r1 = await advance({ issue: 10, to: "qa-passed", evidence: { pr: "7", defer: "1" } }, w.deps);
    assert.equal((r1 as { code?: string }).code, "qa-verdict-mismatch");
    const r2 = await advance({ issue: 10, to: "ready-for-agent", evidence: { pr: "7", defer: "1" } }, w.deps);
    assert.equal((r2 as { code?: string }).code, "qa-verdict-mismatch");
    const wm = world("enforce", live({ state: "MERGED" }));
    const r3 = await advance({ issue: 10, to: "needs-dev-resume", evidence: { pr: "7", defer: "1" } }, wm.deps);
    assert.equal((r3 as { code?: string }).code, "pr-merged");
    const r4 = await advance({ issue: 10, to: "needs-dev-resume", evidence: { pr: "7" } }, w.deps);
    assert.equal((r4 as { code?: string }).code, "qa-verdict-missing");
    assert.deepEqual(w.edits, []);
  });

  test("closed-PR FAIL edge runs the qa-fail-rounds cap (3rd FAIL parks); a defer never does", async () => {
    const three = [failBody(1), failBody(2), failBody(3)];
    const w = world("enforce", live({ state: "CLOSED", timedBodies: [timed(failBody(3))] }), three);
    const res = await advance({ issue: 10, to: "ready-for-agent", evidence: { pr: "7" }, actor: "hydra-qa" }, w.deps);
    assert.equal((res as { code?: string }).code, "parked:qa-fail-rounds");
    assert.deepEqual(w.edits, [{ issue: 10, remove: ["needs-qa"], add: ["parked"] }]);
    const wd = world("enforce", live({ state: "CLOSED" }), three);
    const rd = await advance({ issue: 10, to: "ready-for-agent", evidence: { pr: "7", defer: "1" } }, wd.deps);
    assert.equal(rd.ok, true);
  });
});
