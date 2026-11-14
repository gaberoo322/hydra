/**
 * scripts/ops-collect.ts — operator diagnostics collector CLI.
 *
 *   npx tsx scripts/ops-collect.ts --collectors cycles,memory,board,scheduler [--text] [--count N]
 *
 * Prints one result per collector (`{ok:true,data}|{ok:false,code,reason}`) as
 * JSON, or as `name: ...` lines with --text. ALWAYS exits 0: a failing
 * collector degrades to its own `ok:false` result so the caller keeps
 * diagnosing. Reads orchestrator state over /api/*, Redis through
 * src/redis/agent-memory.ts, and the board through the gh adapter.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ghJson } from "../src/github/gh.ts";
import { closeRedisConnections } from "../src/redis/connection.ts";
import { getMemoryPatterns } from "../src/redis/agent-memory.ts";
import {
  collectAgentMemory,
  collectBoard,
  collectCycles,
  collectScheduler,
  learningAgents,
  renderText,
  type CollectorResult,
} from "./ops-collect-logic.ts";

const BASE = process.env.HYDRA_API_URL ?? "http://localhost:4000";
const REPO = "gaberoo322/hydra";
export const COLLECTOR_NAMES = ["cycles", "memory", "board", "scheduler"] as const;

async function getJson(path: string): Promise<CollectorResult<unknown>> {
  try {
    const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { ok: false, code: "http-error", reason: `${path} -> ${res.status}` };
    return { ok: true, data: await res.json() };
  } catch (err) {
    /* intentional: error is returned as the collector result, not swallowed */
    return { ok: false, code: "unreachable", reason: `${path}: ${(err as Error).message}` };
  }
}

async function collectMemory(): Promise<CollectorResult<unknown>> {
  let agents: string[];
  try {
    const doc = JSON.parse(readFileSync(new URL("./autopilot/classes.json", import.meta.url), "utf8"));
    agents = learningAgents(doc);
  } catch (err) {
    /* intentional: error is returned as the collector result, not swallowed */
    return { ok: false, code: "classes-unreadable", reason: (err as Error).message };
  }
  const out: CollectorResult<unknown>[] = [];
  for (const agent of agents) {
    try {
      out.push(collectAgentMemory(agent, await getMemoryPatterns(agent)));
    } catch (err) {
      /* intentional: error is returned as the collector result, not swallowed */
      out.push({ ok: false, code: "redis-error", reason: `${agent}: ${(err as Error).message}` });
    }
  }
  return { ok: true, data: out };
}

async function runCollector(name: string, count: number): Promise<CollectorResult<unknown>> {
  switch (name) {
    case "cycles": {
      const r = await getJson(`/api/metrics?count=${count}`);
      return r.ok ? collectCycles(r.data) : r;
    }
    case "scheduler": {
      const r = await getJson("/api/scheduler/status");
      return r.ok ? collectScheduler(r.data) : r;
    }
    case "board": {
      const r = await ghJson<unknown>([
        "issue", "list", "--repo", REPO, "--state", "open", "--limit", "200", "--json", "labels",
      ]);
      if (r.ok) return collectBoard(r.data);
      const failed = r as { code: string; stderr: string };
      return { ok: false, code: failed.code, reason: failed.stderr.slice(0, 200) };
    }
    case "memory":
      return collectMemory();
    default:
      return { ok: false, code: "unknown-collector", reason: `${name} (known: ${COLLECTOR_NAMES.join(",")})` };
  }
}

export async function main(argv: string[]): Promise<void> {
  if (argv.includes("--help")) {
    console.log(`usage: ops-collect.ts --collectors <${COLLECTOR_NAMES.join(",")}> [--text] [--count N]`);
    return;
  }
  const flag = (n: string) => argv[argv.indexOf(n) + 1];
  const names = (argv.includes("--collectors") ? flag("--collectors") : COLLECTOR_NAMES.join(","))
    .split(",")
    .filter(Boolean);
  const count = Number(argv.includes("--count") ? flag("--count") : 50) || 50;
  const results: Record<string, CollectorResult<unknown>> = {};
  for (const n of names) results[n] = await runCollector(n, count);
  if (argv.includes("--text")) for (const n of names) console.log(renderText(n, results[n]));
  else console.log(JSON.stringify(results, null, 2));
  closeRedisConnections();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    () => process.exit(0),
    (err) => {
      console.error("[ops-collect] fatal:", err);
      process.exit(0);
    },
  );
}
