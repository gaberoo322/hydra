# hydra-target-build — Inline-mode contract

Read this file when Step 2's mode detection finds no `Agent`/`Task` spawn tool.
This session then runs the child prompt itself, under these four rules:

1. **Declare the mode loudly.** Before Step 0, state in the session output: `INLINE MODE: no Agent/Task spawn tool in this session; executing the child prompt inline under the inline-mode contract.` Report `Mode | inline` in the Step 10 summary table.
2. **Friction-log the occurrence at detection time** (idempotent on `(skill, cue)`; best-effort — a POST failure never blocks the build):
   ```bash
   hydra raw POST /memory/subagent-friction "{
     \"skill\":\"hydra-target-build\",
     \"cue\":\"no-agent-spawn-tool-run-inline\",
     \"workaround\":\"declared inline mode per the inline-mode contract; applied context-budget discipline\",
     \"context\":\"autopilot dispatch session without Agent/Task spawn tool\",
     \"cycleId\":\"inline-$(date -u +%Y-%m-%d-%H%M)\"
   }"
   ```
3. **Context-budget discipline.** The one session must survive every later step (verify, merge, deploy, state sync), so the inline build spends context as if the saturation it causes lands on itself — because it does:
   - Targeted reads only: read specific files/line ranges you immediately need; never dump large files or broad directory listings into context.
   - Filter command output at the source (`--jq`, `grep`, `head`); never page raw test-suite or journal output into context — capture to a file and grep the failure lines.
   - Cap task complexity at **standard** (Step 3): a **complex** (>5 files) plan MUST be split and re-queued, never built inline.
   - Skip optional exploration (broad greps, archaeology beyond Step 0.5's drift check) unless a verification failure forces it.
   - One remediation pass on a verification failure, then abandon the branch — tighter than delegated mode's "2 failed fixes" rule in Step 6.
4. **Everything else is unchanged.** All child-prompt steps (0–10), safety rules, gates, and state sync apply verbatim; "the child" simply means this session.
