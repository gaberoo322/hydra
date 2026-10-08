/**
 * turn-snapshot/afk-frontier.ts — the retro, wayfinder-frontier and tickets
 * Turn Snapshot collectors (ADR-0043 slice 5B, #4933): the pre-resolution of
 * "is there a run to retro / a wayfinder ticket / a spec to ticket?" that
 * decide.py stays too pure to do itself. They were collect_retro,
 * collect_wayfinder_frontier and collect_tickets in collect-state.sh.
 *
 * Semantics carried over verbatim (golden files under
 * test/fixtures/turn-snapshot/remaining/ pin the bytes):
 *
 *   - retro (#920, #3871, #4244, #4584): `retro_run_available` is true when the
 *     newest-14 runs index (`GET /autopilot/runs?limit=14`) holds a run whose
 *     `str(status).lower()` is neither "" nor "running" (false on any failed
 *     read — nothing to retro). `retro_run_drillable` reads the FIRST such
 *     run's retro bundle (`GET /autopilot/runs/<run_id>/retro`): false only on
 *     a parsed, `runFound: true` bundle with no flagged dispatch, no
 *     reflections / stuckSignals / recommendations and `runFlagged` not true;
 *     ANY failure reads true (dispatch anyway — a dark learning loop is worse
 *     than a wasted dispatch). No candidate (or one without a run_id) → false.
 *     A FAILED bundle fetch also fired the pipeline's `|| echo "true"`, so that
 *     case carries a second `true` line — kept for byte parity until slice 6.
 *   - wayfinder frontier (#3351, #3354, #3400, ADR-0029): approved maps = open
 *     `wayfinder:map` issues without `wayfinder:destination-pending`, walked in
 *     ascending number order; per map, ONE GraphQL sub-issue read yields the
 *     in-flight count (open + assigned AFK-typed tickets) and — only when that
 *     map has none in flight — the first open, unassigned, unblocked
 *     `wayfinder:research`/`wayfinder:task` ticket. The first map with a pick
 *     wins; in-flight sums over EVERY map. Any failure degrades to `none`.
 *   - tickets (#4014): the oldest (lowest-numbered) open, unassigned
 *     `needs-tickets` issue → `tickets_available=true` +
 *     `tickets_orch_pending_spec=issue-<N>`; otherwise false / none.
 */

import type { Classified, CollectorOutcome, DegradedMarker } from "./collector.ts";
import type { GhJsonRead, TurnSnapshotGithub } from "./github-port.ts";
import type { TurnSnapshotHydra } from "./hydra-http.ts";
import { JqError, jqEquals, jqField, jqIter, jqIterable, jqLength, jqSort, jqText, jqCompare } from "./jq-compat.ts";
import { pyJsonLoads, pyTruthy } from "./py-compat.ts";
import { isPyDict, pyStrValue } from "./py-format.ts";
import { labelNames } from "./board-saturation.ts";

export interface AfkFrontierDeps {
  readonly github: TurnSnapshotGithub;
  /** Only the generic read (the retro runs index + bundle). */
  readonly hydra: Pick<TurnSnapshotHydra, "get">;
  readonly ghListLimit: number;
}

export const RETRO_RUNS_PATH = "/autopilot/runs?limit=14";
export const WAYFINDER_MAP_LABEL = "wayfinder:map";
export const WAYFINDER_DRAFT_LABEL = "wayfinder:destination-pending";
export const WAYFINDER_AFK_TYPES = ["wayfinder:research", "wayfinder:task"] as const;
export const NEEDS_TICKETS_LABEL = "needs-tickets";

const fail = <T>(reason: string): Classified<T> => ({ ok: false, reason });
const okv = <T>(value: T): Classified<T> => ({ ok: true, value });
const outcome = <T>(collector: string, value: T, degraded: DegradedMarker[]): CollectorOutcome<T> => ({ collector, value, degraded, notes: [] });

/** Run a jq-shaped fold over a gh read; a failed read or a jq runtime error is the bash's empty read. */
function jqFold<T>(read: GhJsonRead, fold: (data: unknown) => T): Classified<T> {
  if (read.kind !== "ok") return fail(read.kind === "empty" ? "gh-read-failed" : "unparseable");
  try {
    return okv(fold(read.data));
  } catch (err) {
    if (err instanceof JqError) return fail(`jq: ${err.message}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Retro
// ---------------------------------------------------------------------------

/** `str(r.get('status','')).lower() not in ('', 'running')` over a runs-index entry. */
function isCompletedRun(r: unknown): r is Record<string, unknown> {
  if (!isPyDict(r)) return false;
  const status = pyStrValue("status" in r ? r.status : "").toLowerCase();
  return status !== "" && status !== "running";
}

export interface RetroRuns {
  readonly available: boolean;
  /** The run_id `/hydra-retro` would analyse (`str()` of a truthy run_id), or null. */
  readonly candidate: string | null;
}

/** The two runs-index heredocs: any completed run? and the first completed run's id. */
export function foldRetroRuns(body: string | null): Classified<RetroRuns> {
  if (body === null) return fail("runs-read-failed");
  const parsed = pyJsonLoads(body);
  if (!parsed.ok) return fail("runs-unparseable");
  const d = parsed.value;
  const runs = isPyDict(d) && "runs" in d ? d.runs : [];
  // Python iterates a dict's keys / a str's chars — never dicts; only list items can complete.
  const rows: unknown[] = Array.isArray(runs) ? runs : [];
  const first = rows.find(isCompletedRun);
  if (first === undefined) return okv({ available: false, candidate: null });
  const rid = first.run_id;
  const candidate = pyTruthy(rid) ? pyStrValue(rid).replace(/\n+$/, "") : "";
  return okv({ available: true, candidate: candidate === "" ? null : candidate });
}

/** The bundle heredoc: true unless a parsed, run-found bundle carries nothing to drill. */
export function foldRetroBundle(body: string): boolean {
  const parsed = pyJsonLoads(body);
  if (!parsed.ok) return true;
  const b = parsed.value;
  if (!isPyDict(b)) return true;
  if (b.runFound !== true) return true;
  const dispatches = "dispatches" in b ? b.dispatches : [];
  const anyFlagged = Array.isArray(dispatches) ? dispatches.some((x) => isPyDict(x) && pyTruthy(x.flagged)) : false;
  return anyFlagged || pyTruthy(b.reflections) || pyTruthy(b.stuckSignals) || pyTruthy(b.recommendations) || b.runFlagged === true;
}

export interface RetroValue {
  readonly runs: Classified<RetroRuns>;
  /** null = no candidate run (drillable=false); else the bundle verdict. */
  readonly drillable: boolean | null;
}

export async function collectRetro(deps: AfkFrontierDeps): Promise<CollectorOutcome<RetroValue>> {
  const runsRead = await deps.hydra.get(RETRO_RUNS_PATH);
  const runs = foldRetroRuns(runsRead.kind === "ok" ? runsRead.body : null);
  const candidate = runs.ok ? runs.value.candidate : null;
  if (candidate === null) return outcome("retro", { runs, drillable: null }, "reason" in runs ? [{ field: "retroRuns", reason: runs.reason }] : []);
  const bundle = await deps.hydra.get(`/autopilot/runs/${candidate}/retro`);
  const value: RetroValue = {
    runs,
    drillable: bundle.kind === "ok" ? foldRetroBundle(bundle.body) : true,
  };
  return outcome("retro", value, bundle.kind === "failed" ? [{ field: "retroBundle", reason: bundle.reason }] : []);
}

// ---------------------------------------------------------------------------
// Wayfinder frontier
// ---------------------------------------------------------------------------

/**
 * Python's `int(x)` as `print(int(n))` printed it, or null where it raises
 * (the loop then stops: every later map is dropped, as in the heredoc).
 */
export function pyIntText(x: unknown): string | null {
  if (typeof x === "boolean") return x ? "1" : "0";
  if (typeof x === "number") return Number.isFinite(x) ? BigInt(Math.trunc(x)).toString() : null;
  if (typeof x === "string") {
    const s = x.trim();
    if (!/^[+-]?\d+(?:_\d+)*$/.test(s)) return null;
    return BigInt(s.replaceAll("_", "")).toString();
  }
  return null;
}

/** The approved map numbers, ascending — the maps `--jq` plus the int-printing heredoc. */
export function foldWayfinderMaps(read: GhJsonRead): Classified<string[]> {
  const numbers = jqFold(read, (data) =>
    jqSort(
      jqIter(data)
        .filter((issue) => !labelNames(issue).some((n) => jqEquals(n, WAYFINDER_DRAFT_LABEL)))
        .map((issue) => jqField(issue, "number")),
    ),
  );
  if ("reason" in numbers) return fail(numbers.reason);
  const out: string[] = [];
  for (const n of numbers.value) {
    const text = pyIntText(n);
    if (text === null) break;
    out.push(text);
  }
  return okv(out);
}

const jqGt0 = (v: unknown) => jqCompare(v, 0) > 0;

/**
 * One map's GraphQL `--jq`: `<inflight>` or `<inflight> <pick-number> <pick-type>`
 * (a pick only when nothing is in flight), or failed on a jq runtime error.
 */
export function foldWayfinderMapLine(read: GhJsonRead): Classified<string> {
  return jqFold(read, (data) => {
    const nodes = jqField(jqField(jqField(jqField(jqField(data, "data"), "repository"), "issue"), "subIssues"), "nodes");
    const typed = jqIter(nodes).map((node) => {
      const types = jqIter(jqField(jqField(node, "labels"), "nodes"))
        .map((l) => jqField(l, "name"))
        .filter((n) => WAYFINDER_AFK_TYPES.some((t) => jqEquals(n, t)));
      if (node !== null && node !== undefined && (typeof node !== "object" || Array.isArray(node))) throw new JqError("cannot add object to non-object");
      return { node, type: types[0] ?? null };
    });
    const afk = typed.filter((t) => t.type !== null);
    const open = (t: { node: unknown }) => jqEquals(jqField(t.node, "state"), "OPEN");
    const assignees = (t: { node: unknown }) => jqField(jqField(t.node, "assignees"), "totalCount");
    const inflight = afk.filter((t) => open(t) && jqGt0(assignees(t))).length;
    const pick = afk.filter((t) => {
      if (!(open(t) && jqEquals(assignees(t), 0))) return false;
      const blockers = jqField(jqField(t.node, "blockedBy"), "nodes");
      const openBlockers = (jqIterable(blockers) ? jqIter(blockers) : []).filter((b) => jqEquals(jqField(b, "state"), "OPEN"));
      return jqEquals(jqLength(openBlockers), 0);
    })[0];
    if (inflight > 0 || pick === undefined) return String(inflight);
    return `${inflight} ${jqText(jqField(pick.node, "number"))} ${String(pick.type).replace("wayfinder:", "")}`;
  });
}

export interface WayfinderValue {
  readonly frontier: string | null;
  readonly ticketType: string;
  readonly inflightGlobal: number;
}

/** The bash loop's `cut` fields over each map line: in-flight sum + the first pick. */
export function foldWayfinderFrontier(lines: readonly string[]): WayfinderValue {
  let frontier: string | null = null;
  let ticketType = "";
  let inflightGlobal = 0;
  for (const line of lines) {
    const fields = line.split(" ");
    const inflight = fields[0] ?? "";
    if (/^[0-9]+$/.test(inflight)) inflightGlobal += Number(inflight);
    const hasDelim = line.includes(" ");
    const pickNum = hasDelim ? (fields[1] ?? "") : "";
    if (frontier === null && pickNum !== "") {
      frontier = pickNum;
      ticketType = hasDelim ? (fields[2] ?? "") : "";
    }
  }
  return { frontier, ticketType, inflightGlobal };
}

/**
 * Max concurrent per-map GraphQL reads. The bash walked maps one at a time; an
 * unbounded fan-out (up to the 100-map page) risks GitHub's secondary rate
 * limits on the shared token, so the walk runs a small fixed pool.
 */
export const WAYFINDER_GRAPHQL_CONCURRENCY = 4;

/** `Promise.all(xs.map(fn))` with at most `limit` calls in flight; results stay in input order. */
export async function mapWithConcurrency<T, R>(xs: readonly T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let next = 0;
  const worker = async () => {
    while (next < xs.length) {
      const i = next++;
      out[i] = await fn(xs[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), xs.length) }, worker));
  return out;
}

export async function collectWayfinderFrontier(deps: AfkFrontierDeps): Promise<CollectorOutcome<WayfinderValue>> {
  const maps = foldWayfinderMaps(await deps.github.openIssueLabelsWithLabel(WAYFINDER_MAP_LABEL, deps.ghListLimit));
  const mapNumbers = maps.ok ? maps.value : [];
  const lines = await mapWithConcurrency(mapNumbers, WAYFINDER_GRAPHQL_CONCURRENCY, async (n) =>
    foldWayfinderMapLine(await deps.github.wayfinderMapSubIssues(n)),
  );
  const degraded: DegradedMarker[] = "reason" in maps ? [{ field: "wayfinderMaps", reason: maps.reason }] : [];
  lines.forEach((l, i) => {
    if ("reason" in l) degraded.push({ field: `wayfinderMap:${mapNumbers[i]}`, reason: l.reason });
  });
  return outcome("wayfinder-frontier", foldWayfinderFrontier(lines.map((l) => (l.ok ? l.value : ""))), degraded);
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

/** The oldest unassigned needs-tickets issue number (only a bare digit string is accepted), or null. */
export function foldTicketsPick(read: GhJsonRead): Classified<string | null> {
  const first = jqFold(read, (data) => {
    const numbers = jqIter(data)
      .filter((issue) => jqEquals(jqLength(jqField(issue, "assignees")), 0))
      .map((issue) => jqField(issue, "number"));
    return jqText(jqSort(numbers)[0] ?? null);
  });
  if ("reason" in first) return fail(first.reason);
  return okv(/^[0-9]+$/.test(first.value) ? first.value : null);
}

export async function collectTickets(deps: AfkFrontierDeps): Promise<CollectorOutcome<Classified<string | null>>> {
  const pick = foldTicketsPick(await deps.github.openIssueAssigneesWithLabel(NEEDS_TICKETS_LABEL, deps.ghListLimit));
  return outcome("tickets", pick, "reason" in pick ? [{ field: "ticketsPick", reason: pick.reason }] : []);
}
