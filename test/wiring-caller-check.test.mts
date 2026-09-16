/**
 * test/wiring-caller-check.test.mts — pin the wiring caller-reachability
 * check (issue #2289, parent epic #2286) at the pure-function level.
 *
 * scripts/ci/wiring-caller-check.ts is the static complement to the runtime
 * wiring-liveness chore: it reads the `type: caller` entries from
 * config/direction/liveness.yaml and fails when a declared symbol has no
 * reference anywhere outside its own definition (the no-caller failure class
 * that shipped an orphaned `seedVerifiedPairRegistry`). These tests drive the
 * parser and the reachability check directly against fixtures — no filesystem
 * walk, no process.exit — exactly the way the seam-check tests pin their grammar.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { parseCallerEntries, checkCallerReachability } = await import(
  "../scripts/ci/wiring-caller-check.ts"
);

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
