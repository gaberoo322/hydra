/**
 * Wake-on-LAN auto-recovery tests (issue #2228).
 *
 * Covers the four acceptance criteria with NO live network:
 *  1. The magic-packet builder emits a correct 102-byte packet (6×0xFF sync +
 *     16× MAC) and rejects a bad MAC.
 *  2/4. The high-level orchestrator (attemptEmbedBackendWake) sends through an
 *     injected `send`, and disabled/exhausted/send-error cases are a no-op that
 *     never throws.
 *  3. The pure cooldown + max-attempt timing policy (WakeGate) is asserted with
 *     a passed-in clock — no fake timers, no sockets.
 *  Plus the fan-out integration (maybeWakeEmbedBackend) re-probes before the
 *  existing #2131 alert and resets the gate when the backend recovers.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  buildMagicPacket,
  parseMac,
  WakeGate,
  sendMagicPacket,
  readWolConfig,
  attemptEmbedBackendWake,
  WOL_DEFAULT_MAC,
  WOL_DEFAULT_BROADCAST,
  WOL_PORTS,
  type WolConfig,
} from "../src/health/wol.ts";
import { maybeWakeEmbedBackend } from "../src/health/fan-out.ts";

describe("buildMagicPacket — packet layout (criterion 1)", () => {
  test("emits exactly 102 bytes: 6×0xFF sync header + 16× the MAC", () => {
    const packet = buildMagicPacket("d8:bb:c1:70:62:76");
    assert.ok(packet, "expected a Buffer for a valid MAC");
    assert.equal(packet!.length, 102);
    // First 6 bytes are the 0xFF synchronization stream.
    for (let i = 0; i < 6; i++) assert.equal(packet![i], 0xff);
    // The next 96 bytes are the 6-byte MAC repeated 16 times.
    const mac = [0xd8, 0xbb, 0xc1, 0x70, 0x62, 0x76];
    for (let rep = 0; rep < 16; rep++) {
      for (let i = 0; i < 6; i++) {
        assert.equal(packet![6 + rep * 6 + i], mac[i], `rep ${rep} octet ${i}`);
      }
    }
  });

  test("accepts dash-separated and mixed-case MACs", () => {
    const a = buildMagicPacket("D8-BB-C1-70-62-76");
    const b = buildMagicPacket("d8:bb:c1:70:62:76");
    assert.ok(a && b);
    assert.deepEqual([...a!], [...b!]);
  });

  test("rejects a bad MAC (returns null, never throws)", () => {
    assert.equal(buildMagicPacket("not-a-mac"), null);
    assert.equal(buildMagicPacket("d8:bb:c1:70:62"), null); // 5 octets
    assert.equal(buildMagicPacket("d8:bb:c1:70:62:76:99"), null); // 7 octets
    assert.equal(buildMagicPacket("zz:bb:c1:70:62:76"), null); // non-hex
    assert.equal(buildMagicPacket(""), null);
    assert.equal(parseMac("d8:bb:c1:70:62:76")?.length, 6);
    assert.equal(parseMac("garbage"), null);
  });
});

describe("WakeGate — pure cooldown + max-attempt policy (criterion 3)", () => {
  test("first send is allowed; within cooldown is blocked", () => {
    const gate = new WakeGate(1000, 3);
    assert.equal(gate.shouldSend(0), true);
    gate.recordSend(0);
    assert.equal(gate.shouldSend(500), false, "within cooldown → blocked");
    assert.equal(gate.shouldSend(1000), true, "cooldown elapsed → allowed");
  });

  test("stops after max attempts (exhausted) so the alert can fire", () => {
    const gate = new WakeGate(0, 2); // zero cooldown isolates the attempt cap
    assert.equal(gate.shouldSend(0), true);
    gate.recordSend(0);
    assert.equal(gate.shouldSend(0), true);
    gate.recordSend(0);
    assert.equal(gate.exhausted, true);
    assert.equal(gate.shouldSend(0), false, "attempt cap reached → no more sends");
    assert.equal(gate.attemptCount, 2);
  });

  test("reset() re-arms the budget after recovery", () => {
    const gate = new WakeGate(1000, 1);
    gate.recordSend(0);
    assert.equal(gate.exhausted, true);
    gate.reset();
    assert.equal(gate.exhausted, false);
    assert.equal(gate.shouldSend(0), true);
    assert.equal(gate.attemptCount, 0);
  });
});

describe("readWolConfig — env overrides with #1794 defaults", () => {
  test("conservative default: disabled, gaming-PC MAC + broadcast", () => {
    const cfg = readWolConfig({});
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.mac, WOL_DEFAULT_MAC);
    assert.equal(cfg.broadcast, WOL_DEFAULT_BROADCAST);
    assert.ok(cfg.cooldownMs > 0 && cfg.maxAttempts > 0);
  });

  test("env vars override every field", () => {
    const cfg = readWolConfig({
      HYDRA_WOL_ENABLED: "true",
      HYDRA_WOL_MAC: "aa:bb:cc:dd:ee:ff",
      HYDRA_WOL_BROADCAST: "192.168.1.255",
      HYDRA_WOL_COOLDOWN_MS: "1000",
      HYDRA_WOL_MAX_ATTEMPTS: "5",
    } as NodeJS.ProcessEnv);
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.mac, "aa:bb:cc:dd:ee:ff");
    assert.equal(cfg.broadcast, "192.168.1.255");
    assert.equal(cfg.cooldownMs, 1000);
    assert.equal(cfg.maxAttempts, 5);
  });

  test("HYDRA_WOL_ENABLED accepts 1 as well as true", () => {
    assert.equal(readWolConfig({ HYDRA_WOL_ENABLED: "1" } as NodeJS.ProcessEnv).enabled, true);
    assert.equal(readWolConfig({ HYDRA_WOL_ENABLED: "no" } as NodeJS.ProcessEnv).enabled, false);
  });

  test("bad numeric env falls back to the default (never NaN/<=0)", () => {
    const cfg = readWolConfig({ HYDRA_WOL_COOLDOWN_MS: "-5", HYDRA_WOL_MAX_ATTEMPTS: "abc" } as NodeJS.ProcessEnv);
    assert.ok(cfg.cooldownMs > 0);
    assert.ok(cfg.maxAttempts > 0);
  });
});

const enabledConfig = (over: Partial<WolConfig> = {}): WolConfig => ({
  enabled: true,
  mac: WOL_DEFAULT_MAC,
  broadcast: WOL_DEFAULT_BROADCAST,
  cooldownMs: 1000,
  maxAttempts: 3,
  ...over,
});

describe("attemptEmbedBackendWake — orchestrator (criteria 2 + 4)", () => {
  test("disabled config → no-op, never sends", async () => {
    let sent = false;
    const out = await attemptEmbedBackendWake(enabledConfig({ enabled: false }), new WakeGate(0, 3), 0, {
      send: async () => {
        sent = true;
        return { ok: true, bytesPerPort: 102, ports: [...WOL_PORTS] };
      },
    });
    assert.deepEqual(out, { attempted: false, reason: "disabled" });
    assert.equal(sent, false);
  });

  test("enabled + allowed → sends via injected send", async () => {
    const gate = new WakeGate(1000, 3);
    let calledWith: [string, string] | null = null;
    const out = await attemptEmbedBackendWake(enabledConfig(), gate, 0, {
      send: async (mac, broadcast) => {
        calledWith = [mac, broadcast];
        return { ok: true, bytesPerPort: 102, ports: [...WOL_PORTS] };
      },
    });
    assert.equal(out.attempted, true);
    assert.deepEqual(calledWith, [WOL_DEFAULT_MAC, WOL_DEFAULT_BROADCAST]);
    assert.equal(gate.attemptCount, 1);
  });

  test("cooldown blocks a second immediate send", async () => {
    const gate = new WakeGate(1000, 3);
    const send = async () => ({ ok: true as const, bytesPerPort: 102, ports: [...WOL_PORTS] });
    await attemptEmbedBackendWake(enabledConfig(), gate, 0, { send });
    const second = await attemptEmbedBackendWake(enabledConfig(), gate, 500, { send });
    assert.deepEqual(second, { attempted: false, reason: "cooldown" });
  });

  test("after max attempts → exhausted no-op (alert path)", async () => {
    const gate = new WakeGate(0, 1);
    const send = async () => ({ ok: true as const, bytesPerPort: 102, ports: [...WOL_PORTS] });
    await attemptEmbedBackendWake(enabledConfig({ maxAttempts: 1 }), gate, 0, { send });
    const second = await attemptEmbedBackendWake(enabledConfig({ maxAttempts: 1 }), gate, 0, { send });
    assert.deepEqual(second, { attempted: false, reason: "exhausted" });
  });

  test("send error is surfaced as attempted-but-not-ok, never throws", async () => {
    const out = await attemptEmbedBackendWake(enabledConfig(), new WakeGate(0, 3), 0, {
      send: async () => ({ ok: false, reason: "send-error", error: "ENETUNREACH" }),
    });
    assert.equal(out.attempted, true);
    assert.equal((out as any).sent.ok, false);
  });
});

describe("sendMagicPacket — IO fold, never throws (criterion 4)", () => {
  test("invalid MAC → {ok:false, reason:'invalid-mac'} without a socket", async () => {
    let socketMade = false;
    const r = await sendMagicPacket("garbage", "10.0.0.255", {
      socketFactory: (() => {
        socketMade = true;
        return {} as any;
      }) as any,
    });
    assert.deepEqual(r, { ok: false, reason: "invalid-mac" });
    assert.equal(socketMade, false, "must reject before opening a socket");
  });

  test("socket-factory throw folds to send-error (no exception escapes)", async () => {
    const r = await sendMagicPacket(WOL_DEFAULT_MAC, "10.0.0.255", {
      socketFactory: (() => {
        throw new Error("boom");
      }) as any,
    });
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "send-error");
  });

  test("emitted socket 'error' event folds to send-error", async () => {
    // Minimal fake dgram socket that emits an error on bind.
    const fake = {
      handlers: {} as Record<string, (...a: any[]) => void>,
      once(ev: string, fn: (...a: any[]) => void) {
        this.handlers[ev] = fn;
        return this;
      },
      bind(_cb?: () => void) {
        // Fire the error path instead of the bind callback.
        this.handlers["error"]?.(new Error("EACCES"));
      },
      setBroadcast() {},
      send() {},
      close() {},
    };
    const r = await sendMagicPacket(WOL_DEFAULT_MAC, "10.0.0.255", {
      socketFactory: (() => fake) as any,
    });
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "send-error");
  });
});

describe("maybeWakeEmbedBackend — fan-out integration (criterion 2)", () => {
  const failed = { status: "failed" as const, latencyMs: null };
  const running = { status: "running" as const, latencyMs: 7 };

  test("healthy probe → returns it unchanged and resets the gate", async () => {
    const gate = new WakeGate(1000, 3);
    gate.recordSend(0); // pretend a prior attempt happened
    const out = await maybeWakeEmbedBackend(running, async () => running, {
      config: enabledConfig(),
      gate,
    });
    assert.equal(out.status, "running");
    assert.equal(gate.attemptCount, 0, "healthy read re-arms the budget");
  });

  test("failed probe + enabled → wakes, re-probes, reports recovered (no alert)", async () => {
    const gate = new WakeGate(0, 3);
    let woke = false;
    let reprobes = 0;
    const out = await maybeWakeEmbedBackend(
      failed,
      // re-probe now reports healthy after the wake
      (async () => {
        reprobes++;
        return running;
      }) as any,
      {
        config: enabledConfig(),
        gate,
        wake: async () => {
          woke = true;
          return { attempted: true, sent: { ok: true, bytesPerPort: 102, ports: [...WOL_PORTS] } };
        },
        sleep: async () => {},
      },
    );
    assert.equal(woke, true);
    assert.equal(reprobes, 1, "re-probes exactly once after the wake");
    assert.equal(out.status, "running", "recovered → reported running, no #2131 alert");
  });

  test("failed probe + wake sent but still down → original failure stands (alert fires)", async () => {
    const out = await maybeWakeEmbedBackend(failed, (async () => failed) as any, {
      config: enabledConfig(),
      gate: new WakeGate(0, 3),
      wake: async () => ({ attempted: true, sent: { ok: true, bytesPerPort: 102, ports: [...WOL_PORTS] } }),
      sleep: async () => {},
    });
    assert.equal(out.status, "failed", "still down → failure surfaces for the alert");
  });

  test("disabled → returns the original failure, does not re-probe", async () => {
    let reprobed = false;
    const out = await maybeWakeEmbedBackend(
      failed,
      (async () => {
        reprobed = true;
        return running;
      }) as any,
      {
        config: enabledConfig({ enabled: false }),
        gate: new WakeGate(0, 3),
        wake: async () => ({ attempted: false, reason: "disabled" }),
        sleep: async () => {},
      },
    );
    assert.equal(out.status, "failed");
    assert.equal(reprobed, false, "no re-probe when wake didn't happen");
  });

  test("send-error (cross-subnet) → original failure, no re-probe", async () => {
    let reprobed = false;
    const out = await maybeWakeEmbedBackend(
      failed,
      (async () => {
        reprobed = true;
        return running;
      }) as any,
      {
        config: enabledConfig(),
        gate: new WakeGate(0, 3),
        wake: async () => ({ attempted: true, sent: { ok: false, reason: "send-error", error: "ENETUNREACH" } }),
        sleep: async () => {},
      },
    );
    assert.equal(out.status, "failed");
    assert.equal(reprobed, false);
  });
});
