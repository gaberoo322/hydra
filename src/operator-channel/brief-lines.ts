/**
 * Morning Brief line renderers (ADR-0045 Decision 7, issue #5047).
 *
 * `BRIEF_KINDS` is every notification event type that is NOT on the closed page
 * list — derived from `NOTIFICATION_EVENT_TYPES`, so there is one source of
 * truth. `BRIEF_LINE_RENDERERS` is typed `Record<BriefKind, …>`: adding a type
 * to the vocabulary without a rendering arm is a compile error, and
 * `test/operator-channel-brief.test.mts` additionally iterates `BRIEF_KINDS`
 * asserting each renders a non-empty line. A kind outside the vocabulary (an
 * arbitrary `/events/publish` payload) renders through one generic fallback and
 * is never blank.
 *
 * Renderers return PLAIN text; the HTML renderer (`brief-render.ts`) applies the
 * single escaper. Pure: no I/O, no clock.
 */

import { NOTIFICATION_EVENT_TYPES, type NotificationEventType } from "../event-bus-vocabulary.ts";
import type { PageKind } from "./page-list.ts";
import { isPageKind } from "./page-list.ts";

/** A stored Morning Brief item (the shape `OperatorChannel.brief` appends). */
export interface BriefItem {
  kind: string;
  title: string;
  facts: Array<{ label: string; value: string }>;
  at: number;
}

export type BriefKind = Exclude<NotificationEventType, PageKind>;

export const BRIEF_KINDS: readonly BriefKind[] = (
  Object.values(NOTIFICATION_EVENT_TYPES) as NotificationEventType[]
).filter((k): k is BriefKind => !isPageKind(k));

function fact(item: BriefItem, ...labels: string[]): string | undefined {
  for (const label of labels) {
    const hit = item.facts?.find((f) => f.label === label);
    if (hit && hit.value !== "") return hit.value;
  }
  return undefined;
}

function short(sha: string | undefined): string {
  return sha ? sha.slice(0, 8) : "unknown commit";
}

/** Generic line: `kind: title (label=value, …)`. Never blank. */
export function genericBriefLine(item: BriefItem): string {
  const factText = (item.facts ?? [])
    .slice(0, 4)
    .map((f) => `${f.label}=${f.value}`)
    .join(", ");
  const title = item.title && item.title !== item.kind ? ` ${item.title}` : "";
  return `${item.kind}:${title}${factText ? ` (${factText})` : ""}`.trim();
}

export const BRIEF_LINE_RENDERERS: Record<BriefKind, (item: BriefItem) => string> = {
  "cycle:completed": (i) =>
    `Cycle completed: ${fact(i, "title", "cycleId") ?? (i.title !== i.kind ? i.title : "(untitled)")}`,
  "dlq:alert": (i) =>
    `Dead-letter alert: ${fact(i, "eventType") ?? "unknown event"} on ${fact(i, "originalStream") ?? "unknown stream"}`,
  "dlq:entry": (i) =>
    `Dead-letter entry: ${fact(i, "eventType") ?? "unknown event"} from ${fact(i, "originalStream") ?? "unknown stream"}`,
  "holdback.reverted": (i) => `Outcome Holdback reverted ${short(fact(i, "commitSha"))}`,
  "holdback.cap-reached": (i) =>
    `Outcome Holdback daily revert cap reached (suppressed ${short(fact(i, "commitSha"))})`,
  "model-fallback": (i) =>
    `Model fallback engaged${fact(i, "reason") ? `: ${fact(i, "reason")}` : ""}`,
  "autopilot-paused": () => "Autopilot paused",
  "autopilot-resumed": () => "Autopilot resumed",
  "builder-health.stagnation": (i) =>
    `Builder-health stagnation: ${fact(i, "signal") ?? "signal"} (${fact(i, "realm") ?? "realm"})`,
};

/** Render one brief item as a plain-text line; unknown kinds use the generic fallback. */
export function renderBriefLine(item: BriefItem): string {
  const renderer = (BRIEF_LINE_RENDERERS as Record<string, ((i: BriefItem) => string) | undefined>)[item.kind];
  const line = renderer ? renderer(item) : genericBriefLine(item);
  return line.trim() !== "" ? line : genericBriefLine({ ...item, kind: item.kind || "unknown" }) || "unknown event";
}
