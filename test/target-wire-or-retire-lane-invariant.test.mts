/**
 * Regression test for issue #3726 (design-concept artifact `issue-3726`,
 * hash `f4c573e3d22e7a70089826b347dc2fbae2b47ad...`) — pins the
 * `needs-triage` + `wire-or-retire` **pairing invariant**:
 *
 *   `wire-or-retire` is a QUALIFIER on the `needs-triage` lane, never a lane
 *   of its own, and `hydra-wire-or-retire` (the resolver) is the ONLY writer
 *   permitted to retire the pairing. Every other board writer — above all
 *   `hydra-target-sweep` — must treat an open `wire-or-retire` item as
 *   not-its-work and leave both labels alone.
 *
 * The live defect this fixed: `hydra-target-sweep`'s triage step (Step 2)
 * auto-promoted ANY well-described `needs-triage` issue to `ready-for-agent`,
 * stripping `needs-triage` off it — and exempted no label class. A
 * wire-or-retire decision item names a specific module file plus ledger
 * context, so it legitimately passes the "well-described" test and got
 * `needs-triage` stripped, zeroing the co-presence predicate at
 * `collect-state.sh:971` (`wor_label in labels and in_triage`) that
 * `wire_or_retire_target_available` depends on — silently disabling the
 * `hydra-wire-or-retire` handoff (confirmed live on hydra-betting#760, #626,
 * #631).
 *
 * This suite pins three things that were previously UNPINNED:
 *   (a) the sweep PLAYBOOK's triage step contains the wire-or-retire
 *       exemption instruction, ordered before the well-described test;
 *   (b) [REVISED by issue #3747 — see the last `describe` block below] the
 *       `collect-state.sh` count-side predicate no longer requires
 *       `needs-triage` co-presence: #3726's AND-needs-triage fix went blind
 *       the moment a triaged item left the `needs-triage` lane by ANY path
 *       other than the resolver's own verdict (hydra-betting#626:
 *       `wire-or-retire` + `ready-for-agent`, never touched by the resolver,
 *       permanently invisible to the old predicate) — the exact
 *       "flag-without-label dead-end handoff" pattern. #3747 redefines
 *       "unresolved" as the resolver's complete three-exit enumeration
 *       instead: WIRE/RETIRE self-terminate by stripping `wire-or-retire`
 *       entirely, a stale item CLOSES (excluded upstream by the enclosing
 *       `--state open` read), and UNCLEAR is the one state that needs an
 *       EXPLICIT exclusion since it deliberately keeps `wire-or-retire` while
 *       adding `ready-for-human` — so #3726's own negative-case assertion
 *       (UNCLEAR must not re-arm the signal) is PRESERVED, just re-derived
 *       from a `ready-for-human` check instead of a `needs-triage` one;
 *   (c) the resolver PLAYBOOK's WIRE/RETIRE transitions remove BOTH labels,
 *       while its UNCLEAR transition removes only `needs-triage` (keeping
 *       `wire-or-retire` so the operator can see the decision class) — and
 *       the resolver's own work-finding query (a SEPARATE `gh` read from the
 *       collect-state.sh dispatch-gate signal above) still requires
 *       co-presence, unaffected by #3747.
 *
 * Two hard constraints (per the approved design-concept artifact):
 *   - reads the in-repo PLAYBOOK (`docs/operator-playbooks/*.md`), NEVER the
 *     generated skill artifact under `~/.claude/skills/` — only one SKILL.md is tracked
 *     in this repo (`git ls-files | grep -c SKILL.md` == 1), so a
 *     generated-artifact assertion would read a file that doesn't exist in a
 *     fresh worktree (the known worktree-local doc-drift flake class);
 *   - makes NO `gh api` call — a live label read would burn the `gh` quota a
 *     running autopilot shares and go ambiently red.
 *
 * New top-level `describe`s in their own file (not grafted onto
 * test/autopilot-target-board-signals.test.mts's existing suite, which owns
 * the co-presence POSITIVE case only incidentally as a #3710 truncation
 * fixture) per this repo's sibling-teardown / shared-state flake authoring
 * rule.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");

const SWEEP_PLAYBOOK = join(REPO_ROOT, "docs", "operator-playbooks", "hydra-target-sweep.md");
const WOR_PLAYBOOK = join(REPO_ROOT, "docs", "operator-playbooks", "hydra-wire-or-retire.md");
const COLLECT_STATE_SCRIPT = join(REPO_ROOT, "scripts", "autopilot", "collect-state.sh");

const sweepSrc = readFileSync(SWEEP_PLAYBOOK, "utf-8");
const worSrc = readFileSync(WOR_PLAYBOOK, "utf-8");
const collectStateSrc = readFileSync(COLLECT_STATE_SCRIPT, "utf-8");

describe("hydra-target-sweep playbook — wire-or-retire exemption (issue #3726)", () => {
  test("Step 2 (triage lane) names the wire-or-retire exemption explicitly", () => {
    assert.match(
      sweepSrc,
      /### 2\. Process triage lane/,
      "the triage-lane step heading must still exist for the exemption to be anchored under it",
    );
    assert.match(
      sweepSrc,
      /wire-or-retire/i,
      "the sweep playbook must mention wire-or-retire at all — previously it had ZERO matches, which is exactly what let the sweep strip needs-triage off these items unexamined",
    );
  });

  test("the exemption is a distinct numbered step, not a parenthetical", () => {
    const triageSection = sweepSrc.slice(
      sweepSrc.indexOf("### 2. Process triage lane"),
      sweepSrc.indexOf("### 3. Process blocked lane"),
    );
    assert.match(
      triageSection,
      /^\d+\.\s+\*\*Wire-or-retire exemption\*\*/m,
      "the exemption must be its own numbered list item inside the triage-lane step, not folded into a parenthetical aside on the well-described test",
    );
  });

  test("the exemption is ordered BEFORE the well-described auto-promote test", () => {
    const triageSection = sweepSrc.slice(
      sweepSrc.indexOf("### 2. Process triage lane"),
      sweepSrc.indexOf("### 3. Process blocked lane"),
    );
    const exemptionIdx = triageSection.search(/\*\*Wire-or-retire exemption\*\*/);
    const wellDescribedIdx = triageSection.search(/\*\*Well-described\?\*\*/);
    assert.ok(exemptionIdx > -1, "exemption bullet not found");
    assert.ok(wellDescribedIdx > -1, "well-described bullet not found");
    assert.ok(
      exemptionIdx < wellDescribedIdx,
      "the exemption must run BEFORE the well-described test — the whole failure mode is that a wire-or-retire item legitimately PASSES that test on its merits, so gating after it is too late",
    );
  });

  test("the exemption instructs leaving BOTH labels untouched, not stripping needs-triage", () => {
    const triageSection = sweepSrc.slice(
      sweepSrc.indexOf("### 2. Process triage lane"),
      sweepSrc.indexOf("### 3. Process blocked lane"),
    );
    const exemptionLine = triageSection
      .split("\n")
      .find((l) => /\*\*Wire-or-retire exemption\*\*/.test(l));
    assert.ok(exemptionLine, "could not isolate the exemption bullet line");
    assert.match(
      exemptionLine!,
      /leave both labels|leave.*untouched/i,
      "the exemption must explicitly say to leave both labels alone — the old failure was removing needs-triage while adding ready-for-agent",
    );
    assert.doesNotMatch(
      exemptionLine!,
      /--remove-label needs-triage/,
      "the exemption bullet itself must not carry a needs-triage-stripping command",
    );
  });
});

describe("hydra-wire-or-retire playbook — co-presence work-finding query (issue #3726)", () => {
  test("the resolution loop's board read requires co-presence of both labels", () => {
    const loopSection = worSrc.slice(
      worSrc.indexOf("## The resolution loop"),
      worSrc.indexOf("### 1. Verify first"),
    );
    assert.match(
      loopSection,
      /labels=wire-or-retire,needs-triage/,
      "the resolution loop's gh api read must filter on labels=wire-or-retire,needs-triage (REST comma == AND) so it never re-matches an item whose needs-triage was already retired",
    );
    assert.doesNotMatch(
      loopSection,
      /labels=wire-or-retire(?!,needs-triage)/,
      "the resolution loop must not filter on wire-or-retire ALONE — that re-matches the resolver's own UNCLEAR / risk-carve-out output forever",
    );
  });

  test("the command-reference block agrees with the resolution loop (no drift between the two queries)", () => {
    assert.match(
      worSrc,
      /labels=wire-or-retire,needs-triage/g,
      "at least the reference block's query must require co-presence",
    );
    const occurrences = (worSrc.match(/labels=wire-or-retire,needs-triage/g) ?? []).length;
    assert.ok(
      occurrences >= 2,
      `expected the co-presence query to appear at least twice (resolution loop + command reference), found ${occurrences} — a single occurrence means the two queries have drifted apart again`,
    );
  });
});

describe("hydra-wire-or-retire playbook — WIRE/RETIRE vs UNCLEAR label transitions (issue #3726)", () => {
  function decideSection(): string {
    const start = worSrc.indexOf("### 4. Decide");
    const end = worSrc.indexOf("## Standard RETIRE-task body template");
    assert.ok(start > -1 && end > start, "could not locate the '### 4. Decide' section");
    return worSrc.slice(start, end);
  }

  test("WIRE removes BOTH needs-triage and wire-or-retire", () => {
    const section = decideSection();
    const wireBullet = section.slice(section.indexOf("**(a) WIRE**"), section.indexOf("**(b) RETIRE**"));
    assert.match(wireBullet, /--remove-label needs-triage/);
    assert.match(wireBullet, /--remove-label wire-or-retire/);
    assert.match(wireBullet, /--add-label ready-for-agent/);
  });

  test("RETIRE removes BOTH needs-triage and wire-or-retire", () => {
    const section = decideSection();
    const retireBullet = section.slice(section.indexOf("**(b) RETIRE**"), section.indexOf("**(c) UNCLEAR**"));
    assert.match(retireBullet, /--remove-label needs-triage/);
    assert.match(retireBullet, /--remove-label wire-or-retire/);
    assert.match(retireBullet, /--add-label ready-for-agent/);
  });

  test("UNCLEAR removes ONLY needs-triage — wire-or-retire is deliberately kept", () => {
    const section = decideSection();
    const unclearBullet = section.slice(section.indexOf("**(c) UNCLEAR**"));
    assert.match(unclearBullet, /--remove-label needs-triage/);
    assert.match(unclearBullet, /--add-label ready-for-human/);
    assert.doesNotMatch(
      unclearBullet!,
      /--remove-label wire-or-retire/,
      "UNCLEAR must NOT remove wire-or-retire — dropping it here would erase the operator-visible decision-class marker and (worse) let the item re-enter the sweep's promotable set",
    );
  });
});

describe("collect-state.sh — wire-or-retire 'unresolved' redefinition (issue #3747)", () => {
  /**
   * scope-justification: this describe block previously pinned #3726's
   * AND-needs-triage co-presence predicate as a NEGATIVE-case regression
   * (`wire-or-retire` WITHOUT `needs-triage` must NOT arm the signal). Issue
   * #3747 Part 2 (Files in scope: `scripts/autopilot/collect-state.sh`)
   * retires the `needs-triage` requirement specifically — it is precisely
   * what made hydra-betting#626 (`wire-or-retire` + `ready-for-agent`, no
   * `needs-triage`) permanently invisible to `wire_or_retire_target_available`
   * despite sitting on the board unresolved — but PRESERVES the underlying
   * intent: an item the resolver already adjudicated must not re-arm the
   * signal. The new predicate re-derives that guarantee from a
   * `ready-for-human` exclusion instead of a `needs-triage` requirement (the
   * complete enumeration of the resolver's three exits: WIRE/RETIRE strip
   * `wire-or-retire` entirely and self-terminate; UNCLEAR keeps
   * `wire-or-retire` but adds `ready-for-human`, so THAT is the one state
   * needing an explicit exclusion; a stale item closes, excluded upstream by
   * the enclosing `--state open` read). Per this repo's rule on removing
   * behavior (CLAUDE.md), the assertions below are updated to match while
   * preserving the original UNCLEAR-must-not-re-arm case; block 2 above (the
   * resolver playbook's OWN co-presence work-finding query) is a different,
   * unaffected seam and keeps its original assertions.
   */

  /** The Target lane-signal emitter (same block test/autopilot-target-board-signals.test.mts exercises). */
  function extractLaneEmitter(): string {
    const match = collectStateSrc.match(
      /python3 -c "(\nimport json, os, sys\ntry:\n  rows = json\.load[\s\S]*?)"\s*2>\/dev\/null/,
    );
    assert.ok(match, "could not locate the Target lane-signal python block in collect-state.sh");
    return match![1];
  }

  function runLaneEmitter(
    rows: readonly { labels: string[] }[],
    env: Record<string, string> = {},
  ): Record<string, string> {
    const r = spawnSync("python3", ["-c", extractLaneEmitter()], {
      input: JSON.stringify(rows.map((row) => ({ labels: row.labels }))),
      encoding: "utf-8",
      env: { ...process.env, GH_ISSUE_LIST_LIMIT: "100", ...env },
    });
    assert.equal(r.status, 0, `lane emitter exited non-zero: ${r.stderr}`);
    const out: Record<string, string> = {};
    for (const line of (r.stdout ?? "").trim().split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return out;
  }

  test("a row carrying wire-or-retire WITHOUT needs-triage DOES now arm the signal (the #626 case)", () => {
    const out = runLaneEmitter([{ labels: ["wire-or-retire", "ready-for-agent"] }]);
    assert.equal(
      out.wire_or_retire_target_available,
      "true",
      "hydra-betting#626-shaped row (wire-or-retire + ready-for-agent, no needs-triage) must arm the signal — this was the exact invisibility #3747 fixed",
    );
    assert.equal(out.wire_or_retire_target_triage, "1");
  });

  test("a row carrying BOTH wire-or-retire and needs-triage still arms the signal (positive control)", () => {
    const out = runLaneEmitter([{ labels: ["wire-or-retire", "needs-triage"] }]);
    assert.equal(out.wire_or_retire_target_available, "true");
    assert.equal(out.wire_or_retire_target_triage, "1");
  });

  test("an UNCLEAR-adjudicated row (wire-or-retire + ready-for-human) still does NOT arm the signal", () => {
    // PRESERVED from #3726: an item the resolver already adjudicated UNCLEAR
    // (wire-or-retire kept for operator visibility, ready-for-human added)
    // must not re-arm wire_or_retire_target — only the CONDITION changed
    // (ready-for-human exclusion instead of a needs-triage requirement), not
    // the guarantee.
    const out = runLaneEmitter([{ labels: ["wire-or-retire", "ready-for-human"] }]);
    assert.equal(out.wire_or_retire_target_available, "false");
    assert.equal(out.wire_or_retire_target_triage, "0");
  });

  test("mixed board: every open wire-or-retire row counts EXCEPT the UNCLEAR (ready-for-human) one", () => {
    const out = runLaneEmitter([
      { labels: ["wire-or-retire", "needs-triage"] }, // counts
      { labels: ["wire-or-retire"] }, // counts
      { labels: ["wire-or-retire", "ready-for-human"] }, // excluded — UNCLEAR
      { labels: ["wire-or-retire", "ready-for-agent"] }, // counts — the #626 shape
      { labels: ["needs-triage"] }, // excluded — no wire-or-retire label at all
    ]);
    assert.equal(
      out.wire_or_retire_target_triage,
      "3",
      "every wire-or-retire row counts except the ready-for-human (UNCLEAR) one and the bare needs-triage row",
    );
    assert.equal(out.wire_or_retire_target_available, "true");
  });

  test("closed items never reach this predicate — enforced upstream by the open-only gh read, not by a filter here", () => {
    // `rows` is fed straight from `gh issue list --state open`, so a closed
    // wire-or-retire item is never present in the input at all — there is no
    // "closed" row shape to construct here. This test documents that the
    // stale/close exit is satisfied by the enclosing read, not by any extra
    // condition in this predicate (see the sibling `--state open` wiring
    // assertion in test/autopilot-target-board-signals.test.mts).
    assert.match(
      collectStateSrc,
      /gh issue list --repo "\$TARGET_GH_REPO" --state open --limit "\$GH_ISSUE_LIST_LIMIT" --json/,
      "the Target board read that feeds this predicate must stay open-only",
    );
  });
});
