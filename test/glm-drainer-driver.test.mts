/**
 * test/glm-drainer-driver.test.mts — pin `runDriverMode`, the GLM dev-drainer
 * bash↔TypeScript bridge that replaced the `write_node_driver()` heredoc
 * inside `scripts/glm/drainer-loop.sh` (issue #4371).
 *
 * Every case drives an INJECTED `DriverDeps` object — no live Redis, no live
 * `claude` spawn, no filesystem read beyond an in-memory fake — so this suite
 * exercises the three modes' control flow (heartbeat / preflight / author)
 * plus the bad-argv and driver-fault arms as an ordinary TypeScript unit,
 * exactly the leverage the issue asks for (mirrors
 * `test/glm-drainer-runner.test.mts`'s technique for the sibling module).
 *
 * New top-level describe with its own trivial lifecycle — it touches no
 * shared Redis seam, so it never piggybacks a sibling suite's teardown.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  runDriverMode,
  isDriverFailure,
  type DriverDeps,
} from "../src/glm/drainer-driver.ts";
import { ClaudeCliTimeoutError, type SpawnFn } from "../src/claude-cli/exec.ts";
import { loadDrainerConfig } from "../src/glm/drainer-config.ts";
import type { GateDeps } from "../src/glm/gate.ts";
import type { PickDeps } from "../src/glm/pick.ts";
import type { FinishDeps } from "../src/glm/finish.ts";
import type { TickDeps } from "../src/glm/drainer-driver.ts";

/** A spawn stub that fails loudly if it is ever actually invoked. */
const unusedSpawn: SpawnFn = (() => {
  throw new Error("spawn should never be invoked directly by runDriverMode");
}) as unknown as SpawnFn;

/** Base fake deps: every call is a no-op success unless overridden. */
function makeDeps(overrides: Partial<DriverDeps> = {}): DriverDeps {
  return {
    setGlmDrainerHeartbeat: (async () => ({ ok: true }) as any) as DriverDeps["setGlmDrainerHeartbeat"],
    preflightBeforePr: (async () => ({ ok: true, checkedPaths: 0 })) as DriverDeps["preflightBeforePr"],
    buildGlmEnv: (() => ({ ok: true, env: {} })) as DriverDeps["buildGlmEnv"],
    buildDrainerArgs: (() => ({ ok: true, args: [] })) as DriverDeps["buildDrainerArgs"],
    runGlmClaude: (async () => ({ code: 0, stdout: "", stderr: "" })) as DriverDeps["runGlmClaude"],
    spawn: unusedSpawn,
    readFile: () => "",
    env: {},
    apiTimeoutMs: 1000,
    ...overrides,
  };
}

describe("src/glm/drainer-driver.ts — runDriverMode (issue #4371)", () => {
  test("heartbeat: ok:true result -> exit 0, line is the JSON result", async () => {
    const deps = makeDeps({
      setGlmDrainerHeartbeat: (async () => ({ ok: true })) as DriverDeps["setGlmDrainerHeartbeat"],
    });
    const outcome = await runDriverMode(["heartbeat"], deps);
    assert.equal(outcome.ok, true);
    assert.ok(!isDriverFailure(outcome));
    if (!isDriverFailure(outcome)) {
      assert.equal(outcome.exitCode, 0);
      assert.deepEqual(JSON.parse(outcome.line), { ok: true });
    }
  });

  test("heartbeat: ok:false result -> exit 1, line still carries the result", async () => {
    const deps = makeDeps({
      setGlmDrainerHeartbeat: (async () => ({
        ok: false,
        code: "glm-heartbeat-write-failed",
        message: "redis down",
      })) as DriverDeps["setGlmDrainerHeartbeat"],
    });
    const outcome = await runDriverMode(["heartbeat"], deps);
    assert.equal(outcome.ok, true); // driver itself did not fault
    if (!isDriverFailure(outcome)) {
      assert.equal(outcome.exitCode, 1);
      assert.deepEqual(JSON.parse(outcome.line), {
        ok: false,
        code: "glm-heartbeat-write-failed",
        message: "redis down",
      });
    }
  });

  test("preflight: reads/trims/blank-filters the changed-files file, exits 0 on an ok:true verdict", async () => {
    let capturedPaths: readonly string[] | undefined;
    const deps = makeDeps({
      readFile: () => "src/a.ts\n  src/b.ts  \n\n\n",
      preflightBeforePr: (async (options) => {
        capturedPaths = options.changedPaths;
        return { ok: true, checkedPaths: options.changedPaths.length };
      }) as DriverDeps["preflightBeforePr"],
    });
    const outcome = await runDriverMode(["preflight", "/fake/changed.txt"], deps);
    assert.deepEqual(capturedPaths, ["src/a.ts", "src/b.ts"]);
    if (!isDriverFailure(outcome)) {
      assert.equal(outcome.exitCode, 0);
      assert.deepEqual(JSON.parse(outcome.line), { ok: true, checkedPaths: 2 });
    } else {
      assert.fail("expected a success outcome");
    }
  });

  test("preflight: exits 0 even on a BLOCKED (ok:false) verdict — a completed check, not a driver fault", async () => {
    const deps = makeDeps({
      readFile: () => "src/untouchable.ts\n",
      preflightBeforePr: (async () => ({
        ok: false,
        code: "glm-preflight-blocked",
        violations: [{ kind: "verifier-core", path: "src/untouchable.ts", matched: "src/untouchable.ts" }],
        message: "blocked",
      })) as DriverDeps["preflightBeforePr"],
    });
    const outcome = await runDriverMode(["preflight", "/fake/changed.txt"], deps);
    assert.ok(!isDriverFailure(outcome), "a blocked preflight verdict is not a driver fault");
    if (!isDriverFailure(outcome)) {
      assert.equal(outcome.exitCode, 0);
      const parsed = JSON.parse(outcome.line);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.code, "glm-preflight-blocked");
    }
  });

  test("preflight: missing <changed-files-file> arg -> glm-driver-bad-argv", async () => {
    const deps = makeDeps();
    const outcome = await runDriverMode(["preflight"], deps);
    assert.ok(isDriverFailure(outcome));
    if (isDriverFailure(outcome)) {
      assert.equal(outcome.code, "glm-driver-bad-argv");
      assert.match(outcome.message, /changed-files-file/);
    }
  });

  test("author: buildGlmEnv failure -> ok:false JSON with NO spawn, exit 0", async () => {
    let runGlmClaudeCalls = 0;
    const deps = makeDeps({
      readFile: () => "prompt text",
      buildGlmEnv: (() => ({
        ok: false,
        code: "glm-auth-token-missing",
        message: "ANTHROPIC_AUTH_TOKEN is unset",
      })) as DriverDeps["buildGlmEnv"],
      runGlmClaude: (async () => {
        runGlmClaudeCalls++;
        return { code: 0, stdout: "", stderr: "" };
      }) as DriverDeps["runGlmClaude"],
    });
    const outcome = await runDriverMode(["author", "/fake/prompt.txt", "/fake/wt"], deps);
    assert.equal(runGlmClaudeCalls, 0, "spawn/runGlmClaude must never be invoked on a buildGlmEnv failure");
    if (!isDriverFailure(outcome)) {
      assert.equal(outcome.exitCode, 0);
      assert.deepEqual(JSON.parse(outcome.line), {
        ok: false,
        code: "glm-auth-token-missing",
        message: "ANTHROPIC_AUTH_TOKEN is unset",
      });
    } else {
      assert.fail("expected a success outcome (driver itself did not fault)");
    }
  });

  test("author: buildDrainerArgs failure -> ok:false JSON with NO spawn, exit 0", async () => {
    let runGlmClaudeCalls = 0;
    const deps = makeDeps({
      readFile: () => "prompt text",
      buildDrainerArgs: (() => ({
        ok: false,
        code: "glm-model-would-route-first-party",
        message: "refusing to route first-party",
      })) as DriverDeps["buildDrainerArgs"],
      runGlmClaude: (async () => {
        runGlmClaudeCalls++;
        return { code: 0, stdout: "", stderr: "" };
      }) as DriverDeps["runGlmClaude"],
    });
    const outcome = await runDriverMode(["author", "/fake/prompt.txt", "/fake/wt"], deps);
    assert.equal(runGlmClaudeCalls, 0, "spawn/runGlmClaude must never be invoked on a buildDrainerArgs failure");
    if (!isDriverFailure(outcome)) {
      assert.equal(outcome.exitCode, 0);
      assert.deepEqual(JSON.parse(outcome.line), {
        ok: false,
        code: "glm-model-would-route-first-party",
        message: "refusing to route first-party",
      });
    } else {
      assert.fail("expected a success outcome (driver itself did not fault)");
    }
  });

  test("author: success -> ok:true JSON, stdout/stderr tail-truncated to 4000 chars", async () => {
    const longStdout = "o".repeat(5000);
    const longStderr = "e".repeat(5000);
    const deps = makeDeps({
      readFile: () => "prompt text",
      runGlmClaude: (async () => ({ code: 0, stdout: longStdout, stderr: longStderr })) as DriverDeps["runGlmClaude"],
    });
    const outcome = await runDriverMode(["author", "/fake/prompt.txt", "/fake/wt"], deps);
    if (!isDriverFailure(outcome)) {
      assert.equal(outcome.exitCode, 0);
      const parsed = JSON.parse(outcome.line);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.code, 0);
      assert.equal(parsed.stdout, longStdout.slice(-4000));
      assert.equal(parsed.stderr, longStderr.slice(-4000));
      assert.equal(parsed.stdout.length, 4000);
    } else {
      assert.fail("expected a success outcome");
    }
  });

  test("author: missing <prompt-file>/<cwd> args -> glm-driver-bad-argv", async () => {
    const deps = makeDeps();
    const outcome = await runDriverMode(["author", "/fake/prompt.txt"], deps);
    assert.ok(isDriverFailure(outcome));
    if (isDriverFailure(outcome)) {
      assert.equal(outcome.code, "glm-driver-bad-argv");
      assert.match(outcome.message, /prompt-file/);
    }
  });

  test("unknown mode -> glm-driver-bad-argv, no stack (never a thrown Error)", async () => {
    const deps = makeDeps();
    const outcome = await runDriverMode(["no-such-mode"], deps);
    assert.ok(isDriverFailure(outcome));
    if (isDriverFailure(outcome)) {
      assert.equal(outcome.code, "glm-driver-bad-argv");
      assert.match(outcome.message, /unknown mode: no-such-mode/);
      assert.equal(outcome.stack, undefined);
    }
  });

  test("a rejecting dependency never throws out of runDriverMode -> glm-driver-fault, stack preserved", async () => {
    const deps = makeDeps({
      setGlmDrainerHeartbeat: (async () => {
        throw new Error("kaboom");
      }) as DriverDeps["setGlmDrainerHeartbeat"],
    });
    const outcome = await runDriverMode(["heartbeat"], deps);
    assert.ok(isDriverFailure(outcome));
    if (isDriverFailure(outcome)) {
      assert.equal(outcome.code, "glm-driver-fault");
      assert.match(outcome.message, /kaboom/);
      // The original heredoc's `main().catch` wrote `err.stack` to stderr,
      // not just `err.message` — pin that the full multi-line stack survives
      // into the outcome so the CLI entrypoint can reproduce it byte-for-byte.
      assert.ok(outcome.stack, "expected a stack to be carried on glm-driver-fault");
      assert.match(outcome.stack!, /kaboom/);
      assert.match(outcome.stack!, /Error: kaboom\n\s+at /, "expected a real multi-line Error stack, not just the message");
    }
  });

  test("a rejecting dependency that throws a non-Error still falls back to String(err), matching the original heredoc", async () => {
    const deps = makeDeps({
      setGlmDrainerHeartbeat: (async () => {
        // eslint has no opinion here (no eslint config in this repo) — a
        // non-Error throw is a legitimate JS possibility runDriverMode's
        // catch must still handle per `err instanceof Error ? ... : String(err)`.
        throw "not an Error object";
      }) as DriverDeps["setGlmDrainerHeartbeat"],
    });
    const outcome = await runDriverMode(["heartbeat"], deps);
    assert.ok(isDriverFailure(outcome));
    if (isDriverFailure(outcome)) {
      assert.equal(outcome.code, "glm-driver-fault");
      assert.equal(outcome.message, "not an Error object");
      assert.equal(outcome.stack, "not an Error object");
    }
  });
});

describe("src/glm/drainer-driver.ts — tick mode composes gate -> pick -> claim -> worktree -> author -> finish (issue #4688)", () => {
  // New top-level describe; every dep is an injected fake, so no Redis, gh,
  // git or claude process is touched and there is no shared teardown.
  const NOW_MS = Date.parse("2026-10-13T12:00:00Z");
  const TS = Math.floor(NOW_MS / 1000);

  interface Rig {
    deps: DriverDeps;
    calls: string[];
    logs: string[];
    finishCalls: string[];
    claudeCwds: string[];
    prompts: string[];
  }

  function rig(
    opts: {
      paused?: boolean;
      candidates?: boolean;
      resume?: { branch: string; ahead: number } | null;
      dryRun?: boolean;
      worktreeAddFails?: boolean;
      bodyThrows?: boolean;
      localRefPresent?: boolean;
      runGlmClaude?: DriverDeps["runGlmClaude"];
    } = {},
  ): Rig {
    const calls: string[] = [];
    const logs: string[] = [];
    const finishCalls: string[] = [];
    const claudeCwds: string[] = [];
    const prompts: string[] = [];
    const config = { ...loadDrainerConfig({}), capDir: "/cap", worktreeRoot: "/wt-root", dryRun: opts.dryRun ?? false };
    const gateDeps: GateDeps = {
      getAutopilotPaused: async () => ({ paused: opts.paused ?? false }),
      setGlmDrainerHeartbeat: async () => ({ ok: true }),
      readFileIfExists: () => null,
      unlink: () => {},
      now: () => NOW_MS,
      config,
    };
    const row = {
      number: 77,
      title: "t",
      url: "u",
      createdAt: "",
      labels: ["glm-eligible", "ready-for-agent", "cleanup-scan"],
      body: "## Files in scope\n\n- `src/a.ts`\n",
      state: "OPEN",
      updatedAt: "2026-10-13T00:00:00Z",
    };
    const pick = {
      env: {},
      now: () => NOW_MS,
      log: (m: string) => { logs.push(`pick:${m}`); },
      listGlmEligible: async () => ({ ok: true, rows: opts.candidates === false ? [] : [row] }),
      listOpenPrs: async () => ({ ok: true, rows: [] }),
      listMergedPrs: async () => ({ ok: true, rows: [] }),
      fetchArtifact: async () => null,
      fetchOpenBlockers: async () => new Set<number>(),
      runRecoverStale: async () => 0,
      listResumeRows: async () =>
        opts.resume ? [{ branch: opts.resume.branch, aheadCount: opts.resume.ahead, ts: 1 }] : [],
      publishLastPick: async () => undefined,
    } as unknown as PickDeps;
    const finish = {
      config: { ...config },
      repoRoot: "/repo",
      now: () => NOW_MS,
      log: (m: string) => { logs.push(`finish:${m}`); },
      editIssueLabels: async (issue: number, l: { remove?: string[]; add?: string[] }) => {
        finishCalls.push(`label:${issue}:r=${(l.remove ?? []).join("+")}:a=${(l.add ?? []).join("+")}`);
        return { ok: true };
      },
      viewIssueTitle: async () => "title",
      createPr: async () => ({ ok: false, stderr: "no" }),
      listOpenPrs: async () => ({ ok: true, rows: [] }),
      runGit: async (args: string[]) => {
        finishCalls.push(`git:${args.join(" ")}`);
        return { ok: true, stdout: "0", stderr: "" };
      },
      removeWorktree: async (wt: string) => { finishCalls.push(`rm:${wt}`); return { ok: true }; },
      pushBranchUpstream: async () => ({ ok: true }),
      deleteRemoteBranch: async () => ({ ok: true }),
      remoteBranchExists: async () => false,
      preflight: async () => ({ ok: true, checkedPaths: 0 }),
      readFileIfExists: () => null,
      writeFile: () => {},
      unlinkIfExists: () => {},
      appendToFile: () => {},
    } as unknown as FinishDeps;
    const tick: TickDeps = {
      config,
      repoRoot: "/repo",
      now: () => NOW_MS,
      log: (m) => { logs.push(m); },
      claimIssue: async (n) => { calls.push(`claim:${n}`); return { ok: true }; },
      readIssueBody: async (n) => { calls.push(`body:${n}`); if (opts.bodyThrows) throw new Error("gh exploded"); return row.body; },
      git: async (args) => {
        calls.push(`git:${args.join(" ")}`);
        if (args[0] === "show-ref") return { ok: opts.localRefPresent ?? false };
        if (args[0] === "worktree") return { ok: !opts.worktreeAddFails };
        return { ok: true };
      },
      linkNodeModules: (root, wt) => { calls.push(`link:${root}->${wt}`); },
    };
    const deps = makeDeps({
      gateDeps,
      pick,
      finish,
      tick,
      buildDrainerArgs: ((o: { prompt: string }) => {
        prompts.push(o.prompt);
        return { ok: true, args: [] };
      }) as DriverDeps["buildDrainerArgs"],
      runGlmClaude:
        opts.runGlmClaude ??
        ((async (_s: unknown, _b: unknown, _a: unknown, _t: unknown, o: { cwd: string }) => {
          calls.push("author");
          claudeCwds.push(o.cwd);
          return { code: 0, stdout: "", stderr: "" };
        }) as unknown as DriverDeps["runGlmClaude"]),
    });
    return { deps, calls, logs, finishCalls, claudeCwds, prompts };
  }

  async function tickOf(r: Rig): Promise<{ exitCode: number; line: any }> {
    const outcome = await runDriverMode(["tick"], r.deps);
    assert.ok(!isDriverFailure(outcome), "a completed tick is never a driver fault");
    if (isDriverFailure(outcome)) throw new Error("unreachable");
    return { exitCode: outcome.exitCode, line: JSON.parse(outcome.line) };
  }

  test("a gate skip stops before pick: no claim, pick/finish null, exit 0, the operator-paused journal line is logged", async () => {
    const r = rig({ paused: true });
    const { exitCode, line } = await tickOf(r);
    assert.equal(exitCode, 0);
    assert.deepEqual(line, { gate: { able: false, reason: "paused" }, pick: null, finish: null });
    assert.deepEqual(r.calls, []);
    assert.ok(r.logs.some((l) => /^operator paused — skip \(no heartbeat/.test(l)));
    assert.ok(!r.logs.some((l) => l.startsWith("pick:")), "pick must not run after a skip");
  });

  test("an idle pick stops before claim: finish null, exit 0, the idle journal line is logged", async () => {
    const r = rig({ candidates: false });
    const { exitCode, line } = await tickOf(r);
    assert.equal(exitCode, 0);
    assert.equal(line.gate.able, true);
    assert.equal(line.pick.idle, true);
    assert.equal(line.finish, null);
    assert.deepEqual(r.calls, []);
    assert.ok(r.logs.some((l) => /grill-clear .* — idle$/.test(l)));
  });

  test("fresh pick: claim -> body -> fetch -> worktree add -b off origin/master -> link -> author in the worktree -> finish", async () => {
    const r = rig();
    const { exitCode, line } = await tickOf(r);
    const wt = `/wt-root/agent-glm-77-${TS}`;
    const branch = `worktree-agent-glm-77-${TS}`;
    assert.equal(exitCode, 0);
    assert.deepEqual(r.calls, [
      "claim:77",
      "body:77",
      "git:fetch origin --quiet",
      `git:worktree add -b ${branch} ${wt} origin/master`,
      `link:/repo->${wt}`,
      "author",
    ]);
    assert.deepEqual(r.claudeCwds, [wt]);
    assert.match(r.prompts[0], /^\/hydra-dev 77\n/);
    assert.match(r.prompts[0], /## Files in scope/);
    assert.doesNotMatch(r.prompts[0], /## RESUME/);
    assert.equal(line.pick.issue, 77);
    assert.ok(line.finish, "finish must be reached");
    assert.ok(r.finishCalls.length > 0, "the finish phase must have run effects");
  });

  test("resume with the local ref present: `worktree add <wt> <branch>`, RESUME paragraph carries the pick's commit count", async () => {
    const branch = "worktree-agent-glm-77-1790000000";
    const r = rig({ resume: { branch, ahead: 3 }, localRefPresent: true });
    await tickOf(r);
    const wt = `/wt-root/agent-glm-77-${TS}`;
    assert.ok(r.calls.includes(`git:worktree add ${wt} ${branch}`));
    assert.ok(!r.calls.some((c) => c.includes("--track")));
    assert.match(r.prompts[0], /after committing and pushing 3 commit\(s\) on this\nvery branch \(worktree-agent-glm-77-1790000000\)/);
    assert.ok(r.logs.some((l) => l === `issue #77: resuming pushed drainer branch ${branch} (3 commit(s) ahead of origin/master)`));
  });

  test("resume with the local ref absent: `worktree add -b <branch> --track <wt> origin/<branch>`", async () => {
    const branch = "worktree-agent-glm-77-1790000000";
    const r = rig({ resume: { branch, ahead: 1 }, localRefPresent: false });
    await tickOf(r);
    const wt = `/wt-root/agent-glm-77-${TS}`;
    assert.ok(r.calls.includes(`git:worktree add -b ${branch} --track ${wt} origin/${branch}`));
  });

  test("worktree-create failure routes to finish with a null worktree and never authors; the claim is released", async () => {
    const r = rig({ worktreeAddFails: true });
    const { exitCode, line } = await tickOf(r);
    assert.equal(exitCode, 0);
    assert.ok(!r.calls.includes("author"), "no authoring after a failed worktree");
    assert.ok(!r.calls.some((c) => c.startsWith("link:")));
    assert.equal(line.finish.action, "release-not-authored");
    assert.ok(r.finishCalls.includes("label:77:r=in-progress:a=ready-for-agent"));
    assert.ok(!r.finishCalls.some((c) => c.startsWith("rm:")), "no worktree to remove");
    assert.ok(r.logs.some((l) => /^ERROR could not create a worktree for issue #77 — handing a synthetic not-run outcome/.test(l)));
  });

  test("a throw between claim and author (readIssueBody) still reaches finish as a driver fault: never authors, claim released", async () => {
    const r = rig({ bodyThrows: true });
    const { exitCode, line } = await tickOf(r);
    assert.equal(exitCode, 0);
    assert.ok(!r.calls.includes("author"), "no authoring after a pre-author throw");
    assert.ok(line.finish, "finish must be reached");
    assert.ok(r.finishCalls.includes("label:77:r=in-progress:a=ready-for-agent"));
  });

  test("a non-timeout author rejection still reaches finish (driver-fault arm): exit 0, claim released", async () => {
    const r = rig({
      runGlmClaude: (async () => {
        throw new Error("spawn exploded");
      }) as unknown as DriverDeps["runGlmClaude"],
    });
    const { exitCode, line } = await tickOf(r);
    assert.equal(exitCode, 0);
    assert.equal(line.finish.action, "release-not-authored");
    assert.ok(r.finishCalls.includes("label:77:r=in-progress:a=ready-for-agent"));
  });

  test("a timed-out author session is an outcome handed to finish, not a fault", async () => {
    const r = rig({
      runGlmClaude: (async () => {
        throw new ClaudeCliTimeoutError("cut off", 3_000_000);
      }) as unknown as DriverDeps["runGlmClaude"],
    });
    const { exitCode, line } = await tickOf(r);
    assert.equal(exitCode, 0);
    assert.ok(line.finish, "finish must be reached on a timeout");
    assert.notEqual(line.finish.action, "finish-fault");
  });

  test("dry-run: zero claim/body/git/spawn calls; claim, worktree and author log their would-* lines; finish runs in dry-run", async () => {
    const r = rig({ dryRun: true });
    const { exitCode, line } = await tickOf(r);
    const wt = `/wt-root/agent-glm-77-${TS}`;
    assert.equal(exitCode, 0);
    assert.deepEqual(r.calls, [], "a dry-run tick must make no gh/git/spawn calls");
    assert.deepEqual(r.finishCalls, [], "finish must make no effect calls under dry-run");
    assert.ok(r.logs.includes("would-claim issue #77 (ready-for-agent -> in-progress, DRY_RUN=1)"));
    assert.ok(r.logs.includes(`would-create-worktree issue #77 branch=worktree-agent-glm-77-${TS} path=${wt} (DRY_RUN=1)`));
    assert.ok(r.logs.includes(`would-author issue #77 in ${wt} (DRY_RUN=1)`));
    assert.equal(line.finish.dryRun, true);
  });
});

describe("src/glm/drainer-driver.ts — author-mode timeout is an authoring OUTCOME, not a driver fault (issue #4337 INV-1)", () => {
  // New top-level describe with its own trivial lifecycle — no shared Redis
  // seam, so it never piggybacks a sibling suite's teardown (CLAUDE.md
  // authoring rule). Pins the #4337 contract: runClaudeCli's timeout
  // rejection (now the typed ClaudeCliTimeoutError, code
  // "claude-cli-timeout") must reach the bash loop as
  // {ok:true, code:null, timedOut:true, timeoutMs} on stdout with exit 0 —
  // the session RAN and was cut off — while every OTHER rejection still
  // becomes glm-driver-fault with its stack preserved.

  test("author: runGlmClaude rejecting with ClaudeCliTimeoutError -> ok:true timedOut:true line, exit 0 (timeout is an outcome, not a fault)", async () => {
    const deps = makeDeps({
      readFile: () => "prompt text",
      runGlmClaude: (async () => {
        throw new ClaudeCliTimeoutError("glm-drainer timed out after 3000000ms", 3_000_000);
      }) as DriverDeps["runGlmClaude"],
    });
    const outcome = await runDriverMode(["author", "/fake/prompt.txt", "/fake/wt"], deps);
    assert.ok(!isDriverFailure(outcome), "a timeout must NOT surface as a driver fault");
    if (!isDriverFailure(outcome)) {
      assert.equal(outcome.exitCode, 0);
      assert.deepEqual(JSON.parse(outcome.line), {
        ok: true,
        code: null,
        timedOut: true,
        timeoutMs: 3_000_000,
      });
    }
  });

  test("author: a timeout-shaped rejection carrying the code field but no timeoutMs falls back to deps.apiTimeoutMs", async () => {
    // The discrimination is on err.code, NEVER on message text — a
    // structurally-identical rejection (e.g. from another lane's seam or a
    // future caller) must map the same way, with the driver's own configured
    // window as the only sane timeoutMs fallback.
    const deps = makeDeps({
      readFile: () => "prompt text",
      runGlmClaude: (async () => {
        throw Object.assign(new Error("cut off"), { code: "claude-cli-timeout" });
      }) as DriverDeps["runGlmClaude"],
    });
    const outcome = await runDriverMode(["author", "/fake/prompt.txt", "/fake/wt"], deps);
    if (!isDriverFailure(outcome)) {
      assert.equal(outcome.exitCode, 0);
      const parsed = JSON.parse(outcome.line);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.timedOut, true);
      assert.equal(parsed.timeoutMs, 1000); // makeDeps' apiTimeoutMs
    } else {
      assert.fail("expected a success outcome");
    }
  });

  test("author: a NON-timeout rejection still maps to glm-driver-fault with the stack preserved", async () => {
    const deps = makeDeps({
      readFile: () => "prompt text",
      runGlmClaude: (async () => {
        throw new Error("kaboom");
      }) as DriverDeps["runGlmClaude"],
    });
    const outcome = await runDriverMode(["author", "/fake/prompt.txt", "/fake/wt"], deps);
    assert.ok(isDriverFailure(outcome), "a non-timeout rejection IS a driver fault");
    if (isDriverFailure(outcome)) {
      assert.equal(outcome.code, "glm-driver-fault");
      assert.match(outcome.message, /kaboom/);
      assert.ok(outcome.stack, "expected the stack to be carried on glm-driver-fault");
      assert.match(outcome.stack!, /kaboom/);
    }
  });

  test("author: a rejection whose message merely MENTIONS 'timed out' but carries no code field is still a fault (never discriminate on text)", async () => {
    const deps = makeDeps({
      readFile: () => "prompt text",
      runGlmClaude: (async () => {
        throw new Error("glm-drainer timed out after 3000000ms (but not the typed error)");
      }) as DriverDeps["runGlmClaude"],
    });
    const outcome = await runDriverMode(["author", "/fake/prompt.txt", "/fake/wt"], deps);
    assert.ok(isDriverFailure(outcome), "message text alone must never arm the timeout mapping");
    if (isDriverFailure(outcome)) {
      assert.equal(outcome.code, "glm-driver-fault");
    }
  });

  test("ClaudeCliTimeoutError carries the machine-readable code + timeoutMs and the pinned message shape", () => {
    const err = new ClaudeCliTimeoutError("glm-drainer timed out after 10ms", 10);
    assert.equal(err.code, "claude-cli-timeout");
    assert.equal(err.timeoutMs, 10);
    assert.equal(err.message, "glm-drainer timed out after 10ms");
    assert.ok(err instanceof Error);
  });
});
