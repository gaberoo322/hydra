# Root-causing discover_orch's dispatch gap and model routing

**Asset for wayfinder ticket [#3916](https://github.com/gaberoo322/hydra/issues/3916)** (map [#3913](https://github.com/gaberoo322/hydra/issues/3913) — "Cut hydra-discover's token cost without degrading finding quality"). Follows on from ticket #3914's characterization doc (`docs/research/2026-08-08-hydra-discover-token-cost-characterization.md`, recovered here from branch `docs/hydra-discover-cost-characterization-3914` at commit `b4910abc` — not yet merged to master), which raised two open questions this doc answers with code tracing, git history, and live state: (Q1) is `discover_orch` being silently excluded from dispatch, and (Q2) is its model routing broken.

Investigation date: 2026-08-08. Live state observed: `hydra-autopilot.service` paused (`autopilotPause.since=1786198828119`), `hydra-orchestrator.service` live on `:4000` (`deployedSha: 493cffa5`), orch board `ready_for_agent: 36` right now.

## Executive summary

1. **Q1 — no dispatch exclusion in `decide.py`.** The selector (`scripts/autopilot/decide.py:3007-3017`) is reachable, correct, and — because of a *different* confirmed bug — structurally biased to win the round-robin over `architecture_orch`, not lose it. The apparent "`discover_orch` has never fired" signal (`signal-last-fired` / `state.json` both reading `0`) is a **measurement artifact of a real, distinct bug**: `scripts/autopilot/bootstrap.sh:993,996` hardcodes `discover_orch` into the "5 always-on" group that is reset to `0` on **every** bootstrap/pace-gate relaunch (~every 15 min), while its round-robin partner `architecture_orch` is correctly placed in the "7 long-cooldown" group that survives relaunches. This classification predates a cooldown change to the very class it misclassifies (see below) — it was never revisited. The actual 14-day dark stretch for **both** `discover_orch` and `architecture_orch` is best explained by the *shared* `orch_backfill_idle` gate genuinely not having fired, corroborated by live evidence.
2. **Q2 — no model-routing bug.** The prior doc's "4/4 sampled dispatches ran on Opus" finding measured the wrong file: all four sampled transcripts are **parent autopilot-loop session transcripts** (each has its own nested `subagents/` directory), not the leaf `discover_orch` dispatch. Tracing each sample's own `dispatchId` sentinel to its actual nested `subagents/agent-<hash>.jsonl` file shows **100% `claude-haiku-4-5-20251001`** (97, 87, 40, 32 tool-use events respectively — 256/256 haiku, 0 non-haiku). A corpus-wide scan of 332 parent-side `Agent()` dispatch calls whose prompt contains `skill=hydra-discover` found `model:"haiku"` explicitly set in 279 (84%), `sonnet` in 27 (8%), and no `model` field in 26 (8%) — i.e. the routing table (`docs/operator-playbooks/hydra-autopilot.md:174`) is being honored the overwhelming majority of the time. This is **not** an instance of the documented Fable-fallback family (`hydra-autopilot.md:138-154`): no fallback is occurring — the requested model is the model that ran.

---

## Q1 — Is `discover_orch`'s selector being reached, or excluded upstream?

### The selector itself is fine, and checked *first*

`_rule_signal_classes` (`scripts/autopilot/decide.py:1993-2260`) iterates a fixed tuple of signal classes in order (lines 2036 onward):

```
"health", "sweep_orch", "sweep_target", "discover_orch", "discover_target",
"scout_orch", "architecture_orch", "retro_orch", "cleanup_orch", ...
```

`discover_orch` is checked **before** `architecture_orch`. Its selector branch (`decide.py:3007-3017`):

```python
if sig == "discover_orch":
    if _signal_present(state, events, "orch_backfill_idle"):
        return make_dispatch(sig, "hydra-discover", reason="orch board idle — discovery backfill")
    return None
```

This is the simplest of the backfill selectors — no board-saturation cap (unlike `architecture_orch`, `cleanup_orch`, `scout_orch`, which all check a `*_board_saturated` guard first). The only gate is `orch_backfill_idle` presence, `_select_for_signal`'s own cooldown check (`if not signal_is_cooled(state, sig, now): return None`, `decide.py:2978`), and the shared `_rule_signal_classes` gates (`dispatch_blocked`, `shed_classes`, `escalated_slots`, `scope_excluded`, `burned`). None of these single out `discover_orch`. Given the iteration order and the one-per-turn `BACKFILL_SIGNAL_CLASSES` stagger (`decide.py:335`, `BACKFILL_SIGNAL_CLASSES = ("discover_orch", "architecture_orch")`), `discover_orch` — evaluated first — wins the stagger slot whenever `orch_backfill_idle` is present, unless it is itself gated out by cooldown, burn, budget, or scope.

### The real bug: `signal_last_fired[discover_orch]` can never carry a real value across a relaunch

`classes.json` gives `discover_orch` and `architecture_orch` the **identical** 1h cooldown:

```
discover_orch          cooldownSeconds=3600
architecture_orch      cooldownSeconds=3600
```

(`scripts/autopilot/classes.json:120` / `:153`). The `discover_orch` row's own `notes` field explains why: *"Dropped from 30m to 3600s so it round-robins with architecture_orch off the unified orch_backfill_idle signal"* (`classes.json:123`, issue #959).

But `scripts/autopilot/bootstrap.sh` treats the two classes asymmetrically. The composed `signal_last_fired` seed (`bootstrap.sh:993-996`):

```bash
SIGNAL_LAST_FIRED_JSON='{"health":0,"sweep_orch":0,"sweep_target":0,"discover_orch":0,"discover_target":0,"retro_orch":0,"architecture_orch":0,"cleanup_orch":0,"scout_orch":0,"wire_or_retire_target":0,"design_qa_target":0,"skill_prune":0}'
...
SIGNAL_LAST_FIRED_MERGED="$(jq -cn --argjson cooled "${COOLDOWN_SIGNAL_SEED}" '
  {health:0, sweep_orch:0, sweep_target:0, discover_orch:0, discover_target:0} + $cooled
' ...)"
```

`discover_orch` is one of the "**5 always-on classes seeded at 0 (re-armed each run by design)**" (comment at `bootstrap.sh:987-988`). `architecture_orch` is in the *other* group — `COOLDOWN_SIGNAL_SEED` (`bootstrap.sh:926`), the "7 long-cooldown classes carried forward from the prior state" (prior state file → Redis mirror → 0; `bootstrap.sh:907-980`). Every bootstrap/pace-gate relaunch (~every 15 minutes per the comment at `bootstrap.sh:897`) **wipes `discover_orch`'s tracked last-fired time back to `0`**, no matter what real dispatches happened in between. `architecture_orch`'s tracked time survives.

**This is a stale classification, not a design choice — confirmed by git history:**

- `be1eed58` (2026-06-03, closes #959, PR #963) — *"unify board-idle signal + 1h backfill cadence"* — raised `discover_orch`'s cooldown from 30 min to 3600s specifically to pair it with `architecture_orch`.
- `61790320` (2026-06-30, closes #2575, PR #2577) — *"seed retro_orch + 3 cooldown classes into signal_last_fired, carried across pace-gate relaunch"* — is the commit that introduced the "5 always-on" vs "long-cooldown carried forward" split, to fix exactly this failure mode (its own commit message: *"decide.py's `signal_is_cooled()` defaults a missing key to epoch 0 — permanently 'cooled' — so the 24h retro cooldown never held across a relaunch and retro fired 5–8×/day instead of the designed 1×/day"*). This fix enumerated `retro_orch` / `architecture_orch` / `cleanup_orch` / `scout_orch` as the classes needing carry-forward — **and omitted `discover_orch`**, even though by this date (nearly a month after #963) `discover_orch` already carried the identical 3600s cooldown that makes it susceptible to the *exact bug this commit was fixing*. The classification was inherited from before #963 raised the cooldown (when 30-min ≈ the 15-min relaunch interval made a reset-to-0 nearly harmless) and was never revisited when the cooldown became 1h.

**Consequence:** `signal_is_cooled(state, "discover_orch", now)` (`decide.py:1278-1284`) reads `last = state.get("signal_last_fired", {}).get("discover_orch", 0) or 0`, which is *always* `0` post-relaunch, so `(now - 0) >= 3600` is trivially `True` — `discover_orch`'s cooldown is a no-op in practice (it is *always* eligible), and `hydra:autopilot:signal-last-fired` / `/tmp/hydra-autopilot-state.json` will report `discover_orch: 0` **forever**, regardless of real dispatch history. `stamp_signal()` (`decide.py:1288-1291`) is a pure function with genuinely zero call sites (`grep -n "stamp_signal(" scripts/autopilot/decide.py` → only the definition) — but even if something called it, `bootstrap.sh`'s next relaunch would erase the write for this specific class. `reap.py`'s docstring (`scripts/autopilot/reap.py:1260-1261`) is correct that stamping is "by the dispatcher, not here," and `reap.py`'s `_mirror_cross_run_state_to_redis` (`reap.py:1372`) mirrors *whatever is in* `state["signal_last_fired"]` — it isn't filtered against a class allowlist — so the leak is entirely in `bootstrap.sh`'s read-side seed composition, not the write/mirror path.

### Live confirmation this is a *tracking* bug, not the *current* dispatch-gap cause

Both facts are true simultaneously, from the same live state read:

```
$ cat /tmp/hydra-autopilot-state.json | jq .signal_last_fired
{
  "health": 0,
  "sweep_orch": 1786191733,
  "sweep_target": 0,
  "discover_orch": 0,
  "discover_target": 0,
  "retro_orch": 1786146252,
  "architecture_orch": 1785041019,
  "cleanup_orch": 1785040455,
  "scout_orch": 1786188632,
  "wire_or_retire_target": 1786146252,
  "design_qa_target": 1785804881,
  "skill_prune": 1784817039
}
```

`architecture_orch` — which **does** correctly survive relaunches — is *also* frozen at `1785041019` (2026-07-25 21:43 PDT), identical to the last confirmed real `discover_orch` dispatch. If `discover_orch` were being silently excluded by a decide.py-level bug while `architecture_orch` kept firing normally, `architecture_orch`'s timestamp would have advanced past that date. It hasn't. That is direct evidence the **shared upstream gate** — not an asymmetric selector exclusion — is what has suppressed both classes for the same 14-day window.

`GET /api/autopilot/board-state` right now:

```
{"needs_qa":0,"ready_for_agent":36,"needs_triage":0,"needs_research":0,"in_progress":0,"blocked":4,...}
```

`orch_backfill_idle`'s gate (`scripts/autopilot/collect-state.sh:839`) is `fallback_due = (rfa == 0 and nr == 0 and nt == 0 and wq == 0)` — **all four** of ready-for-agent, needs-research, needs-triage, and the Redis work-queue must be simultaneously empty. Live `ready_for_agent` is `36` right now — far from idle. This is consistent with `orch_backfill_idle` having stayed `false` continuously since 2026-07-25 because the orch board has carried a sustained ready-for-agent backlog, which would starve **both** backfill classes identically — not a `discover_orch`-specific defect.

### Answer to Q1

`decide.py`'s selector is reached and correct; it is not what excludes `discover_orch`. Two distinct things are true:
- **A real, confirmed, `discover_orch`-specific bug** (`bootstrap.sh:993,996`) makes `signal_last_fired[discover_orch]` permanently unobservable/`0`, so the "never fired" diagnostic used to open this investigation is not trustworthy evidence on its own — it would read `0` even if `discover_orch` fired constantly.
- **The actual 14-day dark stretch** is best attributed to the shared `orch_backfill_idle` signal (owned by `collect-state.sh`, not `decide.py`) not having been true, symmetrically affecting `architecture_orch` too (same frozen epoch, and unlike `discover_orch`, `architecture_orch`'s tracking is known-reliable). Confidence: high that the bootstrap.sh bug is real and `discover_orch`-specific (direct code + git-history evidence); medium-high that it is *not* the cause of the current 14-day gap (inferred from `architecture_orch`'s matching frozen timestamp + live non-idle board state, not from a day-by-day `orch_backfill_idle` history, which is not persisted anywhere queried here).

---

## Q2 — Is `discover_orch`'s model routing broken?

### The prior sample measured the wrong file

The prior doc's 4 samples (`3b3c05e7-…`, `99776bb2-…`, `1b29b620-…`, `884a0fa4-…`) are **top-level session transcripts that each own a nested `subagents/` directory**:

```
$ ls -d 3b3c05e7-2cc4-42b7-b3a1-3c2559173527/subagents
3b3c05e7-2cc4-42b7-b3a1-3c2559173527/subagents
```

(same for all four). A file with its own `subagents/` folder is the **parent autopilot-loop session** — the long-running decision loop that dispatches `dev_orch`/`qa_orch`/`discover_orch`/etc. as `Agent(run_in_background=True, isolation="worktree", ...)` calls — not the dispatched `hydra-discover` subagent itself. The parent loop legitimately runs on whatever model the top-level autopilot session uses (Opus-family in these samples); that has nothing to do with `discover_orch`'s per-class routing.

### Tracing the real dispatch: 100% Haiku, 0 non-Haiku

Each parent transcript's own `discover_orch` dispatch carries a unique sentinel, e.g. for `3b3c05e7-…`:

```
hydra-dispatch v1 skill=hydra-discover dispatchId=worktree-agent-bdfabe0b-t3-discover_orch runId=bdfabe0b-9da8-4e32-a1a8-ac9ab3e266e2
```

Grepping for the **full** `dispatchId` (not the shared run-id prefix, which recurs across every class dispatched in the same turn) inside `<parent>/subagents/*.jsonl` isolates the one nested transcript that actually ran as that dispatch:

| Parent transcript | Nested `discover_orch` subagent file | Model | Tool-use events |
|---|---|---|---|
| `3b3c05e7-…` | `subagents/agent-a587a048a80ea376f.jsonl` | `claude-haiku-4-5-20251001` | 97 |
| `99776bb2-…` | `subagents/agent-a44d81db75d467af3.jsonl` | `claude-haiku-4-5-20251001` | 87 |
| `1b29b620-…` | `subagents/agent-a9b2f04e28ec76cf7.jsonl` | `claude-haiku-4-5-20251001` | 40 |
| `884a0fa4-…` | `subagents/agent-ac8c9be29d4e08916.jsonl` | `claude-haiku-4-5-20251001` | 32 |

**All four of the exact same dispatches the prior doc sampled ran entirely on Haiku (256/256 events)** once traced to the correct file — the routing table (`docs/operator-playbooks/hydra-autopilot.md:174`: `discover_orch / discover_target | Haiku`) was honored in every one of them. A separate full-corpus check confirms this at scale: a real `Agent()` dispatch call in a parent transcript, isolated via `007f5435-…` (dispatchId `worktree-agent-a27b9723-t1-discover_orch`, `model: "haiku"` at the call site) traces to `007f5435-…/subagents/agent-a86ba45574c14e84f.jsonl`, which ran entirely on `claude-haiku-4-5-20251001` (39/39 events) — a clean, independent confirmation that when the parent passes `model="haiku"`, the resulting subagent runs Haiku.

### Corpus-wide dispatch-call compliance

Scanning parent transcripts for `Agent()` tool_use calls whose `prompt` contains `skill=hydra-discover` (332 matched calls across the recovered corpus, spanning 2026-07-09 through 2026-07-25):

```
Counter({'haiku': 279, 'sonnet': 27, None: 26})
```

84% explicit `haiku`, 8% `sonnet`, 8% no `model` field at all (which would inherit the parent session's own model — a real but much smaller compliance gap than "predominantly Opus," and plausibly explainable by the documented cascade-routing escalation override, `hydra-autopilot.md:170-198`, which legitimately substitutes a stronger model for one turn on a `no_op`/`failed` retry — not verified further here).

### Answer to Q2

**No model-routing bug exists for `discover_orch`.** The routing map is being honored in the overwhelming majority of measured dispatches, confirmed directly (100% Haiku) on all four cases the prior doc used to conclude the opposite. This is **not** a distinct instance of the documented Fable-fallback bug family (`hydra-autopilot.md:138-154`) — that family is "the requested model (`fable`) silently resolves to a different, unentitled model." Here, the requested model (`haiku`) is exactly the model that ran; there is no fallback occurring. The prior doc's "65-149 Opus events per session, not Haiku" finding was a measurement error (parent-loop transcript mistaken for the leaf dispatch), not a real defect. Confidence: high (direct trace of all 4 originally-sampled dispatches to their correct file, unanimous result; corroborated by a 332-call corpus scan and one independently-verified parent→child pair).

---

## Summary table

| Question | Answer | Confidence |
|---|---|---|
| Q1: Is `discover_orch`'s selector reached/excluded? | Reached and correct; not excluded by `decide.py`. `signal_last_fired[discover_orch]` is permanently `0` due to a confirmed, distinct `bootstrap.sh` bug (stale "always-on" classification predating a cooldown change), making the "never fired" diagnostic untrustworthy on its own. The actual 14-day dark stretch is best explained by the shared `orch_backfill_idle` gate (board not idle — live `ready_for_agent=36`), symmetrically affecting `architecture_orch` too. | High on the bootstrap.sh bug; medium-high on it not being the current gap's cause |
| Q2: Is `discover_orch`'s model routing broken? | No. All 4 previously-"Opus" samples run 100% Haiku once traced to the correct nested subagent file; corpus-wide dispatch calls show 84% explicit `haiku`. Not related to the documented Fable-fallback family — no fallback occurs. | High |

## Primary sources cited

- `scripts/autopilot/decide.py`: `SIGNAL_COOLDOWNS` (321-323), `BACKFILL_SIGNAL_CLASSES` (335), `BACKFILL_STARVATION_FLOOR_SEC` (349), `signal_is_cooled` (1278-1284), `stamp_signal` (1288-1291, zero call sites), `signal_starved` (1294-1320), `_rule_signal_classes` (1993-2260, iteration order at 2036), `_select_for_signal` / `discover_orch` branch (2977-2978, 3007-3017), `architecture_orch` branch (3075-3100)
- `scripts/autopilot/bootstrap.sh`: schema-version comment (822-825), `COOLDOWN_SIGNAL_SEED` 7-class carry-forward (895-980, esp. 907-911 documenting `retro_orch`/`architecture_orch`/`cleanup_orch`/`scout_orch`/`wire_or_retire_target`/`design_qa_target`/`skill_prune`), composed `SIGNAL_LAST_FIRED_JSON` (987-999, esp. 993 and 996 — the always-on `discover_orch:0` hardcode)
- `scripts/autopilot/reap.py`: `run_completion` docstring on signal-class stamping ownership (1246, 1260-1261), `_mirror_cross_run_state_to_redis` (1356-1372, unfiltered mirror of whatever is in `signal_last_fired`)
- `scripts/autopilot/classes.json`: `discover_orch` entry (115-124, `cooldownSeconds:3600`, notes citing #959), `architecture_orch` entry (148-157, `cooldownSeconds:3600`), full signal-class cooldown table (all 15 signal rows)
- `scripts/autopilot/collect-state.sh`: `orch_backfill_idle` = `fallback_due` definition (774, 839-847)
- Git history: `be1eed58` (2026-06-03, closes #959/#963 — raised `discover_orch` cooldown to 3600s) vs `61790320` (2026-06-30, closes #2575/#2577 — introduced the always-on/long-cooldown split, omitting `discover_orch` despite the prior cooldown change)
- `docs/operator-playbooks/hydra-autopilot.md`: class taxonomy table (76-90), per-class model routing table + rationale (112-180, esp. 174 `discover_orch`/`discover_target` → Haiku), documented Fable-fallback family (138-154)
- Live API (`curl`, 2026-08-08): `GET /api/health`, `GET /api/autopilot/board-state` (`ready_for_agent:36`), `GET /api/scheduler/status`
- Live filesystem: `/tmp/hydra-autopilot-state.json` (`signal_last_fired` snapshot quoted above, `turn:14`)
- Real Claude Code session transcripts: `~/.claude/projects/-home-gabe-hydra/` — the same 266 top-level sentinel-matched files from the prior doc's census, PLUS their nested `<session-id>/subagents/agent-<hash>.jsonl` files (not previously examined); direct trace of `3b3c05e7-…`, `99776bb2-…`, `1b29b620-…`, `884a0fa4-566a-…` (the prior doc's 4 samples) to their nested discover-dispatch subagent files via exact `dispatchId` match; a 332-call corpus scan of `Agent()` tool_use inputs whose `prompt` contains `skill=hydra-discover`, tabulating the `model` field
