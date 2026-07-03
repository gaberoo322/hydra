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
 *   6. UNREACHABLE IS NOT A FINDING: a status-0 (service-down) route is skipped,
 *      not filed — a downed service is a health problem, not per-route drift.
 *   7. TITLE/DEDUP COHERENCE: routeFromOpenIssueTitle round-trips renderRouteTitle
 *      and rejects foreign titles.
 *
 * Pure planner — crawl results and the open board are injected — so these run in
 * milliseconds with zero fs/network setup.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  extractRoutes,
  planRouteCrawlEmit,
  renderRouteTitle,
  routeFromOpenIssueTitle,
  ROUTE_CRAWL_EMIT_CAP,
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
    const plan = planRouteCrawlEmit([ok("/"), ok("/pnl"), ok("/markets")], []);
    assert.equal(plan.issues.length, 0);
    assert.equal(plan.dropped.length, 0);
    assert.equal(plan.healthy, 3);
  });

  test("each non-200 route yields exactly one issue with route/status/curl/digest", () => {
    const plan = planRouteCrawlEmit([ok("/"), bad("/pnl", 500, "boom on /pnl")], []);
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
    const plan = planRouteCrawlEmit([bad("/pnl", 500, "")], []);
    assert.ok(plan.issues[0].body.includes("no matching journalctl error lines"));
  });

  test("route-keyed dedup: an open route-crawl issue suppresses a repeat finding", () => {
    const openTitle = renderRouteTitle("/pnl", 500);
    const plan = planRouteCrawlEmit([bad("/pnl", 503)], [openTitle]);
    assert.equal(plan.issues.length, 0);
    assert.equal(plan.dropped.length, 1);
    assert.equal(plan.dropped[0].route, "/pnl");
    assert.match(plan.dropped[0].reason, /already tracked/);
  });

  test("dedup keys on route only, ignoring the status in the open title", () => {
    // Open issue says 500; live crawl now sees 502 — still the same broken route.
    const plan = planRouteCrawlEmit([bad("/markets", 502)], [renderRouteTitle("/markets", 500)]);
    assert.equal(plan.issues.length, 0);
  });

  test("per-run cap: overflow beyond the cap is dropped, not silently lost", () => {
    const many: RouteCrawlResult[] = [];
    for (let i = 0; i < ROUTE_CRAWL_EMIT_CAP + 2; i++) {
      many.push(bad(`/route-${i}`, 500));
    }
    const plan = planRouteCrawlEmit(many, []);
    assert.equal(plan.issues.length, ROUTE_CRAWL_EMIT_CAP);
    assert.equal(plan.dropped.length, 2);
    for (const d of plan.dropped) {
      assert.match(d.reason, /over the per-run cap/);
    }
  });

  test("unreachable (status 0) is skipped as service-health, not filed", () => {
    const plan = planRouteCrawlEmit([bad("/pnl", 0), ok("/")], []);
    assert.equal(plan.issues.length, 0);
    assert.equal(plan.dropped.length, 0);
    // Both the 200 and the status-0 count as "not a finding".
    assert.equal(plan.healthy, 2);
  });

  test("a foreign open title does not suppress a genuine finding", () => {
    const plan = planRouteCrawlEmit([bad("/pnl", 500)], ["cleanup(target): unrelated"]);
    assert.equal(plan.issues.length, 1);
  });
});
