/**
 * turn-snapshot/picks.ts — the grill / dev-ready pick, Candidate Exclusion,
 * merged-PR and active-dev_orch collector (ADR-0043 slice 3, issue #4931),
 * moved whole — fetches included — out of `collect-state.sh`'s
 * `collect_orch_grill_candidates`, `collect_orch_merged_prs`,
 * `collect_orch_grill_and_dev_ready_picks`, `collect_candidate_exclusions`
 * and `collect_active_dev_orch`.
 *
 * Shape (the ADR-0040 Decision 2 precedent, as slice 1's pr-gate.ts): pure
 * classifiers over typed inputs plus ONE orchestrating collector
 * ({@link collectPicks}) over injected deps. The predicates are NOT
 * re-spelled here — they are the canonical TS ones the bash used to mirror:
 *
 *   strict blockers   src/github/blockers.ts `extractStrictBlockerRefs`
 *                     (the inline python PATTERNS / PARENT_PATTERNS twin is gone)
 *   merged-PR refs    src/github/pr-refs.ts `mergedPrReferences`
 *                     (collect-state no longer pipes into pr-refs.py --merged)
 *   grill exemption   src/glm/eligibility.ts `glmGrillExemption`
 *                     (the MECHANICAL / TRIVIAL python twins are gone)
 *   GLM provenance    pr-gate.ts `isGlmProvenance` (one PR-side predicate)
 *   in-flight sets    pr-gate.ts's outcome, taken IN-PROCESS (no exports file)
 *
 * What it computes (semantics unchanged from the bash; the history behind
 * each rule lives in the issues named inline):
 *
 *   candidates        ready-for-agent issues, minus target-backlog (#2704),
 *                     in-flight dev work (#3711, #3851), `in-progress`, and an
 *                     OPEN strict blocker (#3965, Epic refs subtracted #4823);
 *                     issue number ascending, capped at 10 (#3711).
 *   grill pick        the first candidate with no fresh design concept that is
 *                     neither mechanical (#1230) nor trivially T1 (#1088).
 *   dev-ready pick    the first GRILL-CLEAR candidate (fresh artifact,
 *                     cleanup-scan, or T1 — never a `track:` tracker), refused
 *                     when GLM-withheld (#4254) or merged-PR-referenced (#4690).
 *   exclusions        the four Candidate Exclusion members re-evaluated over
 *                     the whole raw pool (#3964) — telemetry only.
 *   active_dev_orch   open hydra-dev-branch PRs updated < 90 min ago, GLM
 *                     drainer PRs excluded (#412, #3687, #4048).
 *
 * The wire is still byte-identical `kv` (Decision 4), so the classifiers keep
 * the Python/jq crash semantics the golden files pin (a malformed payload
 * degrades the whole block to its fallback, exactly as `except: pass` / a jq
 * error did). Never throws on a read failure.
 */

import { extractStrictBlockerRefs } from "../../github/blockers.ts";
import { mergedPrReferences, type PrRefRow } from "../../github/pr-refs.ts";
import { glmGrillExemption, type GlmGrillExemption } from "../../glm/eligibility.ts";
import { ORCH_BOARD_LABELS } from "../../board-labels.ts";
import { DESIGN_CONCEPT_MAX_AGE_MS } from "../../design-concept-gate.ts";
import type { CollectorOutcome, DegradedMarker } from "./collector.ts";
import { ghTimestampSeconds, parseJsonRead, type GhJsonRead, type TurnSnapshotGithub } from "./github-port.ts";
import type { TurnSnapshotHydra } from "./hydra-http.ts";
import { isGlmProvenance, type InflightRefs } from "./pr-gate.ts";

export const PICKS_COLLECTOR = "picks";

/** How many ascending candidates the pick walk may consider (#3711). */
const GRILL_CANDIDATE_CAP = 10;
/** An open dev PR counts toward `active_dev_orch` while updated within this window (#412). */
const ACTIVE_DEV_WINDOW_SECONDS = 5400;
/** The head-branch prefixes hydra-dev creates (#412). */
const DEV_BRANCH_PREFIXES: readonly string[] = ["issue-", "hydra-dev/", "worktree-agent-"];
/** The merged-PR read's page size (the bash's literal `--limit 100`, #4690). */
const MERGED_PR_LIMIT = 100;

/** One Candidate Exclusion evaluation (#3964) — `candidate_exclusions_json` rows. */
interface CandidateExclusionRecord {
  readonly anchor: string;
  readonly member: "target-scope-exclusion" | "in-flight-dev-exclusion" | "mechanical-exclusion" | "trivial-anchor-exclusion";
  readonly verdict: "excluded" | "survived";
  readonly evidence: string;
}

export interface PicksSnapshot {
  /** `orch_pending_grill_anchor` — `null` = no pending grill anchor. */
  readonly grillPick: number | null;
  /** `orch_dev_ready_anchor` — `null` = no dev-ready anchor. */
  readonly devReadyPick: number | null;
  readonly candidateExclusions: readonly CandidateExclusionRecord[];
  readonly activeDevOrch: number;
  /** The grill-list read failed: the orch-board degraded accumulator flips (#4130). */
  readonly boardDegraded: boolean;
}

// ---------------------------------------------------------------------------
// Payload-shape readers (the golden files pin the degrade-on-malformed rule)
// ---------------------------------------------------------------------------

/**
 * Returned by a reader when the payload has a shape the strangled bash/python
 * would have crashed on. A classifier that sees it degrades its whole block to
 * the fallback — exactly as the old `except: pass` / `|| true` / a jq error
 * did — by an explicit early return, never by a throw.
 */
const MALFORMED = Symbol("malformed-payload");
type Malformed = typeof MALFORMED;

type Dict = Record<string, unknown>;

function isDict(v: unknown): v is Dict {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Whether a decoded JSON field carries a value — the pick blocks' `x or
 * default` reading: `null`, `false`, `0`, `""` and an EMPTY list or object
 * read as unset; a non-empty list or object does not. (Python truthiness: a
 * naive JS truthiness check would call `[]` and `{}` set.)
 */
function isSet(v: unknown): boolean {
  return v !== null && typeof v === "object" ? Object.keys(v).length > 0 : Boolean(v);
}

/** Is the value an integer? (JSON decoding cannot tell `5.0` from `5`.) */
function isInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

/**
 * The elements a loop over a decoded JSON value visits: a list's items, a
 * string's characters, a dict's keys; anything else is not iterable.
 */
function elementsOf(v: unknown): unknown[] | Malformed {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return [...v];
  if (isDict(v)) return Object.keys(v);
  return MALFORMED;
}

/** `row[key]`, or `dflt` when absent; a non-object row is malformed. */
function fieldOf(row: unknown, key: string, dflt: unknown = null): unknown {
  if (!isDict(row)) return MALFORMED;
  return key in row ? row[key] : dflt;
}

/** `row[key]` read as text, `""` when unset; a non-text value is malformed. */
function textField(row: unknown, key: string): string | Malformed {
  const v = fieldOf(row, key);
  if (v === MALFORMED) return MALFORMED;
  if (!isSet(v)) return "";
  if (typeof v !== "string") return MALFORMED;
  return v;
}

/** The set of a row's label names (`""` for a nameless label); a non-hashable name is malformed. */
function labelNamesOf(row: unknown): Set<unknown> | Malformed {
  const raw = fieldOf(row, "labels");
  if (raw === MALFORMED) return MALFORMED;
  const labels = elementsOf(isSet(raw) ? raw : []);
  if (labels === MALFORMED) return MALFORMED;
  const out = new Set<unknown>();
  for (const l of labels) {
    const name = fieldOf(l, "name", "");
    if (name === MALFORMED || (name !== null && typeof name === "object")) return MALFORMED;
    out.add(name);
  }
  return out;
}

/** The values a `.[]` walk visits (list items, or an object's values); anything else is malformed. */
function valuesOf(v: unknown): unknown[] | Malformed {
  if (Array.isArray(v)) return v;
  if (isDict(v)) return Object.values(v);
  return MALFORMED;
}

/** `row[key]` where a null row yields null (a `.field` walk); any other non-object row is malformed. */
function nullableField(row: unknown, key: string): unknown {
  if (row === null) return null;
  if (!isDict(row)) return MALFORMED;
  return key in row ? row[key] : null;
}

/** `.labels | map(.name)` (`// []` when `orEmpty`); malformed when the walk cannot run. */
function labelNameList(row: unknown, orEmpty: boolean): unknown[] | Malformed {
  let labels = nullableField(row, "labels");
  if (labels === MALFORMED) return MALFORMED;
  if (orEmpty && (labels === null || labels === false)) labels = [];
  const items = valuesOf(labels);
  if (items === MALFORMED) return MALFORMED;
  const names: unknown[] = [];
  for (const l of items) {
    const name = nullableField(l, "name");
    if (name === MALFORMED) return MALFORMED;
    names.push(name);
  }
  return names;
}

/**
 * An integer from a decoded JSON value, or `null` where the conversion is
 * undefined (non-finite number, non-numeric text, list, ...). Booleans are
 * 0/1, floats truncate, text may carry a sign, spaces and `_` digit groups.
 */
function toInteger(v: unknown): number | null {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v === "string" && /^\s*[+-]?\d(?:_?\d)*\s*$/.test(v)) return Number(v.trim().replace(/_/g, ""));
  return null;
}

// ---------------------------------------------------------------------------
// Pure classifiers
// ---------------------------------------------------------------------------

/**
 * The grill-list read's `--jq` filter (#2704): `[ .[] | select((.labels |
 * map(.name) | index("target-backlog")) | not) ]`. `null` = the jq raised (the
 * read FAILED, exactly as the bash saw it).
 */
function dropTargetBacklog(data: unknown): unknown[] | null {
  const rows = valuesOf(data);
  if (rows === MALFORMED) return null;
  const kept: unknown[] = [];
  for (const row of rows) {
    const names = labelNameList(row, false);
    if (names === MALFORMED) return null;
    if (!names.includes(ORCH_BOARD_LABELS.target_backlog)) kept.push(row);
  }
  return kept;
}

/**
 * Strict-blocker refs of one row (Epic refs subtracted, self-refs excluded) —
 * src/github/blockers.ts. {@link MALFORMED} when the row's body is not text.
 */
function rowBlockerRefs(it: unknown, n: number): number[] | Malformed {
  const body = textField(it, "body");
  if (body === MALFORMED) return MALFORMED;
  return extractStrictBlockerRefs(body).filter((x) => x !== n);
}

/** Step 1 (#3965): the union of strict-blocker refs across the pool, ascending. A malformed pool is `[]`. */
export function blockerRefUnion(items: unknown): number[] {
  const rows = elementsOf(items);
  if (rows === MALFORMED) return [];
  const refs = new Set<number>();
  for (const it of rows) {
    const n = fieldOf(it, "number");
    if (n === MALFORMED) return [];
    if (!isInteger(n)) continue;
    const rowRefs = rowBlockerRefs(it, n);
    if (rowRefs === MALFORMED) return [];
    for (const x of rowRefs) refs.add(x);
  }
  return [...refs].sort((a, b) => a - b);
}

/**
 * Step 2 (#3965): which requested refs are OPEN, from the batched search read.
 * FAIL-SAFE: a failed / empty / unparseable read (or a malformed row) treats
 * EVERY requested ref as still open — the loop waits a tick.
 */
export function openBlockers(read: GhJsonRead, requested: readonly number[]): number[] {
  if (read.kind !== "ok") return [...requested];
  const rows = Array.isArray(read.data) ? read.data : [];
  const open = new Set<number>();
  for (const r of rows) {
    const n = fieldOf(r, "number");
    if (n === MALFORMED) return [...requested];
    if (isInteger(n)) open.add(n);
  }
  return requested.filter((x) => open.has(x));
}

/** Step 3 (#3965): the pool members blocked by an OPEN strict blocker, ascending. A malformed pool is `[]`. */
export function blockedDependencyIssues(items: unknown, open: ReadonlySet<number>): number[] {
  const rows = elementsOf(items);
  if (rows === MALFORMED) return [];
  const blocked: number[] = [];
  for (const it of rows) {
    const n = fieldOf(it, "number");
    if (n === MALFORMED) return [];
    if (!isInteger(n)) continue;
    const rowRefs = rowBlockerRefs(it, n);
    if (rowRefs === MALFORMED) return [];
    if (rowRefs.some((x) => open.has(x))) blocked.push(n);
  }
  return blocked.sort((a, b) => a - b);
}

/**
 * The candidate pool (#3711): issue number ASCENDING, capped at
 * {@link GRILL_CANDIDATE_CAP}, minus in-flight dev work, `in-progress`, and
 * the blocked-dependency set (a HARD skip at construction, #3965). A malformed
 * pool is `[]`.
 */
export function grillCandidates(items: unknown, inflight: ReadonlySet<number>, blockedDep: ReadonlySet<number>): number[] {
  const rows = elementsOf(items);
  if (rows === MALFORMED) return [];
  const nums = new Set<number>();
  for (const it of rows) {
    const n = fieldOf(it, "number");
    if (n === MALFORMED) return [];
    if (!isInteger(n)) continue;
    const labels = labelNamesOf(it);
    if (labels === MALFORMED) return [];
    if (inflight.has(n) || labels.has(ORCH_BOARD_LABELS.in_progress) || blockedDep.has(n)) continue;
    nums.add(n);
  }
  return [...nums].sort((a, b) => a - b).slice(0, GRILL_CANDIDATE_CAP);
}

/**
 * The GLM-withheld set (#4254): `glm_withheld` off a HEALTHY board-state body
 * (`null` = the read was degraded). Every malformed case is the empty set —
 * fail-open, no pin is refused (#3754).
 */
export function parseGlmWithheld(boardState: string | null): ReadonlySet<number> {
  const out = new Set<number>();
  if (boardState === null) return out;
  const parsed = parseJsonRead(boardState);
  if (parsed.kind !== "ok" || !isDict(parsed.data)) return out;
  const xs = parsed.data.glm_withheld;
  if (!Array.isArray(xs)) return out;
  for (const x of xs) if (isInteger(x) && x > 0) out.add(x);
  return out;
}

/**
 * The shipped-work set (#4690): issues a MERGED PR references, by
 * src/github/pr-refs.ts `mergedPrReferences` (closing verb over title+body OR
 * a `(#N)` title anchor). An unparseable / non-list / malformed payload is the
 * empty set.
 */
export function mergedRefIssues(read: GhJsonRead): ReadonlySet<number> {
  if (read.kind !== "ok" || !Array.isArray(read.data)) return new Set();
  const rows: PrRefRow[] = [];
  for (const pr of read.data as unknown[]) {
    if (!isDict(pr)) continue;
    const title = isSet(pr.title) ? pr.title : "";
    if (typeof title !== "string") return new Set();
    const body = isSet(pr.body) ? pr.body : "";
    rows.push({ title, body: typeof body === "string" ? body : JSON.stringify(body) });
  }
  return mergedPrReferences(rows);
}

/**
 * Is a design-concept body a FRESH artifact? (`createdAt` within
 * DESIGN_CONCEPT_MAX_AGE_MS of now; a draft counts — Phase B warn-only.)
 * Unparseable / non-object / unreadable `createdAt` → not fresh.
 */
function isFreshArtifact(body: string, nowMs: number): boolean {
  const parsed = parseJsonRead(body);
  if (parsed.kind !== "ok" || !isDict(parsed.data)) return false;
  const raw = "createdAt" in parsed.data ? parsed.data.createdAt : 0;
  const created = toInteger(isSet(raw) ? raw : 0);
  if (created === null) return false;
  return Math.floor(nowMs) - created <= DESIGN_CONCEPT_MAX_AGE_MS;
}

/**
 * Why a candidate needs no grill — src/glm/eligibility.ts `glmGrillExemption`
 * over the candidate's row (`null` = it must be grilled; also `null` when the
 * row cannot be found or read, the old fail-toward-grill default).
 */
function candidateExemption(items: readonly unknown[], n: number): GlmGrillExemption | null {
  let row: unknown;
  for (const x of items) {
    const num = fieldOf(x, "number", -1);
    if (num === MALFORMED) return null;
    const asInt = toInteger(num);
    if (asInt === null) return null;
    if (asInt === n) {
      row = x;
      break;
    }
  }
  if (row === undefined || !isDict(row)) return null;
  const labels = labelNamesOf(row);
  if (labels === MALFORMED) return null;
  const names = [...labels].filter((x): x is string => typeof x === "string");
  const title = typeof row.title === "string" ? row.title : null;
  const body = typeof row.body === "string" ? row.body : null;
  return glmGrillExemption({ number: n, labels: names, title, body });
}

/** The Candidate Exclusion records (#3964) over the RAW pool; a malformed payload is `[]`. */
function candidateExclusionRecords(
  read: GhJsonRead,
  branchIssues: ReadonlySet<number>,
  bodyRefIssues: ReadonlySet<number>,
): CandidateExclusionRecord[] {
  const items = read.kind === "ok" && Array.isArray(read.data) ? read.data : [];
  const records: CandidateExclusionRecord[] = [];
  const add = (anchor: string, member: CandidateExclusionRecord["member"], excluded: string | null) =>
    records.push({ anchor, member, verdict: excluded === null ? "survived" : "excluded", evidence: excluded ?? "" });
  for (const it of items) {
    const n = fieldOf(it, "number");
    if (n === MALFORMED) return [];
    if (!isInteger(n)) continue;
    const anchor = `issue-${n}`;
    const labels = labelNamesOf(it);
    if (labels === MALFORMED) return [];
    const rawTitle = textField(it, "title");
    if (rawTitle === MALFORMED) return [];
    const title = rawTitle.replace(/^\s+/, "");
    add(anchor, "target-scope-exclusion", labels.has(ORCH_BOARD_LABELS.target_backlog) ? "target-backlog-label" : null);
    add(
      anchor,
      "in-flight-dev-exclusion",
      bodyRefIssues.has(n)
        ? "pr-body-ref"
        : branchIssues.has(n)
          ? "pr-branch-name"
          : labels.has(ORCH_BOARD_LABELS.in_progress)
            ? "in-progress-label"
            : null,
    );
    add(
      anchor,
      "mechanical-exclusion",
      labels.has(ORCH_BOARD_LABELS.cleanup_scan)
        ? "cleanup-scan-label"
        : title.toLowerCase().startsWith("track:")
          ? "track-title-prefix"
          : null,
    );
    let trivial: string | null = null;
    if (!labels.has(ORCH_BOARD_LABELS.needs_design_concept)) {
      const body = textField(it, "body");
      if (body === MALFORMED) return [];
      if (/Expected\s+tier:\s*T?1\b/i.test(body)) trivial = "expected-tier-t1";
    }
    add(anchor, "trivial-anchor-exclusion", trivial);
  }
  return records;
}

/**
 * `active_dev_orch` (#412): open PRs on a hydra-dev head branch, not GLM
 * drainer work (#3687 label OR #4048 branch prefix), updated within
 * {@link ACTIVE_DEV_WINDOW_SECONDS}. A failed read or a malformed row (which
 * failed the old `gh … --jq` read, printing `0` via `|| echo 0`) is `0`.
 */
export function countActiveDevOrch(read: GhJsonRead, nowSeconds: number): number {
  if (read.kind !== "ok") return 0;
  const prs = valuesOf(read.data);
  if (prs === MALFORMED) return 0;
  let count = 0;
  for (const pr of prs) {
    const head = nullableField(pr, "headRefName");
    if (head === MALFORMED || typeof head !== "string") return 0;
    if (!DEV_BRANCH_PREFIXES.some((p) => head.startsWith(p))) continue;
    const names = labelNameList(pr, true);
    if (names === MALFORMED) return 0;
    if (isGlmProvenance(new Set(names), head)) continue;
    const t = ghTimestampSeconds(nullableField(pr, "updatedAt"));
    if (t === null) return 0;
    if (nowSeconds - t < ACTIVE_DEV_WINDOW_SECONDS) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// The collector (orchestration over injected deps)
// ---------------------------------------------------------------------------

export interface PicksDeps {
  readonly github: TurnSnapshotGithub;
  readonly hydra: Pick<TurnSnapshotHydra, "designConceptBody">;
  /** Epoch milliseconds. */
  readonly now: () => number;
  /** `gh … --limit` page size (collect-state.sh's GH_ISSUE_LIST_LIMIT). */
  readonly ghListLimit: number;
  /** The pr-gate collector's in-flight sets, taken in-process (slice 1's outcome). */
  readonly inflight: InflightRefs;
  /** The HEALTHY orch board-state body (the glm_withheld source), or `null` when that read degraded. */
  readonly boardState: string | null;
}

const GRILL_LIST_FAILED_NOTE = "orch grill-list read FAILED (empty payload) — flagged degraded (issue #4130)";
const MERGED_READ_FAILED_NOTE =
  "WARN orch merged-PR list read FAILED (empty payload) — merged-PR pin refusal fails OPEN to no refusal this pass (issue #4690)";

function mergedRefusalNote(n: number): string {
  return `merged-pr-referenced: refusing the orch_dev_ready pin for issue-${n} — a MERGED PR already references it (work likely shipped; the issue is open only because that PR carried no closing keyword) — not re-dispatching; close or re-scope by hand (issue #4690)`;
}

/** Gather and classify the picks, exclusions and active-dev count. Never throws on a read failure. */
export async function collectPicks(deps: PicksDeps): Promise<CollectorOutcome<PicksSnapshot>> {
  const notes: string[] = [];
  const degraded: DegradedMarker[] = [];
  const limit = deps.ghListLimit;

  // 1. ONE ready-for-agent read feeds the candidate pool (target-backlog
  //    dropped by the old --jq filter) AND the raw Candidate Exclusion pool.
  const rfa = await deps.github.listReadyForAgentIssues(limit);
  const filtered = rfa.kind === "ok" ? dropTargetBacklog(rfa.data) : null;
  if (filtered === null) {
    notes.push(GRILL_LIST_FAILED_NOTE);
    degraded.push({ field: "grillList", reason: rfa.kind === "ok" ? "jq-error" : rfa.kind === "empty" ? "empty-payload" : "unparseable" });
  }
  const pool: unknown[] = filtered ?? [];

  // 2. Blocked-dependency exclusion (#3965): one batched openness lookup.
  const refs = blockerRefUnion(pool);
  let open: number[] = [];
  if (refs.length > 0) {
    const search = await deps.github.searchOpenIssueNumbers(refs.join(" "), limit);
    if (search.kind !== "ok") degraded.push({ field: "openBlockers", reason: "fail-safe-all-open" });
    open = openBlockers(search, refs);
  }
  const blockedDep = new Set(blockedDependencyIssues(pool, new Set(open)));
  const candidates = grillCandidates(pool, new Set(deps.inflight.union), blockedDep);
  const withheld = parseGlmWithheld(deps.boardState);

  // 3. Merged-PR shipped-work set — fetched only when a pin is possible.
  let merged: ReadonlySet<number> = new Set();
  if (candidates.length > 0) {
    const read = await deps.github.listMergedPrs(MERGED_PR_LIMIT);
    if (read.kind === "empty") {
      notes.push(MERGED_READ_FAILED_NOTE);
      degraded.push({ field: "mergedPrs", reason: "empty-payload" });
    }
    merged = mergedRefIssues(read);
  }

  // 4. The walk: resolve both picks, stopping once both are known.
  let grillPick: number | null = null;
  let devReadyPick: number | null = null;
  /** The pin guard, in the bash's `&&` order: withheld first, then the (logging) merged-PR check. */
  const pinnable = (n: number): boolean => {
    if (devReadyPick !== null || withheld.has(n)) return false;
    if (merged.has(n)) {
      notes.push(mergedRefusalNote(n));
      return false;
    }
    return true;
  };
  for (const n of candidates) {
    if (grillPick !== null && devReadyPick !== null) break;
    const artifact = await deps.hydra.designConceptBody(n);
    if (isFreshArtifact(artifact, deps.now())) {
      if (pinnable(n)) devReadyPick = n;
      continue;
    }
    const exemption = candidateExemption(pool, n);
    if (exemption === ORCH_BOARD_LABELS.cleanup_scan || exemption === "track-title") {
      // Mechanical: never grilled; only cleanup-scan is a valid dev pin (#1230, #3711).
      if (pinnable(n) && exemption === ORCH_BOARD_LABELS.cleanup_scan) devReadyPick = n;
      continue;
    }
    if (exemption === "expected-tier-t1") {
      if (pinnable(n)) devReadyPick = n;
      continue;
    }
    if (grillPick === null) grillPick = n;
  }

  // 5. Candidate Exclusion telemetry over the RAW pool (#3964).
  const candidateExclusions = candidateExclusionRecords(rfa, new Set(deps.inflight.branch), new Set(deps.inflight.body));

  // 6. active_dev_orch (#412).
  const activeDevOrch = countActiveDevOrch(await deps.github.listOpenPrHeads(), deps.now() / 1000);

  return {
    collector: PICKS_COLLECTOR,
    value: { grillPick, devReadyPick, candidateExclusions, activeDevOrch, boardDegraded: filtered === null },
    degraded,
    notes,
  };
}

/** The snapshot the CLI renders when the collector itself could not run (the grill list counts as unread). */
export function picksFallbackSnapshot(): PicksSnapshot {
  return { grillPick: null, devReadyPick: null, candidateExclusions: [], activeDevOrch: 0, boardDegraded: true };
}
