/**
 * Lifecycle caps (ADR-0047 D6, issue #5314): the pure cap table + predicates in
 * src/lifecycle/caps.ts and their wiring into the writer seam (openClaim,
 * advance in-progress -> ready-for-agent, parkForCap, postCapReset). Offline:
 * every gh / Redis / clock effect is an in-memory SeamDeps fake.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  CAP_DEFAULTS,
  CAP_TABLE,
  buildSeedEvidence,
  capEnvName,
  classRole,
  countReviewedFailRoundsSinceReset,
  evaluateCaps,
  latestResetMs,
  parseCapResetTs,
  resolveCapLimits,
  timelineArmCounts,
  type CapJournalEntry,
} from "../src/lifecycle/caps.ts";
import { advance, openClaim, releaseClaim, type SeamDeps, type LifecycleMode } from "../src/lifecycle/seam.ts";
import { postCapReset } from "../src/lifecycle/park.ts";
import type { LifecycleJournalEntry } from "../src/redis/lifecycle-journal.ts";

const NOW = Date.parse("2026-11-04T12:00:00Z");
const LIMITS = { ...CAP_DEFAULTS };

function je(over: Partial<CapJournalEntry> = {}): CapJournalEntry {
  return { ts: NOW - 1000, kind: "claim-opened", from: null, to: null, evidence: {}, reason: null, result: "ok", written: true, ...over };
}
const opened = (cls = "dev_orch", extra: Record<string, string> = {}, ts = NOW - 1000) =>
  je({ ts, kind: "claim-opened", evidence: { class: cls, state: "ready-for-agent", ...extra } });
const closed = (cls: string, outcome: string, ts = NOW - 900) =>
  je({ ts, kind: "claim-closed", evidence: { class: cls, outcome } });

function claimAttempt(over: Record<string, unknown> = {}) {
  return { kind: "claim" as const, class: "dev_orch", state: "ready-for-agent", pr: null, purpose: null, ...over } as any;
}
function evalArms(entries: CapJournalEntry[], attempt: any, extra: Record<string, unknown> = {}) {
  return evaluateCaps({ attempt, entries, resetMs: 0, timeline: [], trailerRounds: null, limits: LIMITS, ...extra });
}
const countOf = (ev: ReturnType<typeof evaluateCaps>, arm: string) => ev.counts.find((c) => c.arm === arm)!.count;

const failBody = (pr: number, round: number) =>
  `### Findings\n| x |\n\n## Standards\nQA-Verdict: FAIL pr=${pr} round=${round} sha=abcdef123456 blockers=1 max_severity=high`;

describe("cap table (INV-1)", () => {
  test("arms, units and limits are the ADR-0047 D6 table", () => {
    assert.deepEqual(
      CAP_TABLE.map((r) => `${r.arm}:${r.unit}:${r.limit}`),
      [
        "qa-fail-rounds:pr:3",
        "dev-nopr-resume:issue:2",
        "qa-stall:issue:3",
        "red-ci-forward-fix:pr:2",
        "stale-requeue:issue:2",
        "needs-dev-resume-claims:issue:4",
        "total-claims:issue:10",
      ],
    );
  });

  test("env override takes a positive integer; anything else falls back with a warning", () => {
    assert.equal(capEnvName("needs-dev-resume-claims"), "HYDRA_LIFECYCLE_CAP_NEEDS_DEV_RESUME_CLAIMS");
    const ok = resolveCapLimits({ HYDRA_LIFECYCLE_CAP_TOTAL_CLAIMS: "20" });
    assert.equal(ok.limits["total-claims"], 20);
    for (const bad of ["0", "-3", "2.5", "abc"]) {
      const r = resolveCapLimits({ HYDRA_LIFECYCLE_CAP_TOTAL_CLAIMS: bad });
      assert.equal(r.limits["total-claims"], 10);
      assert.equal(r.warnings.length, 1);
    }
  });

  test("qa-fail-rounds is NOT env-overridable", () => {
    const r = resolveCapLimits({ HYDRA_LIFECYCLE_CAP_QA_FAIL_ROUNDS: "9" });
    assert.equal(r.limits["qa-fail-rounds"], 3);
    assert.equal(r.warnings.length, 0);
  });

  test("classRole is a pure prefix rule", () => {
    assert.equal(classRole("dev_orch"), "dev");
    assert.equal(classRole("glm-drainer"), "dev");
    assert.equal(classRole("qa_orch"), "qa");
    assert.equal(classRole("sweep_orch"), "other");
  });
});

describe("reset marker (INV-4, INV-5)", () => {
  test("a malformed marker is ignored, never a reset", () => {
    assert.equal(parseCapResetTs("Hydra-Cap-Reset: by=op ts=not-a-date"), null);
    assert.equal(parseCapResetTs("Hydra-Cap-Reset: by=op ts=2026-11-04T10:00:00Z"), Date.parse("2026-11-04T10:00:00Z"));
    assert.equal(latestResetMs(["x", "Hydra-Cap-Reset: by=op ts=garbage"]), 0);
  });

  test("countReviewedFailRoundsSinceReset counts only bodies after the last marker", () => {
    const bodies = [failBody(7, 1), failBody(7, 2), "Hydra-Cap-Reset: by=op ts=2026-11-04T10:00:00Z", failBody(7, 3)];
    assert.equal(countReviewedFailRoundsSinceReset(bodies.slice(0, 2), 7), 2);
    assert.equal(countReviewedFailRoundsSinceReset(bodies, 7), 1);
  });

  test("a malformed Hydra-Cap-Reset line does NOT reset the PR-side round count (INV-4)", () => {
    for (const bad of ["Hydra-Cap-Reset: garbage", "Hydra-Cap-Reset: by=op", "Hydra-Cap-Reset: by=op ts=notadate"]) {
      assert.equal(countReviewedFailRoundsSinceReset([failBody(7, 1), failBody(7, 2), bad, failBody(7, 3)], 7), 3, bad);
    }
  });
});

describe("one comparator, per-arm counts (INV-2, INV-3)", () => {
  test("total-claims parks at the limit, counting only prior attempts", () => {
    const nine = Array.from({ length: 9 }, () => opened());
    assert.equal(evalArms(nine, claimAttempt()).over, null);
    const ten = Array.from({ length: 10 }, () => opened());
    assert.equal(evalArms(ten, claimAttempt()).over?.arm, "total-claims");
  });

  test("needs-dev-resume-claims applies only when the re-read state is needs-dev-resume", () => {
    const four = Array.from({ length: 4 }, () => opened("dev_orch", { state: "needs-dev-resume" }));
    assert.equal(evalArms(four, claimAttempt({ state: "ready-for-agent" })).over, null);
    assert.equal(evalArms(four, claimAttempt({ state: "needs-dev-resume" })).over?.arm, "needs-dev-resume-claims");
  });

  test("dev-nopr-resume: 2 resumes run, the 3rd no-PR stall parks", () => {
    const afterOne = [opened(), closed("dev_orch", "no-pr")];
    assert.equal(evalArms(afterOne, claimAttempt()).over, null);
    const afterTwo = [...afterOne, opened(), closed("dev_orch", "no-pr")];
    const ev2 = evalArms(afterTwo, claimAttempt());
    assert.equal(countOf(ev2, "dev-nopr-resume"), 1);
    assert.equal(ev2.over, null);
    const afterThree = [...afterTwo, opened(), closed("dev_orch", "no-pr")];
    assert.equal(evalArms(afterThree, claimAttempt()).over?.arm, "dev-nopr-resume");
  });

  test("dev-nopr-resume does not apply when the last dev claim closed pr-opened", () => {
    const entries = [opened(), closed("dev_orch", "no-pr"), opened(), closed("dev_orch", "no-pr"), opened(), closed("dev_orch", "pr-opened")];
    assert.equal(evalArms(entries, claimAttempt()).over, null);
  });

  test("qa-stall: 3 stalls, the 4th qa claim parks; a dev claim is unaffected", () => {
    const stalls = [1, 2, 3].flatMap(() => [opened("qa_orch"), closed("qa_orch", "stall")]);
    assert.equal(evalArms(stalls, claimAttempt({ class: "qa_orch" })).over?.arm, "qa-stall");
    assert.equal(evalArms(stalls, claimAttempt({ class: "dev_orch" })).over, null);
  });

  test("red-ci-forward-fix counts forward-fix claims on the same PR", () => {
    const two = [opened("dev_orch", { purpose: "forward-fix", pr: "9" }), opened("dev_orch", { purpose: "forward-fix", pr: "9" })];
    assert.equal(evalArms(two, claimAttempt({ purpose: "forward-fix", pr: 9 })).over?.arm, "red-ci-forward-fix");
    assert.equal(evalArms(two, claimAttempt({ purpose: "forward-fix", pr: 10 })).over, null);
    assert.equal(evalArms(two, claimAttempt({ purpose: "fresh", pr: 9 })).over, null);
  });

  test("qa-fail-rounds (trailer source) parks the next claim on that PR at 3", () => {
    assert.equal(evalArms([], claimAttempt({ class: "qa_orch", pr: 5 }), { trailerRounds: 2 }).over, null);
    const ev = evalArms([], claimAttempt({ class: "qa_orch", pr: 5 }), { trailerRounds: 3 });
    assert.equal(ev.over?.arm, "qa-fail-rounds");
    assert.equal(ev.over?.source, "trailer");
  });

  test("stale-requeue counts written in-progress -> ready-for-agent entries of any kind", () => {
    const rq = (kind: string) => je({ kind, from: "in-progress", to: "ready-for-agent", written: true });
    const ev = evalArms([rq("transition"), rq("refused")], { kind: "requeue" });
    assert.equal(ev.over?.arm, "stale-requeue");
    const unwritten = je({ kind: "refused", from: "in-progress", to: "ready-for-agent", written: false });
    assert.equal(evalArms([unwritten, unwritten], { kind: "requeue" }).over, null);
  });

  test("when several arms are over, the first in table order names the park", () => {
    const entries = [...Array.from({ length: 10 }, () => opened("dev_orch", { state: "needs-dev-resume" }))];
    const ev = evalArms(entries, claimAttempt({ state: "needs-dev-resume" }));
    assert.equal(ev.over?.arm, "needs-dev-resume-claims");
    assert.ok(ev.counts.find((c) => c.arm === "total-claims")!.count >= 10);
  });

  test("entries at or before the reset ts are ignored", () => {
    const entries = Array.from({ length: 10 }, () => opened("dev_orch", {}, NOW - 5000));
    assert.equal(evalArms(entries, claimAttempt(), { resetMs: NOW - 1000 }).over, null);
  });
});

describe("timeline fallback + baseline seeding (INV-11)", () => {
  const ev = (event: "labeled" | "unlabeled", label: string, tsMs: number) => ({ event, label, tsMs });

  test("timelineArmCounts pairs unlabeled in-progress with labeled ready-for-agent within 60s", () => {
    const events = [
      ev("labeled", "in-progress", 1000),
      ev("unlabeled", "in-progress", 100_000),
      ev("labeled", "ready-for-agent", 130_000),
      ev("unlabeled", "in-progress", 500_000),
      ev("labeled", "ready-for-agent", 900_000),
      ev("labeled", "needs-dev-resume", 2000),
    ];
    const c = timelineArmCounts(events, 0);
    assert.equal(c["total-claims"], 1);
    assert.equal(c["stale-requeue"], 1);
    assert.equal(c["needs-dev-resume-claims"], 1);
    assert.equal(timelineArmCounts(events, 200_000)["stale-requeue"], 0);
  });

  test("a journal miss counts from the timeline and tags timeline-derived", () => {
    const events = Array.from({ length: 10 }, (_, i) => ev("labeled", "in-progress", 1000 + i));
    const r = evalArms([], claimAttempt(), { timeline: events });
    assert.equal(r.journalMiss, true);
    assert.equal(r.over?.arm, "total-claims");
    assert.equal(r.over?.source, "timeline-derived");
  });

  test("seed evidence folds in the seeding entry; later counts are baseline + entries after", () => {
    const seed = buildSeedEvidence({ "total-claims": 8, "needs-dev-resume-claims": 0, "stale-requeue": 0 }, opened());
    assert.equal(seed["cap-baseline"], "timeline-derived");
    assert.equal(seed["baseline.total-claims"], "9");
    const seeded = opened("dev_orch", seed);
    const r1 = evalArms([seeded], claimAttempt());
    assert.equal(countOf(r1, "total-claims"), 9);
    assert.equal(r1.over, null);
    const r2 = evalArms([seeded, opened()], claimAttempt());
    assert.equal(r2.over?.arm, "total-claims");
    assert.equal(r2.over?.source, "timeline-derived");
  });

  test("an all-zero baseline seeds nothing", () => {
    assert.deepEqual(buildSeedEvidence({ "total-claims": 0, "needs-dev-resume-claims": 0, "stale-requeue": 0 }, je({ kind: "refused" })), {});
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
  claim: { dispatchId: string; class: string; run: string; artifactHash: null; openedAt: number } | null;
  fetchFail: Set<string>;
  commentBodies: string[];
  timelineEvents: Array<{ event: "labeled" | "unlabeled"; label: string; tsMs: number }>;
  prBodies: string[];
}

function world(mode: LifecycleMode, labels: string[], env: Record<string, string> = {}): World {
  const w: World = {
    journal: [], edits: [], comments: [], labels: [...labels], claim: null, fetchFail: new Set(),
    commentBodies: [], timelineEvents: [], prBodies: [], deps: undefined as unknown as SeamDeps,
  };
  w.deps = {
    repo: "o/r",
    mode: async () => mode,
    view: async (n) =>
      w.fetchFail.has("view")
        ? { ok: false, code: "gh-failed" }
        : { ok: true, row: { number: n, title: "t", url: "", createdAt: "", labels: [...w.labels], body: "", state: "OPEN" } },
    edit: async (issue, l) => {
      w.edits.push({ issue, remove: l.remove, add: l.add });
      w.labels = w.labels.filter((x) => !l.remove.includes(x)).concat(l.add);
      return { ok: true };
    },
    close: async () => ({ ok: true }),
    comment: async (number, body) => {
      w.comments.push({ number, body });
      return { ok: true };
    },
    env: () => env,
    fetch: {
      designConcept: async () => ({ ok: true, value: { exists: true, status: "approved" } }),
      pr: async () => ({ ok: false }),
      comment: async () => ({ ok: false }),
      stateEntry: async () => ({ ok: true, value: { enteredAtMs: null } }),
      issueComments: async () => (w.fetchFail.has("comments") ? { ok: false } : { ok: true, value: w.commentBodies }),
      timeline: async () => (w.fetchFail.has("timeline") ? { ok: false } : { ok: true, value: w.timelineEvents }),
      prBodies: async () => (w.fetchFail.has("prBodies") ? { ok: false } : { ok: true, value: w.prBodies }),
    },
    journal: {
      append: async (_r, _i, e) => (w.journal.push(e), { ok: true }),
      expireOnClose: async () => ({ ok: true }),
      openClaim: async (_r, _i, c) => {
        if (w.claim) return { ok: false, code: "claim-held", existing: w.claim };
        w.claim = c as World["claim"];
        return { ok: true, claim: c };
      },
      closeClaim: async (_r, _i, id) => {
        if (w.claim && w.claim.dispatchId !== id) return { ok: false, error: "claim-owner-mismatch" };
        const prior = w.claim;
        w.claim = null;
        return { ok: true, prior };
      },
      read: async () => (w.fetchFail.has("journal") ? { ok: false, error: "x" } : { ok: true, entries: [...w.journal] }),
      readClaim: async () => ({ ok: true, claim: w.claim }),
    },
    now: () => NOW,
  };
  return w;
}

const seedClaims = (w: World, n: number, state = "ready-for-agent") => {
  for (let i = 0; i < n; i++) {
    w.journal.push({
      v: 1, ts: NOW - 5000 + i, kind: "claim-opened", from: null, to: null, source: "cli", actor: "t",
      evidence: { dispatch: `d${i}`, class: "dev_orch", run: "r", state }, reason: null, rationale: null, result: "ok", written: true,
    });
  }
};
const claimInput = (over: Record<string, unknown> = {}) => ({ issue: 42, dispatchId: "dNew", class: "dev_orch", run: "r1", ...over }) as any;

describe("openClaim wiring (INV-6, INV-7, INV-10, INV-12, INV-13)", () => {
  test("under cap: claim opens, entry carries {dispatch,class,run,state[,pr][,purpose]}", async () => {
    const w = world("enforce", ["ready-for-agent"]);
    const res = await openClaim(claimInput({ pr: 5, purpose: "resume" }), w.deps);
    assert.equal(res.ok, true);
    const e = w.journal.find((x) => x.kind === "claim-opened")!;
    assert.deepEqual(e.evidence, { dispatch: "dNew", class: "dev_orch", run: "r1", state: "ready-for-agent", pr: "5", purpose: "resume" });
  });

  test("enforce over cap: no claim, parks in the same call, returns parked:<arm>", async () => {
    const w = world("enforce", ["ready-for-agent"]);
    seedClaims(w, 10);
    const res = await openClaim(claimInput(), w.deps);
    assert.deepEqual(res, { ok: false, code: "parked:total-claims", written: true });
    assert.equal(w.claim, null);
    assert.equal(w.edits.length, 1);
    assert.deepEqual(w.edits[0], { issue: 42, remove: ["ready-for-agent"], add: ["parked"] });
    const park = w.journal.find((e) => e.kind === "transition" && e.to === "parked")!;
    assert.equal(park.reason, "cap:total-claims");
    assert.equal(park.result, "parked:total-claims");
  });

  test("a park posts exactly ONE unified comment on the issue, never the PR", async () => {
    const w = world("enforce", ["needs-qa"]);
    seedClaims(w, 10);
    await openClaim(claimInput({ class: "qa_orch", pr: 77 }), w.deps);
    assert.equal(w.comments.length, 1);
    assert.equal(w.comments[0].number, 42);
    assert.match(w.comments[0].body, /^## Hydra cap park/);
    assert.match(w.comments[0].body, /^Hydra-Cap-Park: arm=total-claims count=10 limit=10 unit=issue pr=77 source=journal ts=/m);
    assert.ok(w.comments.every((c) => c.number !== 77));
  });

  test("shadow over cap: relabels nothing, claim opens, one extra shadow-would-park entry", async () => {
    const w = world("shadow", ["ready-for-agent"]);
    seedClaims(w, 10);
    const res = await openClaim(claimInput(), w.deps);
    assert.equal(res.ok, true);
    assert.equal((res as any).wouldPark, "total-claims");
    assert.equal(w.edits.length, 0);
    assert.equal(w.comments.length, 0);
    assert.ok(w.claim);
    const extra = w.journal.at(-1)!;
    assert.equal(extra.kind, "refused");
    assert.equal(extra.to, "parked");
    assert.equal(extra.result, "shadow-would-park:total-claims");
    assert.equal(extra.written, false);
    assert.equal(extra.evidence.arm, "total-claims");
    assert.equal(w.journal.filter((e) => e.kind === "claim-opened").length, 11);
  });

  test("a held claim returns claim-held with no counting and no park", async () => {
    const w = world("enforce", ["ready-for-agent"]);
    seedClaims(w, 10);
    w.claim = { dispatchId: "other", class: "dev_orch", run: "r", artifactHash: null, openedAt: 1 };
    const res = await openClaim(claimInput(), w.deps);
    assert.equal(res.ok, false);
    assert.equal((res as any).code, "claim-held");
    assert.equal(w.edits.length, 0);
    assert.equal(w.comments.length, 0);
  });

  test("a park from a state with no parked row writes no label, journals refused:park-illegal-from, still refuses", async () => {
    const w = world("enforce", ["qa-passed"]);
    seedClaims(w, 10);
    const res = await openClaim(claimInput(), w.deps);
    assert.deepEqual(res, { ok: false, code: "parked:total-claims", written: false });
    assert.equal(w.edits.length, 0);
    assert.ok(w.journal.some((e) => e.result === "refused:park-illegal-from:qa-passed"));
  });

  test("a fetch failure skips the cap check: claim proceeds, entry carries cap-check=skipped:fetch-failed", async () => {
    for (const failing of ["comments", "prBodies", "view"]) {
      const w = world("enforce", ["ready-for-agent"]);
      seedClaims(w, 10);
      w.fetchFail.add(failing);
      const res = await openClaim(claimInput({ pr: 5 }), w.deps);
      assert.equal(res.ok, true, failing);
      assert.equal(w.edits.length, 0, failing);
      const e = w.journal.filter((x) => x.kind === "claim-opened").at(-1)!;
      assert.equal(e.evidence["cap-check"], "skipped:fetch-failed", failing);
    }
  });

  test("journal read AND timeline both failing skips the check", async () => {
    const w = world("enforce", ["ready-for-agent"]);
    w.fetchFail.add("journal");
    w.fetchFail.add("timeline");
    const res = await openClaim(claimInput(), w.deps);
    assert.equal(res.ok, true);
    assert.equal(w.journal.at(-1)!.evidence["cap-check"], "skipped:fetch-failed");
  });

  test("journal miss falls back to the timeline, parks tagged timeline-derived", async () => {
    const w = world("enforce", ["ready-for-agent"]);
    w.timelineEvents = Array.from({ length: 10 }, (_, i) => ({ event: "labeled" as const, label: "in-progress", tsMs: 1000 + i }));
    const res = await openClaim(claimInput(), w.deps);
    assert.deepEqual(res, { ok: false, code: "parked:total-claims", written: true });
    const park = w.journal.find((e) => e.kind === "transition")!;
    assert.equal(park.evidence.source, "timeline-derived");
    assert.equal(park.evidence["cap-baseline"], "timeline-derived");
    assert.match(w.comments[0].body, /source=timeline-derived/);
  });

  test("a journal miss with timeline events seeds the first entry so no fresh budget follows Redis loss", async () => {
    const w = world("enforce", ["ready-for-agent"]);
    w.timelineEvents = Array.from({ length: 9 }, (_, i) => ({ event: "labeled" as const, label: "in-progress", tsMs: 1000 + i }));
    const first = await openClaim(claimInput(), w.deps);
    assert.equal(first.ok, true);
    assert.equal(w.journal[0].evidence["baseline.total-claims"], "10");
    await releaseClaim(42, "dNew", w.deps, "cli", "pr-opened");
    const second = await openClaim(claimInput({ dispatchId: "dNew2" }), w.deps);
    assert.equal(second.ok, false);
    assert.equal((second as any).code, "parked:total-claims");
  });

  test("total-claims parks an alternating-arm loop while every per-arm count stays under its limit (AC1)", async () => {
    const w = world("enforce", ["ready-for-agent"]);
    const shapes = [{}, { class: "qa_orch", pr: 5 }, { pr: 5, purpose: "resume" }];
    for (let i = 0; i < 10; i++) {
      const r = await openClaim(claimInput({ dispatchId: `d${i}`, ...shapes[i % 3] }), w.deps);
      assert.equal(r.ok, true, `claim ${i + 1} opens`);
      await releaseClaim(42, `d${i}`, w.deps, "cli", "pr-opened");
    }
    const eleventh = await openClaim(claimInput({ dispatchId: "d10" }), w.deps);
    assert.deepEqual(eleventh, { ok: false, code: "parked:total-claims", written: true });
  });

  test("Hydra-Cap-Reset on the issue restarts every count", async () => {
    const w = world("enforce", ["ready-for-agent"]);
    seedClaims(w, 10);
    w.commentBodies = [`Hydra-Cap-Reset: by=op ts=${new Date(NOW - 1000).toISOString()}`];
    const res = await openClaim(claimInput(), w.deps);
    assert.equal(res.ok, true);
  });

  test("qa-fail-rounds parks a QA claim on a PR with 3 reviewed FAIL rounds", async () => {
    const w = world("enforce", ["needs-qa"]);
    w.prBodies = [failBody(5, 1), failBody(5, 2), failBody(5, 3)];
    const res = await openClaim(claimInput({ class: "qa_orch", pr: 5 }), w.deps);
    assert.deepEqual(res, { ok: false, code: "parked:qa-fail-rounds", written: true });
    const park = w.journal.find((e) => e.kind === "transition")!;
    assert.equal(park.evidence.source, "trailer");
    assert.equal(park.evidence.pr, "5");
  });

  test("a failed park label write journals write-failed and enforce still refuses", async () => {
    const w = world("enforce", ["ready-for-agent"]);
    seedClaims(w, 10);
    w.deps.edit = async () => ({ ok: false, code: "gh-failed", stderr: "no such label" });
    const res = await openClaim(claimInput(), w.deps);
    assert.deepEqual(res, { ok: false, code: "parked:total-claims", written: false });
    assert.ok(w.journal.some((e) => e.result === "write-failed:gh-failed"));
    assert.equal(w.comments.length, 0);
  });
});

describe("releaseClaim outcome (INV-13)", () => {
  test("claim-closed carries {dispatch, class, outcome}; outcome is optional", async () => {
    const w = world("shadow", ["ready-for-agent"]);
    await openClaim(claimInput(), w.deps);
    await releaseClaim(42, "dNew", w.deps, "cli", "no-pr");
    assert.deepEqual(w.journal.at(-1)!.evidence, { dispatch: "dNew", class: "dev_orch", outcome: "no-pr" });
    await openClaim(claimInput({ dispatchId: "d2" }), w.deps);
    await releaseClaim(42, "d2", w.deps);
    assert.deepEqual(w.journal.at(-1)!.evidence, { dispatch: "d2", class: "dev_orch" });
  });
});

describe("advance in-progress -> ready-for-agent is the stale re-queue (INV-3, INV-6, INV-7)", () => {
  const requeueEntries = (w: World, n: number) => {
    for (let i = 0; i < n; i++) {
      w.journal.push({
        v: 1, ts: NOW - 5000 + i, kind: "transition", from: "in-progress", to: "ready-for-agent", source: "cli",
        actor: "t", evidence: {}, reason: null, rationale: null, result: "ok", written: true,
      });
    }
  };

  test("enforce over cap: ready-for-agent is NOT written, the seam parks instead", async () => {
    const w = world("enforce", ["in-progress"]);
    requeueEntries(w, 2);
    const res = await advance({ issue: 42, to: "ready-for-agent" }, w.deps);
    assert.deepEqual({ ok: res.ok, code: (res as any).code, written: (res as any).written }, { ok: false, code: "parked:stale-requeue", written: true });
    assert.deepEqual(w.edits, [{ issue: 42, remove: ["in-progress"], add: ["parked"] }]);
    assert.ok(!w.labels.includes("ready-for-agent"));
  });

  test("shadow over cap: the requeue still writes, wouldPark is reported, a shadow entry is journaled", async () => {
    const w = world("shadow", ["in-progress"]);
    requeueEntries(w, 2);
    const res = await advance({ issue: 42, to: "ready-for-agent" }, w.deps);
    assert.equal(res.ok, true);
    assert.equal((res as any).wouldPark, "stale-requeue");
    assert.deepEqual(w.edits, [{ issue: 42, remove: ["in-progress"], add: ["ready-for-agent"] }]);
    assert.equal(w.journal.at(-1)!.result, "shadow-would-park:stale-requeue");
  });

  test("under cap: advance is unchanged and no cap entry appears", async () => {
    const w = world("shadow", ["in-progress"]);
    requeueEntries(w, 1);
    const res = await advance({ issue: 42, to: "ready-for-agent" }, w.deps);
    assert.equal(res.ok, true);
    assert.equal((res as any).wouldPark, undefined);
    assert.ok(!w.journal.some((e) => e.result.startsWith("shadow-would-park")));
  });

  test("other transitions do no cap work", async () => {
    const w = world("enforce", ["needs-triage"]);
    w.fetchFail.add("comments");
    await advance({ issue: 42, to: "needs-info", reason: "missing-repro", rationale: "x" }, w.deps);
    assert.ok(!w.journal.some((e) => "cap-check" in e.evidence));
  });
});

describe("postCapReset (INV-14)", () => {
  test("posts the marker on the issue and, when the latest cap park names pr=, on that PR", async () => {
    const w = world("enforce", ["ready-for-agent"]);
    w.journal.push({
      v: 1, ts: NOW - 10, kind: "transition", from: "needs-qa", to: "parked", source: "cli", actor: "t",
      evidence: { pr: "77" }, reason: "cap:qa-fail-rounds", rationale: null, result: "parked:qa-fail-rounds", written: true,
    });
    const ts = new Date(NOW).toISOString();
    const res = await postCapReset(42, { by: "operator", ts }, w.deps);
    assert.deepEqual(res, { ok: true, prPosted: true });
    const line = `Hydra-Cap-Reset: by=operator ts=${ts}`;
    assert.deepEqual(w.comments, [{ number: 42, body: line }, { number: 77, body: line }]);
    assert.equal(latestResetMs([line]), NOW);
  });

  test("an invalid ts is rejected without posting", async () => {
    const w = world("enforce", ["ready-for-agent"]);
    const res = await postCapReset(42, { by: "op", ts: "nope" }, w.deps);
    assert.deepEqual(res, { ok: false, code: "invalid-reset-input" });
    assert.equal(w.comments.length, 0);
  });
});
