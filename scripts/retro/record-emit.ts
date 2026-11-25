/**
 * scripts/retro/record-emit.ts — the hydra-retro plumbing (ledger, emit,
 * recheck) in ONE tested CLI (issue #5739).
 *
 *   npx tsx scripts/retro/record-emit.ts issue --title T --body-file F --cue C --run-id R
 *   npx tsx scripts/retro/record-emit.ts pr --cue C --run-id R --ref N
 *   npx tsx scripts/retro/record-emit.ts recheck --entries-file F.json
 *   npx tsx scripts/retro/record-emit.ts ledger --cues-file F.json
 *
 * `issue` is three effects in order: `gh issue create` (no state label), the
 * lifecycle-seam first-state advance, then `recordRetroSeen`. The record runs
 * only after the advance succeeded (or the zero-state backstop already put the
 * issue in needs-triage), so a refused advance leaves the cue UNRECORDED and
 * the next run retries it. The created issue is reported, never deleted.
 *
 * Every subcommand prints ONE JSON line. Exit 0 = ok, 1 = refused or a failed
 * effect, 2 = usage. Nothing throws past `main` (STD-VERIFY-NEVER-THROW).
 * This is plumbing for the plan the playbook already computes, not a planner.
 */

import { resolve, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isEntrypoint } from "../lib/entrypoint.mjs";
import { advance, defaultSeamDeps, type AdvanceResult } from "../../src/lifecycle/index.ts";
import { ghExec } from "../../src/github/gh.ts";
import { resolveGithubRepo } from "../../src/github/issues.ts";
import { closeRedisConnections } from "../../src/redis/connection.ts";
import {
  bumpRetroRecurrence,
  getRetroRecurrence,
  getRetroSeen,
  recordRetroSeen,
  type RetroSeenEntry,
} from "../../src/redis/retro-seen.ts";

export const RETRO_ACTOR = "hydra-retro";

export interface RecordEmitPorts {
  /** Run a `gh` argv; resolves to stdout on success or the failure code. */
  gh(args: string[]): Promise<{ ok: true; stdout: string } | { ok: false; code: string }>;
  advance(input: { issue: number; to: string; actor: string }): Promise<AdvanceResult>;
  recordSeen(entry: RetroSeenEntry): Promise<void>;
  bumpRecurrence(cue: string): Promise<number>;
  getSeen(): Promise<Record<string, RetroSeenEntry>>;
  getRecurrence(): Promise<Record<string, number>>;
  now(): string;
  readFile(path: string): string;
}

export interface RecordEmitOutcome {
  code: 0 | 1 | 2;
  result: Record<string, unknown>;
}

const usage = (message: string): RecordEmitOutcome => ({ code: 2, result: { ok: false, code: "usage", message } });
const failed = (code: string, extra: Record<string, unknown> = {}): RecordEmitOutcome => ({
  code: 1,
  result: { ok: false, ...extra, code },
});

function parseFlags(argv: readonly string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) flags[a.slice(2)] = argv[++i] ?? "";
  }
  return flags;
}

export function parseIssueNumber(stdout: string): number | null {
  const m = /\/issues\/(\d+)\s*$/.exec(stdout.trim().split("\n").pop() ?? "");
  return m ? Number(m[1]) : null;
}

async function runIssue(flags: Record<string, string>, ports: RecordEmitPorts): Promise<RecordEmitOutcome> {
  const { title, "body-file": bodyFile, cue, "run-id": runId } = flags;
  if (!title || !bodyFile || !cue || !runId) return usage("issue requires --title, --body-file, --cue and --run-id");
  const body = ports.readFile(bodyFile);
  const created = await ports.gh(["issue", "create", "--repo", resolveGithubRepo(), "--title", title, "--body", body]);
  if (created.ok === false) return failed(created.code);
  const issue = parseIssueNumber(created.stdout);
  if (issue === null) return failed("gh-url-unparseable", { stdout: created.stdout.slice(0, 200) });

  let adv: AdvanceResult;
  try {
    adv = await ports.advance({ issue, to: "needs-triage", actor: RETRO_ACTOR });
  } catch (err) {
    console.error(`[retro-emit] lifecycle advance threw for #${issue}; cue ${cue} left unrecorded:`, err);
    return failed("crashed", { issue });
  }
  if (adv.ok === false) {
    // The reconcile zero-state backstop can win the race and leave the issue in needs-triage:
    // the same move then answers ok+noop, so one identical retry tells that case from a real refusal.
    const retry = adv.code === "illegal-transition" ? await safeAdvance(ports, issue) : null;
    if (!retry || retry.ok === false || retry.observed.state !== "needs-triage") {
      console.error(`[retro-emit] first-state refused for #${issue} (${adv.code}); cue ${cue} left unrecorded`);
      return failed(adv.code, { issue });
    }
  }

  try {
    await ports.recordSeen({ cue, decision: "issue", runId, ref: String(issue), at: ports.now() });
  } catch (err) {
    console.error(`[retro-emit] recordRetroSeen failed for #${issue}:`, err);
    return failed("record-failed", { issue });
  }
  return { code: 0, result: { ok: true, issue, cue } };
}

async function safeAdvance(ports: RecordEmitPorts, issue: number): Promise<AdvanceResult | null> {
  try {
    return await ports.advance({ issue, to: "needs-triage", actor: RETRO_ACTOR });
  } catch (err) {
    console.error(`[retro-emit] lifecycle advance re-read threw for #${issue}:`, err);
    return null;
  }
}

async function runPr(flags: Record<string, string>, ports: RecordEmitPorts): Promise<RecordEmitOutcome> {
  const { cue, "run-id": runId, ref } = flags;
  if (!cue || !runId || !ref) return usage("pr requires --cue, --run-id and --ref");
  try {
    await ports.recordSeen({ cue, decision: "pr", runId, ref, at: ports.now() });
  } catch (err) {
    console.error(`[retro-emit] recordRetroSeen (pr) failed for ${cue}:`, err);
    return failed("record-failed");
  }
  return { code: 0, result: { ok: true, cue } };
}

function readJsonArray(ports: RecordEmitPorts, path: string): unknown[] | null {
  try {
    const parsed: unknown = JSON.parse(ports.readFile(path));
    return Array.isArray(parsed) ? parsed : null;
  } catch (err) {
    console.error(`[retro-emit] cannot read a JSON array from ${path}:`, err);
    return null;
  }
}

async function runRecheck(flags: Record<string, string>, ports: RecordEmitPorts): Promise<RecordEmitOutcome> {
  if (!flags["entries-file"]) return usage("recheck requires --entries-file");
  const entries = readJsonArray(ports, flags["entries-file"]);
  if (entries === null) return failed("entries-unreadable");
  let n = 0;
  for (const e of entries as RetroSeenEntry[]) {
    try {
      await ports.recordSeen({ ...e, at: ports.now() });
      n++;
    } catch (err) {
      console.error(`[retro-emit] recheck record failed for ${e.cue}:`, err);
      return failed("record-failed", { cue: e.cue, rechecked: n });
    }
  }
  return { code: 0, result: { ok: true, rechecked: n } };
}

async function runLedger(flags: Record<string, string>, ports: RecordEmitPorts): Promise<RecordEmitOutcome> {
  if (!flags["cues-file"]) return usage("ledger requires --cues-file");
  const cues = readJsonArray(ports, flags["cues-file"]);
  if (cues === null) return failed("cues-unreadable");
  try {
    for (const c of cues as string[]) await ports.bumpRecurrence(c);
    const seen = await ports.getSeen();
    const recurrence = await ports.getRecurrence();
    return { code: 0, result: { seenCues: Object.keys(seen), recurrence } };
  } catch (err) {
    console.error("[retro-emit] ledger read/bump failed:", err);
    return failed("ledger-failed");
  }
}

/** Decision function: argv + ports in, one outcome out. Never throws. */
export async function runRecordEmit(argv: readonly string[], ports: RecordEmitPorts): Promise<RecordEmitOutcome> {
  const [verb, ...rest] = argv;
  const flags = parseFlags(rest);
  try {
    if (verb === "issue") return await runIssue(flags, ports);
    if (verb === "pr") return await runPr(flags, ports);
    if (verb === "recheck") return await runRecheck(flags, ports);
    if (verb === "ledger") return await runLedger(flags, ports);
  } catch (err) {
    console.error("[retro-emit] unexpected failure:", err);
    return failed("crashed");
  }
  return usage("usage: issue | pr | recheck | ledger");
}

function productionPorts(): RecordEmitPorts {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const deps = defaultSeamDeps(repoRoot);
  return {
    async gh(args) {
      const res = await ghExec(args);
      return res.ok === false ? { ok: false, code: res.code } : { ok: true, stdout: res.data.stdout };
    },
    advance: (input) => advance(input, deps),
    recordSeen: recordRetroSeen,
    bumpRecurrence: (cue) => bumpRetroRecurrence(cue),
    getSeen: getRetroSeen,
    getRecurrence: getRetroRecurrence,
    now: () => new Date().toISOString(),
    readFile: (path) => readFileSync(path, "utf8"),
  };
}

/** CLI entry: one JSON line, exit 0/1/2, Redis closed before exit. */
export async function main(argv: readonly string[], makePorts: () => RecordEmitPorts = productionPorts): Promise<number> {
  let out: RecordEmitOutcome;
  try {
    out = await runRecordEmit(argv, makePorts());
  } catch (err) {
    console.error("[retro-emit] port construction or run crashed:", err);
    out = failed("crashed");
  }
  process.stdout.write(`${JSON.stringify(out.result)}\n`);
  closeRedisConnections();
  return out.code;
}

if (isEntrypoint(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.stdout.write("", () => process.exit(code)),
    (err) => {
      console.error("[retro-emit] crashed:", err);
      closeRedisConnections();
      process.exit(1);
    },
  );
}
