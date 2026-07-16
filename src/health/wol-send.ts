// Wake-on-LAN packet-send MECHANISM — the low-level UDP magic-packet leaf
// (issue #3345, extracted from src/health/wol.ts).
//
// WHY THIS FILE EXISTS
//   src/health/wol.ts used to house two structurally-independent concerns: the
//   pure UDP magic-packet builder/sender (this file) and the wake-trigger
//   POLICY (`WakeGate`, `readWolConfig`, the `attempt*`/`maybe*` wake
//   orchestrators — still in wol.ts). The coupling runs one way: the policy
//   imports `sendMagicPacket` from this leaf; this leaf has ZERO policy
//   knowledge — no `WakeGate`, no env reads, no probe-result types. Its only
//   dependency is `node:dgram`, so the packet-byte layout and the socket send
//   are testable by injecting a fake UDP socket, without loading the gate /
//   config / attempt stack.
//
// THE PURE / IO SPLIT (kept intact — see issue #2228 design)
//   - `buildMagicPacket(mac)` is a PURE function: it validates the MAC and
//     returns the canonical 102-byte WoL packet (6×0xFF sync header + 16× the
//     6-byte MAC). No network. Unit-tested directly.
//   - `sendMagicPacket()` is the IO side. It NEVER throws (CLAUDE.md: never
//     throw from the health/verification path); every failure folds to a
//     result object and a fail-loud `console.error`.
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
