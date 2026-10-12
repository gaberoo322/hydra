/**
 * Regression test for scout cooldown constant drift between the TypeScript
 * calendar walk (`src/scout/calendar-walk.ts`) and the Python decision brain
 * (`scripts/autopilot/decide.py`).
 *
 * Issue #533 — follow-up to PR #530 (closes #485, tool-scout Phase B).
 *
 * Why this test exists
 * --------------------
 *
 * PR #530 introduced two cooldown constants that *must* stay in lock-step
 * but live in different languages:
 *
 *   - `CLASS_COOLDOWN_DAYS` in `src/scout/calendar-walk.ts` (gates the
 *     read-path / dashboard "next scout in N days" affordance).
 *   - `SIGNAL_COOLDOWNS["scout_orch"]` in `scripts/autopilot/decide.py`
 *     (gates whether decide.py emits a `scout_orch` dispatch action).
 *
 * If one drifts without the other (e.g. someone bumps the TS constant to
 * 14 days but forgets the Python dict), the dashboard and the dispatcher
 * disagree silently — the UI promises a scout in N days, the autopilot
 * waits M. This test fails CI when that happens.
 *
 * Coverage notes
 * --------------
 *
 * 1. Per-class cooldown (the primary symmetric pair): asserted to be equal
 *    by reading from both source-of-truth modules at test time.
 *
 * 2. Per-category cooldown (`CATEGORY_COOLDOWN_DAYS` in TS):
 *    Verified via grep that `decide.py` does NOT carry a Python counterpart
 *    — the category cooldown is intentionally TS-only because Python only
 *    reads the pre-computed `scout_walk_due` signal from the Turn Snapshot
 *    and never re-checks category state. This is the architecture the
 *    issue asked us to "verify": Python delegates category gating to the
 *    TS planWalk. The test pins this asymmetry so a future drift (someone
 *    duplicates the constant into Python without making it shared) shows
 *    up as a deliberate test edit, not a silent change.
 *
 *    We additionally pin the TS-side `CATEGORY_COOLDOWN_DAYS` value to
 *    a constant in this test. Bumping the category cooldown is now a
 *    visible diff to two files (the source and this test), which forces
 *    the author to think about whether a Python-side mirror is needed.
 *
 * Method: read SIGNAL_COOLDOWNS["scout_orch"] from decide.py via a
 * `python3 -c` subprocess (decide.py is a script, not a package — same
 * pattern used by `test/autopilot-brain-smoke.test.mts`). Importing via
 * `importlib.util` requires registering the module in `sys.modules` first
 * so the `@dataclass` decorators inside decide.py resolve their own module
 * during class-body evaluation.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { readBrainSource, BRAIN_SELECTORS_DIR, type BrainSourceFile } from "../scripts/ci/brain-source.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DECIDE_PY = resolve(REPO_ROOT, "scripts", "autopilot", "decide.py");

const { CLASS_COOLDOWN_DAYS, CATEGORY_COOLDOWN_DAYS } = await import(
  "../src/scout/calendar-walk.ts"
);

/**
 * Live-code lines (docstrings + comments stripped, crude but adequate) in any
 * brain source file that mention a category-cooldown constant. Returns
 * `path: line` entries so a hit names the module it lives in.
 */
function categoryCooldownHits(files: readonly BrainSourceFile[]): string[] {
  const hits: string[] = [];
  for (const f of files) {
    const noDoc = f.text.replace(/"""[\s\S]*?"""/g, "").replace(/'\'\'[\s\S]*?\'\'\'/g, "");
    for (const raw of noDoc.split("\n")) {
      const line = raw.split("#", 1)[0];
      if (line.includes("CATEGORY_COOLDOWN") || line.includes("category_cooldown")) {
        hits.push(`${f.path}: ${line.trim()}`);
      }
    }
  }
  return hits;
}

const SECONDS_PER_DAY = 24 * 60 * 60;

/**
 * Read a SIGNAL_COOLDOWNS entry from decide.py.
 *
 * decide.py is a CLI script (not a package), and importing it triggers
 * `@dataclass` decorators at module top level. The decorators introspect
 * `sys.modules[cls.__module__]` during class evaluation, so the module
 * has to be registered in `sys.modules` BEFORE `spec.loader.exec_module`
 * runs — otherwise Python 3.12 raises `AttributeError: 'NoneType' object
 * has no attribute '__dict__'`. Hence the `sys.modules[name] = m`
 * assignment in the helper script below.
 */
function readSignalCooldownFromPython(signalKey: string): number {
  const script = `
import sys
import importlib.util
spec = importlib.util.spec_from_file_location("decide", ${JSON.stringify(DECIDE_PY)})
m = importlib.util.module_from_spec(spec)
sys.modules["decide"] = m
spec.loader.exec_module(m)
print(m.SIGNAL_COOLDOWNS[${JSON.stringify(signalKey)}])
`;
  const r = spawnSync("python3", ["-c", script], { encoding: "utf-8" });
  if (r.status !== 0) {
    throw new Error(
      `python3 failed reading SIGNAL_COOLDOWNS[${signalKey}]: status=${r.status} stderr=${r.stderr}`,
    );
  }
  const out = r.stdout.trim();
  const n = Number(out);
  if (!Number.isFinite(n)) {
    throw new Error(
      `python3 emitted non-numeric SIGNAL_COOLDOWNS[${signalKey}]: ${JSON.stringify(out)}`,
    );
  }
  return n;
}

describe("scout cooldown constant drift — TS ↔ Python", () => {
  test("CLASS_COOLDOWN_DAYS (TS) matches SIGNAL_COOLDOWNS['scout_orch'] (Python)", () => {
    const tsSeconds = CLASS_COOLDOWN_DAYS * SECONDS_PER_DAY;
    const pySeconds = readSignalCooldownFromPython("scout_orch");
    assert.equal(
      tsSeconds,
      pySeconds,
      `\nCLASS_COOLDOWN_DAYS drift detected!\n` +
        `  src/scout/calendar-walk.ts  CLASS_COOLDOWN_DAYS = ${CLASS_COOLDOWN_DAYS} days (${tsSeconds}s)\n` +
        `  scripts/autopilot/decide.py SIGNAL_COOLDOWNS['scout_orch'] = ${pySeconds}s (${pySeconds / SECONDS_PER_DAY} days)\n` +
        `These must stay equal — the TS const drives the dashboard's "next scout in N days" copy and\n` +
        `the Python dict drives whether decide.py emits a scout_orch dispatch. If one moves, the\n` +
        `operator sees a misleading UI vs dispatcher disagreement (issue #533).`,
    );
  });

  test("CATEGORY_COOLDOWN_DAYS (TS) has no Python mirror — decide.py delegates category gating to TS", () => {
    // The category cooldown is intentionally TS-only: decide.py reads
    // `scout_walk_due` (computed by the Turn Snapshot + planWalk) and never
    // re-checks per-category state. We assert this asymmetry by grepping
    // decide.py for any `CATEGORY` reference that would suggest someone
    // bolted on a Python-side copy without making it shared.
    //
    // If a future change moves to a shared `config/autopilot/cooldowns.json`
    // (option 1 in the issue), decide.py will gain a load site for the
    // category cooldown too — at which point this test should be updated to
    // assert the loaded values match, exactly the same way as the class
    // cooldown test above.
    // Scan the WHOLE brain corpus (decide.py + decide_base.py + every
    // decide_selectors/*.py) — the scout_orch handler lives in
    // decide_selectors/scout.py, so reading decide.py alone would pass vacuously.
    const hits = categoryCooldownHits(readBrainSource().files);
    assert.deepEqual(
      hits,
      [],
      `the decision brain now references a category-cooldown constant; the TS-only invariant assumed by\n` +
        `this test is broken. Either:\n` +
        `  (a) make it a shared config (option 1 in issue #533) and update this test to assert\n` +
        `      both sources load the same value, OR\n` +
        `  (b) intentionally diverge — in which case update this test's comment to explain why.\n` +
        `Hits: ${JSON.stringify(hits)}`,
    );

    // Pin the current TS value so a silent bump in `CATEGORY_COOLDOWN_DAYS`
    // forces the author to consider whether Python needs a mirror.
    assert.equal(
      CATEGORY_COOLDOWN_DAYS,
      30,
      `CATEGORY_COOLDOWN_DAYS changed (was 30, now ${CATEGORY_COOLDOWN_DAYS}). Update this pin AND\n` +
        `re-check whether decide.py needs a matching mirror (issue #533).`,
    );
  });

  test("category-cooldown mirror scan goes red on a mirror planted in a decide_selectors module", () => {
    const real = readBrainSource().files;
    assert.deepEqual(categoryCooldownHits(real), [], "baseline corpus must be clean");
    const planted: BrainSourceFile = {
      path: `${BRAIN_SELECTORS_DIR}/scout.py`,
      text: "CATEGORY_COOLDOWN_DAYS = 30\n",
    };
    const hits = categoryCooldownHits([...real, planted]);
    assert.equal(hits.length, 1);
    assert.match(hits[0], /decide_selectors\/scout\.py/);
    // a mention that is only in a comment / docstring must NOT trip it
    const benign: BrainSourceFile = {
      path: `${BRAIN_SELECTORS_DIR}/scout.py`,
      text: '"""CATEGORY_COOLDOWN docs"""\n# category_cooldown note\nx = 1\n',
    };
    assert.deepEqual(categoryCooldownHits([benign]), []);
  });
});
