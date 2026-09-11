/**
 * Regression test for issue #4220 — the `untriaged_orphans` predicate omits
 * `needs-dev-resume`, so the #3866 dev-stall backstop instantly self-triggers
 * a `sweep_orch` that fights the resume queue.
 *
 * `scripts/autopilot/collect-state.sh` counts `untriaged_orphans` as open
 * issues carrying NONE of an exclusion label set. `needs-dev-resume` was not
 * in that set — but it is exactly the label `reap.py`'s
 * `_handle_dev_orch_stall` (issue #3866, `DEV_RESUME_LABEL` in
 * `scripts/autopilot/reap_stall.py`) writes when a `dev_orch` completion opens
 * no PR: the anchor is relabelled `ready-for-agent`/`in-progress` →
 * `needs-dev-resume` and a resume record is queued on
 * `state.dev_resume_pending`, which decide.py's dev_orch selector drains as a
 * PINNED dispatch independent of `orch_work_available`. So the moment the
 * backstop fires, the anchor became an "untriaged orphan" by this predicate
 * (observed live: run 9b671faa, 2026-08-25, issue #3870 — the relabel moved
 * `untriaged_orphans` 0 → 1 on the very next tick and #3870 was the sole
 * match). `untriaged_orphans_orch` is a secondary trigger for `sweep_orch`,
 * whose verdict would relabel the anchor into some other lane — undoing the
 * very state the resume path depends on while `dev_resume_pending` still
 * holds a record pinning a dispatch to it. Two mechanisms, opposite
 * directions, on the same issue.
 *
 * `needs-dev-resume` is a legitimate in-flight lane, not an absence of
 * triage — the same category as `needs-tickets` (#3817) and `hitl-grill`
 * (#4025), both already excluded for exactly this reason. The fix adds it to
 * the exclusion array.
 *
 * These cases run the COMMITTED jq filter through real `jq` (extracted
 * verbatim from the script — the #3728/#3817/#4025/#4096 precedent), NOT a
 * TypeScript re-derivation. Both directions of the predicate are pinned so a
 * partial regression cannot slip through: the label must be excluded AND the
 * orphan detector's actual target (a genuinely label-less / miscategorised
 * issue) must still be counted.
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "autopilot", "collect-state.sh");

const SRC = readFileSync(SCRIPT, "utf-8");

/** Extract the committed untriaged_orphans jq filter verbatim from the script
 *  (same extractor shape as autopilot-collect-state-signals.test.mts). */
function extractFilter(): string {
  const start = SRC.indexOf('echo -n "untriaged_orphans="');
  assert.ok(start >= 0, "untriaged_orphans emitter missing from collect-state.sh");
  const jqOpen = SRC.indexOf("--jq '", start);
  assert.ok(jqOpen >= 0, "untriaged_orphans gh read missing its --jq filter");
  const filterStart = jqOpen + "--jq '".length;
  const filterEnd = SRC.indexOf("'", filterStart);
  assert.ok(filterEnd >= 0, "untriaged_orphans --jq filter is never closed");
  return SRC.slice(filterStart, filterEnd);
}

/** Run the committed filter against synthetic issues through real jq. */
function count(issues: readonly { labels: string[] }[]): string {
  const input = JSON.stringify(
    issues.map((i) => ({ labels: i.labels.map((name) => ({ name })) })),
  );
  const r = spawnSync("jq", [extractFilter()], { input, encoding: "utf-8" });
  assert.equal(r.status, 0, `untriaged_orphans jq failed: ${r.stderr}`);
  return (r.stdout ?? "").trim();
}

describe("collect-state.sh untriaged_orphans excludes needs-dev-resume (#4220)", () => {
  test("headline: a needs-dev-resume-only issue is NOT an untriaged orphan", () => {
    // The exact post-backstop state: reap.py's _handle_dev_orch_stall swaps
    // ready-for-agent/in-progress away, so needs-dev-resume is the ONLY
    // lifecycle label left. The dev_orch selector's dev_resume_pending drain
    // (decide.py, issue #3866) owns this issue — counting it as an orphan
    // would dispatch sweep_orch to relabel it out from under the queued
    // resume.
    assert.equal(
      count([{ labels: ["needs-dev-resume"] }]),
      "0",
      "needs-dev-resume marks an issue with a resume record queued on state.dev_resume_pending — it is tracked in-flight state, not an absence of triage",
    );
  });

  test("needs-dev-resume survives alongside non-lifecycle tags (the #3870 shape)", () => {
    // The live repro's realistic composite: the stalled anchor keeps any
    // modifier/category tags it carried (e.g. glm-eligible) — none of which
    // is a lifecycle label, so the exclusion must hold via needs-dev-resume
    // itself.
    assert.equal(
      count([{ labels: ["needs-dev-resume", "glm-eligible"] }]),
      "0",
    );
  });

  test("backstop intact: a genuinely label-less issue IS still an orphan", () => {
    // The narrowing must not weaken the detector's actual target: an issue
    // with genuinely NO labels matches neither the exclusion set nor the
    // wayfinder prefix, so it stays counted.
    assert.equal(count([{ labels: [] }]), "1");
  });

  test("backstop intact: a meta-friction-only issue IS still an orphan (motivating example)", () => {
    assert.equal(count([{ labels: ["meta-friction"] }]), "1");
  });

  test("backstop intact: a wayfinder-prefixed issue stays excluded (prefix family, #3728)", () => {
    assert.equal(count([{ labels: ["wayfinder:map"] }]), "0");
  });

  test("sibling lanes unchanged: needs-tickets alone stays excluded (#3817)", () => {
    assert.equal(count([{ labels: ["needs-tickets"] }]), "0");
  });

  test("sibling lanes unchanged: hitl-grill alone stays excluded (#4025)", () => {
    assert.equal(count([{ labels: ["hitl-grill"] }]), "0");
  });

  test("sibling lanes unchanged: needs-design-concept alone stays an orphan (#4096)", () => {
    // #4096 deliberately REMOVED needs-design-concept from the exclusion
    // array (unreachable-lane recovery via sweep). #4220 must not quietly
    // widen the array back past that narrowing.
    assert.equal(count([{ labels: ["needs-design-concept"] }]), "1");
  });

  test("mixed board: the resume-pending anchor is excluded, genuine orphans counted", () => {
    assert.equal(
      count([
        { labels: ["needs-dev-resume"] }, // excluded (#4220 — resume queued)
        { labels: ["needs-tickets"] }, // excluded (#3817)
        { labels: ["needs-design-concept", "ready-for-agent"] }, // excluded (parked-and-routed, #4096)
        { labels: ["meta-friction"] }, // genuine orphan
        { labels: [] }, // genuine orphan
      ]),
      "2",
    );
  });

  test("drift guard: the committed exclusion array lists needs-dev-resume", () => {
    // If a future edit drops the label from the jq filter's exclusion array
    // (e.g. by regenerating the list from a taxonomy that lacks it), this
    // fails loudly here instead of silently re-opening the #4220
    // sweep-vs-resume fight in production. The array lives inside the
    // extracted filter itself, so this asserts the committed text.
    assert.ok(
      extractFilter().includes('"needs-dev-resume"'),
      "the untriaged_orphans exclusion array must contain \"needs-dev-resume\" (issue #4220)",
    );
  });
});
