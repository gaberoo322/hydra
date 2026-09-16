/**
 * test/wiring-caller-check.test.mts — pin the static wiring checks that read
 * config/direction/liveness.yaml at the pure-function level.
 *
 * scripts/ci/wiring-caller-check.ts is the static complement to the runtime
 * wiring-liveness chore. It owns two check families, both declared in the
 * shared manifest:
 *
 * - `type: caller` (issue #2289, parent epic #2286): fails when a declared
 *   symbol has no reference anywhere outside its own definition (the
 *   no-caller failure class that shipped an orphaned
 *   `seedVerifiedPairRegistry`).
 * - `type: signal` (issue #4519): the autopilot signal-parity check — every
 *   signal name `collect-state.sh` emits must be either rowed in the
 *   playbook's Signal wiring table or explicitly exempted in the manifest,
 *   and every row's promoted field must be a name `decide.py` actually reads
 *   (the emitted-but-never-promoted class that shipped `design_qa_target_due`
 *   #4342 and `retro_run_drillable` #3871/#4244 as absent-and-falsy).
 *
 * These tests drive the parsers and the checks directly against fixtures —
 * no filesystem walk, no process.exit — exactly the way the seam-check tests
 * pin their grammar.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const {
  parseCallerEntries,
  checkCallerReachability,
  parseSignalEntries,
  extractEmittedSignals,
  extractSignalTable,
  extractReadFields,
  checkSignalParity,
} = await import("../scripts/ci/wiring-caller-check.ts");

describe("wiring-caller-check: parseCallerEntries", () => {
  test("extracts only `type: caller` rows, ignoring timer rows", () => {
    const yaml = `# manifest
entries:
  - unit: hydra-betting-scan.timer
    type: timer
    maxStaleMinutes: 120
  - unit: seedVerifiedPairRegistry
    type: caller
    symbol: seedVerifiedPairRegistry
    defFile: src/registry/seed.ts
    description: Seeds the verified-pair registry at boot.
`;
    const callers = parseCallerEntries(yaml);
    assert.equal(callers.length, 1);
    assert.equal(callers[0].symbol, "seedVerifiedPairRegistry");
    assert.equal(callers[0].defFile, "src/registry/seed.ts");
  });

  test("falls back to `unit` as the symbol when no explicit `symbol` is given", () => {
    const yaml = `entries:
  - unit: bootstrapScheduler
    type: caller
`;
    const callers = parseCallerEntries(yaml);
    assert.equal(callers.length, 1);
    assert.equal(callers[0].symbol, "bootstrapScheduler");
  });

  test("returns an empty list when no caller entries are declared", () => {
    const yaml = `entries:
  - unit: hydra-betting-scan.timer
    type: timer
    maxStaleMinutes: 120
`;
    assert.deepEqual(parseCallerEntries(yaml), []);
  });

  test("ignores trailing comments and handles quoted scalars", () => {
    const yaml = `entries:
  - unit: x   # trailing comment
    type: caller
    symbol: "quotedSymbol"   # also commented
`;
    const callers = parseCallerEntries(yaml);
    assert.equal(callers.length, 1);
    assert.equal(callers[0].symbol, "quotedSymbol");
  });
});

describe("wiring-caller-check: checkCallerReachability", () => {
  test("a caller-entry with a live reference outside its definition PASSES", () => {
    const callers = parseCallerEntries(`entries:
  - unit: seedVerifiedPairRegistry
    type: caller
    symbol: seedVerifiedPairRegistry
    defFile: src/registry/seed.ts
`);
    const files = [
      {
        path: "src/registry/seed.ts",
        content: "export function seedVerifiedPairRegistry() { return 1; }",
      },
      {
        path: "src/index.ts",
        content:
          "import { seedVerifiedPairRegistry } from './registry/seed.ts';\nseedVerifiedPairRegistry();",
      },
    ];
    const result = checkCallerReachability(callers, files);
    assert.equal(result.ok, true);
    assert.equal(result.violations.length, 0);
    assert.equal(result.counts["seedVerifiedPairRegistry"], 2);
  });

  test("a caller-entry with ZERO references outside its definition FAILS, naming the symbol", () => {
    const callers = parseCallerEntries(`entries:
  - unit: seedVerifiedPairRegistry
    type: caller
    symbol: seedVerifiedPairRegistry
    defFile: src/registry/seed.ts
`);
    const files = [
      {
        path: "src/registry/seed.ts",
        content:
          "export function seedVerifiedPairRegistry() { return seedVerifiedPairRegistry; }",
      },
      {
        path: "src/index.ts",
        content: "console.log('nothing references the orphan');",
      },
    ];
    const result = checkCallerReachability(callers, files);
    assert.equal(result.ok, false);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].symbol, "seedVerifiedPairRegistry");
    // The diagnostic must NAME the symbol so a reviewer can act on it.
    assert.match(result.violations[0].message, /seedVerifiedPairRegistry/);
    // References inside the definition file itself do NOT count as live.
    assert.equal(result.counts["seedVerifiedPairRegistry"], 0);
  });

  test("does not partial-match a longer symbol (whole-word boundary)", () => {
    const callers = parseCallerEntries(`entries:
  - unit: seedRegistry
    type: caller
    symbol: seedRegistry
    defFile: src/seed.ts
`);
    const files = [
      { path: "src/seed.ts", content: "export const seedRegistry = 1;" },
      // Only a longer symbol references it — must NOT count as a live caller.
      { path: "src/other.ts", content: "seedRegistryExtended();" },
    ];
    const result = checkCallerReachability(callers, files);
    assert.equal(result.ok, false);
    assert.equal(result.counts["seedRegistry"], 0);
  });

  test("mixed manifest: a referenced and an unreferenced caller — only the orphan fails", () => {
    const callers = parseCallerEntries(`entries:
  - unit: liveCaller
    type: caller
    symbol: liveCaller
    defFile: src/a.ts
  - unit: deadCaller
    type: caller
    symbol: deadCaller
    defFile: src/b.ts
`);
    const files = [
      { path: "src/a.ts", content: "export function liveCaller() {}" },
      { path: "src/b.ts", content: "export function deadCaller() {}" },
      { path: "src/wire.ts", content: "import {liveCaller} from './a.ts'; liveCaller();" },
    ];
    const result = checkCallerReachability(callers, files);
    assert.equal(result.ok, false);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].symbol, "deadCaller");
  });

  test("empty caller list is a clean pass (no caller entries declared)", () => {
    const result = checkCallerReachability([], [
      { path: "src/a.ts", content: "anything();" },
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.violations.length, 0);
  });
});

// ---------------------------------------------------------------------------
// type: signal — manifest parsing (issue #4519)
// ---------------------------------------------------------------------------

describe("wiring-signal-check: parseSignalEntries", () => {
  test("extracts a `type: signal` row with its artifact paths and flat exemption lists", () => {
    const yaml = `entries:
  - unit: autopilot-signal-parity
    type: signal
    collectScript: scripts/autopilot/collect-state.sh
    decideScript: scripts/autopilot/decide.py
    playbookDoc: docs/operator-playbooks/hydra-autopilot.md
    observabilityOnly: redis,scheduler,nonmerges
    unrowedConsumes: slot_events_json=slot_events,orch_realm_weekly_share=orch_realm_weekly_share
    description: Advisory parity over the autopilot signal contract.
`;
    const entries = parseSignalEntries(yaml);
    assert.equal(entries.length, 1);
    const e = entries[0];
    assert.equal(e.unit, "autopilot-signal-parity");
    assert.equal(e.collectScript, "scripts/autopilot/collect-state.sh");
    assert.equal(e.decideScript, "scripts/autopilot/decide.py");
    assert.equal(e.playbookDoc, "docs/operator-playbooks/hydra-autopilot.md");
    assert.deepEqual(e.observabilityOnly, ["redis", "scheduler", "nonmerges"]);
    assert.deepEqual(e.unrowedConsumes, [
      { signal: "slot_events_json", field: "slot_events" },
      { signal: "orch_realm_weekly_share", field: "orch_realm_weekly_share" },
    ]);
    assert.equal(e.description, "Advisory parity over the autopilot signal contract.");
  });

  test("ignores caller/timer rows and defaults the optional lists to empty", () => {
    const yaml = `entries:
  - unit: seedVerifiedPairRegistry
    type: caller
    symbol: seedVerifiedPairRegistry
  - unit: autopilot-signal-parity
    type: signal
    collectScript: a.sh
    decideScript: b.py
    playbookDoc: c.md
`;
    const entries = parseSignalEntries(yaml);
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].observabilityOnly, []);
    assert.deepEqual(entries[0].unrowedConsumes, []);
  });

  test("skips malformed unrowedConsumes pairs (no `=` separator) rather than fatal", () => {
    const yaml = `entries:
  - unit: x
    type: signal
    collectScript: a.sh
    decideScript: b.py
    playbookDoc: c.md
    unrowedConsumes: good_one=field,bad-no-separator
`;
    const entries = parseSignalEntries(yaml);
    assert.deepEqual(entries[0].unrowedConsumes, [{ signal: "good_one", field: "field" }]);
  });

  test("returns an empty list when no signal entries are declared", () => {
    assert.deepEqual(parseSignalEntries("entries:\n  - unit: t.timer\n    type: timer\n"), []);
  });
});

// ---------------------------------------------------------------------------
// type: signal — collect-state.sh emission extraction
// ---------------------------------------------------------------------------

describe("wiring-signal-check: extractEmittedSignals", () => {
  test("extracts echo, echo -n prefix, printf-arg, and python print emissions (deduped)", () => {
    const sh = `#!/usr/bin/env bash
set -uo pipefail

collect_health() {
hydra health 2>/dev/null | python3 -c "$(cat <<'PY'
try: d=json.load(sys.stdin); print(f'health={d["status"]} redis={d["redis"]}')
except: print('health=FAIL')
PY
)"
echo -n "failed_services="; systemctl --user list-units | grep -c hydra || echo 0
}

collect_wip() {
  printf '%s\\n' "target_wip_limit=unknown" "target_in_progress=0"
  echo "orch_backfill_idle=$idle"
}
`;
    const emitted = extractEmittedSignals(sh);
    assert.deepEqual(emitted, [
      "failed_services",
      "health",
      "orch_backfill_idle",
      "redis",
      "target_in_progress",
      "target_wip_limit",
    ]);
  });

  test("ignores commented-out emissions and non-emission assignments", () => {
    const sh = `# echo "ghost_signal=1" -- retired
SOME_VAR=$(compute "not_an_emission")
X=1 Y=2
echo "real_signal=true"
`;
    assert.deepEqual(extractEmittedSignals(sh), ["real_signal"]);
  });

  test("left boundary: a partial word inside a longer name is never extracted", () => {
    const sh = `echo "prefix_bearer=x my_signal=1"
`;
    // `bearer` alone must NOT be extracted — the token is `prefix_bearer`
    // (underscores are name characters). The whole token IS the signal.
    const emitted = extractEmittedSignals(sh);
    assert.ok(!emitted.includes("bearer"));
    assert.deepEqual(emitted, ["my_signal", "prefix_bearer"]);
  });
});

// ---------------------------------------------------------------------------
// type: signal — playbook Signal-wiring table extraction
// ---------------------------------------------------------------------------

describe("wiring-signal-check: extractSignalTable", () => {
  const PLAYBOOK = `# prose before

## Signal wiring (state.signals)

\`collect-state.sh\` emits raw counts; the model turns them into the
boolean signals decide.py reads from \`state.signals\`. The key mappings:

| collect-state output | state.signals key | Drives |
|---|---|---|
| \`ready_for_agent > 0\` (orch GH board) | \`orch_work_available\` | \`dev_orch\` (issue #458) |
| \`target_wip_saturated=true\\|false\` (target GH board) | \`target_wip_saturated\` (boolean) | suppresses \`dev_target\` |
| \`target_board_signals_truncated\` (**target GH board** read) | (advisory only) | nothing — never gates dispatch |
| \`hitl_grill_open\` (orch GH board) | \`hitl_grill_open\` (count) | observability only — gates nothing |
| \`target_risk_surface_json\` (issue #4411) | \`state.target_risk_surface\` (object) | wire_or_retire carve-out |

## Next section

Unrelated prose.
`;

  test("parses rows: mentions from any cell, promoted field from column 2, self-exemption", () => {
    const rows = extractSignalTable(PLAYBOOK);
    assert.equal(rows.length, 5);

    const [r1, r2, r3, r4, r5] = rows;
    // Mentions come from every cell's backtick spans (leading identifier).
    assert.ok(r1.mentioned.includes("ready_for_agent"));
    assert.ok(r1.mentioned.includes("orch_work_available"));
    assert.ok(r1.mentioned.includes("dev_orch"));
    assert.equal(r1.field, "orch_work_available");
    assert.equal(r1.selfExempt, false);

    // An escaped \\| inside a cell must NOT split the row.
    assert.ok(r2.mentioned.includes("target_wip_saturated"));
    assert.equal(r2.field, "target_wip_saturated");

    // "(advisory only)" in column 2: no promoted field + self-exempt.
    assert.equal(r3.field, undefined);
    assert.equal(r3.selfExempt, true);

    // "observability only" anywhere in the row self-exempts.
    assert.equal(r4.field, "hitl_grill_open");
    assert.equal(r4.selfExempt, true);

    // state./state.signals. prefixes are stripped off the promoted field.
    assert.equal(r5.field, "target_risk_surface");
    assert.equal(r5.selfExempt, false);
  });

  test("returns [] when the playbook has no Signal wiring section", () => {
    assert.deepEqual(extractSignalTable("# nothing here\n\n## Other\n"), []);
  });
});

// ---------------------------------------------------------------------------
// type: signal — decide.py read-surface extraction
// ---------------------------------------------------------------------------

describe("wiring-signal-check: extractReadFields", () => {
  test("collects whole-content identifier string literals (both quote styles)", () => {
    const py = `def f(state, events):
    if _signal_present(state, events, "orch_board_signals_degraded"):
        return bool((state.get("signals") or {}).get("orch_realm_weekly_share"))
    raw = signals.get('wayfinder_orch_frontier')
    sat = ESCALATION_SATURATION_SIGNAL.get(slot)  # value-passed read
`;
    const read = extractReadFields(py);
    assert.ok(read.includes("orch_board_signals_degraded"));
    assert.ok(read.includes("orch_realm_weekly_share"));
    assert.ok(read.includes("wayfinder_orch_frontier"));
    assert.ok(read.includes("signals"));
  });

  test("does not count prose mentions inside docstrings or name= tokens", () => {
    const py = `def g():
    """
    collect-state.sh emits \`orch_backfill_idle=true\` when the board is empty.
    The word 'prose' appears quoted but so does design_qa_target_due=true.
    """
    x = "real_read"
`;
    const read = extractReadFields(py);
    assert.ok(read.includes("real_read"));
    assert.ok(read.includes("prose")); // a quoted bare word IS a literal — but:
    assert.ok(!read.includes("orch_backfill_idle"));
    assert.ok(!read.includes("design_qa_target_due"));
  });

  test("table-driven reads count: a dict value naming the signal is a read", () => {
    const py = `ESCALATION_SATURATION_SIGNAL = {
    "cleanup_orch": "cleanup_board_saturated",
}
`;
    assert.ok(extractReadFields(py).includes("cleanup_board_saturated"));
  });
});

// ---------------------------------------------------------------------------
// type: signal — the parity verdict (issue #4519)
// ---------------------------------------------------------------------------

describe("wiring-signal-check: checkSignalParity", () => {
  const ENTRY = {
    unit: "autopilot-signal-parity",
    collectScript: "scripts/autopilot/collect-state.sh",
    decideScript: "scripts/autopilot/decide.py",
    playbookDoc: "docs/operator-playbooks/hydra-autopilot.md",
    observabilityOnly: ["redis"],
    unrowedConsumes: [{ signal: "slot_events_json", field: "slot_events" }],
  };

  const TEXTS = {
    collectStateText: `echo "health=ok"
echo -n "failed_services="; echo 0
echo "design_qa_target_due=true"
echo "orch_backfill_idle=false"
echo "redis=ok"
echo "slot_events_json={}"
`,
    decideText: `if _signal_present(state, events, "health_fail"):
    pass
if (state.get("signals") or {}).get("orch_backfill_idle"):
    pass
if state.get("slot_events"):
    pass
`,
    playbookText: `## Signal wiring (state.signals)

| collect-state output | state.signals key | Drives |
|---|---|---|
| \`health=FAIL\` or \`failed_services>0\` | \`health_fail\` | \`health\` |
| \`orch_backfill_idle=true\` | \`orch_backfill_idle\` | \`architecture_orch\` |
`,
  };

  test("the #4342/#4244 class: an emitted signal with no row and no exemption FAILS", () => {
    const result = checkSignalParity(ENTRY, TEXTS);
    assert.equal(result.ok, false);
    const v = result.violations.find((x) => x.kind === "emitted-no-row");
    assert.ok(v, "expected an emitted-no-row violation");
    assert.equal(v!.name, "design_qa_target_due");
    assert.match(v!.message, /design_qa_target_due/);
  });

  test("rowed + read signals pass; mentions in any cell count as rowed", () => {
    const result = checkSignalParity(ENTRY, TEXTS);
    // health/failed_services are rowed (mentioned), orch_backfill_idle rowed+read.
    const unrowed = result.violations.filter((x) => x.kind === "emitted-no-row");
    assert.deepEqual(unrowed.map((v) => v.name), ["design_qa_target_due"]);
  });

  test("an exempted observability-only signal passes the row requirement", () => {
    // redis is in observabilityOnly and emitted — no violation for it.
    const result = checkSignalParity(ENTRY, TEXTS);
    assert.ok(!result.violations.some((v) => v.name === "redis"));
  });

  test("an exempted unrowedConsumes signal passes iff decide.py still reads the field", () => {
    // slot_events_json → slot_events is read in the fixture: no violation.
    const okResult = checkSignalParity(ENTRY, TEXTS);
    assert.ok(!okResult.violations.some((v) => v.name === "slot_events_json"));

    // Remove the read: the documented consumer is gone → exempt-consumer-gone.
    const gone = checkSignalParity(ENTRY, {
      ...TEXTS,
      decideText: `if _signal_present(state, events, "health_fail"):
    pass
`,
    });
    const v = gone.violations.find((x) => x.kind === "exempt-consumer-gone");
    assert.ok(v, "expected exempt-consumer-gone");
    assert.equal(v!.name, "slot_events_json");
  });

  test("a row promoting a field decide.py never reads FAILS (row-field-never-read)", () => {
    const texts = {
      collectStateText: `echo "arch_board_saturated=false"
`,
      decideText: `# reads nothing relevant
x = "unrelated"
`,
      playbookText: `## Signal wiring (state.signals)

| collect-state output | state.signals key | Drives |
|---|---|---|
| \`arch_board_saturated=true\` | \`arch_board_saturated\` | suppresses \`architecture_orch\` |
`,
    };
    const result = checkSignalParity(
      { ...ENTRY, observabilityOnly: [], unrowedConsumes: [] },
      texts,
    );
    const v = result.violations.find((x) => x.kind === "row-field-never-read");
    assert.ok(v, "expected row-field-never-read");
    assert.equal(v!.name, "arch_board_saturated");
  });

  test("a self-exempted (advisory/observability-only) row skips the read requirement", () => {
    const texts = {
      collectStateText: `echo "hitl_grill_open=3"
`,
      decideText: `x = "nothing"
`,
      playbookText: `## Signal wiring (state.signals)

| collect-state output | state.signals key | Drives |
|---|---|---|
| \`hitl_grill_open\` (count) | \`hitl_grill_open\` (count) | observability only — gates nothing |
`,
    };
    const result = checkSignalParity(
      { ...ENTRY, observabilityOnly: [], unrowedConsumes: [] },
      texts,
    );
    assert.equal(result.ok, true);
  });

  test("an exemption naming a signal that is no longer emitted is stale", () => {
    const result = checkSignalParity(
      { ...ENTRY, observabilityOnly: ["redis", "ghost_signal"], unrowedConsumes: [] },
      { ...TEXTS, decideText: "" },
    );
    const v = result.violations.find((x) => x.kind === "exempt-stale");
    assert.ok(v, "expected exempt-stale");
    assert.equal(v!.name, "ghost_signal");
  });

  test("a clean contract is a clean pass with diagnostic counts", () => {
    const texts = {
      collectStateText: `echo "orch_backfill_idle=false"
`,
      decideText: `if (state.get("signals") or {}).get("orch_backfill_idle"):
    pass
`,
      playbookText: `## Signal wiring (state.signals)

| collect-state output | state.signals key | Drives |
|---|---|---|
| \`orch_backfill_idle=true\` | \`orch_backfill_idle\` | \`architecture_orch\` |
`,
    };
    const result = checkSignalParity(
      { ...ENTRY, observabilityOnly: [], unrowedConsumes: [] },
      texts,
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.violations, []);
    assert.equal(result.counts.emitted, 1);
    // `rowned` counts every backtick-mentioned name across ALL cells (the
    // driver `architecture_orch` in column 3 counts too) — it is a diagnostic
    // total, not the count of emitted signals covered.
    assert.ok(result.counts.rowed >= 1);
  });
});
