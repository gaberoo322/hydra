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
 *   2. **The canonical field set + typed return shapes** — {@link IssueRow} /
 *      {@link PrRow}, parsed once by {@link parseIssueRows} / {@link parsePrRows}.
 *   3. **The label-filtered / search-windowed list queries** the aggregators
 *      actually need ({@link listIssuesByLabel}, {@link listIssuesBySearch},
 *      {@link listOpenPrs}, {@link viewPr}), reading through the Adapter's
 *      `ghJson`.
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
 * The canonical open-PR list `--json` field set. Covers BOTH consumer shapes:
 *   - the CI-rollup view (`updatedAt`, `statusCheckRollup`) the merge-queue
 *     readers need, and
 *   - the lifecycle view (`state`, `headRefName`, `createdAt`) the PR Lifecycle
 *     Bridge (`src/autopilot/pr-lifecycle-bridge.ts`, issue #673) needs to diff
 *     OPEN→MERGED/CLOSED transitions and attribute an event to a head branch.
 * Over-fetching a handful of small fields is cheaper than maintaining two
 * divergent field lists — the same posture {@link ISSUE_JSON_FIELDS} takes.
 */
const PR_LIST_JSON_FIELDS =
  "number,state,title,url,headRefName,createdAt,updatedAt,statusCheckRollup";

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

/** One open PR as the read seam returns it, including its CI status rollup. */
export interface PrRow {
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  /**
   * Upper-cased PR state (`OPEN` / `MERGED` / `CLOSED`), populated when the
   * caller requested `state` in its `--json` field set. Defaults to `OPEN` when
   * the field is present-but-unrecognized, and `""` when not requested at all.
   * Consumed by the PR Lifecycle Bridge (issue #673) to diff state transitions.
   */
  state: string;
  /**
   * Head-branch name, populated only when the caller requested `headRefName`.
   * The lifecycle bridge extracts the dispatch task_id from it; `""` otherwise.
   */
  headRefName: string;
  /**
   * ISO-8601 created timestamp, populated only when the caller requested
   * `createdAt`; `""` otherwise.
   */
  createdAt: string;
  /** Raw status-check rollup entries; the caller decides which conclusions count as failing. */
  statusCheckRollup: Array<{
    conclusion?: string;
    name?: string;
    context?: string;
  }>;
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

/**
 * Parse a `gh pr list --json` payload into {@link PrRow}s. Rows without a
 * positive integer `number` are dropped; `statusCheckRollup` is normalized to
 * an array of `{conclusion,name,context}`. Never throws.
 */
export function parsePrRows(parsed: unknown, repo: string): PrRow[] {
  if (!Array.isArray(parsed)) return [];
  const out: PrRow[] = [];
  for (const candidate of parsed) {
    if (!candidate || typeof candidate !== "object") continue;
    const c = candidate as {
      number?: unknown;
      state?: unknown;
      title?: unknown;
      url?: unknown;
      headRefName?: unknown;
      createdAt?: unknown;
      updatedAt?: unknown;
      statusCheckRollup?: unknown;
    };
    const number = typeof c.number === "number" ? c.number : NaN;
    if (!Number.isFinite(number) || number <= 0) continue;
    const rollupRaw = Array.isArray(c.statusCheckRollup) ? c.statusCheckRollup : [];
    const statusCheckRollup = rollupRaw
      .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
      .map((r) => ({
        conclusion: typeof r.conclusion === "string" ? r.conclusion : undefined,
        name: typeof r.name === "string" ? r.name : undefined,
        context: typeof r.context === "string" ? r.context : undefined,
      }));
    out.push({
      number,
      // State requested → upper-cased; absent → "" (the lifecycle bridge maps
      // an unrecognized-but-present value to OPEN at its own layer).
      state: typeof c.state === "string" ? c.state.toUpperCase() : "",
      title: typeof c.title === "string" ? c.title : `PR #${number}`,
      url:
        typeof c.url === "string"
          ? c.url
          : `https://github.com/${repo}/pull/${number}`,
      headRefName: typeof c.headRefName === "string" ? c.headRefName : "",
      createdAt: typeof c.createdAt === "string" ? c.createdAt : "",
      updatedAt: typeof c.updatedAt === "string" ? c.updatedAt : "",
      statusCheckRollup,
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

const DEFAULT_LIMIT = 100;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

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

/**
 * List open PRs with their CI status rollup. Never throws — returns the
 * discriminated {@link IssueReadResult} of {@link PrRow}.
 */
export async function listOpenPrs(
  opts: IssueQueryOptions = {},
): Promise<IssueReadResult<PrRow>> {
  const repo = resolveGithubRepo(opts.repo);
  if (!repo) return { ok: true, rows: [] };
  const args = [
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    opts.state ?? "open",
    "--limit",
    String(opts.limit ?? DEFAULT_LIMIT),
    "--json",
    opts.fields ?? PR_LIST_JSON_FIELDS,
  ];
  const res = await ghJson<unknown>(args, execOpts(opts));
  if (isGhFailure(res)) return { ok: false, code: res.code };
  return { ok: true, rows: parsePrRows(res.data, repo) };
}

// ---------------------------------------------------------------------------
// 3a. Per-PR view — re-exported from the focused view-pr Module (#2224)
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

/** Like {@link listOpenPrs} but degrades to `[]` after logging. */
export async function listOpenPrsOrEmpty(
  logPrefix: string,
  opts: IssueQueryOptions = {},
): Promise<PrRow[]> {
  const res = await listOpenPrs(opts);
  if (isIssueReadFailure(res)) {
    console.error(`[${logPrefix}] gh pr list failed (${res.code})`);
    return [];
  }
  return res.rows;
}
