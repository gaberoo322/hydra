# Headroom offline spike (tool-scout #4769)

Date: 2026-10-06. Tool: Headroom 0.40.0 (`headroom-ai`, headroomlabs-ai/headroom). Harness: `scripts/headroom-spike.sh`. Eval: `evals/headroom-tap-preservation.yaml`.

## Recommendation

**GO for the GLM-lane proxy pilot (integration option 1), conditional on the guards below. Starting the pilot remains an operator decision (ADR-0005 credentials); this document recommends and does not enact.**

The mechanical rule from the design concept is: GO iff (1) 100% of failing-test names and SUITE-COUNT verdict strings survive verbatim in the compressed text AND (2) aggregate token reduction on the corpus is at least 15%. Both held:

| Criterion | Result |
|---|---|
| Gated strings verbatim in compressed text | 11 / 11 (5 TAP strings, 6 SUITE-COUNT verdict strings) |
| Aggregate token reduction (default config) | 18.5% (340,801 -> 277,812 tokens) |

This is a necessary offline proxy for the issue's live promotion bar (>= 15% fewer tokens per merged PR with no rise in QA first-FAILs), not a substitute for it.

## Why "conditional": the GO is weaker than it looks

1. **The 18.5% is carried by JSON.** `gh api` pulls + issues lists are 296k of the 341k corpus tokens (87%). Their reduction is 13.4% and 45.7%. The three text payloads (TAP, verdict block, journal) together shrink only 45,071 -> 40,820 tokens = **9.4%**, below the 15% bar. The pilot lane clears 15% only if its traffic is JSON-heavy; the GLM drainer's mix is not measured here. The pilot's 7-day baseline must capture the JSON/text split.
2. **Log compression is lossy on error-shaped lines.** For `journal.txt`, 87 lines matched `error|fail|warn`; of the first five (informational needles, not gated) only 3 survived verbatim in the compressed text. Agents that diagnose from `journalctl` (hydra-doctor, incident) would silently lose evidence. Keep journal output out of the compressed path for the pilot, or retrieve-on-miss in the lane wrapper.
3. **Compression of the TAP was non-deterministic across two full runs.** Run 1 left the TAP essentially untouched (0.1%, whitespace-level dedupe only); run 2 compressed it 21.5% (passing subtests elided behind a `Retrieve more: hash=...` marker, the failing `not ok` / `# Subtest:` lines kept). Both runs preserved 5/5 gated strings. The committed eval embeds the run-2 output. A 5/5 score on one small planted TAP (60 subtests, one failure) is not proof for a 30,000-line full-suite TAP; the pilot must golden-check a real red `npm test` capture before promotion.
4. **CCR-only recovery counts as NOT preserved** (the design rule), and the compressed gh payloads and TAP all carry a retrieve marker. No gated string depended on it, but the informational needles in elided regions (journal) would.

## Method

- **In-process library call**, no proxy: `headroom.compress(messages, model="claude-sonnet-4-5")`. Headroom exposes no offline compress CLI subcommand. Each payload is wrapped as an Anthropic `tool_result` (user turn) after a `tool_use`, followed by six filler turns so it is not in the protected-recent window. Two configs were run (`default`, `protect_recent=0`); they were identical on this corpus, so the verdict uses `default`.
- **Preservation** is a verbatim substring check on the compressed `tool_result` text. Gated needles: every `not ok N - <name>` line and name plus the failing `# Subtest:` line (TAP), and the six verdict headline strings (SUITE-COUNT block). gh/journal needles are informational (first/last item number and title; first five error-shaped log lines).
- **Token counts** are Headroom's own `tokens_before` / `tokens_after` (no Anthropic `count_tokens` call: the spike has no API key). **Caveat:** a single-message offline test puts all content in the live zone, so the CacheAligner / frozen-prefix behaviour that protects Anthropic's KV cache is NOT exercised. Real traffic would see smaller savings on cached prefixes and a possible cache-hit cost that this spike cannot measure.
- **Toolchain / deviations from the brief:** pinned uv 0.12.23 (SHA256-verified tarball, spike-local) then `uv tool install --python 3.13 "headroom-ai[proxy,ml]==0.40.0"`. The issue text names `[proxy]`; the `[ml]` extra is added because without it the Kompress text model cannot load and TAP/log text passes through untouched, which makes any "preserved" verdict vacuous (an earlier run without it did exactly that: 0.0% on TAP, 0.2% on journal). The harness warms the model up (Kompress downloads its ~274 MB ONNX model in the background on first use) and records `kompress_live`; if it never loads the verdict is INCONCLUSIVE. Version 0.40.0 is current on PyPI (the design concept cited 0.39.1). Everything lives under `~/.cache/hydra-headroom-spike/` (one `rm -rf`); nothing is in `package.json`.
- **Never run:** proxy, `headroom wrap`, MCP server, systemd units, `ANTHROPIC_BASE_URL` changes. The compressor ran under `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL -u GH_TOKEN -u GITHUB_TOKEN` with `HEADROOM_BEACON=off DO_NOT_TRACK=1 HEADROOM_UPDATE_CHECK=off HF_HUB_DISABLE_TELEMETRY=1` and `HOME` pointed at the spike dir. The only network access besides the corpus capture was the unauthenticated HuggingFace model download.

## Results (run 2, default config)

| payload | source | bytes | sha256 | tokens before | tokens after | reduction | gated strings kept |
|---|---|---|---|---|---|---|---|
| `tap-red.txt` | `node --test --test-force-exit --test-reporter=tap` on a planted-failing file under `/tmp` | 11,581 | `156ed8cc90f2fedd4d73825ae92a71c8117d4bd30594306cd48b26b122a4792b` | 3,330 | 2,614 | 21.5% | 5 / 5 |
| `suite-count-verdict.txt` | verdict headlines copied literally from `scripts/test/redis-db-launch.mjs` (file names and counts synthetic) | 1,530 | `011fc3ac6f41e87be6ce538f0ffcba0a4f763e7493c303363ee7c58fbbfdd21d` | 493 | 493 | 0.0% | 6 / 6 |
| `gh-issues.json` | `gh api repos/gaberoo322/hydra/issues?state=open&per_page=40` | 209,996 | `c48f111d6b5ef81ec797c4c6ab42cd2692923b8cb2cfc84d3879953894beb675` | 59,521 | 32,312 | 45.7% | n/a (4/4 info) |
| `gh-pulls.json` | `gh api repos/gaberoo322/hydra/pulls?state=all&per_page=40` | 826,799 | `bf44ab92889989142d8a29e95e07a2eb16676ddf8ad3dcd079b50e81362fd9b1` | 236,209 | 204,680 | 13.4% | n/a (4/4 info) |
| `journal.txt` | `journalctl --user -u hydra-orchestrator.service -n 400 --no-pager` | 127,811 | `fd236c405af9b1dcf9373c52bfe34567b509b1cc47fc0b17771e4ff2b97d4c6f` | 41,248 | 37,713 | 8.6% | n/a (3/5 info) |
| **aggregate** | | | | **340,801** | **277,812** | **18.5%** | **11 / 11** |

The raw corpus is not committed (journal and API JSON can carry secrets); it was captured under `/tmp/hydra-headroom-spike/corpus/`. `gh-issues.json` and `journal.txt` hashes were identical in runs 1 and 2 because the underlying data had not changed in between; the TAP differs per run (durations).

Run 1 (same harness, same day): aggregate 18.4%, TAP 0.1%, journal 10.0%, 11/11 gated strings kept.

## `~/.claude.json` integrity

The acceptance criterion asks for a byte-identical before/after diff. It could **not** be satisfied literally on this host, and the script exits 3 by design on a mismatch:

| run | before | after |
|---|---|---|
| 1 | `8d63e37ba14ee49de1f68fee4f05b10470b106cb7ab0487f36a1a71d27db179b` | `b57201f29a2181d2218b03215ebe6cb8b9469b9e1e50349272b5738e1cd7bf24` |
| 2 | `6ca0bce8a0566a31459d344d16b5d17c4c8e291c9354587e8a88f203f5cb9b92` | `83929c8cb7df2368c0b41c51fa0de849ac967e4df473dceab6a0387b41d77b82` |

Attribution: the file is rewritten continuously by the live Claude Code sessions on this host (the autopilot and the dispatching session itself). Before Headroom was installed, two hashes taken ~20 seconds apart with no spike process running already differed (`52f3f22b...` then `e2f4b95b...`). The harness also confines `HOME` to the spike directory for the install and compress stages and asserts `~/.cache/hydra-headroom-spike/home/.claude.json` is absent after the run (it was absent in both runs), so Headroom had no path to the real file. The integrity check is only a clean pass on a host with no other Claude Code session writing; on this host treat the "spike-home absent" line as the operative evidence.

## Next step (operator decision, not enacted here)

If the operator approves the proxy pilot: run it as its own user systemd unit for the GLM drainer only, with `HEADROOM_BEACON=off` and `--code-memory none`, and exempt journal / `journalctl` output from compression. Before promotion beyond the GLM lane, repeat the golden check on a real full-suite red TAP and capture a 7-day baseline of tokens per merged PR, 429 rate, QA first-FAIL rate, and the JSON/text token split.
