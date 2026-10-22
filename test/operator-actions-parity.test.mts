/**
 * Parity-contract pins (issue #4638, ADR-0034 §9 — guidance-epic 19/19).
 *
 * Every rung runs against the COMMITTED route inventory
 * (docs/generated/routes.json, ADR-0034 §10 / #4589) and the shipped
 * operator-action REGISTRY, so a new route, a new playbook, or a registry
 * route with no inventory row reddens the required `test` job until someone
 * classifies it in src/operator-actions/parity.ts. Each pure helper is also
 * driven against a synthetic fixture to prove it can FAIL.
 *
 *   Rung 1 (§9.1) — every write route is in exactly one of: registry
 *     in-dashboard routes / MACHINE_WRITES / PENDING_CONTROL_WRITES; RETIRED
 *     writes are absent from the inventory; PENDING can only shrink.
 *   Rung 3 (§9.3) — every playbook is a class: entry, referenced by a registry
 *     action, or DOCS_ONLY with a reason.
 *   Rung 4 (§9.4) — every GET is in exactly one of HOMED_READS / MACHINE_READS;
 *     RETIRED reads are absent; each HOMED file contains the path literal.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { REGISTRY } from "../src/operator-actions/registry.ts";
import {
  DOCS_ONLY,
  FEED_GRAMMAR_WRITES,
  HOMED_READS,
  HOMED_UNATTRIBUTED,
  MACHINE_READS,
  MACHINE_WRITES,
  PENDING_CONTROL_WRITES,
  RETIRED_READS,
  RETIRED_WRITES,
  RETIREMENT_CANDIDATES,
  homedReadMisses,
  loadRouteInventory,
  partitionRoutes,
  playbookCoverage,
  readParity,
  registryWriteRoutes,
  resolveRegistryRoute,
  routeKey,
  routeLiteralPattern,
  writeParity,
  type RouteInventoryRow,
} from "../src/operator-actions/parity.ts";
import { InvariantViolationError } from "../src/errors.ts";
import type { OperatorActionEntry } from "../src/schemas/operator-actions.ts";

const REPO = resolve(import.meta.dirname, "..");
const ROWS = loadRouteInventory();

/**
 * The ceiling for PENDING_CONTROL_WRITES. Shrink-only: delete a key here in
 * the same PR that registers its control and deletes it from parity.ts. Never
 * add one — a new human-shaped write gets a registry entry instead.
 */
const PENDING_CEILING: readonly string[] = [
  "POST /api/holdback/enroll", // #4633 INV-10 deferral
];

/**
 * The ceiling for RETIREMENT_CANDIDATES (follow-up #5160). Shrink-only: each
 * key leaves when #5160 retires it (→ RETIRED_*) or names its caller
 * (→ MACHINE_*). Never add one.
 */
const RETIREMENT_CEILING: readonly string[] = [
  "GET /api/agents/stream",
  "GET /api/config/:section",
  "GET /api/cycle/report/:cycleId",
  "GET /api/metrics/instrumentation",
  "GET /api/observability/config",
  "GET /api/today/decision-queue",
  "PATCH /api/dispatches/subagent/:sessionId/current-step",
];

function row(method: string, path: string, consumers: string[] = []): RouteInventoryRow {
  return { method, path, consumers };
}

function readRepoFile(file: string): string | null {
  const abs = join(REPO, file);
  return existsSync(abs) ? readFileSync(abs, "utf-8") : null;
}

function playbookNames(): string[] {
  return readdirSync(join(REPO, "docs", "operator-playbooks"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .sort();
}

// ---------------------------------------------------------------------------
// The inventory loader
// ---------------------------------------------------------------------------

describe("loadRouteInventory — reads the committed routes.json (never re-enumerates)", () => {
  test("loads a non-empty list of {method, path, consumers} rows with /api paths", () => {
    assert.ok(ROWS.length > 50, `expected the full inventory; got ${ROWS.length} rows`);
    for (const r of ROWS) {
      assert.match(r.path, /^\/api\//);
      assert.ok(Array.isArray(r.consumers));
    }
  });

  test("a malformed inventory throws InvariantViolationError, never an empty list", () => {
    const dir = mkdtempSync(join(tmpdir(), "parity-inventory-"));
    try {
      const file = join(dir, "routes.json");
      writeFileSync(file, JSON.stringify({ family: "routes", rows: [] }));
      assert.throws(() => loadRouteInventory(file), InvariantViolationError);
      writeFileSync(file, JSON.stringify({ family: "routes", rows: [{ method: "GET" }] }));
      assert.throws(() => loadRouteInventory(file), InvariantViolationError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("parity.ts reads the inventory and never scans src/api for routes itself", () => {
    const src = readFileSync(join(REPO, "src", "operator-actions", "parity.ts"), "utf-8");
    assert.match(src, /docs\/generated\/routes\.json/);
    assert.doesNotMatch(src, /readdirSync/, "parity.ts must not walk router sources");
    assert.doesNotMatch(src, /\(get\|post/, "parity.ts must not carry a route-registration regex");
  });
});

// ---------------------------------------------------------------------------
// Rung 1 — write routes (§9.1)
// ---------------------------------------------------------------------------

describe("rung 1 — every write route is in exactly one set (§9.1)", () => {
  test("the shipped sets partition the inventory's write routes", () => {
    const report = writeParity(ROWS, REGISTRY);
    assert.deepEqual(report.unclassified, [], "unclassified write routes — add each to a set in parity.ts");
    assert.deepEqual(report.multiplyClassified, [], "a write route sits in two sets — delete the stale entry");
    assert.deepEqual(report.stale, [], "a set names a write route the inventory no longer has");
    assert.deepEqual(report.retiredPresent, [], "a RETIRED_WRITES route is back in the inventory");
    assert.deepEqual(report.dangling, [], "a registry in-dashboard route matches no inventory row");
  });

  test("every set entry carries a non-empty reason (PENDING also a ref)", () => {
    for (const [key, reason] of Object.entries({ ...MACHINE_WRITES, ...FEED_GRAMMAR_WRITES, ...RETIRED_WRITES })) {
      assert.ok(reason.trim().length > 0, `${key} has no reason`);
    }
    for (const [key, entry] of Object.entries(PENDING_CONTROL_WRITES)) {
      assert.ok(entry.ref.trim().length > 0 && entry.reason.trim().length > 0, `${key} needs ref + reason`);
    }
  });

  test("PENDING_CONTROL_WRITES is shrink-only: every key is within the frozen ceiling", () => {
    const over = Object.keys(PENDING_CONTROL_WRITES).filter((k) => !PENDING_CEILING.includes(k));
    assert.deepEqual(over, [], "PENDING_CONTROL_WRITES may only shrink — register a control instead");
  });

  test("RETIREMENT_CANDIDATES is shrink-only and every entry cites follow-up #5160", () => {
    const over = Object.keys(RETIREMENT_CANDIDATES).filter((k) => !RETIREMENT_CEILING.includes(k));
    assert.deepEqual(over, [], "RETIREMENT_CANDIDATES may only shrink — classify a new route instead");
    for (const [key, reason] of Object.entries(RETIREMENT_CANDIDATES)) {
      assert.match(reason, /#5160/, `${key} must cite follow-up #5160`);
    }
  });

  test("FEED_GRAMMAR_WRITES is frozen to the §8.4 typed feed dismiss", () => {
    assert.deepEqual(Object.keys(FEED_GRAMMAR_WRITES), ["POST /api/attention/:id/dismiss"]);
    assert.match(FEED_GRAMMAR_WRITES["POST /api/attention/:id/dismiss"], /§8\.4/);
  });

  test("a route in RETIREMENT_CANDIDATES and MACHINE_WRITES at once is reported as multiply classified", () => {
    const report = writeParity([row("PATCH", "/api/p")], [], {
      machine: { "PATCH /api/p": "m" },
      feed: {},
      pending: {},
      candidates: { "PATCH /api/p": "#5160", "GET /api/ignored-by-rung-1": "#5160" },
      retired: {},
    });
    assert.deepEqual(report.multiplyClassified, [{ key: "PATCH /api/p", sets: ["MACHINE_WRITES", "RETIREMENT_CANDIDATES"] }]);
    assert.deepEqual(report.stale, [], "a GET candidate is rung 4's business, never stale in rung 1");
  });

  test("§9.1's five retired writes are the RETIRED_WRITES set", () => {
    assert.deepEqual(Object.keys(RETIRED_WRITES).sort(), [
      "DELETE /api/env/:project/:key",
      "POST /api/calibration/outcomes/sync",
      "POST /api/kill",
      "POST /api/research/start",
      "PUT /api/env/:project",
    ]);
  });

  test("registry routes resolve through {placeholder} → :param (design-concept approve, paused)", () => {
    const { keys } = registryWriteRoutes(REGISTRY, ROWS);
    assert.ok(keys.has("POST /api/design-concepts/:anchorRef/approve"));
    assert.ok(keys.has("POST /api/autopilot/paused"));
    assert.equal(resolveRegistryRoute("POST", "/alerts/{id}/dismiss", [row("POST", "/api/alerts/:id/dismiss")]), "POST /api/alerts/:id/dismiss");
    assert.equal(resolveRegistryRoute("POST", "/alerts/x/dismiss", [row("POST", "/api/alerts/:id/dismiss")]), null);
    assert.equal(resolveRegistryRoute("GET", "/alerts/{id}/dismiss", [row("POST", "/api/alerts/:id/dismiss")]), null);
  });

  test("a NEW unclassified write route reddens the partition", () => {
    const rows = [...ROWS, row("POST", "/api/brand-new/thing")];
    assert.deepEqual(writeParity(rows, REGISTRY).unclassified, ["POST /api/brand-new/thing"]);
  });

  test("a route in two sets, a stale entry, a returning retired route and a dangling registry route are all reported", () => {
    const rows = [row("POST", "/api/a"), row("POST", "/api/kill")];
    const registry = [
      {
        key: "control:x/y",
        recommended: { kind: "in-dashboard", route: "/a", method: "POST", confirmTier: "immediate-undo", label: "A", preconditions: [], consequence: "c" },
        alternatives: [
          { kind: "in-dashboard", route: "/nope", method: "POST", confirmTier: "immediate-undo", label: "N", preconditions: [], consequence: "c" },
          { kind: "terminal-skill", command: "/x", label: "X", preconditions: [], consequence: "c" },
        ],
        rationale: "r",
        doc: "d",
      },
    ] as unknown as OperatorActionEntry[];
    const report = writeParity(rows, registry, {
      machine: { "POST /api/a": "m", "POST /api/gone": "m" },
      feed: {},
      pending: {},
      candidates: {},
      retired: { "POST /api/kill": "r" },
    });
    assert.deepEqual(report.multiplyClassified, [{ key: "POST /api/a", sets: ["registry", "MACHINE_WRITES"] }]);
    assert.deepEqual(report.stale, [{ set: "MACHINE_WRITES", key: "POST /api/gone" }]);
    assert.deepEqual(report.retiredPresent, ["POST /api/kill"]);
    assert.deepEqual(report.unclassified, [], "the retired-but-present route is reported once, as retiredPresent");
    assert.deepEqual(report.dangling, ["control:x/y: POST /nope"]);
  });
});

// ---------------------------------------------------------------------------
// Rung 4 — read routes (§9.4)
// ---------------------------------------------------------------------------

describe("rung 4 — every GET is in exactly one set (§9.4)", () => {
  test("the shipped sets partition the inventory's GET routes", () => {
    const report = readParity(ROWS);
    assert.deepEqual(report.unclassified, [], "unclassified GET routes — add each to a set in parity.ts");
    assert.deepEqual(report.multiplyClassified, [], "a GET sits in two sets");
    assert.deepEqual(report.stale, [], "a set names a GET the inventory no longer has");
    assert.deepEqual(report.retiredPresent, [], "a RETIRED_READS route is back in the inventory");
  });

  test("§9.4's eleven retired reads are the RETIRED_READS set", () => {
    assert.equal(Object.keys(RETIRED_READS).length, 11);
    for (const [key, reason] of Object.entries({ ...RETIRED_READS, ...MACHINE_READS })) {
      assert.ok(reason.trim().length > 0, `${key} has no reason`);
    }
  });

  test("every HOMED_READS owning file is an inventory consumer, exists and contains the path literal", () => {
    assert.deepEqual(homedReadMisses(HOMED_READS, ROWS, readRepoFile), []);
  });

  test("every HOMED_UNATTRIBUTED waiver is a homed GET the inventory genuinely cannot attribute", () => {
    for (const [key, reason] of Object.entries(HOMED_UNATTRIBUTED)) {
      assert.ok(key in HOMED_READS, `${key} is waived but not homed`);
      const inv = ROWS.find((r) => routeKey(r) === key);
      assert.ok(inv, `${key} is not in the inventory`);
      assert.ok(!inv.consumers.includes(HOMED_READS[key]), `${key}'s home is now attributed — delete the waiver`);
      assert.ok(reason.trim().length > 10, `${key} needs a real reason`);
    }
  });

  test("every GET with an inventory dashboard consumer is homed, not machine-facing", () => {
    const misfiled = ROWS.filter((r) => r.method === "GET" && r.consumers.length > 0)
      .map(routeKey)
      .filter((key) => !(key in HOMED_READS));
    assert.deepEqual(misfiled, []);
  });

  test("a NEW unclassified GET reddens the partition", () => {
    const rows = [...ROWS, row("GET", "/api/brand-new/read")];
    assert.deepEqual(readParity(rows).unclassified, ["GET /api/brand-new/read"]);
  });

  test("partitionRoutes reports a GET in two sets", () => {
    const report = partitionRoutes(
      [row("GET", "/api/x")],
      () => true,
      { A: new Set(["GET /api/x"]), B: new Set(["GET /api/x"]) },
      new Set(),
    );
    assert.deepEqual(report.multiplyClassified, [{ key: "GET /api/x", sets: ["A", "B"] }]);
  });

  test("routeLiteralPattern normalises :param ↔ ${…} and the /api / ${API_BASE} prefixes", () => {
    const p = routeLiteralPattern("/api/autopilot/runs/:runId/retro");
    assert.ok(p.test("useApi(`/autopilot/runs/${encodeURIComponent(runId)}/retro`)"));
    assert.ok(p.test('fetch("/api/autopilot/runs/:runId/retro")'));
    assert.ok(p.test("fetch(`${API_BASE}/autopilot/runs/${id}/retro?x=1`)"));
    assert.ok(!p.test("useApi(`/autopilot/runs/${id}/retro/more`)"));
    const m = routeLiteralPattern("/api/metrics");
    assert.ok(m.test('useApi("/metrics?count=5")'));
    assert.ok(!m.test('useApi("/metrics/cost")'), "a prefix must not match a longer path");
  });

  test("homedReadMisses reports a missing file, a non-consumer and a file without the literal", () => {
    const rows = [row("GET", "/api/a", ["f1.jsx"]), row("GET", "/api/b", ["f2.jsx"]), row("GET", "/api/c", [])];
    const misses = homedReadMisses(
      { "GET /api/a": "f1.jsx", "GET /api/b": "f2.jsx", "GET /api/c": "f3.jsx" },
      rows,
      (file) => (file === "f1.jsx" ? null : 'useApi("/zzz")'),
      {},
    );
    assert.deepEqual(misses, [
      { key: "GET /api/a", file: "f1.jsx", why: "missing-file" },
      { key: "GET /api/b", file: "f2.jsx", why: "no-literal" },
      { key: "GET /api/c", file: "f3.jsx", why: "not-a-consumer" },
    ]);
  });

  test("a path literal that survives only in a doc comment, with the consumer gone, reddens the HOMED pin", () => {
    // The review mutation: AlertsPanel's call renamed to /alertz while its
    // header comment still says `/alerts`. The literal check alone would pass;
    // the inventory no longer lists the file as a consumer, so the pin fails.
    const source = '/** Reads `/alerts` for the panel. */\nconst a = useApi("/alertz");';
    assert.ok(routeLiteralPattern("/api/alerts").test(source), "the comment does satisfy the literal check alone");
    const misses = homedReadMisses(
      { "GET /api/alerts": "AlertsPanel.jsx" },
      [row("GET", "/api/alerts", [])],
      () => source,
      {},
    );
    assert.deepEqual(misses, [{ key: "GET /api/alerts", file: "AlertsPanel.jsx", why: "not-a-consumer" }]);
  });
});

// ---------------------------------------------------------------------------
// Rung 3 — playbooks (§9.3)
// ---------------------------------------------------------------------------

describe("rung 3 — every playbook is reachable as instruction (§9.3)", () => {
  test("every playbook is a class: entry, a registry-action reference, or DOCS_ONLY", () => {
    const report = playbookCoverage(playbookNames(), REGISTRY);
    assert.deepEqual(report.uncovered, [], "playbooks with no class:, registry reference or DOCS_ONLY reason");
    assert.deepEqual(report.redundantDocsOnly, [], "a DOCS_ONLY playbook is now covered — delete its entry");
    assert.deepEqual(report.unknownDocsOnly, [], "a DOCS_ONLY entry names no playbook");
  });

  test("every DOCS_ONLY entry carries an explicit reason", () => {
    for (const [name, reason] of Object.entries(DOCS_ONLY)) {
      assert.ok(reason.trim().length > 10, `${name} needs a real reason`);
    }
  });

  test("a new playbook with no coverage is reported; a covered one is not", () => {
    const report = playbookCoverage(["hydra-dev", "hydra-brand-new"], REGISTRY, {});
    assert.deepEqual(report.uncovered, ["hydra-brand-new"]);
    const redundant = playbookCoverage(["hydra-dev"], REGISTRY, { "hydra-dev": "x", "nope": "y" });
    assert.deepEqual(redundant.redundantDocsOnly, ["hydra-dev"]);
    assert.deepEqual(redundant.unknownDocsOnly, ["nope"]);
  });
});
