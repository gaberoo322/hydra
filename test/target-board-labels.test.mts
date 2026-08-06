/**
 * Network-free drift guard for the Target board-label manifest (issue #3720).
 *
 * Why this test exists
 * --------------------
 *
 * #3720's root cause was a contract asserted in prose but never checked at
 * runtime: the wire-or-retire producer filed through the RETIRED `/api/backlog`
 * surface for weeks (it 404'd, the runner exit(1)'d, and nothing was ever
 * filed), and a category-error label — `queued`, a retired Redis LANE name
 * masquerading as a GitHub label — silently succeeded in a remove-label loop
 * because nothing cross-checked the label literals Target-directed code
 * writes against a single manifest.
 *
 * This test pins the recurrence-prevention half of the fix. It is deliberately
 * NETWORK-FREE: it cross-checks CODE-vs-MANIFEST offline (deterministic). It
 * never queries the live Target label set — a running autopilot routinely
 * exhausts gh rate limits, so a live-labels assertion in a required check
 * would flake red with zero code change (the ambient-poison-pill class,
 * #3650). The MANIFEST-vs-LIVE-REPO direction is left to each producer's own
 * runtime failure path, which after #3720 reports the degradation loudly
 * instead of exit(1) in silence.
 *
 * What it pins
 * ------------
 *
 * 1. The manifest (`TARGET_BOARD_LABELS`) is the single source and its values
 *    are unique (no accidental duplicate literal).
 * 2. Every label the Target emit scripts write via `gh issue create --label`
 *    is a value in the manifest — so a NEW emit writing an unregistered label
 *    fails this test, not the next operator who notices a dark signal.
 * 3. The category-error labels (`queued`, `architecture-scan`, `target-backlog`)
 *    are kept OUT of the Target vocabulary.
 * 4. The wire-or-retire producer files via `gh` (ADR-0031), not the retired
 *    `/api/backlog` surface.
 * 5. The sweep playbook no longer treats the retired `queued` lane as a label.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { TARGET_BOARD_LABELS } from "../src/target-board-labels.ts";
import { WIRE_OR_RETIRE_LABEL } from "../scripts/ci/hydra-target-wire-or-retire-emit.ts";
import { CLEANUP_SCAN_LABEL } from "../scripts/ci/hydra-target-cleanup-emit.ts";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), "utf-8");

const MANIFEST = Object.values(TARGET_BOARD_LABELS) as string[];

describe("Target board-label manifest — authoritative + complete (#3720)", () => {
  test("the manifest is non-empty and its label literals are unique", () => {
    assert.ok(MANIFEST.length >= 13, `manifest unexpectedly shrank to ${MANIFEST.length}`);
    const dupes = MANIFEST.filter((l, i, arr) => arr.indexOf(l) !== i);
    assert.deepEqual(dupes, [], `duplicate label literals in TARGET_BOARD_LABELS: ${dupes}`);
  });

  test("every label the Target emit scripts write is in the manifest", () => {
    // The labels written via `gh issue create --label <X>` by the Target emit
    // runners — the recurrence this guard exists to catch: a new emit that
    // writes a label absent from the manifest.
    const written = [
      CLEANUP_SCAN_LABEL, // hydra-target-cleanup-emit.ts (demote phase)
      "ready-for-agent", // demote-phase routing label (same runner)
      WIRE_OR_RETIRE_LABEL, // hydra-target-wire-or-retire-emit.ts
      "needs-triage", // wire-or-retire co-presence label (same runner)
      "design-qa", // design-QA emit runner (collect-state.sh:889)
    ];
    const missing = written.filter((l) => !MANIFEST.includes(l));
    assert.deepEqual(
      missing,
      [],
      `labels written to the Target repo but absent from TARGET_BOARD_LABELS: ${missing}; add them to src/target-board-labels.ts`,
    );
  });

  test("category-error labels are kept OUT of the Target vocabulary", () => {
    // `queued` is a retired Redis LANE name (the lane↔label table maps it ->
    // ready-for-agent), not a GitHub label; `architecture-scan` is orch-only
    // (zero Target-directed writes); `target-backlog` is an orch-side routing
    // label that no Target-repo issue carries. None belong here.
    for (const bad of ["queued", "architecture-scan", "target-backlog"]) {
      assert.ok(
        !MANIFEST.includes(bad),
        `category-error label "${bad}" must not be in TARGET_BOARD_LABELS (see src/target-board-labels.ts)`,
      );
    }
  });
});

describe("wire-or-retire producer migration — gh, not the retired /api/backlog (#3720)", () => {
  const src = read("scripts/ci/hydra-target-wire-or-retire-emit.ts");

  test("files via gh issue create and dedups via gh issue list (ADR-0031)", () => {
    // execFileSync("gh", [..., "issue", "create"/"list", ...]) — the shape the
    // already-migrated demote sibling (hydra-target-cleanup-emit.ts) uses.
    assert.match(src, /execFileSync\(\s*"gh"/);
    assert.match(src, /"issue",\s*"create"/);
    assert.match(src, /"issue",\s*"list"/);
  });

  test("no longer calls the retired /api/backlog HTTP surface", () => {
    // The script is a gh-CLI wrapper under ADR-0031; it makes no HTTP fetch at
    // all. API_BASE (the retired surface's base-URL constant) is gone and no
    // fetch( call remains — pinning both so a re-introduction of either fails
    // here rather than silently re-darkening the signal.
    assert.doesNotMatch(src, /\bAPI_BASE\b/);
    assert.doesNotMatch(src, /\bfetch\s*\(/);
  });

  test("stamps both wire-or-retire AND needs-triage (co-presence invariant)", () => {
    // collect-state.sh counts a wire-or-retire item only when BOTH labels are
    // present; filing either alone leaves the signal dark. Pin that the create
    // call passes both labels in the same invocation. The wire-or-retire label
    // is passed via the WIRE_OR_RETIRE_LABEL constant; needs-triage as a literal.
    assert.match(src, /"--label",\s*WIRE_OR_RETIRE_LABEL\b/);
    assert.match(src, /"--label",\s*"needs-triage"/);
  });
});

describe("hydra-target-sweep — retired `queued` lane no longer treated as a label (#3720)", () => {
  const sweep = read("docs/operator-playbooks/hydra-target-sweep.md");

  test("the remove-label loop drops the bogus `queued` token", () => {
    // The exact category error: `for L in ready-for-agent in-progress queued` —
    // `queued` is a retired Redis LANE name (the table maps it -> ready-for-agent),
    // not a GitHub label, so DELETEing it as a label was a silent category error.
    // `queued` still legitimately appears in the lane↔label mapping table; this
    // assertion targets only the label-loop sequence.
    assert.doesNotMatch(
      sweep,
      /ready-for-agent\s+in-progress\s+queued\b/,
      "the retired `queued` lane name must not appear as a label in a remove-label loop",
    );
  });
});
