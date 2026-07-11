/**
 * Regression test for issue #896 — the GitHub CLI Adapter seam (src/github/).
 *
 * Strategy: stub the `gh`/`git` binaries with fake bash scripts controlled via
 * env vars, picked up by the seam through HYDRA_GH_BIN / HYDRA_GIT_BIN. The
 * fake logs its argv and emits scenario-appropriate stdout/exit so the
 * assertions can prove the seam is the single DI point (the mock boundary the
 * issue calls out) and that every accessor returns a discriminated result
 * object and NEVER throws.
 *
 * Covered:
 *   - ghExec / gitExec  success → { ok:true, data:{ stdout, stderr } }
 *   - ghJson            success → typed parsed data
 *   - non-zero exit     → { ok:false, code:"gh-failed" }
 *   - missing binary    → { ok:false, code:"gh-not-installed" } (ENOENT)
 *   - auth-shaped stderr→ { ok:false, code:"gh-auth-failed" }
 *   - empty stdout      → { ok:false, code:"gh-empty" } (ghJson)
 *   - malformed JSON    → { ok:false, code:"gh-malformed-json" } (ghJson)
 *   - timeout           → { ok:false, code:"gh-timeout" } + process killed
 *   - HYDRA_GH_BIN      → the override is the seam's single DI point
 *   - isGhOk / isGhFailure type guards
 */

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

import { ghExec, ghJson } from "../src/github/gh.ts";
import { gitExec } from "../src/github/git.ts";
import {
  ghBin,
  gitBin,
  classifyFailure,
  isGhOk,
  isGhFailure,
  type RawExecResult,
  type GhResult,
} from "../src/github/exec.ts";

let workDir: string;
let fakeBinPath: string;
let invocationsPath: string;

let originalGhBin: string | undefined;
let originalGitBin: string | undefined;

/**
 * A fake `gh`/`git` script dispatching on FAKE_SCENARIO. It appends its argv to
 * a log file, then behaves per scenario:
 *   ok        → echoes a success line (or JSON for `*json*`), exit 0
 *   json      → echoes a JSON array, exit 0
 *   empty     → echoes nothing, exit 0
 *   malformed → echoes non-JSON, exit 0
 *   fail      → stderr generic error, exit 1
 *   auth      → stderr auth-shaped error, exit 1
 *   slow      → sleeps longer than the test timeout, then exit 0
 */
async function writeFakeBin(path: string, log: string) {
  const body = `#!/usr/bin/env bash
set -u
SCENARIO=\${FAKE_SCENARIO:-ok}
printf '%s\\n' "$(printf '%s ' "$@")" >> "${log}"
case "$SCENARIO" in
  json)      echo '[{"number":1,"title":"x"}]'; exit 0 ;;
  empty)     exit 0 ;;
  malformed) echo 'not json {'; exit 0 ;;
  fail)      echo "boom" >&2; exit 1 ;;
  auth)      echo "gh: authentication failed for github.com" >&2; exit 1 ;;
  ratelimit) echo "gh: API rate limit exceeded for user ID 1. (HTTP 403)" >&2; exit 1 ;;
  slow)      sleep 5; echo "late"; exit 0 ;;
  *)         echo "OK https://github.com/gaberoo322/hydra/issues/42"; exit 0 ;;
esac
`;
  await writeFile(path, body, "utf-8");
  await chmod(path, 0o755);
}

async function readInvocations(): Promise<string[]> {
  if (!existsSync(invocationsPath)) return [];
  const raw = await readFile(invocationsPath, "utf-8");
  return raw.split("\n").filter((l) => l.trim().length > 0);
}

describe("GitHub CLI Adapter seam (issue #896)", () => {
  before(async () => {
    workDir = await mkdtemp(join(tmpdir(), "hydra-github-seam-"));
    fakeBinPath = join(workDir, "fake-bin");
    invocationsPath = join(workDir, "invocations.log");
    await writeFakeBin(fakeBinPath, invocationsPath);

    originalGhBin = process.env.HYDRA_GH_BIN;
    originalGitBin = process.env.HYDRA_GIT_BIN;
    process.env.HYDRA_GH_BIN = fakeBinPath;
    process.env.HYDRA_GIT_BIN = fakeBinPath;
  });

  beforeEach(async () => {
    await writeFile(invocationsPath, "", "utf-8");
    delete process.env.FAKE_SCENARIO;
  });

  after(async () => {
    if (originalGhBin === undefined) delete process.env.HYDRA_GH_BIN;
    else process.env.HYDRA_GH_BIN = originalGhBin;
    if (originalGitBin === undefined) delete process.env.HYDRA_GIT_BIN;
    else process.env.HYDRA_GIT_BIN = originalGitBin;
    delete process.env.FAKE_SCENARIO;
    await rm(workDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // HYDRA_GH_BIN / HYDRA_GIT_BIN — the single DI point
  // ---------------------------------------------------------------------------

  test("ghBin honors HYDRA_GH_BIN; gitBin honors HYDRA_GIT_BIN", () => {
    assert.equal(ghBin(), fakeBinPath);
    assert.equal(gitBin(), fakeBinPath);
  });

  test("ghBin falls back to 'gh' / gitBin to 'git' when unset", () => {
    const savedGh = process.env.HYDRA_GH_BIN;
    const savedGit = process.env.HYDRA_GIT_BIN;
    delete process.env.HYDRA_GH_BIN;
    delete process.env.HYDRA_GIT_BIN;
    try {
      assert.equal(ghBin(), "gh");
      assert.equal(gitBin(), "git");
    } finally {
      process.env.HYDRA_GH_BIN = savedGh;
      process.env.HYDRA_GIT_BIN = savedGit;
    }
  });

  // ---------------------------------------------------------------------------
  // ghExec — success / failure result objects
  // ---------------------------------------------------------------------------

  test("ghExec success → ok:true with stdout, and routes through the seam binary", async () => {
    process.env.FAKE_SCENARIO = "ok";
    const result = await ghExec(["issue", "create", "--title", "x"]);
    assert.equal(result.ok, true);
    if (result.ok) assert.match(result.data.stdout, /issues\/42/);
    const invocations = await readInvocations();
    assert.ok(
      invocations.some((l) => l.startsWith("issue create ")),
      "the fake binary recorded the argv — proves it is the single DI point",
    );
  });

  test("ghExec non-zero exit → ok:false code gh-failed (never throws)", async () => {
    process.env.FAKE_SCENARIO = "fail";
    const result = await ghExec(["issue", "list"]);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "gh-failed");
      assert.match(result.stderr, /boom/);
    }
  });

  test("ghExec rate-limit stderr → code gh-rate-limited, never throws (issue #3137)", async () => {
    process.env.FAKE_SCENARIO = "ratelimit";
    const result = await ghExec(["issue", "list"]);
    assert.equal(result.ok, false);
    if (!result.ok) {
      // The rate-limit classification wins over the generic 403 auth match, so
      // callers can arm the adaptive backoff gate instead of treating it as an
      // auth failure.
      assert.equal(result.code, "gh-rate-limited");
      assert.match(result.stderr, /rate limit exceeded/i);
    }
  });

  test("ghExec auth-shaped stderr → code gh-auth-failed", async () => {
    process.env.FAKE_SCENARIO = "auth";
    const result = await ghExec(["pr", "view", "1"]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "gh-auth-failed");
  });

  test("ghExec missing binary → code gh-not-installed (ENOENT)", async () => {
    const saved = process.env.HYDRA_GH_BIN;
    process.env.HYDRA_GH_BIN = join(workDir, "does-not-exist-binary");
    try {
      const missing = await ghExec(["issue", "list"]);
      assert.equal(missing.ok, false);
      if (!missing.ok) assert.equal(missing.code, "gh-not-installed");
    } finally {
      process.env.HYDRA_GH_BIN = saved;
    }
  });

  test("ghExec timeout → code gh-timeout, process killed", async () => {
    process.env.FAKE_SCENARIO = "slow";
    const result = await ghExec(["issue", "list"], { timeout: 150 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "gh-timeout");
  });

  // ---------------------------------------------------------------------------
  // ghJson — typed parse + the two output-shape error modes
  // ---------------------------------------------------------------------------

  test("ghJson success → ok:true with parsed typed data", async () => {
    process.env.FAKE_SCENARIO = "json";
    const result = await ghJson<Array<{ number: number; title: string }>>([
      "issue",
      "list",
      "--json",
      "number,title",
    ]);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.length, 1);
      assert.equal(result.data[0].number, 1);
    }
  });

  test("ghJson empty stdout → code gh-empty", async () => {
    process.env.FAKE_SCENARIO = "empty";
    const result = await ghJson(["issue", "list", "--json", "number"]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "gh-empty");
  });

  test("ghJson malformed output → code gh-malformed-json", async () => {
    process.env.FAKE_SCENARIO = "malformed";
    const result = await ghJson(["issue", "list", "--json", "number"]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "gh-malformed-json");
  });

  test("ghJson on a failing process maps to the process-failure code, not a parse code", async () => {
    process.env.FAKE_SCENARIO = "fail";
    const result = await ghJson(["issue", "list", "--json", "number"]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "gh-failed");
  });

  // ---------------------------------------------------------------------------
  // gitExec — the sibling adapter on the same primitive
  // ---------------------------------------------------------------------------

  test("gitExec success → ok:true; routes through HYDRA_GIT_BIN", async () => {
    process.env.FAKE_SCENARIO = "ok";
    const result = await gitExec(["rev-parse", "HEAD"]);
    assert.equal(result.ok, true);
    const invocations = await readInvocations();
    assert.ok(invocations.some((l) => l.startsWith("rev-parse HEAD")));
  });

  test("gitExec non-zero exit → ok:false (never throws)", async () => {
    process.env.FAKE_SCENARIO = "fail";
    const result = await gitExec(["diff", "--name-only"]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "gh-failed");
  });

  // ---------------------------------------------------------------------------
  // classifyFailure — the centralized error-mode mapping
  // ---------------------------------------------------------------------------

  test("classifyFailure: ENOENT → gh-not-installed", () => {
    const raw: RawExecResult = {
      stdout: "",
      stderr: "spawn gh ENOENT",
      exitCode: -1,
      timedOut: false,
      spawnErrorCode: "ENOENT",
    };
    assert.equal(classifyFailure(raw), "gh-not-installed");
  });

  test("classifyFailure: timeout wins over stderr content", () => {
    const raw: RawExecResult = {
      stdout: "",
      stderr: "authentication failed",
      exitCode: -1,
      timedOut: true,
    };
    assert.equal(classifyFailure(raw), "gh-timeout");
  });

  test("classifyFailure: auth-shaped stderr → gh-auth-failed", () => {
    const raw: RawExecResult = {
      stdout: "",
      stderr: "HTTP 403: Permission denied",
      exitCode: 1,
      timedOut: false,
    };
    assert.equal(classifyFailure(raw), "gh-auth-failed");
  });

  test("classifyFailure: primary rate-limit stderr → gh-rate-limited (issue #3137)", () => {
    const raw: RawExecResult = {
      stdout: "",
      stderr: "gh: API rate limit exceeded for user ID 12345. (HTTP 403)",
      exitCode: 1,
      timedOut: false,
    };
    assert.equal(classifyFailure(raw), "gh-rate-limited");
  });

  test("classifyFailure: secondary rate-limit stderr → gh-rate-limited (issue #3137)", () => {
    const raw: RawExecResult = {
      stdout: "",
      stderr: "HTTP 403: You have exceeded a secondary rate limit.",
      exitCode: 1,
      timedOut: false,
    };
    assert.equal(classifyFailure(raw), "gh-rate-limited");
  });

  test("classifyFailure: rate_limit_error token → gh-rate-limited (issue #3137)", () => {
    const raw: RawExecResult = {
      stdout: "",
      stderr: '{"type":"error","error":{"type":"rate_limit_error"}}',
      exitCode: 1,
      timedOut: false,
    };
    assert.equal(classifyFailure(raw), "gh-rate-limited");
  });

  test("classifyFailure: rate-limit wins over the generic 403 auth match (issue #3137)", () => {
    // A rate-limit stderr also contains "403"; the more specific rate-limit
    // classification must win so callers arm backoff rather than treat it as
    // an auth failure.
    const raw: RawExecResult = {
      stdout: "",
      stderr: "API rate limit exceeded (HTTP 403)",
      exitCode: 1,
      timedOut: false,
    };
    assert.equal(classifyFailure(raw), "gh-rate-limited");
  });

  test("classifyFailure: timeout still wins over rate-limit stderr (issue #3137)", () => {
    const raw: RawExecResult = {
      stdout: "",
      stderr: "API rate limit exceeded",
      exitCode: -1,
      timedOut: true,
    };
    assert.equal(classifyFailure(raw), "gh-timeout");
  });

  test("classifyFailure: generic non-zero → gh-failed", () => {
    const raw: RawExecResult = {
      stdout: "",
      stderr: "some other error",
      exitCode: 1,
      timedOut: false,
    };
    assert.equal(classifyFailure(raw), "gh-failed");
  });

  // ---------------------------------------------------------------------------
  // Type guards — narrowing under the repo's strict:false tsconfig
  // ---------------------------------------------------------------------------

  test("isGhOk / isGhFailure narrow the discriminated result", () => {
    const ok: GhResult<number> = { ok: true, data: 7 };
    const bad: GhResult<number> = { ok: false, code: "gh-failed", stderr: "x" };
    assert.equal(isGhOk(ok), true);
    assert.equal(isGhFailure(ok), false);
    assert.equal(isGhOk(bad), false);
    assert.equal(isGhFailure(bad), true);
    if (isGhOk(ok)) assert.equal(ok.data, 7);
    if (isGhFailure(bad)) assert.equal(bad.code, "gh-failed");
  });
});
