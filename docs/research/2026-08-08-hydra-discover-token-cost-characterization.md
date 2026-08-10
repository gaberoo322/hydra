# Characterizing hydra-discover's per-dispatch token cost

**Asset for wayfinder ticket [#3914](https://github.com/gaberoo322/hydra/issues/3914)** (map [#3913](https://github.com/gaberoo322/hydra/issues/3913) — "Cut hydra-discover's token cost without degrading finding quality"). Pure fact-finding against primary sources: source files, live Redis, the live `/api` surface, and real Claude Code session transcripts (JSONL) recovered from `~/.claude/projects/-home-gabe-hydra/`. No judgment calls, no proposed fixes — the map's next tickets own that.

Investigation date: 2026-08-08. Orchestrator state observed: `hydra-autopilot.service` inactive (operator-paused since `2026-08-08T14:20:28Z`, i.e. `autopilotPause.since=1786198828119`), `hydra-orchestrator.service` live on `:4000`, Redis (`hydra-redis-1`) uptime 39 days (`run_id:3ead80434a229b11ed095f655f2f0e1371938d2c`, `uptime_in_days:39` — covers the entire investigation window).

## Executive summary — the single highest-leverage finding

**The ~35%/day "hydra-discover" cost line the map is built on does not correspond to real autopilot dispatches of `discover_orch` over most of the measurement window, and at least part of it is confirmed test-suite contamination of the production cost ledger — not per-dispatch behavior at all.**

Three independent, primary-source facts converge on this:

1. **No real `discover_orch` dispatch has happened since 2026-07-25.** Every real Claude Code background dispatch stamps a hidden sentinel `<!-- hydra-dispatch v1 skill=hydra-discover … -->` into its transcript ([docs/operator-playbooks/hydra-autopilot.md:101](../operator-playbooks/hydra-autopilot.md)). A full scan of `~/.claude/projects/-home-gabe-hydra/*.jsonl` found **264 transcripts** carrying that exact sentinel; the newest is dated **2026-07-25 21:44 PDT**. A parallel scan restricted to `-newermt 2026-07-26` found **zero**. Meanwhile `hydra:autopilot:signal-last-fired` (Redis hash, HGETALL) and the live `/tmp/hydra-autopilot-state.json` both show `discover_orch: 0` — "never fired" in this Redis instance's 39-day life — while sibling backfill class `architecture_orch` shows a real timestamp (`1785041019` = 2026-07-25 21:43 PDT, the same evening). So the class-level dispatch cooldown mechanism has been dark for **14 days**.
2. **Yet `costByClass` (`GET /api/metrics`) has attributed a consistent ~35–40% of *every single day's* token spend to the `hydra-discover` skill for the past 27 days straight**, including today (2026-08-08: `hydra-discover=19,530,000` of `totalTokens≈55.06M`, 35.5%; see the 28-day table in Q4). This persisted straight through the 14-day dispatch-dark period — the line item did not go to zero when real dispatches stopped.
3. **A confirmed, quantified leak explains at least part of the gap.** `test/autopilot-dedup-reap.test.mts`'s `runReap()` helper (lines 93–112) spawns the real `scripts/autopilot/reap.py completion` CLI **without overriding `HYDRA_API_BASE`** — unlike its sibling `test/autopilot-token-record-reap-completion.test.mts`, which explicitly pins `HYDRA_API_BASE` to a dead port "so nothing leaks to the live orchestrator on :4000" (that file's own comment, lines 84–88). `reap.py` defaults `HYDRA_API_BASE` to `http://localhost:4000` ([scripts/autopilot/reap.py:68](../../scripts/autopilot/reap.py)) — the real, live orchestrator on this exact host. Two ISSUE-432 test cases in `autopilot-dedup-reap.test.mts` (lines 338–373, 375–396) call `reap.py completion discover_orch <task_id> <tokens> hydra-discover` with `task_id="aa6ce268f0b849876"`/`tokens=42500` and `task_id="runaway-task"`/`tokens=500000`. Live Redis today shows exactly `hydra:metrics:tokens:by-cycle:aa6ce268f0b849876 = 90,525,000` and `hydra:metrics:tokens:by-cycle:runaway-task = 1,065,000,000` — **both are exact integer multiples of the test's fixture values: 90,525,000 / 42,500 = 2130 and 1,065,000,000 / 500,000 = 2130, the identical multiple for both keys.** That is a `HINCRBY`-style accumulation from 2,130 real executions of this unisolated test against the live production Redis (`db0`), each one POSTing a fabricated `skill: "hydra-discover"` token record to the real `/api/metrics/tokens` — the exact same counters `getRollingCostByClass()` reads. Confidence: **high** on the mechanism and its exact historical magnitude (the 2130× match on two independent keys is not coincidental); **unquantified** on what fraction of any single day's total it explains, because per-cycle keys carry no per-write timestamp (see Q4 caveats).

A secondary, independently-confirmed cost multiplier: the 264 recovered real dispatch transcripts show `discover_orch` running on **`claude-opus-4-8`/`claude-opus-5` for the overwhelming majority of usage events (65–149 of ~70–150 per session, 4/4 sampled sessions)**, not the `Haiku` the per-class model routing table documents ([docs/operator-playbooks/hydra-autopilot.md:174](../operator-playbooks/hydra-autopilot.md): `discover_orch / discover_target | Haiku | Patrol/diagnostics, designed small/fast/cheap`). This mirrors a documented sibling failure mode in the same file (lines 138–154: Fable-routed classes silently paying Opus when Fable is unentitled), but here the class was never routed to Fable at all — it's pinned straight to Haiku in the static map, so this is a distinct instance of the same bug family, not yet documented. See Q1 for detail.

**Reframing for the map:** the original question ("does the in-skill Tier-3 iteration counter survive across fresh per-dispatch sessions?") turns out to be secondary. The dominant finding is that the class barely dispatches at all right now, Tier 3 has *never* fired in any recoverable real dispatch, and the reported cost is contaminated by a confirmed test-isolation leak plus a confirmed model-routing miss. Any token-cost-reduction work on this map should start by (a) fixing the `HYDRA_API_BASE` leak in `test/autopilot-dedup-reap.test.mts`, (b) auditing whether `model="haiku"` is actually reaching the `Agent()` call for `discover_orch`, and (c) re-measuring `costByClass` after both fixes before concluding anything about Tier-3 cadence.

---

## Q1 — Does the autopilot dispatch path honor the iteration-counter gating?

**Design as documented.** `docs/operator-playbooks/hydra-discover.md:14–26` (and the generated `~/.claude/skills/hydra-discover/SKILL.md:16–28`):

```
## Context management
On `/loop` each iteration:
1. Read `/tmp/hydra-discover-iteration.txt` (default 0)
2. Increment, write back
3. `/compact` (Claude) / fresh context (Codex)
Counter controls tier:
- Every iteration: Tier 1 + 2
- Every 3rd iteration: Tier 1 + 2 + 3
```

The counter-increment step is explicitly scoped to `/loop` — the interactive, self-repeating slash-command mode — not to a standalone one-shot dispatch. This matters because autopilot's dispatch mechanism is a single `Agent(run_in_background=True, isolation="worktree", model=<resolved>, ...)` call per turn ([docs/operator-playbooks/hydra-autopilot.md:101](../operator-playbooks/hydra-autopilot.md)) — **not** a `/loop`-wrapped session. Whether a compliant one-shot dispatch is even supposed to execute the "on `/loop` each iteration" steps is genuinely ambiguous from the prose alone.

**Filesystem evidence — the counter is not being maintained.** `/tmp/hydra-discover-iteration.txt` (checked live): content `30`, `mtime: 2026-07-25 11:58:37 -0700`, i.e. **unmodified for 14 days** at investigation time, despite `costByClass` showing tens of millions of "hydra-discover" tokens attributed on every one of those 14 days (Q4 table). `/tmp` is a host-level path, not worktree-scoped — `isolation="worktree"` only isolates the *git checkout*, so if dispatches really were reading/incrementing this file every run, its mtime would track the dispatch cadence. It doesn't.

**Real transcript evidence — the counter WAS exercised historically, inconsistently.** Grepping the 264 recovered real `discover_orch` transcripts for their self-reported summary line (`[hydra-discover] Tier N (iteration M)`) turns up varying iteration numbers across sessions — e.g. transcript `1b29b620-9a09-4ab6-a610-2b8d0e4abc4e.jsonl` (2026-07-24) reports `Tier 1+2 (iteration 14)`, while `3b3c05e7-2cc4-42b7-b3a1-3c2559173527.jsonl` (2026-07-25, the last real dispatch found) reports `Tier 1+2 (iteration 0)` **despite not containing a single read or write of `hydra-discover-iteration.txt` anywhere in its 362-line transcript** (`grep -c hydra-discover-iteration.txt` → 0). That is direct evidence that at least this dispatch's "iteration 0" label was not derived from the persisted file at all — it looks like a default the agent printed rather than a value it read.

**Cooldown-tracking is separately, verifiably broken for this class.** The class-level 1h cooldown (`scripts/autopilot/classes.json` — `discover_orch.cooldownSeconds: 3600`, the same object also documents the intended round-robin with `architecture_orch` off the shared `orch_backfill_idle` signal) depends on `state.signal_last_fired[<class>]` being stamped whenever a dispatch fires. Two independent live sources agree it never has been for `discover_orch`:

- `docker exec hydra-redis-1 redis-cli HGETALL hydra:autopilot:signal-last-fired` → `discover_orch 0` (alongside `health 0`, `sweep_target 0`, `discover_target 0`; every other tracked class — `architecture_orch 1785041019`, `cleanup_orch 1785040455`, `retro_orch 1786146252`, `scout_orch 1786188632`, `wire_or_retire_target 1786146252`, `design_qa_target 1785804881`, `skill_prune 1784817039` — carries a real epoch).
- The live `/tmp/hydra-autopilot-state.json` (`turn: 14`, `pid: 2947883`, `sweep_orch: 1786191733` proving it's a fresh, real run) shows the identical `discover_orch: 0`.

Tracing why: `scripts/autopilot/decide.py` defines `stamp_signal(state, signal, now_epoch)` at line 1288 — **it has zero call sites anywhere in `decide.py`** (`grep -n "stamp_signal(" scripts/autopilot/decide.py` returns only the definition). The `discover_orch` selector branch (`decide.py:3007–3017`) calls `make_dispatch(sig, "hydra-discover", ...)`, and `make_dispatch` (`decide.py:753–783`) is a pure action constructor that never touches `signal_last_fired`. `reap.py`'s own docstring is explicit about who it thinks is responsible: *"the signal cooldown lives in signal_last_fired and is stamped by the dispatcher, not here"* (`scripts/autopilot/reap.py:1260–1261`). So the actual stamping is delegated to whatever bash the autopilot *playbook* session runs when executing a `dispatch` action — a prompt-driven step, not a code-enforced one — and for `discover_orch` specifically that step is evidently not happening reliably (it clearly did, historically, given the 264 real dispatches; it evidently doesn't now).

**Model-routing evidence — the class is silently paying for a different model than documented.** `docs/operator-playbooks/hydra-autopilot.md:174` pins `discover_orch` / `discover_target` to **Haiku** ("designed small/fast/cheap"). Sampling 4 of the 264 real transcripts for their `"model":"..."` fields:

| Transcript | Date (mtime) | Opus-family events | haiku events | sonnet events |
|---|---|---|---|---|
| `3b3c05e7-…` | 2026-07-25 | 149 (`claude-opus-5`) | 1 | 3 |
| `99776bb2-…` | 2026-07-16 | 65 (`claude-opus-4-8`) | 2 | 1 |
| `1b29b620-…` | 2026-07-24 | 52 (`claude-opus-4-8`) | 1 | 1 |
| `884a0fa4-…` | 2026-07-17 | 79 (`claude-opus-4-8`) | 2 | 2 |

4/4 sampled real dispatches ran their main session overwhelmingly on an Opus-family model, not Haiku (the 1–3 haiku/sonnet events per session look like small ancillary tool-classification calls, not the main loop). This is the same *class* of bug `hydra-autopilot.md:138–154` already documents for `dev_target`/`retro_orch`/`design_concept_orch` (Fable-routed classes silently falling back to Opus while Fable sits unentitled) — but `discover_orch` was never routed to Fable in the first place; it's pinned straight to Haiku in the static map, so if this reproduces beyond the 4-sample check it is a **distinct, not-yet-documented instance** of "the class routing table's model kwarg isn't reaching the `Agent()` call."

**Confidence:** High that (a) the `/loop`-scoped counter is not meaningfully gating anything in the current standalone-dispatch autopilot architecture — its mtime is stale for 14 days across a period of continuous reported spend; (b) `discover_orch`'s own class-level cooldown tracking is broken (two independent 0-valued sources, code-traced to a dead `stamp_signal` function); (c) real dispatches ran on Opus, not Haiku, in all 4 sampled transcripts. Medium confidence that this Opus-routing pattern is universal across all 264 historical dispatches (only 4 were sampled in depth) — worth a full sweep as a follow-up, not done here for time.

---

## Q2 — When Tier 3 fires, how many parallel Explore subagents / what's the per-subagent cost?

**Cannot be characterized from real dispatch data — Tier 3 has never fired in any recoverable real dispatch.** All 264 transcripts carrying the `hydra-dispatch v1 skill=hydra-discover` sentinel were scanned for `"subagent_type":"Explore"` (the Tier-3a/3b fan-out mechanism per `docs/operator-playbooks/hydra-discover.md:196–197`: *"Claude: `Agent(subagent_type: "Explore", ...)` parallel"*) using ripgrep (`rg -l '"subagent_type":"Explore"' <all 264 files>`): **zero matches.** Every summary line recovered (`[hydra-discover] Tier N (iteration M)`) reads `Tier 1+2`, never `Tier 1+2+3`, regardless of the reported iteration number (0, 14, and others observed).

The skill doc itself never specifies a concrete fan-out width — 3a ("targeted source analysis") and 3b ("cross-module coupling", a fixed set of 3 grep/wc-l shell commands) don't name a parallelism count; the only quantitative signal is the doc's own cost estimate ("Tier 1+2 < 3 min; Tier 3 adds up to 5 min via subagents", `hydra-discover.md:31`) which is a wall-clock budget, not a token or subagent-count budget.

**Confidence:** High that Tier 3 does not fire in practice (0/264 is a complete census of the recoverable real-dispatch transcript history, not a sample). Cannot assign any confidence to a fan-out width or per-subagent cost because there is no positive instance to measure. If the map wants this number, it will have to be obtained by deliberately forcing a Tier-3 iteration (e.g. manually seeding the iteration file and dispatching once) rather than from historical data, since historical data contains none.

---

## Q3 — Does Tier 3c (external WebSearch) fire, and how often?

**No — zero occurrences found.** The same 264-transcript sweep for `"name":"WebSearch"` and `"name":"WebFetch"` (the tools Tier 3c would invoke per `hydra-discover.md:213–227`'s research-query table) returned **zero matches** across the full set (`rg -l '"name":"WebSearch"' <264 files>` → empty; confirmed independently on the one fully-inspected transcript, `3b3c05e7-…`, with a direct `grep -c` on both tool names → 0/0).

This is consistent with Q2: Tier 3c is gated behind Tier 3 firing at all (`hydra-discover.md:193`: "Tier 3: Codebase deep dive (every 3rd iteration)"; 3c is a sub-step of Tier 3), and Tier 3 itself has never fired in the recoverable history, so 3c inherits the same zero.

**Confidence:** High (complete census of available transcripts, not a sample) that WebSearch/WebFetch round-trip cost is **not** a contributor to `hydra-discover`'s measured cost in this window — it cannot be, if the tool is never called. Any WebSearch-round-trip-cost narrative in the map's prior framing should be dropped or re-scoped to "what would it cost if Tier 3c ever fired," not "what is it costing now."

---

## Q4 — Per-tier token breakdown across the last ~10 real discover_orch dispatches

**This cannot be produced as specified — there are not ~10 recent real dispatches to sample, and the available cost data is not tier-attributed.** Two structural facts:

1. **No real dispatch (dispatch-sentinel-verified) exists after 2026-07-25.** The "last ~10 real discover_orch dispatches" the ticket asks for, read literally, are 14+ days old. The most recent 10 by mtime (from the 264-file census) are:

   | # | Transcript | mtime (local) |
   |---|---|---|
   | 1 | `3b3c05e7-2cc4-42b7-b3a1-3c2559173527` | 2026-07-25 21:44:05 |
   | 2 | `42921da9-bf27-4679-a8a8-f3b338884f3a` | 2026-07-25 16:57:13 |
   | 3 | `b34c31b1-cce0-4806-83f5-91b370f1bb34` | 2026-07-25 12:21:19 |
   | 4 | `accc4046-483f-4f56-87ff-b58edd8fd54f` | 2026-07-25 10:35:34 |
   | 5 | `1178e4b0-4e04-4902-a9e7-c7552df696f7` | 2026-07-25 08:29:38 |
   | 6 | `304ebfbf-96aa-48cb-9354-53f25704be41` | 2026-07-25 07:57:46 |
   | 7 | `a7dd5b49-7947-454f-96be-1583f72e3faf` | 2026-07-25 07:40:54 |
   | 8 | `5eb937e2-6bcf-4c7e-b229-7fdca6ff9fb3` | 2026-07-25 07:28:22 |
   | 9 | `717a3e63-7cc7-476b-99a9-1cc12a10ff88` | 2026-07-25 05:44:14 |
   | 10 | `9b08fac6-0c70-43bd-9bf9-c0cf6686efd5` | 2026-07-25 05:15:06 |

   All 10 cluster in a single ~16.5-hour window on 2026-07-25 — the day `orch_backfill_idle` last fired for the shared `discover_orch`/`architecture_orch` backfill set (`architecture_orch` last-fired `1785041019` = the same evening) — not a representative recent sample. The one fully inspected (`3b3c05e7-…`) ran **Tier 1+2 only**: self-reported `<subagent_tokens>71784</subagent_tokens>`, `<tool_uses>38</tool_uses>`, `<duration_ms>169158</duration_ms>` (≈169s, consistent with the doc's "<3 min" Tier-1+2 budget). The raw transcript-level usage sum for the same session was **~16.8M tokens** (`input:287, output:109449, cache_read:16,508,712, cache_creation:177,709`) — two orders of magnitude above the self-reported `subagent_tokens`, almost entirely `cache_read`. Neither of these numbers is tier-attributed by the schema (see next point), and I cannot resolve which one (if either) is what flows into `costByClass`.

2. **The Redis/API cost surfaces do not carry a tier dimension at all.** `recordSubagentTokens()` / `POST /api/metrics/tokens` (`src/api/metrics-tokens.ts:52–66`) accepts only `{skill, tokens, cycleId?, date?}` — no `tier` field. `tokensByCycleKey(cycleId)` (`src/redis/cost.ts:35–37`) stores only `{tokens, skill}` per cycle. `getCostByClass`/`getRollingCostByClass` (`src/cost/cost-attribution.ts:182–209`) fold that into per-skill-per-day totals — also no tier breakdown. So even for a real dispatch, there is no way to answer "how many of its tokens were Tier 1+2 vs Tier 3" from any persisted system — it would have to come from re-reading each transcript's raw tool-call sequence, which is what was done for the one session above.

**What the daily aggregate actually shows (28-day series, `hydra:metrics:tokens:by-skill:daily:<date>` HGET `hydra-discover`, cross-checked against `hydra:metrics:tokens:autopilot:daily:<date>` GET for the day total):**

| Date | hydra-discover tokens | Day total tokens | Discover share |
|---|---|---|---|
| 2026-07-09 | 65,137,846 | 184,499,366 | 35.3% |
| 2026-07-10 | 72,734,034 | 207,677,505 | 35.0% |
| 2026-07-11 | 68,432,613 | 189,748,930 | 36.1% |
| 2026-07-12 | 72,152,500 | 196,877,162 | 36.7% |
| 2026-07-13 | 55,335,000 | 145,845,758 | 37.9% |
| 2026-07-15 | 36,948,104 | 100,750,895 | 36.7% |
| 2026-07-16 | 70,573,495 | 188,602,746 | 37.4% |
| 2026-07-17 | 62,444,842 | 164,412,596 | 38.0% |
| 2026-07-18 | 47,197,500 | 125,061,970 | 37.7% |
| 2026-07-19 | 46,724,478 | 126,898,939 | 36.8% |
| 2026-07-20 | 5,425,000 | 14,837,000 | 36.6% |
| 2026-07-21 | 9,765,000 | 27,533,439 | 35.5% |
| 2026-07-22 | 18,987,500 | 50,353,768 | 37.7% |
| 2026-07-23 | 17,964,922 | 47,227,065 | 38.0% |
| 2026-07-24 | 55,387,159 | 149,446,009 | 37.1% |
| **2026-07-25** | **74,358,710** | 199,418,157 | 37.3% *(last day with a real dispatch sentinel)* |
| 2026-07-26 | 31,536,784 | 89,331,320 | 35.3% |
| 2026-07-27 | 36,347,500 | 97,045,703 | 37.5% |
| 2026-07-28 | 8,680,000 | 22,347,200 | 38.8% |
| 2026-07-29 | 542,500 | 1,396,700 | 38.8% |
| 2026-07-30 | 32,007,500 | 84,508,112 | 37.9% |
| 2026-07-31 | 30,922,500 | 84,512,506 | 36.6% |
| 2026-08-01 | 30,380,000 | 87,239,954 | 34.8% |
| 2026-08-04 | 11,935,000 | 33,113,862 | 36.0% |
| 2026-08-05 | 28,752,500 | 77,886,539 | 36.9% |
| 2026-08-06 | 58,590,000 | 157,593,593 | 37.2% |
| 2026-08-07 | 1,085,000 | 3,480,677 | 31.2% |
| **2026-08-08** | **19,530,000** | 55,056,727 | **35.5%** *(matches issue #3914's headline "~20.6M of ~58.5M"; the `/api/metrics` costByClass read at the same moment reported `totalTokens: 58,537,404`, `research.skills: [{skill: "hydra-discover", tokens: 20,615,000}]` — the small deltas from the table above are the rolling-24h-UTC window vs single-UTC-day read, per `cost-attribution.ts:188–199`)* |

The ratio is remarkably stable (~35–38%) across all 28 days, **including every day of the 14-day dispatch-dark period** (2026-07-26 through 2026-08-08) when zero sentinel-verified real dispatches occurred. A ratio this stable, persisting through a total dispatch outage, is inconsistent with "real per-dispatch Tier-1/2/3 behavior drives the number" and consistent with a **structural, roughly-proportional contamination source** (e.g., a fixed-size test artifact that gets re-triggered at a rate loosely tied to overall development/CI activity, which is also what drives the "day total" denominator up and down in lockstep) — this is circumstantial support for, not proof of, the Q1/executive-summary contamination finding; I did not find a way to attribute day-by-day *proportions* of the leak with the data available (see caveat below).

**Confirmed contamination magnitude found directly in Redis (`hydra:metrics:tokens:by-cycle:*`, `docker exec hydra-redis-1 redis-cli KEYS/HGETALL`, all in `db0`, the same DB the live service reads):**

| Cycle key | skill | tokens (cumulative) | TTL at capture | Source |
|---|---|---|---|---|
| `runaway-task` | `hydra-discover` | 1,065,000,000 | 597,489s (≈6.9d, near the default 7d cycle TTL) | `test/autopilot-dedup-reap.test.mts:375–396` (`OVER_SOFT=500_000`); 1,065,000,000 / 500,000 = **2130** |
| `aa6ce268f0b849876` | `hydra-discover` | 90,525,000 | 597,478s | `test/autopilot-dedup-reap.test.mts:338–373` (`tokens="42500"`); 90,525,000 / 42,500 = **2130** (identical multiple) |

Both values are HINCRBY-style accumulations (the underlying `recordSubagentTokens`/`getSkillTokensAll` path increments, never overwrites — `src/redis/cost.ts` key shapes are plain Redis INT strings/hashes) from 2,130 real executions of this specific unisolated test scenario against the live production Redis, each POSTing through the real `POST /api/metrics/tokens` (`reap.py`'s `_post_token_record`, line 982) to the real live orchestrator (`HYDRA_API_BASE` unset in `runReap()`, defaults to `http://localhost:4000`). Other unrelated test-fixture-named cycle keys with implausibly large token counts were found in the same `db0` keyspace for other skills (`task-A`/`hydra-qa` 25.1M, `task-B`/`hydra-dev` 47.4M, `soft-trip-task`/`hydra-qa` 1,133,500,000, `no-stamp`/`hydra-target-build` 106.3M, `legacy-iso-task`/`hydra-dev` 170.24M, `betting-build-1591`/`hydra-target-build` 255.6M) — the leak is **not specific to `hydra-discover`**, but `hydra-discover`'s two entries are directly traced to a named, still-present test file and describe block. `scripts/test/redis-db-launch.mjs` (lines 8, 19, 225–234) documents that the intended isolation is a `DB-1` fallback with `FLUSHDB` at run start; these keys sitting in `db0` (confirmed with `redis-cli -n 0 EXISTS ... → 1`, `-n 1 EXISTS ... → 0`) means this specific test bypasses that isolation path (it invokes `reap.py` as a raw subprocess via `spawnSync`, which shells out to `docker exec hydra-redis-1 redis-cli` for its *separate* `signal_last_fired`/`research_force_counter` mirror writes regardless of any JS-side `REDIS_URL`, and — the actually load-bearing path here — POSTs over HTTP to whatever `HYDRA_API_BASE` resolves to, which is the live service, not a test double).

**What this does and doesn't prove:**
- **Proves:** a real, exploitable, currently-open code path exists (`test/autopilot-dedup-reap.test.mts`'s `runReap()`, unlike its properly-isolated sibling) by which running this test file on a machine with `hydra-orchestrator.service` live on `:4000` (true of this dev host) writes fabricated `hydra-discover` (and other-skill) token counts into the exact Redis keys `costByClass` reads, and that this has happened at least 2,130 times cumulatively.
- **Does not prove:** what fraction of any single day's ~35% figure this specific leak explains. The per-cycle keys carry no per-increment timestamp — only a rolling TTL that resets on every write — so I cannot reconstruct a day-by-day contribution from Redis state alone. A single full run of the two ISSUE-432 test cases adds `500,000 + 42,500 = 542,500` tokens to *whatever day* is "today" in UTC at run time; matching that against 19–90M/day would require dozens of runs on some days and few on others, which is plausible for an actively-developed repo with frequent `npm test`/CI activity but not verified here.

**Confidence:** High on the existence, mechanism, and historical magnitude (2130×, cross-confirmed on two independent keys) of the test-pollution leak. Low/unquantified on its precise contribution to any specific day's total — flagging this explicitly per the ticket's instruction not to silently present a partial number as complete. **This is a distinct data-quality risk from the `costByClass` "~13% sampled denominator" caveat in operator memory (`reference_costbyclass_partial_denominator`) — that caveat is about `costByClass`'s coverage of true total spend; this finding is about `costByClass`'s numerator being partly fabricated, a different and additive problem.** I also checked `GET /api/usage` (`bySkillByModel`, described in the same operator memory as the more-complete source) at investigation time: it has **no `hydra-discover` key at all** in its last-7-day window (top entries: `interactive` 34.0%, `hydra-dev` 22.5%, `hydra-autopilot` 14.0%, `hydra-qa` 6.3%, …, `GRAND TOTAL 4,722,294,430`) — that surface derives from OAuth-reported session usage tagged by a *different* skill-attribution mechanism than the reap-time Redis counters `costByClass` reads, and evidently doesn't see `hydra-discover` as a distinct bucket at all in this window. The two "more authoritative" sources the operator memory points to (`costByClass` vs `/api/usage bySkillByModel`) disagree completely on whether `hydra-discover` is a meaningful cost line — itself worth flagging to the map as a reconciliation gap, not resolved here.

---

## Summary table

| Question | Answer | Confidence |
|---|---|---|
| Q1: Does autopilot honor Tier-3 iteration gating? | The `/loop`-scoped counter file is stale for 14 days despite continuous reported spend; class-level cooldown tracking (`signal_last_fired`) is code-traced as broken (dead `stamp_signal`, never called); real dispatches (4/4 sampled) ran on Opus, not the documented Haiku. | High on staleness/brokenness; medium on Opus-routing generalizing beyond the 4 samples |
| Q2: Tier-3 parallel Explore fan-out width / cost | Never fires in any of 264 recoverable real dispatches — no data exists to characterize a fan-out width | High (complete census, not sample) |
| Q3: Does Tier 3c (WebSearch) fire? | Never — 0/264 | High (complete census) |
| Q4: Per-tier breakdown, last ~10 real dispatches | No recent real dispatches exist (last one 2026-07-25); the schema has no tier field at all; a confirmed test-pollution leak (2130× accumulated) and a costByClass/`api/usage` reconciliation gap both undermine trusting the headline daily number as pure per-dispatch cost | High on the leak's existence/magnitude; unquantified on its share of any given day |

## Primary sources cited

- `docs/operator-playbooks/hydra-discover.md` (lines 14–34, 193–229)
- `~/.claude/skills/hydra-discover/SKILL.md` (generated mirror)
- `docs/operator-playbooks/hydra-autopilot.md` (lines 76–101, 112–180, 626–659)
- `scripts/autopilot/classes.json` (`discover_orch` entry)
- `scripts/autopilot/decide.py` (lines 1278–1320, 3007–3017, `stamp_signal` at 1288 with zero call sites)
- `scripts/autopilot/reap.py` (lines 68, 164–221, 982–1069, 1236–1276)
- `src/api/metrics-tokens.ts` (lines 24–66)
- `src/cost/cost-attribution.ts` (lines 96–209)
- `src/redis/cost.ts` (lines 24–37)
- `test/autopilot-dedup-reap.test.mts` (lines 93–112, 338–373, 375–396)
- `test/autopilot-token-record-reap-completion.test.mts` (lines 18–97, contrast case)
- `scripts/test/redis-db-launch.mjs` (lines 8, 19, 225–234)
- Live Redis (`docker exec hydra-redis-1 redis-cli`): `HGETALL hydra:autopilot:signal-last-fired`; `KEYS`/`HGETALL hydra:metrics:tokens:by-cycle:*`; `HGETALL`/`GET hydra:metrics:tokens:by-skill:daily:<date>` and `hydra:metrics:tokens:autopilot:daily:<date>` for 28 dates 2026-07-09→2026-08-08; `INFO server`/`INFO keyspace`
- Live filesystem: `/tmp/hydra-discover-iteration.txt` (`stat`, `cat`); `/tmp/hydra-autopilot-state.json`
- Live API (`curl`, 2026-08-08): `GET /api/health`, `GET /api/metrics` (`costByClass`), `GET /api/usage` (`bySkillByModel`), `GET /api/scheduler/status`
- Real Claude Code session transcripts: `~/.claude/projects/-home-gabe-hydra/*.jsonl` — 264 files matched via `rg -l "hydra-dispatch v1 skill=hydra-discover"`; deep-inspected `3b3c05e7-2cc4-42b7-b3a1-3c2559173527.jsonl`, `99776bb2-ed24-4356-b47d-adbd48cfe011.jsonl`, `1b29b620-9a09-4ab6-a610-2b8d0e4abc4e.jsonl`, `884a0fa4-566a-47a1-a48f-e166e8a2efe8.jsonl` for model distribution, tool-call composition, and usage totals
