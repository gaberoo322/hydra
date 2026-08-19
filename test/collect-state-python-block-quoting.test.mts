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
  const NEEDLE = 'python3 -c "';
  const out: { index: number; line: number; next: string }[] = [];
  let i = 0;
  while (true) {
    const idx = src.indexOf(NEEDLE, i);
    if (idx === -1) break;
    const start = idx + NEEDLE.length;
    out.push({
      index: idx,
      line: src.slice(0, idx).split("\n").length,
      next: src.slice(start, start + 2),
    });
    i = start;
  }
  return out;
}

describe("collect-state.sh — python3 -c block quoting (issue #4042)", () => {
  test("the script actually uses python3 -c somewhere (guard is not vacuous)", () => {
    const occurrences = pythonDashCOccurrences();
    assert.ok(
      occurrences.length > 0,
      "expected at least one `python3 -c \"` invocation in collect-state.sh — if python3 usage was removed entirely, update or delete this guard",
    );
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
    let count = 0;
    while ((m = re.exec(src)) !== null) {
      count++;
      const line = src.slice(0, m.index).split("\n").length;
      assert.equal(
        m[1],
        "'",
        `collect-state.sh:${line} — the heredoc delimiter after `+
          "\`$(cat <<\` must be single-quoted (e.g. <<'PY') to suppress all shell " +
          "expansion of the Python source; found an unquoted or double-quoted delimiter instead.",
      );
    }
    assert.ok(count > 0, "expected to find at least one `python3 -c \"$(cat <<` wrapper");
  });

  test("the previously-vulnerable Target-board reducer's backticked comments are present and now inert (regression pin)", () => {
    // The four `command not found` lines observed live all originated from
    // this one block's comments. Confirm the backticked tokens are still
    // there (so this test would catch a regression if the comments were
    // rewritten to no longer exercise the fix) AND that they sit inside the
    // single-quoted-heredoc form, not a bare double-quoted `python3 -c "`.
    // Post-#4130 the gh read routes through `_gh_capture target gh issue list
    // ...` and the variable is assigned from $GH_CAPTURE_OUT, so the anchor is
    // the assignment itself rather than the retired `$(gh issue list` form.
    const marker = 'TARGET_BOARD_ISSUES_JSON="$GH_CAPTURE_OUT"';
    const blockStart = src.indexOf(marker);
    assert.ok(blockStart >= 0, "could not locate the Target-board reducer invocation");
    const pythonInvoke = src.indexOf('python3 -c "', blockStart);
    assert.ok(pythonInvoke >= 0, "could not locate the Target-board reducer's python3 -c invocation");
    assert.equal(
      src.slice(pythonInvoke + 'python3 -c "'.length, pythonInvoke + 'python3 -c "'.length + 2),
      "$(",
      "the Target-board reducer must use the safe $(cat <<'PY' ... PY) wrapper",
    );
    const blockEnd = src.indexOf("\nPY\n)", pythonInvoke);
    assert.ok(blockEnd >= 0, "could not locate the Target-board reducer's heredoc terminator");
    const body = src.slice(pythonInvoke, blockEnd);
    assert.match(
      body,
      /`wire-or-retire`/,
      "expected the historically-vulnerable backticked `wire-or-retire` comment token to still be present",
    );
    assert.match(
      body,
      /`bug`/,
      "expected the historically-vulnerable backticked `bug` comment token to still be present",
    );
  });
});
