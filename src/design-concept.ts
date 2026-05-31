/**
 * Design Concept — Redis-backed alignment artifact (Phase A of #437).
 *
 * A design-concept artifact is a structured record produced by the (future)
 * `hydra-grill` skill before any code-writing dispatch (`dev_orch` /
 * `dev_target`). It captures:
 *
 *   - Which `CONTEXT.md` glossary terms the agent grounded in, and which
 *     gaps remain.
 *   - Which modules the agent intends to touch, with `interfaceImpact` and
 *     `depthClassification` annotations.
 *   - The invariants the agent intends to preserve.
 *   - The rejected alternatives, the Q&A trace that produced the design,
 *     and any prototype snippets that resolved hard logic/state questions.
 *
 * The artifact is the single source of truth consumed both by the gate
 * (`gateCheck()` here) and by PR-time review (the future two-axis
 * `hydra-qa` rewrite — sub-issue #440). See ADR-0008.
 *
 * Phase A scope: persistence + HTTP surface + gate semantics only. No
 * autopilot wiring (Phase B), no CI hook (Phase C). The `dev_orch` gate
 * is NOT wired here — `src/gate.ts` and the autopilot decide.py are out
 * of scope for this sub-issue.
 *
 * Redis schema:
 *   hydra:design-concept:{anchorRef}  → Hash (full body, JSON-encoded fields)
 *   hydra:design-concept:index         → Sorted set (score = createdAt)
 *
 * TTL: 7 days from createdAt. The index is opportunistically pruned of
 * stale entries on every read.
 */

import { createHash } from "node:crypto";

import {
  getDesignConceptHash,
  listAllDesignConceptRefs,
  listRecentDesignConceptRefs,
  removeDesignConceptFromIndex,
  saveDesignConceptHash,
  setDesignConceptField,
} from "./redis/design-concept.ts";
import {
  type DesignConceptInput as DesignConceptInputType,
} from "./schemas/design-concept.ts";
import { classifyChange } from "./tier-classifier.ts";

// `DesignConceptInput` is owned by `src/schemas/design-concept.ts` per
// ADR-0011 (single source of truth: the schema is also the type). The
// re-export below keeps the historical import path working.
export type { DesignConceptInput } from "./schemas/design-concept.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 7 days, in milliseconds. */
export const DESIGN_CONCEPT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** 7 days, in seconds — for Redis EXPIRE. */
const DESIGN_CONCEPT_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Minimum Q&A trace depth for the gate. From the ADR-0008 schema. */
const MIN_QA_TRACE_LENGTH = 6;

// ---------------------------------------------------------------------------
// AnchorRef normalization (issue #736)
// ---------------------------------------------------------------------------

/**
 * Canonicalize an anchorRef to the `issue-<N>` form used end-to-end by the
 * autopilot signal path (issue #736).
 *
 * The wedge: the grill/writer sometimes persists under a bare issue number
 * (`"736"` → key `hydra:design-concept:736`), but every reader — the
 * autopilot's `orch_pending_grill_anchor` signal, `collect-state.sh`'s
 * `/api/design-concepts/issue-<N>` probe, the slot `anchor` field, and
 * candidate refs — uses the `issue-<N>` form. The mismatch orphaned the
 * artifact: `GET /api/design-concepts/736` → 200, `GET .../issue-736` → 404,
 * so `design_concept_orch` re-grilled forever and `dev_orch` was starved.
 *
 * Normalizing at the persistence seam (used by BOTH write and read) makes
 * the round-trip total: a bare `"736"` and the dispatched `"issue-736"`
 * resolve to the same canonical key `issue-736`, regardless of which form
 * the caller supplies. Non-issue refs (kanban titles, work-queue
 * descriptions, the `test:*` refs) are passed through unchanged.
 *
 * Rules:
 *   - `"736"` (pure digits)        → `"issue-736"`
 *   - `"#736"` (leading hash)      → `"issue-736"`
 *   - `"issue-736"` (already canon)→ `"issue-736"` (idempotent)
 *   - `"PR-4: foo"`, `"some title"`→ unchanged (not an issue number)
 */
export function normalizeAnchorRef(anchorRef: string): string {
  if (typeof anchorRef !== "string") return anchorRef;
  const trimmed = anchorRef.trim();
  if (trimmed === "") return trimmed;
  // Already canonical: `issue-<digits>` (case-insensitive on the prefix).
  if (/^issue-\d+$/i.test(trimmed)) {
    return `issue-${trimmed.slice(trimmed.indexOf("-") + 1)}`;
  }
  // Bare issue number, optionally prefixed with `#` or `issue #`.
  const m = trimmed.match(/^(?:issue\s*)?#?(\d+)$/i);
  if (m) {
    return `issue-${m[1]}`;
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DesignConceptScope = "orch" | "target";

export type DesignConceptStatus = "draft" | "approved" | "stale";

export type InterfaceImpact = "none" | "extend" | "breaking";

export type DepthClassification = "deep" | "shallow" | "unknown";

export type ModuleTouched = {
  path: string;
  interfaceImpact: InterfaceImpact;
  depthClassification: DepthClassification;
};

export type RejectedAlternative = { alt: string; why: string };

export type QaTurn = { q: string; a: string };

export type Prototype = {
  question: string;
  branch: "logic" | "ui";
  snippet: string;
  answer: string;
  workTreePath: string;
};

export type DesignConcept = {
  anchorRef: string;
  scope: DesignConceptScope;
  createdAt: number;
  artifactHash: string;
  glossaryTerms: string[];
  glossaryGaps: string[];
  modulesTouched: ModuleTouched[];
  invariants: string[];
  rejectedAlternatives: RejectedAlternative[];
  qaTrace: QaTurn[];
  prototypes: Prototype[];
  status: DesignConceptStatus;
  approvedBy: "auto-gate" | `operator:${string}` | "";
};

/* `DesignConceptInput` is now defined (and re-exported above) by
 * `src/schemas/design-concept.ts` — see ADR-0011. */

// ---------------------------------------------------------------------------
// Canonical JSON + artifact hash
// ---------------------------------------------------------------------------

/**
 * Canonical-JSON encode an arbitrary value: object keys are emitted in
 * sorted order, no whitespace, primitives encoded as `JSON.stringify`
 * does. Used as the input to `sha256` for `artifactHash`, so two
 * artifacts with the same body always produce the same hash.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined) continue;
    parts.push(JSON.stringify(k) + ":" + canonicalJson(v));
  }
  return "{" + parts.join(",") + "}";
}

/**
 * Compute the `artifactHash` for a design concept. Hashes all body fields
 * EXCLUDING `artifactHash`, `createdAt`, `status`, and `approvedBy` — so
 * approving an artifact (or persisting it at a different timestamp) does
 * not change its content identity.
 */
export function computeArtifactHash(d: Omit<DesignConcept, "artifactHash">): string {
  const body = {
    anchorRef: d.anchorRef,
    scope: d.scope,
    glossaryTerms: d.glossaryTerms,
    glossaryGaps: d.glossaryGaps,
    modulesTouched: d.modulesTouched,
    invariants: d.invariants,
    rejectedAlternatives: d.rejectedAlternatives,
    qaTrace: d.qaTrace,
    prototypes: d.prototypes,
  };
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Save (or overwrite) a design concept. Computes `createdAt` and
 * `artifactHash` server-side. Index is updated in lockstep with the
 * hash key; both share the same 7-day TTL via Redis EXPIRE.
 *
 * Idempotent on `anchorRef`: a second call replaces the prior artifact.
 */
export async function saveDesignConcept(
  input: DesignConceptInputType,
  now: number = Date.now(),
): Promise<DesignConcept> {
  if (!input.anchorRef || typeof input.anchorRef !== "string") {
    throw new Error("saveDesignConcept: anchorRef is required");
  }
  if (input.scope !== "orch" && input.scope !== "target") {
    throw new Error("saveDesignConcept: scope must be 'orch' or 'target'");
  }

  const status: DesignConceptStatus = input.status ?? "draft";
  const approvedBy: DesignConcept["approvedBy"] = input.approvedBy ?? "";

  // Canonicalize to the `issue-<N>` form the autopilot signal path reads
  // (issue #736). A bare `"736"` and the dispatched `"issue-736"` both
  // persist under the same key, so readers can always find the artifact.
  const anchorRef = normalizeAnchorRef(input.anchorRef);

  const draft: Omit<DesignConcept, "artifactHash"> = {
    anchorRef,
    scope: input.scope,
    createdAt: now,
    glossaryTerms: input.glossaryTerms ?? [],
    glossaryGaps: input.glossaryGaps ?? [],
    modulesTouched: input.modulesTouched ?? [],
    invariants: input.invariants ?? [],
    rejectedAlternatives: input.rejectedAlternatives ?? [],
    qaTrace: input.qaTrace ?? [],
    prototypes: input.prototypes ?? [],
    status,
    approvedBy,
  };

  const artifactHash = computeArtifactHash(draft);
  const concept: DesignConcept = { ...draft, artifactHash };

  await saveDesignConceptHash(
    concept.anchorRef,
    concept.createdAt,
    [
      "anchorRef", concept.anchorRef,
      "scope", concept.scope,
      "createdAt", String(concept.createdAt),
      "artifactHash", concept.artifactHash,
      "glossaryTerms", JSON.stringify(concept.glossaryTerms),
      "glossaryGaps", JSON.stringify(concept.glossaryGaps),
      "modulesTouched", JSON.stringify(concept.modulesTouched),
      "invariants", JSON.stringify(concept.invariants),
      "rejectedAlternatives", JSON.stringify(concept.rejectedAlternatives),
      "qaTrace", JSON.stringify(concept.qaTrace),
      "prototypes", JSON.stringify(concept.prototypes),
      "status", concept.status,
      "approvedBy", concept.approvedBy,
    ],
    DESIGN_CONCEPT_TTL_SECONDS,
  );

  return concept;
}

function parseJsonField<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    console.error("[DesignConcept] Failed to parse JSON field", { raw, err });
    return fallback;
  }
}

function hydrate(raw: Record<string, string>): DesignConcept | null {
  if (!raw || !raw.anchorRef) return null;
  const status = (raw.status || "draft") as DesignConceptStatus;
  const approvedBy = (raw.approvedBy || "") as DesignConcept["approvedBy"];
  return {
    anchorRef: raw.anchorRef,
    scope: (raw.scope === "target" ? "target" : "orch") as DesignConceptScope,
    createdAt: Number(raw.createdAt) || 0,
    artifactHash: raw.artifactHash || "",
    glossaryTerms: parseJsonField<string[]>(raw.glossaryTerms, []),
    glossaryGaps: parseJsonField<string[]>(raw.glossaryGaps, []),
    modulesTouched: parseJsonField<ModuleTouched[]>(raw.modulesTouched, []),
    invariants: parseJsonField<string[]>(raw.invariants, []),
    rejectedAlternatives: parseJsonField<RejectedAlternative[]>(
      raw.rejectedAlternatives,
      [],
    ),
    qaTrace: parseJsonField<QaTurn[]>(raw.qaTrace, []),
    prototypes: parseJsonField<Prototype[]>(raw.prototypes, []),
    status,
    approvedBy,
  };
}

/** Fetch one design concept by `anchorRef`. Returns null if missing. */
export async function getDesignConcept(
  anchorRef: string,
): Promise<DesignConcept | null> {
  if (!anchorRef) return null;
  // Normalize so a lookup by either form (`"736"` or `"issue-736"`)
  // resolves to the canonical persisted key (issue #736).
  const raw = await getDesignConceptHash(normalizeAnchorRef(anchorRef));
  return hydrate(raw);
}

/**
 * Opportunistic prune of stale (>7d) entries from the index. Reads the
 * whole index, drops members whose score is older than `cutoff`. Cheap
 * for the expected index size (≤ a few hundred entries; 7-day TTL caps
 * growth). Returns the number of entries pruned.
 *
 * The hash keys themselves are reaped by Redis via EXPIRE, so this only
 * keeps the index consistent.
 */
async function pruneStaleIndex(now: number): Promise<number> {
  const cutoff = now - DESIGN_CONCEPT_MAX_AGE_MS;
  const allRefs = await listAllDesignConceptRefs();
  let pruned = 0;
  for (const ref of allRefs) {
    const raw = await getDesignConceptHash(ref);
    const createdAt = Number(raw?.createdAt) || 0;
    // Either the hash is gone (TTL'd out) or it's older than the cutoff.
    if (!raw?.anchorRef || createdAt < cutoff) {
      await removeDesignConceptFromIndex(ref);
      pruned += 1;
    }
  }
  return pruned;
}

/**
 * List design concepts in reverse-chronological order. The index is
 * pruned of stale entries on every call (see `pruneStaleIndex`).
 *
 * Filters:
 *   - `scope`: only return artifacts for this scope.
 *   - `limit`: cap the returned count (default 50; max 200).
 */
export async function listDesignConcepts(opts: {
  scope?: DesignConceptScope;
  limit?: number;
  now?: number;
} = {}): Promise<DesignConcept[]> {
  const now = opts.now ?? Date.now();
  await pruneStaleIndex(now);

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const refs = await listRecentDesignConceptRefs(limit);
  const out: DesignConcept[] = [];
  for (const ref of refs) {
    const dc = await getDesignConcept(ref);
    if (!dc) continue;
    if (opts.scope && dc.scope !== opts.scope) continue;
    out.push(dc);
  }
  return out;
}

/**
 * Mark a design concept as `approved` and record the approver. The
 * approver must be either the literal string `"auto-gate"` or
 * `"operator:<name>"`. Throws on unknown anchorRef so callers can return
 * 404 rather than silently no-op.
 */
export async function approveDesignConcept(
  anchorRef: string,
  by: string,
): Promise<DesignConcept> {
  const existing = await getDesignConcept(anchorRef);
  if (!existing) {
    throw new Error(`approveDesignConcept: no artifact for anchorRef "${anchorRef}"`);
  }
  if (!by || (by !== "auto-gate" && !by.startsWith("operator:"))) {
    throw new Error(
      `approveDesignConcept: 'by' must be "auto-gate" or "operator:<name>", got "${by}"`,
    );
  }
  const approvedBy = by as DesignConcept["approvedBy"];
  // Field updates must target the same canonical key the artifact was
  // persisted under (issue #736) — `existing.anchorRef` is already
  // normalized by `saveDesignConcept`, but normalize the incoming ref too
  // in case the caller passed the bare form.
  const key = normalizeAnchorRef(anchorRef);
  await setDesignConceptField(key, "status", "approved");
  await setDesignConceptField(key, "approvedBy", approvedBy);
  return { ...existing, status: "approved", approvedBy };
}

// ---------------------------------------------------------------------------
// Freshness + gate
// ---------------------------------------------------------------------------

/**
 * Return true iff the artifact was created within the freshness window
 * (7 days by default). Pure function — no Redis IO.
 */
export function isFresh(
  d: DesignConcept,
  now: number,
  maxAgeMs: number = DESIGN_CONCEPT_MAX_AGE_MS,
): boolean {
  if (!d || typeof d.createdAt !== "number" || d.createdAt <= 0) return false;
  return now - d.createdAt <= maxAgeMs;
}

/**
 * Gate check — the 7 deterministic failure modes from ADR-0008 §"Gate
 * check". Returns `{ ok: true, reasons: [] }` only when EVERY rule
 * passes. Pure function — no Redis IO. The autopilot consumes this
 * verbatim in Phase B.
 *
 * For Phase A: `glossaryGaps` fails closed (any non-empty list is a
 * reject). The whitelist-via-Redis escape hatch lands later.
 *
 * For Phase A: `interfaceImpact: 'breaking'` cross-checks against the
 * existing tier classifier in `src/tier-classifier.ts` — every breaking
 * module path must classify to tier >= 2. Under the monotonic T1–T4
 * ladder (ADR-0015) a "breaking" declaration on a T1 (prompt-shaped,
 * auto-merge-trivial) path is the only gate failure here: T1 is the
 * shallowest, lowest-blast-radius tier and a breaking change there is a
 * contradiction. T2 (outcome-holdback), T3 (operator-review), and T4
 * (Verifier Core — the deepest tier, carrying the most verification) all
 * clear this check. NOTE (issue #737): under the old non-monotonic
 * numbering a breaking change on a Tier-0 path FAILED this rule
 * (0 < 2); under the monotonic ladder Verifier Core is T4 (deepest) and
 * now PASSES — this corrects a latent inversion (the deepest tier should
 * carry the most verification, not be rejected). Intended behavior delta,
 * not a regression.
 */
export function gateCheck(
  d: DesignConcept,
  now: number,
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];

  // 1. No glossary gaps allowed in Phase A.
  if (Array.isArray(d.glossaryGaps) && d.glossaryGaps.length > 0) {
    reasons.push(
      `glossaryGaps non-empty (${d.glossaryGaps.length}): ${d.glossaryGaps.join(", ")}`,
    );
  }

  // 2. At least one invariant.
  if (!Array.isArray(d.invariants) || d.invariants.length < 1) {
    reasons.push("invariants must list at least 1 entry");
  }

  // 3. At least one modulesTouched.
  if (!Array.isArray(d.modulesTouched) || d.modulesTouched.length < 1) {
    reasons.push("modulesTouched must list at least 1 entry");
  }

  // 4. Breaking impact → tier ≥ 2.
  const breakingPaths = (d.modulesTouched ?? [])
    .filter((m) => m && m.interfaceImpact === "breaking")
    .map((m) => m.path);
  if (breakingPaths.length > 0) {
    const cls = classifyChange(breakingPaths);
    if (cls.tier < 2) {
      reasons.push(
        `interfaceImpact: 'breaking' on tier-${cls.tier} path(s) — breaking change must classify to tier >= 2 ` +
          `(got: ${cls.reason})`,
      );
    }
  }

  // 5. Q&A trace depth.
  if (!Array.isArray(d.qaTrace) || d.qaTrace.length < MIN_QA_TRACE_LENGTH) {
    reasons.push(
      `qaTrace must have at least ${MIN_QA_TRACE_LENGTH} turns (got ${d.qaTrace?.length ?? 0})`,
    );
  }

  // 6. Freshness.
  if (!isFresh(d, now)) {
    reasons.push("artifact is stale (older than 7 days)");
  }

  // 7. Status must be approved.
  if (d.status !== "approved") {
    reasons.push(`status must be 'approved' (got '${d.status}')`);
  }

  return { ok: reasons.length === 0, reasons };
}
