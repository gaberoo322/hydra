/**
 * Regression guard for issue #4042 — `scripts/autopilot/collect-state.sh`
 * used to run its Python reducers as `python3 -c "<source>"` inside a
 * DOUBLE-quoted shell string. The shell performs command/backtick
 * substitution on double-quoted content before python3 ever sees it, so any
 * unescaped backtick span inside a Python *comment* was executed as a shell
 * command. This reproduced live on every Phase 1 autopilot run (2026-08-13,
 * run f1347b80):
 *
 *   scripts/autopilot/collect-state.sh: line 981: wire-or-retire: command not found
 *   scripts/autopilot/collect-state.sh: line 981: wire-or-retire: command not found
 *   scripts/autopilot/collect-state.sh: line 981: wire-or-retire: command not found
 *   scripts/autopilot/collect-state.sh: line 981: bug: command not found
 *
 * Every occurrence today happens to substitute to the empty string (the
 * backticked tokens are not real commands), so the emitted signals were
 * correct by luck, not design — the NEXT comment backticking a real command
 * name (`reset`, `test`, `sweep`) would execute it inside the autopilot's
 * Phase 1, every turn.
 *
 * The fix converts every `python3 -c "..."` invocation in this script to
 * `python3 -c "$(cat <<'PY' ... PY)"` — a single-quoted heredoc captured into
 * a variable and passed as the `-c` argument. The single-quoted delimiter
 * (`<<'PY'`) suppresses ALL `$var` / `$(...)` / backtick expansion of the
 * Python source, and wrapping the heredoc inside `$(...)` (rather than
 * attaching it directly to the `python3` command) keeps stdin routed through
 * the pipeline unchanged — several blocks pipe JSON into python3 via
 * `sys.stdin`, and a heredoc attached directly to `python3` would steal fd 0
 * away from that pipe.
 *
 * This is a grep-shaped guard (the acceptance criterion in #4042), not a full
 * script execution — collect-state.sh is network-dependent (live `gh`,
 * `docker`, the orchestrator HTTP service), so pinning behaviour here means
 * pinning the SOURCE SHAPE, mirroring the existing source-pinning tests in
 * test/autopilot-scripts.test.mts and test/collect-state-inflight-exclusion.test.mts.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "autopilot", "collect-state.sh");
const src = readFileSync(SCRIPT, "utf-8");

/**
 * Every `python3 -c "` occurrence in the file, with the two characters
 * immediately following the opening quote (enough to tell a safe
 * `"$(cat <<'PY'` wrapper apart from a vulnerable literal double-quoted
 * block, which would start with something else — e.g. `"\n` or `"import`).
 */
function pythonDashCOccurrences(): { index: number; line: number; next: string }[] {
  return pythonDashCOccurrencesIn(src);
}

function pythonDashCOccurrencesIn(text: string): { index: number; line: number; next: string }[] {
  const NEEDLE = 'python3 -c "';
  const out: { index: number; line: number; next: string }[] = [];
  let i = 0;
  while (true) {
    const idx = text.indexOf(NEEDLE, i);
    if (idx === -1) break;
    const start = idx + NEEDLE.length;
    out.push({
      index: idx,
      line: text.slice(0, idx).split("\n").length,
      next: text.slice(start, start + 2),
    });
    i = start;
  }
  return out;
}

describe("collect-state.sh — python3 -c block quoting (issue #4042)", () => {
  test("the script carries no python3 -c block at all (ADR-0043: every reducer is a Turn Snapshot collector)", () => {
    // Slice 4 (#4932) moved the last python reducers (the Target board family)
    // into TS, so the count is pinned EXACTLY to 0. The shape checks below
    // stay as the guard for any re-introduced block — which should be a TS
    // collector instead (ADR-0043 Decision 6). The finder itself is exercised
    // by the fixture case that follows, so a 0 here is not a vacuous parse.
    assert.deepEqual(
      pythonDashCOccurrences().map((o) => `line ${o.line}`),
      [],
      "collect-state.sh gained a `python3 -c` block — write a Turn Snapshot collector instead (ADR-0043 Decision 6)",
    );
  });

  test("the finder recognises a python3 -c invocation (guards the 0 above against a vacuous pass)", () => {
    assert.deepEqual(pythonDashCOccurrencesIn('x\ny=$(python3 -c "$(cat <<\'PY\'\nprint(1)\nPY\n)")\n').map((o) => o.next), ["$("]);
  });

  test("every python3 -c invocation wraps its source in a single-quoted heredoc command substitution, never a literal double-quoted block", () => {
    const occurrences = pythonDashCOccurrences();
    for (const occ of occurrences) {
      assert.equal(
        occ.next,
        "$(",
        `collect-state.sh:${occ.line} — \`python3 -c "\` must be immediately followed by \`$(\` ` +
          `(i.e. \`python3 -c "$(cat <<'PY' ... PY)"\`), not literal Python source. Found ` +
          `\`python3 -c "${occ.next}...\` instead — this is the exact double-quoted-inline shape ` +
          "that let a backtick inside a Python comment execute as a shell command (issue #4042).",
      );
    }
  });

  test("every python3 -c wrapper uses a SINGLE-quoted heredoc delimiter (<<'PY'), never an unquoted or double-quoted one", () => {
    // Belt-and-suspenders: a future edit could "fix" the shape check above by
    // switching to `$(cat <<PY ... PY)` (delimiter unquoted) or `$(cat <<"PY" ... PY)`
    // (delimiter double-quoted) — both re-enable $var/$(...)/backtick expansion
    // of the Python source, defeating the fix while still passing the
    // structural check above. Every `python3 -c "$(cat <<` site must pair with
    // a single-quoted delimiter.
    const re = /python3 -c "\$\(cat <<(.)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const line = src.slice(0, m.index).split("\n").length;
      assert.equal(
        m[1],
        "'",
        `collect-state.sh:${line} — the heredoc delimiter after `+
          "\`$(cat <<\` must be single-quoted (e.g. <<'PY') to suppress all shell " +
          "expansion of the Python source; found an unquoted or double-quoted delimiter instead.",
      );
    }
    // No "at least one wrapper" floor: since ADR-0043 slice 4 (#4932) the
    // script has no python3 -c block (pinned to 0 above); this check guards a
    // re-introduction.
  });
});
