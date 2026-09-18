#!/usr/bin/env -S npx tsx
/**
 * post-merge-health — alarm-only operational-health smoke check for the Target
 * (issue #1054, epic #1052 "selectively converge the Target SDLC").
 *
 * WHY THIS EXISTS
 * ---------------
 * The Orchestrator gates its own merges with per-merge **Outcome Holdback** —
 * it merges, then watches a fast outcome signal and reverts on regression. That
 * mechanism is unusable for the Target: settlement outcomes are
 * settlement-lagged (hours/days, not merge-attributable) and the
 * outcome-ingestion seam was removed (#933). Epic #1052 therefore replaces
 * per-merge Holdback for the Target with a cheaper, alarm-only post-merge watch
 * keyed on *fast operational-health signals the Target already exposes*.
 *
 * This is the lowest-effort, highest-attribution slice: it samples signals that
 * already exist on the Target's web service (`/api/health/full`, with a
 * `/api/health` fallback — see HEALTH ROUTES below) right after a Target merge
 * and, if operational health has regressed past a configurable noise floor,
 * raises a **hydra-target-incident** alarm.
 *
 * ALARM-ONLY — NEVER AUTO-REVERT
 * ------------------------------
 * This watcher deliberately does NOT revert, gate, or block any merge. It runs
 * *after* the merge has already landed and only *observes*. On a detected
 * regression it dispatches the `hydra-target-incident` skill (which decides whether to
 * investigate/fix/revert). The post-merge watch is an alarm bell, not a merge
 * gate — see epic #1052's rationale ("the post-merge watch keys on fast
 * operational-health signals in alarm-only mode").
 *
 * FAIL-LOUD, NEVER THROW (issue #4524)
 * ------------------------------------
 * If the Target API is unreachable (service down mid-deploy, port not yet up,
 * network blip, or a body that is not health-shaped JSON — e.g. a proxy HTML
 * error page), the run returns the explicit `{ kind: "unreachable" }` result
 * and logs a loud BASELINE FAILURE (snapshot mode) / PROBE FAILURE (post-merge
 * mode) line naming the URL(s) probed and the HYDRA_TARGET_WEB_URL knob — an
 * unreachable Target means the post-merge watch compares NOTHING, which is
 * itself alarm-worthy operator signal, not something to swallow quietly. It
 * still MUST NOT throw — an unreachable Target is not itself a merge
 * regression, and a throwing post-merge probe must never look like a build
 * failure — and it still never dispatches hydra-target-incident and still
 * exits 0 on this path. Per the Orchestrator convention, nothing here ever
 * throws on the I/O path; callers read the returned result object.
 *
 * NON-2xx WITH A HEALTH BODY IS A VALID SAMPLE (issue #1699)
 * ----------------------------------------------------------
 * `/api/health/full` answers HTTP 503 *with a full per-service JSON body* when
 * the overall status is degraded/error — that is the endpoint's convention, not
 * an outage. Discarding non-2xx responses (the pre-#1699 behavior) meant the
 * watcher yielded ZERO signal exactly when the Target was unhealthy, so a
 * merge-caused regression was indistinguishable from ambient degradation. Any
 * HTTP response — regardless of status code — whose body parses as a JSON
 * object with a string `status` field is therefore a valid health sample; only
 * network errors, timeouts, and non-JSON / shape-invalid bodies count as
 * unreachable.
 *
 * HEALTH ROUTES: FULL FIRST, BASIC FALLBACK (issue #4524)
 * ------------------------------------------------------
 * The Target's web service exposes two health shapes:
 *   - `/api/health/full` — `{ status, services: { <name>: { status } } }`
 *     (the richer per-service map this watcher was built on);
 *   - `/api/health`      — `{ status, service, time, <dep>: { status, … } }`
 *     (a basic shape: overall status plus per-dependency objects).
 * fetchTargetHealth probes the FULL route first. ONLY an HTTP 404 on it —
 * checked BEFORE the body is parsed, because a Next.js 404 is an HTML page —
 * triggers a second probe of the BASIC route; the sample records which route
 * answered (`route: "full" | "basic"`). Any other outcome on the full route
 * (5xx, non-JSON body, network error, timeout, JSON without a string status)
 * is classified unreachable exactly as before: a Target that HAS the full route
 * but serves an error page is a different fact from one that lacks the route,
 * and masking it with a shallower basic sample would hide exactly the
 * regression this watch exists to catch. The #1699 any-status-with-health-body
 * rule applies unchanged on both routes.
 *
 * BASELINE-DELTA MODE (issue #1699)
 * ---------------------------------
 * While the Target baseline is ambiently degraded, absolute thresholds cannot
 * tell "this merge broke it" from "it was already broken". The caller
 * (hydra-target-build) therefore captures a pre-merge baseline snapshot via
 * `--snapshot-out <path>` just before the merge lands, and passes
 * `--baseline <path>` to the post-merge run. In delta mode, ambient
 * (pre-existing) degradation alone NEVER alarms — only deltas do:
 *   - services newly not-ok (were ok or absent in the baseline),
 *   - per-service severity worsening (degraded -> error),
 *   - overall severity-rank worsening (ok=0 < degraded=unknown=1 < error=2).
 * The HYDRA_PMH_* floors keep their names and meanings; in delta mode they
 * apply to *delta* counts instead of absolute counts. When no --baseline is
 * supplied (legacy/manual callers, lost file), the watcher falls back to the
 * absolute-threshold evaluator but reports any breach as INCONCLUSIVE rather
 * than alarming (see ABSOLUTE-MODE below). The baseline is a plain file
 * (node:fs) — never Redis / the orchestrator API — so the script stays
 * leaf-level for sync-target-gate.sh mirroring (#1451).
 *
 * ABSOLUTE-MODE IS NON-BLOCKING (issue #1817 recurrence)
 * ------------------------------------------------------
 * Post-merge health is a *regression* signal — it attributes a fault to a merge
 * only by diffing post-merge state against a pre-merge baseline. With NO
 * baseline the comparator measures the Target's absolute state against fixed
 * floors, and the Target's chronic-degraded floor structurally exceeds those
 * floors on EVERY merge regardless of what changed: opticOdds is
 * unconfigured-by-design (provider class), pinnacle has never had data
 * (execution class), and freshness-class services are stale ~90-98% of the time
 * because their freshness window (180s/300s) is far tighter than the cron
 * cadence (~30min/~4h). So the freshness-flap suppression (issue #1817, delta
 * mode) never runs on this path, and the absolute floors false-positive on
 * every merge — the 2026-06-13 recurrences (#1817). The orchestrator-only fix
 * is to make the absolute-threshold fallback NON-BLOCKING: an absolute breach is
 * reported `inconclusive` (logged for diagnostics, hydra-target-incident NEVER
 * dispatched) instead of alarming. The real fix that restores a signal is
 * supplying a pre-merge --baseline (delta mode), which the paved
 * hydra-target-build road now does on both merge paths (#1839). An operator who
 * genuinely wants absolute-mode alarms opts back in with
 * HYDRA_PMH_ALARM_WITHOUT_BASELINE=1.
 *
 * SIGNAL MODEL
 * ------------
 * Both routes normalize into one TargetHealthSnapshot:
 *   - `/api/health/full` contributes the per-service map verbatim;
 *   - `/api/health`'s per-dependency objects (e.g. `db: { status }`) are mapped
 *     as services by ONE generic rule — every top-level key other than
 *     `services` whose value is an object carrying a string `status` becomes
 *     services[<key>].
 * Service status words are normalized to the severity vocabulary:
 * `reachable|healthy|up` -> `ok`, `unreachable|down` -> `error`; anything else
 * is preserved verbatim (lowercased) and still ranks as not-ok. We map the
 * service set to three merge-attributable signals named in the issue:
 *   - overall health status (`ok`/`degraded`/`error`)
 *   - execution-success proxy: count of *execution-class* services not `ok`
 *     (scanner, ingestion, execution, db/database, …) — a regression here means
 *     the merge broke the run/execution path
 *   - provider/API error proxy: count of *provider-class* services not `ok`
 *     (opticOdds, pinnacle*, kalshi, polymarket, provider*) — a regression here
 *     means the merge broke an external-data integration
 * Any service that doesn't match an execution/provider keyword still counts
 * toward the generic "services not ok" floor, so a brand-new failing service is
 * never silently ignored.
 *
 * BASE URL VIA THE TARGET-CONFIG SEAM (issue #4524)
 * ------------------------------------------------
 * The base URL is resolved by getTargetWebUrl() in src/target-config.ts (env
 * HYDRA_TARGET_WEB_URL, legacy alias HYDRA_BETTING_URL, soft default
 * DEFAULT_TARGET_WEB_URL) — this script carries NO port literal and no
 * Target-specific URL. The retired script-local HYDRA_TARGET_API_URL override
 * is gone: one fact, one seam (ADR-0013).
 *
 * NOISE FLOOR (all configurable via env — see DEFAULTS below)
 * ----------------------------------------------------------
 *   - HYDRA_TARGET_WEB_URL             base URL of the Target web service
 *                                     (resolved via the target-config seam;
 *                                     the script reads no URL env itself)
 *   - HYDRA_PMH_ALARM_ON_OVERALL      overall statuses that alarm (csv)
 *   - HYDRA_PMH_MAX_DEGRADED_SERVICES services-not-ok count tolerated before alarm
 *   - HYDRA_PMH_MAX_EXECUTION_ERRORS  execution-class not-ok count tolerated
 *   - HYDRA_PMH_MAX_PROVIDER_ERRORS   provider-class not-ok count tolerated
 *   - HYDRA_PMH_TIMEOUT_MS            per-request fetch timeout
 *   - HYDRA_PMH_DISPATCH              "1" to actually dispatch hydra-target-incident,
 *                                     anything else => dry-run (print only)
 *   - HYDRA_PMH_FRESHNESS_SERVICES    csv keyword allowlist of freshness-class
 *                                     service names whose ok->soft delta is
 *                                     suppressed (see FRESHNESS-FLAP below)
 *   - HYDRA_PMH_ALARM_WITHOUT_BASELINE "1" to alarm on an absolute-floor breach
 *                                     even with NO baseline (legacy behavior);
 *                                     default off — see ABSOLUTE-MODE below
 *
 * FRESHNESS-FLAP SUPPRESSION (issue #1817)
 * ----------------------------------------
 * Several Target services derive their status purely from the *freshness* of the
 * latest persisted pipeline run: `state==="fresh"` (within a short freshness
 * window) => ok, else degraded/stale. When that freshness window (e.g. the
 * scanner's 180s) is far tighter than the underlying cron cadence (e.g. ~30min),
 * the signal FLAPS ok<->degraded purely as a function of WHEN the single health
 * probe fires relative to the cron — not because of any merge. A one-shot
 * delta comparator that happened to sample the baseline inside the fresh window
 * and the post-merge probe outside it therefore reports a phantom
 * `scanner: ok -> degraded` regression that is a pure sampling-phase artifact
 * (the 2026-06-13 false-positives on the then-Target — issue #1817).
 *
 * The orchestrator comparator cannot observe the Target's cron cadence, so it
 * cannot debounce by re-sampling (that would need 30min+ of probing and couple
 * the comparator to the Target schedule — both rejected in the #1817 design
 * concept). The orchestrator-only fix is a SCOPED suppression rule inside
 * evaluateDelta: the SINGLE delta we suppress is the ok(rank 0) -> soft(rank 1,
 * i.e. degraded/stale/unknown) transition, and ONLY for services whose name
 * matches a freshness-class keyword allowlist (scanner, ingest, pinnacle,
 * fairline, freshness — env-overridable via HYDRA_PMH_FRESHNESS_SERVICES).
 * Everything else still counts as a regression:
 *   - ANY transition INTO error (rank 2) on ANY service (a freshness flap never
 *     produces an error; an error is unambiguous and always alarms);
 *   - any worsening from an already-not-ok baseline (e.g. degraded -> error);
 *   - ok -> degraded on a HARD-CHECK (non-freshness) service — e.g. a genuine
 *     `database: ok -> degraded` still alarms; suppression is NEVER global.
 * The overall status is derived from the per-service set, so a freshness flap on
 * one service can drag overall ok -> degraded; that overall worsening is ALSO
 * suppressed, but ONLY when every per-service delta was a freshness flap (no
 * surviving delta) and the overall went into soft rank (not error). An overall
 * worsening into error, or with any surviving per-service delta, still alarms.
 * Recovered/improved services and same-rank drift stay ignored (unchanged). The
 * absolute-threshold fallback evaluator is intentionally left alone: the flap is
 * a baseline-relative sampling artifact, so the suppression only makes sense in
 * delta mode (the paved hydra-target-build road always supplies a baseline).
 *
 * USAGE
 * -----
 *   # pre-merge (hydra-target-build Step 7): capture the baseline
 *   tsx scripts/target/post-merge-health.ts --snapshot-out <path>
 *   # post-merge (hydra-target-build Step 8.6): compare against the baseline
 *   tsx scripts/target/post-merge-health.ts [--merge-sha <sha>] [--baseline <path>] [--dry-run]
 *
 * Intended to be fired by hydra-target-build right after an emulated
 * merge-on-green lands (see docs/operator-playbooks/hydra-target-build.md). It
 * is leaf-level: it imports only Node stdlib plus the target-config seam
 * (`src/target-config.ts` — itself `node:`-stdlib-only, and already in the
 * sync-target-gate.sh mirror closure), so it has no coupling to the
 * orchestrator service and can run from any worktree (issue #4524).
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { getTargetName, getTargetWebUrl } from "../../src/target-config.ts";

// ── Defaults ────────────────────────────────────────────────────────────────

const DEFAULTS = {
  /** Overall `/api/health/full` statuses that constitute an alarm. */
  alarmOnOverall: ["error"] as string[],
  /** Tolerated count of services not `ok` before alarming. */
  maxDegradedServices: 2,
  /** Tolerated count of execution-class services not `ok` before alarming. */
  maxExecutionErrors: 0,
  /** Tolerated count of provider-class services not `ok` before alarming. */
  maxProviderErrors: 1,
  /** Per-request fetch timeout (ms). */
  timeoutMs: 5000,
  /**
   * Freshness-class keyword allowlist (issue #1817). A service whose name
   * matches any of these fragments has its ok->soft (degraded/stale/unknown)
   * delta suppressed as a freshness-window flap. Defaults to the data/freshness
   * services named in #1817; env-overridable via HYDRA_PMH_FRESHNESS_SERVICES.
   */
  freshnessServices: ["scanner", "ingest", "pinnacle", "fairline", "freshness"] as string[],
};

/**
 * Keyword fragments that classify a service name as execution-class. `db` and
 * `database` (issue #4524): the basic `/api/health` shape exposes the Target's
 * database as a `db` dependency — a database going not-ok post-merge is an
 * execution-class regression (default floor 0 → alarms in delta mode), not a
 * generic one that the maxDegradedServices floor would tolerate.
 */
const EXECUTION_SERVICE_KEYWORDS = [
  "scanner",
  "ingest",
  "execution",
  "exec",
  "settle",
  "order",
  "db",
  "database",
];
/** Keyword fragments that classify a service name as provider-class. */
const PROVIDER_SERVICE_KEYWORDS = ["provider", "opticodds", "pinnacle", "kalshi", "polymarket", "venue", "api"];

// ── Types ────────────────────────────────────────────────────────────────────

export type ServiceStatus = "ok" | "degraded" | "error" | string;

export interface PostMergeHealthConfig {
  apiUrl: string;
  alarmOnOverall: string[];
  maxDegradedServices: number;
  maxExecutionErrors: number;
  maxProviderErrors: number;
  timeoutMs: number;
  /**
   * Freshness-class keyword allowlist (issue #1817): service names matching any
   * of these fragments have their ok->soft delta suppressed as a freshness-flap.
   */
  freshnessServices: string[];
  /**
   * When true, an absolute-floor breach with NO pre-merge baseline still alarms
   * + dispatches (the pre-#1817-recurrence behavior). Defaults to FALSE: without
   * a baseline the comparator has no regression signal, so an absolute breach on
   * the Target's chronic-degraded floor is reported `inconclusive`, never an
   * alarm. Env-overridable via HYDRA_PMH_ALARM_WITHOUT_BASELINE=1.
   */
  alarmWithoutBaseline: boolean;
  /** When false, an alarm is logged + printed but hydra-target-incident is not spawned. */
  dispatch: boolean;
}

/**
 * Script-local normalized view of /api/health/full. Named TargetHealthSnapshot
 * (not HealthSnapshot) to avoid colliding with the orchestrator's CONTEXT.md
 * **Health Snapshot** term (the /api/health/deep internal model) — this leaf
 * script never imports orchestrator code, but the name should not lie.
 */
export interface TargetHealthSnapshot {
  /** Overall `status` field from /api/health/full (lowercased). */
  overall: ServiceStatus;
  /** Per-service status map, service name => lowercased status string. */
  services: Record<string, ServiceStatus>;
  /** Count of services whose status is not "ok". */
  servicesNotOk: number;
  /** Count of execution-class services whose status is not "ok". */
  executionErrors: number;
  /** Count of provider-class services whose status is not "ok". */
  providerErrors: number;
}

export interface RegressionVerdict {
  /** True when at least one configured threshold was breached. */
  regressed: boolean;
  /** Human-readable reasons (one per breached threshold). Empty when healthy. */
  reasons: string[];
  snapshot: TargetHealthSnapshot;
}

/** How the post-merge verdict was computed (issue #1699). */
export type EvaluationMode = "absolute" | "delta";

/** Discriminated result of one watcher run. Never thrown — always returned. */
export type WatchResult =
  | { kind: "unreachable"; reason: string }
  | { kind: "baseline-written"; path: string; snapshot: TargetHealthSnapshot }
  | { kind: "baseline-write-failed"; reason: string }
  | { kind: "healthy"; verdict: RegressionVerdict; mode: EvaluationMode }
  | { kind: "alarm"; verdict: RegressionVerdict; dispatched: boolean; mode: EvaluationMode }
  // No pre-merge baseline was available (issue #1817 recurrence). Post-merge
  // health is a REGRESSION signal — meaningless without a baseline to diff
  // against — so an absolute-floor breach is reported as inconclusive (logged,
  // NEVER dispatched) rather than alarming on the Target's chronic-degraded
  // floor. Opt back into the legacy absolute-alarm behavior with
  // HYDRA_PMH_ALARM_WITHOUT_BASELINE=1. `verdict` carries the absolute-floor
  // breach that WOULD have alarmed, for diagnostics.
  | { kind: "inconclusive"; verdict: RegressionVerdict; reason: string };

/**
 * Which health route answered the sample (issue #4524): "full" is
 * `/api/health/full`, "basic" is the `/api/health` fallback taken when the full
 * route answers HTTP 404.
 */
export type HealthRoute = "full" | "basic";

/**
 * Discriminated result of a Target health fetch. Never thrown — always
 * returned. `httpStatus` rides along on success because a valid sample may
 * arrive on a non-2xx response (issue #1699): /api/health/full answers 503
 * with a full health body when the overall status is degraded/error. `route`
 * names which route actually answered (issue #4524).
 */
export type FetchHealthResult =
  | { ok: true; body: unknown; httpStatus: number; route: HealthRoute }
  | { ok: false; reason: string };

// ── Config ────────────────────────────────────────────────────────────────────

function parseCsvEnv(raw: string | undefined, fallback: string[]): string[] {
  if (!raw || !raw.trim()) return fallback;
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

function parseIntEnv(raw: string | undefined, fallback: number): number {
  if (!raw || !raw.trim()) return fallback;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Build the watcher config from the environment, layering env overrides over
 * DEFAULTS. `dispatch` defaults to false (dry-run); set HYDRA_PMH_DISPATCH=1 (or
 * pass --dispatch) to actually spawn hydra-target-incident.
 *
 * BASE URL (issue #4524): `apiUrl` is resolved by getTargetWebUrl()
 * (src/target-config.ts — env HYDRA_TARGET_WEB_URL, legacy alias
 * HYDRA_BETTING_URL, soft default DEFAULT_TARGET_WEB_URL), so this script
 * carries no port literal and the retired script-local HYDRA_TARGET_API_URL
 * override is gone. The `env` parameter governs only the HYDRA_PMH_* knobs;
 * the seam reads process.env itself, exactly as every other consumer does.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): PostMergeHealthConfig {
  return {
    apiUrl: getTargetWebUrl().replace(/\/+$/, ""),
    alarmOnOverall: parseCsvEnv(env.HYDRA_PMH_ALARM_ON_OVERALL, DEFAULTS.alarmOnOverall),
    maxDegradedServices: parseIntEnv(env.HYDRA_PMH_MAX_DEGRADED_SERVICES, DEFAULTS.maxDegradedServices),
    maxExecutionErrors: parseIntEnv(env.HYDRA_PMH_MAX_EXECUTION_ERRORS, DEFAULTS.maxExecutionErrors),
    maxProviderErrors: parseIntEnv(env.HYDRA_PMH_MAX_PROVIDER_ERRORS, DEFAULTS.maxProviderErrors),
    timeoutMs: parseIntEnv(env.HYDRA_PMH_TIMEOUT_MS, DEFAULTS.timeoutMs),
    freshnessServices: parseCsvEnv(env.HYDRA_PMH_FRESHNESS_SERVICES, DEFAULTS.freshnessServices),
    alarmWithoutBaseline: env.HYDRA_PMH_ALARM_WITHOUT_BASELINE === "1",
    dispatch: env.HYDRA_PMH_DISPATCH === "1",
  };
}

// ── Snapshot parsing (pure) ────────────────────────────────────────────────────

function classify(serviceName: string, keywords: string[]): boolean {
  const lower = serviceName.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

/**
 * True when a service name matches the configured freshness-class keyword
 * allowlist (issue #1817). A freshness-class service derives its status from
 * data freshness, so its ok->soft (degraded/stale) transition can be a pure
 * sampling-phase flap rather than a real regression — only THIS transition,
 * and only for THESE services, is suppressed in evaluateDelta. Exported so the
 * suppression rule is unit-testable in isolation.
 */
export function isFreshnessClass(serviceName: string, freshnessServices: string[]): boolean {
  return classify(serviceName, freshnessServices);
}

/**
 * Decide whether a single per-service delta counts as a regression (issue
 * #1817). Pure. A delta counts iff the severity worsened AND it is not a scoped
 * freshness-flap. The ONLY suppressed transition is ok(rank 0) -> soft(rank 1,
 * i.e. degraded/stale/unknown) on a freshness-class service. ANY transition
 * into error (rank 2), and ANY worsening from an already-not-ok baseline, still
 * counts — so a genuine database ok->degraded (hard-check service) and any
 * scanner ok->error / stale->error all still alarm.
 */
export function deltaCounts(
  serviceName: string,
  before: ServiceStatus | undefined,
  after: ServiceStatus,
  freshnessServices: string[],
): boolean {
  const beforeRank = before === undefined ? 0 : severityRank(before);
  const afterRank = severityRank(after);
  if (afterRank <= beforeRank) return false; // not a worsening
  // Suppress ONLY ok(0) -> soft(1) on a freshness-class service. Any move into
  // error (rank 2) and any non-freshness service still counts.
  if (beforeRank === 0 && afterRank === 1 && isFreshnessClass(serviceName, freshnessServices)) {
    return false;
  }
  return true;
}

/**
 * Status-word normalisation (issue #4524). The basic `/api/health` shape uses a
 * reachability vocabulary (`reachable`, `unreachable`) rather than the severity
 * vocabulary (`ok`/`degraded`/`error`) the evaluators rank. Map the known
 * synonyms onto the severity vocabulary; anything unfamiliar is preserved
 * verbatim (lowercased) so it still ranks as not-ok (severityRank 1), matching
 * the pre-existing "unknown convention = degraded" rule.
 */
const STATUS_WORD_ALIASES: Record<string, ServiceStatus> = {
  reachable: "ok",
  healthy: "ok",
  up: "ok",
  unreachable: "error",
  down: "error",
};

function normaliseServiceStatus(raw: string): ServiceStatus {
  const lower = raw.toLowerCase();
  return STATUS_WORD_ALIASES[lower] ?? lower;
}

/**
 * Parse a raw health-route JSON body (either route — see HEALTH ROUTES above)
 * into a normalized TargetHealthSnapshot. Tolerant of shape drift: a
 * missing/oddly-typed `services` map yields an empty service set rather than
 * throwing, and unknown statuses are preserved verbatim (lowercased) so a
 * future status string still counts as "not ok".
 *
 * Per-dependency fields (issue #4524): the basic `/api/health` shape carries
 * dependencies as top-level objects (e.g. `db: { status, latencyMs }`). ONE
 * generic rule maps them: every top-level key other than `services` whose value
 * is an object carrying a string `status` becomes services[<key>]. The
 * `services`-map handling itself is unchanged, so every full-shape body parses
 * exactly as before.
 */
export function parseHealthSnapshot(body: unknown): TargetHealthSnapshot {
  const obj = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const overall = typeof obj.status === "string" ? obj.status.toLowerCase() : "unknown";

  const services: Record<string, ServiceStatus> = {};
  const rawServices = obj.services;
  if (rawServices && typeof rawServices === "object") {
    for (const [name, val] of Object.entries(rawServices as Record<string, unknown>)) {
      let status: ServiceStatus;
      if (val && typeof val === "object" && typeof (val as Record<string, unknown>).status === "string") {
        status = normaliseServiceStatus((val as Record<string, unknown>).status as string);
      } else if (typeof val === "string") {
        status = normaliseServiceStatus(val);
      } else {
        status = "unknown";
      }
      services[name] = status;
    }
  }

  // Per-dependency fields of the basic shape (db, cache, …): object with a
  // string `status` at the top level (other than `services`/`status`) => a
  // service entry keyed by the field name.
  for (const [key, val] of Object.entries(obj)) {
    if (key === "services" || key === "status") continue;
    if (val && typeof val === "object" && typeof (val as Record<string, unknown>).status === "string") {
      services[key] = normaliseServiceStatus((val as Record<string, unknown>).status as string);
    }
  }

  let servicesNotOk = 0;
  let executionErrors = 0;
  let providerErrors = 0;
  for (const [name, status] of Object.entries(services)) {
    if (status === "ok") continue;
    servicesNotOk += 1;
    if (classify(name, EXECUTION_SERVICE_KEYWORDS)) executionErrors += 1;
    if (classify(name, PROVIDER_SERVICE_KEYWORDS)) providerErrors += 1;
  }

  return { overall, services, servicesNotOk, executionErrors, providerErrors };
}

/**
 * Evaluate a TargetHealthSnapshot against the configured ABSOLUTE noise floor.
 * Pure — returns a verdict with one reason string per breached threshold. This
 * is the fallback evaluator when no pre-merge baseline is available (legacy /
 * manual callers); the paved hydra-target-build road uses evaluateDelta.
 */
export function evaluateRegression(snapshot: TargetHealthSnapshot, config: PostMergeHealthConfig): RegressionVerdict {
  const reasons: string[] = [];

  if (config.alarmOnOverall.includes(snapshot.overall)) {
    reasons.push(`overall health status is "${snapshot.overall}" (alarm-on: ${config.alarmOnOverall.join(", ")})`);
  }
  if (snapshot.executionErrors > config.maxExecutionErrors) {
    reasons.push(
      `execution-class services not ok: ${snapshot.executionErrors} > floor ${config.maxExecutionErrors}`,
    );
  }
  if (snapshot.providerErrors > config.maxProviderErrors) {
    reasons.push(
      `provider-class services not ok: ${snapshot.providerErrors} > floor ${config.maxProviderErrors}`,
    );
  }
  if (snapshot.servicesNotOk > config.maxDegradedServices) {
    reasons.push(`services not ok: ${snapshot.servicesNotOk} > floor ${config.maxDegradedServices}`);
  }

  return { regressed: reasons.length > 0, reasons, snapshot };
}

/**
 * Rank a status string by severity for delta comparison (issue #1699):
 * ok=0 < degraded=unknown(=any other not-ok convention, e.g. "stale",
 * "not_configured")=1 < error=2. Pure.
 */
export function severityRank(status: ServiceStatus): number {
  if (status === "ok") return 0;
  if (status === "error") return 2;
  return 1;
}

/**
 * Evaluate the post-merge snapshot AGAINST a pre-merge baseline (issue #1699
 * baseline-delta mode). Pure. Ambient (pre-existing) degradation alone never
 * alarms — only deltas do:
 *   - a service newly not-ok (was ok, or absent, in the baseline);
 *   - a per-service severity worsening (e.g. degraded -> error);
 *   - an overall severity-rank worsening (ok=0 < degraded=unknown=1 < error=2).
 * Recovered/improved services and same-rank status drift are ignored. The
 * HYDRA_PMH_* floors keep their meanings but apply to the DELTA counts: e.g.
 * with maxProviderErrors=1, one provider service newly failing post-merge is
 * still tolerated, two alarm.
 */
export function evaluateDelta(
  baseline: TargetHealthSnapshot,
  current: TargetHealthSnapshot,
  config: PostMergeHealthConfig,
): RegressionVerdict {
  const reasons: string[] = [];

  // Per-service deltas: newly not-ok or severity-worsened vs the baseline.
  // A service absent from the baseline ranks as ok=0 so a brand-new failing
  // service still counts as a delta. deltaCounts (issue #1817) additionally
  // suppresses the ok->soft freshness-flap for freshness-class services only —
  // any move into error and any non-freshness service still counts.
  const deltas: Array<{ name: string; from: ServiceStatus | "(absent)"; to: ServiceStatus }> = [];
  for (const [name, status] of Object.entries(current.services)) {
    const before = baseline.services[name];
    if (deltaCounts(name, before, status, config.freshnessServices)) {
      deltas.push({ name, from: before ?? "(absent)", to: status });
    }
  }

  let executionDelta = 0;
  let providerDelta = 0;
  for (const d of deltas) {
    if (classify(d.name, EXECUTION_SERVICE_KEYWORDS)) executionDelta += 1;
    if (classify(d.name, PROVIDER_SERVICE_KEYWORDS)) providerDelta += 1;
  }
  const describe = (names: Array<{ name: string; from: string; to: string }>): string =>
    names.map((d) => `${d.name}: ${d.from} -> ${d.to}`).join(", ");

  // Overall severity-rank worsening. Freshness-flap suppression (issue #1817)
  // also applies here: a freshness flap on a single service can drag the OVERALL
  // status from ok -> degraded. If every per-service delta was suppressed as a
  // freshness flap (deltas is empty) AND the overall only worsened INTO soft
  // rank (degraded/stale/unknown, not error), the overall worsening is itself a
  // flap artifact and must not alarm — otherwise the suppression would be
  // defeated by the derived overall field. A worsening INTO error (rank 2)
  // always alarms (invariant 4); any surviving per-service delta keeps the
  // overall check armed (invariant 5 — a real hard-check ok->degraded yields a
  // surviving delta, so this branch never masks it).
  const overallWorsened = severityRank(current.overall) > severityRank(baseline.overall);
  const overallIntoSoftOnly = severityRank(current.overall) === 1;
  const overallIsFreshnessFlap = deltas.length === 0 && overallIntoSoftOnly;
  if (overallWorsened && !overallIsFreshnessFlap) {
    reasons.push(
      `overall health worsened vs pre-merge baseline: "${baseline.overall}" -> "${current.overall}"`,
    );
  }
  if (executionDelta > config.maxExecutionErrors) {
    reasons.push(
      `execution-class services newly failing/worsened vs baseline: ${executionDelta} > floor ` +
        `${config.maxExecutionErrors} (${describe(deltas.filter((d) => classify(d.name, EXECUTION_SERVICE_KEYWORDS)))})`,
    );
  }
  if (providerDelta > config.maxProviderErrors) {
    reasons.push(
      `provider-class services newly failing/worsened vs baseline: ${providerDelta} > floor ` +
        `${config.maxProviderErrors} (${describe(deltas.filter((d) => classify(d.name, PROVIDER_SERVICE_KEYWORDS)))})`,
    );
  }
  if (deltas.length > config.maxDegradedServices) {
    reasons.push(
      `services newly failing/worsened vs baseline: ${deltas.length} > floor ` +
        `${config.maxDegradedServices} (${describe(deltas)})`,
    );
  }

  return { regressed: reasons.length > 0, reasons, snapshot: current };
}

/**
 * Compose the `$context` argument handed to the hydra-target-incident skill. Pure +
 * deterministic so it can be asserted in tests. `targetName` (issue #4524) is
 * supplied by the caller from getTargetName() so the script carries no Target
 * name; `route` names which health route was actually sampled, so the Target
 * API line never hardcodes `/api/health/full`.
 */
export function buildIncidentContext(
  verdict: RegressionVerdict,
  opts: {
    mergeSha?: string;
    apiUrl: string;
    mode?: EvaluationMode;
    route?: HealthRoute;
    targetName?: string;
  },
): string {
  const failing = Object.entries(verdict.snapshot.services)
    .filter(([, status]) => status !== "ok")
    .map(([name, status]) => `${name}=${status}`)
    .join(", ");
  const route = opts.route ?? "full";
  const routeUrl = `${opts.apiUrl}/api/health${route === "full" ? "/full" : ""}`;
  const lines = [
    `Post-merge operational-health regression detected on the Target (${opts.targetName ?? "name unavailable via target-config"}).`,
    "ALARM-ONLY signal from scripts/target/post-merge-health.ts (issue #1054) — investigate; do NOT assume an auto-revert happened.",
    opts.mergeSha ? `Merge SHA: ${opts.mergeSha}` : "Merge SHA: (not provided)",
    `Target API: ${routeUrl} (route: ${route})`,
    `Comparison mode: ${opts.mode === "delta" ? "baseline-delta (regression vs the pre-merge snapshot — issue #1699)" : "absolute thresholds (no pre-merge baseline supplied)"}`,
    `Overall status: ${verdict.snapshot.overall}`,
    `Failing services: ${failing || "(none reported individually)"}`,
    "Breached thresholds:",
    ...verdict.reasons.map((r) => `  - ${r}`),
  ];
  return lines.join("\n");
}

// ── I/O ────────────────────────────────────────────────────────────────────────

/**
 * One route probe's outcome. `http-404` is distinguished from body failures so
 * fetchTargetHealth can decide the fallback: on the FULL route a 404 means
 * "route absent" (probe the basic route), while non-404 failures stay
 * unreachable — see HEALTH ROUTES in the header (issue #4524).
 */
type RouteProbeResult =
  | { ok: true; body: unknown; httpStatus: number }
  | { ok: false; kind: "http-404"; reason: string }
  | { ok: false; kind: "invalid"; reason: string };

/**
 * Probe ONE health route URL. `absentOn404` selects the 404 semantics: on the
 * full route a 404 is checked BEFORE the body is parsed (a Next.js 404 is an
 * HTML page, so parsing it first would just produce a confusing non-JSON
 * error) and reported as kind "http-404"; on the basic route — the LAST
 * fallback, with nowhere further to go — the #1699 rule applies verbatim: any
 * HTTP status whose body is a health-shaped JSON object is a valid sample.
 * Never throws.
 */
async function probeHealthRoute(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  absentOn404: boolean,
): Promise<RouteProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (absentOn404 && res.status === 404) {
      return { ok: false, kind: "http-404", reason: `route absent (HTTP 404) at ${url}` };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      return {
        ok: false,
        kind: "invalid",
        reason:
          `Target health endpoint returned a non-JSON body (HTTP ${res.status}) from ${url}: ` +
          `${String(err)} — treating as unreachable`,
      };
    }
    if (!body || typeof body !== "object" || typeof (body as Record<string, unknown>).status !== "string") {
      return {
        ok: false,
        kind: "invalid",
        reason:
          `Target health endpoint returned a JSON body without a string "status" field ` +
          `(HTTP ${res.status}) from ${url} — not a health sample, treating as unreachable`,
      };
    }
    return { ok: true, body, httpStatus: res.status };
  } catch (err) {
    // AbortError (timeout) or connection-refused (service down mid-deploy) both
    // land here. Treat as unreachable — never throw, never alarm.
    return { ok: false, kind: "invalid", reason: `Target health endpoint unreachable at ${url}: ${String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch the Target's health: probe `/api/health/full` first; ONLY an HTTP 404
 * on it (checked before the body is parsed) falls back to one probe of
 * `/api/health` (issue #4524 — a Target that only serves the basic shape must
 * still produce a snapshot, not a silent no-op). Any other full-route outcome
 * (5xx with a non-JSON body, network error, timeout, JSON without a string
 * `status`) is classified unreachable exactly as before — the fallback never
 * masks a broken full route. Never throws: on any failure returns
 * `{ ok: false, reason }`, naming both probed URLs whenever both were probed.
 *
 * The HTTP status code is deliberately NOT a validity gate (issue #1699): the
 * endpoint answers 503 WITH a full per-service health body when the overall
 * status is degraded/error, and discarding that body made the watcher yield
 * zero signal exactly when the Target was unhealthy. Any response whose body
 * parses as a JSON object with a string `status` field is a valid sample —
 * regardless of status code, so a future 500-with-body convention keeps
 * working too. Only a truly-unreachable Target (network error, timeout,
 * non-JSON body such as a proxy HTML error page) is classified unreachable.
 */
export async function fetchTargetHealth(
  config: PostMergeHealthConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchHealthResult> {
  const fullUrl = `${config.apiUrl}/api/health/full`;
  const basicUrl = `${config.apiUrl}/api/health`;

  const full = await probeHealthRoute(fullUrl, config.timeoutMs, fetchImpl, true);
  if (full.ok === true) return { ok: true, body: full.body, httpStatus: full.httpStatus, route: "full" };

  if (full.kind === "http-404") {
    const basic = await probeHealthRoute(basicUrl, config.timeoutMs, fetchImpl, false);
    if (basic.ok === true) return { ok: true, body: basic.body, httpStatus: basic.httpStatus, route: "basic" };
    if (basic.kind === "http-404") {
      return {
        ok: false,
        reason:
          `Target serves neither ${fullUrl} nor ${basicUrl} (both answered HTTP 404) — ` +
          `is HYDRA_TARGET_WEB_URL (${config.apiUrl}) pointing at the Target web service?`,
      };
    }
    return {
      ok: false,
      reason: `${basic.reason} (after the full route answered 404, also probed ${fullUrl})`,
    };
  }

  return { ok: false, reason: full.reason };
}

// ── Baseline persistence (issue #1699 — file-based, stdlib-only) ─────────────

/**
 * On-disk shape of a pre-merge baseline snapshot. A plain file (NOT Redis /
 * the orchestrator API) keeps this script leaf-level so sync-target-gate.sh
 * mirroring into Target worktrees keeps working unchanged.
 */
export interface BaselineFile {
  version: 1;
  capturedAt: string;
  snapshot: TargetHealthSnapshot;
}

/** Write a baseline snapshot to disk. Never throws — returns a result object. */
export function writeBaseline(
  path: string,
  snapshot: TargetHealthSnapshot,
): { ok: true } | { ok: false; reason: string } {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const payload: BaselineFile = { version: 1, capturedAt: new Date().toISOString(), snapshot };
    writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `failed to write baseline snapshot to ${path}: ${String(err)}` };
  }
}

/**
 * Read a baseline snapshot from disk. Never throws — a missing, unparsable, or
 * shape-invalid file returns `{ ok: false }` and the caller falls back to the
 * absolute-threshold evaluator.
 */
export function readBaseline(
  path: string,
): { ok: true; snapshot: TargetHealthSnapshot } | { ok: false; reason: string } {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    const snap = parsed && typeof parsed === "object" ? (parsed.snapshot as Record<string, unknown> | undefined) : undefined;
    if (
      !snap ||
      typeof snap !== "object" ||
      typeof snap.overall !== "string" ||
      !snap.services ||
      typeof snap.services !== "object"
    ) {
      return { ok: false, reason: `baseline file at ${path} is not a valid baseline snapshot` };
    }
    return { ok: true, snapshot: snap as unknown as TargetHealthSnapshot };
  } catch (err) {
    return { ok: false, reason: `failed to read baseline snapshot from ${path}: ${String(err)}` };
  }
}

/**
 * Dispatch the hydra-target-incident skill with the regression context. Spawns
 * `claude -p "/hydra-target-incident <context>"` detached (subscription-billed,
 * may run minutes). Never throws — a spawn failure is logged and reported as not
 * dispatched, because failing to alarm must not look like a build failure.
 *
 * Realm note (ADR-0025, issue #2553): post-merge Target regressions route to
 * the Target-scoped hydra-target-incident, not the Orchestrator's hydra-incident
 * — each Operate-layer incident skill is single-realm.
 *
 * `spawnImpl` is injectable so tests can assert the argv without spawning.
 */
export function dispatchIncident(
  context: string,
  spawnImpl: typeof spawn = spawn,
): { dispatched: boolean; reason?: string } {
  try {
    const child = spawnImpl(
      "claude",
      ["--dangerously-skip-permissions", "-p", `/hydra-target-incident ${context}`],
      { detached: true, stdio: "ignore" },
    );
    child.unref?.();
    child.on?.("error", (err: unknown) => {
      console.error(
        `[post-merge-health] hydra-target-incident dispatch failed to start: ${String(err)}`,
      );
    });
    return { dispatched: true };
  } catch (err) {
    console.error(`[post-merge-health] hydra-target-incident dispatch threw: ${String(err)}`);
    return { dispatched: false, reason: String(err) };
  }
}

// ── Orchestration ───────────────────────────────────────────────────────────────

/**
 * Run one post-merge health watch. Fetches the Target health and then:
 *   - `opts.snapshotOut` set (pre-merge mode): persists the snapshot as the
 *     baseline file and returns — never evaluates, never alarms;
 *   - `opts.baselinePath` set and readable: evaluates DELTAS vs the baseline
 *     (issue #1699) so ambient degradation alone never alarms;
 *   - otherwise: evaluates against the absolute noise floor.
 *
 * FRESHNESS-FLAP SUPPRESSION (issue #1817): in delta mode, evaluateDelta no
 * longer counts an ok->soft (degraded/stale) transition on a freshness-class
 * service as a regression — that transition is a sampling-phase artifact of the
 * service's freshness window being tighter than its cron cadence. Any move into
 * error, any worsening from an already-not-ok baseline, and ok->degraded on a
 * non-freshness (hard-check) service all still count. The suppression lives
 * entirely in the pure evaluator; runWatch samples the Target exactly once.
 *
 * Only on a regression and only when `config.dispatch` is true does it fire
 * hydra-target-incident. Returns a WatchResult; never throws.
 */
export async function runWatch(
  config: PostMergeHealthConfig,
  opts: { mergeSha?: string; snapshotOut?: string; baselinePath?: string } = {},
  deps: { fetchImpl?: typeof fetch; spawnImpl?: typeof spawn } = {},
): Promise<WatchResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;

  const fetched: FetchHealthResult = await fetchTargetHealth(config, fetchImpl);
  if (fetched.ok !== true) {
    // FAIL-LOUD, NEVER THROW (issue #4524): an unreachable Target means this
    // watch compares NOTHING — in snapshot mode Step 8.6 will run without a
    // baseline — which is alarm-worthy operator signal, not a silent skip.
    // The explicit result kind, the no-dispatch rule, and exit code 0 are all
    // unchanged (a throwing/non-zero probe must never look like a build
    // failure); what changes is the loudness and the named knob.
    const probed = `${config.apiUrl}/api/health/full (and ${config.apiUrl}/api/health)`;
    if (opts.snapshotOut) {
      console.error(
        `[post-merge-health] BASELINE FAILURE — Target unreachable at ${probed}: ${fetched.reason}; ` +
          `Step 8.6 will run without a baseline (base URL resolved via HYDRA_TARGET_WEB_URL → ${config.apiUrl})`,
      );
    } else {
      console.error(
        `[post-merge-health] PROBE FAILURE — Target unreachable at ${probed}: ${fetched.reason} ` +
          `(base URL resolved via HYDRA_TARGET_WEB_URL → ${config.apiUrl})`,
      );
    }
    return { kind: "unreachable", reason: fetched.reason };
  }

  const snapshot = parseHealthSnapshot(fetched.body);

  if (opts.snapshotOut) {
    const wrote = writeBaseline(opts.snapshotOut, snapshot);
    if (wrote.ok !== true) {
      // Fail-soft: a baseline-write failure must never look like a build
      // failure; the post-merge run will fall back to absolute thresholds.
      console.error(`[post-merge-health] baseline write failed (no-op): ${wrote.reason}`);
      return { kind: "baseline-write-failed", reason: wrote.reason };
    }
    console.log(
      `[post-merge-health] pre-merge baseline written to ${opts.snapshotOut} ` +
        `(overall=${snapshot.overall} servicesNotOk=${snapshot.servicesNotOk} route=${fetched.route} httpStatus=${fetched.httpStatus})`,
    );
    return { kind: "baseline-written", path: opts.snapshotOut, snapshot };
  }

  // Resolve the baseline. A baseline path that is unreadable falls back to the
  // absolute-threshold evaluator. In delta mode evaluateDelta applies the
  // issue-#1817 freshness-flap suppression; absolute mode (no baseline) keeps
  // the pre-#1817 behavior.
  let baseline: TargetHealthSnapshot | null = null;
  if (opts.baselinePath) {
    const read = readBaseline(opts.baselinePath);
    if (read.ok === true) {
      baseline = read.snapshot;
    } else {
      console.error(`[post-merge-health] ${read.reason} — falling back to absolute thresholds`);
    }
  }

  const mode: EvaluationMode = baseline ? "delta" : "absolute";
  const verdict = baseline
    ? evaluateDelta(baseline, snapshot, config)
    : evaluateRegression(snapshot, config);

  if (!verdict.regressed) {
    console.log(
      `[post-merge-health] healthy (mode=${mode}, route=${fetched.route}, httpStatus=${fetched.httpStatus}): ` +
        `overall=${snapshot.overall} servicesNotOk=${snapshot.servicesNotOk} ` +
        `executionErrors=${snapshot.executionErrors} providerErrors=${snapshot.providerErrors}`,
    );
    return { kind: "healthy", verdict, mode };
  }

  // ABSOLUTE-MODE NON-BLOCKING FALLBACK (issue #1817 recurrence).
  // Post-merge health is a *regression* signal: it can only attribute a fault to
  // a merge by diffing against a pre-merge baseline. With no baseline the
  // comparator is measuring the Target's *absolute* state against fixed floors —
  // and the Target's chronic-degraded floor (opticOdds not_configured, pinnacle
  // 0-rows, freshness-class services stale ~90-98% of the time because the cron
  // cadence is far longer than the freshness window) structurally exceeds those
  // floors on EVERY merge regardless of what changed. So an absolute-mode breach
  // is reported `inconclusive` (logged, NEVER dispatched) rather than alarming
  // on a phantom regression. Operators who genuinely want absolute-mode alarms
  // opt back in with HYDRA_PMH_ALARM_WITHOUT_BASELINE=1. The fix that restores a
  // real signal is supplying a pre-merge --baseline (delta mode), which is the
  // paved hydra-target-build road on both merge paths (#1839).
  if (mode === "absolute" && !config.alarmWithoutBaseline) {
    const reason =
      "no pre-merge baseline supplied — absolute-mode breach is not a merge-attributable regression " +
      "(set HYDRA_PMH_ALARM_WITHOUT_BASELINE=1 to alarm anyway). Breached floors: " +
      verdict.reasons.join("; ");
    console.error(
      `[post-merge-health] INCONCLUSIVE (mode=absolute, httpStatus=${fetched.httpStatus}): ${reason}\n` +
        "NOT dispatching hydra-target-incident — post-merge health is meaningless without a baseline. " +
        "Capture one pre-merge via --snapshot-out so the post-merge run can diff in delta mode.",
    );
    return { kind: "inconclusive", verdict, reason };
  }

  // The Target name comes from the target-config seam (issue #4524) — the
  // script itself carries no Target identity.
  const context = buildIncidentContext(verdict, {
    mergeSha: opts.mergeSha,
    apiUrl: config.apiUrl,
    mode,
    route: fetched.route,
    targetName: getTargetName(),
  });
  console.error(`[post-merge-health] ALARM — post-merge operational-health regression:\n${context}`);

  if (!config.dispatch) {
    console.error(
      "[post-merge-health] dry-run (HYDRA_PMH_DISPATCH != 1): NOT dispatching hydra-target-incident. " +
        "Re-run with --dispatch to alarm.",
    );
    return { kind: "alarm", verdict, dispatched: false, mode };
  }

  const { dispatched } = dispatchIncident(context, deps.spawnImpl ?? spawn);
  if (dispatched) {
    console.error("[post-merge-health] dispatched hydra-target-incident (alarm-only; no revert performed).");
  }
  return { kind: "alarm", verdict, dispatched, mode };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────

interface CliArgs {
  mergeSha?: string;
  dispatch?: boolean;
  dryRun?: boolean;
  /** Pre-merge mode: write the current health snapshot to this path and exit. */
  snapshotOut?: string;
  /** Post-merge delta mode: compare against the baseline snapshot at this path. */
  baseline?: string;
}

/** Parse argv (everything after `node script.ts`). Pure for testability. */
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--merge-sha") {
      args.mergeSha = argv[++i];
    } else if (a === "--dispatch") {
      args.dispatch = true;
    } else if (a === "--dry-run") {
      args.dryRun = true;
    } else if (a === "--snapshot-out") {
      args.snapshotOut = argv[++i];
    } else if (a === "--baseline") {
      args.baseline = argv[++i];
    }
  }
  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  // CLI flags override env: --dispatch forces dispatch, --dry-run forces off.
  if (args.dispatch) config.dispatch = true;
  if (args.dryRun) config.dispatch = false;

  const result = await runWatch(config, {
    mergeSha: args.mergeSha,
    snapshotOut: args.snapshotOut,
    baselinePath: args.baseline,
  });

  // Exit code is informational only — this is alarm-only and must never look
  // like a failing merge gate. 0 = no regression / clean no-op (including the
  // snapshot-write and unreachable modes). We use a distinct non-blocking code
  // (75 / EX_TEMPFAIL) ONLY for an alarm so a wrapper can optionally notice it,
  // but callers that ignore exit codes are unaffected.
  if (result.kind === "alarm") return 75;
  return 0;
}

// Only run main when invoked directly (not when imported by tests).
// import.meta.url vs argv[1] is the standard ESM "is this the entrypoint" guard.
const invokedDirectly = (() => {
  try {
    const entry = process.argv[1] ?? "";
    return import.meta.url === `file://${entry}` || import.meta.url.endsWith(entry.replace(/^.*\//, ""));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      // Defensive: main() is built not to throw, but if it ever does, log and
      // exit 0 — a crashing alarm probe must not masquerade as a merge failure.
      console.error(`[post-merge-health] unexpected error (treated as no-op): ${String(err)}`);
      process.exit(0);
    });
}
