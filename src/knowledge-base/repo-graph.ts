/**
 * Repo-graph coupling adapter (issue #2939).
 *
 * # Why this module exists
 *
 * The Orchestrator already builds a full directed import graph of `src/` —
 * `scanArchitecture()` in `src/aggregators/architecture-graph.ts` (~326
 * modules, ~818 edges, per-module inDegree/outDegree, derived group
 * membership) — but that graph was wired to exactly one consumer: the
 * dashboard's `GET /api/architecture` route. Neither `hydra-discover` nor the
 * `hydra-architecture-scan` playbook ever read it, so architecture-deepening
 * candidate search fell back to random file-size pattern-matching instead of
 * the coupling signal the graph already encodes.
 *
 * This adapter is the missing BRIDGE (not new infrastructure): it consumes the
 * existing `ArchitectureGraph` READ-ONLY and formats a deterministic markdown
 * coupling-summary block that the architecture-scan Explore phase can seed its
 * candidate search from — the seam-hub / cross-group-tension modules worth
 * deepening.
 *
 * # Design contract
 *
 * - **Pure adapter.** No Express, no module-global cache, no I/O of its own.
 *   It calls `scanArchitecture()` (already pure + FS-injectable) and reduces
 *   the returned graph to a markdown string with pure array/map arithmetic.
 *   The same `ArchitectureGraphDeps` injection points flow straight through,
 *   so this module is unit-testable with stubbed `readdir`/`readFile` and no
 *   real filesystem.
 * - **`scanArchitecture()` is NOT modified** — this is a downstream consumer
 *   only. `GET /api/architecture` behaviour is unaffected.
 * - **No new runtime dependency** (ADR-0005): node stdlib only. The coupling
 *   derivation is O(nodes + edges) in-memory arithmetic.
 * - **No Redis / OpenViking seam** — this module opens no connection and
 *   imports neither `redis/*` nor an OV request path; the coupling report is
 *   deterministic and emitted directly as a prompt block.
 * - **Deterministic output.** Given the same graph, the markdown is
 *   byte-identical: every ranking has an explicit stable tiebreak (module id
 *   / pair key ascending), so ties never reorder between runs.
 */

import {
  scanArchitecture,
  type ArchitectureGraph,
  type ArchitectureGraphDeps,
  type ArchitectureNode,
} from "../aggregators/architecture-graph.ts";

// ---------------------------------------------------------------------------
// Tunables — how many rows each section of the report surfaces.
// ---------------------------------------------------------------------------

/**
 * Report shape knobs. Defaults satisfy the issue acceptance criterion
 * (≥10 ranked modules + top-5 cross-group pairs). Exposed so a caller/test
 * can request a wider report; the report never emits more rows than the graph
 * actually has.
 */
export interface CouplingReportOptions {
  /** How many fan-in-ranked modules to list. Default 10. */
  topModules?: number;
  /** How many cross-group edge pairs to list. Default 5. */
  topGroupPairs?: number;
}

const DEFAULTS: Required<CouplingReportOptions> = {
  topModules: 10,
  topGroupPairs: 5,
};

// ---------------------------------------------------------------------------
// Pure derivations over an ArchitectureGraph (no I/O).
// ---------------------------------------------------------------------------

/** A module ranked by how many other modules depend on it (fan-in). */
export interface RankedModule {
  id: string;
  group: string;
  /** Modules that import this one (`inDegree`). */
  fanIn: number;
  /** Modules this one imports (`outDegree`). */
  fanOut: number;
  /** `fanIn + fanOut` — the module's total coupling. */
  coupling: number;
}

/** A directed group→group edge count (cross-group coupling tension). */
export interface GroupPair {
  from: string;
  to: string;
  /** Number of module→module edges that cross this group boundary. */
  count: number;
}

/**
 * Rank modules by fan-in (inDegree) descending, then total coupling
 * descending, then id ascending — a fully-deterministic order so ties never
 * reorder between runs.
 */
export function rankModulesByFanIn(nodes: ArchitectureNode[]): RankedModule[] {
  return nodes
    .map((n) => ({
      id: n.id,
      group: n.group,
      fanIn: n.inDegree,
      fanOut: n.outDegree,
      coupling: n.inDegree + n.outDegree,
    }))
    .sort(
      (a, b) =>
        b.fanIn - a.fanIn ||
        b.coupling - a.coupling ||
        a.id.localeCompare(b.id),
    );
}

/**
 * Collapse the module→module edge list into directed group→group pairs,
 * counting only edges that CROSS a group boundary (intra-group edges are not
 * cross-group tension). Ranked by count descending, then `from`/`to` id
 * ascending for a deterministic order.
 */
export function crossGroupPairs(graph: ArchitectureGraph): GroupPair[] {
  const groupOf = new Map<string, string>();
  for (const n of graph.nodes) groupOf.set(n.id, n.group);

  const counts = new Map<string, number>();
  for (const e of graph.edges) {
    const fromGroup = groupOf.get(e.from);
    const toGroup = groupOf.get(e.to);
    // Both endpoints are always known modules (edges are built from the node
    // set), but guard defensively and skip intra-group edges.
    if (fromGroup === undefined || toGroup === undefined) continue;
    if (fromGroup === toGroup) continue;
    const key = `${fromGroup} ${toGroup}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([key, count]) => {
      const [from, to] = key.split(" ");
      return { from, to, count };
    })
    .sort(
      (a, b) =>
        b.count - a.count ||
        a.from.localeCompare(b.from) ||
        a.to.localeCompare(b.to),
    );
}

// ---------------------------------------------------------------------------
// Markdown rendering.
// ---------------------------------------------------------------------------

/**
 * Render an already-computed graph into the deterministic markdown
 * coupling-summary block. Split from {@link getCouplingReport} so callers that
 * already hold a graph (e.g. the dashboard route) can reuse the formatter
 * without re-scanning, and so the pure formatter is testable in isolation.
 */
export function renderCouplingReport(
  graph: ArchitectureGraph,
  options: CouplingReportOptions = {},
): string {
  const topModules = options.topModules ?? DEFAULTS.topModules;
  const topGroupPairs = options.topGroupPairs ?? DEFAULTS.topGroupPairs;

  const ranked = rankModulesByFanIn(graph.nodes).slice(0, topModules);
  const pairs = crossGroupPairs(graph).slice(0, topGroupPairs);

  const lines: string[] = [];
  lines.push("## Repo coupling summary");
  lines.push("");
  lines.push(
    `_Derived from the import graph (${graph.moduleCount} modules, ` +
      `${graph.edgeCount} edges). Seed candidate search from these ` +
      `high-coupling seam hubs, not file size._`,
  );
  lines.push("");

  lines.push(`### Most-depended-on modules (top ${ranked.length} by fan-in)`);
  lines.push("");
  lines.push("| Module | Group | Fan-in | Fan-out |");
  lines.push("| --- | --- | ---: | ---: |");
  for (const m of ranked) {
    lines.push(`| \`${m.id}\` | ${m.group} | ${m.fanIn} | ${m.fanOut} |`);
  }
  lines.push("");

  lines.push(`### Top cross-group coupling (top ${pairs.length} pairs)`);
  lines.push("");
  if (pairs.length === 0) {
    lines.push("_No cross-group edges._");
  } else {
    lines.push("| From group | To group | Edges |");
    lines.push("| --- | --- | ---: |");
    for (const p of pairs) {
      lines.push(`| ${p.from} | ${p.to} | ${p.count} |`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * Scan the repo import graph and emit the deterministic markdown
 * coupling-summary block for seeding architecture-scan candidate search.
 *
 * Wraps `scanArchitecture()` READ-ONLY: the `ArchitectureGraphDeps` (srcDir /
 * readdir / readFile / now) flow straight through, so this is unit-testable
 * with stubbed filesystem deps and pure given them.
 */
export async function getCouplingReport(
  deps: ArchitectureGraphDeps = {},
  options: CouplingReportOptions = {},
): Promise<string> {
  const graph = await scanArchitecture(deps);
  return renderCouplingReport(graph, options);
}
