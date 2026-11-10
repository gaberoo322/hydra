/**
 * test/qa-fix-proof.test.mts — reviewer-commit proof (issue #5266,
 * ADR-0046 Decision 2): path classes, commit evaluation, TAP assertion proof,
 * the `QA-Fix:` commit trailer, and the CLI contract.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  classifyQaFixPath,
  evaluateQaFixProof,
  parseTapAssertionProof,
  type QaFixCommit,
} from "../src/qa/fix-proof.ts";
import { parseQaFixCommitTrailer } from "../src/qa/verdict-trailer.ts";
import {
  changedTestWarning,
  classifyChangedTestProof,
  hasTapEvidence,
  diffAddsTestCase,
  parseGitLog,
  selectChangedTestCandidates,
} from "../scripts/ci/qa-fix-proof.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");

function commit(sha: string, trailer: string | null, paths: string[]): QaFixCommit {
  return {
    sha,
    message: `fix: thing\n\nbody${trailer === null ? "" : `\n\n${trailer}`}\n`,
    paths,
  };
}

describe("qa-fix-proof — QA-Fix commit trailer", () => {
  test("parses A and B", () => {
    assert.deepEqual(parseQaFixCommitTrailer("x\n\nQA-Fix: A\n"), { present: true, cls: "A", raw: "A" });
    assert.deepEqual(parseQaFixCommitTrailer("x\n\nQA-Fix: B"), { present: true, cls: "B", raw: "B" });
  });
  test("malformed values are present with cls null (never silently ignored)", () => {
    for (const v of ["C", "", "a", "AB"]) {
      const t = parseQaFixCommitTrailer(`x\n\nQA-Fix: ${v}\n`);
      assert.equal(t.present, true);
      assert.equal(t.present && t.cls, null);
    }
  });
  test("absent / mid-line mention is not a trailer; never throws on junk", () => {
    assert.deepEqual(parseQaFixCommitTrailer("no trailer"), { present: false });
    assert.deepEqual(parseQaFixCommitTrailer("see QA-Fix: A inline"), { present: false });
    assert.deepEqual(parseQaFixCommitTrailer(null), { present: false });
    assert.deepEqual(parseQaFixCommitTrailer(undefined), { present: false });
  });
});

describe("qa-fix-proof — classifyQaFixPath table", () => {
  const rows: Array<[string, string]> = [
    ["docs/reference.md", "A"],
    ["CLAUDE.md", "A"],
    ["CODING_STANDARDS.md", "deny"],
    ["docs/operator-playbooks/hydra-autopilot.md", "deny"],
    ["docs/adr/0046-x.md", "deny"],
    ["config/orchestrator/vision.md", "deny"],
    ["src/qa/CONTEXT.md", "deny"],
    [".claude/skills/x/SKILL.md", "deny"],
    ["README.md", "A"],
    [".changelog/5266-x.md", "A"],
    ["docs/generated/ci-gates.json", "A"],
    ["test/fixtures/coding-standards-baseline.json", "A"],
    ["test/fixtures/suite-count-baseline.json", "AB"],
    ["test/fixtures/test-source-read-baseline.json", "AB"],
    ["test/foo.test.mts", "B"],
    ["./test/foo.test.mts", "B"],
    ["test/helpers/x.test.mts", "deny"],
    ["test/helpers/redis.mts", "deny"],
    ["test/fixtures/qa-cohort-baseline.json", "deny"],
    ["config/orchestrator/qa-rollout.json", "deny"],
    ["src/qa/fold.ts", "deny"],
    ["scripts/ci/x.ts", "deny"],
    [".github/workflows/qa-fix-proof.yml", "deny"],
    ["package.json", "deny"],
    ["package-lock.json", "deny"],
    ["dashboard/src/a.tsx", "deny"],
    [".github/workflows/ci.yml", "deny"],
    ["src/untouchable.ts", "deny"],
    ["", "deny"],
  ];
  for (const [path, cls] of rows) {
    test(`${path || "(empty)"} -> ${cls}`, () => {
      assert.equal(classifyQaFixPath(path), cls);
    });
  }
});

describe("qa-fix-proof — evaluateQaFixProof", () => {
  test("no QA-Fix commits -> fast-path pass", () => {
    const r = evaluateQaFixProof({
      commits: [commit("a1", null, ["src/x.ts"])],
      changedFiles: ["src/x.ts"],
      stage: "off",
    });
    assert.equal(r.ok, true);
    assert.equal(r.reason, "no-qa-fix-commits");
  });

  test("class A docs commit passes at stage A and A+B", () => {
    for (const stage of ["A", "A+B"] as const) {
      const r = evaluateQaFixProof({
        commits: [commit("a1", "QA-Fix: A", ["docs/reference.md", ".changelog/1-x.md"])],
        changedFiles: ["src/x.ts", "docs/reference.md"],
        stage,
      });
      assert.equal(r.ok, true, stage);
      assert.deepEqual(r.qaFixCommits, ["a1"]);
    }
  });

  test("stage off rejects any QA-Fix commit", () => {
    const r = evaluateQaFixProof({
      commits: [commit("a1", "QA-Fix: A", ["docs/reference.md"])],
      changedFiles: [],
      stage: "off",
    });
    assert.equal(r.ok, false);
    assert.equal(r.violations[0]?.reason, "stage-off");
  });

  test("stage A rejects class B; A+B accepts and lists test files", () => {
    const c = commit("b1", "QA-Fix: B", ["test/a.test.mts", "test/fixtures/suite-count-baseline.json"]);
    const a = evaluateQaFixProof({ commits: [c], changedFiles: [], stage: "A" });
    assert.equal(a.ok, false);
    assert.equal(a.violations[0]?.reason, "class-b-not-permitted");
    const ab = evaluateQaFixProof({ commits: [c], changedFiles: [], stage: "A+B" });
    assert.equal(ab.ok, true);
    assert.deepEqual(ab.classBTestFiles, ["test/a.test.mts"]);
  });

  test("production code in a QA-Fix commit is a deny-path violation", () => {
    const r = evaluateQaFixProof({
      commits: [commit("a1", "QA-Fix: A", ["docs/reference.md", "src/x.ts"])],
      changedFiles: [],
      stage: "A+B",
    });
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((v) => v.reason === "deny-path" && v.path === "src/x.ts"));
  });

  test("Verifier Core path in a QA-Fix commit is denied", () => {
    const r = evaluateQaFixProof({
      commits: [commit("a1", "QA-Fix: B", [".github/workflows/ci.yml"])],
      changedFiles: [],
      stage: "A+B",
    });
    assert.equal(r.ok, false);
    assert.equal(r.violations[0]?.reason, "deny-path");
  });

  test("class/path mismatch both ways", () => {
    const a = evaluateQaFixProof({
      commits: [commit("a1", "QA-Fix: A", ["test/a.test.mts"])],
      changedFiles: [],
      stage: "A+B",
    });
    assert.equal(a.violations[0]?.reason, "wrong-class-path");
    const b = evaluateQaFixProof({
      commits: [commit("b1", "QA-Fix: B", ["docs/x.md"])],
      changedFiles: [],
      stage: "A+B",
    });
    assert.equal(b.violations[0]?.reason, "wrong-class-path");
  });

  test("malformed trailer value is a violation", () => {
    const r = evaluateQaFixProof({
      commits: [commit("a1", "QA-Fix: C", ["docs/x.md"])],
      changedFiles: [],
      stage: "A+B",
    });
    assert.equal(r.ok, false);
    assert.equal(r.violations[0]?.reason, "malformed-trailer");
  });

  test("a PR whose diff touches Verifier Core may carry no QA-Fix commit", () => {
    const r = evaluateQaFixProof({
      commits: [commit("a1", "QA-Fix: A", ["docs/x.md"])],
      changedFiles: ["src/untouchable.ts", "docs/x.md"],
      stage: "A+B",
    });
    assert.equal(r.ok, false);
    assert.equal(r.violations[0]?.reason, "verifier-core-pr");
  });

  test("never throws on junk input", () => {
    assert.doesNotThrow(() =>
      evaluateQaFixProof({ commits: undefined as never, changedFiles: undefined as never, stage: "off" }),
    );
  });
});

describe("qa-fix-proof — parseTapAssertionProof", () => {
  const F = "test/new.test.mts";
  const assertTap = `TAP version 13
not ok 1 - assertion fails
  ---
  duration_ms: 1
  location: '/tmp/wt/${F}:5:1'
  failureType: 'testCodeFailure'
  error: 'expected 1 to equal 2'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  ...
1..1
`;
  const crashTap = `TAP version 13
not ok 1 - /tmp/wt/${F}
  ---
  duration_ms: 40
  location: '/tmp/wt/${F}:1:1'
  failureType: 'testCodeFailure'
  exitCode: 1
  error: 'test failed'
  code: 'ERR_TEST_FAILURE'
  ...
1..1
`;
  const throwTap = `TAP version 13
not ok 1 - throws plain
  ---
  location: '/tmp/wt/${F}:5:1'
  error: 'boom'
  code: 'ERR_TEST_FAILURE'
  ...
1..1
`;
  const passTap = `TAP version 13
ok 1 - passes
  ---
  location: '/tmp/wt/${F}:5:1'
  ...
1..1
`;

  test("ERR_ASSERTION failure is proven", () => {
    const r = parseTapAssertionProof(assertTap, [F]);
    assert.equal(r.ok, true);
    assert.equal(r.files[F]?.assertionFailures, 1);
  });
  test("file-level import crash (exitCode) is unproven", () => {
    const r = parseTapAssertionProof(crashTap, [F]);
    assert.equal(r.ok, false);
    assert.equal(r.files[F]?.crashed, true);
  });
  test("plain throw is unproven", () => {
    assert.equal(parseTapAssertionProof(throwTap, [F]).ok, false);
  });
  test("a file that passes at the merge-base is unproven", () => {
    assert.deepEqual(parseTapAssertionProof(passTap, [F]).unproven, [F]);
  });
  test("assertion plus a crash entry in the same file is unproven", () => {
    assert.equal(parseTapAssertionProof(assertTap + crashTap, [F]).ok, false);
  });
  test("empty / junk TAP is unproven and never throws", () => {
    assert.equal(parseTapAssertionProof("", [F]).ok, false);
    assert.equal(parseTapAssertionProof(null, [F]).ok, false);
  });
  test("each file is proven independently", () => {
    const G = "test/other.test.mts";
    const r = parseTapAssertionProof(assertTap, [F, G]);
    assert.deepEqual(r.unproven, [G]);
  });
});

describe("qa-fix-proof — parseGitLog", () => {
  test("splits records into sha + message", () => {
    const out = "aaa\x1ffix: a\n\nQA-Fix: A\n\x1e\nbbb\x1ffix: b\n\x1e";
    const commits = parseGitLog(out);
    assert.deepEqual(commits.map((c) => c.sha), ["aaa", "bbb"]);
    assert.equal(parseQaFixCommitTrailer(commits[0]?.message).present, true);
    assert.equal(parseQaFixCommitTrailer(commits[1]?.message).present, false);
  });
});

describe("qa-fix-proof — CLI contract", () => {
  const CLI = join(REPO_ROOT, "scripts", "ci", "qa-fix-proof.ts");
  test("missing --base/--head exits 2 (usage)", () => {
    const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", CLI], {
      encoding: "utf8",
    });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /usage: qa-fix-proof\.ts --base/);
  });
  test("an unresolvable ref fails closed with proof-run-failed (exit 1)", () => {
    const r = spawnSync(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", CLI, "--base", "deadbeef", "--head", "deadbeef"],
      { encoding: "utf8", cwd: REPO_ROOT },
    );
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, /proof-run-failed/);
  });
});

// The CLI's proof run spawns `node --test`; inside this test run NODE_TEST_CONTEXT would make it a silent subprocess reporter.
const cleanEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
};

describe("qa-fix-proof — CLI against a real temp git repo (INV-9/INV-10/INV-11)", () => {
  const CLI = join(REPO_ROOT, "scripts", "ci", "qa-fix-proof.ts");
  const run = (cwd: string, base: string, head: string) =>
    spawnSync(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", CLI, "--base", base, "--head", head],
      { encoding: "utf8", cwd, env: cleanEnv() },
    );
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
      cwd,
      encoding: "utf8",
    }).trim();
  const put = (dir: string, rel: string, body: string) => {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), body);
  };
  const mkRepo = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "qa-fix-proof-test-"));
    git(dir, "init", "-q", "-b", "master");
    put(dir, "README.md", "base\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    return dir;
  };

  test("no QA-Fix commit -> fast path exit 0 (no-qa-fix-commits)", () => {
    const dir = mkRepo();
    try {
      const base = git(dir, "rev-parse", "HEAD");
      put(dir, "src/x.ts", "export {};\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "feat: x");
      const r = run(dir, base, git(dir, "rev-parse", "HEAD"));
      assert.equal(r.status, 0, r.stderr);
      assert.equal(JSON.parse(r.stdout).reason, "no-qa-fix-commits");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a rollout config added only on the PR head does NOT enable the stage (read at BASE)", () => {
    const dir = mkRepo();
    try {
      const base = git(dir, "rev-parse", "HEAD");
      put(dir, "config/orchestrator/qa-rollout.json", JSON.stringify({ "reviewer-commits": "A+B" }));
      put(dir, "docs/note.md", "hi\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "docs: note\n\nQA-Fix: A");
      const r = run(dir, base, git(dir, "rev-parse", "HEAD"));
      assert.equal(r.status, 1, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.stage, "off");
      assert.ok(out.violations.some((v: { reason: string }) => v.reason === "stage-off"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const seedB = (dir: string) => {
    put(dir, "config/orchestrator/qa-rollout.json", JSON.stringify({ "reviewer-commits": "A+B" }));
    put(
      dir,
      "package.json",
      JSON.stringify({ scripts: { "test:file": "node --experimental-strip-types --test --test-force-exit --test-reporter=tap" } }),
    );
    put(dir, "test/fixtures/qa-cohort-baseline.json", JSON.stringify({ metrics: { tripped: false } }));
    put(dir, "src/mod.ts", "export const v = 1;\n");
  };

  test("a class-B commit that deletes a test file is a violation (class-b-deletes-test), not a silent pass", () => {
    const dir = mkRepo();
    try {
      seedB(dir);
      put(dir, "test/gone.test.mts", "export {};\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "seed");
      const base = git(dir, "rev-parse", "HEAD");
      git(dir, "rm", "-q", "test/gone.test.mts");
      git(dir, "commit", "-q", "-m", "test: drop\n\nQA-Fix: B");
      const r = run(dir, base, git(dir, "rev-parse", "HEAD"));
      assert.equal(r.status, 1, r.stderr);
      assert.equal(JSON.parse(r.stdout).reason, "class-b-deletes-test");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("INV-10: a class-B test that fails by ASSERTION at the merge-base is proven (exit 0)", () => {
    const dir = mkRepo();
    try {
      seedB(dir);
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "seed");
      const base = git(dir, "rev-parse", "HEAD");
      put(dir, "src/mod.ts", "export const v = 2;\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "fix: v");
      put(
        dir,
        "test/new.test.mts",
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { v } from "../src/mod.ts";\ntest("v is 2", () => { assert.equal(v, 2); });\n',
      );
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "test: pin v\n\nQA-Fix: B");
      const r = run(dir, base, git(dir, "rev-parse", "HEAD"));
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.equal(JSON.parse(r.stdout).proof.ok, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("INV-10 sibling: a class-B test that fails by import error at the merge-base is unproven (exit 1)", () => {
    const dir = mkRepo();
    try {
      seedB(dir);
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "seed");
      const base = git(dir, "rev-parse", "HEAD");
      put(dir, "src/added.ts", "export const w = 1;\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "feat: w");
      put(
        dir,
        "test/new.test.mts",
        'import test from "node:test";\nimport { w } from "../src/added.ts";\ntest("w", () => { if (!w) throw new Error("x"); });\n',
      );
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "test: pin w\n\nQA-Fix: B");
      const r = run(dir, base, git(dir, "rev-parse", "HEAD"));
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.equal(JSON.parse(r.stdout).reason, "unproven");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("qa-fix-proof CLI entrypoint guard (#5266 round 3)", () => {
  test("invoked via a symlinked path with a space still runs (usage exit 2, not silent 0)", () => {
    const dir = mkdtempSync(join(tmpdir(), "qfp link-"));
    try {
      const link = join(dir, "qa fix proof.ts");
      symlinkSync(join(REPO_ROOT, "scripts/ci/qa-fix-proof.ts"), link);
      const r = spawnSync(
        process.execPath,
        ["--no-warnings", "--experimental-strip-types", link],
        { encoding: "utf8", cwd: REPO_ROOT },
      );
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /usage/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("qa-fix-proof — changed-tests mode (#5447)", () => {
  test("selectChangedTestCandidates: added always, modified only with a new case, helpers/deleted/renamed never", () => {
    const sel = selectChangedTestCandidates([
      { status: "A", path: "test/new.test.mts", addsCase: false },
      { status: "M", path: "test/with-case.test.mts", addsCase: true },
      { status: "M", path: "test/refactor.test.mts", addsCase: false },
      { status: "A", path: "test/helpers/h.mts", addsCase: false },
      { status: "D", path: "test/gone.test.mts", addsCase: false },
      { status: "R", path: "test/renamed.test.mts", addsCase: false },
      { status: "A", path: "test/fixtures/f.json", addsCase: false },
    ]);
    assert.deepEqual(sel.candidates, ["test/new.test.mts", "test/with-case.test.mts"]);
    assert.deepEqual(sel.skipped, [{ path: "test/refactor.test.mts", reason: "no-new-case" }]);
    assert.ok(sel.overlay.includes("test/helpers/h.mts"));
    assert.ok(sel.overlay.includes("test/fixtures/f.json"));
    assert.ok(!sel.overlay.includes("test/gone.test.mts"));
  });

  test("diffAddsTestCase matches only added test(/it( lines", () => {
    assert.equal(diffAddsTestCase('@@ -1 +1,2 @@\n+  test("x", () => {})\n'), true);
    assert.equal(diffAddsTestCase('@@ -1 +1 @@\n+  it("y", () => {})\n'), true);
    assert.equal(diffAddsTestCase('@@ -1 +1 @@\n-  test("x", () => {})\n+  const a = 1;\n'), false);
  });

  test("classifyChangedTestProof: assertion=proven, crash=inconclusive, neither=passes-at-merge-base", () => {
    const files = ["test/a.test.mts", "test/b.test.mts", "test/c.test.mts"];
    const tap = parseTapAssertionProof(
      [
        "not ok 1 - test/a.test.mts",
        "  ---",
        "  code: 'ERR_ASSERTION'",
        "  location: 'test/a.test.mts:3:1'",
        "  ...",
        "not ok 2 - test/b.test.mts",
        "  ---",
        "  location: 'test/b.test.mts'",
        "  exitCode: 1",
        "  ...",
        "ok 3 - test/c.test.mts",
      ].join("\n"),
      files,
    );
    const c = classifyChangedTestProof(tap, files);
    assert.deepEqual(c.proven, ["test/a.test.mts"]);
    assert.deepEqual(c.inconclusive, ["test/b.test.mts"]);
    assert.deepEqual(c.passesAtMergeBase, ["test/c.test.mts"]);
  });

  test("hasTapEvidence: empty/garbled output is no evidence; ok/not ok headers are", () => {
    assert.equal(hasTapEvidence(""), false);
    assert.equal(hasTapEvidence(null), false);
    assert.equal(hasTapEvidence("garbled npm noise\nnothing here"), false);
    assert.equal(hasTapEvidence("ok 1 - test/c.test.mts\n"), true);
    assert.equal(hasTapEvidence("not ok 2 - test/c.test.mts\n"), true);
  });

  test("finding wording names both readings and never asserts vacuity", () => {
    const w = changedTestWarning("test/x.test.mts");
    assert.match(w, /^::warning file=test\/x\.test\.mts::/);
    assert.match(w, /already true on master/);
    assert.doesNotMatch(w, /vacuous/i);
  });

  const CLI = join(REPO_ROOT, "scripts", "ci", "qa-fix-proof.ts");
  const runMode = (cwd: string, base: string, head: string, mode = "changed-tests") =>
    spawnSync(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", CLI, "--mode", mode, "--base", base, "--head", head],
      { encoding: "utf8", cwd, env: cleanEnv() },
    );
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
      cwd,
      encoding: "utf8",
    }).trim();
  const put = (dir: string, rel: string, body: string) => {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), body);
  };

  test("an unknown --mode exits 2 (usage)", () => {
    const r = runMode(REPO_ROOT, "a", "b", "bogus");
    assert.equal(r.status, 2, r.stderr);
  });

  test("an infrastructure failure still exits 0 with a ::warning:: naming the cause", () => {
    const r = runMode(REPO_ROOT, "deadbeef", "deadbeef");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /::warning::test-can-fail proof could not run/);
  });

  test("end to end: a runner that emits no TAP is inconclusive + warned, never passes-at-merge-base", () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-fix-proof-notap-"));
    try {
      git(dir, "init", "-q", "-b", "master");
      put(dir, "package.json", JSON.stringify({ scripts: { "test:file": "node -e 0" } }));
      put(dir, "src/mod.ts", "export const v = 1;\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "base");
      const base = git(dir, "rev-parse", "HEAD");
      put(dir, "test/new.test.mts", 'import test from "node:test";\ntest("x", () => {});\n');
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "feat");
      const r = runMode(dir, base, git(dir, "rev-parse", "HEAD"));
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const lines = r.stdout.trim().split("\n");
      const out = JSON.parse(lines[lines.length - 1] as string);
      assert.equal(out.files["test/new.test.mts"].outcome, "inconclusive");
      assert.deepEqual(out.findings, []);
      assert.match(r.stdout, /::warning::test-can-fail proof produced no TAP/);
      assert.doesNotMatch(r.stdout, /already true on master/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("end to end: proven / inconclusive / passes-at-merge-base / skipped, always exit 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-fix-proof-ct-"));
    try {
      git(dir, "init", "-q", "-b", "master");
      put(
        dir,
        "package.json",
        JSON.stringify({ scripts: { "test:file": "node --experimental-strip-types --test --test-force-exit --test-reporter=tap" } }),
      );
      put(dir, "src/mod.ts", "export const v = 1;\n");
      put(dir, "test/existing.test.mts", 'import test from "node:test";\ntest("old", () => {});\n');
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "base");
      const base = git(dir, "rev-parse", "HEAD");
      put(dir, "src/mod.ts", "export const v = 2;\n");
      put(dir, "src/added.ts", "export const w = 1;\n");
      const hdr = 'import test from "node:test";\nimport assert from "node:assert/strict";\n';
      put(dir, "test/proven.test.mts", hdr + 'import { v } from "../src/mod.ts";\ntest("v is 2", () => { assert.equal(v, 2); });\n');
      put(dir, "test/vacuous.test.mts", hdr + 'test("always", () => { assert.equal(1, 1); });\n');
      put(dir, "test/crash.test.mts", hdr + 'import { w } from "../src/added.ts";\ntest("w", () => { assert.equal(w, 1); });\n');
      put(dir, "test/existing.test.mts", 'import test from "node:test";\n// comment only\ntest("old", () => {});\n');
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "feat");
      const r = runMode(dir, base, git(dir, "rev-parse", "HEAD"));
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const lines = r.stdout.trim().split("\n");
      const out = JSON.parse(lines[lines.length - 1] as string);
      assert.equal(out.files["test/proven.test.mts"].outcome, "proven");
      assert.equal(out.files["test/vacuous.test.mts"].outcome, "passes-at-merge-base");
      assert.equal(out.files["test/crash.test.mts"].outcome, "inconclusive");
      assert.deepEqual(out.findings, ["test/vacuous.test.mts"]);
      assert.deepEqual(out.skipped, [{ path: "test/existing.test.mts", reason: "no-new-case" }]);
      assert.match(r.stdout, /::warning file=test\/vacuous\.test\.mts::/);
      assert.doesNotMatch(r.stdout, /::warning file=test\/proven/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
