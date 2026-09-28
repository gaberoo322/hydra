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
 *   1. every file with a `gh pr merge` / REST merge call site either runs the
 *      guard or is in EXEMPT with a written reason;
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
import { readFileSync, readdirSync } from "node:fs";
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

/** Files allowed to carry a merge call site without the guard, and why. */
const EXEMPT: Record<string, string> = {
  "hydra-qa.md":
    "hydra-qa's own PASS path — the verdict it just posted IS the guard's input; its direct-merge fallback is pinned to the guard below",
  "_fragments/hydra-target-build-merge-flow.md":
    "Target repo PRs — Target QA verdicts live on the linked Target issue, not in QA-Verdict trailers the guard reads",
};

function section(text: string, startRe: RegExp, endRe: RegExp): string {
  const start = text.search(startRe);
  assert.ok(start > -1, `section start ${startRe} not found`);
  // Search for the end AFTER the start line, so a `^##` end pattern never
  // matches the start heading itself.
  const bodyStart = text.indexOf("\n", start) + 1;
  const end = text.slice(bodyStart).search(endRe);
  return end === -1 ? text.slice(start) : text.slice(start, bodyStart + end);
}

describe("QA merge guard — every playbook merge call site (issue #4738)", () => {
  test("every file with a merge call site runs the guard or is documented as exempt", () => {
    const unguarded: string[] = [];
    for (const rel of playbookFiles()) {
      const text = read(rel);
      if (mergeCallSites(text).length === 0) continue;
      if (rel in EXEMPT) continue;
      if (!text.includes(GUARD)) unguarded.push(rel);
    }
    assert.deepEqual(
      unguarded,
      [],
      `these playbooks run a merge without consulting ${GUARD} — run the guard before the merge (skip on a non-zero exit) or add the file to EXEMPT with a reason`,
    );
  });

  test("the exempt list is honest: every entry exists, still merges, and has a reason", () => {
    const files = new Set(playbookFiles());
    for (const [rel, reason] of Object.entries(EXEMPT)) {
      assert.ok(files.has(rel), `EXEMPT names ${rel}, which is not a playbook source`);
      assert.ok(mergeCallSites(read(rel)).length > 0, `EXEMPT names ${rel}, which has no merge call site — drop it`);
      assert.ok(reason.length > 20, `EXEMPT entry ${rel} needs a real reason`);
    }
  });

  test("the detector sees the call sites it must (guards against a vacuous pass)", () => {
    for (const rel of ["hydra-review.md", "hydra-auto-merge-window.md", "hydra-autopilot.md", "hydra-qa.md"]) {
      assert.ok(mergeCallSites(read(rel)).length > 0, `${rel} should carry a merge call site`);
    }
    assert.equal(mergeCallSites("gh pr merge 1 --disable-auto").length, 0, "a disarm is not a merge");
    assert.equal(mergeCallSites("gh api -X PUT repos/o/r/pulls/12/merge").length, 1, "the REST merge form counts");
  });
});

describe("hydra-review Land it — guard verdict + explicit QA-Override (issue #4738)", () => {
  const review = read("hydra-review.md");
  const landIt = section(review, /^- \*\*Land it\*\*/m, /^- \*\*Update branch\*\*/m);

  test("runs the guard before landing and shows its reason + latest verdict", () => {
    assert.ok(landIt.includes(GUARD), "Land it must run the QA merge guard");
    assert.ok(landIt.indexOf(GUARD) < landIt.indexOf("QA-Override:"), "the guard runs before any override");
    assert.match(landIt, /`reason`/, "a denial must surface the guard's reason");
    assert.match(landIt, /latest `verdict`/, "a denial must surface the latest verdict");
  });

  test("landing over a denial requires an explicit override choice", () => {
    assert.match(landIt, /\*\*Route to QA \(Recommended\)\*\*/, "the recommended answer to a denial is routing to QA");
    assert.match(landIt, /\*\*Override: accept the FAIL\*\*/);
    assert.match(landIt, /\*\*Override: QA not needed\*\*/);
  });

  test("the override posts the pinned `QA-Override:` line BEFORE merging, bound to the head", () => {
    assert.ok(
      landIt.includes("QA-Override: pr=<PR> sha=<head12> reason=<text>"),
      "the override line format must be exactly `QA-Override: pr=<PR> sha=<head12> reason=<text>`",
    );
    const comment = landIt.indexOf("gh pr comment <PR>");
    const merge = landIt.indexOf("gh pr merge <PR> --squash --match-head-commit");
    assert.ok(comment > -1 && merge > -1 && comment < merge, "comment first, then a head-pinned merge");
  });

  test("the playbook literal, once filled, matches the line qa:catch-rate counts", () => {
    const filled = "QA-Override: pr=<PR> sha=<head12> reason=<text>"
      .replace("<PR>", "4555")
      .replace("<head12>", "0123456789ab")
      .replace("<text>", "land as-is");
    // Mirror of QA_OVERRIDE_LINE_RE in the catch-rate instrument.
    assert.match(filled, /^QA-Override:[ \t]+pr=(\d+)[ \t]+sha=([0-9a-fA-F]{7,40})[ \t]+reason=(\S.*)$/);
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

describe("autopilot qa-verdict events carry the guard's SHAs (issues #4737, #4738)", () => {
  const text = read("hydra-autopilot.md");

  test("the event-build section calls the guard and fills verdict_sha + head_sha from it", () => {
    const build = section(text, /^### Building `qa-verdict` events/m, /^##/m);
    assert.ok(build.includes(GUARD), "qa-verdict events must be built from the guard CLI");
    assert.match(build, /verdict_sha: \(\.verdictSha/, "verdict_sha comes from the guard's verdictSha");
    assert.match(build, /head_sha: \.headSha/, "head_sha comes from the guard's headSha");
    assert.match(build, /stale-verdict/, "the section names the decide.py hold it feeds");
  });

  test("the auto-merge action re-checks the guard before arming", () => {
    const row = text.split("\n").find((l) => /^\|\s*`auto-merge`\s*\|/.test(l));
    assert.ok(row, "auto-merge action row missing");
    assert.ok(row!.indexOf(GUARD) > -1 && row!.indexOf(GUARD) < row!.indexOf("gh pr merge --auto"));
  });
});
