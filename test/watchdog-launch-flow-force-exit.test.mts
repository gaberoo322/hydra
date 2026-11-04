/**
 * Drift-guard (#5097 QA round 2): the launch-flow CLI force-exit must stay under
 * the bash wrapper's `timeout` bound and WARN when it fires. The numeric
 * force-exit vs gh-timeout relation is asserted on imports in
 * test/watchdog-launch-flow.test.mts; only the two facts that live solely in
 * shell / CLI source are read here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { LAUNCH_FLOW_FORCE_EXIT_MS } from "../src/watchdog/launch-flow.ts";

const read = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), "utf-8");

test("force-exit stays under the bash run_launch_flow_cli wrapper bound", () => {
  const m = /run_launch_flow_cli\(\) \{[^}]*?(\d+); \}/.exec(read("scripts/hydra-watchdog.sh"));
  assert.ok(m, "run_launch_flow_cli wrapper not found");
  const wrapperMs = Number(m[1]) * 1000;
  assert.ok(LAUNCH_FLOW_FORCE_EXIT_MS < wrapperMs, `force-exit ${LAUNCH_FLOW_FORCE_EXIT_MS} must stay under wrapper ${wrapperMs}`);
});

test("the CLI WARNs when the force-exit fires", () => {
  assert.match(read("scripts/hydra-watchdog.ts"), /WARN force-exit after/);
});
