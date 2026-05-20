// ---------------------------------------------------------------------------
// /api/agents — AgentStream backend (issue #531)
// ---------------------------------------------------------------------------
//
// Closes the loop on PR #528. That PR stamped a deterministic
// `worktreeBranch` correlation token onto every dispatch action emitted by
// `scripts/autopilot/decide.py`, so the dashboard's slice-4 cross-link
// (`dashboard/src/pages/Autopilot.jsx`'s "Watch stream →" button)
// generates `/agents/stream?agent=<stamped-token>` hrefs that are
// structurally well-formed. But there was no backend endpoint that resolved
// that token to anything, and no live WebSocket producer either — the
// in-process `agent:stream` WS frames the AgentStream page subscribes to
// were emitted by `src/codex-runner.ts`, which PR #400 deleted in the
// codex-removal cut-over. End-to-end: the link rendered, the navigation
// worked, the resulting page was empty.
//
// This endpoint is the missing resolver. Given a stamped branch, it walks
// the most-recent autopilot runs in reverse-chronological order, scans
// their turn ZSETs for a dispatch action whose `worktreeBranch` matches,
// and returns that action with the cycle-record join attached. A non-empty
// result confirms "yes, the orchestrator saw this dispatch get fired".
//
// Why not a Redis stream of per-dispatch frames? The dispatch fires Claude
// Code subagents as separate processes via the harness's Agent tool — the
// orchestrator never sees their token-by-token output. Until Claude Code
// exposes a sidecar streaming hook, the highest-fidelity correlation we
// can offer is the dispatch action itself (stamped by decide.py) plus the
// eventual outcome (written by `POST /autopilot/cycle-record` at Phase 6).
// That's what this endpoint returns.
//
// Schema closure: this endpoint is READ-ONLY relative to Redis. It does
// not write `hydra:autopilot:*` and does not depend on any new top-level
// fields on the run hash (slice-2 AC10 / slice-3 AC12 / slice-4 AC9
// invariant preserved). It reuses `fetchTurnsWithJoins` from
// `src/api/autopilot.ts` for the dispatch→cycle join.

import { Router } from "express";
import { redisKeys } from "../redis-keys.ts";
import { hashGetAll, zRevRange } from "../redis-adapter.ts";
import { fetchTurnsWithJoins } from "./autopilot.ts";

// How many recent runs to scan when resolving a stamped branch. The branch
// format is `worktree-agent-<runtoken>-t<turn>-<slot>` (PR #528) — once a
// run ends, its dispatched branches are stable history. A 7d TTL on the
// run hash + 50 runs/day ceiling means 350 is a comfortable upper bound;
// we cap at 64 to keep the scan O(64) on the common case (operator clicks
// "Watch stream" within the same run or the few preceding it).
const MAX_RUNS_SCANNED = 64;

// How many turns to fetch per run during the scan. The 7d TTL + token
// budget caps turns-per-run at low thousands, but the typical interactive
// case is a few dozen turns. 1000 is the soft cap that mirrors the detail
// endpoint's RUN_TURNS_MAX_FETCH approach.
const MAX_TURNS_PER_RUN = 1000;

export function createAgentsRouter() {
  const router = Router();

  // -------------------------------------------------------------------------
  // GET /agents/stream?agent=<worktreeBranch>
  //
  // Resolves a stamped `worktreeBranch` correlation token to its dispatch
  // action + cycle outcome. The dashboard's `AgentStream` page renders this
  // alongside its live WS subscription so the "Watch stream" cross-link
  // surfaces non-empty data even when the live stream has nothing to say.
  //
  // Response shape (200):
  //   {
  //     agent: "<branch>",
  //     resolved: true,
  //     runId: "<run_id>",
  //     turnN: <number>,
  //     dispatch: { type: "dispatch", worktreeBranch: "<branch>", ... },
  //     outcome: { cycleId, status, prNumber, costUsd, startedAt, completedAt }
  //              | null   // when the cycle hasn't been recorded yet
  //   }
  //
  // Response shape (404):
  //   { agent: "<branch>", resolved: false, reason: "..." }
  //
  // The unscoped form (no `?agent=`) returns 400 — historical full-stream
  // behaviour lives in the WS channel; the REST endpoint is correlation-only.
  // -------------------------------------------------------------------------
  router.get("/agents/stream", async (req, res) => {
    try {
      const agent = typeof req.query.agent === "string"
        ? req.query.agent.trim()
        : "";
      if (!agent) {
        return res.status(400).json({
          error: "Missing query parameter 'agent' (the stamped worktreeBranch correlation token)",
        });
      }

      // Walk the most-recent N runs in reverse-chronological order. ZREVRANGE
      // returns newest-first by score (started_epoch). The branch token's
      // `runtoken-t<turn>-<slot>` shape is run-scoped, so it would be unusual
      // — though not impossible — for the same branch to appear in two runs.
      // We return the first (newest) match.
      const recentRunIds = await zRevRange(
        redisKeys.autopilotRunsIndex(),
        0,
        MAX_RUNS_SCANNED - 1,
      );

      if (!recentRunIds || recentRunIds.length === 0) {
        return res.status(404).json({
          agent,
          resolved: false,
          reason: "no autopilot runs recorded yet",
        });
      }

      for (const runId of recentRunIds) {
        // Cheap row existence check before the per-turn scan. If the index is
        // ahead of the hash (TTL race) skip silently.
        const runRow = await hashGetAll(redisKeys.autopilotRun(runId));
        if (!runRow || !runRow.started) continue;

        const turns = await fetchTurnsWithJoins(runId, MAX_TURNS_PER_RUN);
        for (const turn of turns) {
          const actions: any[] = Array.isArray((turn as any).actions)
            ? ((turn as any).actions as any[])
            : [];
          for (const action of actions) {
            if (!action || action.type !== "dispatch") continue;
            const stamped =
              (typeof action.worktreeBranch === "string" && action.worktreeBranch) ||
              (typeof action.worktree_branch === "string" && action.worktree_branch) ||
              (typeof action.branch === "string" && action.branch) ||
              null;
            if (stamped !== agent) continue;

            // Hit. Return the action + outcome. `outcome` is already attached
            // by fetchTurnsWithJoins (null when the cycle hasn't been
            // recorded yet — Phase 6 of the autopilot dispatch lifecycle).
            return res.json({
              agent,
              resolved: true,
              runId,
              turnN: typeof (turn as any).turn_n === "number"
                ? (turn as any).turn_n
                : Number((turn as any).turn_n || 0),
              dispatch: action,
              outcome: action.outcome ?? null,
            });
          }
        }
      }

      // No match across the scanned window.
      return res.status(404).json({
        agent,
        resolved: false,
        reason: `no dispatch action found with worktreeBranch=${agent} in the most recent ${recentRunIds.length} autopilot runs`,
      });
    } catch (err: any) {
      console.error(`[agentsAPI] /agents/stream failed: ${err?.message || err}`);
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  return router;
}
