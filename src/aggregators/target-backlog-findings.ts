/**
 * Target-backlog-findings aggregator (issue #617, PRD #615).
 *
 * Returns issues labeled `target-backlog` that were opened inside the
 * window AND haven't been routed by sweep yet. "Not routed" = NOT closed
 * AND NOT labeled `in-progress`. These are findings the dashboard wants
 * to surface so the operator can see net-new diagnostics from the
 * `hydra-target-discover` skill that still need triage.
 *
 * # Design contract
 *
 * - **Pure filter core.** `filterUnroutedFindings` is exported separately
 *   so tests can pin the filter behavior without subprocess setup.
 * - **Never throws.** Sub-fetch failure degrades to `[]`.
 * - **Window-based.** Caller passes `windowHours` (1..168). 24h is the
 *   sensible default for an overnight runtime-diagnostics sweep.
 */

import { execFileViaSeam } from "../github/exec-file-compat.ts";

// The production default routes `gh`/`git` through the GitHub CLI Adapter seam
// (issue #899). Tests still inject `deps.execFileAsync` directly — this only
// changes the default, not the injection seam.
const execFile = execFileViaSeam;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface Finding {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  labels: string[];
  /** Excerpt of the body — first paragraph or first 240 chars, whichever shorter. */
  excerpt: string;
}

export interface TargetFindingsDeps {
  now?: Date;
  githubRepo?: string;
  execFileAsync?: (
    cmd: string,
    args: readonly string[],
    opts?: { cwd?: string; timeout?: number; maxBuffer?: number },
  ) => Promise<{ stdout: string; stderr: string }>;
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export async function getNewTargetFindings(
  windowHours: number,
  deps: TargetFindingsDeps = {},
): Promise<Finding[]> {
  const now = deps.now ?? new Date();
  const windowStart = new Date(now.getTime() - windowHours * 60 * 60 * 1000);
  const exec = deps.execFileAsync ?? execFile;
  const repo = deps.githubRepo ?? "gaberoo322/hydra";
  if (!repo) return [];

  try {
    const sinceDate = windowStart.toISOString().split("T")[0];
    const { stdout } = await exec(
      "gh",
      [
        "issue",
        "list",
        "--repo",
        repo,
        "--state",
        "all",
        "--label",
        "target-backlog",
        "--search",
        `created:>=${sinceDate}`,
        "--limit",
        "100",
        "--json",
        "number,title,url,createdAt,labels,body,state",
      ],
      { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
    );
    return filterUnroutedFindings(stdout, windowStart);
  } catch (err: any) {
    console.error(`[target-backlog-findings] gh issue list failed: ${err?.message || err}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Pure filter — exported for tests
// ---------------------------------------------------------------------------

/**
 * Pure helper — exported for tests. Filters a `gh issue list --json`
 * payload to the un-routed subset:
 *
 *   - `state` is OPEN
 *   - no `in-progress` label
 *   - `createdAt` strictly within the window
 *
 * Sorted newest-first so the dashboard shows the freshest diagnostics
 * at the top of the section.
 */
export function filterUnroutedFindings(
  jsonStdout: string,
  windowStart: Date,
): Finding[] {
  if (!jsonStdout.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const startMs = windowStart.getTime();
  const out: Finding[] = [];
  for (const candidate of parsed) {
    if (!candidate || typeof candidate !== "object") continue;
    const c = candidate as {
      number?: unknown;
      title?: unknown;
      url?: unknown;
      createdAt?: unknown;
      labels?: Array<{ name?: unknown }>;
      body?: unknown;
      state?: unknown;
    };
    const number = typeof c.number === "number" ? c.number : NaN;
    if (!Number.isFinite(number) || number <= 0) continue;
    const createdAt = typeof c.createdAt === "string" ? c.createdAt : "";
    const createdMs = Date.parse(createdAt);
    if (!Number.isFinite(createdMs) || createdMs < startMs) continue;
    const state = typeof c.state === "string" ? c.state.toUpperCase() : "";
    if (state !== "OPEN") continue;
    const labels = (c.labels ?? [])
      .map((l) => l?.name)
      .filter((n): n is string => typeof n === "string");
    if (labels.includes("in-progress")) continue;
    out.push({
      number,
      title: typeof c.title === "string" ? c.title : `Issue #${number}`,
      url: typeof c.url === "string" ? c.url : `https://github.com/gaberoo322/hydra/issues/${number}`,
      createdAt,
      labels,
      excerpt: excerptOf(typeof c.body === "string" ? c.body : ""),
    });
  }
  out.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return out;
}

/**
 * Pure helper — exported for tests. Returns the first non-empty paragraph
 * of a markdown body, trimmed and clamped to 240 chars. Front-matter and
 * blockquote prefixes are kept as-is so the operator sees the original
 * voice of the finding.
 */
export function excerptOf(body: string): string {
  if (!body) return "";
  const paragraphs = body.split(/\n{2,}/);
  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    if (trimmed.length <= 240) return trimmed;
    return trimmed.slice(0, 237) + "...";
  }
  return "";
}
