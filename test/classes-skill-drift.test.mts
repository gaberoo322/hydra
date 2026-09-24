/**
 * classes.json ↔ decide.py dispatched-skill parity (issue #4636, guidance-epic
 * #4619 slice 17 — ADR-0034 §9.2).
 *
 * "classes.json is authoritative for the dispatched skill. A drift test pins
 * it against decide.py's make_dispatch literals. wayfinder_orch's routing
 * happens at dispatch time and is exempted by name."
 *
 * The pre-#4636 drift this file killed: research_orch's row named
 * `hydra-research` while decide.py's selector dispatched `hydra-issue-research`
 * (the mirror image of qa_target's #4576 drift, where the SELECTOR was wrong
 * and the row was right — see `_select_slot_qa_target`'s docstring). Both
 * directions are now mechanically pinned:
 *
 *   1. per-class equality — every `_select_slot_<name>` / `_select_signal_<name>`
 *      function's make_dispatch skill literals equal that class's row `skill`
 *      column (wayfinder_orch exempt by name: the playbook's ticket-type router
 *      picks the skill at dispatch time, and the row names the taxonomy
 *      DEFAULT);
 *   2. file-wide containment — every skill literal in ANY make_dispatch call is
 *      named by some row, so a selector dispatching an unnamed skill reddens
 *      even before its class row exists;
 *   3. registry flags — every `class:<name>` registry entry's manual command
 *      mirrors `/<row.skill>` and carries `--apply` exactly when the class's
 *      selector stamps the constant `"apply": True` prompt arg (the #1078
 *      anti-dry-run-no-op lesson: a hand-run must emit exactly like an
 *      autopilot dispatch).
 *
 * decide.py is Python and out of this PR's scope, so the parser is TEXT-based:
 * top-level `def` chunks, string-literal second arguments only. The escalation
 * re-dispatch site (`make_dispatch(slot, skill, …)` — a variable, not a
 * literal) is deliberately invisible to it: it re-dispatches the SAME skill the
 * selector already chose, so the selector pin covers it transitively.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { DISPATCH_CLASSES, classByName } from "../src/taxonomy/classes.ts";
import { REGISTRY } from "../src/operator-actions/registry.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DECIDE_PY = readFileSync(join(REPO_ROOT, "scripts", "autopilot", "decide.py"), "utf-8");

// ---------------------------------------------------------------------------
// Parser — decide.py selector functions → dispatched skill literals
// ---------------------------------------------------------------------------

/** A make_dispatch skill literal: `make_dispatch(<ident>, "<skill>"` — the
 * second positional argument as a string literal. Variable arguments (the
 * escalation path's `skill`) do not match, by design. */
const DISPATCH_LITERAL = /make_dispatch\(\s*[A-Za-z_]\w*,\s*"([^"]+)"/g;

/** A top-level function definition — chunk boundaries for the parser. */
const TOP_LEVEL_DEF = /^def (\w+)\(/gm;

/** wayfinder_orch is exempt from per-class equality BY NAME (ADR-0034 §9.2):
 * the hydra-autopilot playbook resolves ticket_type → skill at dispatch time,
 * so the row names the taxonomy DEFAULT rather than a single dispatched skill. */
const SKILL_EQUALITY_EXEMPT = new Set(["wayfinder_orch"]);

export interface SelectorDispatches {
  /** The classes.json row the selector function selects for (the `_select_(slot|signal)_` suffix). */
  className: string;
  /** The full function name, for failure messages. */
  fn: string;
  /** Every string-literal skill its make_dispatch calls carry (duplicates kept). */
  skills: string[];
  /** Whether any of its dispatches stamps the constant `"apply": True` prompt arg. */
  applyStamped: boolean;
}

export function extractSelectorDispatches(source: string): SelectorDispatches[] {
  const defs = [...source.matchAll(TOP_LEVEL_DEF)];
  const out: SelectorDispatches[] = [];
  for (let i = 0; i < defs.length; i++) {
    const fn = defs[i]![1]!;
    const suffix = /^_select_(?:slot|signal)_(.+)$/.exec(fn);
    if (!suffix) continue;
    // Chunk = this def up to the next top-level def (functions do not nest).
    const body = source.slice(defs[i]!.index!, defs[i + 1]?.index ?? source.length);
    const skills = [...body.matchAll(DISPATCH_LITERAL)].map((m) => m[1]!);
    out.push({
      className: suffix[1]!,
      fn,
      skills,
      applyStamped: /"apply":\s*True/.test(body),
    });
  }
  return out;
}

const SELECTORS = extractSelectorDispatches(DECIDE_PY);
const ROW_SKILLS = new Set(DISPATCH_CLASSES.map((r) => r.skill));

// ---------------------------------------------------------------------------
// 1. Per-class equality — the row's skill column IS what the selector dispatches
// ---------------------------------------------------------------------------

describe("classes.json ↔ decide.py: per-class skill equality (ADR-0034 §9.2)", () => {
  test("every selector dispatches exactly its row's skill column (wayfinder_orch exempt)", () => {
    // Guard against silent vacuity: if decide.py renames its selector
    // functions, SELECTORS empties and every per-class assertion below would
    // pass without checking anything. Today every row is wired 1:1 — a future
    // alphabet-only row (ADR-0030 Decision 5 expand step, pre-#3423
    // tickets_orch shape) must land WITH an explicit exemption here.
    assert.equal(
      SELECTORS.length,
      DISPATCH_CLASSES.length,
      `expected one _select_(slot|signal)_ function per classes.json row — got ${SELECTORS.length} selectors for ${DISPATCH_CLASSES.length} rows; if a row is deliberately alphabet-only, extend SKILL_EQUALITY_EXEMPT in the same PR`,
    );

    const mismatches: string[] = [];
    for (const sel of SELECTORS) {
      const row = classByName(sel.className);
      assert.ok(row, `decide.py selector ${sel.fn} names no classes.json row "${sel.className}"`);
      if (SKILL_EQUALITY_EXEMPT.has(sel.className)) continue;
      if (sel.skills.length === 0) {
        mismatches.push(
          `${sel.className}: selector ${sel.fn} carries NO make_dispatch skill literal — the dispatches moved or the literal regex drifted`,
        );
        continue;
      }
      for (const skill of new Set(sel.skills)) {
        if (skill !== row!.skill) {
          mismatches.push(
            `${sel.className}: decide.py dispatches "${skill}" but classes.json names "${row!.skill}"`,
          );
        }
      }
    }
    assert.deepEqual(mismatches, []);
  });

  test("wayfinder_orch's exemption is dispatch-time routing, not a stale row", () => {
    const sel = SELECTORS.find((s) => s.className === "wayfinder_orch");
    assert.ok(sel, "wayfinder_orch selector must exist — the exempted class is still parsed");
    const row = classByName("wayfinder_orch");
    assert.ok(row);
    assert.ok(
      sel!.skills.includes(row!.skill),
      `wayfinder_orch is exempt from equality, but its row's DEFAULT skill "${row!.skill}" must still be among its dispatched literals (${sel!.skills.join(", ")}) — the playbook router overrides per ticket type, it does not replace the default`,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. File-wide containment — no dispatched skill goes unnamed
// ---------------------------------------------------------------------------

describe("classes.json ↔ decide.py: every dispatched skill is named by a row", () => {
  test("no make_dispatch skill literal outside the row skill set (issue #4636 acceptance criterion 1)", () => {
    const fileWide = [...DECIDE_PY.matchAll(DISPATCH_LITERAL)].map((m) => m[1]!);
    // Vacuity guard: a literal-extraction regression must not pass silently.
    assert.ok(
      fileWide.length >= SELECTORS.length,
      `extracted only ${fileWide.length} make_dispatch literals — the literal regex has drifted from decide.py's call shape`,
    );
    const unknown = [...new Set(fileWide)].filter((s) => !ROW_SKILLS.has(s));
    assert.deepEqual(
      unknown,
      [],
      `decide.py dispatches skill(s) no classes.json row names: ${unknown.join(", ")} — classes.json is authoritative for the dispatched skill (ADR-0034 §9.2)`,
    );
  });

  test("reddens on a dispatched skill no row names (synthetic fail direction)", () => {
    // The same containment the live check above performs, against a minimal
    // synthetic decide.py — acceptance criterion 1's reddening, demonstrated
    // without mutating the real selector.
    const synthetic = [
      "def _select_signal_health(",
      '    return make_dispatch(sig, "hydra-not-a-skill", reason="x")',
      "",
    ].join("\n");
    const literals = [...synthetic.matchAll(DISPATCH_LITERAL)].map((m) => m[1]!);
    const unknown = [...new Set(literals)].filter((s) => !ROW_SKILLS.has(s));
    assert.deepEqual(unknown, ["hydra-not-a-skill"]);
  });

  test("parses the multiline make_dispatch form and its apply stamp", () => {
    const synthetic = [
      "def _select_signal_cleanup_orch():",
      "    return make_dispatch(",
      "        sig,",
      '        "hydra-cleanup",',
      '        prompt_args={"apply": True},',
      '        reason="x",',
      "    )",
      "",
    ].join("\n");
    const sel = extractSelectorDispatches(synthetic)[0]!;
    assert.equal(sel.className, "cleanup_orch");
    assert.deepEqual(sel.skills, ["hydra-cleanup"]);
    assert.equal(sel.applyStamped, true);
  });

  test("flags a selector/row skill mismatch (synthetic fail direction)", () => {
    const synthetic = [
      "def _select_slot_dev_orch():",
      '    return make_dispatch(cls, "hydra-qa", reason="x")',
      "",
    ].join("\n");
    const sel = extractSelectorDispatches(synthetic)[0]!;
    const row = classByName("dev_orch");
    assert.ok(row);
    assert.notEqual(sel.skills[0], row!.skill);
  });
});

// ---------------------------------------------------------------------------
// 3. Registry class:<name> manual commands carry the exact dispatch flags
// ---------------------------------------------------------------------------

describe("registry class:<name> entries carry the exact dispatch flags (issue #4636)", () => {
  test("command mirrors /<row.skill> and carries --apply iff the selector stamps apply:true", () => {
    const classEntries = new Map(
      REGISTRY.filter((e) => e.key.startsWith("class:")).map((e) => [e.key, e]),
    );
    for (const sel of SELECTORS) {
      const entry = classEntries.get(`class:${sel.className}`);
      assert.ok(
        entry,
        `no class:${sel.className} registry entry — one class: entry per classes.json row (ADR-0034 §9.2)`,
      );
      const row = classByName(sel.className);
      assert.ok(row);
      const rec = entry!.recommended;
      assert.equal(
        rec.kind,
        "terminal-skill",
        `class:${sel.className} recommended must be a terminal-skill manual command`,
      );
      if (rec.kind !== "terminal-skill") continue;
      assert.ok(
        rec.command === `/${row!.skill}` || rec.command.startsWith(`/${row!.skill} `),
        `class:${sel.className}: manual command "${rec.command}" must start with "/${row!.skill}"`,
      );
      assert.equal(
        rec.command.includes("--apply"),
        sel.applyStamped,
        `class:${sel.className}: decide.py stamps apply:${sel.applyStamped}, so the manual command ${sel.applyStamped ? `must carry --apply (got "${rec.command}")` : `must NOT carry a spurious --apply (got "${rec.command}")`}`,
      );
    }
  });
});
