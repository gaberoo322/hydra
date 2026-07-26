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
  GLM_MODEL_SLOT,
  STRIPPED_ENV_KEYS,
  buildDrainerArgs,
  buildGlmEnv,
  preflightBeforePr,
  runGlmClaude,
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
  test("pins the z.ai endpoint, the Sonnet slot, and the CLI timeout", () => {
    assert.equal(GLM_ANTHROPIC_BASE_URL, "https://api.z.ai/api/anthropic");
    assert.equal(GLM_API_TIMEOUT_MS, 3_000_000);
    assert.equal(GLM_MODEL_SLOT, "sonnet");
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
  test("always pins --settings and the Sonnet model slot", () => {
    const args = buildDrainerArgs({ prompt: "work issue #1" });
    assert.equal(args.includes("--settings"), true);
    assert.equal(args[args.indexOf("--settings") + 1], DRAINER_SETTINGS_PATH);
    assert.equal(args[args.indexOf("--model") + 1], GLM_MODEL_SLOT);
    assert.equal(args[args.indexOf("-p") + 1], "work issue #1");
  });

  test("the auth token is never an argv entry (argv is world-readable)", () => {
    const env = buildGlmEnv({ ANTHROPIC_AUTH_TOKEN: FAKE_TOKEN });
    assert.equal(env.ok, true);
    const args = buildDrainerArgs({ prompt: "author the change", extraArgs: ["--verbose"] });
    assert.equal(args.join(" ").includes(FAKE_TOKEN), false);
    assert.equal(args.join(" ").includes("ANTHROPIC_AUTH_TOKEN"), false);
    assert.equal(args.includes("--verbose"), true);
  });

  test("honors an explicit settings path and model override", () => {
    const args = buildDrainerArgs({
      prompt: "p",
      settingsPath: "/tmp/other-settings.json",
      model: "haiku",
    });
    assert.equal(args[args.indexOf("--settings") + 1], "/tmp/other-settings.json");
    assert.equal(args[args.indexOf("--model") + 1], "haiku");
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
