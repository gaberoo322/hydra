/**
 * Tool-scout walk-surface enumeration (extracted from calendar-walk.ts,
 * issue #2826).
 *
 * This module is a **pure FS-I/O leaf**: it owns just the discovery of the
 * targets the scout calendar walk operates over — the
 * `docs/ai-leverage-categories.md` category slugs. It imports nothing from
 * `src/redis/*` and holds no cooldown/eligibility logic; that coordination
 * stays in the sibling `calendar-walk.ts` planner.
 *
 * The split follows two distinct change axes (issue #2826):
 *
 *   - **Walk-surface enumeration** (this module) grows when the categories
 *     document format changes (or a new surface source is added). Its failure
 *     modes are FS read errors and markdown parse errors — recoverable
 *     per-source with `console.error` + an empty-array fallback.
 *   - **Eligibility/cooldown routing** (`calendar-walk.ts`) grows when cooldown
 *     tiers change. Its failure modes are Redis errors.
 *
 * Keeping the FS surface here — co-located with `parseCategorySlugs` — lets a
 * test exercise `planWalk`'s eligibility routing by injecting a fixed target
 * list, without stubbing the entire FS surface.
 *
 * Dependency targets (`dep:<name>` from `package.json`) were REMOVED from the
 * walk surface in issue #4556: the `hydra-tool-scout` playbook has no
 * procedure for scouting a dependency (its validate → discover → rubric →
 * file process is category-shaped), so `dep:*` targets sat in the eligible
 * set indefinitely. Dependency freshness and CVEs are already covered by
 * `npm run deps:check` (taze) and the OSV scan. If a dependency-walk
 * procedure is ever defined, re-introduce a dep-surface enumerator here.
 */

import { promises as fs } from "node:fs";
import { resolve } from "node:path";

/** A single target the walk surfaces — a category slug. */
export interface WalkTarget {
  /** Stable identifier the dispatch uses (category slug). */
  slug: string;
  /** Always "category" — `dep:<name>` targets were removed (issue #4556). */
  kind: "category";
  /** Free-text source label for diagnostics (file path or section). */
  source: string;
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
