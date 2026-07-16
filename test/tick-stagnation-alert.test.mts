/**
 * tick-stagnation-alert seam tests (issue #3371).
 *
 * Exercises `emitTickStagnationAlerts` — the per-tick builder-health stagnation
 * emit lifted OUT of the Observability Heartbeat (`src/scheduler/heartbeat.ts`)
 * so the liveness state machine stops carrying the two-domain import chain
 * (builder-health aggregator + notification bus) and the process-lifetime
 * edge-state store. Each case constructs the free function with a scorecard stub
 * + a bus stub + an injected store — no `HeartbeatController`, no Redis, no
 * GitHub. Mirrors the `status-projection.ts` extraction test axis (#2974).
 *
 * The edge-trigger semantics themselves are unit-covered in
 * `test/builder-health.test.mts` / the notification suite; this suite covers the
 * EXTRACTED module's contract: it wires the scorecard reader + store into
 * `emitStagnationAlerts`, is fire-and-forget never-throws, and no-ops on a bus
 * without `publish`. It is its own top-level `describe` (stub-only, no shared
 * Redis teardown to piggyback on), per the repo authoring rule.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { emitTickStagnationAlerts } from "../src/scheduler/tick-stagnation-alert.ts";
import { createInMemoryStagnationStore } from "../src/notification/stagnation-alerts.ts";

// A minimal bus that records every published envelope so a test can assert
// whether (and how often) the emit fired.
function makeSpyBus() {
  const published: any[] = [];
  return {
    published,
    publish: async (_stream: string, event: any) => {
      published.push(event);
    },
  };
}

// Build a scorecard whose stagnation panel puts ONE (signal, realm) block into
// the given verdict state, everything else absent. `null` = a dark block.
function scorecardWith(state: "ok" | "warming" | "breach") {
  return {
    stagnation: {
      signals: {
        mergeRate: {
          orch: {
            state,
            current: state === "breach" ? 1 : 10,
            baseline: 10,
            sustainedCycles: state === "breach" ? 4 : 0,
          },
          target: null,
        },
      },
    },
  } as any;
}

describe("emitTickStagnationAlerts — extracted tick side-effect", () => {
  it("fires exactly once on the transition INTO breach", async () => {
    const bus = makeSpyBus();
    const store = createInMemoryStagnationStore();
    await emitTickStagnationAlerts(bus, {
      getBuilderHealthScorecard: async () => scorecardWith("breach"),
      store,
    });
    assert.equal(bus.published.length, 1, "one alert fires on the edge into breach");
    assert.equal(bus.published[0].type, "builder-health.stagnation");
    assert.equal(bus.published[0].payload.signal, "mergeRate");
    assert.equal(bus.published[0].payload.realm, "orch");
  });

  it("suppresses a repeat while the signal stays breached (edge-triggered, store shared across ticks)", async () => {
    const bus = makeSpyBus();
    const store = createInMemoryStagnationStore();
    const deps = {
      getBuilderHealthScorecard: async () => scorecardWith("breach"),
      store,
    };
    await emitTickStagnationAlerts(bus, deps); // tick 1 — fires
    await emitTickStagnationAlerts(bus, deps); // tick 2 — still breached, suppressed
    assert.equal(bus.published.length, 1, "no re-fire while continuously breached");
  });

  it("re-arms after the signal leaves breach, so a later re-breach fires again", async () => {
    const bus = makeSpyBus();
    const store = createInMemoryStagnationStore();
    let state: "ok" | "warming" | "breach" = "breach";
    const deps = {
      getBuilderHealthScorecard: async () => scorecardWith(state),
      store,
    };
    await emitTickStagnationAlerts(bus, deps); // fires
    state = "ok";
    await emitTickStagnationAlerts(bus, deps); // leaves breach, re-arms, no fire
    state = "breach";
    await emitTickStagnationAlerts(bus, deps); // re-breach fires again
    assert.equal(bus.published.length, 2, "re-breach after leaving breach fires a second alert");
  });

  it("never fires on a warming (cold-start) signal", async () => {
    const bus = makeSpyBus();
    await emitTickStagnationAlerts(bus, {
      getBuilderHealthScorecard: async () => scorecardWith("warming"),
      store: createInMemoryStagnationStore(),
    });
    assert.equal(bus.published.length, 0, "warming is suppressed");
  });

  it("never throws when the scorecard read rejects (fire-and-forget contract)", async () => {
    const bus = makeSpyBus();
    await assert.doesNotReject(
      emitTickStagnationAlerts(bus, {
        getBuilderHealthScorecard: async () => {
          throw new Error("redis + github fan-out wedged");
        },
        store: createInMemoryStagnationStore(),
      }),
    );
    assert.equal(bus.published.length, 0, "a failed scorecard read publishes nothing");
  });

  it("is a silent no-op on a bus without a publish method (bus not yet wired) — scorecard is not even read", async () => {
    let read = false;
    await assert.doesNotReject(
      emitTickStagnationAlerts(
        {} as any,
        {
          getBuilderHealthScorecard: async () => {
            read = true;
            return scorecardWith("breach");
          },
          store: createInMemoryStagnationStore(),
        },
      ),
    );
    assert.equal(read, false, "a bus without publish short-circuits before the scorecard read");
  });

  it("is a silent no-op on a null/undefined bus", async () => {
    await assert.doesNotReject(emitTickStagnationAlerts(null));
    await assert.doesNotReject(emitTickStagnationAlerts(undefined));
  });
});
