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
 *  Plus the fan-out integration (maybeWakeEmbedBackend) fires the wake
 *  best-effort and returns the current probe result WITHOUT blocking the
 *  /health/deep path on a re-probe (#2228 QA fix), resetting the gate when the
 *  backend reads healthy.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// Mechanism symbols (packet build + UDP send) live in the wol-send.ts leaf
// (issue #3345); policy symbols (gate, config, wake triggers) stay in wol.ts.
import {
  buildMagicPacket,
  parseMac,
  sendMagicPacket,
  WOL_DEFAULT_MAC,
  WOL_DEFAULT_BROADCAST,
  WOL_PORTS,
} from "../src/health/wol-send.ts";
import {
  WakeGate,
  readWolConfig,
  attemptEmbedBackendWake,
  maybeWakeEmbedBackend,
  getWolGates,
  resetWolGates,
  type WolConfig,
} from "../src/health/wol.ts";

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

  // #2228 QA fix: maybeWakeEmbedBackend is now FIRE-AND-RETURN. On a failed
  // probe it fires the WoL wake (best-effort) and returns the CURRENT probe
  // result immediately — it never sleeps + re-probes on the request path (that
  // inline 45s reprobe wedged GET /health/deep). Recovery is observed by the
  // next scheduled health tick, so these tests assert the wake fires and the
  // ORIGINAL result is returned synchronously, with no re-probe call.

  test("healthy probe → returns it unchanged and resets the gate", async () => {
    const gate = new WakeGate(1000, 3);
    gate.recordSend(0); // pretend a prior attempt happened
    const out = await maybeWakeEmbedBackend(running, {
      config: enabledConfig(),
      gate,
    });
    assert.equal(out.status, "running");
    assert.equal(gate.attemptCount, 0, "healthy read re-arms the budget");
  });

  test("failed probe + enabled → fires the wake and returns the failure (next tick re-probes)", async () => {
    const gate = new WakeGate(0, 3);
    let woke = false;
    const out = await maybeWakeEmbedBackend(failed, {
      config: enabledConfig(),
      gate,
      wake: async () => {
        woke = true;
        return { attempted: true, sent: { ok: true, bytesPerPort: 102, ports: [...WOL_PORTS] } };
      },
    });
    assert.equal(woke, true, "wake fired best-effort");
    assert.equal(out.status, "failed", "returns the current failure — no inline re-probe blocks the path");
  });

  test("failed probe + wake sent → original failure stands this tick (alert fires; recovery is next-tick)", async () => {
    const out = await maybeWakeEmbedBackend(failed, {
      config: enabledConfig(),
      gate: new WakeGate(0, 3),
      wake: async () => ({ attempted: true, sent: { ok: true, bytesPerPort: 102, ports: [...WOL_PORTS] } }),
    });
    assert.equal(out.status, "failed", "still down at probe time → failure surfaces for the alert");
  });

  test("disabled → fires the no-op wake and returns the original failure", async () => {
    let woke = false;
    const out = await maybeWakeEmbedBackend(failed, {
      config: enabledConfig({ enabled: false }),
      gate: new WakeGate(0, 3),
      wake: async () => {
        woke = true;
        return { attempted: false, reason: "disabled" };
      },
    });
    assert.equal(out.status, "failed");
    assert.equal(woke, true, "wake is still consulted (it self-noops when disabled)");
  });

  test("send-error (cross-subnet) → original failure returned synchronously", async () => {
    const out = await maybeWakeEmbedBackend(failed, {
      config: enabledConfig(),
      gate: new WakeGate(0, 3),
      wake: async () => ({ attempted: true, sent: { ok: false, reason: "send-error", error: "ENETUNREACH" } }),
    });
    assert.equal(out.status, "failed");
  });
});

// Issue #3544: the VLM-host wake trigger (`attemptVlmHostWake` / `maybeWakeVlmHost`,
// issue #2335) and their describe blocks were removed with the probe at the
// OpenViking VLM cutover — OpenViking's VLM backend moved off the gaming-PC Ollama
// host onto the in-repo claude-cli shim (#3542), so nothing depends on that host.
// The embed-backend wake path (asserted above) is unchanged.

// Issue #2570: the WoL Adapter that owns the process-lifetime WakeGate singleton.
// Before #2570 the embed gate was a module-level `new WakeGate(...)` constant in
// src/health/fan-out.ts, which left the fan-out holding mutable module-global state
// and bled the retry budget across test cases (no module-reset harness could clear
// it). getWolGates() relocates that lifecycle here: lazily-constructed, memoized;
// resetWolGates() clears the memo so a test gets a fresh gate. Each case resets in a
// beforeEach so the singleton state never leaks across cases (the very isolation the
// adapter exists to provide). (Issue #3544: the parallel vlm gate was retired with
// the VLM cutover, so the adapter now owns a single embed gate.)
describe("WoL Adapter — getWolGates()/resetWolGates() singleton lifecycle (issue #2570)", () => {
  // resetWolGates is a per-case isolation reset (NOT a once-per-suite before) so
  // a gate budget consumed by one case never bleeds into the next.
  beforeEach(() => resetWolGates());
  afterEach(() => resetWolGates());

  test("returns the SAME memoized gate across calls (cross-request persistence)", () => {
    const a = getWolGates();
    const b = getWolGates();
    assert.strictEqual(a.embed, b.embed, "embed gate is the same instance across calls");
  });

  test("the embed gate starts with a zero attempt budget", () => {
    const gates = getWolGates();
    assert.equal(gates.embed.attemptCount, 0);
    assert.equal(gates.embed.exhausted, false);
  });

  test("resetWolGates() rebuilds a fresh, zero-budget gate (test-isolation defect fixed)", () => {
    const first = getWolGates();
    first.embed.recordSend(0);
    assert.equal(first.embed.attemptCount, 1);

    resetWolGates();
    const second = getWolGates();
    // A brand-new gate: different instance, zero budget — the retry budget did
    // NOT bleed across the reset (the module-singleton isolation defect #2570 cites).
    assert.notStrictEqual(second.embed, first.embed);
    assert.equal(second.embed.attemptCount, 0);
  });

  test("the gates are seeded from readWolConfig() cooldown + max-attempts", () => {
    const PRIOR = {
      cd: process.env.HYDRA_WOL_COOLDOWN_MS,
      max: process.env.HYDRA_WOL_MAX_ATTEMPTS,
    };
    try {
      process.env.HYDRA_WOL_MAX_ATTEMPTS = "1";
      process.env.HYDRA_WOL_COOLDOWN_MS = "0";
      resetWolGates(); // force a rebuild that reads the env we just set
      const gates = getWolGates();
      // maxAttempts:1 → a single recordSend exhausts the budget; cooldown:0 → the
      // attempt cap (not the cooldown) is the gating constraint.
      assert.equal(gates.embed.shouldSend(0), true);
      gates.embed.recordSend(0);
      assert.equal(gates.embed.exhausted, true, "maxAttempts:1 from env exhausts after one send");
    } finally {
      if (PRIOR.cd === undefined) delete process.env.HYDRA_WOL_COOLDOWN_MS; else process.env.HYDRA_WOL_COOLDOWN_MS = PRIOR.cd;
      if (PRIOR.max === undefined) delete process.env.HYDRA_WOL_MAX_ATTEMPTS; else process.env.HYDRA_WOL_MAX_ATTEMPTS = PRIOR.max;
      resetWolGates();
    }
  });
});
