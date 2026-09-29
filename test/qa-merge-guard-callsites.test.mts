/**
 * Every playbook merge call site consults the QA merge guard (issue #4738,
 * decision #4736 option 2).
 *
 * The 150-PR audit found GLM-authored PRs (#4427, #4435, #4440, #4536) that
 * reached `needs-qa` and were then merged by hand before QA ran, and #4436
 * merged over an unaddressed FAIL. The guard (`qa-merge-guard.ts`, #4737)
 * answers "may this PR merge now?" from QA's own record, bound to the head
 * SHA. This doc-drift test greps the playbook sources (the generated
 * `hydra-*` skills are artifacts of these files) and pins that:
 *
 *   1. every `gh pr merge` / REST merge CALL SITE has a guard invocation in
 *      its block (its fence, or its paragraph) or an EXEMPT entry with a
 *      written reason;
 *   2. the lanes the issue names behave as specified — hydra-review's Land-it
 *      shows the guard verdict and needs an explicit override choice that
 *      posts a `QA-Override:` line; hydra-auto-merge-window and hydra-sweep
 *      skip denied PRs and never override; the autopilot builds `qa-verdict`
 *      events through the guard so decide.py's stale-verdict hold can fire.
 *
 * The `QA-Override:` line's parser/renderer are pinned in
 * test/qa-catch-rate.test.mts; here only the playbook's literal is pinned.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PLAYBOOKS = join(ROOT, "docs", "operator-playbooks");
const GUARD = "qa-merge-guard.ts";

/** Playbook sources that generate skills: top-level + `_fragments/` (not `_vendor/`). */
function playbookFiles(): string[] {
  const top = readdirSync(PLAYBOOKS)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f);
  const frags = readdirSync(join(PLAYBOOKS, "_fragments"))
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .map((f) => `_fragments/${f}`);
  return [...top, ...frags].sort();
}

const read = (rel: string): string => readFileSync(join(PLAYBOOKS, rel), "utf8");

/**
 * A merge call site: `gh pr merge` (except a `--disable-auto` disarm, which
 * can only stop a merge) or a REST `pulls/<n>/merge` call.
 */
function mergeCallSites(text: string): string[] {
  return text
    .split("\n")
    .filter(
      (line) =>
        (/\bgh pr merge\b/.test(line) && !/--disable-auto/.test(line)) ||
        /pulls\/[^\s"'`]*\/merge\b/.test(line),
    );
}

/** One merge call site: the line, and the block it sits in. */
interface CallSite {
  file: string;
  line: number;
  text: string;
  /** The enclosing fenced code block, else the enclosing paragraph / list item. */
  block: string;
}

/**
 * Every merge call site in a playbook, with its block. A line inside a
 * ``` fence belongs to that whole fence; any other line belongs to its
 * paragraph (the run of non-blank lines around it).
 */
function callSites(file: string, text: string): CallSite[] {
  const lines = text.split("\n");
  const fenceOf: number[] = new Array(lines.length).fill(-1);
  let open = -1;
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) {
      if (open === -1) open = i;
      else {
        for (let j = open; j <= i; j++) fenceOf[j] = open;
        open = -1;
      }
    }
  });
  const sites: CallSite[] = [];
  lines.forEach((l, i) => {
    if (mergeCallSites(l).length === 0) return;
    let lo = i;
    let hi = i;
    if (fenceOf[i] !== -1) {
      lo = fenceOf[i];
      hi = lo + 1;
      while (hi < lines.length && fenceOf[hi] === lo) hi++;
      hi--;
    } else {
      while (lo > 0 && lines[lo - 1].trim() !== "" && fenceOf[lo - 1] === -1) lo--;
      while (hi < lines.length - 1 && lines[hi + 1].trim() !== "" && fenceOf[hi + 1] === -1) hi++;
    }
    sites.push({ file, line: i + 1, text: l, block: lines.slice(lo, hi + 1).join("\n") });
  });
  return sites;
}

/**
 * Call sites allowed WITHOUT a guard invocation in their block, each keyed by
 * file + a substring of the call-site line, with the reason it is exempt.
 */
const EXEMPT: ReadonlyArray<{ file: string; match: string; reason: string }> = [
  {
    file: "hydra-qa.md",
    match: "gh pr merge $pr_number --repo gaberoo322/hydra --auto --squash --delete-branch",
    reason: "hydra-qa's own PASS arm: the PASS verdict it just posted at this head IS the guard's input",
  },
  {
    file: "hydra-auto-merge-window.md",
    match: "apply `operator-approved` to Tier-0 PRs and click `gh pr merge --auto`",
    reason: "safety-model prose; item 4 directly below requires the guard, and the act loop runs it",
  },
  {
    file: "hydra-auto-merge-window.md",
    match: "`gh pr merge --auto` is idempotent",
    reason: "failure-mode prose about overlapping passes, not a merge instruction",
  },
  {
    file: "_fragments/hydra-target-build-merge-flow.md",
    match: "gh pr merge",
    reason: "Target repo PRs: Target QA verdicts live on the linked Target issue, not in QA-Verdict trailers the guard reads",
  },
];

const isExempt = (s: CallSite): boolean =>
  EXEMPT.some((e) => e.file === s.file && s.text.includes(e.match));

function section(text: string, startRe: RegExp, endRe: RegExp): string {
  const start = text.search(startRe);
  assert.ok(start > -1, `section start ${startRe} not found`);
  // Search for the end AFTER the start line, so a `^##` end pattern never
  // matches the start heading itself.
  const bodyStart = text.indexOf("\n", start) + 1;
  const end = text.slice(bodyStart).search(endRe);
  return end === -1 ? text.slice(start) : text.slice(start, bodyStart + end);
}

/** The lines between `# >>> name` and `# <<< name` (exclusive). */
function markerBlock(text: string, name: string): string {
  const lines = text.split("\n");
  const a = lines.findIndex((l) => l.trim() === `# >>> ${name}`);
  const b = lines.findIndex((l) => l.trim() === `# <<< ${name}`);
  assert.ok(a > -1 && b > a, `marker block "${name}" not found`);
  return lines.slice(a + 1, b).join("\n");
}

describe("QA merge guard — every playbook merge call site (issue #4738)", () => {
  test("every merge call site has a guard invocation in its block or an exempt entry", () => {
    const unguarded: string[] = [];
    for (const rel of playbookFiles()) {
      for (const site of callSites(rel, read(rel))) {
        if (isExempt(site)) continue;
        if (!site.block.includes(GUARD)) unguarded.push(`${rel}:${site.line}: ${site.text.trim()}`);
      }
    }
    assert.deepEqual(
      unguarded,
      [],
      `these merge call sites have no ${GUARD} invocation in their block — run the guard in the same block (skip on a non-zero exit) or add an EXEMPT entry with a reason`,
    );
  });

  test("the exempt list is honest: every entry matches a live call site and has a reason", () => {
    const all = playbookFiles().flatMap((rel) => callSites(rel, read(rel)));
    for (const e of EXEMPT) {
      assert.ok(
        all.some((s) => s.file === e.file && s.text.includes(e.match)),
        `EXEMPT entry ${e.file} :: ${e.match} matches no call site — drop it`,
      );
      assert.ok(e.reason.length > 20, `EXEMPT entry ${e.file} :: ${e.match} needs a real reason`);
    }
  });

  test("the detector sees the call sites it must (guards against a vacuous pass)", () => {
    for (const rel of ["hydra-review.md", "hydra-auto-merge-window.md", "hydra-autopilot.md", "hydra-qa.md"]) {
      assert.ok(mergeCallSites(read(rel)).length > 0, `${rel} should carry a merge call site`);
    }
    assert.equal(mergeCallSites("gh pr merge 1 --disable-auto").length, 0, "a disarm is not a merge");
    assert.equal(mergeCallSites("gh api -X PUT repos/o/r/pulls/12/merge").length, 1, "the REST merge form counts");
    const sites = callSites("x.md", "prose\n\n```bash\nguard qa-merge-guard.ts\n\ngh pr merge 1\n```\n\nlone gh pr merge 2\n");
    assert.equal(sites.length, 2);
    assert.ok(sites[0].block.includes(GUARD), "a fenced call site's block is its whole fence");
    assert.ok(!sites[1].block.includes(GUARD), "a prose call site's block is only its paragraph");
  });
});

describe("hydra-review Land it — guard verdict + explicit QA-Override (issue #4738)", () => {
  const review = read("hydra-review.md");
  const landIt = section(review, /^- \*\*Land it\*\*/m, /^- \*\*Update branch\*\*/m);

  test("runs the guard before landing and shows its reason + latest verdict", () => {
    assert.ok(landIt.includes(GUARD), "Land it must run the QA merge guard");
    assert.match(landIt, /`reason`/, "a denial must surface the guard's reason");
    assert.match(landIt, /latest `verdict`/, "a denial must surface the latest verdict");
  });

  test("landing over a denial requires an explicit override choice", () => {
    assert.match(landIt, /\*\*Route to QA \(Recommended\)\*\*/, "the recommended answer to a denial is routing to QA");
    assert.match(landIt, /\*\*Override: accept the FAIL\*\*/);
    assert.match(landIt, /\*\*Override: QA not needed\*\*/);
    assert.match(landIt, /QA-Override recipe/, "the override options point at the recipe");
  });

  test("the override recipe renders the line via the catch-rate renderer and never interpolates the reason", () => {
    const recipe = markerBlock(review, "qa-override");
    assert.match(recipe, /<<'QA_OVERRIDE_REASON'/, "the reason is captured through a QUOTED heredoc");
    assert.match(recipe, /renderQaOverrideLine/, "the line is rendered by the pinned renderer");
    assert.match(recipe, /--body-file/, "the comment body goes through --body-file");
    assert.doesNotMatch(recipe, /--body\s+"/, "never an interpolated --body");
    const comment = recipe.indexOf("gh pr comment");
    const merge = recipe.indexOf("gh pr merge");
    assert.ok(comment > -1 && merge > comment, "comment first, then merge");
    assert.match(recipe, /--squash --match-head-commit "\$HEAD_SHA"/, "merge-now is head-pinned");
    assert.match(recipe, /--auto --squash --match-head-commit "\$HEAD_SHA"/, "the --auto arm is head-pinned too");
  });

  test("a hostile reason (quote, $(...), backtick) lands verbatim and executes nothing", () => {
    const HEAD = "0123456789abcdef0123456789abcdef01234567";
    const REASON = 'He said "ship it" $(echo pwned) and `touch PWNED_BACKTICK`';
    const dir = mkdtempSync(join(tmpdir(), "qa-override-"));
    try {
      const log = join(dir, "gh.log");
      const body = join(dir, "body.txt");
      // A fake `gh` on PATH: answers the guard's REST reads, records the rest.
      writeFileSync(
        join(dir, "gh"),
        [
          "#!/usr/bin/env bash",
          'echo "$*" >> "$GH_LOG"',
          'if [ "$1" = api ]; then',
          '  case "$*" in',
          `    *"/pulls/4555 --jq"*) echo '"${HEAD}"' ;;`,
          `    *files*) echo '"src/x.ts"' ;;`,
          "  esac",
          'elif [ "$1 $2" = "pr comment" ]; then',
          '  while [ $# -gt 0 ]; do [ "$1" = --body-file ] && cat "$2" > "$GH_BODY"; shift; done',
          "fi",
          "exit 0",
        ].join("\n"),
      );
      chmodSync(join(dir, "gh"), 0o755);
      const script = markerBlock(review, "qa-override")
        .replace("<operator's reason, verbatim>", REASON)
        .replaceAll("<PR>", "4555")
        .replaceAll("<RREPO>", "o/r");
      const r = spawnSync("bash", ["-c", script], {
        cwd: ROOT,
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_LOG: log, GH_BODY: body },
        encoding: "utf8",
      });
      assert.equal(r.status, 0, `recipe failed: ${r.stderr}`);
      const posted = readFileSync(body, "utf8");
      assert.ok(
        posted.includes(`QA-Override: pr=4555 sha=0123456789ab reason=${REASON}\n`),
        `the reason must land verbatim, got:\n${posted}`,
      );
      assert.ok(!existsSync(join(ROOT, "PWNED_BACKTICK")), "a backtick in the reason must not execute");
      const calls = readFileSync(log, "utf8");
      assert.match(calls, new RegExp(`pr merge 4555 --repo o/r --squash --match-head-commit ${HEAD}`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(join(ROOT, "PWNED_BACKTICK"), { force: true });
    }
  });
});

describe("autonomous merge lanes skip denied PRs and never override (issue #4738)", () => {
  test("hydra-auto-merge-window runs the guard before its first merge call and never overrides", () => {
    const text = read("hydra-auto-merge-window.md");
    const py = section(text, /^python3 <<PYEOF$/m, /^PYEOF$/m);
    const guardIdx = py.indexOf(GUARD);
    const mergeIdx = py.indexOf('"pr", "merge"');
    assert.ok(guardIdx > -1, "the act loop must invoke the guard");
    assert.ok(mergeIdx > -1, "the act loop still arms auto-merge");
    assert.ok(guardIdx < mergeIdx, "the guard must run before any merge call");
    assert.match(py, /guard\.returncode != 0[\s\S]*?continue/, "a non-zero guard exit skips the PR");
    assert.doesNotMatch(py, /QA-Override/, "the window never posts an override");
    assert.match(text, /never overrides/i);
  });

  test("hydra-sweep never merges directly; any land runs the guard and never overrides", () => {
    const text = read("hydra-sweep.md");
    assert.equal(mergeCallSites(text).length, 0, "the sweep must not carry a direct merge call");
    assert.ok(text.includes(GUARD), "the sweep must name the guard for any land it performs");
    assert.match(text, /\*\*never\*\* posts a `QA-Override:`/);
  });

  test("hydra-qa's direct-merge fallback is guarded and head-pinned", () => {
    const text = read("hydra-qa.md");
    const fallback = section(text, /^\*\*If `--auto` is refused/m, /^A denied guard/m);
    assert.ok(fallback.includes(GUARD), "the direct-merge fallback must run the guard");
    assert.ok(
      fallback.indexOf(GUARD) < fallback.indexOf('gh pr merge "$pr_number"'),
      "the guard gates the fallback merge",
    );
    assert.match(fallback, /--match-head-commit/, "the fallback merge is pinned to the guarded head");
  });
});

describe("autopilot qa-verdict events carry the guard's SHAs + required-check state (issues #4737, #4738)", () => {
  const text = read("hydra-autopilot.md");
  const build = section(text, /^### Building `qa-verdict` events/m, /^##/m);

  /** Run the playbook's event builder on a guard result + CI summary. */
  function event(guard: unknown, ci: unknown): Record<string, unknown> {
    const r = spawnSync("bash", ["-c", markerBlock(build, "qa-verdict-event")], {
      env: { ...process.env, PR: "12", TIER: "3", GUARD_JSON: JSON.stringify(guard), CI_JSON: JSON.stringify(ci) },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, `event builder failed: ${r.stderr}`);
    return JSON.parse(r.stdout);
  }
  const HEAD = "0123456789abcdef0123456789abcdef01234567";
  const atHead = (verdict: string) => ({
    allowed: !verdict.startsWith("FAIL"),
    reason: verdict.startsWith("FAIL") ? "verdict-fail" : "verdict-at-head",
    verdict,
    verdictSha: "0123456789ab",
    headSha: HEAD,
    exempt: false,
  });
  const green = { red: [], requiredPending: 0 };

  test("the section builds events from the guard CLI and the shared required-check helpers", () => {
    assert.ok(build.includes(GUARD), "qa-verdict events must be built from the guard CLI");
    assert.match(build, /redRequiredChecks\(checks\)/, "red required checks come from the shared helper");
    assert.match(build, /classifyVerdict\('PASS', checks\)\.summary\.requiredPending/, "pending required count from classifyVerdict");
    assert.match(build, /stale-verdict/, "the section names the decide.py hold it feeds");
  });

  test("the ci-state snippet derives {red, requiredPending} from the shared helpers, and fails closed", () => {
    const run = (checks: string) =>
      spawnSync("bash", ["-c", `${markerBlock(build, "ci-state")}\nprintf '%s' "$CI_JSON"`], {
        cwd: ROOT,
        env: { ...process.env, CHECKS_JSON: checks },
        encoding: "utf8",
      });
    const checks = JSON.stringify([
      { name: "test", status: "completed", conclusion: "success", required: true },
      { name: "scope-check", status: "in_progress", conclusion: null, required: true },
      { name: "tier-gate", status: "completed", conclusion: "failure", required: true },
      { name: "advisory-checks", status: "completed", conclusion: "failure", required: false },
    ]);
    const ok = run(checks);
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(JSON.parse(ok.stdout), { red: ["tier-gate"], requiredPending: 1 });
    const broken = run("");
    assert.equal(broken.stdout, "null", "an unreadable check list yields CI_JSON=null (→ PENDING)");
  });

  test("PASS-pending-CI at head + every required check green → PASS (the stranded-PR fix)", () => {
    assert.deepEqual(event(atHead("PASS-pending-CI"), green), {
      type: "qa-verdict",
      pr_number: 12,
      tier: 3,
      verdict: "PASS",
      verdict_sha: "0123456789ab",
      head_sha: HEAD,
    });
    assert.equal(event(atHead("PASS"), green).verdict, "PASS");
  });

  test("PASS at head + a required check still pending → PENDING", () => {
    assert.equal(event(atHead("PASS"), { red: [], requiredPending: 2 }).verdict, "PENDING");
    assert.equal(event(atHead("PASS-pending-CI"), { red: [], requiredPending: 1 }).verdict, "PENDING");
  });

  test("a red required check → FAIL, even under a PASS trailer", () => {
    assert.equal(event(atHead("PASS-pending-CI"), { red: ["test"], requiredPending: 0 }).verdict, "FAIL");
    assert.equal(event(atHead("PASS"), { red: ["scope-check"], requiredPending: 1 }).verdict, "FAIL");
  });

  test("a FAIL trailer → FAIL regardless of CI", () => {
    assert.equal(event(atHead("FAIL"), green).verdict, "FAIL");
    assert.equal(event(atHead("FAIL-pending-CI"), green).verdict, "FAIL");
  });

  test("fail closed: unreadable CI or guard → PENDING", () => {
    assert.equal(event(atHead("PASS"), null).verdict, "PENDING");
    const ev = event(null, green);
    assert.equal(ev.verdict, "PENDING");
    assert.equal(ev.verdict_sha, "unknown");
    assert.equal(ev.head_sha, "");
  });

  test("a stale PASS carries the mismatched SHAs so decide.py holds it as stale-verdict", () => {
    const stale = { ...atHead("PASS"), allowed: false, reason: "stale-verdict", headSha: "ffffffffffff" + HEAD.slice(12) };
    const ev = event(stale, green);
    assert.equal(ev.verdict, "PASS");
    assert.equal(ev.verdict_sha, "0123456789ab");
    assert.ok(!String(ev.head_sha).startsWith(String(ev.verdict_sha)), "SHAs must not bind");
  });

  test("the auto-merge action re-checks the guard before arming", () => {
    const row = text.split("\n").find((l) => /^\|\s*`auto-merge`\s*\|/.test(l));
    assert.ok(row, "auto-merge action row missing");
    assert.ok(row!.indexOf(GUARD) > -1 && row!.indexOf(GUARD) < row!.indexOf("gh pr merge --auto"));
  });
});
