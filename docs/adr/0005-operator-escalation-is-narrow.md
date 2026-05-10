# Operator escalation only when no autonomous remedy exists

When **Stuckness** fires — whether on a leading or terminal **Target Outcome** — autopilot's default response is autonomous: research into *why* the outcome isn't moving, then a corresponding dev cycle or orchestrator self-modification. Terminal-metric stuckness raises priority but does not change the response policy.

Operator escalation is reserved for interventions only the operator can perform. Initial closed list:

- **Credentials / secrets** — new API keys, OAuth tokens, env vars
- **External-account actions** — opening accounts on new platforms, accepting TOS, KYC steps
- **Tier 0 Untouchable Core** changes (already operator-only per ADR-0001)
- **Vision-level conflicts** — when the **Target Vision** prose contradicts what **Target Outcomes** are pushing toward, the operator decides which is wrong

Hydra exhausts autonomous options before raising any of these. "I tried things and they didn't work" is *not* a reason to escalate — it's a reason to research harder. The escalation channel is GitHub issues with `ready-for-human`, surfaced in the daily digest.

## Considered options

Default-to-escalate-on-stuckness was considered and rejected: it makes overnight autonomous operation impossible (the whole point of `/hydra-autopilot`), and turns the operator into the bottleneck for problems Hydra could have researched its way through.
