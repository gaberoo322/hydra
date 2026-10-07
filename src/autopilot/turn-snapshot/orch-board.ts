/**
 * turn-snapshot/orch-board.ts — the orch board, untriaged-orphan and needs-qa
 * collectors (ADR-0043 slice 2, issue #4930), moved whole — fetch included —
 * out of `collect-state.sh`'s `collect_orch_board`,
 * `collect_untriaged_orphans` and `collect_needs_qa_numbers`.
 *
 * Shape (the slice-1 / ADR-0040 Decision 2 precedent): pure classifiers over
 * typed reads ({@link healthyBoardState}, {@link needsTriageItems},
 * {@link countUntriagedOrphans}, {@link needsQaNumbers}) plus three
 * orchestrating collectors over injected deps.
 *
 *   orch-board        the board COUNTS line + `orch_needs_triage_items`.
 *                     PRIMARY read: `GET /autopilot/board-state` through the
 *                     hydra HTTP adapter (issue #934). When that read fails —
 *                     service down, `degraded: true`, a non-object or a body
 *                     without `ready_for_agent` — the DEGRADED path imports
 *                     `deriveBoardState` (src/autopilot/board-state.ts) and
 *                     feeds it the gh port's open-issue rows: ONE predicate,
 *                     no second-language copy (ADR-0043 Decision 2 deleted the
 *                     jq re-implementation and its hardcoded 5400/43200
 *                     windows; the windows are `STALE_*_SECONDS` in
 *                     src/board-labels.ts). The degraded path is reached when
 *                     the service — and so its Redis-backed GLM drainer
 *                     heartbeat — is unreachable, which IS the stale-heartbeat
 *                     condition: `glmPartitionActive=false`, so `glm-eligible`
 *                     rows are counted (fail-open toward work, #3754 /
 *                     ADR-0032), and no open-blocker set is resolved (the
 *                     #3059 strict-blocker exclusion stays endpoint-only, as
 *                     it always was). A FAILED fallback read emits NO counts
 *                     line and flips the orch-lane degraded accumulator — a
 *                     failed read must never masquerade as an all-zero board
 *                     (#4130). `orch_needs_triage_items` (#3939) is a
 *                     standalone needs-triage read, served whichever branch
 *                     produced the counts; a failed read emits it empty
 *                     (decide.py then fails open on the coarse count, #3709).
 *   untriaged-orphans the count of open issues carrying NONE of
 *                     {@link UNTRIAGED_ORPHAN_EXCLUDED_LABELS} and no
 *                     `wayfinder:`-prefixed label (#2426 and the issues on
 *                     each label below). Standalone read; failure → 0, so a
 *                     gh outage never spuriously fires a sweep.
 *   needs-qa          the open `needs-qa` issue numbers in gh's DEFAULT order
 *                     — the same unsorted query hydra-qa self-selects with,
 *                     so `[0]` is the issue QA reviews next (#3829 INV-4: a
 *                     numeric sort would break that parity). Failure → empty
 *                     (decide.py treats it as absent and fails open).
 *
 * The board-state reading also feeds the still-bash grill-candidate collector
 * (the `glm_withheld` pin guard, #4254) and the ARCH block's degraded
 * accumulator; the CLI hands those back through `--exports-file`
 * (`renderOrchBoardExports`). Never throws: every read failure is a
 * `DegradedMarker` plus the verbatim stderr note the bash printed.
 */

import { deriveBoardState } from "../board-state.ts";
import { ORCH_BOARD_LABELS } from "../../board-labels.ts";
import { parseIssueRows } from "../../github/issues.ts";
import type { Classified, CollectorOutcome, DegradedMarker } from "./collector.ts";
import type { GhJsonRead, TurnSnapshotGithub } from "./github-port.ts";
import type { HydraRead, TurnSnapshotHydra } from "./hydra-http.ts";
import { pyJsonLoads, pyTruthy } from "./py-compat.ts";

export const ORCH_BOARD_COLLECTOR = "orch-board";
export const UNTRIAGED_ORPHANS_COLLECTOR = "untriaged-orphans";
export const NEEDS_QA_COLLECTOR = "needs-qa";

/** The board-state count keys, in the emitted line's order (the `deriveBoardState` projection). */
export const BOARD_COUNT_KEYS = [
  "needs_qa",
  "ready_for_agent",
  "needs_triage",
  "needs_research",
  "in_progress",
  "blocked",
  "stale_in_progress",
  "stale_blocked",
] as const;
export type BoardCountKey = (typeof BOARD_COUNT_KEYS)[number];
export type DerivedBoardCounts = ReturnType<typeof deriveBoardState>;

/** Where this turn's board counts came from — the renderer prints each source in its historical format. */
export type BoardCounts =
  /** The service's own counts, verbatim per key (the healthy path). */
  | { readonly source: "service"; readonly values: Readonly<Record<BoardCountKey, unknown>> }
  /** `deriveBoardState` over the gh rows (the degraded path). */
  | { readonly source: "derived"; readonly values: DerivedBoardCounts }
  /** No counts line this turn (withheld — see `reason`). */
  | { readonly source: "none"; readonly reason: string };

export interface OrchBoardSnapshot {
  readonly counts: BoardCounts;
  /** The parsed healthy board-state body (the `glm_withheld` source), or `null` when the service read was unusable. */
  readonly boardState: Readonly<Record<string, unknown>> | null;
  /** The #4130 orch-lane accumulator seed: a counts read FAILED this turn. */
  readonly orchBoardDegraded: boolean;
  /** `orch_needs_triage_items` (#3939), ascending; degraded → empty. */
  readonly needsTriageItems: Classified<readonly number[]>;
}

export interface OrchBoardDeps {
  readonly github: Pick<TurnSnapshotGithub, "listOpenIssueBoardRows" | "openIssueNumbersByLabel">;
  readonly hydra: Pick<TurnSnapshotHydra, "orchBoardState">;
  /** Epoch milliseconds — the degraded path's staleness clock. */
  readonly now: () => number;
  /** `gh … --limit` page size (collect-state.sh's GH_ISSUE_LIST_LIMIT). */
  readonly ghListLimit: number;
}

// ---------------------------------------------------------------------------
// Pure classifiers
// ---------------------------------------------------------------------------

/**
 * The healthy-read test the bash applied to the service body: a JSON object,
 * not `degraded` (Python truthiness — `null`/`0`/absent read as healthy), and
 * carrying `ready_for_agent`. Returns the body, or `null` when unusable.
 */
/** A service read as the Python `json.load` the bash piped it through saw it. */
export function serviceJsonRead(read: HydraRead): GhJsonRead {
  if (read.kind === "failed") return { kind: "empty" };
  const parsed = pyJsonLoads(read.body);
  return "error" in parsed ? { kind: "unparseable", error: parsed.error } : { kind: "ok", data: parsed.value };
}

/** Why a service read is unusable, for the degraded marker and the diagnostic line. */
function serviceFailureReason(read: HydraRead, json: GhJsonRead): string {
  if (read.kind === "failed") return read.reason;
  if (json.kind === "unparseable") return `unparseable: ${json.error}`;
  return "degraded-or-incomplete-body";
}

export function healthyBoardState(read: GhJsonRead): Readonly<Record<string, unknown>> | null {
  if (read.kind !== "ok") return null;
  const d = read.data;
  if (d === null || typeof d !== "object" || Array.isArray(d)) return null;
  const body = d as Record<string, unknown>;
  if (pyTruthy(body.degraded)) return null;
  return Object.hasOwn(body, "ready_for_agent") ? body : null;
}

/** Numbers from a `[{"number": N}, …]` read, or `null` when the read failed / is not a list. */
function issueNumbers(read: GhJsonRead): number[] | null {
  if (read.kind !== "ok" || !Array.isArray(read.data)) return null;
  const out: number[] = [];
  for (const r of read.data) {
    const n = r !== null && typeof r === "object" ? (r as { number?: unknown }).number : undefined;
    if (typeof n === "number") out.push(n);
  }
  return out;
}

/** `orch_needs_triage_items`: the open needs-triage numbers, ascending (decide.py parses them into a set). */
export function needsTriageItems(read: GhJsonRead): Classified<readonly number[]> {
  const nums = issueNumbers(read);
  return nums === null ? { ok: false, reason: "read-failed" } : { ok: true, value: [...nums].sort((a, b) => a - b) };
}

/** `needs_qa_numbers`: the open needs-qa numbers in gh's default order — NEVER sorted (#3829 INV-4). */
export function needsQaNumbers(read: GhJsonRead): Classified<readonly number[]> {
  const nums = issueNumbers(read);
  return nums === null ? { ok: false, reason: "read-failed" } : { ok: true, value: nums };
}

/**
 * The lifecycle / parking labels that make an open issue NOT an untriaged
 * orphan (#2426): the dev_orch path keys only on `ready-for-agent` and the
 * triage path only on `needs-triage`, so an issue carrying none of these is
 * invisible to both and the `untriaged_orphans_orch` signal fires sweep_orch
 * to route it. Every entry is EXACT-name; the wayfinder family is a prefix
 * test ({@link WAYFINDER_LABEL_PREFIX}). Why each parking label is here:
 *
 *   - `ready-for-human` (#2828): a terminal operator queue (e.g. a hydra-grill
 *     handoff, ADR-0034 §8.1) — counting it re-triaged the queue every turn.
 *   - `needs-info` (#2958): parked for operator ACs / a design pick; sweep
 *     cannot advance it (run 038937ae churn).
 *   - `needs-tickets` (#3817): a standalone parking lane whose consumer is the
 *     `tickets_orch` producer (#4014); sweep has no rule for it.
 *   - `hitl-grill` (#4025): a TERMINAL park state no agent may action;
 *     counting it drained the very inbox the label holds.
 *   - `needs-dev-resume` (#4220): tracked in-flight state — reap.py's dev_orch
 *     stall backstop (#3866) queues a resume on `state.dev_resume_pending`,
 *     and hydra-qa's GLM-PR bounce (#4460 INV-7) routes the forward-fix lane
 *     through it. Counting it (run 9b671faa) fired a sweep that relabelled the
 *     anchor out from under the queued resume.
 *
 * Deliberately NOT here: `needs-design-concept` (#4096 removed it — without
 * `ready-for-agent` it is an unreachable lane whose only recovery is this
 * backstop; with `ready-for-agent` it stays excluded via that entry), and
 * `meta-friction` (the backstop's motivating example). Producer/category
 * tags (`design-qa`, `cleanup-scan`, `architecture-scan`, `tool-scout`),
 * PR-only labels (`operator-approved`, `glm-authored`, `merge-ready`,
 * `ready-for-merge`, `no-rebase`) and modifier tags (`keep-open`,
 * `design-concept-exempt`, `glm-eligible`, `glm-withhold`, …) always ride
 * alongside a lifecycle label, so they are audited out, not added.
 */
export const UNTRIAGED_ORPHAN_EXCLUDED_LABELS: readonly string[] = [
  ORCH_BOARD_LABELS.ready_for_agent,
  ORCH_BOARD_LABELS.in_progress,
  ORCH_BOARD_LABELS.blocked,
  ORCH_BOARD_LABELS.needs_qa,
  ORCH_BOARD_LABELS.needs_triage,
  ORCH_BOARD_LABELS.needs_research,
  ORCH_BOARD_LABELS.target_backlog,
  "ready-for-human",
  "needs-info",
  "needs-tickets",
  "hitl-grill",
  "needs-dev-resume",
];

/**
 * `wayfinder:*` tickets carry no lifecycle label BY DESIGN (they dispatch via
 * `wayfinder_orch_frontier`), so the family is dropped by PREFIX (#3728) — a
 * future ticket type is covered by construction; an issue with genuinely no
 * labels still matches neither test and stays counted.
 */
export const WAYFINDER_LABEL_PREFIX = "wayfinder:";

/** The untriaged-orphan count over `number,labels` rows, or `null` when the read failed. */
export function countUntriagedOrphans(read: GhJsonRead): number | null {
  if (read.kind !== "ok" || !Array.isArray(read.data)) return null;
  const excluded = new Set(UNTRIAGED_ORPHAN_EXCLUDED_LABELS);
  let count = 0;
  for (const issue of read.data) {
    const labels = issue !== null && typeof issue === "object" ? (issue as { labels?: unknown }).labels : undefined;
    const names = (Array.isArray(labels) ? labels : [])
      .map((l) => (l !== null && typeof l === "object" ? (l as { name?: unknown }).name : undefined))
      .filter((n): n is string => typeof n === "string");
    if (names.some((n) => excluded.has(n))) continue;
    if (names.some((n) => n.startsWith(WAYFINDER_LABEL_PREFIX))) continue;
    count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Collectors
// ---------------------------------------------------------------------------

/** Gather the orch board counts (service, else `deriveBoardState`) + the needs-triage item set. Never throws on a read failure. */
export async function collectOrchBoard(deps: OrchBoardDeps): Promise<CollectorOutcome<OrchBoardSnapshot>> {
  const notes: string[] = [];
  const degraded: DegradedMarker[] = [];
  let counts: BoardCounts;
  let orchBoardDegraded = false;

  const serviceRead = await deps.hydra.orchBoardState();
  const serviceJson = serviceJsonRead(serviceRead);
  const boardState = healthyBoardState(serviceJson);
  if (boardState !== null) {
    const missing = BOARD_COUNT_KEYS.filter((k) => !Object.hasOwn(boardState, k));
    if (missing.length === 0) {
      const values = Object.fromEntries(BOARD_COUNT_KEYS.map((k) => [k, boardState[k]])) as Record<BoardCountKey, unknown>;
      counts = { source: "service", values };
    } else {
      // The bash's python KeyError'd here: no counts line, the accumulator untouched.
      counts = { source: "none", reason: "service-response-missing-keys" };
      degraded.push({ field: "counts", reason: "service-response-missing-keys" });
      notes.push(`turn-snapshot orch-board: board-state response lacks ${missing.join(", ")} — counts line withheld (issue #4930)`);
    }
  } else {
    const why = serviceFailureReason(serviceRead, serviceJson);
    degraded.push({ field: "boardState", reason: why });
    // Not an `orch …` note: the bash printed nothing here, and the golden note set stays exact.
    notes.push(`turn-snapshot orch-board: board-state read unusable (${why}) — deriving counts from the gh board rows (issue #4930)`);
    const rows = await deps.github.listOpenIssueBoardRows(deps.ghListLimit);
    if (rows.kind === "ok" && Array.isArray(rows.data)) {
      counts = { source: "derived", values: deriveBoardState(parseIssueRows(rows.data, ""), deps.now()) };
    } else {
      counts = { source: "none", reason: "fallback-read-failed" };
      orchBoardDegraded = true;
      degraded.push({ field: "counts", reason: "fallback-read-failed" });
      notes.push("orch board read FAILED (fallback board-list query empty) — counts withheld, board flagged degraded (issue #4130)");
    }
  }

  const triage = needsTriageItems(await deps.github.openIssueNumbersByLabel(ORCH_BOARD_LABELS.needs_triage, deps.ghListLimit));
  if ("reason" in triage) degraded.push({ field: "needsTriageItems", reason: triage.reason });

  return {
    collector: ORCH_BOARD_COLLECTOR,
    value: { counts, boardState, orchBoardDegraded, needsTriageItems: triage },
    degraded,
    notes,
  };
}

export interface OrchLaneDeps {
  readonly github: Pick<TurnSnapshotGithub, "listOpenIssueLabelRows" | "openIssueNumbersByLabel">;
  readonly ghListLimit: number;
}

/** The untriaged-orphan backstop count; a failed read is degraded (rendered `0`). */
export async function collectUntriagedOrphans(deps: OrchLaneDeps): Promise<CollectorOutcome<Classified<number>>> {
  const count = countUntriagedOrphans(await deps.github.listOpenIssueLabelRows(deps.ghListLimit));
  const value: Classified<number> = count === null ? { ok: false, reason: "read-failed" } : { ok: true, value: count };
  return {
    collector: UNTRIAGED_ORPHANS_COLLECTOR,
    value,
    degraded: value.ok ? [] : [{ field: "untriagedOrphans", reason: "read-failed" }],
    notes: [],
  };
}

/** The ordered needs-qa issue numbers; a failed read is degraded (rendered empty). */
export async function collectNeedsQaNumbers(deps: OrchLaneDeps): Promise<CollectorOutcome<Classified<readonly number[]>>> {
  const value = needsQaNumbers(await deps.github.openIssueNumbersByLabel(ORCH_BOARD_LABELS.needs_qa, deps.ghListLimit));
  return {
    collector: NEEDS_QA_COLLECTOR,
    value,
    degraded: "reason" in value ? [{ field: "needsQaNumbers", reason: value.reason }] : [],
    notes: [],
  };
}

/** The orch-board snapshot the CLI renders when the collector itself could not run (the all-reads-failed shape). */
export function orchBoardFallbackSnapshot(reason: string): OrchBoardSnapshot {
  return {
    counts: { source: "none", reason },
    boardState: null,
    orchBoardDegraded: true,
    needsTriageItems: { ok: false, reason },
  };
}
