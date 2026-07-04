/**
 * Unit coverage for the wiring-liveness DARK-OUTCOME ALARM (issue #2805).
 *
 * Self-contained top-level describe with no shared teardown (CLAUDE.md
 * no-nested-shared-teardown rule). Touches no Redis, no gh — the clock, gh filer,
 * and the four Redis streak/marker accessors are all injected, so the
 * "file only after 7 days continuously dark, idempotent, clears on recovery,
 * never throws" policy is deterministic. The pure DARK/STALE detection is covered
 * in test/wiring-liveness-outcomes.test.mts; this file covers the alarm layer.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  runDarkOutcomeAlarm,
  DEFAULT_DARK_ALARM_MS,
  type DarkAlarmDeps,
} from "../src/scheduler/chores/wiring-liveness-dark-alarm.ts";
import type { OutcomeVerdict } from "../src/scheduler/chores/wiring-liveness-outcomes.ts";

const NOW_MS = Date.parse("2026-07-04T12:00:00.000Z");

/** A dark verdict fixture. */
function darkVerdict(name: string): Extract<OutcomeVerdict, { status: "dark" }> {
  return {
    name,
    kind: "leading",
    status: "dark",
    query: `metrics/${name}.txt`,
    producerHint: `producer must write ${name}`,
  };
}

/**
 * In-memory fakes for the Redis streak/marker + gh filer, so a full alarm pass is
 * deterministic. `darkSince` mimics SET NX (first write wins); `filed` is the
 * dedup marker set. `fileCalls` records every gh create.
 */
function fakes(opts: { fileFails?: boolean } = {}) {
  const darkSince = new Map<string, number>();
  const filed = new Set<string>();
  const cleared: string[] = [];
  const fileCalls: string[][] = [];
  const deps: DarkAlarmDeps = {
    now: () => NOW_MS,
    clearStreak: async (n) => {
      cleared.push(n);
      darkSince.delete(n);
      filed.delete(n);
    },
    readDarkSince: async (n) => (darkSince.has(n) ? darkSince.get(n)! : null),
    writeDarkSince: async (n, nowMs) => {
      if (!darkSince.has(n)) darkSince.set(n, nowMs); // SET NX
      return darkSince.get(n)!;
    },
    readFiled: async (n) => filed.has(n),
    writeFiled: async (n) => {
      filed.add(n);
    },
    fileIssue: async (args) => {
      fileCalls.push(args);
      if (opts.fileFails) return { ok: false, code: "gh-timeout", stderr: "boom" };
      return { ok: true, data: { stdout: "https://github.com/gaberoo322/hydra/issues/9001\n", stderr: "" } };
    },
  };
  return { deps, darkSince, filed, cleared, fileCalls };
}

describe("runDarkOutcomeAlarm (#2805)", () => {
  test("a first-tick dark outcome anchors the streak but does NOT file (below threshold)", async () => {
    const { deps, darkSince, fileCalls } = fakes();
    const res = await runDarkOutcomeAlarm([darkVerdict("brier")], [], deps);
    assert.equal(fileCalls.length, 0, "must not file on the first dark tick");
    assert.equal(res.filed.length, 0);
    assert.equal(darkSince.get("brier"), NOW_MS, "streak anchored to now");
    assert.deepEqual(
      res.outcomes.map((o) => o.action),
      ["below-threshold"],
    );
  });

  test("dark for >= 7 days files exactly one needs-triage issue with producer identity", async () => {
    const { deps, darkSince, fileCalls, filed } = fakes();
    // Pre-seed the streak anchor to 8 days ago.
    darkSince.set("brier", NOW_MS - (DEFAULT_DARK_ALARM_MS + 24 * 60 * 60 * 1000));
    const res = await runDarkOutcomeAlarm([darkVerdict("brier")], [], deps);
    assert.equal(fileCalls.length, 1, "files once past threshold");
    assert.deepEqual(res.filed, ["brier"]);
    assert.ok(filed.has("brier"), "sets the dedup marker after filing");
    // Invariant 6: the gh args carry the metric file path + producer hint.
    const args = fileCalls[0];
    const body = args[args.indexOf("--body") + 1];
    assert.match(body, /metrics\/brier\.txt/);
    assert.match(body, /producer must write brier/);
    assert.ok(args.includes("needs-triage"), "labels the issue needs-triage");
    const o = res.outcomes[0];
    assert.equal(o.action, "filed");
    assert.equal((o as any).issueNumber, 9001, "parses the issue number from gh stdout");
  });

  test("idempotent across ticks — an already-filed streak does not re-file (Invariant 4)", async () => {
    const { deps, darkSince, filed, fileCalls } = fakes();
    darkSince.set("brier", NOW_MS - (DEFAULT_DARK_ALARM_MS + 1000));
    filed.add("brier"); // already filed this streak
    const res = await runDarkOutcomeAlarm([darkVerdict("brier")], [], deps);
    assert.equal(fileCalls.length, 0, "must not re-file when the marker is set");
    assert.deepEqual(
      res.outcomes.map((o) => o.action),
      ["already-filed"],
    );
  });

  test("a gh failure records file-failed and does NOT set the marker (retries next tick, never throws)", async () => {
    const { deps, darkSince, filed } = fakes({ fileFails: true });
    darkSince.set("brier", NOW_MS - (DEFAULT_DARK_ALARM_MS + 1000));
    const res = await runDarkOutcomeAlarm([darkVerdict("brier")], [], deps);
    assert.equal(res.filed.length, 0);
    assert.ok(!filed.has("brier"), "a failed file must not set the dedup marker");
    const o = res.outcomes[0];
    assert.equal(o.action, "file-failed");
    assert.equal((o as any).reason, "gh-timeout");
  });

  test("recovery clears the streak/marker for each recovered name (stateless recovery)", async () => {
    const { deps, cleared, darkSince, filed, fileCalls } = fakes();
    // Pre-seed a stale streak + filed marker that recovery must wipe.
    darkSince.set("brier", NOW_MS - DEFAULT_DARK_ALARM_MS);
    filed.add("brier");
    const res = await runDarkOutcomeAlarm([], ["brier"], deps);
    assert.deepEqual(cleared, ["brier"], "clears the recovered outcome's streak");
    assert.ok(!darkSince.has("brier"), "streak anchor wiped");
    assert.ok(!filed.has("brier"), "dedup marker wiped so a future streak files fresh");
    assert.equal(fileCalls.length, 0);
    assert.deepEqual(res.outcomes, [], "no per-verdict outcome for a recovered (non-dark) name");
  });

  test("respects an injected sub-default threshold so a fresh streak files immediately", async () => {
    const { deps, fileCalls } = fakes();
    const res = await runDarkOutcomeAlarm([darkVerdict("brier")], [], { ...deps, darkAlarmMs: 0 });
    assert.equal(fileCalls.length, 1, "a 0ms threshold files on the first dark tick");
    assert.deepEqual(res.filed, ["brier"]);
  });
});
