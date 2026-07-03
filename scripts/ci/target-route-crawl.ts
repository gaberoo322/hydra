/**
 * scripts/ci/target-route-crawl.ts — deterministic production route crawl for
 * the `hydra-target-discover` skill (issue #2735, epic #2732).
 *
 * WHY THIS EXISTS. All four of the Target's most recent operator-visible
 * outages (item-737/738 and siblings) were 500s a route emitted *in
 * production* after a clean merge — the pages rendered fine in CI but crashed
 * against real production data (a null column, an empty table, a shape the
 * fixtures never had). PR-time CI is structurally blind to this class of
 * failure: it never sees the production database. The only place to catch it is
 * a runtime crawl of the *live* service. This runner is that crawl.
 *
 * WHAT IT DOES. It reads the Target's nav-registry (the single source of truth
 * for the web app's routes — hydra-betting src/components/nav-registry.ts,
 * Portfolio-IA slice 1 / #2435), curls every distinct page route against the
 * live service (http://localhost:3333), and turns each non-200 into exactly one
 * deduped `target-backlog` GitHub issue carrying the HTTP status, a repro curl,
 * and the journalctl error digest for that route's window. A healthy crawl
 * files nothing.
 *
 * CURL-TIER ONLY. Production monitoring stays at the curl tier — no browser,
 * no Playwright here. Browser-level smoke belongs to the CI tier (#2733); this
 * runner is the always-on production heartbeat, so it must be cheap and
 * dependency-free (Node stdlib + the `gh`/`journalctl` CLIs the playbook
 * already relies on).
 *
 * DISCIPLINE MIRRORS THE CLEANUP EMITTER (scripts/ci/hydra-target-cleanup-emit.ts):
 *   - PURE PLANNING CORE ({@link planRouteCrawlEmit}) — crawl results, the open
 *     board, the cap, and the date are injected, so the whole
 *     filter → dedup → cap → render plan unit-tests with zero fs/network
 *     (test/target-route-crawl.test.mts). Only the thin CLI at the bottom
 *     touches fs, curl, journalctl, and `gh`.
 *   - PER-RUN CAP: at most {@link ROUTE_CRAWL_EMIT_CAP} issues per crawl, so a
 *     site-wide breakage can't spam the board with dozens of issues in one run.
 *   - ROUTE-KEYED DEDUP: while an open route-crawl issue covers a route, no new
 *     issue for that route is filed (mirrors the emitter's file-keyed dedup).
 *   - FAIL-CLOSED on an unreadable board: the CLI aborts rather than emit
 *     without being able to dedup, exactly like the cleanup emitter.
 *
 * Usage (the playbook invokes this, NOT a hand-rolled loop — the #1449 lesson):
 *
 *   # dry-run: crawls, prints per-route status + the plan, files nothing
 *   npx tsx scripts/ci/target-route-crawl.ts
 *
 *   # apply: files one deduped target-backlog issue per non-200 route
 *   npx tsx scripts/ci/target-route-crawl.ts --apply
 *
 *   # point at a non-default base (e.g. a staging port)
 *   npx tsx scripts/ci/target-route-crawl.ts --base http://localhost:3333
 */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

/** The live Target web service the crawl hits by default (see the service unit). */
export const DEFAULT_BASE_URL = "http://localhost:3333";

/** Canonical nav-registry path in the Target checkout — the route source of truth. */
export const NAV_REGISTRY_PATH =
  "/home/gabe/hydra-betting/web/src/components/nav-registry.ts";

/**
 * At most this many non-200 routes file an issue per crawl. A site-wide
 * breakage (e.g. a shared layout crash 500ing every page) would otherwise flood
 * the board; capping keeps one crawl to a bounded, reviewable set. The dropped
 * overflow is reported, not silently discarded.
 */
export const ROUTE_CRAWL_EMIT_CAP = 3;

/** Label every crawl-filed issue carries — the target-backlog board + dedup seam. */
export const ROUTE_CRAWL_LABELS = ["target-backlog"] as const;

/** The stable title prefix; the dedup seam ({@link routeFromOpenIssueTitle}) keys on it. */
export const ROUTE_CRAWL_TITLE_PREFIX = "route-crawl(target):";

/** One route's crawl outcome, as measured by the CLI (or injected in tests). */
export interface RouteCrawlResult {
  /** The page route, e.g. "/pnl". Hash-free (in-page anchors are stripped). */
  readonly route: string;
  /** The HTTP status the live service returned, or 0 if the request never completed. */
  readonly status: number;
  /** Response body size in bytes (informational; recorded in the issue body). */
  readonly bytes: number;
  /**
   * A short journalctl error digest for this route's failure window, already
   * gathered by the caller. Empty string when there was nothing to report
   * (e.g. a healthy route, or the log had no matching lines).
   */
  readonly errorDigest: string;
}

/** One issue the plan wants filed. */
export interface PlannedRouteIssue {
  readonly route: string;
  readonly status: number;
  readonly title: string;
  readonly body: string;
}

/** A non-200 route the plan is NOT filing, and why (dedup or over-cap). */
export interface DroppedRouteFinding {
  readonly route: string;
  readonly status: number;
  readonly reason: string;
}

/** The deterministic plan {@link planRouteCrawlEmit} returns. */
export interface RouteCrawlEmitPlan {
  /** Issues to file, in emit order (length ≤ cap). One per non-200 route. */
  readonly issues: readonly PlannedRouteIssue[];
  /** Non-200 routes intentionally not filed (already-tracked or over-cap). */
  readonly dropped: readonly DroppedRouteFinding[];
  /** Count of routes that returned 200 — the "healthy crawl files nothing" seam. */
  readonly healthy: number;
}

/**
 * Extract the distinct page routes from the Target nav-registry source text.
 *
 * PURE — takes the file's text, returns sorted unique routes. It matches every
 * `href: "…"` string literal in the registry (the registry is the ONE place a
 * route is declared, #2435), then:
 *   - drops in-page hash anchors (`/pnl#pnl-live-readiness` → `/pnl`) — an
 *     anchor is the same underlying route, so crawling it twice is wasteful and
 *     would produce two issues for one broken page;
 *   - drops external links (anything with a scheme like `https:`);
 *   - keeps only absolute app routes (leading `/`);
 *   - dedups and sorts for a stable crawl order.
 *
 * Parsing the source text (rather than importing the module) keeps this on the
 * no-dependency lane and lets it run from the orchestrator repo against the
 * Target checkout without a cross-repo import.
 */
export function extractRoutes(navRegistrySource: string): string[] {
  const routes = new Set<string>();
  const hrefRe = /href:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(navRegistrySource)) !== null) {
    let href = m[1];
    // External / non-app links (have a scheme) are out of scope for the crawl.
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
    // Strip in-page anchors — same underlying route.
    const hashIdx = href.indexOf("#");
    if (hashIdx !== -1) href = href.slice(0, hashIdx);
    if (href === "") continue; // a bare "#…" anchor with no route
    if (!href.startsWith("/")) continue; // relative fragments aren't crawlable routes
    routes.add(href);
  }
  return [...routes].sort();
}

/** Render the (stable, dedup-keyed) issue title for a broken route. */
export function renderRouteTitle(route: string, status: number): string {
  return `${ROUTE_CRAWL_TITLE_PREFIX} ${route} returned ${status}`;
}

/**
 * Recover the route an open route-crawl issue covers, from its title — the
 * dedup seam (mirrors the cleanup emitter's identityFromOpenItemTitle). Returns
 * null for a title that isn't a route-crawl issue, so foreign titles never
 * suppress a real finding.
 */
export function routeFromOpenIssueTitle(title: string): string | null {
  const trimmed = title.trim();
  if (!trimmed.startsWith(ROUTE_CRAWL_TITLE_PREFIX)) return null;
  const rest = trimmed.slice(ROUTE_CRAWL_TITLE_PREFIX.length).trim();
  // "<route> returned <status>" — the route is everything before " returned ".
  const idx = rest.indexOf(" returned ");
  const route = idx === -1 ? rest : rest.slice(0, idx);
  return route.trim() || null;
}

/** Render the issue body: problem, evidence (status + bytes + repro curl + digest), fix. */
export function renderRouteBody(
  result: RouteCrawlResult,
  baseUrl: string,
): string {
  const url = `${baseUrl}${result.route}`;
  const digestBlock =
    result.errorDigest.trim().length > 0
      ? result.errorDigest.trim()
      : "(no matching journalctl error lines captured for this route's window)";
  return [
    "## Problem",
    "",
    `The production route \`${result.route}\` returned **HTTP ${result.status}** on the live`,
    `Target web service (\`${baseUrl}\`). PR-time CI does not exercise routes against the`,
    "production database, so this class of data-drift crash is invisible until a runtime crawl",
    "hits it. Filed by the `hydra-target-discover` route crawl (issue #2735).",
    "",
    "## Evidence",
    "",
    `- Status: \`${result.status}\``,
    `- Response size: \`${result.bytes}\` bytes`,
    "- Repro:",
    "  ```bash",
    `  curl -s -o /dev/null -w "%{http_code}\\n" ${url}`,
    "  ```",
    "- journalctl digest (hydra-betting-web.service):",
    "  ```",
    ...digestBlock.split("\n").map((line) => `  ${line}`),
    "  ```",
    "",
    "## Suggested fix",
    "",
    "Reproduce against production data, find the unhandled shape (usually a null column, an",
    "empty result set, or a value the fixtures never produce), and make the page render an",
    "empty/degraded state instead of throwing.",
    "",
    "## Context for orchestrator",
    "",
    "Data-drift crash caught by the always-on production route crawl, not CI. Part of the",
    "Target UI-quality loop (epic #2732).",
  ].join("\n");
}

/**
 * The pure planner: crawl results + the open board + cap + date → the emit plan.
 *
 * Pipeline: keep only non-200 routes → dedup against open route-crawl issues by
 * route → cap → render. 200s are counted into `healthy` and never filed (the
 * "healthy crawl files nothing" acceptance criterion). A route whose request
 * never completed (status 0 / unreachable service) is treated as healthy-skip,
 * NOT a finding — an unreachable service is a service-health problem the
 * playbook's existing health check owns, not a per-route data-drift crash, and
 * filing one issue per route for a downed service is exactly the flood the cap
 * exists to prevent.
 */
export function planRouteCrawlEmit(
  results: readonly RouteCrawlResult[],
  openIssueTitles: readonly string[],
  baseUrl: string = DEFAULT_BASE_URL,
  cap: number = ROUTE_CRAWL_EMIT_CAP,
): RouteCrawlEmitPlan {
  const trackedRoutes = new Set<string>();
  for (const title of openIssueTitles) {
    const route = routeFromOpenIssueTitle(title);
    if (route) trackedRoutes.add(route);
  }

  let healthy = 0;
  const dropped: DroppedRouteFinding[] = [];
  const candidates: RouteCrawlResult[] = [];

  for (const r of results) {
    if (r.status === 200) {
      healthy++;
      continue;
    }
    if (r.status === 0) {
      // Request never completed — service-health, not per-route data drift.
      // Count it as "not a finding" so a downed service doesn't flood the board.
      healthy++;
      continue;
    }
    if (trackedRoutes.has(r.route)) {
      dropped.push({
        route: r.route,
        status: r.status,
        reason: "already tracked by an open route-crawl issue",
      });
      continue;
    }
    candidates.push(r);
  }

  const issues: PlannedRouteIssue[] = [];
  for (const r of candidates.slice(0, cap)) {
    issues.push({
      route: r.route,
      status: r.status,
      title: renderRouteTitle(r.route, r.status),
      body: renderRouteBody(r, baseUrl),
    });
  }
  for (const r of candidates.slice(cap)) {
    dropped.push({
      route: r.route,
      status: r.status,
      reason: `over the per-run cap of ${cap} routes`,
    });
  }

  return { issues, dropped, healthy };
}

// ---------------------------------------------------------------------------
// Thin CLI wrapper — the only part that touches fs, curl, journalctl, and gh.
// ---------------------------------------------------------------------------

/** Curl one route on the live service; never throws (a failed curl → status 0). */
function crawlRoute(baseUrl: string, route: string): { status: number; bytes: number } {
  try {
    // -s silent, -o /dev/null discard body, -w emit "status bytes", 10s cap.
    const out = execFileSync(
      "curl",
      [
        "-s",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code} %{size_download}",
        "--max-time",
        "10",
        `${baseUrl}${route}`,
      ],
      { encoding: "utf8" },
    ).trim();
    const [statusStr, bytesStr] = out.split(/\s+/);
    return { status: Number(statusStr) || 0, bytes: Number(bytesStr) || 0 };
  } catch (err) {
    // A non-zero curl exit (connection refused, timeout) → unreachable.
    console.error(
      `target-route-crawl: curl failed for ${route}:`,
      err instanceof Error ? err.message : err,
    );
    return { status: 0, bytes: 0 };
  }
}

/** Grab a short journalctl error digest for the failing-route window; never throws. */
function journalDigest(): string {
  try {
    const out = execFileSync(
      "bash",
      [
        "-c",
        "journalctl --user -u hydra-betting-web.service --since '5 min ago' --no-pager 2>&1 " +
          "| grep -iE 'error|fail|500|unhandled|exception' | grep -v DeprecationWarning | tail -8",
      ],
      { encoding: "utf8" },
    );
    return out.trim();
  } catch (err) {
    // grep exits 1 when it matches nothing — that's "no digest", not an error.
    if (err && typeof err === "object" && "status" in err && (err as { status: number }).status === 1) {
      return "";
    }
    console.error(
      "target-route-crawl: journalctl digest failed:",
      err instanceof Error ? err.message : err,
    );
    return "";
  }
}

/** Read the currently-open target-backlog issue titles (for dedup). Throws on gh failure. */
function readOpenIssueTitles(): string[] {
  const out = execFileSync(
    "gh",
    [
      "issue",
      "list",
      "--repo",
      "gaberoo322/hydra",
      "--label",
      "target-backlog",
      "--state",
      "open",
      "--limit",
      "200",
      "--json",
      "title",
      "--jq",
      ".[].title",
    ],
    { encoding: "utf8" },
  );
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** File one target-backlog issue via gh; returns the created issue URL. */
function fileIssue(issue: PlannedRouteIssue): string {
  const labelArgs = ROUTE_CRAWL_LABELS.flatMap((l) => ["--label", l]);
  const footer = `\n\n---\nSource: hydra-target-discover | ${new Date().toISOString()}`;
  const out = execFileSync(
    "gh",
    [
      "issue",
      "create",
      "--repo",
      "gaberoo322/hydra",
      "--title",
      issue.title,
      "--body",
      issue.body + footer,
      ...labelArgs,
    ],
    { encoding: "utf8" },
  );
  return out.trim();
}

function main(): void {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const baseIdx = args.indexOf("--base");
  const baseUrl = baseIdx !== -1 && args[baseIdx + 1] ? args[baseIdx + 1] : DEFAULT_BASE_URL;

  let registrySource: string;
  try {
    registrySource = readFileSync(NAV_REGISTRY_PATH, "utf8");
  } catch (err) {
    console.error(
      `target-route-crawl: cannot read the Target nav-registry at ${NAV_REGISTRY_PATH} — aborting:`,
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  }

  const routes = extractRoutes(registrySource);
  console.log(`Crawling ${routes.length} routes on ${baseUrl}:`);

  const results: RouteCrawlResult[] = [];
  for (const route of routes) {
    const { status, bytes } = crawlRoute(baseUrl, route);
    const isBad = status !== 200 && status !== 0;
    console.log(`  ${route}  ->  ${status || "UNREACHABLE"}  (${bytes} bytes)`);
    results.push({
      route,
      status,
      bytes,
      // Only pay for a journal digest on a genuine non-200 (not 200, not unreachable).
      errorDigest: isBad ? journalDigest() : "",
    });
  }

  let openTitles: string[];
  try {
    openTitles = readOpenIssueTitles();
  } catch (err) {
    console.error(
      "target-route-crawl: failed to read the open target-backlog board — aborting (cannot dedup safely):",
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  }

  const plan = planRouteCrawlEmit(results, openTitles, baseUrl);

  console.log("");
  console.log(`Healthy (200 / skipped): ${plan.healthy}`);
  console.log(`To file:                 ${plan.issues.length} (cap ${ROUTE_CRAWL_EMIT_CAP})`);
  console.log(`Dropped:                 ${plan.dropped.length}`);
  for (const d of plan.dropped) {
    console.log(`  - ${d.route} (${d.status}): ${d.reason}`);
  }

  if (!apply) {
    for (const issue of plan.issues) {
      console.log("\n--- would file ---");
      console.log(issue.title);
      console.log(issue.body);
    }
    console.log("\n(dry-run; no issues created — pass --apply to file them)");
    return;
  }

  for (const issue of plan.issues) {
    try {
      const url = fileIssue(issue);
      console.log(`Filed: ${url} — ${issue.title}`);
    } catch (err) {
      console.error(
        `target-route-crawl: failed to file issue for ${issue.route}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

// Run only as a CLI, not when imported by the test suite.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
