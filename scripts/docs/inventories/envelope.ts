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

/** Corpus tier (#4544 decision 2): which part of the /docs page a member belongs to. */
export type CorpusTier = "living" | "playbook" | "historical";

/** One row of the corpus family (docs/generated/corpus.json, #4591). */
export interface CorpusRow {
  /** Repo-relative markdown path the dashboard build renders. */
  path: string;
  tier: CorpusTier;
  /** The /docs page route for this file — derived from `path` only. */
  route: string;
  /** First `# ` heading, else the file basename. */
  title: string;
}

/** Where a row's truth lives: repo-relative file + 1-based line. */
export interface SourceRef {
  path: string;
  line: number;
}

/** One row of the redis-keys family (docs/generated/redis-keys.json, #4594). */
export interface RedisKeyRow {
  /** The `redisKeys` member name; null for a retired-family row. */
  builder: string | null;
  /** The key shape with `{param}` placeholders (retired rows: the declared literal). */
  pattern: string;
  /** Builder parameter names, in order. */
  params: string[];
  /** `redisKeys.<builder>` tokens in src/ + scripts/ outside keys.ts (comments stripped). */
  callSites: number;
  /** The src/redis/*.ts files among the call sites (Redis Adapters), sorted. */
  accessors: string[];
  /** `METHOD /api/path` labels of routes whose router directly imports an accessor. */
  servedBy: string[];
  /** The first serving route's home, or null when no route reads this directly. */
  home: string | null;
  /** True only for a declared retired family still referenced in adapter code. */
  retired: boolean;
  source: SourceRef;
}

/** One row of the streams family (docs/generated/streams.json, #4594). */
export interface StreamRow {
  /** The constant name inside STREAMS / RETAINED_STREAMS, e.g. "NOTIFICATIONS". */
  constant: string;
  /** The on-wire stream key, e.g. "hydra:notifications". */
  key: string;
  /** True for a RETAINED_STREAMS member (no live consumer). */
  retained: boolean;
  /** CONSUMER_GROUPS entry for the key; [] when none. */
  consumerGroups: string[];
  servedBy: string[];
  home: string | null;
  source: SourceRef;
}

/** One row of the schemas family (docs/generated/schemas.json, #4594). */
export interface SchemaRow {
  /** The exported zod value's identifier. */
  name: string;
  /** Repo-relative src/schemas/<domain>.ts file. */
  file: string;
  /** Every first-party src file importing it, sorted. */
  importedBy: string[];
  /** `METHOD /api/path` labels joined by nearest-preceding registration. */
  routes: string[];
  source: SourceRef;
}

/** One row of the tier-paths family (docs/generated/tier-paths.json, #4594). */
export interface TierPathRow {
  tier: 1 | 2 | 3 | 4;
  kind: "prefix" | "file" | "default";
  /** The path or prefix; "*" for the T3 default row. */
  path: string;
  source: SourceRef;
}

/** One row of the chores family (docs/generated/chores.json, #4594). */
export interface ChoreRow {
  /** 0-based registry execution order. */
  order: number;
  name: string;
  cadence: "weekly" | "daily" | "every-run";
  source: SourceRef;
}

/** One row of the env-vars family (docs/generated/env-vars.json, #4594). Names and sites only — never a value. */
export interface EnvVarRow {
  name: string;
  readSites: SourceRef[];
  inEnvExample: boolean;
  source: SourceRef;
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

/** The corpus inventory: envelope + corpus rows. */
export type CorpusInventory = Inventory<CorpusRow>;

/** The counts inventory: envelope + metric rows. */
export type CountsInventory = Inventory<CountRow>;

export type RedisKeysInventory = Inventory<RedisKeyRow>;
export type StreamsInventory = Inventory<StreamRow>;
export type SchemasInventory = Inventory<SchemaRow>;
export type TierPathsInventory = Inventory<TierPathRow>;
export type ChoresInventory = Inventory<ChoreRow>;
export type EnvVarsInventory = Inventory<EnvVarRow>;

/** The committed byte form: two-space JSON + trailing newline. */
export function serializeInventory<Row>(inventory: Inventory<Row>): string {
  return `${JSON.stringify(inventory, null, 2)}\n`;
}
