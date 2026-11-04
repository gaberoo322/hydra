/**
 * The SKILL MIRROR DRIFT watchdog check (issue #3828; ported to TypeScript in
 * #5098). The former bash suite's cases, 1:1, over in-memory fake ports
 * (test/_helpers/watchdog-drift-fakes.mts) — no bash, no real sync-skills.sh.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  SKILL_MIRROR_LOG_PREFIX,
  SKILL_MIRROR_MARKER_NAME,
  diffSkillMirror,
  runSkillMirror,
} from "../src/watchdog/skill-mirror.ts";
import { NOW_S, makeSkillMirrorHarness } from "./_helpers/watchdog-drift-fakes.mts";

const root = "/home/gabe/hydra";
const cfg = (over: Partial<{ autoFix: boolean; graceS: number }> = {}) => ({
  root,
  liveDir: "/live",
  autoFix: false,
  graceS: 600,
  ...over,
});
const text = (logs: string[]): string => logs.join("\n");

describe("watchdog skill-mirror drift check (issue #3828, #5098)", () => {
  test("in sync (live matches a fresh regen): logs 'in sync', no drift warning, scratch removed", async () => {
    const h = makeSkillMirrorHarness();
    await runSkillMirror(h.deps, cfg());
    assert.match(text(h.logs), /in sync \(live mirror matches/);
    assert.doesNotMatch(text(h.logs), /WARNING DRIFT/);
    assert.ok(h.logs.every((l) => l.startsWith(SKILL_MIRROR_LOG_PREFIX)));
    assert.deepEqual(h.removed, ["/scratch/x"]);
  });

  test("drift (live mirror stale), auto-fix OFF (default): advisory WARNING naming the skill, never resyncs", async () => {
    const h = makeSkillMirrorHarness();
    h.state.live = { demo: "STALE" };
    await runSkillMirror(h.deps, cfg());
    assert.match(text(h.logs), /WARNING DRIFT — 1 skill\(s\) diverge from \/home\/gabe\/hydra: demo /);
    assert.match(text(h.logs), /auto-fix disabled .*advisory only/);
    assert.equal(h.resyncs.length, 0);
    assert.deepEqual(h.marker.writes, [NOW_S]);
    assert.deepEqual(h.removed, ["/scratch/x"], "the scratch dir is removed on every path");
  });

  test("a skill absent from the live mirror reports as '<name>(missing-live)'", async () => {
    const h = makeSkillMirrorHarness();
    h.state.live = {};
    await runSkillMirror(h.deps, cfg());
    assert.match(text(h.logs), /demo\(missing-live\)/);
  });

  test("drift, auto-fix ON but within grace window: waits, does not resync", async () => {
    const h = makeSkillMirrorHarness({ marker: `${NOW_S - 100}\n` });
    h.state.live = { demo: "STALE" };
    await runSkillMirror(h.deps, cfg({ autoFix: true }));
    assert.match(text(h.logs), /within grace window \(drift 100s < 600s\)/);
    assert.equal(h.resyncs.length, 0);
    assert.equal(h.scheduler.calls, 0);
  });

  test("drift, auto-fix ON, grace elapsed: clears the marker then resyncs the default mirror", async () => {
    const h = makeSkillMirrorHarness({ marker: `${NOW_S - 700}\n` });
    h.state.live = { demo: "STALE" };
    await runSkillMirror(h.deps, cfg({ autoFix: true }));
    assert.deepEqual(h.resyncs, [root]);
    assert.match(text(h.logs), /AUTO-FIX — drift sustained 700s >= grace 600s/);
    assert.match(text(h.logs), /auto-fix completed/);
    assert.equal(h.marker.raw, null, "the marker is cleared so a failed resync re-arms the window");
  });

  test("a failing resync is one WARN line", async () => {
    const h = makeSkillMirrorHarness({ marker: `${NOW_S - 700}\n` });
    h.state.live = { demo: "STALE" };
    h.state.resync = { ran: true, exitCode: 1, stderrTail: "guard" };
    await runSkillMirror(h.deps, cfg({ autoFix: true }));
    assert.match(text(h.logs), /WARN auto-fix \(scripts\/sync-skills\.sh\) returned non-zero/);
  });

  test("a deliberately stopped scheduler blocks the auto-fix", async () => {
    const h = makeSkillMirrorHarness({ marker: `${NOW_S - 700}\n`, stopReason: "deliberate" });
    h.state.live = { demo: "STALE" };
    await runSkillMirror(h.deps, cfg({ autoFix: true }));
    assert.match(text(h.logs), /NOT auto-fixing/);
    assert.equal(h.resyncs.length, 0);
  });

  test("fail-safe: missing sync-skills.sh skips with WARN", async () => {
    const h = makeSkillMirrorHarness({ marker: `${NOW_S - 50}\n` });
    h.state.scriptExists = false;
    await runSkillMirror(h.deps, cfg());
    assert.equal(h.logs.length, 1);
    assert.match(text(h.logs), /WARN sync-skills\.sh not found at \/home\/gabe\/hydra/);
    assert.equal(h.marker.raw, `${NOW_S - 50}\n`, "the marker is untouched");
  });

  test("fail-safe: a failed scratch regeneration is one WARN, the marker untouched, the scratch removed", async () => {
    const h = makeSkillMirrorHarness({ marker: `${NOW_S - 50}\n` });
    h.state.regen = { ran: true, exitCode: 2, stderrTail: "boom" };
    await runSkillMirror(h.deps, cfg());
    assert.match(text(h.logs), /WARN scratch regeneration of .* failed \(exit 2\): boom/);
    assert.equal(h.marker.raw, `${NOW_S - 50}\n`);
    assert.deepEqual(h.removed, ["/scratch/x"]);
  });

  test("fail-safe: no scratch dir skips with WARN", async () => {
    const h = makeSkillMirrorHarness();
    h.state.scratchOk = false;
    await runSkillMirror(h.deps, cfg());
    assert.match(text(h.logs), /WARN could not create a scratch dir/);
  });

  test("no-drift clears a stale grace marker", async () => {
    const h = makeSkillMirrorHarness({ marker: `${NOW_S - 9999}\n` });
    await runSkillMirror(h.deps, cfg({ autoFix: true }));
    assert.equal(h.marker.raw, null);
    assert.equal(h.resyncs.length, 0);
  });

  test("diffSkillMirror compares byte-for-byte and skips a skill with no regenerated SKILL.md", () => {
    const fresh: Record<string, string> = { a: "x", b: "y", c: "z" };
    const live: Record<string, string> = { a: "x", b: "Y" };
    assert.deepEqual(
      diffSkillMirror(["a", "b", "c", "d"], (n) => fresh[n] ?? null, (n) => live[n] ?? null),
      ["b", "c(missing-live)"],
    );
  });

  test("the marker keeps its pre-cut-over file name (continuity across the deploy)", () => {
    assert.equal(SKILL_MIRROR_MARKER_NAME, "hydra-watchdog-skill-mirror-drift-since");
  });
});
