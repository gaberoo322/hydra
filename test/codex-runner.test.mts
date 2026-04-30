import test from "node:test";
import assert from "node:assert/strict";

import { MODEL_TIERS, buildCodexArgs, composePrompt } from "../src/codex-runner.ts";

test("composePrompt includes personality, workspace, task prompt, and feedback", () => {
  const prompt = composePrompt({
    prompt: "Implement the fix.",
    systemPrompt: "# Builder\nReturn JSON.",
    feedback: "- Keep tests small",
    workDir: "/tmp/project",
  });

  assert.match(prompt, /## Personality File/);
  assert.match(prompt, /# Builder/);
  assert.match(prompt, /## Workspace/);
  assert.match(prompt, /Primary workspace: \/tmp\/project/);
  assert.match(prompt, /Implement the fix\./);
  assert.match(prompt, /## Human Feedback/);
  assert.match(prompt, /Keep tests small/);
});

test("buildCodexArgs produces correct exec command with model and workspace", () => {
  const args = buildCodexArgs({
    prompt: "Do the work",
    model: MODEL_TIERS.codex,
    workDir: "/repo",
  });

  assert.deepEqual(args, [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "--model", MODEL_TIERS.codex,
    "--cd", "/repo",
    "Do the work",
  ]);
});
