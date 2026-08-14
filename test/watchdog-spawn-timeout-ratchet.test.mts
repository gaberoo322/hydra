/**
 * Ratchet: no watchdog-spawning test file may use a sub-floor `spawnSync`
 * timeout (issues #4044, #4072).
 *
 * WHY A RATCHET AND NOT ANOTHER SWEEP. #4044 found this exact defect and fixed
 * the three files that existed when it was filed. Two more with the same defect
 * (`watchdog-launch-flow`, `watchdog-pending-work`) were authored *inside its
 * own open window* and were never covered — the pattern reintroduced itself
 * within hours of being fixed:
 *
 *   2026-08-13 10:07Z  #4044 filed, enumerating 3 files
 *   2026-08-13 10:20Z  watchdog-pending-work.test.mts created  (13 min later)
 *   2026-08-13 17:45Z  watchdog-launch-flow.test.mts  created
 *   2026-08-14 01:24Z  #4044 closed
 *
 * A static enumeration cannot cover files being written concurrently with it,
 * and nothing stopped file #6. This guard is that "nothing".
 *
 * WHY A TEST RATHER THAN A CI WORKFLOW. A sibling advisory workflow cannot
 * block a merge — only checks inside the already-required `test` job can. This
 * file therefore runs in the same job it protects, and needs no workflow edit
 * (which would land in the Verifier Core).
 *
 * WHAT IT COSTS TO GET THIS WRONG. `test` gates `deploy`, so each flake also
 * silently parks prod behind master — the #734 drift detector is log-only, so
 * nothing alarms. Measured 2026-08-14: 3 failures in 10 master runs, all on
 * watchdog-spawning suites, plus reddened required checks on unrelated PRs.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { MIN_WATCHDOG_TEST_TIMEOUT_MS } from "./_helpers/watchdog-timeouts.mts";

const TEST_DIR = resolve(import.meta.dirname);

/** Marker identifying a file that drives `scripts/hydra-watchdog.sh`. */
const WATCHDOG_MARKER = "hydra-watchdog.sh";

/**
 * Every `timeout: <number>` in a spawn options object, as [literal, ms] pairs.
 *
 * Matches only NUMERIC literals — `timeout: WATCHDOG_SPAWN_TIMEOUT_MS` is the
 * compliant form and is deliberately invisible here, so migrating a file to the
 * shared constant is what makes it pass rather than picking a big enough
 * number. Underscore separators (`120_000`) are normalised before comparison.
 */
export function numericTimeouts(source: string): { literal: string; ms: number }[] {
  const out: { literal: string; ms: number }[] = [];
  for (const m of source.matchAll(/\btimeout:\s*([0-9][0-9_]*)\b/g)) {
    out.push({ literal: m[1], ms: Number(m[1].replace(/_/g, "")) });
  }
  return out;
}

/** Test files that reference the watchdog script AND spawn something. */
function watchdogSpawningFiles(): { name: string; source: string }[] {
  return readdirSync(TEST_DIR)
    .filter((f) => f.endsWith(".test.mts"))
    .map((name) => ({ name, source: readFileSync(join(TEST_DIR, name), "utf-8") }))
    .filter((f) => f.source.includes(WATCHDOG_MARKER) && f.source.includes("spawnSync"))
    // This guard's own source mentions both markers in prose; exclude it so it
    // cannot flag itself.
    .filter((f) => f.name !== "watchdog-spawn-timeout-ratchet.test.mts");
}

describe("watchdog spawn-timeout ratchet (issues #4044, #4072)", () => {
  test("the guard actually finds the watchdog suites (it is not vacuously green)", () => {
    const files = watchdogSpawningFiles().map((f) => f.name).sort();
    // A guard that silently matches nothing is worse than no guard — it reads
    // as passing forever. Pin the known set so a rename that breaks discovery
    // fails loudly here instead of quietly disabling the ratchet.
    assert.ok(
      files.length >= 5,
      `expected at least the 5 known watchdog suites, found ${files.length}: ${files.join(", ")}`,
    );
    for (const expected of [
      "autopilot-watchdog.test.mts",
      "watchdog-deploy-drift.test.mts",
      "watchdog-launch-flow.test.mts",
      "watchdog-pending-work.test.mts",
      "watchdog-skill-mirror-drift.test.mts",
    ]) {
      assert.ok(files.includes(expected), `known watchdog suite not discovered: ${expected}`);
    }
  });

  test(`no watchdog suite spawns with a timeout below ${MIN_WATCHDOG_TEST_TIMEOUT_MS}ms`, () => {
    const offenders: string[] = [];
    for (const { name, source } of watchdogSpawningFiles()) {
      for (const { literal, ms } of numericTimeouts(source)) {
        if (ms < MIN_WATCHDOG_TEST_TIMEOUT_MS) offenders.push(`${name}: timeout: ${literal} (${ms}ms)`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `watchdog suites must not use a spawn timeout below ${MIN_WATCHDOG_TEST_TIMEOUT_MS}ms — ` +
        `these ceilings expire under CI load and redden the REQUIRED test gate (#4044/#4072). ` +
        `Import WATCHDOG_SPAWN_TIMEOUT_MS or WATCHDOG_REDIS_TIMEOUT_MS from ` +
        `test/_helpers/watchdog-timeouts.mts instead of a bare literal.\nOffenders:\n  ` +
        offenders.join("\n  "),
    );
  });

  test("PROOF: the detector fires on a deliberately-low ceiling", () => {
    // AC from #4072: "The guard is proven to fail against a deliberately-low
    // ceiling before being landed green." Exercising the pure extractor is that
    // proof without mutating a real file on disk — if this ever stops finding
    // the 4_000, the check above has gone vacuous and every real offender would
    // slip through silently.
    const synthetic = `
      const r = spawnSync("docker", ["exec", "hydra-redis-1", "redis-cli", "PING"], {
        encoding: "utf-8",
        timeout: 4_000,
      });
      // ${WATCHDOG_MARKER}
    `;
    const found = numericTimeouts(synthetic);
    assert.equal(found.length, 1, "extractor must find the numeric literal");
    assert.equal(found[0].ms, 4000, "underscore separators must be normalised");
    assert.ok(found[0].ms < MIN_WATCHDOG_TEST_TIMEOUT_MS, "4s must be judged below the floor");
  });

  test("a compliant file using the shared constant is NOT flagged", () => {
    // The named-constant form must be invisible to the extractor, otherwise the
    // only way to pass would be to inline an ever-larger number — the very
    // literal-copying habit that let this defect recur.
    const compliant = `
      const r = spawnSync("bash", ["-c", driver], {
        encoding: "utf-8",
        timeout: WATCHDOG_SPAWN_TIMEOUT_MS,
      });
      // ${WATCHDOG_MARKER}
    `;
    assert.deepEqual(numericTimeouts(compliant), []);
  });
});
