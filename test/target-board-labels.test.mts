/**
 * Regression tests for the Target board-label manifest and its drift guard
 * (issue #3720).
 *
 * `src/target-board-labels.ts` was a dead declaration — zero importers
 * exercising it as a manifest, zero test asserting real Target-directed code
 * agreed with it — the exact "a contract asserted in prose but never checked
 * at runtime" failure mode #3720 diagnoses. This suite:
 *
 *   1. Statically scans the known Target-label-writing source sites
 *      (`scripts/autopilot/collect-state.sh`'s `TARGET_*_LABEL` shell
 *      assignments, the two `hydra-target-*-emit.ts` runners' `*_LABEL`
 *      constants) and asserts every literal they reference is present in
 *      {@link TARGET_BOARD_LABELS}. This is network-free — it never calls
 *      `gh api .../labels` (rate-limit-fragile while autopilot is running) —
 *      a deterministic CODE-vs-MANIFEST check, not MANIFEST-vs-LIVE-REPO.
 *   2. Pins the four labels the issue's audit found genuinely written/read on
 *      the Target repo but missing from the manifest (`cleanup-scan`,
 *      `design-qa`, `ubiquitous-language`, `skip-changelog`).
 *   3. Pins the exclusion of the two cruft labels the issue's own mitigation
 *      created on the live Target repo (`queued` — a category error, the
 *      retired Redis LANE name mistaken for a label; `architecture-scan` —
 *      zero Target-directed references, orch-only).
 *   4. Regression-guards the bogus `queued` remove-label reference in
 *      `hydra-target-sweep.md` that made the category error succeed silently.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  TARGET_BOARD_LABELS,
  TARGET_SPECIFIC_LABELS,
} from "../src/target-board-labels.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");

function readRepoFile(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), "utf-8");
}

const MANIFEST_VALUES = new Set(Object.values(TARGET_BOARD_LABELS) as string[]);

/**
 * `TARGET_..._LABEL="value"` shell assignments — the naming convention that
 * marks a Target-directed label literal in collect-state.sh. The sibling
 * `ARCH_SCAN_LABEL` / `CLEANUP_SCAN_LABEL` (orch-scoped, no `TARGET_` prefix)
 * are deliberately NOT matched — they count orchestrator-repo issues.
 */
const SHELL_TARGET_LABEL = /^TARGET_[A-Z0-9_]*_LABEL="([a-z][a-z0-9-]*)"/gm;

function extractShellTargetLabels(text: string): string[] {
  return [...text.matchAll(SHELL_TARGET_LABEL)].map((m) => m[1]);
}

/** `export const X_LABEL = "value";` TS constants. */
const TS_LABEL_CONST = /export const [A-Z0-9_]+_LABEL\s*=\s*"([a-z][a-z0-9-]*)"/g;

function extractTsLabelConsts(text: string): string[] {
  return [...text.matchAll(TS_LABEL_CONST)].map((m) => m[1]);
}

describe("Target board-label manifest drift guard (issue #3720)", () => {
  test("collect-state.sh's TARGET_*_LABEL constants are all in the manifest", () => {
    const found = extractShellTargetLabels(
      readRepoFile("scripts/autopilot/collect-state.sh"),
    );
    assert.ok(
      found.length >= 3,
      `expected to find at least 3 TARGET_*_LABEL assignments in collect-state.sh, found ${found.length}`,
    );
    for (const label of found) {
      assert.ok(
        MANIFEST_VALUES.has(label),
        `collect-state.sh references Target label "${label}" which is missing from TARGET_BOARD_LABELS`,
      );
    }
  });

  test("hydra-target-wire-or-retire-emit.ts's label constants are all in the manifest", () => {
    const found = extractTsLabelConsts(
      readRepoFile("scripts/ci/hydra-target-wire-or-retire-emit.ts"),
    );
    assert.ok(found.includes("wire-or-retire"), "expected WIRE_OR_RETIRE_LABEL to be found");
    assert.ok(found.includes("needs-triage"), "expected WIRE_OR_RETIRE_TRIAGE_LABEL to be found");
    for (const label of found) {
      assert.ok(
        MANIFEST_VALUES.has(label),
        `hydra-target-wire-or-retire-emit.ts references Target label "${label}" which is missing from TARGET_BOARD_LABELS`,
      );
    }
  });

  test("hydra-target-cleanup-emit.ts's label constants are all in the manifest", () => {
    const found = extractTsLabelConsts(
      readRepoFile("scripts/ci/hydra-target-cleanup-emit.ts"),
    );
    assert.ok(found.includes("cleanup-scan"), "expected CLEANUP_SCAN_LABEL to be found");
    for (const label of found) {
      assert.ok(
        MANIFEST_VALUES.has(label),
        `hydra-target-cleanup-emit.ts references Target label "${label}" which is missing from TARGET_BOARD_LABELS`,
      );
    }
  });

  test("manifest carries the four labels the issue's audit found missing", () => {
    assert.equal(TARGET_SPECIFIC_LABELS.cleanup_scan, "cleanup-scan");
    assert.equal(TARGET_SPECIFIC_LABELS.design_qa, "design-qa");
    assert.equal(
      TARGET_SPECIFIC_LABELS.ubiquitous_language,
      "ubiquitous-language",
    );
    assert.equal(TARGET_SPECIFIC_LABELS.skip_changelog, "skip-changelog");
  });

  test("manifest excludes the two cruft labels the issue's mitigation created", () => {
    assert.equal(
      MANIFEST_VALUES.has("queued"),
      false,
      "'queued' is a retired Redis lane name mistaken for a label — never add it",
    );
    assert.equal(
      MANIFEST_VALUES.has("architecture-scan"),
      false,
      "architecture-scan has zero Target-directed references — it is orch-only",
    );
  });

  test("hydra-target-sweep.md's remove-label loop no longer treats 'queued' as a label (regression)", () => {
    const doc = readRepoFile("docs/operator-playbooks/hydra-target-sweep.md");
    const loopLine = doc
      .split("\n")
      .find((l) => l.includes("for L in ready-for-agent"));
    assert.ok(
      loopLine,
      "expected to find the remove-label loop line in hydra-target-sweep.md",
    );
    assert.doesNotMatch(
      loopLine!,
      /\bqueued\b/,
      "the remove-label loop must not treat the retired 'queued' lane name as a label again",
    );
  });

  test("docs that reference ubiquitous-language / skip-changelog / design-qa cite labels present in the manifest", () => {
    const buildDoc = readRepoFile("docs/operator-playbooks/hydra-target-build.md");
    assert.match(buildDoc, /`ubiquitous-language`/);
    assert.ok(MANIFEST_VALUES.has("ubiquitous-language"));
    assert.match(buildDoc, /`skip-changelog`/);
    assert.ok(MANIFEST_VALUES.has("skip-changelog"));

    const designQaDoc = readRepoFile("docs/operator-playbooks/hydra-design-qa.md");
    assert.match(designQaDoc, /`design-qa`/);
    assert.ok(MANIFEST_VALUES.has("design-qa"));
  });
});
