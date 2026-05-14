/**
 * Regression test for issue #412 — dev_orch gate uses a fresh PR signal,
 * not the stale `in-progress` label.
 *
 * The /hydra-autopilot Phase 4 `dev_orch` rule used to gate on
 * `in_progress == 0`. That signal is stored in a GitHub label and can
 * survive a dispatch that died before producing a PR — observed in
 * the 2026-05-14 autopilot session where issue #377 carried a stale
 * `in_progress` label all night and blocked every `dev_orch` dispatch.
 *
 * The fix replaces the label check with `active_dev_orch == 0`, a
 * collector emitted by `scripts/autopilot/collect-state.sh` that
 * counts open PRs on a hydra-dev head branch updated within the last
 * 90 minutes. The branch-prefix list MUST match the three patterns
 * hydra-dev actually creates (verified against `git branch -r` on
 * 2026-05-14):
 *
 *   - `issue-<N>-<slug>`    (most common; from the playbook prose)
 *   - `hydra-dev/<...>`     (planned future namespace)
 *   - `worktree-agent-<h>`  (Claude Agent tool isolation=worktree)
 *
 * This test pins the filter behavior by feeding constructed PR lists
 * through the same jq expression the script uses, so a future edit
 * can't silently break the gate.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "autopilot", "collect-state.sh");

// The jq filter is the load-bearing part of the collector. Extract it
// from the script so any drift in the script is caught here.
function extractJqFilter(): string {
  const src = readFileSync(SCRIPT, "utf-8");
  // The filter is the multi-line jq argument after `gh pr list ... --jq`.
  // We pull the content between the first `--jq '[` and its terminating
  // `] | length'`. The whole filter is committed verbatim in the script.
  const match = src.match(/--jq '(\[[\s\S]*?\] \| length)'/);
  assert.ok(match, "could not locate jq filter in collect-state.sh");
  return match[1];
}

function runJq(filter: string, input: unknown): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("jq", [filter], {
    input: JSON.stringify(input),
    encoding: "utf-8",
  });
  return {
    status: r.status ?? -1,
    stdout: (r.stdout ?? "").trim(),
    stderr: r.stderr ?? "",
  };
}

function iso(secondsAgo: number): string {
  // GitHub's `updatedAt` is whole-second ISO-8601 (e.g. "2026-05-14T15:30:55Z").
  // jq's fromdateiso8601 rejects fractional seconds — Date#toISOString returns
  // ms precision and would break the filter. Strip the `.NNN` segment so the
  // test fixture matches the live API shape.
  const d = new Date(Date.now() - secondsAgo * 1000);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

describe("scripts/autopilot/collect-state.sh — active_dev_orch collector (issue #412)", () => {
  const filter = extractJqFilter();

  test("stale in-progress label + no active PR → dispatch allowed (active_dev_orch=0)", () => {
    // The exact scenario from the issue #412 motivation: the live PR
    // list is empty even though some board issue carries the label.
    // The collector only looks at PRs — labels don't matter here.
    const prs: unknown[] = [];
    const r = runJq(filter, prs);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "0", "no PRs → count must be 0 (gate open)");
  });

  test("fresh PR on issue-<N> head → dispatch blocked (active_dev_orch=1)", () => {
    const prs = [
      { headRefName: "issue-412-dev-orch-gate", updatedAt: iso(60) },
    ];
    const r = runJq(filter, prs);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "1", "one fresh PR on issue- prefix → count=1 (gate closed)");
  });

  test("fresh PR on hydra-dev/ head → dispatch blocked (active_dev_orch=1)", () => {
    const prs = [
      { headRefName: "hydra-dev/some-feature", updatedAt: iso(120) },
    ];
    const r = runJq(filter, prs);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "1", "one fresh PR on hydra-dev/ prefix → count=1");
  });

  test("fresh PR on worktree-agent- head → dispatch blocked (active_dev_orch=1)", () => {
    // Claude Agent tool with isolation=worktree creates branches named
    // worktree-agent-<hash>. These are still hydra-dev work and MUST be
    // counted, otherwise the gate would dispatch a second dev_orch on
    // top of an active one — defeating the purpose of the gate.
    const prs = [
      { headRefName: "worktree-agent-ab3a8b01c3f11f366", updatedAt: iso(300) },
    ];
    const r = runJq(filter, prs);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "1", "one fresh worktree-agent PR → count=1");
  });

  test("no label + no PR → dispatch allowed (active_dev_orch=0)", () => {
    const prs: unknown[] = [];
    const r = runJq(filter, prs);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "0");
  });

  test("old PR (>90 min stale) → dispatch allowed (active_dev_orch=0)", () => {
    // 91 minutes old — past the 5400s freshness window.
    const prs = [
      { headRefName: "issue-377-stale-dev", updatedAt: iso(91 * 60) },
    ];
    const r = runJq(filter, prs);
    assert.equal(r.status, 0);
    assert.equal(
      r.stdout,
      "0",
      "PR older than 90 min must NOT count — that's the bug we're fixing",
    );
  });

  test("PR with non-hydra-dev branch prefix is ignored", () => {
    // Branches like `fix/foo` or `feat/bar` are not hydra-dev work.
    // They shouldn't gate the dev_orch slot.
    const prs = [
      { headRefName: "fix/priorities-unstick-planner-loop", updatedAt: iso(60) },
      { headRefName: "feat/issue-407-hydra-pr-rebase-skill", updatedAt: iso(60) },
    ];
    const r = runJq(filter, prs);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "0", "non-hydra-dev branches must be ignored");
  });

  test("boundary: PR exactly at 90 min is NOT counted", () => {
    // The filter is `< 5400` (strict less-than). A PR exactly at the
    // boundary should be treated as stale and not gate the slot.
    const prs = [
      { headRefName: "issue-100-foo", updatedAt: iso(5400) },
    ];
    const r = runJq(filter, prs);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "0", "PR exactly at boundary is stale (filter is < 5400)");
  });

  test("mixed fresh + stale + foreign → only fresh hydra-dev counted", () => {
    const prs = [
      { headRefName: "issue-1-fresh", updatedAt: iso(60) },           // counts
      { headRefName: "issue-2-stale", updatedAt: iso(99 * 60) },      // stale → no
      { headRefName: "hydra-dev/x", updatedAt: iso(1000) },           // counts
      { headRefName: "worktree-agent-deadbeef", updatedAt: iso(10) }, // counts
      { headRefName: "fix/foreign", updatedAt: iso(10) },             // foreign → no
    ];
    const r = runJq(filter, prs);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "3", "three fresh hydra-dev PRs out of five total");
  });

  test("collector script is executable and emits active_dev_orch line", () => {
    // Belt-and-braces: confirm the line is actually printed when the
    // script runs. We don't assert the value (it depends on live
    // GitHub state) — only that the key is present, so the playbook's
    // Phase 4 dev_orch rule can read it.
    const r = spawnSync(SCRIPT, [], { encoding: "utf-8", timeout: 30_000 });
    // Script exits non-zero in some hostile environments (no `hydra`
    // CLI on PATH, etc.); we only care about the active_dev_orch line.
    const out = (r.stdout ?? "") + (r.stderr ?? "");
    assert.match(
      out,
      /^active_dev_orch=\d+$/m,
      "collector must emit a parseable active_dev_orch=<count> line",
    );
  });
});

describe("docs/operator-playbooks/hydra-autopilot.md — dev_orch rule (issue #412)", () => {
  const playbook = readFileSync(
    join(REPO_ROOT, "docs", "operator-playbooks", "hydra-autopilot.md"),
    "utf-8",
  );

  test("Phase 4 dev_orch rule reads active_dev_orch, not in_progress", () => {
    // Match the dev_orch sub-section. We require the live-PR signal AND
    // that the legacy `in_progress == 0` phrase is gone from this rule.
    const devOrchSection = playbook.match(/#### `dev_orch`[\s\S]*?(?=####|\Z)/);
    assert.ok(devOrchSection, "dev_orch section missing from playbook");
    const body = devOrchSection[0];
    assert.match(
      body,
      /active_dev_orch == 0/,
      "dev_orch rule must reference active_dev_orch (issue #412)",
    );
    assert.doesNotMatch(
      body,
      /`in_progress == 0`/,
      "dev_orch rule must NOT still gate on `in_progress == 0` (the stale-label bug)",
    );
  });

  test("Phase 1 collector inventory mentions active_dev_orch", () => {
    // The collector list in Phase 1 prose should advertise the new key
    // so operators reading the playbook can find it.
    assert.match(
      playbook,
      /active_dev_orch/,
      "Phase 1 prose must mention active_dev_orch so operators see the new signal",
    );
  });
});
