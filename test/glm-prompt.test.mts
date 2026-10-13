/**
 * src/glm/prompt.ts — the GLM dev-drainer's pure authoring-prompt composer
 * (issue #4688, ADR-0040 Decision 1; epic #4681).
 *
 * Replaces the bash `compose_prompt` RESUME group that lived in
 * test/glm-drainer-loop.test.mts and adds the scope-extraction coverage the
 * bash suite never had. Pure unit tests — no processes, no Redis, no I/O —
 * so this is a new top-level describe with no lifecycle hooks.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { composePrompt, extractScopeSections } from "../src/glm/prompt.ts";

describe("src/glm/prompt.ts — extractScopeSections (port of the compose_prompt awk, issue #4688)", () => {
  test("no scope heading => empty section", () => {
    assert.equal(extractScopeSections("Just prose.\n\n## Notes\n\nfoo\n"), "");
  });

  test("in-scope only: the section is emitted, and so is the first following non-scope ## section (quirk), but not the second", () => {
    const body = "## Files in scope\n\n- x\n\n## Other\n\nsecond\n\n## Third\n\nthird\n";
    // QUIRK pinned on purpose: the awk closes the block on the SECOND
    // non-scope `##`, so the first one ("## Other") rides along. Behaviour
    // preserved by the port (ADR-0040 Decision 6); fixing it is a separate
    // change.
    assert.equal(extractScopeSections(body), "## Files in scope\n\n- x\n\n## Other\n\nsecond");
  });

  test("in + out of scope: both sections emitted, then the first trailing non-scope section (quirk)", () => {
    const body =
      "intro\n\n## Files in scope\n\n- `a.ts`\n\n## Files out of scope\n\n- `b.ts`\n\n## Notes\n\nfoo\n\n## More\n\nbar\n";
    assert.equal(
      extractScopeSections(body),
      "## Files in scope\n\n- `a.ts`\n\n## Files out of scope\n\n- `b.ts`\n\n## Notes\n\nfoo",
    );
  });

  test("an issue body whose scope block is last is emitted whole, trailing newlines trimmed (bash $(...) parity)", () => {
    assert.equal(extractScopeSections("## Files in scope\n\n- a\n- b\n\n\n"), "## Files in scope\n\n- a\n- b");
  });
});

describe("src/glm/prompt.ts — composePrompt (issue #4688 INV-5)", () => {
  const body = "## Files in scope\n\n- `src/a.ts`\n\n## Files out of scope\n\n- `src/b.ts`\n";

  test("fresh dispatch: command header, fence disclosure, scope contract and the issue's scope sections; no RESUME paragraph", () => {
    const p = composePrompt(77, body, "", "");
    assert.match(p, /^\/hydra-dev 77\n\n---\n/);
    assert.match(p, /`gh pr create` — a supervising loop opens the PR for you/);
    assert.match(p, /## SCOPE CONTRACT — issue body is authoritative/);
    assert.match(p, /For reference, the issue's own scope section\(s\):\n\n## Files in scope\n\n- `src\/a\.ts`/);
    assert.ok(p.endsWith("- `src/b.ts`\n"), "the prompt ends with the scope sections and one newline");
    assert.doesNotMatch(p, /## RESUME/);
  });

  test("resume dispatch: the RESUME paragraph names the branch, the commit count and the pr-body-first instruction", () => {
    const p = composePrompt(77, body, "worktree-agent-glm-77-1790000000", 2);
    assert.match(p, /## RESUME — a prior drainer session on this issue was cut off by the timeout/);
    assert.match(
      p,
      /after committing and pushing 2 commit\(s\) on this\nvery branch \(worktree-agent-glm-77-1790000000\), and no PR was opened for it/,
    );
    assert.match(p, /Write the \.glm-drainer-pr-body\.md file FIRST, before touching code/);
  });

  test("resume with an unknown commit count substitutes 'at least one'", () => {
    for (const commits of ["", null, undefined] as const) {
      const p = composePrompt(77, body, "worktree-agent-glm-77-1", commits);
      assert.match(p, /after committing and pushing at least one commit\(s\) on this/);
    }
  });

  test("the RESUME paragraph is present iff resumeBranch is non-empty", () => {
    assert.doesNotMatch(composePrompt(1, body, null, 5), /## RESUME/);
    assert.doesNotMatch(composePrompt(1, body, undefined, 5), /## RESUME/);
    assert.match(composePrompt(1, body, "b", 5), /## RESUME/);
  });

  test("never throws on a non-string body", () => {
    assert.doesNotThrow(() => composePrompt(1, undefined as unknown as string, "", ""));
  });
});
