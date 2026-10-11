/**
 * src/glm/finish.ts — the GLM drainer's finish phase (issue #4685, ADR-0040
 * Decisions 1–3, epic #4681).
 *
 * Unit layer for the bash-era groups D5 (open_pr adopt-on-collision), D13
 * (post-author arms / salvage ladder), D15 (timeout-cap glm-withhold
 * handoff), D16 (parse_quota_block_stdout) and D17 (quota block recorded
 * after the claim release) per the #4679 test-port rule: decideFinish /
 * parseAuthorOutcome / parseQuotaBlockStdout cases are typed TABLES with
 * exact-equality expectations, and runFinish cases run against FAKE deps
 * that record every effect call in order. No processes, no real git, no
 * temp repos, no Redis, no goldens. The bash groups this file replaces were
 * deleted from test/glm-drainer-loop.test.mts in the same PR (only one
 * sourced-snippet compose_prompt case survives there — the RESUME paragraph
 * is still bash's to write); the whole-script D1–D4, flock, systemd and
 * run_driver groups stay there too.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  GLM_LABEL_AUTHORED,
  PR_BODY_FILENAME,
  QUOTA_BLOCK_FALLBACK_SECONDS,
  QUOTA_BLOCK_MAX_SECONDS,
  QUOTA_BLOCK_MIN_SECONDS,
  TIMEOUT_NOTE,
  decideFinish,
  parseAuthorOutcome,
  parseQuotaBlockStdout,
  runFinish,
  timeoutCounterFilePath,
  type AuthorOutcome,
  type DecideFinishInput,
  type FinishDeps,
  type FinishInput,
  type FinishResult,
  type FinishVerdict,
} from "../src/glm/finish.ts";
import { capFilePath, quotaBlockFilePath } from "../src/glm/gate.ts";
import { loadDrainerConfig } from "../src/glm/drainer-config.ts";
import { runDriverMode, type DriverDeps } from "../src/glm/drainer-driver.ts";
import type { PrRow } from "../src/github/prs.ts";

const NOW_MS = Date.parse("2026-09-30T12:00:00Z");
const NOW_SEC = Math.floor(NOW_MS / 1000);
const CAP_DIR = "/cap";
const CAP_FILE = capFilePath(CAP_DIR, NOW_MS); // /cap/hydra-glm-drainer-daily-cap-2026-09-30
const QUOTA_FILE = quotaBlockFilePath(CAP_DIR);
const TIMEOUT_FILE = timeoutCounterFilePath(CAP_DIR, 77);
const REPO_ROOT = "/repo";
const WT = "/repo/wts/agent-glm-77-1";
const BODY_FILE = `${WT}/${PR_BODY_FILENAME}`;
const BRANCH = "worktree-agent-glm-77-1790000000";
const PR_URL = "https://github.com/gaberoo322/hydra/pull/12345";

// The author-outcome JSON lines the driver emits (mirrors the shapes the old
// bash jq fields read: .ok / .code / .message / .stdout / .timedOut).
const OUTCOME_CLEAN = JSON.stringify({ ok: true, code: 0, stdout: "fake session stdout", stderr: "" });
const OUTCOME_TIMEOUT = JSON.stringify({ ok: true, code: null, timedOut: true, timeoutMs: 3000000 });
const OUTCOME_TIMEOUT_429 = JSON.stringify({
  ok: true,
  code: null,
  timedOut: true,
  stdout: "API Error: Request rejected (429) — [1310][Weekly/Monthly Limit Exhausted.",
  stderr: "",
});
const OUTCOME_NOT_RUN = JSON.stringify({
  ok: false,
  code: "glm-auth-token-missing",
  message: "ANTHROPIC_AUTH_TOKEN is unset",
});

const READY = "ready-for-agent";
const NEEDS_QA = "needs-qa";
const WITHHOLD = "glm-withhold";

// ---------------------------------------------------------------------------
// parseAuthorOutcome — pure
// ---------------------------------------------------------------------------

describe("parseAuthorOutcome — the three post-author arms (issue #4337 INV-2)", () => {
  const rows: Array<[string, string, number, AuthorOutcome]> = [
    ["non-zero driver exit is a driver fault, even with a good JSON line", OUTCOME_CLEAN, 1, { kind: "driver-fault" }],
    ["empty stdout is a driver fault", "", 0, { kind: "driver-fault" }],
    ["whitespace-only stdout is a driver fault", "  \n", 0, { kind: "driver-fault" }],
    ["unparseable JSON is a driver fault (delta d: the ARM, never a crash)", "not json at all", 0, { kind: "driver-fault" }],
    ["a JSON non-object is a driver fault", "42", 0, { kind: "driver-fault" }],
    [
      "ok:false with a string code is not-run, carrying code and message",
      OUTCOME_NOT_RUN,
      0,
      { kind: "not-run", code: "glm-auth-token-missing", message: "ANTHROPIC_AUTH_TOKEN is unset" },
    ],
    [
      "ok:false with a null code renders the code as the string \"null\" (bash jq parity)",
      JSON.stringify({ ok: false, code: null, message: "" }),
      0,
      { kind: "not-run", code: "null", message: "" },
    ],
    [
      "a clean ran outcome carries code and stdout",
      OUTCOME_CLEAN,
      0,
      { kind: "ran", timedOut: false, code: 0, stdout: "fake session stdout" },
    ],
    [
      "a timed-out session RAN (an authoring outcome the ladder salvages, never a fault)",
      OUTCOME_TIMEOUT,
      0,
      { kind: "ran", timedOut: true, code: null, stdout: "" },
    ],
    [
      "timedOut is honored only when strictly true",
      JSON.stringify({ ok: true, code: 0, timedOut: "true" }),
      0,
      { kind: "ran", timedOut: false, code: 0, stdout: "" },
    ],
    [
      "a non-number code on a ran outcome reads as null",
      JSON.stringify({ ok: true, code: "0" }),
      0,
      { kind: "ran", timedOut: false, code: null, stdout: "" },
    ],
    [
      "a missing stdout on a ran outcome reads as \"\"",
      JSON.stringify({ ok: true, code: 3 }),
      0,
      { kind: "ran", timedOut: false, code: 3, stdout: "" },
    ],
  ];
  for (const [name, raw, exitCode, expected] of rows) {
    test(name, () => {
      assert.deepEqual(parseAuthorOutcome(raw, exitCode), expected);
    });
  }
});

// ---------------------------------------------------------------------------
// parseQuotaBlockStdout — D16, seven rows exactly (issue #4273)
// ---------------------------------------------------------------------------

/** Render an epoch as the `YYYY-MM-DD HH:MM:SS` wall clock z.ai prints. */
function wallClock(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().slice(0, 19).replace("T", " ");
}

describe("parseQuotaBlockStdout — z.ai's 429 payload, 7 cases (issue #4273, group D16)", () => {
  const rows: Array<[string, string, number | null]> = [
    [
      "the exact journal 429 line with a now-stale reset date takes the 60-min fallback, not the parsed instant",
      // date -u -d '2026-08-30 05:22:45 +0800' +%s -> 1788038565 (the old
      // bash group's own fixture note), which is in the PAST relative to
      // NOW_SEC — a stale advertised reset must not unblock the lane.
      `API Error: Request rejected (429) · [1310][Weekly/Monthly Limit Exhausted.\nYour limit will reset at 2026-08-30 05:22:45`,
      NOW_SEC + QUOTA_BLOCK_FALLBACK_SECONDS,
    ],
    [
      "a genuinely future reset, expressed as a +0800 wall clock, parses to its UTC epoch (inside the clamp band, so untouched)",
      `Request rejected (429) reset at ${wallClock(NOW_SEC + 7200 + 8 * 3600)}`,
      NOW_SEC + 7200,
    ],
    ["non-429 stdout never sets a block", "authoring session ended cleanly", null],
    [
      "a 429 with no reset clause takes the 60-min fallback",
      "Request rejected (429) — no reset info in this payload",
      NOW_SEC + QUOTA_BLOCK_FALLBACK_SECONDS,
    ],
    [
      "a 429 with a garbage/unparseable reset clause takes the 60-min fallback, not a crash",
      "Request rejected (429) reset at 9999-99-99 99:99:99",
      NOW_SEC + QUOTA_BLOCK_FALLBACK_SECONDS,
    ],
    [
      "a parseable future reset below the 15-min floor is clamped up to the floor",
      `Request rejected (429) reset at ${wallClock(NOW_SEC + 60 + 8 * 3600)}`,
      NOW_SEC + QUOTA_BLOCK_MIN_SECONDS,
    ],
    [
      "a parseable future reset above the 35-day ceiling is clamped down to the ceiling",
      `Request rejected (429) reset at ${wallClock(NOW_SEC + 40 * 86400 + 8 * 3600)}`,
      NOW_SEC + QUOTA_BLOCK_MAX_SECONDS,
    ],
  ];
  for (const [name, text, expected] of rows) {
    test(name, () => {
      assert.equal(parseQuotaBlockStdout(text, NOW_SEC, "+0800"), expected);
    });
  }

  test("only the FIRST reset clause is read (bash head -1 parity)", () => {
    const first = wallClock(NOW_SEC + 7200 + 8 * 3600);
    const second = wallClock(NOW_SEC + 90 * 86400 + 8 * 3600);
    assert.equal(
      parseQuotaBlockStdout(`Request rejected (429) reset at ${first} … later reset at ${second}`, NOW_SEC, "+0800"),
      NOW_SEC + 7200,
    );
  });

  test("an unparseable tzOffset takes the fallback (the offset string is a config surface, not evidence)", () => {
    const text = `Request rejected (429) reset at ${wallClock(NOW_SEC + 7200 + 8 * 3600)}`;
    assert.equal(parseQuotaBlockStdout(text, NOW_SEC, "UTC+8"), NOW_SEC + QUOTA_BLOCK_FALLBACK_SECONDS);
    assert.equal(parseQuotaBlockStdout(text, NOW_SEC, "+080"), NOW_SEC + QUOTA_BLOCK_FALLBACK_SECONDS);
  });

  test("a negative offset is honored (sign + four digits)", () => {
    // Wall clock in -0500: UTC = wall + 5h, so a wall 7h out lands at NOW+7200.
    const text = `Request rejected (429) reset at ${wallClock(NOW_SEC + 7200 - 5 * 3600)}`;
    assert.equal(parseQuotaBlockStdout(text, NOW_SEC, "-0500"), NOW_SEC + 7200);
  });
});

// ---------------------------------------------------------------------------
// decideFinish — the pure salvage-ladder table (D13 + D15)
// ---------------------------------------------------------------------------

describe("decideFinish — pure salvage-ladder table (issues #4337 D13/D15, #4685 INV-2)", () => {
  const RAN: AuthorOutcome = { kind: "ran", timedOut: false, code: 0, stdout: "" };
  const base: DecideFinishInput = {
    authorOutcome: RAN,
    commitCount: 2,
    prBodyPresent: true,
    timedOut: false,
    timeoutCount: 0,
    timeoutResumeCap: 2,
    preflightOk: null,
    prOpened: null,
    dryRun: false,
  };
  const rows: Array<[string, Partial<DecideFinishInput>, FinishVerdict]> = [
    ["clean ran path, no evidence gathered yet: gather preflight first", {}, { action: "open-pr", next: "preflight" }],
    [
      "driver-fault outcome: release-not-authored, never a withhold (a fault says nothing about tier)",
      { authorOutcome: { kind: "driver-fault" } },
      { action: "release-not-authored", withhold: false },
    ],
    [
      "not-run outcome (fail-closed env/args build): release-not-authored",
      { authorOutcome: { kind: "not-run", code: "glm-auth-token-missing", message: "" } },
      { action: "release-not-authored", withhold: false },
    ],
    [
      "commitCount 0: nothing usable produced, plain release below the timeout cap",
      { commitCount: 0 },
      { action: "release-nothing-produced", withhold: false },
    ],
    [
      "D15: a TIMED-OUT nothing-produced release AT the cap withholds (explicit Claude-lane handoff)",
      { commitCount: 0, timedOut: true, timeoutCount: 2 },
      { action: "release-nothing-produced", withhold: true },
    ],
    [
      "D13/D15: a timed-out nothing-produced release BELOW the cap stays plain (the GLM lane resumes)",
      { commitCount: 0, timedOut: true, timeoutCount: 1 },
      { action: "release-nothing-produced", withhold: false },
    ],
    [
      "D15: the cap is IGNORED when the session did not time out",
      { commitCount: 0, timedOut: false, timeoutCount: 5 },
      { action: "release-nothing-produced", withhold: false },
    ],
    [
      "pr body absent with commits: keep-partial-for-resume, plain below the cap",
      { commitCount: 1, prBodyPresent: false },
      { action: "keep-partial-for-resume", withhold: false },
    ],
    [
      "pr body absent + timed out AT the cap: keep-partial WITH withhold",
      { commitCount: 1, prBodyPresent: false, timedOut: true, timeoutCount: 2 },
      { action: "keep-partial-for-resume", withhold: true },
    ],
    [
      "preflight blocked: withhold-preflight-blocked (always withholds — the T2/T3 fence hit)",
      { preflightOk: false },
      { action: "withhold-preflight-blocked", withhold: true },
    ],
    [
      "preflight passed, PR not attempted yet: gather the PR answer next",
      { preflightOk: true },
      { action: "open-pr", next: "create-pr" },
    ],
    [
      "genuine gh pr create failure (no adoptable PR): release-after-failed-pr, plain below the cap",
      { preflightOk: true, prOpened: false },
      { action: "release-after-failed-pr", withhold: false },
    ],
    [
      "genuine gh pr create failure + timed out AT the cap: release WITH withhold",
      { preflightOk: true, prOpened: false, timedOut: true, timeoutCount: 2 },
      { action: "release-after-failed-pr", withhold: true },
    ],
    [
      "clean success: PR opened (or adopted) -> advance",
      { preflightOk: true, prOpened: true },
      { action: "open-pr", next: "advance" },
    ],
    [
      "dry-run skips the commit-count rung (bash parity: the `!= 1` guards)",
      { commitCount: 0, dryRun: true },
      { action: "open-pr", next: "preflight" },
    ],
    [
      "dry-run skips the pr-body rung",
      { prBodyPresent: false, dryRun: true },
      { action: "open-pr", next: "preflight" },
    ],
    [
      "rule order is first-match-wins: rung 2 (commits=0) outranks a blocked preflight",
      { commitCount: 0, preflightOk: false },
      { action: "release-nothing-produced", withhold: false },
    ],
    [
      "rule order: a not-authored outcome outranks everything, even a blocked preflight",
      { authorOutcome: { kind: "driver-fault" }, preflightOk: false, commitCount: 0 },
      { action: "release-not-authored", withhold: false },
    ],
  ];
  for (const [name, overrides, expected] of rows) {
    test(name, () => {
      assert.deepEqual(decideFinish({ ...base, ...overrides }), expected);
    });
  }
});

// ---------------------------------------------------------------------------
// runFinish — fake deps, ordered effect recording
// ---------------------------------------------------------------------------

interface FakeOpts {
  /** git rev-list --count origin/master..HEAD */
  commitCount?: number;
  /** git diff --name-only origin/master...HEAD */
  changedPaths?: string[];
  /** The .glm-drainer-pr-body.md content in the worktree (null = absent). */
  prBody?: string | null;
  createPr?: { ok: boolean; url?: string; stderr?: string };
  openPrs?: Array<{ number: number; url: string; headRefName: string }>;
  listOk?: boolean;
  preflightOk?: boolean;
  preflightRejects?: boolean;
  remoteBranchExists?: boolean;
  dryRun?: boolean;
  timeoutResumeCap?: number;
  /** Pre-seeded counter/state files under CAP_DIR. */
  files?: Record<string, string>;
  /** Reject these effects (effect-isolation cases). */
  rejectEffects?: string[];
}

function fakePrRow(number: number, headRefName: string): PrRow {
  return {
    number,
    title: `PR #${number}`,
    url: `https://github.com/gaberoo322/hydra/pull/${number}`,
    updatedAt: "",
    state: "OPEN",
    headRefName,
    createdAt: "",
    statusCheckRollup: [],
  };
}

function makeFinishDeps(opts: FakeOpts = {}): { deps: FinishDeps; calls: string[]; logs: string[]; files: Map<string, string> } {
  const calls: string[] = [];
  const logs: string[] = [];
  const files = new Map<string, string>(Object.entries(opts.files ?? {}));
  if (opts.prBody !== null) files.set(BODY_FILE, opts.prBody ?? "fake session pr body\n");
  const reject = new Set(opts.rejectEffects ?? []);
  const config = {
    ...loadDrainerConfig({}),
    capDir: CAP_DIR,
    timeoutResumeCap: opts.timeoutResumeCap ?? 2,
    dryRun: opts.dryRun ?? false,
  };
  const deps: FinishDeps = {
    config,
    repoRoot: REPO_ROOT,
    now: () => NOW_MS,
    log: (msg) => { logs.push(msg); },
    editIssueLabels: async (issue, labels) => {
      if (reject.has("editIssueLabels")) throw new Error("injected editIssueLabels rejection");
      calls.push(`label:${issue}:r=${(labels.remove ?? []).join("+") ?? ""}:a=${(labels.add ?? []).join("+") ?? ""}`);
      return { ok: true };
    },
    viewIssueTitle: async (issue) => {
      calls.push(`title:${issue}`);
      return "Fake issue title";
    },
    createPr: async (input) => {
      if (reject.has("createPr")) throw new Error("injected createPr rejection");
      calls.push(`pr-create:${input.head}`);
      return opts.createPr ?? { ok: true, url: PR_URL };
    },
    listOpenPrs: async () => {
      calls.push("pr-list");
      if (opts.listOk === false) return { ok: false, rows: [] };
      return { ok: true, rows: (opts.openPrs ?? []).map((p) => fakePrRow(p.number, p.headRefName)) };
    },
    runGit: async (args) => {
      calls.push(`git:${args.join(" ")}`);
      if (args[0] === "rev-list" && args[1] === "--count") {
        return { ok: true, stdout: String(opts.commitCount ?? 0), stderr: "" };
      }
      if (args[0] === "diff" && args[1] === "--name-only") {
        return { ok: true, stdout: (opts.changedPaths ?? ["src/glm/finish.ts"]).join("\n"), stderr: "" };
      }
      if (args[0] === "fetch") return { ok: true, stdout: "", stderr: "" };
      return { ok: false, stderr: `fake runGit: unhandled ${args.join(" ")}` };
    },
    removeWorktree: async (wt) => {
      if (reject.has("removeWorktree")) throw new Error("injected removeWorktree rejection");
      calls.push(`worktree-remove:${wt}`);
      return { ok: true };
    },
    pushBranchUpstream: async (branch) => {
      calls.push(`push:${branch}`);
      return { ok: true };
    },
    deleteRemoteBranch: async (branch) => {
      calls.push(`branch-delete:${branch}`);
      return { ok: true };
    },
    remoteBranchExists: async (branch) => {
      calls.push(`ls-remote:${branch}`);
      return opts.remoteBranchExists ?? true;
    },
    preflight: async (options) => {
      if (opts.preflightRejects) throw new Error("injected preflight rejection");
      calls.push(`preflight:${options.changedPaths.join(",")}`);
      if (opts.preflightOk === false) {
        return { ok: false, code: "glm-preflight-blocked" as const, violations: [], message: "fake violation" };
      }
      return { ok: true, checkedPaths: options.changedPaths.length };
    },
    readFileIfExists: (path) => files.get(path) ?? null,
    writeFile: (path, content) => {
      calls.push(`write:${path}`);
      files.set(path, content);
    },
    unlinkIfExists: (path) => {
      calls.push(`unlink:${path}`);
      files.delete(path);
    },
    appendToFile: (path, text) => {
      calls.push(`append:${path}`);
      files.set(path, (files.get(path) ?? "") + text);
    },
  };
  return { deps, calls, logs, files };
}

function ranInput(overrides: Partial<FinishInput> = {}): FinishInput {
  return { issue: 77, worktree: WT, branch: BRANCH, authorRaw: OUTCOME_CLEAN, authorExitCode: 0, ...overrides };
}

describe("runFinish — the post-author arms, in order (issue #4337 D13, issue #4685 INV-4)", () => {
  test("driver-fault arm: FAULTED journal line, worktree removed, ONE plain release, no withhold", async () => {
    const h = makeFinishDeps();
    const r = await runFinish(h.deps, ranInput({ authorRaw: "", authorExitCode: 1 }));
    assert.equal(r.action, "release-not-authored");
    assert.deepEqual(r.labels, [READY]);
    assert.match(h.logs.join("\n"), /authoring driver FAULTED \(exit=1\) for issue #77 — see driver stderr above/);
    assert.doesNotMatch(h.logs.join("\n"), /authoring session did not run/);
    assert.deepEqual(h.calls, [`worktree-remove:${WT}`, `label:77:r=in-progress:a=ready-for-agent`]);
    assert.equal(h.files.has(TIMEOUT_FILE), false, "a fault never touches the timeout counter");
  });

  test("not-run arm: the fail-closed line with the driver's code and message, plain release", async () => {
    const h = makeFinishDeps();
    const r = await runFinish(h.deps, ranInput({ authorRaw: OUTCOME_NOT_RUN }));
    assert.equal(r.action, "release-not-authored");
    assert.match(
      h.logs.join("\n"),
      /authoring session did not run for issue #77: glm-auth-token-missing — ANTHROPIC_AUTH_TOKEN is unset/,
    );
    assert.doesNotMatch(h.logs.join("\n"), /FAULTED/);
    assert.deepEqual(h.calls, [`worktree-remove:${WT}`, `label:77:r=in-progress:a=ready-for-agent`]);
  });

  test("worktree-create-failure shape (no worktree/branch): releases with nothing to remove", async () => {
    const h = makeFinishDeps();
    const r = await runFinish(h.deps, {
      issue: 77,
      worktree: null,
      branch: null,
      authorRaw: JSON.stringify({ ok: false, code: "glm-worktree-create-failed", message: "create_worktree failed — no worktree to salvage" }),
      authorExitCode: 0,
    });
    assert.equal(r.action, "release-not-authored");
    assert.deepEqual(h.calls, [`label:77:r=in-progress:a=ready-for-agent`], "no worktree removal, no git effects");
    assert.match(h.logs.join("\n"), /glm-worktree-create-failed/);
  });

  test("clean success: push -> preflight -> pr-create -> counter reset -> needs-qa advance -> cap increment -> worktree removal", async () => {
    const h = makeFinishDeps({ commitCount: 2, changedPaths: ["src/glm/finish.ts", "test/glm-finish.test.mts"] });
    const r = await runFinish(h.deps, ranInput());
    assert.equal(r.action, "open-pr");
    assert.deepEqual(r.labels, [NEEDS_QA]);
    assert.deepEqual(r.pr, { number: 12345, url: PR_URL, adopted: false });
    const journal = h.logs.join("\n");
    assert.match(journal, /authoring session ended for issue #77 \(timedOut=false, exit=0\)/);
    assert.match(journal, /preflight passed for issue #77 — opening PR/);
    assert.match(journal, /gh pr create succeeded: https:\/\/github\.com\/gaberoo322\/hydra\/pull\/12345/);
    assert.match(journal, /issue #77: PR opened \(branch=worktree-agent-glm-77-1790000000\), advanced to needs-qa, daily cap incremented/);
    // NO release on the success path — the claim advanced instead.
    assert.doesNotMatch(h.calls.join("\n"), /a=ready-for-agent/);
    assert.deepEqual(
      h.calls,
      [
        `git:rev-list --count origin/master..HEAD`,
        `push:${BRANCH}`,
        `git:fetch origin --quiet`,
        `git:diff --name-only origin/master...HEAD`,
        "preflight:src/glm/finish.ts,test/glm-finish.test.mts",
        `title:77`,
        `pr-create:${BRANCH}`,
        `unlink:${TIMEOUT_FILE}`,
        `label:77:r=ready-for-agent+in-progress:a=needs-qa`,
        `write:${CAP_FILE}`,
        `worktree-remove:${WT}`,
      ],
    );
    assert.equal(h.files.get(CAP_FILE), "1\n", "the daily-cap file keeps today's bare-integer format with a trailing newline");
  });

  test("salvage arm (timed out with commits + pr body): counter incremented FIRST, note appended, identical fence", async () => {
    const h = makeFinishDeps({ commitCount: 1, changedPaths: ["src/glm/finish.ts"] });
    const r = await runFinish(h.deps, ranInput({ authorRaw: OUTCOME_TIMEOUT }));
    assert.equal(r.action, "open-pr");
    // INV-4: the timed-out session's counter increment is the FIRST effect.
    // (The written "1\n" value is asserted on the arms where the counter
    // file SURVIVES — keep-partial and D15 below; here the successful PR
    // opening removes it again, which the last assert pins.)
    assert.equal(h.calls[0], `write:${TIMEOUT_FILE}`);
    const journal = h.logs.join("\n");
    assert.match(journal, /authoring session ended for issue #77 \(timedOut=true, exit=null\)/);
    assert.match(journal, /appended GLM drainer timeout note to /);
    // The appended note is the byte-identical plain-text disclosure.
    assert.ok(h.files.get(BODY_FILE)!.endsWith(TIMEOUT_NOTE), "TIMEOUT_NOTE must be appended verbatim");
    assert.equal(h.files.has(TIMEOUT_FILE), false, "a successful open-pr resets the timeout budget (INV-6)");
  });

  test("keep-partial arm (commits, no pr body): push, worktree removed, remote branch KEPT, no PR attempt", async () => {
    const h = makeFinishDeps({ commitCount: 1, prBody: null });
    const r = await runFinish(h.deps, ranInput({ authorRaw: OUTCOME_TIMEOUT }));
    assert.equal(r.action, "keep-partial-for-resume");
    assert.match(
      h.logs.join("\n"),
      /partial work kept on origin\/worktree-agent-glm-77-1790000000 for resume \(commits=1, pr-body-present=no\)/,
    );
    const joined = h.calls.join("\n");
    assert.doesNotMatch(joined, /preflight:/, "no PR attempt from this state — the gates would wedge it (INV-4)");
    assert.doesNotMatch(joined, /pr-create:/);
    assert.doesNotMatch(joined, /branch-delete:/, "the pushed branch IS the resume record");
    assert.doesNotMatch(joined, /ls-remote:/);
    assert.deepEqual(
      h.calls,
      [
        `write:${TIMEOUT_FILE}`,
        `git:rev-list --count origin/master..HEAD`,
        `push:${BRANCH}`,
        `worktree-remove:${WT}`,
        `label:77:r=in-progress:a=ready-for-agent`,
      ],
    );
    assert.equal(h.files.get(TIMEOUT_FILE), "1\n", "the PR-less timeout accumulates (INV-6)");
  });

  test("nothing-produced arm: worktree removed, remote branch deleted after the ls-remote check, plain release", async () => {
    const h = makeFinishDeps({ commitCount: 0, remoteBranchExists: true });
    const r = await runFinish(h.deps, ranInput({ authorRaw: OUTCOME_TIMEOUT }));
    assert.equal(r.action, "release-nothing-produced");
    assert.match(h.logs.join("\n"), /issue #77: nothing usable produced \(commits=0\) — releasing claim/);
    assert.deepEqual(
      h.calls,
      [
        `write:${TIMEOUT_FILE}`,
        `git:rev-list --count origin/master..HEAD`,
        `worktree-remove:${WT}`,
        `ls-remote:${BRANCH}`,
        `branch-delete:${BRANCH}`,
        `label:77:r=in-progress:a=ready-for-agent`,
      ],
    );
    assert.equal(r.quotaBlockedUntil, null, "no 429 in the stdout -> no quota block");
    assert.equal(h.files.has(QUOTA_FILE), false);
  });

  test("delta (c): a never-pushed remote branch is NOT pushed a --delete (the ls-remote check gates it)", async () => {
    const h = makeFinishDeps({ commitCount: 0, remoteBranchExists: false });
    const r = await runFinish(h.deps, ranInput({ authorRaw: OUTCOME_TIMEOUT }));
    assert.equal(r.action, "release-nothing-produced");
    const joined = h.calls.join("\n");
    assert.match(joined, /ls-remote:/);
    assert.doesNotMatch(joined, /branch-delete:/, "no push --delete for a branch that does not exist on origin");
  });

  test("D15: a second PR-less timed-out session AT the cap releases with glm-withhold (separate second label write)", async () => {
    // Session 1 already left the counter at 1; this session's own increment
    // (INV-4: FIRST) takes it to 2 = the cap.
    const h = makeFinishDeps({ commitCount: 1, prBody: null, files: { [TIMEOUT_FILE]: "1\n" } });
    const r = await runFinish(h.deps, ranInput({ authorRaw: OUTCOME_TIMEOUT }));
    assert.equal(r.action, "keep-partial-for-resume");
    assert.deepEqual(r.labels, [READY, WITHHOLD]);
    assert.match(
      h.logs.join("\n"),
      /issue #77: timeout resume cap reached \(2\/2\) — releasing with glm-withhold so the Claude dev_orch lane takes this issue and its pushed branch over/,
    );
    // INV-3: the withhold rides a SEPARATE second gh issue edit, after the release.
    const releaseIdx = h.calls.indexOf(`label:77:r=in-progress:a=ready-for-agent`);
    const withholdIdx = h.calls.indexOf(`label:77:r=:a=glm-withhold`);
    assert.ok(releaseIdx >= 0, "expected the release write");
    assert.ok(withholdIdx > releaseIdx, "the withhold write must follow the release write");
    assert.equal(h.files.get(TIMEOUT_FILE), "2\n");
  });

  test("preflight-blocked arm: worktree removed, branch deleted, release + ALWAYS withhold, timeout counter untouched", async () => {
    const h = makeFinishDeps({ commitCount: 1, preflightOk: false, remoteBranchExists: true });
    const r = await runFinish(h.deps, ranInput());
    assert.equal(r.action, "withhold-preflight-blocked");
    assert.deepEqual(r.labels, [READY, WITHHOLD]);
    const journal = h.logs.join("\n");
    assert.match(journal, /preflight BLOCKED for issue #77: /);
    assert.doesNotMatch(journal, /timeout resume cap reached/, "the cap line is timeout-driven only");
    assert.deepEqual(
      h.calls,
      [
        `git:rev-list --count origin/master..HEAD`,
        `push:${BRANCH}`,
        `git:fetch origin --quiet`,
        `git:diff --name-only origin/master...HEAD`,
        "preflight:src/glm/finish.ts",
        `worktree-remove:${WT}`,
        `ls-remote:${BRANCH}`,
        `branch-delete:${BRANCH}`,
        `label:77:r=in-progress:a=ready-for-agent`,
        `label:77:r=:a=glm-withhold`,
      ],
    );
    assert.equal(h.files.has(TIMEOUT_FILE), false, "not timed out -> no counter write; the arm never removes it either");
  });

  test("a REJECTING preflight fails closed (an unreadable gate is a closed gate)", async () => {
    const h = makeFinishDeps({ commitCount: 1, preflightRejects: true });
    const r = await runFinish(h.deps, ranInput());
    assert.equal(r.action, "withhold-preflight-blocked");
    assert.match(h.logs.join("\n"), /WARN preflight threw \(non-fatal\)/);
    assert.match(h.logs.join("\n"), /preflight BLOCKED for issue #77/);
  });

  test("D5 adopt: gh pr create fails, the open-PR list HAS the head branch -> ANOMALY + adopt + relabel via the issue-edit seam", async () => {
    const h = makeFinishDeps({
      commitCount: 1,
      createPr: { ok: false, stderr: 'GraphQL: a pull request for branch "worktree-agent-glm-77-1790000000" into branch "master" already exists:' },
      openPrs: [{ number: 999, url: "https://github.com/gaberoo322/hydra/pull/999", headRefName: BRANCH }],
    });
    const r = await runFinish(h.deps, ranInput());
    // Adoption is SUCCESS: the caller's advance path fires (issue #3900).
    assert.equal(r.action, "open-pr");
    assert.deepEqual(r.pr, { number: 999, url: "https://github.com/gaberoo322/hydra/pull/999", adopted: true });
    const journal = h.logs.join("\n");
    assert.match(journal, /ANOMALY issue #77: gh pr create failed but PR #999 \(https:\/\/github\.com\/gaberoo322\/hydra\/pull\/999\) already exists for branch=worktree-agent-glm-77-1790000000 — adopting it instead of releasing the claim \(see issue #3900\)/);
    // Only the ERROR line means "genuine failure" — the WARN line says
    // "…before treating this as a genuine failure" on the adopt path too.
    assert.doesNotMatch(journal, /ERROR gh pr create failed/);
    // Delta (b): the glm-authored re-apply rides gh ISSUE edit on the PR
    // number (gh pr edit is broken for labels here, ADR-0034 §7) — in the
    // fake that is the SAME editIssueLabels seam, called with the PR number.
    assert.ok(h.calls.includes(`label:999:r=:a=${GLM_LABEL_AUTHORED}`), `expected the adopted-PR relabel:\n${h.calls.join("\n")}`);
    assert.ok(h.calls.includes(`label:77:r=ready-for-agent+in-progress:a=needs-qa`), "adoption must still advance the issue to needs-qa");
    assert.equal(h.files.get(CAP_FILE), "1\n", "an adopted PR counts against the daily cap like a fresh one");
  });

  test("D5 genuine failure: gh pr create fails, the open-PR list has NO match -> release, worktree AND branch left for inspection", async () => {
    const h = makeFinishDeps({
      commitCount: 1,
      createPr: { ok: false, stderr: "gh: Some other failure" },
      openPrs: [],
    });
    const r = await runFinish(h.deps, ranInput());
    assert.equal(r.action, "release-after-failed-pr");
    assert.deepEqual(r.labels, [READY]);
    const journal = h.logs.join("\n");
    assert.match(journal, /ERROR gh pr create failed for issue #77 branch=worktree-agent-glm-77-1790000000 and no existing PR found for that branch — genuine failure/);
    assert.match(journal, /PR creation failed for issue #77 — releasing claim \(branch\/worktree left for operator inspection\)/);
    assert.doesNotMatch(journal, /ANOMALY/);
    const joined = h.calls.join("\n");
    assert.doesNotMatch(joined, /worktree-remove:/, "the worktree stays for operator inspection");
    assert.doesNotMatch(joined, /branch-delete:/, "the remote branch stays for operator inspection");
    assert.doesNotMatch(joined, /a=needs-qa/);
    assert.ok(h.calls.includes(`label:77:r=in-progress:a=ready-for-agent`), "the claim is still released");
  });

  test("D5: a FAILED adopt lookup (gh pr list error) is a genuine failure, never a crash", async () => {
    const h = makeFinishDeps({
      commitCount: 1,
      createPr: { ok: false, stderr: "gh: create failed" },
      listOk: false,
    });
    const r = await runFinish(h.deps, ranInput());
    assert.equal(r.action, "release-after-failed-pr");
    assert.match(h.logs.join("\n"), /genuine failure/);
  });

  test("D17: a 429 stdout on the nothing-produced arm records the quota block AFTER the claim release", async () => {
    const h = makeFinishDeps({ commitCount: 0 });
    const r = await runFinish(h.deps, ranInput({ authorRaw: OUTCOME_TIMEOUT_429 }));
    assert.equal(r.action, "release-nothing-produced");
    const releaseIdx = h.calls.indexOf(`label:77:r=in-progress:a=ready-for-agent`);
    const quotaIdx = h.calls.indexOf(`write:${QUOTA_FILE}`);
    assert.ok(releaseIdx >= 0 && quotaIdx > releaseIdx, `the quota block must be recorded after the release:\n${h.calls.join("\n")}`);
    // No parseable reset clause in the fixture stdout -> the 60-min fallback.
    assert.equal(r.quotaBlockedUntil, NOW_SEC + QUOTA_BLOCK_FALLBACK_SECONDS);
    assert.equal(h.files.get(QUOTA_FILE), `${NOW_SEC + QUOTA_BLOCK_FALLBACK_SECONDS}\n`);
    assert.match(h.logs.join("\n"), /recorded z\.ai quota block until /);
  });

  test("a 429 stdout on an arm that is NOT nothing-produced records no block (bash parity: evidence, only there)", async () => {
    const h = makeFinishDeps({ commitCount: 1, prBody: null });
    const r = await runFinish(h.deps, ranInput({ authorRaw: OUTCOME_TIMEOUT_429 }));
    assert.equal(r.action, "keep-partial-for-resume");
    assert.equal(r.quotaBlockedUntil, null);
    assert.equal(h.files.has(QUOTA_FILE), false);
  });

  test("effect isolation: a REJECTING worktree removal WARNs and the release still happens", async () => {
    const h = makeFinishDeps({ rejectEffects: ["removeWorktree"] });
    const r = await runFinish(h.deps, ranInput({ authorRaw: "", authorExitCode: 1 }));
    assert.equal(r.action, "release-not-authored");
    assert.match(h.logs.join("\n"), /WARN worktree remove \(\/repo\/wts\/agent-glm-77-1\) threw \(non-fatal\)/);
    assert.ok(h.calls.includes(`label:77:r=in-progress:a=ready-for-agent`), "the release must still run");
  });

  test("effect isolation: a throwing evidence dep on the ran path degrades, never crashes (finish-fault backstop)", async () => {
    // countCommits reads through the guarded runGit; make it throw so the
    // top-level catch fires and the best-effort plain release still lands.
    const h = makeFinishDeps({ commitCount: 1, rejectEffects: ["editIssueLabels"] });
    const r = await runFinish(h.deps, ranInput());
    // The label seam throwing on the advance arm is caught per-effect (WARN),
    // not by the top-level catch — the arm completes.
    assert.equal(r.action, "open-pr");
    assert.match(h.logs.join("\n"), /WARN advance issue #77 to needs-qa threw \(non-fatal\)/);
  });

  test("finish-fault: an exception inside the arm falls back to a best-effort plain release and reports it", async () => {
    const h = makeFinishDeps({});
    // The very FIRST journal write throws — the fault propagates out of
    // finishInner into runFinish's top-level catch. The catch's best-effort
    // releaseClaim rides `safe`, which does not journal on the success path,
    // so the plain release lands even with the log sink broken (its own
    // nested catch is the backstop if it ever did throw).
    h.deps.log = () => { throw new Error("injected log sink failure"); };
    const r = await runFinish(h.deps, ranInput({ authorRaw: "", authorExitCode: 1 }));
    assert.equal(r.action, "finish-fault");
    assert.equal(r.issue, 77);
    assert.match(String(r.detail), /injected log sink failure/);
    assert.ok(h.calls.includes(`label:77:r=in-progress:a=ready-for-agent`), "the best-effort plain release still landed");
    assert.deepEqual(r.labels, []);
  });
});

// ---------------------------------------------------------------------------
// runFinish — dry-run is hermetic (INV-12, delta a)
// ---------------------------------------------------------------------------

describe("runFinish — DRY_RUN walks the would-ladder with ZERO effect calls", () => {
  test("ran + timed out: every skipped effect logs exactly one would- line, no dep is touched", async () => {
    const h = makeFinishDeps({ dryRun: true, commitCount: 0, prBody: null });
    const r = await runFinish(h.deps, ranInput({ authorRaw: OUTCOME_TIMEOUT }));
    assert.equal(r.action, "open-pr");
    assert.equal(r.dryRun, true);
    assert.deepEqual(r.labels, [NEEDS_QA]);
    assert.deepEqual(
      h.calls,
      [],
      `dry-run must make zero gh/git/preflight/file-write dep calls:\n${h.calls.join("\n")}`,
    );
    const journal = h.logs.join("\n");
    for (const line of [
      "would-increment timeout-counter for issue #77 (DRY_RUN=1)",
      "would-append GLM drainer timeout note to ",
      "would-preflight (DRY_RUN=1)",
      "preflight passed for issue #77 — opening PR",
      "would-open-pr issue #77 branch=worktree-agent-glm-77-1790000000 (DRY_RUN=1)",
      "would-remove timeout-counter for issue #77 (DRY_RUN=1)",
      "would-advance issue #77 to needs-qa (DRY_RUN=1)",
      "would-increment daily-cap counter (DRY_RUN=1)",
      "issue #77: PR opened (branch=worktree-agent-glm-77-1790000000), advanced to needs-qa, daily cap incremented",
      `would-remove-worktree ${WT} (DRY_RUN=1)`,
    ]) {
      assert.ok(journal.includes(line), `expected journal line "${line}" in:\n${journal}`);
    }
    // Delta (a): no title read under dry-run.
    assert.doesNotMatch(journal, /Fake issue title/);
    assert.equal(h.files.has(TIMEOUT_FILE), false);
    assert.equal(h.files.has(CAP_FILE), false);
  });

  test("not-authored under dry-run: would-release + would-remove-worktree only", async () => {
    const h = makeFinishDeps({ dryRun: true });
    const r = await runFinish(h.deps, ranInput({ authorRaw: "", authorExitCode: 1 }));
    assert.equal(r.action, "release-not-authored");
    assert.equal(r.dryRun, true);
    assert.deepEqual(h.calls, []);
    const journal = h.logs.join("\n");
    assert.ok(journal.includes(`would-remove-worktree ${WT} (DRY_RUN=1)`));
    assert.ok(journal.includes("would-release issue #77 (in-progress -> ready-for-agent, withhold=false, DRY_RUN=1)"));
  });
});

// ---------------------------------------------------------------------------
// The `finish` driver mode (INV-10)
// ---------------------------------------------------------------------------

describe("runDriverMode('finish') — one FinishResult JSON line, exit 0 (issue #4685 INV-10)", () => {
  const base = { env: {} } as unknown as DriverDeps;
  const AUTHOR_PATH = "/tmp/hydra-glm-drainer-author-77.json";

  function depsWith(h: ReturnType<typeof makeFinishDeps>, file: string): DriverDeps {
    return { ...base, readFile: () => file, finish: h.deps };
  }

  test("ran outcome with worktree+branch: prints the FinishResult line, exit 0", async () => {
    const h = makeFinishDeps({ commitCount: 2, changedPaths: ["src/glm/finish.ts"] });
    const out = await runDriverMode(["finish", "77", AUTHOR_PATH, "0", WT, BRANCH], depsWith(h, OUTCOME_CLEAN));
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.exitCode, 0);
    const parsed = JSON.parse(out.line) as FinishResult;
    assert.equal(parsed.action, "open-pr");
    assert.equal(parsed.issue, 77);
    assert.deepEqual(parsed.labels, [NEEDS_QA]);
    assert.equal(parsed.dryRun, false);
    assert.deepEqual(Object.keys(parsed).sort(), ["action", "dryRun", "issue", "labels", "pr", "quotaBlockedUntil"]);
  });

  test("an unreadable author-outcome file is the empty string -> the driver-fault ARM, exit 0 (delta d)", async () => {
    const h = makeFinishDeps();
    const deps = { ...base, readFile: () => { throw new Error("ENOENT"); }, finish: h.deps };
    const out = await runDriverMode(["finish", "77", AUTHOR_PATH, "0", WT, BRANCH], deps);
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.exitCode, 0);
    const parsed = JSON.parse(out.line) as FinishResult;
    assert.equal(parsed.action, "release-not-authored");
    assert.ok(h.calls.includes(`label:77:r=in-progress:a=ready-for-agent`), "the claim is salvaged, not crashed on");
  });

  test("a ran outcome WITHOUT worktree and branch is bad-argv (exit-1 arm)", async () => {
    const out = await runDriverMode(["finish", "77", AUTHOR_PATH, "0"], depsWith(makeFinishDeps(), OUTCOME_CLEAN));
    assert.deepEqual(out, {
      ok: false,
      code: "glm-driver-bad-argv",
      message: "finish mode requires <worktree> <branch> for a ran author outcome",
    });
  });

  test("a NOT-RUN outcome without worktree and branch is VALID (the synthetic worktree-create-failure path)", async () => {
    const h = makeFinishDeps();
    const out = await runDriverMode(["finish", "77", AUTHOR_PATH, "0"], depsWith(h, OUTCOME_NOT_RUN));
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(JSON.parse(out.line).action, "release-not-authored");
  });

  test("missing/bad positionals are bad-argv", async () => {
    const cases: string[][] = [
      ["finish"],
      ["finish", "77"],
      ["finish", "77", AUTHOR_PATH],
      ["finish", "not-a-number", AUTHOR_PATH, "0", WT, BRANCH],
      ["finish", "77", AUTHOR_PATH, "not-a-number", WT, BRANCH],
    ];
    for (const argv of cases) {
      const out = await runDriverMode(argv, depsWith(makeFinishDeps(), OUTCOME_CLEAN));
      assert.equal(out.ok, false, `expected bad-argv for ${argv.join(" ")}`);
      if (out.ok === false) assert.equal(out.code, "glm-driver-bad-argv");
    }
  });
});
