# Operator escalation only when no autonomous remedy exists

When a **Target Outcome** stops moving — whether leading or terminal — autopilot's default response is autonomous: research into *why* the outcome isn't moving, then a corresponding dev cycle or orchestrator self-modification. A regressing terminal metric raises priority but does not change the response policy.

(An earlier draft of this ADR routed escalation through an automated **Stuckness** detector; that detector was retired in ADR-0010 because it was orphaned in the codex cut-over. The policy in this ADR — research first, escalate only for the closed list below — is unchanged.)

Operator escalation is reserved for interventions only the operator can perform. Initial closed list:

- **Credentials / secrets** — new API keys, OAuth tokens, env vars
- **External-account actions** — opening accounts on new platforms, accepting TOS, KYC steps
- **Second failed Deep-QA Remediation Loop pass** on a T4 (Verifier Core) change — autonomous remediation exhausted, per ADR-0015 (replaces the retired "Tier 0 changes are operator-only" trigger)
- **Vision-level conflicts** — when the **Target Vision** prose contradicts what **Target Outcomes** are pushing toward, the operator decides which is wrong

Hydra exhausts autonomous options before raising any of these. "I tried things and they didn't work" is *not* a reason to escalate — it's a reason to research harder. The escalation channel is GitHub issues with `ready-for-human`, surfaced in the daily digest.

## Considered options

Default-to-escalate-on-outcome-stagnation was considered and rejected: it makes overnight autonomous operation impossible (the whole point of `/hydra-autopilot`), and turns the operator into the bottleneck for problems Hydra could have researched its way through.
