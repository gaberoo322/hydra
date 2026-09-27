# src/cost phase map: `transcriptScan` and `assembleSnapshot`

- **Ticket:** #4705 (`wayfinder:research`), part of the src/cost layering map #4516
- **Feeds:** #4706 (decomposition grilling). This doc describes what the code does now. It does **not** propose where to split it; #4706 decides that.
- **Baseline:** `origin/master` @ `ef41f0195` (2026-09-27). Every `file:line` below is against that commit.

## Headline

- **`transcriptScan`** (`src/cost/transcript-scan.ts:412–879`) runs ten phases in order. Four of them do I/O: the memo load, the file listing plus per-file `stat`, the per-file `readFile`, and the memo write. The OAuth read is fired at the top and awaited at the end, and it also does I/O. One env var is read, the Weekly Reset Anchor. The rest is pure accumulation over closure-held mutable state. The per-file parse phase (6d) already has a pure intermediate representation, `FileParseMemoEntry` (#3805). The memo-replay phase (6b) consumes the same representation. Both paths call one shared line fold, `foldParsedLine`. The per-file **cross-tab** fold and the per-file 24h accumulation are still written out twice, once on each path.
- **`assembleSnapshot`** (`src/cost/snapshot-assembly.ts:756–1019`) is already a thin coordinator over thirteen exported pure folds (#2188, #2247, #2279, #2988). It does no filesystem, Redis or clock I/O. It does read env: ten `config.ts` getters are called directly, and an eleventh read is hidden inside `deriveHardStop` (`getEmergencyStopPercent`, #4560). It also has fail-loud `logger` side effects inside four helpers. The file header claims "no `process.env` reads". That is true of the fold helpers and false of the coordinator.
- **Coverage gaps (walk level):** no test asserts `bySkillByModel24h` as produced by the walk, on either the fresh path or the memo-replay path. Memo replay of foreign lines, of `observedResetMs`, and of the `byDispatchKind` cross-tab is also untested. The #3752 reconciliation invariant is asserted only on a hand-built `ScanResult` (`test/snapshot-assembly.test.mts:169–177`). The walk itself is never checked against it.
- **Stale docblocks:** 20 claims across 8 `src/cost/*.ts` files. The table in §4 lists them, including the two the ticket already knew about.

---

## 1. `transcriptScan` phase map

Signature (`transcript-scan.ts:412–418`): `(root, now, resolveSkill, readOAuth, memoIo = {}) → Promise<ScanResult>`. It never reads the clock, because `now` is a parameter. It never throws: every I/O site is wrapped in try/catch.

| # | Phase | Lines | Reads | Writes | Effects |
|---|---|---|---|---|---|
| P0 | Cutoffs + injectable defaults | 419–424 | `now`, `memoIo` | `nowMs`, `cutoff7d/24h/5h`, `loadMemo`, `writeMemo` | pure |
| P1 | Fire OAuth read (not awaited) | 432 | `readOAuth` | `oauthPromise` | **I/O** (HTTP + Redis backoff via `oauth-read-cache.ts`), deferred |
| P2 | Accumulator + memo-cache init | 434–496 | env via `getWeeklyResetAnchorMs()` (466) | `acc5h`, `acc7d`, `byModel5h/7d/24h`, `bySkillByModel`, `bySkillByModel24h`, `byDispatchKind`, `tokens24h`, `anchorEnvMs`, `sinceResetEntries`, `mostRecentObservedResetMs`, `unknownModelsSeen`, `foreignModelsSeen`, `foreign7d`, `skillCache`, `kindCache`, 6 counters | **env read** (1), otherwise pure |
| P3 | Memo load | 498–509 | `loadMemo` | `memoMap`, `memoUpserts`, `memoDeletes` | **I/O** (Redis HGETALL via `../redis/transcript-parse-memo.ts`), degrades to empty map |
| P4 | Closure helpers | 511–570 | cutoffs, `anchorEnvMs` | defines `isKnownFamily`, `isKnownDispatchKind`, `isMemoEntryUsable`, `foldParsedLine` | pure definitions. `foldParsedLine` **mutates** `foreign7d`, `acc7d`, `byModel7d`, `tokens24h`, `byModel24h`, `acc5h`, `byModel5h`, `sinceResetEntries` and the caller's `fileByFamily7d` |
| P5 | List transcript files | 572 | `root` | `files` | **I/O** (`listTranscriptFiles`, a directory walk in `src/transcript-store.ts`) |
| P6a | `stat`, mtime gate, memo eviction | 574–595 | `file`, `cutoff7d`, `memoMap` | `st`, `filesSkippedByMtime`, `memoMap` (delete), `memoDeletes`, `filesScanned` | **I/O** (`stat`) |
| P6b | Memo-hit replay | 597–669 | `memoMap.get(file)`, `st`, cutoffs | via `foldParsedLine`: global accumulators. Locally: `fileByFamily7d/24h`, `fileHadInWindow24h`. Also `filesServedFromMemo`, `linesParsed`, `linesWithUsage`, `parseErrors`, `mostRecentObservedResetMs`, `unknownModelsSeen`, `foreignModelsSeen`, `bySkillByModel`, `byDispatchKind`, `bySkillByModel24h` | pure (over the cached entry) |
| P6c | Read file | 671–677 | `file` | `content` | **I/O** (`readFile`), logs and skips on error |
| P6d | Per-line parse + fold | 679–764 | `content`, cutoffs, `anchorEnvMs` | `lines`, per-file `fileByFamily7d/24h`, `fileHadInWindow7d/24h`, `memoEntries`, `fileLinesParsed`, `fileLinesWithUsage`, `fileParseErrors`, `fileObservedResetMs`. Globals: `linesParsed`, `parseErrors`, `linesWithUsage`, `mostRecentObservedResetMs`, `foreignModelsSeen`, `unknownModelsSeen`, plus everything `foldParsedLine` touches | pure (over `content`) |
| P6e | Per-session skill / dispatch-kind attribution + cross-tab fold | 766–803 | `lines`, `file` (→ `sessionIdFromPath`), `resolveSkill`, `fileByFamily7d/24h` | `skillCache`, `kindCache`, `fileSkill`, `fileDispatchKind`, `bySkillByModel`, `byDispatchKind`, `bySkillByModel24h` | pure (the `resolveSkill` injected in production is the pure `deriveSkill`) |
| P6f | Stage memo upsert | 805–815 | `st`, per-file locals from P6d/P6e | `memoUpserts` | pure |
| P7 | Memo write (one pipelined batch) | 818–829 | `memoUpserts`, `memoDeletes` | none | **I/O** (Redis pipeline), logs and continues on error |
| P8 | Once-per-scan diagnostics | 831–854 | `foreignModelsSeen`, `foreign7d`, `unknownModelsSeen` | none | `logger.info` / `logger.warn` |
| P9 | Await OAuth + build `ScanResult` | 856–878 | `oauthPromise` and every accumulator | return value | await of P1 |

### 1.1 Data flow across phase boundaries

- **The closure accumulator set** is written by P2, mutated by P4's `foldParsedLine` and by P6b/P6d/P6e, and read by P9. It is the dominant coupling in the function. Of the per-scan state, only `memoUpserts`/`memoDeletes` (P3 → P6 → P7) and `oauthPromise` (P1 → P9) move on another path.
- **`anchorEnvMs`** (P2, env) gates two things: the since-reset buffering in `foldParsedLine` (567) and the promotion to `mostRecentObservedResetMs` (638, 716). `assembleSnapshot` **re-reads the same env var** (`snapshot-assembly.ts:797`) to gate `deriveSinceReset`. The two phases therefore agree only because both read `HYDRA_USAGE_WEEKLY_RESET_ANCHOR` inside the same `getUsage` call.
- **`FileParseMemoEntry`** (`../redis/transcript-parse-memo.ts`) is already a complete, serialisable per-file contribution. It carries in-7d `entries[]`, `skill`, `dispatchKind`, `observedResetMs` and 3 counters. P6d/P6e/P6f **produce** it and P6b **consumes** it. On a hit, `observedResetMs` is always recorded, whatever the anchor setting (705–719), so a later anchor-set scan replays correctly.
- **One fold, two copies of the cross-tab.** `foldParsedLine` is the one shared line fold, the #3805 "never two copies" invariant (531–541). Two blocks are still duplicated between replay (P6b) and fresh parse (P6d/P6e):
  - the per-file 24h accumulation (628–631 vs 760–763);
  - the per-file fold into `bySkillByModel` / `byDispatchKind` / `bySkillByModel24h` (650–666 vs 787–802).

  The 24h copy has already needed one fix. The #3752 memo-hit path under-counted until the block at 609–631 was added.
- **Attribution memo asymmetry.** On a memo hit, P6b takes `cached.skill` / `cached.dispatchKind` and never populates `skillCache` / `kindCache`. Suppose a later file carries the same `sessionIdFromPath` and is freshly parsed. It resolves its skill from its **own** first user message instead of reusing the earlier resolution. This matters only when two top-level files share a stem, since subagent shards live under `<sessionId>/subagents/` with their own stems. It is still a real divergence between the two paths.

### 1.2 Pure vs I/O, and candidate pure cores (ADR-0040 Decision 2 sense)

ADR-0040 Decision 2 (`docs/adr/0040-glm-drainer-typed-tick-and-shared-eligibility.md:54`) splits each phase into a pure `decide*` core (typed in, typed verdict, no I/O) and a `run*` orchestration over injected deps. Mapped onto `transcriptScan`:

| Phase(s) | Purity today | Candidate pure core? |
|---|---|---|
| P6d + P6e + P6f | pure over `(content, cutoffs, resolveSkill)` | **Yes, strongest.** Its natural output type already exists: `FileParseMemoEntry`. |
| P4 `foldParsedLine` + P6b + the P6e cross-tab fold | pure but closure-mutating | **Yes.** A "fold one `FileParseMemoEntry` into the scan accumulators" core would serve both the hit and miss paths and remove the §1.1 duplication. |
| P0, P8's message-building | pure | trivial |
| P1/P9, P3, P5, P6a, P6c, P7 | I/O | the `run*` side. `memoIo` and `readOAuth` are already injected. `listTranscriptFiles`, `stat` and `readFile` are **not** injectable today; tests use a real temp dir. |
| P2's `getWeeklyResetAnchorMs()` | env | could arrive as an argument (see §1.1) |

## 2. `assembleSnapshot` phase map

Signature (`snapshot-assembly.ts:756–760`): `(scan: ScanResult, now: Date, priorBySkill = null) → UsageSnapshot`. It is synchronous and does no filesystem, Redis or clock I/O.

| # | Phase | Lines | Reads | Writes | Effects |
|---|---|---|---|---|---|
| A0 | Destructure scan | 761–781 | `scan`, `now` | `nowMs` + 18 scan fields | pure |
| A1 | Calibration env | 783–797, 807–808 | `getWeeklyQuotaTokens`, `getFiveHourQuotaTokens`, `getQuotaWeight{Opus,Sonnet,Haiku}`, `getWeeklyResetAnchorMs`, `getCacheReadWeight` | `weeklyQuota`, `fiveHourQuota`, `calibrated`, `weights`, `quotaWeightCalibrated`, `anchorEnvMs`, `cacheReadWeight`, `burnWeights` | **env** (7 getters) |
| A2 | Weighted burn numerators | 811–817 | `byModel5h/7d/24h`, A1 | `weightedBurns` | pure (`deriveWeightedBurns`) |
| A3 | Estimate percents | 823–824 | A2, A1 | `estimatePercentLast5h/7d`, `projectedWeeklyPercent` | pure (`deriveEstimatePercents`) |
| A4 | OAuth headline rebase | 842–851 | `scan.oauth`, A3 | `percentLast5h/7d`, `usageSource`, `oauthError`, `oauthStale`, `oauthAgeMs`, `oauthFiveHourResetsAt`, `oauthSevenDayResetsAt` | pure plus `logger.error` on fallback (`rebaseOnOAuth`, 453) |
| A5 | Hard stops | 870–874 | A4 | `emergencyStop`, `weeklyEmergencyStop` | **hidden env read**: `deriveHardStop` calls `getEmergencyStopPercent()` (`eligibility.ts:112`, #4560) |
| A6 | Quota-Weight totals | 880–885 | `byModel5h/7d`, A1 | `quotaWeightLast5h/7d` | pure (`deriveQuotaWeightTotals`) |
| A7 | Since-reset fixed window | 892–901 | `anchorEnvMs`, `mostRecentObservedResetMs`, `nowMs`, `sinceResetEntries`, A1 | `tokensSinceReset`, `percentSinceReset`, `weeklyResetAnchor` | pure plus `logger.warn` on boundary override (`deriveSinceReset`, 531) |
| A8 | Window pace + pacing state | 913–924 | `nowMs`, `oauthSevenDayResetsAt` (A4), `weeklyResetAnchor` (A7), `percentLast7d` (A4), `projectedWeeklyPercent` (A3) | `windowElapsedFraction`, `paceRatio`, `pacingState` | pure (`deriveWindowPace`, `derivePacingState`). **Must follow A7** (#4121 INV-7) |
| A9 | Detectors | 932–958 | `getDriftReferencePercent`, `getDriftFactor`, `getOAuthEstimateDivergenceFactor`, A3/A4/A7 | none | **env** (3 getters) plus `logger.warn` (657, 718) |
| A10 | Result literal | 963–1018 | everything above plus `priorBySkill` | `UsageSnapshot` | pure. Inline folds: `deriveBySkillWoW` (996), `deriveAttributedPercent` (1000), `cacheHitRatio` ×2 (1013–1014) |

### 2.1 Data flow and purity

- The phase order is a DAG, but the only ordering the code does not force syntactically is **A7 before A8**. It is documented at 903–912.
- `assembleSnapshot` is pure **given env**: 11 env reads (10 direct and 1 via `deriveHardStop`), all through `config.ts`. Lifting A1, A5's threshold and A9's three factors into a typed config argument would make it a pure `decide*`-shaped function. Every fold it composes is already pure and exported (§3.2). So in the ADR-0040 sense it is already a `run*`-free core whose only impurities are env and fail-loud logging.
- The env value `anchorEnvMs` is read on **both** sides of the `ScanResult` boundary (P2 and A1). The scan's `sinceResetEntries` is empty when the anchor is unset, so the boundary type carries an implicit env precondition.

## 3. Test coverage per phase

Suite inventory: `test/usage-tracker.test.mts` has 58 `describe` blocks and 306 tests, in 16 top-level suites. Of those, `describe("usage-tracker")` at line 278 holds 36 nested suites and 228 tests. `test/snapshot-assembly.test.mts` has 2 suites and 8 tests. `test/transcript-session-tokens.test.mts` has 2 suites and 12 tests. `test/token-breakdown.test.mts` has 1 suite and 13 tests.

### 3.1 `transcriptScan` phases

Entry points: `getUsage` (G), `transcriptScan` called directly (T), or a pure helper (H).

| Phase | Suites that reach it (file:line of the suite) | Via |
|---|---|---|
| P0 cutoffs / window bucketing (`foldParsedLine`) | `getUsage scanning` (ut:506, 18 tests); `getUsage cache-hit ratio fields` (ut:436); `weighted quota-burn percentages` (ut:2844); memo `shrinking 5h window` (ut:5411) | G |
| P1/P9 OAuth fire + await | `OAuth meter rebase` (ut:3099); `hard-stop gated on real OAuth` (ut:3259); `OAuth read cadence + last-good` (ut:3437); `OAuth meter exponential backoff` (ut:3766); `OAuth single-flight + Retry-After` (ut:3958, mostly `makeReadOAuth` direct); `OAuth meter backoff persistence` (ut:4276); `test/oauth-backoff-persist.test.mts` (`makeReadOAuth` direct) | G, H |
| P2 anchor env / since-reset buffering | `since-reset window via getUsage` (ut:2383); `drift detector warns` (ut:2997) | G |
| P3 memo load (hit / corrupt / outage) | `transcript parse memo`: seam round-trip (ut:5337), `degrade paths via transcriptScan()` (ut:5490: rejecting load, rejecting write, unrecognised family) | T, H |
| P5/P6a listing, stat, mtime skip, eviction | `getUsage scanning` (ut:506); memo `ages out … evicted` (ut:5462, via `utimes`) | G |
| P6b memo-hit replay | memo `end-to-end via getUsage()` (ut:5383): unchanged file served from memo with identical totals and `bySkillByModel` deep-equal (ut:5384); shrinking-5h replay (ut:5411); appended-file re-parse (ut:5438) | G |
| P6c read failure | none found | — |
| P6d per-line parse | `parseUsageLine` (ut:279), `parseObservedResetMs` (ut:2339) as H; `getUsage scanning` (ut:506) as G; foreign-provider suite (ut:5193: 3 via G/T, 1 H) | G, T, H |
| P6e attribution + cross-tab | `deriveSkill` (ut:1047), `firstUserMessageText` (ut:1088), `deriveDispatchKind` (ut:1311), `token-breakdown.test.mts:23` as H; `bySkillByModel cross-tab` (ut:1125: reconciliation Σskill = byModel, once-per-file resolution) and `byDispatchKind cross-tab + attributedPercent` (ut:1405) as G | G, H |
| P7 memo write failure | `a rejecting memo write is swallowed` (ut:5509) | T |
| P8 diagnostics | unknown-model warn asserted in `getUsage scanning` (ut:1006, ut:1025) | G |

**Walk-level gaps** (no test reaches the behaviour through G or T):

1. **`bySkillByModel24h` produced by the walk**, on both the fresh path (793–802) and the memo-replay path (609–631, 657–666). It is asserted only on a hand-built `ScanResult` (`test/snapshot-assembly.test.mts:169–177`) and in `test/cost-by-class.test.mts:299–402` fixtures. That code path had a real under-count bug before (§1.1).
2. **Memo replay of `observedResetMs`** into `mostRecentObservedResetMs` (637–643). The memo suites all seed `observedResetMs: null`.
3. **Memo replay of foreign entries** (621–623). No memo test seeds `foreign: true`.
4. **Memo replay of `byDispatchKind`** (650–656). The end-to-end memo test deep-equals only `bySkillByModel` (ut:5402).
5. **P6c `readFile` failure** (674–676) and the P6a `stat` race (577–579).

`test/transcript-session-tokens.test.mts` covers `sumSessionTokens` / `tokensForSession` (#3250). Those are sibling functions in the same file, not phases of `transcriptScan`. They reuse `parseUsageLine` but none of the window or memo logic.

### 3.2 `assembleSnapshot` phases

| Phase | Direct pure-helper suite (H) | Through `assembleSnapshot` direct (A) | Through `getUsage` (G) |
|---|---|---|---|
| A2 `deriveWeightedBurns` | ut:4975 (4) | sa:86 calibrated | ut:2844 weighted burn % |
| A3 `deriveEstimatePercents` | ut:5017 (3) | sa:29, sa:86 | ut:506, ut:2844 |
| A4 `rebaseOnOAuth` | ut:4734 (4) | — | ut:3099, ut:3259, ut:3437 |
| A5 `deriveHardStop` | ut:4527 (7), ut:5571 (4, env #4560) | sa:29 (no stop) | ut:3259 |
| A6 `deriveQuotaWeightTotals` | ut:5050 (3) | — | ut:506 (quota-weight cases) |
| A7 `deriveSinceReset` | ut:4817 (5) | — | ut:2383 |
| A8 `deriveWindowPace` / `derivePacingState` | ut:4633 (8), ut:4603 (4) | — | ut:506, ut:2844 |
| A9 `detectCalibrationDrift` / `detectEstimateOAuthDivergence` | ut:4899 (6), ut:2653 (6) | — | ut:2997, ut:2733 |
| A10 `deriveBySkillWoW` | ut:5087 (6) | sa:110 prior-week | none. `readPriorWeek` is never injected in `usage-tracker.test.mts`. `test/usage-weekly-snapshot.test.mts` covers the accessor, not the `getUsage` wiring |
| A10 `deriveAttributedPercent` | ut:1368 (4) | — | ut:1405 |
| A10 pass-through fields | — | sa:29 (diagnostics, raw totals, `bySkillByModel24h`) | ut:436 (`cacheHitRatio`) |
| `weightedQuotaBurn` (A2 internals) | sa:231 (5) | — | — |

(ut = `test/usage-tracker.test.mts`, sa = `test/snapshot-assembly.test.mts`; numbers are suite start lines.)

The A phases are well covered at the helper level. `assembleSnapshot` direct coverage is thin: three tests. The A7 → A8 ordering dependency (window start falls back to `weeklyResetAnchor` when the OAuth reset is null) is covered only through `deriveWindowPace` unit inputs (ut:4633). No composed test exercises it.

## 4. Stale docblock inventory

These are claims in `src/cost/*.ts` that no longer match the code. **H** marks a file header; **B** marks an in-body comment, included where it repeats a stale header claim.

| # | File:line | Claim | Reality |
|---|---|---|---|
| 1 | `transcript-scan.ts:14–18` **H** | Owns "the OAuth cached meter read — `readOAuthCached()` + the module-level `oauthCache` singleton" | Moved to `oauth-read-cache.ts` (#2923, PR #2925). This file only wires it through `makeReadOAuth` (894–935) |
| 2 | `transcript-scan.ts:20–26` **H** | Pure quota-math and final `UsageSnapshot` assembly "stays in `usage-tracker.ts`" | In `snapshot-assembly.ts`: folds moved in #2279 (PR #2291), `assembleSnapshot` in #2988 (PR #2993) |
| 3 | `transcript-scan.ts:28–31` **H** | Imports FROM `token-math`, `config`, `oauth-usage`, `transcript-store`, `transcript-parse-memo`; "`usage-tracker.ts` imports the scan + OAuth-cache primitives FROM here" | Also imports `token-breakdown.ts` and `oauth-read-cache.ts`. `usage-tracker.ts` takes `clearOAuthCache` straight from `oauth-read-cache.ts` (usage-tracker.ts:173) |
| 4 | `transcript-scan.ts:304–306, 394, 891–892` **B** | `ScanResult` feeds "the pure snapshot-assembly phase (`usage-tracker.ts`)"; "that pure math lives in `usage-tracker.ts`"; "`usage-tracker.ts` stays the pure coordinator/assembler" | Same as #2 |
| 5 | `transcript-scan.ts:505, 675, 827, 840, 852` **B** | Log prefix `[usage-tracker]` | Emitted from `transcript-scan.ts`. Cosmetic, but it misattributes grep hits |
| 6 | `snapshot-assembly.ts:16–17` **H** | "PURE: … no `process.env` reads … every time/env/scalar input enters as a function argument" | True of the fold helpers. False of `assembleSnapshot` (added by #2988 after this header was written), which calls 10 `config.ts` env getters, plus 1 through `deriveHardStop` |
| 7 | `snapshot-assembly.ts:20–22` **H** | Imports "from the sibling pure leaves (`token-math.ts`, `transcript-scan.ts`, `oauth-usage.ts`)" | `transcript-scan.ts` is now type-only (`ScanResult`), and it and `oauth-usage.ts` are I/O modules, not pure leaves. The list is missing `token-breakdown.ts`, `config.ts`, `eligibility.ts` and `types.ts` (lines 52–89) |
| 8 | `snapshot-assembly.ts:10` **H** | "the 1,130-line I/O coordinator" | `usage-tracker.ts` is 418 lines |
| 9 | `snapshot-assembly.ts:27–30` **H** | "Functions moved here are VERBATIM relocations … of the helpers that previously lived in `usage-tracker.ts`" | Several were authored here later: `weightedQuotaBurnByCategory` (#3825), `deriveWindowPace` (#4121), `detectEstimateOAuthDivergence` (#2832), `deriveBySkillWoW` (#2404, PR #2420) |
| 10 | `snapshot-assembly.ts:835–837, 862–864` **B** | Hard stops gated on OAuth, so "autopilot fails open" during an OAuth outage | Superseded at the eligibility layer by #3804: a sustained outage yields `meterUnavailable: true` → `allow: false` (`eligibility-usage.ts:55–68`, `eligibility.ts:892–902`). The snapshot fields are unchanged, but the "fails open" narration is wrong |
| 11 | `usage-tracker.ts:14–19` **H** | "Scope today: pure reader + calibration. No Redis writes. No event bus. No dispatch decisions — the scheduler/autopilot integration … lands in a follow-up PR" | The autopilot gates on it (eligibility); the scan writes the Redis parse memo (#3805); `getUsage` reads Redis (prior week, #2404) |
| 12 | `usage-tracker.ts:157–160` **B** | "`usage-tracker.ts` is now the pure coordinator/assembler over the `ScanResult`" | It is the I/O coordinator only. Assembly is in `snapshot-assembly.ts` (#2988) |
| 13 | `usage-tracker.ts:209–211, 415–416` **B** | `EMPTY_BREAKDOWN` / `emptyByModel` / `addBreakdown` "now live in the TranscriptScan seam … imported at the top of this file" | They live in `token-breakdown.ts` (#3513) and are not imported here |
| 14 | `usage-tracker.ts:220–223, 245–247` **B** | `oauthCache` "moved to the TranscriptScan seam"; "The OAuth last-good cache lives in the TranscriptScan seam now" | `oauth-read-cache.ts` (#2923) |
| 15 | `usage-tracker.ts:233–236` **B** | "the seven pure snapshot-assembly slice helpers" | `snapshot-assembly.ts` now exports 13 fold functions plus `assembleSnapshot` |
| 16 | `config.ts:10–11, 16–17` **H** | "`usage-tracker.ts` imports the readers it consumes internally from here" | `usage-tracker.ts` imports none. The consumers are `snapshot-assembly.ts`, `transcript-scan.ts` (`getWeeklyResetAnchorMs`), `oauth-read-cache.ts`, `eligibility.ts`, `weighted-quota-estimate.ts` and others |
| 17 | `eligibility.ts:34–36` **H** | "The JSONL walk, OAuth precedence, weekly Reset-Anchor math, and quota-weight accounting still live in `usage-tracker.ts`" | Walk: `transcript-scan.ts`. OAuth precedence, Reset-Anchor and quota-weight math: `snapshot-assembly.ts` |
| 18 | `token-math.ts:13–14` **H** | "`usage-tracker.ts` imports its math from here" | It no longer does. The consumers are `transcript-scan.ts`, `snapshot-assembly.ts`, `weighted-quota-estimate.ts`, `token-breakdown.ts` (types) and others |
| 19 | `token-breakdown.ts:5` **H** | "Extracted OUT of the `transcript-scan.ts` I/O coordinator (issue #1971)" | The extraction was #3513 (PR #3514). #1971 is the issue that created `transcript-scan.ts`. The line conflates the two |
| 20 | `index.ts:9–10` **H** | "the tracker has no Redis surface — it scans Claude Code's on-disk JSONL transcripts" | The tracker path touches Redis three ways: parse memo (#3805), prior-week snapshot read (#2404), OAuth backoff persistence (#2840) |

Checked and still accurate: `oauth-read-cache.ts:28–34` (its import-direction claim holds); `types.ts:13–15` (it does import `DispatchKind` from `transcript-scan.ts`, which is a re-export; whether that edge is acceptable is already an open question on #4516); `weighted-quota-estimate.ts:12` (the import list matches).

## 5. Precedents: how pieces were lifted out of these bodies

| Extraction | Issue / PR | Shape | What it moved | Tests |
|---|---|---|---|---|
| TranscriptScan seam | #1971 / PR #1975 | **I/O-vs-pure split at a record boundary.** The former private `scanUsage()` was cut into an I/O half returning a new internal `ScanResult` type and a pure tail over it; `getUsage` coordinates both | JSONL walk + OAuth cache out of `usage-tracker.ts` | existing `getUsage` suites unchanged |
| Pure scalar helpers | #2188 / PR #2193; #2247 / PR #2249 | **In-place fold extraction.** Inline math in `assembleSnapshot` became named, exported, scalar-input helpers; `assembleSnapshot` shrank to a coordinator. #2188's design concept explicitly **rejected** a "deps bag / DI container" framing because the body was already I/O-free | `derivePacingState`, `rebaseOnOAuth`, `deriveSinceReset`, `detectCalibrationDrift`; then `deriveWeightedBurns`, `deriveEstimatePercents`, `deriveQuotaWeightTotals` | new per-helper suites in `usage-tracker.test.mts` (+271, +123 lines) |
| snapshot-assembly leaf | #2279 / PR #2291 | **Verbatim relocation into a sibling pure leaf**, with shared primitives (`familyWeight`, `MODEL_FAMILIES`) pushed *down* into `token-math.ts` to avoid a back-import cycle | the 7 helpers + `weightedQuotaBurn` (`usage-tracker.ts` −403 lines) | tests unchanged apart from import paths (+7/−6) |
| `assembleSnapshot` relocation | #2988 / PR #2993 | **Verbatim relocation of the coordinator** next to its folds, so that "how is a snapshot built" lives in one file. It picked up the `config.ts` / `eligibility.ts` value imports, which is the source of stale claim #6 | `assembleSnapshot` (`usage-tracker.ts` −306) | **new** `test/snapshot-assembly.test.mts`, a direct no-I/O test over a synthetic `ScanResult` |
| OAuth backoff/cache seam | #2923 / PR #2925 | **Verbatim relocation of a stateful sub-concern** into its own leaf, leaving a wiring function (`makeReadOAuth`) plus re-exports at the old names | `readOAuthCached`, `oauthCache`, backoff, single-flight | unchanged, reached via re-exports |
| token-breakdown leaf | #3513 / PR #3514 | **Verbatim pure-leaf extraction to repair a pure→I/O import edge.** `snapshot-assembly.ts` had imported accumulator primitives from I/O-laden `transcript-scan.ts`. Re-exports at the old names kept importers unchanged | `EMPTY_BREAKDOWN`, `emptyByModel`, `addBreakdown`, dispatch-kind vocabulary, `deriveSkill` family (`transcript-scan.ts` −156) | **new** `test/token-breakdown.test.mts` (+83) |

What recurs across the precedents:
- Every lift was a behaviour-neutral **verbatim relocation**, or an in-place helper extraction, with "byte-identical `UsageSnapshot`" as the acceptance bar.
- Re-exports at the old names are left behind. That is why `transcript-scan.ts:937–969` and `usage-tracker.ts:175–181, 401` carry re-export tails.
- Each new pure leaf got its own direct-test file (#2988, #3513). Helper extractions added suites to the monolithic `usage-tracker.test.mts` (#2188, #2247).
- None of the precedents touched the **inside** of the `transcriptScan` loop. Every lift so far came from around it: the OAuth cache, the type/primitive vocabulary, and the post-walk math. #3805 added the `FileParseMemoEntry` representation and `foldParsedLine` but kept them in the body.
