import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import {
  resolveRolloutSwitches,
  loadRolloutSwitches,
  COHORT_BASELINE_PATH,
} from "../src/qa/rollout-switches.ts";
import { BASELINE_FIXTURE_PATH } from "../scripts/qa/cohort-baseline.ts";

const OFF = { "two-way-pair": "off", "reviewer-commits": "off" };

describe("qa rollout switches", () => {
  it("missing config, key, or malformed value resolve off", () => {
    assert.deepEqual(resolveRolloutSwitches(undefined, "not-tripped").effective, OFF);
    assert.deepEqual(resolveRolloutSwitches({}, "not-tripped").effective, OFF);
    for (const bad of ["On", " on ", 1, null, ["on"]]) {
      assert.equal(resolveRolloutSwitches({ "two-way-pair": bad }, "not-tripped").effective["two-way-pair"], "off");
    }
    assert.equal(resolveRolloutSwitches({ "reviewer-commits": "A+b" }, "not-tripped").effective["reviewer-commits"], "off");
    assert.deepEqual(resolveRolloutSwitches([], "not-tripped").effective, OFF);
    assert.deepEqual(resolveRolloutSwitches("x", "not-tripped").effective, OFF);
  });

  it("valid values pass through per key independently", () => {
    const r = resolveRolloutSwitches({ "two-way-pair": "shadow", "reviewer-commits": "bogus" }, "not-tripped");
    assert.deepEqual(r.effective, { "two-way-pair": "shadow", "reviewer-commits": "off" });
    const r2 = resolveRolloutSwitches({ "two-way-pair": "on", "reviewer-commits": "A+B", extra: 1 }, "not-tripped");
    assert.deepEqual(r2.effective, { "two-way-pair": "on", "reviewer-commits": "A+B" });
    assert.ok(r2.reasons.includes("key-unknown:extra"));
  });

  it("trip and unknown trip force off but keep configured", () => {
    const cfg = { "two-way-pair": "on", "reviewer-commits": "A" };
    for (const t of ["tripped", "unknown"] as const) {
      const r = resolveRolloutSwitches(cfg, t);
      assert.deepEqual(r.effective, OFF);
      assert.deepEqual(r.configured, cfg);
    }
  });

  it("loader: trip source mapping and error handling", async () => {
    const cfg = JSON.stringify({ "two-way-pair": "on", "reviewer-commits": "A+B" });
    const mk = (base: string | Error, conf: string | Error = cfg) => async (p: string) => {
      const v = p.endsWith("qa-rollout.json") ? conf : base;
      if (v instanceof Error) throw v;
      return v;
    };
    const enoent = Object.assign(new Error("nf"), { code: "ENOENT" });
    const notTripped = JSON.stringify({ metrics: { tripped: false } });
    const on = await loadRolloutSwitches("/r", { readFile: mk(notTripped) });
    assert.equal(on.effective["two-way-pair"], "on");
    assert.equal(on.trip.state, "not-tripped");
    const tr = await loadRolloutSwitches("/r", { readFile: mk(JSON.stringify({ metrics: { tripped: true } })) });
    assert.deepEqual(tr.effective, OFF);
    for (const b of ["{not json", "{}", JSON.stringify({ metrics: { tripped: "no" } }), enoent]) {
      const r = await loadRolloutSwitches("/r", { readFile: mk(b) });
      assert.deepEqual(r.effective, OFF);
      assert.ok(r.reasons.includes("trip-unreadable"));
    }
    const missing = await loadRolloutSwitches("/r", { readFile: mk(notTripped, enoent) });
    assert.deepEqual(missing.effective, OFF);
    assert.ok(missing.reasons.includes("config-missing"));
    const origErr = console.error;
    console.error = () => {};
    try {
      const bad = await loadRolloutSwitches("/r", { readFile: mk(notTripped, new Error("EACCES")) });
      assert.deepEqual(bad.effective, OFF);
      assert.ok(bad.reasons.includes("config-read-failed"));
      const junk = await loadRolloutSwitches("/r", { readFile: mk(notTripped, "{oops") });
      assert.deepEqual(junk.effective, OFF);
    } finally {
      console.error = origErr;
    }
  });

  it("baseline path matches cohort script and committed files resolve off/off", async () => {
    assert.equal(COHORT_BASELINE_PATH, BASELINE_FIXTURE_PATH);
    const root = fileURLToPath(new URL("..", import.meta.url));
    const r = await loadRolloutSwitches(root);
    assert.deepEqual(r.configured, OFF);
    assert.deepEqual(r.effective, OFF);
  });

  it("non-ENOENT trip read failure gets a distinct reason; ENOENT does not", async () => {
    const cfg = JSON.stringify({ "two-way-pair": "on", "reviewer-commits": "A" });
    const mk = (base: Error) => async (p: string) => {
      if (p.endsWith("qa-rollout.json")) return cfg;
      throw base;
    };
    const origErr = console.error;
    console.error = () => {};
    try {
      const io = await loadRolloutSwitches("/r", { readFile: mk(new Error("EIO")) });
      assert.deepEqual(io.effective, OFF);
      assert.ok(io.reasons.includes("trip-unreadable"));
      assert.ok(io.reasons.includes("trip-read-failed"));
    } finally {
      console.error = origErr;
    }
    const enoent = Object.assign(new Error("nf"), { code: "ENOENT" });
    const nf = await loadRolloutSwitches("/r", { readFile: mk(enoent) });
    assert.ok(nf.reasons.includes("trip-unreadable"));
    assert.ok(!nf.reasons.includes("trip-read-failed"));
  });
});
