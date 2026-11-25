/**
 * scripts/retro/record-emit.ts — the hydra-retro section 8 emit sequence in ONE
 * tested call (issue #5739).
 *
 *   npx tsx scripts/retro/record-emit.ts emit --title T --body-file F --cue C --run-id R
 *       [--label L]... [--repo owner/name] [--decision issue]
 *   npx tsx scripts/retro/record-emit.ts recheck --cue C --decision issue|pr|artifact --run-id R [--ref N]
 *
 * `emit` is: `gh issue create`, then the first-state write through the
 * lifecycle seam, then `recordRetroSeen`. The order is the contract: a failed
 * first-state advance leaves the cue UNRECORDED, so the next retro run retries
 * the finding instead of deduping against an issue that never reached
 * needs-triage. `recheck` re-records an existing seen entry with a fresh `at`
 * (the review-mode recheck: an open prior emit emits nothing, but the due
 * signal must not re-fire daily).
 *
 * Prints ONE JSON line. Exit 0 = emitted/recorded, 1 = a step failed (the
 * `stage` names which), 2 = usage.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { isEntrypoint } from "../lib/entrypoint.mjs";
import type { RetroSeenEntry } from "../../src/redis/retro-seen.ts";

const execFileP = promisify(execFile);

export const DEFAULT_REPO = "gaberoo322/hydra";
export const RETRO_ACTOR = "hydra-retro";

export interface EmitInput {
  title: string;
  body: string;
  cue: string;
  runId: string;
  labels: string[];
  repo: string;
  decision: RetroSeenEntry["decision"];
}

/** The side effects, injected so the ordering contract is testable offline. */
export interface EmitPorts {
  /** Create the issue; resolves to gh's stdout (the issue URL). */
  createIssue(input: EmitInput): Promise<string>;
  /** Run the lifecycle first-state advance; resolves to the exit code and the verb's last JSON line. */
  advanceFirstState(issue: number): Promise<{ code: number; json: unknown }>;
  record(entry: RetroSeenEntry): Promise<void>;
  now(): string;
}

export type EmitResult =
  | { ok: true; issue: number; url: string; recorded: true }
  | { ok: false; stage: "create" | "parse-url" | "first-state" | "record"; error: string; issue?: number; url?: string };

/** The reconcile zero-state backstop racing the first-state write is a success, per the first-state rule. */
function isBackstopRace(json: unknown): boolean {
  if (typeof json !== "object" || json === null) return false;
  const j = json as { error?: unknown; code?: unknown; observed?: { state?: unknown; labels?: unknown } };
  const code = j.code ?? j.error;
  if (code !== "illegal-transition") return false;
  const labels = Array.isArray(j.observed?.labels) ? (j.observed?.labels as unknown[]) : [];
  return j.observed?.state === "needs-triage" || labels.includes("needs-triage");
}

export function parseIssueNumber(url: string): number | null {
  const m = /\/issues\/(\d+)\s*$/.exec(url.trim().split("\n").pop() ?? "");
  return m ? Number(m[1]) : null;
}

export async function emitIssue(input: EmitInput, ports: EmitPorts): Promise<EmitResult> {
  let url: string;
  try {
    url = (await ports.createIssue(input)).trim();
  } catch (err) {
    console.error("[retro-emit] gh issue create failed:", err);
    return { ok: false, stage: "create", error: err instanceof Error ? err.message : String(err) };
  }
  const issue = parseIssueNumber(url);
  if (issue === null) return { ok: false, stage: "parse-url", error: `no issue number in: ${url}`, url };

  const adv = await ports.advanceFirstState(issue);
  if (adv.code !== 0 && !isBackstopRace(adv.json)) {
    console.error(`[retro-emit] first-state advance failed for #${issue}; cue ${input.cue} left unrecorded`, adv.json);
    return { ok: false, stage: "first-state", error: JSON.stringify(adv.json), issue, url };
  }

  try {
    await ports.record({ cue: input.cue, decision: input.decision, runId: input.runId, ref: String(issue), at: ports.now() });
  } catch (err) {
    console.error(`[retro-emit] recordRetroSeen failed for #${issue}:`, err);
    return { ok: false, stage: "record", error: err instanceof Error ? err.message : String(err), issue, url };
  }
  return { ok: true, issue, url, recorded: true };
}

/** Re-record an existing seen entry with a fresh `at` (review-mode recheck). */
export async function recheckEntry(
  entry: Omit<RetroSeenEntry, "at">,
  ports: Pick<EmitPorts, "record" | "now">,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await ports.record({ ...entry, at: ports.now() });
    return { ok: true };
  } catch (err) {
    console.error(`[retro-emit] recheck record failed for ${entry.cue}:`, err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function parseLastJson(text: string): unknown {
  const last = text.trim().split("\n").pop() ?? "";
  try {
    return JSON.parse(last);
  } catch {
    /* intentional: a non-JSON lifecycle line is reported raw to the caller */
    return { raw: last };
  }
}

function productionPorts(): EmitPorts {
  return {
    async createIssue(input) {
      const args = ["issue", "create", "--repo", input.repo, "--title", input.title, "--body", input.body];
      for (const l of input.labels) args.push("--label", l);
      const { stdout } = await execFileP("gh", args);
      return stdout;
    },
    async advanceFirstState(issue) {
      try {
        const { stdout } = await execFileP("npx", ["tsx", "scripts/lifecycle.ts", "advance", String(issue), "needs-triage", "--actor", RETRO_ACTOR]);
        return { code: 0, json: parseLastJson(stdout) };
      } catch (err) {
        const e = err as { code?: number; stdout?: string };
        return { code: typeof e.code === "number" ? e.code : 1, json: parseLastJson(e.stdout ?? "") };
      }
    },
    async record(entry) {
      const { recordRetroSeen } = await import("../../src/redis/retro-seen.ts");
      await recordRetroSeen(entry);
    },
    now: () => new Date().toISOString(),
  };
}

function parseFlags(argv: readonly string[]): { flags: Record<string, string>; multi: Record<string, string[]> } {
  const flags: Record<string, string> = {};
  const multi: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const v = argv[i + 1] ?? "";
    flags[a.slice(2)] = v;
    (multi[a.slice(2)] ??= []).push(v);
    i++;
  }
  return { flags, multi };
}

const DECISIONS = ["issue", "pr", "artifact"];

export async function main(argv: readonly string[], ports: EmitPorts = productionPorts()): Promise<number> {
  const [verb, ...rest] = argv;
  const { flags, multi } = parseFlags(rest);
  if (verb === "emit") {
    const { title, "body-file": bodyFile, cue, "run-id": runId } = flags;
    if (!title || !bodyFile || !cue || !runId) {
      console.error("[retro-emit] emit requires --title, --body-file, --cue and --run-id");
      return 2;
    }
    const decision = (flags.decision ?? "issue") as RetroSeenEntry["decision"];
    if (!DECISIONS.includes(decision)) {
      console.error(`[retro-emit] unknown --decision '${decision}'`);
      return 2;
    }
    const res = await emitIssue(
      { title, body: readFileSync(bodyFile, "utf8"), cue, runId, labels: multi.label ?? [], repo: flags.repo ?? DEFAULT_REPO, decision },
      ports,
    );
    process.stdout.write(`${JSON.stringify(res)}\n`);
    return res.ok ? 0 : 1;
  }
  if (verb === "recheck") {
    const { cue, decision, "run-id": runId, ref } = flags;
    if (!cue || !runId || !decision || !DECISIONS.includes(decision)) {
      console.error("[retro-emit] recheck requires --cue, --run-id and --decision issue|pr|artifact");
      return 2;
    }
    const res = await recheckEntry({ cue, decision: decision as RetroSeenEntry["decision"], runId, ref: ref ?? null }, ports);
    process.stdout.write(`${JSON.stringify(res)}\n`);
    return res.ok ? 0 : 1;
  }
  console.error("[retro-emit] usage: emit --title T --body-file F --cue C --run-id R [--label L]... | recheck --cue C --decision D --run-id R [--ref N]");
  return 2;
}

if (isEntrypoint(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.stdout.write("", () => process.exit(code)),
    (err) => {
      console.error("[retro-emit] crashed:", err);
      process.exit(1);
    },
  );
}
