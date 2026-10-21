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

import { DEGRADE, type Classified, type CollectorOutcome, type DegradedMarker } from "./collector.ts";
import { parseJsonRead, type GhJsonRead, type TurnSnapshotGithub } from "./github-port.ts";
import type { TurnSnapshotHydra } from "./hydra-http.ts";
import { labelNames, MALFORMED_PAYLOAD } from "./board-saturation.ts";

export interface AfkFrontierDeps {
  readonly github: TurnSnapshotGithub;
  /** Only the generic read (the retro runs index + bundle). */
  readonly hydra: Pick<TurnSnapshotHydra, "get">;
  readonly ghListLimit: number;
}

const RETRO_RUNS_PATH = "/autopilot/runs?limit=14";
const WAYFINDER_MAP_LABEL = "wayfinder:map";
const WAYFINDER_DRAFT_LABEL = "wayfinder:destination-pending";
const WAYFINDER_AFK_TYPES = ["wayfinder:research", "wayfinder:task"] as const;
export const NEEDS_TICKETS_LABEL = "needs-tickets";

const fail = <T>(reason: string): Classified<T> => ({ ok: false, reason });
const okv = <T>(value: T): Classified<T> => ({ ok: true, value });
const outcome = <T>(collector: string, value: T, degraded: DegradedMarker[]): CollectorOutcome<T> => ({ collector, value, degraded, notes: [] });

/**
 * Fold a gh read: a failed / unparseable read keeps its reason; a fold that
 * returns `null` met a {@link MALFORMED_PAYLOAD} shape (the shapes the bash's
 * `--jq` errored on) and the whole read degrades.
 */
function foldRead<T>(read: GhJsonRead, fold: (data: unknown) => T | null): Classified<T> {
  if (read.kind !== "ok") return fail(read.kind === "empty" ? DEGRADE.GH_READ_FAILED : DEGRADE.UNPARSEABLE);
  const value = fold(read.data);
  return value === null ? fail(DEGRADE.MALFORMED_PAYLOAD) : okv(value);
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

/** A list's items or an object's values; `null` for anything else (including the malformed `undefined`). */
const members = (v: unknown): unknown[] | null => (Array.isArray(v) ? v : isObj(v) ? Object.values(v) : null);

/**
 * `v.key` over a decoded payload, null-propagating: `null` for a null value
 * or a missing key; `undefined` — malformed — for a scalar or a list (and for
 * an already-malformed `undefined`). A JSON value is never `undefined`, so the
 * sentinel cannot collide with data.
 */
function at(v: unknown, key: string): unknown {
  if (v === null) return null;
  if (!isObj(v)) return undefined;
  return Object.hasOwn(v, key) ? v[key] : null;
}

/** A field's text as it lands in a frontier line: a string verbatim, anything else as JSON. */
const fieldText = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));

/**
 * Whether a decoded JSON value carries anything: `null`, `false`, `0`, `""`
 * and an EMPTY list or object read as unset; a non-empty list or object does not.
 */
const isSet = (v: unknown): boolean => (v !== null && typeof v === "object" ? Object.keys(v).length > 0 : Boolean(v));

const typeRank = (v: unknown): number =>
  v === null ? 0 : v === false ? 1 : v === true ? 2 : typeof v === "number" ? 3 : typeof v === "string" ? 4 : Array.isArray(v) ? 5 : 6;

/**
 * The order the frontier walks issue `number` values in (the bash's jq
 * `sort`): null < false < true < numbers (ascending) < strings (code-point
 * order) < lists < objects. Two lists / two objects tie — every consumer stops
 * at the first one, so their relative order is never observable.
 */
function numberOrder(a: unknown, b: unknown): number {
  const d = typeRank(a) - typeRank(b);
  if (d !== 0) return d;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") {
    const ca = Array.from(a, (c) => c.codePointAt(0) as number);
    const cb = Array.from(b, (c) => c.codePointAt(0) as number);
    for (let i = 0; i < Math.min(ca.length, cb.length); i++) if (ca[i] !== cb[i]) return (ca[i] as number) - (cb[i] as number);
    return ca.length - cb.length;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Retro
// ---------------------------------------------------------------------------

/**
 * A runs-index entry that has finished: an object whose `status`, lowercased,
 * is neither `""` nor `"running"`. A missing status is unfinished; a
 * non-string one (`null`, a number, …) counts as finished.
 */
function isCompletedRun(r: unknown): r is Record<string, unknown> {
  if (!isObj(r) || !("status" in r)) return false;
  if (typeof r.status !== "string") return true;
  const status = r.status.toLowerCase();
  return status !== "" && status !== "running";
}

export interface RetroRuns {
  readonly available: boolean;
  /** The run_id `/hydra-retro` would analyse (`str()` of a truthy run_id), or null. */
  readonly candidate: string | null;
}

/** The two runs-index heredocs: any completed run? and the first completed run's id. */
export function foldRetroRuns(body: string | null): Classified<RetroRuns> {
  if (body === null) return fail(DEGRADE.RUNS_READ_FAILED);
  const parsed = parseJsonRead(body);
  if (parsed.kind !== "ok") return fail("runs-unparseable");
  const d = parsed.data;
  const runs = isObj(d) && "runs" in d ? d.runs : [];
  // Only a list's items can be run entries (an object's keys / a string's characters never are).
  const rows: unknown[] = Array.isArray(runs) ? runs : [];
  const first = rows.find(isCompletedRun);
  if (first === undefined) return okv({ available: false, candidate: null });
  const rid = first.run_id;
  const candidate = isSet(rid) ? fieldText(rid).replace(/\n+$/, "") : "";
  return okv({ available: true, candidate: candidate === "" ? null : candidate });
}

/** The bundle heredoc: true unless a parsed, run-found bundle carries nothing to drill. */
export function foldRetroBundle(body: string): boolean {
  const parsed = parseJsonRead(body);
  if (parsed.kind !== "ok") return true;
  const b = parsed.data;
  if (!isObj(b)) return true;
  if (b.runFound !== true) return true;
  const dispatches = "dispatches" in b ? b.dispatches : [];
  const anyFlagged = Array.isArray(dispatches) ? dispatches.some((x) => isObj(x) && isSet(x.flagged)) : false;
  return anyFlagged || isSet(b.reflections) || isSet(b.stuckSignals) || isSet(b.recommendations) || b.runFlagged === true;
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
function pyIntText(x: unknown): string | null {
  if (typeof x === "boolean") return x ? "1" : "0";
  if (typeof x === "number") return Number.isFinite(x) ? BigInt(Math.trunc(x)).toString() : null;
  if (typeof x === "string") {
    const s = x.trim();
    if (!/^[+-]?\d+(?:_\d+)*$/.test(s)) return null;
    return BigInt(s.replaceAll("_", "")).toString();
  }
  return null;
}

/** The approved map numbers in {@link numberOrder}, as integer text; the walk stops at the first non-integer. */
export function foldWayfinderMaps(read: GhJsonRead): Classified<string[]> {
  const numbers = foldRead(read, (data) => {
    const issues = members(data);
    if (issues === null) return null;
    const out: unknown[] = [];
    for (const issue of issues) {
      const names = labelNames(issue);
      if (names === null) return null;
      if (!names.includes(WAYFINDER_DRAFT_LABEL)) out.push(at(issue, "number"));
    }
    return out.sort(numberOrder);
  });
  if ("reason" in numbers) return fail(numbers.reason);
  const out: string[] = [];
  for (const n of numbers.value) {
    const text = pyIntText(n);
    if (text === null) break;
    out.push(text);
  }
  return okv(out);
}

/**
 * A sub-issue's assignee `totalCount` reads as "someone is on it" when it is a
 * positive number — or a string, list or object (they rank above every
 * number, the bash's `> 0`); `null` and booleans do not.
 */
const assigned = (count: unknown): boolean => (typeof count === "number" ? count > 0 : count !== null && typeof count !== "boolean");

/**
 * One map's sub-issue line: `<inflight>` or `<inflight> <pick-number> <pick-type>`
 * (a pick only when nothing is in flight), or failed on a malformed payload.
 * AFK-typed sub-issues (`wayfinder:research` / `wayfinder:task`) are the only
 * ones read past their labels; an OPEN one with a positive assignee count is
 * in flight, and the pick is the first OPEN, unassigned (count exactly 0) one
 * with no OPEN blocker.
 */
export function foldWayfinderMapLine(read: GhJsonRead): Classified<string> {
  return foldRead(read, (data) => {
    const nodes = members(at(at(at(at(at(data, "data"), "repository"), "issue"), "subIssues"), "nodes"));
    if (nodes === null) return null;
    const afk: { node: unknown; type: string }[] = [];
    for (const node of nodes) {
      // A sub-issue must carry `labels.nodes` (a null or scalar node cannot).
      const labels = members(at(at(node, "labels"), "nodes"));
      if (labels === null) return null;
      let type: string | null = null;
      for (const l of labels) {
        const name = at(l, "name");
        if (name === undefined) return null;
        if (type === null && WAYFINDER_AFK_TYPES.some((t) => t === name)) type = name as string;
      }
      if (type !== null) afk.push({ node, type });
    }
    const open = (node: unknown) => at(node, "state") === "OPEN";
    const assigneeCount = (node: unknown) => at(at(node, "assignees"), "totalCount");
    let inflight = 0;
    for (const t of afk) {
      if (!open(t.node)) continue;
      const count = assigneeCount(t.node);
      if (count === undefined) return null;
      if (assigned(count)) inflight++;
    }
    // Every AFK sub-issue is read (a malformed later one still degrades the map); the first qualifying one is the pick.
    let pick: { node: unknown; type: string } | undefined;
    for (const t of afk) {
      if (!open(t.node)) continue;
      const count = assigneeCount(t.node);
      if (count === undefined) return null;
      if (count !== 0) continue;
      const blockers = at(at(t.node, "blockedBy"), "nodes");
      if (blockers === undefined) return null;
      let openBlockers = 0;
      for (const b of members(blockers) ?? []) {
        const state = at(b, "state");
        if (state === undefined) return null;
        if (state === "OPEN") openBlockers++;
      }
      if (openBlockers === 0 && pick === undefined) pick = t;
    }
    if (inflight > 0 || pick === undefined) return String(inflight);
    return `${inflight} ${fieldText(at(pick.node, "number"))} ${pick.type.replace("wayfinder:", "")}`;
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

/**
 * The oldest unassigned needs-tickets issue number (only a bare digit string
 * is accepted), or null. Unassigned = an `assignees` of size 0: an empty list
 * or object, `""`, `0` or a missing / null field; a boolean is malformed.
 */
function foldTicketsPick(read: GhJsonRead): Classified<string | null> {
  const first = foldRead(read, (data) => {
    const issues = members(data);
    if (issues === null) return null;
    const numbers: unknown[] = [];
    for (const issue of issues) {
      const a = at(issue, "assignees");
      if (a === undefined || typeof a === "boolean") return null;
      const size = a === null ? 0 : typeof a === "number" ? Math.abs(a) : typeof a === "string" ? Array.from(a).length : Object.keys(a).length;
      if (size === 0) numbers.push(at(issue, "number"));
    }
    return fieldText(numbers.sort(numberOrder)[0] ?? null);
  });
  if ("reason" in first) return fail(first.reason);
  return okv(/^[0-9]+$/.test(first.value) ? first.value : null);
}

export async function collectTickets(deps: AfkFrontierDeps): Promise<CollectorOutcome<Classified<string | null>>> {
  const pick = foldTicketsPick(await deps.github.openIssueAssigneesWithLabel(NEEDS_TICKETS_LABEL, deps.ghListLimit));
  return outcome("tickets", pick, "reason" in pick ? [{ field: "ticketsPick", reason: pick.reason }] : []);
}
