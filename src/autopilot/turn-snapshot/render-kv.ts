/**
 * turn-snapshot/render-kv.ts — the `kv` renderer: the Turn Snapshot as the
 * flat `key=value` lines `decide.py` / `merge-signals.py` read today
 * (ADR-0043 Decision 4). Until slice 6 switches the wire to JSON, every line
 * here must be byte-identical to what the strangled bash printed, and a
 * degraded field renders as that field's historical fallback (`none`, empty,
 * `false`) — this is the ONE place that mapping lives.
 */

import type { PrGateSnapshot, PrPick } from "./pr-gate.ts";
import type { CandidateExclusionRecord, PicksSnapshot } from "./picks.ts";

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

// --- slice 3 (#4931): grill/dev-ready picks, Candidate Exclusions, active dev_orch ---

const anchor = (n: number | null) => (n === null ? "none" : `issue-${n}`);

/** Python's `json.dumps(records)` (default `, ` / `: ` separators; every value is ASCII). */
function pyDumpsRecords(records: readonly CandidateExclusionRecord[]): string {
  const q = (v: string) => JSON.stringify(v);
  const rows = records.map(
    (r) => `{"anchor": ${q(r.anchor)}, "member": ${q(r.member)}, "verdict": ${q(r.verdict)}, "evidence": ${q(r.evidence)}}`,
  );
  return `[${rows.join(", ")}]`;
}

/** The picks signal lines, in collect-state.sh's emit order, newline-terminated. */
export function renderPicksKv(s: PicksSnapshot): string {
  return [
    `orch_pending_grill_anchor=${anchor(s.grillPick)}`,
    `orch_dev_ready_anchor=${anchor(s.devReadyPick)}`,
    `candidate_exclusions_json=${pyDumpsRecords(s.candidateExclusions)}`,
    `active_dev_orch=${s.activeDevOrch}`,
  ]
    .map((l) => `${l}\n`)
    .join("");
}

/** The shell assignment collect-state.sh reads back: the ORCH_BOARD_DEGRADED accumulator (#4130) its still-bash arch block consumes. */
export function renderPicksExports(s: PicksSnapshot): string {
  return `ORCH_BOARD_DEGRADED=${s.boardDegraded ? 1 : 0}\n`;
}
