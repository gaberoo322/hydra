/**
 * scripts/qa/pair-graduation.ts — P3 of the two-pass review rollout (issue
 * #5265, ADR-0046 Decision 6).
 *
 * A READ-ONLY, zero-token graduation check for the `two-way-pair` switch. It
 * folds `QA-Shadow:` lines (parsed by src/qa/shadow-fold.ts, never
 * re-implemented) into a readiness report and plans — at most once — the
 * `ready-for-human` flip item. It never calls a model, never writes Redis,
 * never edits config/orchestrator/qa-rollout.json or any repo file; its only
 * side effect is `gh issue create` under `--apply`. The flip itself is an
 * operator-merged config PR (ADR-0046 D6).
 *
 * It also owns the pair-cohort rule (`findOnWindow`, `pairCohortOf`) that
 * scripts/qa/cohort-baseline.ts's `cohortOf` seam delegates to, so the
 * 30-PR cohort trip counts only PRs merged after the `on` flip and never
 * shadow PRs. This file imports nothing from cohort-baseline.ts (no cycle);
 * TRIP_MIN_PAIR_PRS is re-declared and pinned equal by test.
 *
 * NAMED FOLLOW-UP: the pair-cohort rule is tier/door blind (window PRs the
 * pair did not review inflate the pair cohort — the fail-safe direction); a
 * `mode=` field on the `QA-Shadow:` line would let it tighten to
 * `mode=standard` once P2's wiring follow-up lands.
 *
 *   npx tsx scripts/qa/pair-graduation.ts                     # live, dry-run
 *   npx tsx scripts/qa/pair-graduation.ts --apply             # file the flip item
 *   npx tsx scripts/qa/pair-graduation.ts --from-inputs x.json
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseQaShadowLines, type ParsedQaShadowLine } from "../../src/qa/shadow-fold.ts";
import {
  loadRolloutSwitches,
  type TripState,
  type TwoWayPairValue,
} from "../../src/qa/rollout-switches.ts";
import type { QaVerdictTrailer } from "../../src/qa/verdict-trailer.ts";

/** ADR-0046 D6: "about 20 two-way T3 PRs with none". */
export const GRADUATION_MIN_SHADOW_PRS = 20;
/** Re-declared from cohort-baseline.ts MIN_MATURED_PAIR; pinned equal by test. */
export const TRIP_MIN_PAIR_PRS = 30;
export const FLIP_ITEM_TITLE = "Flip two-way-pair: shadow → on (pair graduation ready)";
export const FLIP_ITEM_MARKER = "<!-- pair-graduation-flip two-way-pair -->";
export const FLIP_ITEM_LABEL = "ready-for-human";
export const ROLLOUT_CONFIG_PATH = "config/orchestrator/qa-rollout.json";
const DEFAULT_SINCE = "2026-10-06T21:25:53Z";
const COHORT_FIXTURE_PATH = "test/fixtures/qa-cohort-baseline.json";

// ---------------------------------------------------------------------------
// The `on` window (from git history of the config file) and the pair cohort
// ---------------------------------------------------------------------------

export interface ConfigCommit {
  at: string;
  twoWayPair: unknown;
}
export interface OnWindow {
  onFlipAt: string;
  offFlipAt: string | null;
}

/** Pure. First commit where two-way-pair === "on", and the first later commit where it is not. */
export function findOnWindow(history: ConfigCommit[]): OnWindow | null {
  let onFlipAt: string | null = null;
  for (const c of Array.isArray(history) ? history : []) {
    if (!c || typeof c.at !== "string") continue;
    if (onFlipAt === null) {
      if (c.twoWayPair === "on") onFlipAt = c.at;
    } else if (c.twoWayPair !== "on") {
      return { onFlipAt, offFlipAt: c.at };
    }
  }
  return onFlipAt === null ? null : { onFlipAt, offFlipAt: null };
}

export interface CohortRow {
  number: number;
  mergedAt: string;
  trailers: QaVerdictTrailer[];
  shadowLines: ParsedQaShadowLine[];
}

/** A PR's OWN QA-Shadow lines: attributed by pr=, like QA-Verdict trailers. */
function ownShadowLines(row: { number: number; shadowLines?: ParsedQaShadowLine[] }): ParsedQaShadowLine[] {
  return (Array.isArray(row.shadowLines) ? row.shadowLines : []).filter((l) => l.pr === row.number);
}
/** A shadow PR carries >=1 own line with a numeric pair_miss. */
function isShadowPr(row: { number: number; shadowLines?: ParsedQaShadowLine[] }): boolean {
  return ownShadowLines(row).some((l) => typeof l.pairMiss === "number");
}

/** Pure. `pair` iff merged in the `on` window, trailer-reviewed, and not a shadow PR. */
export function pairCohortOf(
  row: { number: number; mergedAt: string; trailers?: QaVerdictTrailer[]; shadowLines?: ParsedQaShadowLine[] },
  window: OnWindow | null,
): "baseline" | "pair" {
  if (window === null) return "baseline";
  const merged = Date.parse(row.mergedAt);
  const on = Date.parse(window.onFlipAt);
  const off = window.offFlipAt === null ? null : Date.parse(window.offFlipAt);
  if (Number.isNaN(merged) || Number.isNaN(on) || on > merged) return "baseline";
  if (off !== null && !(merged < off)) return "baseline";
  const reviewed = (Array.isArray(row.trailers) ? row.trailers : []).some((t) => t.pr === row.number);
  if (!reviewed || isShadowPr(row)) return "baseline";
  return "pair";
}

// ---------------------------------------------------------------------------
// The readiness fold
// ---------------------------------------------------------------------------

export type GraduationState = "ready" | "collecting" | "not-in-shadow" | "already-on" | "tripped";

export interface GraduationInputs {
  prs: Array<{ number: number; shadowLines: ParsedQaShadowLine[] }>;
  switches: { configured: TwoWayPairValue | string; trip: TripState };
  /** From the committed cohort fixture; null when unreadable. */
  cohortTrip: { pairMatured: number; tripped: boolean; criteriaMet: boolean } | null;
}

export interface GraduationReport {
  state: GraduationState;
  ready: boolean;
  shadow: { measuredPrs: number; pairMissPrs: number; unmeasured: number; needed: number };
  trip: {
    state: TripState;
    pairMatured: number | null;
    needed: number;
    tripped: boolean | null;
    criteriaMet: boolean | null;
  };
  configured: string;
}

/** Pure, never throws; malformed rows warn. */
export function assessPairGraduation(inputs: GraduationInputs): {
  report: GraduationReport;
  warnings: string[];
} {
  const warnings: string[] = [];
  const rows = Array.isArray(inputs?.prs) ? inputs.prs : [];
  let measuredPrs = 0;
  let pairMissPrs = 0;
  let unmeasured = 0;
  const seen = new Set<number>();
  for (const [i, p] of rows.entries()) {
    if (!p || !Number.isInteger(p.number) || p.number < 1) {
      warnings.push(`prs[${i}]: missing number, skipped`);
      continue;
    }
    if (seen.has(p.number)) {
      warnings.push(`prs[${i}] #${p.number}: duplicate PR row, skipped`);
      continue;
    }
    seen.add(p.number);
    const own = ownShadowLines(p);
    const numeric = own.filter((l) => typeof l.pairMiss === "number");
    if (numeric.length > 0) {
      measuredPrs += 1;
      if (numeric.some((l) => (l.pairMiss as number) > 0)) pairMissPrs += 1;
    } else if (own.some((l) => l.pairMiss === "unmeasured")) {
      unmeasured += 1;
    }
  }
  const configured = String(inputs?.switches?.configured ?? "off");
  const tripState: TripState = inputs?.switches?.trip ?? "unknown";
  const ct = inputs?.cohortTrip ?? null;
  if (ct === null) warnings.push("cohort trip fixture unreadable; trip readout is null");

  const ready =
    measuredPrs >= GRADUATION_MIN_SHADOW_PRS &&
    pairMissPrs === 0 &&
    configured === "shadow" &&
    tripState === "not-tripped";
  let state: GraduationState;
  if (configured === "on") state = "already-on";
  else if (configured !== "shadow") state = "not-in-shadow";
  else if (tripState === "tripped") state = "tripped";
  else state = ready ? "ready" : "collecting";

  return {
    report: {
      state,
      ready,
      shadow: { measuredPrs, pairMissPrs, unmeasured, needed: GRADUATION_MIN_SHADOW_PRS },
      trip: {
        state: tripState,
        pairMatured: ct ? ct.pairMatured : null,
        needed: TRIP_MIN_PAIR_PRS,
        tripped: ct ? ct.tripped : null,
        criteriaMet: ct ? ct.criteriaMet : null,
      },
      configured,
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// The flip item (at most one open)
// ---------------------------------------------------------------------------

export interface OpenIssue {
  number: number;
  title: string;
  body?: string | null;
}

export type FlipPlan =
  | { file: false; reason: string; existing: number | null }
  | { file: true; title: string; body: string; labels: string[] };

export function renderFlipItemBody(report: GraduationReport): string {
  return [
    FLIP_ITEM_MARKER,
    "",
    "The two-way review pair has graduated from shadow (ADR-0046 D6).",
    "",
    "## Proposed change",
    "",
    "In `config/orchestrator/qa-rollout.json`:",
    "",
    "```diff",
    '-  "two-way-pair": "shadow"',
    '+  "two-way-pair": "on"',
    "```",
    "",
    "## Evidence snapshot",
    "",
    `- shadow PRs measured: ${report.shadow.measuredPrs} (need ${report.shadow.needed})`,
    `- pair-miss PRs: ${report.shadow.pairMissPrs}`,
    `- unmeasured rounds (neither clean nor miss): ${report.shadow.unmeasured}`,
    `- cohort trip: ${report.trip.state}`,
    "",
    "This flip is operator-merged. It is never autopilot-opened or auto-merged (ADR-0046 D6).",
    "",
  ].join("\n");
}

/** Pure. Files only when ready and no open issue already has the title or marker. */
export function planFlipItem(report: GraduationReport, openIssues: OpenIssue[]): FlipPlan {
  if (!report.ready) return { file: false, reason: `not-ready:${report.state}`, existing: null };
  const dupes = (Array.isArray(openIssues) ? openIssues : []).filter(
    (i) => i && (i.title === FLIP_ITEM_TITLE || (typeof i.body === "string" && i.body.includes(FLIP_ITEM_MARKER))),
  );
  if (dupes.length > 0) {
    return { file: false, reason: "flip-item-already-open", existing: (dupes[0] as OpenIssue).number };
  }
  return { file: true, title: FLIP_ITEM_TITLE, body: renderFlipItemBody(report), labels: [FLIP_ITEM_LABEL] };
}

// ---------------------------------------------------------------------------
// CLI helpers (git / gh) — the pure folds above are the tested surface
// ---------------------------------------------------------------------------

/** Build the config-file history from git on the current checkout. Never throws; [] on failure. */
export function readConfigHistory(repoRoot: string = process.cwd()): ConfigCommit[] {
  const run = (args: string[]): string =>
    execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  try {
    const log = run(["log", "--reverse", "--format=%H%x09%cI", "--", ROLLOUT_CONFIG_PATH]);
    const out: ConfigCommit[] = [];
    for (const line of log.split("\n").filter(Boolean)) {
      const [sha, at] = line.split("\t");
      let twoWayPair: unknown = undefined;
      try {
        twoWayPair = (JSON.parse(run(["show", `${sha}:${ROLLOUT_CONFIG_PATH}`])) as Record<string, unknown>)[
          "two-way-pair"
        ];
      } catch (err) {
        console.error(`[pair-graduation] unreadable config at ${sha}:`, err);
      }
      out.push({ at: at as string, twoWayPair });
    }
    return out;
  } catch (err) {
    console.error("[pair-graduation] git history of the rollout config unreadable:", err);
    return [];
  }
}

async function harvestShadowPrs(repo: string, since: string): Promise<GraduationInputs["prs"]> {
  const { ghJson } = await import("../../src/github/gh.ts");
  const opts = { timeout: 300_000, maxBuffer: 256 * 1024 * 1024 };
  const get = async <T>(path: string): Promise<T[]> => {
    const res = await ghJson<T[][]>(["api", path, "--paginate", "--slurp"], opts);
    if (res.ok === false) throw new Error(`gh api ${path} failed: ${res.code}`);
    return res.data.flat();
  };
  const all = await get<{ number: number; pull_request?: { merged_at: string | null } }>(
    `repos/${repo}/issues?state=all&since=${encodeURIComponent(since)}&per_page=100`,
  );
  const prs: GraduationInputs["prs"] = [];
  for (const it of all) {
    if (!it.pull_request?.merged_at) continue;
    const comments = await get<{ body: string | null }>(`repos/${repo}/issues/${it.number}/comments?per_page=100`);
    const reviews = await get<{ body: string | null }>(`repos/${repo}/pulls/${it.number}/reviews?per_page=100`);
    const shadowLines = [...comments, ...reviews]
      .flatMap((c) => parseQaShadowLines(c.body))
      .filter((l) => l.pr === it.number);
    if (shadowLines.length > 0) prs.push({ number: it.number, shadowLines });
  }
  return prs;
}

function readCohortTrip(repoRoot: string): GraduationInputs["cohortTrip"] {
  try {
    const m = (JSON.parse(readFileSync(`${repoRoot}/${COHORT_FIXTURE_PATH}`, "utf8")) as any)?.metrics;
    return {
      pairMatured: Number(m?.cohorts?.pair?.matured ?? 0),
      tripped: m?.tripped === true,
      criteriaMet: m?.criteriaMet === true,
    };
  } catch (err) {
    console.error("[pair-graduation] cohort fixture unreadable:", err);
    return null;
  }
}

const isMain = (() => {
  try {
    return (
      Array.isArray(process.argv) &&
      process.argv[1] !== undefined &&
      import.meta.url === `file://${process.argv[1]}`
    );
  } catch {
    /* intentional: import.meta unavailable outside a module host — not the CLI */
    return false;
  }
})();

if (isMain) {
  const arg = (flag: string): string | null => {
    const i = process.argv.indexOf(flag);
    return i === -1 || i === process.argv.length - 1 ? null : (process.argv[i + 1] as string);
  };
  const repo = arg("--repo") ?? "gaberoo322/hydra";
  const apply = process.argv.includes("--apply");
  const fromInputs = arg("--from-inputs");
  const repoRoot = process.cwd();

  let inputs: GraduationInputs;
  let openIssues: OpenIssue[] = [];
  if (fromInputs !== null) {
    const doc = JSON.parse(readFileSync(fromInputs, "utf8"));
    inputs = doc.inputs ?? doc;
    openIssues = doc.openIssues ?? [];
  } else {
    try {
      const sw = await loadRolloutSwitches(repoRoot);
      inputs = {
        prs: await harvestShadowPrs(repo, DEFAULT_SINCE),
        switches: { configured: sw.configured["two-way-pair"], trip: sw.trip.state },
        cohortTrip: readCohortTrip(repoRoot),
      };
      const { ghJson } = await import("../../src/github/gh.ts");
      const res = await ghJson<OpenIssue[]>(
        [
          "issue", "list", "--repo", repo, "--label", FLIP_ITEM_LABEL, "--state", "open",
          "--limit", "200", "--json", "number,title,body",
        ],
        { timeout: 60_000 },
      );
      if (res.ok === false) throw new Error(`gh issue list failed: ${res.code}`);
      openIssues = res.data;
    } catch (err) {
      console.error("[pair-graduation] harvest failed:", err);
      process.exit(1);
    }
  }
  const { report, warnings } = assessPairGraduation(inputs);
  for (const w of warnings) console.error(`[pair-graduation] warning: ${w}`);
  const plan = planFlipItem(report, openIssues);
  let flipItem: Record<string, unknown>;
  if (plan.file === false) {
    flipItem = { filed: false, existing: plan.existing, reason: plan.reason };
  } else if (!apply) {
    flipItem = { filed: false, wouldFile: { title: plan.title, labels: plan.labels, body: plan.body } };
  } else {
    try {
      const url = execFileSync(
        "gh",
        ["issue", "create", "--repo", repo, "--title", plan.title, "--body", plan.body, "--label", FLIP_ITEM_LABEL],
        { encoding: "utf8" },
      ).trim();
      flipItem = { filed: true, url };
    } catch (err) {
      console.error("[pair-graduation] gh issue create failed:", err);
      process.exit(1);
    }
  }
  process.stdout.write(JSON.stringify({ report, flipItem }, null, 2) + "\n", () => process.exit(0));
}
