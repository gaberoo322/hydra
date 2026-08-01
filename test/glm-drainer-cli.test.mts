/**
 * test/glm-drainer-cli.test.mts — coverage for the bash-to-TypeScript bridge
 * `scripts/glm/drainer-cli.ts` (issue #3689, ADR-0032), which
 * `scripts/glm/drainer-loop.sh` shells out to for the two seams a bash
 * script cannot reach directly:
 *
 *   heartbeat  -> setGlmDrainerHeartbeat (src/redis/autopilot.ts)
 *   preflight  -> preflightBeforePr (src/glm/drainer-runner.ts)
 *
 * These run the REAL compiled subcommand as a child process (the same
 * invocation the loop uses: `node --experimental-strip-types
 * scripts/glm/drainer-cli.ts <cmd> ...`), asserting exit code + the
 * single-line stdout/stderr contract the loop branches on. `heartbeat`
 * touches the real (test-DB-isolated) Redis; `preflight` touches no Redis —
 * it runs the Verifier-Core path match + tier classifier + the real
 * `scripts/ci/secret-scan.sh` over harmless, already-tracked repo files.
 *
 * New top-level describe, no shared teardown with any sibling suite.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import Redis from "ioredis";

import { GLM_DRAINER_ACTIVE_KEY } from "../src/redis/autopilot.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO_ROOT, "scripts", "glm", "drainer-cli.ts");
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/1";

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(
    "node",
    ["--experimental-strip-types", CLI, ...args],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("scripts/glm/drainer-cli.ts heartbeat subcommand (#3689)", () => {
  let redis: any;
  before(() => {
    redis = new Redis(REDIS_URL);
  });
  after(async () => {
    if (redis) {
      await redis.del(GLM_DRAINER_ACTIVE_KEY);
      redis.disconnect();
    }
  });

  test("writes the heartbeat and exits 0 with the one-line success marker", async () => {
    await redis.del(GLM_DRAINER_ACTIVE_KEY);
    const before_ = Date.now();
    const r = runCli(["heartbeat"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^heartbeat-ok$/m);
    const raw = Number(await redis.get(GLM_DRAINER_ACTIVE_KEY));
    assert.ok(raw >= before_);
  });
});

describe("scripts/glm/drainer-cli.ts preflight subcommand (#3689)", () => {
  test("a Verifier-Core path blocks: exit 1, stderr names the violation", () => {
    const r = runCli(["preflight", "src/untouchable.ts"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /preflight-blocked/);
    assert.match(r.stderr, /Verifier-Core/);
  });

  test("harmless in-fence paths pass: exit 0, one-line success marker", () => {
    // package.json is tracked, contains no secret-like strings, and is not a
    // Verifier-Core path — a clean T2/T3-shaped diff target.
    const r = runCli(["preflight", "package.json"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^preflight-ok checked=1$/m);
  });

  test("an empty path list short-circuits to a clean pass (no diff to leak)", () => {
    const r = runCli(["preflight"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^preflight-ok checked=0$/m);
  });

  test("unknown subcommand exits 2 with a usage message on stderr", () => {
    const r = runCli(["bogus"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown subcommand/);
  });
});
