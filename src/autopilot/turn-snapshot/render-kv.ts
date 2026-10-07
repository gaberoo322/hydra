/**
 * turn-snapshot/render-kv.ts — the `kv` renderer: the Turn Snapshot as the
 * flat `key=value` lines `decide.py` / `merge-signals.py` read today
 * (ADR-0043 Decision 4). Until slice 6 switches the wire to JSON, every line
 * here must be byte-identical to what the strangled bash printed, and a
 * degraded field renders as that field's historical fallback (`none`, empty,
 * `false`) — this is the ONE place that mapping lives.
 */

import type { InflightRefs, PrGateSnapshot, PrPick } from "./pr-gate.ts";
import type { OrchBoardSnapshot } from "./orch-board.ts";
import type { Classified } from "./collector.ts";
import { pyJsonDumps } from "./py-compat.ts";

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

/**
 * The orch board lines, newline-terminated (ADR-0043 slice 2): the counts
 * JSON line (absent when withheld), then `orch_needs_triage_items`. Each
 * counts source keeps its historical byte format — the service read went
 * through python's `json.dumps` (`", "` / `": "` separators), the degraded
 * read through gh's `--jq` (compact) — so decide.py sees no change.
 */
export function renderOrchBoardKv(s: OrchBoardSnapshot): string {
  const lines: string[] = [];
  if (s.counts.source === "service") lines.push(pyJsonDumps(s.counts.values));
  else if (s.counts.source === "derived") lines.push(JSON.stringify(s.counts.values));
  lines.push(`orch_needs_triage_items=${s.needsTriageItems.ok ? nums(s.needsTriageItems.value) : ""}`);
  return lines.map((l) => `${l}\n`).join("");
}

/**
 * The board-state reading as the shell assignments collect-state.sh reads back
 * into its globals: ORCH_BOARD_DEGRADED (the #4130 accumulator seed),
 * BOARD_STATE_DEGRADED and BOARD_STATE_JSON (the healthy body, one compact
 * line — the still-bash `glm_withheld` pin guard's source, #4254).
 */
export function renderOrchBoardExports(s: OrchBoardSnapshot): string {
  return [
    `ORCH_BOARD_DEGRADED=${s.orchBoardDegraded ? 1 : 0}\n`,
    `BOARD_STATE_DEGRADED=${s.boardState === null ? 1 : 0}\n`,
    `BOARD_STATE_JSON=${s.boardState === null ? "" : JSON.stringify(s.boardState)}\n`,
  ].join("");
}

/** `untriaged_orphans=N` — a failed read renders `0` (never a spurious sweep). */
export function renderUntriagedOrphansKv(count: Classified<number>): string {
  return `untriaged_orphans=${count.ok ? count.value : 0}\n`;
}

/**
 * `needs_qa_numbers=…` in gh's order. A successful read is followed by an
 * EMPTY line: the bash printed gh's `--jq` string (its own newline) and then
 * a bare `echo` — kept byte-for-byte until the slice-6 JSON switch.
 */
export function renderNeedsQaNumbersKv(numbers: Classified<readonly number[]>): string {
  return numbers.ok ? `needs_qa_numbers=${nums(numbers.value)}\n\n` : "needs_qa_numbers=\n";
}
