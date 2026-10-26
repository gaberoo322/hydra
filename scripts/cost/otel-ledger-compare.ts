#!/usr/bin/env -S npx tsx
/**
 * scripts/cost/otel-ledger-compare.ts — read-only comparison of the OTel span
 * ledger against the transcript-derived per-dispatch token count (issue #5177,
 * epic #5171).
 *
 * For every agent_id in the OTel index it joins the SubagentDispatch row
 * (skill, dispatchId, issueRef, parentSessionId), folds that dispatch's own
 * JSONL through the shared message.id-deduped `parseTranscriptFile` (never a
 * private re-parse, #5172 / ADR-0042 check 5) and prints one row per agent:
 * spanTotal (+ the 4 categories), transcriptTotal, delta, deltaPct, requests.
 * Footer counts report join misses (spans but no dispatch row) and transcript
 * misses (dispatch row but no JSONL).
 *
 * ZERO Redis writes. Exits 1 on any join failure it could not resolve (after
 * printing the partial table), never a stack trace.
 *
 * Usage:
 *   npx tsx scripts/cost/otel-ledger-compare.ts
 *   npx tsx scripts/cost/otel-ledger-compare.ts --json
 */
import { readFile } from "node:fs/promises";
import { listOtelAgentIds, getOtelAgentTotals, type OtelAgentTotals } from "../../src/redis/otel-spans.ts";
import { getSubagentDispatch } from "../../src/redis/dispatches.ts";
import { resolveSubagentTranscriptPath } from "../../src/transcript-store.ts";
import { parseTranscriptFile } from "../../src/cost/index.ts";

export interface CompareRow {
  agentId: string;
  skill: string | null;
  dispatchId: string | null;
  issueRef: string | null;
  spanTotal: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  transcriptTotal: number | null;
  delta: number | null;
  deltaPct: number | null;
  requests: number;
}

export interface CompareFooter {
  agents: number;
  joinMisses: number;
  transcriptMisses: number;
  failures: number;
}

/** Pure: combine span totals with an (optional) dispatch row and transcript total. */
export function buildRow(
  totals: Pick<OtelAgentTotals, "agentId" | "input" | "output" | "cacheRead" | "cacheCreation" | "requests">,
  dispatch: { skill: string; dispatchId: string; issueRef?: string } | null,
  transcriptTotal: number | null,
): CompareRow {
  const spanTotal = totals.input + totals.output + totals.cacheRead + totals.cacheCreation;
  const delta = transcriptTotal === null ? null : spanTotal - transcriptTotal;
  const deltaPct =
    transcriptTotal === null || transcriptTotal === 0 || delta === null
      ? null
      : Math.round((delta / transcriptTotal) * 10000) / 100;
  return {
    agentId: totals.agentId,
    skill: dispatch?.skill ?? null,
    dispatchId: dispatch?.dispatchId ?? null,
    issueRef: dispatch?.issueRef ?? null,
    spanTotal,
    input: totals.input,
    output: totals.output,
    cacheRead: totals.cacheRead,
    cacheCreation: totals.cacheCreation,
    transcriptTotal,
    delta,
    deltaPct,
    requests: totals.requests,
  };
}

/** Pure: transcript-side count via the shared message.id-deduped fold (non-foreign lines). */
export function transcriptTotalFromContent(content: string): number {
  const parsed = parseTranscriptFile(content, 0, () => ({ skill: "", dispatchKind: "interactive" }));
  let total = 0;
  for (const e of parsed.entry.entries) {
    if (!e.foreign) total += e.tokens.total;
  }
  return total;
}

export function renderTable(rows: readonly CompareRow[], footer: CompareFooter): string {
  const head = ["agentId", "skill", "dispatchId", "spanTotal", "in", "out", "cacheR", "cacheW", "transcript", "delta", "delta%", "reqs"];
  const cell = (v: string | number | null) => (v === null ? "-" : String(v));
  const body = rows.map((r) =>
    [r.agentId, r.skill, r.dispatchId, r.spanTotal, r.input, r.output, r.cacheRead, r.cacheCreation, r.transcriptTotal, r.delta, r.deltaPct, r.requests].map(cell),
  );
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const fmt = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i])).join("  ");
  const lines = [fmt(head), ...body.map(fmt)];
  lines.push(
    "",
    `agents=${footer.agents} joinMisses=${footer.joinMisses} (spans but no SubagentDispatch row) ` +
      `transcriptMisses=${footer.transcriptMisses} (dispatch row but no JSONL) failures=${footer.failures}`,
  );
  return lines.join("\n");
}

async function main(): Promise<number> {
  const json = process.argv.slice(2).includes("--json");
  const rows: CompareRow[] = [];
  const footer: CompareFooter = { agents: 0, joinMisses: 0, transcriptMisses: 0, failures: 0 };

  let ids: string[];
  try {
    ids = await listOtelAgentIds();
  } catch (err) {
    console.error("[otel-ledger-compare] failed to list the OTel index:", err);
    return 1;
  }

  for (const agentId of ids) {
    footer.agents++;
    try {
      const totals = await getOtelAgentTotals(agentId);
      if (!totals) continue; // hash expired between index read and fetch
      const dispatch = await getSubagentDispatch(agentId);
      let transcriptTotal: number | null = null;
      if (!dispatch) {
        footer.joinMisses++;
      } else {
        const path = dispatch.parentSessionId
          ? await resolveSubagentTranscriptPath(dispatch.parentSessionId, dispatch.sessionId)
          : null;
        if (!path) {
          footer.transcriptMisses++;
        } else {
          transcriptTotal = transcriptTotalFromContent(await readFile(path, "utf8"));
        }
      }
      rows.push(buildRow(totals, dispatch, transcriptTotal));
    } catch (err) {
      footer.failures++;
      console.error(`[otel-ledger-compare] could not resolve agent ${agentId}:`, err);
    }
  }

  if (json) {
    process.stdout.write(JSON.stringify({ rows, footer }, null, 2) + "\n");
  } else {
    process.stdout.write(renderTable(rows, footer) + "\n");
  }
  return footer.failures > 0 ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("[otel-ledger-compare] fatal:", err);
      process.exit(1);
    });
}
