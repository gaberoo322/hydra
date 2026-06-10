/**
 * Regression tests for the hydra-target-cleanup deterministic emit planner —
 * the TARGET mirror of hydra-cleanup-emit (demote-only sweep, step 2 of the
 * Target dead-code cleanup plan).
 *
 * What the planner must guarantee (each pinned below):
 *
 *   1. DEMOTE-ONLY: only export findings still referenced within their own
 *      file (classifyExportFix → "demote") are emitted. delete-class findings,
 *      whole-file findings, and unknown-source findings are dropped — the
 *      Target's CLAUDE.md authorises this sweep for demotes only.
 *   2. WIRING GRACE: a finding in a file touched within the last 45 days is
 *      dropped (Hydra builds modules first, wires later — young dead exports
 *      are usually wiring-in-flight). Unknown file age fails closed.
 *   3. ONE ITEM PER FILE: sibling findings in one file batch into a single
 *      backlog item (addToBacklog fuzzy-title dedup would reject per-symbol
 *      titles, and the picker ships one PR per file anyway).
 *   4. FILE-KEYED DEDUP: while an open cleanup-scan item covers a path, no
 *      new item for that path is filed.
 *   5. TITLE/BODY COHERENCE (the #1449/#1005 drift guard carried over): title
 *      and body for an item come from the same (path, symbols) group in one
 *      pass — every emitted title's path and symbols appear in its own body.
 *
 * Pure planner — source text, file age, and the open board are injected — so
 * these run in milliseconds with zero setup.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  planTargetCleanupEmit,
  renderTargetTitle,
  renderTargetBody,
  identityFromOpenItemTitle,
  TARGET_EMIT_CAP,
  WIRING_GRACE_DAYS,
} from "../scripts/ci/hydra-target-cleanup-emit.ts";
import type { KnipReport } from "../scripts/ci/hydra-cleanup-render.ts";

/** A file where both symbols are referenced in-file (demote-class). */
const DEMOTE_SOURCE = [
  "export type AlphaStatus = 'on' | 'off';",
  "export const alphaDefault: AlphaStatus = 'on';",
  "function useAlpha(s: AlphaStatus) { return s ?? alphaDefault; }",
  "useAlpha('on');",
].join("\n");

/** A file where the symbol has no in-file reference (delete-class). */
const DELETE_SOURCE = ["export const orphanConst = 42;", "const other = 1;", "void other;"].join("\n");

function report(issues: Array<{ file: string; exports?: string[]; types?: string[] }>, files: string[] = []): KnipReport {
  return {
    files,
    issues: issues.map((i) => ({
      file: i.file,
      exports: (i.exports ?? []).map((name) => ({ name })),
      types: (i.types ?? []).map((name) => ({ name })),
    })),
  };
}

const SOURCES: Record<string, string> = {
  "src/lib/alpha.ts": DEMOTE_SOURCE,
  "src/lib/orphan.ts": DELETE_SOURCE,
  "src/lib/providers/venue.ts": DEMOTE_SOURCE,
  "src/lib/young.ts": DEMOTE_SOURCE,
};

const readSource = (p: string): string => SOURCES[p] ?? "";
const oldFile = (_p: string): number | null => 120;

function plan(
  r: KnipReport,
  openTitles: string[] = [],
  ages: (p: string) => number | null = oldFile,
  cap?: number,
) {
  return planTargetCleanupEmit(r, openTitles, readSource, ages, "2026-06-10", cap);
}

describe("hydra-target-cleanup-emit — demote-only filter", () => {
  test("emits demote-class export findings, batched per file", () => {
    const p = plan(report([{ file: "src/lib/alpha.ts", exports: ["alphaDefault"], types: ["AlphaStatus"] }]));
    assert.equal(p.items.length, 1);
    assert.equal(p.items[0].path, "src/lib/alpha.ts");
    assert.deepEqual(p.items[0].symbols, ["alphaDefault", "AlphaStatus"]);
  });

  test("drops delete-class findings (deferred to wire-or-retire)", () => {
    const p = plan(report([{ file: "src/lib/orphan.ts", exports: ["orphanConst"] }]));
    assert.equal(p.items.length, 0);
    assert.equal(p.dropped.length, 1);
    assert.match(p.dropped[0].reason, /delete-class/);
  });

  test("drops whole-file findings (wire-or-retire territory)", () => {
    const p = plan(report([], ["src/lib/alpha.ts"]));
    assert.equal(p.items.length, 0);
    assert.match(p.dropped[0].reason, /whole-file/);
  });

  test("drops findings whose source is unavailable (fail closed)", () => {
    const p = plan(report([{ file: "src/lib/missing.ts", exports: ["ghost"] }]));
    assert.equal(p.items.length, 0);
    assert.match(p.dropped[0].reason, /fail closed/);
  });

  test("drops test-file and .d.ts findings", () => {
    const p = plan(
      report([
        { file: "src/lib/alpha.test.ts", exports: ["helper"] },
        { file: "src/types.d.ts", types: ["Decl"] },
      ]),
    );
    assert.equal(p.items.length, 0);
    assert.equal(p.dropped.length, 2);
    for (const d of p.dropped) assert.match(d.reason, /test-only \/ type-declaration/);
  });

  test("providers paths are emitted (demote is allowed there — rule 1 forbids deletion only)", () => {
    const p = plan(report([{ file: "src/lib/providers/venue.ts", exports: ["alphaDefault"] }]));
    assert.equal(p.items.length, 1);
    assert.equal(p.items[0].path, "src/lib/providers/venue.ts");
  });
});

describe("hydra-target-cleanup-emit — wiring grace period", () => {
  test(`drops findings in files younger than ${WIRING_GRACE_DAYS} days`, () => {
    const p = plan(report([{ file: "src/lib/young.ts", exports: ["alphaDefault"] }]), [], () => 10);
    assert.equal(p.items.length, 0);
    assert.match(p.dropped[0].reason, /wiring grace period \(10d old\)/);
  });

  test("a file exactly at the grace boundary is emitted", () => {
    const p = plan(report([{ file: "src/lib/alpha.ts", exports: ["alphaDefault"] }]), [], () => WIRING_GRACE_DAYS);
    assert.equal(p.items.length, 1);
    assert.equal(p.items[0].ageDays, WIRING_GRACE_DAYS);
  });

  test("unknown file age fails closed", () => {
    const p = plan(report([{ file: "src/lib/alpha.ts", exports: ["alphaDefault"] }]), [], () => null);
    assert.equal(p.items.length, 0);
    assert.match(p.dropped[0].reason, /age unknown — fail closed/);
  });
});

describe("hydra-target-cleanup-emit — dedup and cap", () => {
  test("a path with an open cleanup-scan item is not re-filed", () => {
    const openTitle = renderTargetTitle("src/lib/alpha.ts", ["alphaDefault"]);
    const p = plan(report([{ file: "src/lib/alpha.ts", exports: ["alphaDefault"], types: ["AlphaStatus"] }]), [openTitle]);
    assert.equal(p.items.length, 0);
    assert.equal(p.dropped.length, 2);
    for (const d of p.dropped) assert.match(d.reason, /open cleanup-scan item already covers/);
  });

  test("identityFromOpenItemTitle round-trips rendered titles (single and batched)", () => {
    assert.equal(identityFromOpenItemTitle(renderTargetTitle("src/lib/a.ts", ["x"])), "src/lib/a.ts");
    assert.equal(identityFromOpenItemTitle(renderTargetTitle("src/lib/a.ts", ["x", "y", "z"])), "src/lib/a.ts");
    assert.equal(identityFromOpenItemTitle("feat: unrelated backlog item"), null);
  });

  test("caps emitted items per run, largest demote batch first", () => {
    const issues = Array.from({ length: TARGET_EMIT_CAP + 2 }, (_, i) => ({
      file: `src/lib/file-${String(i).padStart(2, "0")}.ts`,
      exports: i === 0 ? ["alphaDefault", "AlphaStatus"] : ["alphaDefault"],
    }));
    const sources: Record<string, string> = {};
    for (const i of issues) sources[i.file] = DEMOTE_SOURCE;
    const p = planTargetCleanupEmit(
      report(issues),
      [],
      (path) => sources[path] ?? "",
      oldFile,
      "2026-06-10",
    );
    assert.equal(p.items.length, TARGET_EMIT_CAP);
    assert.equal(p.items[0].path, "src/lib/file-00.ts"); // 2 demotes ranks first
    assert.equal(p.dropped.filter((d) => /over the per-run cap/.test(d.reason)).length, 2);
  });
});

describe("hydra-target-cleanup-emit — rendering (title/body coherence)", () => {
  test("title and body name the same path and symbols (the drift guard)", () => {
    const p = plan(report([{ file: "src/lib/alpha.ts", exports: ["alphaDefault"], types: ["AlphaStatus"] }]));
    const item = p.items[0];
    assert.match(item.title, /alphaDefault/);
    assert.match(item.title, /src\/lib\/alpha\.ts/);
    assert.match(item.body, /`alphaDefault`/);
    assert.match(item.body, /`AlphaStatus`/);
    assert.match(item.body, /web\/src\/lib\/alpha\.ts/);
  });

  test("body carries the Target policy: demote-only, citation, baseline tightening", () => {
    const p = plan(report([{ file: "src/lib/alpha.ts", exports: ["alphaDefault"] }]));
    const body = p.items[0].body;
    assert.match(body, /demote, do NOT delete/);
    assert.match(body, /scan date 2026-06-10/);
    assert.match(body, /deadcode:update-baseline/);
    assert.match(body, /No file deletions/);
  });

  test("renderTargetTitle keeps cross-file titles word-diverse (fuzzy-dedup guard)", () => {
    // addToBacklog rejects a new title sharing ≥70% of significant words with
    // an existing one. Leading with the symbol keeps two single-symbol items
    // from different files under that threshold.
    const a = renderTargetTitle("src/lib/providers/polymarket-ws/client.ts", ["PolymarketWsStats"]);
    const b = renderTargetTitle("src/lib/providers/polymarket-ws/protocol.ts", ["PolymarketWsMessageType"]);
    const words = (t: string) => new Set(t.toLowerCase().split(/\s+/).filter((w) => w.length > 3));
    const wa = words(a);
    const wb = words(b);
    const overlap = [...wa].filter((w) => wb.has(w)).length;
    assert.ok(
      overlap / Math.max(wa.size, wb.size) < 0.7,
      `cross-file title overlap must stay under the 0.7 fuzzy-dedup threshold (got ${overlap}/${Math.max(wa.size, wb.size)})`,
    );
  });

  test("renderTargetTitle/Body throw on an empty batch (blank-title guard)", () => {
    assert.throws(() => renderTargetTitle("", ["x"]));
    assert.throws(() => renderTargetTitle("src/lib/a.ts", []));
    assert.throws(() => renderTargetBody("src/lib/a.ts", [], 90, "2026-06-10"));
  });
});
