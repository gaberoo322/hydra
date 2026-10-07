/**
 * turn-snapshot/render-kv.ts — the `kv` renderer: the Turn Snapshot as the
 * flat `key=value` lines `decide.py` / `merge-signals.py` read today
 * (ADR-0043 Decision 4). Until slice 6 switches the wire to JSON, every line
 * here must be byte-identical to what the strangled bash printed, and a
 * degraded field renders as that field's historical fallback (`none`, empty,
 * `false`) — this is the ONE place that mapping lives.
 */

import type { InflightRefs, PrGateSnapshot, PrPick } from "./pr-gate.ts";
import { pyJsonDumps } from "./py-compat.ts";
import { TARGET_WIP_LIMIT, type TargetBoardSnapshot } from "./target-board.ts";
import type { TargetRiskSurfaceSnapshot } from "./target-risk-surface.ts";
import type { TargetScanSnapshot } from "./target-scan-boards.ts";

const nums = (xs: readonly number[]) => xs.join(" ");
const pick = (p: PrPick | null) => (p === null ? "none" : `issue-${p.issue}:${p.pr}:${p.headRefName}`);

/** The PR-gate signal lines, in collect-state.sh's emit order, newline-terminated. */
export function renderPrGateKv(s: PrGateSnapshot): string {
  const glm = s.glmRed.ok ? s.glmRed.value : { bucket: [], pick: null };
  const resume = s.devResumePick.ok ? s.devResumePick.value : null;
  const dirtyFix = s.dirtyFix.ok ? s.dirtyFix.value : { pick: null, surface: [] };
  const lines = [
    `orch_prs_dirty=${nums(s.dirty)}`,
    `orch_prs_unchecked=${nums(s.unchecked)}`,
    `orch_prs_behind=${nums(s.behind)}`,
    `orch_ci_trigger_stale=${s.ciTriggerStale.ok && s.ciTriggerStale.value ? "true" : "false"}`,
    `orch_prs_glm_red=${nums(glm.bucket)}`,
    `orch_glm_red_forward_fix=${pick(glm.pick)}`,
    `orch_dev_resume_pick=${pick(resume)}`,
    `orch_dirty_forward_fix=${pick(dirtyFix.pick)}`,
    `orch_prs_dirty_surface=${dirtyFix.surface.map((e) => `${e.pr}:${e.closingIssue ?? "none"}`).join(" ")}`,
  ];
  return lines.map((l) => `${l}\n`).join("");
}

/**
 * The in-flight sets as the shell assignments collect-state.sh reads back into
 * its ORCH_INFLIGHT_* globals (consumed by the still-bash grill-candidate and
 * candidate-exclusion collectors until slice 3 moves them).
 */
export function renderInflightExports(inflight: InflightRefs): string {
  return [
    `ORCH_INFLIGHT_ISSUES=${nums(inflight.union)}\n`,
    `ORCH_INFLIGHT_BRANCH_ISSUES=${nums(inflight.branch)}\n`,
    `ORCH_INFLIGHT_BODYREF_ISSUES=${nums(inflight.body)}\n`,
  ].join("");
}

// ---------------------------------------------------------------------------
// Target-board family (ADR-0043 slice 4, #4932)
// ---------------------------------------------------------------------------

/** The degraded-read count zeros (fallback order) — `target_board_signals_degraded` carries the caveat. */
const TARGET_DEGRADED_COUNTS =
  "target_ready_for_agent=0\ntarget_ready_blocker_excluded=0\ntarget_needs_qa=0\ntarget_needs_triage=0\ntarget_needs_research=0\n";

/** The `collect_target_board` lines, in its emit order. */
export function renderTargetBoardKv(s: TargetBoardSnapshot): string {
  let out = "";
  if (!s.counts.ok) out += TARGET_DEGRADED_COUNTS;
  else if (s.counts.value === null) out += "\n";
  else out += s.counts.value.map(([k, v]) => `${k}=${v}\n`).join("");
  const wip = s.wip.ok ? s.wip.value : { limit: TARGET_WIP_LIMIT, inProgress: 0, live: 0, saturated: false };
  out += `target_wip_limit=${wip.limit}\ntarget_in_progress=${wip.inProgress}\ntarget_wip_live=${wip.live}\ntarget_wip_saturated=${wip.saturated ? "true" : "false"}\n`;
  out += `target_needs_qa_pr_ref=${s.needsQaPr.ref}\ntarget_needs_qa_pr_head=${s.needsQaPr.head}\n`;
  out += `target_dev_resume_pick=${pick(s.devResumePick.ok ? s.devResumePick.value : null)}\n`;
  return out;
}

/** The lane accumulator as the shell assignment collect-state.sh reads back (#4130). */
export function renderTargetBoardExports(s: TargetBoardSnapshot): string {
  return `TARGET_LANE_DEGRADED=${s.laneDegraded ? "1" : "0"}\n`;
}

const bool = (b: boolean) => (b ? "true" : "false");

/** The `collect_target_scan_boards` lines, in its emit order. */
export function renderTargetScanKv(s: TargetScanSnapshot): string {
  const lines = [`target_board_signals_degraded=${bool(s.signalsDegraded)}`];
  if (s.signals.ok) {
    const v = s.signals.value;
    lines.push(
      `target_board_signals_truncated=${bool(v.truncated)}`,
      `target_needs_triage_items=${nums(v.needsTriageItems)}`,
      `target_backfill_idle=${bool(v.backfillIdle)}`,
      `target_cleanup_board_open_scan=${v.cleanupOpenScan}`,
      `target_cleanup_board_saturated=${bool(v.cleanupSaturated)}`,
      `wire_or_retire_target_triage=${v.wireOrRetireTriage}`,
      `wire_or_retire_target_available=${bool(v.wireOrRetireTriage > 0)}`,
      `wire_or_retire_target_unlabelled=${v.wireOrRetireUnlabelled}`,
      `design_qa_target_open=${v.designQaOpen}`,
      `design_qa_target_saturated=${bool(v.designQaSaturated)}`,
      `design_qa_target_adr_present=${bool(s.adrPresent)}`,
      `design_qa_target_due=${bool(!v.designQaSaturated && s.adrPresent)}`,
    );
  } else {
    // Fail closed: never dispatch a scan/resolver that cannot read its own board.
    lines.push(
      "target_board_signals_truncated=false",
      "target_needs_triage_items=",
      "target_backfill_idle=false",
      "target_cleanup_board_open_scan=0",
      "target_cleanup_board_saturated=true",
      "wire_or_retire_target_triage=0",
      "wire_or_retire_target_available=false",
      "wire_or_retire_target_unlabelled=0",
      "design_qa_target_open=0",
      "design_qa_target_saturated=true",
      `design_qa_target_adr_present=${bool(s.adrPresent)}`,
      "design_qa_target_due=false",
    );
  }
  return lines.map((l) => `${l}\n`).join("");
}

/** The `target_risk_surface_json=` line — Python `json.dumps` of the manifest, or the fail-closed object. */
export function renderTargetRiskSurfaceKv(s: TargetRiskSurfaceSnapshot): string {
  const m = s.manifest;
  const payload = "reason" in m ? { ok: false, errors: [`target_risk_surface_json: ${m.reason}`] } : m.value;
  return `target_risk_surface_json=${pyJsonDumps(payload)}\n`;
}
