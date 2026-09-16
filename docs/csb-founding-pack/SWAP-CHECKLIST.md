# Claw Street Bets: swap checklist

Capstone of wayfinder map [CSB founding pack](https://github.com/gaberoo322/hydra/issues/4313), ticket [CSB swap checklist (capstone)](https://github.com/gaberoo322/hydra/issues/4326). This is the concrete, CSB-specific form of `docs/target-swap-runbook.md`. Work top to bottom; each box is one verifiable action.

**Facts verified on this host on 2026-09-15** (re-check any you rely on if the swap is weeks later):

- `gaberoo322/claw-street-bets` does not exist; `~/claw-street-bets` does not exist; port 3334 is free.
- `hydra-orchestrator.service` loads `~/hydra/.env` (sets `HYDRA_PROJECT_WORKSPACE=/home/gabe/hydra-betting`) **and** `-/home/gabe/hydra-betting/.env.local`. No orchestrator code under `src/` or `scripts/` reads `DATABASE_URL`, the only relevant var that file supplies.
- `hydra-pace-gate.service` and `hydra-autopilot.service` set only `HOME`/`PATH`: the autopilot session has **no** `HYDRA_TARGET_*` vars, so every Target playbook resolves identity through `scripts/target/print-target-facts.ts` → `src/target-config.ts` defaults (`hydra-betting`, `gaberoo322/hydra-betting`, `:3333`). `collect-state.sh:291` and `reap_ghrefs.py:52` carry their own `hydra-betting` fallbacks; the direction-drift check uses `HYDRA_TARGET_REPO` (default `~/hydra-betting`).
- Target direction docs are read from the **tracked** `~/hydra/config/direction/` (no `HYDRA_CONFIG_PATH` is set). `config/direction/liveness.yaml` already has an empty `entries:` list (betting timers retired in #4410).
- Redis runs in the `hydra-redis-1` container (data dir `/data`); Postgres runs in `hydra-postgres-1` (role = the container's `POSTGRES_USER`; databases today: `hydra`, `postgres`).
- Four self-hosted runners serve `gaberoo322/hydra`; `~/actions-runner-betting` + `github-actions-runner-betting.service` (disabled) are free to re-register.
- Autopilot scope is pinned `orch-only` in `~/.config/systemd/user/hydra-autopilot.service.d/scope.conf`.

**Operator decisions taken while writing this checklist (2026-09-15):**

1. CSB direction docs replace the tracked `config/direction/` via a hydra PR (not an external `HYDRA_CONFIG_PATH` copy): every in-process reader, the drift check, the refresh-PR flow and CI's wiring-caller-check assume the in-repo copy.
2. Target identity reaches every context twice over: one shared env file loaded by the orchestrator, pace-gate and autopilot units, **plus** a PR flipping the code defaults to CSB so interactive shells and any unconfigured context resolve CSB too.
3. The three Target-lane gaps folded in from swap-readiness are fixed **before** the swap by autopilot; the swap session only live-verifies them.
4. The `metrics/csb/*` outcome files are written by an orchestrator chore, built before the swap.

---

## Phase A: before the swap (runs now, orch-only autopilot)

### A1. Pre-swap orchestrator fixes merged and deployed

- [ ] [#4474](https://github.com/gaberoo322/hydra/issues/4474): `target_ready_for_agent` excludes Target issues with an open PR (ex-#4227).
- [ ] [#4475](https://github.com/gaberoo322/hydra/issues/4475): liveness-aware Target WIP-saturation signal (ex-#4241).
- [ ] [#4476](https://github.com/gaberoo322/hydra/issues/4476): data-driven worktree-isolation carve-out for every Target-tree-touching class (ex-#4293).
- [ ] [#4477](https://github.com/gaberoo322/hydra/issues/4477): orchestrator chore publishes the Target's `/api/outcomes` into `metrics/<query>` files.
- [ ] Prod is on a master that contains all four: `git -C ~/hydra log --oneline -1` matches `origin/master` after the last merge settles (run `bash scripts/deploy.sh` once if a back-to-back merge cancelled a deploy).

### A2. Coinbase facts (operator only)

- [ ] **Fee tier scope**: confirm in the Coinbase account UI that the Advanced Trade fee tier is per-account and shared by portfolios (cost-model ticket [#4359](https://github.com/gaberoo322/hydra/issues/4359), decision 5). Record the realized tier. If it is already above Intro 1, `c` stays at min(realized tier, Advanced 2) and #4359's decision 3 is moot; if the assumption is wrong, re-open #4359 **before** repo creation (a re-freeze changes `config/graduation-gate.yaml`).
- [ ] **First-month tier-climb budget**: write down the real-money budget for the first live month at the bottom tier. It sits outside the graduation gate (#4359) and is not needed until live graduation; record where it lives.
- [ ] **Portfolio + keys**: create a dedicated CSB portfolio and a scoped API key with view/market-data permissions only (paper phase; `can_transfer` never). The level2 WebSocket channel is public (no JWT; see `coinbase-api.md`), so the recorder needs no key on day one; the key is for `transaction_summary`, fills and, later, orders. The `claw-street-bets` portfolio was created 2026-09-16; the key is still to create. Store the key only in `~/claw-street-bets/.env.local` (mode 0600) once the repo is cloned, never in git.

### A3. Swap PRs prepared (open as drafts, merge in Phase C)

Both are ordinary hydra PRs; opening them early lets CI shake them out. **Do not merge before Phase C step C3.** A default flip before the repo exists points every Target read at a missing repo.

- [ ] **PR "swap(direction): CSB direction docs replace betting's"**, touching `config/direction/`:
  - `vision.md`, `priorities.md`, `outcomes.yaml` ← `docs/csb-founding-pack/direction/` from this branch.
  - `liveness.yaml` stays with empty `entries:`; CSB units are added as each ships (a declared-but-unbuilt unit alarms MISSING).
  - Betting-shaped files move to `docs/historical/hydra-betting/direction/`: `goals.md` (10 betting references), `roadmap.md` (96), `research-journal.md` (15). `/api/goals` then returns its 404 "No goals file found" until CSB research writes one; confirm the dashboard tolerates that, or seed a CSB `goals.md` from the `priorities.md` milestones.
  - Audit and keep only if Target-agnostic: `architecture-review.md` (4 betting references, last touched 2026-09-12), `proposal-policy.md` (0), `tech-preferences.md` (0; its preferences must match the CSB stack or be rewritten).
  - `outcomes.yaml` must load with the orchestrator loader (the founding ticket validated 17 outcomes: `orchestrator-self-improvement-share` plus 16 CSB).
- [ ] **PR "swap(target): target-config defaults point at claw-street-bets"**:
  - `src/target-config.ts`: `DEFAULT_TARGET_NAME=claw-street-bets`, `DEFAULT_TARGET_GITHUB_REPO=gaberoo322/claw-street-bets`, `DEFAULT_TARGET_WEB_URL=http://localhost:3334`, and `test/target-config.test.mts`.
  - The stray fallbacks: `scripts/autopilot/collect-state.sh` (`TARGET_GH_REPO`, and the direction-drift `HYDRA_TARGET_REPO` default), `scripts/autopilot/reap_ghrefs.py`, `docs/operator-playbooks/hydra-review.md` (`REVIEW_REPOS`). Prefer routing them through the target seam over re-literalising; the target-coupling ratchet must stay green.

---

## Phase B: create the repo (`SCAFFOLD.md` §10)

### B1. Repo and checkout

- [ ] `gh repo create gaberoo322/claw-street-bets --private`; default branch `main`; clone to `~/claw-street-bets`.
- [ ] Copy the labels the autopilot reads from the archived board: `gh label clone gaberoo322/hydra-betting --repo gaberoo322/claw-street-bets` (then confirm `ready-for-agent`, `needs-triage`, `needs-qa`, `in-progress`, `blocked`, `reframe`, `ready-for-human`, `money-critical`, `hold-for-operator` exist).

### B2. Founding pack into the repo

| From this branch (`docs/csb-founding-pack/`) | To the CSB repo |
|---|---|
| `.hydra/manifest.json` | `.hydra/manifest.json` |
| `direction/vision.md`, `priorities.md`, `outcomes.yaml` | `direction/` (authoritative copy) |
| `config/graduation-gate.yaml` | `config/graduation-gate.yaml` |
| `CONTEXT.md` | `CONTEXT.md` |
| `SCAFFOLD.md`, this file | `docs/founding/` (provenance) |
| `coinbase-api.md` | `docs/venue/coinbase-api.md` (living venue reference) |

- [ ] Author `config/risk-template.json` v1 from [#4341](https://github.com/gaberoo322/hydra/issues/4341): 0.5% per trade at stop (1% hard cap), 3% daily-loss halt per strategy per UTC day (realized + unrealized), 3% total open-risk cap; live proof $5k/strategy, ×2 per 90 clean days, $20k ceiling. Version it and pin that version in `direction/outcomes.yaml`.
- [ ] Author `config/universe-filter.json` from founding decision 9 ([#4314](https://github.com/gaberoo322/hydra/issues/4314)): a config-driven liquidity filter (minimum 24h volume, maximum spread) over Coinbase spot. No numeric thresholds were locked; seed conservative values that admit BTC-USD and ETH-USD, and file a CSB issue to calibrate them from the candle store.
- [ ] Scaffold per `SCAFFOLD.md` §1–§7: Node pin (`.nvmrc` = the orchestrator's exact version), strict `tsconfig`, the `package.json` script set, directory layout, `src/risk/risk-core.ts` with its existence test, the gate-agreement test, the outcomes-name test, `/api/outcomes` stubbed to return `null` per outcome, `/api/health`.
- [ ] Commit `ci.yml`, `automerge.yml`, `deploy.yml`; `npm test` (real vitest), `npm run typecheck` and `npm run build` are green at creation.

### B3. Host resources

- [ ] Postgres database:
  ```bash
  PGU=$(docker exec hydra-postgres-1 printenv POSTGRES_USER)
  docker exec hydra-postgres-1 psql -U "$PGU" -d postgres -c 'CREATE DATABASE claw_street_bets'
  ```
  Put its `DATABASE_URL` in `~/claw-street-bets/.env.local` (0600, untracked).
- [ ] CI runner: re-register `~/actions-runner-betting` against `gaberoo322/claw-street-bets` as `github-actions-runner-csb.service`; retire the betting unit file. This becomes a fifth runner on the same host and Unix user as the orchestrator's four (CLAUDE.md pitfall: never kill test processes by pattern).
- [ ] systemd units `claw-street-bets-*` installed by `scripts/deploy.sh` (`EnvironmentFile=%h/claw-street-bets/.env.local`, web on :3334).

### B4. Protection and round trip

- [ ] Branch protection on `main` requiring `typecheck-and-test` **before** the first agent PR (betting shipped without it and `--auto` bypassed CI).
- [ ] A trivial hand PR runs CI green, auto-merges, deploys, and `curl -sf http://localhost:3334/api/health` answers.

---

## Phase C: point Hydra at CSB

### C0. Quiesce

- [ ] `curl -sf -X POST http://localhost:4000/api/autopilot/paused -H 'content-type: application/json' -d '{"paused":true}'`
- [ ] No in-flight dispatch: `curl -sf http://localhost:4000/api/autopilot/inflight-slots | jq '.slots | length'` is `0`, and `curl -sf http://localhost:4000/api/autopilot/paused` shows `"paused":true`. (The runbook's `/api/scheduler/status .activeCycle` field no longer exists.)

### C1. Snapshot Redis

- [ ] ```bash
  docker exec hydra-redis-1 redis-cli SAVE
  docker cp hydra-redis-1:/data/dump.rdb ~/hydra-swap-backups/redis-pre-csb-swap-$(date +%Y%m%d-%H%M%S).rdb
  ```
  Record the path; it is the Redis rollback.

### C2. Target identity env

- [ ] Create `~/.config/hydra/target.env` (no secrets, 0644):
  ```
  HYDRA_TARGET_NAME=claw-street-bets
  HYDRA_PROJECT_WORKSPACE=/home/gabe/claw-street-bets
  HYDRA_TARGET_GITHUB_REPO=gaberoo322/claw-street-bets
  HYDRA_TARGET_WEB_URL=http://localhost:3334
  HYDRA_TARGET_REPO=/home/gabe/claw-street-bets
  ```
  No `HYDRA_CONFIG_PATH` (decision 1: direction stays in `~/hydra/config`).
- [ ] Add a `target.conf` drop-in with `EnvironmentFile=%h/.config/hydra/target.env` for **each** of `hydra-orchestrator.service`, `hydra-pace-gate.service`, `hydra-autopilot.service` (`~/.config/systemd/user/<unit>.d/target.conf`).
- [ ] Remove `HYDRA_PROJECT_WORKSPACE=/home/gabe/hydra-betting` from `~/hydra/.env` (it would otherwise race the drop-in).
- [ ] Remove `EnvironmentFile=-/home/gabe/hydra-betting/.env.local` from `hydra-orchestrator.service`. Before removing, confirm nothing else the orchestrator needs comes only from that file (Telegram alerting reads `~/hydra/.env`).
- [ ] `systemctl --user daemon-reload`, then `systemctl --user show hydra-pace-gate.service -p Environment` (and the other two units) lists the `HYDRA_TARGET_*` values.

### C3. Merge the swap PRs

- [ ] Merge the direction PR and the target-defaults PR (A3). Let CI settle; after the **last** merge, run `bash scripts/deploy.sh` once (back-to-back master merges can cancel the earlier deploy).

### C4. Reset Target work-state in Redis (current list, verified 2026-09-15)

The runbook's generic delete list is **stale for this host**. Several prefixes it names are now shared with the orchestrator and must be kept.

- [ ] Re-run the census and diff it against this list; any prefix not named below is **kept**:
  ```bash
  docker exec hydra-redis-1 redis-cli --scan --pattern 'hydra:*' | sed -E 's/^(hydra:[a-z0-9_-]+(:[a-z-]+)?).*/\1/' | sort | uniq -c | sort -rn
  ```
- [ ] **Delete** (Target-scoped, all betting leftovers):
  ```bash
  for p in 'hydra:backlog:*' 'hydra:anchors:*' 'hydra:target:design-concept:*' 'hydra:wiring-liveness:*'; do
    docker exec hydra-redis-1 redis-cli --scan --pattern "$p" | xargs -r -n 100 docker exec -i hydra-redis-1 redis-cli DEL
  done
  ```
  On 2026-09-15 these held: `hydra:backlog:*` 8 keys (the retired Redis backlog), `hydra:anchors:*` 3 (`work-queue:processing`, `reframe`, `calibration:index`), `hydra:target:design-concept:*` 4, `hydra:wiring-liveness:*` 9 (betting Brier dark-since/dark-filed markers).
- [ ] **Keep. The runbook lists these, but they are orchestrator-shared now:** `hydra:cycle:*` (orch and GLM dispatch cycles), `hydra:design-concept:*` (orchestrator grill artifacts, including in-flight ones), `hydra:holdback:*` (orchestrator Tier-2 holdback baselines and merge-watch), `hydra:review`, `hydra:blocked:last-escalation`.
- [ ] **Keep** (builder-self): `hydra:autopilot:*` (including `dispatch-outcome:*-dev_target` attribution history), `hydra:metrics:*`, `hydra:scout*`, `hydra:glm*`, `hydra:cost*`, `hydra:memory*`, `hydra:learning*`, `hydra:friction*`, `hydra:attribution*`, `hydra:retro*`, `hydra:proposals*`, `hydra:outcomes:history:*`, `hydra:scheduler*`.
- [ ] Unrelated to the swap and left alone: ~1.2k `hydra:test*` keys in db0.

### C5. Restart and verify grounding

- [ ] `systemctl --user restart hydra-orchestrator.service` (dashboard already rebuilt by `deploy.sh`); the journal shows **no** `[target-config] ... falling back` warnings.
- [ ] `curl -sf http://localhost:4000/api/health | jq`
- [ ] `curl -sf http://localhost:4000/api/outcomes | jq '.outcomes[].name'` lists the 17 outcomes (`orchestrator-self-improvement-share` plus 16 `csb-*`), CSB values `null`.
- [ ] Under the autopilot's env: `env $(cat ~/.config/hydra/target.env | xargs) bash -c 'cd ~/hydra && npx tsx scripts/target/print-target-facts.ts' | jq` shows `name: claw-street-bets`, `githubRepo: gaberoo322/claw-street-bets`, `manifest.ok: true`, `appSubdir: ""`, 11 surface entries.
- [ ] `bash scripts/autopilot/collect-state.sh` (same env) reports the CSB board (`target_ready_for_agent` from `gaberoo322/claw-street-bets`) and `direction_drift=false`.
- [ ] Wiring-liveness shows no `hydra-betting-*` MISSING rows.
- [ ] Within an hour of the web unit being up, `metrics/csb/` exists or the #4477 chore logs a clean "all null" sample.

### C6. Seed and smoke-test one build (autopilot still paused)

- [ ] File one or two small CSB issues for priorities milestone 1 (scaffold follow-ups), each with a `## Files in scope` section, labelled `ready-for-agent`.
- [ ] Run `/hydra-target-build` by hand on one. Confirm: the worktree lands at `~/claw-street-bets/.worktrees/<cycle-id>` (appSubdir empty collapses the nesting), grounding runs the manifest's `verify.test`, a PR opens on `gaberoo322/claw-street-bets`, CI goes green, automerge fires unless it is money-critical.

### C7. Live-verify the pre-swap fixes

- [ ] **#4474**: with the smoke PR open, `collect-state.sh` does not count its issue in `target_ready_for_agent`, and a `decide.py` dry run emits no `dev_target` for it.
- [ ] **#4475**: with the WIP limit's worth of live `in-progress` claims, `decide.py` emits the saturation skip, not a `dev_target` dispatch; an orphaned `in-progress` label (no live slot) does not count.
- [ ] **#4476**: one dispatch each of `sweep_target` and `cleanup_target` reaches `~/claw-street-bets` with no worktree-isolation abort.
- [ ] Any failure: file a `ready-for-agent` issue on `gaberoo322/hydra` naming the observed behaviour, and hold the unpause until it merges if it would burn tokens per turn (the #4475 class).

### C8. Autopilot back to both scopes

- [ ] In `~/.config/systemd/user/hydra-autopilot.service.d/scope.conf`, append a dated comment ("CSB swap landed") and set `HYDRA_AUTOPILOT_SCOPE=all`; `systemctl --user daemon-reload`.
- [ ] Unpause: `curl -sf -X POST http://localhost:4000/api/autopilot/paused -H 'content-type: application/json' -d '{"paused":false}'`; watch the first two turns dispatch `*_target` classes against the CSB board.

---

## Phase D: close out

- [ ] Retire the `csb/founding-pack-direction` branch once the CSB repo carries the pack. (Map #4313 was already closed at handoff on 2026-09-15, when this checklist was written; it stays labelled `keep-open` as the founding reference.)
- [ ] Unrelated operator-only leftovers from the mothball: revoke the Kalshi API key server-side; withdraw the $116.09 Kalshi cash; decide on the remaining `POLYMARKET_*` credentials.
- [ ] Small follow-up, never filed: CONTEXT.md's Outcome Holdback entry should say "unless the outcome declares `holdback: exclude`".

## Rollback

1. Pause autopilot (C0).
2. Remove the three `target.conf` drop-ins, restore `HYDRA_PROJECT_WORKSPACE` in `~/hydra/.env`, `daemon-reload`.
3. `git revert` the two swap PRs on hydra master (direction + defaults) and deploy.
4. Restore Redis: stop `hydra-orchestrator.service`, `docker cp <snapshot> hydra-redis-1:/data/dump.rdb`, `docker restart hydra-redis-1`, start the orchestrator.
5. Scope back to `orch-only` in `scope.conf`; unpause only if the old posture is wanted.

The CSB repo, database and runner can stay in place through a rollback; nothing in Phase B touches the orchestrator.
