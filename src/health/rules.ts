// Health Diagnostic Rules (issue #1867)
//
// The diagnostic rule set extracted from `src/health/diagnostics.ts` so the
// rule-authoring surface is one focused file: open this module, append a
// function literal to the `RULES` array. Each rule reads a Health Snapshot and
// returns a Health Diagnostic when it fires, else null. The parse pipeline and
// wire projection stay in `diagnostics.ts`; the structured type vocabulary was
// extracted to the zero-logic leaf `types.ts` (issue #3230), so this module
// consumes the `HealthSnapshot` / `HealthDiagnostic` types from the leaf
// directly — no transitive dependency on the 551-line assessment pipeline.
//
// `assessHealth` (still in `diagnostics.ts`) imports `RULES` and runs
// each rule in array order — see the runner there. Ordering is load-bearing:
// `summary` quotes `diagnostics[0].what`, so RULES order is the diagnostics
// order. Thresholds stay inline in each rule — co-located = locality.

import type { HealthSnapshot, HealthDiagnostic } from "./types.ts";
import { assessSkillCatalog, assessRegistrationFailureRate } from "./skill-catalog.ts";
// Issue #2386: the OV skill-catalog state is now carried ON the HealthSnapshot
// (`s.skillCatalog`), read live once at fan-out time in collectProbeInputs — the
// module that already owns every other in-process probe read. The two
// skill-catalog rules below read it from the snapshot like every other rule,
// making rule purity (a rule is a function of HealthSnapshot → diagnostic|null)
// literally true for ALL rules, not approximately true with two exceptions.
// rules.ts no longer value-imports getSkillCatalogState from the knowledge-base
// cluster (issue #1968's direct read), so the rule-authoring module's dependency
// graph is exactly its documented seam: it reads only diagnostics.ts types and
// the pure assessors in skill-catalog.ts.

// Issue #2013: service-probe keys that already have a bespoke diagnostic rule
// (with a tailored why/impact/action) earlier in RULES. The generic
// "external service not running" iterator rule skips these so a degraded service
// is reported exactly once — by its bespoke rule — never doubled. Any monitored
// service NOT listed here (e.g. the #2013 "embed-backend" key) is covered by the
// generic rule with zero per-service code.
const SVC_PROBES_WITH_BESPOKE_RULES = new Set(["openviking", "vikingdb", "embed-backend"]);

export const RULES: Array<(s: HealthSnapshot) => HealthDiagnostic | null> = [
  (s) =>
    s.health.status === "killed"
      ? {
          severity: "critical",
          component: "orchestrator",
          what: "Kill switch is active",
          why: "A kill file blocks all cycles until removed.",
          impact: "No cycles can run.",
          action: "Investigate, then: rm ~/hydra/.kill",
          autoRecovery: false,
        }
      : null,
  // Issue #744: operator-only emergency brake engaged. Surfaced as a
  // warning (not critical) — it's a deliberate operator action, not a fault,
  // but it suppresses ALL auto-merge so it must be visible until released.
  (s) =>
    s.emergencyBrake.engaged
      ? {
          severity: "warning",
          component: "autopilot",
          what: "EMERGENCY BRAKE ENGAGED",
          why: `Operator pulled the emergency brake${s.emergencyBrake.engagedBy ? ` (${s.emergencyBrake.engagedBy})` : ""}. All auto-merge is paused and open PRs are routed to /hydra-review.`,
          impact: "No PR auto-merges until the brake is released.",
          action: "When the incident is resolved: hydra brake off",
          autoRecovery: false,
        }
      : null,
  (s) =>
    !s.health.redis
      ? {
          severity: "critical",
          component: "redis",
          what: "Redis disconnected",
          why: "Redis is the sole state store. Without it, cycles, backlog, memory, and metrics are unavailable.",
          impact: "All operations fail.",
          action: "docker exec hydra-redis-1 redis-cli ping",
          autoRecovery: false,
        }
      : null,
  // Issue #3459: the "Stopped but work exists" else-if branch removed — it
  // gated on s.queueDepth > 0 || s.blCounts.total > 0, which were always 0
  // after ADR-0031 retired the Redis backlog subsystem (honest-zero stubs).
  (s) =>
    s.sched.consecutiveErrors >= 5
      ? {
          severity: "error",
          component: "scheduler",
          what: `Auto-stopped after ${s.sched.consecutiveErrors} errors`,
          why: `Last: "${s.sched.lastError || "unknown"}". Pauses at 5 to prevent runaway spend.`,
          impact: "No autonomous cycles.",
          action: "Check logs, then POST /api/scheduler/start",
          autoRecovery: false,
        }
      : null,
  (s) =>
    s.disk.availableGb > 0 && s.disk.availableGb < 5
      ? {
          severity: "error",
          component: "disk",
          what: `Disk critical: ${s.disk.availableGb}GB free`,
          why: `NVMe at ${s.disk.usedPercent}%. Operations fail below ~2GB.`,
          impact: "Cycle failures.",
          action: "Clean Docker images or move to /mnt/hydra-ssd",
          autoRecovery: false,
        }
      : null,
  (s) =>
    s.mem.usedPercent > 95
      ? {
          severity: "error",
          component: "memory",
          what: `Memory critical: ${s.mem.availableGb}GB free`,
          why: "OOM killer may terminate processes.",
          impact: "Crashes.",
          action: "top -o %MEM",
          autoRecovery: false,
        }
      : null,
  (s) =>
    s.recent.revertRate > 30 && s.recent.mergedN >= 3
      ? {
          severity: "error",
          component: "pipeline",
          what: `High revert rate: ${s.recent.revertRate}%`,
          why: `${s.recent.revertN}/${s.recent.mergedN} merges reverted. Executor breaking existing tests.`,
          impact: "No forward progress.",
          action: "Review executor feedback, check flaky tests",
          autoRecovery: false,
        }
      : null,
  (s) =>
    s.sched.consecutiveErrors > 0 && s.sched.consecutiveErrors < 5
      ? {
          severity: "warning",
          component: "scheduler",
          what: `${s.sched.consecutiveErrors} consecutive error(s)`,
          why: `Auto-stops at 5. Last: "${s.sched.lastError || "unknown"}"`,
          impact: "May stop soon.",
          action: "Monitor next cycles",
          autoRecovery: true,
        }
      : null,
  (s) =>
    s.disk.availableGb >= 5 && s.disk.availableGb < 20 && s.disk.totalGb > 0
      ? {
          severity: "warning",
          component: "disk",
          what: `Disk low: ${s.disk.availableGb}GB free (${s.disk.usedPercent}%)`,
          why: "Below 20GB safety margin.",
          impact: "Heavy ops may fail.",
          action: "Clean old artifacts",
          autoRecovery: false,
        }
      : null,
  (s) =>
    s.mem.usedPercent > 85 && s.mem.usedPercent <= 95
      ? {
          severity: "warning",
          component: "memory",
          what: `Memory elevated: ${s.mem.usedPercent}%`,
          why: `${s.mem.availableGb}GB free of ${s.mem.totalGb}GB.`,
          impact: "OOM risk under load.",
          action: "Check resource-heavy processes",
          autoRecovery: false,
        }
      : null,
  (s) =>
    s.svcProbes["openviking"]?.status === "failed"
      ? {
          severity: "warning",
          component: "openviking",
          what: "OpenViking unreachable",
          why: "Agents run without knowledge context, reducing quality.",
          impact: "Degraded quality.",
          action: "curl http://localhost:1933/health",
          autoRecovery: true,
        }
      : null,
  (s) =>
    s.svcProbes["vikingdb"]?.status === "failed"
      ? {
          severity: "warning",
          component: "vikingdb",
          what: "VikingDB unreachable",
          why: "Embeddings storage down. Indexing and search fail.",
          impact: "Knowledge inoperative.",
          action: "docker ps | grep viking",
          autoRecovery: true,
        }
      : null,
  // Issue #2131: a BESPOKE rule for the OpenViking dense-embedding + VLM backend
  // (the gaming-PC Ollama endpoint reached over Tailscale, #980/#1795). The
  // #2013 `embed-backend` probe (probeEmbedBackend → folds an ov-service-down /
  // ov-timeout on the embedding-exercising `search/find` transport to "failed")
  // already lands a keyed svcProbes["embed-backend"] entry. The generic
  // "external service not running" iterator below WOULD cover it, but with a
  // generic message that neither names the offline backend nor points at the
  // recovery path. The 2026-06-18 outage (#2104/#2064/#1831) showed the cost: a
  // fully-offline backend surfaced only as the benign `info` "OV search slow"
  // (the ovSearch ov-timeout → "timeout" rule below), so nothing operator-facing
  // escalated. This bespoke `warning` is the loud, actionable signal that gap
  // needs — it names the offline embedding/VLM backend and points at the
  // Wake-on-LAN recovery path (#1794). It is excluded from the generic iterator
  // (SVC_PROBES_WITH_BESPOKE_RULES) so the degraded backend is reported exactly
  // once. The slow-but-reachable case is untouched: a slow OV search still folds
  // the ovSearch probe to "timeout" → `info` "OV search slow" (the embed-backend
  // probe only fails on a transport-level ov-service-down / ov-timeout — OV
  // answering at all, even slowly, reads "running"), so no false alert fires.
  (s) =>
    s.svcProbes["embed-backend"]?.status === "failed"
      ? {
          severity: "warning",
          component: "embed-backend",
          what: "Embedding/VLM backend unreachable",
          why: "The OpenViking dense-embedding + VLM backend (the gaming-PC Ollama endpoint, gabes-desktop-1:11434, reached over Tailscale — #980/#1795) did not answer the embedding-exercising search probe. OpenViking itself may be up while this backend is offline.",
          impact: "Knowledge-plane search degrades to empty and the learning indexer stalls — agents run cycles with reduced context until the backend recovers.",
          action: "Wake/check the gaming PC (Wake-on-LAN recovery: #1794). Verify the backend: curl -m5 http://gabes-desktop-1:11434/api/tags. See OpenViking embedding/VLM backend split in docs/reference.md.",
          autoRecovery: true,
        }
      : null,
  // Issue #2013: a SINGLE generic "external service not running" rule that
  // iterates the keyed ServiceProbeMap (#1869) and fires for any monitored
  // service in a non-running state that does NOT already have a bespoke rule
  // above. This is the point of the #1869 map iterator: adding a new monitored
  // service (e.g. the #2013 "embed-backend" entry) needs ZERO new rule code —
  // it is covered automatically here, with no per-service duplication. The two
  // services with tailored action strings (openviking, vikingdb) keep their
  // bespoke rules and are excluded here so a service is never double-reported.
  // A status of "running" (or a missing key, which optional chaining leaves
  // undefined) does not fire.
  (s) => {
    for (const [name, probe] of Object.entries(s.svcProbes)) {
      if (SVC_PROBES_WITH_BESPOKE_RULES.has(name)) continue;
      if (probe?.status && probe.status !== "running") {
        return {
          severity: "warning",
          component: name,
          what: `External service "${name}" not running`,
          why: `The ${name} probe reported status "${probe.status}" instead of "running".`,
          impact: "A dependency the orchestrator monitors is degraded or unreachable.",
          action: `Check the ${name} service and its backing host/container.`,
          autoRecovery: true,
        };
      }
    }
    return null;
  },
  // Issue #3459: "Pipeline empty" rule removed — it gated on queueDepth === 0
  // && blCounts.total === 0, which were always 0 after ADR-0031 (the rule
  // fired on every tick once the honest-zero stubs replaced the real readers,
  // making it pure noise). A future GitHub-board-aware rule can replace it.

  (s) =>
    s.recent.noTaskRate > 40 && s.recent.cycleCount >= 5
      ? {
          severity: "warning",
          component: "pipeline",
          what: `No-task rate: ${s.recent.noTaskRate}%`,
          why: `Planner failed in ${s.recent.noTaskN}/${s.recent.cycleCount} cycles. Items may be stale.`,
          impact: "~$1.55 wasted per cycle.",
          action: "Clean queue, update priorities",
          autoRecovery: false,
        }
      : null,
  // Issue #3459: "Blocked items" rule removed — it gated on blCounts.blocked > 0,
  // which was always 0 after ADR-0031 retired the Redis backlog subsystem.
  // The dollar-based daily-spend cap diagnostic was retired with the
  // Subscription Usage Tracker. The new gate fires through the autopilot
  // (see /api/usage and /api/usage/eligibility), not the scheduler.
  (s) =>
    s.recent.mergeRate < 40 && s.recent.cycleCount >= 5
      ? {
          severity: "warning",
          component: "pipeline",
          what: `Low merge rate: ${s.recent.mergeRate}%`,
          why: `${s.recent.mergedN}/${s.recent.cycleCount} merged. Tasks too ambitious or failing.`,
          impact: "Slow progress.",
          action: "Narrow scope, review feedback",
          autoRecovery: false,
        }
      : null,
  (s) =>
    s.sysd.watchdog !== "active"
      ? {
          severity: "warning",
          component: "infrastructure",
          what: "Watchdog inactive",
          why: `Status: "${s.sysd.watchdog}". No auto-restart on hangs.`,
          impact: "No auto-recovery.",
          action: "systemctl --user start hydra-watchdog.timer",
          autoRecovery: false,
        }
      : null,
  (s) => {
    if (s.sched.running && s.sched.lastCycleAt) {
      const ss = (Date.now() - new Date(s.sched.lastCycleAt).getTime()) / 1000;
      if (ss > 900 && s.health.cycle !== "running") {
        return {
          severity: "info",
          component: "scheduler",
          what: `Idle ${Math.round(ss / 60)}m`,
          why: "Scheduler active but no recent cycle. May be paused.",
          impact: "May resume.",
          action: "Check status",
          autoRecovery: true,
        };
      }
    }
    return null;
  },
  (s) =>
    s.patterns.planner === 0 && s.patterns.executor === 0 && s.patterns.skeptic === 0
      ? {
          severity: "info",
          component: "intelligence",
          what: "No learned patterns",
          why: "Normal for fresh deployments.",
          impact: "Agents run without lessons.",
          action: "Accumulates automatically",
          autoRecovery: true,
        }
      : null,
  (s) =>
    s.ovSearch.status === "running" && s.ovSearch.resultCount === 0
      ? {
          severity: "info",
          component: "intelligence",
          what: "OV search empty",
          why: "Service up but index may be empty.",
          impact: "No knowledge context.",
          action: "Check indexer",
          autoRecovery: false,
        }
      : null,
  (s) =>
    s.ovSearch.status === "failed"
      ? {
          severity: "warning",
          component: "intelligence",
          what: "OV search failing",
          why: "Knowledge-plane search probe returned an error (OpenViking up but search 500ing — usually its LLM/embedding backend is down).",
          impact: "Agents run cycles with empty knowledge context.",
          action: "Check OpenViking + its LLM/embedding backend (#980).",
          autoRecovery: false,
        }
      : null,
  // Issue #1781: the search transport never reached OpenViking — distinct from a
  // 5xx (`failed`) and from a slow plane (`timeout`). The `search/find` path is
  // what exercises the embedding backend, so a transport failure here points at
  // the dense-embedding service (post-#1795 the local `ollama-embed` container)
  // or, for indexing, the Tailnet VLM host — NOT at OpenViking itself. Surface a
  // distinct, actionable warning so the operator checks the right hop. searchKnowledge
  // still returns empty (never throws), so this degrades quality, it does not crash cycles.
  (s) =>
    s.ovSearch.status === "backend-unreachable"
      ? {
          severity: "warning",
          component: "intelligence",
          what: "OV embedding backend unreachable",
          why: "Knowledge-plane search transport never reached OpenViking (DNS/connection-refused/timeout on the embedding-exercising search path). OpenViking may be up while its embedding backend is unreachable.",
          impact: "Search returns empty — agents run cycles with no knowledge context until the backend recovers.",
          action: "Check the dense-embedding service: docker exec hydra-openviking-1 curl -m5 http://ollama-embed:11434/api/tags (and the Tailnet VLM host gabes-desktop-1:11434 if indexing). See OpenViking embedding/VLM backend split in docs/reference.md.",
          autoRecovery: true,
        }
      : null,
  // Issue #1032: a probe TIMEOUT is NOT a fault — the Ollama-backed embedding
  // path is just slow, and real agent searches (no 3s cap) succeed. Surface it
  // as info so a slow-but-working plane is visible without folding the top-level
  // status to `degraded` the way the `failed` warning above does.
  (s) =>
    s.ovSearch.status === "timeout"
      ? {
          severity: "info",
          component: "intelligence",
          what: "OV search slow",
          why: "Search probe exceeded its deep-health timeout but did not error — the Ollama-backed embedding path (nomic-embed over Tailscale, #980) is slow, not down. Real agent searches have no such cap and succeed.",
          impact: "None on agents; the deep-health probe latency is just high.",
          action: "Monitor; raise OV_SEARCH_PROBE_TIMEOUT_MS if it persists.",
          autoRecovery: true,
        }
      : null,
  // Issue #2492: surface the reflection-deposit-health verdict through the
  // deep-health fold so an operator checking /api/health/deep sees it where they
  // look — closing the discoverability gap that kept re-filing a NON-bug
  // (#1912→#2450→#2467→#2492). The full verdict ALWAYS rides the wire envelope
  // (intelligence.reflectionHealth), so this rule deliberately fires NOTHING on
  // the honest `all-none-empty-store` / `healthy` / `no-data` states — a
  // 100%-`none` distribution on an empty reflection store is the EXPECTED steady
  // state of a high-merge-rate run (reflections are produced only on a non-merged
  // failure), NOT an alarm; folding it to `degraded` would BE the false alarm the
  // design-concept invariant forbids (mirrors the #2386/#2278 honest-none-never-
  // phantom-alarm discipline). It fires a single INFO (never warning/error) ONLY
  // on `served-but-bucketed-none`: a cycle DID carry a present reflectionSources
  // deposit yet still bucketed `none` — the genuine candidate false-none worth an
  // operator's eye (deposit/read plumbing), distinct from the honest empty store.
  (s) =>
    s.reflectionHealth.verdict === "served-but-bucketed-none"
      ? {
          severity: "info",
          component: "intelligence",
          what: "Reflection deposit served but bucketed 'none'",
          why: s.reflectionHealth.note,
          impact:
            "A reflection deposit landed yet did not register as applied context — a candidate false-none (distinct from the EXPECTED all-none of an empty store on a high-merge run, which is not surfaced here). Learning-context telemetry may under-count what reached a retry.",
          action:
            "Inspect the deposit/read path: GET /api/learning/reflection-health for the full distribution; confirm reap.py reflection_sources forwarding and the per-anchor/by-file read seam (src/reflections/index.ts).",
          autoRecovery: true,
        }
      : null,
  // Issue #2805: surface a DARK leading outcome (a `kind: leading` outcome whose
  // reading is null — no data ever produced) through the deep-health fold so an
  // operator watching /api/health/deep sees the vision's primary-path blindness
  // where they look. The full dark-outcome check runs at fan-out time and lands
  // on the snapshot (s.darkOutcomes); this rule is a PURE function of the snapshot
  // (Invariant 5) — no I/O. Advisory WARNING severity, never critical (Invariant
  // 7): a dark leading outcome is silent Outcome-Holdback blindness (every
  // baseline carries value:null), NOT a process fault. The why/action carry the
  // producerHint + metric file path (query) so the operator knows WHICH producer
  // is dark and where it should write (Invariant 6). Fires only when at least one
  // leading outcome reads dark; an all-live (or empty) snapshot no-ops — honest-
  // none, never a phantom alarm (mirrors the #2492/#2386 discipline).
  (s) => {
    const dark = (s.darkOutcomes || []).filter((v) => v.status === "dark");
    if (dark.length === 0) return null;
    const detail = dark
      .map((v) => `${v.name} (${v.producerHint}) → should write ${v.query}`)
      .join("; ");
    return {
      severity: "warning",
      component: "intelligence",
      what: `Dark leading outcome${dark.length > 1 ? "s" : ""}: ${dark.map((v) => v.name).join(", ")}`,
      why: `A kind:leading outcome has read null (no data ever produced). ${detail}`,
      impact:
        "Silent Outcome-Holdback blindness — every holdback baseline carries value:null for this outcome, so the system cannot tell whether its learning improves the vision's primary-path metric.",
      action:
        "Diagnose the named producer chain and bring it live; the wiring-liveness dark-outcome alarm (issue #2805) auto-files a needs-triage issue once the outcome has been continuously dark for 7+ days.",
      autoRecovery: false,
    };
  },
  // Issue #3270: warn when the attribution ledger is empty. The attribution
  // spine (epic #2628) was designed to populate `hydra:attribution:ledger` with
  // per-merge observation rows as soon as PRs land and their windows close. An
  // empty ledger after the wiring (post-#3113 ordering fix) signals the producer
  // flow never fired — the exact symptom issue #3270 diagnoses. Advisory: surfaces
  // as a WARNING (not error) so an operator is alerted without blocking the
  // pipeline. Fires only when count === 0 (never on partial population); the
  // honest-zero default on probe failure means this rule no-ops when the probe
  // itself fails (honest-none, never a phantom alarm).
  (s) => {
    if (s.attributionLedgerCount > 0) return null;
    return {
      severity: "warning" as const,
      component: "intelligence",
      what: "Attribution ledger is empty — merger→ledger flow never fired",
      why: "The outcome-attribution spine (epic #2628) wires `runAttributionRecord` as a housekeeping chore (issue #2632) to populate `hydra:attribution:ledger` with per-merge observation rows. The ledger has 0 rows, meaning the producer flow (open window on PR landing → close window after duration → append row) has not completed a single cycle. The issue #3113 ordering fix (attribution-record before holdback-merge-watch in housekeeping.ts) must be applied AND at least one PR must have landed AND its window must have elapsed.",
      impact: "The ridge estimator (#2630) and per-class scoreboard (#2943) have no data — `estimateMarginalEffects` returns empty results and the outcome-attribution spine is dark despite the wiring existing.",
      action: "Check `runAttributionRecord` logs (`journalctl --user -u hydra-orchestrator.service | grep '\[attribution\]'`). Verify: (1) holdback pending-enroll registry has/had entries (`HGETALL hydra:holdback:pending-enroll`); (2) attribution-record chore runs BEFORE holdback-merge-watch in housekeeping.ts (issue #3113); (3) at least one window has elapsed (`HGETALL hydra:attribution:windows`).",
      autoRecovery: false,
    };
  },
    // Issue #1968: surface the silent empty/partial OV skill catalog through the
  // deep-health Health Assessment fold so an operator watching /api/health/deep
  // (or hydra-doctor) sees it — the standalone /api/health/skills endpoint is a
  // supplementary detail view, but only this rule folds the failure into the
  // top-level `status` and `diagnostics` array. Issue #2386: the catalog state
  // now arrives ON the snapshot (`s.skillCatalog`, assembled at fan-out time),
  // so this rule is pure over its `s` argument like every other rule — no more
  // out-of-band getSkillCatalogState() read. assessSkillCatalog already maps
  // empty → severity:"error", partial → severity:"warning", and ok/in-flight →
  // diagnostic:null, so this rule is a thin pass-through of that gate's diagnostic.
  (s) => assessSkillCatalog(s.skillCatalog).diagnostic,
  // Issue #2277: the registration-FAILURE-RATE alert. Distinct from the
  // population gate above (empty/partial): this reads the last completed pass's
  // failure rate from `s.skillCatalog` (issue #2386 — sourced from the snapshot,
  // not a live getSkillCatalogState() read). It fires a `warning` when the failure
  // rate exceeds 10% and points at OpenViking load + the ollama-recovery playbook.
  // `warning` (not `error`) so it ANNOTATES the population verdict without
  // escalating the deep-health fold above it. Read-only: it adds no export to
  // skill-registration and never mutates state. (Issue #3544: the Ollama VLM
  // liveness correlation was retired at the VLM cutover — see the rule body.)
  (s) => assessRegistrationFailureRate(s.skillCatalog),
];

// ---- fmtUp — uptime humanizer shared by assessHealth + the wire projection -
//
// Pure seconds → "Hh Mm" / "Mm" formatter. Lives here alongside RULES (the
// rule-authoring surface) and is imported back by `diagnostics.ts`,
// where both `assessHealth`'s healthy-summary banner and
// `projectHealthDeepResponse`'s `uptimeHuman` field consume it.
export function fmtUp(s: number): string {
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
