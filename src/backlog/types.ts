/**
 * Backlog domain types — the compiler-enforced shape of a Kanban backlog item.
 *
 * Before this module the backlog family had no domain type: `reads.ts` declared
 * `type Item = any` and every read/write site (~96 field accesses across ~7
 * files) operated on an untyped bag, so a renamed or mistyped field was a silent
 * runtime miss rather than a build error (issue #2588). `BacklogItem` is the one
 * concentration point that names every field a persisted item can carry; a new
 * field is a one-place edit here and a renamed field is a compile error at every
 * read site.
 *
 * SCOPE NOTE — three item-ish shapes, only ONE is `BacklogItem`:
 *   1. `BacklogItem` (this file)  — the canonical PERSISTED Kanban item: what
 *      `getItem`/`saveItem` round-trip through Redis and what the lanes live in.
 *   2. `NewBacklogItemInput`       — the LOOSER creation payload `addToBacklog`
 *      accepts (carries producer-side fields like `category`, `adjustedScore`,
 *      `confidence`, `complexity` that are folded INTO `meta`, and never persist
 *      as top-level item fields).
 *   3. work-queue JSON entries     — a DIFFERENT shape (`reference`, `queuedAt`,
 *      `reason`) parsed in `anchor-candidates.ts`; NOT a `BacklogItem`. The
 *      eligibility predicates run over both #1 and #3, so they accept the wider
 *      `BacklogItemLike` structural type, not `BacklogItem`.
 */

/**
 * The `meta` sub-record. Every field is optional: `meta` accumulates
 * transition-stamped breadcrumbs (`blockedAt`, `startedAt`, `completedAt`, …) as
 * an item moves through the lanes, plus the producer-side scoring fields folded
 * in at creation. The trailing index signature keeps the historical open-map
 * access pattern (`item.meta = { ...item.meta, someNewKey }`) working without a
 * schema edit for every ad-hoc stamp.
 */
export interface BacklogItemMeta {
  /** Producer that created the item (e.g. "research", "operator"). */
  source?: string;
  /** Ranking score folded in at creation (from the producer's `adjustedScore`). */
  score?: number;
  /** Producer confidence (0–1), folded in at creation. */
  confidence?: number;
  /** Producer complexity estimate, folded in at creation. */
  complexity?: number;
  /** Date-only (YYYY-MM-DD) the item was added. */
  addedAt?: string;
  /** Date-only the item was promoted to the queued lane. */
  queuedAt?: string;
  /** Date-only the item entered inProgress. */
  startedAt?: string;
  /** Date-only the item reached done. */
  completedAt?: string;
  /** Terminal outcome recorded on the move to done (e.g. "merged"). */
  outcome?: string;
  /** Date-only the item was blocked. */
  blockedAt?: string;
  /** Human/agent-readable reason the item is blocked (schedulability invariant, #1920). */
  blockedReason?: string;
  /** Date-only the item was returned to backlog from inProgress. */
  returnedAt?: string;
  /** Reason the item was returned to backlog. */
  returnReason?: string;
  /** Carrier flag: this anchor needs a spawn-capable dispatch (#2075). */
  dispatchSpawnCapable?: boolean;
  /** Carrier flag: this anchor is not deliverable by any code-writing PR (#2282). */
  nonPrDeliverable?: boolean;
  /** Open-map escape hatch for ad-hoc `{ ...item.meta, newKey }` stamps. */
  [key: string]: unknown;
}

/**
 * A persisted Kanban backlog item — the canonical shape `getItem`/`saveItem`
 * round-trip through Redis and the shape the lanes hold.
 */
export interface BacklogItem {
  /** Stable id (auto-incremented counter; number at creation, string when re-read from Redis keys). */
  id: string | number;
  /** Exact title — the by-title index key and the dedup/lane-resolution key. */
  title: string;
  /** Current lane (one of LANES). */
  lane: string;
  /** ISO timestamp of the most recent lane transition (null before the first transition). */
  movedAt: string | null;
  /** ISO timestamp the item was claimed into inProgress (cleared on transition out). */
  claimedAt: string | null;
  /** Claim owner while inProgress — e.g. an agent id or `pr-<number>` (cleared out of inProgress). */
  claimedBy: string | null;
  /** Priority order: 1 (urgent) first, 0 (none/unset) last. */
  priority?: number;
  /** Free-form description. */
  description?: string;
  /** GitHub-issue-style label strings (also a carrier for eligibility flags). */
  labels?: string[];
  /** Category tags folded from the creation payload. */
  tags?: string[];
  /** Effort estimate (null when unset). */
  estimate?: number | null;
  /** Parent item id for epic/child relationships (null when top-level). */
  parentId?: string | number | null;
  /** Completion flag (true when moved to done with outcome "merged"). */
  checked?: boolean;
  /** Transition-stamped breadcrumbs + producer scoring fields. */
  meta?: BacklogItemMeta;
  /** Top-level carrier flag: needs a spawn-capable dispatch (#2075, work-queue-JSON form). */
  dispatchSpawnCapable?: boolean;
  /** Top-level carrier flag: not deliverable by any PR (#2282, work-queue-JSON form). */
  nonPrDeliverable?: boolean;
}

/**
 * The looser payload `addToBacklog` accepts. The producer supplies a title plus
 * optional overrides; the extra producer-side fields (`category`, `source`,
 * `adjustedScore`, `confidence`, `complexity`) are folded INTO `meta`/`tags` and
 * never persist as top-level `BacklogItem` fields. All fields optional except
 * `title` because the dedup + creation path only requires a title.
 */
export interface NewBacklogItemInput {
  title: string;
  lane?: string;
  priority?: number;
  description?: string;
  labels?: string[];
  estimate?: number | null;
  parentId?: string | number | null;
  claimedBy?: string | null;
  /** Producer-side fields folded into meta/tags at creation. */
  category?: string;
  source?: string;
  adjustedScore?: number;
  confidence?: number;
  complexity?: number;
}

/**
 * Minimal structural shape the pure eligibility predicates read. Both a
 * canonical `BacklogItem` (#1 above) and a parsed work-queue JSON entry (#3)
 * satisfy it, so the predicates in candidate-eligibility.ts stay sound across
 * both call sites without an `any`. Every field is optional and the predicates
 * defensively narrow each one before use.
 */
export interface BacklogItemLike {
  lane?: string;
  movedAt?: string | null;
  claimedAt?: string | null;
  claimedBy?: string | null;
  labels?: unknown;
  meta?: { blockedReason?: unknown; dispatchSpawnCapable?: unknown; nonPrDeliverable?: unknown; [key: string]: unknown } | null;
  dispatchSpawnCapable?: unknown;
  nonPrDeliverable?: unknown;
  [key: string]: unknown;
}
