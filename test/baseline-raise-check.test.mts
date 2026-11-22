/**
 * test/baseline-raise-check.test.mts — unit test of the pure baseline-raise
 * guard (issue #5553). Synthetic base/head pairs only: the required `test` job
 * has no PR body and no origin/master, so the live reader is the advisory
 * workflow step, never this file. Polarity comes from the Ratchet registry
 * (scripts/ci/ratchets.ts): a ceiling loosens by growing, a floor by shrinking.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  evaluateBaselineRaise,
  buildFixturePairs,
  listBaselineFixtures,
  parseBaselineRaiseLines,
} from "../scripts/ci/baseline-raise-check.ts";
import { diffBaselineJson, type RatchetPolarity } from "../scripts/ci/ratchet.ts";
import { RATCHETS, registryRowFor, rowBaseline, rowEnforcement, rowId, rowPolarity } from "../scripts/ci/ratchets.ts";

const FX = "scripts/ci/skill-size-baseline.json";
const FLOOR = "test/fixtures/suite-count-baseline.json";
const pair = (base: unknown, head: unknown, path = FX, polarity: RatchetPolarity | "none" = "ceiling") => ({
  path,
  base: base === null ? null : JSON.stringify(base),
  head: head === null ? null : JSON.stringify(head),
  ...(polarity === "none" ? {} : { polarity }),
});
const run = (base: unknown, head: unknown, changedFiles: string[] = [], prBody = "") =>
  evaluateBaselineRaise({ fixtures: [pair(base, head)], changedFiles, prBody });
const runFloor = (base: unknown, head: unknown, changedFiles: string[] = [], prBody = "") =>
  evaluateBaselineRaise({ fixtures: [pair(base, head, FLOOR, "floor")], changedFiles, prBody });

describe("evaluateBaselineRaise", () => {
  test("unaccompanied raise is reported with fixture and row", () => {
    const r = run({ a: 1 }, { a: 2 });
    assert.equal(r.ok, false);
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].fixture, FX);
    assert.equal(r.findings[0].key, "a");
    assert.equal(r.findings[0].kind, "raised");
  });

  test("matching Baseline-raise line clears it", () => {
    const r = run({ a: 1 }, { a: 2 }, [], `Baseline-raise: ${FX} a - needed`);
    assert.equal(r.ok, true);
    assert.equal(r.cleared.length, 1);
  });

  test("hyphen, en dash and em dash separators all match", () => {
    for (const sep of ["-", "–", "—"]) {
      const { lines } = parseBaselineRaiseLines(`Baseline-raise: ${FX} a ${sep} why`);
      assert.equal(lines.length, 1, sep);
      assert.equal(lines[0].reason, "why");
    }
  });

  test("added key and added element are growth; element cleared by array path", () => {
    const r = run({ files: {}, hits: ["x"] }, { files: { k: 1 }, hits: ["x", "y"] });
    assert.deepEqual(r.findings.map((f) => `${f.key}:${f.kind}`).sort(), ["files/k:added-key", "hits:added-element"]);
    const c = run({ hits: ["x"] }, { hits: ["x", "y", "z"] }, [], `Baseline-raise: ${FX} hits - two hits`);
    assert.equal(c.ok, true);
    assert.equal(c.cleared.length, 2);
  });

  test("root key / names a bare-array fixture", () => {
    const r = run(["a"], ["a", "b"], [], `Baseline-raise: ${FX} / - r`);
    assert.equal(r.ok, true);
  });

  test("row moved for a file outside the diff is reported, even a shrink", () => {
    const r = run({ "src/a.ts": 5 }, { "src/a.ts": 3 }, ["src/other.ts"]);
    assert.equal(r.ok, false);
    assert.equal(r.findings[0].kind, "lowered");
    assert.equal(r.findings[0].outOfDiff, true);
    const k = run({ "src/a.ts": 5 }, {}, ["src/other.ts"]);
    assert.equal(k.findings[0].kind, "removed-key");
  });

  test("tab-separated element subject uses the second field", () => {
    const el = "catch\tsrc/a.ts\tfoo";
    const r = run({ hits: [el] }, { hits: [] }, ["src/b.ts"]);
    assert.equal(r.findings[0].kind, "removed-element");
    assert.equal(run({ hits: [el] }, { hits: [] }, ["src/a.ts"]).ok, true);
  });

  test("removed element longer than 120 chars still derives its subject (out-of-diff reported)", () => {
    const el = `catch\tsrc/a.ts\t${"x".repeat(200)}`;
    const r = run({ hits: [el] }, { hits: [] }, ["src/b.ts"]);
    assert.equal(r.findings[0].kind, "removed-element");
    assert.equal(r.findings[0].outOfDiff, true);
    // sibling shape: same long element, subject file in the diff, passes silently
    assert.equal(run({ hits: [el] }, { hits: [] }, ["src/a.ts"]).ok, true);
  });

  test("shrink of an in-diff row and unchanged baseline pass silently", () => {
    assert.deepEqual(run({ "src/a.ts": 5 }, { "src/a.ts": 3 }, ["src/a.ts"]).findings, []);
    const same = run({ a: 1, "src/a.ts": 2 }, { a: 1, "src/a.ts": 2 });
    assert.equal(same.ok, true);
    assert.equal(same.cleared.length, 0);
  });

  test("a row with no derivable subject skips the out-of-diff rule on shrink", () => {
    assert.equal(run({ total: 9 }, { total: 7 }).ok, true);
  });

  test("added row for a file added in the diff is still growth (no carve-out)", () => {
    const r = run({ "test/a.test.mts": 1 }, { "test/a.test.mts": 1, "test/b.test.mts": 2 }, ["test/b.test.mts"]);
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].kind, "added-key");
  });

  test("blanket * clears every finding and is reported separately", () => {
    const r = run({ a: 1, b: 1 }, { a: 2, b: 2 }, [], `Baseline-raise: ${FX} * - bulk`);
    assert.equal(r.ok, true);
    assert.equal(r.cleared.length, 2);
    assert.deepEqual(r.blanket, [FX]);
  });

  test("malformed lines (empty reason, unknown fixture) clear nothing", () => {
    const body = [`Baseline-raise: ${FX} a -`, "Baseline-raise: nope.json a - why"].join("\n");
    const r = run({ a: 1 }, { a: 2 }, [], body);
    assert.equal(r.ok, false);
    assert.equal(r.malformedLines.length, 2);
  });

  test("absent-at-base or absent-at-head yields no findings; unparseable is a finding", () => {
    assert.equal(run(null, { a: 1 }).ok, true);
    assert.equal(run({ a: 1 }, null).ok, true);
    const r = evaluateBaselineRaise({
      fixtures: [{ path: FX, base: "{", head: "{}", polarity: "ceiling" }],
      changedFiles: [],
      prBody: "",
    });
    assert.equal(r.findings[0].kind, "unparseable");
  });

  test("never throws on junk input", () => {
    const r = evaluateBaselineRaise({
      fixtures: [{ path: FX, base: "1", head: "[1]", polarity: "ceiling" }],
      changedFiles: [],
      prBody: undefined as unknown as string,
    });
    assert.equal(typeof r.ok, "boolean");
  });
});

function baselinesOnDisk(): string[] {
  const root = join(import.meta.dirname, "..");
  const disk: string[] = [];
  for (const f of readdirSync(join(root, "scripts/ci"))) if (f.endsWith("-baseline.json")) disk.push(`scripts/ci/${f}`);
  const walk = (rel: string): void => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (e.isDirectory()) walk(`${rel}/${e.name}`);
      else if (e.name.endsWith("-baseline.json")) disk.push(`${rel}/${e.name}`);
    }
  };
  walk("test/fixtures");
  return disk.sort();
}

describe("listBaselineFixtures inventory", () => {
  test("lists every on-disk *-baseline.json, with no hand-kept exclusion list", async () => {
    const root = join(import.meta.dirname, "..");
    assert.deepEqual(listBaselineFixtures(root), baselinesOnDisk());
    assert.ok(listBaselineFixtures(root).includes("test/fixtures/qa-cohort-baseline.json"));
    const exported = Object.keys(await import("../scripts/ci/baseline-raise-check.ts"));
    assert.equal(exported.includes("NON_RATCHET_BASELINES"), false);
    assert.equal(exported.includes("diffBaselineShrink"), false);
  });
});

describe("Ratchet registry", () => {
  test("every *-baseline.json on disk has exactly one row and every row's file exists", () => {
    const disk = baselinesOnDisk();
    const rows = RATCHETS.map(rowBaseline);
    assert.deepEqual([...rows].sort(), disk);
    assert.equal(new Set(rows).size, rows.length, "baseline paths are unique");
    const ids = RATCHETS.map(rowId);
    assert.equal(new Set(ids).size, ids.length, "ids are unique");
  });

  test("registryRowFor finds each kind and nothing else", () => {
    assert.equal(registryRowFor("scripts/ci/skill-size-baseline.json")?.kind, "ratchet");
    assert.equal(registryRowFor(FLOOR)?.kind, "external");
    assert.equal(registryRowFor("test/fixtures/qa-cohort-baseline.json")?.kind, "fixture");
    assert.equal(registryRowFor("scripts/ci/nope-baseline.json"), undefined);
  });

  test("polarity and enforcement are recorded per row: suite-count is a required floor, fixtures have neither", () => {
    const suite = registryRowFor(FLOOR)!;
    assert.equal(rowPolarity(suite), "floor");
    assert.equal(rowEnforcement(suite), "required");
    assert.equal(rowPolarity(registryRowFor("scripts/ci/skill-size-baseline.json")!), "ceiling");
    assert.equal(rowEnforcement(registryRowFor("scripts/ci/never-throw-baseline.json")!), "advisory");
    const fixture = registryRowFor("test/fixtures/turn-snapshot/pr-gate-baseline.json")!;
    assert.equal(rowPolarity(fixture), undefined);
    assert.equal(rowEnforcement(fixture), undefined);
  });
});

describe("polarity-aware guard", () => {
  test("a floor: an added test row or a raised count is not a finding", () => {
    const base = { "test/a.test.mts": 4 };
    assert.equal(runFloor(base, { ...base, "test/b.test.mts": 2 }, ["test/b.test.mts"]).ok, true);
    assert.equal(runFloor(base, { "test/a.test.mts": 6 }, ["test/a.test.mts"]).ok, true);
  });

  test("a floor: a lowered count or a removed row is a finding, cleared by a Baseline-raise line", () => {
    const base = { "test/a.test.mts": 4, "test/b.test.mts": 2 };
    const lowered = runFloor(base, { ...base, "test/a.test.mts": 3 }, ["test/a.test.mts"]);
    assert.equal(lowered.ok, false);
    assert.equal(lowered.findings[0].kind, "lowered");
    const removed = runFloor(base, { "test/a.test.mts": 4 }, ["test/b.test.mts"]);
    assert.equal(removed.findings[0].kind, "removed-key");
    const cleared = runFloor(base, { "test/a.test.mts": 4 }, [], `Baseline-raise: ${FLOOR} test/b.test.mts - file deleted`);
    assert.equal(cleared.ok, true);
    assert.equal(cleared.cleared.length, 1);
  });

  test("a floor: a tightened row for a file outside the diff is still reported", () => {
    const r = runFloor({ "test/a.test.mts": 4 }, { "test/a.test.mts": 5 }, ["src/other.ts"]);
    assert.equal(r.ok, false);
    assert.equal(r.findings[0].outOfDiff, true);
  });

  test("a shape change is a finding under either polarity", () => {
    assert.equal(runFloor({ a: 1 }, ["a"]).findings[0].kind, "shape-changed");
    assert.equal(run({ a: 1 }, ["a"]).findings[0].kind, "shape-changed");
  });

  test("a pair with no polarity produces no finding", () => {
    const r = evaluateBaselineRaise({
      fixtures: [pair({ a: 1 }, { a: 9, b: 1 }, "test/fixtures/qa-cohort-baseline.json", "none")],
      changedFiles: [],
      prBody: "",
    });
    assert.deepEqual(r.findings, []);
  });
});

describe("diffBaselineJson", () => {
  test("reports both directions in one pass", () => {
    const d = diffBaselineJson({ a: 1, b: 5, gone: 1, hits: ["x", "y"] }, { a: 2, b: 3, new: 1, hits: ["x", "z"] });
    assert.deepEqual(d.grown.map((r) => `${r.path}:${r.kind}`).sort(), ["a:raised", "hits:added-element", "new:added-key"]);
    assert.deepEqual(d.shrunk.map((r) => `${r.path}:${r.kind}`).sort(), ["b:lowered", "gone:removed-key", "hits:removed-element"]);
  });

  test("strings are neither grown nor shrunk and a duplicate element counts", () => {
    assert.deepEqual(diffBaselineJson({ note: "a" }, { note: "b" }), { grown: [], shrunk: [] });
    assert.deepEqual(diffBaselineJson(["a"], ["a", "a"]).grown.map((r) => r.kind), ["added-element"]);
  });
});

describe("commit-pinned head reads and nested-row subjects", () => {
  test("nested count row for a file outside the diff is reported", () => {
    const row = "files/docs/operator-playbooks/x.md/issue-cite";
    const r = run({ files: { "docs/operator-playbooks/x.md": { "issue-cite": 5 } } }, { files: { "docs/operator-playbooks/x.md": { "issue-cite": 3 } } }, ["src/other.ts"]);
    assert.equal(r.ok, false);
    assert.equal(r.findings[0].key, row);
    assert.equal(r.findings[0].outOfDiff, true);
  });

  test("nested count row for a file in the diff keeps passing silently on shrink", () => {
    const r = run({ files: { "docs/x.md": { "issue-cite": 5 } } }, { files: { "docs/x.md": { "issue-cite": 3 } } }, ["docs/x.md"]);
    assert.equal(r.ok, true);
  });

  test("fixture pairs read head from the head commit, not the working tree", () => {
    const calls: string[] = [];
    const show = (sha: string, path: string) => {
      calls.push(`${sha}:${path}`);
      return sha === "MB" ? "base" : sha === "HEAD1" ? "head" : "working-tree";
    };
    const [p] = buildFixturePairs([FX], "MB", "HEAD1", show);
    assert.deepEqual(p, { path: FX, base: "base", head: "head" });
    assert.deepEqual(calls, [`MB:${FX}`, `HEAD1:${FX}`]);
  });

  test("path absent at head commit yields null head (retired fixture)", () => {
    const [p] = buildFixturePairs([FX], "MB", "H", (sha) => (sha === "MB" ? "{}" : null));
    assert.equal(p.head, null);
  });
});
