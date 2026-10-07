/**
 * turn-snapshot/target-scan-boards.ts — the Target scan-board signals
 * (ADR-0043 slice 4, issue #4932), moved whole out of `collect-state.sh`'s
 * `collect_target_scan_boards`: the cleanup / wire-or-retire / design-QA
 * dispatch gates plus the advisory truncation and degradation keys.
 *
 * ONE read: the open Target issues with their label names (the same
 * `gh issue list --json number,labels --jq …` call the bash issued). Two
 * inputs arrive from outside the collector because they belong to other
 * collectors: the lane-degraded accumulator (#4130, set by the target-board
 * collector — a failed counts read must still flip
 * `target_board_signals_degraded` here) and the orchestrator work-queue
 * length (`backfill_idle`, read by the still-bash arch-cleanup collector).
 *
 * Semantics (unchanged; history in the issues):
 *   truncated   len(rows) ≥ the page size — advisory (#3710)
 *   backfill_idle  no triage, no ready-for-agent, empty work queue
 *   cleanup     saturated when > 10 open `cleanup-scan` items
 *   wire-or-retire  available iff some item carries BOTH `wire-or-retire` AND
 *               `needs-triage` (#3726 — the AND is load-bearing); `unlabelled`
 *               counts wire-or-retire items with no lifecycle label (#3973)
 *   design-qa   saturated when > 5 open `design-qa` items; due iff not
 *               saturated AND a design-language ADR exists under the Target
 *               workspace (#4528 — `docs/adr/*design-language*.md`)
 * A failed read fails CLOSED to the suppressing defaults and latches the lane
 * accumulator.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { TARGET_BOARD_LABELS } from "../../target-board-labels.ts";
import type { Classified, CollectorOutcome, DegradedMarker } from "./collector.ts";
import type { TurnSnapshotGithub } from "./github-port.ts";
import { pyIntOf, pyIsInt } from "./py-compat.ts";

export const TARGET_SCAN_BOARDS_COLLECTOR = "target-scan-boards";

/** The Target labels these gates count — all from the board-label manifest (#3720). */
export const TARGET_SCAN_LABELS = {
  cleanupScan: TARGET_BOARD_LABELS.cleanup_scan,
  wireOrRetire: TARGET_BOARD_LABELS.wire_or_retire,
  designQa: TARGET_BOARD_LABELS.design_qa,
  needsTriage: TARGET_BOARD_LABELS.needs_triage,
  readyForAgent: TARGET_BOARD_LABELS.ready_for_agent,
  readyForHuman: TARGET_BOARD_LABELS.ready_for_human,
  blocked: TARGET_BOARD_LABELS.blocked,
} as const;

export const TARGET_CLEANUP_BOARD_SATURATION_CAP = 10;
export const TARGET_DESIGN_QA_BOARD_SATURATION_CAP = 5;

/** The design-language ADR convention, relative to the Target workspace (#4528; the playbook re-checks it). */
export const DESIGN_QA_ADR_GLOB = "docs/adr/*design-language*.md";

export interface TargetScanSignals {
  readonly truncated: boolean;
  readonly needsTriageItems: readonly number[];
  readonly backfillIdle: boolean;
  readonly cleanupOpenScan: number;
  readonly cleanupSaturated: boolean;
  readonly wireOrRetireTriage: number;
  readonly wireOrRetireUnlabelled: number;
  readonly designQaOpen: number;
  readonly designQaSaturated: boolean;
}

export interface TargetScanSnapshot {
  /** The emitted `target_board_signals_degraded` value (the lane accumulator after this read). */
  readonly signalsDegraded: boolean;
  /** Fail-closed: degraded → the suppressing defaults. */
  readonly signals: Classified<TargetScanSignals>;
  /** Advisory: a design-language ADR exists under the Target workspace. */
  readonly adrPresent: boolean;
}

export interface TargetScanDeps {
  readonly github: Pick<TurnSnapshotGithub, "listOpenIssueLabelNames">;
  readonly ghListLimit: number;
  /** The lane accumulator the target-board collector produced (#4130). */
  readonly laneDegraded: boolean;
  /** The orchestrator work-queue length (`backfill_idle`). */
  readonly workQueue: number;
  /** The Target workspace (`""` = unresolved → no ADR, fail closed). */
  readonly workspace: string;
  /** Defaults to {@link designLanguageAdrPresent} on the real filesystem. */
  readonly adrPresent?: (workspace: string) => boolean;
}

/** Does `<workspace>/docs/adr/*design-language*.md` match a file (shell-glob semantics: no dotfiles)? */
export function designLanguageAdrPresent(workspace: string): boolean {
  if (workspace === "") return false;
  const dir = join(workspace, "docs", "adr");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    /* intentional: a missing workspace / docs/adr is "no design ADR" (the bash glob matched nothing) — fail closed */
    void err;
    return false;
  }
  return names.some((n) => {
    if (n.startsWith(".") || !n.includes("design-language") || !n.endsWith(".md")) return false;
    try {
      return statSync(join(dir, n)).isFile();
    } catch (err) {
      /* intentional: an unreadable entry (dangling symlink) is not a match, as with `[ -f ]` */
      void err;
      return false;
    }
  });
}

/** Classify the open-issue rows (`[{number, labels: [name…]}]`). Pure. */
export function classifyTargetScan(rows: readonly unknown[], opts: { limit: number; workQueue: number }): TargetScanSignals {
  const L = TARGET_SCAN_LABELS;
  let triage = 0;
  const triageNumbers = new Set<number>();
  let queued = 0;
  let openScan = 0;
  let openDesignQa = 0;
  let worTriage = 0;
  let worUnlabelled = 0;
  for (const row of rows) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
    const labels = (row as Record<string, unknown>).labels;
    if (!Array.isArray(labels)) continue;
    const has = (l: string) => labels.includes(l);
    const inTriage = has(L.needsTriage);
    if (inTriage) {
      triage++;
      const num = (row as Record<string, unknown>).number;
      if (pyIsInt(num)) triageNumbers.add(pyIntOf(num));
    }
    if (has(L.readyForAgent)) queued++;
    if (has(L.cleanupScan)) openScan++;
    if (has(L.designQa)) openDesignQa++;
    // The AND is load-bearing (#3726): never relax it to an OR.
    if (has(L.wireOrRetire) && inTriage) worTriage++;
    if (has(L.wireOrRetire) && !(inTriage || has(L.readyForAgent) || has(L.readyForHuman) || has(L.blocked))) worUnlabelled++;
  }
  return {
    truncated: rows.length >= opts.limit,
    needsTriageItems: [...triageNumbers].sort((a, b) => a - b),
    backfillIdle: triage === 0 && queued === 0 && opts.workQueue === 0,
    cleanupOpenScan: openScan,
    cleanupSaturated: openScan > TARGET_CLEANUP_BOARD_SATURATION_CAP,
    wireOrRetireTriage: worTriage,
    wireOrRetireUnlabelled: worUnlabelled,
    designQaOpen: openDesignQa,
    designQaSaturated: openDesignQa > TARGET_DESIGN_QA_BOARD_SATURATION_CAP,
  };
}

/** Gather and classify the scan-board signals. Never throws on a read failure. */
export async function collectTargetScanBoards(deps: TargetScanDeps): Promise<CollectorOutcome<TargetScanSnapshot>> {
  const degraded: DegradedMarker[] = [];
  const adrPresent = (deps.adrPresent ?? designLanguageAdrPresent)(deps.workspace);
  const read = await deps.github.listOpenIssueLabelNames(deps.ghListLimit);
  let signalsDegraded = deps.laneDegraded;
  let signals: Classified<TargetScanSignals>;
  if (read.kind === "empty") {
    signalsDegraded = true;
    signals = { ok: false, reason: "board-read-failed" };
  } else if (read.kind === "unparseable") {
    signals = { ok: false, reason: "unparseable" };
  } else {
    const rows = Array.isArray(read.data) ? read.data : [];
    signals = { ok: true, value: classifyTargetScan(rows, { limit: deps.ghListLimit, workQueue: deps.workQueue }) };
  }
  if ("reason" in signals) degraded.push({ field: "scanSignals", reason: signals.reason });
  return {
    collector: TARGET_SCAN_BOARDS_COLLECTOR,
    value: { signalsDegraded, signals, adrPresent },
    degraded,
    notes: [],
  };
}

/** The snapshot rendered when the collector could not run. */
export function targetScanFallbackSnapshot(reason: string): TargetScanSnapshot {
  return { signalsDegraded: true, signals: { ok: false, reason }, adrPresent: false };
}
