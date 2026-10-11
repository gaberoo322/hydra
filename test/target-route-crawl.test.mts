/**
 * Regression tests for the hydra-target-discover production route crawl planner
 * (scripts/ci/target-route-crawl.ts, issue #2735, epic #2732).
 *
 * What the planner + route extractor must guarantee (each pinned below):
 *
 *   1. ROUTE EXTRACTION: the distinct crawlable routes are recovered from the
 *      Target nav-registry source text — external links dropped, in-page hash
 *      anchors collapsed to their base route, results deduped and sorted.
 *   2. NON-200 → ONE ISSUE: each non-200 route yields exactly one planned issue
 *      whose title/body carry the route, status, repro curl, and error digest.
 *   3. HEALTHY FILES NOTHING: an all-200 crawl produces zero issues.
 *   4. ROUTE-KEYED DEDUP: while an open route-crawl issue covers a route, no new
 *      issue for that route is planned.
 *   5. PER-RUN CAP: at most ROUTE_CRAWL_EMIT_CAP issues per crawl; the overflow
 *      is reported as dropped, not silently discarded.
 *   6. UNREACHABLE IS NOT A FINDING (nor healthy): a status-0 route is skipped,
 *      not filed — a downed service is a health problem, not per-route drift.
 *   7. TITLE/DEDUP COHERENCE: routeFromOpenIssueTitle round-trips renderRouteTitle
 *      and rejects foreign titles.
 *   8. BOARD-SATURATION FLOOR: once MORE than ROUTE_CRAWL_SATURATION_CAP open
 *      route-crawl issues stand on the board, the run emits nothing at all —
 *      every non-200 is dropped with a saturation reason (mirrors the cleanup
 *      emitter's TARGET_SATURATION_CAP guard).
 *
 * Pure planner — crawl results and the open board are injected — so these run in
 * milliseconds with zero fs/network setup.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverRoutes,
  extractRoutes,
  isServiceUnreachable,
  planRouteCrawlEmit,
  renderRouteBody,
  routesFromAppRouterPages,
  ROUTE_CRAWL_LABELS,
  type RouteCrawlContext,
  renderRouteTitle,
  routeFromOpenIssueTitle,
  ROUTE_CRAWL_EMIT_CAP,
  ROUTE_CRAWL_SATURATION_CAP,
  ROUTE_CRAWL_TITLE_PREFIX,
  type RouteCrawlResult,
} from "../scripts/ci/target-route-crawl.ts";

/** A minimal nav-registry-shaped source fixture. */
const NAV_SRC = `
export const NAV_TABS = [
  { href: "/", label: "Portfolio" },
  { href: "/history", label: "History" },
  { href: "/markets", label: "Markets" },
];
export const SYSTEM_SURFACES = [
  { href: "/pnl#pnl-live-readiness", label: "Live Readiness" },
  { href: "/pnl#pnl-trade-history", label: "Trade History" },
  { href: "/venue-orders", label: "Venue Orders" },
  { href: "https://example.com/external", label: "External" },
  { href: "#anchor-only", label: "Anchor" },
];
`;

const CTX: RouteCrawlContext = {
  baseUrl: "http://localhost:9999",
  serviceName: "example-target-web.service",
};

/** Plan with the injected Target context (the seam facts the CLI resolves). */
function planCrawl(results: readonly RouteCrawlResult[], openTitles: readonly string[]) {
  return planRouteCrawlEmit(results, openTitles, CTX);
}

function ok(route: string): RouteCrawlResult {
  return { route, status: 200, bytes: 1000, errorDigest: "" };
}
function bad(route: string, status = 500, digest = "TypeError: cannot read x"): RouteCrawlResult {
  return { route, status, bytes: 0, errorDigest: digest };
}

describe("extractRoutes", () => {
  test("recovers distinct app routes, collapses hashes, drops external + anchor-only", () => {
    const routes = extractRoutes(NAV_SRC);
    assert.deepEqual(routes, ["/", "/history", "/markets", "/pnl", "/venue-orders"]);
  });

  test("returns [] for source with no href literals", () => {
    assert.deepEqual(extractRoutes("export const X = 1;"), []);
  });

  test("dedups a route that appears many times (both hashed and bare)", () => {
    const src = `
      { href: "/pnl" },
      { href: "/pnl#a" },
      { href: "/pnl#b" },
    `;
    assert.deepEqual(extractRoutes(src), ["/pnl"]);
  });
});

describe("routeFromOpenIssueTitle (dedup seam)", () => {
  test("round-trips renderRouteTitle", () => {
    const title = renderRouteTitle("/pnl", 500);
    assert.equal(routeFromOpenIssueTitle(title), "/pnl");
  });

  test("returns null for a foreign title so it never suppresses a real finding", () => {
    assert.equal(routeFromOpenIssueTitle("cleanup(target): demote unused export"), null);
    assert.equal(routeFromOpenIssueTitle("some unrelated bug"), null);
  });

  test("title carries the prefix, route, and status", () => {
    const title = renderRouteTitle("/markets", 502);
    assert.ok(title.startsWith(ROUTE_CRAWL_TITLE_PREFIX));
    assert.ok(title.includes("/markets"));
    assert.ok(title.includes("502"));
  });
});

describe("planRouteCrawlEmit", () => {
  test("healthy crawl files nothing", () => {
    const plan = planCrawl([ok("/"), ok("/pnl"), ok("/markets")], []);
    assert.equal(plan.issues.length, 0);
    assert.equal(plan.dropped.length, 0);
    assert.equal(plan.healthy, 3);
  });

  test("each non-200 route yields exactly one issue with route/status/curl/digest", () => {
    const plan = planCrawl([ok("/"), bad("/pnl", 500, "boom on /pnl")], []);
    assert.equal(plan.issues.length, 1);
    assert.equal(plan.healthy, 1);
    const issue = plan.issues[0];
    assert.equal(issue.route, "/pnl");
    assert.equal(issue.status, 500);
    assert.ok(issue.title.includes("/pnl"));
    assert.ok(issue.body.includes("/pnl"));
    assert.ok(issue.body.includes("500"));
    assert.ok(issue.body.includes("curl -s"), "body carries a repro curl");
    assert.ok(issue.body.includes("boom on /pnl"), "body carries the error digest");
  });

  test("missing digest renders a placeholder, not a broken code block", () => {
    const plan = planCrawl([bad("/pnl", 500, "")], []);
    assert.ok(plan.issues[0].body.includes("no matching journalctl error lines"));
  });

  test("route-keyed dedup: an open route-crawl issue suppresses a repeat finding", () => {
    const openTitle = renderRouteTitle("/pnl", 500);
    const plan = planCrawl([bad("/pnl", 503)], [openTitle]);
    assert.equal(plan.issues.length, 0);
    assert.equal(plan.dropped.length, 1);
    assert.equal(plan.dropped[0].route, "/pnl");
    assert.match(plan.dropped[0].reason, /already tracked/);
  });

  test("dedup keys on route only, ignoring the status in the open title", () => {
    // Open issue says 500; live crawl now sees 502 — still the same broken route.
    const plan = planCrawl([bad("/markets", 502)], [renderRouteTitle("/markets", 500)]);
    assert.equal(plan.issues.length, 0);
  });

  test("per-run cap: overflow beyond the cap is dropped, not silently lost", () => {
    const many: RouteCrawlResult[] = [];
    for (let i = 0; i < ROUTE_CRAWL_EMIT_CAP + 2; i++) {
      many.push(bad(`/route-${i}`, 500));
    }
    const plan = planCrawl(many, []);
    assert.equal(plan.issues.length, ROUTE_CRAWL_EMIT_CAP);
    assert.equal(plan.dropped.length, 2);
    for (const d of plan.dropped) {
      assert.match(d.reason, /over the per-run cap/);
    }
  });

  test("unreachable (status 0) is skipped as service-health, not filed, and NEVER counted healthy", () => {
    const plan = planCrawl([bad("/pnl", 0), ok("/")], []);
    assert.equal(plan.issues.length, 0);
    assert.equal(plan.dropped.length, 0);
    assert.equal(plan.healthy, 1, "only the 200 is healthy");
    assert.equal(plan.unreachable, 1, "the status-0 route is counted on its own");
  });

  test("issue body names the seam-resolved service unit, not a hardcoded one", () => {
    const body = renderRouteBody(bad("/pnl", 500, "boom"), CTX.baseUrl, CTX.serviceName);
    assert.ok(body.includes("journalctl digest (example-target-web.service)"));
    assert.ok(body.includes("http://localhost:9999/pnl"));
    const planned = planCrawl([bad("/pnl", 500, "boom")], []);
    assert.ok(planned.issues[0].body.includes("example-target-web.service"));
  });

  test("findings carry the needs-triage label, never the retired target-backlog", () => {
    assert.deepEqual([...ROUTE_CRAWL_LABELS], ["needs-triage"]);
  });

  test("a foreign open title does not suppress a genuine finding", () => {
    const plan = planCrawl([bad("/pnl", 500)], ["cleanup(target): unrelated"]);
    assert.equal(plan.issues.length, 1);
  });
});

describe("planRouteCrawlEmit — board-saturation floor", () => {
  /** N distinct open route-crawl issue titles (each a different tracked route). */
  function saturatedBoard(n: number): string[] {
    const titles: string[] = [];
    for (let i = 0; i < n; i++) titles.push(renderRouteTitle(`/saturated-${i}`, 500));
    return titles;
  }

  test("board over the saturation floor: a fresh non-200 route emits nothing, dropped with a saturation reason", () => {
    // The board carries MORE than the floor of open crawl issues, and none of
    // them is /pnl — without the floor, /pnl would file (it is not deduped).
    const open = saturatedBoard(ROUTE_CRAWL_SATURATION_CAP + 1);
    const plan = planCrawl([bad("/pnl", 500)], open);
    assert.equal(plan.issues.length, 0, "saturated board emits nothing");
    assert.equal(plan.dropped.length, 1);
    assert.equal(plan.dropped[0].route, "/pnl");
    assert.match(plan.dropped[0].reason, /board saturated/);
    assert.match(plan.dropped[0].reason, /emitting nothing/);
  });

  test("saturation floor beats the per-run cap: many findings all suppressed, not just capped", () => {
    const open = saturatedBoard(ROUTE_CRAWL_SATURATION_CAP + 5);
    const many: RouteCrawlResult[] = [];
    for (let i = 0; i < ROUTE_CRAWL_EMIT_CAP + 3; i++) many.push(bad(`/hot-${i}`, 500));
    const plan = planCrawl(many, open);
    assert.equal(plan.issues.length, 0, "nothing files while the board is saturated");
    assert.equal(plan.dropped.length, many.length, "every finding is dropped, none capped-through");
    for (const d of plan.dropped) assert.match(d.reason, /board saturated/);
  });

  test("saturation floor still counts healthy + status-0 routes so the report stays honest", () => {
    const open = saturatedBoard(ROUTE_CRAWL_SATURATION_CAP + 1);
    const plan = planCrawl([ok("/"), bad("/pnl", 0), bad("/markets", 500)], open);
    assert.equal(plan.issues.length, 0);
    assert.equal(plan.healthy, 1, "only the 200 is healthy");
    assert.equal(plan.unreachable, 1, "the status-0 route is reported as unreachable");
    assert.equal(plan.dropped.length, 1, "only the genuine non-200 is dropped");
    assert.match(plan.dropped[0].reason, /board saturated/);
  });

  test("exactly at the saturation floor is NOT saturated — findings still file normally", () => {
    // The guard is strictly `> cap`, mirroring TARGET_SATURATION_CAP: a board
    // AT the floor still emits, so the run does not go quiet one issue too early.
    const open = saturatedBoard(ROUTE_CRAWL_SATURATION_CAP);
    const plan = planCrawl([bad("/pnl", 500)], open);
    assert.equal(plan.issues.length, 1, "at the floor (not over it) a fresh route still files");
    assert.equal(plan.dropped.length, 0);
    assert.equal(plan.issues[0].route, "/pnl");
  });
});

describe("isServiceUnreachable", () => {
  test("true only when every crawled route is status 0", () => {
    assert.equal(isServiceUnreachable([bad("/a", 0), bad("/b", 0)]), true);
    assert.equal(isServiceUnreachable([bad("/a", 0), ok("/b")]), false);
    assert.equal(isServiceUnreachable([bad("/a", 500)]), false);
  });

  test("an empty crawl is not 'unreachable' (the no-route-source skip owns that)", () => {
    assert.equal(isServiceUnreachable([]), false);
  });
});

describe("routesFromAppRouterPages", () => {
  test("maps page files to routes: root, nested, route groups dropped", () => {
    assert.deepEqual(
      routesFromAppRouterPages([
        "page.tsx",
        "pnl/page.tsx",
        "(marketing)/about/page.tsx",
        "(a)/(b)/deep/page.jsx",
        "layout.tsx",
        "pnl/loading.tsx",
      ]),
      ["/", "/about", "/deep", "/pnl"],
    );
  });

  test("skips dynamic, parallel-slot, private and intercepting segments", () => {
    assert.deepEqual(
      routesFromAppRouterPages([
        "markets/[id]/page.tsx",
        "docs/[...slug]/page.tsx",
        "@modal/login/page.tsx",
        "_components/page.tsx",
        "feed/(.)photo/page.tsx",
        "ok/page.tsx",
      ]),
      ["/ok"],
    );
  });

  test("returns sorted unique routes", () => {
    assert.deepEqual(
      routesFromAppRouterPages(["b/page.tsx", "a/page.tsx", "(g)/a/page.tsx"]),
      ["/a", "/b"],
    );
  });
});

describe("discoverRoutes", () => {
  function tmpApp(): string {
    return mkdtempSync(join(tmpdir(), "route-crawl-"));
  }
  function put(root: string, rel: string, content = ""): void {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }

  test("primary source: app-router enumeration under <appDir>/src/app", () => {
    const dir = tmpApp();
    try {
      put(dir, "src/app/page.tsx");
      put(dir, "src/app/pnl/page.tsx");
      put(dir, "src/app/markets/[id]/page.tsx");
      const d = discoverRoutes(dir);
      assert.equal(d.source, "app-router");
      assert.deepEqual(d.routes, ["/", "/pnl"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("falls back to <appDir>/app when src/app is absent", () => {
    const dir = tmpApp();
    try {
      put(dir, "app/status/page.tsx");
      assert.deepEqual(discoverRoutes(dir).routes, ["/status"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fallback source: nav registry parsed by extractRoutes", () => {
    const dir = tmpApp();
    try {
      put(dir, "src/components/nav-registry.ts", NAV_SRC);
      const d = discoverRoutes(dir);
      assert.equal(d.source, "nav-registry");
      assert.deepEqual(d.routes, ["/", "/history", "/markets", "/pnl", "/venue-orders"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no route source: source null, routes empty, looked-paths reported (loud skip, never healthy)", () => {
    const dir = tmpApp();
    try {
      const d = discoverRoutes(dir);
      assert.equal(d.source, null);
      assert.deepEqual(d.routes, []);
      assert.ok(d.looked.length >= 3, "names every path it inspected");
      assert.ok(d.looked.every((p) => p.startsWith(dir)), "only the Target app dir is read");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
