/**
 * Regression tests for the gh-label DELETE-collection guard (issue #4654).
 *
 * Failure mode being prevented: an agent removing ONE label reaches for
 *   gh api repos/gaberoo322/hydra/issues/<n>/labels -X DELETE -f name=<label>
 * which hits the GitHub REST *collection* endpoint
 * (`DELETE /issues/{n}/labels`) — that removes EVERY label on the issue,
 * silently (exit 0). The single-label form puts the name in the URL PATH:
 * `DELETE /issues/{n}/labels/{name}`. This bit 3 times across 2 dispatch
 * classes (dev_orch on #4632, two qa_orch dispatches on #4349/#4354),
 * wiping routing labels like `glm-ab-control` / `design-concept-exempt`.
 *
 * The guard is a PreToolUse hook (`scripts/claude-hooks/
 * gh-label-delete-guard.sh`) that denies any Bash tool call whose command
 * text carries, in a single shell segment, BOTH a DELETE HTTP method and a
 * reference to `issues/<n>/labels` with no trailing `/<name>` path segment.
 *
 * What each test pins (design-concept invariants INV-1..INV-3 for
 * issue-4654, artifact hash f62001c6994b...):
 *
 *   - the exact #4632 transcript call is DENIED (`-X DELETE`).
 *   - `--method DELETE` / `--method=DELETE` / `-XDELETE` are all DENIED.
 *   - the raw `curl` form is DENIED (the rule matches command text, not the
 *     binary).
 *   - the single-label PATH form is ALLOWED — literal, `$VAR`, `${VAR}`.
 *   - GET/POST on the collection endpoint is ALLOWED.
 *   - `gh issue edit --remove-label` (the sanctioned path) is ALLOWED.
 *   - a repo-level `repos/o/r/labels/<name>` delete is ALLOWED.
 *   - a chained path-form-delete `&&` collection-GET is ALLOWED (segment-wise
 *     evaluation, not a whole-command substring match).
 *   - a comment/echo merely mentioning DELETE + the collection URL (no real
 *     invocation) is ALLOWED.
 *   - a non-Bash tool_name, missing command, or malformed JSON stdin all
 *     fail OPEN (exit 0) — the guard must never wedge an unrelated call.
 *   - the deny payload shape matches the harness contract (stderr JSON with
 *     hookSpecificOutput.permissionDecision == "deny") and names the
 *     corrected forms + issue #4654.
 *
 * The hook is pure shell + python (no Node), so we exercise it by spawning
 * it as a subprocess and feeding stdin — mirroring
 * test/worktree-write-fence.test.mts.
 */

import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const HOOK = resolve(REPO_ROOT, "scripts/claude-hooks/gh-label-delete-guard.sh");

function runHook(payload: unknown, raw?: string): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const input = raw !== undefined ? raw : JSON.stringify(payload);
  const r = spawnSync("bash", [HOOK], {
    input,
    encoding: "utf8",
  });
  return {
    status: r.status,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
  };
}

function bash(command: string) {
  return { tool_name: "Bash", tool_input: { command } };
}

describe("gh-label-delete-guard — denies the collection-endpoint wipe", () => {
  test("the exact #4632 transcript call is DENIED", () => {
    const r = runHook(
      bash(
        'gh api repos/gaberoo322/hydra/issues/4632/labels -X DELETE -f name="in-progress"',
      ),
    );
    assert.equal(r.status, 2, `expected deny, got ${r.status}; stderr=${r.stderr}`);
    assert.match(r.stderr, /#4632/);
    assert.match(r.stderr, /#4654/);
  });

  test("--method DELETE is DENIED", () => {
    const r = runHook(
      bash("gh api --method DELETE repos/gaberoo322/hydra/issues/10/labels -f name=foo"),
    );
    assert.equal(r.status, 2);
  });

  test("--method=DELETE is DENIED", () => {
    const r = runHook(
      bash("gh api --method=DELETE repos/gaberoo322/hydra/issues/10/labels"),
    );
    assert.equal(r.status, 2);
  });

  test("-XDELETE (no space) is DENIED", () => {
    const r = runHook(bash("gh api -XDELETE repos/gaberoo322/hydra/issues/10/labels"));
    assert.equal(r.status, 2);
  });

  test("raw curl DELETE against the collection URL is DENIED", () => {
    const r = runHook(
      bash("curl -X DELETE https://api.github.com/repos/o/r/issues/10/labels"),
    );
    assert.equal(r.status, 2, "the rule matches command text, not the binary");
  });

  test("a bare trailing slash ('/labels/') is still the collection endpoint — DENIED", () => {
    const r = runHook(bash("gh api repos/o/r/issues/10/labels/ -X DELETE"));
    assert.equal(r.status, 2);
  });

  test("curl's --request DELETE long form is DENIED (QA-4698 false negative)", () => {
    const r = runHook(
      bash(
        "curl --request DELETE https://api.github.com/repos/o/r/issues/4632/labels",
      ),
    );
    assert.equal(
      r.status,
      2,
      `expected deny, got ${r.status}; stderr=${r.stderr} — curl has no --method flag, only --request`,
    );
  });

  test("curl's --request=DELETE long form is DENIED", () => {
    const r = runHook(
      bash(
        "curl --request=DELETE https://api.github.com/repos/o/r/issues/4632/labels",
      ),
    );
    assert.equal(r.status, 2);
  });

  test("a backslash line-continued gh api ... -X DELETE call is DENIED (QA-4698 false negative)", () => {
    const r = runHook(
      bash(
        'gh api repos/gaberoo322/hydra/issues/4632/labels \\\n  -X DELETE -f name="in-progress"',
      ),
    );
    assert.equal(
      r.status,
      2,
      `expected deny, got ${r.status}; stderr=${r.stderr} — a backslash line-continuation must collapse to a space before segment-splitting, not act as its own segment separator`,
    );
    assert.match(r.stderr, /#4632/);
  });

  test("a $VAR indirection ('URL=...; gh api \"$URL\" -X DELETE') is DENIED (QA-4698 2nd re-review)", () => {
    const r = runHook(
      bash(
        'URL="repos/gaberoo322/hydra/issues/42/labels"; gh api -X DELETE "$URL"',
      ),
    );
    assert.equal(
      r.status,
      2,
      `expected deny, got ${r.status}; stderr=${r.stderr} — assigning the collection URL to a variable in an earlier statement must not defeat the guard`,
    );
    assert.match(r.stderr, /#42/);
  });

  test("a $L indirection ('L=labels; gh api issues/42/$L -X DELETE') is DENIED (QA-4698 2nd re-review)", () => {
    const r = runHook(
      bash("L=labels; gh api repos/gaberoo322/hydra/issues/42/$L -X DELETE"),
    );
    assert.equal(
      r.status,
      2,
      `expected deny, got ${r.status}; stderr=${r.stderr} — assigning the literal 'labels' path segment to a variable must not defeat the guard`,
    );
    assert.match(r.stderr, /#42/);
  });

  test("a quoted ';' inside a data flag ('-d \\'note=a;b\\'') no longer defeats the segment split (QA-4698 2nd re-review)", () => {
    const r = runHook(
      bash(
        "curl -s -X DELETE -d 'note=a;b' https://api.github.com/repos/gaberoo322/hydra/issues/42/labels",
      ),
    );
    assert.equal(
      r.status,
      2,
      `expected deny, got ${r.status}; stderr=${r.stderr} — a semicolon quoted inside a -d value is not a real shell separator`,
    );
  });

  test("a quoted '|' inside a data flag ('-d \\'note=a|b\\'') no longer defeats the segment split (QA-4698 2nd re-review)", () => {
    const r = runHook(
      bash(
        "curl -s -X DELETE -d 'note=a|b' https://api.github.com/repos/gaberoo322/hydra/issues/42/labels",
      ),
    );
    assert.equal(
      r.status,
      2,
      `expected deny, got ${r.status}; stderr=${r.stderr} — a pipe quoted inside a -d value is not a real shell separator`,
    );
  });

  test("an 'export'-prefixed $VAR indirection is DENIED (QA-4698 3rd re-review)", () => {
    const r = runHook(
      bash(
        'export URL="repos/gaberoo322/hydra/issues/42/labels"; gh api -X DELETE "$URL"',
      ),
    );
    assert.equal(
      r.status,
      2,
      `expected deny, got ${r.status}; stderr=${r.stderr} — an 'export ' prefix on the assignment must not defeat variable resolution`,
    );
    assert.match(r.stderr, /#42/);
  });

  test("a two-hop chained-variable indirection ('BASE=...; URL=\"$BASE/labels\"') is DENIED (QA-4698 3rd re-review)", () => {
    const r = runHook(
      bash(
        'BASE="repos/gaberoo322/hydra/issues/42"; URL="$BASE/labels"; gh api -X DELETE "$URL"',
      ),
    );
    assert.equal(
      r.status,
      2,
      `expected deny, got ${r.status}; stderr=${r.stderr} — a variable assigned from another variable's value must resolve transitively, not just one hop`,
    );
    assert.match(r.stderr, /#42/);
  });
});

describe("gh-label-delete-guard — allows the sanctioned forms", () => {
  test("the single-label PATH form (literal name) is ALLOWED", () => {
    const r = runHook(
      bash("gh api repos/gaberoo322/hydra/issues/10/labels/in-progress -X DELETE"),
    );
    assert.equal(r.status, 0, `expected allow, got ${r.status}; stderr=${r.stderr}`);
  });

  test("the single-label PATH form with a $VAR name is ALLOWED", () => {
    const r = runHook(bash("gh api repos/o/r/issues/10/labels/$L -X DELETE"));
    assert.equal(r.status, 0);
  });

  test("the single-label PATH form with a ${VAR} name is ALLOWED", () => {
    const r = runHook(bash("gh api repos/o/r/issues/10/labels/${LABEL} -X DELETE"));
    assert.equal(r.status, 0);
  });

  test("GET on the collection endpoint is ALLOWED", () => {
    const r = runHook(bash("gh api repos/o/r/issues/10/labels"));
    assert.equal(r.status, 0);
  });

  test("POST on the collection endpoint is ALLOWED", () => {
    const r = runHook(bash("gh api repos/o/r/issues/10/labels -X POST -f labels[]=foo"));
    assert.equal(r.status, 0);
  });

  test("the sanctioned `gh issue edit --remove-label` path is ALLOWED", () => {
    const r = runHook(
      bash("gh issue edit 10 --repo gaberoo322/hydra --remove-label foo"),
    );
    assert.equal(r.status, 0);
  });

  test("a repo-level label delete (`repos/o/r/labels/<name>`) is ALLOWED", () => {
    const r = runHook(bash("gh api repos/o/r/labels/foo -X DELETE"));
    assert.equal(r.status, 0);
  });

  test("a chained path-form delete followed by a collection GET is ALLOWED (segment-wise)", () => {
    const r = runHook(
      bash(
        "gh api repos/o/r/issues/10/labels/x -X DELETE && gh api repos/o/r/issues/10/labels",
      ),
    );
    assert.equal(
      r.status,
      0,
      "each shell segment must be evaluated independently, not the whole command as one string",
    );
  });

  test("a bare-newline-joined path-form delete followed by a collection GET is ALLOWED (QA-4698 3rd re-review)", () => {
    const r = runHook(
      bash(
        "gh api repos/o/r/issues/10/labels/x -X DELETE\ngh api repos/o/r/issues/10/labels",
      ),
    );
    assert.equal(
      r.status,
      0,
      `expected allow, got ${r.status}; stderr=${r.stderr} — a plain newline between two ` +
        "statements (no &&/;) must split segments the same way as an explicit separator, so " +
        "the sanctioned single-label DELETE on line 1 doesn't falsely co-occur with the benign " +
        "collection GET on line 2",
    );
  });

  test("a comment merely mentioning DELETE + the collection URL is ALLOWED", () => {
    const r = runHook(bash('echo "DELETE issues/10/labels is dangerous"'));
    assert.equal(r.status, 0);
  });
});

describe("gh-label-delete-guard — fail-open cases", () => {
  test("a non-Bash tool_name is ALLOWED (fail open)", () => {
    const r = runHook({ tool_name: "Read", tool_input: { file_path: "x" } });
    assert.equal(r.status, 0);
  });

  test("a missing tool_input.command is ALLOWED (fail open)", () => {
    const r = runHook({ tool_name: "Bash", tool_input: {} });
    assert.equal(r.status, 0);
  });

  test("malformed JSON stdin is ALLOWED (fail open)", () => {
    const r = runHook(undefined, "not json{{{");
    assert.equal(r.status, 0);
  });

  test("empty stdin is ALLOWED (fail open)", () => {
    const r = runHook(undefined, "");
    assert.equal(r.status, 0);
  });

  test("a command with unbalanced quotes is ALLOWED (fail open — can't safely tokenize)", () => {
    const r = runHook(
      bash("gh api repos/o/r/issues/10/labels -X DELETE 'unterminated"),
    );
    assert.equal(r.status, 0, `expected allow, got ${r.status}; stderr=${r.stderr}`);
  });
});

describe("gh-label-delete-guard — deny payload shape", () => {
  test("deny payload matches the harness contract and names the corrected forms", () => {
    const r = runHook(
      bash("gh api repos/gaberoo322/hydra/issues/4632/labels -X DELETE -f name=in-progress"),
    );
    assert.equal(r.status, 2);

    const lines = r.stderr.trim().split("\n");
    assert.ok(lines.length >= 2, `expected reason line + JSON line, got: ${r.stderr}`);

    const jsonLine = lines[lines.length - 1];
    const parsed = JSON.parse(jsonLine);
    assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
    assert.match(
      parsed.hookSpecificOutput.permissionDecisionReason,
      /gh issue edit 4632 --repo gaberoo322\/hydra --remove-label/,
      "deny reason must name the sanctioned gh issue edit form for the same issue number",
    );
    assert.match(
      parsed.hookSpecificOutput.permissionDecisionReason,
      /issues\/4632\/labels\/<name>/,
      "deny reason must also name the single-label REST path form",
    );
  });
});

describe("gh-label-delete-guard — issue #4728 binding forms", () => {
  // PR #4698's round-4 QA found these ordinary binding forms let a
  // collection DELETE through as ALLOW, because LEADING_ASSIGN recognised
  // only bare and export-prefixed NAME=value. One DENY regression per newly
  // recognised form, plus the ALLOW counter-tests: every DENY below was an
  // ALLOW before this change. All forms feed the ONE assigned table — the
  // chain test proves two different forms resolve through the same
  // fixed-point pass.
  const COLLECTION_URL = "repos/gaberoo322/hydra/issues/42/labels";

  test("a declare-prefixed binding feeding a collection DELETE is DENIED (#4728)", () => {
    const r = runHook(
      bash(`declare URL="${COLLECTION_URL}"; gh api -X DELETE "$URL"`),
    );
    assert.equal(
      r.status,
      2,
      `expected deny, got ${r.status}; stderr=${r.stderr} — a declare-prefixed assignment must not defeat variable resolution`,
    );
    assert.match(r.stderr, /#42/);
  });

  test("a declare -x (export flag) binding feeding a collection DELETE is DENIED (#4728)", () => {
    const r = runHook(
      bash(`declare -x URL="${COLLECTION_URL}"; gh api -X DELETE "$URL"`),
    );
    assert.equal(
      r.status,
      2,
      `expected deny, got ${r.status}; stderr=${r.stderr} — declaration keywords with flags must still bind`,
    );
    assert.match(r.stderr, /#42/);
  });

  test("a readonly binding feeding a collection DELETE is DENIED (#4728)", () => {
    const r = runHook(
      bash(`readonly URL="${COLLECTION_URL}"; gh api -X DELETE "$URL"`),
    );
    assert.equal(
      r.status,
      2,
      `expected deny, got ${r.status}; stderr=${r.stderr} — a readonly assignment must not defeat variable resolution`,
    );
    assert.match(r.stderr, /#42/);
  });

  test("a typeset binding feeding a collection DELETE is DENIED (#4728)", () => {
    const r = runHook(
      bash(`typeset URL="${COLLECTION_URL}"; gh api -X DELETE "$URL"`),
    );
    assert.equal(
      r.status,
      2,
      `expected deny, got ${r.status}; stderr=${r.stderr} — a typeset assignment must not defeat variable resolution`,
    );
    assert.match(r.stderr, /#42/);
  });

  test("a local binding in a one-line function body feeds a collection DELETE and is DENIED (#4728)", () => {
    const r = runHook(
      bash(
        `wipe() { local URL="${COLLECTION_URL}"; gh api -X DELETE "$URL"; }`,
      ),
    );
    assert.equal(
      r.status,
      2,
      `expected deny, got ${r.status}; stderr=${r.stderr} — a local assignment right after a function-body opener must bind`,
    );
    assert.match(r.stderr, /#42/);
  });

  test("a local binding in a multi-line function body feeds a collection DELETE and is DENIED (#4728)", () => {
    const r = runHook(
      bash(
        `wipe() {\n  local URL="${COLLECTION_URL}"\n  gh api -X DELETE "$URL"\n}`,
      ),
    );
    assert.equal(
      r.status,
      2,
      `expected deny, got ${r.status}; stderr=${r.stderr} — a local assignment on its own line inside a function body must bind`,
    );
    assert.match(r.stderr, /#42/);
  });

  test("a local binding inside a brace-group opener feeds a collection DELETE and is DENIED (#4728)", () => {
    const r = runHook(
      bash(`{ local URL="${COLLECTION_URL}"; gh api -X DELETE "$URL"; }`),
    );
    assert.equal(
      r.status,
      2,
      `expected deny, got ${r.status}; stderr=${r.stderr} — a local assignment right after a brace-group opener must bind`,
    );
    assert.match(r.stderr, /#42/);
  });

  test("a local binding inside a subshell opener feeds a collection DELETE and is DENIED (#4728)", () => {
    const r = runHook(
      bash(`( local URL="${COLLECTION_URL}"; gh api -X DELETE "$URL" )`),
    );
    assert.equal(
      r.status,
      2,
      `expected deny, got ${r.status}; stderr=${r.stderr} — a local assignment right after a subshell opener must bind`,
    );
    assert.match(r.stderr, /#42/);
  });

  test("a printf -v binding feeding a collection DELETE is DENIED (#4728)", () => {
    const r = runHook(
      bash(`printf -v URL '${COLLECTION_URL}'; gh api -X DELETE "$URL"`),
    );
    assert.equal(
      r.status,
      2,
      `expected deny, got ${r.status}; stderr=${r.stderr} — a printf -v binding must not defeat variable resolution`,
    );
    assert.match(r.stderr, /#42/);
  });

  test("a printf -v '%s' <path> binding feeding a collection DELETE is DENIED (#4728)", () => {
    const r = runHook(
      bash(`printf -v URL '%s' '${COLLECTION_URL}'; gh api -X DELETE "$URL"`),
    );
    assert.equal(
      r.status,
      2,
      `expected deny, got ${r.status}; stderr=${r.stderr} — an exact %s format must bind its first argument`,
    );
    assert.match(r.stderr, /#42/);
  });

  test("a read -r here-string binding feeding a collection DELETE is DENIED (#4728)", () => {
    const r = runHook(
      bash(`read -r URL <<< "${COLLECTION_URL}"; gh api -X DELETE "$URL"`),
    );
    assert.equal(
      r.status,
      2,
      `expected deny, got ${r.status}; stderr=${r.stderr} — a read here-string binding must not defeat variable resolution`,
    );
    assert.match(r.stderr, /#42/);
  });

  test("set -- positional args resolved into a collection DELETE are DENIED (#4728)", () => {
    const r = runHook(
      bash(`set -- ${COLLECTION_URL}; gh api -X DELETE "$1"`),
    );
    assert.equal(
      r.status,
      2,
      `expected deny, got ${r.status}; stderr=${r.stderr} — a positional parameter set via set -- must resolve like any other variable`,
    );
    assert.match(r.stderr, /#42/);
  });

  test("bindings from different forms share one resolution table — read feeds local which feeds the URL — DENIED (#4728)", () => {
    const r = runHook(
      bash(
        `read -r L <<< "labels"; local URL="repos/gaberoo322/hydra/issues/42/$L"; gh api -X DELETE "$URL"`,
      ),
    );
    assert.equal(
      r.status,
      2,
      `expected deny, got ${r.status}; stderr=${r.stderr} — every binding form must feed the SAME assigned table and fixed-point resolution, not a per-form path`,
    );
    assert.match(r.stderr, /#42/);
  });

  test("a local binding holding the single-label PATH form is ALLOWED (#4728)", () => {
    const r = runHook(
      bash(
        `local URL="repos/o/r/issues/10/labels/keep"; gh api -X DELETE "$URL"`,
      ),
    );
    assert.equal(
      r.status,
      0,
      `expected allow, got ${r.status}; stderr=${r.stderr} — recognising local must not break the sanctioned single-label path form`,
    );
  });

  test("a keyword appearing mid-statement (echo local URL=...) creates no binding — ALLOWED (#4728)", () => {
    const r = runHook(
      bash(
        `echo local URL="repos/o/r/issues/42/labels"; gh api -X DELETE "$URL"`,
      ),
    );
    assert.equal(
      r.status,
      0,
      `expected allow, got ${r.status}; stderr=${r.stderr} — in real bash the echo line assigns nothing, so $URL stays unset in the DELETE; recognition is anchored at statement start and must not create a binding here`,
    );
  });

  test("declaration keywords with no = assignment create no binding and no error — ALLOWED (#4728)", () => {
    const r = runHook(
      bash(`declare -p URL; readonly LABELS; local n; gh api -X DELETE "$URL"`),
    );
    assert.equal(
      r.status,
      0,
      `expected allow, got ${r.status}; stderr=${r.stderr} — a keyword with no = assignment must be a no-op, not an error and not a binding`,
    );
  });

  test("a command-substitution value is not captured (literal values only) — ALLOWED (#4728)", () => {
    const r = runHook(
      bash(
        `SUB="$(echo repos/o/r/issues/42/labels)"; gh api -X DELETE "$SUB"`,
      ),
    );
    assert.equal(
      r.status,
      0,
      `expected allow, got ${r.status}; stderr=${r.stderr} — command substitution is not evaluated and its raw text is never substituted into the command`,
    );
  });

  test("an array (...) value is not captured (literal values only) — ALLOWED (#4728)", () => {
    // The space before the ';' is deliberate: shlex's punctuation_chars mode
    // glues CONSECUTIVE punctuation into one token, so a bare `);` becomes
    // the single token ');' — not a recognised separator — and the two
    // statements merge into one segment, where the array literal's own text
    // (not any binding) co-occurs with the DELETE flag and DENYs. That
    // pre-existing _segments artifact is out of scope for this PR (the issue
    // pins the segment splitter as sound); the space keeps the ';' a lone
    // token so THIS test pins the actual invariant: the array value binds
    // nothing and $URL stays unresolved.
    const r = runHook(
      bash(`declare URL=(${COLLECTION_URL}) ; gh api -X DELETE "$URL"`),
    );
    assert.equal(
      r.status,
      0,
      `expected allow, got ${r.status}; stderr=${r.stderr} — array values are out of scope for the literal-only resolution pass (issue #4728 INV-5)`,
    );
  });

  // Issue #4877 — `$@`/`$*` resolve through the same `assigned` table.
  const SINGLE_URL = "repos/gaberoo322/hydra/issues/42/labels/keep";
  for (const ref of ['"$@"', "$@", '"$*"', "$*", "${@}", "${*}"]) {
    test(`set -- collection URL then DELETE ${ref} is DENIED (#4877)`, () => {
      const r = runHook(
        bash(`set -- ${COLLECTION_URL}; gh api -X DELETE ${ref}`),
      );
      assert.equal(r.status, 2, `expected deny, got ${r.status}; stderr=${r.stderr}`);
    });
  }

  test("a later set -- replaces the first: collection then path is ALLOWED (#4877)", () => {
    for (const ref of ['"$1"', '"$@"']) {
      const r = runHook(
        bash(
          `set -- ${COLLECTION_URL}; set -- ${SINGLE_URL}; gh api -X DELETE ${ref}`,
        ),
      );
      assert.equal(r.status, 0, `${ref}: expected allow, got ${r.status}; stderr=${r.stderr}`);
    }
  });

  test("a later set -- replaces the first: path then collection is DENIED (#4877)", () => {
    for (const ref of ['"$1"', '"$@"']) {
      const r = runHook(
        bash(
          `set -- ${SINGLE_URL}; set -- ${COLLECTION_URL}; gh api -X DELETE ${ref}`,
        ),
      );
      assert.equal(r.status, 2, `${ref}: expected deny, got ${r.status}; stderr=${r.stderr}`);
    }
  });

  test("an unresolved $@ with no preceding set -- binds nothing — ALLOWED (#4877)", () => {
    const r = runHook(bash(`gh api -X DELETE "$@"`));
    assert.equal(r.status, 0, `expected allow, got ${r.status}; stderr=${r.stderr}`);
  });

  test("a bare set -- clears earlier $@ / $1 bindings — ALLOWED (#4877)", () => {
    for (const ref of ['"$@"', '"$*"', '"$1"']) {
      const r = runHook(
        bash(`set -- ${COLLECTION_URL}; set --; gh api -X DELETE ${ref}`),
      );
      assert.equal(r.status, 0, `${ref}: expected allow, got ${r.status}; stderr=${r.stderr}`);
    }
  });

  test("a non-literal set -- word binds nothing — ALLOWED (#4877)", () => {
    for (const args of ['"$(echo x)/labels"', "`echo x`"]) {
      const r = runHook(bash(`set -- ${args}; gh api -X DELETE "$@"`));
      assert.equal(r.status, 0, `${args}: expected allow, got ${r.status}; stderr=${r.stderr}`);
    }
  });

  test("an unbalanced-quote set -- binds nothing and fails open — ALLOWED (#4877)", () => {
    const r = runHook(bash(`set -- "${COLLECTION_URL}; gh api -X DELETE "$@"`));
    assert.equal(r.status, 0, `expected allow, got ${r.status}; stderr=${r.stderr}`);
  });

  test("printf -v with a non-%s format binds nothing — ALLOWED (#4877)", () => {
    const r = runHook(
      bash(
        `printf -v URL '%s/labels' repos/o/r/issues/42; gh api -X DELETE "$URL"`,
      ),
    );
    assert.equal(r.status, 0, `expected allow, got ${r.status}; stderr=${r.stderr}`);
  });

  test("a function-name opener with local binding feeding a collection DELETE is DENIED (#4877)", () => {
    const r = runHook(
      bash(
        `function w { local URL="${COLLECTION_URL}"; gh api -X DELETE "$URL"; }`,
      ),
    );
    assert.equal(r.status, 2, `expected deny, got ${r.status}; stderr=${r.stderr}`);
  });

  test("typeset/readonly with no = do not mask a literal collection DELETE (#4877)", () => {
    for (const kw of ["typeset URL", "readonly URL"]) {
      const r = runHook(
        bash(`${kw}; gh api -X DELETE ${COLLECTION_URL}`),
      );
      assert.equal(r.status, 2, `${kw}: expected deny, got ${r.status}; stderr=${r.stderr}`);
    }
  });
});

describe("gh-label-delete-guard — performance", () => {
  test("typical invocation: median of 5 runs completes in under 1000ms", () => {
    // PreToolUse hooks run synchronously and stall every tool call. Typical
    // cost is tens of ms (a python shell-out per parse field). The ceiling is
    // deliberately generous and uses a MEDIAN of 5 runs: one cold or loaded
    // sample (CI load ~45 pushed a single run past 250ms, #4740/#4742) must
    // not fail the suite, while a real regression (network/git/Redis IO in
    // the hook) costs seconds and still does.
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = Date.now();
      const r = runHook(bash("gh api repos/o/r/issues/10/labels"));
      samples.push(Date.now() - start);
      assert.equal(r.status, 0);
    }
    samples.sort((a, b) => a - b);
    const median = samples[2];
    assert.ok(
      median < 1000,
      `guard median ${median}ms (samples ${samples.join(",")}) — too slow for a per-tool-call hook`,
    );
  });
});

describe("gh-label-delete-guard — fail closed on internal error (#4745)", () => {
  // Built by concatenation so the live guard never sees the literal method word.
  const METHOD_WORD = "DEL" + "ETE";
  const SUSPECT_CMD = `gh api repos/o/r/issues/42/labels -X ${METHOD_WORD} -f name=x`;
  let dir: string;
  let realPython: string;

  function runWithShim(command: string) {
    const r = spawnSync("bash", [HOOK], {
      input: JSON.stringify(bash(command)),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
    return { status: r.status, stderr: r.stderr || "" };
  }

  function installShim(body: string) {
    writeFileSync(join(dir, "python3"), body, { mode: 0o755 });
  }

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "label-guard-shim-"));
    realPython = spawnSync("bash", ["-c", "command -v python3"], {
      encoding: "utf8",
    }).stdout.trim();
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("a >1MiB multi-line verdict still exits 2 (no SIGPIPE 141)", () => {
    installShim(
      [
        "#!/bin/bash",
        'if [ "$1" = "-" ]; then',
        "  printf 'DENY\\n42\\n'",
        "  head -c 1200000 /dev/zero | tr '\\0' 'x' | fold -w 80",
        "  exit 0",
        "fi",
        `exec "${realPython}" "$@"`,
        "",
      ].join("\n"),
    );
    const r = runWithShim(SUSPECT_CMD);
    assert.equal(r.status, 2, `stderr=${r.stderr.slice(0, 500)}`);
    assert.match(r.stderr, /#42/);
  });

  test("an always-failing python3 blocks a labels-collection DELETE but allows ls", () => {
    installShim("#!/bin/bash\nexit 1\n");
    const blocked = runWithShim(SUSPECT_CMD);
    assert.equal(blocked.status, 2);
    assert.match(blocked.stderr, /internal error/);
    assert.match(blocked.stderr, /failing closed/);
    assert.equal(runWithShim("ls").status, 0);
  });

  test("a garbled (non ALLOW/DENY) verdict on a suspect command fails closed", () => {
    installShim(
      `#!/bin/bash\nif [ "$1" = "-" ]; then echo garbage; exit 0; fi\nexec "${realPython}" "$@"\n`,
    );
    assert.equal(runWithShim(SUSPECT_CMD).status, 2);
    assert.equal(runWithShim("ls").status, 0);
  });
});
