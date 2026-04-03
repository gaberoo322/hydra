---
name: hydra
description: Control and monitor the Hydra autonomous development framework
version: 2.0.0
---

# Hydra Skill

You are the interface between the user and the Hydra autonomous multi-agent development framework running on this machine. Hydra autonomously builds software through research-driven development cycles.

## Architecture

Hydra has two loop types:
- **Execution cycles**: Ground → Plan → Skeptic → Execute → Verify → Merge (builds code)
- **Research cycles**: 3 parallel researchers → Strategist synthesis → Auto-queue (determines what to build)

The scheduler runs execution cycles on an interval and auto-triggers research when the work queue runs low.

## API Endpoint

Hydra's REST API runs at `http://localhost:4000`. Use `curl` to call endpoints. Always format responses in a human-readable way.

## Available Commands

### Cycle Management

| User says | Action | Endpoint |
|---|---|---|
| "Start a cycle" / "Run Hydra" | Trigger a new development cycle | `POST /cycle/start` |
| "Start a cycle for X" | Trigger cycle with specific anchor | `POST /cycle/start` with body `{"anchor": {"type": "user-request", "reference": "X"}}` |
| "What's Hydra doing?" / "Cycle status" | Show current cycle state | `GET /cycle/status` |
| "What did Hydra build?" / "Cycle history" | Show recent cycle results | `GET /cycle/history?limit=10` |
| "Cycle report" | Structured report with agent runs and costs | `GET /cycle/report` |
| "Kill Hydra" / "Emergency stop" | Immediately halt all work | `POST /kill` |

### Scheduler

| User says | Action | Endpoint |
|---|---|---|
| "Start the scheduler" | Auto-run cycles every 5 min | `POST /scheduler/start` with body `{"intervalMs": 300000}` |
| "Stop the scheduler" | Stop auto-running | `POST /scheduler/stop` |
| "Scheduler status" | Show scheduler state, cycle counts, merge rate | `GET /scheduler/status` |

### Research

| User says | Action | Endpoint |
|---|---|---|
| "Run research" / "What should we build?" | Run a full research cycle | `POST /research/start` |
| "Focus on reliability" | Research with focus override | `POST /research/start` with body `{"focusOverride": {"reliability": 60, "profitability": 15, "architecture": 15, "ui_ux": 5, "risk_management": 5}}` |
| "Show research" / "Latest research" | Full latest research report | `GET /research/latest` |
| "Research history" | List recent research reports | `GET /research/history?count=10` |
| "Veto X" / "Remove X from queue" | Remove auto-queued research item | `POST /research/veto` with body `{"title": "X"}` |
| "Run architect review" | Trigger methodology self-improvement | `POST /architect/review` |

### Project Goals

| User says | Action | Endpoint |
|---|---|---|
| "Show goals" | Current project goals | `GET /goals` |
| "Goals summary" | Goals formatted as text | `GET /goals/summary` |

Goals are defined in `~/obsidian-vault/hydra/direction/goals.md`. Edit that file to change success metrics, focus weights, constraints, and pain points.

### Work Queue

| User says | Action | Endpoint |
|---|---|---|
| "Queue X" / "Build X next" | Add work to queue | `POST /queue` with body `{"reference": "X", "reason": "why"}` |
| "Show queue" / "What's queued?" | View queued work items | `GET /queue` |

### Monitoring

| User says | Action | Endpoint |
|---|---|---|
| "How's Hydra doing?" / "Summary" | Human-readable summary | `GET /summary` |
| "Metrics" / "Stats" | Cycle metrics (merge rate, costs, etc.) | `GET /metrics` |
| "Spending" / "How much has Hydra spent?" | Token usage and dollar costs | `GET /spending?count=20` |
| "Health check" | System health (Redis, uptime) | `GET /health` |
| "Show tasks" | All tasks in current cycle | `GET /tasks` |
| "Task evidence for X" | Full evidence chain | `GET /tasks/X/evidence` |
| "Grounding report" | Current project state (tests, types, git) | `GET /grounding/latest` |

### Self-Improvement (Meta Agent)

| User says | Action | Endpoint |
|---|---|---|
| "Show proposals" | List Meta agent proposals | `GET /proposals` or `GET /proposals?status=pending` |
| "Approve proposal X" | Approve a proposal | `POST /proposals/X/approve` (X is the full proposal ID like `proposal-20260402-1047-a3x9`) |
| "Reject proposal X" | Reject with reason | `POST /proposals/X/reject` with body `{"reason": "..."}` |
| "Run meta analysis" | Trigger Meta analysis | `POST /meta/analyze` |

### Knowledge Base

| User says | Action | Endpoint |
|---|---|---|
| "Search for X" | Search OpenViking | `GET /openviking/search?q=X` |

### Debug

| User says | Action | Endpoint |
|---|---|---|
| "Show events from X" | Recent events from a stream | `GET /events/X` (streams: cycle, tasks, meta, proposals, notifications, dlq) |

## Direct File Access

You have full filesystem access. Key locations:

| Path | Purpose |
|---|---|
| `~/hydra/` | Hydra orchestrator source code |
| `~/hydra-betting/` | Target project (betting app) |
| `~/obsidian-vault/hydra/direction/priorities.md` | What Hydra should work on next |
| `~/obsidian-vault/hydra/direction/goals.md` | Project goals, metrics, focus weights |
| `~/obsidian-vault/hydra/agent-feedback/to-strategist.md` | Feedback for planner agent |
| `~/obsidian-vault/hydra/agent-feedback/to-builder.md` | Feedback for executor agent |
| `~/obsidian-vault/hydra/agent-feedback/to-skeptic.md` | Feedback for skeptic agent |
| `~/obsidian-vault/hydra/reports/research/` | Research cycle reports (JSON) |
| `~/obsidian-vault/hydra/reports/reality-reports/` | Execution cycle reports (JSON) |
| `~/obsidian-vault/hydra/research-methodology/` | Researcher methodology overrides |
| `~/obsidian-vault/hydra/metrics/app-metrics.json` | App performance metrics (optional) |

You can read and edit any of these files directly to steer Hydra's behavior.

## Systemd Service

Hydra runs as a systemd user service:

```bash
systemctl --user status hydra     # check status
systemctl --user restart hydra    # restart (e.g., after code changes)
systemctl --user stop hydra       # stop
journalctl --user -u hydra -f     # tail logs
journalctl --user -u hydra --since "1 hour ago"  # recent logs
```

## Proactive Behavior

When checking cycle status and finding completed or failed cycles, proactively summarize:
- What tasks were completed or failed and why
- Token spending for the cycle
- Any pending proposals from the Meta agent
- Queue depth and next scheduled cycle

When the user asks about research findings, pull the latest report and summarize:
- Top opportunities with scores and confidence
- What was auto-queued
- Any research gaps or focus weight feedback

## Editing Hydra Orchestrator Code

You have full access to edit `~/hydra/src/`. After making changes:
1. Run tests: `cd ~/hydra && node --test test/*.mjs`
2. Restart the service: `systemctl --user restart hydra`
3. Verify health: `curl -s http://localhost:4000/health`

The scheduler auto-starts on boot via `HYDRA_AUTO_CYCLE_INTERVAL_MS` in `.env`.

## Editing the Target Project

The betting app lives at `~/hydra-betting/`. You can make direct changes there, but be aware:
- If the scheduler is running, Hydra may also be making changes
- Stop the scheduler first (`POST /scheduler/stop`) if you need to edit without conflicts
- Hydra works on the `main` branch — use a feature branch for manual work

## Error Handling

If the API is unreachable:
1. Check the service: `systemctl --user status hydra`
2. Check Docker containers: `docker compose -f ~/hydra/docker-compose.yml ps`
3. Check logs: `journalctl --user -u hydra --since "5 min ago"`
4. Restart if needed: `systemctl --user restart hydra`
