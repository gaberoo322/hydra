/**
 * Regression tests for the hydra-cleanup deterministic emit runner
 * (issue #1449) and the demote-vs-delete classifier it leans on.
 *
 * WHAT #1449 IS — a recurrence of #1167. #1167 moved parse→validate→dedup→render
 * into pure helpers, but the skill's EMIT step stayed LLM-prose-executed. On run
 * f6403146 the model rendered each issue BODY via renderBody() (correct symbol
 * in the H1) yet HAND-BUILT the TITLE from raw knip output, losing the symbol —
 * the blank `cleanup: remove unused export  (src/schemas/today-page.ts)` titles
 * on #1421–#1426 (body H1 said `RecentMergesQuery`, title was blank). Two
 * defect classes:
 *
 *   1. BLANK-TITLE: title and body came from two different sources, so they
 *      diverged. The fix is a single deterministic runner where the title comes
 *      ONLY from renderTitle() and the body from renderBody() on the SAME
 *      finding — no hand-built title can drift from the body.
 *   2. DELETE-INSTEAD-OF-DEMOTE: an "unused export" still referenced WITHIN its
 *      own file (a sibling `z.infer<typeof X>` alias, a schema composed into
 *      another schema) was deleted, breaking `tsc`. The fix is a deterministic
 *      classifyExportFix() that reads the symbol's own file and marks the
 *      finding `demote` (drop the `export` keyword) when an in-file reference
 *      survives, so the emitted issue says "demote", not "delete".
 *
 * These tests would have caught BOTH defects: the title/body coherence assertion
 * fails if the runner ever splits them again, and the classifier assertions fail
 * if an internally-referenced export is marked for deletion.
 *
 * Pure helpers — no fs/network/process (the planner takes an injected source
 * reader) — so these run in milliseconds with zero setup.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  classifyExportFix,
  renderTitle,
  renderBatchTitle,
  findingIdentity,
  identitiesFromIssueBody,
  type CleanupFinding,
  type KnipReport,
} from "../scripts/ci/hydra-cleanup-render.ts";
import {
  planCleanupEmit,
  EMIT_CAP,
  SYMBOLS_PER_BATCH,
} from "../scripts/ci/hydra-cleanup-emit.ts";

const ISO = "2026-06-09";

// A faithful reproduction of the real src/schemas/autopilot-idle.ts pattern that
// recurred (#1449): a schema flagged "unused export" by knip, but referenced
// internally by a z.infer type alias AND composed into a sibling schema. Deleting
// it would break tsc — the correct fix is demote.
const SCHEMA_SOURCE_INTERNALLY_REFERENCED = `
import { z } from "zod";

export const IdleBlockedBySchema = z.object({ reason: z.string() });
export type IdleBlockedBy = z.infer<typeof IdleBlockedBySchema>;

export const IdleDiagnosticsSchema = z.object({
  blockedBy: IdleBlockedBySchema,
});
`;

// A truly-dead export: declared and exported, never referenced again in-file.
const SOURCE_TRULY_DEAD = `
export const deadConst = 42;

export function liveThing() {
  return 1;
}
`;

describe("classifyExportFix — deterministic demote-vs-delete (#1449)", () => {
  test("DEMOTE: an export referenced within its own file (z.infer alias + sibling schema)", () => {
    // This is the EXACT recurrence: IdleBlockedBySchema is knip-"unused" (no
    // external importer) but referenced on the z.infer line AND inside
    // IdleDiagnosticsSchema. A delete breaks tsc; the verdict must be demote.
    const finding: CleanupFinding = {
      kind: "export",
      path: "src/schemas/autopilot-idle.ts",
      name: "IdleBlockedBySchema",
    };
    assert.equal(
      classifyExportFix(finding, SCHEMA_SOURCE_INTERNALLY_REFERENCED),
      "demote",
      "an internally-referenced export must be classified demote, never delete",
    );
  });

  test("DELETE: an export with no in-file reference beyond its declaration", () => {
    const finding: CleanupFinding = { kind: "export", path: "src/x.ts", name: "deadConst" };
    assert.equal(classifyExportFix(finding, SOURCE_TRULY_DEAD), "delete");
  });

  test("the declaration line itself does not count as an internal reference", () => {
    // Only one occurrence of `deadConst`, on its own `export const` line. That
    // line is the declaration, not a use, so the verdict is delete (not demote).
    const finding: CleanupFinding = { kind: "export", path: "src/x.ts", name: "deadConst" };
    assert.equal(classifyExportFix(finding, "export const deadConst = 42;\n"), "delete");
  });

  test("an in-file CALL site counts as an internal reference → demote", () => {
    const src = `
export function helper() { return 1; }
function usesHelper() { return helper() + 1; }
`;
    const finding: CleanupFinding = { kind: "export", path: "src/y.ts", name: "helper" };
    assert.equal(classifyExportFix(finding, src), "demote");
  });

  test("word-boundary: a substring match (helperX) does not falsely demote `helper`", () => {
    const src = `
export const helper = 1;
const helperExtended = 2;
console.log(helperExtended);
`;
    const finding: CleanupFinding = { kind: "export", path: "src/z.ts", name: "helper" };
    // `helperExtended` must NOT count as a reference to `helper`.
    assert.equal(classifyExportFix(finding, src), "delete");
  });

  test("unknown for a file finding, an empty name, or empty source", () => {
    assert.equal(classifyExportFix({ kind: "file", path: "a.ts", name: "" }, "x"), "unknown");
    assert.equal(classifyExportFix({ kind: "export", path: "a.ts", name: "" }, "x"), "unknown");
    assert.equal(classifyExportFix({ kind: "export", path: "a.ts", name: "Foo" }, ""), "unknown");
  });
});

describe("planCleanupEmit — title/body coherence, the #1449 blank-title guard", () => {
  // The board is empty for these so dedup is a no-op; we focus on the
  // title/body coherence + classification routing.
  const noOpenIssues: string[] = [];

  test("BLANK-TITLE GUARD: every planned issue's title names the SAME symbol as its body H1", () => {
    // This is the assertion that would have caught #1421–#1426: there, the body
    // H1 had `RecentMergesQuery` but the title was blank. Here we assert the
    // title and the body H1 can never name different symbols, because both come
    // from the same finding in one pass. Two findings in two different module
    // dirs → two 1-finding batches → the legacy single-finding format.
    const report: KnipReport = {
      files: [],
      issues: [
        { file: "src/schemas/today-page.ts", exports: [{ name: "RecentMergesQuery" }], types: [] },
        { file: "src/api/autopilot-board.ts", exports: [{ name: "BOARD_ISSUE_FIELDS" }], types: [] },
      ],
    };
    // No internal refs in the (empty) source → both classify delete; irrelevant
    // to this assertion, which is purely about title/body coherence.
    const plan = planCleanupEmit(report, noOpenIssues, () => "", ISO);
    assert.equal(plan.issues.length, 2);
    for (const issue of plan.issues) {
      assert.equal(issue.findings.length, 1, "one finding per module dir → legacy single format");
      const finding = issue.findings[0];
      // The title carries the symbol name — never blank, never double-space.
      assert.ok(issue.title.includes(finding.name), `title must name the symbol: ${issue.title}`);
      assert.ok(!/remove unused export  /.test(issue.title), "no double-space blank title (the #1421 defect)");
      assert.ok(!/ $/.test(issue.title), "no trailing-space title");
      // The body H1 names the SAME symbol the title does.
      const h1 = issue.body.split("\n")[0];
      assert.ok(h1.includes(finding.name), `body H1 must name the same symbol as the title: ${h1}`);
      // Title is exactly what renderTitle produces from the finding — i.e. the
      // runner cannot have hand-built it.
      assert.equal(issue.title, renderTitle(finding));
    }
  });

  test("an export with a blank name (the #1167/#1449 parse-miss) never reaches a planned issue", () => {
    // knip emitted an export object with no name → parseKnipReport surfaces it
    // as name:"" → the filter's validateFinding drops it BEFORE render. The
    // runner must not crash and must not emit a blank-title issue.
    const report: KnipReport = {
      files: [],
      issues: [
        { file: "src/schemas/today-page.ts", exports: [{ line: 1, col: 1, pos: 1 }], types: [] },
        { file: "src/schemas/today-page.ts", exports: [{ name: "RealExport" }], types: [] },
      ],
    };
    const plan = planCleanupEmit(report, noOpenIssues, () => "", ISO);
    assert.equal(plan.issues.length, 1, "only the well-formed finding is emitted");
    assert.equal(plan.issues[0].findings.length, 1);
    assert.equal(plan.issues[0].findings[0].name, "RealExport");
    assert.ok(plan.dropped.some((d) => /blank-title|empty symbol name/.test(d.reason)));
  });

  test("DEMOTE ROUTING: an internally-referenced export is planned with fix=demote and the body says so", () => {
    const report: KnipReport = {
      files: [],
      issues: [{ file: "src/schemas/autopilot-idle.ts", exports: [{ name: "IdleBlockedBySchema" }], types: [] }],
    };
    const readSource = (p: string) =>
      p === "src/schemas/autopilot-idle.ts" ? SCHEMA_SOURCE_INTERNALLY_REFERENCED : "";
    const plan = planCleanupEmit(report, noOpenIssues, readSource, ISO);
    assert.equal(plan.issues.length, 1);
    const issue = plan.issues[0];
    assert.equal(issue.findings[0].fix, "demote", "internally-referenced export routes to demote");
    // The emitted BODY must lead with the demote recommendation, not invite a delete.
    assert.match(issue.body, /Recommended fix: \*\*demote\*\* \(drop the `export` keyword\) — NOT delete/);
    assert.match(issue.body, /Deleting it would break `tsc`/);
  });

  test("DEMOTE ROUTING in a BATCH: the checklist line carries the demote verdict (#1653)", () => {
    // Two findings in the SAME module dir → one batch issue; the demote verdict
    // must survive into the per-symbol checklist line.
    const report: KnipReport = {
      files: [],
      issues: [
        { file: "src/schemas/autopilot-idle.ts", exports: [{ name: "IdleBlockedBySchema" }], types: [] },
        { file: "src/schemas/other.ts", exports: [{ name: "deadConst" }], types: [] },
      ],
    };
    const readSource = (p: string) =>
      p === "src/schemas/autopilot-idle.ts" ? SCHEMA_SOURCE_INTERNALLY_REFERENCED : SOURCE_TRULY_DEAD;
    const plan = planCleanupEmit(report, noOpenIssues, readSource, ISO);
    assert.equal(plan.issues.length, 1, "same module dir → one batch issue");
    const issue = plan.issues[0];
    assert.equal(issue.moduleDir, "src/schemas");
    assert.match(issue.body, /- \[ \] `IdleBlockedBySchema` \(`src\/schemas\/autopilot-idle\.ts`\) — fix: \*\*demote\*\*/);
    assert.match(issue.body, /- \[ \] `deadConst` \(`src\/schemas\/other\.ts`\) — fix: \*\*delete\*\*/);
    // Batch title comes ONLY from renderBatchTitle on the same findings.
    assert.equal(issue.title, renderBatchTitle("src/schemas", issue.findings));
    // The body manifest carries exactly the batch's identities (the dedup surface).
    assert.deepEqual(identitiesFromIssueBody(issue.body), issue.findings.map((f) => findingIdentity(f)));
    // Files in scope lists both distinct paths.
    assert.match(issue.body, /- `src\/schemas\/autopilot-idle\.ts`/);
    assert.match(issue.body, /- `src\/schemas\/other\.ts`/);
  });

  test("DELETE ROUTING: a truly-dead export is planned with fix=delete and the body says so", () => {
    const report: KnipReport = {
      files: [],
      issues: [{ file: "src/x.ts", exports: [{ name: "deadConst" }], types: [] }],
    };
    const readSource = (p: string) => (p === "src/x.ts" ? SOURCE_TRULY_DEAD : "");
    const plan = planCleanupEmit(report, noOpenIssues, readSource, ISO);
    assert.equal(plan.issues[0].findings[0].fix, "delete");
    assert.match(plan.issues[0].body, /Recommended fix: \*\*delete\*\*/);
  });

  test("FILTER: verifier-core, test, .d.ts, and entrypoint findings are dropped", () => {
    const report: KnipReport = {
      files: ["src/index.ts", "test/foo.test.mts", "src/types/global.d.ts"],
      issues: [
        { file: "src/tier-classifier.ts", exports: [{ name: "isVerifierCore" }], types: [] },
        { file: "src/clean.ts", exports: [{ name: "okToFile" }], types: [] },
      ],
    };
    const plan = planCleanupEmit(report, [], () => "", ISO);
    const emittedPaths = plan.issues.flatMap((i) => i.findings.map((f) => f.path));
    assert.deepEqual(emittedPaths, ["src/clean.ts"], "only the clean, non-core, non-test finding survives");
    assert.ok(plan.dropped.some((d) => /verifier-core/.test(d.reason)));
  });

  test("DEDUP: a finding already open on the board is not re-emitted (identity-keyed)", () => {
    const report: KnipReport = {
      files: [],
      issues: [{ file: "src/clean.ts", exports: [{ name: "okToFile" }], types: [] }],
    };
    const openTitles = ["cleanup: remove unused export `okToFile` (src/clean.ts)"];
    const plan = planCleanupEmit(report, openTitles, () => "", ISO);
    assert.equal(plan.issues.length, 0, "the already-open finding is deduped, nothing emitted");
    assert.ok(plan.dropped.some((d) => /duplicate/.test(d.reason)));
  });

  test("RECURRENCE: re-running the plan against the board it just filled emits ZERO new issues", () => {
    // Mixed board after the first run: a 1-finding batch (legacy title carries
    // the identity) AND a multi-finding batch (identities live in the body
    // manifest). The second run must recover identities from BOTH surfaces.
    const report: KnipReport = {
      files: ["dashboard/src/components/Card.jsx"],
      issues: [
        { file: "src/clean-a.ts", exports: [{ name: "deadA" }], types: [] },
        { file: "src/clean-b.ts", exports: [{ name: "deadB" }], types: [] },
      ],
    };
    const first = planCleanupEmit(report, [], () => "", ISO);
    // dashboard/src (1 file finding) + src (2 export findings) → 2 batches.
    assert.equal(first.issues.length, 2);
    const filledBoard = first.issues.map((i) => ({ title: i.title, body: i.body }));
    const second = planCleanupEmit(report, filledBoard, () => "", ISO);
    assert.equal(second.issues.length, 0, "re-run double-files nothing");
  });

  test("GROUPING + CAP: one batch per module dir, capped at EMIT_CAP batch issues (#1653)", () => {
    // 10 findings in 10 DIFFERENT module dirs → 10 one-finding batches; the cap
    // keeps the first EMIT_CAP and drops the rest with the over-cap reason.
    const exports = Array.from({ length: 10 }, (_, i) => ({
      file: `src/mod${i}/e.ts`,
      exports: [{ name: `e${i}` }],
      types: [],
    }));
    const report: KnipReport = { files: [], issues: exports };
    const plan = planCleanupEmit(report, [], () => "", ISO);
    assert.equal(plan.issues.length, EMIT_CAP);
    const overCap = plan.dropped.filter((d) => /over the per-run cap/.test(d.reason));
    assert.equal(overCap.length, 2, "the 2 batches over the cap are dropped with the over-cap reason");
  });

  test("RANK: a batch holding whole-file deletions ranks ahead of export-only batches", () => {
    const report: KnipReport = {
      files: ["dashboard/src/F0.jsx", "dashboard/src/F1.jsx"],
      issues: [
        { file: "src/schemas/a.ts", exports: [{ name: "a1" }, { name: "a2" }, { name: "a3" }], types: [] },
      ],
    };
    const plan = planCleanupEmit(report, [], () => "", ISO);
    assert.equal(plan.issues.length, 2);
    assert.equal(plan.issues[0].moduleDir, "dashboard/src", "whole-file batch first");
    assert.ok(plan.issues[0].findings.every((f) => f.kind === "file"));
    assert.equal(plan.issues[1].moduleDir, "src/schemas");
  });

  test("CHUNKING: a module over SYMBOLS_PER_BATCH splits into reviewable chunks (#1653)", () => {
    const n = SYMBOLS_PER_BATCH * 2 + 5; // 45 findings in ONE module dir
    const report: KnipReport = {
      files: [],
      issues: Array.from({ length: n }, (_, i) => ({
        file: `src/schemas/f${i % 9}.ts`,
        exports: [{ name: `sym${i}` }],
        types: [],
      })),
    };
    // Generous cap so chunking, not the cap, decides the issue count.
    const plan = planCleanupEmit(report, [], () => "", ISO, 100);
    assert.equal(plan.issues.length, 3, "45 findings chunk into 20 + 20 + 5");
    assert.deepEqual(plan.issues.map((i) => i.findings.length), [SYMBOLS_PER_BATCH, SYMBOLS_PER_BATCH, 5]);
    for (const issue of plan.issues) {
      assert.equal(issue.moduleDir, "src/schemas");
      assert.ok(issue.findings.length <= SYMBOLS_PER_BATCH);
    }
  });

  test("COVERAGE: a 179-finding / 21-module backlog plans into ~24 batches covering every finding (#1653)", () => {
    // The real 2026-06-10 backlog shape from the accepted proposal: 179
    // outstanding findings across 21 module buckets, the largest (src/schemas)
    // holding 70. Per-symbol granularity = 179 issues; batched = one per module
    // bucket plus the chunk splits for the 70-finding bucket (4 chunks) →
    // 21 + 3 = 24 issues, an ~87% reduction, with EVERY finding covered.
    const bucketSizes = [70, 17, 10, 9, 8, 8, 7, 6, 6, 5, 5, 4, 4, 4, 3, 3, 3, 2, 2, 2, 1];
    assert.equal(bucketSizes.reduce((a, b) => a + b, 0), 179);
    const issues = bucketSizes.flatMap((size, m) =>
      Array.from({ length: size }, (_, i) => ({
        file: `src/mod${m}/f${i % 7}.ts`,
        exports: [{ name: `m${m}sym${i}` }],
        types: [],
      })),
    );
    const report: KnipReport = { files: [], issues };
    // Uncapped plan (cap = 1000) to measure full-backlog coverage.
    const plan = planCleanupEmit(report, [], () => "", ISO, 1000);
    const covered = plan.issues.reduce((acc, i) => acc + i.findings.length, 0);
    assert.equal(covered, 179, "every finding lands in exactly one batch");
    assert.equal(plan.issues.length, 24, "21 module buckets + 3 chunk splits for the 70-finding bucket");
    // No identity appears in two batches.
    const allIds = plan.issues.flatMap((i) => i.findings.map((f) => findingIdentity(f)));
    assert.equal(new Set(allIds).size, allIds.length, "no finding is double-batched");
  });

  test("CHUNK TITLES: equal-sized single-file chunks render DISTINCT [i/k]-suffixed titles (Invariant 6, #1653 forward-fix)", () => {
    // The exact QA-verdict reproduction on PR #1696: a 40-export module where
    // every finding lives in ONE file splits into two chunks of 20 — without
    // the [i/k] suffix both issues rendered the byte-identical title.
    const n = SYMBOLS_PER_BATCH * 2; // 40 findings, all in one file
    const report: KnipReport = {
      files: [],
      issues: Array.from({ length: n }, (_, i) => ({
        file: "src/schemas/big.ts",
        exports: [{ name: `sym${String(i).padStart(2, "0")}` }],
        types: [],
      })),
    };
    const plan = planCleanupEmit(report, [], () => "", ISO, 100);
    assert.equal(plan.issues.length, 2, "40 findings chunk into 20 + 20");
    const [first, second] = plan.issues;
    assert.notEqual(first.title, second.title, "sibling chunks must never render identical titles");
    assert.match(first.title, / \[1\/2\]$/, "first chunk carries the [1/2] suffix");
    assert.match(second.title, / \[2\/2\]$/, "second chunk carries the [2/2] suffix");
    // Title/H1 coherence by construction survives the suffix (the #1005 guard).
    for (const issue of plan.issues) {
      assert.equal(issue.body.split("\n")[0], `# ${issue.title}`);
    }
    // Re-running against the board these two filled emits nothing — the suffix
    // must not disturb manifest-keyed dedup.
    const filledBoard = plan.issues.map((i) => ({ title: i.title, body: i.body }));
    const second_run = planCleanupEmit(report, filledBoard, () => "", ISO, 100);
    assert.equal(second_run.issues.length, 0, "suffixed chunk titles dedup via the body manifest");
  });

  test("CHUNK TITLES: an unsplit batch carries NO suffix; a 1-finding remainder chunk of a split DOES (#1653 forward-fix)", () => {
    // 21 findings in one module dir → chunks of 20 + 1. The remainder chunk is
    // a chunk of a SPLIT module, so it renders the batch format with [2/2] —
    // NOT the legacy single-finding title (whose identity-in-title contract is
    // reserved for unsplit 1-finding groups).
    const n = SYMBOLS_PER_BATCH + 1;
    const report: KnipReport = {
      files: [],
      issues: Array.from({ length: n }, (_, i) => ({
        file: `src/schemas/f${i % 3}.ts`,
        exports: [{ name: `sym${String(i).padStart(2, "0")}` }],
        types: [],
      })),
    };
    const plan = planCleanupEmit(report, [], () => "", ISO, 100);
    assert.equal(plan.issues.length, 2, "21 findings chunk into 20 + 1");
    // Ranking puts the 20-finding chunk first (bigger harvest).
    assert.match(plan.issues[0].title, / \[1\/2\]$/);
    assert.equal(plan.issues[0].findings.length, SYMBOLS_PER_BATCH);
    assert.match(plan.issues[1].title, / \[2\/2\]$/, "the 1-finding remainder of a split is still a suffixed chunk");
    assert.equal(plan.issues[1].findings.length, 1);
    // The remainder chunk carries the manifest (batch dedup surface), so its
    // identity is recoverable from the body even though its title is batch-shaped.
    assert.deepEqual(
      identitiesFromIssueBody(plan.issues[1].body),
      plan.issues[1].findings.map((f) => findingIdentity(f)),
    );
    // An UNSPLIT 1-finding group still uses the legacy format, suffix-free.
    const single: KnipReport = {
      files: [],
      issues: [{ file: "src/clean/a.ts", exports: [{ name: "onlyOne" }], types: [] }],
    };
    const singlePlan = planCleanupEmit(single, [], () => "", ISO, 100);
    assert.equal(singlePlan.issues.length, 1);
    assert.equal(singlePlan.issues[0].title, renderTitle(singlePlan.issues[0].findings[0]));
    assert.doesNotMatch(singlePlan.issues[0].title, /\[\d+\/\d+\]$/);
  });

  test("WITHIN-KIND SORT: findings sort by (path, name) within each kind — chunking is insertion-order independent (Invariant 6, #1653 forward-fix)", () => {
    // Feed the SAME findings in two different insertion orders (knip output
    // order is not a stability guarantee). Both plans must produce identical
    // chunk contents in identical order: files first, then exports by (path, name).
    const entries = [
      { file: "src/schemas/zz.ts", name: "alpha" },
      { file: "src/schemas/aa.ts", name: "zulu" },
      { file: "src/schemas/aa.ts", name: "alpha" },
      { file: "src/schemas/mm.ts", name: "mid" },
    ];
    const mkReport = (ordered: typeof entries): KnipReport => ({
      files: ["src/schemas/deadfile.ts"],
      issues: ordered.map((e) => ({ file: e.file, exports: [{ name: e.name }], types: [] })),
    });
    const forward = planCleanupEmit(mkReport(entries), [], () => "", ISO, 100);
    const reversed = planCleanupEmit(mkReport([...entries].reverse()), [], () => "", ISO, 100);
    assert.equal(forward.issues.length, 1);
    const expectedOrder = [
      "src/schemas/deadfile.ts::", // whole-file deletion leads
      "src/schemas/aa.ts::alpha", // then exports by (path, name)
      "src/schemas/aa.ts::zulu",
      "src/schemas/mm.ts::mid",
      "src/schemas/zz.ts::alpha",
    ];
    const ids = (plan: typeof forward) =>
      plan.issues[0].findings.map((f) => `${f.path}::${f.name}`);
    assert.deepEqual(ids(forward), expectedOrder, "files first, then exports sorted by (path, name)");
    assert.deepEqual(ids(reversed), expectedOrder, "the same order regardless of knip insertion order");
    assert.equal(forward.issues[0].body, reversed.issues[0].body, "byte-identical body across insertion orders");
  });

  test("WITHIN-KIND SORT: chunk BOUNDARIES are deterministic across insertion orders (#1653 forward-fix)", () => {
    // 25 single-file exports fed forward and reversed: the (path, name) sort —
    // not knip's output order — must decide which 20 land in chunk 1.
    const names = Array.from({ length: 25 }, (_, i) => `sym${String(i).padStart(2, "0")}`);
    const mkReport = (ns: string[]): KnipReport => ({
      files: [],
      issues: ns.map((name) => ({ file: "src/schemas/big.ts", exports: [{ name }], types: [] })),
    });
    const forward = planCleanupEmit(mkReport(names), [], () => "", ISO, 100);
    const reversed = planCleanupEmit(mkReport([...names].reverse()), [], () => "", ISO, 100);
    assert.equal(forward.issues.length, 2);
    for (let c = 0; c < 2; c++) {
      assert.deepEqual(
        forward.issues[c].findings.map((f) => f.name),
        reversed.issues[c].findings.map((f) => f.name),
        `chunk ${c + 1} holds the same findings in the same order regardless of insertion order`,
      );
    }
    assert.deepEqual(
      forward.issues[0].findings.map((f) => f.name),
      names.slice(0, SYMBOLS_PER_BATCH),
      "chunk 1 is the first 20 in (path, name) order",
    );
  });
});
