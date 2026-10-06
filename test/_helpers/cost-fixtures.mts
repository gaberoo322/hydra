/**
 * Shared Cost-module test fixtures (issue #4784, epic #4780 — the test-topology
 * split of ADR-0042 Decision 8).
 *
 * These seven helpers were defined inline at the top of
 * `test/usage-tracker.test.mts` and are used by both that file and
 * `test/transcript-scan.test.mts` (split out of it). They are moved here
 * VERBATIM — bodies unchanged — so both suites share one definition instead of
 * a forked copy. Pure fixtures + env snapshot only: no Redis, no src imports
 * beyond the `TokenBreakdown` type the `breakdown` fixture is typed against.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TokenBreakdown } from "../../src/cost/token-math.ts";

// ADR-0027: the cost module now logs through the pino structured-logger seam
// (module singleton → process.stderr) instead of freeform console.* strings.
// The fail-loud detectors under test (unknown-model warn, calibration-drift
// warn, estimate/OAuth divergence warn) therefore emit serialized JSON lines on
// stderr, not console.warn/console.error calls. `captureLoggerLines` intercepts
// `process.stderr.write`, parses each pino line, and collects its `msg` string —
// the human-readable message is preserved on the `msg` field, so the existing
// substring filters (`.includes("[usage-tracker]")`, `.includes("calibration
// drift")`, `.includes("estimate/OAuth divergence")`) keep matching unchanged.
// The corresponding pino JSON object is also exposed via `.records()` for tests
// that want to assert on structured fields / level.
export function captureLoggerLines(): {
  lines: () => string[];
  records: () => Array<Record<string, any>>;
  restore: () => void;
} {
  const originalWrite = process.stderr.write.bind(process.stderr);
  const msgs: string[] = [];
  const objs: Array<Record<string, any>> = [];
  (process.stderr as any).write = (chunk: any) => {
    for (const raw of String(chunk).split("\n")) {
      if (!raw.trim()) continue;
      let obj: Record<string, any>;
      try {
        obj = JSON.parse(raw);
      } catch {
        continue; // not a pino line
      }
      objs.push(obj);
      if (typeof obj.msg === "string") msgs.push(obj.msg);
    }
    return true;
  };
  return {
    lines: () => msgs,
    records: () => objs,
    restore: () => {
      (process.stderr as any).write = originalWrite;
    },
  };
}

export function breakdown(p: Partial<TokenBreakdown> = {}): TokenBreakdown {
  const input = p.input ?? 0;
  const output = p.output ?? 0;
  const cacheRead = p.cacheRead ?? 0;
  const cacheCreation = p.cacheCreation ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheCreation,
    total: p.total ?? input + output + cacheRead + cacheCreation,
  };
}

export interface TokenInput {
  in?: number;
  out?: number;
  cacheRead?: number;
  cacheCreation?: number;
}

export function assistantLine(ts: string, tokens: TokenInput = {}, model?: string): string {
  const message: Record<string, unknown> = {
    role: "assistant",
    usage: {
      input_tokens: tokens.in ?? 0,
      output_tokens: tokens.out ?? 0,
      cache_read_input_tokens: tokens.cacheRead ?? 0,
      cache_creation_input_tokens: tokens.cacheCreation ?? 0,
    },
  };
  if (model !== undefined) message.model = model;
  return JSON.stringify({
    type: "assistant",
    timestamp: ts,
    message,
  });
}

/**
 * A `type:"user"` transcript line carrying `content` as a plain string — the
 * first-user-message signal `deriveSkill` reads (issue #2402). Pass the
 * `hydra-dispatch` sentinel comment or a `<command-name>/skill</command-name>`
 * marker to attribute a fixture session; omit to leave it interactive.
 * `isMeta:true` marks a harness-injected line the extractor must skip.
 */
export function userLine(content: string, opts: { meta?: boolean } = {}): string {
  return JSON.stringify({
    type: "user",
    timestamp: "2026-05-25T10:59:00Z",
    isMeta: opts.meta === true,
    message: { role: "user", content },
  });
}

/** The hydra-dispatch sentinel comment for `skill`, as it lands in a transcript. */
export function sentinelLine(skill: string): string {
  return userLine(
    `<!-- hydra-dispatch v1 skill=${skill} dispatchId=worktree-agent-deadbeef-t1-x runId=deadbeef-0000 -->`,
  );
}

export async function writeFixture(root: string, relPath: string, lines: string[]): Promise<void> {
  const full = join(root, relPath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, lines.join("\n") + "\n", "utf-8");
}

export function withEnvSnapshot() {
  const keys = [
    "HYDRA_USAGE_WEEKLY_QUOTA_TOKENS",
    "HYDRA_USAGE_5H_QUOTA_TOKENS",
    "HYDRA_USAGE_WEEKLY_RESET_ANCHOR",
    "HYDRA_USAGE_WEEKLY_PACE_CEILING",
    "HYDRA_CLAUDE_PROJECTS_ROOT",
    "HYDRA_QUOTA_WEIGHT_OPUS",
    "HYDRA_QUOTA_WEIGHT_SONNET",
    "HYDRA_QUOTA_WEIGHT_HAIKU",
    "HYDRA_USAGE_CACHE_READ_WEIGHT",
    "HYDRA_USAGE_DRIFT_REFERENCE_PERCENT",
    "HYDRA_USAGE_DRIFT_FACTOR",
    "HYDRA_OAUTH_ESTIMATE_DIVERGENCE_FACTOR",
    "HYDRA_OAUTH_USAGE_TTL_MS",
    "HYDRA_OAUTH_USAGE_MAX_STALE_MS",
    "HYDRA_USAGE_5H_THROTTLE_T1",
    "HYDRA_USAGE_5H_THROTTLE_T2",
  ];
  const prev: Record<string, string | undefined> = {};
  for (const k of keys) prev[k] = process.env[k];
  return () => {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  };
}
