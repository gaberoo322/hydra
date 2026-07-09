# Target Swap Runbook (swap-mode, one target at a time)

**Status:** Finalized (2026-07-08) against the shipped Target Manifest epic ([#3014](https://github.com/gaberoo322/hydra/issues/3014) / [ADR-0026](./adr/0026-target-manifest.md)). One sibling slice — #3018 (thread the manifest through the remaining gate/script sites) — is still in flight; the single precondition that depends on it is footnoted.

## What this is

The procedure for pointing a **single** running Orchestrator instance at a **different Target** — e.g. switching from `hydra-betting` to a new gaming webapp — by flipping env vars and restarting, per [ADR-0002](./adr/0002-single-target-per-orchestrator-instance.md). This is **swap-mode**: one target at a time. The previous target pauses while the new one runs; they do **not** run concurrently.

Use this to **smoke-test a swap** before investing in the unbuilt "fleet" (concurrent multi-instance) scaffolding. If you need both targets building at once, this runbook is not enough — see [Concurrent operation](#concurrent-operation-not-this-runbook).

> **The one thing that will bite you:** target work-state in Redis (`hydra:backlog:*`, `hydra:anchors:*`, `hydra:cycle:*`) is **global, not namespaced per target**. A naive "flip env + restart" leaves the *old* target's backlog, work-queue, and cycle locks in place, and the new target's autopilot will try to build **betting** items against the **gaming** repo. Step 3 handles this. Do not skip it.

## Mental model: what swaps vs. what stays

| Concern | Swaps with the target | Stays (builder-self) |
|---|---|---|
| Workspace / repo / web URL | ✅ env vars (Step 2) | — |
| Direction docs (vision, outcomes) | ✅ `HYDRA_CONFIG_PATH` (Step 2) | — |
| Manifest (build/gate facts) | ✅ lives in target repo (`.hydra/manifest.json`) | — |
| Backlog, work-queue, cycle locks | ✅ Redis reset (Step 3) | — |
| Patterns / lessons / class-stats / usage / attribution | — | ✅ keep (it's about the *builder*, not the target) |

The awkwardness — you reset *some* `hydra:*` keys and preserve others, with no realm prefix to select on — is a known consequence of ADR-0002's single-instance model and the reason concurrent operation needs real config/Redis externalization work (a natural follow-on to #3014).

---

## Preconditions

- [ ] The new Target repo exists on GitHub (e.g. `gaberoo322/hydra-gaming`) with: a `main` branch, a working `package.json`, a real test command, and `npm run typecheck`.
- [ ] The new Target repo contains `.hydra/manifest.json`: a `version` (int), a `verify` block (`install`, `test`, `typecheck`, `build`, `appSubdir` — `""` for a repo-root target), and a `riskCritical` block (`surface[]`, `mutationKillFloor`; an empty `surface` requires `acknowledgedNoRiskSurface: true`, so the risk gate cannot be silently disabled). Schema: `src/schemas/target-manifest.ts`; the shipped betting manifest (`~/hydra-betting/.hydra/manifest.json`) is the worked example. The orchestrator reads the verify commands (#3019) and the risk surface (#3017) from this file; a few remaining gate/script sites still fall back to built-in defaults **until #3018 lands**, so double-check those sites when swapping to a non-betting target before #3018 merges.
- [ ] The new Target's direction docs are authored: `vision.md` + `outcomes.yaml` (with at least one **leading** outcome, or Tier-2 Outcome Holdback cannot run). See the [outcome-measurability caveat](#outcome-measurability-caveat).
- [ ] You have a maintenance window — the current target stops making progress during and after the swap.

---

## Procedure

### Step 0 — Quiesce the current target

```bash
# Pause autopilot so nothing dispatches mid-swap.
curl -sf -X POST http://localhost:4000/api/autopilot/paused \
  -H 'content-type: application/json' -d '{"paused":true}'

# Let any in-flight build finish and merge (or close its PR). Confirm no active cycle lock:
curl -sf http://localhost:4000/api/scheduler/status | jq '.activeCycle // "none"'
```

Wait until no cycle is active. A swap while a build holds `hydra:cycle:active:*` will orphan that lock against the wrong repo (see the betting-cycle-lock-orphan hazard).

### Step 1 — Snapshot Redis (rollback insurance)

```bash
# Point at the SAME instance the orchestrator uses (REDIS_URL, default redis://localhost:6379).
redis-cli SAVE            # or BGSAVE; produces dump.rdb you can restore
cp "$(redis-cli CONFIG GET dir | tail -1)/dump.rdb" ~/hydra-swap-backups/dump-$(date +%s).rdb
```

This lets you restore betting's full state on rollback. Store the path; you'll need it.

### Step 2 — Point the env at the new target

Set these for the service (in the unit's `Environment=` / the `.env` that `bin/start.sh` loads — **not** just your shell):

| Var | Example | Notes |
|---|---|---|
| `HYDRA_TARGET_NAME` | `hydra-gaming` | drives worktree prefix + `${name}-web.service` |
| `HYDRA_PROJECT_WORKSPACE` | `/home/gabe/hydra-gaming` | absolute path to the checked-out target |
| `HYDRA_TARGET_GITHUB_REPO` | `gaberoo322/hydra-gaming` | `owner/repo` |
| `HYDRA_TARGET_WEB_URL` | `http://localhost:3334` | canonical (#3020); legacy `HYDRA_BETTING_URL` still resolves via `getTargetWebUrl()` but emits a one-time deprecation warning |
| `HYDRA_CONFIG_PATH` | `/home/gabe/hydra-gaming-config` | external config dir (Step 2a) |

**Step 2a — external config dir** (keeps gaming's direction docs out of the shared orchestrator repo):

```bash
# config/ holds BOTH orchestrator-self config (agents, feedback, orchestrator/vision.md)
# AND per-target direction/. Copy the whole tree, then swap only direction/.
cp -r ~/hydra/config ~/hydra-gaming-config
rm -rf ~/hydra-gaming-config/direction
cp -r /path/to/gaming/direction ~/hydra-gaming-config/direction   # vision.md, outcomes.yaml, ...
```

> This copy is a swap-mode workaround. The clean end-state (per the manifest philosophy) is per-target direction living *in the target repo* — tracked as the config-externalization follow-on to #3014.

### Step 3 — Reset target work-state in Redis (keep builder-self state)

```bash
# Delete TARGET-scoped work keys so the board starts empty for the new target.
# (Snapshot from Step 1 is your undo.) These namespaces are keyed by target
# backlog items / anchors / PRs, so leaving them behind leaks stale betting
# state into the gaming board.
redis-cli --scan --pattern 'hydra:backlog:*'        | xargs -r redis-cli DEL
redis-cli --scan --pattern 'hydra:anchors:*'        | xargs -r redis-cli DEL
redis-cli --scan --pattern 'hydra:cycle:*'          | xargs -r redis-cli DEL
redis-cli --scan --pattern 'hydra:design-concept:*' | xargs -r redis-cli DEL
redis-cli --scan --pattern 'hydra:blocked*'         | xargs -r redis-cli DEL
redis-cli --scan --pattern 'hydra:review:*'         | xargs -r redis-cli DEL
redis-cli --scan --pattern 'hydra:holdback:*'       | xargs -r redis-cli DEL
redis-cli --scan --pattern 'hydra:regression-hunt*' | xargs -r redis-cli DEL

# DO NOT delete builder-self keys — they are about the *builder*, not the
# target, and MUST carry across the swap:
#   hydra:attribution:*   decision/outcome attribution ledger
#   hydra:class-stats*    per-class dispatch stats
#   hydra:usage* / snapshots   subscription usage accounting
#   hydra:memory* / hydra:learning* / hydra:friction*   pattern memory, lessons, friction cues
#   hydra:scout*          tool-scout seen-list
#   hydra:dispatches* / hydra:reflections* / hydra:retro*   dispatch records & retrospectives
#   hydra:scheduler* / hydra:autopilot*   scheduler + autopilot control state
# When unsure, inspect BEFORE deleting — the snapshot is your only undo:
#   redis-cli --scan --pattern 'hydra:*' | sed -E 's/(hydra:[a-z-]+).*/\1/' | sort | uniq -c | sort -rn
```

> The delete-list is deliberately explicit (not a `FLUSHDB`-minus-allowlist) so it always fails safe: an unrecognized namespace is *preserved*, never dropped. If you add a new target-work namespace to the orchestrator, add it here too.

### Step 4 — Rebuild dashboard + restart the service

```bash
cd ~/hydra
npm run build --prefix dashboard      # Express serves dashboard/dist — stale build = stale UI
lsof -ti:4000 && echo "port 4000 busy — stop the service first"
systemctl --user restart hydra-orchestrator.service
journalctl --user -u hydra-orchestrator.service -f    # watch for the target-config banner
```

On boot, `target-config.ts` logs the resolved target name/workspace/repo. Confirm they're the gaming values, not betting.

### Step 5 — Verify the swap grounded correctly

```bash
curl -sf http://localhost:4000/api/health | jq
curl -sf http://localhost:4000/api/scheduler/status | jq '{target:.targetName, workspace:.workspace}'
# Outcomes loaded from the new config dir?
curl -sf http://localhost:4000/api/outcomes | jq '.[].name'
```

- [ ] Health OK, target name = gaming, workspace = gaming path.
- [ ] Outcomes list shows the gaming outcomes (not betting's Brier metrics).
- [ ] Seed one or two gaming backlog items and confirm they appear on the board.

### Step 6 — Smoke-test one build, then unpause

Dispatch a single small build **manually** first (don't unpause into an empty-context autopilot):

```bash
# In the main session: /hydra-target-build on a trivial seeded gaming issue.
# Confirm: worktree lands under the gaming workspace, grounding runs the gaming
# test command, a PR opens against gaberoo322/hydra-gaming.
```

Only once a manual build round-trips cleanly:

```bash
curl -sf -X POST http://localhost:4000/api/autopilot/paused \
  -H 'content-type: application/json' -d '{"paused":false}'
```

---

## Rollback (swap back to betting)

1. Pause autopilot (Step 0).
2. Restore env vars to the betting values (or revert the `.env` / unit change).
3. `redis-cli` FLUSHDB is **not** needed — restore the Step 1 snapshot: stop the service, replace `dump.rdb` with your backup, start Redis, restart the orchestrator.
4. Rebuild dashboard + restart (Step 4). Verify (Step 5) shows betting again.
5. Unpause.

---

## Outcome-measurability caveat

Betting was the crucible because its success metric (real money → Brier / ROI) is external and unforgiving. A gaming app's metrics are softer. But Tier-2 **Outcome Holdback** and the learning loop **require at least one measurable leading outcome** in `outcomes.yaml`, or post-merge regression checking degrades to "did tests pass." Before the swap, define concrete leading proxies — e.g. crash-free session rate, cold-start time, a level-completion funnel, D1 retention — with a file/API source the orchestrator can sample. Without them the swap will "work" but the builder flies blind on whether it's improving the product.

## Concurrent operation (NOT this runbook)

To run betting **and** gaming at the same time you need a **second Orchestrator instance**, not a swap: a separate clone of `gaberoo322/hydra` (same upstream — **never a fork**) with its own `REDIS_URL` (or DB index — global `hydra:*` keys collide otherwise), its own `HYDRA_PORT`, its own systemd unit set, and its own `HYDRA_CONFIG_PATH`. This is ADR-0002's "fleet model," explicitly future/unbuilt. Validate the swap with this runbook first; build the fleet isolation only once the swap is proven sound.
