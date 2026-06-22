# Ollama VLM Backend Recovery

**When to run:** the orchestrator surfaces one of the VLM-backend health
diagnostics — most pointedly the `OV skill registration failure rate …%`
alert (issue #2277) — OR `hydra-doctor` reports the OV skill catalog
empty/partial AND the deep-health `ollamaVlm` probe reads `down`.

This is an **operator runbook**, not a code path. The root cause is
infrastructure: the Tailnet gaming-PC Ollama endpoint
(`http://gabes-desktop-1:11434`, LAN `10.0.0.101`) that OpenViking uses for its
vision/indexing (VLM) model is offline or unreachable. The orchestrator cannot
fix this autonomously — it can only surface it (the #2284 liveness probe + the
#2277 failure-rate alert) and re-register skills once the host is back (the
hourly Housekeeping recovery chore, #2148).

## Symptom chain (why an offline Ollama silently empties the skill catalog)

1. **Infrastructure:** Ollama `:11434` on the gaming PC is offline or its port
   is blocked. Tailnet host reachability (`ping`) is NOT the same as
   Ollama-process liveness — the box can answer ICMP while the Ollama service is
   down or the GPU is asleep.
2. **OpenViking cascade:** the VLM client times out on summarization
   (`openai.APITimeoutError`); `semantic_processor` stalls; the
   `/api/v1/skills` endpoint blocks on semantic generation and times out.
3. **Skill registration:** `registerOneSkill` burns its 3 attempts / 120s budget
   (with the #2250 server-side-timeout retry logic) but every attempt times out
   because the OV endpoint never recovers → `skillCatalogState` stays
   `0/4` (or partial).
4. **Learning degradation:** planners run without skill context — degraded
   forecast quality, contributes to the no-task rate (#1832).

## Confirm it is the VLM backend (60 seconds)

```bash
# 1. The orchestrator's own liveness verdict (#2284 probe; #2277 failure-rate alert).
curl -s http://localhost:4000/api/health/deep | jq '{
  ollamaVlm: .ollamaVlm,
  skillRegistration: [.diagnostics[] | select(.what | test("skill registration|skill catalog"))]
}'

# 2. Skill-catalog state directly.
curl -s http://localhost:4000/api/health/skills | jq '{registered, total, completed}'

# 3. Is the Ollama host actually answering? (host reachable != service up)
ping -c1 -W2 gabes-desktop-1.tail324a33.ts.net   # Tailnet reachability
curl -s -m5 http://gabes-desktop-1:11434/api/tags # Ollama process liveness
```

- `ollamaVlm.status == "down"` + skill registration failing → this runbook.
- `ollamaVlm.status == "ok"` but registration still failing → NOT a VLM outage;
  OpenViking is overloaded/5xx-ing under indexing load (#1924/#1831). Check OV
  load (`curl http://localhost:1933/health`) and back off concurrent indexing
  instead; do not chase the gaming PC.

## Recover the host

1. **Wake the gaming PC** if it is asleep/off. Wake-on-LAN is wired and verified
   (#1794) — MAC `d8:bb:c1:70:62:76`, LAN `10.0.0.101`. Power-off → packet →
   Ollama answering takes ~40s, zero-touch. The recovery path needs the host's
   ErP-off + Fast-Startup-off BIOS settings and the WSL auto-launch task to be
   in place (see the `Gaming PC Ollama endpoint` operator note).

   ```bash
   # From hydra-server, if a wol tool is installed:
   wakeonlan d8:bb:c1:70:62:76   # or: etherwake d8:bb:c1:70:62:76
   ```

   The orchestrator also exposes a WoL helper surface (`src/health/wol.ts`,
   #1794) — `hydra-doctor` can fire it when it detects the down probe.

2. **Verify Ollama came up** (re-run the liveness curl until it answers):

   ```bash
   until curl -s -m5 http://gabes-desktop-1:11434/api/tags >/dev/null; do
     echo "waiting for Ollama…"; sleep 5
   done
   echo "Ollama is answering"
   ```

3. **If WoL does not bring it back**, the host needs manual attention:
   - Power it on at the box.
   - Confirm the Ollama service is running and the VLM model is loaded
     (`systemctl status ollama` on the gaming PC; check RTX GPU load).
   - Confirm Tailscale is up on the host so the orchestrator can reach it.

## Re-populate the skill catalog (no restart needed)

Once Ollama answers, the **hourly Housekeeping recovery chore**
(`reRegisterMissingSkills`, #2148) re-POSTs only the still-missing skills and
merges the outcome back into `skillCatalogState` — `empty`/`partial` flips to
`ok` WITHOUT a process restart. To recover immediately rather than wait for the
next hourly tick, trigger the chore (or, as a last resort, restart the service —
the startup pass re-registers all four):

```bash
# Confirm the catalog recovered:
curl -s http://localhost:4000/api/health/skills | jq '{registered, total}'

# Last resort — full restart re-runs the once-at-startup registration pass:
systemctl --user restart hydra-orchestrator.service
```

The failure-rate alert and the `ollamaVlm` deep-health probe clear on their own
once the catalog is repopulated — no separate acknowledgement step.

## Graceful degradation: the catalog is DEFERRED, not failed (issue #2277)

When the VLM host is down at startup, `registerSkills` no longer burns the full
4 skills × 3 attempts × 120s timeout budget against an OV handler that cannot
answer (OV's `POST /api/v1/skills` does VLM-dependent semantic enrichment
SYNCHRONOUSLY — verified to block ~52s and 500 with `INTERNAL: Request timed
out.` even with `wait:false`). Instead it **pre-flights the VLM liveness probe
and DEFERS the pass**: it POSTs nothing, records every skill with the
`vlm-deferred` marker, sets `vlmDeferred:true` on the catalog state, and emits
**exactly one** operator alert (`[Learning] OV skill catalog DEFERRED — …`).

What you will see while the VLM is down:

- `GET /api/health/skills` → `status:"degraded"`, `vlmDeferred:true`,
  `registered:0` — a **deliberate** graceful degradation, NOT the `empty`/error
  verdict that means "every POST failed under load" (#1968). The deep-health
  diagnostic is a `warning` with `autoRecovery:true`, not an `error`.
- The orchestrator logs ONE deferral line, not 200+ per-skill timeout lines —
  the cascade is short-circuited at the source.

No operator action beyond recovering the host (the Recovery steps above). Once
the VLM answers, the hourly Housekeeping chore (`reRegisterMissingSkills`,
gated on the skills-endpoint liveness) re-registers the deferred skills and
flips `vlmDeferred` back to false — **no restart needed**.

## Durable fix (out of scope for this runbook)

This is the recurring root cause behind a cluster of issues
(#2269 / #2250 / #2148 / #2103 / #2064 / #1968, root cause #1831). Moving the
VLM backend off a consumer device onto a stable infrastructure host removes the
class of outage entirely. Until then, this runbook is the operator recovery
path; the orchestrator-side observability (the #2284 liveness probe and the
#2277 failure-rate alert) exists so the outage is never again silent.
