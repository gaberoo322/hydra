/**
 * test/lifecycle-seam-check.test.mts — blocking shrink-only ratchet against
 * direct lifecycle state-label writes (ADR-0047 D3/D7, issue #5311).
 *
 * The live describe is the gate (runs in the REQUIRED `test` job). This file
 * does no fs read itself — it calls the script's exported functions.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { OPEN_STATES } = await import("../src/lifecycle/index.ts");
const {
  LIFECYCLE_STATE_NAMES,
  REPO_ROOT,
  checkLifecycleRatchet,
  isExemptPath,
  isSurface,
  loadLifecycleBaseline,
  parseLifecycleBaseline,
  scanFileSites,
  scanLifecycleSeam,
} = await import("../scripts/ci/lifecycle-seam-check.ts");

describe("lifecycle-seam-check: live tree vs committed baseline", () => {
  test("scanner vocabulary is exactly OPEN_STATES", () => {
    assert.deepEqual([...LIFECYCLE_STATE_NAMES], [...OPEN_STATES]);
    assert.equal(LIFECYCLE_STATE_NAMES.includes("closed"), false);
  });

  test("no new direct state-label write sites and the baseline is not stale", async () => {
    const verdict = checkLifecycleRatchet(
      await scanLifecycleSeam(REPO_ROOT),
      await loadLifecycleBaseline(REPO_ROOT),
    );
    assert.deepEqual(verdict.messages, []);
    assert.equal(verdict.ok, true);
  });
});

describe("lifecycle-seam-check: ratchet verdicts", () => {
  const observed = { "docs/operator-playbooks/hydra-x.md": { count: 2, lines: [3, 9] } };

  test("observed above baseline (unlisted = 0) fails naming the file, lines and scripts/lifecycle.ts", () => {
    const v = checkLifecycleRatchet(observed, { files: {} });
    assert.equal(v.ok, false);
    assert.match(v.messages[0]!, /new direct state-label write in docs\/operator-playbooks\/hydra-x\.md/);
    assert.match(v.messages[0]!, /lines 3, 9/);
    assert.match(v.messages[0]!, /scripts\/lifecycle\.ts advance/);
  });

  test("a new site in an already-baselined file still fails (per-file count)", () => {
    const v = checkLifecycleRatchet(observed, { files: { "docs/operator-playbooks/hydra-x.md": 1 } });
    assert.equal(v.ok, false);
    assert.match(v.messages[0]!, /new direct state-label write/);
  });

  test("observed below baseline, or a vanished file, fails with the shrink command", () => {
    const below = checkLifecycleRatchet(observed, { files: { "docs/operator-playbooks/hydra-x.md": 3 } });
    assert.equal(below.ok, false);
    assert.match(below.messages[0]!, /baseline is stale/);
    assert.match(below.messages[0]!, /--shrink-baseline/);
    const gone = checkLifecycleRatchet({}, { files: { "docs/gone.md": 1 } });
    assert.equal(gone.ok, false);
    assert.match(gone.messages[0]!, /baseline is stale/);
  });

  test("an exact match passes with the total", () => {
    const v = checkLifecycleRatchet(observed, { files: { "docs/operator-playbooks/hydra-x.md": 2 } });
    assert.equal(v.ok, true);
    assert.equal(v.total, 2);
  });
});

describe("lifecycle-seam-check: detection grammar (synthetic)", () => {
  const md = (text: string) => scanFileSites("docs/operator-playbooks/hydra-x.md", text);
  const ts = (text: string) => scanFileSites("src/x.ts", text);

  test("state literal after --add-label is a site", () => {
    assert.deepEqual(md("gh issue edit 5 --add-label needs-qa"), [1]);
  });

  test("flag-only literal writes are not sites", () => {
    assert.deepEqual(md("gh issue edit 5 --add-label glm-withhold"), []);
  });

  test("needs-qa-override never matches needs-qa", () => {
    assert.deepEqual(md("gh issue edit 5 --add-label needs-qa-override"), []);
  });

  test("a variable operand is a site", () => {
    assert.deepEqual(md('gh issue edit 5 --remove-label "$l"'), [1]);
  });

  test("one line is at most one site", () => {
    assert.deepEqual(md("gh issue edit 5 --remove-label needs-qa --add-label in-progress"), [1]);
  });

  test("gh api labels GET is not a site; DELETE of a state is", () => {
    assert.deepEqual(md("gh api repos/a/b/issues/5/labels"), []);
    assert.deepEqual(md("gh api -X DELETE repos/a/b/issues/5/labels/needs-qa"), [1]);
  });

  test("TS: ORCH_BOARD_LABELS key resolving to a state is a site", () => {
    assert.deepEqual(ts("await addIssueLabel(1, ORCH_BOARD_LABELS.needs_qa);"), [1]);
  });

  test("TS: a flag const is not a site, a state const is", () => {
    assert.deepEqual(ts('const F = "glm-withhold";\nawait addIssueLabel(1, F);'), []);
    assert.deepEqual(ts('const S = "in-progress";\nawait removeIssueLabel(1, S);'), [2]);
  });

  test("TS: pass-through labels object and parameters fail closed", () => {
    assert.deepEqual(ts("await deps.editIssueLabels(1, labels);"), [1]);
    assert.deepEqual(ts("await addIssueLabel(n, label);"), [1]);
  });

  test("TS: each editIssueLabels array element is its own site", () => {
    assert.equal(ts('editIssueLabels(1, { remove: ["in-progress"], add: ["needs-qa", "glm-withhold"] });').length, 2);
  });

  test("TS: comment-only mentions and function definitions are not sites", () => {
    assert.deepEqual(ts('// addIssueLabel(1, "needs-qa")'), []);
    assert.deepEqual(ts("export async function addIssueLabel(n: number, label: string) {}"), []);
  });

  test("exempt paths yield no sites", () => {
    assert.deepEqual(scanFileSites("src/lifecycle/seam.ts", 'addIssueLabel(1, "needs-qa");'), []);
    assert.deepEqual(scanFileSites("scripts/lifecycle.ts", 'addIssueLabel(1, "needs-qa");'), []);
    assert.deepEqual(
      scanFileSites("docs/operator-playbooks/hydra-target-qa.md", "gh issue edit 5 --add-label needs-qa"),
      [],
    );
  });

  test("backslash-continued flag with the label on the next line is a site; a flag continuation is not", () => {
    assert.deepEqual(md("gh issue edit 5 --add-label \\\n  needs-qa"), [1]);
    assert.deepEqual(md("gh issue edit 5 --add-label \\\n  glm-withhold"), []);
  });

  test("comma-separated labels: any state in the list makes a site", () => {
    assert.deepEqual(md("gh issue edit 5 --add-label glm-withhold,needs-qa"), [1]);
    assert.deepEqual(md("gh issue edit 5 --add-label glm-withhold,other-flag"), []);
  });

  test("TS: argv-style gh shell-out is a site; a flag argv is not", () => {
    assert.deepEqual(ts('run("gh", ["issue", "edit", "5", "--add-label", "needs-qa"]);'), [1]);
    assert.deepEqual(ts('run("gh", ["issue", "edit", "5", "--add-label", "glm-withhold"]);'), []);
  });

  test("gh api labels[]= (bare and quoted -f) and gh issue create --label are sites; flags/filters are not", () => {
    assert.deepEqual(md("gh api repos/x/issues/5 -f labels[]=needs-qa"), [1]);
    assert.deepEqual(md('gh api repos/x/issues/5 -f "labels[]=needs-qa"'), [1]);
    assert.deepEqual(md('gh issue create --title t --label "needs-triage"'), [1]);
    assert.deepEqual(md("gh api repos/x/issues/5 -f labels[]=glm-withhold"), []);
    assert.deepEqual(md("gh issue list --label needs-qa"), []);
  });

  test("TS: a function-local const does not clear another function's parameter operand", () => {
    const src = 'function a() {\n  const label = "glm-withhold";\n}\nfunction b(label: string) {\n  addIssueLabel(1, label);\n}';
    assert.deepEqual(ts(src), [5]);
    assert.deepEqual(ts('const label = "glm-withhold";\naddIssueLabel(1, label);'), []);
    assert.deepEqual(ts('const label = "glm-withhold";\nfunction f() { const label = "x"; }\naddIssueLabel(1, label);'), [3]);
  });

  test("TS: prettier-formatted argv with flag and operand on separate lines is a site; a flag operand is not", () => {
    assert.deepEqual(ts('run("gh", [\n  "issue",\n  "--add-label",\n  "needs-qa",\n]);'), [3]);
    assert.deepEqual(ts('run("gh", [\n  "issue",\n  "--add-label",\n  "glm-withhold",\n]);'), []);
  });

  test("TS: argv list form with a non-literal operand fails closed; a flag literal does not", () => {
    assert.deepEqual(ts('run("gh", ["issue", "edit", "5", "--add-label", labelFor(x)]);'), [1]);
    assert.deepEqual(ts('run("gh", ["issue", "edit", "5", "--add-label", labels[i]]);'), [1]);
    assert.deepEqual(ts('run("gh", ["issue", "edit", "5", "--add-label", "glm-withhold"]);'), []);
  });

  test("TS: a module const shadowed by a parameter or destructured binding is unresolvable", () => {
    const param = 'const label = "glm-withhold";\nfunction b(label: string) {\n  addIssueLabel(1, label);\n}';
    assert.deepEqual(ts(param), [3]);
    const destructured = 'const label = "glm-withhold";\nfunction b(o) {\n  const { label } = o;\n  addIssueLabel(1, label);\n}';
    assert.deepEqual(ts(destructured), [4]);
    // sibling: an `if (label) {` control-flow paren is not a binding, so the flag const still resolves
    assert.deepEqual(ts('const label = "glm-withhold";\nif (label) {\n  addIssueLabel(1, label);\n}'), []);
  });

  test("TS: gh api argv and --field/--raw-field/--input forms are sites; a GET or flag label is not", () => {
    assert.deepEqual(ts('run("gh", ["api", "-X", "POST", "repos/x/issues/5/labels", "-f", "labels[]=needs-qa"]);'), [1]);
    assert.deepEqual(ts('run("gh", ["api", "repos/x/issues/5/labels", "--field", "labels[]=needs-qa"]);'), [1]);
    assert.deepEqual(ts('run("gh", ["api", "repos/x/issues/5/labels", "--input", "body.json"]);'), [1]);
    assert.deepEqual(md("gh api repos/x/issues/5/labels --raw-field labels[]=needs-qa"), [1]);
    assert.deepEqual(ts('run("gh", ["api", "-X", "POST", "repos/x/issues/5/labels", "-f", "labels[]=glm-withhold"]);'), []);
    assert.deepEqual(ts('run("gh", ["api", "repos/x/issues/5/labels"]);'), []);
  });

  test("TS: a bare single-parameter arrow shadows a module const", () => {
    const arrow = 'const label = "glm-withhold";\nxs.map(label => addIssueLabel(1, label));';
    assert.deepEqual(ts(arrow), [2]);
    assert.deepEqual(ts('const label = "glm-withhold";\nxs.map(async label => addIssueLabel(1, label));'), [2]);
    const dflt = 'const label = "glm-withhold";\nconst f = (a = g(1), label) => addIssueLabel(1, label);';
    assert.deepEqual(ts(dflt), [2]);
    // sibling: an unrelated arrow does not shadow
    assert.deepEqual(ts('const label = "glm-withhold";\nxs.map(x => x);\naddIssueLabel(1, label);'), []);
  });

  test("scan surface covers .mts/.cts/.tsx/.js/.cjs/.mjs under src/ and scripts/; sites are found in them", () => {
    for (const f of ["src/a.mts", "src/a.tsx", "src/a.js", "src/a.cjs", "scripts/a.mts", "scripts/a.cjs", "scripts/a.js"]) {
      assert.equal(isSurface(f), true, f);
      assert.deepEqual(scanFileSites(f, 'addIssueLabel(1, "needs-qa");'), [1], f);
    }
    assert.equal(isSurface("src/a.json"), false);
    assert.equal(isSurface("test/a.mts"), false);
  });

  test("single-line argv --label on a create is a site; --label on a list is not", () => {
    assert.deepEqual(ts('run("gh", ["issue", "create", "--label", "needs-triage"]);'), [1]);
    assert.deepEqual(ts('run("gh", ["issue", "create", "--label=needs-triage"]);'), [1]);
    assert.deepEqual(ts('run("gh", ["issue", "list", "--label", "needs-triage"]);'), []);
    assert.deepEqual(ts('run("gh", ["issue", "create", "--label", "glm-withhold"]);'), []);
  });

  test("TS: editIssueLabels spread or computed property fails closed; add/remove arrays of flags do not", () => {
    assert.deepEqual(ts("editIssueLabels(1, { ...opts });"), [1]);
    assert.deepEqual(ts("editIssueLabels(1, { [k]: [v] });"), [1]);
    assert.deepEqual(ts('editIssueLabels(1, { add: ["glm-withhold"] });'), []);
  });

  test("block comments keep line numbers stable", () => {
    assert.deepEqual(ts('/* a\n b\n c */\naddIssueLabel(1, "needs-qa");'), [4]);
  });
});

describe("lifecycle-seam-check: evasion forms (#5367)", () => {
  const md = (text: string) => scanFileSites("docs/operator-playbooks/hydra-x.md", text);
  const ts = (text: string) => scanFileSites("src/x.ts", text);

  test("short -l on a create is a site (shell and argv forms)", () => {
    assert.deepEqual(md("gh issue create --title t -l needs-triage"), [1]);
    assert.deepEqual(md("gh issue create --title t -l=needs-triage"), [1]);
    assert.deepEqual(ts('run("gh", ["issue", "create", "-l", "needs-triage"]);'), [1]);
  });

  test("short -l outside create context, with a flag literal, or as a lookalike token is not a site", () => {
    assert.deepEqual(md("gh pr list -l needs-triage"), []);
    assert.deepEqual(md("ls -l $dir"), []);
    assert.deepEqual(md("gh issue create --title t -l glm-withhold"), []);
    assert.deepEqual(md("gh issue create --title t -label needs-triage"), []);
    assert.deepEqual(md("gh issue create --title t -lx needs-triage"), []);
  });

  test("short -l: ls/wc/grep -l with a variable operand is not a site even when `create` appears earlier", () => {
    assert.deepEqual(md("# create the dir\nls -l $dir"), []);
    assert.deepEqual(md("gh issue create --title t\nwc -l $f"), []);
    assert.deepEqual(md("gh issue create --title t -l $state"), [1]);
  });

  test("short -l reaches across a multi-line argv list and a heredoc body (same reach as --label)", () => {
    assert.deepEqual(ts('run("gh", [\n  "issue",\n  "create",\n  "--title", t,\n  "-l", "needs-triage",\n]);'), [5]);
    assert.deepEqual(ts('run("gh", [\r\n  "issue",\r\n  "create",\r\n  "-l", "needs-triage",\r\n]);'), [4]);
    assert.deepEqual(md("gh issue create --title t --body-file - <<'EOF'\nbody line\nEOF\n  -l needs-triage"), [4]);
    assert.deepEqual(md("gh issue create --title t \\\r\n  -l needs-triage"), [1]);
    // sibling shapes keep their verdict: a later command on a new line or after a boundary is not create context
    assert.deepEqual(md("gh issue create --title t\nwc -l $f"), []);
    assert.deepEqual(md("gh issue create --title t; wc -l $f"), []);
    assert.deepEqual(md("gh issue create --title t && ls -l $f"), []);
  });

  test("short -l: a `;` / `&&` / `|` inside a quoted title or body is not a command boundary", () => {
    assert.deepEqual(md('gh issue create --title "fix; x" -l needs-triage'), [1]);
    assert.deepEqual(md('gh issue create --body "a | b" -l needs-triage'), [1]);
    assert.deepEqual(md("gh issue create --title 'a && b' -l needs-triage"), [1]);
    assert.deepEqual(md('gh issue create --title "say \\"hi\\"; x" -l needs-triage'), [1]);
    assert.deepEqual(ts('run("gh", ["issue", "create", "--title", "fix; x", "-l", "needs-triage"]);'), [1]);
    assert.deepEqual(ts('run("gh", ["issue", "create", "--body", "a | b", "-l", "needs-triage"]);'), [1]);
    // sibling shapes: a real boundary after a closed quote still ends the create command
    assert.deepEqual(md('gh issue create --title "t"; wc -l $f'), []);
    assert.deepEqual(md("gh issue create --title 'a; b' && ls -l $f"), []);
  });

  test("short -l: a newline inside a quoted multi-line body is not a command boundary", () => {
    assert.deepEqual(md('gh issue create --title t --body "line1\nline2" -l needs-triage'), [2]);
    assert.deepEqual(md("gh issue create --title t --body 'a\nb\nc' -l needs-triage"), [3]);
    assert.deepEqual(ts('run("gh", ["issue", "create", "--body", "a\nb", "-l", "needs-triage"]);'), [2]);
    // sibling: the --label twin agrees, and an unquoted newline still ends the command
    assert.deepEqual(md('gh issue create --title t --body "line1\nline2" --label needs-triage'), [2]);
    assert.deepEqual(md('gh issue create --title "t"\nwc -l $f'), []);
  });

  test("TS: `deps.f ?? ((n, l) => seamFn(n, l))` is a wrapper; a non-arrow `x ?? other(..)` is not", () => {
    assert.deepEqual(
      ts("const addLabel = deps.addLabel ?? ((n: number, label: string) => addIssueLabel(n, label));\naddLabel(1, lbl);"),
      [1, 2],
    );
    assert.deepEqual(ts("const addLabel = deps.addLabel ?? makeThing(addIssueLabel);\naddLabel(1, lbl);"), []);
  });

  test("python f-string placeholder operand is a site", () => {
    assert.deepEqual(md('cmd = f"gh issue edit 5 --add-label {state}"'), [1]);
    assert.deepEqual(md("gh issue edit 5 --add-label={x}"), [1]);
  });

  test("flag literal followed by + concatenation is a site", () => {
    assert.deepEqual(ts('run("gh", ["issue", "edit", "5", "--add-label " + x]);'), [1]);
  });

  test("flag= literal followed by + concatenation is a site", () => {
    assert.deepEqual(ts('run("gh", ["issue", "edit", "5", "--add-label=" + x]);'), [1]);
  });

  test("short -l literal followed by + concatenation is a site in create context only", () => {
    assert.deepEqual(ts("run(\"gh issue create \" + '-l ' + x);"), [1]);
    assert.deepEqual(ts("run(\"gh pr list \" + '-l ' + x);"), []);
  });

  test("trailing = with no operand is a site; a flag operand after = is not", () => {
    assert.deepEqual(ts('run("gh", ["issue", "edit", "5", "--add-label=", x]);'), [1]);
    assert.deepEqual(ts('run("gh", ["issue", "edit", "5", "--add-label=glm-withhold"]);'), []);
    assert.deepEqual(md("gh issue edit 5 --add-label="), [1]);
  });

  test("TS: generic call is a site", () => {
    assert.deepEqual(ts('await addIssueLabel<void>(1, "needs-qa");'), [1]);
    assert.deepEqual(ts('await addIssueLabel<void>(1, "glm-withhold");'), []);
  });

  test("TS: optional call is a site", () => {
    assert.deepEqual(ts('await addIssueLabel?.(1, "needs-qa");'), [1]);
  });

  test("TS: member optional call is a site", () => {
    assert.deepEqual(ts("await deps.editIssueLabels?.(1, labels);"), [1]);
  });

  test("TS: import-as alias is a wrapper of the seam function", () => {
    assert.deepEqual(ts('import { addIssueLabel as addLabel } from "./x";\naddLabel(1, "needs-qa");'), [2]);
    assert.deepEqual(ts('import { addIssueLabel as addLabel } from "./x";\naddLabel(1, "glm-withhold");'), []);
  });

  test("TS: ??-fallback alias is a wrapper of the seam function", () => {
    const src = 'const addLabel = deps.addIssueLabel ?? addIssueLabel;\naddLabel(5, "needs-qa");';
    assert.deepEqual(ts(src), [2]);
    assert.deepEqual(ts('const addLabel = deps.addIssueLabel ?? addIssueLabel;\naddLabel(5, "glm-withhold");'), []);
  });

  test("TS: arrow wrapper calls are sites and the pass-through definition counts", () => {
    const src = "const w = (n: number, l: string) => addIssueLabel(n, l);\nw(1, \"needs-qa\");";
    assert.deepEqual(ts(src), [1, 2]);
  });

  test("TS: a direct-call result binding is not a wrapper", () => {
    assert.deepEqual(ts('const res = await addIssueLabel(1, "glm-withhold");\nres(1, "needs-qa");'), []);
  });

  test("QA #5367: a member call named like a wrapper is not a wrapper call", () => {
    // red without the fix: `run` is a wrapper (arrow over addIssueLabel); `proc.run(a, b)` must not count.
    const src = 'const run = (n: number) => addIssueLabel(n, l);\nproc.run(a, b);';
    assert.deepEqual(ts(src), [1]);
    // sibling shape keeps its verdict: a bare wrapper call still counts; a member seam call still counts.
    assert.deepEqual(ts('const run = (n: number, l: string) => addIssueLabel(n, l);\nrun(1, x);'), [1, 2]);
    assert.deepEqual(ts("gh.addIssueLabel(1, x);"), [1]);
  });

  test("QA #5367: object shorthand and call-result bindings are not wrappers", () => {
    // red without the fix: the initializer merely mentions the seam fn.
    assert.deepEqual(ts("const deps = { addIssueLabel };\ndeps(1, x);"), []);
    assert.deepEqual(ts("const r = xs.map((x) => addIssueLabel(x, 'glm-withhold'));\nr(1, x);"), []);
    // sibling shape keeps its verdict: bare alias and `??` alias are still wrappers.
    assert.deepEqual(ts("const a = addIssueLabel;\na(1, x);"), [2]);
    assert.deepEqual(ts("const a = deps.addIssueLabel ?? addIssueLabel;\na(1, x);"), [2]);
  });

  test("isExemptPath: only the three transport files are exempt under src/github", () => {
    for (const f of ["src/github/issues.ts", "src/github/issue-actions.ts", "src/github/prs.ts"]) {
      assert.equal(isExemptPath(f), true, f);
    }
    for (const f of [
      "src/github/labels.ts",
      "src/github/gh.ts",
      "scripts/claude-hooks/gh-label-delete-guard.sh",
    ]) {
      assert.equal(isExemptPath(f), false, f);
    }
  });

  test("documented non-count: python %-formatting", () => {
    assert.deepEqual(md('cmd = "gh issue edit 5 --add-label %s" % x'), []);
  });

  test("documented non-count: arity-changing wrapper calls (definition line still counts)", () => {
    const src = 'const w = (l: string) => addIssueLabel(ISSUE, l);\nw("needs-qa");';
    assert.deepEqual(ts(src), [1]);
  });

  test("documented non-count: two-hop aliases and re-exports", () => {
    assert.deepEqual(ts('import { addIssueLabel as a } from "./x";\nconst b = a;\nb(1, "needs-qa");'), []);
    assert.deepEqual(ts('export { addIssueLabel as x } from "./y";\nx(1, "needs-qa");'), []);
  });

  test("documented non-count: flag assembled from a separately-bound string", () => {
    assert.deepEqual(ts('const FLAG = "--add-label";\nrun("gh", ["issue", "edit", "5", FLAG, "needs-qa"]);'), []);
  });

  test("documented non-count: .github/workflows is not a scan surface", () => {
    assert.equal(isSurface(".github/workflows/x.yml"), false);
  });
});

describe("lifecycle-seam-check: PR-context carve-out (#5428)", () => {
  const md = (text: string) => scanFileSites("docs/operator-playbooks/hydra-x.md", text);
  const ts = (text: string) => scanFileSites("src/x.ts", text);

  test("gh pr edit --add-label of a state is not a site", () => {
    assert.deepEqual(md("gh pr edit 5 --add-label ready-for-human"), []);
    assert.deepEqual(md('gh pr edit "${PR_NUMBER}" --repo o/r --add-label ready-for-human'), []);
  });

  test("gh pr create --label and -l are not sites", () => {
    assert.deepEqual(md("gh pr create --label needs-qa --title t"), []);
    assert.deepEqual(md("gh pr create -l needs-qa --title t"), []);
  });

  test("PR context is command-bounded: a following gh issue write is still a site", () => {
    assert.deepEqual(md("gh pr edit 5 --add-label x && gh issue edit 5 --add-label needs-qa"), [1]);
  });

  test("argv form gh pr edit is not a site", () => {
    assert.deepEqual(ts('run("gh", ["pr", "edit", "--add-label", "ready-for-human"]);'), []);
  });

  test("gh api on a PR-identifier label path is not a site", () => {
    assert.deepEqual(md('gh api -X DELETE "repos/o/r/issues/$PR/labels/$L"'), []);
    assert.deepEqual(md("gh api -X DELETE repos/o/r/issues/${PR_NUMBER}/labels/ready-for-human"), []);
  });

  test("gh api on an issue identifier or literal number stays a site", () => {
    assert.deepEqual(md('gh api -X DELETE "repos/o/r/issues/$ISSUE/labels/$L"'), [1]);
    assert.deepEqual(md("gh api -X DELETE repos/o/r/issues/42/labels/needs-qa"), [1]);
  });

  test("PR-path allowlist is exact: PR-prefixed issue identifiers stay sites", () => {
    assert.deepEqual(md('gh api -X DELETE "repos/o/r/issues/$PRD_ISSUE/labels/needs-qa"'), [1]);
    assert.deepEqual(md("gh api -X DELETE repos/o/r/issues/${PRIORITY_ISSUE}/labels/needs-qa"), [1]);
    assert.deepEqual(md("gh api -X DELETE repos/o/r/issues/$PROJECT_NUMBER/labels/needs-qa"), [1]);
    assert.deepEqual(md("gh api -X DELETE repos/o/r/issues/${PR_NUM}/labels/ready-for-human"), []);
  });

  test("a gh pr nested in a gh issue command does not exempt the issue write", () => {
    assert.deepEqual(md('gh issue edit "$(gh pr view 5 --json number -q .number)" --add-label needs-qa'), [1]);
    assert.deepEqual(md("gh pr edit 5 --add-label ready-for-human"), []);
  });

  test("gh global flags (-R/--repo) before the subcommand do not hide the issue command", () => {
    assert.deepEqual(md("gh -R o/r issue edit $(gh pr view 5 -q .number) --add-label needs-qa"), [1]);
    assert.deepEqual(md("gh --repo o/r issue edit $(gh pr view 5 -q .number) --add-label needs-qa"), [1]);
    // sibling: a -R prefixed gh pr command keeps its PR-flag exemption
    assert.deepEqual(md("gh -R o/r pr edit 5 --add-label ready-for-human"), []);
  });

  test("a >2000-char body gh issue with a nested gh pr still counts (no fixed lookback)", () => {
    const body = "x".repeat(3000);
    assert.deepEqual(md(`gh issue edit 5 --body "${body} $(gh pr view 5 -q .number)" --add-label needs-qa`), [1]);
    // sibling: a >2000-char gh pr command keeps its PR-flag exemption
    assert.deepEqual(md(`gh pr edit 5 --body "${body}" --add-label ready-for-human`), []);
  });

  test("chained gh api calls are judged per invocation", () => {
    assert.deepEqual(
      md('gh api -X DELETE repos/o/r/issues/$PR/labels/x && gh api -X DELETE repos/o/r/issues/$ISSUE/labels/needs-qa'),
      [1],
    );
    assert.deepEqual(md("gh api -X DELETE repos/o/r/issues/$PR/labels/x && gh api -X DELETE repos/o/r/issues/${PR_NUMBER}/labels/y"), []);
  });

  test("documented non-count: PR aliased from an issue number", () => {
    assert.deepEqual(md("PR=$ISSUE; gh api -X DELETE repos/o/r/issues/$PR/labels/needs-qa"), []);
  });

  test("hydra-review and hydra-pr-rebase remain scan surfaces", () => {
    assert.deepEqual(scanFileSites("docs/operator-playbooks/hydra-review.md", "gh issue edit 5 --add-label needs-qa"), [1]);
    assert.deepEqual(scanFileSites("docs/operator-playbooks/hydra-pr-rebase.md", "gh issue edit 5 --add-label needs-qa"), [1]);
  });
});

describe("lifecycle-seam-check: fails closed", () => {
  test("an unreadable scan root throws instead of being skipped", async () => {
    // package.json is a file, so <root>/docs/... is ENOTDIR, not a missing dir.
    await assert.rejects(
      () => scanLifecycleSeam(`${REPO_ROOT}/package.json`),
      /cannot read dir docs\/operator-playbooks/,
    );
  });

  test("a missing scan root has no sites", async () => {
    assert.deepEqual(await scanLifecycleSeam(`${REPO_ROOT}/no-such-root-5311`), {});
  });

  test("a malformed baseline throws", () => {
    assert.throws(() => parseLifecycleBaseline('{"rule":"x"}'), /malformed baseline/);
    assert.throws(
      () => parseLifecycleBaseline('{"rule":"lifecycle-seam","files":{"a":-1}}'),
      /malformed baseline/,
    );
    assert.deepEqual(
      parseLifecycleBaseline('{"rule":"lifecycle-seam","files":{"a":2}}').files,
      { a: 2 },
    );
  });
});
