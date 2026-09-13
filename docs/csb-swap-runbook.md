# CSB Swap Runbook — pointing Hydra at `gaberoo322/claw-street-bets`

**Status:** Drafted 2026-09-13 as the capstone of wayfinder map [#4313](https://github.com/gaberoo322/hydra/issues/4313) (ticket [#4326](https://github.com/gaberoo322/hydra/issues/4326)). This is the **concrete, one-session instance** of the generic [`target-swap-runbook.md`](./target-swap-runbook.md) for the Claw Street Bets (CSB) successor target ([ADR-0013](./adr/0013-swappable-single-target-builder.md), CSB amendment). Where the two disagree, **this file wins for CSB** — every list below was re-verified against the source tree and the live Redis keyspace on the draft date, and several generic steps turned out to be stale (called out inline as *Correction*).

Every step is written to be executed by the operator in one swap session. Nothing in this document has been executed; the swap is the first act **after** map #4313 closes.

## Inputs

| Input | Where it lives today | Produced by |
|---|---|---|
| `vision.md`, `priorities.md`, `outcomes.yaml` | branch `csb/founding-pack-direction`, `docs/csb-founding-pack/direction/` | #4320, #4319 |
| `config/graduation-gate.yaml` (v1) | same branch, `docs/csb-founding-pack/config/` | #4319, #4359 |
| `.hydra/manifest.json` + `SCAFFOLD.md` (repo scaffold spec) | same branch, `docs/csb-founding-pack/` | #4322 |
| `CONTEXT.md` (61-term glossary) | same branch, `docs/csb-founding-pack/CONTEXT.md` | #4409 |
| `config/risk-template.json` v1 numbers | ticket #4341 (0.5% per trade at stop, 1% hard cap, 3% daily halt, 3% open risk) | #4341 |
| ADR-0013 CSB amendment | merged on `master` (PR #4329) | #4315 |
| Betting mothball state | `~/hydra-swap-backups/` (Redis snapshot + 168 MB Postgres dump); repo archived; units stopped/disabled | #4325 |

The founding-pack branch has **no open PR** and is **not on `master`** — it is a staging branch. The swap session copies from it (or, better, from the CSB repo once SCAFFOLD §10 step 2 has committed `direction/` there — the CSB repo's `direction/` is authoritative from that moment).

## What swaps vs. what stays (CSB-specific)

The generic table still holds. Three surfaces the generic runbook does not mention **also** carry the old target's identity and must be flipped in the same session, or `dev_target` will build against the archived betting checkout:

| Surface | Why it matters | Step |
|---|---|---|
| `hydra-autopilot.service` environment | The autopilot session env carries **no** `HYDRA_TARGET_*` vars (the unit sets only `HOME`/`PATH`; `hydra-pace-gate.sh` and `bootstrap.sh` never source `.env`). Every autopilot-side seam — `scripts/target/print-target-facts.ts`, `collect-state.sh`'s `TARGET_GH_REPO="${HYDRA_TARGET_GITHUB_REPO:-gaberoo322/hydra-betting}"`, `reap_ghrefs.py`, `scripts/branch-prune.sh`'s `HYDRA_TARGET_REPO` fallback — falls back to the **betting** defaults in `src/target-config.ts` when the vars are absent. Under the current `orch-only` pin this is latent; the moment scope returns to `all` it is live. | 2c |
| `worktree-write-fence.sh` main-checkout roots | The installed PreToolUse hook (`~/.claude/hooks/hydra/worktree-write-fence.sh`, source `scripts/claude-hooks/worktree-write-fence.sh`) hardcodes `/home/gabe/hydra-betting/` and `/home/gabe/hydra-betting/web/.worktrees/`. It is the **sole** ghost-write protection for `dev_target` (#3889). | 2d |
| `~/.claude/settings.json` read allow-list | Grants `Read(//home/gabe/hydra-betting/web/**)`; a CSB dispatch will hit permission prompts in a `-p` session without the equivalent. | 2d |

---

## Preconditions

- [ ] **CSB repo exists** per `SCAFFOLD.md` §10 steps 1–5: `gaberoo322/claw-street-bets` (private), default branch `main`, Node pinned to the orchestrator's `.nvmrc`, `package.json` scripts (`test` = real `vitest run`, `typecheck`, `build`, …), the three workflows (`ci.yml`, `automerge.yml`, `deploy.yml`), **branch protection requiring `typecheck-and-test` from day one**, `src/risk/risk-core.ts` + its existence test, the gate-agreement test, an `/api/outcomes` stub returning `null`s so the suite is green at creation.
- [ ] **`.hydra/manifest.json` committed** at the CSB repo root exactly as drafted (`version: 1`, `verify.appSubdir: ""`, 11 `riskCritical.surface` entries, `mutationKillFloor: 60`). It validates against `src/schemas/target-manifest.ts` (strict).
- [ ] **`direction/` committed** in the CSB repo: `vision.md`, `priorities.md`, `outcomes.yaml` from the pack; `config/graduation-gate.yaml` and `config/risk-template.json` v1 alongside.
- [ ] **CSB checkout at `/home/gabe/claw-street-bets`** (`git clone` of `main`, `npm ci` run once at the root — there is no `web/` nesting, so no per-worktree `node_modules` symlink is ever needed; `dev_target` worktrees nest under `/home/gabe/claw-street-bets/.worktrees/<cycle>` and find the root `node_modules` by the upward walk, the #4177 mechanism).
- [ ] **`/home/gabe/claw-street-bets/.env.local`** exists with the CSB Postgres `DATABASE_URL` and read-only Coinbase market-data keys (paper phase: never `can_transfer`, per #4317). No Kalshi/Odds/Polymarket vars.
- [ ] **CSB self-hosted runner** (`github-actions-runner-csb.service`) installed and online; a trivial PR has run CI green and auto-merged (SCAFFOLD §10 step 5).
- [ ] **Postgres**: database `claw_street_bets` created; Drizzle migrations applied by CI's `migrate` job. (Retiring the betting database and revoking the Kalshi keys is #4463 — independent of this swap; do not block on it.)
- [ ] **Maintenance window**: nothing Target-scoped is running today (scope is `orch-only`), so the only thing that pauses is orchestrator self-work while autopilot is paused in Step 0.

---

## Procedure

### Step 0 — Quiesce

```bash
curl -sf -X POST http://localhost:4000/api/autopilot/paused \
  -H 'content-type: application/json' -d '{"paused":true}'
curl -sf http://localhost:4000/api/health | jq '{status, autopilotPause, cycle}'
```

- [ ] `autopilotPause.paused == true`.
- [ ] `cycle` shows no active cycle. `hydra:cycle:active*` locks are reset in Step 3 regardless, but do not swap while a build is mid-flight (the betting-cycle-lock-orphan hazard).
- [ ] No `worktree-agent-*` PR is open on `gaberoo322/hydra` that a paused autopilot would need to resume mid-swap: `gh pr list --repo gaberoo322/hydra --state open --json headRefName --jq '.[].headRefName' | grep -c worktree-agent` should be `0`, or you accept those PRs resume after Step 7.
- [ ] GLM drainer idle: `journalctl --user -u hydra-glm-drainer.service -n 5 --no-pager` shows no `authoring` line in progress (the drainer is orch-only and unaffected, but a mid-swap restart of the orchestrator drops its API calls).

### Step 1 — Snapshot Redis

`redis-cli` is not on the host PATH; Redis runs in Docker as `hydra-redis-1` (the watchdog uses the same path).

```bash
docker exec hydra-redis-1 redis-cli SAVE
mkdir -p ~/hydra-swap-backups
docker cp hydra-redis-1:/data/dump.rdb ~/hydra-swap-backups/dump-pre-csb-swap-$(date +%s).rdb
ls -la ~/hydra-swap-backups/
```

- [ ] New `dump-pre-csb-swap-*.rdb` listed next to the 2026-09-07 mothball snapshot. This is the only undo for Step 3.

### Step 2 — Point every environment at CSB

There are **four** places, not one. Set all four in the same session.

**2a — `~/hydra/.env`** (loaded by `hydra-orchestrator.service` via `EnvironmentFile=`). Today it has only `HYDRA_PROJECT_WORKSPACE=/home/gabe/hydra-betting` and no other target var, so the name/repo/URL fall back to the betting defaults compiled into `src/target-config.ts`. Set every identity var explicitly (ADR-0002):

```bash
HYDRA_TARGET_NAME=claw-street-bets
HYDRA_PROJECT_WORKSPACE=/home/gabe/claw-street-bets
HYDRA_TARGET_GITHUB_REPO=gaberoo322/claw-street-bets
HYDRA_TARGET_WEB_URL=http://localhost:3334
HYDRA_CONFIG_PATH=/home/gabe/claw-street-bets-config
# Second checkout-path var read by collect-state.sh's direction-drift probe and
# scripts/branch-prune.sh (both default to ~/hydra-betting). Same value as the
# workspace; the duplication is a seam defect to file post-swap (see Step 9).
HYDRA_TARGET_REPO=/home/gabe/claw-street-bets
```

`HYDRA_TARGET_WEB_URL` is the canonical name; there is no `HYDRA_BETTING_URL` in `.env` today, so nothing to delete. The unit's `Environment=HYDRA_WORKTREE_DIR=/dev/shm/hydra-worktrees` is the **orchestrator's** worktree dir and stays.

**2b — `~/.config/systemd/user/hydra-orchestrator.service`**: replace the tolerant betting env line (the unit's own 2026-09-11 comment says to do exactly this):

```ini
EnvironmentFile=-/home/gabe/claw-street-bets/.env.local
```

**2c — `hydra-autopilot.service` drop-in (the surface the generic runbook misses).** Create `~/.config/systemd/user/hydra-autopilot.service.d/target.conf`:

```ini
# CSB swap 2026-09-xx: the autopilot session gets NO .env; every Target seam in
# scripts/autopilot and scripts/target reads these from process.env and falls
# back to the retired hydra-betting defaults when absent (src/target-config.ts).
[Service]
Environment=HYDRA_TARGET_NAME=claw-street-bets
Environment=HYDRA_PROJECT_WORKSPACE=/home/gabe/claw-street-bets
Environment=HYDRA_TARGET_GITHUB_REPO=gaberoo322/claw-street-bets
Environment=HYDRA_TARGET_WEB_URL=http://localhost:3334
Environment=HYDRA_CONFIG_PATH=/home/gabe/claw-street-bets-config
Environment=HYDRA_TARGET_REPO=/home/gabe/claw-street-bets
```

Then `systemctl --user daemon-reload`. (Do **not** point `EnvironmentFile=` at `~/hydra/.env` instead — that would also hand the autopilot session Sentry/Telegram tokens it never needed.) Also `export` the same six vars in the interactive shell you will run the Step 6 smoke test from.

**2d — hooks and permissions (operator-owned files, outside the repo):**

- `~/.claude/hooks/hydra/worktree-write-fence.sh`: add `/home/gabe/claw-street-bets/` to the main-checkout root list (line ~115 today) and `/home/gabe/claw-street-bets/.worktrees/` to the worktree-root list (line ~91; note **no `web/`** — `appSubdir` is `""`). Make the same edit in the repo source `scripts/claude-hooks/worktree-write-fence.sh` on a branch and PR it, or the next `setup-claude-hooks.sh` run reverts your installed copy. Keep the betting entries until #4463 removes the checkout; they are harmless.
- `~/.claude/settings.json`: add `Read(//home/gabe/claw-street-bets/**)` beside the two betting `Read(...)` allow entries.
- `~/.claude/hooks/hydra/sync-backlog-on-merge.sh` matches `*hydra-betting*` in cwd and reads `~/hydra-betting`; it is dead after the swap — leave it (it no-ops) or remove it.

**Verify Step 2 before restarting anything** — the seam script is the single source of truth every Target playbook composes on (#4411):

```bash
cd ~/hydra && set -a && . ./.env && set +a
npx tsx scripts/target/print-target-facts.ts | jq
```

- [ ] `name == "claw-street-bets"`, `githubRepo == "gaberoo322/claw-street-bets"`, `workspace == "/home/gabe/claw-street-bets"`, `serviceName == "claw-street-bets-web.service"`, `webUrl == "http://localhost:3334"`.
- [ ] `manifest.ok == true`, `manifest.appSubdir == ""`, `manifest.surface` has 11 entries and `surfaceRepoRelative` equals `surface` (empty subdir is the identity).
- [ ] No `[target-config] … is unset; falling back` warning on stderr.

### Step 2e — Build the external config dir

`config/` holds orchestrator-self prompts **and** the per-target `direction/`. Copy the tree, then replace only `direction/`:

```bash
cp -r ~/hydra/config ~/claw-street-bets-config
rm -rf ~/claw-street-bets-config/direction
mkdir -p ~/claw-street-bets-config/direction
# Authoritative source once committed in the CSB repo; the staging branch is the fallback.
cp ~/claw-street-bets/direction/{vision.md,priorities.md,outcomes.yaml} ~/claw-street-bets-config/direction/
# liveness.yaml: today's copy is an empty `entries:` list — carry it verbatim
# so the wiring-liveness timer chore has a file to read.
cp ~/hydra/config/direction/liveness.yaml ~/claw-street-bets-config/direction/
```

What to do with the seven other betting-shaped direction files (`goals.md`, `roadmap.md`, `tech-preferences.md`, `proposal-policy.md`, `research-journal.md`, `architecture-review.md`, and betting's `priorities.md`/`roadmap.md` pair):

- `roadmap.md` and `goals.md` — **omit**. Their readers (`src/config/roadmap.ts`, `src/project-goals.ts`) return `null` on `ENOENT`; the first `hydra-target-research` cycle writes a CSB `roadmap.md`, and `priorities.md`'s front matter already says it replaces the founding seed.
- `tech-preferences.md`, `proposal-policy.md`, `research-journal.md`, `architecture-review.md` — read only by the research/architect playbooks. Start CSB with an **empty `research-journal.md`** (the Director appends to it) and a three-line `tech-preferences.md` naming the CSB stack (TypeScript strict, Next.js, Postgres/Drizzle, systemd, vitest). Omit the other two.

Two edits to make while copying `outcomes.yaml`:

1. Its header comment says "There is no per-outcome opt-out field today; exclusion is a hardcoded name set in `src/holdback-policy.ts`". That was true at draft time; #4413 shipped the optional per-outcome `holdback: include | exclude` field (default `include`). Update the comment and add `holdback: exclude` to `orchestrator-self-improvement-share` and the terminal `csb-realmoney-pnl-net-usd` if you do not want a code PR's holdback verdict judged against them. Leave the 15 per-strategy leading metrics on `include` — they are exactly what holdback exists to guard.
2. Every `query:` is `metrics/csb/...txt` resolved against `HYDRA_ROOT` (`~/hydra`). **There is no producer for those files yet** — #4410 retired the betting Brier producer, and CSB's `/api/outcomes` sampler is SCAFFOLD §8 work on the CSB board. Until it lands, every leading outcome reads dark and the Tier-2 holdback degrades to "tests passed". That is the expected post-swap state, not a swap failure; do **not** create placeholder metric files with fake values (`wiring-liveness` would then see a live source pinned at a floor).

- [ ] `~/claw-street-bets-config/direction/` contains exactly: `vision.md`, `priorities.md`, `outcomes.yaml`, `liveness.yaml`, `research-journal.md`, `tech-preferences.md`.
- [ ] `grep -c 'name:' ~/claw-street-bets-config/direction/outcomes.yaml` is `17` (1 orchestrator-share + 1 terminal + 15 leading).

### Step 3 — Reset Target work-state in Redis (verified 2026-09-13)

The list below was rebuilt from `src/redis/keys.ts`, every `src/redis/*.ts` adapter, `scripts/autopilot/*`, and a read-only `SCAN` census of the live keyspace on the draft date. It differs from the generic runbook in **four** places — read the *Correction* notes before running anything. Run against `hydra-redis-1`; the Step 1 snapshot is the only undo.

```bash
rc() { docker exec -i hydra-redis-1 redis-cli "$@"; }
del_pattern() { rc --scan --pattern "$1" | xargs -r -n 200 docker exec -i hydra-redis-1 redis-cli DEL; }

# ---- DELETE: Target work-state (keyed by betting issues/anchors/cycles) ----
del_pattern 'hydra:backlog:*'            # retired Target-only Redis backlog: items, counter, lane:*, title-index, reconciler:health
del_pattern 'hydra:anchors:work-queue'   # dev_target work queue (betting item refs)
del_pattern 'hydra:anchors:reframe-queue'
del_pattern 'hydra:anchors:prior-failures'
del_pattern 'hydra:cycle:active'         # cycle locks ONLY — see Correction 1
del_pattern 'hydra:cycle:active:*'
del_pattern 'hydra:target:*'             # hydra:target:design-concept:<anchor> — Target design-concept artifacts written by hydra-target-build Step 4.5 (not in keys.ts; playbook-written)
del_pattern 'hydra:holdback:*'           # Tier-2 outcome baselines per commit + pending-enroll/enrolled-marker/merge-watch:health — all snapshot BETTING outcome values
del_pattern 'hydra:wiring-liveness:*'    # dark-since/dark-filed per betting outcome name + output-series
del_pattern 'hydra:task:*'               # per-cycle task hashes (Target builds)
del_pattern 'hydra:tasks*'
del_pattern 'hydra:deps:*'               # per-cycle task dependencies
```

**Correction 1 — `hydra:cycle:*`.** The generic runbook deletes the whole namespace. Today `hydra:cycle:<hex>` records are written by `POST /autopilot/cycle-record` for **every** dispatch — orchestrator classes included (`reap.py` is the sole writer) — and are joined by `/api/cycle/history`, the dispatch-outcome ledger and usage attribution. Deleting them erases builder history. Delete only the lock keys (`hydra:cycle:active`, `hydra:cycle:active:<source>`); keep `hydra:cycle:<id>`, `hydra:cycle:<id>:tasks` and `hydra:cycle:index`.

**Correction 2 — `hydra:design-concept:*` is orchestrator state, keep it.** Keys are `hydra:design-concept:issue-<N>` for **orchestrator** grill anchors (design_concept_orch is orch-scope by definition) plus `hydra:dc:*` counters. The Target's equivalents live under `hydra:target:design-concept:*` (deleted above). Deleting the generic runbook's `hydra:design-concept:*` would orphan every open orch anchor's grill artifact and fail the design-concept-reconcile gate on their PRs.

**Correction 3 — `hydra:review:*` is orchestrator state, keep it.** `hydra:review:pickup-armed` is the `/hydra-review` phone-notify edge trigger.

**Correction 4 — `hydra:blocked*` / `hydra:regression-hunt*` have no live reader or writer** (only `keys.ts` still names them). Deleting them is harmless hygiene, not a swap step.

```bash
# ---- PRESERVE (builder-self; carries across the swap) — do NOT touch ----
#   hydra:autopilot:*      runs, turns, dispatch-outcome:<cycle>, pr:<N>, slot-events, class-stats, paused/emergency-brake,
#                          recs, retro, launch-flow, pace-gate:last-tick, candidate-exclusions, cascade-telemetry, glm-eligibility
#   hydra:cycle:<id>, :tasks, :index      (Correction 1)
#   hydra:design-concept:*  hydra:dc:*    (Correction 2)
#   hydra:review:*                        (Correction 3)
#   hydra:metrics:*        tokens by-skill/by-cycle/daily, usage-snapshot, claims-reaped, oauth/github backoff, transcript-parse-memo, scope-violations
#   hydra:cost:*           dispatch-join ledger
#   hydra:glm:*            drainer active flag + A/B assignments
#   hydra:attribution:*    hydra:learning:*  hydra:memory:*  hydra:friction:*  hydra:reflections:*  hydra:retro:*
#   hydra:scout:*          hydra:attention:*  hydra:dispatches:*  hydra:scheduler:*  hydra:notifications  hydra:dlq  hydra:alerts
#   hydra:agent-stream  hydra:merge:lock  hydra:capacity*  hydra:cleanup:*  hydra:digest:*  hydra:architecture:*

# ---- OPTIONAL HYGIENE: retired-subsystem residue with no reader (safe any time, unrelated to the swap) ----
#   hydra:specs:*  hydra:reports:*  hydra:proposals:*  hydra:plans:*  hydra:knowledge*  hydra:code*  hydra:adversarial*
#   hydra:pattern-detector*  hydra:events*  hydra:stream*  hydra:outcomes*  hydra:meta*  hydra:scheduler:research-floor:*
#   hydra:blocked*  hydra:regression-hunt*  hydra:test:*   (the last is ~1.2k node:test isolation leftovers)
```

Re-run the census before and after and diff:

```bash
rc --scan --pattern 'hydra:*' | awk -F: '{print $1":"$2}' | sort | uniq -c | sort -rn
```

- [ ] `hydra:backlog`, `hydra:anchors`, `hydra:target`, `hydra:holdback`, `hydra:wiring-liveness`, `hydra:task*`, `hydra:deps` absent.
- [ ] `hydra:design-concept`, `hydra:dc`, `hydra:review`, `hydra:autopilot`, `hydra:cycle` (minus `active*`) counts unchanged.

> The delete-list is explicit, never `FLUSHDB`-minus-allowlist: an unrecognised namespace is preserved. If you add a Target-scoped namespace to the orchestrator later, add it here **and** in the generic runbook.

### Step 4 — Rebuild dashboard + restart

```bash
cd ~/hydra
git status --short            # must be clean: the deploy dirty-tree guard and the boot ExecStartPre=tsc both run from this tree
npm run build --prefix dashboard
systemctl --user daemon-reload
lsof -ti:4000 && echo "port 4000 busy — the restart below handles it; do not npx tsx src/index.ts"
systemctl --user restart hydra-orchestrator.service
journalctl --user -u hydra-orchestrator.service -n 40 --no-pager | grep -E '\[Hydra\] Target:|target-config'
```

- [ ] Boot banner reads `[Hydra] Target: claw-street-bets (workspace: /home/gabe/claw-street-bets)`.
- [ ] No `[target-config] … falling back` warning (each one means a var from 2a did not reach the unit).

### Step 5 — Verify the swap grounded

*Correction:* `/api/scheduler/status` and `/api/health` carry **no** target fields today (the generic runbook's `.targetName`/`.workspace` jq returns `null`). Use the seam script and these endpoints instead:

```bash
curl -sf http://localhost:4000/api/health | jq '{status, deployedSha, originMasterSha}'
curl -sf http://localhost:4000/api/health/deep | jq '.sysdTargetWeb'      # "unknown"/inactive until claw-street-bets-web.service is up — expected
curl -sf http://localhost:4000/api/outcomes | jq '.outcomes | length, (map(.name) | .[0:3])'
curl -sf 'http://localhost:4000/api/autopilot/board-state?scope=target' | jq '{degraded, ready_for_agent, needs_qa, needs_triage}'
cd ~/hydra && bash scripts/autopilot/collect-state.sh 2>/dev/null | grep -E '^target_|^direction_drift='
```

- [ ] `/api/outcomes` returns 17 rows; the first names are `orchestrator-self-improvement-share`, `csb-realmoney-pnl-net-usd`, `csb-trend-ema-…`. Values are `null`/dark — expected (Step 2e note 2).
- [ ] `board-state?scope=target` is `degraded: false` and the counts match `gh issue list --repo gaberoo322/claw-street-bets --state open` (an empty CSB board reads all zeros — that is fine; a `degraded: true` means the repo handle or `gh` auth is wrong).
- [ ] `collect-state.sh` prints `target_ready_for_agent=0` (or the real count) and `direction_drift=false`; if it prints `direction_drift=true`, `HYDRA_TARGET_REPO` is still pointing at `~/hydra-betting`.
- [ ] `journalctl --user -u hydra-orchestrator.service` shows the wiring-liveness chore reading `liveness.yaml` with zero entries, not a betting unit name.

### Step 6 — Smoke-test one build, manually

Seed one trivial CSB issue (a README sentence, or the `/api/health` stub returning a version string) with `## Files in scope` / `## Files out of scope` and the `ready-for-agent` label, then — in a shell where the six Step 2c vars are exported — run `/hydra-target-build` interactively **before** unpausing autopilot. Confirm, in order:

- [ ] The target-seam preamble resolves to CSB (`$TARGET_GH_REPO == gaberoo322/claw-street-bets`, `$TARGET_APP_DIR == $TARGET_WS`).
- [ ] Step 0.6 creates the worktree at `/home/gabe/claw-street-bets/.worktrees/<cycle-id>` from `origin/main` — **not** under `/dev/shm`, **not** under a `web/` subdir, and with no `node_modules` symlink (upward walk finds the root install).
- [ ] The WIP gate counts `label:in-progress` on the CSB repo via REST and reports `0/3`.
- [ ] Grounding runs the manifest's `verify.test` = `npm test` and it is the real vitest suite (no `MIN_PASSING_TESTS` count gate, no `test:raw` split — salvage do-not-carry #6).
- [ ] A PR opens on `gaberoo322/claw-street-bets`; the required `typecheck-and-test` check runs on the CSB runner; `automerge.yml` squash-merges it (or holds it if the closing issue is `money-critical`).
- [ ] `deploy.yml` runs `scripts/deploy.sh` and `claw-street-bets-web.service` answers `http://localhost:3334/api/health`; `/api/health/deep .sysdTargetWeb` flips to active.

If any of the six fails, fix the seam, not the runbook: per the ADR-0013 amendment, "any hydra-betting assumption it surfaces … is a defect to fix at the seam, not a reason to special-case CSB".

### Step 7 — Lift the autopilot scope pin (`orch-only` → `all`)

The pin lives in `~/.config/systemd/user/hydra-autopilot.service.d/scope.conf`. Its 2026-09-01 block says exactly: *"Revert to `all` when the CSB swap lands."* The file also carries three budget lines that must survive:

```ini
Environment=HYDRA_AUTOPILOT_SCOPE=orch-only
Environment=HYDRA_AUTOPILOT_DAILY_SPEND_CAP_USD=0
Environment=HYDRA_AUTOPILOT_QUOTA_WEEK_MAX=5
Environment=HYDRA_AUTOPILOT_QUOTA_5H_MAX=15
```

**Do not delete the file** — that would also drop the three budget caps. Edit the one line to `Environment=HYDRA_AUTOPILOT_SCOPE=all`, prepend a dated comment block in the file's own log style ("2026-09-xx: REVERTED to scope=all — CSB swap landed; Target = gaberoo322/claw-street-bets; the 09-01 pin's premise (no live Target) no longer holds"), then:

```bash
systemctl --user daemon-reload
systemctl --user show hydra-autopilot.service -p Environment | tr ' ' '\n' | grep -E 'HYDRA_AUTOPILOT_SCOPE|HYDRA_TARGET_|HYDRA_CONFIG_PATH|HYDRA_PROJECT_WORKSPACE'
```

- [ ] `HYDRA_AUTOPILOT_SCOPE=all` **and** all six Step 2c vars appear in the unit's effective environment. (The running autopilot process, if any, keeps its old env until the pace-gate's next launch; `RuntimeMaxSec=32400` bounds that at 9 h, or `systemctl --user restart hydra-autopilot.service` now that the merge queue is idle.)
- [ ] Re-read the Per-class model routing note in `docs/operator-playbooks/hydra-autopilot.md`: `dev_target`/`qa_target` are stamped Fable and become live rows the moment scope is `all` — CSB launches money-critical authoring and review at the frontier tier by design.

Then unpause:

```bash
curl -sf -X POST http://localhost:4000/api/autopilot/paused \
  -H 'content-type: application/json' -d '{"paused":false}'
```

Watch the first autopilot turn's `collect-state` output (`journalctl --user -u hydra-autopilot.service -f`): the `target_*` lines must reference CSB counts and `target_board_signals_degraded=false`.

### Step 8 — Pre-swap verification of the three folded dispatch-machinery gaps

These three were folded from swap-readiness #4324 into this checklist by operator decision (2026-09-13) because none is testable against the archived betting board. **Do not file them before the swap.** During the swap session, once Step 7 has produced at least one real `dev_target` dispatch against the live CSB board, run each check; file the issue only where the gap is confirmed real. Each filed issue must carry `## Files in scope` (or `issue-label-validation` demotes `ready-for-agent` to `needs-info`).

**8.1 — Open-PR-ref exclusion for `target_ready_for_agent` (ex-#4227).**

*Claim:* `collect-state.sh` tallies the raw `ready-for-agent` label on the Target repo with no open-PR-ref exclusion, so `dev_target` re-dispatches an issue that already has an open PR. The orch lane already has this exclusion: `ORCH_INFLIGHT_PR_JSON=$(gh pr list --repo gaberoo322/hydra …) | python3 pr-refs.py` (collect-state.sh ~line 727–742). There is no Target twin.

*Verify against the live CSB board:* after the Step 6 smoke PR is **open but not yet merged** (hold it by leaving a `hold-for-operator` label, or seed a second issue and let `dev_target` open its PR), run:

```bash
cd ~/hydra && bash scripts/autopilot/collect-state.sh 2>/dev/null | grep -E '^target_ready_for_agent='
gh pr list --repo gaberoo322/claw-street-bets --state open --json headRefName,body | python3 scripts/autopilot/pr-refs.py
```

If the first line still counts the issue whose number the second command prints, the gap is real (the healthy path through `/api/autopilot/board-state?scope=target` applies the #3059 open-*blocker* filter but no open-*PR* filter; the REST fallback applies neither).

*If real, file THEN:* `ready-for-agent`, title "collect-state: exclude Target issues with an open PR ref from target_ready_for_agent (ex-#4227)". Files in scope: `scripts/autopilot/collect-state.sh`, `scripts/autopilot/pr-refs.py`, `test/collect-state-target-board.test.mts` (or the nearest existing collect-state test). Acceptance: a Target issue referenced by an open CSB PR (branch `issue-<N>-*` or body `Closes #N`) is excluded from `target_ready_for_agent` in both the healthy and the REST-fallback path; the exclusion count is emitted as `target_inflight_excluded=<n>` for telemetry.

**8.2 — Target-WIP-saturation signal (ex-#4241).**

*Claim:* `collect-state.sh` emits no Target in-progress count, so `decide.py` dispatches `dev_target` into `hydra-target-build`'s pre-flight WIP gate (`label:in-progress` ≥ 3 → `BLOCKED: WIP limit reached`), burning ~80k tokens per bounce. The open design point: a bare label count re-introduces the orphaned-claim false positive (a stale `in-progress` label with no live process — operator memory: *Target WIP gate wedges on orphaned claims*), so the signal needs liveness, or the WIP limit's single source must move out of the playbook.

*Verify against the live CSB board:* with three CSB issues labelled `in-progress` (two can be deliberately orphaned test issues), run one autopilot turn and read the dispatch log. If `decide.py` still emits a `dev_target` dispatch and its transcript ends at `BLOCKED: WIP limit reached (3/3 in-progress)`, the gap is real. Also grep `collect-state.sh` output for any `target_in_progress=` line — today there is none.

*If real, file THEN:* `needs-design-concept` + `ready-for-agent` (it has an unresolved design point, so it should be grilled first), title "autopilot: Target-WIP-saturation signal with liveness — stop dispatching dev_target into a full WIP gate (ex-#4241)". Files in scope: `scripts/autopilot/collect-state.sh`, `scripts/autopilot/decide.py`, `docs/operator-playbooks/hydra-target-build.md`, `docs/operator-playbooks/hydra-autopilot.md`. The grill must decide between (a) a `target_in_progress_live` count that cross-checks each `in-progress` issue against `hydra:dispatches:subagent:*` liveness, and (b) moving the WIP limit constant into `classes.json` so `decide.py` owns it and the playbook reads it.

**8.3 — Worktree-isolation carve-out beyond `dev_target` (ex-#4293).**

*Claim:* the #3889 carve-out (omit `isolation="worktree"`) covers `dev_target` only; `cleanup_target` hard-aborted under harness isolation, and every other `*_target` class that touches the Target working tree (`research_target`, `qa_target`, `sweep_target`, `discover_target`, `cleanup_target`, `wire_or_retire_target`, `design_qa_target` — the 8 `scope: target` rows in `scripts/autopilot/classes.json`) is exposed. The resolution wants a scope predicate in the dispatch table plus a per-class worktree-guard preamble variant, so the #4178 false-abort trap does not widen, decided together with which Target classes survive for CSB.

*Verify against the live CSB board:* let scope `all` run until each of `cleanup_target`, `research_target`, and `sweep_target` has fired once (cooldowns 1 h / board-empty-driven / 15 min). For each, read the dispatch transcript (`/api/agents/stream?agent=<worktreeBranch>` or the `reap.py` completion line). A transcript that aborts on `worktree-isolation-broken` or on the default preamble's `cwd == /home/gabe/hydra → ABORT` when it needed to `git -C /home/gabe/claw-street-bets …` confirms the gap for that class. `self_heal.py` classifies these as `worktree-isolation-broken` (ABORT, never auto-retry), so they will also show up in the reap-side friction counts.

*If real, file THEN:* one issue per **confirmed** class family, `ready-for-agent`, title "autopilot: scope predicate + per-class worktree-guard variant for `<class>` (ex-#4293)". Files in scope: `docs/operator-playbooks/hydra-autopilot.md` (dispatch table row + Worktree-guard preamble section), `scripts/autopilot/classes.json` (a `harnessIsolation: true|false` column), `scripts/autopilot/decide.py` (emit it on the action), and the affected `docs/operator-playbooks/hydra-target-*.md`. Also decide in the same issue whether the class survives at all for CSB (e.g. `design_qa_target` presumes a rendered UI; CSB has a dashboard from SCAFFOLD milestone 7 only).

### Step 9 — Follow-ups this runbook's research surfaced (file after the swap, not now)

Each is a seam defect in the ADR-0013 sense, discovered while verifying the steps above; none blocks the swap.

1. `src/target-config.ts` compiles `hydra-betting` / `gaberoo322/hydra-betting` / `http://localhost:3333` as **soft defaults** with a warning. After the swap those defaults name an archived repo; an unset identity var should **fail closed** (throw `InvalidArgumentError`), which would also have made the Step 2c gap impossible to miss.
2. `HYDRA_TARGET_REPO` (collect-state direction-drift, `branch-prune.sh`, `hydra-target-build.md` §direction docs) duplicates `HYDRA_PROJECT_WORKSPACE`. Collapse to the canonical var.
3. `scripts/hydra-watchdog.sh` lines ~384–396 still probe `hydra-betting-{ingest,scan,alerts}` and `localhost:3333/api/kalshi/balance`; and its `/home/gabe/hydra-betting/web/node_modules` integrity check (~line 999) should become the CSB root `node_modules`. Both are Tier-3 (watchdog scripts).
4. `scripts/claude-hooks/worktree-write-fence.sh` hardcodes the Target checkout roots (Step 2d) — derive them from `print-target-facts.ts` or a config file.
5. `scripts/ci/hydra-target-cleanup-emit.ts` and `scripts/ci/hydra-target-wire-or-retire-emit.ts` export `TARGET_REPO = "gaberoo322/hydra-betting"` as constants (baselined by the target-coupling ratchet) — route through `getTargetGithubRepo()`.
6. The generic `target-swap-runbook.md` Step 3 and Step 5 corrections above (cycle records, design-concept, review, scheduler-status fields) should be folded back into the generic runbook once this swap has proven them.
7. Add the `hydra:target:*` namespace to `src/redis/keys.ts` (or a `src/redis/target-design-concept.ts` adapter) so the Target design-concept key is discoverable from the central key surface rather than only from a playbook heredoc.

---

## Rollback (swap back to the mothballed betting checkout)

Only meaningful while `~/hydra-betting` and its Postgres still exist (#4463 open):

1. Pause autopilot (Step 0) and set `scope.conf` back to `orch-only` (there is no live betting board to dispatch against).
2. Revert 2a–2d (restore `HYDRA_PROJECT_WORKSPACE=/home/gabe/hydra-betting` and remove the other five vars, restore the orchestrator unit's betting `EnvironmentFile=-` line, remove `target.conf`).
3. Stop the orchestrator, `docker cp` the Step 1 `dump-pre-csb-swap-*.rdb` back to `hydra-redis-1:/data/dump.rdb`, restart the Redis container, then rebuild + restart (Step 4).
4. Verify the boot banner reads `hydra-betting`. Unpause.

## Outcome-measurability note

CSB's outcomes are unusually well specified for a fresh target — 15 leading metrics with pre-registered Stage-A floors and holdback noise bands — but until SCAFFOLD §8's `/api/outcomes` sampler lands on the CSB board, all of them read dark. Plan the first CSB milestones (scaffold → candle store → fill model + backtester → strategies + controls → paper loop + outcome writers) knowing the builder flies on "tests pass" alone until milestone 5. That is the honest state the vision asks for ("profit reads zero until a strategy graduates"), not a swap defect.
