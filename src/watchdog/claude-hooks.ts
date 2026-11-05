/**
 * watchdog/claude-hooks.ts — the CLAUDE HOOKS check (issue #5099, epic #5094,
 * slice 5/5; ADR-0040 Decision 2 shape). Ported from `run_claude_hooks` in
 * scripts/hydra-watchdog.sh (#5064).
 *
 * scripts/setup-claude-hooks.sh owns the HOOKS array of Claude Code PreToolUse
 * hooks (`--list` is the single source of truth — never a second copy here).
 * This check alarms when ANY listed hook is (a) missing as a file under the
 * installed hooks dir, or (b) not registered in settings.json's
 * hooks.PreToolUse (an exact `matcher` AND `bash <dir>/<name>` command match —
 * a substring match would accept a wrong matcher or a decorated command), or
 * the settings file is absent/unparseable.
 *
 * STRICTLY READ-ONLY on the hooks and settings. Delivery is ONE in-band bus
 * event per episode (`infra:claude_hooks_missing`, deliberately NOT a Page).
 * Dedup is a FILE since-marker written only AFTER a successful publish
 * (retry-until-delivered) — deliberately NOT the Redis episode tracker, whose
 * fired marker is set BEFORE delivery. Every tooling failure is a WARN + return.
 */

import { join } from "node:path";
import type { EventBus } from "../event-bus.ts";

export const CLAUDE_HOOKS_LOG_PREFIX = "hydra-claude-hooks-watchdog:";

/** Wrapper bound: one `--list` (20s cap), a handful of file reads and one publish. */
export const CLAUDE_HOOKS_TIMEOUT_S = 60;

export const CLAUDE_HOOKS_EVENT_TYPE = "infra:claude_hooks_missing";
export const CLAUDE_HOOKS_EVENT_SOURCE = "watchdog-claude-hooks";
export const CLAUDE_HOOKS_CORRELATION_ID = "claude-hooks";
export const CLAUDE_HOOKS_MARKER_NAME = "hydra-claude-hooks-missing.since";

export interface ClaudeHooksConfig {
  /** The installer script (`setup-claude-hooks.sh`) whose `--list` is the expected set. */
  setupPath: string;
  hooksDir: string;
  settingsPath: string;
  stateDir: string;
  /** The notification stream (default `hydra:notifications`; rebound in tests). */
  notifyStream: string;
}

/** One `--list` line: `name|matcher`. */
export interface ExpectedHook {
  name: string;
  matcher: string;
}

export interface InstallerListing {
  ok: boolean;
  exitCode: number;
  stdout: string;
}

export interface ClaudeHooksDeps {
  files: {
    exists(path: string): boolean;
    ensureStateDir(dir: string): boolean;
    /** Raw settings.json text, or `null` when absent/unreadable. */
    readSettings(path: string): string | null;
    hasSinceMarker(path: string): boolean;
    writeSinceMarker(path: string, epochS: number): void;
    clearSinceMarker(path: string): void;
  };
  host: {
    /** `bash <setup> --list`; `ok:false` when the script could not run to completion. */
    listInstaller(setupPath: string): Promise<InstallerListing>;
  };
  /** Publishes the envelope; resolves the stream id, or `null` when nothing landed. */
  bus: { publish(stream: string, event: Parameters<EventBus["publish"]>[1]): Promise<string | null> };
  clock: { nowMs(): number };
  log: (line: string) => void;
}

/** Parse the installer listing into entries (blank lines dropped). */
export function parseHookListing(stdout: string): ExpectedHook[] {
  const out: ExpectedHook[] = [];
  for (const line of stdout.split("\n")) {
    if (line === "") continue;
    const bar = line.indexOf("|");
    out.push(bar < 0 ? { name: line, matcher: "" } : { name: line.slice(0, bar), matcher: line.slice(bar + 1) });
  }
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The set of exact (matcher, command) pairs of every command hook under hooks.PreToolUse; `null` if settings is not an object. */
function registeredPairs(settings: unknown): Set<string> | null {
  if (!isObj(settings)) return null;
  const hooks = settings.hooks;
  let pre: unknown = isObj(hooks) ? (hooks.PreToolUse ?? []) : [];
  if (!Array.isArray(pre)) pre = [];
  const pairs = new Set<string>();
  for (const block of pre as unknown[]) {
    if (!isObj(block) || !Array.isArray(block.hooks)) continue;
    for (const h of block.hooks) {
      if (isObj(h) && h.type === "command") pairs.add(JSON.stringify([block.matcher ?? null, h.command ?? null]));
    }
  }
  return pairs;
}

/**
 * Pure verdict: the reasons the live install is incomplete (`[]` == healthy).
 * `installed` is the set of expected hook names present as files; `settingsText`
 * is the raw settings.json (`null` == absent). Vocabulary is the bash block's:
 * `file-missing:<n>`, `unregistered:<n>`, `settings-unreadable`.
 */
export function decideClaudeHooks(input: {
  expected: readonly ExpectedHook[];
  installed: ReadonlySet<string>;
  settingsText: string | null;
  hooksDir: string;
}): string[] {
  const reasons: string[] = [];
  for (const h of input.expected) {
    if (!input.installed.has(h.name)) reasons.push(`file-missing:${h.name}`);
  }
  let pairs: Set<string> | null = null;
  if (input.settingsText !== null) {
    try {
      pairs = registeredPairs(JSON.parse(input.settingsText));
    } catch {
      /* intentional: unparseable settings == Claude Code loads no hooks from it either (settings-unreadable) */
      pairs = null;
    }
  }
  if (pairs === null) {
    reasons.push("settings-unreadable");
    return reasons;
  }
  const dir = input.hooksDir.replace(/\/+$/, "");
  for (const h of input.expected) {
    if (!pairs.has(JSON.stringify([h.matcher, `bash ${dir}/${h.name}`]))) reasons.push(`unregistered:${h.name}`);
  }
  return reasons;
}

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** One watchdog tick of the claude-hooks check. Never throws. */
export async function runClaudeHooks(deps: ClaudeHooksDeps, config: ClaudeHooksConfig): Promise<void> {
  const say = (line: string): void => deps.log(`${CLAUDE_HOOKS_LOG_PREFIX} ${line}`);
  try {
    if (!deps.files.exists(config.setupPath)) {
      say(`WARN installer ${config.setupPath} not found — skipping claude hooks check`);
      return;
    }
    const listing = await deps.host.listInstaller(config.setupPath);
    if (!listing.ok || listing.exitCode !== 0) {
      say(`WARN ${config.setupPath} --list failed (rc=${listing.exitCode}) — skipping claude hooks check`);
      return;
    }
    const expected = parseHookListing(listing.stdout);
    if (expected.length === 0) {
      say(`WARN ${config.setupPath} --list returned no hooks — skipping claude hooks check`);
      return;
    }
    if (!deps.files.ensureStateDir(config.stateDir)) {
      say(`WARN cannot create state dir ${config.stateDir} — skipping claude hooks check`);
      return;
    }
    const markerPath = join(config.stateDir, CLAUDE_HOOKS_MARKER_NAME);
    const installed = new Set(expected.filter((h) => deps.files.exists(join(config.hooksDir, h.name))).map((h) => h.name));
    const reasons = decideClaudeHooks({
      expected,
      installed,
      settingsText: deps.files.readSettings(config.settingsPath),
      hooksDir: config.hooksDir,
    });

    if (reasons.length === 0) {
      if (deps.files.hasSinceMarker(markerPath)) say("claude hooks healthy again — dedup re-armed");
      deps.files.clearSinceMarker(markerPath);
      say(`claude-hooks tick processed (${expected.length} hook(s) installed and registered: ${expected.map((h) => h.name).join(" ")})`);
      return;
    }

    const reasonStr = reasons.join(",");
    say(
      `ALARM Claude Code PreToolUse hooks not fully installed: ${reasonStr} (hooks dir ${config.hooksDir}, settings ${config.settingsPath}; issue #5064 — run 'bash scripts/setup-claude-hooks.sh' or 'bash scripts/deploy.sh' from an operator shell)`,
    );
    if (deps.files.hasSinceMarker(markerPath)) return;

    // Only a stream id proves the entry landed; the marker is written AFTER
    // that, so a failed publish retries next tick instead of silencing the episode.
    let streamId: string | null = null;
    try {
      streamId = await deps.bus.publish(config.notifyStream, {
        type: CLAUDE_HOOKS_EVENT_TYPE,
        source: CLAUDE_HOOKS_EVENT_SOURCE,
        correlationId: CLAUDE_HOOKS_CORRELATION_ID,
        payload: { signal: "claude-hooks", reason: reasonStr.replace(/[^a-zA-Z0-9_.:,-]/g, "") },
      });
    } catch (err) {
      say(`WARN in-band delivery FAILED (${msg(err)}) — will retry next tick`);
      return;
    }
    if (streamId !== null && /^[0-9]+-[0-9]+$/.test(streamId)) {
      deps.files.writeSinceMarker(markerPath, Math.floor(deps.clock.nowMs() / 1000));
      say(`in-band delivery published type=${CLAUDE_HOOKS_EVENT_TYPE} -> ${config.notifyStream} (id ${streamId})`);
    } else {
      say(`WARN in-band delivery FAILED (publish reply '${String(streamId).slice(0, 160)}' is not a stream id) — will retry next tick`);
    }
  } catch (err) {
    say(`WARN claude-hooks tick failed: ${msg(err)}`);
  }
}
