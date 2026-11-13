/**
 * Lifecycle reconcile pass (ADR-0047 D1/D2/D4/D5, issue #5316).
 *
 * Offline: every gh / Redis / clock effect is an in-memory fake. Pins the
 * design-concept invariants INV-1..INV-13 for src/lifecycle/reconcile.ts,
 * src/lifecycle/timeline.ts and the shared qa-passed exit predicate.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { advance, type SeamDeps } from "../src/lifecycle/seam.ts";
import {
  MAX_QA_EXIT_EVALS,
  MAX_TIMELINE_FETCHES,
  isZeroStateExempt,
  resolveQaPr,
  singleClosingPr,
  runReconcile,
  type OpenPrRef,
  type ReconcileDeps,
  type ReconcileReport,
} from "../src/lifecycle/reconcile.ts";
import { externalMoves, lastKnownState, replayStateSnapshots } from "../src/lifecycle/timeline.ts";
import { classifyQaPassedExit, type QaLivePr } from "../src/lifecycle/gates.ts";
import { findTransition } from "../src/lifecycle/transitions.ts";
import type { LifecycleJournalEntry } from "../src/redis/lifecycle-journal.ts";

const NOW = Date.parse("2026-11-04T12:00:00.000Z");
const T1 = Date.parse("2026-11-04T08:00:00.000Z");
const T2 = Date.parse("2026-11-04T09:00:00.000Z");
const HEAD = "0123456789abcdef0123456789abcdef01234567";

interface Issue {
  labels: string[];
  body: string;
  state: "OPEN" | "CLOSED";
}
type TlEvent = { event: "labeled" | "unlabeled"; label: string; tsMs: number };

function je(over: Partial<LifecycleJournalEntry> = {}): LifecycleJournalEntry {
  return {
    v: 1, ts: NOW - 1000, kind: "transition", from: null, to: null, source: "cli", actor: "t",
    evidence: {}, reason: null, rationale: null, result: "ok", written: true, ...over,
  };
}

function live(over: Partial<QaLivePr> = {}): QaLivePr {
  return { number: 200, state: "OPEN", isDraft: false, mergeStateStatus: "CLEAN", headSha: HEAD, checks: "green", bodies: [], ...over };
}

const PASS_TRAILER = (pr: number, sha = HEAD.slice(0, 12)) =>
  `QA-Verdict: PASS pr=${pr} round=1 sha=${sha} blockers=0 max_severity=none`;

function world(mode: "shadow" | "enforce" = "enforce") {
  const w = {
    issues: new Map<number, Issue>(),
    closedRows: [] as number[],
    journals: new Map<number, LifecycleJournalEntry[]>(),
    timelines: new Map<number, TlEvent[]>(),
    comments: new Map<number, string[]>(),
    prs: [] as OpenPrRef[],
    lives: new Map<number, QaLivePr>(),
    prRecords: new Map<number, { number: number; state: string; body: string }>(),
    edits: [] as Array<{ issue: number; remove: string[]; add: string[] }>,
    closes: [] as number[],
    posted: [] as Array<{ number: number; body: string }>,
    appends: [] as Array<{ issue: number; entry: LifecycleJournalEntry }>,
    expired: [] as number[],
    persisted: [] as number[],
    reports: [] as ReconcileReport[],
    timelineFetches: 0,
    openIssuesFail: false,
    journalThrowFor: new Set<number>(),
    editFails: false,
    persistFails: false,
    expireFails: false,
    postFails: false,
    deps: undefined as unknown as ReconcileDeps,
  };
  const j = (n: number): LifecycleJournalEntry[] => {
    if (!w.journals.has(n)) w.journals.set(n, []);
    return w.journals.get(n)!;
  };
  const row = (n: number, i: Issue) => ({
    number: n, title: `issue ${n}`, url: `https://github.com/o/r/issues/${n}`, createdAt: "", labels: [...i.labels], body: i.body, state: i.state,
  });
  const seam: SeamDeps = {
    repo: "o/r",
    mode: async () => mode,
    view: async (n) => {
      const i = w.issues.get(n);
      return i ? { ok: true, row: row(n, i) } : { ok: false, code: "gh-failed" };
    },
    edit: async (n, l) => {
      if (w.editFails) return { ok: false, code: "gh-failed", stderr: "x" };
      w.edits.push({ issue: n, remove: l.remove, add: l.add });
      const i = w.issues.get(n)!;
      i.labels = i.labels.filter((x) => !l.remove.includes(x)).concat(l.add);
      return { ok: true };
    },
    close: async (n) => {
      w.closes.push(n);
      w.issues.get(n)!.state = "CLOSED";
      return { ok: true };
    },
    comment: async (number, body) => {
      if (w.postFails) return { ok: false, code: "gh-failed", stderr: "x" };
      w.posted.push({ number, body });
      w.comments.set(number, [...(w.comments.get(number) ?? []), body]);
      return { ok: true };
    },
    env: () => ({}),
    fetch: {
      designConcept: async () => ({ ok: true, value: { exists: true, status: "approved" } }),
      pr: async (n) => (w.prRecords.has(n) ? { ok: true, value: w.prRecords.get(n)! } : { ok: false }),
      comment: async () => ({ ok: false }),
      stateEntry: async () => ({ ok: true, value: { enteredAtMs: null } }),
      issueComments: async (n) => ({ ok: true, value: w.comments.get(n) ?? [] }),
      timeline: async (n) => {
        w.timelineFetches++;
        return { ok: true, value: w.timelines.get(n) ?? [] };
      },
      prBodies: async () => ({ ok: true, value: [] }),
      qaLive: async (n) => (w.lives.has(n) ? { ok: true, value: w.lives.get(n)! } : { ok: false }),
    },
    journal: {
      append: async (_r, n, e) => {
        w.appends.push({ issue: n, entry: e });
        j(n).push(e);
        return { ok: true };
      },
      expireOnClose: async (_r, n) =>
        w.expireFails ? { ok: false, error: "x" } : (w.expired.push(n), { ok: true }),
      openClaim: async () => ({ ok: false, code: "redis-failed", error: "n/a" }),
      closeClaim: async () => ({ ok: true, prior: null }),
      read: async (_r, n) => {
        if (w.journalThrowFor.has(n)) throw new Error("boom");
        return { ok: true, entries: [...j(n)] };
      },
      readClaim: async () => ({ ok: true, claim: null }),
    },
    now: () => NOW,
  };
  w.deps = {
    seam,
    listOpenIssues: async () =>
      w.openIssuesFail
        ? { ok: false, code: "gh-failed" }
        : { ok: true, rows: [...w.issues].filter(([, i]) => i.state === "OPEN").map(([n, i]) => row(n, i)) },
    listOpenPrs: async () => ({ ok: true, value: w.prs }),
    listRecentlyClosed: async () => ({
      ok: true,
      rows: w.closedRows.map((n) => row(n, w.issues.get(n) ?? { labels: [], body: "", state: "CLOSED" })),
    }),
    persistJournal: async (_r, n) =>
      w.persistFails ? { ok: false, error: "x" } : (w.persisted.push(n), { ok: true }),
    writeReport: async (report) => (w.reports.push(report), { ok: true }),
  };
  const add = (n: number, labels: string[], over: Partial<Issue> = {}) =>
    w.issues.set(n, { labels, body: "", state: "OPEN", ...over });
  return { w, add, journal: j };
}

describe("reconcile: external transitions (INV-1, INV-8)", () => {
  test("reconcile never writes a label to undo an out-of-seam change: an operator edit is journaled external and no edit is issued", async () => {
    const { w, add, journal } = world();
    add(10, ["ready-for-agent"]);
    journal(10).push(je({ kind: "transition", from: "ready-for-agent", to: "in-progress" }));
    w.timelines.set(10, [
      { event: "labeled", label: "in-progress", tsMs: T1 },
      { event: "unlabeled", label: "in-progress", tsMs: T2 },
      { event: "labeled", label: "ready-for-agent", tsMs: T2 },
    ]);
    const report = await runReconcile(w.deps);
    assert.equal(w.edits.length, 0);
    assert.equal(w.closes.length, 0);
    assert.equal(report.externalEntries, 1);
    const e = w.appends.find((a) => a.issue === 10)!.entry;
    assert.equal(e.kind, "external");
    assert.equal(e.source, "external");
    assert.equal(e.written, true);
    assert.equal(e.from, "in-progress");
    assert.equal(e.to, "ready-for-agent");
    assert.equal(lastKnownState(w.journals.get(10)!), "ready-for-agent");
  });

  test("reconcile.ts source never calls deps.edit, editIssueLabels or gh directly", () => {
    const src = readFileSync(new URL("../src/lifecycle/reconcile.ts", import.meta.url), "utf8");
    assert.equal(src.includes("deps.edit"), false);
    assert.equal(src.includes("editIssueLabels"), false);
    assert.equal(src.includes("ghExec"), false);
    assert.equal(src.includes("ghJson"), false);
    assert.equal(src.includes("seam.edit"), false);
  });

  test("external detection is diff-first: a matching journal state fetches no timeline", async () => {
    const { w, add, journal } = world();
    add(11, ["in-progress"]);
    journal(11).push(je({ to: "in-progress" }));
    await runReconcile(w.deps);
    assert.equal(w.timelineFetches, 0);
  });

  test("an empty journal yields no external entries and no timeline fetch", async () => {
    const { w, add } = world();
    add(12, ["in-progress"]);
    w.timelines.set(12, [{ event: "labeled", label: "in-progress", tsMs: T1 }]);
    const report = await runReconcile(w.deps);
    assert.equal(w.timelineFetches, 0);
    assert.equal(report.externalEntries, 0);
    assert.equal(w.appends.length, 0);
  });

  test("timeline fetches are capped per tick and the remainder waits for the next tick", async () => {
    assert.equal(MAX_TIMELINE_FETCHES, 25);
    assert.equal(MAX_QA_EXIT_EVALS, 20);
    const { w, add, journal } = world();
    for (const n of [21, 22, 23]) {
      add(n, ["ready-for-agent"]);
      journal(n).push(je({ to: "in-progress" }));
      w.timelines.set(n, [
        { event: "labeled", label: "in-progress", tsMs: T1 },
        { event: "unlabeled", label: "in-progress", tsMs: T2 },
        { event: "labeled", label: "ready-for-agent", tsMs: T2 },
      ]);
    }
    const first = await runReconcile(w.deps, { maxTimelineFetches: 2 });
    assert.equal(w.timelineFetches, 2);
    assert.equal(first.externalEntries, 2);
    await runReconcile(w.deps, { maxTimelineFetches: 2 });
    assert.equal(w.timelineFetches, 3);
  });
});

describe("timeline replay (pure)", () => {
  test("snapshots collapse same-timestamp events and ignore non-state labels", () => {
    const snaps = replayStateSnapshots([
      { event: "labeled", label: "in-progress", tsMs: T1 },
      { event: "labeled", label: "bug", tsMs: T1 },
      { event: "unlabeled", label: "in-progress", tsMs: T2 },
      { event: "labeled", label: "needs-qa", tsMs: T2 },
    ]);
    assert.deepEqual(snaps, [
      { tsMs: T1, states: ["in-progress"] },
      { tsMs: T2, states: ["needs-qa"] },
    ]);
  });

  test("externalMoves lists every single-state move after the anchor, oldest first", () => {
    const moves = externalMoves(
      [
        { event: "labeled", label: "in-progress", tsMs: T1 },
        { event: "unlabeled", label: "in-progress", tsMs: T1 + 10 },
        { event: "labeled", label: "blocked", tsMs: T1 + 10 },
        { event: "unlabeled", label: "blocked", tsMs: T2 },
        { event: "labeled", label: "parked", tsMs: T2 },
      ],
      "in-progress",
      "parked",
    );
    assert.deepEqual(moves, [
      { tsMs: T1 + 10, from: "in-progress", to: "blocked" },
      { tsMs: T2, from: "blocked", to: "parked" },
    ]);
  });

  test("with no matching anchor one stand-in move records the journal-to-GitHub gap", () => {
    const moves = externalMoves([{ event: "labeled", label: "needs-qa", tsMs: T1 }], "in-progress", "needs-qa");
    assert.deepEqual(moves, [{ tsMs: T1, from: "in-progress", to: "needs-qa" }]);
  });

  test("lastKnownState ignores unwritten and stateless entries", () => {
    assert.equal(lastKnownState([]), null);
    assert.equal(
      lastKnownState([je({ to: "needs-qa" }), je({ kind: "claim-opened", to: null }), je({ kind: "refused", to: "parked", written: false })]),
      "needs-qa",
    );
  });
});

describe("qa-passed exits (INV-3, INV-4, INV-13)", () => {
  test("classifyQaPassedExit decision order is fixed", () => {
    assert.equal(classifyQaPassedExit(live({ state: "MERGED", mergeStateStatus: "DIRTY", checks: "red" })), "closed");
    assert.equal(classifyQaPassedExit(live({ state: "CLOSED" })), "ready-for-agent");
    assert.equal(classifyQaPassedExit(live({ mergeStateStatus: "DIRTY", checks: "green" })), "needs-dev-resume");
    assert.equal(classifyQaPassedExit(live({ checks: "red" })), "needs-dev-resume");
    assert.equal(classifyQaPassedExit(live({ checks: "green" })), "needs-qa");
    assert.equal(classifyQaPassedExit(live({ checks: "green", bodies: [PASS_TRAILER(200)] })), "none");
    assert.equal(classifyQaPassedExit(live({ checks: "green", headSha: "ffff" + HEAD.slice(4), bodies: [PASS_TRAILER(200)] })), "needs-qa");
    assert.equal(classifyQaPassedExit(live({ checks: "green", bodies: ["QA-Verdict: FAIL pr=200 round=1 sha=" + HEAD.slice(0, 12) + " blockers=1 max_severity=high"] })), "needs-qa");
    assert.equal(classifyQaPassedExit(live({ checks: "pending" })), "none");
    assert.equal(classifyQaPassedExit(live({ checks: "unknown" })), "none");
    assert.equal(classifyQaPassedExit(live({ isDraft: true, checks: "red" })), "none");
  });

  test("each qa-passed exit cause routes to its state through the seam with actor reconcile", async () => {
    const { w, add, journal } = world();
    const cases: Array<[number, number, QaLivePr, string]> = [
      [30, 300, live({ number: 300, state: "MERGED" }), "closed"],
      [31, 301, live({ number: 301, state: "CLOSED" }), "ready-for-agent"],
      [32, 302, live({ number: 302, mergeStateStatus: "DIRTY" }), "needs-dev-resume"],
      [33, 303, live({ number: 303, checks: "red" }), "needs-dev-resume"],
      [34, 304, live({ number: 304, checks: "green" }), "needs-qa"],
      [35, 305, live({ number: 305, checks: "pending" }), "none"],
      [36, 306, live({ number: 306, checks: "green", bodies: [PASS_TRAILER(306)] }), "none"],
    ];
    for (const [issue, pr, l] of cases) {
      add(issue, ["qa-passed"]);
      journal(issue).push(je({ to: "qa-passed", evidence: { pr: String(pr) } }));
      w.lives.set(pr, l);
      w.prRecords.set(pr, { number: pr, state: l.state, body: `Closes #${issue}` });
    }
    const report = await runReconcile(w.deps);
    for (const [issue, , , target] of cases) {
      if (target === "none") {
        assert.equal(w.issues.get(issue)!.labels.join(), "qa-passed", `#${issue}`);
      } else if (target === "closed") {
        assert.equal(w.issues.get(issue)!.state, "CLOSED");
      } else {
        assert.deepEqual(w.issues.get(issue)!.labels, [target], `#${issue}`);
      }
    }
    assert.deepEqual(report.qaExits, {
      "needs-dev-resume": 2, "needs-qa": 1, closed: 1, "ready-for-agent": 1, none: 2, unresolved: 0,
    });
    const t = w.appends.find((a) => a.issue === 32 && a.entry.kind === "transition")!.entry;
    assert.equal(t.actor, "reconcile");
    assert.equal(t.to, "needs-dev-resume");
  });

  test("the qa-exit gate verifies the requested target against the live PR", async () => {
    const { w, add } = world("enforce");
    add(40, ["qa-passed"]);
    w.lives.set(400, live({ number: 400, mergeStateStatus: "DIRTY" }));
    const res = await advance({ issue: 40, to: "needs-qa", evidence: { pr: "400" }, actor: "reconcile" }, w.deps.seam);
    assert.equal(res.ok, false);
    assert.equal("code" in res ? res.code : "", "qa-exit-cause-mismatch");
    assert.equal(w.edits.length, 0);
    const missing = await advance({ issue: 40, to: "needs-dev-resume", actor: "reconcile" }, w.deps.seam);
    assert.equal("code" in missing ? missing.code : "", "evidence-required:pr");
  });

  test("the PR is resolved from pointers: journal evidence, else the single open closing PR, else unresolved with no write", async () => {
    const prs: OpenPrRef[] = [{ number: 7, body: "Closes #50" }, { number: 8, body: "unrelated" }];
    assert.equal(resolveQaPr([je({ to: "qa-passed", evidence: { pr: "99" } })], 50, prs), 99);
    assert.equal(resolveQaPr([], 50, prs), 7);
    assert.equal(resolveQaPr([], 50, [...prs, { number: 9, body: "Fixes #50" }]), null);
    assert.equal(resolveQaPr([], 51, prs), null);
    assert.equal(resolveQaPr([], 50, null), null);

    const { w, add } = world();
    add(50, ["qa-passed"]);
    w.prs = [{ number: 7, body: "Closes #50" }, { number: 9, body: "Fixes #50" }];
    const report = await runReconcile(w.deps);
    assert.equal(report.qaExits.unresolved, 1);
    assert.equal(w.edits.length, 0);
  });

  test("INV-13: only the three qa-passed rows flip to the qa-exit gate; the three caller reconcile rows carry real gates; only needs-dev-resume -> ready-for-agent stays unimplemented", () => {
    for (const to of ["needs-dev-resume", "needs-qa", "ready-for-agent"] as const) {
      assert.equal(findTransition("qa-passed", to)?.gate, "qa-exit", to);
    }
    assert.equal(findTransition("qa-passed", "closed")?.gate, "close");
    assert.equal(findTransition("blocked", "ready-for-agent")?.gate, "unblocked");
    assert.equal(findTransition("in-progress", "needs-dev-resume")?.gate, "claim-released");
    assert.equal(findTransition("in-progress", "ready-for-agent")?.gate, "claim-released");
    assert.equal(findTransition("needs-dev-resume", "ready-for-agent")?.gate, "not-yet-implemented");
  });
});

describe("invalid and zero state (INV-5, INV-6)", () => {
  test("an issue with 2+ state labels is journaled once per label set, listed in the report and never edited", async () => {
    const { w, add } = world();
    add(60, ["needs-qa", "in-progress", "bug"]);
    const first = await runReconcile(w.deps);
    assert.deepEqual(first.invalid, [{ number: 60, labels: ["in-progress", "needs-qa"] }]);
    const e = w.appends.filter((a) => a.issue === 60);
    assert.equal(e.length, 1);
    assert.equal(e[0].entry.kind, "refused");
    assert.equal(e[0].entry.result, "invalid:state-ambiguous");
    assert.equal(e[0].entry.evidence.labels, "in-progress,needs-qa");
    assert.equal(e[0].entry.written, false);
    await runReconcile(w.deps);
    assert.equal(w.appends.filter((a) => a.issue === 60).length, 1);
    w.issues.get(60)!.labels = ["needs-qa", "blocked"];
    await runReconcile(w.deps);
    assert.equal(w.appends.filter((a) => a.issue === 60).length, 2);
    assert.equal(w.edits.length, 0);
  });

  test("zero state labels relabel to needs-triage through advance; epics, keep-open and wayfinder issues are exempt", async () => {
    const { w, add } = world();
    add(70, ["wontfix"]);
    add(71, [], { body: "## Sub-issues\n- [ ] #72\n" });
    add(72, ["keep-open"]);
    add(73, ["wayfinder:map"]);
    const report = await runReconcile(w.deps);
    assert.deepEqual(report.zeroStateRelabeled, [70]);
    assert.equal(report.zeroStateExempt, 3);
    assert.deepEqual(w.edits, [{ issue: 70, remove: [], add: ["needs-triage"] }]);
    const t = w.appends.find((a) => a.issue === 70 && a.entry.kind === "transition")!.entry;
    assert.equal(t.actor, "reconcile");
    assert.equal(t.reason, "rerouted");
    assert.equal(t.rationale, "zero-state backstop");
    assert.equal(isZeroStateExempt({ labels: ["x"], body: "" }), false);
  });
});

describe("external un-park posts one Hydra-Cap-Reset (INV-7)", () => {
  const setup = () => {
    const ctx = world();
    ctx.add(80, ["ready-for-agent"]);
    ctx.journal(80).push(je({ kind: "transition", to: "parked", reason: "cap:total-claims" }));
    ctx.w.timelines.set(80, [
      { event: "labeled", label: "parked", tsMs: T1 },
      { event: "unlabeled", label: "parked", tsMs: T2 },
      { event: "labeled", label: "ready-for-agent", tsMs: T2 },
    ]);
    return ctx;
  };

  test("an external parked exit posts the marker exactly once and a second tick posts nothing", async () => {
    const { w } = setup();
    const first = await runReconcile(w.deps);
    assert.equal(first.capResetsPosted, 1);
    const markers = w.posted.filter((p) => p.number === 80 && p.body.startsWith("Hydra-Cap-Reset:"));
    assert.equal(markers.length, 1);
    assert.equal(markers[0].body, `Hydra-Cap-Reset: by=external ts=${new Date(T2).toISOString()}`);
    const second = await runReconcile(w.deps);
    assert.equal(second.capResetsPosted, 0);
    assert.equal(w.posted.filter((p) => p.body.startsWith("Hydra-Cap-Reset:")).length, 1);
  });

  test("an existing marker at or after the event suppresses a second one; a later re-park gets its own", async () => {
    const { w } = setup();
    w.comments.set(80, [`Hydra-Cap-Reset: by=op ts=${new Date(T2).toISOString()}`]);
    const report = await runReconcile(w.deps);
    assert.equal(report.capResetsPosted, 0);
    assert.equal(w.posted.length, 0);
  });
});

describe("external close and reopen (INV-9)", () => {
  test("a recently closed issue without a terminal closed entry gets one and the retention clock", async () => {
    const { w, add, journal } = world();
    add(90, ["in-progress"], { state: "CLOSED" });
    journal(90).push(je({ to: "in-progress" }));
    add(91, [], { state: "CLOSED" });
    add(92, [], { state: "CLOSED" });
    journal(92).push(je({ to: "closed" }));
    w.closedRows = [90, 91, 92];
    const report = await runReconcile(w.deps);
    assert.equal(report.scanned.recentlyClosed, 3);
    assert.deepEqual(w.expired, [90]);
    const e = w.appends.find((a) => a.issue === 90)!.entry;
    assert.equal(e.kind, "external");
    assert.equal(e.to, "closed");
    assert.equal(w.appends.filter((a) => a.issue === 91 || a.issue === 92).length, 0);
  });

  test("an open issue whose last journal state is closed gets an external reopen entry and PERSIST", async () => {
    const { w, add, journal } = world();
    add(93, ["needs-triage"]);
    journal(93).push(je({ to: "closed" }));
    await runReconcile(w.deps);
    assert.deepEqual(w.persisted, [93]);
    const e = w.appends.find((a) => a.issue === 93)!.entry;
    assert.equal(e.kind, "external");
    assert.equal(e.from, "closed");
    assert.equal(e.to, "needs-triage");
    await runReconcile(w.deps);
    assert.equal(w.persisted.length, 1);
  });
});

describe("report, dry-run and never-throw (INV-10, INV-11)", () => {
  test("the report is persisted with the enforce-readiness fields", async () => {
    const { w, add, journal } = world();
    add(100, ["ready-for-agent"]);
    journal(100).push(
      je({ to: "ready-for-agent", ts: NOW - 1000 }),
      je({ kind: "refused", to: "in-progress", result: "shadow-would-refuse:design-concept-missing", ts: NOW - 2000 }),
      je({ kind: "refused", to: "parked", result: "shadow-would-park:total-claims", written: false, ts: NOW - 3000 }),
      je({ kind: "refused", to: "parked", result: "shadow-would-refuse:old", ts: NOW - 30 * 24 * 3_600_000 }),
    );
    const report = await runReconcile(w.deps);
    assert.equal(w.reports.length, 1);
    assert.equal(report.seamTransitions, 1);
    assert.deepEqual(report.wouldRefuseByReason, { "design-concept-missing": 1 });
    assert.deepEqual(report.wouldParkByArm, { "total-claims": 1 });
    assert.equal(report.mode, "enforce");
    assert.equal(report.scanned.open, 1);
    assert.deepEqual(report.errors, []);
    for (const k of ["invalid", "zeroStateRelabeled", "zeroStateExempt", "externalEntries", "capResetsPosted", "qaExits"] as const) {
      assert.ok(k in report, k);
    }
  });

  test("a failed open-issues read aborts the pass with zero writes", async () => {
    const { w, add } = world();
    add(110, []);
    w.openIssuesFail = true;
    const report = await runReconcile(w.deps);
    assert.deepEqual(report.errors, ["open-issues-read-failed"]);
    assert.equal(w.edits.length, 0);
    assert.equal(w.appends.length, 0);
    assert.equal(w.reports.length, 0);
  });

  test("a per-issue failure is recorded and the loop continues", async () => {
    const { w, add } = world();
    add(120, ["wontfix"]);
    add(121, ["wontfix"]);
    w.journalThrowFor.add(120);
    const report = await runReconcile(w.deps);
    assert.ok(report.errors.includes("issue-failed:#120"));
    assert.deepEqual(report.zeroStateRelabeled, [121]);
    assert.equal(w.reports.length, 1);
  });

  test("dry-run classifies everything and performs no write of any kind", async () => {
    const { w, add, journal } = world();
    add(130, ["wontfix"]);
    add(131, ["qa-passed"]);
    journal(131).push(je({ to: "qa-passed", evidence: { pr: "310" } }));
    w.lives.set(310, live({ number: 310, checks: "red" }));
    add(132, ["ready-for-agent"]);
    journal(132).push(je({ to: "parked" }));
    w.timelines.set(132, [
      { event: "labeled", label: "parked", tsMs: T1 },
      { event: "unlabeled", label: "parked", tsMs: T2 },
      { event: "labeled", label: "ready-for-agent", tsMs: T2 },
    ]);
    const before = w.appends.length;
    const report = await runReconcile(w.deps, { dryRun: true });
    assert.equal(report.dryRun, true);
    assert.deepEqual(report.zeroStateRelabeled, [130]);
    assert.equal(report.qaExits["needs-dev-resume"], 1);
    assert.equal(report.externalEntries, 1);
    assert.equal(report.capResetsPosted, 1);
    assert.equal(w.edits.length, 0);
    assert.equal(w.posted.length, 0);
    assert.equal(w.appends.length, before);
    assert.equal(w.reports.length, 0);
  });
});

describe("report counts only written effects and surfaces failed writes (QA round 1)", () => {
  test("a refused zero-state relabel is an error, not a relabel; a written one still counts", async () => {
    const { w, add } = world();
    add(110, ["wontfix"]);
    w.editFails = true;
    const refused = await runReconcile(w.deps);
    assert.deepEqual(refused.zeroStateRelabeled, []);
    assert.ok(refused.errors.some((e) => e.startsWith("zero-state-refused:#110")), refused.errors.join());
    w.editFails = false;
    const ok = await runReconcile(w.deps);
    assert.deepEqual(ok.zeroStateRelabeled, [110]);
  });

  test("a refused qa-passed exit is an error, not a routed exit; none still counts", async () => {
    const { w, add, journal } = world();
    add(111, ["qa-passed"]);
    journal(111).push(je({ to: "qa-passed", evidence: { pr: "311" } }));
    w.lives.set(311, live({ number: 311, checks: "green" }));
    w.prRecords.set(311, { number: 311, state: "OPEN", body: "Closes #111" });
    w.editFails = true;
    const refused = await runReconcile(w.deps);
    assert.equal(refused.qaExits["needs-qa"], 0);
    assert.ok(refused.errors.some((e) => e.startsWith("qa-exit-refused:#111")), refused.errors.join());
    w.editFails = false;
    const ok = await runReconcile(w.deps);
    assert.equal(ok.qaExits["needs-qa"], 1);
  });

  test("failed PERSIST on reopen and failed expire on close are reported", async () => {
    const { w, add, journal } = world();
    add(112, ["needs-triage"]);
    journal(112).push(je({ to: "closed" }));
    add(113, [], { state: "CLOSED" });
    journal(113).push(je({ to: "in-progress" }));
    w.closedRows = [113];
    w.persistFails = true;
    w.expireFails = true;
    const report = await runReconcile(w.deps);
    assert.ok(report.errors.includes("persist-failed:#112"), report.errors.join());
    assert.ok(report.errors.includes("expire-failed:#113"), report.errors.join());
  });

  test("a failed cap-reset post leaves the diff unchanged so the next tick retries and posts the marker", async () => {
    const { w, add, journal } = world();
    add(114, ["ready-for-agent"]);
    journal(114).push(je({ kind: "transition", to: "parked", reason: "cap:total-claims" }));
    w.timelines.set(114, [
      { event: "labeled", label: "parked", tsMs: T1 },
      { event: "unlabeled", label: "parked", tsMs: T2 },
      { event: "labeled", label: "ready-for-agent", tsMs: T2 },
    ]);
    w.postFails = true;
    const first = await runReconcile(w.deps);
    assert.ok(first.errors.some((e) => e.startsWith("cap-reset-failed:#114")));
    assert.equal(w.appends.filter((a) => a.issue === 114).length, 0);
    w.postFails = false;
    const second = await runReconcile(w.deps);
    assert.equal(w.posted.filter((p) => p.number === 114 && p.body.startsWith("Hydra-Cap-Reset:")).length, 1);
    assert.equal(second.externalEntries, 1);
  });

  test("INV-10 tally scope is open issues only: a closed issue's journal is not counted", async () => {
    const { w, add, journal } = world();
    add(115, ["ready-for-agent"]);
    journal(115).push(je({ kind: "transition", ts: NOW - 1000, to: "ready-for-agent" }));
    add(116, [], { state: "CLOSED" });
    journal(116).push(je({ kind: "transition", ts: NOW - 1000, to: "closed", written: true }));
    w.closedRows = [116];
    const report = await runReconcile(w.deps);
    assert.equal(report.seamTransitions, 1);
  });
});

describe("PR-covered ready-for-agent promotion (#5489)", () => {
  const closing = (n: number, over: Partial<OpenPrRef> = {}): OpenPrRef => ({ number: 900 + n, body: `Closes #${n}`, ...over });

  test("a ready-for-agent issue with one open non-draft closing PR routes to needs-qa through the seam with actor reconcile and evidence.pr", async () => {
    const { w, add, journal } = world();
    add(500, ["ready-for-agent"]);
    w.prs = [closing(500)];
    w.prRecords.set(1400, { number: 1400, state: "OPEN", body: "Closes #500" });
    const report = await runReconcile(w.deps);
    assert.deepEqual(w.edits, [{ issue: 500, remove: ["ready-for-agent"], add: ["needs-qa"] }]);
    assert.deepEqual(report.prCovered, { promoted: 1, ambiguous: 0, claimHeld: 0, refused: 0 });
    const entry = journal(500).find((e) => e.to === "needs-qa");
    assert.equal(entry?.actor, "reconcile");
    assert.equal(entry?.evidence?.pr, "1400");
  });

  test("a draft PR is not a candidate: no write", async () => {
    const { w, add } = world();
    add(501, ["ready-for-agent"]);
    w.prs = [closing(501, { isDraft: true })];
    const report = await runReconcile(w.deps);
    assert.equal(w.edits.length, 0);
    assert.deepEqual(report.prCovered, { promoted: 0, ambiguous: 0, claimHeld: 0, refused: 0 });
  });

  test("2+ closing PRs are ambiguous: counted, no write", async () => {
    const { w, add } = world();
    add(502, ["ready-for-agent"]);
    w.prs = [closing(502), { number: 7777, body: "Fixes #502" }];
    const report = await runReconcile(w.deps);
    assert.equal(w.edits.length, 0);
    assert.equal(report.prCovered.ambiguous, 1);
  });

  test("a held dispatch claim skips the promotion; a failed claim read is an error with no write", async () => {
    const { w, add } = world();
    add(503, ["ready-for-agent"]);
    add(504, ["ready-for-agent"]);
    w.prs = [closing(503), closing(504)];
    w.deps.seam.journal.readClaim = async (_r, n) =>
      n === 503
        ? { ok: true, claim: { dispatchId: "d", class: "dev_orch", run: "r", artifactHash: null, openedAt: NOW } as never }
        : { ok: false, error: "x" };
    const report = await runReconcile(w.deps);
    assert.equal(w.edits.length, 0);
    assert.equal(report.prCovered.claimHeld, 1);
    assert.ok(report.errors.includes("claim-read-failed:#504"));
  });

  test("promotions are bounded per pass", async () => {
    const { w, add } = world();
    for (const n of [510, 511, 512]) {
      add(n, ["ready-for-agent"]);
      w.prs.push(closing(n));
      w.prRecords.set(900 + n, { number: 900 + n, state: "OPEN", body: `Closes #${n}` });
    }
    const report = await runReconcile(w.deps, { maxPrCoveredPromotions: 2 });
    assert.equal(report.prCovered.promoted, 2);
    assert.equal(w.edits.length, 2);
  });

  test("needs-dev-resume and in-progress rows with an open closing PR get no write from this arm", async () => {
    const { w, add } = world();
    add(520, ["needs-dev-resume"]);
    add(521, ["in-progress"]);
    w.prs = [closing(520), closing(521)];
    const report = await runReconcile(w.deps);
    assert.equal(w.edits.length, 0);
    assert.equal(report.prCovered.promoted, 0);
  });

  test("a failed open-PR read does nothing; dry-run counts a would-promote and writes nothing", async () => {
    const { w, add } = world();
    add(530, ["ready-for-agent"]);
    w.prs = [closing(530)];
    const dry = await runReconcile(w.deps, { dryRun: true });
    assert.equal(dry.prCovered.promoted, 1);
    assert.equal(w.edits.length, 0);
    w.deps.listOpenPrs = async () => ({ ok: false });
    const failed = await runReconcile(w.deps);
    assert.equal(failed.prCovered.promoted, 0);
    assert.equal(w.edits.length, 0);
  });

  test("singleClosingPr: one closing PR, drafts removed, ambiguity and null read", () => {
    const prs: OpenPrRef[] = [{ number: 1, body: "Closes #9" }, { number: 2, body: "Closes #9", isDraft: true }];
    assert.equal(singleClosingPr(prs, 9), 1);
    assert.equal(singleClosingPr([...prs, { number: 3, body: "Closes #9" }], 9), null);
    assert.equal(singleClosingPr(prs, 10), null);
    assert.equal(singleClosingPr(null, 9), null);
  });
});
