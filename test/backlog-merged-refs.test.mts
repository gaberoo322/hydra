/**
 * Regression tests for the MergedAnchorRefs Seam (issue #882 / #1880).
 *
 * `src/backlog/merged-refs.ts` is the shared merged-by-cycle suppression
 * infrastructure extracted from `src/anchor-candidates.ts` (issue #1880). It is
 * owned by NEITHER the Candidate Feed nor the WorkQueueHygiene reconciler — both
 * are consumers. These tests exercise the Seam in isolation, with no Candidate
 * Feed fixture scaffolding:
 *   - the normalized identity-token algebra (`normalizeIdentity`,
 *     `mergedTokensFromPr`, `candidateMergedTokens`, `isMergedWork`,
 *     `mergedTokensFromGhJson`)
 *   - the TTL-cached, swap-seam-aware production loader factory
 *     (`makeMergedAnchorRefsLoader`)
 *
 * The Candidate Feed's USE of these helpers (suppression in the feed,
 * work-queue reap) is pinned in `test/api-anchor-candidates.test.mts`.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  isMergedWork,
  candidateMergedTokens,
  mergedTokensFromPr,
  mergedTokensFromGhJson,
  normalizeIdentity,
  makeMergedAnchorRefsLoader,
  subjectCoverageScore,
  subjectCoveredBy,
  titleSimilarity,
  SUBJECT_MATCH_THRESHOLD,
} from "../src/backlog/merged-refs.ts";
import { __resetForTests as __resetTargetConfig } from "../src/target-config.ts";

describe("merged-by-cycle pure helpers (#882)", () => {
  test("normalizeIdentity lowercases, collapses whitespace, trims", () => {
    assert.equal(normalizeIdentity("  Foo   BAR  "), "foo bar");
    assert.equal(normalizeIdentity(undefined as any), "");
  });

  test("mergedTokensFromPr harvests #NNN, item-NNN, and the normalized title", () => {
    const toks = mergedTokensFromPr(
      "feat: Polymarket CLOB V2 maker order (#910)",
      "Closes #322\n\nImplements item-322 maker stack.",
    );
    assert.ok(toks.includes("910"));
    assert.ok(toks.includes("322"));
    assert.ok(toks.includes("item-322"));
    assert.ok(toks.includes("feat: polymarket clob v2 maker order (#910)"));
  });

  test("candidateMergedTokens emits the bare issue number for a kanban anchor", () => {
    const toks = candidateMergedTokens({ issue: 882, title: "Some anchor", anchorRef: "Some anchor" });
    assert.ok(toks.includes("882"));
    assert.ok(toks.includes("some anchor"));
  });

  test("candidateMergedTokens extracts item-NNN from a target work-queue ref", () => {
    const toks = candidateMergedTokens({
      issue: "item-322",
      title: "item-322 Polymarket CLOB V2 maker order placement",
      anchorRef: "item-322 Polymarket CLOB V2 maker order placement",
    });
    assert.ok(toks.includes("item-322"));
  });

  test("isMergedWork: empty merged-set never suppresses", () => {
    assert.equal(
      isMergedWork({ issue: 1, title: "x", anchorRef: "x" }, new Set()),
      false,
    );
  });

  test("isMergedWork: item-NNN candidate matches a merged item-NNN token", () => {
    const merged = new Set(["item-322"]);
    assert.equal(
      isMergedWork(
        { issue: "item-322", title: "item-322 maker order", anchorRef: "item-322 maker order" },
        merged,
      ),
      true,
    );
  });

  test("isMergedWork: kanban issue number matches a merged #NNN token", () => {
    const merged = new Set(["882"]);
    assert.equal(isMergedWork({ issue: 882, title: "Anchor", anchorRef: "Anchor" }, merged), true);
  });

  test("item-NNN matching is whole-word: item-302 must NOT match merged item-3020 (boundary)", () => {
    // QA-flagged boundary (#882): the `\bitem-(\d+)\b` regex must not treat
    // item-302 and item-3020 as the same identity. A merged item-3020 should
    // suppress ONLY item-3020 — item-302 stays live (and vice-versa).
    const mergedLong = new Set(["item-3020"]);
    assert.equal(
      isMergedWork({ issue: "item-302", title: "item-302 short id", anchorRef: "item-302 short id" }, mergedLong),
      false,
      "item-302 must not be suppressed by a merged item-3020",
    );
    assert.equal(
      isMergedWork({ issue: "item-3020", title: "item-3020 long id", anchorRef: "item-3020 long id" }, mergedLong),
      true,
      "item-3020 IS suppressed by the merged item-3020 token",
    );

    const mergedShort = new Set(["item-302"]);
    assert.equal(
      isMergedWork({ issue: "item-3020", title: "item-3020 long id", anchorRef: "item-3020 long id" }, mergedShort),
      false,
      "item-3020 must not be suppressed by a merged item-302 (prefix is not a match)",
    );

    // Token harvesting itself must normalize to the exact id, not a prefix.
    // (Filter to the canonical `item-<digits>` token shape — the normalized
    // title `item-3020 maker order` is also harvested but is not an id token.)
    const idTok = /^item-\d+$/;
    assert.deepEqual(candidateMergedTokens({ issue: "item-302", title: "item-302", anchorRef: "item-302" }).filter((t) => idTok.test(t)), ["item-302"]);
    assert.deepEqual(mergedTokensFromPr("item-3020 maker order", "").filter((t) => idTok.test(t)), ["item-3020"]);
  });

  test("mergedTokensFromGhJson parses a gh pr list payload; bad input → []", () => {
    const json = JSON.stringify([
      { title: "fix: thing (#5)", body: "Closes #321" },
      { title: "item-481 shipped", body: "" },
    ]);
    const toks = mergedTokensFromGhJson(json);
    assert.ok(toks.includes("5"));
    assert.ok(toks.includes("321"));
    assert.ok(toks.includes("item-481"));
    assert.deepEqual(mergedTokensFromGhJson("not json"), []);
    assert.deepEqual(mergedTokensFromGhJson(""), []);
    assert.deepEqual(mergedTokensFromGhJson("{}"), []);
  });
});

describe("makeMergedAnchorRefsLoader — swap seam + TTL cache (#882, #1834)", () => {
  // A fake `gh` exec that records the repos it was asked to scan and returns a
  // canned merged-PR payload. Shaped like promisify(execFile)'s resolution.
  function fakeExec(payloadByRepo: Record<string, string>) {
    const calls: string[] = [];
    const exec = (async (_cmd: string, args: string[]) => {
      const repoIdx = args.indexOf("--repo");
      const repo = repoIdx >= 0 ? args[repoIdx + 1] : "";
      calls.push(repo);
      return { stdout: payloadByRepo[repo] ?? "[]", stderr: "" };
    }) as any;
    return { exec, calls };
  }

  // Each test constructs a FRESH loader so the closure-local TTL cache starts
  // cold — #1834 replaced the module-level cache + `__resetMergedScanCacheForTests`
  // with this per-loader isolation.
  test("scans the orchestrator repo AND the swap-seam target repo (ADR-0013)", async () => {
    __resetTargetConfig();
    process.env.HYDRA_TARGET_GITHUB_REPO = "acme/widgets";
    try {
      const { exec, calls } = fakeExec({
        "gaberoo322/hydra": JSON.stringify([{ title: "fix (#100)", body: "" }]),
        "acme/widgets": JSON.stringify([{ title: "item-322 maker", body: "" }]),
      });
      const loadMergedAnchorRefs = makeMergedAnchorRefsLoader(exec);
      const refs = await loadMergedAnchorRefs(1_000_000);
      // Both the literal orchestrator repo and the CONFIGURED target repo were
      // scanned — NOT the hardcoded gaberoo322/hydra-betting.
      assert.deepEqual(calls.sort(), ["acme/widgets", "gaberoo322/hydra"]);
      assert.ok(refs.has("100"));
      assert.ok(refs.has("item-322"));
    } finally {
      delete process.env.HYDRA_TARGET_GITHUB_REPO;
      __resetTargetConfig();
    }
  });

  test("a fresh cache entry (<TTL) short-circuits the gh shell-out", async () => {
    __resetTargetConfig();
    process.env.HYDRA_TARGET_GITHUB_REPO = "acme/widgets";
    try {
      const { exec, calls } = fakeExec({
        "gaberoo322/hydra": JSON.stringify([{ title: "fix (#7)", body: "" }]),
        "acme/widgets": "[]",
      });
      const loadMergedAnchorRefs = makeMergedAnchorRefsLoader(exec);
      const t0 = 5_000_000;
      const first = await loadMergedAnchorRefs(t0);
      assert.ok(first.has("7"));
      const callsAfterFirst = calls.length; // 2 (one per repo)

      // Second call 30s later — within the 60s TTL — must reuse the cache.
      const second = await loadMergedAnchorRefs(t0 + 30_000);
      assert.equal(calls.length, callsAfterFirst, "no new gh calls within TTL");
      assert.equal(second, first, "same cached Set instance returned");

      // After the TTL expires, the reader scans again.
      const third = await loadMergedAnchorRefs(t0 + 61_000);
      assert.ok(calls.length > callsAfterFirst, "gh re-scanned after TTL expiry");
      assert.ok(third.has("7"));
    } finally {
      delete process.env.HYDRA_TARGET_GITHUB_REPO;
      __resetTargetConfig();
    }
  });

  test("a gh failure degrades to an empty set and is cached (never throws)", async () => {
    __resetTargetConfig();
    try {
      const exec = (async () => { throw new Error("gh: command not found"); }) as any;
      const loadMergedAnchorRefs = makeMergedAnchorRefsLoader(exec);
      const refs = await loadMergedAnchorRefs(9_000_000);
      assert.equal(refs.size, 0, "total failure → empty set (suppress nothing)");
    } finally {
      __resetTargetConfig();
    }
  });

  test("each loader instance owns an isolated cache (no module-level leak)", async () => {
    __resetTargetConfig();
    process.env.HYDRA_TARGET_GITHUB_REPO = "acme/widgets";
    try {
      const a = fakeExec({ "gaberoo322/hydra": JSON.stringify([{ title: "fix (#1)", body: "" }]), "acme/widgets": "[]" });
      const b = fakeExec({ "gaberoo322/hydra": JSON.stringify([{ title: "fix (#2)", body: "" }]), "acme/widgets": "[]" });
      const loaderA = makeMergedAnchorRefsLoader(a.exec);
      const loaderB = makeMergedAnchorRefsLoader(b.exec);
      const t0 = 8_000_000;
      const refsA = await loaderA(t0);
      const refsB = await loaderB(t0);
      // Loader B does its OWN scan rather than reading A's cache.
      assert.ok(refsA.has("1") && !refsA.has("2"));
      assert.ok(refsB.has("2") && !refsB.has("1"));
      assert.ok(b.calls.length > 0, "loader B scanned despite loader A warming first");
    } finally {
      delete process.env.HYDRA_TARGET_GITHUB_REPO;
      __resetTargetConfig();
    }
  });
});

describe("subject fuzzy-match — asymmetric containment (#2110)", () => {
  test("a renamed shipment scores 1.00: every item word is covered by the (longer) blob", () => {
    const itemTitle = "Extract scheduler housekeeping cooldown helper";
    const blob =
      "refactor(scheduler): extract cooldown helper from housekeeping module\n\n" +
      "Pulls the per-class cooldown logic into a pure helper for testability.";
    // Every significant item word (extract/scheduler/housekeeping/cooldown/helper)
    // appears in the blob → full coverage, despite the blob's extra body words.
    assert.equal(subjectCoverageScore(itemTitle, blob), 1);
    assert.equal(subjectCoveredBy(itemTitle, blob), true);
  });

  test("the symmetric titleSimilarity would MISS the same renamed shipment (denominator inflation)", () => {
    const itemTitle = "Extract scheduler housekeeping cooldown helper";
    const blob =
      "refactor(scheduler): extract cooldown helper from housekeeping module\n\n" +
      "Pulls the per-class cooldown logic into a pure helper for testability.";
    // The whole point of #2110: the symmetric helper divides by the LARGER set
    // (the blob), so a genuine rename scores below threshold — proving the new
    // asymmetric helper is required, not a reuse of titleSimilarity.
    assert.ok(
      titleSimilarity(itemTitle, blob) < SUBJECT_MATCH_THRESHOLD,
      "symmetric similarity falls below 0.70 on a real renamed shipment",
    );
  });

  test("unrelated work scores 0.00 and does not match", () => {
    const itemTitle = "Implement portfolio risk dashboard widget";
    const blob = "chore(deps): bump ioredis and update connection pooling timeouts";
    assert.equal(subjectCoverageScore(itemTitle, blob), 0);
    assert.equal(subjectCoveredBy(itemTitle, blob), false);
  });

  test("short/generic titles (< 4 significant words) never subject-match", () => {
    // Only 1 significant word (>3 chars): "tests". Guard returns 0 even if the
    // blob trivially contains it, so generic titles cannot spuriously reconcile.
    assert.equal(subjectCoverageScore("fix the tests", "fix the tests and more words here"), 0);
    assert.equal(subjectCoveredBy("fix the tests", "fix the tests and more words here"), false);
  });

  test("partial coverage below threshold does not match (near-miss still escalates upstream)", () => {
    // 2 of 4 item words covered → 0.50 < 0.70.
    const itemTitle = "alpha beta gamma delta";
    const blob = "alpha beta epsilon zeta theta";
    assert.equal(subjectCoverageScore(itemTitle, blob), 0.5);
    assert.equal(subjectCoveredBy(itemTitle, blob), false);
  });

  test("coverage at exactly the threshold matches (>=, not >)", () => {
    // 7 of 10 item words covered → 0.70 == threshold.
    const itemTitle = "aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj";
    const blob = "aaaa bbbb cccc dddd eeee ffff gggg unrelated other words";
    assert.equal(subjectCoverageScore(itemTitle, blob), 0.7);
    assert.equal(subjectCoveredBy(itemTitle, blob), true);
  });

  test("non-string inputs degrade to 0 (never throws)", () => {
    assert.equal(subjectCoverageScore(undefined as any, "x"), 0);
    assert.equal(subjectCoverageScore("x", null as any), 0);
    assert.equal(subjectCoveredBy(123 as any, "x"), false);
  });
});
