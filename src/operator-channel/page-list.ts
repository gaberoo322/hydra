/**
 * The Operator Channel's one per-kind table (ADR-0045 Decision 3, issues #5045 /
 * #5389; epic #5388).
 *
 * `KIND_TABLE` is the ONLY place a kind's disposition (page or brief, possibly a
 * function of the payload), dashboard-alert flag and severity, dedupKey
 * derivation and Morning Brief line renderer are declared. `PAGE_KINDS`,
 * `ALERT_TYPES` and `BRIEF_KINDS` are DERIVED from it at module load. The
 * channel — never the producer — decides severity: a Page is an event whose
 * row says so; everything else is a Morning Brief item. Adding a kind is one
 * row here. Bus-backed rows reference `NOTIFICATION_EVENT_TYPES` so a typo is a
 * compile error; the rest are string literals the operator-notify CLI emits.
 * (The file name is historical; it holds the whole table.)
 *
 * Import direction is one-way: this module imports only the vocabulary,
 * `./message.ts` and a TYPE from `../notification/alert-grammar.ts`.
 *
 * Every briefLine renderer returns PLAIN TEXT; HTML escaping happens exactly
 * once, in `brief-render.ts` (ADR-0045 Decision 5).
 */

import {
  NOTIFICATION_EVENT_TYPES as E,
  type NotificationEventType,
} from "../event-bus-vocabulary.ts";
import type { AlertSeverity } from "../notification/alert-grammar.ts";
import type { OperatorMessage } from "./message.ts";

type Payload = Record<string, unknown>;

/**
 * A stored brief item: the {@link OperatorMessage} `channel.brief()` appended
 * plus the `at` stamp it added (`hydra:operator-channel:brief:items`).
 */
export interface BriefItem extends OperatorMessage {
  at: number;
}

export type BriefLineRenderer = (item: BriefItem) => string;

/** The value of the fact labelled `label`, or `undefined`. */
export function fact(item: BriefItem, label: string): string | undefined {
  const f = item.facts.find((x) => x.label === label);
  return f?.value;
}

const sha7 = (v: string | undefined) => (v ? v.slice(0, 7) : "?");
const num = (v: string | undefined) => (v === undefined || v === "" ? "—" : v);

/** `label=value` pairs for every fact, for the generic fallback line. */
function factsSummary(item: BriefItem): string {
  return item.facts.map((f) => `${f.label}=${f.value}`).join(", ");
}

/** The generic `kind — title (facts)` line for a kind with no renderer. */
export function genericBriefLine(item: BriefItem): string {
  const facts = factsSummary(item);
  const title = item.title && item.title !== item.kind ? ` — ${item.title}` : "";
  return `${item.kind}${title}${facts ? ` (${facts})` : ""}`;
}

/** One kind's routing + presentation row. */
export interface KindRow {
  /** Page or Morning Brief item; a function decides from the payload. */
  disposition: "page" | "brief" | ((payload: Payload) => "page" | "brief");
  /** Whether the event also raises a dashboard alert (payload-aware when a function). */
  alert: boolean | ((payload: Payload) => boolean);
  /** Dashboard alert severity override; default is error for a page, info for a brief. */
  alertSeverity?: AlertSeverity;
  /** Edge-trigger identity derivation; default is the kind. */
  dedupKey?: (payload: Payload) => string;
  /** Morning Brief line. Required when the disposition is the literal "brief" or a function. */
  briefLine?: BriefLineRenderer;
}

const PAGE = { disposition: "page", alert: false } as const;
const PAGE_ALERT = { disposition: "page", alert: true } as const;

const ROWS = {
  // ---- Infra alarms --------------------------------------------------------
  [E.INFRA_NODE_MODULES_WIPED]: PAGE_ALERT,
  // A self-healed origin identity (payload.repair === "repaired") needs no
  // operator action: a brief item with its own line and no dashboard alert.
  // Every other repair state pages with an alert.
  [E.INFRA_ORIGIN_IDENTITY_WRONG]: {
    disposition: (p: Payload): "page" | "brief" => (p.repair === "repaired" ? "brief" : "page"),
    alert: (p: Payload): boolean => p.repair !== "repaired",
    briefLine: (item: BriefItem): string =>
      `~/hydra origin identity auto-repaired: ${fact(item, "reason") || "wrong"} — origin ${fact(item, "url") || "unknown"} -> ${fact(item, "newUrl") || "canonical"}, fetch ${fact(item, "fetch") || "ok"}`,
  },
  "infra:redis_backup_stale": PAGE,
  // /tmp or /dev/shm inode/space use over the watchdog threshold (issue #5327;
  // the 2026-10-31 inode-full outage was silent). Watchdog-only, out-of-band.
  "infra:tmpfs_exhausted": PAGE,
  // The watchdog CLI itself cannot boot (broken node_modules / strip-types error
  // / node missing) so EVERY ported check is disarmed (issue #5099). Redis-free,
  // raised from hydra-watchdog.sh via operator-notify; never rides the bus.
  "infra:watchdog_cli_failed": PAGE,
  [E.LAUNCH_QUOTA_STRETCH]: PAGE_ALERT,
  [E.LAUNCH_LATENCY_BREACH]: PAGE_ALERT,
  // Deliberately NOT an alert: a deliberate overnight operator pause must never
  // leave a lingering unread dashboard alert (issue #3848).
  [E.LAUNCH_PAUSE_FORGOTTEN]: PAGE,
  [E.GLM_DRAINER_STERILE]: PAGE_ALERT,
  // Launch-flow fail-safe / meter-dark (watchdog-only, out-of-band: the
  // orchestrator may be down, so they never ride the bus — issue #5046).
  "launch:fail_safe": PAGE,
  "launch:meter_dark": PAGE,
  // The notification consumer is dead, deduped per consumer name.
  [E.CONSUMER_DEAD]: {
    disposition: "page",
    alert: true,
    dedupKey: (p: Payload): string => `consumer:dead:${String(p.consumer ?? "unknown")}`,
  },
  // An Outcome Holdback revert failed (the on-wire spelling src/holdback.ts
  // publishes — issue #5047)
  [E.HOLDBACK_REVERT_FAILED]: PAGE,
  // Orchestrator, autopilot, tunnel or backup service failures
  "service:orchestrator_failed": PAGE,
  "service:autopilot_failed": PAGE,
  "service:tunnel_failed": PAGE,
  "service:backup_failed": PAGE,
  // The /hydra-review pickup set going non-empty
  [E.REVIEW_PICKUP_READY]: PAGE,
  // No Morning Brief delivered for 26h (ADR-0045 Decision 8, issue #5048):
  // raised by the watchdog from the Redis last-sent key, independent of the
  // scheduler's running state — a silent channel must itself be noticeable.
  "brief:missing": PAGE,

  // ---- Morning Brief kinds -------------------------------------------------
  [E.CYCLE_COMPLETED]: {
    disposition: "brief",
    alert: false,
    briefLine: (item: BriefItem): string => {
      const merged = fact(item, "merged") === "true";
      const rolledBack = fact(item, "rolledBack") === "true";
      const state = merged ? "merged" : rolledBack ? "rolled back" : "completed";
      const title = fact(item, "title") ?? fact(item, "cycleId") ?? item.title;
      const sha = fact(item, "commitSha");
      return `Cycle ${state}: ${title}${sha ? ` (${sha7(sha)})` : ""}`;
    },
  },
  [E.DLQ_ALERT]: {
    disposition: "brief",
    alert: true,
    dedupKey: (p: Payload): string =>
      `dlq:${String(p.originalStream ?? "unknown")}:${String(p.eventType ?? "unknown")}`,
    briefLine: (item: BriefItem): string =>
      `Dead-letter alert: ${fact(item, "eventType") ?? "?"} from ${fact(item, "originalStream") ?? "?"} (delivery ${num(fact(item, "deliveryCount"))})`,
  },
  [E.DLQ_ENTRY]: {
    disposition: "brief",
    alert: false,
    briefLine: (item: BriefItem): string =>
      `Dead-letter entry: ${fact(item, "eventType") ?? "?"} from ${fact(item, "originalStream") ?? "?"}`,
  },
  [E.HOLDBACK_REVERTED]: {
    disposition: "brief",
    alert: false,
    briefLine: (item: BriefItem): string =>
      `Outcome Holdback auto-revert of ${sha7(fact(item, "commitSha"))}${fact(item, "prNumber") ? ` (PR #${fact(item, "prNumber")})` : ""} — leading outcomes regressed after self-mod`,
  },
  [E.HOLDBACK_CAP_REACHED]: {
    disposition: "brief",
    alert: false,
    briefLine: (item: BriefItem): string =>
      `Outcome Holdback per-day revert cap reached — regression on ${sha7(fact(item, "commitSha"))} suppressed`,
  },
  [E.MODEL_FALLBACK]: {
    disposition: "brief",
    alert: false,
    briefLine: (item: BriefItem): string =>
      `Model fallback ${fact(item, "from") ?? "?"} → ${fact(item, "to") ?? "?"} (${fact(item, "reason") ?? "no reason"})${fact(item, "until") ? ` until ${fact(item, "until")}` : ""}`,
  },
  [E.AUTOPILOT_PAUSED]: {
    disposition: "brief",
    alert: false,
    briefLine: (): string => "Autopilot paused by the operator",
  },
  [E.AUTOPILOT_RESUMED]: {
    disposition: "brief",
    alert: false,
    briefLine: (): string => "Autopilot resumed",
  },
  [E.BUILDER_HEALTH_STAGNATION]: {
    disposition: "brief",
    alert: false,
    briefLine: (item: BriefItem): string =>
      `Builder-health stagnation: ${fact(item, "signal") ?? "?"} [${fact(item, "realm") ?? "?"}] now ${num(fact(item, "current"))} vs baseline ${num(fact(item, "baseline"))}, sustained ${num(fact(item, "sustainedCycles"))} cycles`,
  },
  // The watchdog's per-unit failure brief item (operator-notify service-failed
  // path for a unit with no page row).
  "service:unit_failed": {
    disposition: "brief",
    alert: false,
    briefLine: (item: BriefItem): string => genericBriefLine(item),
  },
} as const;

/** The one table, keyed by kind. */
export const KIND_TABLE: Record<string, KindRow> = ROWS;

type Rows = typeof ROWS;

/** Kinds whose disposition is the literal "brief". */
type LiteralBriefKey = {
  [K in keyof Rows]: Rows[K]["disposition"] extends "brief" ? K : never;
}[keyof Rows];

/** A kind that can page (literal "page" or payload-aware). */
export type PageKind = Exclude<keyof Rows, LiteralBriefKey>;

/** A brief-severity vocabulary member. */
export type BriefKind = Extract<NotificationEventType, LiteralBriefKey>;

/** The row for `kind`, or undefined. Own-property lookup so "constructor" is not a kind. */
export function rowOf(kind: string): KindRow | undefined {
  return Object.hasOwn(KIND_TABLE, kind) ? KIND_TABLE[kind] : undefined;
}

/** Resolve a row's disposition for a payload. */
export function resolveDisposition(row: KindRow, payload?: Payload | null): "page" | "brief" {
  return typeof row.disposition === "function" ? row.disposition(payload ?? {}) : row.disposition;
}

/** Whether a row raises a dashboard alert for a payload. */
export function resolveAlert(row: KindRow, payload?: Payload | null): boolean {
  return typeof row.alert === "function" ? row.alert(payload ?? {}) : row.alert;
}

/** Edge-trigger identity for `kind` + payload (default: the kind). */
export function dedupKeyOf(kind: string, payload?: Payload | null): string {
  const row = rowOf(kind);
  return row?.dedupKey ? row.dedupKey(payload ?? {}) : kind;
}

/** Every kind that can page (literal "page" or payload-aware disposition). */
export const PAGE_KINDS: readonly PageKind[] = Object.entries(KIND_TABLE)
  .filter(([, row]) => row.disposition !== "brief")
  .map(([kind]) => kind as PageKind);

/** Every vocabulary member whose disposition is the literal "brief". */
export const BRIEF_KINDS: readonly BriefKind[] = (Object.values(E) as NotificationEventType[]).filter(
  (k): k is BriefKind => rowOf(k)?.disposition === "brief",
);

/** Event types that carry an alert flag (literal true or payload-aware). */
export const ALERT_TYPES: ReadonlySet<string> = new Set<string>(
  Object.entries(KIND_TABLE)
    .filter(([, row]) => row.alert !== false)
    .map(([kind]) => kind),
);

export function isPageKind(kind: string): kind is PageKind {
  const row = rowOf(kind);
  return !!row && row.disposition !== "brief";
}

/**
 * Event-aware page decision (#5065 QA round 2): the row's disposition resolved
 * against the payload. An unknown kind is never a page.
 */
export function isPageEvent(kind: string, payload?: Payload | null): boolean {
  const row = rowOf(kind);
  return !!row && resolveDisposition(row, payload) === "page";
}
