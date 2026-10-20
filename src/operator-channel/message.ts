/**
 * Operator Channel message model (ADR-0045, issue #5045).
 *
 * The one shape every Hydra→operator Telegram message takes before it is
 * rendered. Types only — severity policy lives in `page-list.ts`, rendering in
 * `render.ts`, delivery in `channel.ts`.
 */

export type OperatorSeverity = "page" | "brief";

export interface OperatorFact {
  label: string;
  value: string;
}

export interface OperatorLink {
  label: string;
  url: string;
}

/** Names an ADR-0034 §8 operator-action registry entry (resolved at render time). */
export interface OperatorAction {
  name: string;
}

export interface OperatorMessage {
  severity: OperatorSeverity;
  /** A PageKind for pages; the bus event type for brief items. */
  kind: string;
  title: string;
  facts: OperatorFact[];
  links: OperatorLink[];
  /** Edge-trigger identity: repeats of the same key are suppressed. */
  dedupKey: string;
  action?: OperatorAction;
}
