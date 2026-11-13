/**
 * Drift guard (issue #5497): the Target playbooks ship via PR only, never touch
 * the serving tree, file work on the Target board, and carry no dead feedback
 * loop, retired direction files or retired Redis-backlog references.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "docs", "operator-playbooks");
const FILES = [
  "hydra-target-incident.md",
  "hydra-target-retro.md",
  "hydra-target-research.md",
  "hydra-target-build.md",
  "_fragments/hydra-target-build-merge-flow.md",
];
const read = (f: string): string => readFileSync(join(ROOT, f), "utf8");

const FORBIDDEN = [
  "git push origin main",
  "systemctl --user restart",
  "/merge/lock",
  "/merge/unlock",
  "git merge ",
  "target-backlog",
  "config/feedback/",
  "reframe-queue",
  "src/backlog/",
  "config/direction/goals.md",
  "config/direction/roadmap.md",
  "NOT deleted",
];

for (const f of FILES) {
  test(`${f} carries no forbidden retired or direct-ship literal`, () => {
    const body = read(f);
    for (const lit of FORBIDDEN) {
      // The literal is forbidden everywhere; prose bans use other wording.
      assert.ok(!body.includes(lit), `${f} must not contain "${lit}"`);
    }
  });
}

for (const f of ["hydra-target-incident.md", "hydra-target-retro.md"]) {
  test(`${f} files Target work on the Target board`, () => {
    const body = read(f);
    assert.ok(body.includes('--repo "$TARGET_GH_REPO"') || body.includes("repo:$TARGET_GH_REPO"));
    assert.ok(!body.includes("--repo gaberoo322/hydra"), `${f} must not file on the Orchestrator repo`);
  });
}

test("incident remediation ends in a PR against the Target main", () => {
  const body = read("hydra-target-incident.md");
  assert.ok(body.includes('gh pr create --repo "$TARGET_GH_REPO" --base main'));
});

test("retro reads its failure signal from the reframe label board", () => {
  assert.ok(read("hydra-target-retro.md").includes("labels=reframe"));
});

test("incident verify commands run from the app-dir equivalent in the worktree", () => {
  const body = read("hydra-target-incident.md");
  assert.ok(body.includes("$APP_REL\" && eval"));
});
