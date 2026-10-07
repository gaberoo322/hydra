/**
 * turn-snapshot/render-kv.ts — the `kv` renderer: the Turn Snapshot as the
 * flat `key=value` lines `decide.py` / `merge-signals.py` read today
 * (ADR-0043 Decision 4). Until slice 6 switches the wire to JSON, every line
 * here must be byte-identical to what the strangled bash printed, and a
 * degraded field renders as that field's historical fallback (`none`, empty,
 * `false`) — this is the ONE place that mapping lives.
 */

import type { InflightRefs, PrGateSnapshot, PrPick } from "./pr-gate.ts";

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
