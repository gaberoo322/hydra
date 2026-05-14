/**
 * Regression test for issue #406 — hydra-dev must consult the live
 * `/api/tier` endpoint instead of self-classifying by path patterns.
 *
 * Background:
 *   Autopilot run 2026-05-14 produced PR #404 with a self-asserted
 *   "Tier 2" claim in its body. The live classifier at /api/tier
 *   returned Tier 3 for the same file list (because the PR modified
 *   `scripts/ci/scope-check.ts`, a Tier-3 path). The mismatch wasted
 *   a QA cycle and left misleading audit history.
 *
 * Fix:
 *   The hydra-dev playbook now instructs the worktree subagent to
 *   call `GET /api/tier?files=<csv>` and use the returned tier
 *   verbatim. If the endpoint is unreachable, the PR is labelled
 *   `Tier: unknown` and `needs-triage` rather than guessing.
 *
 * This test is a grep-style lint on the playbook. The playbook is
 * the source of truth that `scripts/sync-skills.sh` regenerates into
 * `~/.claude/skills/hydra-dev/SKILL.md` on operator machines, so
 * pinning the playbook's tier-API references also pins what gets
 * synced downstream.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLAYBOOK_PATH = resolve(__dirname, "..", "docs", "operator-playbooks", "hydra-dev.md");
const playbook = readFileSync(PLAYBOOK_PATH, "utf8");

describe("hydra-dev playbook — live tier classifier (issue #406)", () => {
  test("references the live /api/tier endpoint", () => {
    assert.ok(
      /\/api\/tier/.test(playbook),
      "Playbook must reference /api/tier so the subagent calls the live classifier instead of guessing from path patterns",
    );
  });

  test("documents the GET shape with comma-separated files query param", () => {
    // The endpoint at src/api/misc.ts is GET, not POST. An earlier draft
    // described `curl -d @<file>`; a regression to that shape will 400.
    assert.ok(
      /GET[^\n]*\/api\/tier/.test(playbook) ||
        /curl[^\n]*\/api\/tier\?files=/.test(playbook),
      "Playbook must document GET /api/tier?files=... (the live endpoint rejects POST with JSON body)",
    );
    assert.ok(
      /files=/.test(playbook),
      "Playbook must show the `files=` query parameter so the subagent constructs a valid URL",
    );
  });

  test("instructs the subagent to put a `Tier: <0|1|2|3>` line in the PR body", () => {
    // Must mention a Tier line in the PR body and the four valid integer
    // values so a future edit can't silently soften the contract.
    assert.ok(
      /Tier:/.test(playbook),
      "Playbook must reference a `Tier:` PR-body line",
    );
    assert.ok(
      /0\|1\|2\|3|0, ?1, ?2, ?3|Tier 0[\s\S]*Tier 3/.test(playbook),
      "Playbook must enumerate the valid tier values (0|1|2|3) so the contract is unambiguous",
    );
  });

  test("specifies the unreachable-classifier fallback (Tier: unknown + needs-triage)", () => {
    assert.ok(
      /unknown/i.test(playbook) && /needs-triage/.test(playbook),
      "Playbook must instruct the subagent to mark `Tier: unknown` and add the `needs-triage` label when /api/tier is unreachable, rather than falling back to a guess",
    );
  });

  test("explicitly forbids self-classification by path patterns", () => {
    // The whole point of #406 is that path-pattern self-classification
    // is unreliable. The playbook must say so loudly enough that a
    // future edit can't quietly re-introduce it.
    assert.ok(
      /(do not|don't|never|MUST NOT|not (?:infer|self-classify|guess))/i.test(playbook) &&
        /(path pattern|self-classif|infer tier|guess)/i.test(playbook),
      "Playbook must explicitly forbid path-pattern self-classification (the failure mode that motivated issue #406)",
    );
  });

  test("references issue #406 so the rationale is discoverable", () => {
    assert.ok(
      /#406|issue 406/.test(playbook),
      "Playbook should cite issue #406 in the tier-classification section for future archaeology",
    );
  });
});
