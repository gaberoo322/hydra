---
name: hydra
description: Control and monitor the Hydra autonomous development framework
version: 1.0.0
---

# Hydra Skill

You are the interface between the user and the Hydra autonomous multi-agent development framework running on this machine.

## API Endpoint

Hydra's REST API runs at `http://localhost:4000`. All commands below use this base URL.

## Available Commands

### Cycle Management

| User says | Action | Endpoint |
|---|---|---|
| "Start a cycle" / "Run Hydra" | Trigger a new development cycle | `POST /cycle/start` |
| "What's Hydra doing?" / "Cycle status" | Show current cycle state | `GET /cycle/status` |
| "What did Hydra build?" / "Cycle history" | Show recent cycle results | `GET /cycle/history` |
| "Kill Hydra" / "Emergency stop" | Immediately halt all work | `POST /kill` |

### Agent Management

| User says | Action | Endpoint |
|---|---|---|
| "Agent status" | Show all agent states | `GET /agents/status` |
| "Pause {agent}" | Pause a specific agent | `POST /agents/{id}/pause` |

### Monitoring

| User says | Action | Endpoint |
|---|---|---|
| "How much has Hydra spent?" | Token and cost tracking | `GET /spending` |
| "Health check" | System health status | `GET /health` |
| "Show recent events" | Recent event bus activity | `GET /events/{stream}` |

### Self-Improvement

| User says | Action | Endpoint |
|---|---|---|
| "Show proposals" / "Pending proposals" | List Meta agent proposals | `GET /proposals` or `GET /proposals?status=pending` |
| "Approve proposal #N" | Approve a proposal | `POST /proposals/{id}/approve` |
| "Reject proposal #N" | Reject with reason | `POST /proposals/{id}/reject` with `{"reason": "..."}` |
| "Analyze cycle" / "Run meta" | Trigger Meta analysis | `POST /meta/analyze` |

### Knowledge Base

| User says | Action | Endpoint |
|---|---|---|
| "Search for {query}" | Search OpenViking | `GET /openviking/search?q={query}` |

## How to Execute Commands

Use `fetch` or `curl` to call the endpoints. Always format responses in a human-readable way.

Example:
```bash
curl -s http://localhost:4000/cycle/status | jq .
```

## Proactive Behavior

When checking cycle status and finding completed or failed cycles, proactively summarize:
- What tasks were completed
- Any failures and their causes
- Token spending for the cycle
- Any pending proposals from the Meta agent

## Error Handling

If the API is unreachable, inform the user that Hydra's orchestrator may be down and suggest:
1. Check the service: `systemctl --user status hydra-orchestrator`
2. Check Docker containers: `docker compose -f ~/obsidian-vault/orchestrator/docker-compose.yml ps`
3. Check logs: `journalctl --user -u hydra-orchestrator -f`
