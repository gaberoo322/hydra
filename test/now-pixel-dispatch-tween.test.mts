/**
 * test/now-pixel-dispatch-tween.test.mts — covers the pure dispatch-
 * tween logic used by the /now-pixel slice E component.
 *
 * Slice E of autopilot observability (#667, #670). The render-side
 * piece (useSpriteAnimations.fireTravel + DispatchTween) is a thin
 * shell around these pure functions, so node:test against the .ts
 * module is sufficient — the dashboard has no jsx test harness
 * (vitest is not on the dependency list; existing now-pixel tests
 * follow this same node:test-against-pure-ts pattern, e.g.
 * test/now-pixel-zone-derivation.test.mts).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DISPATCH_TWEEN_DURATION_MS,
  DISPATCH_TWEEN_DUST_DURATION_MS,
  shouldTweenFrame,
  tweenIdFor,
  tweenSpec,
} from "../dashboard/src/pages/now-pixel/derive-dispatch-tween.ts";

// ---------------------------------------------------------------------------
// shouldTweenFrame — predicate gating
// ---------------------------------------------------------------------------

test("shouldTweenFrame: null / undefined / non-object → null", () => {
  assert.equal(shouldTweenFrame(null), null);
  assert.equal(shouldTweenFrame(undefined), null);
  // @ts-expect-error — intentionally bad input
  assert.equal(shouldTweenFrame("not-a-frame"), null);
  // @ts-expect-error — intentionally bad input
  assert.equal(shouldTweenFrame(42), null);
});

test("shouldTweenFrame: missing payload → null", () => {
  assert.equal(shouldTweenFrame({}), null);
  assert.equal(shouldTweenFrame({ payload: null as any }), null);
});

test("shouldTweenFrame: non-dispatch_decision events → null", () => {
  assert.equal(
    shouldTweenFrame({ payload: { event: "turn_start", turn_n: 1 } }),
    null,
  );
  assert.equal(
    shouldTweenFrame({ payload: { event: "turn_end", turn_n: 1 } }),
    null,
  );
  assert.equal(
    shouldTweenFrame({
      payload: { event: "subagent_stop", status: "success" },
    }),
    null,
  );
  assert.equal(
    shouldTweenFrame({
      payload: { event: "slot_waiting_permission" },
    }),
    null,
  );
});

test("shouldTweenFrame: dispatch_decision but outcome != dispatched → null", () => {
  for (const outcome of ["cooldown", "budget", "idle", "", "weird"]) {
    assert.equal(
      shouldTweenFrame({
        payload: {
          event: "dispatch_decision",
          class: "dev_orch",
          outcome,
          turn_n: 1,
          ts_epoch: 1000,
        },
      }),
      null,
      `outcome=${outcome} should not tween`,
    );
  }
});

test("shouldTweenFrame: dispatch_decision missing class → null", () => {
  assert.equal(
    shouldTweenFrame({
      payload: {
        event: "dispatch_decision",
        outcome: "dispatched",
        turn_n: 1,
        ts_epoch: 1000,
      },
    }),
    null,
  );
  assert.equal(
    shouldTweenFrame({
      payload: {
        event: "dispatch_decision",
        outcome: "dispatched",
        class: "",
        turn_n: 1,
        ts_epoch: 1000,
      },
    }),
    null,
  );
});

test("shouldTweenFrame: happy path returns canonical hit", () => {
  const hit = shouldTweenFrame({
    payload: {
      event: "dispatch_decision",
      outcome: "dispatched",
      class: "dev_target",
      turn_n: 7,
      ts_epoch: 1779905000,
    },
  });
  assert.deepEqual(hit, { cls: "dev_target", turnN: 7, tsEpoch: 1779905000 });
});

test("shouldTweenFrame: tolerates missing turn_n / ts_epoch (defaults to 0)", () => {
  const hit = shouldTweenFrame({
    payload: {
      event: "dispatch_decision",
      outcome: "dispatched",
      class: "qa_orch",
    },
  });
  assert.deepEqual(hit, { cls: "qa_orch", turnN: 0, tsEpoch: 0 });
});

// ---------------------------------------------------------------------------
// tweenIdFor — stable identity
// ---------------------------------------------------------------------------

test("tweenIdFor: same triple → same id (dedupe-friendly)", () => {
  const a = tweenIdFor(7, "dev_orch", 1779905000);
  const b = tweenIdFor(7, "dev_orch", 1779905000);
  assert.equal(a, b);
});

test("tweenIdFor: id encodes inputs and is DOM-safe", () => {
  const id = tweenIdFor(7, "dev_orch", 1779905000);
  assert.match(id, /^dispatch-tween-/);
  assert.match(id, /dev_orch/);
  assert.match(id, /7/);
  assert.match(id, /1779905000/);
});

test("tweenIdFor: strips unsafe characters from class names", () => {
  // Future-proofing: if a class name ever contains punctuation we
  // don't want it to land in a CSS keyframe selector raw.
  const id = tweenIdFor(1, "weird/class!", 100);
  assert.equal(id.includes("/"), false);
  assert.equal(id.includes("!"), false);
});

test("tweenIdFor: different turn_n / class / ts_epoch produce different ids", () => {
  const base = tweenIdFor(1, "dev_orch", 100);
  assert.notEqual(base, tweenIdFor(2, "dev_orch", 100));
  assert.notEqual(base, tweenIdFor(1, "qa_orch", 100));
  assert.notEqual(base, tweenIdFor(1, "dev_orch", 101));
});

// ---------------------------------------------------------------------------
// tweenSpec — render shape
// ---------------------------------------------------------------------------

const rect = (left: number, top: number, w = 100, h = 100) => ({
  left,
  top,
  width: w,
  height: h,
});

test("tweenSpec: two rects → tween from centre-of-from to centre-of-to", () => {
  const spec = tweenSpec({
    fromRect: rect(100, 100, 96, 96),
    toRect: rect(400, 300, 64, 64),
  });
  assert.equal(spec.kind, "tween");
  assert.equal(spec.startX, 148);
  assert.equal(spec.startY, 148);
  assert.equal(spec.endX, 432);
  assert.equal(spec.endY, 332);
});

test("tweenSpec: default duration matches the public constants", () => {
  const spec = tweenSpec({ fromRect: rect(0, 0), toRect: rect(50, 50) });
  assert.equal(spec.durationMs, DISPATCH_TWEEN_DURATION_MS);
  assert.equal(
    spec.dustStartAtMs,
    DISPATCH_TWEEN_DURATION_MS - DISPATCH_TWEEN_DUST_DURATION_MS,
  );
});

test("tweenSpec: reducedMotion=true → instant pop at toRect centre", () => {
  const spec = tweenSpec({
    fromRect: rect(0, 0),
    toRect: rect(200, 200, 40, 40),
    reducedMotion: true,
  });
  assert.equal(spec.kind, "instant");
  assert.equal(spec.startX, 220);
  assert.equal(spec.startY, 220);
  assert.equal(spec.endX, 220);
  assert.equal(spec.endY, 220);
});

test("tweenSpec: missing fromRect → instant pop at toRect centre", () => {
  const spec = tweenSpec({
    fromRect: null,
    toRect: rect(200, 200, 40, 40),
  });
  assert.equal(spec.kind, "instant");
  assert.equal(spec.startX, spec.endX);
  assert.equal(spec.startY, spec.endY);
});

test("tweenSpec: missing toRect → instant pop at origin (renderer treats as no-op)", () => {
  const spec = tweenSpec({
    fromRect: rect(50, 50),
    toRect: null,
  });
  assert.equal(spec.kind, "instant");
  assert.equal(spec.endX, 0);
  assert.equal(spec.endY, 0);
});

test("tweenSpec: malformed rect (missing numeric width) → treated as null", () => {
  const spec = tweenSpec({
    fromRect: { left: 10, top: 10, width: undefined as any, height: 20 },
    toRect: rect(100, 100),
  });
  // fromRect can't be centred → treated as missing → instant pop at toRect.
  assert.equal(spec.kind, "instant");
});

test("tweenSpec: custom duration overrides default", () => {
  const spec = tweenSpec({
    fromRect: rect(0, 0),
    toRect: rect(100, 100),
    durationMs: 1500,
    dustDurationMs: 100,
  });
  assert.equal(spec.durationMs, 1500);
  assert.equal(spec.dustStartAtMs, 1400);
});
