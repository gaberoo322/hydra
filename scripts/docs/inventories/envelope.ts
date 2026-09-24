/**
 * Shared envelope for every generated feature inventory (issue #4589 — the
 * inventory-pipeline tracer bullet per the #4542 resolution and ADR-0034 §10).
 *
 * One envelope shape for every family file committed under docs/generated/:
 *
 *   { family, schemaVersion, generatedFrom, rows }
 *
 * - NO timestamp, NO commit SHA — a regenerated file on an unchanged tree is
 *   byte-identical (#4542 decision 2: a timestamp churns every regeneration;
 *   provenance is the deploy SHA the /docs page renders, not the artifact).
 * - `generatedFrom` holds GLOBS, not expanded file lists — stable across
 *   router additions, and the regeneration contract stays "you touched a file
 *   matching these".
 * - `serializeInventory` is the byte-exact committed form: two-space indented
 *   JSON + trailing newline. The drift test and the runner's `--check` both
 *   compare against it, so there is exactly one serialization truth.
 *
 * Stdlib-only (ADR-0005): this module imports nothing at all.
 */

/** Per-route lifecycle state (ADR-0024 §3, amended by #4587). */
export type Stability = "stable" | "experimental" | "deprecated";

/** One row of the routes family (docs/generated/routes.json). */
export interface RouteRow {
  /** Uppercase HTTP method, e.g. "GET". */
  method: string;
  /** Full path INCLUDING the /api prefix, e.g. "/api/agents/stream". */
  path: string;
  /** Lifecycle state; absent annotation = "stable". */
  stability: Stability;
  /** Text after the em-dash in a `@stability` annotation; null when stable. */
  stabilityNote: string | null;
  /** Repo-relative dashboard/src files that call this path (path-only match). */
  consumers: string[];
  /** The ONE dashboard page a route call-out deep-links to (ADR-0034 §9.4). */
  home: string;
  /** First-party src/ modules the router file imports, collapsed (finding 1). */
  areas: string[];
  /** Where the registration lives: file + line of the `router.<verb>(` token. */
  source: { path: string; line: number };
}

/** One row of the counts family (docs/generated/counts.json). */
export interface CountRow {
  family: string;
  metric: string;
  value: number;
}

/** The envelope every generated inventory file carries. */
export interface Inventory<Row> {
  family: string;
  schemaVersion: 1;
  generatedFrom: string[];
  rows: Row[];
}

/** The routes inventory: envelope + route rows. */
export type RoutesInventory = Inventory<RouteRow>;

/** The counts inventory: envelope + metric rows. */
export type CountsInventory = Inventory<CountRow>;

/** The committed byte form: two-space JSON + trailing newline. */
export function serializeInventory<Row>(inventory: Inventory<Row>): string {
  return `${JSON.stringify(inventory, null, 2)}\n`;
}
