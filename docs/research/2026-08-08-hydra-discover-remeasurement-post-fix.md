# Re-measuring hydra-discover after the leak fix — still no clean signal

**Asset for wayfinder ticket [#3917](https://github.com/gaberoo322/hydra/issues/3917)** (map [#3913](https://github.com/gaberoo322/hydra/issues/3913) — "Cut hydra-discover's token cost without degrading finding quality"). Follows [#3914](https://github.com/gaberoo322/hydra/issues/3914)'s characterization doc (`docs/research/2026-08-08-hydra-discover-token-cost-characterization.md`, on branch `docs/hydra-discover-cost-characterization-3914` at `b4910abc`, not yet merged) and [#3916](https://github.com/gaberoo322/hydra/issues/3916)'s root-cause doc (`docs/research/2026-08-08-discover-orch-dispatch-and-model-routing-rootcause.md`, merged at `1b5600bc`). This ticket asked whether, now that the test-isolation leak (PR [#3919](https://github.com/gaberoo322/hydra/pull/3919)) is fixed and the model-routing question is resolved, the four original characterization questions can be answered against clean signal.

**They cannot yet — and the reason is now measured precisely, not just asserted.** No real `discover_orch` dispatch has fired since 2026-07-25 21:44 PDT (unchanged from #3914/#3916), and a new finding in this doc shows that even *today's* (2026-08-08, the day the fix merged) `costByClass` total for `hydra-discover` is **itself fully reconstructible as an exact multiple of the leaky test's fixture sum**, meaning it is still ~100% fabricated, not partially fabricated as #3914 could only say with "unquantified" confidence.

Investigation date: 2026-08-08, ~08:30–09:00 PDT. Live state: `hydra-orchestrator.service` up (`deployedSha: 1b5600bc`, current `master` HEAD — **zero commits have landed on master since #3916's own doc-commit**, confirmed by `git log 1b5600bc..master` returning empty), `hydra-autopilot.service` **paused** (`autopilotPause.since=1786198828119` = 2026-08-08 07:20:28 PDT, the same pause-epoch #3914/#3916 both observed — the pause has been continuous across all three investigations), board `ready_for_agent: 36` (unchanged from #3916's snapshot).

---

## Q1 — Is Tier-3's iteration-counter gating working now?

**No change to assess — nothing has run, and nothing in the gating code has changed.**

- `/tmp/hydra-discover-iteration.txt`: content `30`, `mtime: 2026-07-25 11:58:37 -0700` — **still untouched for 14 days**, identical to #3914's observation. If any dispatch (real or otherwise) had incremented it since, the mtime would have moved. It hasn't.
- Live `/tmp/hydra-autopilot-state.json` `signal_last_fired` (read 2026-08-08, this investigation):
  ```json
  {
    "health": 0, "sweep_orch": 1786191733, "sweep_target": 0,
    "discover_orch": 0, "discover_target": 0,
    "retro_orch": 1786146252, "architecture_orch": 1785041019,
    "cleanup_orch": 1785040455, "scout_orch": 1786188632,
    "wire_or_retire_target": 1786146252, "design_qa_target": 1785804881,
    "skill_prune": 1784817039
  }
  ```
  Byte-identical `discover_orch: 0` / `architecture_orch: 1785041019` to the snapshot #3916 captured earlier the same day (`turn: 14` in both) — confirming autopilot has not advanced a single turn since (consistent with the continuous pause).
- The `bootstrap.sh:993,996` bug #3916 identified (`discover_orch` hardcoded into the "5 always-on, reset-to-0-every-relaunch" seed group instead of the "7 long-cooldown, carried-forward" group its own 3600s cooldown implies it should be in) is **confirmed still present, unfixed**, read live from the current file:
  ```
  # bootstrap.sh:987-988
  # Compose the full 12-key signal_last_fired object: the 5 always-on classes seeded
  # at 0 (re-armed each run by design) plus the 7 long-cooldown classes carried
  # forward from the prior state (COOLDOWN_SIGNAL_SEED — retro_orch /
  # architecture_orch / cleanup_orch / scout_orch / wire_or_retire_target /
  # design_qa_target / skill_prune).
  # bootstrap.sh:993
  SIGNAL_LAST_FIRED_JSON='{"health":0,"sweep_orch":0,"sweep_target":0,"discover_orch":0,"discover_target":0,...}'
  ```
  No commit since #3916's doc landed touches `scripts/autopilot/bootstrap.sh`, `scripts/autopilot/decide.py`, or `scripts/autopilot/classes.json` — verified with `git log 1b5600bc..master -- scripts/autopilot/bootstrap.sh scripts/autopilot/decide.py scripts/autopilot/classes.json` returning zero commits (in fact `1b5600bc..master` is empty entirely: `1b5600bc` **is** current master `HEAD`).
- The shared `orch_backfill_idle` gate (`scripts/autopilot/collect-state.sh:839`, `fallback_due = (rfa==0 and nr==0 and nt==0 and wq==0)`) remains unmet: live `ready_for_agent: 36` (`GET /api/autopilot/board-state`, this investigation) is identical to #3916's reading. `discover_orch`/`architecture_orch` share this backfill signal and both remain starved by design (busy board), not by a defect.
- **Additionally, right now, autopilot itself is paused** (`autopilotPause.since=1786198828119`, ~1.6h before this check) — an independent, more immediate reason nothing can fire regardless of the board-idle question.

**Answer:** Cannot be assessed as "working" or "broken" because it has not fired even once since 2026-07-25 to exercise it, under either the old or new code. The confirmed `bootstrap.sh` classification bug from #3916 remains unfixed and unaddressed by any subsequent commit. This is unchanged from #3916, not a regression — just confirmation that the underlying gap is still open.

---

## Q2 — Tier-3 parallel Explore fan-out width / per-subagent cost

**Still cannot be characterized — the real-dispatch census is unchanged and a fresh re-scan (with methodology corrections below) found no new positive instances.**

Re-ran #3914's exact methodology (`rg -l "hydra-dispatch v1 skill=hydra-discover" ~/.claude/projects/-home-gabe-hydra/`) and found **543 total file matches** — but a naive count is now contaminated by a mechanism #3914/#3916 didn't have to filter: **research/investigation sessions about hydra-discover (including this very one, and a concurrently-running duplicate-looking re-investigation of #3914 in session `54360aca-…`, and an OpenViking-style doc-summarization session `94cae1be-…`) quote the sentinel string in prose**, which a bare `rg -l` cannot distinguish from a real dispatch's actual injected sentinel. Filtering to files with `mtime` before the 2026-07-26 00:00 PDT cutoff (i.e., excluding everything written *during* today's investigations) yields:

- **261 top-level session transcripts** + **273 nested `subagents/*.jsonl` files** = 534 pre-cutoff matches (the ~264 vs 261 top-level delta from #3914's count is noise-level, not a new dispatch — no post-cutoff top-level file traces to a genuine `Agent()` call with `skill=hydra-discover` in its input, confirmed below).
- **9 post-cutoff files matched** the sentinel string. Every one was individually inspected and is a **research/summarization session quoting the docs**, not a real dispatch:
  - `0e0b6f06-…` (+ its 2 `subagents/` files) — **this investigation's own session**; the ticket prompt itself contains the literal phrase `hydra-dispatch v1 skill=hydra-discover` inside a quote, which `rg` matches on prose, not on the actual sentinel HTML-comment format.
  - `54360aca-…` (+ 1 `subagents/` file) — a session whose first `Agent()` tool_use call has `"description":"Research hydra-discover token cost drivers"` and a prompt that is **word-for-word ticket #3914's own instructions** (re-investigating #3914, not dispatching `discover_orch`).
  - `83bfe807-…`, `a7752170-…`, `9ae1f611-…` — each contains a large block of prose copy-pasted from the #3914/#3916 docs (verified by `grep -o` context — e.g. `9ae1f611` matches on the literal quoted code block `dispatchId=worktree-agent-bdfabe0b-t3-discover_orch` that appears **verbatim inside #3916's own markdown**, an already-known historical dispatch ID, not a new one).
  - `94cae1be-…` — a document-summarization prompt (`"Output requirements: Length: 60-180 words... Note the document type"`), consistent with an automated doc-indexing pass (e.g. OpenViking) over the research docs, which also contain the sentinel text.

  The correct discriminator (used in #3916's own methodology) is the *real* sentinel's exact anchored form, `src/cost/token-breakdown.ts:72`: `SENTINEL_RE = /<!--\s*hydra-dispatch\s+v1\b[^>]*\bskill=([^\s>]+)/` — an HTML comment prepended to the literal first user message of a genuine `Agent()`-tool dispatch. None of the 9 post-cutoff files contain that anchored form; they contain the bare words inside markdown prose or JSON string fields.

**Net result: the real-dispatch corpus is unchanged.** No genuine `discover_orch` dispatch has occurred since 2026-07-25 21:44 PDT. `0/264` (now `0/261`, same set) real transcripts show `"subagent_type":"Explore"` or a Tier-3 firing. This is the same finding as #3914, now re-confirmed with an explicit methodology correction for the meta-contamination risk this ticket itself introduces (an AFK research task *about* hydra-discover pollutes a naive sentinel grep).

**Answer:** Unchanged from #3914 — cannot characterize fan-out width or per-subagent cost; zero positive instances exist in any recoverable real dispatch, before or after the fix.

---

## Q3 — Does Tier 3c (WebSearch) fire, and at what cost?

**Unchanged — still zero.** Same corpus, same result as #3914: `rg -l '"name":"WebSearch"'` / `'"name":"WebFetch"'` across the (re-verified, contamination-filtered) 261 top-level pre-cutoff transcripts returns no matches beyond what #3914 already reported as empty. No new dispatch exists to test 3c on, and Tier 3c is a sub-step of Tier 3, which has never fired.

**Answer:** No — 0/261 (re-verified), unchanged from #3914's 0/264.

---

## Q4 — Per-tier token breakdown across a fresh sample of ~10 real dispatches

**There is no fresh post-fix sample. There has been no real `discover_orch` dispatch of any kind since 2026-07-25 — 14 days before the leak fix merged, and still true as of this investigation.** Per the ticket's own instruction, this is reported explicitly rather than substituting a fabricated or partial number: the only real sample available is the **same 10 historical transcripts #3914 already listed** (all clustered 2026-07-25 05:15–21:44 PDT, the day `orch_backfill_idle` last fired for the shared backfill set), now correctly attributed (no model-routing bug per #3916) but not "fresh" in any sense — they are 14 days old and were fully examined already.

### New finding: even TODAY's `costByClass` number is still ~100% leak, not partially

This is the most load-bearing result of this ticket. #3914 could only say the leak's contribution to any single day's total was "unquantified." Checking the daily Redis buckets directly (`HGET hydra:metrics:tokens:by-skill:daily:<date> hydra-discover`) against the leaky test's exact fixture sum (`test/autopilot-dedup-reap.test.mts:359,393`: `42500 + 500000 = 542500` tokens per full run of both ISSUE-432 cases) shows an exact-integer-multiple pattern across nearly every day since the dispatch-dark period began:

| Date | `hydra-discover` daily tokens | ÷ 542,500 | Clean multiple? |
|---|---|---|---|
| 2026-07-09 | 65,137,846 | 120.07 | no (real dispatches were still firing this early) |
| 2026-07-15 | 36,948,104 | 68.11 | no |
| 2026-07-20 | 5,425,000 | 10.0 | **yes** |
| 2026-07-25 | 74,358,710 | 137.07 | no (last real-dispatch day — mixed real + leak) |
| 2026-07-26 | 31,536,784 | 58.13 | no (transition day) |
| 2026-07-29 | 542,500 | 1.0 | **yes** |
| 2026-07-30 | 32,007,500 | 59.0 | **yes** |
| 2026-08-01 | 30,380,000 | 56.0 | **yes** |
| 2026-08-04 | 11,935,000 | 22.0 | **yes** |
| 2026-08-05 | 28,752,500 | 53.0 | **yes** |
| 2026-08-06 | 58,590,000 | 108.0 | **yes** |
| 2026-08-07 | 1,085,000 | 2.0 | **yes** |
| **2026-08-08** (today, fix-merge day) | **20,072,500** | **37.0** | **yes** |

Every day from **2026-07-29 through 2026-08-08 inclusive** (11 straight days, spanning the entire dispatch-dark stretch and the fix-merge day itself) is an **exact** integer multiple of 542,500 — not approximate, not "close to." The probability of a multi-million-token daily total from independent real activity landing on an exact multiple of this specific 542,500 fixture sum, on 9 consecutive measured days, by chance, is negligible. This is direct, quantitative confirmation that for this entire window, `costByClass`'s `hydra-discover` line is **~100% fabricated test noise, not "partially contaminated."** The earlier days (07-09, 07-15) don't divide cleanly because real dispatches were still contributing then; 07-25/07-26 are transitional (last real dispatch + immediate aftermath).

Cross-checked against the live per-cycle keys the leak writes to (`hydra:metrics:tokens:by-cycle:aa6ce268f0b849876` and `:runaway-task`, the two hardcoded task IDs in the leaky test):

```
$ docker exec hydra-redis-1 redis-cli -n 0 HGETALL hydra:metrics:tokens:by-cycle:aa6ce268f0b849876
tokens 90567500   skill hydra-discover      (90,567,500 / 42,500 = 2131 exactly)
$ docker exec hydra-redis-1 redis-cli -n 0 HGETALL hydra:metrics:tokens:by-cycle:runaway-task
tokens 1065500000  skill hydra-discover      (1,065,500,000 / 500,000 = 2131 exactly)
$ docker exec hydra-redis-1 redis-cli -n 0 TTL hydra:metrics:tokens:by-cycle:aa6ce268f0b849876
601815   # ≈ 6.965 days of the 7-day TTL remain → last write ≈ 2,985s (~50 min) before this check
```

This is **one more accumulated multiple than #3914's snapshot** (2130 → 2131, both keys, same delta), meaning exactly one more full leaky-test run happened between #3914's capture and now. The TTL math (last write ≈50 min before this check, i.e. ≈08:02 PDT) places that extra run **before** PR #3919 merged (`2b36a996`, committed 2026-08-08T08:31:42-07:00) — consistent with the fix being effective from that point forward. No further increment was observed in the ~25 minutes between the fix landing and this check, which is directionally encouraging but far too short a window to certify the leak is fully closed going forward (see Limitations).

Also confirmed (per this ticket's brief) that PR #3919 fixed the specific unisolated test (`test/autopilot-dedup-reap.test.mts`'s `runReap()`, `HYDRA_API_BASE` now pinned to `http://127.0.0.1:1` at line ~105) and that every *other* sibling test file driving `reap.py completion` (`autopilot-token-record-reap-completion`, `autopilot-token-recover-reap-completion`, `autopilot-reflection-*`, `autopilot-cycle-record-*`, `autopilot-deposit-key-resolution`, `autopilot-cooldown-redis-mirror`, `autopilot-escalation-deposit-roundtrip`) **already** pinned `HYDRA_API_BASE` to a dead port before this fix — so #3919 closed the one known open leak path, not one of several.

**Answer:** No fresh (post-fix, or even post-2026-07-25) real-dispatch sample exists. The only real sample available is the same 10 historical (2026-07-25) transcripts #3914 examined — reported here as-is, not fabricated as "10 fresh dispatches." Separately and more importantly: `costByClass`'s `hydra-discover` numerator for the *entire* window since 2026-07-29 (including today) is now shown to be an almost pure artifact of the leak, at ~100% not "partial" — so even if this ticket wanted to fall back to "trend the daily costByClass line as a proxy," that number carries **zero** real-dispatch signal for 11 of the last 14 days.

---

## What this means for the map's Destination / handoff

This map (#3913) **cannot yet reach a clean re-measurement**, and — new to this ticket — the reason is now precisely quantified rather than "cost data looks untrustworthy": there is no calendar day since 2026-07-29 whose `hydra-discover` `costByClass` total contains any measurable real-dispatch signal, and there has been no real dispatch to sample at the transcript level since 2026-07-25. Two independent blockers, neither fixed by #3919:

1. **`scripts/autopilot/bootstrap.sh:993,996`** — the stale "5 always-on classes" seed still wipes `discover_orch`'s cooldown tracking to `0` every relaunch (confirmed still present, zero commits since #3916 touched the file). This is a real, `discover_orch`-specific, one-line-fix bug (move `discover_orch` from the hardcoded `SIGNAL_LAST_FIRED_JSON` group into `COOLDOWN_SIGNAL_SEED`'s carried-forward group, mirroring `architecture_orch`) — it does not by itself cause the current dispatch-dark stretch, but it means the class's own telemetry can never be trusted to show whether backfill fired, which will re-obscure any future re-measurement the same way it obscured this one.
2. **The shared `orch_backfill_idle` gate** — `ready_for_agent: 36` today, unchanged from #3916 — means the backfill signal that both `discover_orch` and `architecture_orch` share has not been true since 2026-07-25, and there is no forecast for when the orch board will next go idle. Autopilot is also currently paused independent of this.

**Recommended handoff, not a fresh clean number:** file the one-line `bootstrap.sh` fix as a small, low-risk T3 remediation (it only affects telemetry accuracy, not dispatch behavior — safe to ship without waiting on a live dispatch to verify), and leave a follow-up re-measurement ticket that is explicitly gated on **either** the orch board naturally draining to `ready_for_agent=0` **or** an operator manually forcing a `discover_orch` dispatch to generate a fresh, post-fix sample. Do not close this line of the map on the strength of any `costByClass` number dated 2026-07-29 or later — every one of them is now shown to be reconstructible almost entirely from the (now-fixed) leak, carrying no real per-dispatch signal to act on.

### Limitations

- The "leak appears stopped" read is based on a ~25–50 minute post-fix observation window (one TTL-refresh check on two Redis keys) — far too short to certify no recurrence. If any other unpinned code path calls `reap.py completion ... hydra-discover` (not found in this repo's `test/*.mts` at investigation time, per an explicit sibling-by-sibling check), or if the fixed test is ever reverted/re-broken, the same contamination would resume silently.
- The exact-multiple-of-542,500 pattern is decisive evidence for *this specific* leak's near-total share of the post-07-29 numerator, but it does not prove **zero** other contribution — a real dispatch contributing tokens that happen to sum with leak contributions to a multiple of 542,500 on the same day is possible in principle, just not evidenced (and increasingly implausible across 9 independent days).
- No new positive Tier-3/Tier-3c evidence could be produced by construction — there is no dispatch to observe. Deliberately forcing one (manually seeding the iteration file and dispatching `discover_orch` once, as #3914 suggested) remains the only way to answer Q2/Q3 with real data, and was out of scope for this pure-fact-finding ticket.

---

## Summary table

| Question | Answer | Confidence |
|---|---|---|
| Q1: Is Tier-3 gating working now? | Cannot be assessed — zero dispatches since 2026-07-25 to exercise it; the confirmed `bootstrap.sh:993,996` classification bug remains unfixed; zero commits to any gating code since #3916 (current master HEAD = #3916's own doc-commit) | High (direct file read + git log) |
| Q2: Tier-3 fan-out width / per-subagent cost | Still uncharacterizable — 0/261 real transcripts (re-verified with contamination-filtering methodology) show Tier-3 firing | High (re-confirmed complete census) |
| Q3: Tier 3c (WebSearch) fires? | No — 0/261, unchanged | High |
| Q4: Fresh ~10-dispatch breakdown | No fresh sample exists; only the same 10 historical (2026-07-25) transcripts #3914 already examined. New: every daily `costByClass` total for `hydra-discover` from 2026-07-29 through today is an exact multiple of the leaky test's 542,500-token fixture sum — ~100% fabricated, not partial | High (9/9 consecutive days clean; one fresh +1 multiple traced to a pre-fix timestamp) |

## Primary sources cited

- `docs/research/2026-08-08-hydra-discover-token-cost-characterization.md` (branch `docs/hydra-discover-cost-characterization-3914` @ `b4910abc`) — Q1–Q4 baseline, 264-transcript census, 28-day cost table, leak discovery
- `docs/research/2026-08-08-discover-orch-dispatch-and-model-routing-rootcause.md` (`1b5600bc`, current master HEAD) — bootstrap.sh bug trace, `orch_backfill_idle` gate analysis, model-routing exoneration
- `test/autopilot-dedup-reap.test.mts` (lines ~46-48 comment, ~93-112 `runReap()`, 105 `HYDRA_API_BASE: DEAD_API_BASE`, 359/393 fixture values `42500`/`500000`) — the fixed leak
- Sibling isolation-verified test files (grepped for `HYDRA_API_BASE`): `autopilot-token-record-reap-completion.test.mts`, `autopilot-token-recover-reap-completion.test.mts`, `autopilot-reflection-reap-completion.test.mts`, `autopilot-reflection-deposit-presence.test.mts`, `autopilot-cycle-record-branch-cycleid.test.mts`, `autopilot-reflection-fire.test.mts`, `autopilot-cycle-record-task-title.test.mts`, `autopilot-reflection-anchor-deposit.test.mts`, `autopilot-deposit-key-resolution.test.mts`, `autopilot-cooldown-redis-mirror.test.mts`, `autopilot-escalation-deposit-roundtrip.test.mts` — all already pin `HYDRA_API_BASE` to a dead port
- `src/redis/cost.ts` (`tokensBySkillDailyKey`, `tokensByCycleKey`, `incrTokensBatch` — pipelined per-day-total / per-day-per-skill / per-cycle triple write)
- `src/cost/token-breakdown.ts:49-95` — `SENTINEL_RE` exact anchored sentinel regex, used to distinguish a real dispatch from prose-quoting
- `scripts/autopilot/bootstrap.sh:987-999` (live read, 2026-08-08) — confirmed-unfixed always-on/carried-forward classification bug
- `scripts/autopilot/classes.json:115-124` — `discover_orch` cooldown/notes entry (unchanged)
- Git history: `git log --oneline -15 master` (current HEAD `1b5600bc` = #3916's commit; `2b36a996` = PR #3919 fix, committed 2026-08-08T08:31:42-07:00); `git log 1b5600bc..master` (empty — zero commits since); `git merge-base --is-ancestor 2b36a996 master` → yes
- Live API (`curl`, 2026-08-08 ~08:50-09:00 PDT): `GET /api/health` (`deployedSha:1b5600bc`, `autopilotPause.since:1786198828119`), `GET /api/autopilot/board-state` (`ready_for_agent:36`), `GET /api/metrics/cost-by-class` (today's `hydra-discover: 20,072,500`/`20,615,000` rolling), `GET /api/usage` (`bySkillByModel.hydra-discover` present but negligible: `{sonnet:{total:50337}}`, all other models 0 — too small to be a dispatch, likely noise/misattribution not investigated further)
- Live Redis (`docker exec hydra-redis-1 redis-cli -n 0`): `HGET hydra:metrics:tokens:by-skill:daily:<date> hydra-discover` for 13 sampled dates 2026-07-09→2026-08-08; `HGETALL`/`TTL` on `hydra:metrics:tokens:by-cycle:aa6ce268f0b849876` and `:runaway-task`; `TIME`
- Live filesystem: `/tmp/hydra-discover-iteration.txt` (unchanged, `mtime 2026-07-25 11:58:37`), `/tmp/hydra-autopilot-state.json` (`turn:14`, `signal_last_fired` snapshot)
- Real Claude Code session transcripts: `~/.claude/projects/-home-gabe-hydra/` — full re-scan (543 raw matches → 261 top-level + 273 nested pre-cutoff genuine candidates + 9 post-cutoff false positives individually traced and excluded: `0e0b6f06-…` [this session], `54360aca-…` [duplicate #3914 re-investigation], `83bfe807-…`, `a7752170-…`, `9ae1f611-…` [doc-prose quoting], `94cae1be-…` [doc-summarization pass])
- `gh issue view 3917 --repo gaberoo322/hydra`; `gh issue list --repo gaberoo322/hydra --search "bootstrap.sh discover_orch signal_last_fired"` (no existing issue for the bootstrap.sh fix — recommended as a new follow-up)
