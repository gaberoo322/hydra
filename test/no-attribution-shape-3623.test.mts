/**
 * Issue #3623 — `no-attribution` shape diagnostic.
 *
 * The #3602 sub-bucket split already separates the `unclassified` sentinel into
 * `fixable` (a second decode source recovers a lane) vs `no-attribution`
 * (structurally undecodable — inherent harness noise under the #2822 never-guess
 * invariant). But `no-attribution` was a single OPAQUE count: an operator asking
 * "WHY are these 14 cycles undecodable?" had to fetch each cycleId/branch and
 * re-derive the shape by hand (a bare-UUID merge-watch first-write behaves
 * differently from an `autopilot-<hash>-t{N}` relay id or a bare
 * `worktree-agent-<longhash>` harness branch — but the bucket erased that).
 *
 * `classifyNoAttributionShape` labels each no-attribution cycle with the STABLE
 * kebab-case shape token that explains its undecodability, so the residue is
 * self-documenting — the issue's "document the undecodable shape" success
 * criterion. It is PURE (string inputs only, zero Redis/async) and NEVER guesses
 * a lane — it only names the structural reason a cycle carries no class token.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { classifyNoAttributionShape } from "../src/autopilot/anchor-type.ts";

describe("classifyNoAttributionShape — names the undecodable structural shape (#3623)", () => {
  test("a bare-UUID cycleId with no branch is `bare-uuid` (merge-watch first-write)", () => {
    // The dominant residual: a merge-status enrichment / cycle-merge-reconcile
    // first-write keyed on a bare UUID with no worktreeBranch to decode.
    assert.equal(
      classifyNoAttributionShape("72d9770f-40b9-41b9-bea4-59c93f1e2ebe", undefined),
      "bare-uuid",
    );
  });

  test("an `autopilot-<hash>-t{N}` cycleId is `autopilot-turn` (no slot token)", () => {
    // The autopilot's own turn-scoped cycleId carries a `-t{N}` turn fence but
    // NO trailing `-<slot>` class token, so it is undecodable by design.
    assert.equal(
      classifyNoAttributionShape("autopilot-2b5a625c-t2", undefined),
      "autopilot-turn",
    );
    assert.equal(
      classifyNoAttributionShape("autopilot-2b5a625c-t1", undefined),
      "autopilot-turn",
    );
  });

  test("a bare `worktree-agent-<longhash>` (cycleId or branch) is `harness-branch`", () => {
    // The harness's own Agent-tool branch name — no `-t{N}-<slot>` fence. The
    // #2822 invariant deliberately excludes it. This is the shape whether the
    // longhash arrives as the cycleId itself or as the stored worktreeBranch.
    assert.equal(
      classifyNoAttributionShape("worktree-agent-a0f1d230dcdda8f78", undefined),
      "harness-branch",
    );
    assert.equal(
      classifyNoAttributionShape(
        "afa22ef1-7e11-41e6-a78f-c725b46c7870",
        "worktree-agent-2b5a625cdeadbeefcafef00dba5eba11",
      ),
      "harness-branch",
    );
  });

  test("a descriptive branch (no class token) is `descriptive-branch`", () => {
    // A human/feature branch like `feat/3605-...` or `vlm-claude-cli-shim-3542`
    // carries an issue number but no dispatch-class token — undecodable.
    assert.equal(
      classifyNoAttributionShape(
        "72d9770f-40b9-41b9-bea4-59c93f1e2ebe",
        "feat/3605-extract-prune-design-concept-index",
      ),
      "descriptive-branch",
    );
    assert.equal(
      classifyNoAttributionShape(
        "4a2fc33e-9478-49dc-88cd-69dd393787dd",
        "vlm-claude-cli-shim-3542",
      ),
      "descriptive-branch",
    );
  });

  test("an unrecognised shape falls back to the honest `unknown-shape` token", () => {
    // Never guess: a cycleId that fits no known undecodable pattern still gets a
    // stable, non-empty token so the caller never has to reason about undefined.
    assert.equal(classifyNoAttributionShape("", undefined), "unknown-shape");
    assert.equal(
      classifyNoAttributionShape("something-weird-and-novel", undefined),
      "unknown-shape",
    );
  });

  test("the branch shape takes precedence when the cycleId alone is a bare UUID", () => {
    // A bare-UUID cycleId WITH a stored branch is more precisely explained by the
    // branch shape (harness-branch / descriptive-branch) than the generic
    // bare-uuid, so the branch is consulted first when present.
    assert.equal(
      classifyNoAttributionShape(
        "72d9770f-40b9-41b9-bea4-59c93f1e2ebe",
        "worktree-agent-a0f1d230dcdda8f78",
      ),
      "harness-branch",
    );
  });
});
