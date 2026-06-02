/**
 * Friction-Pattern Read seam (issue #820).
 *
 * The `hydra:friction:{skill}:patterns` SCAN-and-parse loop was byte-identical
 * in three aggregators — `lessons-trend.ts`, `lessons-overnight.ts`, and
 * `friction-patterns.ts`. Each hand-rolled the same SCAN cursor walk, the same
 * `hydra:friction:` key-to-skill strip, and the same per-key JSON parse with
 * error isolation. Adding a new friction-key shape or fixing the parse meant
 * three identical edits.
 *
 * This module owns that read ONLY: SCAN + parse + per-key error isolation. It
 * deliberately does NOT own pattern validation, windowing, or promotion logic —
 * those stay in each consumer (their `liftFrictionPatterns` / `collectPromoted`
 * / `filterNearPromotion` steps narrow the permissive raw shape into their own
 * typed pattern). The `hydra:friction:*` store is owned by **Pattern Memory**
 * (`src/pattern-memory/`); this reader lives in the aggregator layer (sibling of
 * `types.ts`) so a friction reader does not mis-attribute ownership to
 * `src/metrics/`.
 *
 * Deletion test: remove this file and the identical SCAN-and-parse loop
 * re-concentrates in three aggregators — so the seam earns its place.
 *
 * **Redis seam.** The connection is pulled through `redis/connection.ts` only,
 * so `scripts/ci/redis-seam-check.ts` stays green (no `new Redis()`, no import
 * of `redis/keys` | `redis/kv`).
 *
 * ---
 *
 * Meta-friction GitHub Read seam (issue #864).
 *
 * The `gh issue list --label meta-friction` query + JSON parse + createdAt
 * re-filter was byte-identical across the same three aggregators that owned the
 * Redis duplication. Each hand-rolled the same `gh issue list` argv, the same
 * `JSON.parse` with error isolation, the same exact-timestamp re-filter (the
 * `created:>=YYYY-MM-DD` search is day-coarse, so sub-day windows over-count
 * without it), and the same newest-`createdAt`-first sort.
 *
 * `readMetaFrictionIssues` owns that read ONLY: shell out to `gh`, parse,
 * re-filter, sort. Like the sibling `readFrictionPatterns` it never throws — a
 * gh/auth outage or malformed JSON is `console.error`-logged with the caller's
 * `label` and degrades to `[]` (so the count consumer reads `.length === 0`).
 * It touches no Redis adapter, so `scripts/ci/redis-seam-check.ts` stays green.
 */

import { promisify } from "node:util";
import { execFile as execFileSync } from "node:child_process";

const execFile = promisify(execFileSync);

/**
 * One `meta-friction` GitHub issue, as the dashboard aggregators render it.
 * The exported field shape `{number, title, url, createdAt}` is mirrored
 * structurally (no type-import) by the zod `MetaFrictionIssueRefSchema` in
 * `src/schemas/explore-page.ts` and `MetaFrictionIssueSchema` in
 * `src/schemas/today-page.ts`; keep the four fields in lock-step with those.
 */
export interface MetaFrictionIssue {
  number: number;
  title: string;
  url: string;
  createdAt: string;
}

/**
 * Minimal exec/repo overrides the meta-friction reader needs. Each consumer's
 * own deps interface is a structural superset of this, so callers pass their
 * `deps` object straight through.
 */
export interface MetaFrictionReadDeps {
  githubRepo?: string;
  execFileAsync?: (
    cmd: string,
    args: readonly string[],
    opts?: { cwd?: string; timeout?: number; maxBuffer?: number },
  ) => Promise<{ stdout: string; stderr: string }>;
}

/**
 * Shell out to `gh issue list --label meta-friction --search created:>=DATE`,
 * parse the JSON, re-filter on exact `createdAt` against `windowStart` (the gh
 * search is day-coarse), and return one `MetaFrictionIssue` per surviving row,
 * newest-`createdAt`-first.
 *
 * Never throws: a `gh` failure, empty output, malformed JSON, or non-array
 * payload is `console.error`-logged with `[label]` and degrades to `[]`. List
 * consumers read the array; the count consumer reads `.length`.
 *
 * `--limit 200` is the behaviour-preserving union of the three pre-#864 values
 * (overnight=100, friction-patterns=100, lessons-trend=200): list consumers
 * re-filter+sort a superset (no regression from a larger limit) while the count
 * consumer needs completeness over a long window.
 *
 * @param label log prefix identifying the calling aggregator (e.g.
 *   `"lessons-trend"`), so a parse/fetch failure is attributable in the logs.
 */
export async function readMetaFrictionIssues(
  label: string,
  windowStart: Date,
  deps: MetaFrictionReadDeps = {},
): Promise<MetaFrictionIssue[]> {
  const exec = deps.execFileAsync ?? execFile;
  const repo = deps.githubRepo ?? "gaberoo322/hydra";
  if (!repo) return [];
  const sinceDate = windowStart.toISOString().split("T")[0];
  let stdout = "";
  try {
    ({ stdout } = await exec(
      "gh",
      [
        "issue",
        "list",
        "--repo",
        repo,
        "--state",
        "all",
        "--label",
        "meta-friction",
        "--search",
        `created:>=${sinceDate}`,
        "--limit",
        "200",
        "--json",
        "number,title,url,createdAt",
      ],
      { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
    ));
  } catch (err: any) {
    console.error(
      `[${label}] meta-friction gh fetch failed: ${err?.message || err}`,
    );
    return [];
  }
  return parseMetaFrictionIssues(label, stdout, windowStart);
}

/**
 * Parse `gh issue list --json number,title,url,createdAt` output for the
 * meta-friction query. Re-filters by exact `createdAt` so sub-day windows don't
 * over-count from the search's coarser date-prefix resolution, and sorts
 * newest-first. A malformed/non-array payload is `console.error`-logged with
 * `[label]` and yields `[]` (never throws). Not exported — the seam owns parse;
 * tests exercise it through `readMetaFrictionIssues` with an exec stub.
 */
function parseMetaFrictionIssues(
  label: string,
  jsonStdout: string,
  windowStart: Date,
): MetaFrictionIssue[] {
  if (!jsonStdout.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStdout);
  } catch (err: any) {
    console.error(
      `[${label}] failed to parse meta-friction gh output: ${err?.message || err}`,
    );
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const startMs = windowStart.getTime();
  const out: MetaFrictionIssue[] = [];
  for (const candidate of parsed) {
    if (!candidate || typeof candidate !== "object") continue;
    const c = candidate as {
      number?: unknown;
      title?: unknown;
      url?: unknown;
      createdAt?: unknown;
    };
    const number = typeof c.number === "number" ? c.number : NaN;
    if (!Number.isFinite(number) || number <= 0) continue;
    const createdAt = typeof c.createdAt === "string" ? c.createdAt : "";
    const createdMs = Date.parse(createdAt);
    if (!Number.isFinite(createdMs) || createdMs < startMs) continue;
    out.push({
      number,
      title: typeof c.title === "string" ? c.title : `Issue #${number}`,
      url:
        typeof c.url === "string"
          ? c.url
          : `https://github.com/gaberoo322/hydra/issues/${number}`,
      createdAt,
    });
  }
  out.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return out;
}

/**
 * One `{skill, patterns}` tuple as read off Redis. `patterns` is whatever the
 * stored JSON array contained — the reader does not narrow it. Each consumer
 * supplies its own element type `P` and runs its existing lift/validate step.
 */
export interface FrictionGroup<P> {
  skill: string;
  patterns: P[];
}

/**
 * Scan every `hydra:friction:{skill}:patterns` key, parse each value as a JSON
 * array, and return one `{skill, patterns}` tuple per key. A value that is
 * missing, malformed, or not an array is skipped (logged via `console.error`
 * with `label`), never thrown — preserving each aggregator's "never throws"
 * parse-isolation contract.
 *
 * The element type `P` is the caller's responsibility: the reader casts the
 * parsed array to `P[]` without validating its members, so the caller's
 * lift/validate step remains the single place that narrows the shape.
 *
 * @param label log prefix identifying the calling aggregator (e.g.
 *   `"lessons-trend"`), so a parse failure is attributable in the logs.
 */
export async function readFrictionPatterns<P>(
  label: string,
): Promise<Array<FrictionGroup<P>>> {
  const { getRedisConnection } = await import("../redis/connection.ts");
  const r = getRedisConnection();
  const matches: string[] = [];
  let cursor = "0";
  do {
    const [next, page] = await r.scan(
      cursor,
      "MATCH",
      "hydra:friction:*:patterns",
      "COUNT",
      "200",
    );
    cursor = next;
    matches.push(...page);
  } while (cursor !== "0");

  const out: Array<FrictionGroup<P>> = [];
  for (const key of matches) {
    const skill = key.replace(/^hydra:friction:/, "").replace(/:patterns$/, "");
    const raw = await r.get(key);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) out.push({ skill, patterns: parsed as P[] });
    } catch (err: any) {
      console.error(`[${label}] failed to parse ${key}: ${err?.message || err}`);
    }
  }
  return out;
}
