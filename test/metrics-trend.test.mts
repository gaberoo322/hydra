import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { countsAsMerge, NON_MERGING_ANCHOR_TYPES } from "../src/metrics/merge-predicate.ts";
import {
  computeRollingMergeRateFromTrend,
  projectTokensPerMergedPR,
} from "../src/metrics/stats-projection.ts";

describe("countsAsMerge (issue #4747)", () => {
  it("excludes a qa-review row with tasksMerged=1, with or without status/prNumber", () => {
    assert.equal(countsAsMerge({ anchorType: "qa-review", tasksMerged: 1 }), false);
    assert.equal(
      countsAsMerge({ anchorType: "qa-review", tasksMerged: 1, status: "merged", prNumber: "9" }),
      false,
    );
  });

  it("excludes a grill row with tasksMerged=1", () => {
    assert.equal(countsAsMerge({ anchorType: "grill", tasksMerged: 1, status: "merged" }), false);
  });

  it("derives the non-merging set from the class taxonomy", () => {
    assert.deepEqual([...NON_MERGING_ANCHOR_TYPES].sort(), ["grill", "qa-review"]);
  });

  it("counts a work-queue row only when status is merged", () => {
    assert.equal(
      countsAsMerge({ anchorType: "work-queue", tasksMerged: 1, status: "completed" }),
      false,
    );
    assert.equal(
      countsAsMerge({ anchorType: "work-queue", tasksMerged: 1, status: " Merged " }),
      true,
    );
  });

  it("legacy rows (no status) count only with a prNumber", () => {
    assert.equal(countsAsMerge({ anchorType: "work-queue", tasksMerged: 1 }), false);
    assert.equal(
      countsAsMerge({ anchorType: "work-queue", tasksMerged: 1, prNumber: "123" }),
      true,
    );
  });

  it("is false when tasksMerged is 0 and handles string tasksMerged", () => {
    assert.equal(countsAsMerge({ tasksMerged: 0, status: "merged" }), false);
    assert.equal(countsAsMerge({ tasksMerged: "1", status: "merged" }), true);
  });

  it("returns false for malformed input without throwing", () => {
    assert.equal(countsAsMerge(null), false);
    assert.equal(countsAsMerge(undefined), false);
    assert.equal(countsAsMerge("x"), false);
  });
});

describe("merge readers route through countsAsMerge (issue #4747)", () => {
  const trend = [
    { anchorType: "qa-review", tasksMerged: 1, status: "completed" },
    { anchorType: "grill", tasksMerged: 1, status: "completed" },
    { anchorType: "work-queue", tasksMerged: 1, status: "completed" },
    { anchorType: "work-queue", tasksMerged: 1, status: "merged", tokenCost: 100 },
  ];

  it("rolling merge rate counts only the merged dev row", () => {
    assert.equal(computeRollingMergeRateFromTrend(trend), 25);
  });

  it("tokens-per-merged-PR ignores QA rows", () => {
    const rows = [
      { anchorType: "qa-review", tasksMerged: 1, status: "merged", tokenCost: 9999 },
      ...trend,
    ];
    assert.equal(projectTokensPerMergedPR(rows), 100);
  });

  it("cost-efficiency / cost-per-merged-pr denominators exclude QA rows (AC3)", () => {
    const src = readFileSync("src/api/metrics-cost.ts", "utf8");
    assert.equal((src.match(/trend\.filter\(countsAsMerge\)\.length/g) ?? []).length, 2);
    const mixed = [
      { anchorType: "qa-review", tasksMerged: 1, status: "merged" },
      { anchorType: "work-queue", tasksMerged: 1, status: "merged" },
    ];
    assert.equal(mixed.filter(countsAsMerge).length, 1);
  });

  it("legacy status-less rows with a persisted prNumber count; without one they do not", () => {
    assert.equal(countsAsMerge({ anchorType: "work-queue", tasksMerged: 1, prNumber: "12" }), true);
    assert.equal(countsAsMerge({ anchorType: "work-queue", tasksMerged: 1 }), false);
  });

  it("every named reader module imports countsAsMerge", () => {
    for (const f of [
      "src/metrics/stats-projection.ts",
      "src/metrics/aggregate.ts",
      "src/api/metrics-cost.ts",
      "src/health/diagnostics.ts",
      "src/digest-weekly.ts",
      "src/aggregators/builder-health-stagnation-panel.ts",
    ]) {
      assert.match(readFileSync(f, "utf8"), /import \{[^}]*countsAsMerge[^}]*\}/, f);
    }
  });

  it("no src file re-implements a `tasksMerged > 0` merge test outside the allowlist", () => {
    const allow = new Set([
      "src/metrics/merge-predicate.ts",
      "src/autopilot/cycle-close.ts",
      "src/scheduler/chores/cycle-merge-reconcile.ts",
      "src/scheduler/chores/holdback-merge-watch.ts",
      "src/metrics/record.ts",
      "src/autopilot/schemas.ts",
    ]);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts") && !allow.has(p)) {
          const lines = readFileSync(p, "utf8").split("\n");
          lines.forEach((line, i) => {
            const t = line.trim();
            if (t.startsWith("*") || t.startsWith("//")) return;
            // Any other read of tasksMerged (same-line `> 0`, split `num(row.tasksMerged)`,
            // `>= 1`, ...) is a re-implementation; only the Empty Cycle `=== 0` writer-lockstep
            // check and the optional type declaration are legitimate.
            if (!/tasksMerged/.test(line)) return;
            if (/tasksMerged\??:/.test(line) || /tasksMerged[^;\n]*===\s*0/.test(line)) return;
            offenders.push(`${p}:${i + 1}`);
          });
        }
      }
    };
    walk("src");
    assert.deepEqual(offenders, []);
  });
});
