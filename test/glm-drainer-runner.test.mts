/**
 * test/glm-drainer-runner.test.mts — pin the GLM dev-drainer spawn wrapper
 * (issue #3688, ADR-0032).
 *
 * Every case drives an INJECTED seam — a fake `spawn` child and a fake
 * secret-scan runner — so no live `claude` process and no live
 * `scripts/ci/secret-scan.sh` run in CI. The suite asserts the ADR-0032
 * invariants the wrapper is responsible for: the precise env mechanism
 * (invariant 4), fail-closed credentials (invariant 7), and both halves of the
 * two-layer secret fence (invariant 8).
 *
 * New top-level describe with its own trivial lifecycle — it touches no shared
 * Redis seam, so it never piggybacks a sibling suite's teardown.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";

import {
  DRAINER_SETTINGS_PATH,
  DRAINER_SETTINGS_RELATIVE_PATH,
  GLM_ANTHROPIC_BASE_URL,
  GLM_API_TIMEOUT_MS,
  GLM_MODEL,
  assertGlmModel,
  STRIPPED_ENV_KEYS,
  buildDrainerArgs,
  buildGlmEnv,
  preflightBeforePr,
  runGlmClaude,
  scanTierFence,
  scanVerifierCorePaths,
} from "../src/glm/drainer-runner.ts";

const FAKE_TOKEN = "zai-token-not-a-real-credential";

/** A fake child that emits canned stdout/stderr then closes with exitCode. */
function fakeSpawn(
  stdout: string,
  stderr: string,
  exitCode: number,
  captured?: { bin?: string; args?: string[]; opts?: any },
): any {
  return (bin: string, args: string[], opts: any): any => {
    if (captured) {
      captured.bin = bin;
      captured.args = args;
      captured.opts = opts;
    }
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      if (stdout) child.stdout.emit("data", Buffer.from(stdout));
      if (stderr) child.stderr.emit("data", Buffer.from(stderr));
      child.emit("close", exitCode);
    });
    return child;
  };
}

/** A secret-scan runner that records its input and returns a canned verdict. */
function fakeScan(
  exitCode: number,
  stderr = "",
  calls?: string[][],
): (files: readonly string[]) => Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  return async (files) => {
    calls?.push([...files]);
    return { exitCode, stdout: "", stderr };
  };
}

describe("glm drainer-runner — env mechanism (ADR-0032 invariants 4 + 7)", () => {
  test("pins the z.ai endpoint, an explicit glm-* model, and the CLI timeout", () => {
    assert.equal(GLM_ANTHROPIC_BASE_URL, "https://api.z.ai/api/anthropic");
    assert.equal(GLM_API_TIMEOUT_MS, 3_000_000);
    // #3758: the model name is a routing fence, not a preference. An Anthropic
    // slot alias would be resolved locally by the CLI and sent first-party,
    // ignoring the base-URL override and burning the quota this lane relieves.
    assert.equal(GLM_MODEL.startsWith("glm-"), true, "default model must be an explicit glm-* name");
  });

  test("fail-closed: an absent ANTHROPIC_AUTH_TOKEN aborts instead of defaulting", () => {
    const result = buildGlmEnv({});
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.code, "glm-auth-token-missing");
    assert.match(
      result.ok === false ? result.message : "",
      /ANTHROPIC_AUTH_TOKEN is unset or blank/,
    );
  });

  test("fail-closed: a blank/whitespace token is treated as absent", () => {
    const result = buildGlmEnv({ ANTHROPIC_AUTH_TOKEN: "   " });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.code, "glm-auth-token-missing");
  });

  test("fail-closed even when an Anthropic API key is present (no silent fallback)", () => {
    const result = buildGlmEnv({ ANTHROPIC_API_KEY: "sk-ant-whatever" });
    assert.equal(result.ok, false);
  });

  test("sets base URL + auth token + API_TIMEOUT_MS on success", () => {
    const result = buildGlmEnv({ ANTHROPIC_AUTH_TOKEN: `  ${FAKE_TOKEN}  `, PATH: "/usr/bin" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.env.ANTHROPIC_BASE_URL, GLM_ANTHROPIC_BASE_URL);
    assert.equal(result.env.ANTHROPIC_AUTH_TOKEN, FAKE_TOKEN);
    assert.equal(result.env.API_TIMEOUT_MS, "3000000");
    // Unrelated env is carried through so the CLI still resolves its PATH.
    assert.equal(result.env.PATH, "/usr/bin");
  });

  test("strips ANTHROPIC_API_KEY so the CLI can never fall back to Anthropic quota", () => {
    const result = buildGlmEnv({
      ANTHROPIC_AUTH_TOKEN: FAKE_TOKEN,
      ANTHROPIC_API_KEY: "sk-ant-should-be-removed",
      ANTHROPIC_AUTH_TOKEN_FILE: "/tmp/nope",
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    for (const key of STRIPPED_ENV_KEYS) {
      assert.equal(key in result.env, false, `${key} must not survive into the drainer env`);
    }
  });

  test("never mutates the base env object it was handed", () => {
    const base: NodeJS.ProcessEnv = {
      ANTHROPIC_AUTH_TOKEN: FAKE_TOKEN,
      ANTHROPIC_API_KEY: "sk-ant-still-here",
    };
    const result = buildGlmEnv(base);
    assert.equal(result.ok, true);
    assert.equal(base.ANTHROPIC_API_KEY, "sk-ant-still-here");
    assert.equal(base.ANTHROPIC_BASE_URL, undefined);
  });
});

describe("glm drainer-runner — argv construction", () => {
  test("always pins --settings and the default glm-* model", () => {
    const built = buildDrainerArgs({ prompt: "work issue #1" });
    assert.equal(built.ok, true);
    if (!built.ok) return;
    const args = built.args;
    assert.equal(args.includes("--settings"), true);
    assert.equal(args[args.indexOf("--settings") + 1], DRAINER_SETTINGS_PATH);
    assert.equal(args[args.indexOf("--model") + 1], GLM_MODEL);
    assert.equal(args[args.indexOf("-p") + 1], "work issue #1");
  });

  test("the auth token is never an argv entry (argv is world-readable)", () => {
    const env = buildGlmEnv({ ANTHROPIC_AUTH_TOKEN: FAKE_TOKEN });
    assert.equal(env.ok, true);
    const built = buildDrainerArgs({ prompt: "author the change", extraArgs: ["--verbose"] });
    assert.equal(built.ok, true);
    if (!built.ok) return;
    assert.equal(built.args.join(" ").includes(FAKE_TOKEN), false);
    assert.equal(built.args.join(" ").includes("ANTHROPIC_AUTH_TOKEN"), false);
    assert.equal(built.args.includes("--verbose"), true);
  });

  test("honors an explicit settings path and a glm-* model override", () => {
    const built = buildDrainerArgs({
      prompt: "p",
      settingsPath: "/tmp/other-settings.json",
      model: "glm-4.7",
    });
    assert.equal(built.ok, true);
    if (!built.ok) return;
    assert.equal(built.args[built.args.indexOf("--settings") + 1], "/tmp/other-settings.json");
    assert.equal(built.args[built.args.indexOf("--model") + 1], "glm-4.7");
  });

  // #3758 regression: the base-URL override does NOT redirect an Anthropic slot
  // alias — the CLI resolves it locally and calls Anthropic first-party. These
  // model names previously built valid argv, which is precisely the defect.
  for (const alias of ["sonnet", "opus", "haiku", "claude-sonnet-5", "SONNET", " sonnet "]) {
    test(`rejects the first-party-routing model name ${JSON.stringify(alias)}`, () => {
      const built = buildDrainerArgs({ prompt: "p", model: alias });
      assert.equal(built.ok, false, `${alias} must not build runnable argv`);
      assert.equal(built.ok === false && built.code, "glm-model-would-route-first-party");
      assert.match(built.ok === false ? built.message : "", /3758/);
    });
  }

  test("assertGlmModel accepts glm-* names and rejects everything else", () => {
    assert.equal(assertGlmModel("glm-5.2").ok, true);
    assert.equal(assertGlmModel("glm-4.7").ok, true);
    assert.equal(assertGlmModel("GLM-5.2").ok, true);
    assert.equal(assertGlmModel("sonnet").ok, false);
    assert.equal(assertGlmModel("").ok, false);
  });

  test("the rejection message never suggests an Anthropic slot alias as the fix", () => {
    const built = buildDrainerArgs({ prompt: "p", model: "sonnet" });
    assert.equal(built.ok, false);
    if (built.ok) return;
    assert.match(built.message, /glm-/);
  });
});

describe("glm drainer-runner — subprocess seam", () => {
  test("hands the fenced env and cwd to spawn", async () => {
    const captured: { bin?: string; args?: string[]; opts?: any } = {};
    const env = buildGlmEnv({ ANTHROPIC_AUTH_TOKEN: FAKE_TOKEN });
    assert.equal(env.ok, true);
    if (!env.ok) return;
    await runGlmClaude(fakeSpawn("ok", "", 0, captured), "claude", ["-p", "x"], 5_000, {
      env: env.env,
      cwd: "/tmp/worktree",
    });
    assert.equal(captured.bin, "claude");
    assert.equal(captured.opts.cwd, "/tmp/worktree");
    assert.equal(captured.opts.env.ANTHROPIC_BASE_URL, GLM_ANTHROPIC_BASE_URL);
    assert.deepEqual(captured.opts.stdio, ["ignore", "pipe", "pipe"]);
  });

  test("resolves with {code,stdout,stderr} regardless of a non-zero exit code", async () => {
    const run = await runGlmClaude(fakeSpawn("out", "err", 1), "claude", [], 5_000, { env: {} });
    assert.deepEqual(run, { code: 1, stdout: "out", stderr: "err" });
  });

  test("rejects when spawn throws synchronously", async () => {
    const throwingSpawn: any = () => {
      throw new Error("ENOENT claude");
    };
    await assert.rejects(
      runGlmClaude(throwingSpawn, "claude", [], 5_000, { env: {} }),
      /glm-drainer spawn failed: ENOENT claude/,
    );
  });

  test("rejects on a child 'error' event", async () => {
    const erroringSpawn: any = () => {
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setImmediate(() => child.emit("error", new Error("spawn EACCES")));
      return child;
    };
    await assert.rejects(
      runGlmClaude(erroringSpawn, "claude", [], 5_000, { env: {} }),
      /glm-drainer spawn failed: spawn EACCES/,
    );
  });

  test("SIGKILLs and rejects on timeout", async () => {
    const signals: string[] = [];
    const hangingSpawn: any = () => {
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = (sig: string) => {
        signals.push(sig);
      };
      return child; // never closes
    };
    await assert.rejects(
      runGlmClaude(hangingSpawn, "claude", [], 10, { env: {} }),
      /glm-drainer timed out after 10ms/,
    );
    assert.deepEqual(signals, ["SIGKILL"]);
  });
});

describe("glm drainer-runner — pre-PR preflight (ADR-0032 invariant 8)", () => {
  test("scanVerifierCorePaths flags T4 paths and ignores in-fence ones", () => {
    const violations = scanVerifierCorePaths([
      "src/glm/drainer-runner.ts",
      ".github/workflows/ci.yml",
      "src/untouchable.ts",
      "docs/adr/0032-glm-dev-drainer-worker-lane.md",
    ]);
    assert.equal(violations.length, 2);
    assert.deepEqual(
      violations.map((v) => v.kind === "verifier-core" && v.path).sort(),
      [".github/workflows/ci.yml", "src/untouchable.ts"],
    );
    assert.equal(
      violations.every((v) => v.kind === "verifier-core" && v.matched === v.path),
      true,
    );
  });

  test("passes a clean in-fence diff", async () => {
    const calls: string[][] = [];
    const result = await preflightBeforePr({
      changedPaths: ["src/glm/drainer-runner.ts", "test/glm-drainer-runner.test.mts"],
      secretScan: fakeScan(0, "", calls),
    });
    assert.equal(result.ok, true);
    assert.equal(result.ok === true && result.checkedPaths, 2);
    assert.deepEqual(calls, [["src/glm/drainer-runner.ts", "test/glm-drainer-runner.test.mts"]]);
  });

  test("BLOCKS on a secret-scan hit", async () => {
    const result = await preflightBeforePr({
      changedPaths: ["src/leaky.ts"],
      secretScan: fakeScan(1, "secret-scan: credential-like string in src/leaky.ts (line(s): 4)"),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "glm-preflight-blocked");
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].kind, "secret-scan");
    assert.match(result.message, /credential-like string in src\/leaky\.ts/);
  });

  test("BLOCKS on a Verifier-Core / T4 diff even when the secret scan is clean", async () => {
    const result = await preflightBeforePr({
      changedPaths: ["src/tier-classifier.ts"],
      secretScan: fakeScan(0),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(result.violations, [
      { kind: "verifier-core", path: "src/tier-classifier.ts", matched: "src/tier-classifier.ts" },
    ]);
    assert.match(result.message, /Verifier-Core\/T4 path src\/tier-classifier\.ts/);
  });

  test("reports BOTH violation kinds when the diff trips both fences", async () => {
    const result = await preflightBeforePr({
      changedPaths: [".github/workflows/deploy.yml", "src/leaky.ts"],
      secretScan: fakeScan(1, "secret-scan: credential-like string in src/leaky.ts (line(s): 9)"),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(result.violations.map((v) => v.kind).sort(), [
      "secret-scan",
      "verifier-core",
    ]);
  });

  test("fails CLOSED when the scanner itself cannot run", async () => {
    const result = await preflightBeforePr({
      changedPaths: ["src/anything.ts"],
      secretScan: async () => {
        throw new Error("bash: not found");
      },
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.violations[0].kind, "secret-scan");
    assert.match(result.message, /could not be run: bash: not found/);
  });

  test("a scanner usage error (exit 2) is also blocking", async () => {
    const result = await preflightBeforePr({
      changedPaths: ["src/anything.ts"],
      secretScan: fakeScan(2, "usage"),
    });
    assert.equal(result.ok, false);
  });

  test("scanTierFence independently blocks a T4 diff (classifyChange corroboration)", () => {
    const violation = scanTierFence(["src/untouchable.ts"]);
    assert.notEqual(violation, null);
    assert.equal(violation?.kind, "tier-fence");
    assert.equal(violation?.kind === "tier-fence" && violation.tier, 4);
  });

  test("scanTierFence passes T1/T2/T3 diffs and an empty diff", () => {
    assert.equal(scanTierFence(["config/agents/hydra-dev.md"]), null); // T1
    assert.equal(scanTierFence(["dashboard/src/App.tsx"]), null); // T2
    assert.equal(scanTierFence(["src/glm/drainer-runner.ts"]), null); // T3
    assert.equal(scanTierFence([]), null);
  });

  test("the two T4 checks agree today, so preflight reports the path detail only once", async () => {
    // scanTierFence would also flag this diff; preflight suppresses the
    // duplicate so the actionable per-path violation is the only one reported.
    const result = await preflightBeforePr({
      changedPaths: ["src/untouchable.ts"],
      secretScan: fakeScan(0),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(result.violations.map((v) => v.kind), ["verifier-core"]);
  });

  test("an empty diff short-circuits and never invokes the scanner", async () => {
    const calls: string[][] = [];
    const result = await preflightBeforePr({
      changedPaths: [],
      secretScan: fakeScan(1, "would have blocked", calls),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(calls, []);
  });
});

describe("glm drainer settings.json — input-side secret fence", () => {
  test("the settings file referenced by the runner exists and parses", () => {
    assert.match(DRAINER_SETTINGS_PATH, /config\/glm\/drainer-settings\.json$/);
    assert.equal(DRAINER_SETTINGS_RELATIVE_PATH, "config/glm/drainer-settings.json");
    const settings = JSON.parse(readFileSync(DRAINER_SETTINGS_PATH, "utf8"));
    assert.equal(typeof settings.permissions, "object");
    assert.equal(Array.isArray(settings.permissions.deny), true);
    assert.equal(Array.isArray(settings.permissions.allow), true);
  });

  test("permissions.deny hard-blocks reads of .env files", () => {
    const settings = JSON.parse(readFileSync(DRAINER_SETTINGS_PATH, "utf8"));
    const deny: string[] = settings.permissions.deny;
    for (const rule of ["Read(.env)", "Read(.env.*)", "Read(**/.env)", "Read(**/.env.*)"]) {
      assert.equal(deny.includes(rule), true, `deny must contain ${rule}`);
    }
  });

  test("permissions.deny also blocks the adjacent credential surfaces", () => {
    const settings = JSON.parse(readFileSync(DRAINER_SETTINGS_PATH, "utf8"));
    const deny: string[] = settings.permissions.deny;
    for (const rule of [
      "Read(**/secrets/**)",
      "Read(**/*credential*)",
      "Read(**/*.pem)",
      "Read(**/*.key)",
      "Read(//home/gabe/.claude/.credentials.json)",
      "Read(//home/gabe/.ssh/**)",
    ]) {
      assert.equal(deny.includes(rule), true, `deny must contain ${rule}`);
    }
  });

  test("no allow rule re-opens a denied credential path", () => {
    const settings = JSON.parse(readFileSync(DRAINER_SETTINGS_PATH, "utf8"));
    const allow: string[] = settings.permissions.allow;
    // Broad tool grants (bare `Read`) are fine — deny is evaluated first — but a
    // path-scoped allow naming a credential surface would be a real regression.
    for (const rule of allow) {
      assert.equal(
        /\.env|credential|secret|\.ssh|\.aws|\.pem|\.key/i.test(rule),
        false,
        `allow rule ${rule} names a credential surface`,
      );
    }
  });
});

/**
 * The write-side fence (issue #3790). Until this fix, `Write`/`Edit`/
 * `NotebookEdit` were granted bare above with NO path constraint — the
 * `deny` list only path-scoped `Read(...)`, which has zero effect on any
 * other tool, and a GLM session used exactly that gap on 2026-07-27 to write
 * to operator memory outside the worktree. The fix ships two independent
 * mechanisms; these cases pin both so a future edit to this JSON can't
 * silently drop either one without a test going red (the same "reads as a
 * fence but is not one" failure class already caught once on PR #3701).
 */
describe("glm drainer settings.json — write-side fence (issue #3790)", () => {
  const settings = JSON.parse(readFileSync(DRAINER_SETTINGS_PATH, "utf8"));
  const deny: string[] = settings.permissions.deny;

  test("permissions.deny mirrors every Read(...) credential rule with an Edit(...) rule", () => {
    // Edit(...) is the only tool-scoped rule form verified to hold (Write(...)
    // and NotebookEdit(...) path rules are silently ignored by the CLI) —
    // see the file's own `_comment` block. Every credential-adjacent pattern
    // rule below must exist as BOTH Read(...) and Edit(...).
    for (const rule of [
      "Edit(.env)",
      "Edit(.env.*)",
      "Edit(**/.env)",
      "Edit(**/.env.*)",
      "Edit(**/*.env)",
      "Edit(**/secrets/**)",
      "Edit(**/*credential*)",
      "Edit(**/*.pem)",
      "Edit(**/*.key)",
      "Edit(**/id_rsa*)",
    ]) {
      assert.equal(deny.includes(rule), true, `deny must contain ${rule}`);
    }
  });

  test("permissions.deny fences the operator home surfaces with doubled-leading-slash absolute Edit(...) rules", () => {
    // A single leading slash is silently NOT treated as absolute and does not
    // fence (verified live, per the `_comment` block) — pin the doubled form.
    for (const rule of [
      "Edit(//home/gabe/.claude/**)",
      "Edit(//home/gabe/.config/**)",
      "Edit(//home/gabe/.ssh/**)",
      "Edit(//home/gabe/.aws/**)",
    ]) {
      assert.equal(deny.includes(rule), true, `deny must contain ${rule}`);
      assert.equal(rule.startsWith("Edit(//"), true, `${rule} must use the doubled leading slash`);
    }
  });

  test("no Edit(...) deny rule uses an unfenced single leading slash for an absolute home path", () => {
    // A single-leading-slash absolute form (`Edit(/home/gabe/...)`) reads as a
    // fence but silently is not one — guard against it creeping back in.
    for (const rule of deny) {
      if (!rule.startsWith("Edit(")) continue;
      const inner = rule.slice("Edit(".length, -1);
      if (inner.startsWith("/home/")) {
        assert.fail(`${rule} uses a single leading slash, which does not fence an absolute path`);
      }
    }
  });

  test("settings.hooks.PreToolUse wires the worktree-write-fence.sh hook for the main-checkout boundary", () => {
    // Mechanism 2 (issue #549 reuse): a static deny can't express "outside MY
    // worktree" without hardcoding a per-dispatch worktree id, so the main
    // checkouts (/home/gabe/hydra, /home/gabe/hydra-betting) are fenced by
    // this cwd-relative hook instead. Pin its presence, matcher, and target
    // script so a future edit can't silently drop the whole mechanism.
    assert.equal(typeof settings.hooks, "object", "settings.hooks must be present");
    const preToolUse = settings.hooks.PreToolUse;
    assert.equal(Array.isArray(preToolUse), true, "hooks.PreToolUse must be an array");
    assert.equal(preToolUse.length > 0, true, "hooks.PreToolUse must not be empty");

    const fenceBlock = preToolUse.find((block: any) =>
      Array.isArray(block?.hooks) &&
      block.hooks.some((h: any) => typeof h?.command === "string" && h.command.includes("worktree-write-fence.sh")),
    );
    assert.ok(fenceBlock, "no hooks.PreToolUse block references worktree-write-fence.sh");

    // Matcher covers every file-editing tool the write-side gap could exploit
    // — same tool set the settings file's own Edit(...) rules assume covers
    // Write/NotebookEdit, plus Read for parity with the setup script's own
    // canonical registration (scripts/setup-claude-hooks.sh).
    assert.equal(fenceBlock.matcher, "Edit|Write|MultiEdit|Read");

    const command = fenceBlock.hooks.find((h: any) => typeof h?.command === "string").command;
    assert.match(command, /scripts\/claude-hooks\/worktree-write-fence\.sh$/);
  });

  test("the _comment block documents the write-side boundary and its residual", () => {
    const comment = Array.isArray(settings._comment)
      ? settings._comment.join(" ")
      : String(settings._comment ?? "");
    assert.match(comment, /WRITE-SIDE BOUNDARY/i);
    assert.match(comment, /#3790/);
    // The residual must be stated, not just the happy path — a hook that
    // silently no-ops outside its recognised worktree roots is a real limit,
    // not an implementation detail to omit.
    assert.match(comment, /RESIDUAL/i);
  });
});

/**
 * The Bash surface, pinned separately.
 *
 * The first draft of `drainer-settings.json` granted a bare, unscoped `Bash`
 * and leaned on four `Bash(...)` deny prefixes plus the `Read(...)` deny rules.
 * That is not a fence: `Read(...)` deny rules constrain the Read tool ONLY, so
 * `less .env`, `head ~/.ssh/id_rsa`, `sed -n p .env`, `xxd`, `base64`, `dd`,
 * `strings`, `grep '' .env` and `python3 -c "open(...).read()"` all reached the
 * same credential bytes. QA caught it on PR #3701; these cases exist so it can
 * never silently come back.
 *
 * The fence is now: headless `claude -p` (no `--dangerously-skip-permissions`,
 * so an unmatched tool call cannot fall back to a prompt) + a scoped `allow`
 * list = deny-by-default. Enumerating interpreters in `deny` is deliberately
 * NOT attempted — it is unwinnable and reads as a fence that is not one.
 */
describe("glm drainer settings.json — Bash surface (PR #3701 QA blocker)", () => {
  const settings = JSON.parse(readFileSync(DRAINER_SETTINGS_PATH, "utf8"));
  const allow: string[] = settings.permissions.allow;
  const deny: string[] = settings.permissions.deny;
  const bashAllow = allow.filter((rule) => rule === "Bash" || rule.startsWith("Bash("));

  /** Everything that can read arbitrary file bytes or execute arbitrary code. */
  const FORBIDDEN_COMMAND_HEADS = [
    "cat",
    "less",
    "more",
    "head",
    "tail",
    "sed",
    "awk",
    "xxd",
    "od",
    "hexdump",
    "strings",
    "base64",
    "dd",
    "cp",
    "mv",
    "grep",
    "egrep",
    "rg",
    "find",
    "env",
    "printenv",
    "export",
    "source",
    "eval",
    "exec",
    "bash",
    "sh",
    "zsh",
    "python",
    "python3",
    "perl",
    "ruby",
    "node",
    "npx",
    "curl",
    "wget",
    "nc",
    "ssh",
    "scp",
    "sudo",
    "tar",
    "zip",
    "openssl",
  ];

  test("grants no bare/unscoped Bash", () => {
    assert.equal(
      allow.includes("Bash"),
      false,
      "a bare `Bash` grant defeats every Read(...) deny rule — see this suite's docblock",
    );
    for (const rule of bashAllow) {
      assert.equal(
        rule === "Bash(*)" || rule === "Bash(:*)",
        false,
        `${rule} is a wildcard-equivalent unscoped Bash grant`,
      );
    }
  });

  test("every Bash grant is a scoped command prefix", () => {
    assert.ok(bashAllow.length > 0, "the drainer needs some Bash to author code");
    for (const rule of bashAllow) {
      assert.match(
        rule,
        /^Bash\([a-z0-9][^()]*\)$/,
        `${rule} is not a well-formed scoped Bash rule`,
      );
    }
  });

  test("no Bash grant is a file-read primitive, an interpreter, or a shell", () => {
    for (const rule of bashAllow) {
      const head = rule.slice("Bash(".length, -1).trim().split(/[\s:]/)[0];
      assert.equal(
        FORBIDDEN_COMMAND_HEADS.includes(head),
        false,
        `Bash grant ${rule} exposes \`${head}\`, which can read arbitrary file bytes or run arbitrary code`,
      );
    }
  });

  test("no Bash grant can open a PR or reach the GitHub API directly", () => {
    // PR creation belongs to the drainer loop (#3689), AFTER preflightBeforePr()
    // clears the diff — an in-session `gh pr create` would route around the
    // output-side half of the fence. `gh api`/`gh secret` are arbitrary-endpoint
    // surfaces, including secret endpoints.
    for (const rule of bashAllow) {
      const command = rule.slice("Bash(".length, -1);
      for (const forbidden of ["gh pr create", "gh pr merge", "gh api", "gh secret", "gh auth"]) {
        assert.equal(
          command.startsWith(forbidden),
          false,
          `Bash grant ${rule} exposes \`${forbidden}\``,
        );
      }
    }
  });

  test("the fence is the allow-list, not a Bash deny-list", () => {
    // Pinning the decision, not just the state: a partial Bash deny-list is the
    // exact flawed model that produced the PR #3701 blocker. If a future change
    // adds one back, this fails and forces the reviewer to re-read the docblock.
    assert.deepEqual(
      deny.filter((rule) => rule.startsWith("Bash(")),
      [],
      "Bash deny-listing is unwinnable and must not be reintroduced as a claimed fence",
    );
  });

  test("the _comment no longer claims the Read denials fence Bash", () => {
    const comment = Array.isArray(settings._comment)
      ? settings._comment.join(" ")
      : String(settings._comment ?? "");
    assert.equal(
      /the Read denials are the real fence/i.test(comment),
      false,
      "the corrected model must not reassert that Read(...) denials constrain Bash",
    );
    assert.match(comment, /allow/i);
  });
});
