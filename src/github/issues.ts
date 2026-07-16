/**
 * github/issues.ts — the GitHub Issue/PR **Read** seam (issue #908).
 *
 * The **GitHub CLI Adapter** (`gh.ts`/`exec.ts`, issues #896/#897, closure
 * #899) owns the *raw process* boundary: it forbids `node:child_process`
 * outside `src/github/` and hands back the generic, untyped `ghJson<T>(args)`
 * primitive. But `ghJson` is a *shallow* interface — a caller still has to know
 * the entire `gh issue list` CLI surface (flags, search syntax, the `--json`
 * field names, the parsed JSON shape). So ~10 aggregators each re-decided
 * "how do I read a GitHub issue?":
 *
 *   - the repo handle was re-spelled (`deps.githubRepo ?? "gaberoo322/hydra"`)
 *     in 8+ files, and
 *   - the `--json` field lists were copy-pasted verbatim, each parsed into a
 *     bespoke local issue shape.
 *
 * This module is the *domain-read* seam that sits ABOVE the Adapter and BELOW
 * the aggregators. It owns, in exactly one place each:
 *
 *   1. **The repo handle** — {@link resolveGithubRepo} (env-overridable via
 *      `HYDRA_GITHUB_REPO`, default `gaberoo322/hydra`). Moving repos is now a
 *      one-env-var change, not a 10-file sweep.
 *   2. **The canonical issue field set + typed return shape** — {@link IssueRow},
 *      parsed once by {@link parseIssueRows}. (The PR-list shapes `PrRow` /
 *      `parsePrRows` were extracted to the focused `./prs.ts` Module, issue
 *      #3370, and are re-exported from here for back-compat.)
 *   3. **The label-filtered / search-windowed list queries** the aggregators
 *      actually need ({@link listIssuesByLabel}, {@link listIssuesBySearch},
 *      {@link listOpenIssues}, {@link viewPr}), reading through the Adapter's
 *      `ghJson`. (The PR-list query `listOpenPrs` lives in `./prs.ts` and is
 *      re-exported here.)
 *
 * Label *classification* does NOT live here: the provenance-label vocabulary
 * and classifier (`provenanceFromLabels`) belong to the Dispatch-Class
 * Taxonomy Module (`src/taxonomy/classes.ts`), which derives them from the
 * classes.json `provenanceLabel` column (#1672). This seam once carried a
 * hand-listed class-label classifier (`dev_orch`/`qa`/…), but the repo's
 * label inventory never contained those class names — every issue bucketed
 * `unclassified` — so that plane was deleted, not moved.
 *
 * # Never throws (CLAUDE.md)
 *
 * Like the `gh.ts` accessors it consumes, every reader here returns a typed
 * result and NEVER throws. The list readers return `IssueReadResult<T>` — a
 * discriminated `{ ok:true; rows }` | `{ ok:false; code }` carrying the seam's
 * `GhErrorCode`. Aggregators that want the legacy "degrade to `[]` under
 * `Promise.allSettled`" contract can call the `*OrEmpty` convenience wrappers,
 * which log the failure code and return `[]`.
 *
 * # What this is NOT
 *
 * - It does NOT own the raw spawn primitive (`exec.ts`, owned by #899) — it
 *   *consumes* `ghJson`, preserving the `child_process` seam.
 * - It does NOT own the metric-join composition (`src/metrics/*`, owned by
 *   #820), nor the Redis-backed friction read (`aggregators/friction-source.ts`,
 *   #864).
 * - It does NOT validate every field against a schema — the typed parse maps
 *   the canonical fields defensively and drops malformed rows, the same
 *   never-throw posture the aggregators already had.
 */

import { ghJson } from "./gh.ts";
import { isGhFailure, type GhErrorCode } from "./exec.ts";
import { viewPr as viewPrModule } from "./view-pr.ts";
import type { ViewPrTransport, ViewPrCache } from "./view-pr.ts";

// ---------------------------------------------------------------------------
// 1. The repo handle — one place, env-overridable
// ---------------------------------------------------------------------------

/** The default GitHub repo handle (`owner/name`) for the orchestrator's own issues. */
export const DEFAULT_GITHUB_REPO = "gaberoo322/hydra";

/**
 * Resolve the GitHub repo handle. Honors the `HYDRA_GITHUB_REPO` env override
 * (so a repo move is a single env change, not a 10-file sweep) and falls back
 * to {@link DEFAULT_GITHUB_REPO}. A caller-supplied `override` (the legacy
 * `deps.githubRepo` injection seam) wins over both so existing tests keep
 * pinning the repo explicitly. An empty-string override is treated as "skip"
 * and returned verbatim so the historical `if (!repo) return []` guard still
 * fires at the call site.
 */
export function resolveGithubRepo(override?: string): string {
  if (override !== undefined) return override;
  const env = process.env.HYDRA_GITHUB_REPO;
  if (typeof env === "string" && env.trim().length > 0) return env.trim();
  return DEFAULT_GITHUB_REPO;
}

// ---------------------------------------------------------------------------
// 2. The canonical field set + typed return shapes
// ---------------------------------------------------------------------------

/**
 * The canonical issue-read `--json` field set. One spelling, consumed by every
 * list query. Aggregators that need a subset still get these (over-fetching a
 * handful of small fields is cheaper than maintaining N divergent field lists).
 */
export const ISSUE_JSON_FIELDS = "number,title,url,createdAt,labels,body,state";

/**
 * One GitHub issue as the read seam returns it. A defensively-parsed superset
 * of the fields the aggregators consume; absent fields are normalized
 * (`title`/`url` synthesized from `number`, `labels` flattened to `string[]`).
 */
export interface IssueRow {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  labels: string[];
  body: string;
  /** Upper-cased issue state (`OPEN` / `CLOSED`), or `""` when not requested. */
  state: string;
  /**
   * ISO-8601 last-updated timestamp, populated only when the caller requested
   * `updatedAt` in its `--json` field override (it is NOT in the default
   * {@link ISSUE_JSON_FIELDS}); omitted otherwise. Optional so the existing
   * fixtures/aggregators that build {@link IssueRow}s without it stay valid.
   * Consumed by staleness reads such as the autopilot board-state projection
   * (issue #934).
   */
  updatedAt?: string;
}

/**
 * The discriminated result every list reader returns. Mirrors the Adapter's
 * `GhResult` posture: `ok:true` carries the parsed rows, `ok:false` carries the
 * seam's machine-readable `GhErrorCode`. Never thrown.
 */
export type IssueReadResult<T> =
  | { ok: true; rows: T[] }
  | { ok: false; code: GhErrorCode };

/**
 * Type guard narrowing an {@link IssueReadResult} to its failure arm. The
 * orchestrator's `tsconfig.json` runs `strict: false`, which disables
 * `strictNullChecks` — and without it, TypeScript will NOT discriminate a
 * union on a boolean `ok` field via plain `if (!res.ok)` (it only narrows
 * string-literal and user-guard discriminators). This mirrors the
 * `isGhFailure`/`isGhOk` guards the Adapter exposes for the same reason.
 */
export function isIssueReadFailure<T>(
  res: IssueReadResult<T>,
): res is { ok: false; code: GhErrorCode } {
  return res.ok === false;
}

// ---------------------------------------------------------------------------
// 2b. Pure parsers — exported for tests
// ---------------------------------------------------------------------------

function issueUrlFallback(repo: string, number: number): string {
  return `https://github.com/${repo}/issues/${number}`;
}

/**
 * Parse a `gh issue list --json` payload (already JSON-parsed by `ghJson`) into
 * {@link IssueRow}s. Rows without a positive integer `number` are dropped.
 * `labels` is flattened from `[{name}]` to `string[]`. Never throws.
 */
export function parseIssueRows(parsed: unknown, repo: string): IssueRow[] {
  if (!Array.isArray(parsed)) return [];
  const out: IssueRow[] = [];
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
      updatedAt?: unknown;
    };
    const number = typeof c.number === "number" ? c.number : NaN;
    if (!Number.isFinite(number) || number <= 0) continue;
    out.push({
      number,
      title: typeof c.title === "string" ? c.title : `Issue #${number}`,
      url: typeof c.url === "string" ? c.url : issueUrlFallback(repo, number),
      createdAt: typeof c.createdAt === "string" ? c.createdAt : "",
      labels: (c.labels ?? [])
        .map((l) => l?.name)
        .filter((n): n is string => typeof n === "string"),
      body: typeof c.body === "string" ? c.body : "",
      state: typeof c.state === "string" ? c.state.toUpperCase() : "",
      updatedAt: typeof c.updatedAt === "string" ? c.updatedAt : "",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. The list / view queries — read through the Adapter's ghJson
// ---------------------------------------------------------------------------

/** Per-query knobs the aggregators vary. All optional with behaviour-preserving defaults. */
export interface IssueQueryOptions {
  /** Repo handle override (legacy `deps.githubRepo` injection). See {@link resolveGithubRepo}. */
  repo?: string;
  /** `--state` value. Defaults to `open`. */
  state?: "open" | "closed" | "all";
  /** `--limit`. Defaults to 100. */
  limit?: number;
  /** Comma-separated `--json` field set. Defaults to {@link ISSUE_JSON_FIELDS}. */
  fields?: string;
  /** Per-call timeout (ms). Defaults to 10_000. */
  timeout?: number;
  /** Per-call stdout cap (bytes). Defaults to 4MB. */
  maxBuffer?: number;
}

/**
 * Default `--limit` for list queries. Exported so the extracted PR-list surface
 * (`./prs.ts`, issue #3370) shares the seam's one spelling.
 */
export const DEFAULT_LIMIT = 100;
/** Default per-call timeout (ms). Exported for `./prs.ts` — see {@link DEFAULT_LIMIT}. */
export const DEFAULT_TIMEOUT_MS = 10_000;
/** Default per-call stdout cap (bytes). Exported for `./prs.ts` — see {@link DEFAULT_LIMIT}. */
export const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

function issueListArgs(
  repo: string,
  extra: string[],
  opts: IssueQueryOptions,
): string[] {
  return [
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    opts.state ?? "open",
    ...extra,
    "--limit",
    String(opts.limit ?? DEFAULT_LIMIT),
    "--json",
    opts.fields ?? ISSUE_JSON_FIELDS,
  ];
}

function execOpts(opts: IssueQueryOptions) {
  return {
    timeout: opts.timeout ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
  };
}

/**
 * List issues carrying a given `--label`. Reads through the Adapter's `ghJson`
 * and parses the canonical field set. Never throws — returns the discriminated
 * {@link IssueReadResult}.
 */
export async function listIssuesByLabel(
  label: string,
  opts: IssueQueryOptions = {},
): Promise<IssueReadResult<IssueRow>> {
  const repo = resolveGithubRepo(opts.repo);
  if (!repo) return { ok: true, rows: [] };
  const res = await ghJson<unknown>(
    issueListArgs(repo, ["--label", label], opts),
    execOpts(opts),
  );
  if (isGhFailure(res)) return { ok: false, code: res.code };
  return { ok: true, rows: parseIssueRows(res.data, repo) };
}

/**
 * List issues matching a `--search` clause (e.g. `created:>=2026-06-01`,
 * `in:title "..."`), optionally also filtered by `--label`. Reads through the
 * Adapter's `ghJson`. Never throws.
 */
export async function listIssuesBySearch(
  search: string,
  opts: IssueQueryOptions & { label?: string } = {},
): Promise<IssueReadResult<IssueRow>> {
  const repo = resolveGithubRepo(opts.repo);
  if (!repo) return { ok: true, rows: [] };
  const extra = ["--search", search];
  if (opts.label) extra.unshift("--label", opts.label);
  const res = await ghJson<unknown>(issueListArgs(repo, extra, opts), execOpts(opts));
  if (isGhFailure(res)) return { ok: false, code: res.code };
  return { ok: true, rows: parseIssueRows(res.data, repo) };
}

/**
 * List issues with no `--label`/`--search` filter — the whole open board in one
 * fetch, bucketed client-side by the caller. This is the "single fetch, count
 * many labels in-process" shape the autopilot board-state projection needs
 * (issue #934): one `gh issue list` instead of N per-label calls. Reads through
 * the Adapter's `ghJson` and parses the canonical field set (override `fields`
 * to also capture `updatedAt` for staleness). Never throws.
 */
export async function listOpenIssues(
  opts: IssueQueryOptions = {},
): Promise<IssueReadResult<IssueRow>> {
  const repo = resolveGithubRepo(opts.repo);
  if (!repo) return { ok: true, rows: [] };
  const res = await ghJson<unknown>(issueListArgs(repo, [], opts), execOpts(opts));
  if (isGhFailure(res)) return { ok: false, code: res.code };
  return { ok: true, rows: parseIssueRows(res.data, repo) };
}

// ---------------------------------------------------------------------------
// 3a. The PR-list surface — re-exported from the focused prs Module (#3370)
// ---------------------------------------------------------------------------

/**
 * The PR-list read surface (`PrRow`, `parsePrRows`, `PR_LIST_JSON_FIELDS`,
 * `listOpenPrs`, `listOpenPrsOrEmpty`) lives in its own Module (`./prs.ts`,
 * issue #3370) — it serves the PR Lifecycle Bridge, the lifecycle snapshot, and
 * the stuck-items aggregator, and evolves on a distinct change axis (CI-rollup +
 * head-branch fields for OPEN PRs) from the issue-list surface. It is re-exported
 * here so the public read-seam surface (`from "../github/issues.ts"`) is
 * unchanged for the existing consumers and the test surface. `prs.ts` imports
 * {@link resolveGithubRepo} and the shared {@link IssueReadResult} /
 * {@link isIssueReadFailure} back from this module (a benign call-time ESM cycle
 * — see `./prs.ts` for the contract).
 */
export { PR_LIST_JSON_FIELDS, parsePrRows, listOpenPrs, listOpenPrsOrEmpty } from "./prs.ts";
export type { PrRow } from "./prs.ts";

// ---------------------------------------------------------------------------
// 3b. Per-PR view — re-exported from the focused view-pr Module (#2224)
// ---------------------------------------------------------------------------

/**
 * The per-PR view transport / cache / normalization cluster lives in its own
 * Module (`./view-pr.ts`, issue #2224) — it is an *implementation* concern
 * (REST↔GraphQL transport switching, REST-to-`--json` normalization, the
 * in-process cache) at a different abstraction level than the domain-read list
 * queries above. It is re-exported here so the public read-seam surface
 * (`from "../github/issues.ts"`) is unchanged for the 15 existing `viewPr`
 * consumers and the test surface.
 */
export {
  ViewPrCache,
  _clearViewPrCache,
  normalizePrViewFromRest,
} from "./view-pr.ts";
export type { ViewPrTransport } from "./view-pr.ts";

/**
 * View a single PR's fields. Thin re-export wrapper over {@link viewPrModule}
 * that injects this seam's {@link resolveGithubRepo} (avoiding an import cycle
 * back into `issues.ts`) so the public signature — `viewPr(prNumber, fields,
 * opts?)` — is unchanged for existing callers. See `./view-pr.ts` for the full
 * transport/cache/normalization contract. Returns the raw parsed object or
 * `null` on any failure. Never throws.
 */
export function viewPr<T = unknown>(
  prNumber: number,
  fields: string,
  opts: IssueQueryOptions & {
    transport?: ViewPrTransport;
    cacheTtlMs?: number;
    cache?: ViewPrCache;
  } = {},
): Promise<T | null> {
  return viewPrModule<T>(prNumber, fields, { ...opts, resolveRepo: resolveGithubRepo });
}

// ---------------------------------------------------------------------------
// 3b. Convenience wrappers — preserve the legacy "degrade to [] + log" contract
// ---------------------------------------------------------------------------

/**
 * Like {@link listIssuesByLabel} but folds the failure arm into `[]` after
 * logging the code — the contract the `Promise.allSettled` aggregators expect.
 * `label`-prefixed log so a failure is attributable.
 */
export async function listIssuesByLabelOrEmpty(
  ghLabel: string,
  logPrefix: string,
  opts: IssueQueryOptions = {},
): Promise<IssueRow[]> {
  const res = await listIssuesByLabel(ghLabel, opts);
  if (isIssueReadFailure(res)) {
    console.error(`[${logPrefix}] gh issue list --label ${ghLabel} failed (${res.code})`);
    return [];
  }
  return res.rows;
}

/** Like {@link listIssuesBySearch} but degrades to `[]` after logging. */
export async function listIssuesBySearchOrEmpty(
  search: string,
  logPrefix: string,
  opts: IssueQueryOptions & { label?: string } = {},
): Promise<IssueRow[]> {
  const res = await listIssuesBySearch(search, opts);
  if (isIssueReadFailure(res)) {
    console.error(`[${logPrefix}] gh issue list --search "${search}" failed (${res.code})`);
    return [];
  }
  return res.rows;
}
