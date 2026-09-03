/**
 * Claw Street Bets founding-pack outcomes draft (issue #4319, map #4313).
 *
 * Two jobs:
 *
 *   1. Prove the drafted `docs/targets/claw-street-bets/direction/outcomes.yaml`
 *      is genuinely "ready to drop into the CSB config": it must load through
 *      the REAL loader (`src/outcomes.ts`, the flat grammar in
 *      `src/config-yaml.ts`) with zero errors and carry the contract the
 *      founding grill resolved (#4314 round 2, decision 13) — exactly one
 *      terminal outcome (real-money P&L net of fees) plus the leading paper
 *      metrics, and the builder-self share carried verbatim.
 *
 *   2. PIN THE PRE-REGISTERED GRADUATION GATE. The gate is operator-only-
 *      editable by convention — the system being measured must never move its
 *      own gate — and in this repo that convention is enforced by THIS test:
 *      every number in the gate block is asserted below, so a PR that lowers
 *      the bar reddens the required `test` job unless it also rewrites these
 *      assertions, which puts the change in the diff for the operator. If you
 *      are an agent and this test is red because you edited the gate: revert
 *      the gate edit. Only the operator changes these numbers, by hand, in an
 *      operator-approved PR.
 *
 * Resolved relative to THIS test file (the worktree checkout), never
 * HYDRA_ROOT, so the assertions read the same tree the `test` job checks out
 * (same precedent as test/outcomes-producer.test.mts).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadOutcomes, type Outcome } from "../src/outcomes.ts";

const here = dirname(fileURLToPath(import.meta.url));
const DRAFT_PATH = resolve(here, "../docs/targets/claw-street-bets/direction/outcomes.yaml");
const LIVE_PATH = resolve(here, "../config/direction/outcomes.yaml");

async function loadDraft(): Promise<Outcome[]> {
  const loaded = await loadOutcomes(DRAFT_PATH);
  assert.equal(
    loaded.ok,
    true,
    `CSB outcomes draft must parse through the real loader: ${JSON.stringify((loaded as any).errors)}`,
  );
  return loaded.outcomes;
}

const LEADING_PAPER_NAMES = [
  "paper-net-sharpe-annualized",
  "paper-net-expectancy-per-trade",
  "paper-max-drawdown-pct",
  "paper-settled-trade-count-cumulative",
  "paper-vs-backtest-fill-divergence",
] as const;

describe("CSB founding pack — outcomes.yaml draft loads through the real loader (#4319)", () => {
  test("parses with zero errors and every outcome is a file source", async () => {
    const outcomes = await loadDraft();
    assert.ok(outcomes.length >= 7, "builder-self + terminal + five leading paper outcomes");
    for (const o of outcomes) {
      assert.equal(o.source, "file", `${o.name} must be source: file (the only implemented adapter)`);
      assert.ok(o.query.endsWith(".txt"), `${o.name} query must be a single-value file`);
    }
  });

  test("declares EXACTLY one terminal outcome: real-money cumulative P&L net of fees, direction up, honest 0 baseline", async () => {
    const outcomes = await loadDraft();
    const terminal = outcomes.filter((o) => o.kind === "terminal");
    assert.equal(terminal.length, 1, "one terminal outcome — the business metric (#4301 lesson)");
    const pnl = terminal[0];
    assert.equal(pnl.name, "real-money-cumulative-pnl-net");
    assert.equal(pnl.direction, "up");
    assert.equal(pnl.baseline, 0, "reads 0 until graduation — the true sum of an empty real-money ledger");
    assert.ok(pnl.target > 0, "terminal target is a positive P&L milestone");
    assert.equal(pnl.query, "metrics/csb/real-money-cumulative-pnl-net.txt");
    assert.equal(
      pnl.attribution_window_ms,
      undefined,
      "attribution_window_ms is only meaningful for leading outcomes",
    );
  });

  test("declares the five leading paper metrics, each with its own attribution window and a csb metrics path", async () => {
    const outcomes = await loadDraft();
    const byName = new Map(outcomes.map((o) => [o.name, o]));
    for (const name of LEADING_PAPER_NAMES) {
      const o = byName.get(name);
      assert.ok(o, `leading outcome ${name} must be declared`);
      assert.equal(o.kind, "leading", `${name} must be kind: leading`);
      assert.equal(o.query, `metrics/csb/${name}.txt`, `${name} query is mechanically derived from its name`);
      assert.ok(
        typeof o.attribution_window_ms === "number" && o.attribution_window_ms > 0,
        `${name} must size its own attribution window (#2632)`,
      );
    }
    // Favourable directions: Sharpe / expectancy / trade count go up; drawdown
    // and fill divergence go down.
    assert.equal(byName.get("paper-net-sharpe-annualized")!.direction, "up");
    assert.equal(byName.get("paper-net-expectancy-per-trade")!.direction, "up");
    assert.equal(byName.get("paper-settled-trade-count-cumulative")!.direction, "up");
    assert.equal(byName.get("paper-max-drawdown-pct")!.direction, "down");
    assert.equal(byName.get("paper-vs-backtest-fill-divergence")!.direction, "down");
  });

  test("leading targets mirror the gate's floors (Sharpe 2.0, expectancy 0.5c, backstop 20%, 2x400 trades, divergence tolerance 0.25c)", async () => {
    const outcomes = await loadDraft();
    const byName = new Map(outcomes.map((o) => [o.name, o]));
    assert.equal(byName.get("paper-net-sharpe-annualized")!.target, 2.0);
    assert.equal(byName.get("paper-net-expectancy-per-trade")!.target, 0.5);
    assert.equal(byName.get("paper-max-drawdown-pct")!.baseline, 20);
    assert.equal(byName.get("paper-settled-trade-count-cumulative")!.target, 800);
    assert.equal(byName.get("paper-vs-backtest-fill-divergence")!.baseline, 0.25);
  });

  test("carries the builder-self orchestrator-self-improvement-share outcome verbatim from the live orchestrator file", async () => {
    const draft = await loadDraft();
    const live = await loadOutcomes(LIVE_PATH);
    assert.equal(live.ok, true, `live outcomes.yaml must parse: ${JSON.stringify((live as any).errors)}`);
    const draftShare = draft.find((o) => o.name === "orchestrator-self-improvement-share");
    const liveShare = live.outcomes.find((o) => o.name === "orchestrator-self-improvement-share");
    assert.ok(liveShare, "live file declares the builder-self share");
    assert.ok(draftShare, "the CSB draft must carry the builder-self share (ADR-0013 §3: the 25% floor survives the swap)");
    assert.deepEqual(draftShare, liveShare, "carried verbatim — same query, baseline, target, noise");
  });
});

// ---------------------------------------------------------------------------
// The gate block is a comment (the outcomes grammar admits only `outcomes:`),
// so it is pinned lexically: each `key: value` line inside the delimited block
// is asserted by regex against the raw text.
// ---------------------------------------------------------------------------

describe("CSB founding pack — pre-registered graduation gate is pinned (operator-only-editable)", () => {
  async function gateBlock(): Promise<string> {
    const raw = await readFile(DRAFT_PATH, "utf-8");
    const begin = raw.indexOf("=== PRE-REGISTERED GRADUATION GATE — BEGIN");
    const end = raw.indexOf("=== PRE-REGISTERED GRADUATION GATE — END");
    assert.ok(begin >= 0, "gate block BEGIN marker present");
    assert.ok(end > begin, "gate block END marker present after BEGIN");
    return raw.slice(begin, end);
  }

  test("states the operator-only edit convention and names this test as its enforcement", async () => {
    const block = await gateBlock();
    assert.match(block, /EDIT CONVENTION — operator-only/);
    assert.match(block, /test\/csb-founding-pack-outcomes\.test\.mts/);
    assert.match(block, /operator-approved/);
    assert.match(block, /NO number below is lowered/);
  });

  test("per-stage floors: >= 400 settled paper trades AND >= 180 calendar days", async () => {
    const block = await gateBlock();
    assert.match(block, /min_settled_paper_trades:\s+400\b/);
    assert.match(block, /min_calendar_days:\s+180\b/);
  });

  test("Stage A screen: net Sharpe >= max(2.0, SR0(k)), beats p95 of >= 200 random-entry controls, expectancy >= 0.5 x c", async () => {
    const block = await gateBlock();
    assert.match(block, /net_sharpe_floor:\s+"max\(2\.0, SR0\(k, window\)\)"/);
    assert.match(block, /net_sharpe_floor_min:\s+2\.0\b/);
    assert.match(block, /control_fleet_min_paths:\s+200\b/);
    assert.match(block, /control_fleet_percentile:\s+95\b/);
    assert.match(block, /net_expectancy_floor_x_cost:\s+0\.5\b/);
  });

  test("Stage B confirm: frozen parameters, PSR(0) >= 0.95, earliest day 180, hard fail day 365", async () => {
    const block = await gateBlock();
    assert.match(block, /frozen_parameters:\s+true\b/);
    assert.match(block, /psr_min:\s+0\.95\b/);
    assert.match(block, /earliest_day:\s+180\b/);
    assert.match(block, /hard_fail_day:\s+365\b/);
  });

  test("max drawdown: fail-fast at control-fleet p95, absolute backstop 20%", async () => {
    const block = await gateBlock();
    assert.match(block, /fail_fast:\s+"paper MDD > p95 of the control fleet's MDD/);
    assert.match(block, /absolute_backstop_pct:\s+20\b/);
  });

  test("fill-model honesty: divergence <= 0.25 x c per rolling 100 trades, fill rate +/-10 pp, breached periods never count", async () => {
    const block = await gateBlock();
    assert.match(block, /pnl_divergence_x_cost:\s+0\.25\b/);
    assert.match(block, /pnl_divergence_window_trades:\s+100\b/);
    assert.match(block, /fill_rate_tolerance_pp:\s+10\b/);
    assert.match(block, /divergent_period_counts:\s+false\b/);
  });

  test("multiple testing: append-only trial ledger over a trailing 24 months, failures never deleted", async () => {
    const block = await gateBlock();
    assert.match(block, /trial_ledger:\s+"append-only; k = every strategy that ever entered Stage A"/);
    assert.match(block, /trailing_months:\s+24\b/);
    assert.match(block, /failures_deleted:\s+never\b/);
  });
});
