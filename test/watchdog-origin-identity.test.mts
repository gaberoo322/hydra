/**
 * Regression test for issue #4939 — the ## ORIGIN IDENTITY block
 * (`run_origin_identity`) in scripts/hydra-watchdog.sh.
 *
 * Invariants pinned (design-concept INV-5..INV-8):
 *   - alarms when remote.origin.url (normalised, ssh/https/.git tolerant) is
 *     not the orchestrator repo, OR refs/remotes/origin/master is missing;
 *   - exactly one enveloped XADD per episode (since-marker dedup), cleared and
 *     re-armed on recovery;
 *   - read-only: never `git remote`, config writes or fetch;
 *   - records the .git/config mtime and logs an INFO line when it moved;
 *   - fail-safe: always returns 0.
 *
 * The block is SOURCED and called alone (the #4500 seam); a fake `redis-cli`
 * on PATH records the XADD argv so no Redis or docker is needed.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WATCHDOG_SPAWN_TIMEOUT_MS } from "./_helpers/watchdog-timeouts.mts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const WATCHDOG = join(REPO_ROOT, "scripts", "hydra-watchdog.sh");

let tmp: string;
let binDir: string;
let stateDir: string;
let xaddLog: string;
let fakeRoot: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "origin-identity-"));
  binDir = join(tmp, "bin");
  stateDir = join(tmp, "state");
  xaddLog = join(tmp, "xadd.log");
  fakeRoot = join(tmp, "root");
  mkdirSync(binDir);
  mkdirSync(join(fakeRoot, ".git"), { recursive: true });
  writeFileSync(join(fakeRoot, ".git", "config"), "[core]\n");
  const fake = join(binDir, "redis-cli");
  writeFileSync(fake, `#!/usr/bin/env bash\necho "$@" >> "${xaddLog}"\n[ -n "$FAKE_XADD_FAIL" ] || echo "1-0"\n`);
  chmodSync(fake, 0o755);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function tick(env: Record<string, string>): { out: string; rc: number } {
  const r = spawnSync(
    "bash",
    ["-c", `source "${WATCHDOG}"; run_origin_identity; echo "rc=$?"`],
    {
      encoding: "utf-8",
      timeout: WATCHDOG_SPAWN_TIMEOUT_MS,
      env: {
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        HOME: process.env.HOME ?? "/tmp",
        HYDRA_ROOT: fakeRoot,
        HYDRA_REDIS_HOST: "127.0.0.1",
        HYDRA_WATCHDOG_ORIGIN_STATE_DIR: stateDir,
        HYDRA_WATCHDOG_ORIGIN_NOTIFY_STREAM: "test:notifications",
        ...env,
      },
    },
  );
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const m = /rc=(\d+)/.exec(out);
  return { out, rc: m ? Number(m[1]) : -1 };
}

const xadds = (): string[] =>
  existsSync(xaddLog) ? readFileSync(xaddLog, "utf-8").trim().split("\n").filter(Boolean) : [];

describe("run_origin_identity (#4939)", () => {
  it("is silent and returns 0 for the expected https URL with origin/master present", () => {
    const r = tick({
      HYDRA_WATCHDOG_ORIGIN_URL: "https://github.com/gaberoo322/hydra.git",
      HYDRA_WATCHDOG_ORIGIN_MASTER_PRESENT: "1",
    });
    assert.equal(r.rc, 0);
    assert.doesNotMatch(r.out, /ALARM/);
    assert.equal(xadds().length, 0);
  });

  it("accepts the ssh form of the expected repo", () => {
    for (const url of [
      "git@github.com:gaberoo322/hydra.git",
      "ssh://git@github.com/gaberoo322/hydra",
      "https://github.com/gaberoo322/hydra/",
    ]) {
      const r = tick({
        HYDRA_WATCHDOG_ORIGIN_URL: url,
        HYDRA_WATCHDOG_ORIGIN_MASTER_PRESENT: "1",
      });
      assert.doesNotMatch(r.out, /ALARM/, url);
    }
  });

  it("alarms and publishes ONE enveloped event for a Target-repo origin URL, deduped across ticks", () => {
    const env = {
      HYDRA_WATCHDOG_ORIGIN_URL: "https://github.com/gaberoo322/claw-street-bets.git",
      HYDRA_WATCHDOG_ORIGIN_MASTER_PRESENT: "1",
    };
    const first = tick(env);
    assert.equal(first.rc, 0);
    assert.match(first.out, /ALARM .*wrong-origin-url.*claw-street-bets/);
    const entries = xadds();
    assert.equal(entries.length, 1);
    assert.match(entries[0], /XADD test:notifications \*/);
    assert.match(entries[0], /type infra:origin_identity_wrong/);

    const second = tick(env);
    assert.match(second.out, /ALARM/);
    assert.equal(xadds().length, 1, "same episode must not re-publish");
  });

  it("never leaks URL credentials into the log line or the XADD payload", () => {
    const r = tick({
      HYDRA_WATCHDOG_ORIGIN_URL: "https://user:ghp_SECRETTOKEN@github.com/gaberoo322/claw-street-bets.git",
      HYDRA_WATCHDOG_ORIGIN_MASTER_PRESENT: "1",
    });
    assert.match(r.out, /ALARM .*wrong-origin-url.*github\.com\/gaberoo322\/claw-street-bets/);
    assert.doesNotMatch(r.out, /SECRETTOKEN|user:/);
    const entries = xadds();
    assert.equal(entries.length, 1);
    assert.doesNotMatch(entries[0], /SECRETTOKEN|user:/);
  });

  it("redacts userinfo up to the LAST @ (token containing @ never leaks)", () => {
    const r = tick({
      HYDRA_WATCHDOG_ORIGIN_URL: "https://user:ghp_ab@cd@github.com/gaberoo322/claw-street-bets.git",
      HYDRA_WATCHDOG_ORIGIN_MASTER_PRESENT: "1",
    });
    assert.match(r.out, /ALARM .*wrong-origin-url/);
    assert.doesNotMatch(r.out, /ghp_ab|cd@|user:/);
    const entries = xadds();
    assert.equal(entries.length, 1);
    assert.doesNotMatch(entries[0], /ghp_ab|cd@|user:/);
  });

  it("alarms wrong-origin-host when the host is not the expected one", () => {
    const r = tick({
      HYDRA_WATCHDOG_ORIGIN_URL: "https://evil.example/gaberoo322/hydra.git",
      HYDRA_WATCHDOG_ORIGIN_MASTER_PRESENT: "1",
    });
    assert.match(r.out, /ALARM .*wrong-origin-host/);
    assert.doesNotMatch(r.out, /wrong-origin-url/);
    const ok = tick({
      HYDRA_WATCHDOG_ORIGIN_URL: "https://evil.example/gaberoo322/hydra.git",
      HYDRA_WATCHDOG_ORIGIN_MASTER_PRESENT: "1",
      HYDRA_WATCHDOG_EXPECTED_ORIGIN_HOST: "evil.example",
    });
    assert.doesNotMatch(ok.out, /ALARM/);
  });

  it("does not create the dedup marker when the XADD fails, so the next tick retries", () => {
    const env = {
      HYDRA_WATCHDOG_ORIGIN_URL: "https://github.com/gaberoo322/claw-street-bets.git",
      HYDRA_WATCHDOG_ORIGIN_MASTER_PRESENT: "1",
    };
    const first = tick({ ...env, FAKE_XADD_FAIL: "1" });
    assert.match(first.out, /WARN in-band delivery FAILED/);
    assert.ok(!existsSync(join(stateDir, "hydra-origin-identity.since")));
    const second = tick(env);
    assert.match(second.out, /in-band delivery published/);
    assert.equal(xadds().length, 2, "retried after the failed first attempt");
    assert.ok(existsSync(join(stateDir, "hydra-origin-identity.since")));
  });

  it("alarms on a correct URL when refs/remotes/origin/master does not resolve", () => {
    const r = tick({
      HYDRA_WATCHDOG_ORIGIN_URL: "https://github.com/gaberoo322/hydra.git",
      HYDRA_WATCHDOG_ORIGIN_MASTER_PRESENT: "0",
    });
    assert.match(r.out, /ALARM .*origin-master-missing.*MISSING/);
    assert.equal(xadds().length, 1);
  });

  it("clears the marker on recovery and re-arms dedup", () => {
    const bad = { HYDRA_WATCHDOG_ORIGIN_URL: "https://x/y/z.git", HYDRA_WATCHDOG_ORIGIN_MASTER_PRESENT: "1" };
    const good = {
      HYDRA_WATCHDOG_ORIGIN_URL: "https://github.com/gaberoo322/hydra.git",
      HYDRA_WATCHDOG_ORIGIN_MASTER_PRESENT: "1",
    };
    tick(bad);
    const healed = tick(good);
    assert.match(healed.out, /origin identity healthy again/);
    tick(bad);
    assert.equal(xadds().length, 2, "a recurrence is a new episode");
  });

  it("logs an INFO line when .git/config mtime moves between ticks", () => {
    const env = {
      HYDRA_WATCHDOG_ORIGIN_URL: "https://github.com/gaberoo322/hydra.git",
      HYDRA_WATCHDOG_ORIGIN_MASTER_PRESENT: "1",
    };
    const first = tick(env);
    assert.doesNotMatch(first.out, /\.git\/config changed at/);
    const later = new Date(Date.now() + 60_000);
    // utimes via node (no git involved)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    spawnSync("touch", ["-d", later.toISOString(), join(fakeRoot, ".git", "config")]);
    const second = tick(env);
    assert.match(second.out, /INFO \.git\/config changed at \d{4}-\d{2}-\d{2}T/);
  });

  it("reads real git state read-only: wrong URL in a real gitdir alarms, config stays untouched", () => {
    const sh = (args: string[]) =>
      spawnSync("git", ["-C", fakeRoot, ...args], { encoding: "utf-8" });
    rmSync(join(fakeRoot, ".git"), { recursive: true, force: true });
    assert.equal(sh(["init", "-q"]).status, 0);
    assert.equal(
      sh(["config", "remote.origin.url", "https://github.com/gaberoo322/claw-street-bets.git"]).status,
      0,
    );
    const before = readFileSync(join(fakeRoot, ".git", "config"), "utf-8");
    const r = tick({});
    assert.equal(r.rc, 0);
    assert.match(r.out, /ALARM .*wrong-origin-url.*origin-master-missing/);
    assert.equal(readFileSync(join(fakeRoot, ".git", "config"), "utf-8"), before);
  });

  it("fails safe (returns 0) when HYDRA_ROOT has no .git", () => {
    rmSync(join(fakeRoot, ".git"), { recursive: true, force: true });
    const r = tick({});
    assert.equal(r.rc, 0);
    assert.match(r.out, /WARN .*not found/);
    assert.equal(xadds().length, 0);
  });

  it("is wired into the main entry point and never shells out a mutating git verb", () => {
    const src = readFileSync(WATCHDOG, "utf-8");
    assert.match(src, /\n  run_origin_identity\n  exit 0/);
    const start = src.indexOf("run_origin_identity() {");
    const block = src.slice(start, src.indexOf("# Entry point", start));
    const code = block
      .split("\n")
      .filter((l) => !/^\s*#/.test(l) && !/\blog\s+"/.test(l))
      .join("\n");
    assert.doesNotMatch(code, /\bgit\s+(-C\s+\S+\s+)?(remote|fetch|prune|pull|push)\b/);
    assert.doesNotMatch(code, /\bgit\s+(-C\s+\S+\s+)?config\b(?![^\n]*--get)/);
  });
});
