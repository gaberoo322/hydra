/**
 * Regression test for issue #5064 — Claude Code PreToolUse hooks are installed
 * on every deploy and alarmed on when missing.
 *
 * Pins:
 *   - scripts/setup-claude-hooks.sh `--list` prints the HOOKS array (the single
 *     source of truth the watchdog reads), and re-running the installer is
 *     idempotent: one PreToolUse block per managed hook, unrelated settings
 *     keys (and non-managed PreToolUse blocks) preserved;
 *     A SYMLINKED settings.json stays a symlink (its target gets the update), and
 *     an unknown argument exits 2 instead of installing;
 *   - scripts/deploy.sh invokes the installer, non-fatally, before the service
 *     restart;
 *   - the watchdog's claude-hooks check (src/watchdog/claude-hooks.ts, issue
 *     #5099) alarms on a missing hook file and on a missing or inexact settings
 *     registration, is silent when both are present, and publishes ONE bus event
 *     per episode — a publish that returns no stream id is a failed delivery,
 *     never a dedup marker.
 *
 * The check runs IN-PROCESS over its typed ports: the installer (`--list`), the
 * hooks dir and settings.json are REAL throwaway temp files; only the bus is a
 * recording fake. No PATH shim, no sourced bash. The real ~/.claude is never
 * read or written.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WATCHDOG_SPAWN_TIMEOUT_MS } from "./_helpers/watchdog-timeouts.mts";
import { decideClaudeHooks, parseHookListing, runClaudeHooks } from "../src/watchdog/claude-hooks.ts";
import { createProductionClaudeHooksDeps } from "../src/watchdog/ports.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SETUP = join(REPO_ROOT, "scripts", "setup-claude-hooks.sh");
const DEPLOY = join(REPO_ROOT, "scripts", "deploy.sh");

let tmp: string;
let stateDir: string;
let hooksDir: string;
let settings: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "claude-hooks-"));
  stateDir = join(tmp, "state");
  hooksDir = join(tmp, "hooks", "hydra");
  settings = join(tmp, "settings.json");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function baseEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
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

  it("keeps a SYMLINKED settings.json a symlink and writes the update to its target", () => {
    // Dotfile managers (stow, chezmoi symlink mode) link ~/.claude/settings.json
    // into a repo. The atomic rename must land on the TARGET; renaming over the
    // link path would silently swap the link for a regular file on every deploy.
    const dotfiles = join(tmp, "dotfiles");
    mkdirSync(dotfiles);
    const target = join(dotfiles, "settings.json");
    writeFileSync(target, JSON.stringify({ model: "opus", env: { A: "é" } }, null, 2) + "\n");
    // Neither mkstemp's 0600 nor the usual 0644, so only copymode from the
    // REAL file can produce it.
    chmodSync(target, 0o640);
    // A RELATIVE link: it must resolve against the link's own dir, not the cwd.
    const linkText = join("dotfiles", "settings.json");
    symlinkSync(linkText, settings);

    const r = runSetup();
    assert.equal(r.status, 0, r.out);
    assert.ok(lstatSync(settings).isSymbolicLink(), "settings.json must still be a symlink after install");
    assert.equal(readlinkSync(settings), linkText, "the link must still point at the same target");
    const data = JSON.parse(readFileSync(target, "utf-8"));
    assert.equal(data.model, "opus", "unrelated keys in the target survive");
    assert.deepEqual(data.env, { A: "é" }, "non-ASCII survives the utf-8 round trip");
    for (const name of expectedHooks()) {
      assert.ok(
        (data.hooks.PreToolUse as Block[]).some((b) => b.hooks?.some((h) => h.command === `bash ${hooksDir}/${name}`)),
        `the symlink TARGET must carry the ${name} registration`,
      );
    }
    assert.equal(statSync(target).mode & 0o777, 0o640, "the target's mode is preserved");
    for (const dir of [tmp, dotfiles]) {
      assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith(".settings.")), [], `no temp file left in ${dir}`);
    }

    // --remove writes through the same path and must keep the link too.
    const removed = runSetup(["--remove"]);
    assert.equal(removed.status, 0, removed.out);
    assert.ok(lstatSync(settings).isSymbolicLink(), "settings.json must still be a symlink after --remove");
    assert.equal(JSON.parse(readFileSync(target, "utf-8")).hooks?.PreToolUse, undefined);
  });

  it("rejects an unknown argument with usage and exit 2, touching nothing", () => {
    const r = runSetup(["--bogus"]);
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /unknown argument '--bogus'/);
    assert.match(r.out, /usage:/);
    assert.equal(existsSync(hooksDir), false, "an unknown flag must not install hooks");
    assert.equal(existsSync(settings), false, "an unknown flag must not create settings.json");
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

  it("EXECUTES the install block: a failing installer prints ::error:: and the deploy still reaches the restart", () => {
    const src = readFileSync(DEPLOY, "utf-8");
    const start = src.indexOf("HOOKS_RC=0\n");
    const end = src.indexOf('echo "==> Restarting service..."');
    assert.ok(start > 0 && end > start, "install block must precede the Restarting service echo");
    // Block + a sentinel standing in for the restart; `set -e` mirrors deploy.sh.
    const block = src.slice(start, end) + "echo RESTART_REACHED\n";
    const dir = mkdtempSync(join(tmpdir(), "deploy-hooks-"));
    try {
      mkdirSync(join(dir, "scripts"));
      writeFileSync(join(dir, "scripts", "setup-claude-hooks.sh"), "#!/bin/bash\nexit 7\n");
      const r = spawnSync("bash", ["-e", "-c", block], { cwd: dir, encoding: "utf-8", timeout: 30_000 });
      assert.equal(r.status, 0, `deploy block must not abort: ${r.stdout}${r.stderr}`);
      assert.match(r.stdout, /::error::Claude Code hook install failed \(exit 7\)/);
      assert.match(r.stdout, /RESTART_REACHED/);
      // Success path: no ::error::.
      writeFileSync(join(dir, "scripts", "setup-claude-hooks.sh"), "#!/bin/bash\nexit 0\n");
      const ok = spawnSync("bash", ["-e", "-c", block], { cwd: dir, encoding: "utf-8", timeout: 30_000 });
      assert.equal(ok.status, 0);
      assert.doesNotMatch(ok.stdout, /::error::/);
      assert.match(ok.stdout, /RESTART_REACHED/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("claude-hooks watchdog check (#5064, ported #5099)", () => {
  /** A recording bus: `reply` is the stream id (or null for a delivery that landed nowhere). */
  function harness(reply: string | null | Error = "1-0") {
    const published: { stream: string; type: string; payload: unknown }[] = [];
    const logs: string[] = [];
    const base = createProductionClaudeHooksDeps((l) => logs.push(l));
    const deps = {
      ...base,
      bus: {
        publish: async (stream: string, event: { type: string; payload?: unknown }) => {
          published.push({ stream, type: event.type, payload: event.payload });
          if (reply instanceof Error) throw reply;
          return reply;
        },
      },
    };
    return { deps, published, logs, text: () => logs.join("\n") };
  }

  const cfg = (over: Record<string, string> = {}) => ({
    setupPath: SETUP,
    hooksDir,
    settingsPath: settings,
    stateDir,
    notifyStream: "test:notifications",
    ...over,
  });
  const marker = (): string => join(stateDir, "hydra-claude-hooks-missing.since");

  it("is silent when every hook is installed and registered", async () => {
    assert.equal(runSetup().status, 0);
    const h = harness();
    await runClaudeHooks(h.deps, cfg());
    assert.doesNotMatch(h.text(), /ALARM/);
    assert.match(h.text(), /claude-hooks tick processed/);
    assert.equal(h.published.length, 0);
  });

  it("alarms on a missing hook file and publishes ONE event per episode", async () => {
    assert.equal(runSetup().status, 0);
    unlinkSync(join(hooksDir, "git-remote-fence.sh"));
    const h = harness();
    await runClaudeHooks(h.deps, cfg());
    assert.match(h.text(), /ALARM .*file-missing:git-remote-fence\.sh/);
    assert.doesNotMatch(h.text(), /unregistered:/);
    assert.equal(h.published.length, 1);
    assert.equal(h.published[0].stream, "test:notifications");
    assert.equal(h.published[0].type, "infra:claude_hooks_missing");
    assert.deepEqual(h.published[0].payload, { signal: "claude-hooks", reason: "file-missing:git-remote-fence.sh" });

    await runClaudeHooks(h.deps, cfg());
    assert.match(h.text(), /ALARM/);
    assert.equal(h.published.length, 1, "same episode must not re-publish");
  });

  it("alarms on a missing settings registration (the live 2026-10-20 state)", async () => {
    assert.equal(runSetup().status, 0);
    const data = JSON.parse(readFileSync(settings, "utf-8"));
    data.hooks.PreToolUse = (data.hooks.PreToolUse as Block[]).filter(
      (b) => !b.hooks?.some((hk) => hk.command?.includes("git-remote-fence.sh")),
    );
    writeFileSync(settings, JSON.stringify(data, null, 2));
    const h = harness();
    await runClaudeHooks(h.deps, cfg());
    assert.match(h.text(), /ALARM .*unregistered:git-remote-fence\.sh/);
    assert.doesNotMatch(h.text(), /unregistered:worktree-write-fence/);
    assert.doesNotMatch(h.text(), /file-missing:/);
    assert.equal(h.published.length, 1);
  });

  it("alarms when settings.json is absent or unparseable", async () => {
    assert.equal(runSetup().status, 0);
    writeFileSync(settings, "{ not json");
    const h = harness();
    await runClaudeHooks(h.deps, cfg());
    assert.match(h.text(), /ALARM .*settings-unreadable/);
    rmSync(settings);
    rmSync(marker(), { force: true });
    const h2 = harness();
    await runClaudeHooks(h2.deps, cfg());
    assert.match(h2.text(), /ALARM .*settings-unreadable/);
  });

  it("retries the publish next tick when delivery fails, and re-arms after recovery", async () => {
    const failed = harness(new Error("redis down"));
    await runClaudeHooks(failed.deps, cfg());
    assert.match(failed.text(), /ALARM/);
    assert.match(failed.text(), /in-band delivery FAILED/);
    assert.equal(existsSync(marker()), false);

    const ok = harness();
    await runClaudeHooks(ok.deps, cfg());
    assert.equal(existsSync(marker()), true);

    assert.equal(runSetup().status, 0);
    const healed = harness();
    await runClaudeHooks(healed.deps, cfg());
    assert.match(healed.text(), /healthy again/);
    assert.equal(existsSync(marker()), false);
  });

  it("treats a publish with no stream id as a FAILED delivery: no since-marker, retried every tick", async () => {
    // Nothing installed, so every tick is in the alarm episode.
    for (const reply of [null, "OK", "ERR wrong number of arguments"]) {
      const h = harness(reply);
      await runClaudeHooks(h.deps, cfg());
      assert.match(h.text(), /ALARM/);
      assert.match(h.text(), /in-band delivery FAILED \(publish reply '.*' is not a stream id\)/, h.text());
      assert.doesNotMatch(h.text(), /in-band delivery published/);
      assert.equal(existsSync(marker()), false, `reply "${reply}" must not write the since-marker`);
    }
    const delivered = harness();
    await runClaudeHooks(delivered.deps, cfg());
    assert.match(delivered.text(), /in-band delivery published .*\(id 1-0\)/);
    assert.equal(existsSync(marker()), true, "a stream-id reply writes the since-marker");
  });

  it("requires an EXACT registration: a wrong matcher or a decorated command counts as unregistered", async () => {
    assert.equal(runSetup().status, 0);
    const data = JSON.parse(readFileSync(settings, "utf-8"));
    for (const b of data.hooks.PreToolUse as Block[]) {
      const hk = b.hooks?.[0];
      if (!hk?.command) continue;
      // Right command, wrong tools: the fence would never fire on Bash.
      if (hk.command.endsWith("/git-remote-fence.sh")) b.matcher = "Edit";
      // Still CONTAINS "<dir>/worktree-write-fence.sh", so a substring check passes it.
      if (hk.command.endsWith("/worktree-write-fence.sh")) hk.command = `${hk.command}.disabled`;
    }
    writeFileSync(settings, JSON.stringify(data, null, 2));
    const h = harness();
    await runClaudeHooks(h.deps, cfg());
    assert.match(h.text(), /ALARM .*unregistered:worktree-write-fence\.sh/);
    assert.match(h.text(), /ALARM .*unregistered:git-remote-fence\.sh/);
    assert.doesNotMatch(h.text(), /file-missing:/);
  });

  it("skips with a WARN (fail-safe) when the installer script is missing or its --list fails", async () => {
    const h = harness();
    await runClaudeHooks(h.deps, cfg({ setupPath: join(tmp, "nope.sh") }));
    assert.match(h.text(), /WARN installer .* not found/);
    assert.doesNotMatch(h.text(), /ALARM/);

    const failing = join(tmp, "failing.sh");
    writeFileSync(failing, "#!/bin/bash\nexit 3\n");
    const h2 = harness();
    await runClaudeHooks(h2.deps, cfg({ setupPath: failing }));
    assert.match(h2.text(), /--list failed \(rc=3\) — skipping/);
    assert.equal(h2.published.length, 0);

    const empty = join(tmp, "empty.sh");
    writeFileSync(empty, "#!/bin/bash\nexit 0\n");
    const h3 = harness();
    await runClaudeHooks(h3.deps, cfg({ setupPath: empty }));
    assert.match(h3.text(), /returned no hooks — skipping/);
  });

  it("decideClaudeHooks is pure: reasons vocabulary over parsed entries", () => {
    const expected = parseHookListing("a.sh|Bash\n\nb.sh|Edit|Write\n");
    assert.deepEqual(expected, [
      { name: "a.sh", matcher: "Bash" },
      { name: "b.sh", matcher: "Edit|Write" },
    ]);
    const settingsText = JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "bash /h/a.sh" }] }] },
    });
    assert.deepEqual(decideClaudeHooks({ expected, installed: new Set(["a.sh", "b.sh"]), settingsText, hooksDir: "/h/" }), [
      "unregistered:b.sh",
    ]);
    assert.deepEqual(decideClaudeHooks({ expected, installed: new Set(["a.sh"]), settingsText: null, hooksDir: "/h" }), [
      "file-missing:b.sh",
      "settings-unreadable",
    ]);
    assert.deepEqual(decideClaudeHooks({ expected, installed: new Set(["a.sh", "b.sh"]), settingsText: "[]", hooksDir: "/h" }), [
      "settings-unreadable",
    ]);
  });
});
