/**
 * Route-table regression tests for the dashboard v3 surface retirement
 * (issue #4012 — epic #4005 slice eta, ADR-0034 §3 "What dies").
 *
 * The dashboard ships no JSX test runner and the worktree resolves no
 * `react`, so — exactly like test/runs-page.test.mts and
 * test/work-page.test.mts — the slice is pinned at the boundaries that ARE
 * mechanically checkable:
 *
 *   1. The retired entry points are physically gone (INV-3: artifact,
 *      generator, generator test, and the advisory CI step that runs it all
 *      leave TOGETHER or the PR ships red).
 *   2. Structural source pins on dashboard/src/App.jsx: no route resolves to
 *      a removed component (INV-1), and every retired deep link — bare
 *      /explore, each of the seven /explore/:tab values, /outcomes — lands
 *      on a client-side <Navigate replace> to the page that absorbed its
 *      content, never a blank page (INV-2).
 *   3. The /now Console/Habitat mode toggle, its ?view= query param, and
 *      its localStorage machinery are gone from App.jsx while /now itself
 *      keeps rendering the surviving Console (issue AC; ADR-0034 §3: the
 *      toggle "collapses with the Habitat").
 *   4. Sidebar keeps the Now nav entry and drops only Outcomes/Explore
 *      (INV-5).
 *   5. The remaining deliberately-orphaned leaf components stay ON DISK,
 *      unrouted (INV-4) — they are a follow-up hydra-cleanup/knip candidate,
 *      and this test must not re-couple to them beyond asserting they were
 *      not swept into this retirement. The now-pixel Habitat leaf itself
 *      (and its 19 sibling components) WAS swept by that anticipated
 *      follow-up (issue #4255) — INV-6 pins that they are now gone. The
 *      explore/outcomes leaf panels were likewise swept by a second
 *      anticipated follow-up (issue #4256) — INV-7 pins that they are now
 *      gone; only LessonsTab.jsx and TabShell.jsx (still reachable from
 *      /explore/lessons and the tab shell wrapper) remain in INV-4.
 *
 * Lifecycle: top-level describes with no shared mutable state (per the
 * CLAUDE.md shared-Redis-teardown authoring rule).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";

async function readSource(rel: string): Promise<string> {
  return readFile(new URL(rel, import.meta.url), "utf8");
}

/** True when the repo-relative file exists at HEAD of this working tree. */
async function pathExists(rel: string): Promise<boolean> {
  try {
    await stat(new URL(rel, import.meta.url));
    return true;
  } catch {
    return false;
  }
}

/** Every .jsx/.ts/.tsx file under dashboard/src that mentions `needle`. */
async function grepDashboardSrc(needle: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const hits: string[] = [];
  const roots = ["../dashboard/src"];
  const walk = async (dir: string) => {
    for (const entry of await readdir(new URL(dir, import.meta.url), {
      withFileTypes: true,
    })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(rel);
      else if (/\.(jsx|ts|tsx)$/.test(entry.name)) {
        const src = await readFile(new URL(rel, import.meta.url), "utf8");
        if (src.includes(needle)) hits.push(rel);
      }
    }
  };
  for (const root of roots) await walk(root);
  return hits;
}

// ---------------------------------------------------------------------------
// INV-3 — the control-plane census leaves as one unit
// ---------------------------------------------------------------------------

describe("control-plane census retires as one unit (INV-3)", () => {
  const deleted = [
    "../dashboard/src/data/control-plane.json",
    "../dashboard/scripts/parse-control-plane.mjs",
    "../test/parse-control-plane.test.mts",
  ];

  for (const rel of deleted) {
    test(`${rel} is deleted`, async () => {
      assert.equal(await pathExists(rel), false, `${rel} must not exist`);
    });
  }

  test("advisory-checks.yml drops the parse-control-plane --check step", async () => {
    const yml = await readSource("../.github/workflows/advisory-checks.yml");
    assert.ok(
      !yml.includes("parse-control-plane"),
      "the advisory workflow must not run the deleted generator against the deleted artifact",
    );
  });
});

// ---------------------------------------------------------------------------
// INV-1 — no route resolves to a removed component
// ---------------------------------------------------------------------------

describe("no route resolves to a removed component (INV-1)", () => {
  test("App.jsx imports none of the removed entry points", async () => {
    const src = await readSource("../dashboard/src/App.jsx");
    assert.ok(
      !src.includes("pages/Explore.jsx"),
      "the retired Explore container must not be imported",
    );
    assert.ok(
      !src.includes("pages/Outcomes.jsx"),
      "the retired Outcomes page must not be imported",
    );
    assert.ok(
      !src.includes("OrchestratorMap"),
      "the retired Orchestrator Map must not be imported",
    );
    assert.ok(
      !src.includes("NowPixel"),
      "the retired Habitat pixel view must not be routed",
    );
  });

  test("no dashboard component references the deleted control-plane artifact or map", async () => {
    assert.deepEqual(await grepDashboardSrc("control-plane.json"), []);
    assert.deepEqual(await grepDashboardSrc("components/OrchestratorMap.jsx"), []);
  });

  test("the surviving v3 routes stay mounted", async () => {
    const src = await readSource("../dashboard/src/App.jsx");
    for (const pin of [
      'path="/"',
      'path="/health"',
      'path="/now"',
      'path="/builder"',
      'path="/runs"',
      'path="/runs/:runId"',
      'path="/work"',
      'path="/dispatch/:dispatchId/transcript"',
    ]) {
      assert.match(src, new RegExp(pin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });
});

// ---------------------------------------------------------------------------
// INV-2 — every retired deep link redirects to the page that absorbed it
// ---------------------------------------------------------------------------

describe("retired deep links redirect to their absorbing pages (INV-2)", () => {
  test("/outcomes → /builder (quality half of Outcomes lives there)", async () => {
    const src = await readSource("../dashboard/src/App.jsx");
    assert.match(src, /path="\/outcomes"[\s\S]{0,160}?to="\/builder"/);
  });

  test("bare /explore → /runs (the old default tab, friction, folded there)", async () => {
    const src = await readSource("../dashboard/src/App.jsx");
    assert.match(src, /path="\/explore"[\s\S]{0,160}?to="\/runs"/);
  });

  test("/explore/:tab still resolves and redirects via <Navigate replace>", async () => {
    const src = await readSource("../dashboard/src/App.jsx");
    assert.match(src, /path="\/explore\/:tab"/);
    // The per-tab fold is a client-side replace redirect, matching the
    // LegacyRunRedirect precedent (#4009) — never a server hop, never 404.
    assert.match(src, /<Navigate replace to=\{to\} \/>/);
  });

  // ADR-0034 §3: "Friction and Behavior → /runs, Flow → /, Lessons →
  // /builder"; the design concept (#4012) extends Architecture → /builder
  // and sends the two dead-end tabs (Anomalies, orchestrator-map) to /.
  const TAB_FOLD: Array<[string, string]> = [
    ["friction", "/runs"],
    ["behavior", "/runs"],
    ["flow", "/"],
    ["lessons", "/builder"],
    ["architecture", "/builder"],
    ["anomalies", "/"],
    ["orchestrator-map", "/"],
  ];

  for (const [tab, target] of TAB_FOLD) {
    test(`/explore/${tab} → ${target}`, async () => {
      const src = await readSource("../dashboard/src/App.jsx");
      // `orchestrator-map` is not a bare identifier, so the object literal
      // quotes it; the bare-identifier tabs are unquoted keys.
      const pin = /^[a-z]+$/.test(tab) ? `${tab}: "${target}"` : `"${tab}": "${target}"`;
      assert.ok(
        src.includes(pin),
        `App.jsx must map the retired ${tab} tab to ${target} (expected literal ${JSON.stringify(pin)})`,
      );
    });
  }

  test("an unrecognized tab folds to the old default's successor (/runs)", async () => {
    const src = await readSource("../dashboard/src/App.jsx");
    // Explore.jsx previously sent unknown tabs to its default tab
    // (friction); friction's successor is /runs, so the fallback must too.
    assert.match(src, /\?\s*EXPLORE_TAB_REDIRECTS\[EXPLORE_DEFAULT_TAB\]/);
  });
});

// ---------------------------------------------------------------------------
// /now — the toggle collapses with the Habitat; the Console survives
// ---------------------------------------------------------------------------

describe("/now renders the Console; the mode toggle machinery is gone", () => {
  test("App.jsx no longer touches the ?view= param or localStorage view plumbing", async () => {
    const src = await readSource("../dashboard/src/App.jsx");
    for (const gone of [
      "NOW_VIEW_QUERY_KEY",
      "VIEW_HABITAT",
      "VIEW_CONSOLE",
      "resolveNowView",
      "writeStoredNowView",
      "useSearchParams",
      "now-view-toggle",
    ]) {
      assert.ok(!src.includes(gone), `App.jsx must not reference ${gone}`);
    }
  });

  test("/now still mounts the surviving Console component", async () => {
    const src = await readSource("../dashboard/src/App.jsx");
    // The route hangs off the thin NowRoute shell, which renders the Console.
    assert.match(src, /path="\/now"[\s\S]{0,80}?NowRoute/);
    assert.match(src, /function NowRoute\(\)[\s\S]{0,400}?<NowConsole \/>/);
  });
});

// ---------------------------------------------------------------------------
// INV-5 — Sidebar drops only Outcomes and Explore
// ---------------------------------------------------------------------------

describe("Sidebar drops only the Outcomes and Explore nav entries (INV-5)", () => {
  test("Now stays; Outcomes and Explore go", async () => {
    const src = await readSource("../dashboard/src/components/Sidebar.jsx");
    assert.match(src, /to: "\/now", label: "Now"/);
    assert.ok(!src.includes('to: "/outcomes"'));
    assert.ok(!src.includes('to: "/explore"'));
  });
});

// ---------------------------------------------------------------------------
// INV-4 — the deliberately-orphaned leaves stay on disk, unrouted
// ---------------------------------------------------------------------------

describe("orphaned leaf components remain on disk for the follow-up cleanup (INV-4)", () => {
  const kept = [
    // The remaining non-reused Explore tab leaves — the other five (Friction,
    // Behavior, Flow, Anomalies, Architecture) were swept by issue #4256
    // (INV-7).
    "../dashboard/src/components/pages/explore/LessonsTab.jsx",
    "../dashboard/src/components/pages/explore/TabShell.jsx",
  ];

  for (const rel of kept) {
    test(`${rel} is NOT swept into this retirement`, async () => {
      assert.equal(await pathExists(rel), true, `${rel} must stay on disk (follow-up knip pass)`);
    });
  }
});

// ---------------------------------------------------------------------------
// INV-7 — the anticipated explore/outcomes follow-up cleanup happened
// (issue #4256)
// ---------------------------------------------------------------------------

describe("the explore/outcomes leaf components were swept in the follow-up cleanup (INV-7)", () => {
  const swept = [
    "../dashboard/src/components/pages/explore/FrictionTab.jsx",
    "../dashboard/src/components/pages/explore/BehaviorTab.jsx",
    "../dashboard/src/components/pages/explore/FlowTab.jsx",
    "../dashboard/src/components/pages/explore/AnomaliesTab.jsx",
    "../dashboard/src/components/pages/explore/ArchitectureTab.jsx",
    "../dashboard/src/components/pages/outcomes/CacheEconomics.jsx",
    "../dashboard/src/components/pages/outcomes/CostByClass.jsx",
    "../dashboard/src/components/pages/outcomes/ClassScoreboard.jsx",
    "../dashboard/src/components/pages/outcomes/CascadeRouting.jsx",
    "../dashboard/src/components/pages/outcomes/SubscriptionQuotaTrend.jsx",
  ];

  for (const rel of swept) {
    test(`${rel} is gone (issue #4256)`, async () => {
      assert.equal(await pathExists(rel), false, `${rel} must be removed by the explore/outcomes cleanup`);
    });
  }
});

// ---------------------------------------------------------------------------
// INV-6 — the anticipated now-pixel follow-up cleanup happened (issue #4255)
// ---------------------------------------------------------------------------

describe("the now-pixel component leaves were swept in the follow-up cleanup (INV-6)", () => {
  const swept = [
    "../dashboard/src/pages/now-pixel/AlertsNoticeBoard.jsx",
    "../dashboard/src/pages/now-pixel/Attribution.jsx",
    "../dashboard/src/pages/now-pixel/AutopilotPavilion.jsx",
    "../dashboard/src/pages/now-pixel/BattleCard.jsx",
    "../dashboard/src/pages/now-pixel/BattleCardRow.jsx",
    "../dashboard/src/pages/now-pixel/ClassSprite.jsx",
    "../dashboard/src/pages/now-pixel/CooldownClock.jsx",
    "../dashboard/src/pages/now-pixel/DispatchTween.jsx",
    "../dashboard/src/pages/now-pixel/HabitatGrid.jsx",
    "../dashboard/src/pages/now-pixel/HabitatZone.jsx",
    "../dashboard/src/pages/now-pixel/HpBar.jsx",
    "../dashboard/src/pages/now-pixel/Infirmary.jsx",
    "../dashboard/src/pages/now-pixel/NowPixel.jsx",
    "../dashboard/src/pages/now-pixel/OakTownCrier.jsx",
    "../dashboard/src/pages/now-pixel/PokedexModal.jsx",
    "../dashboard/src/pages/now-pixel/ReapingFade.jsx",
    "../dashboard/src/pages/now-pixel/RecommendationsTab.jsx",
    "../dashboard/src/pages/now-pixel/RecRunJournalModal.jsx",
    "../dashboard/src/pages/now-pixel/SubagentSprite.jsx",
    "../dashboard/src/pages/now-pixel/TurnJournalTab.jsx",
  ];

  for (const rel of swept) {
    test(`${rel} is gone (issue #4255)`, async () => {
      assert.equal(await pathExists(rel), false, `${rel} must be removed by the now-pixel cleanup`);
    });
  }
});
