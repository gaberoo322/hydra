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
  qaBounce,
  recordsNeeded,
  type GateInput,
  type LifecycleMode,
  type QaLivePr,
  type SeamDeps,
  type TimedBody,
} from "../src/lifecycle/index.ts";
import { isPassVerdict } from "../src/qa/verdict-trailer.ts";
import type { LifecycleJournalEntry } from "../src/redis/lifecycle-journal.ts";

/** Untimed strings count as newer than any reset (the fail-toward-counting rule). */
const timedBodies = (bs: Array<string | TimedBody>): TimedBody[] =>
  bs.map((b) => (typeof b === "string" ? { body: b, tsMs: null } : b));

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
  prBodies: Array<string | TimedBody>;
}

function world(mode: LifecycleMode, pr: QaLivePr, prBodies: Array<string | TimedBody> = []): World {
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
      prBodies: async () => ({ ok: true, value: timedBodies(w.prBodies) }),
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

  test("enforce: a valid T4 FAIL trailer with unreadable PR bodies refuses fetch-failed and writes nothing (the bounce would be uncounted)", async () => {
    const w = world("enforce", live({ timedBodies: [timed(failBody(1))] }), [failBody(1)]);
    w.deps.fetch.prBodies = async () => ({ ok: false });
    const res = (await advance({ issue: 10, to: "needs-dev-resume", evidence: { pr: "7", t4: "1" } }, w.deps)) as { ok: boolean; code?: string };
    assert.deepEqual({ ok: res.ok, code: res.code }, { ok: false, code: "fetch-failed" });
    assert.deepEqual(w.edits, []);
  });

  test("sibling shape: enforce, non-T4, unreadable PR bodies still bounces (a transient read failure must not refuse a T1-T3 FAIL)", async () => {
    const w = world("enforce", live({ timedBodies: [timed(failBody(1))] }), [failBody(1)]);
    w.deps.fetch.prBodies = async () => ({ ok: false });
    const res = await advance({ issue: 10, to: "needs-dev-resume", evidence: { pr: "7" } }, w.deps);
    assert.equal(res.ok, true);
    assert.deepEqual(w.edits, [{ issue: 10, remove: ["needs-qa"], add: ["needs-dev-resume"] }]);
  });

  test("sibling shape: shadow mode with unreadable PR bodies still bounces (INV-12, never refuse on a degraded read outside enforce)", async () => {
    const w = world("shadow", live({ timedBodies: [timed(failBody(1))] }), [failBody(1)]);
    w.deps.fetch.prBodies = async () => ({ ok: false });
    const res = await advance({ issue: 10, to: "needs-dev-resume", evidence: { pr: "7" } }, w.deps);
    assert.equal(res.ok, true);
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

  test("shadow: qa-fail-rounds is a live arm - parks exactly as in enforce, the park entry tagged mode=shadow live=1", async () => {
    const w = world("shadow", liveThree(), three);
    const res = await advance({ issue: 10, to: "needs-dev-resume", evidence: { pr: "7" }, actor: "hydra-qa" }, w.deps);
    assert.deepEqual(
      { ok: res.ok, code: (res as { code?: string }).code, written: (res as { written?: boolean }).written },
      { ok: false, code: "parked:qa-fail-rounds", written: true },
    );
    assert.deepEqual(w.edits, [{ issue: 10, remove: ["needs-qa"], add: ["parked"] }]);
    assert.equal(w.comments.filter((c) => c.number === 10 && c.body.includes("## Hydra cap park")).length, 1, "unified comment exactly once");
    const park = w.journal.find((e) => e.result === "parked:qa-fail-rounds")!;
    assert.equal(park.evidence.mode, "shadow");
    assert.equal(park.evidence.live, "1");
    assert.ok(!w.journal.some((e) => e.result.startsWith("shadow-would-park")), "a live park is not a would-park");
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
    const resetTs = Date.parse("2026-11-04T09:00:00Z");
    const bodies: TimedBody[] = [
      { body: failBody(1), tsMs: resetTs - 2000 },
      { body: failBody(2), tsMs: resetTs - 1000 },
      { body: "Hydra-Cap-Reset: by=op ts=2026-11-04T09:00:00Z", tsMs: resetTs },
      { body: failBody(3), tsMs: resetTs + 1000 },
    ];
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
    assert.equal((await advance({ issue: 10, to: "ready-for-agent", evidence: { pr: "7", defer: "1" }, actor: "hydra-qa" }, w2.deps)).ok, true);
  });

  test("defer evidence never admits qa-passed, a wrong lane, or a merged PR; no defer still needs a trailer", async () => {
    const w = world("enforce", live());
    const r1 = await advance({ issue: 10, to: "qa-passed", evidence: { pr: "7", defer: "1" }, actor: "hydra-qa" }, w.deps);
    assert.equal((r1 as { code?: string }).code, "qa-verdict-mismatch");
    const r2 = await advance({ issue: 10, to: "ready-for-agent", evidence: { pr: "7", defer: "1" }, actor: "hydra-qa" }, w.deps);
    assert.equal((r2 as { code?: string }).code, "qa-verdict-mismatch");
    const wm = world("enforce", live({ state: "MERGED" }));
    const r3 = await advance({ issue: 10, to: "needs-dev-resume", evidence: { pr: "7", defer: "1" }, actor: "hydra-qa" }, wm.deps);
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
    const rd = await advance({ issue: 10, to: "ready-for-agent", evidence: { pr: "7", defer: "1" }, actor: "hydra-qa" }, wd.deps);
    assert.equal(rd.ok, true);
  });
});

describe("QA-FAIL round-3 fixes (#5317 PR #5377)", () => {
  test("defer=1 is accepted only from actor hydra-qa (red without the actor check)", async () => {
    for (const actor of [undefined, "cli", "hydra-dev"]) {
      const w = world("enforce", live());
      const res = await advance({ issue: 10, to: "needs-dev-resume", evidence: { pr: "7", defer: "1" }, ...(actor ? { actor } : {}) }, w.deps);
      assert.equal((res as { code?: string }).code, "defer-actor-not-allowed", `actor=${actor}`);
      assert.deepEqual(w.edits, []);
    }
    // sibling shape: hydra-qa keeps its old verdict
    const ok = world("enforce", live());
    const res = await advance({ issue: 10, to: "needs-dev-resume", evidence: { pr: "7", defer: "1" }, actor: "hydra-qa" }, ok.deps);
    assert.equal(res.ok, true);
  });

  test("gateQaVerdict unit: defer from hydra-qa passes, from anyone else is refused", () => {
    const records = { qaLive: { ok: true as const, value: live() }, stateEntry: { ok: true as const, value: { enteredAtMs: ENTERED } } };
    const base = { issue: 10, from: "needs-qa" as const, to: "needs-dev-resume" as const, flags: [], evidence: { pr: "7", defer: "1" } };
    assert.equal(gateQaVerdict({ ...base, actor: "hydra-qa" }, records).ok, true);
    assert.equal(gateQaVerdict({ ...base, actor: "hydra-dev" }, records).code, "defer-actor-not-allowed");
    assert.equal(gateQaVerdict(base, records).code, "defer-actor-not-allowed");
  });

  test("missing needs-qa entry time falls back to the timeline (red without the fallback)", async () => {
    const w = world("enforce", live({ timedBodies: [timed(trailer("PASS"))] }));
    w.deps.fetch.stateEntry = async () => ({ ok: true, value: { enteredAtMs: null } });
    w.deps.fetch.timeline = async () => ({
      ok: true,
      value: [{ event: "labeled", label: "needs-qa", tsMs: ENTERED }],
    });
    const res = await advance({ issue: 10, to: "qa-passed", evidence: { pr: "7" }, actor: "hydra-qa" }, w.deps);
    assert.equal(res.ok, true);
    assert.deepEqual(w.edits, [{ issue: 10, remove: ["needs-qa"], add: ["qa-passed"] }]);
  });

  test("sibling: no entry time anywhere (journal AND timeline) still refuses state-entry-unknown", async () => {
    const w = world("enforce", live({ timedBodies: [timed(trailer("PASS"))] }));
    w.deps.fetch.stateEntry = async () => ({ ok: true, value: { enteredAtMs: null } });
    const res = await advance({ issue: 10, to: "qa-passed", evidence: { pr: "7" }, actor: "hydra-qa" }, w.deps);
    assert.equal((res as { code?: string }).code, "state-entry-unknown");
    assert.deepEqual(w.edits, []);
  });
});

describe("qaBounce: the seam picks a QA FAIL's exit from one live read (#5659)", () => {
  /** Counts every qaLive fetch; `states` is served one per read, the last repeating. */
  function counted(w: World, states: string[]): { reads: () => number } {
    let n = 0;
    w.deps.fetch.qaLive = async () => {
      const state = states[Math.min(n, states.length - 1)] as string;
      n += 1;
      return { ok: true, value: { ...w.pr, state } };
    };
    return { reads: () => n };
  }
  const failed = () => live({ timedBodies: [timed(failBody(1))] });
  const input = { issue: 10, pr: 7, actor: "hydra-qa" };

  test("OPEN -> needs-dev-resume, CLOSED -> ready-for-agent, each with exactly one live read", async () => {
    for (const [state, to] of [["OPEN", "needs-dev-resume"], ["CLOSED", "ready-for-agent"]] as const) {
      const w = world("enforce", failed(), [failBody(1)]);
      const c = counted(w, [state]);
      assert.deepEqual(await qaBounce(input, w.deps), { ok: true, to });
      assert.deepEqual(w.edits, [{ issue: 10, remove: ["needs-qa"], add: [to] }]);
      assert.equal(c.reads(), 1, `${state}: one PR-state read chooses the exit`);
    }
  });

  test("a MERGED PR is the pr-merged code and writes nothing", async () => {
    const w = world("enforce", failed(), [failBody(1)]);
    counted(w, ["MERGED"]);
    assert.deepEqual(await qaBounce(input, w.deps), { ok: false, code: "pr-merged" });
    assert.deepEqual(w.edits, []);
  });

  test("a PR that closes between the old two reads cannot mismatch: the one read decides", async () => {
    const w = world("enforce", failed(), [failBody(1)]);
    const c = counted(w, ["OPEN", "CLOSED"]);
    assert.deepEqual(await qaBounce(input, w.deps), { ok: true, to: "needs-dev-resume" });
    assert.equal(c.reads(), 1, "no second read exists to disagree");
    assert.ok(w.journal.every((e) => !String(e.result).includes("qa-verdict-mismatch")));
  });

  test("the third reviewed FAIL parks with the arm counts the park comment renders", async () => {
    const three = [failBody(1), failBody(2), failBody(3)];
    const w = world("enforce", live({ timedBodies: [timed(failBody(3))] }), three);
    const res = await qaBounce(input, w.deps);
    assert.equal(res.ok, false);
    const parked = res as { code: string; counts?: ReadonlyArray<{ arm: string; count: number }> };
    assert.equal(parked.code, "parked:qa-fail-rounds");
    assert.equal(parked.counts?.find((c) => c.arm === "qa-fail-rounds")?.count, 3, "the counts are the ones parkForCap renders");
    assert.ok(w.comments.some((c) => c.body.includes("## Hydra cap park")));
    assert.deepEqual(w.edits, [{ issue: 10, remove: ["needs-qa"], add: ["parked"] }]);
  });

  test("defer evidence is the trailer-less bounce; an unreadable PR state refuses fetch-failed and a crash never throws", async () => {
    const w = world("enforce", live());
    assert.deepEqual(await qaBounce({ ...input, defer: true }, w.deps), { ok: true, to: "needs-dev-resume" });
    const wf = world("enforce", failed(), [failBody(1)]);
    wf.deps.fetch.qaLive = async () => ({ ok: false });
    assert.deepEqual(await qaBounce(input, wf.deps), { ok: false, code: "fetch-failed" });
    wf.deps.fetch.qaLive = async () => {
      throw new Error("boom");
    };
    assert.deepEqual(await qaBounce(input, wf.deps), { ok: false, code: "crashed" });
    assert.deepEqual(wf.edits, []);
  });
});

describe("the 2nd T4 deep-QA FAIL escalates through the deep-qa-fails Cap Arm (#5662)", () => {
  const MARK = "Verifier-Core deep-QA: FAIL";
  /** A T4 FAIL comment: the marker, plus a trailer for round `n` (so it also counts as a reviewed round). */
  const deepFail = (n: number) => `${failBody(n)}\n\n${MARK}`;
  const input = { issue: 10, pr: 7, actor: "hydra-qa" };

  test("the first T4 FAIL bounces", async () => {
    const w = world("enforce", live({ timedBodies: [timed(deepFail(1))] }), [deepFail(1)]);
    assert.deepEqual(await qaBounce(input, w.deps), { ok: true, to: "needs-dev-resume" });
    assert.deepEqual(w.edits, [{ issue: 10, remove: ["needs-qa"], add: ["needs-dev-resume"] }]);
  });

  test("the second escalates to ready-for-human with one unified cap comment, journaled cap:deep-qa-fails", async () => {
    const two = [deepFail(1), deepFail(2)];
    const w = world("enforce", live({ timedBodies: [timed(deepFail(2))] }), two);
    const res = await qaBounce(input, w.deps);
    assert.equal(res.ok, false);
    const out = res as { code: string; counts?: ReadonlyArray<{ arm: string; count: number }> };
    assert.equal(out.code, "escalated:deep-qa-fails");
    assert.equal(out.counts?.find((c) => c.arm === "deep-qa-fails")?.count, 2);
    assert.deepEqual(w.edits, [{ issue: 10, remove: ["needs-qa"], add: ["ready-for-human"] }]);
    assert.equal(w.comments.filter((c) => c.number === 10 && c.body.startsWith("## Hydra cap escalation")).length, 1);
    const entry = w.journal.find((e) => e.to === "ready-for-human")!;
    assert.equal(entry.reason, "cap:deep-qa-fails");
    assert.equal(entry.evidence["adr5-reason"], "t4-deep-qa-exhausted");
    assert.equal(entry.result, "escalated:deep-qa-fails");
  });

  test("shadow mode escalates too: deep-qa-fails is a live arm", async () => {
    const w = world("shadow", live({ timedBodies: [timed(deepFail(2))] }), [deepFail(1), deepFail(2)]);
    const res = await qaBounce(input, w.deps);
    assert.equal((res as { code?: string }).code, "escalated:deep-qa-fails");
    assert.deepEqual(w.edits, [{ issue: 10, remove: ["needs-qa"], add: ["ready-for-human"] }]);
  });

  test("a FAIL after an operator reset counts as the first again and bounces", async () => {
    const resetTs = Date.parse("2026-11-04T09:00:00Z");
    const bodies: TimedBody[] = [
      { body: deepFail(1), tsMs: resetTs - 2000 },
      { body: deepFail(2), tsMs: resetTs - 1000 },
      { body: "Hydra-Cap-Reset: by=op ts=2026-11-04T09:00:00Z", tsMs: resetTs },
      { body: deepFail(3), tsMs: resetTs + 1000 },
    ];
    const w = world("enforce", live({ timedBodies: [timed(deepFail(3))] }), bodies);
    assert.deepEqual(await qaBounce(input, w.deps), { ok: true, to: "needs-dev-resume" });
    assert.deepEqual(w.edits, [{ issue: 10, remove: ["needs-qa"], add: ["needs-dev-resume"] }]);
  });

  test("with both arms over their limits, the escalate row wins over the park row", async () => {
    const three = [deepFail(1), deepFail(2), deepFail(3)];
    const w = world("enforce", live({ timedBodies: [timed(deepFail(3))] }), three);
    const res = await qaBounce(input, w.deps);
    assert.equal((res as { code?: string }).code, "escalated:deep-qa-fails");
    assert.deepEqual(w.edits, [{ issue: 10, remove: ["needs-qa"], add: ["ready-for-human"] }]);
  });

  test("T1-T3 FAILs carry no marker: the 3rd reviewed FAIL still parks, never escalates", async () => {
    const three = [failBody(1), failBody(2), failBody(3)];
    const w = world("enforce", live({ timedBodies: [timed(failBody(3))] }), three);
    assert.equal(((await qaBounce(input, w.deps)) as { code?: string }).code, "parked:qa-fail-rounds");
    assert.deepEqual(w.edits, [{ issue: 10, remove: ["needs-qa"], add: ["parked"] }]);
  });
});
