# Hydra Reference

On-demand reference material. Not loaded automatically — read when needed.

For module roles and file structure, explore `src/` directly — static inventories rot faster than code changes. Every table-shaped inventory (Redis keys, streams, routes, config, env vars, tier paths, dispatch classes, units and scripts) is **generated** under `docs/generated/` and drift-guarded in CI; this file keeps only the per-subsystem narrative those tables cannot carry.

## Redis Keys

Generated: see `docs/generated/redis-keys.json`. Keys are typed behind the Redis Adapters (`src/redis/*.ts`, ADR-0009); the inventory lists each family's pattern, accessors and serving routes.

## Event Bus

Generated: see `docs/generated/streams.json`. The Redis Streams event bus lives in `src/event-bus.ts` and fans out over WebSocket to dashboard clients; consumer groups and retention are rows of that inventory.

## API Endpoints (port 4000, all under /api)

Generated: see `docs/generated/routes.json`. Routes are split into domain sub-routers in `src/api/` (each exports a `create*Router(eventBus?)` factory) and classified by `src/operator-actions/parity.ts` (ADR-0034 §9); `POST /kill` and `POST /research/start` were retired under ADR-0024 §3 (issue #4638). The work queue is a Redis LIST (`hydra:anchors:work-queue`) with no per-item id addressing; read it via `GET /api/autopilot/work-queue`.

## Target Outcomes (issue #241, ADR-0003 + ADR-0015)

`config/direction/outcomes.yaml` declares the structured contract between target vision (prose) and orchestrator behavior (code). Loader: `src/outcomes.ts`. API: `GET /api/outcomes`.

**Schema (per outcome):**

| Field | Required | Type | Notes |
|---|---|---|---|
| `name` | yes | string | Unique identifier; lowercase + dashes |
| `kind` | yes | `leading` \| `terminal` | `leading` = usable inside Tier-2 5-cycle holdback windows; `terminal` = ultimate goal, too slow for holdback |
| `direction` | yes | `up` \| `down` | Favorable direction for the value |
| `source` | yes | `file` | Adapter dispatch in `getOutcomeValue`. `file` is the only implemented source (#933); a non-`file` value fails schema validation |
| `query` | yes | string | Source-specific lookup (for `file`: a path resolved against `HYDRA_ROOT` holding a single numeric value) |
| `baseline` | yes | number | Starting reference |
| `target` | yes | number | Goal value |
| `noise_epsilon` | no (default 0) | number | Absolute change below this is treated as no-move |
| `attribution_window_ms` | no | number | Per-metric attribution-window duration in ms (#2632); omit ⇒ the recorder's conservative default. Only meaningful for `leading` |
| `holdback` | no (default `include`) | `include` \| `exclude` | `exclude` marks a leading outcome as market-driven / display-only: still read, trended and attributed, but never drives an Outcome Holdback revert (#4413). Inert on `terminal` outcomes, which are never holdback-eligible. Replaces the retired hardcoded name set in `src/holdback-policy.ts` |

(The `stuckness_threshold_cycles` field was removed in ADR-0010 along with the detector it fed.)

**Source adapters:** `file` is the only implemented source (reads a number from a path resolved against `HYDRA_ROOT`). The earlier `api`, `prometheus`, and `sql` arms were unimplemented stubs (logged + returned `null`); they were removed in #933 — a single real adapter is a hypothetical seam, not a real one (LANGUAGE.md), so the `OutcomeSource` union was narrowed to `file` and a non-`file` `source:` now fails schema validation. The dispatch switch re-opens for a genuine reason the day a second source lands (see the `FUTURE SOURCES` note in `src/outcomes.ts`). The YAML parse (comment stripping + scalar coercion + document walk) lives in its own Module `src/outcomes-yaml.ts` with its own test surface (`test/outcomes-yaml.test.mts`), separate from `validateOutcome`'s outcome-specific rules.

**Error handling:** `loadOutcomes()` never throws. Returns `{ ok: false, errors: string[] }` on parse / schema violations. Missing file is `{ ok: true, outcomes: [] }` so projects start with no outcomes declared without crashing.

**Dependency chain:** Foundational for ADR-0004 work-order — #244 (Tier-2 outcome holdback) imports `loadOutcomes` and `getOutcomeValue`.

## ADR-0002 target swap (issue #258 / #259)

The orchestrator builds one Target Project per instance. The operator switches targets by editing the env vars below and restarting the service. All path/name lookups route through `src/target-config.ts` rather than reading the env directly.

| Var | Default | Effect |
|---|---|---|
| `HYDRA_PROJECT_WORKSPACE` | `<homedir>/<HYDRA_TARGET_NAME>` (with one-time warn) | Absolute path to the target workspace. Drives where `hydra-target-build` subagents run, where context-builder reads, where worktrees are rooted, etc. |
| `HYDRA_TARGET_NAME` | `claw-street-bets` (with one-time warn) | Short slug used for the systemd unit name (`${name}-web.service`), the worktree directory prefix (`${name}-worktree`), and operator-instruction strings. |
| `HYDRA_TARGET_GITHUB_REPO` | `gaberoo322/claw-street-bets` (with one-time warn) | GitHub repo identifier in `owner/repo` form. Read via `getTargetGithubRepo()` / `getTargetCommitUrl(sha)` wherever a Target commit link is rendered. |
| `HYDRA_TARGET_WEB_URL` | the localhost soft default (no warn) | Base URL of the Target's web service, read via `getTargetWebUrl()`. `HYDRA_BETTING_URL` is its deprecated legacy alias (one-time warn). |
| `HYDRA_WORKSPACE` | — | **Deprecated.** Legacy alias for `HYDRA_PROJECT_WORKSPACE`. `getTargetWorkspace()` falls back to it with a one-time deprecation warning. |

`src/target-config.ts` exposes seven pure leaf-level helpers — `getTargetName()`, `getTargetWorkspace()`, `getTargetServiceName()`, `getTargetWorktreePrefix()`, `getTargetGithubRepo()`, `getTargetCommitUrl(sha)`, `getTargetWebUrl()` — that memoize their warnings so each fires at most once per process. Per ADR-0002, the helpers return a single string each; no multi-target abstraction.

## Target worktree lifecycle (issue #2115 / #2465 / #3136 / #4177)

A code-writing dispatch into the Target (`hydra-target-build`) runs in a fresh worktree under `~/hydra-betting/web/.worktrees/` (relocated off `/dev/shm/hydra-worktrees/` in issue #4177 — see below), on a branch named `feature/claude-cycle-<timestamp>`. On a **clean** finish the harness removes the worktree and the branch is deleted. When a dispatch **crashes or exits uncleanly**, the worktree dir *and* its `.git/worktrees/<id>` registry entry survive with the feature branch still checked out — and because git refuses `git branch -D` on a branch a registered worktree still holds, that stale branch cannot be reclaimed until its worktree is removed.

**Why `web/.worktrees/`, not `/dev/shm` (issue #4177, prevention half of #4175):** the prior `/dev/shm/hydra-worktrees/` location had no `node_modules` ancestor, so a per-worktree `npm ci` install (~975M RAM per concurrent worktree) or, worse, a reach-back symlink straight at `~/hydra-betting/web/node_modules` was needed. On 2026-08-19 that symlink let a destructive install step inside a worktree wipe the main checkout's real `node_modules`, taking down six money-critical Target services for ~70 minutes (issue #4175). Nesting the worktree under `~/hydra-betting/web/` instead lets Node's upward module-resolution walk find the real `web/node_modules` as an ancestor with **no symlink and no per-worktree install** — the walk is a resolver *read*, so a destructive `rm -rf node_modules/` inside the worktree only ever targets a local path that was never created there, and has nothing to destroy. `~/hydra-betting/.worktrees/` (not nested under `web/`) would NOT work — the walk from `<wt>/web/src` never reaches `~/hydra-betting/web/node_modules` unless `.worktrees` sits directly inside `web/`.

Two reclaim paths remove those orphans, both delegating to the one pure classifier + orchestration in `src/worktree-orphan.ts` (`classifyOrphanWorktree` / `pruneOrphanedTargetWorktrees`):

| Path | When | Where |
|---|---|---|
| Startup prune | Once per process boot, before the stale-branch sweep | `src/index.ts` |
| Hourly housekeeping chore | Every housekeeping tick (`worktree-orphan-prune`) | `src/scheduler/chores/worktree-orphan-prune.ts` |

The hourly chore (issue #3136) is the backstop for orphans created *between* restarts — a mid-cycle crash whose worktree only crosses the 6h age floor hours later would otherwise survive until the next boot and fail the branch-cleanup path on every tick. Both paths apply the **same never-touch-first liveness discipline**: a worktree is reclaimed ONLY when it is not the main tree, not the current branch, inside the `~/hydra-betting/web/.worktrees/` scope prefix, not held by a **live** agent PID (`kill -0` probe; an invalid/unknown PID is treated as live), and past the **6h age floor** (`DEFAULT_WORKTREE_MIN_AGE_SECONDS`) — so an in-flight dispatch that has not yet written its lock file is never destroyed. The reclaim is idempotent (a second run over an already-clean set is a no-op) and never-throwing. Triggered cleanups surface on the `[Housekeeping]`/`[Hydra]` log channel (a clean tick is silent). Worktrees **outside** the `~/hydra-betting/web/.worktrees/` prefix are deliberately left for the broader `hydra-branch-prune` skill's multi-pass GC.

## Modification Tiers (issue #243, ADR-0001 + ADR-0004 + ADR-0015)

Every PR is classified by blast radius on the monotonic ladder **T1 (shallowest) → T4 (deepest)** based on the files it touches; required verification depth ascends with the tier (ADR-0015 replaced the old "who merges this" framing with "how much verification it must clear", and renamed the deepest tier from *Untouchable Core* to *Verifier Core*). The classifier (`src/tier-classifier.ts`) is invoked by the `tier-gate` CI job and exposed at `GET /api/tier?files=a,b,c`. The per-tier path lists are generated — see `docs/generated/tier-paths.json`.

| Tier | Required verification depth |
|---|---|
| **T1 — Prompt-shaped** | CI green + QA PASS, then auto-merge |
| **T2 — Skill / verification** | CI green + QA PASS, then auto-merge; **Outcome Holdback** (post-merge watch + auto-revert if Target Outcomes regress) |
| **T3 — Core `src/` + demoted infra** | CI green + QA PASS (adversarial reviewer, raised mutation floor, scope-clean), then auto-merge |
| **T4 — Verifier Core** | CI green + the SHA-bound `Verifier-Core deep-QA: PASS @ <sha>` marker, verified by the base-ref `deep-qa-gate` required check (the Live-Gate Invariant, ADR-0020). The 6 self-referential files; the operator is reached only through an exhausted remediation loop (a 2nd failed deep-QA pass) |

Every tier auto-merges once it clears its depth: tier names verification depth, not merge authority (ADR-0015).

**Multi-file PRs:** the highest tier wins (most verification / scrutiny).

**Verifier Core list (`VERIFIER_CORE_PATHS` / `isVerifierCore` in `src/untouchable.ts`):** `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`, `.github/workflows/deep-qa-gate.yml`, `scripts/tier-classify.ts`, `src/tier-classifier.ts`, `src/untouchable.ts`. ADR-0015 (#737) shrank the deepest tier to exactly 5 self-referential files and demoted the former Tier-0 infra paths (`src/cost/`, the watchdog scripts, `scripts/deploy.sh`) down to T3; ADR-0020 (#847) then added a 6th self-referential file, `deep-qa-gate.yml` (the required check that verifies the SHA-bound Deep-QA PASS marker), bringing the list to 6. The pre-#383 entries `src/gate.ts` / `src/verification.ts` / `src/post-merge.ts` / `src/control-loop.ts` / `src/redis-adapter.ts` no longer exist (removed with the codex cut-over, ADR-0006). "Untouchable Core" is the retired name for the Verifier Core.

**The `operator-approved` label:** the #744 emergency brake — a manual operator override, no longer a merge requirement. It is not what gates T4; the Deep-QA PASS marker is. GitHub doesn't enforce per-user labels natively, so the convention is that only the operator account (gaberoo322) applies it.

**Extending the T2 list:** add a path to `TIER_2_PREFIXES` or `TIER_2_FILES` in `src/tier-classifier.ts`. Note: `src/tier-classifier.ts` is itself a Verifier Core (T4) file, so the change clears the deep-QA marker.

**Adding a Verifier Core path:** modify `VERIFIER_CORE_PATHS` in `src/untouchable.ts`. Same self-protection — the file is in its own list.

**CLI wrapper:** `npx tsx scripts/tier-classify.ts <file1> <file2> ...` prints JSON `{tier, reason, files, operatorApproved, perFile}`. The legacy `--operator-approved` flag is accepted as a no-op and the exit code no longer encodes the tier. Accepts piped input (`gh pr diff --name-only N | npx tsx scripts/tier-classify.ts`).

## Outcome Holdback — Post-merge Regression Check (issue #786, ADR-0004 step 4)

T2, T3 and T4 merges are enrolled in an **Outcome Holdback** (issue #741): the orchestrator watches the **leading** Target Outcomes (declared in `config/direction/outcomes.yaml`, kind `leading`) for a tier-aware window after the merge. If any leading outcome regresses unfavorably past its `noise_epsilon` vs the pre-merge baseline, the commit is **auto-reverted** via a `git revert` PR.

**This is the autopilot-only producer, not an in-process watcher.** The original in-process timer-watcher (with its `src/post-merge.ts` / `src/control-loop.ts` wiring and its tier-2 kill-switch key) was **deleted in the ADR-0006 codex cut-over** and is gone. The replacement is the **hydra-qa Post-merge Regression Check** (`docs/operator-playbooks/hydra-qa.md` → "Post-merge Regression Check"): request-scoped work the autopilot poll loop dispatches *after* a merge — no timer, no sampler, no long-lived loop (reintroducing one is the orphaned-recorder failure mode that retired the stuckness detector, ADR-0010). Holdback is read-only with respect to merge; its only action is to open a revert PR.

Implementation seam:
- `src/holdback.ts` — request-scoped producer: `enrollHoldback` (snapshot baseline), `checkHoldback` (sample, detect regression, enforce cap, emit events, return a `decision`), `reportRevertFailed`.
- `src/holdback-policy.ts` — the pure enrollment policy: which tiers enroll, the tier-aware watch window, and `isHoldbackEligibleOutcome`.
- `src/redis/holdback.ts` — typed Redis accessor for the per-merge baseline + per-day revert counter (ADR-0009 seam).
- `src/outcomes.ts` — `snapshotLeadingOutcomes` / `detectRegressions` helpers (leading-only, null = no-data).
- `src/api/holdback.ts` — `POST /api/holdback/{enroll,check,revert-failed,pending}` and `GET /api/holdback/enrolments`, the HTTP surface the playbook drives.
- `src/operator-channel/route-event.ts` — the consumer of the holdback.* events: `holdback.revert_failed` is a Page, the others are Morning Brief items (ADR-0045).

### Redis state

The per-merge baseline (`hydra:holdback:baseline:{commitSha}`, default 14d TTL) and the per-UTC-day revert counter (`hydra:holdback:reverts:{date}`, 7d TTL) are rows of `docs/generated/redis-keys.json`.

### Events

Published on `STREAMS.NOTIFICATIONS` (routed by `src/operator-channel/route-event.ts` to the Operator Channel):

- `holdback.reverted` — a leading outcome regressed and the revert was warranted. Payload: `{commitSha, prNumber, regressedOutcomes}`.
- `holdback.cap-reached` — per-day revert cap hit; the regression was surfaced but the revert suppressed. Payload: `{commitSha, prNumber, regressedOutcomes}`.
- `holdback.revert_failed` — the playbook's `git revert` / PR-open failed after a warranted revert. Payload: `{commitSha, reason}`.

### Tunables (named, env-overridable — ADR-0005)

Defaults live in `src/holdback-policy.ts` (windows), `src/redis/holdback.ts` (cap, TTL) and `src/outcome-regression.ts` (cycle length); documented in `config/direction/outcomes.yaml`:

- `HYDRA_HOLDBACK_WINDOW_CYCLES` (default 5) — the T2 floor of the tier-aware watch window; `HYDRA_HOLDBACK_WINDOW_CYCLES_T3` (default 7) and `HYDRA_HOLDBACK_WINDOW_CYCLES_T4` (default 10) carry it up the ladder, clamped monotonic.
- `HYDRA_HOLDBACK_MAX_REVERTS_PER_DAY` (default 3) — global per-UTC-day revert cap.
- `HYDRA_HOLDBACK_BASELINE_TTL_SECONDS` (default 14d) — baseline-record TTL.
- `HYDRA_HOLDBACK_CYCLE_MS` (default 1h) — wall-clock per cycle, used to decide when a window has elapsed.

### Behavior guarantees

- **Terminal outcomes are excluded.** Only `kind: leading` outcomes drive the holdback decision — terminal outcomes are too slow for the window (ADR-0004; `outcomes.yaml` schema comment).
- **Adapter outages are no-data, not regressions.** A null reading on either side of the comparison never counts as a regression ("no false revert").
- **Enroll only fires when at least one leading outcome adapter returned data.** An all-null baseline makes every future regression unknowable, so such a merge sits as "no signal" rather than a false holdback.
- **Regression = unfavorable move past epsilon.** A favorable move, or a move within `noise_epsilon`, is not a regression.
- **Per-day revert cap precedes any revert.** Once the cap is reached the producer emits `holdback.cap-reached` and suppresses further reverts for the UTC day. The cap counter fails closed on a Redis error (treats the cap as reached) — a runaway revert loop is far more expensive than missing one revert.

### Scope (recap)

T1 (prompt-shaped) merges are never enrolled; T2, T3 and T4 always are, with the window deepening by tier (issue #741, building on the #786 T2 floor).

## GitHub API rate-limit handling (issue #3137)

All `gh`/`git` invocations funnel through the **GitHub CLI Adapter** (`src/github/exec.ts` + `gh.ts`). Rate-limit handling lives on that seam.

**Quota expectations.** The orchestrator authenticates `gh` with a subscription-backed token, so it draws on GitHub's per-user quotas:

| Pool | Endpoint shape | Limit |
|---|---|---|
| REST `core` | `gh api repos/.../pulls/<n>` (the `viewPr` default, issue #968) | 5,000 requests/hour, per user |
| GraphQL | `gh pr view --json`, `gh issue list --json` (legacy `viewPr` opt-out) | 5,000 points/hour, per user — a running autopilot drains this pool first |
| Secondary / abuse | any burst of concurrent or rapid-fire mutations | undocumented dynamic limit; delivered as HTTP 403 "secondary rate limit" |

Primary limits reset hourly; secondary limits are dynamic. A rate-limit response is always **HTTP 403** (not 429) and carries a structured `rate_limit_error` body.

**Detection.** `classifyFailure` (in `exec.ts`) maps a rate-limit stderr to the `gh-rate-limited` `HydraErrorCode` — matched **before** the generic 403 auth check so it is not mis-classified as `gh-auth-failed`. The matcher (`isRateLimitStderr`) recognizes the primary limit (`API rate limit exceeded`), the secondary/abuse limit (`secondary rate limit`), and the JSON `rate_limit_error` token.

**Adaptive backoff.** On a `gh-rate-limited` result, `gh.ts` arms an exponential-backoff gate persisted in Redis (`hydra:metrics:github-api:rate-limit-backoff`, `src/redis/oauth-backoff.ts`): base 30s, doubling per consecutive failure, capped at ~15min, 24h TTL. It is the `gh`-API sibling of the OAuth-meter ladder (issue #2840) — persisted so it survives a `systemctl restart`, fail-open (a Redis outage degrades to no gate), and hydrate-clamped (a stale/hostile `nextAttemptMs` can never park calls longer than a freshly-armed max backoff). A successful `gh` call clears the gate so recovery resets the ladder. Every rate-limit hit emits a structured `console.error` warning naming the consecutive-failure count and the next-attempt instant, so a sustained limit surfaces in `journalctl` instead of being a silent retry storm.

**KNOWN CLI CONSTRAINT (why suggested-fix items #1/#2 are only partially met).** The `gh` CLI does **not** surface the raw HTTP response headers, so `x-ratelimit-remaining` / `x-ratelimit-reset` are **not readable** from a `gh` invocation. Consequences:
- The exact quota-reset instant cannot be read — the backoff is therefore keyed off the structured `rate_limit_error` classification (which IS reliably present), not off `x-ratelimit-reset`. This is the correct-and-implementable design given the CLI boundary.
- The "warn when quota drops below 20%" health check (which needs `x-ratelimit-remaining`) is **not implementable via the CLI** and is deferred. A future path is to reserve one `gh api rate_limit` probe (whose JSON body — distinct from the abstracted headers — does report `remaining`/`reset`) and surface that into `/api/health`; that is a follow-up, not this change.

## Model Tiers

The orchestrator no longer routes per-call models — model selection is the harness's job. Claude Code dispatches subagents on whichever model the operator's subscription chooses, and each dispatch class pins its model in `scripts/autopilot/classes.json`. Generated: see `docs/generated/classes.json` for the per-class model column. Tiers are for accounting/limits visibility only; quota accounting flows through the **Cost** module and **Subscription Usage Tracker** (see `CONTEXT.md`), and the legacy dollar-denominated daily-spend surrogate was retired (see `docs/historical/`).

## Learning System (operational)

Conceptual definitions live in `CONTEXT.md` (**Pattern Memory**, **Reflections**). This is the operational detail.

**Redis-native. Two tiers:**

> The former primary tier — an OpenViking session per dispatch, committed at
> close to extract patterns as searchable embeddings — is **RETIRED**
> (ADR-0033). Its module (`ov-session.ts`) and every `.commit()` caller were
> already gone before the retirement, so this section described a capability
> that no longer existed; the learning system is Redis-native with no fallback
> relationship to anything.

1. **Redis patterns:** consolidated patterns in `hydra:memory:{agent}:patterns` with hit counts. At `PROMOTION_THRESHOLD` (3, exported from `src/pattern-memory/constants.ts`) a pattern is promoted — promotion only stamps `promoted` / `promotedAt` on the Redis pattern record (the lesson-file write and the `to-*.md` feedback files were retired with the codex cut-over, ADR-0006) — and a `meta-friction` GitHub issue is opened (issue #512). Stale one-offs pruned after 14 days.
2. **Episodic reflections:** on subagent failure, a structured reflection is stored in `hydra:reflections:{ref}` (7-day TTL); re-injected when the same anchor/file is retried.

**Cue taxonomy (issue #524)** — two QA cues, split because they describe different things. The per-cue threshold table is `CUE_ESCALATION_THRESHOLDS` in `src/pattern-memory/cue-policy.ts`:
- `acceptance-criterion-unmet` — true defect; escalates to a GitHub issue at its (high) per-cue threshold.
- `acceptance-criterion-deferred` — only verifiable post-deploy/runtime/by-operator (metadata, not a defect); threshold 20+, and it is metadata-only (`isMetadataCue`). Migrate pre-split entries with `bash scripts/cleanup/reclassify-deferred-acs.sh --apply`.

## Config (`~/hydra/config/`) — git-tracked

Generated: see `docs/generated/config.json` (every file under `config/`, with its section and readers; `unread: true` rows have no live reader). Operator edits these (or uses the dashboard):

- `config/direction/vision.md` — **target product** vision (prose)
- `config/direction/outcomes.yaml` — structured **Target Outcomes** metrics (ADR-0003)
- `config/orchestrator/vision.md` — **orchestrator-self** vision (trade-offs when ambiguous)
- `config/direction/priorities.md` — what to work on next (refreshed by `/hydra-target-research`)
- `config/research/` — research agent configs (director, domain/technical/market researchers, strategist)

`config/direction/goals.md` was deleted. The legacy `config/*.md` agent personality files (`architect.md`, `builder.md`, …) are still on disk but have no reader; they and the retired `config/feedback/to-*.md` files date from the codex cut-over — see `docs/historical/`. Runtime state is all in Redis (see **Redis Keys** above).

## Backups

Generated: see `docs/generated/units-scripts.json` for the backup timers, services and scripts. Two nightly systemd timers copy the stateful stores off their docker volumes onto the SATA SSD at `/mnt/hydra-ssd/backups/` — a device physically distinct from the docker volumes, so a `docker volume rm`, a compose-recreate gone wrong, or volume corruption no longer loses the data. The orchestrator's Redis dump (`scripts/redis-backup.sh`, daily 03:15) and the hydra-betting Postgres dump (host-only, daily 03:00) each keep a 7-day retention window (`find -mtime +7 -delete`), fail loud on empty/errored output (rm-on-fail, exit 1, `[…] FAILED` on stderr), print a `[…] OK: <file> (<size>)` line on success, and route `OnFailure=hydra-notify-failure@%n` to the shared Operator Channel notify template (instance-parameterized `%i`, zero edits per new unit). Since ADR-0045 D2 (issue #5046) that template runs `scripts/operator-notify.ts` (subcommand `service-failed --unit %i`) under `/usr/bin/node --experimental-strip-types`: a SIGTERM / exit 143 stop never pages, only orchestrator / autopilot / tunnel / backup units page (every other unit lands in the Morning Brief), and the same CLI (`page` / `resolve` / `brief`) is what the watchdog's alarm blocks call — no bash or unit file talks to the Bot API directly (enforced by `scripts/ci/telegram-seam-check.ts`).

**What is in-repo vs. host state.** The Redis backup is fully repo-tracked and deploy-installed (issue #4604): `scripts/redis-backup.sh` plus `scripts/systemd/hydra-redis-backup.{service,timer}` live in the repo, and `scripts/deploy.sh` installs the units (`install -D` into `~/.config/systemd/user/`), the script copy (`~/.local/bin/hydra-redis-backup.sh`), and `enable --now`s the timer — the same convergent shape as the watchdog / test-proc-reaper / GLM-drainer timers, idempotent on re-deploy. The Postgres sibling stays host-only (script at `~/.local/bin/hydra-pg-backup.sh`, units under `~/.config/systemd/user/`, installed by hand): one hand-installed timer is exactly how the Redis backup silently went uninstalled for months, so new timers ship tracked + deploy-installed. Deploy also seeds a first dump when no `hydra-redis-*.rdb.gz` newer than 36h exists (`systemctl --user start --no-block`): the seed never blocks or fails the deploy — a failed seed pages via the unit's `OnFailure=` template instead.

**Detection when it breaks.** The watchdog's `run_redis_backup_freshness` block (`scripts/hydra-watchdog.sh`) flags a missing or stale dump (default threshold 36h — one daily cadence plus a late-run margin), alerts once per staleness episode onto `hydra:notifications`, and logs when the timer is not enabled; `/hydra-doctor`'s Timer Health loop covers the timer and prints the newest backup file + age.

**Redis backup mechanism.** `scripts/redis-backup.sh` fires `BGSAVE` inside `hydra-redis-1`, then polls `INFO persistence` until the save has genuinely LANDED — `rdb_last_save_time` advanced past the pre-snapshot value **and** `rdb_bgsave_in_progress==0` **and** `rdb_last_bgsave_status==ok` (30s bounded, fail-loud on timeout or `err`) — before `docker cp`-ing `/data/dump.rdb` out of the volume (no sudo on `/var/lib/docker`) and gzipping it. This never races an in-flight or failed save and never copies a stale up-to-900s auto-RDB. RDB (`BGSAVE` + `dump.rdb`) was chosen over copying the AOF `appendonlydir/` because a single self-consistent `dump.rdb` is a simpler, atomic restore artifact than the multi-file `base + incr + manifest` layout (which can be captured mid-rewrite). The script refuses to run (exit 1) when `/mnt/hydra-ssd/backups` does not exist — an unmounted SSD must not silently turn into a backup tree on the root filesystem.

**Restore procedure (Redis).** Because the orchestrator's Redis runs with `appendonly yes`, dropping a `dump.rdb` back into the volume is **not** sufficient on its own — on startup Redis prefers the AOF over the RDB, so a naive `dump.rdb` swap silently loads the *old* AOF, not the restored snapshot. Account for that load-precedence caveat:

```bash
# 1. Stop the writers so nothing races the restore.
systemctl --user stop hydra-orchestrator.service
docker stop hydra-redis-1

# 2. Decompress the chosen snapshot.
gunzip -k /mnt/hydra-ssd/backups/redis/hydra-redis-<ts>.rdb.gz   # -> hydra-redis-<ts>.rdb

# 3. Put it back as /data/dump.rdb inside the volume (container stopped).
docker cp /mnt/hydra-ssd/backups/redis/hydra-redis-<ts>.rdb hydra-redis-1:/data/dump.rdb

# 4. AOF-vs-RDB load precedence — remove the stale AOF dir so the RDB is the
#    only durable source on startup, then start normally. Redis loads
#    /data/dump.rdb (no AOF to prefer) and rebuilds the AOF from it on step 5.
#    The container is already stopped from step 1, so operate on the volume.
#
#    Do NOT try `CONFIG SET appendonly no` + `docker restart` instead: CONFIG
#    SET is an ephemeral runtime change never written back to redis.conf, so the
#    restart re-reads `appendonly yes`, finds the old appendonlydir/, and
#    silently loads the STALE AOF — dump.rdb is never consulted. Removing the
#    AOF dir while the container is stopped is the only reliable path.
docker run --rm -v hydra_redis-data:/data busybox rm -rf /data/appendonlydir
docker start hydra-redis-1                                            # loads dump.rdb (no AOF present)
docker exec hydra-redis-1 redis-cli BGREWRITEAOF                      # rebuild the AOF from the loaded dataset

# 5. Verify the keyspace, then bring the orchestrator back.
docker exec hydra-redis-1 redis-cli DBSIZE
systemctl --user start hydra-orchestrator.service
curl -s http://localhost:4000/api/health
```

Off-BOX shipping (gaming PC via Tailscale, cloud object storage) is deliberately out of scope — it needs an external destination + credentials, which is ADR-0005 operator-escalation territory. The on-box second-disk copy captures the volume-loss failure mode today; off-box is a separate operator decision.

## Deploy recipe

Runs automatically on merge to master via a self-hosted GitHub Actions runner on this server; the steps live in `scripts/deploy.sh` (see `docs/generated/ci-gates.json` and `docs/generated/units-scripts.json` for the CI jobs and units around it). In order: fast-forward pull, `npm ci`, `scripts/sync-skills.sh` (regenerate `~/.claude/skills/` from playbooks — fails fast on non-zero exit; introduced in #433 after the 2026-05-15 silent-wedge incident), the dashboard build, a service restart, then a `/api/health` check.

**Operator setup (one-time):** `bash scripts/setup-git-hooks.sh` installs an opt-in `post-merge` hook that re-runs `scripts/sync-skills.sh` when a `git pull` brings in `docs/operator-playbooks/*.md` changes. Remove with `--remove`.

**Subagent session-id capture hooks (issue #692 + #2406):** the subagent-dispatch registry `hydra:dispatches:subagent:{sessionId}` (24h TTL, indexed at `hydra:dispatches:subagent:index`) is populated by **two** triggers that both scrape the hidden `<!-- hydra-dispatch v1 skill=… dispatchId=… runId=… -->` sentinel from a session's transcript and POST it to `POST /api/dispatches/subagent`, making a live session recoverable to `(skill, dispatchId, runId, startedAt)`. Both share one grammar source-of-truth, `scripts/hooks/extract-dispatch-sentinel.sh` (sourced, not executed):

- **`SessionStart` hook** (`scripts/hooks/session-start-capture.sh`, registered in the project-scoped `~/hydra/.claude/settings.json`) — fires for **top-level** sessions (the operator running `claude`, or the autopilot parent). No install step; Claude Code loads project settings automatically inside `~/hydra`.
- **`PostToolUse` hook** (`scripts/autopilot/hooks/on-subagent-tool-call.sh`, registered per-skill via the sibling `<skill>.settings.json` that `sync-skills.sh` syncs) — fires **inside** Agent-tool subagent children, which `SessionStart` structurally never reaches (#2406 root cause: the registry was empty for every Agent-tool dispatch). It registers on the first tool call, guarded by a once-per-session marker under `${HYDRA_DISPATCH_REGISTER_MARKER_DIR:-/tmp}` so the scrape+POST runs once per session (the registry write is idempotent regardless). This trigger is decoupled from the offline usage-attribution work (#2401/#2402): they share only the sentinel grammar, never a mechanism, and the registration introduces no registry dependency into `src/cost/*`.

Sessions without the sentinel (a human running `claude`) silently no-op. Both hooks are best-effort: a Redis/HTTP outage, missing sentinel, missing transcript, or missing `jq` logs to stderr and exits 0 without ever blocking the session or the tool call; re-registering the same session is an idempotent no-op. Smoke-test: `redis-cli zrange hydra:dispatches:subagent:index 0 -1 WITHSCORES` should show a fresh entry within ~5s of the autopilot dispatching a `hydra-dev` subagent.

**Emergency manual deploy:** `./scripts/deploy.sh`. Never deploy by restarting the service without building the dashboard first — Express serves the dashboard build output, so stale builds mean stale UI.
