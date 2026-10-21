/**
 * Morning Brief line renderers (ADR-0045 Decision 7, issue #5047).
 *
 * `BRIEF_KINDS` is every `NOTIFICATION_EVENT_TYPES` value that is NOT on the
 * closed page list — derived, never hand-listed, so the vocabulary stays the
 * one source of truth. `BRIEF_LINE_RENDERERS` is typed `Record<BriefKind, …>`:
 * adding a brief-severity event type without a renderer arm is a `tsc` error,
 * and test/operator-channel-brief.test.mts iterates `BRIEF_KINDS` asserting a
 * non-empty line per kind. A kind outside the vocabulary (an arbitrary
 * `/events/publish` payload) renders through {@link renderBriefLine}'s generic
 * fallback and is never blank.
 *
 * Every renderer returns PLAIN TEXT. The HTML escaping happens exactly once,
 * in `brief-render.ts` through `escapeHtml` (ADR-0045 Decision 5).
 */

import {
  NOTIFICATION_EVENT_TYPES as E,
  type NotificationEventType,
} from "../event-bus-vocabulary.ts";
import { PAGE_KINDS, type PageKind } from "./page-list.ts";
import type { OperatorMessage } from "./message.ts";

/** A brief-severity vocabulary member: the vocabulary minus the page list. */
export type BriefKind = Exclude<NotificationEventType, PageKind>;

const PAGE_KIND_SET: ReadonlySet<string> = new Set<string>(PAGE_KINDS);

export const BRIEF_KINDS: readonly BriefKind[] = (Object.values(E) as NotificationEventType[]).filter(
  (k): k is BriefKind => !PAGE_KIND_SET.has(k),
);

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

/** `label: value` pairs for every fact, for the generic fallback line. */
function factsSummary(item: BriefItem): string {
  return item.facts.map((f) => `${f.label}=${f.value}`).join(", ");
}

export const BRIEF_LINE_RENDERERS: Record<BriefKind, BriefLineRenderer> = {
  [E.CYCLE_COMPLETED]: (item) => {
    const merged = fact(item, "merged") === "true";
    const rolledBack = fact(item, "rolledBack") === "true";
    const state = merged ? "merged" : rolledBack ? "rolled back" : "completed";
    const title = fact(item, "title") ?? fact(item, "cycleId") ?? item.title;
    const sha = fact(item, "commitSha");
    return `Cycle ${state}: ${title}${sha ? ` (${sha7(sha)})` : ""}`;
  },
  [E.DLQ_ALERT]: (item) =>
    `Dead-letter alert: ${fact(item, "eventType") ?? "?"} from ${fact(item, "originalStream") ?? "?"} (delivery ${num(fact(item, "deliveryCount"))})`,
  [E.DLQ_ENTRY]: (item) =>
    `Dead-letter entry: ${fact(item, "eventType") ?? "?"} from ${fact(item, "originalStream") ?? "?"}`,
  [E.HOLDBACK_REVERTED]: (item) =>
    `Outcome Holdback auto-revert of ${sha7(fact(item, "commitSha"))}${fact(item, "prNumber") ? ` (PR #${fact(item, "prNumber")})` : ""} — leading outcomes regressed after self-mod`,
  [E.HOLDBACK_CAP_REACHED]: (item) =>
    `Outcome Holdback per-day revert cap reached — regression on ${sha7(fact(item, "commitSha"))} suppressed`,
  [E.MODEL_FALLBACK]: (item) =>
    `Model fallback ${fact(item, "from") ?? "?"} → ${fact(item, "to") ?? "?"} (${fact(item, "reason") ?? "no reason"})${fact(item, "until") ? ` until ${fact(item, "until")}` : ""}`,
  [E.AUTOPILOT_PAUSED]: () => "Autopilot paused by the operator",
  [E.AUTOPILOT_RESUMED]: () => "Autopilot resumed",
  [E.BUILDER_HEALTH_STAGNATION]: (item) =>
    `Builder-health stagnation: ${fact(item, "signal") ?? "?"} [${fact(item, "realm") ?? "?"}] now ${num(fact(item, "current"))} vs baseline ${num(fact(item, "baseline"))}, sustained ${num(fact(item, "sustainedCycles"))} cycles`,
};

const RENDERERS: Record<string, BriefLineRenderer> = BRIEF_LINE_RENDERERS;

/**
 * Render one brief item as a plain-text line. A vocabulary member uses its
 * typed arm; anything else gets the generic `kind — title (facts)` line, so an
 * unknown on-wire kind is reported rather than silently dropped.
 */
export function renderBriefLine(item: BriefItem): string {
  const arm = RENDERERS[item.kind];
  if (arm) return arm(item);
  const facts = factsSummary(item);
  const title = item.title && item.title !== item.kind ? ` — ${item.title}` : "";
  return `${item.kind}${title}${facts ? ` (${facts})` : ""}`;
}

/**
 * Tolerant parse of a stored list entry. Returns null for an entry that is not
 * a brief item (corrupt, or missing kind/at) so one bad row never blanks the
 * section.
 */
export function briefItemFromStored(raw: unknown): BriefItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const kind = typeof r.kind === "string" ? r.kind : null;
  const at = typeof r.at === "number" ? r.at : Number(r.at);
  if (!kind || !Number.isFinite(at)) return null;
  const facts = Array.isArray(r.facts)
    ? r.facts
        .filter((f): f is { label: unknown; value: unknown } => !!f && typeof f === "object")
        .map((f) => ({ label: String(f.label), value: String(f.value) }))
    : [];
  const links = Array.isArray(r.links)
    ? r.links
        .filter((l): l is { label: unknown; url: unknown } => !!l && typeof l === "object")
        .map((l) => ({ label: String(l.label), url: String(l.url) }))
    : [];
  return {
    severity: "brief",
    kind,
    title: typeof r.title === "string" ? r.title : kind,
    facts,
    links,
    dedupKey: typeof r.dedupKey === "string" ? r.dedupKey : kind,
    at,
  };
}
