/**
 * Regression test for issue #5064 — Claude Code PreToolUse hooks are installed
 * on every deploy and alarmed on when missing.
 *
 * Pins:
 *   - scripts/setup-claude-hooks.sh `--list` prints the HOOKS array (the single
 *     source of truth the watchdog reads), and re-running the installer is
 *     idempotent: one PreToolUse block per managed hook, unrelated settings
 *     keys (and non-managed PreToolUse blocks) preserved;
 *   - scripts/deploy.sh invokes the installer, non-fatally, before the service
 *     restart;
 *   - the watchdog's ## CLAUDE HOOKS block (`run_claude_hooks`) alarms on a
 *     missing hook file and on a missing settings registration, is silent when
 *     both are present, and publishes ONE enveloped XADD per episode.
 *
 * The watchdog block is SOURCED and called alone (the #4500 seam, as in
 * test/watchdog-origin-identity.test.mts); a fake `redis-cli` on PATH records
 * the XADD argv, so no Redis or docker is needed. Every path is a throwaway
 * temp dir — the real ~/.claude is never read or written.
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
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WATCHDOG_SPAWN_TIMEOUT_MS } from "./_helpers/watchdog-timeouts.mts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const WATCHDOG = join(REPO_ROOT, "scripts", "hydra-watchdog.sh");
const SETUP = join(REPO_ROOT, "scripts", "setup-claude-hooks.sh");
const DEPLOY = join(REPO_ROOT, "scripts", "deploy.sh");

let tmp: string;
let binDir: string;
let stateDir: string;
let hooksDir: string;
let settings: string;
let xaddLog: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "claude-hooks-"));
  binDir = join(tmp, "bin");
  stateDir = join(tmp, "state");
  hooksDir = join(tmp, "hooks", "hydra");
  settings = join(tmp, "settings.json");
  xaddLog = join(tmp, "xadd.log");
  mkdirSync(binDir);
  const fake = join(binDir, "redis-cli");
  writeFileSync(fake, `#!/usr/bin/env bash\necho "$@" >> "${xaddLog}"\n[ -n "$FAKE_XADD_FAIL" ] || echo "1-0"\n`);
  chmodSync(fake, 0o755);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function baseEnv(): Record<string, string> {
  return {
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    // A throwaway HOME so neither script can touch the real ~/.claude.
    HOME: tmp,
  };
}

function runSetup(args: string[] = []): { out: string; status: number } {
  const r = spawnSync("bash", [SETUP, ...args], {
    encoding: "utf-8",
    timeout: WATCHDOG_SPAWN_TIMEOUT_MS,
    env: { ...baseEnv(), CLAUDE_HOOKS_DIR: hooksDir, CLAUDE_SETTINGS: settings },
  });
  return { out: `${r.stdout ?? ""}${r.stderr ?? ""}`, status: r.status ?? -1 };
}

function expectedHooks(): string[] {
  const r = runSetup(["--list"]);
  assert.equal(r.status, 0, r.out);
  return r.out.trim().split("\n").filter(Boolean).map((e) => e.split("|")[0]);
}

function tick(env: Record<string, string> = {}): { out: string; rc: number } {
  const r = spawnSync(
    "bash",
    ["-c", `source "${WATCHDOG}"; run_claude_hooks; echo "rc=$?"`],
    {
      encoding: "utf-8",
      timeout: WATCHDOG_SPAWN_TIMEOUT_MS,
      env: {
        ...baseEnv(),
        HYDRA_ROOT: REPO_ROOT,
        HYDRA_REDIS_HOST: "127.0.0.1",
        HYDRA_WATCHDOG_CLAUDE_HOOKS_DIR: hooksDir,
        HYDRA_WATCHDOG_CLAUDE_SETTINGS: settings,
        HYDRA_WATCHDOG_CLAUDE_HOOKS_STATE_DIR: stateDir,
        HYDRA_WATCHDOG_CLAUDE_HOOKS_NOTIFY_STREAM: "test:notifications",
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

type Block = { matcher?: string; hooks?: { type?: string; command?: string }[] };
const preToolUse = (): Block[] =>
  (JSON.parse(readFileSync(settings, "utf-8")).hooks?.PreToolUse ?? []) as Block[];

describe("setup-claude-hooks.sh (#5064)", () => {
  it("--list prints the HOOKS array, including both fences, without touching disk", () => {
    const names = expectedHooks();
    assert.ok(names.includes("worktree-write-fence.sh"), names.join(","));
    assert.ok(names.includes("git-remote-fence.sh"), names.join(","));
    assert.equal(existsSync(hooksDir), false, "--list must not create the hooks dir");
    assert.equal(existsSync(settings), false, "--list must not create settings.json");
  });

  it("is idempotent and preserves unrelated settings keys and non-managed hooks", () => {
    const foreign = { matcher: "Bash", hooks: [{ type: "command", command: "bash /elsewhere/guard.sh" }] };
    writeFileSync(
      settings,
      JSON.stringify({ model: "opus", env: { A: "é" }, hooks: { PreToolUse: [foreign], Stop: [] } }, null, 2) + "\n",
    );
    assert.equal(runSetup().status, 0);
    const afterFirst = readFileSync(settings, "utf-8");
    const second = runSetup();
    assert.equal(second.status, 0, second.out);
    assert.match(second.out, /unchanged/, "a no-op re-run must skip the settings write");
    assert.equal(readFileSync(settings, "utf-8"), afterFirst, "re-run must be byte-identical");

    const data = JSON.parse(afterFirst);
    assert.equal(data.model, "opus");
    assert.deepEqual(data.env, { A: "é" });
    assert.deepEqual(data.hooks.Stop, []);
    const pre = preToolUse();
    assert.deepEqual(pre[0], foreign, "non-managed PreToolUse block must survive");
    for (const name of expectedHooks()) {
      const matching = pre.filter((b) => b.hooks?.some((h) => h.command === `bash ${hooksDir}/${name}`));
      assert.equal(matching.length, 1, `exactly one block for ${name}`);
      assert.equal(
        readFileSync(join(hooksDir, name), "utf-8"),
        readFileSync(join(REPO_ROOT, "scripts", "claude-hooks", name), "utf-8"),
        `${name} copied from the checkout's scripts/claude-hooks/`,
      );
    }
    assert.equal(pre.length, 1 + expectedHooks().length);
  });
});

describe("deploy.sh installs the Claude hooks (#5064)", () => {
  it("invokes setup-claude-hooks.sh non-fatally, before the service restart", () => {
    const src = readFileSync(DEPLOY, "utf-8");
    const call = src.indexOf("bash scripts/setup-claude-hooks.sh || HOOKS_RC=$?");
    const restart = src.indexOf("systemctl --user restart hydra-orchestrator.service");
    assert.ok(call > 0, "deploy.sh must run the installer in the child-process `|| RC=$?` form");
    assert.ok(restart > call, "the installer must run before the service restart");
    assert.match(src, /::error::Claude Code hook install failed/);
  });
});

describe("run_claude_hooks watchdog block (#5064)", () => {
  it("is silent and returns 0 when every hook is installed and registered", () => {
    assert.equal(runSetup().status, 0);
    const r = tick();
    assert.equal(r.rc, 0, r.out);
    assert.doesNotMatch(r.out, /ALARM/);
    assert.match(r.out, /claude-hooks tick processed/);
    assert.equal(xadds().length, 0);
  });

  it("alarms on a missing hook file and publishes ONE event per episode", () => {
    assert.equal(runSetup().status, 0);
    unlinkSync(join(hooksDir, "git-remote-fence.sh"));
    const first = tick();
    assert.equal(first.rc, 0);
    assert.match(first.out, /ALARM .*file-missing:git-remote-fence\.sh/);
    assert.doesNotMatch(first.out, /unregistered:/);
    const entries = xadds();
    assert.equal(entries.length, 1);
    assert.match(entries[0], /XADD test:notifications \*/);
    assert.match(entries[0], /type infra:claude_hooks_missing/);

    const second = tick();
    assert.match(second.out, /ALARM/);
    assert.equal(xadds().length, 1, "same episode must not re-publish");
  });

  it("alarms on a missing settings registration (the live 2026-10-20 state)", () => {
    assert.equal(runSetup().status, 0);
    const data = JSON.parse(readFileSync(settings, "utf-8"));
    data.hooks.PreToolUse = (data.hooks.PreToolUse as Block[]).filter(
      (b) => !b.hooks?.some((h) => h.command?.includes("git-remote-fence.sh")),
    );
    writeFileSync(settings, JSON.stringify(data, null, 2));
    const r = tick();
    assert.equal(r.rc, 0);
    assert.match(r.out, /ALARM .*unregistered:git-remote-fence\.sh/);
    assert.doesNotMatch(r.out, /unregistered:worktree-write-fence/);
    assert.doesNotMatch(r.out, /file-missing:/);
    assert.equal(xadds().length, 1);
  });

  it("alarms when settings.json is absent or unparseable", () => {
    assert.equal(runSetup().status, 0);
    writeFileSync(settings, "{ not json");
    const r = tick();
    assert.match(r.out, /ALARM .*settings-unreadable/);
    rmSync(settings);
    const r2 = tick();
    assert.match(r2.out, /ALARM .*settings-unreadable/);
  });

  it("retries the XADD next tick when delivery fails, and re-arms after recovery", () => {
    const failed = tick({ FAKE_XADD_FAIL: "1" });
    assert.match(failed.out, /ALARM/);
    assert.match(failed.out, /in-band delivery FAILED/);
    assert.equal(existsSync(join(stateDir, "hydra-claude-hooks-missing.since")), false);

    tick();
    assert.equal(existsSync(join(stateDir, "hydra-claude-hooks-missing.since")), true);

    assert.equal(runSetup().status, 0);
    const healed = tick();
    assert.match(healed.out, /healthy again/);
    assert.equal(existsSync(join(stateDir, "hydra-claude-hooks-missing.since")), false);
  });

  it("skips with a WARN (fail-safe) when the installer script is missing", () => {
    const r = tick({ HYDRA_WATCHDOG_CLAUDE_HOOKS_SETUP: join(tmp, "nope.sh") });
    assert.equal(r.rc, 0);
    assert.match(r.out, /WARN installer .* not found/);
    assert.doesNotMatch(r.out, /ALARM/);
  });
});
