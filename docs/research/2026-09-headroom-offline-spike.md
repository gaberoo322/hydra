# Headroom offline spike — does context compression preserve what Hydra agents verify?

Issue #4769 (tool-scout: Headroom). Measured 2026-10-06 with `scripts/headroom-spike.sh`. Offline only: no proxy, no `headroom wrap`, no MCP server, no systemd unit, no `ANTHROPIC_BASE_URL` change, no model credential reaching Headroom.

## Recommendation

**GO for the GLM-lane proxy pilot (integration option 1), conditional, with the pilot still an operator decision.**

The mechanical rule from the design concept is met: (1) 100% of the gating strings (failing-test name + `not ok` / `# Subtest:` lines, SUITE-COUNT GATE verdict strings) survive verbatim in all three wire-shape variants, and (2) aggregate token reduction on the corpus is **17.2%** (bar: 15%). Read the GO with these four caveats, because the mechanical rule is weaker than it looks:

1. **The preservation result is real but trivial for the gating payloads.** Headroom barely touched them: the red TAP shrank 0.2% (25,593 to 25,552 tokens) and the SUITE-COUNT block 0.0% (router `noop`). Headroom protects error-bearing tool output; the only TAP change was collapsing identical repeated `ok` blocks into `... (repeats 3 lines from N lines back)` markers. The failing test survived because it was left alone, not because compression is failure-aware.
2. **The 17.2% comes almost entirely from `gh api` JSON** (38.4% on the issue list, 13.3% on the PR list; columnar re-encoding). JSON is ~83% of the corpus bytes and the aggregate is byte/token-weighted, so it is dominated by the 618 KB PR list. A real dispatch mix has far less JSON per token of prose and TAP; the live 7-day measurement in the pilot's step 4 is the only number that counts toward the issue's real promotion bar (>=15% fewer tokens per merged PR, no rise in QA first-FAILs). This offline figure is a necessary proxy, not a substitute.
3. **The journal excerpt is lossy.** 15.1% saved, but only **5 of the 25** `error|fail|warn` lines survived verbatim (SmartCrusher sampled the log; the rest are recoverable only via CCR `headroom_retrieve`, which counts as NOT preserved because agents cannot be relied on to call it). This does not trip the GO rule (journal lines are not gating strings), but it is the same silent-elision risk the issue named. Dispatch classes that read journals to find a fault (`health`, `hydra-doctor`, `hydra-incident`) should not be routed through the proxy until a golden case covers it. The GLM drainer lane (`dev_orch` workers reading TAP and issue JSON) is the better-fitting pilot.
4. **Text-model coverage needed an extra the issue did not name.** `headroom-ai[proxy]` alone leaves the Kompress text model unloaded, and Headroom then passes all non-JSON text through untouched (it logs `Kompress model not ready` and compresses nothing), which would have made every text payload "preserved" for free. The spike installs `headroom-ai[proxy,ml]` and preloads Kompress synchronously. The pilot's install must do the same, and must pre-warm the model, or the proxy silently degrades to JSON-only compression.

## Method

- **Toolchain (ADR-0005 lane).** Nothing in `package.json`. The script downloads a pinned uv release (0.12.23, SHA256 `9167d72b3319674b6303c4cbe071854bba13ebdf3d76b1a7cbdc175471fb66d6`, verified before extraction), confines `UV_TOOL_DIR`, `UV_TOOL_BIN_DIR`, `UV_PYTHON_INSTALL_DIR`, `UV_CACHE_DIR` and `HF_HOME` to `~/.cache/hydra-headroom-spike/`, and runs `uv tool install --python 3.13 "headroom-ai[proxy,ml]==0.40.0"`. Removable with `scripts/headroom-spike.sh clean`. Pin note: 0.40.0 was current on PyPI on the run date (0.39.1 in the design concept was current a week earlier).
- **In-process library call**, `headroom.compress(messages, model="claude-sonnet-4-5-20250929", ...)`, from the tool's own interpreter under `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL -u GH_TOKEN -u GITHUB_TOKEN` with `HEADROOM_BEACON=off DO_NOT_TRACK=1 HEADROOM_UPDATE_CHECK=off HF_HUB_DISABLE_TELEMETRY=1`. Kompress weights came from HuggingFace (no credential needed). GitHub data was captured in a separate earlier step.
- **Wire shape.** Each payload is a tool result followed by five more turns, so it sits outside the protected-recent window, as in real traffic. Three variants: Anthropic `tool_result` with `compress_user_messages=True` (primary), the same with default config, and an OpenAI-style `role: "tool"` message. All three produced identical numbers: tool results are compressed regardless of the user-message guard.
- **Token counts** are Headroom's own `tokens_before` / `tokens_after`, minus an `"ok"` baseline conversation to isolate the payload. There is no Anthropic `count_tokens` call (no API key). Caveat: a single offline conversation puts all content in the live zone, so CacheAligner (the prompt-cache-preserving prefix logic) is not exercised; cache behaviour is only observable in the live pilot.
- **Preservation** = verbatim substring presence in the compressed text. A string reachable only through a CCR retrieve marker is NOT preserved.
- **Safety check.** `~/.claude.json` sha256 before and after: `fe17edaed2372683092544e21c5dfd1542a71cd8ef194aefcdc96f147fbf5d99` both times (script exits non-zero on mismatch). Caveat for reruns: a concurrently running Claude Code session rewrites that file, so a mismatch can be a false alarm; rerun before concluding anything.
- **Corpus is not committed** (journal and API JSON can carry secrets). It lives in `/tmp/hydra-headroom-spike/corpus/` and the sha256 manifest below identifies this run. `gh api` and journal payloads are live, so a rerun produces different hashes and slightly different ratios.

## Corpus manifest and results (primary variant)

| payload | source command | bytes | sha256 (first 16) | tokens before | tokens after | saved | gating strings kept |
|---|---|---|---|---|---|---|---|
| a-red-tap | `node --experimental-strip-types --test --test-force-exit --test-reporter=tap planted-failure.test.mts` (planted file under `/tmp`, 600 cases, failure at #300) | 86,766 | 4ffe2ed3114f76da | 25,593 | 25,552 | 0.2% | 2/2 |
| b-suite-count | literal verdict block from `scripts/test/redis-db-launch.mjs` (drift-checked) | 1,548 | 89bf4e6a8b8c438e | 403 | 403 | 0.0% | 7/7 |
| c1-issues-json | `gh api 'repos/gaberoo322/hydra/issues?state=all&per_page=40'` | 197,931 | 6e00750f0729e9be | 56,282 | 34,668 | 38.4% | n/a |
| c2-pulls-json | `gh api 'repos/gaberoo322/hydra/pulls?state=all&per_page=30'` | 618,720 | 22cc76dec9e95b55 | 177,565 | 153,931 | 13.3% | n/a |
| d-journal | `journalctl --user -u hydra-orchestrator.service -n 300 --no-pager` | 75,907 | a08bd1bdb1cbfd4f | 24,735 | 21,011 | 15.1% | 5/25 error/warn lines (informational) |

Aggregate: **17.2%** saved; gating strings **9/9** verbatim. Transforms: TAP `lossless_config`, verdict block `noop`, JSON `mixed` (columnar), journal `smart_crusher`.

## Promptfoo golden case

`evals/headroom-tap-preservation.yaml` (offline `echo` provider, no API key, picked up by the advisory `evals/*.yaml` loop with no workflow edit; promptfoo pinned 0.121.15 as elsewhere). It embeds, inline, a verbatim excerpt of the real compressed TAP around the failing test (compressed 86 KB outputs are too large to inline whole), and holds two tests: a CONTROL on the uncompressed excerpt and the COMPRESSED excerpt, each asserting the `not ok 300 - ...` line, the `# Subtest: ...` line and the test name. Both pass. Because the TAP was left essentially untouched, the golden case passing is expected and does not prove failure-awareness; it guards against a future Headroom version that starts eliding.

## Pilot guidance if the operator approves

- Install `headroom-ai[proxy,ml]` pinned, pre-warm Kompress, run on the GLM drainer unit only, `HEADROOM_BEACON=off`.
- Capture the 7-day baseline first (tokens per merged PR, 429 rate, QA first-FAIL rate), then judge the live promotion bar.
- Keep journal-reading classes off the proxy until a journal-error golden case exists.
- The pilot still needs the credential-forwarding question answered (does the proxy forward cleanly to z.ai with `ANTHROPIC_AUTH_TOKEN`); this spike deliberately did not touch it.
