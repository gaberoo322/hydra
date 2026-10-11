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
 * WHAT IT DOES. It discovers the Target's page routes from the live Target
 * checkout (Next.js app-router `page.tsx` enumeration, falling back to a nav
 * registry — {@link discoverRoutes}), curls every distinct route against the
 * live service, and turns each non-200 into exactly one deduped `needs-triage`
 * issue on the TARGET repo carrying the HTTP status, a repro curl, and the
 * journalctl error digest for that route's window. A healthy crawl files
 * nothing.
 *
 * TARGET SEAM (issue #4846). Every Target identity fact — web URL, workspace /
 * app dir, systemd unit, findings repo — is read through `collectTargetFacts()`
 * (scripts/target/print-target-facts.ts, issue #4411), never a literal, so the
 * crawl follows the Target across swaps (ADR-0013). Unreachable is never
 * healthy: a status-0 route is counted separately and an all-unreachable crawl
 * exits 1 loudly instead of reporting a false "Healthy" verdict.
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
 *   - REST-ONLY board reads (ADR-0031 Decision 6): `gh api`, never
 *     `gh issue list --json` / GraphQL.
 *
 * Usage (the playbook invokes this, NOT a hand-rolled loop — the #1449 lesson):
 *
 *   # dry-run: crawls, prints per-route status + the plan, files nothing
 *   npx tsx scripts/ci/target-route-crawl.ts
 *
 *   # apply: files one deduped needs-triage issue per non-200 route
 *   npx tsx scripts/ci/target-route-crawl.ts --apply
 *
 *   # override the seam-resolved web URL (e.g. a staging port)
 *   npx tsx scripts/ci/target-route-crawl.ts --base http://localhost:<port>
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { collectTargetFacts } from "../target/print-target-facts.ts";

/**
 * Nav-registry fallback locations, relative to the Target app dir (workspace
 * joined with the manifest's `verify.appSubdir`). Tried in order.
 */
export const NAV_REGISTRY_RELATIVE_PATHS = [
  "src/app/nav.ts",
  "src/components/nav-registry.ts",
] as const;

/** Next.js app-router roots, relative to the Target app dir. Tried in order. */
export const APP_ROUTER_RELATIVE_ROOTS = ["src/app", "app"] as const;

/**
 * At most this many non-200 routes file an issue per crawl. A site-wide
 * breakage (e.g. a shared layout crash 500ing every page) would otherwise flood
 * the board; capping keeps one crawl to a bounded, reviewable set. The dropped
 * overflow is reported, not silently discarded.
 */
export const ROUTE_CRAWL_EMIT_CAP = 3;

/**
 * The board-saturation floor (mirrors `TARGET_SATURATION_CAP = 10` in the
 * cleanup emitter): if the Target board already carries MORE than this many
 * open route-crawl issues, the run emits NOTHING at all — not even up to the
 * per-run cap. Where {@link ROUTE_CRAWL_EMIT_CAP} bounds a *single* crawl's
 * output, this bounds the *standing* board: once the operator is already
 * sitting on a wall of unaddressed route-crawl issues, filing more is pure
 * noise, so the run goes quiet until the board is drained back under the floor.
 */
export const ROUTE_CRAWL_SATURATION_CAP = 10;

/**
 * Label every crawl-filed issue carries. `needs-triage` per ADR-0031 — the
 * Target board's intake lane; the older orch-side backlog label is retired.
 */
export const ROUTE_CRAWL_LABELS = ["needs-triage"] as const;

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
  /**
   * Count of routes whose request never completed (status 0). NEVER folded
   * into `healthy` — an unreachable service must not read as a clean crawl.
   * These still file nothing (service-down is the health check's job).
   */
  readonly unreachable: number;
}

/** Target facts the pure planner/renderer need — injected, never read here. */
export interface RouteCrawlContext {
  /** Live web base URL (seam-resolved `webUrl`, or the `--base` override). */
  readonly baseUrl: string;
  /** The Target's systemd unit name, named in the issue body's journal digest. */
  readonly serviceName: string;
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
  serviceName: string,
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
    `- journalctl digest (${serviceName}):`,
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
 * never completed (status 0 / unreachable service) is counted into `unreachable`
 * (NEVER `healthy`) and is
 * NOT a finding — an unreachable service is a service-health problem the
 * playbook's existing health check owns, not a per-route data-drift crash, and
 * filing one issue per route for a downed service is exactly the flood the cap
 * exists to prevent.
 *
 * BOARD-SATURATION FLOOR (mirrors the cleanup emitter's `TARGET_SATURATION_CAP`
 * guard): before planning any emission, if the board already carries MORE than
 * `saturationCap` open route-crawl issues, the plan emits nothing — every
 * non-200 route is dropped with a saturation reason. This is the *standing*
 * bound (distinct from the per-run `cap`): once the operator is sitting on a
 * wall of unaddressed crawl issues, more filing is noise, so the run goes quiet
 * until the board drains back under the floor. Healthy routes are still counted
 * so the report stays truthful.
 */
export function planRouteCrawlEmit(
  results: readonly RouteCrawlResult[],
  openIssueTitles: readonly string[],
  ctx: RouteCrawlContext,
  cap: number = ROUTE_CRAWL_EMIT_CAP,
  saturationCap: number = ROUTE_CRAWL_SATURATION_CAP,
): RouteCrawlEmitPlan {
  const trackedRoutes = new Set<string>();
  for (const title of openIssueTitles) {
    const route = routeFromOpenIssueTitle(title);
    if (route) trackedRoutes.add(route);
  }

  // Board-saturation floor: too many open route-crawl issues already → emit
  // nothing this run (mirrors hydra-target-cleanup-emit's TARGET_SATURATION_CAP
  // guard). Every non-200 route is dropped with a saturation reason; healthy
  // routes are still counted so the crawl report is honest.
  if (trackedRoutes.size > saturationCap) {
    let saturatedHealthy = 0;
    let saturatedUnreachable = 0;
    const saturatedDropped: DroppedRouteFinding[] = [];
    for (const r of results) {
      if (r.status === 200) {
        saturatedHealthy++;
        continue;
      }
      if (r.status === 0) {
        saturatedUnreachable++;
        continue;
      }
      saturatedDropped.push({
        route: r.route,
        status: r.status,
        reason: `board saturated (${trackedRoutes.size} open route-crawl issues > ${saturationCap} cap) — emitting nothing`,
      });
    }
    return {
      issues: [],
      dropped: saturatedDropped,
      healthy: saturatedHealthy,
      unreachable: saturatedUnreachable,
    };
  }

  let healthy = 0;
  let unreachable = 0;
  const dropped: DroppedRouteFinding[] = [];
  const candidates: RouteCrawlResult[] = [];

  for (const r of results) {
    if (r.status === 200) {
      healthy++;
      continue;
    }
    if (r.status === 0) {
      // Request never completed — service-health, not per-route data drift.
      // Not a finding (a downed service must not flood the board) but also
      // NEVER healthy: counted on its own so the report cannot read as clean.
      unreachable++;
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
      body: renderRouteBody(r, ctx.baseUrl, ctx.serviceName),
    });
  }
  for (const r of candidates.slice(cap)) {
    dropped.push({
      route: r.route,
      status: r.status,
      reason: `over the per-run cap of ${cap} routes`,
    });
  }

  return { issues, dropped, healthy, unreachable };
}

/**
 * True when at least one route was crawled and EVERY one was unreachable
 * (status 0) — the service is down or the base URL is wrong, so the crawl
 * measured nothing. The CLI turns this into a loud exit 1, never "Healthy".
 */
export function isServiceUnreachable(results: readonly RouteCrawlResult[]): boolean {
  return results.length > 0 && results.every((r) => r.status === 0);
}

/**
 * Map Next.js app-router `page.*` file paths (relative to the app root, e.g.
 * `(marketing)/pnl/page.tsx`) to crawlable routes. PURE.
 *
 *   - `page.tsx` at the root          -> `/`
 *   - `(group)` segments              -> dropped (route groups add no URL part)
 *   - `[param]` / `[...rest]`         -> whole path skipped (not curl-able)
 *   - `@slot` (parallel) / `_private` -> whole path skipped
 *   - `(.)x` / `(..)x` intercepting   -> whole path skipped
 *
 * Returns sorted, unique routes.
 */
export function routesFromAppRouterPages(pagePaths: readonly string[]): string[] {
  const routes = new Set<string>();
  for (const raw of pagePaths) {
    const normalized = raw.replace(/\\/g, "/").replace(/^\/+/, "");
    const segments = normalized.split("/");
    const file = segments.pop() ?? "";
    if (!/^page\.(tsx|jsx|ts|js|mdx)$/.test(file)) continue;
    const kept: string[] = [];
    let skip = false;
    for (const seg of segments) {
      if (seg === "") continue;
      if (/^\(\.+\)/.test(seg)) {
        skip = true; // intercepting route
        break;
      }
      if (/^\(.*\)$/.test(seg)) continue; // route group
      if (seg.startsWith("[") || seg.startsWith("@") || seg.startsWith("_")) {
        skip = true;
        break;
      }
      kept.push(seg);
    }
    if (skip) continue;
    routes.add("/" + kept.join("/"));
  }
  return [...routes].sort();
}

/** Result of {@link discoverRoutes}. `source: null` = no route source found. */
export interface RouteDiscovery {
  readonly routes: string[];
  readonly source: "app-router" | "nav-registry" | null;
  /** Every path inspected, for the loud skip message. */
  readonly looked: string[];
}

/** Recursively list files under `dir`, as paths relative to `dir`. Never throws. */
function listFilesRecursive(dir: string, rel = ""): string[] {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(join(dir, rel), { withFileTypes: true });
  } catch (err) {
    console.error(
      `target-route-crawl: cannot read ${join(dir, rel)}:`,
      err instanceof Error ? err.message : err,
    );
    return out;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFilesRecursive(dir, childRel));
    else out.push(childRel);
  }
  return out;
}

/**
 * Discover crawlable routes from the live Target checkout at `appDir`.
 * Primary: Next.js app-router `page.*` enumeration (`src/app` then `app`).
 * Fallback: a nav registry parsed by {@link extractRoutes}. Reads only under
 * `appDir` — never a foreign Target's tree.
 */
export function discoverRoutes(appDir: string): RouteDiscovery {
  const looked: string[] = [];
  for (const rel of APP_ROUTER_RELATIVE_ROOTS) {
    const root = join(appDir, rel);
    looked.push(root);
    if (!existsSync(root)) continue;
    const routes = routesFromAppRouterPages(listFilesRecursive(root));
    if (routes.length > 0) return { routes, source: "app-router", looked };
  }
  for (const rel of NAV_REGISTRY_RELATIVE_PATHS) {
    const path = join(appDir, rel);
    looked.push(path);
    if (!existsSync(path)) continue;
    try {
      const routes = extractRoutes(readFileSync(path, "utf8"));
      if (routes.length > 0) return { routes, source: "nav-registry", looked };
    } catch (err) {
      console.error(
        `target-route-crawl: cannot read nav registry ${path}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return { routes: [], source: null, looked };
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
function journalDigest(serviceName: string): string {
  try {
    const out = execFileSync(
      "journalctl",
      ["--user", "-u", serviceName, "--since", "5 min ago", "--no-pager"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return out
      .split("\n")
      .filter((l) => /error|fail|500|unhandled|exception/i.test(l) && !l.includes("DeprecationWarning"))
      .slice(-8)
      .join("\n");
  } catch (err) {
    console.error(
      "target-route-crawl: journalctl digest failed:",
      err instanceof Error ? err.message : err,
    );
    return "";
  }
}

/**
 * Read the open issue titles on the Target repo (for dedup) via REST — never
 * `gh issue list --json` / GraphQL (ADR-0031 Decision 6). PRs are filtered out.
 * Throws on gh failure (the CLI fails closed).
 */
function readOpenIssueTitles(repo: string): string[] {
  const out = execFileSync(
    "gh",
    [
      "api",
      `repos/${repo}/issues?state=open&per_page=100`,
      "--paginate",
      "--jq",
      '.[] | select(has("pull_request")|not) | .title',
    ],
    { encoding: "utf8" },
  );
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** File one needs-triage issue on the Target repo via gh; returns the created issue URL. */
function fileIssue(issue: PlannedRouteIssue, repo: string): string {
  const labelArgs = ROUTE_CRAWL_LABELS.flatMap((l) => ["--label", l]);
  const footer = `\n\n---\nSource: hydra-target-discover | ${new Date().toISOString()}`;
  const out = execFileSync(
    "gh",
    [
      "issue",
      "create",
      "--repo",
      repo,
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

  const facts = collectTargetFacts();
  if (facts.manifest.ok === false) {
    console.error(
      `target-route-crawl: Target manifest unresolved — aborting: ${facts.manifest.errors.join("; ")}`,
    );
    process.exit(1);
  }
  const appDir = facts.manifest.appSubdir
    ? join(facts.workspace, facts.manifest.appSubdir)
    : facts.workspace;

  const baseIdx = args.indexOf("--base");
  const baseUrl = baseIdx !== -1 && args[baseIdx + 1] ? args[baseIdx + 1] : facts.webUrl;
  const ctx: RouteCrawlContext = { baseUrl, serviceName: facts.serviceName };

  const discovery = discoverRoutes(appDir);
  if (discovery.source === null) {
    console.error(
      `route-crawl: SKIPPED — no route source for Target ${facts.name} (looked for ${discovery.looked.join(", ")})`,
    );
    process.exit(1);
  }
  const routes = discovery.routes;
  console.log(`Crawling ${routes.length} routes (${discovery.source}) on ${baseUrl}:`);

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
      errorDigest: isBad ? journalDigest(facts.serviceName) : "",
    });
  }

  if (isServiceUnreachable(results)) {
    console.error(`route-crawl: SERVICE UNREACHABLE at ${baseUrl} — filing nothing`);
    process.exit(1);
  }

  let openTitles: string[];
  try {
    openTitles = readOpenIssueTitles(facts.githubRepo);
  } catch (err) {
    console.error(
      `target-route-crawl: failed to read the open ${facts.githubRepo} board — aborting (cannot dedup safely):`,
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  }

  const plan = planRouteCrawlEmit(results, openTitles, ctx);

  console.log("");
  console.log(`Healthy (200):           ${plan.healthy}`);
  console.log(`Unreachable:             ${plan.unreachable}`);
  console.log(
    `To file:                 ${plan.issues.length} (per-run cap ${ROUTE_CRAWL_EMIT_CAP}, board-saturation floor ${ROUTE_CRAWL_SATURATION_CAP})`,
  );
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
      const url = fileIssue(issue, facts.githubRepo);
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
