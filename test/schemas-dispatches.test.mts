/**
 * Regression tests for the subagent-dispatch capture boundary (issue #692).
 *
 * Two pure surfaces, no Express / no Redis:
 *
 *   1. `src/schemas/dispatches.ts` — the zod boundary schemas. Pins the
 *      accepted shape (the schema-validation 400 case for the route is
 *      exercised by asserting `safeParse` rejects the bad bodies; the route
 *      just echoes `result.error.issues`).
 *   2. The sentinel contract — the hidden `<!-- hydra-dispatch v1 ... -->`
 *      marker. We replicate the field-extraction regex the SessionStart hook
 *      (`scripts/hooks/session-start-capture.sh`) uses and run it against
 *      three fixture first-messages: WITH a well-formed sentinel, WITHOUT one,
 *      and with a MALFORMED one (missing dispatchId). This pins the
 *      with/without/malformed branches the hook keys on.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  SubagentDispatchPostBodySchema,
  SubagentDispatchStepPatchBodySchema,
} from "../src/schemas/dispatches.ts";

// ---------------------------------------------------------------------------
// POST body schema
// ---------------------------------------------------------------------------

describe("SubagentDispatchPostBodySchema — happy path", () => {
  test("accepts the minimum valid body (sessionId + skill + dispatchId)", () => {
    const result = SubagentDispatchPostBodySchema.safeParse({
      sessionId: "sess-abc",
      skill: "hydra-dev",
      dispatchId: "worktree-agent-deadbeef-t1-dev_orch",
    });
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.sessionId, "sess-abc");
      assert.equal(result.data.skill, "hydra-dev");
      assert.equal(result.data.runId, undefined);
    }
  });

  test("accepts the full body including optional runId / refs", () => {
    const result = SubagentDispatchPostBodySchema.safeParse({
      sessionId: "sess-abc",
      skill: "hydra-dev",
      dispatchId: "wt-1",
      runId: "run-123",
      startedAt: "2026-05-28T10:00:00.000Z",
      projectDir: "/dev/shm/wt",
      currentStep: "research",
      issueRef: "#692",
      prRef: "#700",
    });
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.runId, "run-123");
      assert.equal(result.data.issueRef, "#692");
    }
  });

  test("trims surrounding whitespace from required handles", () => {
    const result = SubagentDispatchPostBodySchema.safeParse({
      sessionId: "  sess-abc  ",
      skill: "  hydra-dev  ",
      dispatchId: "  wt-1  ",
    });
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.sessionId, "sess-abc");
      assert.equal(result.data.skill, "hydra-dev");
      assert.equal(result.data.dispatchId, "wt-1");
    }
  });
});

describe("SubagentDispatchPostBodySchema — rejection cases (the 400 surface)", () => {
  test("rejects empty body — missing required fields", () => {
    const result = SubagentDispatchPostBodySchema.safeParse({});
    assert.equal(result.success, false);
    if (!result.success) {
      assert.ok(Array.isArray(result.error.issues));
      const paths = result.error.issues.flatMap((i) => i.path);
      assert.ok(paths.includes("sessionId"));
      assert.ok(paths.includes("skill"));
      assert.ok(paths.includes("dispatchId"));
    }
  });

  test("rejects whitespace-only sessionId", () => {
    const result = SubagentDispatchPostBodySchema.safeParse({
      sessionId: "   ",
      skill: "hydra-dev",
      dispatchId: "wt-1",
    });
    assert.equal(result.success, false);
  });

  test("rejects non-string skill", () => {
    const result = SubagentDispatchPostBodySchema.safeParse({
      sessionId: "sess-abc",
      skill: 42,
      dispatchId: "wt-1",
    });
    assert.equal(result.success, false);
  });

  test("rejects unknown top-level fields (strict mode)", () => {
    const result = SubagentDispatchPostBodySchema.safeParse({
      sessionId: "sess-abc",
      skill: "hydra-dev",
      dispatchId: "wt-1",
      bogus: "x",
    });
    assert.equal(result.success, false);
  });

  test("error.issues[] carries { path, message } for the gateway to echo", () => {
    const result = SubagentDispatchPostBodySchema.safeParse({ skill: "hydra-dev" });
    assert.equal(result.success, false);
    if (!result.success) {
      for (const issue of result.error.issues) {
        assert.ok(Array.isArray(issue.path));
        assert.equal(typeof issue.message, "string");
      }
    }
  });
});

describe("SubagentDispatchStepPatchBodySchema", () => {
  test("accepts a non-empty currentStep", () => {
    const result = SubagentDispatchStepPatchBodySchema.safeParse({ currentStep: "verifying" });
    assert.equal(result.success, true);
  });

  test("accepts an empty currentStep (clearing the step is legitimate)", () => {
    const result = SubagentDispatchStepPatchBodySchema.safeParse({ currentStep: "" });
    assert.equal(result.success, true);
  });

  test("rejects a missing currentStep", () => {
    const result = SubagentDispatchStepPatchBodySchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("rejects unknown fields (strict)", () => {
    const result = SubagentDispatchStepPatchBodySchema.safeParse({
      currentStep: "x",
      extra: 1,
    });
    assert.equal(result.success, false);
  });
});

// ---------------------------------------------------------------------------
// Sentinel extraction contract — replicates the hook's field-extraction.
// ---------------------------------------------------------------------------

/**
 * Mirror of the field-extraction the SessionStart hook performs. The hook
 * does this in bash (grep for the sentinel line, then per-field grep), but
 * the regex contract is what matters: this JS copy pins the with/without/
 * malformed branches so a future hook rewrite has a spec to match.
 */
function extractSentinel(
  firstUserMessage: string,
): { skill: string; dispatchId: string; runId?: string } | null {
  const line = firstUserMessage
    .split("\n")
    .find((l) => /<!--\s*hydra-dispatch\s+v1\s/.test(l));
  if (!line) return null;
  const field = (name: string): string | undefined => {
    const m = line.match(new RegExp(`${name}=([^\\s>]+)`));
    return m ? m[1] : undefined;
  };
  const skill = field("skill");
  const dispatchId = field("dispatchId");
  if (!skill || !dispatchId) return null; // malformed — hook skips these
  const runId = field("runId");
  const out: { skill: string; dispatchId: string; runId?: string } = { skill, dispatchId };
  if (runId) out.runId = runId;
  return out;
}

describe("dispatch sentinel — three fixture first-messages", () => {
  test("WITH a well-formed sentinel (autopilot run, runId present)", () => {
    const msg = [
      "<!-- hydra-dispatch v1 skill=hydra-dev dispatchId=worktree-agent-deadbeef-t3-dev_orch runId=abcd-1234 -->",
      "",
      "## CRITICAL SAFETY RULE — READ FIRST",
      "Build issue #692...",
    ].join("\n");
    const got = extractSentinel(msg);
    assert.deepEqual(got, {
      skill: "hydra-dev",
      dispatchId: "worktree-agent-deadbeef-t3-dev_orch",
      runId: "abcd-1234",
    });
  });

  test("WITH a well-formed sentinel but no runId (operator launch)", () => {
    const msg =
      "<!-- hydra-dispatch v1 skill=hydra-grill dispatchId=wt-local-t0-grill -->\nGrill issue #690";
    const got = extractSentinel(msg);
    assert.deepEqual(got, { skill: "hydra-grill", dispatchId: "wt-local-t0-grill" });
    assert.equal(got?.runId, undefined);
  });

  test("WITHOUT any sentinel (interactive operator session) → null (hook no-ops)", () => {
    const msg = "Hey Claude, can you help me debug the scheduler?";
    assert.equal(extractSentinel(msg), null);
  });

  test("MALFORMED sentinel (missing dispatchId) → null (hook skips)", () => {
    const msg = "<!-- hydra-dispatch v1 skill=hydra-dev -->\nsome task";
    assert.equal(extractSentinel(msg), null);
  });
});
