// Wake-on-LAN auto-recovery for the OpenViking dense-embedding backend
// (issue #2228 — the stretch goal of #1794). The parallel VLM-host wake trigger
// (#2335) was retired at the OpenViking VLM cutover (issue #3544).
//
// WHY THIS FILE EXISTS
//   The deep-health fan-out (src/health/fan-out.ts) already DETECTS an offline
//   gaming-PC embedding backend: `probeEmbedBackend()` folds an unreachable
//   `search/find` transport to `status:"failed"`, and the bespoke #2131 rule
//   (src/health/rules.ts) emits a `warning` whose action text literally tells a
//   human to "Wake/check the gaming PC (Wake-on-LAN recovery: #1794)." #1794
//   verified that a magic packet from the orchestrator host wakes the gaming PC
//   (`gabes-desktop-1`, Intel I225-V NIC, MAC d8:bb:c1:70:62:76) from a full
//   power-off and the Ollama backend self-recovers in ~40s. This module makes
//   that recovery AUTOMATIC: the IO layer broadcasts the packet before alerting,
//   so a powered-off box self-heals with no operator in the loop.
//
// THE MECHANISM / POLICY SPLIT (issue #3345)
//   The low-level UDP packet mechanism — `parseMac`, `buildMagicPacket`,
//   `sendMagicPacket`, `WolSendResult`, and the socket-level constants
//   (`WOL_PORTS`, `WOL_DEFAULT_MAC`, `WOL_DEFAULT_BROADCAST`) — lives in the
//   focused leaf src/health/wol-send.ts. THIS module is the wake-trigger
//   POLICY: it decides WHEN a wake fires; the leaf owns HOW the packet is
//   built and broadcast. The dependency runs strictly one way: this file
//   imports `sendMagicPacket` from the leaf; the leaf has zero policy
//   knowledge.
//
// THE PURE / IO SPLIT (kept intact — see issue #2228 design)
//   - `WakeGate` is a PURE timing policy: cooldown (at most one send per N ms)
//     plus a max-attempt cap (after K failed wakes, stop and let the existing
//     #2131 alert page the operator). No clock import — `now` is passed in, so
//     the guardrails are deterministically unit-testable.
//   - `attemptEmbedBackendWake()` (and the `sendMagicPacket` mechanism it
//     drives) is the IO side. It NEVER throws (CLAUDE.md: never throw from the
//     health/verification path); every failure folds to a result object and a
//     fail-loud `console.error`.
//
// `assessHealth()` stays pure and is untouched — it never sends a packet. The
// send is wired into the fan-out's embed-backend probe step (the IO layer that
// already runs probeEmbedBackend), and only fires when that probe reports
// `failed`.
import {
  sendMagicPacket,
  type WolSendResult,
  WOL_DEFAULT_MAC,
  WOL_DEFAULT_BROADCAST,
} from "./wol-send.ts";
import type { ServiceProbeResult } from "./probe.ts";

/** Conservative default: at most one wake every 5 minutes. */
const WOL_DEFAULT_COOLDOWN_MS = 5 * 60_000;
/** After this many consecutive failed wakes, stop and fall through to the alert. */
const WOL_DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Pure cooldown + max-attempt policy for WoL sends.
 *
 * It owns NO clock and NO network — `shouldSend(now)` decides purely from the
 * timestamps/counters it was given, and `recordSend(now)` advances them. This
 * keeps the guardrails (no packet-per-heartbeat spam; give up after K attempts)
 * deterministically unit-testable without faking time or sockets.
 *
 * Lifecycle, driven by the IO caller:
 *   - `shouldSend(now)` → true only if NOT within cooldown AND attempts < max.
 *   - `recordSend(now)` after a send attempt — bumps the attempt counter and the
 *     last-send timestamp (so the next `shouldSend` honours the cooldown).
 *   - `reset()` when the backend is observed healthy again — clears the attempt
 *     counter so a future outage gets a fresh budget of wakes.
 */
export class WakeGate {
  private attempts = 0;
  private lastSendMs: number | null = null;
  // NB: explicit field declarations + constructor assignment, NOT TypeScript
  // parameter properties — the `npm test` runner uses `--experimental-strip-types`
  // (strip-only mode) which rejects parameter properties (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX).
  private readonly cooldownMs: number;
  private readonly maxAttempts: number;
  constructor(
    cooldownMs: number = WOL_DEFAULT_COOLDOWN_MS,
    maxAttempts: number = WOL_DEFAULT_MAX_ATTEMPTS,
  ) {
    this.cooldownMs = cooldownMs;
    this.maxAttempts = maxAttempts;
  }

  /** True iff a send is allowed right now (outside cooldown AND under the cap). */
  shouldSend(now: number): boolean {
    if (this.attempts >= this.maxAttempts) return false;
    if (this.lastSendMs !== null && now - this.lastSendMs < this.cooldownMs) return false;
    return true;
  }

  /** Record that a send was attempted at `now` (advances cooldown + attempt count). */
  recordSend(now: number): void {
    this.attempts += 1;
    this.lastSendMs = now;
  }

  /** Clear the attempt budget — call when the backend is healthy again. */
  reset(): void {
    this.attempts = 0;
    this.lastSendMs = null;
  }

  /** True once the attempt cap is hit (the alert should fire instead). */
  get exhausted(): boolean {
    return this.attempts >= this.maxAttempts;
  }

  get attemptCount(): number {
    return this.attempts;
  }
}

/** Resolved WoL config: env overrides with the #1794-verified defaults. */
export interface WolConfig {
  enabled: boolean;
  mac: string;
  broadcast: string;
  cooldownMs: number;
  maxAttempts: number;
}

/**
 * Read WoL config from the environment, falling back to the #1794-verified
 * defaults. Pure (no I/O); `env` is injectable for the test. The enable flag is
 * conservative — auto-wake is OFF unless `HYDRA_WOL_ENABLED` is `true`/`1`, so
 * the behaviour change is opt-in (the host must actually be on the gaming PC's
 * `10.0.0.0/24` LAN for the L2 broadcast to land).
 */
export function readWolConfig(env: NodeJS.ProcessEnv = process.env): WolConfig {
  const flag = (env.HYDRA_WOL_ENABLED || "").toLowerCase();
  const num = (raw: string | undefined, dflt: number): number => {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : dflt;
  };
  return {
    enabled: flag === "true" || flag === "1",
    mac: env.HYDRA_WOL_MAC || WOL_DEFAULT_MAC,
    broadcast: env.HYDRA_WOL_BROADCAST || WOL_DEFAULT_BROADCAST,
    cooldownMs: num(env.HYDRA_WOL_COOLDOWN_MS, WOL_DEFAULT_COOLDOWN_MS),
    maxAttempts: num(env.HYDRA_WOL_MAX_ATTEMPTS, WOL_DEFAULT_MAX_ATTEMPTS),
  };
}

/** Why a wake attempt did / didn't happen — surfaced for logging + testing. */
export type WakeOutcome =
  | { attempted: false; reason: "disabled" | "cooldown" | "exhausted" }
  | { attempted: true; sent: WolSendResult };

/**
 * High-level orchestrator the IO layer calls when it observes the embed-backend
 * probe `failed`. Consults the gate (cooldown + max-attempts), and if allowed,
 * broadcasts the packet. NEVER throws — best-effort recovery side-effect.
 *
 * The caller passes the resolved `config`, the shared `gate` (so cooldown +
 * attempt state persists across heartbeats), and `now` (injectable clock). When
 * `config.enabled` is false this is an immediate `{attempted:false}` no-op, so a
 * cross-subnet / disabled deployment never sends.
 */
export async function attemptEmbedBackendWake(
  config: WolConfig,
  gate: WakeGate,
  now: number = Date.now(),
  { send = sendMagicPacket }: { send?: typeof sendMagicPacket } = {},
): Promise<WakeOutcome> {
  return attemptHostWake(config, gate, now, "embed-backend", { send });
}

/**
 * Generic WoL wake orchestrator for a "this gaming-PC-hosted backend is down →
 * wake the box" trigger. Today the sole caller is `attemptEmbedBackendWake`
 * (probeEmbedBackend → `failed`); the parallel VLM-host trigger was retired at
 * the OpenViking VLM cutover (issue #3544), when the VLM backend moved off the
 * gaming-PC Ollama host onto the in-repo claude-cli shim (#3542), so nothing
 * depends on that host any more. The generic `reason`-labelled shape is kept so
 * a future gaming-PC-hosted backend can re-use it.
 *
 * NEVER throws — every failure path inside `send` / `sendMagicPacket` already
 * folds to a result object + fail-loud console.error. `reason` is a short label
 * (`"embed-backend"`) folded into the success log so the operator can tell which
 * down-signal triggered the wake.
 */
async function attemptHostWake(
  config: WolConfig,
  gate: WakeGate,
  now: number = Date.now(),
  reason = "host",
  { send = sendMagicPacket }: { send?: typeof sendMagicPacket } = {},
): Promise<WakeOutcome> {
  if (!config.enabled) return { attempted: false, reason: "disabled" };
  if (gate.exhausted) return { attempted: false, reason: "exhausted" };
  if (!gate.shouldSend(now)) return { attempted: false, reason: "cooldown" };
  gate.recordSend(now);
  const sent = await send(config.mac, config.broadcast);
  if (sent.ok) {
    console.error(
      `[wol] ${reason} down — broadcast magic packet to ${config.broadcast} (MAC ${config.mac}); ` +
        `attempt ${gate.attemptCount}/${config.maxAttempts}`,
    );
  }
  return { attempted: true, sent };
}

// ---- Probe-failure wake trigger — "did this probe fail? → fire a WoL wake" ---
//
// `maybeWakeEmbedBackend` is the RECOVERY-POLICY half of the WoL subsystem: it
// maps the embed-backend `ServiceProbeResult` to a wake decision and fires
// `attemptEmbedBackendWake` through the gate. It lives HERE (issue #2834)
// alongside the rest of the wake policy (`attempt*Wake`, `WakeGate`) so ALL WoL
// trigger decisions — WHEN to wake — concentrate in one module (HOW to send is
// the src/health/wol-send.ts mechanism leaf, #3345). The fan-out
// (src/health/fan-out.ts) imports it and calls it from its embed-backend probe
// step. The parallel VLM-host wake trigger (`maybeWakeVlmHost`) was retired at
// the VLM cutover (issue #3544).

/**
 * If the embed-backend probe reported `failed`, fire a best-effort WoL wake
 * (respecting the module-level cooldown + max-attempt gate) and return the
 * ORIGINAL probe result immediately. The wake is a fire-and-return side-effect:
 * we never `sleep` + re-probe on the request path, so `GET /health/deep` is
 * never blocked waiting for the box to POST (#2228 QA blocker — the old inline
 * 45s reprobe wedged the fan-out for ~45s on every wake attempt). Recovery is
 * observed by the NEXT scheduled health tick, which is sufficient: the magic
 * packet has already been broadcast, and a powered-on box answers the next probe.
 *
 * Returning `initial` on a failed read means the existing #2131 alert still
 * fires for THIS tick (the backend is, after all, still down at probe time) —
 * that's the correct behavior; the wake is a recovery attempt for the NEXT tick,
 * not a same-request heal. A healthy read resets the gate so the next outage
 * starts fresh.
 *
 * NEVER throws — every failure path inside `attemptEmbedBackendWake` /
 * `sendMagicPacket` already folds to a result object + fail-loud console.error.
 *
 * Injectable `config`, `gate`, and `wake` keep this unit-testable without a real
 * socket, clock, or network — and there is no clock/sleep to inject anymore.
 */
export async function maybeWakeEmbedBackend(
  initial: ServiceProbeResult,
  {
    config = readWolConfig(),
    gate = getWolGates().embed,
    wake = attemptEmbedBackendWake,
  }: {
    config?: WolConfig;
    gate?: WakeGate;
    wake?: typeof attemptEmbedBackendWake;
  } = {},
): Promise<ServiceProbeResult> {
  if (initial.status !== "failed") {
    // Backend healthy → clear the attempt budget so a later outage re-arms.
    gate.reset();
    return initial;
  }
  // Fire the wake (best-effort, never-throwing) and return immediately. We do
  // NOT wait for the box to come up — the next scheduled health tick re-probes
  // and observes recovery. `outcome` is consumed only for the fail-loud logging
  // already done inside attemptEmbedBackendWake; nothing here blocks on it.
  await wake(config, gate);
  return initial;
}

// ---- WoL Adapter — owns the cross-request WakeGate singleton lifecycle (#2570) --
//
// WHY THIS ADAPTER EXISTS (the #2570 deepening)
//   The embed-backend WoL recovery (#2228) needs a single WakeGate whose cooldown
//   + max-attempt state persists ACROSS heartbeats/health-deep requests — the
//   fan-out runs once per request, so a per-call gate would let a down backend be
//   wake-spammed once per request. That singleton used to be a module-level
//   `new WakeGate(...)` instance in src/health/fan-out.ts, with its WoL-config
//   resolution (`readWolConfig()`) inlined at fan-out module load. That left
//   fan-out.ts holding mutable module-global state — the only health module that
//   did — so `collectProbeInputs` was NOT a pure function of its injected deps,
//   and the gate's retry budget bled across test cases (the test-isolation defect
//   the issue cites: a test had to reset the module-level singleton, which this
//   repo has no module-reset harness for).
//
//   This adapter relocates that singleton lifecycle out of the fan-out and into
//   the WoL module that already owns WakeGate. `getWolGates()` lazily constructs
//   the gate from `readWolConfig()` (cooldown + max-attempts resolved once at
//   first access from the environment — same conservative, auto-wake-OFF
//   posture), memoizes it, and hands the SAME instance back on every call — so a
//   no-gate `collectProbeInputs` caller keeps ONE embed budget across requests
//   (cross-request persistence invariant).
//
//   `resetWolGates()` clears the memo so a test gets a fresh, resettable gate
//   without a module-reset harness — closing the test-isolation defect. The
//   pure / never-throw IO split above is UNTOUCHED: this adapter only encapsulates
//   the singleton lifecycle; it moves no pure logic and sends no packet.
//
//   Issue #3544: the parallel VLM-host wake gate (#2335) was retired with the
//   VLM cutover — the gaming-PC VLM host is no longer used by OpenViking — so this
//   adapter now owns a single embed-backend gate.

/** The cross-request WoL gate(s): one budget per physical down-signal. */
export interface WolGates {
  /** Embed-backend wake budget (#2228) — consumed by `probeEmbedBackend` failures. */
  embed: WakeGate;
}

let wolGates: WolGates | null = null;

/**
 * The process-lifetime WoL gate (issue #2570).
 *
 * Lazily constructs (on first call) ONE embed gate from `readWolConfig()` — the
 * same cooldown + max-attempt values the fan-out used to resolve inline at module
 * load — then memoizes and returns the SAME instance on every subsequent call.
 * This is the cross-request persistence the WoL recovery needs: a no-gate
 * `collectProbeInputs` caller shares ONE budget across heartbeats, so a down
 * backend can't be wake-spammed once per request.
 *
 * Pure with respect to I/O — it touches no socket and no clock; it only
 * constructs the policy object.
 */
export function getWolGates(): WolGates {
  if (wolGates === null) {
    const config = readWolConfig();
    wolGates = {
      embed: new WakeGate(config.cooldownMs, config.maxAttempts),
    };
  }
  return wolGates;
}

/**
 * Drop the memoized WoL gate so the NEXT {@link getWolGates} call rebuilds a
 * fresh, zero-attempt gate from the current environment (issue #2570).
 *
 * Exists for test isolation: a test that exercises gate exhaustion or
 * cross-request leakage through the default (no-gate) `collectProbeInputs` path
 * can call this in a `beforeEach`/`afterEach` to guarantee the retry budget does
 * not bleed across cases — the defect the issue cites, previously impossible to
 * clear because the gate was a module-level constant in fan-out.ts and this repo
 * has no module-reset harness. Production never calls this.
 */
export function resetWolGates(): void {
  wolGates = null;
}
