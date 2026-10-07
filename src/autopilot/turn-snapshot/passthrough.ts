/**
 * turn-snapshot/passthrough.ts — the HTTP-passthrough Turn Snapshot collectors
 * (ADR-0043 slice 5, #4933): health, direction drift, scout alerts, realm
 * share, usage eligibility, emergency brake, class stats, capacity, scheduler,
 * recommendations and slot events.
 *
 * Each was a `collect-state.sh` function that read one or two data-plane
 * routes through `hydra raw GET` (now the injected {@link TurnSnapshotHydraHttp})
 * and, for most, folded the JSON in an inline python heredoc that swallowed
 * every exception into a fallback line. Here each collector is
 * `(deps) => Promise<CollectorOutcome<T>>`: the fold is a pure function over
 * the decoded payload, and every arm the python's bare `except:` caught is an
 * explicit degraded field (`Classified` with `ok: false`) that the `kv`
 * renderer (render-kv-passthrough.ts) turns back into today's fallback line.
 *
 * Semantics carried over verbatim (golden files under
 * test/fixtures/turn-snapshot/passthrough/ pin the bytes):
 *   - health: `health=<status> redis=<redis>` (Python `str()` of each), or
 *     `health=FAIL`; `failed_services=<lines matching "hydra">` from the failed
 *     systemd user units. Under `set -o pipefail` a zero count (grep -c exits 1)
 *     or a failed systemctl also fired the `|| echo 0` arm, so those cases
 *     carry a second `0` line — kept for byte parity until slice 6.
 *   - direction drift (#1791): `true` when a readable live Target direction doc
 *     (`$HYDRA_TARGET_REPO/direction/{priorities,roadmap}.md`, else the Target
 *     workspace from src/target-config.ts) differs byte-wise from its readable
 *     committed copy under `${HYDRA_CONFIG_PATH:-$HOME/hydra/config}/direction`;
 *     a missing side never drifts. Read-only.
 *   - scout alerts: `len(eligible)` of `/scout/alert-plan` (0 when unreadable;
 *     a failed fetch also fired the pipefail `|| echo 0` → second `0` line).
 *   - realm share (#4161): orch dispatch tokens over orch+target dispatch
 *     tokens from `/usage` `bySkillByModel`, folded through the taxonomy
 *     `scope` column of scripts/autopilot/classes.json ("both" and unknown
 *     skills count on neither side); `unavailable` on any unreadable input or
 *     a non-positive denominator — fail-open, never suppresses dispatch.
 *   - usage eligibility / emergency brake (#744) / class stats (#2943): the
 *     body verbatim, or the documented fail-open literal.
 *   - capacity (#4298): `capacity_orch_share=<.2f> capacity_floor_met=…
 *     capacity_floor_status=… capacity_window=…`, or the honest unmeasured line.
 *   - scheduler: `CODEX_ACTIVE` iff `/cycle/status` `running` is truthy, then
 *     `scheduler=<state> nonmerges=<n> stall=ok|alert|hard-stop` (<5 / 5-7 / >=8).
 *   - recommendations: `recommendations=<n>: <first action[:60]>` / `=0` /
 *     `=unavailable`.
 *   - slot events (#509, #4510): `/autopilot/slot-events?last_id=<cursor>&count=<n>`,
 *     the cursor from HYDRA_AUTOPILOT_SLOT_EVENTS_LAST_ID (default `0`,
 *     percent-encoded like `jq @uri`), count from HYDRA_AUTOPILOT_SLOT_EVENTS_COUNT
 *     (default `100`); body verbatim (trailing newlines stripped) or the empty shape.
 *
 * No collector throws on bad input; {@link runPassthroughCollectors} also
 * catches an unexpected throw and renders that collector's full fallback.
 */

import { join } from "node:path";
import type { Classified, CollectorOutcome, DegradedMarker } from "./collector.ts";
import type { TurnSnapshotHost } from "./host-port.ts";
import type { HydraHttpRead, TurnSnapshotHydraHttp } from "./hydra-http.ts";
import { pyJsonLoads, pyTruthy } from "./py-compat.ts";
import { isPyDict, pyLen } from "./py-format.ts";
import {
  renderCapacityKv,
  renderClassStatsKv,
  renderDirectionDriftKv,
  renderEmergencyBrakeKv,
  renderHealthKv,
  renderRealmShareKv,
  renderRecommendationsKv,
  renderSchedulerKv,
  renderScoutAlertsKv,
  renderSlotEventsKv,
  renderUsageEligibilityKv,
} from "./render-kv-passthrough.ts";

/** Raw env the passthrough collectors read (values as `process.env` holds them). */
export interface PassthroughEnv {
  readonly HOME?: string;
  readonly HYDRA_CONFIG_PATH?: string;
  readonly HYDRA_TARGET_REPO?: string;
  readonly HYDRA_AUTOPILOT_SLOT_EVENTS_LAST_ID?: string;
  readonly HYDRA_AUTOPILOT_SLOT_EVENTS_COUNT?: string;
}

export interface PassthroughDeps {
  readonly hydra: TurnSnapshotHydraHttp;
  readonly host: TurnSnapshotHost;
  readonly env: PassthroughEnv;
  /** Absolute path of the class taxonomy (scripts/autopilot/classes.json). */
  readonly taxonomyPath: string;
  /** The Target workspace when HYDRA_TARGET_REPO is unset (src/target-config.ts in production). */
  readonly targetWorkspace: () => string;
}

// ---------------------------------------------------------------------------
// Value types
// ---------------------------------------------------------------------------

export interface HealthValue {
  readonly service: Classified<{ readonly status: unknown; readonly redis: unknown }>;
  /** Lines of the failed-unit listing containing `hydra`. */
  readonly failedServices: number;
  /** The `|| echo 0` arm fired (zero matches or systemctl failed) — a second `0` line. */
  readonly failedServicesFallbackZero: boolean;
}

export interface ScoutAlertsValue {
  readonly eligible: Classified<number>;
  /** The fetch failed, so the pipefail `|| echo 0` arm fired — a second `0` line. */
  readonly fetchFailed: boolean;
}

export interface CapacityValue {
  readonly share: number;
  readonly floorMet: unknown;
  readonly floorStatus: unknown;
  readonly window: unknown;
}

export interface SchedulerValue {
  readonly codexRunning: Classified<boolean>;
  readonly scheduler: Classified<{ readonly state: unknown; readonly nonMerges: number | boolean }>;
}

export interface RecommendationsValue {
  readonly count: number;
  /** The first item's `action[:60]` (a string or a list slice); `null` when the list is empty/falsy. */
  readonly firstAction: string | readonly unknown[] | null;
}

// ---------------------------------------------------------------------------
// Pure folds (payload → classified value)
// ---------------------------------------------------------------------------

type Parsed = { ok: true; value: unknown } | { ok: false; reason: string };

function parseRead(read: HydraHttpRead): Parsed {
  if (read.kind === "failed") return { ok: false, reason: read.reason };
  const parsed = pyJsonLoads(read.body);
  return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, reason: "unparseable" };
}

const fail = <T>(reason: string): Classified<T> => ({ ok: false, reason });
const okv = <T>(value: T): Classified<T> => ({ ok: true, value });

/** `health={d["status"]} redis={d["redis"]}` needs a dict carrying both keys. */
export function foldHealth(p: Parsed): HealthValue["service"] {
  if ("reason" in p) return fail(p.reason);
  const d = p.value;
  if (!isPyDict(d) || !("status" in d) || !("redis" in d)) return fail("shape");
  return okv({ status: d.status, redis: d.redis });
}

/** `grep -c hydra` over the listing, plus whether the pipeline's `|| echo 0` arm fired. */
export function foldFailedServices(read: { ok: boolean; stdout: string }): { count: number; fallbackZero: boolean } {
  const lines = read.stdout === "" ? [] : read.stdout.replace(/\n$/, "").split("\n");
  const count = lines.filter((l) => l.includes("hydra")).length;
  return { count, fallbackZero: !read.ok || count === 0 };
}

/** `len(d.get('eligible', []))`. */
export function foldScoutAlerts(p: Parsed): Classified<number> {
  if ("reason" in p) return fail(p.reason);
  if (!isPyDict(p.value)) return fail("shape");
  const n = pyLen("eligible" in p.value ? p.value.eligible : []);
  return n === null ? fail("eligible-has-no-len") : okv(n);
}

/** The #4161 realm fold. `taxonomy` is the decoded classes.json, or a failure reason. */
export function foldRealmShare(p: Parsed, taxonomy: Parsed): Classified<number> {
  if ("reason" in p) return fail(p.reason);
  const bsm = isPyDict(p.value) ? p.value.bySkillByModel : undefined;
  if (!isPyDict(bsm)) return fail("no-bySkillByModel");
  if ("reason" in taxonomy) return fail(`taxonomy-${taxonomy.reason}`);
  const doc = pyTruthy(taxonomy.value) ? taxonomy.value : {};
  if (!isPyDict(doc)) return fail("taxonomy-shape");
  const classes = pyTruthy(doc.classes) ? doc.classes : [];
  // Python iterates a list's items, a dict's keys, a str's chars — only list
  // items can be dicts. (A truthy number would crash the python outside its
  // try; it degrades here instead — see the PR's "Decisions taken".)
  const rows: unknown[] = Array.isArray(classes) ? classes : [];
  const skillScope = new Map<string, string>();
  for (const row of rows) {
    if (!isPyDict(row)) continue;
    const { skill, scope } = row;
    if (typeof skill === "string" && (scope === "orch" || scope === "target" || scope === "both")) skillScope.set(skill, scope);
  }
  let orch = 0;
  let target = 0;
  for (const [skill, entry] of Object.entries(bsm)) {
    const realm = skillScope.get(skill);
    if (realm !== "orch" && realm !== "target") continue;
    if (!isPyDict(entry)) continue;
    for (const fam of Object.values(entry)) {
      if (!isPyDict(fam)) continue;
      const raw = fam.total;
      if (typeof raw !== "number") continue;
      if (realm === "orch") orch += raw;
      else target += raw;
    }
  }
  const denom = orch + target;
  if (!Number.isFinite(denom) || denom <= 0) return fail("zero-denominator");
  const share = orch / denom;
  if (!Number.isFinite(share) || share < 0 || share > 1) return fail("share-out-of-range");
  return okv(share);
}

/** `d['orchestrator']['share']:.2f` + `d.get('floorMet')`, `d.get('floorStatus')`, `o['window']`. */
export function foldCapacity(p: Parsed): Classified<CapacityValue> {
  if ("reason" in p) return fail(p.reason);
  const d = p.value;
  if (!isPyDict(d) || !("orchestrator" in d)) return fail("no-orchestrator");
  const o = d.orchestrator;
  if (!isPyDict(o) || !("share" in o) || !("window" in o)) return fail("orchestrator-shape");
  const share = typeof o.share === "boolean" ? Number(o.share) : o.share;
  if (typeof share !== "number") return fail("share-not-numeric");
  return okv({ share, floorMet: d.floorMet, floorStatus: d.floorStatus, window: o.window });
}

/** `'CODEX_ACTIVE' if d.get('running') else 'CODEX_IDLE'`. */
export function foldCycleRunning(p: Parsed): Classified<boolean> {
  if ("reason" in p) return fail(p.reason);
  if (!isPyDict(p.value)) return fail("shape");
  return okv(pyTruthy(p.value.running));
}

/** `d.get('state','?')`, `d.get('consecutiveNonMerges',0)` — which must compare with an int. */
export function foldScheduler(p: Parsed): SchedulerValue["scheduler"] {
  if ("reason" in p) return fail(p.reason);
  const d = p.value;
  if (!isPyDict(d)) return fail("shape");
  const nm = "consecutiveNonMerges" in d ? d.consecutiveNonMerges : 0;
  if (typeof nm !== "number" && typeof nm !== "boolean") return fail("nonmerges-not-numeric");
  return okv({ state: "state" in d ? d.state : "?", nonMerges: nm });
}

/** The scheduler stall band: `<5` ok, `>=8` hard-stop, else alert. */
export function stallBand(nonMerges: number | boolean): "ok" | "alert" | "hard-stop" {
  const n = Number(nonMerges);
  return n < 5 ? "ok" : n >= 8 ? "hard-stop" : "alert";
}

/** `len(items)` + `items[0].get("action","?")[:60]` when the payload is truthy. */
export function foldRecommendations(p: Parsed): Classified<RecommendationsValue> {
  if ("reason" in p) return fail(p.reason);
  const items = p.value;
  if (!pyTruthy(items)) return okv({ count: 0, firstAction: null });
  if (!Array.isArray(items)) return fail("not-a-list");
  const first = items[0];
  if (!isPyDict(first)) return fail("first-not-a-dict");
  const action = "action" in first ? first.action : "?";
  if (typeof action === "string") return okv({ count: items.length, firstAction: Array.from(action).slice(0, 60).join("") });
  if (Array.isArray(action)) return okv({ count: items.length, firstAction: action.slice(0, 60) });
  return fail("action-not-sliceable");
}

/** `jq -sRr @uri`: percent-encode every UTF-8 byte outside `A-Za-z0-9-_.~`. */
export function jqUri(s: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(s)) {
    const ch = String.fromCharCode(byte);
    out += /[A-Za-z0-9\-_.~]/.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** The slot-events GET path for a cursor/count env (bash `${VAR:-default}` defaults). */
export function slotEventsPath(env: PassthroughEnv): string {
  const lastId = env.HYDRA_AUTOPILOT_SLOT_EVENTS_LAST_ID || "0";
  const count = env.HYDRA_AUTOPILOT_SLOT_EVENTS_COUNT || "100";
  return `/autopilot/slot-events?last_id=${jqUri(lastId)}&count=${count}`;
}

// ---------------------------------------------------------------------------
// Collectors
// ---------------------------------------------------------------------------

const marker = (field: string, c: Classified<unknown>): DegradedMarker[] => ("reason" in c ? [{ field, reason: c.reason }] : []);

function outcome<T>(collector: string, value: T, degraded: DegradedMarker[]): CollectorOutcome<T> {
  return { collector, value, degraded, notes: [] };
}

export async function collectHealth(deps: PassthroughDeps): Promise<CollectorOutcome<HealthValue>> {
  const [read, units] = await Promise.all([deps.hydra.get("/health"), deps.host.failedServiceUnits()]);
  const service = foldHealth(parseRead(read));
  const fs = foldFailedServices(units);
  const degraded = [...marker("health", service), ...(units.ok ? [] : [{ field: "failedServices", reason: "systemctl-failed" }])];
  return outcome("health", { service, failedServices: fs.count, failedServicesFallbackZero: fs.fallbackZero }, degraded);
}

export const DIRECTION_DOCS = ["priorities.md", "roadmap.md"] as const;

export async function collectDirectionDrift(deps: PassthroughDeps): Promise<CollectorOutcome<boolean>> {
  const targetDir = join(deps.env.HYDRA_TARGET_REPO || deps.targetWorkspace(), "direction");
  const orchDir = join(deps.env.HYDRA_CONFIG_PATH || join(deps.env.HOME ?? "", "hydra", "config"), "direction");
  let drift = false;
  for (const doc of DIRECTION_DOCS) {
    const [live, copy] = await Promise.all([deps.host.readFile(join(targetDir, doc)), deps.host.readFile(join(orchDir, doc))]);
    if (live !== null && copy !== null && !live.equals(copy)) {
      drift = true;
      break;
    }
  }
  return outcome("direction-drift", drift, []);
}

export async function collectScoutAlerts(deps: PassthroughDeps): Promise<CollectorOutcome<ScoutAlertsValue>> {
  const read = await deps.hydra.get("/scout/alert-plan");
  const eligible = foldScoutAlerts(parseRead(read));
  return outcome("scout-alerts", { eligible, fetchFailed: read.kind === "failed" }, marker("eligible", eligible));
}

export async function collectRealmShare(deps: PassthroughDeps): Promise<CollectorOutcome<Classified<number>>> {
  const [read, taxonomyBytes] = await Promise.all([deps.hydra.get("/usage"), deps.host.readFile(deps.taxonomyPath)]);
  let taxonomy: Parsed;
  if (taxonomyBytes === null) taxonomy = { ok: false, reason: "unreadable" };
  else {
    const parsed = pyJsonLoads(taxonomyBytes.toString("utf-8"));
    taxonomy = parsed.ok ? { ok: true, value: parsed.value } : { ok: false, reason: "unparseable" };
  }
  const share = foldRealmShare(parseRead(read), taxonomy);
  return outcome("realm-share", share, marker("orchRealmWeeklyShare", share));
}

async function collectBody(deps: PassthroughDeps, collector: string, path: string): Promise<CollectorOutcome<Classified<string>>> {
  const read = await deps.hydra.get(path);
  const body: Classified<string> = read.kind === "ok" ? okv(read.body) : fail(read.reason);
  return outcome(collector, body, marker(collector, body));
}

export const collectUsageEligibility = (deps: PassthroughDeps) => collectBody(deps, "usage-eligibility", "/usage/eligibility");
export const collectEmergencyBrake = (deps: PassthroughDeps) => collectBody(deps, "emergency-brake", "/autopilot/emergency-brake");
export const collectClassStats = (deps: PassthroughDeps) => collectBody(deps, "class-stats", "/autopilot/class-stats");

export async function collectCapacity(deps: PassthroughDeps): Promise<CollectorOutcome<Classified<CapacityValue>>> {
  const capacity = foldCapacity(parseRead(await deps.hydra.get("/capacity")));
  return outcome("capacity", capacity, marker("capacity", capacity));
}

export async function collectScheduler(deps: PassthroughDeps): Promise<CollectorOutcome<SchedulerValue>> {
  const [cycle, sched] = await Promise.all([deps.hydra.get("/cycle/status"), deps.hydra.get("/scheduler/status")]);
  const codexRunning = foldCycleRunning(parseRead(cycle));
  const scheduler = foldScheduler(parseRead(sched));
  return outcome("scheduler", { codexRunning, scheduler }, [...marker("codexRunning", codexRunning), ...marker("scheduler", scheduler)]);
}

export async function collectRecommendations(deps: PassthroughDeps): Promise<CollectorOutcome<Classified<RecommendationsValue>>> {
  const recs = foldRecommendations(parseRead(await deps.hydra.get("/recommendations")));
  return outcome("recommendations", recs, marker("recommendations", recs));
}

export async function collectSlotEvents(deps: PassthroughDeps): Promise<CollectorOutcome<Classified<string>>> {
  const read = await deps.hydra.get(slotEventsPath(deps.env));
  // `$(hydra raw GET …)` strips trailing newlines; an empty capture is the fallback arm.
  const body = read.kind === "ok" ? read.body.replace(/\n+$/, "") : "";
  const events: Classified<string> = body !== "" ? okv(body) : fail(read.kind === "failed" ? read.reason : "empty-body");
  return outcome("slot-events", events, marker("slotEvents", events));
}

// ---------------------------------------------------------------------------
// Registry + runner (the CLI's `--collectors` names)
// ---------------------------------------------------------------------------

interface PassthroughEntry {
  collect(deps: PassthroughDeps): Promise<{ text: string; degraded: readonly DegradedMarker[] }>;
  /** The lines the collector prints when every read failed (also the crash fallback). */
  readonly fallback: string;
}

function entry<T>(collect: (d: PassthroughDeps) => Promise<CollectorOutcome<T>>, render: (v: T) => string, fallback: string): PassthroughEntry {
  return {
    async collect(deps) {
      const o = await collect(deps);
      return { text: render(o.value), degraded: o.degraded };
    },
    fallback,
  };
}

const FAILED: Classified<never> = { ok: false, reason: "all-reads-failed" };

/** Collector name → collect + render, in no particular order (the caller's `--collectors` order is the emit order). */
export const PASSTHROUGH_COLLECTORS: Readonly<Record<string, PassthroughEntry>> = {
  health: entry(collectHealth, renderHealthKv, renderHealthKv({ service: FAILED, failedServices: 0, failedServicesFallbackZero: true })),
  "direction-drift": entry(collectDirectionDrift, renderDirectionDriftKv, renderDirectionDriftKv(false)),
  "scout-alerts": entry(collectScoutAlerts, renderScoutAlertsKv, renderScoutAlertsKv({ eligible: FAILED, fetchFailed: true })),
  "realm-share": entry(collectRealmShare, renderRealmShareKv, renderRealmShareKv(FAILED)),
  "usage-eligibility": entry(collectUsageEligibility, renderUsageEligibilityKv, renderUsageEligibilityKv(FAILED)),
  "emergency-brake": entry(collectEmergencyBrake, renderEmergencyBrakeKv, renderEmergencyBrakeKv(FAILED)),
  "class-stats": entry(collectClassStats, renderClassStatsKv, renderClassStatsKv(FAILED)),
  capacity: entry(collectCapacity, renderCapacityKv, renderCapacityKv(FAILED)),
  scheduler: entry(collectScheduler, renderSchedulerKv, renderSchedulerKv({ codexRunning: FAILED, scheduler: FAILED })),
  recommendations: entry(collectRecommendations, renderRecommendationsKv, renderRecommendationsKv(FAILED)),
  "slot-events": entry(collectSlotEvents, renderSlotEventsKv, renderSlotEventsKv(FAILED)),
};

export function isPassthroughCollector(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(PASSTHROUGH_COLLECTORS, name);
}

/**
 * Run the named collectors concurrently and concatenate their `kv` text in the
 * given order. A collector that throws is reported as a stderr note and
 * rendered as its full fallback — the run never throws.
 */
export async function runPassthroughCollectors(
  names: readonly string[],
  deps: PassthroughDeps,
): Promise<{ stdout: string; notes: string[]; degraded: DegradedMarker[] }> {
  const results = await Promise.all(
    names.map(async (name) => {
      const e = PASSTHROUGH_COLLECTORS[name] as PassthroughEntry;
      try {
        return { name, ...(await e.collect(deps)), note: null as string | null };
      } catch (err) {
        /* intentional: fail-open — the crash becomes a stderr note plus the collector's fallback lines */
        const msg = err instanceof Error ? err.message : String(err);
        return {
          name,
          text: e.fallback,
          degraded: [{ field: name, reason: "collector-crashed" }],
          note: `orch turn-snapshot ${name} collector crashed (${msg}) — emitting its fail-open fallback (issue #4933)`,
        };
      }
    }),
  );
  return {
    stdout: results.map((r) => r.text).join(""),
    notes: results.flatMap((r) => (r.note === null ? [] : [r.note])),
    degraded: results.flatMap((r) => [...r.degraded]),
  };
}
