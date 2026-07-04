/**
 * Tool-scout walk-surface enumeration (extracted from calendar-walk.ts,
 * issue #2826).
 *
 * This module is a **pure FS-I/O leaf**: it owns just the discovery of the
 * targets the scout calendar walk operates over — the `package.json` runtime
 * dependencies and the `docs/ai-leverage-categories.md` category slugs. It
 * imports nothing from `src/redis/*` and holds no cooldown/eligibility logic;
 * that coordination stays in the sibling `calendar-walk.ts` planner.
 *
 * The split follows two distinct change axes (issue #2826):
 *
 *   - **Walk-surface enumeration** (this module) grows when a new package
 *     manifest is added or the categories document format changes. Its failure
 *     modes are FS read errors and markdown parse errors — recoverable
 *     per-source with `console.error` + an empty-array fallback.
 *   - **Eligibility/cooldown routing** (`calendar-walk.ts`) grows when cooldown
 *     tiers change. Its failure modes are Redis errors.
 *
 * Keeping the FS surface here — co-located with `parseCategorySlugs` — lets a
 * test exercise `planWalk`'s eligibility routing by injecting a fixed target
 * list, without stubbing the entire FS surface.
 */

import { promises as fs } from "node:fs";
import { resolve } from "node:path";

/** A single target the walk surfaces — either a category slug or a dep name. */
export interface WalkTarget {
  /** Stable identifier the dispatch uses (category slug OR `dep:<name>`). */
  slug: string;
  /** Whether this comes from `docs/ai-leverage-categories.md` or `package.json`. */
  kind: "category" | "dependency";
  /** Free-text source label for diagnostics (file path or section). */
  source: string;
}

/**
 * Parse the orchestrator + dashboard `package.json` runtime deps. Excludes
 * `devDependencies` — those don't ship in the running process and aren't
 * load-bearing for AI-agent leverage. Pure async I/O; no Redis.
 */
export async function listRuntimeDependencies(
  hydraRoot: string,
): Promise<WalkTarget[]> {
  const out: WalkTarget[] = [];

  async function readDeps(path: string, sourceLabel: string): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(path, "utf-8");
    } catch (err) {
      // Best-effort — log + skip rather than throw. A missing manifest is a
      // diagnostic, not a fatal walk error.
      console.error(`calendar-walk: failed to read ${path}:`, err);
      return;
    }
    let parsed: { dependencies?: Record<string, unknown> };
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error(`calendar-walk: failed to parse ${path}:`, err);
      return;
    }
    const deps = parsed.dependencies ?? {};
    for (const name of Object.keys(deps).sort()) {
      out.push({
        slug: `dep:${name}`,
        kind: "dependency",
        source: sourceLabel,
      });
    }
  }

  await readDeps(resolve(hydraRoot, "package.json"), "package.json");
  await readDeps(
    resolve(hydraRoot, "dashboard", "package.json"),
    "dashboard/package.json",
  );
  return out;
}

/**
 * Parse `docs/ai-leverage-categories.md` and extract each H2 heading as a
 * category slug. Format: `## <N>. <slug>` (matches the Phase A doc).
 *
 * Pure parser — no Redis, no network. Tests pass a fixture instead of the
 * real file to pin behaviour without coupling to doc edits.
 */
export function parseCategorySlugs(markdown: string): WalkTarget[] {
  const out: WalkTarget[] = [];
  const seen = new Set<string>();
  // Match lines of the form `## 1. typed-schemas` or `## typed-schemas`
  // (the leading number-and-dot is optional so a future doc edit that drops
  // the numbering still works).
  const re = /^##\s+(?:\d+\.\s+)?([a-z0-9][a-z0-9-]*)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    const slug = m[1];
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push({
      slug,
      kind: "category",
      source: "docs/ai-leverage-categories.md",
    });
  }
  return out;
}

/**
 * Convenience: read + parse `docs/ai-leverage-categories.md` from disk.
 *
 * Promoted from private (was `listCategories` in calendar-walk.ts) so the FS
 * surface is independently testable (issue #2826, design-concept invariant 4).
 */
export async function listCategories(hydraRoot: string): Promise<WalkTarget[]> {
  const path = resolve(hydraRoot, "docs", "ai-leverage-categories.md");
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf-8");
  } catch (err) {
    console.error(`calendar-walk: failed to read ${path}:`, err);
    return [];
  }
  return parseCategorySlugs(raw);
}
