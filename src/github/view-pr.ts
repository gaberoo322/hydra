/**
 * github/view-pr.ts — the per-PR **view** transport / cache / normalization
 * Module, extracted out of the GitHub Issue/PR Read seam (`issues.ts`,
 * issue #908) by architecture-scan issue #2224.
 *
 * `issues.ts` is the *domain-read* seam: repo-handle resolution, the canonical
 * `--json` field set + typed list rows, and the label-filtered/search-windowed
 * list queries. The single-PR view, by contrast, is an *implementation* concern
 * at a different abstraction level — "what REST response shape does GitHub
 * return for a `/pulls/<n>` resource, and how do I normalize it back to the
 * `gh pr view --json` field names?" Co-locating it here means the
 * transport-switching policy (REST vs GraphQL pool pressure, issue #968), the
 * cache-entry shape + TTL, and the REST-to-GraphQL normalization adapter all
 * change together, in exactly one ~270-line home, leaving the list queries in
 * `issues.ts` untouched.
 *
 * # Cache encapsulation (mirrors `OvSearchMetricsCounter`, #1926)
 *
 * The in-process per-PR cache was a module-level mutable `Map` with a global
 * `_clearViewPrCache()` test-scrub. It is now the injectable {@link ViewPrCache}
 * class: production uses the {@link defaultViewPrCache} singleton (so the public
 * {@link viewPr} contract — short-TTL in-process caching keyed by
 * repo+number+fields — is preserved 1:1), while a test constructs a private
 * `ViewPrCache` per case instead of scrubbing a singleton. The legacy
 * {@link _clearViewPrCache} hook is retained for the existing global-surface
 * tests and clears the default singleton.
 *
 * # Never throws (CLAUDE.md)
 *
 * Like the `issues.ts`/`gh.ts` readers it consumes, {@link viewPr} returns the
 * raw parsed object or `null` on any failure — it NEVER throws.
 *
 * # Public surface unchanged
 *
 * `viewPr`, `ViewPrTransport`, `normalizePrViewFromRest`, and `_clearViewPrCache`
 * are still importable from `../github/issues.ts` (which re-exports them from
 * here), so the 15 existing `viewPr` consumers and the test surface are
 * unchanged by the move.
 */

import { ghJson } from "./gh.ts";
import { isGhFailure } from "./exec.ts";
import type { IssueQueryOptions } from "./issues.ts";

/**
 * Transport for the single-PR read ({@link viewPr}):
 *   - `"rest"`    — `gh api repos/<repo>/pulls/<n>` (+ `/reviews`, `/commits`
 *     sub-calls only when those fields are requested). Draws on the GitHub
 *     **REST** rate-limit pool (`core`, 5,000/hr), which under autopilot sits
 *     ~99% idle. This is the default, and the fix for issue #968.
 *   - `"graphql"` — the legacy `gh pr view <n> --json` path, which rides the
 *     **GraphQL** pool the running autopilot exhausts. Kept as an opt-out for
 *     callers that need a field REST doesn't expose.
 *
 * The seam exposes the choice (rather than re-deciding per call site) so the
 * per-PR read stays in exactly one home while each consumer picks the cheapest
 * correct path (CONTEXT.md "GitHub Issue/PR Read").
 */
export type ViewPrTransport = "rest" | "graphql";

/** Default TTL for the in-process per-PR cache. Merged-PR metadata is immutable. */
const VIEW_PR_CACHE_TTL_MS = 5 * 60 * 1000;

interface ViewPrCacheEntry {
  expiresAt: number;
  value: unknown;
}

/** Injectable deps for {@link ViewPrCache}. */
export interface ViewPrCacheDeps {
  /** Wall-clock source for TTL checks. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Short-TTL in-process cache for {@link viewPr}, keyed by `repo|number|fields`
 * so two consumers requesting different field sets don't collide. Merged-PR
 * metadata is immutable, so a stale entry self-heals on TTL expiry and an
 * open-PR read (which a fresh fetch may still mutate) is bounded by the TTL.
 * Only successful (`!= null`) reads are cached — a transient failure must not
 * pin a `null` for the whole TTL.
 *
 * The entry map is a private instance field — there is no shared global, so a
 * test constructs a fresh instance per case instead of scrubbing a singleton
 * (mirrors `OvSearchMetricsCounter`, #1926). Production uses the
 * {@link defaultViewPrCache} singleton; behavior is preserved 1:1.
 */
export class ViewPrCache {
  private readonly entries = new Map<string, ViewPrCacheEntry>();
  private readonly now: () => number;

  constructor(deps: ViewPrCacheDeps = {}) {
    this.now = deps.now ?? Date.now;
  }

  static key(repo: string, prNumber: number, fields: string): string {
    return `${repo}|${prNumber}|${fields}`;
  }

  /**
   * Return a live (non-expired) cached value for `key`, or `undefined` on a
   * miss / expiry. A `ttl <= 0` disables the read (always a miss).
   */
  get(key: string, ttl: number): unknown | undefined {
    if (ttl <= 0) return undefined;
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > this.now()) return hit.value;
    return undefined;
  }

  /**
   * Cache a successful (`!= null`) value under `key` for `ttl` ms. A `ttl <= 0`
   * or a `null` value is a no-op (a transient failure must not pin a `null`).
   */
  set(key: string, value: unknown, ttl: number): void {
    if (ttl <= 0 || value === null) return;
    this.entries.set(key, { expiresAt: this.now() + ttl, value });
  }

  /** Drop all cached per-PR views. */
  clear(): void {
    this.entries.clear();
  }
}

/** Production singleton — the in-process cache shared by all {@link viewPr} callers. */
export const defaultViewPrCache = new ViewPrCache();

/** Test/maintenance hook: drop all cached per-PR views from the default singleton. */
export function _clearViewPrCache(): void {
  defaultViewPrCache.clear();
}

/**
 * Map a `gh pr view --json` camelCase field name onto the GitHub REST
 * `/pulls/<n>` JSON key (snake_case), or `null` when the field is NOT inline on
 * the `/pulls/<n>` resource and needs a sub-call (`reviews`, `commits`).
 */
const REST_INLINE_FIELD_MAP: Record<string, string> = {
  number: "number",
  title: "title",
  url: "html_url",
  mergedAt: "merged_at",
  state: "state",
  body: "body",
};

function normalizeRestActor(
  actor: unknown,
): { login?: string; is_bot?: boolean } | null {
  if (!actor || typeof actor !== "object") return null;
  const a = actor as { login?: unknown; type?: unknown };
  const login = typeof a.login === "string" ? a.login : undefined;
  // REST marks bot accounts with `type: "Bot"`; classifyAutonomy also keys off
  // the `[bot]` login suffix, so a missing `type` still classifies correctly.
  const is_bot = a.type === "Bot" ? true : undefined;
  const out: { login?: string; is_bot?: boolean } = {};
  if (login !== undefined) out.login = login;
  if (is_bot !== undefined) out.is_bot = is_bot;
  return out;
}

/**
 * Normalize a REST `/pulls/<n>` object (+ optional reviews/commits sub-results)
 * into the `gh pr view --json <fields>`-shaped object the consumers expect.
 * Only the requested `fields` are populated, mirroring `--json`'s projection.
 * Exported for tests.
 */
export function normalizePrViewFromRest(
  pull: Record<string, unknown>,
  fields: string,
  subResults: { reviews?: unknown; commits?: unknown } = {},
): Record<string, unknown> {
  const requested = fields
    .split(",")
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
  const out: Record<string, unknown> = {};
  for (const field of requested) {
    if (field === "labels") {
      const raw = Array.isArray(pull.labels) ? pull.labels : [];
      out.labels = raw
        .map((l) =>
          l && typeof l === "object" && typeof (l as { name?: unknown }).name === "string"
            ? { name: (l as { name: string }).name }
            : null,
        )
        .filter((l): l is { name: string } => l !== null);
      continue;
    }
    if (field === "mergedBy") {
      out.mergedBy = normalizeRestActor(pull.merged_by);
      continue;
    }
    if (field === "reviews") {
      const raw = Array.isArray(subResults.reviews) ? subResults.reviews : [];
      out.reviews = raw.map((r) => ({
        author: normalizeRestActor((r as { user?: unknown })?.user),
      }));
      continue;
    }
    if (field === "commits") {
      const raw = Array.isArray(subResults.commits) ? subResults.commits : [];
      out.commits = raw.map((c) => {
        const obj = (c ?? {}) as { author?: unknown };
        return { author: normalizeRestActor(obj.author) };
      });
      continue;
    }
    const restKey = REST_INLINE_FIELD_MAP[field];
    if (restKey !== undefined && restKey in pull) {
      out[field] = pull[restKey];
    }
  }
  return out;
}

/** Does this `--json` field set require a REST sub-call beyond `/pulls/<n>`? */
function restSubCallsFor(fields: string): { reviews: boolean; commits: boolean } {
  const set = new Set(fields.split(",").map((f) => f.trim()));
  return { reviews: set.has("reviews"), commits: set.has("commits") };
}

/**
 * Per-call exec knobs read off the {@link IssueQueryOptions} the seam shares.
 * Mirrors `issues.ts::execOpts` (the defaults are intentionally identical).
 */
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

function execOpts(opts: IssueQueryOptions) {
  return {
    timeout: opts.timeout ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
  };
}

async function viewPrViaRest<T>(
  repo: string,
  prNumber: number,
  fields: string,
  opts: IssueQueryOptions,
): Promise<T | null> {
  const eo = execOpts(opts);
  const pullRes = await ghJson<Record<string, unknown>>(
    ["api", `repos/${repo}/pulls/${prNumber}`],
    eo,
  );
  if (isGhFailure(pullRes)) return null;

  const need = restSubCallsFor(fields);
  const sub: { reviews?: unknown; commits?: unknown } = {};
  if (need.reviews) {
    const r = await ghJson<unknown>(
      ["api", `repos/${repo}/pulls/${prNumber}/reviews`, "--paginate"],
      eo,
    );
    // A sub-call failure degrades that field to empty rather than nulling the
    // whole view — the same partial-degrade posture the consumers already have.
    sub.reviews = isGhFailure(r) ? [] : r.data;
  }
  if (need.commits) {
    const c = await ghJson<unknown>(
      ["api", `repos/${repo}/pulls/${prNumber}/commits`, "--paginate"],
      eo,
    );
    sub.commits = isGhFailure(c) ? [] : c.data;
  }
  return normalizePrViewFromRest(pullRes.data, fields, sub) as T;
}

async function viewPrViaGraphql<T>(
  repo: string,
  prNumber: number,
  fields: string,
  opts: IssueQueryOptions,
): Promise<T | null> {
  const res = await ghJson<T>(
    ["pr", "view", String(prNumber), "--repo", repo, "--json", fields],
    execOpts(opts),
  );
  if (isGhFailure(res)) return null;
  return res.data;
}

/**
 * View a single PR's fields. Returns the raw parsed object (typed `T` is the
 * caller's responsibility, as with `ghJson`) or `null` on any failure — the
 * historical `gh pr view` consumers (recent-merges, builder-health) treat a
 * failed view as "no labels known" rather than aborting. Never throws.
 *
 * Transport (issue #968): defaults to the **REST** pool (`gh api`), which the
 * autopilot leaves ~99% idle, instead of the GraphQL pool `gh pr view --json`
 * drains to zero. REST returns a snake_case shape; this seam normalizes it back
 * into the `--json`-shaped object its consumers already map, so the
 * consumer-facing contract is unchanged. `reviews`/`commits` (not inline on the
 * REST `/pulls/<n>` resource) are fetched via REST sub-calls only when those
 * fields are requested. Pass `transport: "graphql"` to opt back into the legacy
 * path. Results are cached in-process under a short TTL keyed by repo+number+fields.
 *
 * The repo is resolved by the caller-supplied `resolveRepo` (the read seam's
 * `resolveGithubRepo`, injected to avoid an import cycle); an empty resolved
 * repo short-circuits to `null` (the historical `if (!repo) return null` guard).
 * The cache defaults to the {@link defaultViewPrCache} singleton; tests inject a
 * private {@link ViewPrCache} instead of scrubbing the global.
 */
export async function viewPr<T = unknown>(
  prNumber: number,
  fields: string,
  opts: IssueQueryOptions & {
    transport?: ViewPrTransport;
    cacheTtlMs?: number;
    resolveRepo: (override?: string) => string;
    cache?: ViewPrCache;
  },
): Promise<T | null> {
  const repo = opts.resolveRepo(opts.repo);
  if (!repo) return null;

  const cache = opts.cache ?? defaultViewPrCache;
  const ttl = typeof opts.cacheTtlMs === "number" ? opts.cacheTtlMs : VIEW_PR_CACHE_TTL_MS;
  const key = ViewPrCache.key(repo, prNumber, fields);
  const cached = cache.get(key, ttl);
  if (cached !== undefined) return cached as T;

  const transport: ViewPrTransport = opts.transport ?? "rest";
  const value =
    transport === "graphql"
      ? await viewPrViaGraphql<T>(repo, prNumber, fields, opts)
      : await viewPrViaRest<T>(repo, prNumber, fields, opts);

  // Cache only successful reads — a transient failure must not pin a null.
  cache.set(key, value, ttl);
  return value;
}
