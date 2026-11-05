/**
 * Drift-guard (#5097 QA round 2): the launch-flow CLI force-exit must stay under
 * the WATCHDOG_CHECKS wrapper's `timeout` bound and WARN when it fires. The numeric
 * force-exit vs gh-timeout relation is asserted on imports in
 * test/watchdog-launch-flow.test.mts; only the fact that lives solely in
 * CLI source is read here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { WATCHDOG_CHECKS } from "../src/watchdog/checks.ts";
import { LAUNCH_FLOW_FORCE_EXIT_MS } from "../src/watchdog/launch-flow.ts";

const read = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), "utf-8");

test("force-exit stays under the launch-flow WATCHDOG_CHECKS timeout bound", () => {
  const check = WATCHDOG_CHECKS.find((c) => c.subcommand === "launch-flow");
  assert.ok(check, "launch-flow row not found in WATCHDOG_CHECKS");
  const wrapperMs = check.timeoutS * 1000;
  assert.ok(LAUNCH_FLOW_FORCE_EXIT_MS < wrapperMs, `force-exit ${LAUNCH_FLOW_FORCE_EXIT_MS} must stay under wrapper ${wrapperMs}`);
});

test("the CLI WARNs when the force-exit fires", () => {
  assert.match(read("scripts/hydra-watchdog.ts"), /WARN force-exit after/);
});
