# Inventory sources of truth and the existing drift-test family

**Wayfinder ticket:** [#4539](https://github.com/gaberoo322/hydra/issues/4539) ·
**Map:** [/docs — a generated, drift-tested system reference page in the cockpit #4537](https://github.com/gaberoo322/hydra/issues/4537) ·
**Date:** 2026-09-17

Audited against master commit `647aa09fd` (`origin/master` at audit time). The local
checkout was at `06d30e1cd`, one commit behind; the only difference is the addition of
`docs/research/2026-09-17-docs-corpus-staleness-audit.md` (PR #4546), so every source,
test and script path below is byte-identical on both commits. Line numbers are of the
files at `647aa09fd` (`grep -n` / `cat -n`).

Facts only. No design, no page proposals, no prose rewrites. Where the sibling audit
already measured a divergence, its finding IDs (`README-NN`, `REF-NN`, `CTX-NN`,
`MAP-NN`, `ADR-NN`, `REG-NN`) are cited rather than re-derived.

Two provenance notes for later readers:

- **Map #4416's ticket #4418** ("enumerate the operator-facing non-HTTP surface") was
  still **OPEN with no deliverable on master** on 2026-09-17. The non-HTTP surfaces below
  (systemd units, operator scripts, `bin/hydra`, chores) are therefore enumerated here
  from primary sources; this document is primary for them until #4418 lands.
- **`src/operator-actions/parity.ts` does not exist on master** (`git ls-tree origin/master
  src/operator-actions/` is empty; `ls src/operator-actions/` fails). There is no
  `HOMED_READS` / `MACHINE_READS` / `RETIRED_READS` / `MACHINE_WRITES` / `RETIRED_WRITES`
  registry to lean on for the route inventory.

---

## 1. Summary

Legend for "machine-readable": **yes** = one committed structured source (TS array/object,
JSON, or a directory listing with a fixed naming rule) exists and is what the code reads;
**partly** = derivable by a deterministic scan of source literals (regex/AST), but no
committed artifact holds the inventory; **prose-only** = the only inventory is a markdown
table or sentence.

| # | Family | Primary source(s) | Machine-readable? | Existing extractor / recipe | Pinning test(s) | One-line gap |
|---|---|---|---|---|---|---|
| 1 | HTTP routes | `src/api.ts:106-222` (48 `api.use(create…Router())` mounts) + `router.<verb>("…")` literals in 48 of the 50 `src/api/*.ts` files | partly | regex recipe in `src/api/ENDPOINT-REGISTRY.md:30-69` (yields 147 routes / 48 files on this commit) | none reads the routers as an inventory (`grep -l ENDPOINT-REGISTRY test/` → 0) | the only committed inventory is the hand-kept registry table, stale (REG-01..03) |
| 2 | Dashboard pages & routes | `dashboard/src/App.jsx:93-119` (`<Route>` JSX literals); `dashboard/src/components/Sidebar.jsx:12-18` (`NAV_ITEMS`) | partly | `grep -n '<Route' dashboard/src/App.jsx` (6 live + 2 detail + 4 redirects) | `test/dashboard-routes.test.mts` pins 8 path literals, 3 redirects, 7 tab folds, Sidebar Now entry | no page-list artifact; README/ADR-0034/roster disagree (README-11, ADR-05) |
| 3 | Autopilot dispatch classes | `scripts/autopilot/classes.json` (`{doc, classes:[22 rows]}`) → `src/taxonomy/classes.ts:193-223` and `scripts/autopilot/decide.py:276-391,490` | **yes** | `GET /api/taxonomy/classes` (`src/api/taxonomy.ts:153`); `node -e 'require("./scripts/autopilot/classes.json")'` | `test/taxonomy-classes.test.mts` (JSON ↔ TS ↔ Python parity), `test/taxonomy-route.test.mts`, `test/decide-signal-classes.test.mts` | playbook class table (`hydra-autopilot.md:60-97`) is an untested mirror |
| 3b | Per-class model routing | `docs/operator-playbooks/hydra-autopilot.md:114-194` (markdown table) | prose-only | none | none | no `model` column in `classes.json`; `decide.py` emits no model (REF-21) |
| 4 | Skills & playbooks | `docs/operator-playbooks/*.md` (38 top-level; 36 `hydra-*.md`) + `_fragments/` (14) + `_vendor/` (6); frontmatter `name:` is the skill id | **yes** | `scripts/sync-skills.sh` (generator, `--dry-run`); deployed mirror `~/.claude/skills/hydra-*` (36) | `test/sync-skills.test.mts` (mechanism), `test/watchdog-skill-mirror-drift.test.mts` (mirror detector), `test/vendor-drift-check.test.mts`, `test/playbook-absolute-write-target.test.mts` | no route or page lists skills (`/health/skills` removed, `src/api/health.ts:188` comment); `CONTEXT-MAP.md:41` names a non-existent `.claude/skills/` (MAP-05) |
| 5 | Config files | `config/` tree (40 files, 9 dirs); `src/api/config-io.ts:111-116` `CONFIG_SECTIONS` (4 hard-coded sections) | partly | `find config -type f`; `GET /api/config/:section` (`src/api/config.ts:47`) | none pins the tree; `test/outcomes.test.mts` etc. exercise `config/direction/outcomes.yaml` behaviourally | `CONFIG_SECTIONS.agents` → `config/agents/` does not exist; `orchestrator/`, `glm/`, `digests/`, `research/`-yaml unreachable; 13 root personality files have no reader (REF-23) |
| 6 | Redis keys | `src/redis/keys.ts:10` (`export const redisKeys = {…}`, 74 builders) + 45 `src/redis/*.ts` accessors | partly | `grep -cE '^\s+[a-zA-Z0-9]+:\s*\(' src/redis/keys.ts` → 74; `scripts/ci/redis-seam-check.ts` (import-boundary ratchet, not an inventory) | `test/redis-keys.test.mts` (every builder emits `hydra:`-prefixed, distinct keys) | builders also live outside `keys.ts` (`src/redis/dispatches.ts`, documented at `keys.ts:74-84`); 70 distinct `hydra:` literals in 73 files outside `src/redis/`; 26 builders with zero callers (REF-01) |
| 7 | Event streams | `src/event-bus-stream-keys.ts:45,64,85` (`STREAMS`, `RETAINED_STREAMS`, `CONSUMER_GROUPS`) | **yes** | read the three constants; `GET /api/events/:stream` (`src/api/events.ts:21`) | `test/event-bus.test.mts:97-111` pins the exact key sets and values | `hydra:agent-stream` lives in `keys.ts:391`, not in the stream constants; `docs/reference.md:54-65` lists 4 streams (REF-05) |
| 8 | CI gates & advisory workflows | `.github/workflows/*.yml` (16 files); required set lives only in GitHub branch protection (8 contexts, read via `gh api`) | partly | `ls .github/workflows/*.yml`; `gh api repos/gaberoo322/hydra/branches/master/protection/required_status_checks --jq .contexts` | `test/ci-test-job-pipefail-guard.test.mts` (ci.yml `test` job invariant), `test/dashboard-routes.test.mts:95` (advisory-checks.yml), `test/verifier-core-docs-drift.test.mts` (T4 list) | no in-repo file names the required-check set; `docs/quality-gates.md` is 290 lines of prose with no gate table; `CONTEXT.md` names seam-check "jobs" that are advisory steps (CTX-16) |
| 9 | Systemd units & operator scripts | `scripts/systemd/` (14 tracked units: 8 `.service` + 6 `.timer`); host `~/.config/systemd/user/` (52 `hydra*` units: 30 services + 22 timers, 27 of them `hydra-betting-*`); `scripts/` (35 top-level entries, 13 subdirs); `bin/hydra` (11 subcommands) | partly | `ls scripts/systemd/`; `systemctl --user list-unit-files 'hydra*'`; `bin/hydra:277` `case` | none compares repo units ↔ host units; `test/sync-skills.test.mts:91-104` pins `scripts/deploy.sh` ordering; `test/watchdog-*.test.mts` exercise `scripts/hydra-watchdog.sh` | `hydra-pg-backup.*` / `hydra-redis-backup.*` documented at `docs/reference.md:544-556` are not tracked and (per REF-24) partly not installed |
| 10 | ADRs | `docs/adr/[0-9]*.md` (39 files) + roster table `docs/adr/README.md` (39 `\| [NNNN](./…) \|` rows, 57 lines) + `CONTEXT-MAP.md` "Relevant ADRs" cells + `test/fixtures/adr-area-baseline.json` (26 areas) | **yes** | `ls docs/adr/[0-9]*.md`; `parseRoster()` / `parseContextMapAreas()` exported from `test/adr-roster.test.mts:118,147` | `test/adr-roster.test.mts` (5 assertions) | Status/Decision columns of the roster are unguarded (ADR-03); baseline keeps retired areas (`src/knowledge-base/`, `src/anchor-selection/`) because CONTEXT-MAP still rows them |
| 11 | Env vars | `.env.example` (16 `NAME=` lines); scattered `process.env.X` reads (69 distinct names in `src/`, 21 in `scripts/`; 0 bracket-form); `$HYDRA_*` in shell (68 in `scripts/*.sh`, 54 in `scripts/autopilot/*.sh`); `os.environ` in `scripts/autopilot/*.py` (19) | prose-only (no registry) | `grep -rhoE 'process\.env\.[A-Z0-9_]+' src/ \| sort -u`; `GET/PUT/DELETE /api/env/:project[/:key]` (`src/api/config.ts:103-140`, Bearer-guarded, reads live `.env`, not `.env.example`) | none (`grep -l '\.env\.example' test/` → 0) | 10 of the 16 `.env.example` names have zero readers in `src/`+`scripts/` (`HYDRA_VAULT_PATH`, `HYDRA_CYCLE_TTL_MS`, `HYDRA_ARCHITECT_EVERY_N_RESEARCH`, `HYDRA_APP_METRICS_URL`, `HYDRA_AGENTS_PATH`, `HYDRA_ORCHESTRATOR_PATH`, `OPENAI_PROXY_PORT`, `CODEX_BIN`, `OPENCLAW_TELEGRAM_TARGET`, `OPENCLAW_GATEWAY_TOKEN`); no `src/env.ts`/zod env schema |
| 12 | Tier path lists | `src/untouchable.ts:41-65` (`VERIFIER_CORE_PATHS`, 6 entries); `src/tier-classifier.ts:54-75` (`TIER_1_PREFIXES`, `TIER_2_PREFIXES`, `TIER_2_FILES`) | **yes** | `GET /api/tier?files=` (`src/api/tier.ts:23`); `scripts/tier-classify.ts` (JSON on stdout, `:75-83`) | `test/verifier-core-docs-drift.test.mts` (array ↔ 4 doc sites), `test/tier-classifier.test.mts` | T1/T2 lists are not doc-pinned; `config/agents/`, `.claude/skills/`, `src/anchor-selection.ts` are dead paths (README-04/05, CTX-04); `.github/workflows/deploy.yml` is a phantom (CTX-01) |
| 13 | Housekeeping chores | `src/scheduler/housekeeping.ts:304` (`const chores: Chore[] = […]`, 14 `name:` entries) over `src/scheduler/chores/` (19 files) | **yes** | `grep -c 'name: "' src/scheduler/housekeeping.ts`; `POST /api/maintenance/housekeeping` (`src/api/maintenance.ts:39`) returns `{ran, skipped}` | none pins the registry list | `CONTEXT.md:146` says "six chores + one" (CTX-21); 5 of the 19 files are support modules, not chores |
| 14 | Schemas | `src/schemas/*.ts` (28 files, imported directly by 32 routers; no `index.ts`) | partly | `ls src/schemas/*.ts` | `test/schema-seam-check.test.mts` (tests the seam linter, not the list) | `CONTEXT.md:202` cites deleted `src/schemas/queue.ts` (CTX-18) |
| 15 | Test suite membership | `test/*.test.mts` (466 files) ↔ `test/fixtures/suite-count-baseline.json` (466 keys, Σ 1,962 top-level tests) | **yes** | `node scripts/test/suite-count-check.mjs --update-baseline` (`:517-519`) | the FILE-SET arm of `scripts/test/suite-count-check.mjs` (blocking, reporter-side, not a test file) | README "~3,500 tests" (README-13) has no committed source |

**Tally:** 7 families **yes** (classes, skills/playbooks, streams, ADRs, tiers, chores, suite membership) · 7 **partly** (routes, pages, config, Redis keys, CI, systemd/scripts, schemas) · 2 **prose-only** (model routing, env vars).

Headline facts:

1. **Only three families have a test that ties a *doc* to its *code* source**: ADRs (`adr-roster`: roster ↔ files ↔ CONTEXT-MAP), tier paths (`verifier-core-docs-drift`: `VERIFIER_CORE_PATHS` ↔ CLAUDE.md / CONTEXT.md / reference.md / hydra-qa.md), and the dispatch-class alphabet (`taxonomy-classes`: JSON ↔ TS ↔ Python). Every other doc mirror (README lists, `docs/reference.md` tables, `ENDPOINT-REGISTRY.md`) is unguarded (audit §2).
2. **The route inventory already has a working extractor but no consumer**: the regex recipe at `src/api/ENDPOINT-REGISTRY.md:48-62` reproduces 147 routes across 48 files on this commit *without* the `api.` extension the audit added (both variants give 147). Nothing runs it in CI or tests; the table it feeds holds 134 rows under 43 headings (REG-02).
3. **Of the ten files matching `test/*drift*` / `test/*roster*`, four are not doc/source pins at all**: `deploy-drift` (pure-logic tests of `scripts/deploy-drift-logic.ts` + a Redis alert round-trip), `watchdog-deploy-drift` and `watchdog-skill-mirror-drift` (behavioural tests of two `scripts/hydra-watchdog.sh` blocks with injected inputs), and `vendor-drift-check` (unit tests of a checker whose live run is the weekly advisory `vendor-drift.yml`). The name "drift" in this repo means "two sources may disagree", not "a doc is pinned".
4. **Beyond the ten, 33 more test files pin a doc↔source or source↔source pair** (§3, second table): 15 are playbook doc-lints (`readFileSync` a `docs/operator-playbooks/*.md` and regex-assert a sentence), 6 are cross-language constant mirrors (bash/python literal ↔ TS export), 5 are baseline ratchets with a regenerate flag, and the rest are structural invariants over `ci.yml`, `classes.json`, or the test directory itself.
5. **Every baseline ratchet in the repo uses the same shape**: a committed JSON file (`test/fixtures/*baseline*.json` or `scripts/ci/*-baseline.json` — 12 of the latter), a script with `--update-baseline` / `--write-baseline` that rewrites it, and a failure message that names the command. Three of those ratchets run inside the required `test` job (`typecheck-test-drift`, `test-file-sprawl-guard`, the suite-count FILE-SET arm); the seam-check and skill-size ratchets run only in advisory workflows and their `test/*.test.mts` siblings unit-test the engine against synthetic input, never the live baseline.
6. **The required-check set is not in the repo.** `gh api …/protection/required_status_checks` returns 8 contexts (`test`, `dashboard-build`, `tier-gate`, `mutation-test`, `scope-check`, `secret-scan`, `deep-qa-gate`, `design-concept-reconcile`); no file under `.github/`, `docs/`, or `scripts/ci/` lists them as data, and `docs/quality-gates.md` has no gate table.
7. **Env vars have no source at all**: `.env.example` is 16 lines, 10 of which name variables nothing reads; the live set is ~69 `process.env.*` names in `src/` read ad hoc with no central module.
8. **Two dashboard facts a page inventory must carry**: `Sidebar.jsx:12-18` links only Today / Health / Now, so `/builder`, `/runs`, `/work` are routed but unlinked (only `dashboard/src/pages/Autopilot.jsx` links to `/runs`); and `test/dashboard-routes.test.mts` pins the route *literals*, not a list, so adding a route changes nothing the test sees.

---

## 2. Per-inventory detail

### 2.1 HTTP routes

**(a) Primary source.** Two layers, both TypeScript literals:

- Mounts: `src/api.ts:106-222`, 48 lines of the form `api.use(create<X>Router(…))` (`grep -c 'api.use(create' src/api.ts` → 48). `src/api.ts` registers zero routes itself (`grep -n 'api\.\(get\|post\)' src/api.ts` → none).
- Registrations: `router.<get|post|put|delete|patch>("<path>", …)` inside `src/api/*.ts` (50 `.ts` files; `route-helpers.ts` is a helper; 48 files register at least one route). Every router declares its full path; there is no per-router sub-prefix (`ENDPOINT-REGISTRY.md:32-37`).

**(b) Enumeration today.** The recipe at `src/api/ENDPOINT-REGISTRY.md:48-62` (an `npx tsx -e` regex scan over `src/api.ts` + `src/api/*.ts` minus `route-helpers.ts`, regex `\b(router|app)\.(get|post|put|delete|patch)\(\s*["`']…`). Re-run on this commit as a `.cjs` port: **147 routes, 48 files**. The audit's `(router|app|api)` extension yields the same 147 — the `api.` alternative matches nothing today. The regex is not AST-aware (`ENDPOINT-REGISTRY.md:64-69` states the two caveats: computed paths and non-router `.get(` calls, "none exist today").

**(c) Mirrors.**
- `src/api/ENDPOINT-REGISTRY.md` (ADR-0024 baseline): header `:7` "As of commit `823eca90c` (2026-09-04)", `:8` "147 routes across 47 router modules"; catalog from `:101` holds **134** `| METHOD | \`path\` |` rows under **43** `` ### `src/api/<file>.ts` `` headings. Not tied to the routers by any test (`grep -l ENDPOINT-REGISTRY test/*.test.mts` → 0).
- `docs/reference.md:67-84` "API Endpoints" — 13 routers listed as prose bullets.
- `README.md` "dashboard/API surface" bullets.
- `test/api-500-catch-ratchet.test.mts:100-115` reads every `src/api/*.ts` as text, but to count `res.status(500)` sites against an in-file allowlist — it is a router-file scan, not a route inventory.

**(d) Divergences.** REG-01 (registry names three deleted routers), REG-02 (header 147/47 vs table 134/43 vs master 147/48), REG-03 (10 registry rows absent from master; 23 master routes absent from the registry; 8 live routers with no heading), REF-06 (reference.md lists 13 of 48 routers, four of them deleted), REF-07, CTX-02 (`/api/merge-lock` vs real `POST /api/merge/lock`).

**(e) Ownership deep-links today.** No route or page enumerates routes. The closest live self-description is `GET /api/architecture` (`src/api/architecture.ts:206` → `scanArchitecture()` in `src/aggregators/architecture-graph.ts`), which derives a *module* dependency graph from the `src/` filesystem, not the HTTP surface. `GET /api/versions` (`src/api/versions.ts`) reports deploy tags + changelog fragments, not routes.

### 2.2 Dashboard pages and routes

**(a) Primary source.** `dashboard/src/App.jsx:93-119`, JSX `<Route path="…" element={…}>` literals inside one `<Routes>`:

| Line | Path | Kind |
|---|---|---|
| 94 | `/` | page (`Today`) |
| 97 | `/health` | page |
| 98 | `/now` | page (`NowRoute` → `NowConsole`, `:28-34`) |
| 100 | `/builder` | page |
| 103 | `/runs` | page |
| 104 | `/runs/:runId` | detail (`Autopilot`) |
| 108 | `/work` | page |
| 111 | `/autopilot/:runId` | redirect (`LegacyRunRedirect`, `:48`) |
| 113 | `/dispatch/:dispatchId/transcript` | detail |
| 117 | `/outcomes` | redirect → `/builder` |
| 118 | `/explore` | redirect → `/runs` |
| 119 | `/explore/:tab` | redirect via `EXPLORE_TAB_REDIRECTS` (`:60-73`, 7 tabs, default `friction`) |

Sidebar: `dashboard/src/components/Sidebar.jsx:12-18` `NAV_ITEMS` = `/` Today, `/health` Health, `/now` Now — three entries. `/builder`, `/runs`, `/work` are not in the sidebar; the only other in-app link to them is `dashboard/src/pages/Autopilot.jsx` (→ `/runs`).

**(b) Enumeration today.** `grep -n '<Route' dashboard/src/App.jsx` → 12 routes: 6 live pages, 2 detail views, 4 redirects. Page components: `dashboard/src/pages/{Today,Health,Builder,Runs,Autopilot,Work,DispatchTranscript}.jsx` + `now-console/`; `dashboard/src/pages/now-pixel/` still exists as a directory (its 20 leaf files are asserted deleted by `test/dashboard-routes.test.mts:299-327`).

**(c) Mirrors.** README:83 ("four operator questions"), ADR-0034 (five pages + two detail views), `docs/adr/README.md:48` (roster row), `ENDPOINT-REGISTRY.md:21` ("19→4 page simplification"). None is test-tied. `test/dashboard-routes.test.mts` pins App.jsx/Sidebar.jsx source text only (see §3).

**(d) Divergences.** README-11, ADR-05, REG-04, X-03.

**(e) Ownership deep-links.** The pages are their own live state; there is no route returning the page list.

### 2.3 Autopilot dispatch classes (and model routing)

**(a) Primary source.** `scripts/autopilot/classes.json` — a JSON object `{doc, classes}`; `classes` is an array of **22** rows with keys `name, kind, skill, costClass, learningAgent, cooldownSeconds, scope, provenanceLabel, notes` (7 `pipeline`, 15 `signal` on this commit; the playbook heading `hydra-autopilot.md:60` still says "7 pipeline slots + 14 signal classes"). The `doc` field (`classes.json`) states it is "the single machine-readable table that owns the autopilot dispatch-class alphabet".

Derived views, both reading the file at import time:
- TS: `src/taxonomy/classes.ts:193` (`TAXONOMY_PATH = "../../scripts/autopilot/classes.json"`), `:199` `readFileSync`, `:210` `DISPATCH_CLASSES`, `:213` `PIPELINE_SLOT_NAMES`, `:218` `SIGNAL_CLASS_NAMES`, `:223` `SIGNAL_CLASS_COOLDOWNS`, `:441` `PROVENANCE_LABELS`; parser `parseClassTaxonomy()` `:102` throws `InvariantViolationError` on contract violation.
- Python: `scripts/autopilot/decide.py:276` (path), `:314` loader ("Hard-fails on any contract violation"), `:391` `PIPELINE_SLOTS`, `:490` `SIGNAL_COOLDOWNS`.

**(b) Enumeration today.** `node -e 'console.log(require("./scripts/autopilot/classes.json").classes.length)'` → 22. Live: `GET /api/taxonomy/classes` (`src/api/taxonomy.ts:153`) returns `{classes, pipelineSlots, signalClasses, signalCooldowns, degraded, generatedAt}` with each row carrying its `skill`; `GET /api/autopilot/class-stats` (`src/api/class-stats.ts:73`) is the per-class usage view.

**(c) Mirrors.** `docs/operator-playbooks/hydra-autopilot.md:60-97` "Class taxonomy" table (Kind / Class / Skill) — prose, untested. `docs/reference.md:499-509` "Model Tiers" table (REF-21).

**Model routing** has no code source: `classes.json` has no model column; `decide.py` "emits no model field; the model lever lives here in the playbook, keyed off the slot" (`hydra-autopilot.md:102`); the per-class map is the markdown table at `hydra-autopilot.md:114-194` (`### Per-class model routing (issue #1093)`). No test reads that table as data (`test/skill-prune-contract-token-parity.test.mts:236-254` reads `hydra-autopilot.md` only as a large-text fixture for a scorer).

**(d) Divergences.** REF-21; playbook heading count (14 vs 15 signal rows) — not in the audit's scope; noted here as a new observation, unverified against any issue.

**(e) Ownership deep-links.** `GET /api/taxonomy/classes`, `GET /api/autopilot/class-stats`; no dashboard page renders the class table as such (`dashboard/src` references skill names only via metrics panels).

### 2.4 Skills and playbooks

**(a) Primary source.** `docs/operator-playbooks/` — 38 top-level `.md` (36 `hydra-*.md`, plus `README.md` and `thermo-nuclear-code-quality-review.md`), `_fragments/` (14, pulled in via `@include`), `_vendor/` (6: `code-review.md`, `implement.md`, `improve-codebase-architecture.md`, `to-tickets.md`, `provenance.json`, `README.md`). Each playbook opens with YAML frontmatter `name:` / `description:` / `when_to_use:` / `allowed_tools_claude:` (checked on `hydra-architect.md`, `hydra-doctor.md`, `hydra-sweep.md`); the skill id is the frontmatter `name:`, not the filename.

**(b) Enumeration / extractor.** `scripts/sync-skills.sh` (699 lines) is the generator: reads `$REPO_ROOT/docs/operator-playbooks/*.md` (non-recursive; `_fragments/`, `_vendor/` skipped), composes `compose_base:` bodies, forwards `disable-model-invocation`, copies `reference_files:` siblings, writes `~/.claude/skills/<name>/SKILL.md` (and `~/.codex/skills/` unless `claude_only: true`) with a `DO NOT EDIT. Generated from docs/operator-playbooks/<name>.md` banner (`:475-476`), and prunes banner-carrying dirs whose playbook is gone (`:629-636`, issue #3693). Flags: `--dry-run|-n`, `--force`; default-path write guarded by an `origin/master` content check (`:55-112`, issue #3828). Invoked by `scripts/deploy.sh:60`. Host mirror on this date: `ls -d ~/.claude/skills/hydra-* | wc -l` → 36 (40 entries total incl. `caveman`, `synced`, `thermo-nuclear-code-quality-review`, `zoom-out`).

**(c) Mirrors.** `~/.claude/skills/hydra-*/SKILL.md` (generated); `CLAUDE.md` "Agent skills" section; `docs/operator-playbooks/hydra-autopilot.md` class table (skill column). Tests: `test/sync-skills.test.mts` (playbook edit propagates into the regenerated SKILL.md; `deploy.sh` calls `sync-skills.sh` after `npm ci` and before restart, `:91-104`), `test/watchdog-skill-mirror-drift.test.mts` (host mirror ↔ fresh regen), `test/vendor-drift-check.test.mts` (`supersedes:` entries resolve against `_vendor/` bases).

**(d) Divergences.** MAP-05 (`.claude/skills/` not a repo dir); `scripts/ci/skill-size-ratchet.ts` and `scripts/ci/wiring-caller-check.ts` headers still describe standalone workflows (`skill-size-ratchet.yml`, `wiring-check.yml`) that do not exist — both run as steps of `.github/workflows/advisory-checks.yml:276,284`.

**(e) Ownership deep-links.** None. `src/api/health.ts:188` records the removal of `/health/skills`; `grep -n 'skills\|playbook' src/api/*.ts` hits only comments.

### 2.5 Config files

**(a) Primary source.** The `config/` tree — 40 files in 9 directories (`find config -type f | wc -l`): 13 legacy personality `.md` at the root (`architect.md`, `builder.md`, `devops.md`, `domain-researcher.md`, `market-researcher.md`, `meta.md`, `research-architect.md`, `research-strategist.md`, `researcher.md`, `reviewer.md`, `strategist.md`, `technical-researcher.md`, `tester.md`); `config/direction/` (6: 4 `.md` + `liveness.yaml`, `outcomes.yaml`); `config/orchestrator/vision.md`; `config/research/` (6 `.md`); `config/feedback/` (2 `.md` + `retro-artifacts/` 1 JSON); `config/digests/` (4 `.md` + `retro/` 4 JSON); `config/glm/drainer-settings.json`.

The only code-side registry is `src/api/config-io.ts:111-116`:

```ts
export const CONFIG_SECTIONS: Record<string, ConfigSection> = {
  agents: { dir: "agents", ext: ".md" },
  feedback: { dir: "feedback", ext: ".md" },
  direction: { dir: "direction", ext: ".md" },
  research: { dir: "research", ext: ".md" },
};
```

`config/agents/` does not exist (`ls config/agents` fails); `listConfigSection` maps `ENOENT` to `[]`, so `GET /api/config/agents` returns an empty list. `orchestrator`, `glm`, `digests` are not sections; `.yaml` files in `direction/` are excluded by `ext: ".md"`.

**(b) Enumeration today.** `find config -type f | sort`; `GET /api/config/:section` (`src/api/config.ts:47`), `GET|PUT /api/config/:section/:name` (`:59`, `:76`). `config/direction/outcomes.yaml` is read by `src/outcomes-yaml.ts` via `DEFAULT_OUTCOMES_FILE` (`src/outcomes.ts:47`).

**(c) Mirrors.** `docs/reference.md:531-542` Config section; README:80; CLAUDE.md map line (`config/direction/`, `config/orchestrator/vision.md`). No test pins the layout; `grep -ln 'config/direction' test/` hits behavioural tests (`outcomes`, `wiring-liveness`, `mutation-skip-patterns`, …).

**(d) Divergences.** REF-23 (goals.md deleted; 13 unread personality files; `config/feedback/` writer retired), README-04/README-10, X-01, CTX-13 (`roadmap.md` deleted). New observation: `grep -rn 'config/architect\|config/builder' src/` → 0 hits, confirming no reader for the root personality files.

**(e) Ownership deep-links.** `GET /api/config/:section` for the four registered sections; no dashboard page (`grep -rli 'config' dashboard/src` finds no config page).

### 2.6 Redis keys (and accessors)

**(a) Primary source.** `src/redis/keys.ts` (422 lines): a single `export const redisKeys = {` object literal (`:10`) with ~35 `// ---` section comments naming domains; **74** arrow-function key builders (`grep -cE '^\s+[a-zA-Z0-9]+:\s*\(' src/redis/keys.ts`). Retirements are recorded inline: Specs (`:170-174`, "RETIRED (issue #513)"), `realityReport`/`researchReportIndex` (`:118-129`), budget sentinel (`:262`), capacity floor (`:266`). Builders are *not* required to live in `keys.ts`: `:74-84` reserves a comment for `src/redis/dispatches.ts`'s two namespaces (`hydra:dispatches:operator:{id}`, `hydra:dispatches:subagent:{sessionId}`), declared there as `export function`s.

Accessor modules: `ls src/redis/*.ts | wc -l` → **45** (`agent-memory, alerts, attention, attribution-constants, attribution-ledger, attribution-reverted, attribution-windows, autopilot-pause, autopilot-runs, autopilot, bounded-list, candidate-exclusions, cascade-telemetry, class-stats, connection, cost, cycle-metrics, cycle-tracking, design-concept, dispatches, dispatch-outcomes, emergency-brake, holdback-merge-watch, holdback, housekeeping, keys, kv, launch-flow, oauth-backoff, recommendations, reconciler, reflections, retro-artifacts, retro-seen, review, scheduler, scope-violations, scout, session-block, transcript-parse-memo, usage-snapshots, utility, wiring-liveness-dark-outcomes, wiring-liveness-output-series, workless-hint`).

**(b) Enumeration today.** Builders: the grep above. Literals: `grep -rhoE "hydra:[A-Za-z0-9:_{}\$\.-]+" src/ | sort -u | wc -l` → 217 distinct (the audit's 226 used a different character class); 70 distinct literals in 73 files outside `src/redis/` (largely comments and prefix constants). A second inline key-shape list exists in `src/scheduler/chores/stale-key-prune.ts` (`CYCLE_KEY_PREFIX = "hydra:cycle:"`, `TASK_KEY_PREFIX`, `METRICS_KEY_PREFIX`, `CYCLE_ACTIVE_KEY`, `CYCLE_LAST_KEY`, `LEGACY_METRICS_LIST_KEY`), deliberately not imported from `keys.ts`.

Extractor: none. `scripts/ci/redis-seam-check.ts` is an import-boundary ratchet (forbids `redis/keys`, `redis/kv`, raw `redis/connection` imports outside `src/redis/`; baseline `scripts/ci/redis-seam-baseline.json` via `seam-check-lib.ts`); it emits violations, not a key inventory, and runs in `.github/workflows/test-typecheck.yml` (advisory).

**(c) Mirrors.** `docs/reference.md:7-52` Redis Keys table (42 rows). Tests: `test/redis-keys.test.mts` imports `redisKeys` and asserts every builder output starts with `hydra:` and builders are distinct — a convention pin, not an inventory; `test/redis-seam-check.test.mts` tests the linter's grammar.

**(d) Divergences.** REF-01 (15 documented keys have zero callers; 26 builders overall), REF-02/REF-03 (documented keys absent from code), REF-04/X-09 (`daily-spend` both live and retired in the same file), CTX-17 (18 vs 45 adapters).

**(e) Ownership deep-links.** None enumerate keys. Individual families surface through their domain routes (e.g. `GET /api/alerts`, `GET /api/autopilot/paused`).

### 2.7 Event streams

**(a) Primary source.** `src/event-bus-stream-keys.ts`: `:45` `STREAMS = { NOTIFICATIONS: "hydra:notifications", DLQ: "hydra:dlq" }`, `:64` `RETAINED_STREAMS = { CYCLE: "hydra:cycle" }`, `:78` `streamKey(name)`, `:85-88` `CONSUMER_GROUPS = { [NOTIFICATIONS]: ["telegram"], [DLQ]: ["dlq-processor"] }`, `:90` export. `src/event-bus.ts:475` re-exports them. A fourth stream name, `hydra:agent-stream`, is a `redisKeys` builder (`src/redis/keys.ts:391`), outside the constants.

**(b) Enumeration.** Read the constants; **2 live streams + 1 retained; 2 consumer groups**. Live: `GET /api/events/:stream` (`src/api/events.ts:21`, via `streamKey`), `POST /api/events/publish` (`:39`); mounted `src/api.ts:135`.

**(c) Mirrors / tests.** `docs/reference.md:54-65` (4 streams, 4 groups). `test/event-bus.test.mts:97-111` pins `Object.keys(STREAMS)` = `["DLQ","NOTIFICATIONS"]`, the two values, `Object.keys(RETAINED_STREAMS)` = `["CYCLE"]`, and "CONSUMER_GROUPS only declares groups on live streams". The doc table is not tied to the constants.

**(d) Divergences.** REF-05.

### 2.8 CI gates and advisory workflows

**(a) Primary source.** `.github/workflows/*.yml` — **16** files: `advisory-checks, allow-scripts, audit-nightly, changelog-check, ci, deep-qa-gate, deps-check, design-concept-comment, design-concept-reconcile, issue-label-validation, osv-scan, protected-paths, secret-scan, stryker-check, test-typecheck, vendor-drift`. `ci.yml` job ids at `:43 test`, `:117 dashboard-build`, `:151 tier-gate`, `:232 mutation-test`, `:319 scope-check`, `:381 deploy`. The **required** set is GitHub branch-protection state, not a file: `gh api repos/gaberoo322/hydra/branches/master/protection/required_status_checks --jq .contexts` → `["test","dashboard-build","tier-gate","mutation-test","scope-check","secret-scan","deep-qa-gate","design-concept-reconcile"]` (8; five from `ci.yml`, three from their own workflows).

**(b) Enumeration.** `ls .github/workflows/*.yml`; job ids by `grep -nE '^  [a-z0-9_-]+:$'` per file; required set by the `gh api` call. Advisory seam checks are *steps* inside `advisory-checks.yml` (e.g. `:276` `wiring-caller-check.ts`, `:284` `skill-size-ratchet.ts`) and `test-typecheck.yml:51` (`redis-seam-check`), per CTX-16.

**(c) Mirrors.** `docs/quality-gates.md` (290 lines, prose sections for npm audit, `mutation-test`, `stryker-check`, `scope-check`, a "Required vs advisory" paragraph at `:254` — no table); `CONTEXT.md:62,170-202`; CLAUDE.md "CI/CD" bullets; `README.md`. Tests reading workflow YAML: `test/ci-test-job-pipefail-guard.test.mts:137` (`ci.yml` `test` job pipes `npm test` through a pipefail-protected shell + `MIN_TESTS` floor), `test/dashboard-routes.test.mts:95-101` (`advisory-checks.yml` has no `parse-control-plane` step), `test/tier-classifier.test.mts` (Verifier-Core paths). No extractor emits a CI inventory (`grep -rln writeFileSync scripts/ | xargs grep -ln '\.json'` → `scripts/ci/test-subject-map.ts`, `scripts/ci/stryker-scan.ts`, `scripts/test/suite-count-check.mjs`, `scripts/target/post-merge-health.ts`, `scripts/deploy-drift-check.ts` — none about workflows).

**(d) Divergences.** CTX-16/X-13 (seam "jobs" vs advisory steps; deleted `seam-checks.yml`), REF-17/X-05 (tier-gate label semantics retired at `scripts/tier-classify.ts:17-21`), CTX-01 (`deploy.yml` phantom in `VERIFIER_CORE_PATHS`).

**(e) Ownership deep-links.** None in-process; CI state is GitHub-side (`gh pr checks`).

### 2.9 Systemd units and operator scripts

**(a) Primary sources.** In-repo: `scripts/systemd/` — 14 tracked units (`hydra-autopilot.service`, `hydra-branch-prune.{service,timer}`, `hydra-glm-drainer.{service,timer}`, `hydra-housekeeping.{service,timer}`, `hydra-notify-failure@.service`, `hydra-pace-gate.{service,timer}`, `hydra-test-proc-reaper.{service,timer}`, `hydra-watchdog.{service,timer}`); `grep -rln ExecStart --include='*.service'` finds all 8 services there and nowhere else (no `deploy/`, `config/systemd/`). Host: `systemctl --user list-unit-files 'hydra*'` → 52 units (30 services + 22 timers), of which 27 are `hydra-betting-*` (Target, untracked here) and 25 orchestrator/shared (incl. `hydra-orchestrator.service` enabled, `hydra-pg-backup.*`, `hydra-tunnel.service`, `hydra-docker.service`, `hydra-checkpoint-refresh.*`, `hydra-test-container-cleanup.*`, `hydra-prediction-market-cron.*` — none of these six tracked in-repo).

Scripts: `ls scripts/` → 35 top-level entries (22 files: `ast-search.ts, audit-ghost-writes.py, branch-prune.sh, deploy-drift-check.ts, deploy-drift-logic.ts, deploy.sh, glm-beachhead-report.sh, housekeeping.sh, hydra-watchdog.sh, osv-scan.sh, probe-search.ts, reap-stale-test-procs.sh, redis-backup.sh, reflection-deposit.sh, setup-claude-hooks.sh, setup-git-hooks.sh, sync-skills.sh, sync-target-gate.sh, tier-classify.ts, tool-currency-check.ts, tool-currency-logic.ts`; 13 dirs: `autopilot/` 23, `ci/` 62, `claude-hooks/` 1, `cleanup/` 3, `comby-rules/` 1, `cost/` 1, `glm/` 2, `hooks/` 2, `hydra/` 1, `otel/` 7, `systemd/` 14, `target/` 8, `test/` 2). `bin/hydra` (291 lines) dispatches 11 subcommands at `:277` (`health, scheduler, brake, cycle, backlog, queue, metrics, alerts, recommendations, research, raw`).

**(b) Enumeration.** `ls scripts/systemd/`; `systemctl --user list-unit-files 'hydra*' --no-pager`; `ls scripts/`; `grep -n 'case "\$1" in' -A12 bin/hydra`.

**(c) Mirrors.** `docs/reference.md:544-556` Backups table (`hydra-pg-backup.*`, `hydra-redis-backup.*`), `:623-632` Deploy recipe, `docs/operator-playbooks/hydra-autopilot.md:894-895` (pace-gate units, correctly pointing at `scripts/systemd/`), `CONTEXT.md` Pace Gate / Housekeeping entries. Tests: none compare repo units to host units; `test/sync-skills.test.mts:91-104` pins `scripts/deploy.sh` step order; `test/watchdog-deploy-drift.test.mts` / `test/watchdog-skill-mirror-drift.test.mts` / `test/watchdog-launch-flow.test.mts` exercise `scripts/hydra-watchdog.sh`; `test/host-probe.test.mts:183-192` and `test/autopilot-watchdog.test.mts` reference unit names as fixtures.

**(d) Divergences.** REF-24 (pg-backup timer disabled, redis-backup not installed), REF-25 (deploy recipe omits flock/daemon-reload/health-poll), REF-08 (`src/service-strip.ts` never existed).

**(e) Ownership deep-links.** `GET /api/health/deep` (host-probe fan-out over unit names), `GET /api/versions` (deploy tags). Unit state itself is host-side.

### 2.10 ADRs

**(a) Primary source.** `docs/adr/[0-9]*.md` — 39 files (`0001`–`0039`); roster `docs/adr/README.md` (57 lines; 39 rows matching `^\| \[NNNN\](./NNNN-…md)`); routing tables in `CONTEXT-MAP.md` (two tables with a "Relevant ADRs" column); byte-weight ratchet `test/fixtures/adr-area-baseline.json` (26 area keys, hand-edited, no generator — the test's message says "raise that area's number … IN THIS PR, deliberately").

**(b) Enumeration.** `ls docs/adr/[0-9]*.md | wc -l`; the parsers `listAdrFiles()`, `parseRoster()`, `parseContextMapAreas()`, `declaresStatus()` are `export`ed from `test/adr-roster.test.mts:100-204` and are the only in-repo ADR parsers.

**(c) Mirrors / tests.** `test/adr-roster.test.mts` (§3). Roster Status/Decision columns are not compared to file contents (ADR-03). `CLAUDE.md` and `CONTEXT-MAP.md:55` describe the roster in prose (MAP-06 size claim wrong).

**(d) Divergences.** ADR-01..06, MAP-06. Baseline keeps `src/knowledge-base/` (8150) and `src/anchor-selection/` (11515) because `CONTEXT-MAP.md` still has rows for those retired areas (assertion 4's key-sync test requires the keys to match the map exactly).

**(e) Ownership deep-links.** None; ADRs are not served.

### 2.11 Env vars

**(a) Primary sources.** `.env.example` (16 `NAME=` lines: `HYDRA_PORT, REDIS_URL, HYDRA_PROJECT_WORKSPACE, HYDRA_VAULT_PATH, HYDRA_AUTO_CYCLE_INTERVAL_MS, HYDRA_CYCLE_TTL_MS, HYDRA_RESEARCH_QUEUE_THRESHOLD, HYDRA_RESEARCH_MIN_INTERVAL_MS, HYDRA_ARCHITECT_EVERY_N_RESEARCH, HYDRA_APP_METRICS_URL, HYDRA_AGENTS_PATH, HYDRA_ORCHESTRATOR_PATH, OPENAI_PROXY_PORT, CODEX_BIN, OPENCLAW_TELEGRAM_TARGET, OPENCLAW_GATEWAY_TOKEN`). Readers are scattered: `process.env.<NAME>` → 69 distinct names in `src/`, 21 in `scripts/`, 0 bracket-form; `$HYDRA_*` → 68 in `scripts/*.sh`, 54 in `scripts/autopilot/*.sh`; `os.environ` → 19 in `scripts/autopilot/*.py`. There is no `src/env.ts`, no zod env schema (`grep -rln 'z.object' src/ | xargs grep -l process.env` → none).

**(b) Enumeration.** The greps above. Per-name reader check: 10 of the 16 `.env.example` names return 0 files from `grep -rl <NAME> src/ scripts/` (`HYDRA_VAULT_PATH, HYDRA_CYCLE_TTL_MS, HYDRA_ARCHITECT_EVERY_N_RESEARCH, HYDRA_APP_METRICS_URL, HYDRA_AGENTS_PATH, HYDRA_ORCHESTRATOR_PATH, OPENAI_PROXY_PORT, CODEX_BIN, OPENCLAW_TELEGRAM_TARGET, OPENCLAW_GATEWAY_TOKEN`); `REDIS_URL` has 5, the rest 1 each.

**(c) Mirrors.** `docs/reference.md` env tables (~30 names; REF-10/11/12/18 note stale defaults and undocumented `HYDRA_HOLDBACK_*_T3/_T4`, `HYDRA_TARGET_WEB_URL`); README:90 `.env.example` mention. Tests: none read `.env.example`. Live: `GET/PUT/DELETE /api/env/:project[/:key]` (`src/api/config.ts:103,119,140`, `makeEnvAuthGuard(CRON_SECRET)`) operate on the live `~/hydra/.env` / target `.env.local` with masked values (`config-io.ts:66-69`), not on `.env.example`; no dashboard page.

**(d) Divergences.** REF-10, REF-11, REF-12, REF-18, README-12 (Node range), plus the 10 dead example names (new observation).

### 2.12 Tier path lists

**(a) Primary source.** `src/untouchable.ts:41-65` `VERIFIER_CORE_PATHS` (6: `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`, `.github/workflows/deep-qa-gate.yml`, `scripts/tier-classify.ts`, `src/tier-classifier.ts`, `src/untouchable.ts`); `src/tier-classifier.ts:54-57` `TIER_1_PREFIXES` (`config/agents/`, `config/feedback/`), `:67-70` `TIER_2_PREFIXES` (`.claude/skills/`, `dashboard/`), `:71-75` `TIER_2_FILES` (`src/anchor-selection.ts`); T3 is the default (`:96`).

**(b) Enumeration.** Import the arrays; `GET /api/tier?files=a,b` (`src/api/tier.ts:23`, query via `src/schemas/tier.ts`); `npx tsx scripts/tier-classify.ts <files>` prints `{tier, reason, files, perFile}` (`:75-83`; exit 0 for any classification, `--operator-approved` is a no-op, `:40-44`).

**(c) Mirrors / tests.** CLAUDE.md T4 row, `CONTEXT.md:58`, `docs/reference.md:354,358`, `hydra-qa.md` T4 checklist — all pinned to `VERIFIER_CORE_PATHS` by `test/verifier-core-docs-drift.test.mts` (which also pins `length === 6`, `:66`). README:69 T4 row is not pinned (README-07). T1/T2 lists are mirrored in CLAUDE.md, README:66-67, `docs/reference.md:352`, `CONTEXT.md:74` with no test.

**(d) Divergences.** CTX-01 (phantom `deploy.yml` — code and four pinned docs agree on a path that has never existed), README-04/05/06/07, REF-17, CTX-04, X-17, X-05.

**(e) Ownership deep-links.** `GET /api/tier`.

### 2.13 Housekeeping chores

**(a) Primary source.** `src/scheduler/housekeeping.ts:304` `const chores: Chore[] = [` inside `runHousekeeping()` — 14 `name:` entries (`review-pickup-notify, weekly-summary, usage-weekly-snapshot, memory-consolidation, design-concept-snapshot, stale-key-prune, worktree-orphan-prune, glm-eligibility-sweep, target-outcomes-publish, wiring-liveness, attribution-record, holdback-merge-watch, cycle-merge-reconcile, pattern-cue-demotion`), each with an optional cadence `guard` and a `work` thunk into `src/scheduler/chores/<name>.ts`. The directory holds 19 files; 5 are support modules (`attribution-self-arm.ts`, `wiring-liveness-{dark-alarm,output,timer,types}.ts`) not registered as chores.

**(b) Enumeration.** `grep -c 'name: "' src/scheduler/housekeeping.ts` → 14; `ls src/scheduler/chores/ | wc -l` → 19. Live: `POST /api/maintenance/housekeeping` (`src/api/maintenance.ts:39`) runs them and returns `{ran, skipped}`; the `hydra-housekeeping.timer` unit drives it.

**(c) Mirrors / tests.** `CONTEXT.md:146` (CTX-21); no test pins the registry list; no dashboard reference (`grep -rln 'chores\|housekeeping' dashboard/src` → none).

### 2.14 Schemas

`src/schemas/*.ts` — 28 files, no `index.ts`; each router imports its schema directly (32 of 50 `src/api/*.ts` reference `schemas/`). Enumerate with `ls src/schemas/*.ts`. `scripts/ci/schema-seam-check.ts` + `scripts/ci/schema-seam-baseline.json` ratchet body-parsing outside the seam (advisory step, `advisory-checks.yml:239`); `test/schema-seam-check.test.mts` tests the linter. Mirror: `CONTEXT.md` Schemas entry (CTX-18).

### 2.15 Test-suite membership (counts)

`test/*.test.mts` — 466 files; `test/fixtures/suite-count-baseline.json` — 466 keys (`"test/<name>.test.mts": <top-level count>`), Σ 1,962. Generated by `node scripts/test/suite-count-check.mjs --update-baseline` (`:517-519`, `writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2))`). The FILE-SET arm (`fileCoverageDiff`) hard-fails the required `test` job on any membership diff when `HYDRA_FULL_SUITE=1` (`package.json:14`); the COUNT arms are advisory. `test/fixtures/test-subject-baseline.json` (test files per subject, generated by `npx tsx scripts/ci/test-subject-map.ts --update-baseline`) ratchets sprawl. README-13's "~3,500 tests" has no committed source.

---

## 3. The drift-test family

All `test/*.test.mts` run in the required `test` job: `package.json:14` `"test": "HYDRA_FULL_SUITE=1 node scripts/test/redis-db-launch.mjs node --experimental-strip-types --test --test-force-exit --test-concurrency=1 … test/*.test.mts"` and `test` is in the branch-protection required set (§2.8). "In required job" is therefore **yes** for every row below unless stated.

### 3.1 The ten named files

| Test | Claim pinned | Primary source | Mirror(s) checked | Failure mode / regeneration | Introduced by |
|---|---|---|---|---|---|
| `test/adr-roster.test.mts` | (1) every `docs/adr/NNNN-*.md` has a roster row and every row's link resolves (matched on filename, `:217-242`); (2) no duplicate 4-digit number (`:246`); (3) every ADR declares a Status in one of three spellings (`declaresStatus`, `:188-204`; existence only, not value); (4) both CONTEXT-MAP tables parse (`tables === 2`, `:295`), every cited ADR exists, baseline keys == map areas, per-area byte sum ≤ baseline (`:337-363`); (5) every ADR is cited by some area (`:381`) | `docs/adr/` dir listing; `docs/adr/README.md` (regex `^\|\s*\[(\d{4})\]\(\.\/(\d{4}-[^)]+\.md)\)`, `:122`) | `CONTEXT-MAP.md` "Relevant ADRs" cells (`/ADR-(\d{4})/g`, `:175`); `test/fixtures/adr-area-baseline.json` | Aggregated `assert.deepEqual([], …)` with a "Fix:" sentence per assertion (e.g. `"Routed ADR weight grew past baseline for: …"`, `:356-361`). Baseline is hand-edited in the same PR; no generator. Header explains the aggregate style: per-item subtests were dropped non-deterministically under `--test-force-exit` (`:56-67`) | #4015 (follow-up to PR #4013); assertion 5 motivated by ADR-0035 |
| `test/dashboard-routes.test.mts` | INV-1 App.jsx imports none of `pages/Explore.jsx`, `pages/Outcomes.jsx`, `OrchestratorMap`, `NowPixel` (`:109-127`); the 8 surviving `path="…"` literals are present (`:134-148`); INV-2 `/outcomes`→`/builder`, `/explore`→`/runs`, `/explore/:tab` via `<Navigate replace to={to} />` and the 7-entry `EXPLORE_TAB_REDIRECTS` fold (`:156-205`); `/now` mounts `NowRoute`→`NowConsole` and the view-toggle identifiers are gone (`:213-233`); INV-5 Sidebar keeps `to: "/now", label: "Now"` and drops `/outcomes`, `/explore` (`:241-246`); INV-3/4/6/7 file-existence pins on 3 deleted census files, 2 kept leaves, 30 swept leaves (`:82-101`, `:253-327`) | `dashboard/src/App.jsx`, `dashboard/src/components/Sidebar.jsx` (read as text via `readFile(new URL(rel, import.meta.url))`) | `.github/workflows/advisory-checks.yml` (`!includes("parse-control-plane")`, `:95-101`); filesystem `stat` for the leaf lists | `assert.match(src, /path="\/outcomes"[\s\S]{0,160}?to="\/builder"/)`-style regexes and `assert.ok(!src.includes(…))`; no baseline | #4012 (epic #4005, ADR-0034 §3), extended by #4255, #4256 |
| `test/deploy-drift.test.mts` | `shortSha` / `shasMatch` / `classifyDrift` / `buildDriftAlertMessage` branch behaviour; `emitAlert` writes one parseable `deploy-drift` alert to `hydra:alerts` and never an empty string (`:230-266`) | `scripts/deploy-drift-logic.ts`, `scripts/deploy-drift-check.ts` (imported, not read as text) | Redis via `src/redis/alerts.ts` (REDIS_URL DB 1 fallback, `:42`) | Ordinary `assert.equal`; **reads no doc, pins no doc↔source pair** — it is a unit test of the watchdog's SHA classifier | #2663, #3743 |
| `test/scout-constant-drift.test.mts` | `CLASS_COOLDOWN_DAYS * 86400` (TS) == `SIGNAL_COOLDOWNS["scout_orch"]` (Python) (`:105-118`); `decide.py` has **no** `CATEGORY_COOLDOWN` reference outside comments/docstrings (`:120-166`); `CATEGORY_COOLDOWN_DAYS === 30` (`:169-174`) | `src/scout/calendar-walk.ts` (imported) | `scripts/autopilot/decide.py`, loaded via `python3 -c` + `importlib` with the `sys.modules` pre-registration trick (`:78-102`) | Multi-line message naming both files and values (`"CLASS_COOLDOWN_DAYS drift detected!…"`); hard-coded pin must be edited with the constant | #533 (follow-up to PR #530, #485) |
| `test/typecheck-test-drift.test.mts` | `tsc --noEmit -p tsconfig.test.json` error count == `scripts/ci/test-typecheck-baseline.json`'s `count` (currently 0); fails in **both** directions (`:229-246`) | live `tsc` run (`:204-221`, 60 s timeout) | `scripts/ci/test-typecheck-baseline.json` `{count, note}` | `"New type error(s) in test/** or scripts/**: current=N baseline=M … run \`npm run typecheck:test -- --write-baseline\`"`; stale-baseline arm `"Baseline is stale…"`. Regen: `npm run typecheck:test -- --write-baseline` (`scripts/ci/test-typecheck-check.ts:69`) | #4046 (mirrors advisory `test-typecheck.yml`, #750) |
| `test/vendor-drift-check.test.mts` | `collectSupersedes(docs/operator-playbooks)` on the **live** tree returns >0 entries with well-formed fields (`:31-42`); frontmatter-block edge cases and `check()` finding kinds (`supersedes-unresolved`, `unmanifested-base`, `plugin-not-installed`) on tmpdir fixtures (`:44-195`) | `scripts/ci/vendor-drift-check.ts` (imported) | live `docs/operator-playbooks/*.md` frontmatter `supersedes:` (one assertion); synthetic `_vendor/` + `provenance.json` otherwise | `assert.ok(found.length > 0, "…collecting zero means the parser silently failed")`. The actual drift verdict (base ↔ upstream SHA in `~/.claude/plugins/installed_plugins.json`) runs only in `.github/workflows/vendor-drift.yml:57-58` (weekly, advisory, `--json` artifact) | #3994 (epic #3988) |
| `test/verifier-core-docs-drift.test.mts` | `VERIFIER_CORE_PATHS.length === 6` (`:66`); the set of backtick paths in `CONTEXT.md` between `**Verifier Core**:` and `_Avoid_:` equals the array (`:69-78`); same for the CLAUDE.md line starting `\| T4 — Verifier Core` (`:80-91`); same for the `docs/reference.md` slice after `**Verifier Core list (\`VERIFIER_CORE_PATHS\` / \`isVerifierCore\` in \`src/untouchable.ts\`):**` up to `ADR-0015` (`:93-106`); `docs/reference.md` T4 row's `The (\d+) self-referential files` == length (`:108-120`); `hydra-qa.md` `the (\d+) self-referential paths` == length (`:122-134`); explicit no-op documenting that ADR-0015's historical "exactly 5" is not checked (`:136-146`) | `src/untouchable.ts` (imported) | `CONTEXT.md`, `CLAUDE.md`, `docs/reference.md`, `docs/operator-playbooks/hydra-qa.md` (read as text; `PATH_SPAN` at `:32` matches backtick spans starting `.github/`, `scripts/` or `src/`; `sliceBetween` marker helper, `:51-58`) | `assert.deepEqual(found, EXPECTED, "CONTEXT.md's Verifier Core glossary entry lists […] but VERIFIER_CORE_PATHS is […]")`; marker-not-found is itself an assertion failure | #3819 |
| `test/watchdog-deploy-drift.test.mts` | `scripts/hydra-watchdog.sh` exists and is executable (`:100-104`); `run_deploy_drift` is defined and called inside the `BASH_SOURCE` guard followed by `exit 0` (`:106-118`); sourcing the script and calling `run_deploy_drift` with injected SHAs logs `in sync` / `WARNING DRIFT` + `auto-deploy disabled` / `within grace window` / `would-deploy` (dry-run) / `could not resolve origin/master SHA`, always exit 0, marker file written/cleared (`:121-247`) | `scripts/hydra-watchdog.sh` (read as text for the structural pin; sourced via `bash` for behaviour) | env-injected `HYDRA_WATCHDOG_DRIFT_{DEPLOYED,REMOTE}_SHA`, `…_AUTODEPLOY_DRY_RUN`, `…_DRIFT_STATE_DIR` | `assert.match(lines, /WARNING DRIFT/, "expected drift warning, got: …")`; 120 s spawn timeout via `test/_helpers/watchdog-timeouts.mts` | #734; sourcing refactor #4500 |
| `test/watchdog-skill-mirror-drift.test.mts` | The `## SKILL MIRROR DRIFT` block regenerates every skill from `$HYDRA_ROOT/docs/operator-playbooks/` into a scratch dir via the real `scripts/sync-skills.sh` and diffs against the live mirror: `in sync` / `WARNING DRIFT` naming the skill + `auto-fix disabled` / grace window / `would-resync` dry-run / `sync-skills.sh not found` WARN; live mirror never rewritten; exit 0 (`:130-298`) | `scripts/hydra-watchdog.sh` + `scripts/sync-skills.sh` (copied into a tmp fixture repo, `:64-76`, run with `CLAUDE_SKILLS_DIR`/`CODEX_SKILLS_DIR` overrides) | a fixture `demo.md` playbook vs a deliberately-staled generated `SKILL.md` | `assert.match(lines, /WARNING DRIFT/…)`; `assert.equal(readFileSync(liveDir/demo/SKILL.md), staleBefore)` | #3828 |
| `test/wire-or-retire-carveout-drift.test.mts` | The four carve-out restatement sites in `docs/operator-playbooks/hydra-wire-or-retire.md` (Step 2, pre-template prose, RETIRE-template precondition, post-template rationale; located by `sliceBetween` markers `:64-87`) each contain `risk_carveout`; none of `web/src/lib/{risk,execution,providers,wagers}/` appears anywhere in the file (`:106-127`); the template bullet names `prompt_args.risk_carveout` inline (`:129-143`) | `docs/operator-playbooks/hydra-wire-or-retire.md` (text) | the Target Manifest's `riskCritical.surface` is the intended single source (via `prompt_args.risk_carveout`), asserted only by name | `assert.ok(site.region.includes("risk_carveout"), "…must now point at the manifest-sourced prompt_args.risk_carveout (issue #4411)…")`; flipped from a four-way literal-list parity test | #3957, flipped by #4411 |

### 3.2 Other doc/source pinning tests

Same columns. Rows marked † were located by an Explore sub-search and then traced by the author to the cited `readFileSync`/assertion lines; every row was verified.

| Test | Claim pinned | Primary source | Mirror(s) checked | Failure mode / regeneration | Introduced by |
|---|---|---|---|---|---|
| `test/ci-test-job-pipefail-guard.test.mts` | The `ci.yml` `test` job step that pipes `npm test` is pipefail-protected (any of `set -o pipefail`, `shell: bash`, `PIPESTATUS`) and carries the `MIN_TESTS` floor | `.github/workflows/ci.yml` (`:137`) | invariant regexes over the YAML | `"no step in the \`test\` job pipes \`npm test\`…"`; `isPipefailProtected(step) === true` | #3741 |
| `test/test-file-sprawl-guard.test.mts` | No test subject gains test files over `test/fixtures/test-subject-baseline.json` (shrink-only); baseline keys == live subjects | `scripts/ci/test-subject-map.ts` output over `test/*.test.mts` | `test/fixtures/test-subject-baseline.json` (`:57,62,86`) | `assert.deepEqual` diff naming grown subjects; regen `npx tsx scripts/ci/test-subject-map.ts --update-baseline` | #4134 (epic #4131) |
| `test/toolchain-pin.test.mts` | Running `process.version` satisfies `package.json` `engines.node` and equals `.nvmrc` | `.nvmrc`, `package.json` (`:146,151`) | live interpreter | `"Node drift: running ${process.version} is outside engines.node …"` (`:246`); hand-rolled semver, no dependency | #3952 |
| `test/taxonomy-classes.test.mts` | TS `DISPATCH_CLASSES` == parsed `classes.json` rows; `decide.py` derived tuples (`PIPELINE_SLOTS`, cooldowns) == TS views byte-for-byte through JSON; malformed table → TS throws `InvariantViolationError`, Python exits non-zero (fixture copy, `:224`) | `scripts/autopilot/classes.json` (`:57,135`) | `src/taxonomy/classes.ts` exports; `python3` subprocess over `decide.py` | `assert.deepEqual(py.handlerNames, expected)`; no baseline (fail-loud parity) | epic #1669, slice #1670 |
| `test/taxonomy-route.test.mts` | `GET /taxonomy/classes` projection carries `skill` per row, degrades to `degraded:true` on loader throw, 400 on bad query; `defaultLoadTaxonomy` serves the real `classes.json` alphabet schema-valid (`:189`) | `src/api/taxonomy.ts` (imported) | `scripts/autopilot/classes.json` via the default loader | ordinary asserts; no baseline | #2524 |
| `test/sync-skills.test.mts` | `scripts/deploy.sh` invokes `sync-skills.sh` after `npm ci` and before restart under `set -euo pipefail` (`:91-104`); editing `docs/operator-playbooks/hydra-dev.md` propagates into the regenerated `SKILL.md` with the DO-NOT-EDIT banner (`:121-153`); `setup-git-hooks.sh` post-merge hook is opt-in/idempotent | `scripts/deploy.sh`, `scripts/sync-skills.sh` (spawned with `CLAUDE_SKILLS_DIR` override) | generated `SKILL.md` vs source playbook | `"generated SKILL.md must carry the DO NOT EDIT banner pointing back at the source playbook"` | #433 |
| `test/skill-size-ratchet.test.mts` | Pure functions of `scripts/ci/skill-size-ratchet.ts` (`splitFrontmatter`, `countWords`, `compareAgainstBaseline`, description cap = max(50, baselined)) on **synthetic** strings | `scripts/ci/skill-size-ratchet.ts` (imported) | synthetic baselines only | ordinary asserts. The live ratchet (`docs/operator-playbooks/*.md` + `_fragments/*.md` word counts vs `scripts/ci/skill-size-baseline.json`, regen `--write-baseline`) runs only in `advisory-checks.yml:284` — **not** in the required job | #2946 |
| `test/api-500-catch-ratchet.test.mts` | Hand-rolled `res.status(500)` count per `src/api/*.ts` equals the in-file `ALLOWLIST` | every `src/api/*.ts` as text (`:100`) | in-file allowlist map | `"hand-rolled res.status(500) count drifted from the allowlist:\n…"` (`:110`); widen the allowlist in the same PR | #4402 (follow-up to #909) |
| `test/decide-golden.test.mts` | `decide.py decide` output for each captured `(state, candidates, events)` fixture byte-matches `expected-plan.json` | `test/fixtures/decide-golden/<name>/*.json` | live `decide.py` | `"decide.py plan drifted from golden for fixture …"`; regen `UPDATE_DECIDE_GOLDEN=1 node --experimental-strip-types --test --test-force-exit test/decide-golden.test.mts` (`:34`) | #2713 |
| `test/claude-cli-seam-check.test.mts` (and siblings `redis-seam-check`, `schema-seam-check`, `query-seam-check`, `github-seam-check`, `host-probe-seam-check`, `journal-seam-check`, `anthropic-seam-check`, `telegram-seam-check`, `target-coupling-check`) | The seam predicate classifies synthetic sources correctly; for claude-cli the baseline `callers` stays `[]` (`:143-150`) | `scripts/ci/<seam>-check.ts` (imported) | `scripts/ci/<seam>-baseline.json` (12 such files: 9 seams + `skill-size`, `target-coupling`, `test-typecheck`) | ordinary asserts; regen `npx tsx scripts/ci/<seam>-check.ts --write-baseline`. Live baseline comparison runs in `advisory-checks.yml:239-267` / `test-typecheck.yml:51`, not here | #3703 (claude-cli), #950 family |
| `test/board-state.test.mts` † | `collect-state.sh`'s inline Python blocker-ref regex byte-matches `STRICT_BLOCKER_PATTERN_SOURCES` in `src/github/blockers.ts` | `scripts/autopilot/collect-state.sh` (`:73`) | TS export | `"…the bash/python mirror has drifted from src/github/blockers.ts"` (`:335`) | #3965 |
| `test/target-board-labels.test.mts` † | Every `TARGET_*_LABEL` literal in `collect-state.sh` and the two `hydra-target-*-emit.ts` runners exists in `TARGET_BOARD_LABELS` | `scripts/autopilot/collect-state.sh` (`:40,66-70`) | `src/target-board-labels.ts` export | `"collect-state.sh references Target label "X" which is missing from TARGET_BOARD_LABELS"` (`:76`) | #3720 |
| `test/launch-flow-key-contract.test.mts` † | `pace-gate.sh`'s `LAST_TICK_KEY` literal == `PACE_GATE_LAST_TICK_KEY` (`src/redis/launch-flow.ts`) | `scripts/autopilot/pace-gate.sh` (`:47`) | TS export | `"…PACE_GATE_LAST_TICK_KEY have drifted apart…"` (`:59`) | #3845 (epic #3844) |
| `test/watchdog-launch-flow.test.mts` † | Watchdog bash key template == TS key builder output (INV-12); `LAST_TICK_KEY` == `PACE_GATE_LAST_TICK_KEY` (INV-1) | `scripts/hydra-watchdog.sh` (`:3,312`) | `src/redis/launch-flow.ts`, `src/event-bus-stream-keys.ts` | `"watchdog LAST_TICK_KEY drifted from PACE_GATE_LAST_TICK_KEY"` | #3847 (epic #3844) |
| `test/launch-flow-delivery.test.mts` † | Watchdog `GLM_HEARTBEAT_STALE_MS` bash literal == `GLM_DRAINER_HEARTBEAT_STALE_MS` (`src/redis/autopilot.ts`); `hydra-autopilot.md` documents the two stop levers | `scripts/hydra-watchdog.sh`, `docs/operator-playbooks/hydra-autopilot.md` | TS constant; playbook text | `"the bash staleness window must equal GLM_DRAINER_HEARTBEAT_STALE_MS…"` | #3848 (epic #3844) |
| `test/event-bus.test.mts` | `STREAMS` / `RETAINED_STREAMS` / `CONSUMER_GROUPS` exact keys and values (`:97-111`) | `src/event-bus-stream-keys.ts` (via `event-bus.ts` re-export) | — (self-pin of the constants) | `assert.deepEqual(Object.keys(STREAMS).sort(), ["DLQ","NOTIFICATIONS"])` | (header not issue-stamped) |
| `test/redis-keys.test.mts` | Every `redisKeys` builder output starts with `hydra:` and builders are pairwise distinct | `src/redis/keys.ts` (imported, `:12`) | — | ordinary asserts | (header not issue-stamped) |
| `test/playbook-absolute-write-target.test.mts` † | No `docs/operator-playbooks/*.md` or `_fragments/*.md` names an absolute `~/hydra/…` path as a write target | every playbook + fragment (`listMarkdownFiles`, `:91,108`) | regexes over each file | `"dispatch playbook(s) name an absolute ~/hydra/... path as a write target…"` (`:65` describe) | #4174 |
| `test/watchdog-spawn-timeout-ratchet.test.mts` | No `test/*.test.mts` spawning the watchdog uses a `spawnSync` timeout below `MIN_WATCHDOG_TEST_TIMEOUT_MS`; at least the 5 known suites are found | every `test/*.test.mts` as text (`:62`) | `test/_helpers/watchdog-timeouts.mts` constant | offender list `"${name}: timeout: ${literal}"` | #4044, #4072 |
| `test/hydra-dev-needs-qa-transition.test.mts` † | `hydra-dev.md` Step 6 Success block adds `needs-qa` and removes `ready-for-agent` + `in-progress` | `docs/operator-playbooks/hydra-dev.md` (`:14`) | — | `"Success branch must add needs-qa to the source issue…"` | #846 |
| `test/hydra-dev-reflection-deposit.test.mts` † | `hydra-dev.md` / `hydra-target-build.md` (with `@include`d fragments resolved, `:75-97`) present the reflection deposit step as mandatory; `scripts/reflection-deposit.sh` contract | playbooks + fragments; `scripts/reflection-deposit.sh` (`:59`) | — | regex over the resolved surface | #1912 |
| `test/hydra-dev-tier-classifier.test.mts` † | `_fragments/hydra-dev-child-flow.md` instructs the live `GET /api/tier?files=` call and a `Tier:` PR-body line | `docs/operator-playbooks/_fragments/hydra-dev-child-flow.md` (`:44`) | — | `"Playbook must reference /api/tier so the subagent calls the live classifier…"` | #406 |
| `test/hydra-hitl-grill-option-table.test.mts` † | `hydra-hitl-grill.md` and `hydra-review.md` option tables share slot positions (slot 4 = Skip); park lane exclusive to hitl-grill; `classes.json` has no hitl-grill class (`:103`) | both playbooks (`:31-32`), `scripts/autopilot/classes.json` | cross-checked against each other | `assert.equal(cells[4], "Skip", …)` | #4185 |
| `test/hydra-review-option-table.test.mts` † | `hydra-review.md` §4 option table has stable slot positions across ≥9 bucket rows | `docs/operator-playbooks/hydra-review.md` (`:27`) | self | `"expected >=9 bucket rows, got N"` | #4185 |
| `test/hydra-review-stalled-pr-bucket.test.mts` † | `hydra-review.md` §0.9 defines both stalled-PR predicates | `docs/operator-playbooks/hydra-review.md` (`:40`) | self | `"§0.9 heading not found…"` | #3963 |
| `test/hydra-target-build-anchor-preflight.test.mts` † | The §2.1 preflight bash block in the fragment executes correctly and stays fence-compatible (no process substitution/loops) | `docs/operator-playbooks/_fragments/hydra-target-build-anchor-preflight.md` (`:43`) | executes the extracted block | `assert.equal(res.status, 0, …)` | #4167 |
| `test/hydra-target-build-fence-skip-steps.test.mts` † | Merge-flow fragment enumerates "7.5, 8, and 8.6" and never uses the "7.5–8.6" range form | `docs/operator-playbooks/_fragments/hydra-target-build-merge-flow.md` (`:28`) | two exclusive regexes | `"the fenced skip list must enumerate 7.5, 8, and 8.6 explicitly, excluding 8.5"` | #4224, #4230 |
| `test/hydra-target-build-worktree-guard.test.mts` † | `hydra-target-build.md` Step 0.6 `@include`s the worktree-isolation fragment with `$TARGET_WT` / `$TARGET_APP_DIR`; `branch-prune.sh` knows the nested path | `docs/operator-playbooks/hydra-target-build.md`, `_fragments/target-self-isolation-preamble.md`, `hydra-autopilot.md`, `scripts/branch-prune.sh` (`:30,60,74,202`) | playbook ↔ fragment ↔ script | `"hydra-target-build.md Step 0.6 must @include the fragment"` | #542, #4411 |
| `test/hydra-target-cleanup-emit.test.mts` † | `WIRING_GRACE_DAYS` / `WIRING_GRACE_CEILING_DAYS` constants are named verbatim in `hydra-target-cleanup.md` (`:310-321`) | `docs/operator-playbooks/hydra-target-cleanup.md` | TS constants from the planner module | `"playbook must name the ${WIRING_GRACE_DAYS}-day grace period"` | (header cites #1449/#1005 in body) |
| `test/target-wire-or-retire-lane-invariant.test.mts` † | `hydra-target-sweep.md`, `hydra-wire-or-retire.md`, `collect-state.sh` agree on lane ownership of wire-or-retire items | both playbooks + `scripts/autopilot/collect-state.sh` (`:66-68`) | three-way cross-check | `assert.match` / `assert.doesNotMatch` (`:72-139`) | #3726 |
| `test/autopilot-collect-state-signals.test.mts` † | `collect-state.sh` jq filter for `needs-design-concept`; `hydra-sweep.md` documents the lane, `hydra-review.md` does not duplicate it | `scripts/autopilot/collect-state.sh` (`:43`), `hydra-sweep.md` (`:157`), `hydra-review.md` (`:172`) | script ↔ two playbooks | `"hydra-sweep.md must document the needs-design-concept lane…"` | #4096 |
| `test/autopilot-quota-budget-3867.test.mts` † | `term-check.py` and `decide.py._check_termination` agree on `TERM:quota` for the same state fixture (INV-2) | spawns both scripts over tmp fixtures (`:202,573`) | script ↔ script | `assert.match(…, /^TERM:quota /)` / `cause === "quota"` | #3867 |
| `test/skill-prune-contract-token-parity.test.mts` | `evals/scorers/contract-token-parity.ts` discriminates over-prune vs sediment prune; uses `hydra-autopilot.md` + a fragment as realistic before/after fixtures (`:227-254`) | `evals/scorers/contract-token-parity.ts` (imported) | `docs/operator-playbooks/hydra-autopilot.md` as fixture text only | ordinary asserts; proves the advisory `eval-gate` scorer is non-vacuous inside the required job | #4268 |

**Not test files but part of the same mechanism:** `scripts/test/suite-count-check.mjs` (custom `--test-reporter`, `package.json:14`) — FILE-SET arm compares `test/*.test.mts` membership to `test/fixtures/suite-count-baseline.json` keys and exits non-zero on a diff (blocking); COUNT arms compare per-file counts (advisory). Regen `node scripts/test/suite-count-check.mjs --update-baseline`.

Catalogued: 10 named files + 33 other test files (+ 1 reporter gate). Of the 43 test files, 15 read a `docs/operator-playbooks/**.md` file as text (32 test files in total `fs`-read some real `.md`, counting non-pinning fixture reads).

### 3.3 Shared mechanics observed

- **Reading.** Docs are read as plain text with `readFileSync(resolve(REPO_ROOT, "…"), "utf8")` where `REPO_ROOT = resolve(import.meta.dirname, "..")` (or `dirname(fileURLToPath(import.meta.url))`); `dashboard-routes` alone uses `readFile(new URL(rel, import.meta.url))`. Code sources are **imported** (`VERIFIER_CORE_PATHS`, `redisKeys`, `STREAMS`, `CLASS_COOLDOWN_DAYS`, `DISPATCH_CLASSES`) rather than parsed. Bash/Python sources are read as text (`hydra-watchdog.sh`, `collect-state.sh`, `pace-gate.sh`) or executed via `spawnSync("bash"|"python3", …)`; Python module constants are reached with an `importlib` shim that pre-registers `sys.modules["decide"]` (`scout-constant-drift:78-102`).
- **Parsing style.** Regex over lines or `sliceBetween(startMarker, endMarker)` to isolate one sentence/section before matching (`verifier-core-docs-drift:51-58`, `wire-or-retire-carveout-drift:50-57`); markdown tables parsed by splitting `|` cells with a header-row column lookup (`adr-roster:147-179`); backtick path spans by `/\`((?:\.github\/|scripts\/|src\/)[\w./-]+)\`/g`; roster links by `^\|\s*\[(\d{4})\]\(\.\/(\d{4}-[^)]+\.md)\)`. No YAML/markdown library is used anywhere (ADR-0005).
- **Assertion style.** Offenders are collected into an array and reported once with `assert.deepEqual(list, [], "…\nFix: …")` — the aggregate form is deliberate (`adr-roster:56-67`: per-item subtests under `--test-force-exit` were dropped non-deterministically). Failure messages name both sides and the fix; several pin a literal count (`length === 6`, `CATEGORY_COOLDOWN_DAYS === 30`, `tables === 2`) so a legitimate change forces an edit to the test.
- **Baselines.** JSON, committed, keyed by path or name, values are counts/bytes: `test/fixtures/{suite-count,adr-area,test-subject}-baseline.json`, `scripts/ci/{9 seams,skill-size,target-coupling,test-typecheck}-baseline.json`. Updating is either a script flag (`--update-baseline` for `suite-count-check.mjs` / `test-subject-map.ts`; `--write-baseline` for every `scripts/ci/*-check.ts`) or a hand edit in the same PR (`adr-area-baseline.json`); the failure message always names the command. Ratchets are shrink-only except `typecheck-test-drift`, which also fails when the baseline is stale-high.
- **Where they run.** Everything under `test/` runs in the required `test` job; the header of nearly every file states this is the reason it is a test and not a workflow (a sibling workflow cannot block). The `scripts/ci/*-check.ts` live comparisons run only in `advisory-checks.yml` / `test-typecheck.yml` / `vendor-drift.yml`; their `test/` siblings unit-test the engine on synthetic input.

---

## 4. Machine-readable today vs prose-only

**Machine-readable sources that exist today (an extractor would read these):**

- `scripts/autopilot/classes.json` (22 rows; already served by `GET /api/taxonomy/classes`).
- `src/untouchable.ts` `VERIFIER_CORE_PATHS`; `src/tier-classifier.ts` `TIER_1_PREFIXES` / `TIER_2_PREFIXES` / `TIER_2_FILES` (served by `GET /api/tier`).
- `src/event-bus-stream-keys.ts` `STREAMS` / `RETAINED_STREAMS` / `CONSUMER_GROUPS`.
- `src/redis/keys.ts` `redisKeys` (74 builders) — machine-readable but incomplete (`src/redis/dispatches.ts`; inline prefixes in `stale-key-prune.ts`).
- `src/scheduler/housekeeping.ts` `chores[]` (14 names).
- `docs/adr/[0-9]*.md` + `docs/adr/README.md` rows + `CONTEXT-MAP.md` ADR cells + `test/fixtures/adr-area-baseline.json` (parsers exported from `test/adr-roster.test.mts`).
- `docs/operator-playbooks/*.md` frontmatter (`name`, `description`, `when_to_use`, `allowed_tools_claude`, `compose_base`, `supersedes`, `reference_files`, `claude_only`) — the generator `scripts/sync-skills.sh` already reads it; `~/.claude/skills/hydra-*` is its output.
- `.github/workflows/*.yml` (16 files; `name:`, `on:`, `jobs:` keys parse trivially).
- `scripts/systemd/*.service|*.timer` (14 files).
- `src/api.ts` mount list + `src/api/*.ts` route literals (regex recipe exists in `ENDPOINT-REGISTRY.md:48-62`).
- `dashboard/src/App.jsx` `<Route>` literals; `Sidebar.jsx` `NAV_ITEMS`.
- `config/` directory listing; `src/api/config-io.ts` `CONFIG_SECTIONS`.
- `src/schemas/*.ts` directory listing.
- `test/fixtures/suite-count-baseline.json`, `test/fixtures/test-subject-baseline.json`, `scripts/ci/*-baseline.json`.
- `package.json` (`engines.node`, `dependencies`), `.nvmrc`.

**Prose-only or absent (a source would have to be created before an inventory can be generated):**

- Per-class **model routing** — only `hydra-autopilot.md:114-194`.
- The **required-check set** — only GitHub branch protection (8 contexts); no repo file.
- **Env vars** — `.env.example` is 16 lines with 10 dead names; the live set exists only as scattered `process.env.*` reads; `docs/reference.md` env tables are prose.
- **Host systemd state** beyond the 14 tracked units (38 more `hydra*` units on the host, incl. all 27 `hydra-betting-*`, `hydra-orchestrator.service`, `hydra-pg-backup.*`) — host-only.
- **Redis key ↔ doc "purpose" text** (`docs/reference.md:7-52` Purpose column) — prose; the code has no per-key description field.
- **Route stability / consumer attribution** (`ENDPOINT-REGISTRY.md:70-100`) — prose; deferred per ADR-0024.
- **Deploy recipe** (`docs/reference.md:623-632`) — prose; the executable is `scripts/deploy.sh` + `ci.yml:381` `deploy` job.
- **Which gates are required vs advisory** in `docs/quality-gates.md` — prose paragraphs, no table.
- **Test count** (README:113) — no committed source beyond the suite-count baseline sum (1,962 top-level entries).

---

## 5. Retired / duplicate hand-kept mirrors a generated inventory would supersede

| Mirror | Location | What it duplicates | Audit finding(s) |
|---|---|---|---|
| API Endpoint Registry | `src/api/ENDPOINT-REGISTRY.md` (`:7-8` header; `:101-451` table, 134 rows / 43 headings) | `src/api.ts` mounts + router literals (147 / 48) | REG-01, REG-02, REG-03, REG-05, ADR-06 |
| API Endpoints section | `docs/reference.md:67-84` (13 routers) | same | REF-06, REF-07 |
| Redis Keys table | `docs/reference.md:7-52` (42 rows) | `src/redis/keys.ts` (74 builders) | REF-01, REF-02, REF-03, REF-04 |
| Event Bus table | `docs/reference.md:54-65` (4 streams, 4 groups) | `src/event-bus-stream-keys.ts` (2 + 1; 2 groups) | REF-05 |
| Model Tiers table | `docs/reference.md:499-509` | `hydra-autopilot.md:114-194` (itself prose) | REF-21 |
| Modification Tiers table + prose | `docs/reference.md:345-366`; README:66-69; `CONTEXT.md:74`; CLAUDE.md tier table | `src/untouchable.ts`, `src/tier-classifier.ts` | REF-17, README-04..07, CTX-04, X-05, X-17 (T4 sentences at reference.md:358 / CONTEXT.md:58 / CLAUDE.md T4 row are test-pinned; the rest are not) |
| Backups + Deploy recipe | `docs/reference.md:544-556`, `:623-632` | `scripts/systemd/`, host units, `scripts/deploy.sh`, `ci.yml:381` | REF-24, REF-25 |
| Dashboard page model | README:83; ADR-0034 §2; `docs/adr/README.md:48`; `ENDPOINT-REGISTRY.md:21` | `dashboard/src/App.jsx:93-119` | README-11, ADR-05, REG-04, X-03 |
| Class taxonomy table | `docs/operator-playbooks/hydra-autopilot.md:60-97` | `scripts/autopilot/classes.json` | (heading count 14 vs 15 signal rows — new) |
| Housekeeping chore list | `CONTEXT.md:146` | `src/scheduler/housekeeping.ts:304` | CTX-21 |
| Redis adapter count | `CONTEXT.md:199` ("18") | `ls src/redis/*.ts` (45) | CTX-17 |
| Config section prose | `docs/reference.md:531-542`; README:80 | `config/` tree; `src/api/config-io.ts:111-116` | REF-23, README-10, X-01 |
| Skills location | `CONTEXT-MAP.md:41`; README-05/REF-17 "`~/.claude/skills/`" | `docs/operator-playbooks/` → `scripts/sync-skills.sh` | MAP-05 |
| ADR corpus/roster sizes | `docs/adr/README.md:3`; `CONTEXT-MAP.md:55` | `wc -c` over the files | ADR-01, MAP-06 |
| Candidate Feed / `/api/queue` sections | README:46,79; `docs/reference.md:113-141`; `CONTEXT.md:98`; `CONTEXT-MAP.md:29` | nothing (deleted 2026-07-18, #3455) | REF-09, CTX-07, MAP-04, README-03/09, X-12 |
| Env var tables | `docs/reference.md:147-152` and holdback/usage sections | scattered `process.env` reads; `.env.example` | REF-10, REF-11, REF-12, REF-18 |

Stale in-code self-descriptions (not docs, but would mislead an extractor that trusts headers): `scripts/ci/skill-size-ratchet.ts` and `scripts/ci/wiring-caller-check.ts` headers name standalone workflows that do not exist (both are `advisory-checks.yml` steps); `src/untouchable.ts:10-12` and `src/tier-classifier.ts:15-17` still describe the `operator-approved` label as blocking (retired at `scripts/tier-classify.ts:16-22`); `src/tier-classifier.ts:8-9` still names `config/agents/`.

---

## 6. Method & limits

**Commands (all read-only, run from `/home/gabe/hydra`):**

- Commit: `git fetch -q origin && git log -1 --format=%h origin/master` (→ `647aa09fd`); `git log 06d30e1cd..origin/master --stat` (only the audit doc differs).
- Drift tests: `cat -n test/{adr-roster,dashboard-routes,deploy-drift,scout-constant-drift,typecheck-test-drift,vendor-drift-check,verifier-core-docs-drift,watchdog-deploy-drift,watchdog-skill-mirror-drift,wire-or-retire-carveout-drift}.test.mts` read in full; other pinning tests located by `grep -lnE 'readFileSync|readFile\(' test/*.test.mts` filtered on `.md` / `.json` / `.yml` / `.sh` / `.py` targets and by header keywords (`drift|ratchet|baseline|mirror|playbook|sync-skills|classes.json|toolchain|suite-count|adr-area|workflows/`), then each candidate's `readFileSync` line, assertion string and header issue number traced with `grep -n`.
- Routes: the `ENDPOINT-REGISTRY.md:48-62` recipe ported to a `.cjs` file (both `(router|app)` and `(router|app|api)` variants → 147 / 48); `grep -c 'api.use(create' src/api.ts` (48); `grep -cE '^\| (GET|POST|PUT|DELETE|PATCH) \|' src/api/ENDPOINT-REGISTRY.md` (134); `grep -cE '^#{3,4} .*src/api/'` (43).
- Pages: `grep -n '<Route\|<Navigate' dashboard/src/App.jsx`; `grep -n 'to: "' dashboard/src/components/Sidebar.jsx`; `grep -rln '"/builder"\|"/runs"\|"/work"' dashboard/src`.
- Classes: `node -e` over `classes.json`; `grep -n` in `src/taxonomy/classes.ts`, `scripts/autopilot/decide.py`, `src/api/taxonomy.ts`; `grep -ln classes.json test/*.test.mts`.
- Skills: `ls docs/operator-playbooks/`, `ls ~/.claude/skills/`; `scripts/sync-skills.sh` header and `grep -n 'orphan\|DO NOT EDIT'`; `grep -n sync-skills scripts/deploy.sh`.
- Config / env: `find config -type f`; `sed -n '111,116p' src/api/config-io.ts`; `grep -n 'router\.' src/api/config.ts`; `grep -oE '^[A-Z_]+=' .env.example`; per-name `grep -rl <NAME> src/ scripts/ | wc -l`; `grep -rhoE 'process\.env\.[A-Z0-9_]+' src/ | sort -u | wc -l`.
- Redis / streams: `grep -cE '^\s+[a-zA-Z0-9]+:\s*\(' src/redis/keys.ts`; `ls src/redis/*.ts | wc -l`; `grep -rhoE "hydra:[A-Za-z0-9:_{}\$\.-]+" src/ | sort -u | wc -l`; `sed -n` over `src/event-bus-stream-keys.ts` and `test/event-bus.test.mts:97-111`.
- CI / systemd: `ls .github/workflows/*.yml`; `grep -nE '^  [a-z-]+:$' .github/workflows/ci.yml`; `gh api repos/gaberoo322/hydra/branches/master/protection/required_status_checks --jq '.contexts'`; `ls scripts/systemd/`; `systemctl --user list-unit-files 'hydra*' --no-pager`; `ls scripts/`; `bin/hydra` `case` block.
- ADRs / baselines: `ls docs/adr/[0-9]*.md | wc -l`; `grep -cE '^\| \[[0-9]{4}\]' docs/adr/README.md`; `cat test/fixtures/adr-area-baseline.json`; `node -e` over `suite-count-baseline.json`; `ls scripts/ci/*baseline*.json`; `grep -n 'update-baseline\|write-baseline' scripts/test/suite-count-check.mjs scripts/ci/*.ts`.
- Three Explore sub-searches were used to fan out the candidate lists (other pinning tests; Redis/streams/env/config; CI/systemd/scripts/skills). Every path, line and assertion string they reported that appears above was re-read by the author; sub-search claims that did not survive a direct check were dropped (e.g. one sub-search's `ci.yml` job line numbers, which did not match `grep -n`; the numbers above are the author's).

**Not verified, and why:**

- `npm test` was not run and the service was not started (ticket constraint); route existence is from source, live route behaviour is not asserted. Test *pass* status is not claimed for any file — only what each file asserts.
- The full-suite count (README-13) was not re-measured; only the baseline sum (1,962) and file count (466) are reported.
- The live `vendor-drift` verdict (needs `~/.claude/plugins/installed_plugins.json` and upstream) and the live `skill-size` / seam-check baseline comparisons were not run; their status is inferred from which workflow invokes them.
- Host systemd facts are as reported by `systemctl --user list-unit-files` on 2026-09-17 and can change without a commit.
- `docs/reference.md` line numbers are taken from the audit (same file content on both commits) and spot-checked with `sed -n` at `:7-12, :54-58, :67-72, :345-348, :499-503, :544-556, :623-626`.
- The `hydra-autopilot.md:60` "14 signal classes" vs 15 signal rows in `classes.json` observation is new here and has not been checked against any issue.
