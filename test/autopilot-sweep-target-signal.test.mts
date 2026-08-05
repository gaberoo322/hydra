/**
 * Regression tests for issue #3729 — the sweep_target per-item verdict-stability
 * guard.
 *
 * This issue was RE-SCOPED by the design-concept grill (artifact `issue-3729`):
 * the original "items park in needs-triage forever" premise was falsified (both
 * cited items left the lane in ~28h, well inside their grace windows). The REAL
 * defect is verdict THRASH — successive sweeps at the 900s class cooldown reached
 * mutually contradictory verdicts on the same items (#631 took 10 label events
 * in 28h, #626 took 12 in 36h). Options A (date-gating in collect-state.sh) and C
 * (a parked-until label) are explicitly rejected: A suppresses the very
 * dispatches that promote items out of the lane, and C reintroduces the #3720
 * phantom-label failure mode. The literal Option B (class-level backoff) is also
 * rejected — it would starve a genuinely-new actionable item arriving during
 * another item's backoff.
 *
 * The shipped fix is a PER-ITEM verdict-stability guard, AND-composed with the
 * unchanged 900s class cooldown:
 *
 *   - collect-state.sh emits `target_needs_triage_items=626,631,...` — the
 *     current needs-triage item NUMBERS — as a fresh per-turn fact (stateless;
 *     decide.py owns the cross-turn stamp history). [collect-state section below]
 *   - decide.py keeps `state.target_triage_item_stamps` (issue-number -> epoch
 *     last examined). sweep_target fires iff the 900s class cooldown has elapsed
 *     AND >=1 current item is ELIGIBLE (no stamp, or a stamp older than a fixed
 *     6h backoff window). On fire it stamps `now` for EVERY current item and
 *     prunes the rest. Absent item list -> fail-open (fire), so the guard is
 *     dormant on legacy/degraded state and never deadlocks the lane.
 *
 * Both directions of the issue's literal ACs are pinned, reinterpreted under the
 * per-item mechanism (Q&A turn 8): AC1 ("no dispatch in the current state") is
 * satisfied by constructing the fixture with both items FRESHLY STAMPED (inside
 * the window) rather than by date-gating; AC2 ("adding an actionable item
 * dispatches") by a third, UNSTAMPED item.
 *
 * decide.py is exercised through the `decide` CLI with a frozen `--now=<epoch>`
 * for deterministic backoff-window math; collect-state.sh's read-#2 emitter is
 * extracted and run against synthetic Target boards (mirrors the harness in
 * test/autopilot-target-board-signals.test.mts).
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DECIDE = join(REPO_ROOT, "scripts", "autopilot", "decide.py");
const COLLECT = join(REPO_ROOT, "scripts", "autopilot", "collect-state.sh");
const collectSrc = readFileSync(COLLECT, "utf-8");

// A frozen decision epoch so every backoff-window assertion is deterministic.
// The decide CLI honours `--now=<epoch>`; all stamp math below is relative to it.
const NOW = 1_900_000_000;
const BACKOFF_WINDOW = 6 * 60 * 60; // TARGET_TRIAGE_BACKOFF_SEC in decide.py

interface Tmp {
  dir: string;
  state: string;
  cands: string;
  events: string;
}

function makeTmp(): Tmp {
  const dir = mkdtempSync(join(tmpdir(), "sweep-target-signal-"));
  return {
    dir,
    state: join(dir, "state.json"),
    cands: join(dir, "candidates.json"),
    events: join(dir, "events.json"),
  };
}

interface StateOverrides {
  scope?: string;
  signal_last_fired?: Record<string, number>;
  signals?: Record<string, unknown>;
  target_triage_item_stamps?: Record<string, number>;
}

function baseState(o: StateOverrides = {}): any {
  return {
    started_epoch: NOW,
    limits: {
      token_budget: 2_000_000,
      wall_clock_max_sec: 28_800,
      idle_drain_turns: 5,
      scope: o.scope ?? "all",
    },
    cumulative_tokens: 0,
    dispatches: 0,
    idle_turns: 0,
    turn: 0,
    burned_classes: [],
    reaped_task_ids: [],
    failure_log: [],
    slots: {},
    // sweep_target: 0 => "never fired" => class cooldown elapsed at any real now.
    signal_last_fired: o.signal_last_fired ?? { sweep_target: 0 },
    signals: o.signals ?? {},
    research_force_counter: {},
    ...(o.target_triage_item_stamps
      ? { target_triage_item_stamps: o.target_triage_item_stamps }
      : {}),
  };
}

/** A candidate feed that does NOT recommend research, so only the board signals
 *  under test can drive the Target branch (mirrors decide-target-board-dispatch). */
const feedNoResearch = {
  candidates: [{ anchorRef: "item-1", score: 0.9 }],
  research_recommended: false,
};

interface RunResult {
  plan: any;
  stateAfter: any;
}

function runDecide(
  state: any,
  candidates: any,
  events: any[] = [],
  now: number = NOW,
): RunResult {
  const t = makeTmp();
  try {
    writeFileSync(t.state, JSON.stringify(state));
    writeFileSync(t.cands, JSON.stringify(candidates));
    writeFileSync(t.events, JSON.stringify(events));
    const r = spawnSync(
      "python3",
      [DECIDE, `--now=${now}`, "decide", t.state, t.cands, t.events],
      { encoding: "utf-8" },
    );
    if (r.status !== 0) {
      throw new Error(`decide.py decide exited ${r.status}: ${r.stderr}`);
    }
    const plan = JSON.parse(r.stdout);
    // Read the (possibly mutated) state file back so stamp-writeback assertions
    // can inspect what main() persisted, not just the plan it printed.
    const stateAfter = JSON.parse(readFileSync(t.state, "utf-8"));
    return { plan, stateAfter };
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
}

function findAction(plan: any, predicate: (a: any) => boolean): any | undefined {
  return (plan.actions ?? []).find(predicate);
}

const sweepTarget = (a: any) => a.type === "dispatch" && a.slot === "sweep_target";

// ---------------------------------------------------------------------------
// decide.py — sweep_target per-item verdict-stability guard (issue #3729)
// ---------------------------------------------------------------------------

describe("decide.py — sweep_target per-item verdict-stability guard (issue #3729)", () => {
  test("AC1: every current item freshly stamped -> NO sweep_target dispatch", () => {
    // The issue's literal AC1 ("no dispatch in the current 2-item state"),
    // reinterpreted under the per-item mechanism: both items are inside the
    // backoff window, so the lane is stable and the thrash-suppressing guard
    // holds. (Q&A turn 8 — NOT satisfied by date-gating, which is rejected.)
    const state = baseState({
      signals: { needs_triage_target: true, target_needs_triage_items: "626,631" },
      target_triage_item_stamps: { "626": NOW, "631": NOW },
    });
    const { plan } = runDecide(state, feedNoResearch);
    assert.equal(
      findAction(plan, sweepTarget),
      undefined,
      "a lane whose every item was examined within the 6h window must not re-dispatch sweep_target",
    );
  });

  test("AC1 holds even when the stamps are just inside the window boundary", () => {
    // 1s inside the window is still inside -> suppressed. Pins that the guard
    // uses >= (window elapsed) as the eligibility threshold, not >.
    const state = baseState({
      signals: { needs_triage_target: true, target_needs_triage_items: "626" },
      target_triage_item_stamps: { "626": NOW - (BACKOFF_WINDOW - 1) },
    });
    const { plan } = runDecide(state, feedNoResearch);
    assert.equal(findAction(plan, sweepTarget), undefined);
  });

  test("AC2: an item with NO stamp (cold start) -> sweep_target DOES dispatch", () => {
    // No stamp map at all -> every item is immediately eligible (INV-2). This is
    // the issue's AC2 ("adding a genuinely actionable item dispatches") realised
    // as a third, unstamped item in the set.
    const state = baseState({
      signals: { needs_triage_target: true, target_needs_triage_items: "626,631,700" },
    });
    const { plan } = runDecide(state, feedNoResearch);
    const a = findAction(plan, sweepTarget);
    assert.ok(a, "an unstamped (brand-new) item must make the lane eligible");
    assert.equal(a.skill, "hydra-target-sweep");
  });

  test("AC2 (alt): an item whose stamp is OLDER than the backoff window -> dispatch", () => {
    // 626 examined just now (inside window), 700 examined 7h ago (outside) ->
    // 700 is eligible -> fire. One eligible item is enough.
    const state = baseState({
      signals: { needs_triage_target: true, target_needs_triage_items: "626,700" },
      target_triage_item_stamps: {
        "626": NOW,
        "700": NOW - (BACKOFF_WINDOW + 3600),
      },
    });
    const { plan } = runDecide(state, feedNoResearch);
    assert.ok(findAction(plan, sweepTarget));
  });

  test("fail-open: absent item list -> sweep_target fires (backward-compatible)", () => {
    // needs_triage_target is true but collect-state.sh emitted no item list
    // (legacy state, or a degraded board read). The guard MUST go dormant and
    // fire on the pre-#3729 rule alone — absent-safe, never deadlock the lane.
    // This is what keeps the existing decide-target-board-dispatch suite green.
    const state = baseState({ signals: { needs_triage_target: true } });
    const { plan } = runDecide(state, feedNoResearch);
    assert.ok(
      findAction(plan, sweepTarget),
      "an absent item list must fail open toward firing, not suppress",
    );
  });

  test("fail-open: an empty item-list string also fires", () => {
    // A present-but-empty list ("needs_triage_target true but items=''") is a
    // stale/edge state, not "zero items" — treated as absent -> fail-open.
    const state = baseState({
      signals: { needs_triage_target: true, target_needs_triage_items: "" },
    });
    const { plan } = runDecide(state, feedNoResearch);
    assert.ok(findAction(plan, sweepTarget));
  });

  test("item list supplied via an EVENT is honoured (events take precedence)", () => {
    // _target_triage_items_value checks events before state.signals, mirroring
    // _signal_present. Pin the event path so the per-turn-fact contract holds
    // whichever seam the playbook stitches through.
    const state = baseState({
      signals: { needs_triage_target: true, target_needs_triage_items: "626,631" },
      target_triage_item_stamps: { "626": NOW, "631": NOW },
    });
    // An event overrides state.signals with a DIFFERENT set that has an
    // unstamped item -> the guard must see 777 and fire.
    const events = [
      { type: "signal", name: "target_needs_triage_items", value: "626,777" },
    ];
    const { plan } = runDecide(state, feedNoResearch, events);
    assert.ok(findAction(plan, sweepTarget));
  });

  test("on fire: every current item is stamped `now` and persisted to state.json", () => {
    // INV-4: a dispatch stamps the CURRENT set uniformly (not just the eligible
    // item). main() detects the mutation and writes it back atomically.
    const state = baseState({
      signals: { needs_triage_target: true, target_needs_triage_items: "626,631" },
    });
    const { stateAfter } = runDecide(state, feedNoResearch);
    assert.deepEqual(stateAfter.target_triage_item_stamps, {
      "626": NOW,
      "631": NOW,
    });
  });

  test("on fire: stamps for items no longer in the lane are PRUNED", () => {
    // INV-5: write-back replaces the whole map with the current set, so an item
    // that left needs-triage (999) is dropped — the map never grows unbounded.
    const state = baseState({
      signals: { needs_triage_target: true, target_needs_triage_items: "626,631" },
      target_triage_item_stamps: { "999": NOW - BACKOFF_WINDOW },
    });
    const { stateAfter } = runDecide(state, feedNoResearch);
    assert.deepEqual(stateAfter.target_triage_item_stamps, {
      "626": NOW,
      "631": NOW,
    });
    assert.equal(
      stateAfter.target_triage_item_stamps["999"],
      undefined,
      "a stale stamp for an item that left the lane must be pruned",
    );
  });

  test("on suppress: the stamp map is left UNCHANGED (no write, no prune)", () => {
    // When the guard suppresses (all items inside the window), decide.py must
    // not mutate the map — there was no dispatch to reset clocks for. The
    // pre-existing stamps survive untouched into the next turn.
    const state = baseState({
      signals: { needs_triage_target: true, target_needs_triage_items: "626,631" },
      target_triage_item_stamps: { "626": NOW - 60, "631": NOW - 120 },
    });
    const { plan, stateAfter } = runDecide(state, feedNoResearch);
    assert.equal(findAction(plan, sweepTarget), undefined);
    assert.deepEqual(stateAfter.target_triage_item_stamps, {
      "626": NOW - 60,
      "631": NOW - 120,
    });
  });

  test("INV-1: the 900s class cooldown is STILL enforced (AND-composed, not replaced)", () => {
    // sweep_target fired THIS epoch (inside its 900s class cooldown). Even
    // though the items are eligible, the class cooldown must suppress first —
    // the per-item guard is an ADDITIONAL condition, never a replacement.
    const state = baseState({
      signal_last_fired: { sweep_target: NOW },
      signals: { needs_triage_target: true, target_needs_triage_items: "626" },
    });
    const { plan } = runDecide(state, feedNoResearch);
    assert.equal(
      findAction(plan, sweepTarget),
      undefined,
      "the class cooldown must suppress even when an item is per-item eligible",
    );
  });

  test("per-item independence: a brand-new item fires during another item's backoff", () => {
    // The literal rejected Option B (class-level backoff) could not distinguish
    // "626 was just checked" from "777 is brand-new" and would starve 777. The
    // per-item clock must NOT: 626 inside its window, 777 unstamped -> fire.
    const state = baseState({
      signals: { needs_triage_target: true, target_needs_triage_items: "626,777" },
      target_triage_item_stamps: { "626": NOW },
    });
    const { plan } = runDecide(state, feedNoResearch);
    assert.ok(
      findAction(plan, sweepTarget),
      "a new item arriving mid-backoff must dispatch — the whole point of per-item (not class-level) clocks",
    );
  });

  test("no needs_triage_target signal -> sweep_target idles regardless of stamps", () => {
    // The guard only runs once needs_triage_target is present; with the trigger
    // absent, no stamps in the world produce a dispatch.
    const state = baseState({
      signals: { target_needs_triage_items: "626" },
      target_triage_item_stamps: {},
    });
    const { plan } = runDecide(state, feedNoResearch);
    assert.equal(findAction(plan, sweepTarget), undefined);
  });
});

// ---------------------------------------------------------------------------
// collect-state.sh — target_needs_triage_items emission (issue #3729)
// ---------------------------------------------------------------------------

/**
 * Extract the read-#2 python emitter (the wire-or-retire / design-qa / cleanup
 * block that ALSO emits target_needs_triage_items) and run it against a
 * synthetic Target board, so the test exercises the exact logic the script
 * ships (not a copy that can drift). Mirrors extractTargetBoardEmitter in
 * test/autopilot-target-board-signals.test.mts, but for the number+labels block.
 */
function extractItemEmitter(): string {
  // `import json, os, sys` (with `os`) uniquely identifies read #2; read #1's
  // emitters use `import json,sys`.
  const m = collectSrc.match(
    /TARGET_CLEANUP_BOARD_SATURATION_CAP="\$TARGET_CLEANUP_BOARD_SATURATION_CAP" python3 -c "(\nimport json, os, sys\n[\s\S]*?)\n" 2>\/dev\/null/,
  );
  assert.ok(m, "could not locate the read-#2 item-emitter python block in collect-state.sh");
  return m[1];
}

function runItemEmitter(
  rows: ReadonlyArray<{ number: number; labels: string[] }>,
): Record<string, string> {
  const r = spawnSync("python3", ["-c", extractItemEmitter()], {
    input: JSON.stringify(rows),
    encoding: "utf-8",
  });
  assert.equal(r.status, 0, `item emitter exited non-zero: ${r.stderr}`);
  const out: Record<string, string> = {};
  for (const line of (r.stdout ?? "").trim().split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

describe("collect-state.sh — target_needs_triage_items emission (issue #3729)", () => {
  test("emits target_needs_triage_items as a sorted CSV of needs-triage issue numbers", () => {
    // Unordered input (newest-first gh ordering) must render as a stable
    // ascending list so per-turn state diffs stay readable.
    const out = runItemEmitter([
      { number: 631, labels: ["needs-triage", "wire-or-retire"] },
      { number: 626, labels: ["needs-triage", "wire-or-retire"] },
      { number: 700, labels: ["needs-triage"] },
      { number: 5, labels: ["ready-for-agent"] },
      { number: 9, labels: ["needs-qa"] },
    ]);
    assert.equal(out.target_needs_triage_items, "626,631,700");
  });

  test("a triage-empty board emits an empty list (the fail-open sentinel)", () => {
    // Empty -> decide.py parses None -> guard dormant -> fire. A board with no
    // needs-triage items must never emit a stale or phantom list.
    const out = runItemEmitter([{ number: 5, labels: ["ready-for-agent"] }]);
    assert.equal(out.target_needs_triage_items, "");
  });

  test("the script emits target_needs_triage_items in EVERY branch", () => {
    // decide.py reads this key each turn, so it must be present whether the read
    // succeeded (python success path), the python threw (except arm), the python
    // binary failed (shell || fallback), or the board was unreachable (else).
    // Pin >=4 emit sites so a future edit can't silently drop a branch.
    const occurrences = (collectSrc.match(/target_needs_triage_items=/g) || []).length;
    assert.ok(
      occurrences >= 4,
      `expected target_needs_triage_items= in all 4 branches, found ${occurrences}`,
    );
  });

  test("the read projects `number` alongside labels (the item-list data source)", () => {
    // The jq must carry `number` into the python block (pre-#3729 read #2
    // projected labels only). Pin that read #2 both REQUESTS number
    // (`--json number,labels`) AND projects it (`{ number, ...`), in its
    // specific `[ .[] | ... ]` shape, so a refactor can't silently drop it and
    // make the emitted list always empty.
    assert.match(
      collectSrc,
      /--json number,labels --jq '\[ \.\[\] \| \{ number,/,
      "read #2 must project { number, labels } so item numbers reach the emitter",
    );
  });
});
