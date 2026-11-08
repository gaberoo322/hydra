/**
 * Dispatcher-claim seam semantics (ADR-0047 D4/D5/D7, issue #5315).
 *
 * Offline: gh / Redis / clock are in-memory fakes with real SET NX and
 * compare-and-delete semantics. Pins design-concept invariants INV-1..INV-9, INV-11.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CLAIM_OUTCOMES,
  STALE_CLAIM_AGE_MS,
  MAX_STALE_CLAIM_CLOSES,
  dispatch,
  openClaim,
  releaseClaim,
  releaseClaimByDispatch,
  runReconcile,
  type ReconcileDeps,
  type SeamDeps,
} from "../src/lifecycle/index.ts";
import { runBackfill } from "../scripts/lifecycle-legacy-backfill.ts";
import { main as lifecycleMain } from "../scripts/lifecycle.ts";
import type { DispatchClaim, LifecycleJournalEntry } from "../src/redis/lifecycle-journal.ts";

const NOW = Date.parse("2026-11-07T12:00:00.000Z");

function world(mode: "shadow" | "enforce" = "enforce", dc: { status: string; hash: string | null } | null = null) {
  const w = {
    now: NOW,
    claims: new Map<number, DispatchClaim>(),
    labels: new Map<number, string[]>(),
    edits: [] as Array<{ issue: number; remove: string[]; add: string[] }>,
    journal: [] as Array<{ issue: number; entry: LifecycleJournalEntry }>,
    setCalls: [] as string[],
    /** Runs between listClaims and the stale arm's close (simulates a racing re-open). */
    afterList: null as null | (() => void),
  };
  const seam: SeamDeps = {
    repo: "o/r",
    mode: async () => mode,
    view: async (n) => {
      const labels = w.labels.get(n);
      return labels
        ? { ok: true, row: { number: n, title: "t", url: "", createdAt: "", labels: [...labels], body: "", state: "OPEN" } }
        : { ok: false, code: "gh-failed" };
    },
    edit: async (n, l) => {
      w.edits.push({ issue: n, remove: l.remove, add: l.add });
      w.labels.set(n, (w.labels.get(n) ?? []).filter((x) => !l.remove.includes(x)).concat(l.add));
      return { ok: true };
    },
    close: async () => ({ ok: true }),
    comment: async () => ({ ok: true }),
    env: () => ({}),
    fetch: {
      designConcept: async () =>
        dc === null
          ? { ok: true, value: { exists: false, status: "", artifactHash: null } }
          : { ok: true, value: { exists: true, status: dc.status, artifactHash: dc.hash } },
      pr: async () => ({ ok: false }),
      comment: async () => ({ ok: false }),
      stateEntry: async () => ({ ok: true, value: { enteredAtMs: null } }),
      issueComments: async () => ({ ok: true, value: [] }),
      timeline: async () => ({ ok: true, value: [] }),
      prBodies: async () => ({ ok: true, value: [] }),
    },
    journal: {
      append: async (_r, n, e) => (w.journal.push({ issue: n, entry: e }), { ok: true }),
      expireOnClose: async () => ({ ok: true }),
      openClaim: async (_r, n, claim) => {
        w.setCalls.push(`SET claim:${n} NX`); // no EX/PX is ever passed: the seam has no expiry argument
        const existing = w.claims.get(n);
        if (existing) return { ok: false, code: "claim-held", existing };
        w.claims.set(n, claim);
        return { ok: true, claim };
      },
      closeClaim: async (_r, n, id) => {
        const cur = w.claims.get(n);
        if (!cur) return { ok: true, prior: null };
        if (id === "" || cur.dispatchId !== id) return { ok: false, error: "claim-owner-mismatch" };
        w.claims.delete(n);
        return { ok: true, prior: cur };
      },
      read: async () => ({ ok: true, entries: [] }),
      readClaim: async (_r, n) => ({ ok: true, claim: w.claims.get(n) ?? null }),
      listClaims: async () => {
        const claims = [...w.claims].map(([issue, claim]) => ({ issue, claim: { ...claim } }));
        const hook = w.afterList;
        if (hook) queueMicrotask(hook);
        return { ok: true, claims };
      },
    },
    now: () => w.now,
  };
  return { w, seam };
}

const D = (id: string, cls = "dev_orch") => ({ issue: 10, dispatchId: id, class: cls, run: "r1" });
const closedEntries = (w: ReturnType<typeof world>["w"]) => w.journal.filter((j) => j.entry.kind === "claim-closed");

describe("dispatch: concurrent claims (INV-7)", () => {
  for (const mode of ["shadow", "enforce"] as const) {
    test(`a concurrent second dispatch is refused by SET NX in ${mode}: no label write, no journal entry`, async () => {
      const { w, seam } = world(mode);
      w.labels.set(10, ["ready-for-agent"]);
      const first = await dispatch(D("d1"), seam);
      assert.equal(first.ok, true);
      const editsBefore = w.edits.length;
      const journalBefore = w.journal.length;
      const second = await dispatch(D("d2"), seam);
      assert.equal(second.ok, false);
      assert.equal(second.ok === false && second.code, "claim-held");
      assert.equal(w.edits.length, editsBefore);
      assert.equal(w.journal.length, journalBefore);
      assert.equal(w.claims.get(10)?.dispatchId, "d1");
    });
  }

  test("a held legacy-backfill claim is released by its own dispatchId and the new claim opens in the same call", async () => {
    const { w, seam } = world();
    w.labels.set(10, ["in-progress"]);
    w.claims.set(10, { dispatchId: "legacy-backfill-10", class: "legacy-backfill", run: "x", artifactHash: null, openedAt: NOW });
    const res = await openClaim({ issue: 10, dispatchId: "d9", class: "dev_orch", run: "r" }, seam);
    assert.equal(res.ok, true);
    assert.equal(w.claims.get(10)?.dispatchId, "d9");
    const closed = closedEntries(w);
    assert.equal(closed.length, 1);
    assert.equal(closed[0].entry.evidence.dispatch, "legacy-backfill-10");
    assert.equal(closed[0].entry.evidence.outcome, "released");
  });
});

describe("dispatch: composite verb (INV-6, INV-8)", () => {
  test("enforce refusal of the in-progress advance releases the claim before the refusal is returned", async () => {
    const { w, seam } = world("enforce", { status: "draft", hash: "h" });
    w.labels.set(10, ["ready-for-agent", "needs-design-concept"]);
    const res = await dispatch(D("d1"), seam);
    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.code, "advance-refused");
    assert.equal(res.ok === false && "released" in res && res.released, true);
    assert.equal(w.claims.has(10), false);
    assert.equal(w.edits.length, 0);
  });

  test("shadow writes the label and reports wouldRefuse", async () => {
    const { w, seam } = world("shadow", { status: "draft", hash: "h" });
    w.labels.set(10, ["ready-for-agent", "needs-design-concept"]);
    const res = await dispatch(D("d1"), seam);
    assert.equal(res.ok, true);
    assert.equal(res.ok && res.wouldRefuse, "design-concept-draft");
    assert.equal(w.claims.has(10), true);
    assert.deepEqual(w.labels.get(10)?.includes("in-progress"), true);
  });

  test("an approved artifact hash is copied onto the claim; a draft hash is not", async () => {
    const approved = world("enforce", { status: "approved", hash: "abc123" });
    approved.w.labels.set(10, ["ready-for-agent"]);
    await dispatch(D("d1"), approved.seam);
    assert.equal(approved.w.claims.get(10)?.artifactHash, "abc123");

    const draft = world("shadow", { status: "draft", hash: "zzz" });
    draft.w.labels.set(10, ["ready-for-agent"]);
    await dispatch(D("d1"), draft.seam);
    assert.equal(draft.w.claims.get(10)?.artifactHash, null);
  });

  test("a qa role opens a label-free claim", async () => {
    const { w, seam } = world();
    w.labels.set(10, ["needs-qa"]);
    const res = await dispatch(D("q1", "qa_orch"), seam);
    assert.equal(res.ok, true);
    assert.equal(res.ok && res.advanced, null);
    assert.equal(w.edits.length, 0);
    assert.equal(w.claims.get(10)?.class, "qa_orch");
  });

  test("a dev dispatch on a ready-for-agent issue advances it to in-progress", async () => {
    const { w, seam } = world();
    w.labels.set(10, ["ready-for-agent"]);
    const res = await dispatch(D("d1"), seam);
    assert.equal(res.ok, true);
    assert.deepEqual(w.labels.get(10), ["in-progress"]);
  });
});

describe("release by dispatch id (INV-2, INV-4)", () => {
  test("closes the matching claim without an issue number and journals the outcome", async () => {
    const { w, seam } = world();
    await openClaim({ issue: 10, dispatchId: "d1", class: "dev_orch", run: "r" }, seam);
    const res = await releaseClaimByDispatch("d1", seam, "cli", "no-pr");
    assert.deepEqual(res.ok && res.issue, 10);
    assert.equal(w.claims.size, 0);
    assert.equal(closedEntries(w)[0].entry.evidence.outcome, "no-pr");
  });

  test("zero matches is idempotent: ok, null prior, no journal entry", async () => {
    const { w, seam } = world();
    const res = await releaseClaimByDispatch("nope", seam);
    assert.deepEqual(res, { ok: true, prior: null, issue: null });
    assert.equal(w.journal.length, 0);
  });

  test("a claim owned by another dispatch is never deleted by releaseClaim", async () => {
    const { w, seam } = world();
    await openClaim({ issue: 10, dispatchId: "d1", class: "dev_orch", run: "r" }, seam);
    const res = await releaseClaim(10, "other", seam);
    assert.equal(res.ok === false && res.code, "claim-owner-mismatch");
    assert.equal(w.claims.has(10), true);
  });

  test("the CLI rejects an unknown --outcome with exit 2", async () => {
    assert.equal(await lifecycleMain(["release", "--dispatch", "d1", "--outcome", "bogus"]), 2);
    assert.equal(CLAIM_OUTCOMES.includes("stale"), true);
  });
});

function reconcileDeps(seam: SeamDeps): ReconcileDeps {
  return {
    seam,
    listOpenIssues: async () => ({ ok: true, rows: [] }),
    listOpenPrs: async () => ({ ok: true, value: [] }),
    listRecentlyClosed: async () => ({ ok: true, rows: [] }),
    persistJournal: async () => ({ ok: true }),
    writeReport: async () => ({ ok: true }),
  };
}

describe("reconcile stale-claim arm (INV-3)", () => {
  test("closes a claim at exactly STALE_CLAIM_AGE_MS with outcome stale and spares one at age-1ms", async () => {
    const { w, seam } = world();
    w.claims.set(1, { dispatchId: "old", class: "dev_orch", run: "r", artifactHash: null, openedAt: NOW - STALE_CLAIM_AGE_MS });
    w.claims.set(2, { dispatchId: "young", class: "dev_orch", run: "r", artifactHash: null, openedAt: NOW - STALE_CLAIM_AGE_MS + 1 });
    const report = await runReconcile(reconcileDeps(seam));
    assert.equal(w.claims.has(1), false);
    assert.equal(w.claims.has(2), true);
    assert.equal(report.staleClaims.closed, 1);
    const closed = closedEntries(w);
    assert.equal(closed.length, 1);
    assert.equal(closed[0].entry.evidence.outcome, "stale");
    assert.equal(closed[0].entry.actor, "reconcile");
  });

  test("does NOT delete a claim re-opened under a different dispatchId between list and close", async () => {
    const { w, seam } = world();
    w.claims.set(1, { dispatchId: "old", class: "dev_orch", run: "r", artifactHash: null, openedAt: NOW - STALE_CLAIM_AGE_MS - 5 });
    w.afterList = () => {
      w.claims.set(1, { dispatchId: "fresh", class: "dev_orch", run: "r2", artifactHash: null, openedAt: NOW });
    };
    const report = await runReconcile(reconcileDeps(seam));
    assert.equal(w.claims.get(1)?.dispatchId, "fresh");
    assert.equal(report.staleClaims.spared, 1);
    assert.equal(report.staleClaims.closed, 0);
    assert.deepEqual(report.errors, []);
    assert.equal(closedEntries(w).length, 0);
  });

  test("dry-run classifies and writes nothing; closes are bounded per pass", async () => {
    const { w, seam } = world();
    for (let i = 1; i <= MAX_STALE_CLAIM_CLOSES + 3; i++) {
      w.claims.set(i, { dispatchId: `d${i}`, class: "dev_orch", run: "r", artifactHash: null, openedAt: 0 });
    }
    const dry = await runReconcile(reconcileDeps(seam), { dryRun: true });
    assert.equal(w.claims.size, MAX_STALE_CLAIM_CLOSES + 3);
    assert.equal(dry.staleClaims.closed, MAX_STALE_CLAIM_CLOSES);
    assert.equal(dry.staleClaims.deferred, 3);
    const live = await runReconcile(reconcileDeps(seam));
    assert.equal(live.staleClaims.closed, MAX_STALE_CLAIM_CLOSES);
    assert.equal(w.claims.size, 3);
  });
});

describe("legacy backfill (INV-9)", () => {
  function backfillDeps(w: ReturnType<typeof world>["w"], seam: SeamDeps) {
    return {
      seam,
      listOpenIssues: async () => ({
        ok: true as const,
        rows: [...w.labels].map(([number, labels]) => ({ number, title: "t", url: "", createdAt: "", labels, body: "", state: "OPEN" })),
      }),
    };
  }

  test("dry-run writes nothing; --apply writes one claim per in-progress issue and a second run is a no-op", async () => {
    const { w, seam } = world();
    w.labels.set(1, ["in-progress"]);
    w.labels.set(2, ["in-progress"]);
    w.labels.set(3, ["ready-for-agent"]);
    const deps = backfillDeps(w, seam);

    const dry = await runBackfill(deps);
    assert.deepEqual(dry.summary, { scanned: 2, claimed: 2, held: 0, failed: 0 });
    assert.equal(w.claims.size, 0);

    const first = await runBackfill(deps, { apply: true });
    assert.deepEqual(first.summary, { scanned: 2, claimed: 2, held: 0, failed: 0 });
    assert.equal(w.claims.get(1)?.class, "legacy-backfill");
    assert.equal(w.claims.get(1)?.dispatchId, "legacy-backfill-1");
    const editsAfterFirst = w.edits.length;
    const journalAfterFirst = w.journal.length;

    const second = await runBackfill(deps, { apply: true });
    assert.deepEqual(second.summary, { scanned: 2, claimed: 0, held: 2, failed: 0 });
    assert.equal(w.edits.length, editsAfterFirst);
    assert.equal(w.journal.length, journalAfterFirst);
    assert.equal(editsAfterFirst, 0, "backfill never writes a label");
  });
});

describe("legacy backfill never cap-parks (INV-9)", () => {
  const overCap = (w: ReturnType<typeof world>["w"], seam: SeamDeps): SeamDeps => ({
    ...seam,
    env: () => ({ HYDRA_LIFECYCLE_CAP_TOTAL_CLAIMS: "1" }),
    journal: {
      ...seam.journal,
      read: async () => ({
        ok: true,
        entries: [
          { ts: NOW - 1000, kind: "claim-opened", from: null, to: null, evidence: { class: "dev_orch", state: "in-progress" }, reason: null, result: "ok", written: true },
        ] as unknown as LifecycleJournalEntry[],
      }),
    },
  });

  test("an over-cap in-progress issue is claimed by backfill in enforce mode with no label write", async () => {
    const { w, seam } = world("enforce");
    w.labels.set(1, ["in-progress"]);
    const deps = overCap(w, seam);
    const res = await openClaim({ issue: 1, dispatchId: "legacy-backfill-1", class: "legacy-backfill", run: "x" }, deps);
    assert.equal(res.ok, true);
    assert.equal(w.edits.length, 0);
    assert.equal(w.claims.get(1)?.class, "legacy-backfill");
  });

  test("sibling: a real dispatch class over the same cap still parks in enforce mode", async () => {
    const { w, seam } = world("enforce");
    w.labels.set(1, ["in-progress"]);
    const res = await openClaim({ issue: 1, dispatchId: "d1", class: "dev_orch", run: "r1" }, overCap(w, seam));
    assert.equal(res.ok, false);
    assert.match(res.ok === false ? res.code : "", /^parked:/);
  });
});

describe("no TTL, no force path (INV-1, INV-2)", () => {
  test("no hydra:lifecycle:claim:* write carries an expiry", () => {
    const src = readFileSync(new URL("../src/redis/lifecycle-journal.ts", import.meta.url), "utf8");
    assert.match(src, /r\.set\(key, JSON\.stringify\(claim\), "NX"\)/);
    assert.equal(/claim[^\n]*"(EX|PX|EXAT|PXAT)"/.test(src), false);
    assert.equal(/expire\([^)]*[Cc]laim/.test(src), false);
  });

  test("there is no force-release path: no release --held, no releaseHeldClaim", () => {
    const files = ["../scripts/lifecycle.ts", "../src/lifecycle/seam.ts", "../src/lifecycle/reconcile.ts"];
    for (const f of files) {
      const src = readFileSync(new URL(f, import.meta.url), "utf8");
      assert.equal(/releaseHeldClaim|"held"|--held/.test(src), false, f);
    }
  });
});
