/**
 * scripts/qa/reviewer-commit.ts (issue #5712): the lifted step-9.4 reviewer-commit
 * effect, driven through a recording fake ports object. No live gh, git or fs.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  abortReviewerCommit,
  finishReviewerCommit,
  openReviewerCommit,
  type ReviewerCommitPorts,
} from "../scripts/qa/reviewer-commit.ts";
import type { CmdResult } from "../scripts/qa/_lib.ts";

const REVIEWED = "a".repeat(40);
const FIXED = "b".repeat(40);
const OK = (stdout = ""): CmdResult => ({ ok: true, stdout });
const NO = (stderr = "boom"): CmdResult => ({ ok: false, stderr });
const BODY = "intro\n\n## Files in scope\n\n- `a.md`\n\n## Files out of scope\n\n- `z.md`\n\nCloses #1\n";
const BODY_FIXED = BODY.replace("- `a.md`\n", "- `a.md`\n- `docs/x.md`\n");

interface Env {
  /** argv-joined record of every effect, in order. */
  calls: string[];
  ports: ReviewerCommitPorts;
  files: Map<string, string>;
  staged: Set<string>;
  commits: Array<{ message: string; sha: string }>;
  proofs: Array<{ script: string; args: string[]; cwd: string }>;
  /** Mutate to script a scenario. */
  cfg: {
    live: unknown;
    pushOk: boolean;
    proofOk: boolean;
    /** Paths `git add` stages nothing for (the reviewer never edited them). */
    unedited: Set<string>;
    /** reviewed-head copy of a test path; absent key = path did not exist at the reviewed head. */
    reviewedCopies: Map<string, string | null>;
    /** `git diff --cached -U0 -- <path>` answers. */
    hunks: Map<string, string>;
    editBodyOk: boolean;
    restoreOk: boolean;
    sessionStatusAfter: string;
  };
}

function makeEnv(): Env {
  const calls: string[] = [];
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const staged = new Set<string>();
  const commits: Env["commits"] = [];
  const proofs: Env["proofs"] = [];
  const cfg: Env["cfg"] = {
    live: { headRefOid: REVIEWED, isCrossRepository: false },
    pushOk: true,
    proofOk: true,
    unedited: new Set(),
    reviewedCopies: new Map(),
    hunks: new Map(),
    editBodyOk: true,
    restoreOk: true,
    sessionStatusAfter: "",
  };
  let n = 0;
  let sessionStatus = "";
  const ports: ReviewerCommitPorts = {
    async git(args, cwd) {
      calls.push(`git ${args.join(" ")}${cwd === undefined ? "" : ` @${cwd}`}`);
      const [a, b] = args;
      if (a === "rev-parse" && b === "--git-dir") return OK("/s/.git/worktrees/agent-1");
      if (a === "rev-parse" && b === "--show-toplevel") return OK("/session");
      if (a === "rev-parse" && b === "HEAD") return OK(cwd === "/session" || cwd === undefined ? "sessionhead" : (commits.at(-1)?.sha ?? REVIEWED));
      if (a === "status") return OK(sessionStatus);
      if (a === "worktree" && b === "add") {
        dirs.add(args[3] as string);
        return OK();
      }
      if (a === "worktree" && b === "remove") {
        dirs.delete(args[3] as string);
        return OK();
      }
      if (a === "add") {
        for (const p of args.slice(2)) if (!cfg.unedited.has(p)) staged.add(p);
        return OK();
      }
      if (a === "diff" && b === "--cached" && args[2] === "--name-only") return OK([...staged].join("\n"));
      if (a === "diff" && b === "--cached") return OK(cfg.hunks.get(args[4] as string) ?? "");
      if (a === "commit") {
        const sha = `${String(++n).padStart(2, "0")}`.repeat(20);
        commits.push({ message: args.filter((x, i) => args[i - 1] === "-m").join("\n"), sha });
        staged.clear();
        return OK();
      }
      if (a === "cat-file") {
        const key = (args[2] as string).slice(REVIEWED.length + 1);
        return cfg.reviewedCopies.has(key) ? OK() : NO("missing");
      }
      if (a === "show") {
        const copy = cfg.reviewedCopies.get((args[1] as string).slice(REVIEWED.length + 1));
        return typeof copy === "string" ? OK(copy) : NO("unreadable");
      }
      if (a === "push") return cfg.pushOk ? OK() : NO("rejected");
      return OK();
    },
    async gh(args) {
      calls.push(`gh ${args.join(" ")}`);
      if (args[1] === "view" && args.includes("headRefOid,isCrossRepository")) return OK(JSON.stringify(cfg.live));
      if (args[1] === "view" && args.includes("body")) return OK(BODY);
      if (args[1] === "edit") {
        const isRestore = (args.at(-1) as string).endsWith("body.orig.md");
        return (isRestore ? cfg.restoreOk : cfg.editBodyOk) ? OK() : NO();
      }
      return OK();
    },
    async runTrusted(script, args, cwd) {
      calls.push(`proof ${args.join(" ")}`);
      proofs.push({ script, args, cwd });
      return cfg.proofOk ? OK() : NO("vacuous");
    },
    fs: {
      mkdtemp: (prefix) => {
        const d = `/tmp/${prefix}1`;
        dirs.add(d);
        return d;
      },
      read: (p) => files.get(p) ?? null,
      write: (p, text) => void files.set(p, text),
      exists: (p) => dirs.has(p) || files.has(p),
      rm: (p) => {
        calls.push(`rm ${p}`);
        for (const k of [...files.keys()]) if (k.startsWith(p)) files.delete(k);
        dirs.delete(p);
      },
      symlink: () => undefined,
    },
  };
  // The session status drifts only when a test asks it to (INV-1 assertion).
  Object.defineProperty(cfg, "sessionStatusAfter", {
    get: () => sessionStatus,
    set: (v: string) => {
      sessionStatus = v;
    },
  });
  return { calls, ports, files, staged, commits, proofs, cfg };
}

const plan = (over: Record<string, unknown> = {}) => ({
  action: "commit-a",
  reason: "class-a-fixable",
  reviewedHead: REVIEWED,
  headRef: "feature/x",
  fixedSha: FIXED,
  blockingPaths: ["docs/x.md"],
  followUpPaths: [],
  blockingTestPaths: [],
  followUpTestPaths: [],
  bodyFix: false,
  blockingLocations: ["docs/x.md:3"],
  ...over,
});

const HUNK_NEAR_3 = "--- a/docs/x.md\n+++ b/docs/x.md\n@@ -3,1 +3,1 @@\n-old\n+new\n";

async function open(env: Env, p: Record<string, unknown>) {
  const res = await openReviewerCommit({ plan: p, pr: 77, repo: "o/r" }, env.ports);
  assert.equal(res.ok, true, JSON.stringify(res));
  if (!res.ok) throw new Error("unreachable");
  return res;
}

describe("open: gate before effect (INV-2)", () => {
  test("a cross-repository PR refuses before any fetch, worktree or push", async () => {
    const env = makeEnv();
    env.cfg.live = { headRefOid: REVIEWED, isCrossRepository: true };
    const res = await openReviewerCommit({ plan: plan(), pr: 77, repo: "o/r" }, env.ports);
    assert.deepEqual(res, { ok: false, reason: "cross-repository-pr" });
    assert.ok(!env.calls.some((c) => /^git (fetch|worktree|push)/.test(c)), env.calls.join("\n"));
  });

  test("a moved head refuses with head-moved and builds nothing", async () => {
    const env = makeEnv();
    env.cfg.live = { headRefOid: "c".repeat(40), isCrossRepository: false };
    assert.deepEqual(await openReviewerCommit({ plan: plan(), pr: 77, repo: "o/r" }, env.ports), { ok: false, reason: "head-moved" });
    assert.ok(!env.calls.some((c) => c.startsWith("git worktree")));
  });

  test("an action:none plan and an unreadable PR both refuse without a read-write effect", async () => {
    const env = makeEnv();
    assert.deepEqual(await openReviewerCommit({ plan: { action: "none", reason: "stage-off" }, pr: 77, repo: "o/r" }, env.ports), {
      ok: false,
      reason: "no-plan",
    });
    assert.equal(env.calls.length, 0);
    env.cfg.live = "not an object";
    assert.deepEqual(await openReviewerCommit({ plan: plan(), pr: 77, repo: "o/r" }, env.ports), { ok: false, reason: "pr-unreadable" });
  });

  test("open builds the master worktree at fixedSha, then the detached PR worktree at the reviewed head, and seeds the body files", async () => {
    const env = makeEnv();
    const res = await open(env, plan());
    const adds = env.calls.filter((c) => c.startsWith("git worktree add"));
    assert.equal(adds.length, 2);
    assert.ok(adds[0]?.endsWith(`${res.masterWorktree} ${FIXED} @/session`));
    assert.ok(adds[1]?.endsWith(`${res.prWorktree} ${REVIEWED} @/session`));
    assert.ok(env.calls.indexOf(`git fetch origin feature/x @/session`) < env.calls.indexOf(adds[1] as string));
    assert.equal(env.files.get(res.bodyFile), BODY);
  });
});

describe("finish: the three named defects (issue #5712 group A)", () => {
  test("a successful push is final: no body restore, newHead is the last commit", async () => {
    const env = makeEnv();
    const o = await open(env, plan({ bodyFix: true, blockingLocations: ["PR body", "docs/x.md:3"] }));
    env.files.set(o.bodyFile, BODY_FIXED);
    env.cfg.hunks.set("docs/x.md", HUNK_NEAR_3);
    const res = await finishReviewerCommit(o.stateFile, env.ports);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.pushed, true);
    assert.equal(res.newHead, env.commits.at(-1)?.sha);
    assert.notEqual(res.newHead, REVIEWED);
    assert.deepEqual(res.qaFixes, env.commits.map((c) => c.sha.slice(0, 12)));
    const edits = env.calls.filter((c) => c.startsWith("gh pr edit"));
    assert.equal(edits.length, 1, "one body edit, never a restore after the push");
    assert.ok(env.calls.indexOf(edits[0] as string) < env.calls.findIndex((c) => c.startsWith("git push")), "body edit precedes the push");
  });

  test("a rejected push after the body edit restores the ORIGINAL body and reports nothing pushed", async () => {
    const env = makeEnv();
    const o = await open(env, plan({ bodyFix: true, blockingLocations: ["PR body"], blockingPaths: [] }));
    env.files.set(o.bodyFile, BODY_FIXED);
    env.cfg.pushOk = false;
    const res = await finishReviewerCommit(o.stateFile, env.ports);
    assert.equal(res.ok, false);
    assert.equal(res.reason, "push-rejected");
    assert.equal(res.pushed, false);
    const edits = env.calls.filter((c) => c.startsWith("gh pr edit"));
    assert.equal(edits.length, 2);
    assert.ok(edits[1]?.endsWith("body.orig.md"));
  });

  test("a failed body restore is surfaced loudly in the reason", async () => {
    const env = makeEnv();
    const o = await open(env, plan({ bodyFix: true, blockingLocations: ["PR body"], blockingPaths: [] }));
    env.files.set(o.bodyFile, BODY_FIXED);
    env.cfg.pushOk = false;
    env.cfg.restoreOk = false;
    const res = await finishReviewerCommit(o.stateFile, env.ports);
    assert.equal(res.bodyRestoreFailed, true);
    assert.match(res.reason ?? "", /body-restore-failed/);
  });

  test("a body-only round still makes the EMPTY `QA-Fix: A` commit", async () => {
    const env = makeEnv();
    const o = await open(env, plan({ bodyFix: true, blockingLocations: ["PR body"], blockingPaths: [] }));
    env.files.set(o.bodyFile, BODY_FIXED);
    const res = await finishReviewerCommit(o.stateFile, env.ports);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.ok(env.calls.some((c) => c.startsWith("git commit -q --allow-empty")));
  });

  test("class B: a reviewer-ADDED test file (absent at the reviewed head) has before-count 0 and never refuses", async () => {
    const env = makeEnv();
    const o = await open(env, plan({ action: "commit-b", blockingPaths: [], blockingTestPaths: ["test/new.test.mts"], blockingLocations: ["test/new.test.mts"] }));
    env.files.set(`${o.prWorktree}/test/new.test.mts`, "test('a', () => {});\n");
    const res = await finishReviewerCommit(o.stateFile, env.ports);
    assert.equal(res.ok, true, JSON.stringify(res));
  });

  test("class B: an existing file whose reviewed-head copy cannot be read refuses before-copy-unreadable", async () => {
    const env = makeEnv();
    const o = await open(env, plan({ action: "commit-b", blockingPaths: [], blockingTestPaths: ["test/old.test.mts"], blockingLocations: ["test/old.test.mts"] }));
    env.files.set(`${o.prWorktree}/test/old.test.mts`, "test('a', () => {});\n");
    env.cfg.reviewedCopies.set("test/old.test.mts", null); // cat-file says it exists, show fails
    const res = await finishReviewerCommit(o.stateFile, env.ports);
    assert.equal(res.reason, "before-copy-unreadable");
    assert.ok(!env.calls.some((c) => c.startsWith("git push")));
  });

  test("class B: lowering the case count refuses case-count-lowered", async () => {
    const env = makeEnv();
    const o = await open(env, plan({ action: "commit-b", blockingPaths: [], blockingTestPaths: ["test/old.test.mts"], blockingLocations: ["test/old.test.mts"] }));
    env.cfg.reviewedCopies.set("test/old.test.mts", "test('a', () => {});\ntest('b', () => {});\n");
    env.files.set(`${o.prWorktree}/test/old.test.mts`, "test('a', () => {});\n");
    assert.equal((await finishReviewerCommit(o.stateFile, env.ports)).reason, "case-count-lowered");
  });
});

describe("finish: proofs, commits, staging, push shape", () => {
  test("class-A-only runs two proofs (reviewedHead then fixedSha) by absolute path under the master worktree, before the push", async () => {
    const env = makeEnv();
    const o = await open(env, plan());
    env.cfg.hunks.set("docs/x.md", HUNK_NEAR_3);
    assert.equal((await finishReviewerCommit(o.stateFile, env.ports)).ok, true);
    assert.deepEqual(env.proofs.map((p) => p.args), [
      ["--base", REVIEWED, "--head", "HEAD"],
      ["--base", FIXED, "--head", "HEAD"],
    ]);
    for (const p of env.proofs) {
      assert.equal(p.script, `${o.masterWorktree}/scripts/ci/qa-fix-proof.ts`);
      assert.equal(p.cwd, o.prWorktree);
    }
    assert.ok(env.calls.map((c) => c.startsWith("proof")).lastIndexOf(true) < env.calls.findIndex((c) => c.startsWith("git push")));
  });

  test("any class-B commit runs exactly ONE proof, based on fixedSha; A commits before B with separate trailers", async () => {
    const env = makeEnv();
    const o = await open(
      env,
      plan({ action: "commit-ab", blockingTestPaths: ["test/new.test.mts"], blockingLocations: ["docs/x.md:3", "test/new.test.mts"] }),
    );
    env.cfg.hunks.set("docs/x.md", HUNK_NEAR_3);
    env.files.set(`${o.prWorktree}/test/new.test.mts`, "test('a', () => {});\n");
    const res = await finishReviewerCommit(o.stateFile, env.ports);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.deepEqual(env.proofs.map((p) => p.args), [["--base", FIXED, "--head", "HEAD"]]);
    assert.equal(env.commits.length, 2);
    assert.match(env.commits[0]?.message ?? "", /QA-Fix: A$/);
    assert.match(env.commits[1]?.message ?? "", /QA-Fix: B$/);
    assert.ok(!env.commits.some((c) => /QA-Fix: A.*B|QA-Fix: AB/.test(c.message)), "never a combined trailer");
    assert.equal(res.qaFixes.length, 2);
  });

  test("a failing proof refuses before any body edit or push", async () => {
    const env = makeEnv();
    const o = await open(env, plan({ bodyFix: true, blockingLocations: ["PR body"], blockingPaths: [] }));
    env.files.set(o.bodyFile, BODY_FIXED);
    env.cfg.proofOk = false;
    const res = await finishReviewerCommit(o.stateFile, env.ports);
    assert.equal(res.reason, "proof-failed");
    assert.ok(!env.calls.some((c) => c.startsWith("git push") || c.startsWith("gh pr edit")));
  });

  test("the push is a plain HEAD:refs/heads/<ref> refspec, never forced or `+`", async () => {
    const env = makeEnv();
    const o = await open(env, plan());
    env.cfg.hunks.set("docs/x.md", HUNK_NEAR_3);
    await finishReviewerCommit(o.stateFile, env.ports);
    const pushes = env.calls.filter((c) => c.startsWith("git push"));
    assert.equal(pushes.length, 1);
    assert.ok(pushes[0]?.startsWith("git push origin HEAD:refs/heads/feature/x @"));
    assert.ok(!/--force|\+/.test(pushes[0] as string));
  });

  test("staging never uses -A and refuses a stray staged path or an unstaged blocking path", async () => {
    const env = makeEnv();
    const o = await open(env, plan());
    env.staged.add("src/stray.ts");
    env.cfg.hunks.set("docs/x.md", HUNK_NEAR_3);
    assert.equal((await finishReviewerCommit(o.stateFile, env.ports)).reason, "unapproved-staged-path");
    assert.ok(!env.calls.some((c) => /^git add (-A|\.|--all)/.test(c)));

    const env2 = makeEnv();
    const o2 = await open(env2, plan());
    env2.cfg.unedited.add("docs/x.md");
    assert.equal((await finishReviewerCommit(o2.stateFile, env2.ports)).reason, "blocking-path-unstaged");
  });

  test("nothing staged and no body change refuses nothing-changed", async () => {
    const env = makeEnv();
    const o = await open(env, plan({ blockingPaths: [], blockingLocations: [] }));
    assert.equal((await finishReviewerCommit(o.stateFile, env.ports)).reason, "nothing-changed");
  });

  test("a claimed body fix with an unchanged body refuses body-unchanged; an out-of-scope edit refuses body-scope", async () => {
    const env = makeEnv();
    const o = await open(env, plan({ bodyFix: true, blockingLocations: ["PR body"], blockingPaths: [] }));
    assert.equal((await finishReviewerCommit(o.stateFile, env.ports)).reason, "body-unchanged");

    const env2 = makeEnv();
    const o2 = await open(env2, plan({ bodyFix: true, blockingLocations: ["PR body"], blockingPaths: [] }));
    env2.files.set(o2.bodyFile, BODY.replace("intro", "rewritten intro"));
    assert.equal((await finishReviewerCommit(o2.stateFile, env2.ports)).reason, "body-scope");
  });

  test("row re-verify uses the imported predicates: a `PR body` row is skipped, a line row needs a -U0 hunk near it", async () => {
    const env = makeEnv();
    const o = await open(env, plan({ bodyFix: false, blockingLocations: ["docs/x.md:3"] }));
    env.cfg.hunks.set("docs/x.md", "--- a/docs/x.md\n+++ b/docs/x.md\n@@ -90,1 +90,1 @@\n-old\n+new\n");
    assert.equal((await finishReviewerCommit(o.stateFile, env.ports)).reason, "row-hunk-missing");

    const env2 = makeEnv();
    const o2 = await open(env2, plan({ blockingLocations: ["PR body", "docs/x.md:3"] }));
    env2.cfg.hunks.set("docs/x.md", HUNK_NEAR_3);
    assert.equal((await finishReviewerCommit(o2.stateFile, env2.ports)).ok, true);
  });

  test("a non-path class-A row refuses row-location-unparseable", async () => {
    const env = makeEnv();
    const o = await open(env, plan({ blockingLocations: ["somewhere vague"] }));
    assert.equal((await finishReviewerCommit(o.stateFile, env.ports)).reason, "row-location-unparseable");
  });
});

describe("cleanup on every path (INV-1, INV-10)", () => {
  const removes = (env: Env) => env.calls.filter((c) => c.startsWith("git worktree remove -f"));

  test("success, refusal and abort each remove both worktrees and the work root", async () => {
    for (const mode of ["success", "refusal", "abort"] as const) {
      const env = makeEnv();
      const o = await open(env, plan());
      env.cfg.hunks.set("docs/x.md", HUNK_NEAR_3);
      if (mode === "refusal") env.cfg.proofOk = false;
      if (mode === "abort") assert.equal((await abortReviewerCommit(o.stateFile, env.ports)).ok, true);
      else await finishReviewerCommit(o.stateFile, env.ports);
      assert.equal(removes(env).length, 2, mode);
      assert.ok(env.calls.some((c) => c.startsWith("rm /tmp/qa-reviewer-commit-")), mode);
      assert.ok(!env.calls.some((c) => c.startsWith("git push")) || mode === "success", mode);
    }
  });

  test("a session tree whose status changed is reported as a warning, never swallowed", async () => {
    const env = makeEnv();
    const o = await open(env, plan());
    env.cfg.hunks.set("docs/x.md", HUNK_NEAR_3);
    env.cfg.sessionStatusAfter = " M src/dirty.ts";
    const res = await finishReviewerCommit(o.stateFile, env.ports);
    assert.ok(res.warnings?.includes("session-status-changed"));
  });

  test("a missing or malformed state file refuses state-unreadable", async () => {
    const env = makeEnv();
    assert.equal((await finishReviewerCommit("/nope", env.ports)).reason, "state-unreadable");
    assert.equal((await abortReviewerCommit("/nope", env.ports)).reason, "state-unreadable");
  });
});
