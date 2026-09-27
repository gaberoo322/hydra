# sync-skills.sh per-playbook loop — concern, state and coverage inventory

Resolves the wayfinder ticket "sync-skills map: inventory the per-playbook loop's concerns, cross-section state, and test coverage" (#4708) on the map "decompose sync-skills.sh's flat generation pipeline into named, testable concerns" (#4394). Facts only. The mechanism choice belongs to #4709 and the one-vs-two-generators choice to #4710.

Snapshot: `origin/master` at `55c8f4d8a`, 2026-09-27. Subjects: `scripts/sync-skills.sh` (705 lines), `test/sync-skills.test.mts` (2,373 lines), `docs/operator-playbooks/` (38 top-level playbooks, 13 `_fragments/`, 4 `_vendor/` bases). Every claim cites `path:line` in the snapshot; the "live run" figures come from one run of the script into a scratch `CLAUDE_SKILLS_DIR`/`CODEX_SKILLS_DIR` at this snapshot.

## 1. Summary

- The loop body (`sync-skills.sh:132–633`) holds **twelve concerns**: README skip, frontmatter parse, `@include` resolution, `compose_base` + structural supersession + seam marker, JSON emit + error check, field extraction back into bash, name/description gate + banners, Claude `SKILL.md` write, `.settings.json` companion copy, reference-file emission, `claude_only` gate + stale-Codex removal, Codex `SKILL.md` write (with the `codex_delegation` footer). Outside it: CLI/arg parse, the #3828 default-mirror guard, the `PLAYBOOK_FILES` glob, `prune_orphans`, and the summary/fail-soft exit.
- **Where the logic lives.** Everything that transforms text (parse, include, compose, supersede) is one 279-line Python heredoc (`147–427`) plus a second 20-line Python heredoc for reference files (`547–566`). Bash owns only: routing on flags, string-templating the two frontmatter blocks, and file mechanics. The heredoc's JSON result is re-read by **eleven** separate `python3 -c` invocations (`435–473`), one per bash variable.
- **Cross-section state.** 13 loop-scoped values cross from the extraction block into the four writer sections (`name`, `desc`, `when`, `allowed_claude`, `args_yaml`, `claude_only`, `codex_delegation`, `disable_model_invocation`, `compose`, `reference_files`, `body`, `banner_claude`, `banner_codex`), plus 5 preamble globals (`REPO_ROOT`, `PLAYBOOKS`, `CLAUDE_DIR`, `CODEX_DIR`, `DRY_RUN`) and 4 counters written back. Only `name`, `desc`, `body` and `DRY_RUN` are read by *both* the Claude and Codex writers.
- **Tests.** 67 `test(` calls in 15 `describe` blocks (the map's "~30 in ~11" undercounts; `test/fixtures/suite-count-baseline.json:416` records 15 top-level). All 41 `spawnSync` sites drive the whole script black-box. Direct coverage exists for the guard, `@include`, compose/supersession/marker, reference files, `disable-model-invocation`, and prune. **No direct test** for: field extraction, the `when_to_use`/`allowed-tools`/`arguments` emission lines, the `.settings.json` companion copy, the `claude_only` Codex-removal branch, the `codex_delegation` footer, the two fail-soft skip paths, `--dry-run` on any writer except prune, `-h`/unknown-arg/missing-`python3` exits, or the summary.
- **Live-vs-dormant.** `codex_delegation` is declared by **zero** playbooks (the footer at `593–612` never executes); `claude_only` by 20 (so 18 Codex skills are emitted); `compose_base` by 4; `supersedes` by 3; `reference_files` by 4; `disable-model-invocation` by 3. Two playbooks declare a kebab-case `allowed-tools:` key the parser never reads (see §6.4).

## 2. Concern table

Language: **PY-heredoc** = the inline `python3 - … <<'PY'` block; **py -c** = a `python3 -c` one-liner; **bash**. Coverage: **direct** = a case asserts on this concern's own output/exit; **indirect** = the concern runs on every invocation but nothing asserts its specific behaviour; **none** = the branch is never executed by any test. Test names are abbreviated but unique; line numbers are in `test/sync-skills.test.mts`.

| # | Concern | Lines (`scripts/sync-skills.sh`) | Lang | Inputs consumed | Outputs produced | Test cases | Coverage |
|---|---|---|---|---|---|---|---|
| 0a | CLI/arg parse + `python3` presence check | 42–59 | bash | argv; env `HYDRA_SYNC_SKILLS_FORCE`, `CLAUDE_SKILLS_DIR`, `CODEX_SKILLS_DIR`, `HOME` | `REPO_ROOT`, `PLAYBOOKS`, `CLAUDE_DIR`, `CODEX_DIR`, `DRY_RUN`, `FORCE`; exit 2 (unknown arg), 0 (`-h`), 127 (no python3) | `--force` (1536); `HYDRA_SYNC_SKILLS_FORCE=1` (1556); `--dry-run` only via prune (1204) | direct for `--force`/env; **none** for `-n`, `-h`, unknown-arg, missing-python3 |
| 0b | Default-mirror content guard (#3828) | 61–118 | bash (+ `git`) | `REPO_ROOT`, `FORCE`, the two `*_SKILLS_DIR` env vars (raw, not `CLAUDE_DIR`); `git diff`/`status` vs `origin/master` on `docs/operator-playbooks` | `GUARD_DEFAULT_PATH`, `GUARD_DIRTY`; exit 4 on refusal | describe 1417: tracked diff (1475), untracked file (1497), clean (1516), `--force` (1536), env force (1556), no `origin/master` (1573), not a git repo (1589), override skips guard (1610) | **direct** (8 cases, every branch) |
| 0c | Playbook discovery: non-recursive glob, README skip | 120–134 | bash | `PLAYBOOKS`; `nullglob` | `PLAYBOOK_FILES`; per-iteration `pb`, `base`; `mkdir -p` of both mirrors | vendored base not emitted (720); fragments-not-emitted is implied by 212/243 (only `demo`/`alpha`/`beta` dirs asserted present, never asserted absent) | direct for `_vendor/`; indirect for `_fragments/`; **none** for README |
| 1 | Frontmatter parse (mini-YAML: scalars, quoted scalars, inline `[a, b]`, block `- item` (#3990), bool coercion) | 148–200 | PY-heredoc | `pb` text (argv[1]) | `fm` dict, `body` string; or `{"error":"no frontmatter"}` + exit 0 | Every case exercises it. Sub-features asserted downstream: block sequence (1690–1806), inline list (380), bool `true` (494, 654), quoted block items (1697) | **indirect** — no case targets the parser; the `no frontmatter` branch is never asserted (`skip … no valid frontmatter` appears in no test) |
| 2 | `@include` resolution (#2552): whole-line directive, path-escape refusal, missing-fragment abort, `{{SKILL_NAME}}` substitution, nested-include abort | 202–247 | PY-heredoc | `body`, `fm["name"]`, `playbooks_dir` (argv[2]), `_fragments/*.md` | `resolved` string; `SystemExit` (non-zero → whole sync aborts via `set -e`) | replaced by fragment (212); `{{SKILL_NAME}}` per skill (243); unresolved fails loud (272); nested fails loud (304); live hydra-dev/target-build include (328) | **direct**; path-escape branch (217–221) untested |
| 3a | `compose_base` load + `supersedes`-without-base guard (#3420) | 249–305 | PY-heredoc | `fm["compose_base"]`, `fm["supersedes"]`, `_vendor/<base>.md` | `compose` bool, `base_body`; `SystemExit` on escape/missing/no-frontmatter base | base+overlay order and fm strip (654); strip wins over overlay flag (692); missing base fails loud (746); uncomposed byte-identical (769); live hydra-qa (789); `supersedes` w/o base (1774) | **direct**; path-escape (282) and base-has-no-frontmatter (298–304) untested |
| 3b | Structural supersession — excise named heading through next equal-or-shallower heading, leave marker (#3990) | 307–388 | PY-heredoc | `base_body`, `supersedes` (str or list), `skill_name` | rewritten `base_body` with `<!-- superseded by the <name> overlay: … -->` marker; `SystemExit` on zero/multiple matches | excised incl. nested (1690); unresolved lists headings (1731); ambiguous (1753); no-supersedes byte-identical (1790); live hydra-qa (939, 1961–2044); live arch-scan (2078–2158) | **direct** |
| 3c | Compose-seam supersede marker — hoist overlay preface ahead of base (#3818) + segment join | 390–423 | PY-heredoc | `resolved`, `base_body`, `skill_name` | final `resolved` = `[preface, ---,] base, ---, ## Hydra AFK overlay (<name>), rest` | hoist + marker stripped (877); no-marker order (916); live hydra-qa mandate ordering (1030, 1980); live arch-scan rule precedes base (2132) | **direct** |
| 4 | JSON emit + bash-side error check | 425–433 | PY-heredoc → bash | `fm`, `resolved`, `compose` | stdout JSON → `parsed`; `grep -q '"error"'` over the raw JSON text → `skip`, `errors++`, `continue` | none assert the skip; every success case asserts exit 0 | **indirect**; skip branch **none** |
| 5 | Field extraction into bash — 11 `python3 -c` re-parses of `parsed` | 435–473 | py -c ×11 | `parsed` | `name`, `desc`, `when`, `allowed_claude` (default `Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*)`), `args_yaml` (`[a, b]` re-join), `claude_only` (`1`/`0`), `codex_delegation` (default `none`), `disable_model_invocation` (`1`/`0`), `compose` (`1`/`0`), `reference_files` (newline-separated), `body` | none target a specific extraction; effects asserted downstream only | **indirect** |
| 6 | name/description gate + banner strings | 475–482 | bash | `name`, `desc` | `skip … missing name or description` + `errors++`; `banner_claude`, `banner_codex` (byte-identical strings) | banner regex on hydra-dev (149) and thermo/zoom (2221); prune suite duplicates the exact banner literal (1087–1088) | banners **direct**; missing-name/desc skip **none** |
| 7 | Claude `SKILL.md` write | 484–514 | bash | `name`, `desc`, `when`, `allowed_claude`, `disable_model_invocation`, `compose`, `args_yaml`, `banner_claude`, `body`, `CLAUDE_DIR`, `DRY_RUN` | `$CLAUDE_DIR/<name>/SKILL.md` via `/tmp/sync-skills.claude.$$` + `mv`; `generated_count++`; `would write …` on dry-run | body propagates (120); `disable-model-invocation: true` line (494, 1916, 2235); omitted when absent (494, 559); stripped when composed (654, 692, 789, 1889, 2158); byte-identical regen (559, 769, 2310) | frontmatter flag + body **direct**; `when_to_use:`/`allowed-tools:`/`arguments:` lines **none** (no test greps them); dry-run `would write` **none** |
| 8 | `.settings.json` companion copy (#509) | 516–532 | bash | `name`, `PLAYBOOKS`, `CLAUDE_DIR`, `DRY_RUN`; `<name>.settings.json` (11 live) | `$CLAUDE_DIR/<name>/.claude/settings.json` (`cp`, unmodified) | — (no test in this file or any other `test/*.mts` references the companion) | **none** |
| 9 | Reference-file emission (#2947) | 534–577 | bash + 2nd PY-heredoc (env-fed: `PLAYBOOKS`, `REF_REL`, `NAME`) | `reference_files`, `name`, `REPO_ROOT`, `PLAYBOOKS`, `CLAUDE_DIR`, `DRY_RUN`; `_fragments/<ref>.md` | `$CLAUDE_DIR/<name>/<basename>` via `printf '%s'`; exit 3 + `errors++` on escape/missing | siblings emitted verbatim with `{{SKILL_NAME}}` (380); missing fails loud (416); live hydra-dev surface union (328); live thermo sibling (2258); sibling idempotent (2310) | **direct**; path-escape (553–557) untested |
| 10 | `claude_only` gate + stale-Codex removal | 579–588 | bash | `claude_only`, `name`, `CODEX_DIR`, `DRY_RUN` | `claude_only_count++`; `rm -f` of a banner-owned `$CODEX_DIR/<name>/SKILL.md`; `continue` | fixture at 666 sets `claude_only: true` but the case reads only the Claude output; no case asserts Codex absence or pre-seeds a stale Codex file | gate **indirect**; removal branch **none** |
| 11 | Codex body + `codex_delegation` footer | 590–613 | bash | `body`, `codex_delegation` | `codex_body` (= `body`, or `body` + 20-line "Codex delegation note") | — | **none** (and dormant: 0 live playbooks declare the key) |
| 12 | Codex `SKILL.md` write | 615–632 | bash | `name`, `desc`, `banner_codex`, `codex_body`, `CODEX_DIR`, `DRY_RUN` | `$CODEX_DIR/<name>/SKILL.md` via `/tmp/sync-skills.codex.$$` + `mv`; `codex_count++` | flag never in Codex (534, 2252); byte-identical Codex regen (573–593, 2336–2367); prune of Codex dirs (1133) | **direct** for "no flag" + idempotency; the two-key frontmatter shape itself is never asserted |
| 13 | `prune_orphans` (#3693) | 649–680 | bash (+ `sed`) | `$1` (dir), `PLAYBOOKS`, `DRY_RUN`; banner line of each `SKILL.md` on disk | `rm -rf` of banner-owned dirs whose playbook is gone; `pruned_count++`; `pruned/would prune …` lines | both dirs (1133); non-banner dir kept (1174); `--dry-run` reports only (1204) | **direct** |
| 14 | Summary + fail-soft `exit 0` | 682–705 | bash | `PLAYBOOK_FILES`, 5 counters, `DRY_RUN` | stdout summary; always `exit 0` unless an earlier `set -e`/`exit` fired | — (`sync-skills summary`, `errors:` appear in no test) | **none** |

Whole-pipeline harnesses that touch several rows at once: `liveSync()` (`54–87`, one shared run over the real corpus, #4502) feeds rows 1–3, 7, 9, 12 for the live golden cases (328, 789, 939, 1030, 1889, 1916, 1936–2044, 2048–2165, 2168–2308); `test/watchdog-skill-mirror-drift.test.mts:80` also spawns the real script into a fixture (regeneration exit-0 only, `:36` of its helper). The deploy-integration (`89–117`) and git-hook (`1234–1415`) describes test `deploy.sh`/`setup-git-hooks.sh`, not the loop.

## 3. Cross-section state

Every read below was verified with `grep -n` over `scripts/sync-skills.sh`; line numbers are the read sites (definition site in the first column).

### 3.1 Preamble globals read inside the loop

| Variable | Defined | Read by: Claude (484–514) | settings (516–532) | ref-files (534–577) | Codex (579–632) | prune (650–680) | summary (682–692) |
|---|---|---|---|---|---|---|---|
| `REPO_ROOT` | 42 | — | — | 546 | — | — | — |
| `PLAYBOOKS` | 43 | — | 523 | 546 | — | 668 | — |
| `CLAUDE_DIR` | 44 | 485 | 525 | 569 | — | 679 (arg) | — |
| `CODEX_DIR` | 45 | — | — | — | 583, 590 | 680 (arg) | — |
| `DRY_RUN` | 46/52 | 508 | 526 | 570 | 585, 626 | 670 | 690 |
| `PLAYBOOK_FILES` | 123 | — | — | — | — | — | 684 |

`FORCE`, `GUARD_DEFAULT_PATH`, `GUARD_DIRTY` (47–48, 96–117) are read only by the guard; nothing inside the loop reads them. `pb` is read only at 133 and 147; `base` only in the two skip messages (430, 476).

### 3.2 Loop-scoped values produced by extraction (435–473) or the banner block (481–482)

| Variable | Produced | Claude | settings | ref-files | Codex | Notes |
|---|---|---|---|---|---|---|
| `parsed` | 147 | — | — | — | — | consumed only by 429 and the 11 extractions 435–473 |
| `name` | 435 | 475, 481, 482, 485, 488 | 523, 525 | 546, 567, 569 | 583, 590, 617 | the only value read by all four writers |
| `desc` | 436 | 475, 489 | — | — | 618 | |
| `when` | 437 | 490 | — | — | — | Claude-only; emitted wrapped in literal `"…"` (490) |
| `allowed_claude` | 438 | 491 | — | — | — | Claude-only |
| `args_yaml` | 439–445 | 500 | — | — | — | Claude-only |
| `claude_only` | 446 | — | — | — | 580 | Codex-only (gate) |
| `codex_delegation` | 447 | — | — | — | 592 | Codex-only; dormant |
| `disable_model_invocation` | 451 | 499 | — | — | — | Claude-only |
| `compose` | 457 | 499 | — | — | — | Claude-only; read *only* to veto the flag |
| `reference_files` | 465–472 | — | — | 543, 576 | — | ref-files-only |
| `body` | 473 | 505 | — | — | 591, 593 | shared |
| `banner_claude` | 481 | 503 | — | — | — | identical text to `banner_codex` |
| `banner_codex` | 482 | — | — | — | 621 | |

Derived, single-section values (never cross a section boundary): `claude_target` (485→509–512), `settings_src`/`settings_target` (523–530), `ref_rel`/`ref_out`/`ref_basename`/`ref_target` (544–574), `codex_existing` (583–585), `codex_target` (590→627–630), `codex_body` (591/593→623).

### 3.3 Counters written by sections, read by the summary

`generated_count` (513), `codex_count` (631), `claude_only_count` (581), `errors` (431, 477, 567), `pruned_count` (676) → 685–689.

### 3.4 What the two out-of-loop units share with the loop

- **#3828 guard (61–118)** runs before the loop and shares nothing the loop produces. It reads `REPO_ROOT`, `FORCE` and the *raw* `CLAUDE_SKILLS_DIR`/`CODEX_SKILLS_DIR` env vars (97–98), not the derived `CLAUDE_DIR`/`CODEX_DIR`.
- **`prune_orphans` (650–680)** reads nothing the loop produces. It re-derives ownership from the banner text on disk (662–664) and existence of `$PLAYBOOKS/<name>.md` (668). Its only couplings to the loop are the banner literal (must equal 481–482 byte-for-byte for the `sed` anchor to match) and the shared `DRY_RUN`/`PLAYBOOKS` globals.

## 4. The JSON contract the heredoc emits

Emitted at `425` as one line on stdout; captured into `parsed` (147).

```
{ "fm": { <frontmatter-key>: string | string[] | boolean, … },
  "body": string,          // post-@include, post-compose, post-supersession
  "compose": boolean }     // true iff fm.compose_base was declared
```

or, for a file with no `^---\n…\n---\n` block, `{"error": "no frontmatter"}` with exit 0 (`155–156`).

Facts about the shape:

- `fm` keys are whatever the frontmatter contains; unknown keys pass through untouched (e.g. `allowed-tools`, see §6.4) and are simply never extracted. Value types: `string` (default; one surrounding quote pair stripped, `192–193`), `string[]` from either an inline `[a, b]` (split on `,`, `194–197`) or a block `- item` sequence (`171–191`, only when ≥1 item follows), `boolean` from the literals `true`/`false` (`198–199`).
- `body` is the fully resolved text; Python does no trailing-newline normalisation, but bash's `$(…)` strips trailing newlines from `body` (473) and `echo "$body"` (505, 623) re-adds exactly one. Byte-identity therefore depends on that bash pairing, not on the JSON.
- Every failure other than "no frontmatter" is a `SystemExit(<message>)` (218, 225, 241, 272, 283, 291, 300, 358, 366): non-zero exit → the `$(…)` under `set -euo pipefail` (40) aborts the **whole** script mid-loop. Skills already written in earlier iterations stay written; later ones are not regenerated.
- The bash-side error test (429) greps the raw JSON text for the substring `"error"` rather than reading a field. Because `json.dumps` escapes embedded quotes, a *body* containing `"error"` cannot match (the live `hydra-qa.md` has one and regenerates fine), but any frontmatter **scalar value, list item, or key** that is exactly `error` would serialise as `"error"` and be skipped as "no valid frontmatter". No live playbook has one.
- The 11 extractions (435–473) each re-parse the same JSON; `name`, `desc`, `when` are read with `.get(key, "")`; `allowed_tools_claude` with a hard-coded default (438); `codex_delegation` with default `none` (447); `claude_only`/`disable-model-invocation`/`compose` are truthiness-coerced to `"1"`/`"0"` (446, 451, 457); `arguments` and `reference_files` are re-joined (`[a, b]`) / re-split (one per line) for the shell (439–445, 465–472).

The second heredoc (547–566) has its own contract: env in (`PLAYBOOKS`, `REF_REL`, `NAME`), fragment text with `{{SKILL_NAME}}` substituted out on stdout, exit 3 on escape/missing.

## 5. Coverage gaps

### 5.1 Concerns with no direct test today

| Concern | Lines | What is unasserted |
|---|---|---|
| Field extraction | 435–473 | any single extraction; the `allowed_tools_claude` default; `arguments` list re-join; `codex_delegation` default |
| Claude frontmatter lines other than the flag | 490, 491, 500 | `when_to_use: "…"`, `allowed-tools: …`, `arguments: …` never grepped (the byte-identical cases at 559/769 compare a run to itself, so they would pass even if a line were dropped) |
| `.settings.json` companion | 516–532 | not referenced by any test file |
| `claude_only` → no Codex file; stale-Codex removal | 579–588 | absence never asserted; removal branch never executed |
| `codex_delegation` footer | 590–613 | never executed by a test; zero live declarers |
| Codex frontmatter shape (name + description only) | 616–619 | only "no `disable-model-invocation`" is asserted (534, 2252) |
| Fail-soft skips: no frontmatter; missing name/desc | 429–433, 475–479 | never executed; `errors` count never read |
| `--dry-run` on writers | 508–509, 526–527, 570–571, 585, 626–627 | only prune's dry-run (670–671) is tested (1204) |
| `-n`, `-h`, unknown arg, missing `python3` | 52–59 | none |
| Path-escape refusals | 217–221, 282–286, 553–557 | none (only the missing-file arms are tested) |
| Base file without frontmatter | 298–304 | none |
| README skip | 134 | none |
| Summary block | 682–692 | none |

### 5.2 Golden cases that pin byte-identical regeneration

These compare bytes and therefore constrain any decomposition to reproduce the current output exactly:

- **Self-idempotency (run twice, diff):** 559 (`untouched`, Claude + Codex), 769 (`plain`, Claude), 2310 (live thermo-nuclear + zoom-out Claude, Codex, and the reference sibling — five files).
- **Live-corpus content goldens (substring/regex, not byte-equal, but they pin ordering and exact strings):** 328 (deposit helper invocation with skill tag), 789 (hydra-qa base + overlay + no flag), 939/1030 (hydra-qa excision marker text `superseded by the hydra-qa overlay: '### 4. Spawn both sub-agents in parallel'`, mandate/step-7 ordering), 1889/1916 (flag absent on every `classes.json` skill, present on hydra-autopilot), 1961–2044 (hydra-qa surviving/excised headings), 2078–2158 (architecture-scan inherited/excised/hoisted sections, no dangling links), 2221–2299 (thermo/zoom banner, flag, sibling, ADR-0033 anchors).
- **Exact literals the tests duplicate from the script:** the DO-NOT-EDIT banner (test 1087–1088 = script 481–482); the excision marker format (test 977 = script 383–384); the flag spelling `disable-model-invocation: true` (test 523, 1930, 2240 = script 499); the `## Hydra AFK overlay (<name>)` separator is *not* asserted by any test.
- **7 of 15 describes construct hermetic throwaway repos** (170, 440, 605, 823, 1070, 1417, 1631); the remaining loop-relevant describes (119, 1010, 1809, 1936, 2048, 2168) read `liveSync()`, so the ordering/excision goldens are pinned against the real corpus rather than minimal inputs.

## 6. Facts bearing on the downstream decisions

### 6.1 `python3` is already a hard dependency of deploy and of CI's required `test` job

- The script exits 127 without `python3` (`59`); `scripts/deploy.sh:60` invokes it under `set -euo pipefail` (`deploy.sh:2`), so every master deploy already requires `python3` on the host.
- CI's `test` job is `runs-on: self-hosted` (`ci.yml:44`) with no `setup-python` step; `test/sync-skills.test.mts` spawns the real script 41 times, so the required job already depends on the runner's system `python3`. `ci.yml:53` also runs `scripts/ci/check-skill-playbook-drift.sh`, itself a `python3` heredoc (`:58–62`).
- 22 files under `scripts/` (including `sync-skills.sh` itself) invoke `python3` (the autopilot lane is Python: `decide.py`, `reap.py`, `heartbeat.py`, `pr-refs.py`, …). `python3` is a system binary, not a `package.json` entry, so it sits outside the ADR-0005 runtime-dep allowlist (`docs/adr/README.md:19`; CLAUDE.md "Runtime deps are operator-approved only").

### 6.2 Process count and wall time

One full run over 38 playbooks spawns 1 heredoc + 11 `python3 -c` per playbook plus 1 heredoc per reference file: 38 × 12 + 9 = **465 `python3` processes**, measured wall time ≈ 12 s (`test/sync-skills.test.mts:56` states "~11s … a dozen python3 passes per playbook"). The test file measured ~151 s standalone before the shared `liveSync()` (`test/redis-db-helper.test.mts:596, 640`; `sync-skills.test.mts:55–63`).

### 6.3 TypeScript re-implementations of parts of the grammar already exist

| Piece | sync-skills.sh | Existing TS copy |
|---|---|---|
| Frontmatter split regex `^---\n(.*?)\n---\n(.*)$` | 153 (and 298 for the base) | `scripts/ci/skill-size-ratchet.ts:117–134` `splitFrontmatter` ("mirroring sync-skills.sh's parse"); `scripts/ci/vendor-drift-check.ts:110, 156` (`collectSupersedes`, `bodyOf`); a third Python copy in `scripts/ci/check-skill-playbook-drift.sh:62` |
| `description:` extraction | 436 | `skill-size-ratchet.ts:142` `extractDescription` |
| `supersedes:` block-sequence parse + heading match | 171–191, 342–355 | `vendor-drift-check.ts:103–147` (`collectSupersedes`, `headingsOf`); `test/sync-skills.test.mts:2029–2044` |
| `@include` + `{{SKILL_NAME}}` + `reference_files` resolution | 208–247, 465–472, 547–565 | `test/hydra-dev-reflection-deposit.test.mts:64–99` (same `includeRe` at `:76`) |

No TS module implements compose/hoist/excise end-to-end; no TS code is imported by the script.

### 6.4 Claude-gen vs Codex-gen: what is literally shared

- **Banners:** `banner_claude` and `banner_codex` are the same string (481–482).
- **Body:** in the live run all 18 Codex-emitted bodies are byte-identical to their Claude bodies (measured), because the only Codex-specific body content is the `codex_delegation` footer (593–612) and no playbook declares that key.
- **Frontmatter:** Claude emits up to 6 keys (`name`, `description`, `when_to_use`, `allowed-tools`, `disable-model-invocation`, `arguments`; 487–501; live union: 38/38/36/38/3/23); Codex emits exactly 2 (`name`, `description`; 616–619; 18/18).
- **Siblings:** only the Claude dir receives `.claude/settings.json` (11 live) and reference files (9 live); Codex dirs contain only `SKILL.md` (measured 0 extra files).
- **Write mechanics:** the brace-group → `/tmp/sync-skills.<x>.$$` → `|| true` → dry-run-or-`mv`-and-count shape is duplicated verbatim (486–514 vs 615–632).
- **Gates:** Claude-side has none; Codex-side has the `claude_only` gate (580) applied to 20/38 playbooks.
- **Ignored key:** `hydra-autopilot.md:5` and `hydra-target-build.md:5` declare kebab-case `allowed-tools:` (with `Agent(*)`, and for target-build `WebSearch(*) WebFetch(*)`) and *not* `allowed_tools_claude:`; the extractor reads only the latter (438), so both regenerate with the hard-coded default `Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*)` (verified in the live output). The parser passes the key through in `fm`; nothing reads or warns on it.

### 6.5 Fix history and enforcement surface

- 7 commits touch `scripts/sync-skills.sh` in the available history (root squash `4d14a495b`, 2026-07-25, plus six): four added a concern (#3693 prune, #3823 seam marker, #3828 guard, #3990 supersession) and two edited comments/rule prose (#4003, #4606); none restructured the loop. 12 commits touch the test file.
- Consumers that assume the current output contract: `scripts/deploy.sh:60`; `scripts/hydra-watchdog.sh:940–970` (skill-mirror drift re-runs the script into a scratch dir); `scripts/ci/check-skill-playbook-drift.sh` (frontmatter validity); `scripts/ci/vendor-drift-check.ts` (supersedes entries resolve in bases); `docs/operator-playbooks/_vendor/provenance.json:2` (a comment above a base's frontmatter breaks `298–304`); the `_fragments/README.md:44–45` and `_vendor/README.md:19, 44` prose describing the glob and compose behaviour.

## 7. Sources

- `scripts/sync-skills.sh` — header 1–38; config 42–48; args 50–57; python3 check 59; guard 61–118; glob 122–124; counters 127–130; loop 132–633: README skip 134, heredoc 147–427 (frontmatter 148–200, include 202–247, compose 249–305, supersession 307–388, marker 390–411, join 413–423, emit 425), error check 429–433, extraction 435–473, gate 475–479, banners 481–482, Claude 484–514, settings 516–532, reference files 534–577 (heredoc 547–566), claude_only 579–588, Codex body 590–613, Codex write 615–632; prune 635–680; summary 682–692; exit 694–705.
- `test/sync-skills.test.mts` — shared `liveSync` 54–87; describes at 89, 119, 170, 440, 605, 823, 1010, 1070, 1234, 1417, 1631, 1809, 1936, 2048, 2168; individual cases as cited in §2 and §5.
- `test/fixtures/suite-count-baseline.json:416`; `test/redis-db-helper.test.mts:596, 640`; `test/watchdog-skill-mirror-drift.test.mts:54–95`; `test/hydra-dev-reflection-deposit.test.mts:64–99`.
- `docs/operator-playbooks/*.md` frontmatter key counts (grep `^key:` over the 38 top-level files): `name` 38, `description` 38, `when_to_use` 36, `allowed_tools_claude` 36, `arguments` 23, `claude_only` 20, `reference_files` 4, `compose_base` 4, `supersedes` 3, `disable-model-invocation` 3, `allowed-tools` 2, `codex_delegation` 0; `@include` directives in 12 files (15 lines); `compose-seam-supersede` marker in `hydra-architecture-scan.md`, `hydra-qa.md`; 11 `*.settings.json` companions; `_fragments/` 13 files + README; `_vendor/` 4 bases + `provenance.json` + README.
- `scripts/deploy.sh:2, 50–60`; `.github/workflows/ci.yml:43–53`; `scripts/ci/check-skill-playbook-drift.sh:1–62`; `scripts/ci/skill-size-ratchet.ts:117–162`; `scripts/ci/vendor-drift-check.ts:103–160`; `scripts/hydra-watchdog.sh:940–970`; `docs/operator-playbooks/_fragments/README.md:4–52`; `docs/operator-playbooks/_vendor/README.md:19, 44, 73–111`.
- `docs/adr/README.md:19` (ADR-0005), `:28` (ADR-0014), `:44` (ADR-0030), `:47` (ADR-0033); `docs/adr/0030-one-pocock-skill-lineage-replaces-forks.md:51–62, 88–92` (Decision 4 / Option C, the `disable-model-invocation` strip invariant).
- Live run: `CLAUDE_SKILLS_DIR=<scratch>/claude CODEX_SKILLS_DIR=<scratch>/codex bash scripts/sync-skills.sh` at `55c8f4d8a` — summary `38 playbooks read / 38 claude / 18 codex / 20 claude_only / 0 pruned / 0 errors`, wall 12.0 s; Claude-vs-Codex body diff over the 18 Codex skills: 0 differences.

## Method

Three read-only passes over the snapshot: (1) a line-by-line read of the script with every variable's definition and read sites confirmed by `grep -n`; (2) a read of all 67 test cases, mapping each assertion to the script lines it exercises; (3) a `grep -l` census of frontmatter keys, directives and companions across `docs/operator-playbooks/`, plus one scratch-dir run of the script to measure emitted key sets, sibling files, Claude/Codex body identity and wall time. No script or test was modified.
