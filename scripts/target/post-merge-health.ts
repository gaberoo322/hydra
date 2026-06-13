#!/usr/bin/env -S npx tsx
/**
 * post-merge-health — alarm-only operational-health smoke check for the Target
 * (issue #1054, epic #1052 "selectively converge the Target SDLC").
 *
 * WHY THIS EXISTS
 * ---------------
 * The Orchestrator gates its own merges with per-merge **Outcome Holdback** —
 * it merges, then watches a fast outcome signal and reverts on regression. That
 * mechanism is unusable for the Target (hydra-betting): betting outcomes are
 * settlement-lagged (hours/days, not merge-attributable) and the
 * outcome-ingestion seam was removed (#933). Epic #1052 therefore replaces
 * per-merge Holdback for the Target with a cheaper, alarm-only post-merge watch
 * keyed on *fast operational-health signals the Target already exposes*.
 *
 * This is the lowest-effort, highest-attribution slice: it samples signals that
 * already exist on the Target's web service (`/api/health/full`) right after a
 * Target merge and, if operational health has regressed past a configurable
 * noise floor, raises a **hydra-incident** alarm.
 *
 * ALARM-ONLY — NEVER AUTO-REVERT
 * ------------------------------
 * This watcher deliberately does NOT revert, gate, or block any merge. It runs
 * *after* the merge has already landed and only *observes*. On a detected
 * regression it dispatches the `hydra-incident` skill (which decides whether to
 * investigate/fix/revert). The post-merge watch is an alarm bell, not a merge
 * gate — see epic #1052's rationale ("the post-merge watch keys on fast
 * operational-health signals in alarm-only mode").
 *
 * FAIL-SOFT
 * ---------
 * If the Target API is unreachable (service down mid-deploy, port not yet up,
 * network blip, or a body that is not health-shaped JSON — e.g. a proxy HTML
 * error page), this is a clean no-op: it logs and returns a non-alarm result.
 * It MUST NOT throw — an unreachable Target is not itself a merge regression,
 * and a throwing post-merge probe must never look like a build failure. Per the
 * Orchestrator convention, nothing here ever throws on the I/O path; callers
 * read the returned result object.
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
 * absolute-threshold semantics below. The baseline is a plain file (node:fs) —
 * never Redis / the orchestrator API — so the script stays stdlib-only and
 * leaf-level for sync-target-gate.sh mirroring (#1451).
 *
 * SIGNAL MODEL
 * ------------
 * `/api/health/full` returns `{ status, services: { <name>: { status } } }`
 * where each status is one of `ok` | `degraded` | `error`. We map that to three
 * merge-attributable signals named in the issue:
 *   - overall health status (`ok`/`degraded`/`error`)
 *   - execution-success proxy: count of *execution-class* services not `ok`
 *     (scanner, ingestion, execution, …) — a regression here means the merge
 *     broke the run/execution path
 *   - provider/API error proxy: count of *provider-class* services not `ok`
 *     (opticOdds, pinnacle*, kalshi, polymarket, provider*) — a regression here
 *     means the merge broke an external-data integration
 * Any service that doesn't match an execution/provider keyword still counts
 * toward the generic "services not ok" floor, so a brand-new failing service is
 * never silently ignored.
 *
 * NOISE FLOOR (all configurable via env — see DEFAULTS below)
 * ----------------------------------------------------------
 *   - HYDRA_TARGET_API_URL            base URL of the Target web service
 *   - HYDRA_PMH_ALARM_ON_OVERALL      overall statuses that alarm (csv)
 *   - HYDRA_PMH_MAX_DEGRADED_SERVICES services-not-ok count tolerated before alarm
 *   - HYDRA_PMH_MAX_EXECUTION_ERRORS  execution-class not-ok count tolerated
 *   - HYDRA_PMH_MAX_PROVIDER_ERRORS   provider-class not-ok count tolerated
 *   - HYDRA_PMH_TIMEOUT_MS            per-request fetch timeout
 *   - HYDRA_PMH_DISPATCH              "1" to actually dispatch hydra-incident,
 *                                     anything else => dry-run (print only)
 *   - HYDRA_PMH_CONFIRM_SAMPLES       debounce: total samples that must ALL
 *                                     regress before alarming (default 1 = no
 *                                     debounce; see DEBOUNCE below)
 *   - HYDRA_PMH_CONFIRM_SPACING_MS    spacing between debounce re-samples (ms)
 *
 * DEBOUNCE — freshness-window flapping (issue #1817)
 * --------------------------------------------------
 * Several Target services derive their status purely from the *freshness* of the
 * latest persisted pipeline run: `state==="fresh"` (within a short freshness
 * window) => ok, else degraded/stale. When that freshness window (e.g. the
 * scanner's 180s) is far tighter than the underlying cron cadence (e.g. ~30min),
 * the signal FLAPS ok<->degraded purely as a function of WHEN the single health
 * probe fires relative to the cron — not because of any merge. A one-shot
 * comparator (absolute OR delta) that samples each side once therefore reports a
 * phantom `scanner: ok -> degraded` regression that is a pure sampling-phase
 * artifact (the 2026-06-13 false-positives on hydra-betting — issue #1817).
 *
 * The debounce is the comparator-side fix: when the FIRST sample regresses,
 * re-sample the Target up to HYDRA_PMH_CONFIRM_SAMPLES-1 more times, spaced
 * HYDRA_PMH_CONFIRM_SPACING_MS apart (set this > the service's freshness window
 * so a fresh cron run can land between samples), re-evaluating each sample the
 * same way (delta vs the SAME baseline, or absolute). We alarm ONLY when EVERY
 * sample regresses. A transient freshness flap recovers within a cron cadence,
 * so a later sample sees the service back to ok and the alarm is suppressed; a
 * real regression persists across every sample and still alarms. With the
 * default HYDRA_PMH_CONFIRM_SAMPLES=1 there is no re-sampling and the behavior
 * is byte-for-byte the pre-#1817 one-shot comparator — debounce is strictly
 * opt-in. A sample that becomes unreachable mid-debounce is treated as a
 * non-regression (fail-soft: cannot confirm => do not alarm).
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
 * is leaf-level: it imports only Node stdlib so it has no coupling to the
 * orchestrator service and can run from any worktree.
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// ── Defaults ────────────────────────────────────────────────────────────────

const DEFAULTS = {
  /** Target web service base URL. hydra-betting-web listens on :3333 locally. */
  apiUrl: "http://localhost:3333",
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
   * Debounce (issue #1817): total samples that must ALL regress before alarming.
   * 1 (the default) means no debounce — the one-shot pre-#1817 behavior.
   */
  confirmSamples: 1,
  /**
   * Debounce spacing between re-samples (ms). Set > the service's freshness
   * window so a fresh cron run can land between samples. Default 200_000ms
   * (~3.3min) exceeds the documented 180s scanner freshness window.
   */
  confirmSpacingMs: 200_000,
};

/** Keyword fragments that classify a service name as execution-class. */
const EXECUTION_SERVICE_KEYWORDS = ["scanner", "ingest", "execution", "exec", "settle", "order"];
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
   * Debounce (issue #1817): total samples that must ALL regress before alarming.
   * 1 = no debounce (one-shot). Clamped to >= 1 in loadConfig.
   */
  confirmSamples: number;
  /** Debounce spacing between re-samples (ms). */
  confirmSpacingMs: number;
  /** When false, an alarm is logged + printed but hydra-incident is not spawned. */
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
  | { kind: "alarm"; verdict: RegressionVerdict; dispatched: boolean; mode: EvaluationMode };

/**
 * Discriminated result of a Target health fetch. Never thrown — always
 * returned. `httpStatus` rides along on success because a valid sample may
 * arrive on a non-2xx response (issue #1699): /api/health/full answers 503
 * with a full health body when the overall status is degraded/error.
 */
export type FetchHealthResult =
  | { ok: true; body: unknown; httpStatus: number }
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
 * pass --dispatch) to actually spawn hydra-incident.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): PostMergeHealthConfig {
  const apiUrl = (env.HYDRA_TARGET_API_URL && env.HYDRA_TARGET_API_URL.trim()) || DEFAULTS.apiUrl;
  return {
    apiUrl: apiUrl.replace(/\/+$/, ""),
    alarmOnOverall: parseCsvEnv(env.HYDRA_PMH_ALARM_ON_OVERALL, DEFAULTS.alarmOnOverall),
    maxDegradedServices: parseIntEnv(env.HYDRA_PMH_MAX_DEGRADED_SERVICES, DEFAULTS.maxDegradedServices),
    maxExecutionErrors: parseIntEnv(env.HYDRA_PMH_MAX_EXECUTION_ERRORS, DEFAULTS.maxExecutionErrors),
    maxProviderErrors: parseIntEnv(env.HYDRA_PMH_MAX_PROVIDER_ERRORS, DEFAULTS.maxProviderErrors),
    timeoutMs: parseIntEnv(env.HYDRA_PMH_TIMEOUT_MS, DEFAULTS.timeoutMs),
    // confirmSamples must be >= 1 (a 0-sample debounce is meaningless and would
    // never alarm). parseIntEnv clamps to >= 0; Math.max lifts a 0 back to 1.
    confirmSamples: Math.max(1, parseIntEnv(env.HYDRA_PMH_CONFIRM_SAMPLES, DEFAULTS.confirmSamples)),
    confirmSpacingMs: parseIntEnv(env.HYDRA_PMH_CONFIRM_SPACING_MS, DEFAULTS.confirmSpacingMs),
    dispatch: env.HYDRA_PMH_DISPATCH === "1",
  };
}

// ── Snapshot parsing (pure) ────────────────────────────────────────────────────

function classify(serviceName: string, keywords: string[]): boolean {
  const lower = serviceName.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

/**
 * Parse a raw `/api/health/full` JSON body into a normalized
 * TargetHealthSnapshot. Tolerant of shape drift: a missing/oddly-typed
 * `services` map yields an empty service set rather than throwing, and unknown
 * statuses are preserved verbatim (lowercased) so a future status string still
 * counts as "not ok".
 */
export function parseHealthSnapshot(body: unknown): TargetHealthSnapshot {
  const obj = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const overall = typeof obj.status === "string" ? obj.status.toLowerCase() : "unknown";

  const services: Record<string, ServiceStatus> = {};
  const rawServices = obj.services;
  if (rawServices && typeof rawServices === "object") {
    for (const [name, val] of Object.entries(rawServices as Record<string, unknown>)) {
      let status: string;
      if (val && typeof val === "object" && typeof (val as Record<string, unknown>).status === "string") {
        status = ((val as Record<string, unknown>).status as string).toLowerCase();
      } else if (typeof val === "string") {
        status = val.toLowerCase();
      } else {
        status = "unknown";
      }
      services[name] = status;
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
  // service still counts as a delta.
  const deltas: Array<{ name: string; from: ServiceStatus | "(absent)"; to: ServiceStatus }> = [];
  for (const [name, status] of Object.entries(current.services)) {
    const before = baseline.services[name];
    const beforeRank = before === undefined ? 0 : severityRank(before);
    if (severityRank(status) > beforeRank) {
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

  if (severityRank(current.overall) > severityRank(baseline.overall)) {
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
 * Compose the `$context` argument handed to the hydra-incident skill. Pure +
 * deterministic so it can be asserted in tests.
 */
export function buildIncidentContext(
  verdict: RegressionVerdict,
  opts: { mergeSha?: string; apiUrl: string; mode?: EvaluationMode },
): string {
  const failing = Object.entries(verdict.snapshot.services)
    .filter(([, status]) => status !== "ok")
    .map(([name, status]) => `${name}=${status}`)
    .join(", ");
  const lines = [
    "Post-merge operational-health regression detected on the Target (hydra-betting).",
    "ALARM-ONLY signal from scripts/target/post-merge-health.ts (issue #1054) — investigate; do NOT assume an auto-revert happened.",
    opts.mergeSha ? `Merge SHA: ${opts.mergeSha}` : "Merge SHA: (not provided)",
    `Target API: ${opts.apiUrl}/api/health/full`,
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
 * Fetch `/api/health/full` from the Target. Never throws: on a network error,
 * timeout, non-JSON body, or a JSON body that is not health-shaped, returns
 * `{ ok: false, reason }`. On success returns `{ ok: true, body, httpStatus }`.
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
  const url = `${config.apiUrl}/api/health/full`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      return {
        ok: false,
        reason:
          `Target health endpoint returned a non-JSON body (HTTP ${res.status}) from ${url}: ` +
          `${String(err)} — treating as unreachable`,
      };
    }
    if (!body || typeof body !== "object" || typeof (body as Record<string, unknown>).status !== "string") {
      return {
        ok: false,
        reason:
          `Target health endpoint returned a JSON body without a string "status" field ` +
          `(HTTP ${res.status}) from ${url} — not a health sample, treating as unreachable`,
      };
    }
    return { ok: true, body, httpStatus: res.status };
  } catch (err) {
    // AbortError (timeout) or connection-refused (service down mid-deploy) both
    // land here. Treat as unreachable — never throw, never alarm.
    return { ok: false, reason: `Target health endpoint unreachable at ${url}: ${String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

// ── Baseline persistence (issue #1699 — file-based, stdlib-only) ─────────────

/**
 * On-disk shape of a pre-merge baseline snapshot. A plain file (NOT Redis /
 * the orchestrator API) keeps this script leaf-level so sync-target-gate.sh
 * mirroring into hydra-betting worktrees keeps working unchanged.
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
 * Dispatch the hydra-incident skill with the regression context. Spawns
 * `claude -p "/hydra-incident <context>"` detached (subscription-billed, may run
 * minutes). Never throws — a spawn failure is logged and reported as not
 * dispatched, because failing to alarm must not look like a build failure.
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
      ["--dangerously-skip-permissions", "-p", `/hydra-incident ${context}`],
      { detached: true, stdio: "ignore" },
    );
    child.unref?.();
    child.on?.("error", (err: unknown) => {
      console.error(`[post-merge-health] hydra-incident dispatch failed to start: ${String(err)}`);
    });
    return { dispatched: true };
  } catch (err) {
    console.error(`[post-merge-health] hydra-incident dispatch threw: ${String(err)}`);
    return { dispatched: false, reason: String(err) };
  }
}

// ── Sampling + evaluation helpers ─────────────────────────────────────────────

/**
 * Promise-based sleep. Injectable so the debounce loop's spacing waits are
 * instant in tests (no real wall-clock delay). Pure wrapper over setTimeout.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Evaluate one already-fetched snapshot in the appropriate mode. Pure (no I/O):
 * delta vs the supplied baseline when one is present, otherwise absolute. The
 * baseline is resolved once by the caller so a single re-read serves every
 * debounce sample. Returns both the verdict and the mode it was computed in.
 */
export function evaluateSample(
  snapshot: TargetHealthSnapshot,
  config: PostMergeHealthConfig,
  baseline: TargetHealthSnapshot | null,
): { verdict: RegressionVerdict; mode: EvaluationMode } {
  if (baseline) {
    return { verdict: evaluateDelta(baseline, snapshot, config), mode: "delta" };
  }
  return { verdict: evaluateRegression(snapshot, config), mode: "absolute" };
}

/**
 * Debounce confirmation loop (issue #1817). Called only when the first sample
 * already regressed AND `config.confirmSamples > 1`. Re-samples the Target up to
 * `confirmSamples - 1` more times, each spaced `config.confirmSpacingMs` apart,
 * re-evaluating against the SAME baseline/mode. Returns the FIRST non-regressing
 * verdict it encounters (which suppresses the alarm), or the last regressing
 * verdict if every sample confirmed the regression. Never throws.
 *
 * A re-sample that is unreachable is treated as a non-regression: we cannot
 * confirm, so we must not alarm (fail-soft, matching the unreachable no-op
 * elsewhere). The returned verdict in that case is a synthetic healthy verdict
 * carrying the most recent successful snapshot for logging.
 */
async function confirmRegression(
  config: PostMergeHealthConfig,
  opts: { mergeSha?: string; baselinePath?: string },
  baseline: TargetHealthSnapshot | null,
  mode: EvaluationMode,
  firstVerdict: RegressionVerdict,
  deps: { fetchImpl: typeof fetch; sleepImpl: typeof sleep },
): Promise<RegressionVerdict> {
  let lastVerdict = firstVerdict;
  for (let i = 1; i < config.confirmSamples; i++) {
    console.error(
      `[post-merge-health] debounce (issue #1817): first sample regressed; ` +
        `re-sampling ${i + 1}/${config.confirmSamples} (mode=${mode}) after ` +
        `${config.confirmSpacingMs}ms to rule out a freshness-window flap`,
    );
    await deps.sleepImpl(config.confirmSpacingMs);

    const reFetched = await fetchTargetHealth(config, deps.fetchImpl);
    if (reFetched.ok !== true) {
      // Cannot confirm — fail-soft to non-regression so a flap that coincides
      // with a brief outage never alarms. Keep the prior snapshot for logging.
      console.error(
        `[post-merge-health] debounce sample ${i + 1} unreachable (${reFetched.reason}) — ` +
          `cannot confirm regression, suppressing alarm`,
      );
      return { regressed: false, reasons: [], snapshot: lastVerdict.snapshot };
    }

    const reSnapshot = parseHealthSnapshot(reFetched.body);
    const { verdict: reVerdict } = evaluateSample(reSnapshot, config, baseline);
    lastVerdict = reVerdict;
    if (!reVerdict.regressed) {
      console.error(
        `[post-merge-health] debounce sample ${i + 1} did NOT regress — ` +
          `suppressing alarm as a transient freshness-window flap (issue #1817)`,
      );
      return reVerdict;
    }
  }
  console.error(
    `[post-merge-health] debounce: regression persisted across all ` +
      `${config.confirmSamples} samples — confirmed, proceeding to alarm`,
  );
  return lastVerdict;
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
 * DEBOUNCE (issue #1817): when the first post-merge sample regresses and
 * `config.confirmSamples > 1`, re-sample the Target up to confirmSamples-1 more
 * times (spaced `config.confirmSpacingMs` apart) and alarm ONLY if EVERY sample
 * regresses. A transient freshness-window flap recovers within a cron cadence,
 * so a later sample clears the alarm; a real regression persists. A re-sample
 * that becomes unreachable or recovers below the floor suppresses the alarm
 * (fail-soft: cannot confirm => do not alarm).
 *
 * Only on a confirmed regression and only when `config.dispatch` is true does it
 * fire hydra-incident. Returns a WatchResult; never throws.
 */
export async function runWatch(
  config: PostMergeHealthConfig,
  opts: { mergeSha?: string; snapshotOut?: string; baselinePath?: string } = {},
  deps: { fetchImpl?: typeof fetch; spawnImpl?: typeof spawn; sleepImpl?: typeof sleep } = {},
): Promise<WatchResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleepImpl = deps.sleepImpl ?? sleep;

  const fetched: FetchHealthResult = await fetchTargetHealth(config, fetchImpl);
  if (fetched.ok !== true) {
    // Fail-soft: unreachable Target is a clean no-op (acceptance criterion).
    // In snapshot mode this means no baseline file is written, so the
    // post-merge run falls back to absolute thresholds — coherent and loud.
    console.error(`[post-merge-health] no-op: ${fetched.reason}`);
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
        `(overall=${snapshot.overall} servicesNotOk=${snapshot.servicesNotOk} httpStatus=${fetched.httpStatus})`,
    );
    return { kind: "baseline-written", path: opts.snapshotOut, snapshot };
  }

  // Resolve the baseline once (a single re-read serves every debounce sample).
  // A baseline path that is unreadable falls back to absolute thresholds.
  let baseline: TargetHealthSnapshot | null = null;
  if (opts.baselinePath) {
    const read = readBaseline(opts.baselinePath);
    if (read.ok === true) {
      baseline = read.snapshot;
    } else {
      console.error(`[post-merge-health] ${read.reason} — falling back to absolute thresholds`);
    }
  }

  const first = evaluateSample(snapshot, config, baseline);
  const mode = first.mode;
  let verdict = first.verdict;

  // DEBOUNCE (issue #1817): a regressing first sample is only confirmed if every
  // additional sample also regresses. Freshness-window flaps recover within a
  // cron cadence; spacing the re-samples > the freshness window lets a fresh run
  // land between them and clear a phantom regression.
  if (verdict.regressed && config.confirmSamples > 1) {
    verdict = await confirmRegression(config, opts, baseline, mode, verdict, {
      fetchImpl,
      sleepImpl,
    });
  }

  if (!verdict.regressed) {
    console.log(
      `[post-merge-health] healthy (mode=${mode}, httpStatus=${fetched.httpStatus}): ` +
        `overall=${snapshot.overall} servicesNotOk=${snapshot.servicesNotOk} ` +
        `executionErrors=${snapshot.executionErrors} providerErrors=${snapshot.providerErrors}`,
    );
    return { kind: "healthy", verdict, mode };
  }

  const context = buildIncidentContext(verdict, { mergeSha: opts.mergeSha, apiUrl: config.apiUrl, mode });
  console.error(`[post-merge-health] ALARM — post-merge operational-health regression:\n${context}`);

  if (!config.dispatch) {
    console.error(
      "[post-merge-health] dry-run (HYDRA_PMH_DISPATCH != 1): NOT dispatching hydra-incident. " +
        "Re-run with --dispatch to alarm.",
    );
    return { kind: "alarm", verdict, dispatched: false, mode };
  }

  const { dispatched } = dispatchIncident(context, deps.spawnImpl ?? spawn);
  if (dispatched) {
    console.error("[post-merge-health] dispatched hydra-incident (alarm-only; no revert performed).");
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
  /** Debounce (issue #1817): total samples that must all regress before alarming. */
  confirmSamples?: number;
  /** Debounce (issue #1817): spacing between re-samples (ms). */
  confirmSpacingMs?: number;
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
    } else if (a === "--confirm-samples") {
      const n = Number.parseInt(argv[++i] ?? "", 10);
      if (Number.isFinite(n)) args.confirmSamples = n;
    } else if (a === "--confirm-spacing-ms") {
      const n = Number.parseInt(argv[++i] ?? "", 10);
      if (Number.isFinite(n)) args.confirmSpacingMs = n;
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
  // Debounce flags override env (issue #1817); confirmSamples clamps to >= 1.
  if (args.confirmSamples !== undefined) config.confirmSamples = Math.max(1, args.confirmSamples);
  if (args.confirmSpacingMs !== undefined && args.confirmSpacingMs >= 0) {
    config.confirmSpacingMs = args.confirmSpacingMs;
  }

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
