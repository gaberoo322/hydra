/**
 * Regression tests for the design-concept module (Phase A of #437 / #438).
 *
 * Each test corresponds to a gate failure mode from ADR-0008. Uses a
 * separate Redis DB (1) so it never touches production data — mirrors
 * the pattern in `test/redis-adapter-roundtrip.test.mts`.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

// Force test DB before any module that reads REDIS_URL is loaded.
process.env.REDIS_URL = "redis://localhost:6379/1";

const dc = await import("../src/design-concept.ts");

const TEST_NS = "hydra:design-concept:";
let testRedis: any;

// Build a minimal artifact that passes every gate rule by default.
function buildComplete(overrides: Partial<dc.DesignConcept> = {}): dc.DesignConceptInput {
  return {
    anchorRef: "test:complete",
    scope: "orch",
    glossaryTerms: ["Target", "Orchestrator"],
    glossaryGaps: [],
    modulesTouched: [
      {
        path: "src/foo.ts",
        interfaceImpact: "extend",
        depthClassification: "deep",
      },
    ],
    invariants: ["never throw from gate"],
    rejectedAlternatives: [{ alt: "noop", why: "doesn't ship" }],
    qaTrace: [
      { q: "what is the target?", a: "hydra-betting" },
      { q: "what module?", a: "src/foo.ts" },
      { q: "interface impact?", a: "extend" },
      { q: "invariants?", a: "never throw" },
      { q: "rejected?", a: "noop" },
      { q: "tier?", a: "3" },
    ],
    prototypes: [],
    ...overrides,
  };
}

describe("design-concept Redis store + gate", () => {
  beforeEach(async () => {
    if (!testRedis) testRedis = new Redis("redis://localhost:6379/1");
    const keys = await testRedis.keys(TEST_NS + "*");
    if (keys.length > 0) await testRedis.del(...keys);
  });

  after(async () => {
    const keys = await testRedis.keys(TEST_NS + "*");
    if (keys.length > 0) await testRedis.del(...keys);
    if (testRedis) testRedis.disconnect();
  });

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  test("saveDesignConcept round-trips through Redis", async () => {
    const input = buildComplete({ anchorRef: "test:rt" } as any);
    const saved = await dc.saveDesignConcept(input);

    assert.equal(saved.anchorRef, "test:rt");
    assert.equal(saved.scope, "orch");
    assert.ok(saved.createdAt > 0, "createdAt set server-side");
    assert.match(saved.artifactHash, /^[0-9a-f]{64}$/, "artifactHash is sha256 hex");
    assert.equal(saved.status, "draft");
    assert.equal(saved.approvedBy, "");

    const fetched = await dc.getDesignConcept("test:rt");
    assert.ok(fetched, "fetched non-null");
    assert.equal(fetched!.anchorRef, "test:rt");
    assert.equal(fetched!.glossaryTerms.length, 2);
    assert.equal(fetched!.modulesTouched[0].path, "src/foo.ts");
    assert.equal(fetched!.invariants[0], "never throw from gate");
    assert.equal(fetched!.qaTrace.length, 6);
    assert.equal(fetched!.artifactHash, saved.artifactHash);
  });

  // -------------------------------------------------------------------------
  // #736 — anchor-ref key-format normalization (write→read round-trip on the
  // exact string decide.py dispatches: `issue-<N>`).
  // -------------------------------------------------------------------------

  test("#736 normalizeAnchorRef canonicalizes to issue-<N>", () => {
    assert.equal(dc.normalizeAnchorRef("736"), "issue-736");
    assert.equal(dc.normalizeAnchorRef("#736"), "issue-736");
    assert.equal(dc.normalizeAnchorRef("issue #736"), "issue-736");
    assert.equal(dc.normalizeAnchorRef("issue-736"), "issue-736", "idempotent");
    assert.equal(dc.normalizeAnchorRef("ISSUE-736"), "issue-736", "prefix case-insensitive");
    assert.equal(dc.normalizeAnchorRef("  736  "), "issue-736", "trims");
    // Non-issue refs pass through unchanged.
    assert.equal(dc.normalizeAnchorRef("test:rt"), "test:rt");
    assert.equal(dc.normalizeAnchorRef("PR-4: fold scheduler"), "PR-4: fold scheduler");
    assert.equal(dc.normalizeAnchorRef("Some issue title 736 here"), "Some issue title 736 here");
  });

  test("#736 write under bare number → read by the dispatched issue-<N> string", async () => {
    // This is the exact orphaning repro: the grill writes `"736"`, but
    // collect-state.sh / decide.py read `"issue-736"`. After normalization
    // both must resolve to the same artifact.
    const saved = await dc.saveDesignConcept(buildComplete({ anchorRef: "736" } as any));
    assert.equal(saved.anchorRef, "issue-736", "persisted ref is canonicalized");

    // Read by the dispatched form — the form that used to 404.
    const byIssueForm = await dc.getDesignConcept("issue-736");
    assert.ok(byIssueForm, "GET .../issue-736 must now resolve (was 404)");
    assert.equal(byIssueForm!.anchorRef, "issue-736");
    assert.equal(byIssueForm!.artifactHash, saved.artifactHash);

    // Read by the bare form must resolve to the same artifact.
    const byBareForm = await dc.getDesignConcept("736");
    assert.ok(byBareForm, "GET .../736 still resolves");
    assert.equal(byBareForm!.artifactHash, saved.artifactHash);

    // Only one underlying key exists (no orphan under the bare number).
    const keys = await testRedis.keys(TEST_NS + "736");
    assert.equal(keys.length, 0, "no orphaned bare-number key");
    const canonKeys = await testRedis.keys(TEST_NS + "issue-736");
    assert.equal(canonKeys.length, 1, "exactly one canonical key");
  });

  test("#736 approve by either form targets the canonical key", async () => {
    await dc.saveDesignConcept(buildComplete({ anchorRef: "issue-742" } as any));
    // Approve using the bare form — must hit the same canonical key.
    const approved = await dc.approveDesignConcept("742", "auto-gate");
    assert.equal(approved.status, "approved");
    const fetched = await dc.getDesignConcept("issue-742");
    assert.equal(fetched!.status, "approved", "approval visible under issue-<N>");
    assert.equal(fetched!.approvedBy, "auto-gate");
  });

  test("saveDesignConcept overwrites on second call (idempotent on anchorRef)", async () => {
    const a = await dc.saveDesignConcept(buildComplete({ anchorRef: "test:idem" } as any));
    const b = await dc.saveDesignConcept(
      buildComplete({
        anchorRef: "test:idem",
        invariants: ["different invariant"],
      } as any),
    );
    assert.notEqual(a.artifactHash, b.artifactHash, "content change → new hash");
    const fetched = await dc.getDesignConcept("test:idem");
    assert.equal(fetched!.invariants[0], "different invariant");
  });

  test("approveDesignConcept flips status and records approvedBy", async () => {
    await dc.saveDesignConcept(buildComplete({ anchorRef: "test:approve" } as any));
    const approved = await dc.approveDesignConcept("test:approve", "operator:gabe");
    assert.equal(approved.status, "approved");
    assert.equal(approved.approvedBy, "operator:gabe");
    const fetched = await dc.getDesignConcept("test:approve");
    assert.equal(fetched!.status, "approved");
    assert.equal(fetched!.approvedBy, "operator:gabe");
  });

  test("approveDesignConcept rejects malformed 'by'", async () => {
    await dc.saveDesignConcept(buildComplete({ anchorRef: "test:badby" } as any));
    await assert.rejects(
      () => dc.approveDesignConcept("test:badby", "bogus"),
      /auto-gate|operator/,
    );
  });

  test("approveDesignConcept throws for unknown anchorRef", async () => {
    await assert.rejects(
      () => dc.approveDesignConcept("test:does-not-exist", "auto-gate"),
      /no artifact/,
    );
  });

  test("listDesignConcepts returns reverse-chronological, scope-filtered", async () => {
    const t0 = Date.now() - 5000;
    await dc.saveDesignConcept(
      buildComplete({ anchorRef: "test:list-1", scope: "orch" } as any),
      t0,
    );
    await dc.saveDesignConcept(
      buildComplete({ anchorRef: "test:list-2", scope: "target" } as any),
      t0 + 1000,
    );
    await dc.saveDesignConcept(
      buildComplete({ anchorRef: "test:list-3", scope: "orch" } as any),
      t0 + 2000,
    );

    const all = await dc.listDesignConcepts({ limit: 10 });
    const allRefs = all.map((x) => x.anchorRef).filter((r) => r.startsWith("test:list-"));
    assert.deepEqual(allRefs, ["test:list-3", "test:list-2", "test:list-1"]);

    const orchOnly = await dc.listDesignConcepts({ scope: "orch", limit: 10 });
    const orchRefs = orchOnly.map((x) => x.anchorRef).filter((r) => r.startsWith("test:list-"));
    assert.deepEqual(orchRefs, ["test:list-3", "test:list-1"]);
  });

  test("listDesignConcepts prunes stale (>7d) entries from the index", async () => {
    const now = Date.now();
    const stale = now - dc.DESIGN_CONCEPT_MAX_AGE_MS - 60_000;
    await dc.saveDesignConcept(
      buildComplete({ anchorRef: "test:stale" } as any),
      stale,
    );
    await dc.saveDesignConcept(
      buildComplete({ anchorRef: "test:fresh" } as any),
      now,
    );
    // Manually clear the hash for the stale entry so the prune sees a gap.
    await testRedis.del("hydra:design-concept:test:stale");

    const items = await dc.listDesignConcepts({ now, limit: 10 });
    const refs = items.map((x) => x.anchorRef);
    assert.ok(refs.includes("test:fresh"));
    assert.ok(!refs.includes("test:stale"));

    const indexMembers = await testRedis.zrange("hydra:design-concept:index", 0, -1);
    assert.ok(!indexMembers.includes("test:stale"), "stale removed from index");
  });

  // -------------------------------------------------------------------------
  // artifactHash determinism
  // -------------------------------------------------------------------------

  test("artifactHash is deterministic over canonical JSON (key order ignored)", () => {
    const a: any = {
      anchorRef: "test:hash",
      scope: "orch",
      createdAt: 111,
      status: "draft",
      approvedBy: "",
      glossaryTerms: ["a", "b"],
      glossaryGaps: [],
      modulesTouched: [
        { path: "src/foo.ts", interfaceImpact: "none", depthClassification: "deep" },
      ],
      invariants: ["x"],
      rejectedAlternatives: [],
      qaTrace: [{ q: "1", a: "2" }],
      prototypes: [],
    };
    // Same body, reordered keys, different createdAt/status/approvedBy.
    const b: any = {
      prototypes: [],
      qaTrace: [{ q: "1", a: "2" }],
      rejectedAlternatives: [],
      invariants: ["x"],
      modulesTouched: [
        { depthClassification: "deep", interfaceImpact: "none", path: "src/foo.ts" },
      ],
      glossaryGaps: [],
      glossaryTerms: ["a", "b"],
      approvedBy: "operator:gabe", // ignored
      status: "approved",           // ignored
      createdAt: 999,               // ignored
      scope: "orch",
      anchorRef: "test:hash",
    };
    assert.equal(dc.computeArtifactHash(a), dc.computeArtifactHash(b));
  });

  test("artifactHash changes when body content changes", () => {
    const base: any = {
      anchorRef: "test:hash2",
      scope: "orch",
      createdAt: 0,
      status: "draft",
      approvedBy: "",
      glossaryTerms: [],
      glossaryGaps: [],
      modulesTouched: [],
      invariants: ["x"],
      rejectedAlternatives: [],
      qaTrace: [],
      prototypes: [],
    };
    const h1 = dc.computeArtifactHash(base);
    const h2 = dc.computeArtifactHash({ ...base, invariants: ["y"] });
    assert.notEqual(h1, h2);
  });

  // -------------------------------------------------------------------------
  // Freshness
  // -------------------------------------------------------------------------

  test("isFresh honors the 7-day window", () => {
    const now = 1_000_000_000_000;
    const fresh = { createdAt: now - 6 * 24 * 60 * 60 * 1000 } as dc.DesignConcept;
    const stale = { createdAt: now - 8 * 24 * 60 * 60 * 1000 } as dc.DesignConcept;
    assert.equal(dc.isFresh(fresh, now), true);
    assert.equal(dc.isFresh(stale, now), false);
  });

  // -------------------------------------------------------------------------
  // gateCheck — happy path
  // -------------------------------------------------------------------------

  test("gateCheck returns ok for a complete approved artifact", async () => {
    const saved = await dc.saveDesignConcept(
      buildComplete({ anchorRef: "test:gate-ok" } as any),
    );
    const approved = await dc.approveDesignConcept(saved.anchorRef, "auto-gate");
    const verdict = dc.gateCheck(approved, Date.now());
    assert.equal(verdict.ok, true, `reasons: ${verdict.reasons.join("; ")}`);
    assert.deepEqual(verdict.reasons, []);
  });

  // -------------------------------------------------------------------------
  // gateCheck — 7 failure modes
  // -------------------------------------------------------------------------

  function approvedFresh(overrides: Partial<dc.DesignConcept> = {}): dc.DesignConcept {
    const input = buildComplete(overrides as any);
    return {
      ...input,
      anchorRef: input.anchorRef,
      createdAt: Date.now(),
      artifactHash: "deadbeef",
      status: "approved",
      approvedBy: "auto-gate",
      ...overrides,
    } as dc.DesignConcept;
  }

  test("gateCheck fails on non-empty glossaryGaps", () => {
    const v = dc.gateCheck(
      approvedFresh({ glossaryGaps: ["UnknownTerm"] }),
      Date.now(),
    );
    assert.equal(v.ok, false);
    assert.ok(v.reasons.some((r) => r.includes("glossaryGaps")), v.reasons.join(";"));
  });

  test("gateCheck fails on empty invariants", () => {
    const v = dc.gateCheck(approvedFresh({ invariants: [] }), Date.now());
    assert.equal(v.ok, false);
    assert.ok(v.reasons.some((r) => r.includes("invariants")));
  });

  test("gateCheck fails on empty modulesTouched", () => {
    const v = dc.gateCheck(approvedFresh({ modulesTouched: [] }), Date.now());
    assert.equal(v.ok, false);
    assert.ok(v.reasons.some((r) => r.includes("modulesTouched")));
  });

  test("gateCheck fails when 'breaking' impact lives on a tier-1 path", () => {
    // config/agents/ is Tier 1 per src/tier-classifier.ts — below the
    // tier-2 minimum the gate requires for a breaking change.
    const v = dc.gateCheck(
      approvedFresh({
        modulesTouched: [
          {
            path: "config/agents/planner.md",
            interfaceImpact: "breaking",
            depthClassification: "shallow",
          },
        ],
      }),
      Date.now(),
    );
    assert.equal(v.ok, false);
    assert.ok(
      v.reasons.some((r) => r.includes("breaking")),
      `expected breaking reason, got: ${v.reasons.join("; ")}`,
    );
  });

  test("gateCheck PASSES tier check when 'breaking' impact is on a tier-2 path", () => {
    // .claude/skills/ is Tier 2 in TIER_2_PREFIXES.
    const v = dc.gateCheck(
      approvedFresh({
        modulesTouched: [
          {
            path: ".claude/skills/hydra-grill/SKILL.md",
            interfaceImpact: "breaking",
            depthClassification: "shallow",
          },
        ],
      }),
      Date.now(),
    );
    // The breaking rule itself must not fire — other rules already met.
    assert.equal(v.ok, true, `reasons: ${v.reasons.join("; ")}`);
  });

  test("gateCheck fails on short qaTrace (<6 turns)", () => {
    const v = dc.gateCheck(
      approvedFresh({
        qaTrace: [
          { q: "1", a: "2" },
          { q: "3", a: "4" },
        ],
      }),
      Date.now(),
    );
    assert.equal(v.ok, false);
    assert.ok(v.reasons.some((r) => r.includes("qaTrace")));
  });

  test("gateCheck fails on stale createdAt (>7 days)", () => {
    const now = Date.now();
    const stale: dc.DesignConcept = {
      ...approvedFresh(),
      createdAt: now - dc.DESIGN_CONCEPT_MAX_AGE_MS - 60_000,
    };
    const v = dc.gateCheck(stale, now);
    assert.equal(v.ok, false);
    assert.ok(v.reasons.some((r) => r.includes("stale")));
  });

  test("gateCheck fails on draft status", () => {
    const v = dc.gateCheck(
      { ...approvedFresh(), status: "draft", approvedBy: "" } as dc.DesignConcept,
      Date.now(),
    );
    assert.equal(v.ok, false);
    assert.ok(v.reasons.some((r) => r.includes("status")));
  });
});
