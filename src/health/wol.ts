// Wake-on-LAN auto-recovery for the OpenViking dense-embedding / VLM backend
// (issue #2228 — the stretch goal of #1794).
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
// THE PURE / IO SPLIT (kept intact — see issue #2228 design)
//   - `buildMagicPacket(mac)` is a PURE function: it validates the MAC and
//     returns the canonical 102-byte WoL packet (6×0xFF sync header + 16× the
//     6-byte MAC). No network. Unit-tested directly.
//   - `WakeGate` is a PURE timing policy: cooldown (at most one send per N ms)
//     plus a max-attempt cap (after K failed wakes, stop and let the existing
//     #2131 alert page the operator). No clock import — `now` is passed in, so
//     the guardrails are deterministically unit-testable.
//   - `sendMagicPacket()` / `attemptEmbedBackendWake()` are the IO side. They
//     NEVER throw (CLAUDE.md: never throw from the health/verification path);
//     every failure folds to a result object and a fail-loud `console.error`.
//
// `assessHealth()` stays pure and is untouched — it never sends a packet. The
// send is wired into the fan-out's embed-backend probe step (the IO layer that
// already runs probeEmbedBackend), and only fires when that probe reports
// `failed`.
import { createSocket } from "node:dgram";

/** A 6-octet MAC, lowercased and `:`-separated (the canonical form we emit). */
const MAC_OCTET_COUNT = 6;
/** WoL magic-packet layout: 6 sync bytes + 16 repetitions of the 6-byte MAC. */
const MAGIC_PACKET_BYTES = 6 + 16 * MAC_OCTET_COUNT; // 102
/** The two ports a WoL packet is conventionally broadcast to. */
export const WOL_PORTS = [9, 7] as const;

/** Default config — the #1794-verified gaming-PC values. Overridable via env. */
export const WOL_DEFAULT_MAC = "d8:bb:c1:70:62:76";
export const WOL_DEFAULT_BROADCAST = "10.0.0.255";
/** Conservative default: at most one wake every 5 minutes. */
const WOL_DEFAULT_COOLDOWN_MS = 5 * 60_000;
/** After this many consecutive failed wakes, stop and fall through to the alert. */
const WOL_DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Parse a MAC address into its 6 raw octets.
 *
 * Accepts `:` or `-` separators, case-insensitive (e.g. `d8:bb:c1:70:62:76` or
 * `D8-BB-C1-70-62-76`). Returns `null` for anything that is not exactly six
 * two-hex-digit octets — the caller treats `null` as "reject this MAC" rather
 * than throwing, so a misconfigured env var is a logged no-op, never a crash.
 */
export function parseMac(mac: string): number[] | null {
  if (typeof mac !== "string") return null;
  const parts = mac.trim().split(/[:-]/);
  if (parts.length !== MAC_OCTET_COUNT) return null;
  const octets: number[] = [];
  for (const p of parts) {
    if (!/^[0-9a-fA-F]{2}$/.test(p)) return null;
    octets.push(parseInt(p, 16));
  }
  return octets;
}

/**
 * Build the canonical Wake-on-LAN magic packet for `mac`.
 *
 * PURE. The packet is `6×0xFF` (the sync stream) followed by the target MAC
 * repeated 16 times — exactly 102 bytes. Returns `null` for an invalid MAC
 * (the caller logs + no-ops) so this never throws on bad config.
 */
export function buildMagicPacket(mac: string): Buffer | null {
  const octets = parseMac(mac);
  if (!octets) return null;
  const packet = Buffer.alloc(MAGIC_PACKET_BYTES);
  // 6-byte 0xFF synchronization stream.
  packet.fill(0xff, 0, MAC_OCTET_COUNT);
  // 16 repetitions of the MAC.
  for (let rep = 0; rep < 16; rep++) {
    for (let i = 0; i < MAC_OCTET_COUNT; i++) {
      packet[MAC_OCTET_COUNT + rep * MAC_OCTET_COUNT + i] = octets[i];
    }
  }
  return packet;
}

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

/** Outcome of a single magic-packet broadcast — never an exception. */
export type WolSendResult =
  | { ok: true; bytesPerPort: number; ports: number[] }
  | { ok: false; reason: "invalid-mac" | "send-error"; error?: string };

/**
 * Broadcast a WoL magic packet to `broadcast` on {@link WOL_PORTS}.
 *
 * NEVER throws. A bad MAC folds to `{ok:false, reason:"invalid-mac"}`; any
 * socket / send error (e.g. the service is on a different subnet so the L2
 * broadcast can't reach the NIC, or `EACCES` binding broadcast) folds to
 * `{ok:false, reason:"send-error"}` after a fail-loud `console.error`. The
 * heartbeat keeps running either way.
 *
 * `socketFactory` is injectable so the unit test can drive the send/error paths
 * without opening a real UDP socket.
 */
export async function sendMagicPacket(
  mac: string,
  broadcast: string,
  { socketFactory = createSocket }: { socketFactory?: typeof createSocket } = {},
): Promise<WolSendResult> {
  const packet = buildMagicPacket(mac);
  if (!packet) {
    console.error(`[wol] refusing to send: invalid MAC ${JSON.stringify(mac)}`);
    return { ok: false, reason: "invalid-mac" };
  }
  return new Promise<WolSendResult>((resolve) => {
    let settled = false;
    const done = (r: WolSendResult) => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        /* intentional: socket may already be closed; closing is best-effort cleanup */
      }
      resolve(r);
    };
    let socket: ReturnType<typeof createSocket>;
    try {
      socket = socketFactory("udp4");
    } catch (err) {
      console.error(`[wol] failed to create UDP socket: ${(err as Error)?.message}`);
      return resolve({ ok: false, reason: "send-error", error: (err as Error)?.message });
    }
    socket.once("error", (err) => {
      console.error(`[wol] socket error broadcasting to ${broadcast}: ${err?.message}`);
      done({ ok: false, reason: "send-error", error: err?.message });
    });
    socket.bind(() => {
      try {
        socket.setBroadcast(true);
      } catch (err) {
        console.error(`[wol] setBroadcast failed: ${(err as Error)?.message}`);
        return done({ ok: false, reason: "send-error", error: (err as Error)?.message });
      }
      let remaining = WOL_PORTS.length;
      let sendErr: string | undefined;
      for (const port of WOL_PORTS) {
        socket.send(packet, 0, packet.length, port, broadcast, (err) => {
          if (err && !sendErr) {
            sendErr = err.message;
            console.error(`[wol] send to ${broadcast}:${port} failed: ${err.message}`);
          }
          if (--remaining === 0) {
            if (sendErr) done({ ok: false, reason: "send-error", error: sendErr });
            else done({ ok: true, bytesPerPort: packet.length, ports: [...WOL_PORTS] });
          }
        });
      }
    });
  });
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
  if (!config.enabled) return { attempted: false, reason: "disabled" };
  if (gate.exhausted) return { attempted: false, reason: "exhausted" };
  if (!gate.shouldSend(now)) return { attempted: false, reason: "cooldown" };
  gate.recordSend(now);
  const sent = await send(config.mac, config.broadcast);
  if (sent.ok) {
    console.error(
      `[wol] embed-backend down — broadcast magic packet to ${config.broadcast} (MAC ${config.mac}); ` +
        `attempt ${gate.attemptCount}/${config.maxAttempts}`,
    );
  }
  return { attempted: true, sent };
}
