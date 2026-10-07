/**
 * Ratchet: `scripts/autopilot/collect-state.sh` may not gain inline Python
 * heredocs (ADR-0043 Decision 6).
 *
 * WHY. ADR-0043 strangles collect-state.sh into the typed Turn Snapshot module
 * (`src/autopilot/turn-snapshot/`), one collector per slice. A new signal is
 * written as a TS collector, even beside a still-bash one. Without a guard, a
 * new `python3 <<'PY'` heredoc is the path of least resistance and the
 * migration regresses while it is in flight.
 *
 * HOW IT SHRINKS. CEILING is shrink-only. A slice that deletes heredocs lowers
 * it to the new count in the same PR; raising it is not an escape hatch. The
 * initial 37 is master's 35 plus the two heredocs PR #4860 (#4812) adds, which
 * predates the ADR. Slice 1 ports that collector and removes them.
 *
 * WHY A TEST RATHER THAN A CI WORKFLOW. Only checks inside the required `test`
 * job can block a merge, and a workflow edit would land in the Verifier Core.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SCRIPT = resolve(import.meta.dirname, "../scripts/autopilot/collect-state.sh");

/** Shrink-only. Lower it when a Turn Snapshot slice deletes heredocs. */
const CEILING: number = 37;

/** A python heredoc opener: `<<PY`, `<<'PY'` or `<<"PY"`. */
const HEREDOC = /<<\s*['"]?PY['"]?/g;

function countPythonHeredocs(source: string): number {
  return source.match(HEREDOC)?.length ?? 0;
}

describe("collect-state.sh python-heredoc ratchet (ADR-0043 Decision 6)", () => {
  test("the counter recognises every quoting form (guards a vacuous pass)", () => {
    assert.equal(countPythonHeredocs(`a <<PY\nb <<'PY'\nc <<"PY"\nd << 'PY'\n`), 4);
    assert.equal(countPythonHeredocs("python3 scripts/autopilot/pr-refs.py --closing\n"), 0);
  });

  test("the heredoc count does not exceed the ceiling", () => {
    const count = countPythonHeredocs(readFileSync(SCRIPT, "utf8"));
    assert.ok(count > 0 || CEILING === 0, "collect-state.sh parsed to zero heredocs: lower CEILING to 0 or check the path");
    assert.ok(
      count <= CEILING,
      `collect-state.sh has ${count} python heredocs; the ceiling is ${CEILING}.\n` +
        `ADR-0043 Decision 6: a new signal is a Turn Snapshot collector in src/autopilot/turn-snapshot/, ` +
        `not a new heredoc. Move the logic into TS instead of raising CEILING.`,
    );
  });
});
