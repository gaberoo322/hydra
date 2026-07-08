# hydra-target-build — Inline-mode contract (issue #1782)

Read this file when the mode-detection step in Step 2 finds NO Agent/Task spawn
tool. The delegated-mode path (spawn tool available) is unchanged and needs no
additional guidance beyond the main playbook body.

## Step 2: Delegate — or declare inline mode (issue #1782)

**Mode detection (mandatory, before any build work):** determine whether an `Agent`/`Task` spawn tool is actually callable in THIS session. If it is not in the loaded tool list, make exactly ONE `ToolSearch` query (e.g. `+agent spawn task`) against the deferred-tool list, then commit to a mode. Do not retry the search, and do not assume availability either way.

**Delegated mode (spawn tool available):** spawn the child with the prompt below. Pass `$task` if provided. The child returns ONLY a summary table, reporting `Mode | delegated` in its Step 10 row. This path is unchanged — builds dispatched with the spawn tool available continue to delegate normally.

**Inline mode (no spawn tool):** executing the child prompt in the parent session is permitted ONLY under this explicit contract — never as a silent fallback. Do NOT abort merely because the spawn tool is absent: the dispatch environment never grows the tool mid-session, so fail-loud here would zero Target throughput rather than reroute anywhere useful.

1. **Declare the mode loudly.** Before Step 0, state in the session output: `INLINE MODE: no Agent/Task spawn tool in this session; executing the child prompt inline under the issue #1782 contract.` Report `Mode | inline` in the Step 10 summary table.
2. **Friction-log the occurrence at detection time** (idempotent on `(skill, cue)`; best-effort — a POST failure never blocks the build):
   ```bash
   hydra raw POST /memory/subagent-friction "{
     \"skill\":\"hydra-target-build\",
     \"cue\":\"no-agent-spawn-tool-run-inline\",
     \"workaround\":\"declared inline mode per issue #1782 contract; applied context-budget discipline\",
     \"context\":\"autopilot dispatch session without Agent/Task spawn tool\",
     \"cycleId\":\"inline-$(date -u +%Y-%m-%d-%H%M)\"
   }"
   ```
3. **Context-budget discipline.** The one session must survive every later step (verify, merge, deploy, state sync), so the inline build spends context as if the saturation it causes lands on itself — because it does:
   - Targeted reads only: read specific files/line ranges you immediately need; never dump large files or broad directory listings into context.
   - Filter command output at the source (`--jq`, `grep`, `head`); never page raw `npm test` or journal output into context — capture to a file and grep the failure lines.
   - Cap task complexity at **standard** (Step 3): a **complex** (>5 files) plan MUST be split and re-queued, never built inline.
   - Skip optional exploration (broad greps, archaeology beyond Step 0.5's drift check) unless a verification failure forces it.
   - One remediation pass on a verification failure, then abandon the branch — tighter than delegated mode's "2 failed fixes" rule in Step 6.
4. **Everything else is unchanged.** All child-prompt steps (0–10), safety rules, gates, and state sync apply verbatim; "the child" simply means this session.
