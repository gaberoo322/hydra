/**
 * Regression test for issue #4939 — the ## ORIGIN IDENTITY block
 * (`run_origin_identity`) in scripts/hydra-watchdog.sh — and its #5065
 * auto-repair extension.
 *
 * Invariants pinned (design-concept INV-5..INV-8, plus #5065):
 *   - alarms when remote.origin.url (normalised, ssh/https/.git tolerant) is
 *     not the orchestrator repo, OR refs/remotes/origin/master is missing;
 *   - exactly one enveloped XADD per episode-outcome (since-marker dedup),
 *     cleared and re-armed on recovery;
 *   - #5065: self-heals (rewrite the origin URL to the canonical one, then
 *     fetch) from the watchdog's own shell, only ever inside $HYDRA_ROOT,
 *     behind the HYDRA_WATCHDOG_ORIGIN_AUTOREPAIR kill switch; a failed
 *     repair still alarms and says so;
 *   - records the .git/config mtime and logs an INFO line when it moved;
 *   - fail-safe: always returns 0.
 *
 * The block is SOURCED and called alone (the #4500 seam); a fake `redis-cli`
 * on PATH records the XADD argv so no Redis or docker is needed. The legacy
 * alarm cases run with the kill switch on (their fake .git is not a repo);
 * the #5065 repair cases use a throwaway real repo as HYDRA_ROOT and a local
 * bare repo as the canonical URL, so the fetch works offline.
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

// Keep the host's git config (insteadOf rewrites, credential helpers, hooks)
// out of every throwaway repo, both in the setup calls and in the watchdog.
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

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
  writeFileSync(fake, `#!/usr/bin/env bash\necho "$@" >> "${xaddLog}"\n[ -n "$FAKE_XADD_FAIL" ] || echo "${FAKE_XADD_REPLY:-1-0}"\n`);
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
        // #5046: no-op Operator Channel CLI stub so a tick never boots the
        // production CLI (delivery is asserted in test/launch-flow-delivery).
        HYDRA_WATCHDOG_OPERATOR_NOTIFY: "/bin/true",
        HYDRA_REDIS_HOST: "127.0.0.1",
        HYDRA_WATCHDOG_ORIGIN_STATE_DIR: stateDir,
        HYDRA_WATCHDOG_ORIGIN_NOTIFY_STREAM: "test:notifications",
        ...GIT_ENV,
        // Legacy alarm cases: repair is off unless a case opts in (#5065).
        HYDRA_WATCHDOG_ORIGIN_AUTOREPAIR: "0",
        ...env,
      },
    },
  );
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const m = /\nrc=(\d+)\n?$/.exec(`\n${r.stdout ?? ""}`);
  return { out, rc: m ? Number(m[1]) : -1 };
}

const xadds = (): string[] =>
  existsSync(xaddLog) ? readFileSync(xaddLog, "utf-8").trim().split("\n").filter(Boolean) : [];

function git(cwd: string, args: string[]): { status: number | null; stdout: string } {
  const r = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    env: { ...process.env, ...GIT_ENV },
  });
  return { status: r.status, stdout: (r.stdout ?? "").trim() };
}

/** A local bare repo with one commit on master — the offline "canonical" origin. */
function makeCanonicalBare(): string {
  const bare = join(tmp, "canonical", "hydra.git");
  const seed = join(tmp, "seed");
  mkdirSync(seed, { recursive: true });
  assert.equal(git(tmp, ["init", "-q", "--bare", "-b", "master", bare]).status, 0);
  assert.equal(git(seed, ["init", "-q", "-b", "master"]).status, 0);
  writeFileSync(join(seed, "README"), "seed\n");
  assert.equal(git(seed, ["add", "README"]).status, 0);
  assert.equal(
    git(seed, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "seed"]).status,
    0,
  );
  assert.equal(git(seed, ["push", "-q", bare, "master"]).status, 0);
  return bare;
}

/** Replace the fake .git with a real repo as HYDRA_ROOT. */
function makeRealRoot(): void {
  rmSync(join(fakeRoot, ".git"), { recursive: true, force: true });
  assert.equal(git(fakeRoot, ["init", "-q", "-b", "master"]).status, 0);
}

const originUrl = (): string => git(fakeRoot, ["config", "--get", "remote.origin.url"]).stdout;
const originMasterResolves = (): boolean =>
  git(fakeRoot, ["rev-parse", "--verify", "-q", "refs/remotes/origin/master"]).status === 0;

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

  it("redacts userinfo up to the LAST @ even when the token contains `/` (QA round 4)", () => {
    const r = tick({
      HYDRA_WATCHDOG_ORIGIN_URL: "https://user:ghp_a/b+c@github.com/gaberoo322/claw-street-bets.git",
      HYDRA_WATCHDOG_ORIGIN_MASTER_PRESENT: "1",
    });
    assert.match(r.out, /ALARM .*wrong-origin-url.*remote\.origin\.url=https:\/\/github\.com\/gaberoo322\/claw-street-bets/);
    // Host is computed after the same last-@ strip, so no spurious host alarm.
    assert.doesNotMatch(r.out, /wrong-origin-host/);
    assert.doesNotMatch(r.out, /ghp_a|b\+c|user:/);
    const entries = xadds();
    assert.equal(entries.length, 1);
    assert.doesNotMatch(entries[0], /ghp_a|b\+c|user:/);
    // The expected repo with a slash-bearing token is still healthy (norm strips it too).
    const ok = tick({
      HYDRA_WATCHDOG_ORIGIN_URL: "https://x:t/o/k@github.com/gaberoo322/hydra.git",
      HYDRA_WATCHDOG_ORIGIN_MASTER_PRESENT: "1",
    });
    assert.doesNotMatch(ok.out, /ALARM/);
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

  for (const reply of ["ERR unknown command", "WRONGTYPE Operation against a key", "NOAUTH Authentication required.", "OK"]) {
    it(`an exit-0 non-stream-id XADD reply (${reply.split(" ")[0]}) does not write the since-marker and retries`, () => {
      const env = {
        HYDRA_WATCHDOG_ORIGIN_URL: "https://github.com/gaberoo322/claw-street-bets.git",
        HYDRA_WATCHDOG_ORIGIN_MASTER_PRESENT: "1",
      };
      const first = tick({ ...env, FAKE_XADD_REPLY: reply });
      assert.match(first.out, /WARN in-band delivery FAILED/);
      assert.ok(!existsSync(join(stateDir, "hydra-origin-identity.since")));
      const second = tick(env);
      assert.match(second.out, /in-band delivery published/);
      assert.equal(xadds().length, 2, "retried after the error reply");
      assert.ok(existsSync(join(stateDir, "hydra-origin-identity.since")));
    });
  }

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
    spawnSync("touch", ["-d", later.toISOString(), join(fakeRoot, ".git", "config")]);
    const second = tick(env);
    assert.match(second.out, /INFO \.git\/config changed at \d{4}-\d{2}-\d{2}T/);
  });

  it("fails safe (returns 0) when HYDRA_ROOT has no .git", () => {
    rmSync(join(fakeRoot, ".git"), { recursive: true, force: true });
    const r = tick({ HYDRA_WATCHDOG_ORIGIN_AUTOREPAIR: "1" });
    assert.equal(r.rc, 0);
    assert.match(r.out, /WARN .*not found/);
    assert.equal(xadds().length, 0);
  });
});

describe("run_origin_identity auto-repair (#5065)", () => {
  it("rewrites a wrong origin URL to the canonical one, fetches, and notifies 'repaired'", () => {
    const bare = makeCanonicalBare();
    makeRealRoot();
    assert.equal(
      git(fakeRoot, ["config", "remote.origin.url", "https://user:ghp_SECRETTOKEN@github.com/gaberoo322/claw-street-bets.git"]).status,
      0,
    );
    const env = { HYDRA_WATCHDOG_ORIGIN_AUTOREPAIR: "1", HYDRA_WATCHDOG_CANONICAL_ORIGIN_URL: bare };

    const r = tick(env);
    assert.equal(r.rc, 0);
    assert.match(r.out, /REPAIRED ~\/hydra origin identity: wrong-origin-url\+origin-master-missing/);
    assert.match(r.out, /claw-street-bets\.git -> .*canonical\/hydra\.git; fetch ok/);
    assert.doesNotMatch(r.out, /ALARM/);
    assert.doesNotMatch(r.out, /SECRETTOKEN|user:/);
    assert.equal(originUrl(), bare);
    assert.ok(originMasterResolves(), "fetch recreated refs/remotes/origin/master");

    const entries = xadds();
    assert.equal(entries.length, 1);
    assert.match(entries[0], /type infra:origin_identity_wrong/);
    assert.match(entries[0], /"repair":"repaired"/);
    assert.match(entries[0], /"fetch":"ok"/);
    assert.match(entries[0], /"url":"https:\/\/github\.com\/gaberoo322\/claw-street-bets\.git"/);
    assert.match(entries[0], /"newUrl":"[^"]*canonical\/hydra\.git"/);
    assert.doesNotMatch(entries[0], /SECRETTOKEN|user:/);

    const next = tick(env);
    assert.match(next.out, /origin identity healthy again/);
    assert.equal(xadds().length, 1, "a healed tree publishes nothing more");
  });

  it("fetches a missing origin/master when the URL is already correct (no URL rewrite)", () => {
    const bare = makeCanonicalBare();
    makeRealRoot();
    assert.equal(git(fakeRoot, ["remote", "add", "origin", bare]).status, 0);
    assert.ok(!originMasterResolves());

    const r = tick({ HYDRA_WATCHDOG_ORIGIN_AUTOREPAIR: "1", HYDRA_WATCHDOG_CANONICAL_ORIGIN_URL: bare });
    assert.equal(r.rc, 0);
    assert.match(r.out, /REPAIRED ~\/hydra origin identity: origin-master-missing — .*; fetch ok/);
    assert.ok(originMasterResolves());
    assert.equal(originUrl(), bare);
    const entries = xadds();
    assert.equal(entries.length, 1);
    assert.match(entries[0], /"reason":"origin-master-missing"/);
    assert.match(entries[0], /"repair":"repaired"/);
  });

  it("kill switch HYDRA_WATCHDOG_ORIGIN_AUTOREPAIR=0 leaves the repo untouched and alarms as before", () => {
    const bare = makeCanonicalBare();
    makeRealRoot();
    assert.equal(
      git(fakeRoot, ["config", "remote.origin.url", "https://github.com/gaberoo322/claw-street-bets.git"]).status,
      0,
    );
    const before = readFileSync(join(fakeRoot, ".git", "config"), "utf-8");

    const r = tick({ HYDRA_WATCHDOG_ORIGIN_AUTOREPAIR: "0", HYDRA_WATCHDOG_CANONICAL_ORIGIN_URL: bare });
    assert.equal(r.rc, 0);
    assert.match(r.out, /ALARM .*wrong-origin-url.*origin-master-missing.*auto-repair disabled/);
    assert.doesNotMatch(r.out, /REPAIRED/);
    assert.equal(readFileSync(join(fakeRoot, ".git", "config"), "utf-8"), before);
    assert.ok(!originMasterResolves());
    const entries = xadds();
    assert.equal(entries.length, 1);
    assert.match(entries[0], /"repair":"not-attempted"/);
  });

  it("never acts when the canonical URL is set but empty", () => {
    makeRealRoot();
    assert.equal(
      git(fakeRoot, ["config", "remote.origin.url", "https://github.com/gaberoo322/claw-street-bets.git"]).status,
      0,
    );
    const before = readFileSync(join(fakeRoot, ".git", "config"), "utf-8");
    const r = tick({ HYDRA_WATCHDOG_ORIGIN_AUTOREPAIR: "1", HYDRA_WATCHDOG_CANONICAL_ORIGIN_URL: "" });
    assert.equal(r.rc, 0);
    assert.match(r.out, /ALARM .*auto-repair skipped/);
    assert.equal(readFileSync(join(fakeRoot, ".git", "config"), "utf-8"), before);
  });

  it("a failed repair (unreachable canonical URL) still alarms, reports the failure, and dedups", () => {
    makeRealRoot();
    assert.equal(
      git(fakeRoot, ["config", "remote.origin.url", "https://github.com/gaberoo322/claw-street-bets.git"]).status,
      0,
    );
    const missing = join(tmp, "does-not-exist", "hydra.git");
    const env = { HYDRA_WATCHDOG_ORIGIN_AUTOREPAIR: "1", HYDRA_WATCHDOG_CANONICAL_ORIGIN_URL: missing };

    const r = tick(env);
    assert.equal(r.rc, 0);
    assert.match(r.out, /ALARM .*wrong-origin-url.*auto-repair FAILED: origin fetch failed/);
    assert.doesNotMatch(r.out, /REPAIRED/);
    assert.ok(!originMasterResolves());
    const entries = xadds();
    assert.equal(entries.length, 1);
    assert.match(entries[0], /"repair":"failed"/);
    assert.match(entries[0], /"fetch":"failed-rc-\d+"/);

    const again = tick(env);
    assert.match(again.out, /ALARM .*auto-repair FAILED/);
    assert.equal(xadds().length, 1, "a persistent repair failure must not re-publish");
  });

  it("a set-but-empty canonical URL with an unset origin URL still raises wrong-origin-url", () => {
    const r = tick({
      HYDRA_WATCHDOG_ORIGIN_URL: "",
      HYDRA_WATCHDOG_ORIGIN_MASTER_PRESENT: "1",
      HYDRA_WATCHDOG_CANONICAL_ORIGIN_URL: "",
    });
    assert.match(r.out, /ALARM .*wrong-origin-url/);
    assert.match(xadds()[0] ?? "", /"reason":"wrong-origin-url/);
  });

  it("an alarm that later self-heals republishes once as 'repaired'", () => {
    const bare = makeCanonicalBare();
    makeRealRoot();
    assert.equal(
      git(fakeRoot, ["config", "remote.origin.url", "https://github.com/gaberoo322/claw-street-bets.git"]).status,
      0,
    );
    const alarm = tick({ HYDRA_WATCHDOG_ORIGIN_AUTOREPAIR: "0", HYDRA_WATCHDOG_CANONICAL_ORIGIN_URL: bare });
    assert.match(alarm.out, /ALARM/);
    assert.equal(xadds().length, 1);
    assert.match(xadds()[0], /"repair":"not-attempted"/);

    const healed = tick({ HYDRA_WATCHDOG_ORIGIN_AUTOREPAIR: "1", HYDRA_WATCHDOG_CANONICAL_ORIGIN_URL: bare });
    assert.match(healed.out, /REPAIRED/);
    assert.equal(xadds().length, 2, "alarm -> repaired is a new event");
    assert.match(xadds()[1], /"repair":"repaired"/);
  });

  it("skips repair when the expected repo is empty (EXPECTED-empty)", () => {
    makeRealRoot();
    assert.equal(
      git(fakeRoot, ["config", "remote.origin.url", "https://github.com/gaberoo322/claw-street-bets.git"]).status,
      0,
    );
    const before = readFileSync(join(fakeRoot, ".git", "config"), "utf-8");
    const r = tick({ HYDRA_WATCHDOG_ORIGIN_AUTOREPAIR: "1", HYDRA_WATCHDOG_EXPECTED_ORIGIN_REPO: "" });
    assert.equal(r.rc, 0);
    assert.match(r.out, /ALARM .*auto-repair skipped/);
    assert.equal(readFileSync(join(fakeRoot, ".git", "config"), "utf-8"), before);
  });

  it("skips repair when there is no gitdir (observed URL injected)", () => {
    rmSync(join(fakeRoot, ".git"), { recursive: true, force: true });
    const r = tick({
      HYDRA_WATCHDOG_ORIGIN_AUTOREPAIR: "1",
      HYDRA_WATCHDOG_ORIGIN_URL: "https://github.com/gaberoo322/claw-street-bets.git",
      HYDRA_WATCHDOG_ORIGIN_MASTER_PRESENT: "1",
    });
    assert.equal(r.rc, 0);
    assert.match(r.out, /ALARM .*auto-repair skipped \(no gitdir/);
  });

  it("reports a timed-out fetch (rc 124) and redacts credentials from fetch stderr", () => {
    makeRealRoot();
    assert.equal(
      git(fakeRoot, ["config", "remote.origin.url", "https://github.com/gaberoo322/claw-street-bets.git"]).status,
      0,
    );
    const fakeGit = join(binDir, "git");
    const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf-8" }).stdout.trim();
    writeFileSync(
      fakeGit,
      `#!/usr/bin/env bash\ncase "$*" in *" fetch "*) echo "fatal: unable to access 'https://user:to/ken@example.invalid/x.git/': boom" >&2; exit 1;; esac\nexec "${realGit}" "$@"\n`,
    );
    chmodSync(fakeGit, 0o755);
    const fakeTimeout = join(binDir, "timeout");
    writeFileSync(fakeTimeout, `#!/usr/bin/env bash\nif [ "$1" = "-k" ]; then shift 3; else shift 1; [ -n "$FAKE_TIMEOUT_124" ] && exec "$@"; fi\n"$@"\nrc=$?\n[ -n "$FAKE_TIMEOUT_124" ] && exit 124\nexit $rc\n`);
    chmodSync(fakeTimeout, 0o755);
    const bare = makeCanonicalBare();
    const r = tick({
      HYDRA_WATCHDOG_ORIGIN_AUTOREPAIR: "1",
      HYDRA_WATCHDOG_CANONICAL_ORIGIN_URL: bare,
      HYDRA_WATCHDOG_ORIGIN_FETCH_TIMEOUT_S: "7",
      FAKE_TIMEOUT_124: "1",
    });
    assert.equal(r.rc, 0);
    assert.match(r.out, /origin fetch timed out after 7s/);
    assert.match(r.out, /WARN fetch stderr: .*https:\/\/example\.invalid/);
    assert.doesNotMatch(r.out, /user:|to\/ken/);
    assert.match(xadds()[0], /"fetch":"failed-rc-124"/);
  });

  it("backs off after a failed repair instead of refetching every tick", () => {
    makeRealRoot();
    assert.equal(
      git(fakeRoot, ["config", "remote.origin.url", "https://github.com/gaberoo322/claw-street-bets.git"]).status,
      0,
    );
    const missing = join(tmp, "does-not-exist", "hydra.git");
    const env = { HYDRA_WATCHDOG_ORIGIN_AUTOREPAIR: "1", HYDRA_WATCHDOG_CANONICAL_ORIGIN_URL: missing };
    const first = tick(env);
    assert.match(first.out, /auto-repair FAILED: origin fetch failed/);
    const second = tick(env);
    assert.match(second.out, /auto-repair FAILED: backing off/);
    assert.equal(xadds().length, 1);
    const third = tick({ ...env, HYDRA_WATCHDOG_ORIGIN_REPAIR_BACKOFF_S: "0" });
    assert.match(third.out, /auto-repair FAILED: origin fetch failed/);
  });

  it("is wired into the main entry point; every git call targets $HYDRA_ROOT and mutations are fenced", () => {
    const src = readFileSync(WATCHDOG, "utf-8");
    assert.match(src, /\n  run_origin_identity\n  exit 0/);
    const start = src.indexOf("run_origin_identity() {");
    const block = src.slice(start, src.indexOf("# Entry point", start));
    const code = block
      .split("\n")
      .filter((l) => !/^\s*#/.test(l) && !/\blog\s+"/.test(l))
      .join("\n");
    // Only $HYDRA_ROOT is ever touched.
    const gitCalls = code.match(/\bgit\s+[^\n]*/g) ?? [];
    assert.ok(gitCalls.length > 0);
    for (const call of gitCalls) {
      assert.match(call, /^git -C "\$HYDRA_ROOT" /, call);
    }
    // No remote/ref surgery beyond the fetch.
    assert.doesNotMatch(code, /\bgit -C "\$HYDRA_ROOT" (remote|prune|pull|push|reset|update-ref|gc)\b/);
    assert.doesNotMatch(code, /fetch[^\n]*--prune/);
    // Config writes are limited to remote.origin.url / remote.origin.fetch.
    for (const m of code.matchAll(/git -C "\$HYDRA_ROOT" config (?!--get)(\S+)/g)) {
      assert.match(m[1], /^remote\.origin\.(url|fetch)$/, m[0]);
    }
    // Every mutation sits behind the kill switch.
    const guard = code.indexOf('"$AUTOREPAIR" == "0"');
    const firstWrite = code.indexOf('config remote.origin.url "$CANONICAL"');
    const firstFetch = code.indexOf("fetch --quiet origin");
    assert.ok(guard > 0 && firstWrite > guard && firstFetch > guard);
  });
});
