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
 * network blip), this is a clean no-op: it logs and returns a non-alarm result.
 * It MUST NOT throw — an unreachable Target is not itself a merge regression,
 * and a throwing post-merge probe must never look like a build failure. Per the
 * Orchestrator convention, nothing here ever throws on the I/O path; callers
 * read the returned result object.
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
 *
 * USAGE
 * -----
 *   tsx scripts/target/post-merge-health.ts [--merge-sha <sha>] [--dry-run]
 *
 * Intended to be fired by hydra-target-build right after an emulated
 * merge-on-green lands (see docs/operator-playbooks/hydra-target-build.md). It
 * is leaf-level: it imports only Node stdlib so it has no coupling to the
 * orchestrator service and can run from any worktree.
 */

import { spawn } from "node:child_process";

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
  /** When false, an alarm is logged + printed but hydra-incident is not spawned. */
  dispatch: boolean;
}

export interface HealthSnapshot {
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
  snapshot: HealthSnapshot;
}

/** Discriminated result of one watcher run. Never thrown — always returned. */
export type WatchResult =
  | { kind: "unreachable"; reason: string }
  | { kind: "healthy"; verdict: RegressionVerdict }
  | { kind: "alarm"; verdict: RegressionVerdict; dispatched: boolean };

/** Discriminated result of a Target health fetch. Never thrown — always returned. */
export type FetchHealthResult = { ok: true; body: unknown } | { ok: false; reason: string };

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
    dispatch: env.HYDRA_PMH_DISPATCH === "1",
  };
}

// ── Snapshot parsing (pure) ────────────────────────────────────────────────────

function classify(serviceName: string, keywords: string[]): boolean {
  const lower = serviceName.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

/**
 * Parse a raw `/api/health/full` JSON body into a normalized HealthSnapshot.
 * Tolerant of shape drift: a missing/oddly-typed `services` map yields an empty
 * service set rather than throwing, and unknown statuses are preserved verbatim
 * (lowercased) so a future status string still counts as "not ok".
 */
export function parseHealthSnapshot(body: unknown): HealthSnapshot {
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
 * Evaluate a HealthSnapshot against the configured noise floor. Pure — returns
 * a verdict with one reason string per breached threshold.
 */
export function evaluateRegression(snapshot: HealthSnapshot, config: PostMergeHealthConfig): RegressionVerdict {
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
 * Compose the `$context` argument handed to the hydra-incident skill. Pure +
 * deterministic so it can be asserted in tests.
 */
export function buildIncidentContext(verdict: RegressionVerdict, opts: { mergeSha?: string; apiUrl: string }): string {
  const failing = Object.entries(verdict.snapshot.services)
    .filter(([, status]) => status !== "ok")
    .map(([name, status]) => `${name}=${status}`)
    .join(", ");
  const lines = [
    "Post-merge operational-health regression detected on the Target (hydra-betting).",
    "ALARM-ONLY signal from scripts/target/post-merge-health.ts (issue #1054) — investigate; do NOT assume an auto-revert happened.",
    opts.mergeSha ? `Merge SHA: ${opts.mergeSha}` : "Merge SHA: (not provided)",
    `Target API: ${opts.apiUrl}/api/health/full`,
    `Overall status: ${verdict.snapshot.overall}`,
    `Failing services: ${failing || "(none reported individually)"}`,
    "Breached thresholds:",
    ...verdict.reasons.map((r) => `  - ${r}`),
  ];
  return lines.join("\n");
}

// ── I/O ────────────────────────────────────────────────────────────────────────

/**
 * Fetch `/api/health/full` from the Target. Never throws: on any network error,
 * timeout, non-2xx, or non-JSON body returns `{ ok: false, reason }`. On success
 * returns `{ ok: true, body }` with the parsed JSON.
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
    if (!res.ok) {
      return { ok: false, reason: `Target health endpoint returned HTTP ${res.status} from ${url}` };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      return { ok: false, reason: `Target health endpoint returned non-JSON body from ${url}: ${String(err)}` };
    }
    return { ok: true, body };
  } catch (err) {
    // AbortError (timeout) or connection-refused (service down mid-deploy) both
    // land here. Treat as unreachable — never throw, never alarm.
    return { ok: false, reason: `Target health endpoint unreachable at ${url}: ${String(err)}` };
  } finally {
    clearTimeout(timer);
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

// ── Orchestration ───────────────────────────────────────────────────────────────

/**
 * Run one post-merge health watch. Fetches the Target health, evaluates against
 * the noise floor, and — only on a regression and only when `config.dispatch` is
 * true — fires hydra-incident. Returns a WatchResult; never throws.
 */
export async function runWatch(
  config: PostMergeHealthConfig,
  opts: { mergeSha?: string } = {},
  deps: { fetchImpl?: typeof fetch; spawnImpl?: typeof spawn } = {},
): Promise<WatchResult> {
  const fetched: FetchHealthResult = await fetchTargetHealth(config, deps.fetchImpl ?? fetch);
  if (fetched.ok !== true) {
    // Fail-soft: unreachable Target is a clean no-op (acceptance criterion).
    console.error(`[post-merge-health] no-op: ${fetched.reason}`);
    return { kind: "unreachable", reason: fetched.reason };
  }

  const snapshot = parseHealthSnapshot(fetched.body);
  const verdict = evaluateRegression(snapshot, config);

  if (!verdict.regressed) {
    console.log(
      `[post-merge-health] healthy: overall=${snapshot.overall} servicesNotOk=${snapshot.servicesNotOk} ` +
        `executionErrors=${snapshot.executionErrors} providerErrors=${snapshot.providerErrors}`,
    );
    return { kind: "healthy", verdict };
  }

  const context = buildIncidentContext(verdict, { mergeSha: opts.mergeSha, apiUrl: config.apiUrl });
  console.error(`[post-merge-health] ALARM — post-merge operational-health regression:\n${context}`);

  if (!config.dispatch) {
    console.error(
      "[post-merge-health] dry-run (HYDRA_PMH_DISPATCH != 1): NOT dispatching hydra-incident. " +
        "Re-run with --dispatch to alarm.",
    );
    return { kind: "alarm", verdict, dispatched: false };
  }

  const { dispatched } = dispatchIncident(context, deps.spawnImpl ?? spawn);
  if (dispatched) {
    console.error("[post-merge-health] dispatched hydra-incident (alarm-only; no revert performed).");
  }
  return { kind: "alarm", verdict, dispatched };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────

interface CliArgs {
  mergeSha?: string;
  dispatch?: boolean;
  dryRun?: boolean;
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

  const result = await runWatch(config, { mergeSha: args.mergeSha });

  // Exit code is informational only — this is alarm-only and must never look
  // like a failing merge gate. 0 = no regression / clean no-op. We use a
  // distinct non-blocking code (75 / EX_TEMPFAIL) ONLY for an alarm so a wrapper
  // can optionally notice it, but callers that ignore exit codes are unaffected.
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
