import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadKnipReport,
  KNIP_REPORT_MAX_AGE_MS,
} from "../scripts/ci/hydra-knip-source.ts";

/**
 * test/hydra-knip-source.test.mts — regression for the shared knip-report
 * source loader (issue #4523).
 *
 * `scripts/ci/hydra-cleanup-emit.ts` (Orchestrator) and
 * `scripts/ci/hydra-target-cleanup-emit.ts` (Target) used to hand-declare
 * their own `loadKnipReport()`. The copies drifted: only the Orchestrator's
 * refused a stale report (issue #1766). This suite pins the single shared
 * loader's behaviour — fresh / stale / boundary / malformed — via an
 * injectable clock (`opts.nowMs`), never real sleeping or `utimesSync`.
 */

describe("hydra-knip-source — loadKnipReport (issue #4523)", () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "hydra-knip-source-"));
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("a fresh report parses ok:true with the parsed KnipReport", () => {
    const p = join(dir, "fresh.json");
    const report = { files: ["src/a.ts"], issues: [] };
    writeFileSync(p, JSON.stringify(report));
    const nowMs = Date.now(); // written just now — age ~0
    const result = loadKnipReport(p, {
      rerunCommand: "npx knip --reporter json --no-exit-code > " + p,
      nowMs,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.source, report);
    }
  });

  test("a report older than KNIP_REPORT_MAX_AGE_MS is refused, citing #1766 and the caller's rerunCommand", () => {
    const p = join(dir, "stale.json");
    writeFileSync(p, JSON.stringify({ files: [], issues: [] }));
    const rerunCommand = "cd /fake/target/web && npx knip --reporter json --no-exit-code > " + p;
    // Drive the clock far enough past the write that reportAgeMs exceeds the
    // max, without sleeping: the file's mtime is effectively "now" at write
    // time, so offsetting nowMs forward simulates elapsed time.
    const nowMs = Date.now() + KNIP_REPORT_MAX_AGE_MS + 60_000;
    const result = loadKnipReport(p, { rerunCommand, nowMs });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /#1766/);
      assert.ok(
        result.error.includes(rerunCommand),
        `error should include the caller's rerunCommand, got: ${result.error}`,
      );
    }
  });

  test("age exactly equal to KNIP_REPORT_MAX_AGE_MS is accepted (strict > comparison)", () => {
    const p = join(dir, "boundary.json");
    const report = { files: [], issues: [] };
    writeFileSync(p, JSON.stringify(report));
    // Read the actual mtime the loader itself will statSync, so nowMs pins
    // reportAgeMs to exactly KNIP_REPORT_MAX_AGE_MS regardless of filesystem
    // mtime resolution (avoids the clock-vs-mtime skew a Date.now() capture
    // around the write would introduce).
    const mtimeMs = statSync(p).mtimeMs;
    const nowMs = mtimeMs + KNIP_REPORT_MAX_AGE_MS;
    const result = loadKnipReport(p, { rerunCommand: "irrelevant", nowMs });
    assert.equal(result.ok, true);
  });

  test("malformed JSON returns ok:false with a parse error, not a staleness error", () => {
    const p = join(dir, "malformed.json");
    writeFileSync(p, "{ not valid json");
    const nowMs = Date.now();
    const result = loadKnipReport(p, { rerunCommand: "irrelevant", nowMs });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /failed to parse/);
      assert.ok(result.error.includes(p));
    }
  });
});
