/**
 * Drift guard (#5529): docs/operations/watchdog.md hand-restates the wrapper
 * bounds that live in WATCHDOG_CHECKS and the CLI force-exit that lives in
 * LAUNCH_FLOW_FORCE_EXIT_MS. Numbers only; prose semantics stay with review.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { WATCHDOG_CHECKS } from "../src/watchdog/checks.ts";
import { LAUNCH_FLOW_FORCE_EXIT_MS } from "../src/watchdog/launch-flow.ts";

const doc = readFileSync(new URL("../docs/operations/watchdog.md", import.meta.url), "utf-8");
const lines = doc.split("\n");

const TICK_SENTENCE = /Tick order and wrapper bounds:([^\n]*)/;
const TOKEN = /\b([a-z]+(?:-[a-z]+)*) (\d+)s\b/g;

test("tick-order sentence matches WATCHDOG_CHECKS order and bounds", () => {
  const m = TICK_SENTENCE.exec(doc);
  assert.ok(m, "watchdog.md must keep a 'Tick order and wrapper bounds:' sentence");
  const known = new Set(WATCHDOG_CHECKS.map((c) => c.subcommand));
  const parsed = [...m[1].matchAll(TOKEN)].filter((t) => known.has(t[1])).map((t) => ({ subcommand: t[1], seconds: Number(t[2]) }));
  const expected = WATCHDOG_CHECKS.map((c) => ({ subcommand: c.subcommand, seconds: c.timeoutS }));
  assert.deepStrictEqual(
    parsed,
    expected,
    `watchdog.md 'Tick order and wrapper bounds' drifted from src/watchdog/checks.ts; edit it to: ` +
      expected.map((e) => `${e.subcommand} ${e.seconds}s`).join(", "),
  );
});

test("every other '<subcommand> <N>s' token in the doc equals that check's timeoutS", () => {
  const offenders: string[] = [];
  lines.forEach((line, i) => {
    if (TICK_SENTENCE.test(line)) return;
    for (const t of line.matchAll(TOKEN)) {
      const check = WATCHDOG_CHECKS.find((c) => c.subcommand === t[1]);
      if (!check) continue;
      if (Number(t[2]) !== check.timeoutS) {
        offenders.push(`line ${i + 1}: "${t[1]} ${t[2]}s" is stale; edit line ${i + 1} to say "${t[1]} ${check.timeoutS}s"`);
      }
    }
  });
  assert.deepStrictEqual(offenders, []);
});

test("the launch-flow parenthetical quotes the real CLI force-exit", () => {
  const m = /launch-flow \d+s \(covers the (\d+)s CLI force-exit\)/.exec(doc);
  assert.ok(m, "watchdog.md must keep quoting 'launch-flow <N>s (covers the <N>s CLI force-exit)'");
  assert.strictEqual(
    Number(m[1]),
    LAUNCH_FLOW_FORCE_EXIT_MS / 1000,
    `watchdog.md quotes a ${m[1]}s force-exit; code says ${LAUNCH_FLOW_FORCE_EXIT_MS / 1000}s`,
  );
});
