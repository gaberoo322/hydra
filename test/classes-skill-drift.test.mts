/**
 * classes.json ⇄ decide.py skill drift test (issue #4636, ADR-0034 §9.2).
 *
 * ADR-0034 §9.2 makes `scripts/autopilot/classes.json` AUTHORITATIVE for the
 * skill each dispatch class dispatches. decide.py's per-class selectors
 * (`_select_slot_<name>` / `_select_signal_<name>`) still spell their skill as
 * a `make_dispatch(cls|sig, "<skill>", …)` string literal, so the two can
 * drift silently (research_orch did: classes.json said `hydra-research`
 * while the selector dispatched `hydra-issue-research`). This test pins them.
 *
 * Text scan, not a python `ast` subprocess — the repo precedent
 * (test/autopilot-scripts.test.mts, test/autopilot-invariants.test.mts). The
 * one gap a text scan has — a skill argument that is not a string literal —
 * is closed by failing LOUDLY on it rather than skipping it.
 *
 * `wayfinder_orch` is the single exemption: its skill is routed per ticket
 * type at dispatch time, so its selector literal is only the default.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { DISPATCH_CLASSES } from "../src/taxonomy/classes.ts";
import { readBrainSource } from "../scripts/ci/brain-source.ts";

/** Classes whose dispatched skill is routed at dispatch time (ADR-0034 §9.2). */
const DISPATCH_TIME_ROUTED_CLASSES: readonly string[] = ["wayfinder_orch"];

/** One `make_dispatch(` call found inside a selector block. */
type SelectorCall =
  | { kind: "literal"; skill: string }
  | { kind: "non-literal"; snippet: string };

/**
 * Pure extractor: split Python source on top-level `def `, and for every
 * block named `_select_slot_<name>` / `_select_signal_<name>` collect each
 * `make_dispatch(` call's second argument. A string-literal second argument
 * (after a `cls` / `sig` first argument, whitespace/newline tolerant) yields
 * `{kind: "literal"}`; anything else yields `{kind: "non-literal"}` so the
 * comparator can fail loudly instead of skipping it.
 */
function extractSelectorSkills(source: string): Map<string, SelectorCall[]> {
  const out = new Map<string, SelectorCall[]>();
  const blocks = source.split(/^def /m).slice(1);
  for (const block of blocks) {
    const header = /^(_select_(?:slot|signal)_(\w+))\s*\(/.exec(block);
    if (!header) continue;
    const className = header[2]!;
    const calls: SelectorCall[] = [];
    const callPattern = /make_dispatch\(/g;
    let match: RegExpExecArray | null;
    while ((match = callPattern.exec(block)) !== null) {
      const rest = block.slice(match.index + match[0].length);
      const literal = /^\s*(?:cls|sig)\s*,\s*"([^"]+)"/.exec(rest);
      if (literal) {
        calls.push({ kind: "literal", skill: literal[1]! });
      } else {
        calls.push({ kind: "non-literal", snippet: rest.slice(0, 80).replace(/\s+/g, " ").trim() });
      }
    }
    out.set(className, [...(out.get(className) ?? []), ...calls]);
  }
  return out;
}

type DriftFinding =
  | { kind: "no-selector"; cls: string }
  | { kind: "no-literal"; cls: string }
  | { kind: "non-literal"; cls: string; snippet: string }
  | { kind: "mismatch"; cls: string; expected: string; actual: string };

/**
 * Pure comparator: for every taxonomy row not in `exempt`, its selector block
 * must exist, carry at least one `make_dispatch` call, every call's skill must
 * be a string literal, and every literal must equal the row's skill.
 */
function skillDrift(
  rows: readonly { name: string; skill: string }[],
  selectors: Map<string, SelectorCall[]>,
  exempt: readonly string[],
): DriftFinding[] {
  const findings: DriftFinding[] = [];
  for (const row of rows) {
    if (exempt.includes(row.name)) continue;
    const calls = selectors.get(row.name);
    if (!calls) {
      findings.push({ kind: "no-selector", cls: row.name });
      continue;
    }
    if (calls.length === 0) {
      findings.push({ kind: "no-literal", cls: row.name });
      continue;
    }
    for (const call of calls) {
      if (call.kind === "non-literal") {
        findings.push({ kind: "non-literal", cls: row.name, snippet: call.snippet });
      } else if (call.skill !== row.skill) {
        findings.push({ kind: "mismatch", cls: row.name, expected: row.skill, actual: call.skill });
      }
    }
  }
  return findings;
}

describe("classes.json skill ⇄ decide.py make_dispatch literals (issue #4636)", () => {
  // Issue #4511: the selectors live in decide_selectors/*.py, so scan the whole
  // brain corpus (decide.py + decide_base.py + every selector module).
  const source = readBrainSource().joined;
  const selectors = extractSelectorSkills(source);

  test("the exemption list is exactly wayfinder_orch and names a real dispatch class", () => {
    assert.deepEqual([...DISPATCH_TIME_ROUTED_CLASSES], ["wayfinder_orch"]);
    const names = new Set(DISPATCH_CLASSES.map((r) => r.name));
    for (const name of DISPATCH_TIME_ROUTED_CLASSES) {
      assert.ok(names.has(name), `${name} must be a DISPATCH_CLASSES name`);
    }
  });

  test("every non-exempt class's selector dispatches exactly its classes.json skill", () => {
    const findings = skillDrift(DISPATCH_CLASSES, selectors, DISPATCH_TIME_ROUTED_CLASSES);
    assert.deepEqual(findings, [], `classes.json ⇄ decide.py skill drift: ${JSON.stringify(findings)}`);
  });

  test("the scan actually reached every non-exempt class (no vacuous pass)", () => {
    for (const row of DISPATCH_CLASSES) {
      if (DISPATCH_TIME_ROUTED_CLASSES.includes(row.name)) continue;
      const calls = selectors.get(row.name) ?? [];
      assert.ok(calls.length > 0, `${row.name} selector must carry at least one make_dispatch literal`);
    }
  });

  test("research_orch is pinned to hydra-issue-research on both sides", () => {
    const row = DISPATCH_CLASSES.find((r) => r.name === "research_orch");
    assert.equal(row?.skill, "hydra-issue-research");
    assert.ok(!DISPATCH_CLASSES.some((r) => r.skill === "hydra-research"));
    assert.deepEqual(selectors.get("research_orch"), [{ kind: "literal", skill: "hydra-issue-research" }]);
  });

  test("qa_target stays hydra-target-qa on both sides (the #4576 resolution is not reverted)", () => {
    const row = DISPATCH_CLASSES.find((r) => r.name === "qa_target");
    assert.equal(row?.skill, "hydra-target-qa");
    assert.deepEqual(selectors.get("qa_target"), [{ kind: "literal", skill: "hydra-target-qa" }]);
  });
});

describe("skillDrift — fail direction on synthetic decide.py source (issue #4636)", () => {
  const rows = [
    { name: "cleanup_orch", skill: "hydra-cleanup" },
    { name: "health", skill: "hydra-doctor" },
  ];

  test("reddens when a selector dispatches a skill classes.json does not name", () => {
    const synthetic = [
      "def _select_signal_cleanup_orch(sig, state):",
      "    return make_dispatch(",
      "        sig,",
      '        "hydra-nope",',
      "        prompt_args={\"apply\": True},",
      "    )",
      "",
      "def _select_signal_health(sig, state):",
      '    return make_dispatch(sig, "hydra-doctor", reason="x")',
      "",
    ].join("\n");
    const findings = skillDrift(rows, extractSelectorSkills(synthetic), []);
    assert.deepEqual(findings, [
      { kind: "mismatch", cls: "cleanup_orch", expected: "hydra-cleanup", actual: "hydra-nope" },
    ]);
  });

  test("fails loudly on a non-literal skill argument instead of skipping it", () => {
    const synthetic = [
      "def _select_signal_cleanup_orch(sig, state):",
      "    skill = pick()",
      "    return make_dispatch(sig, skill)",
      "",
      "def _select_signal_health(sig, state):",
      '    return make_dispatch(sig, "hydra-doctor")',
      "",
    ].join("\n");
    const findings = skillDrift(rows, extractSelectorSkills(synthetic), []);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.kind, "non-literal");
    assert.equal(findings[0]!.cls, "cleanup_orch");
  });

  test("reports a class with no selector block at all", () => {
    const synthetic = 'def _select_signal_health(sig, state):\n    return make_dispatch(sig, "hydra-doctor")\n';
    assert.deepEqual(skillDrift(rows, extractSelectorSkills(synthetic), []), [
      { kind: "no-selector", cls: "cleanup_orch" },
    ]);
  });

  test("an exempt class is never checked", () => {
    const synthetic = 'def _select_signal_health(sig, state):\n    return make_dispatch(sig, "hydra-doctor")\n';
    assert.deepEqual(skillDrift(rows, extractSelectorSkills(synthetic), ["cleanup_orch"]), []);
  });
});
