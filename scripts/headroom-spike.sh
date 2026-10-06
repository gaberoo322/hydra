#!/usr/bin/env bash
set -euo pipefail

# headroom-spike.sh — OFFLINE measurement of Headroom context compression on
# Hydra-shaped payloads (tool-scout spike, issue #4769).
#
# OFFLINE ONLY: no Headroom proxy is started, no `headroom wrap`, no MCP server,
# no systemd unit, no ANTHROPIC_BASE_URL change. The compressor is called
# IN-PROCESS as the Python library (`headroom.compress`) from the interpreter of
# the uv-installed tool. No model credential reaches Headroom: the compress step
# runs under `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u
# ANTHROPIC_BASE_URL -u GH_TOKEN -u GITHUB_TOKEN`, with the vendor beacon /
# update check / telemetry switched off.
#
# TOOL LANE (ADR-0005): nothing in package.json. A pinned uv release binary is
# downloaded and SHA256-verified (the scripts/osv-scan.sh pattern), and every uv
# directory is confined to ONE spike-local dir that `rm -rf` removes entirely.
#
# SAFETY: `~/.claude.json` is hashed at start and end; a mismatch exits non-zero.
# The raw corpus (journal logs / API JSON may carry secrets) is written ONLY to
# /tmp/hydra-headroom-spike/corpus/ and is NEVER committed.
#
# Usage:
#   scripts/headroom-spike.sh            # install + capture + compress + report
#   scripts/headroom-spike.sh install    # only the pinned toolchain bootstrap
#   scripts/headroom-spike.sh capture    # only (re)capture the corpus
#   scripts/headroom-spike.sh compress   # only compress + report (needs both above)
#   scripts/headroom-spike.sh clean      # rm -rf the spike dir and the corpus
# Output: a markdown table + JSON results on stdout (progress on stderr).

UV_VERSION="0.12.23"
UV_SHA256="9167d72b3319674b6303c4cbe071854bba13ebdf3d76b1a7cbdc175471fb66d6"
UV_ASSET="uv-x86_64-unknown-linux-gnu.tar.gz"
HEADROOM_VERSION="0.40.0"
HEADROOM_EXTRAS="proxy,ml"   # [proxy] is the issue AC; [ml] is REQUIRED for the Kompress text compressor (without it text payloads pass through untouched)

SPIKE_DIR="${HEADROOM_SPIKE_DIR:-$HOME/.cache/hydra-headroom-spike}"
WORK_DIR="${HEADROOM_SPIKE_WORK:-/tmp/hydra-headroom-spike}"
CORPUS_DIR="$WORK_DIR/corpus"
RESULTS_JSON="$WORK_DIR/results.json"
CLAUDE_JSON="$HOME/.claude.json"
UV_BIN="$SPIKE_DIR/bin/uv"
HEADROOM_PY="$SPIKE_DIR/tools/headroom-ai/bin/python"

log() { printf 'headroom-spike: %s\n' "$*" >&2; }

verify_sha() {
  local file="$1" expected="$2" actual
  actual="$(sha256sum "$file" | awk '{print $1}')"
  if [ "$actual" != "$expected" ]; then
    log "SHA256 mismatch for $file (expected $expected, got $actual)"
    return 1
  fi
}

# Every uv path is confined to the spike dir; nothing lands in ~/.local or pip.
uv_env() {
  env \
    UV_TOOL_DIR="$SPIKE_DIR/tools" \
    UV_TOOL_BIN_DIR="$SPIKE_DIR/tools/bin" \
    UV_PYTHON_INSTALL_DIR="$SPIKE_DIR/python" \
    UV_CACHE_DIR="$SPIKE_DIR/cache" \
    HEADROOM_BEACON=off DO_NOT_TRACK=1 HEADROOM_UPDATE_CHECK=off \
    HF_HUB_DISABLE_TELEMETRY=1 HF_HOME="$SPIKE_DIR/hf" \
    "$@"
}

stage_install() {
  mkdir -p "$SPIKE_DIR/bin"
  if [ ! -x "$UV_BIN" ]; then
    local tmp
    tmp="$(mktemp -d "$SPIKE_DIR/uv-dl.XXXXXX")"
    log "downloading uv $UV_VERSION"
    curl -sSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${UV_ASSET}" -o "$tmp/uv.tgz"
    # Verify BEFORE extracting — a mismatched archive never becomes runnable.
    verify_sha "$tmp/uv.tgz" "$UV_SHA256" || { rm -rf "$tmp"; exit 1; }
    tar xzf "$tmp/uv.tgz" -C "$tmp"
    install -m 0755 "$tmp/uv-x86_64-unknown-linux-gnu/uv" "$UV_BIN"
    rm -rf "$tmp"
  fi
  log "uv: $("$UV_BIN" --version)"
  # Install when absent OR when the installed version is not the pinned one.
  if [ ! -x "$HEADROOM_PY" ] || ! uv_env "$UV_BIN" tool list 2>/dev/null | grep -qF "headroom-ai v${HEADROOM_VERSION}"; then
    log "installing headroom-ai[$HEADROOM_EXTRAS]==$HEADROOM_VERSION (python 3.13, spike-local)"
    uv_env "$UV_BIN" tool install --python 3.13 "headroom-ai[${HEADROOM_EXTRAS}]==${HEADROOM_VERSION}" >&2
  fi
  "$HEADROOM_PY" -c 'import headroom,sys; print("headroom import ok", sys.version.split()[0])' >&2
}

stage_capture() {
  rm -rf "$CORPUS_DIR"
  mkdir -p "$CORPUS_DIR" "$WORK_DIR/planted"
  local repo
  repo="$(git rev-parse --show-toplevel)"

  # (a) red node:test TAP — deterministic planted failure written under /tmp,
  # never under test/ (the suite-count FILE-SET baseline stays untouched).
  cat >"$WORK_DIR/planted/planted-failure.test.mts" <<'EOF'
import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("planted headroom spike suite", () => {
  // A real `npm test` TAP is overwhelmingly `ok` lines with the failure buried in
  // the middle; reproduce that shape (600 cases, the single failure at 300).
  for (let i = 1; i <= 600; i++) {
    if (i === 300) {
      it("planted-failing-test-4769 detects the planted regression", () => {
        assert.equal(1 + 1, 3, "planted failure for the headroom spike");
      });
    } else {
      it(`passing filler case ${i}`, () => {
        assert.equal(i, i);
      });
    }
  }
});
EOF
  log "capturing (a) red TAP"
  (cd "$WORK_DIR/planted" && node --experimental-strip-types --test --test-force-exit \
    --test-reporter=tap planted-failure.test.mts >"$CORPUS_DIR/a-red-tap.txt" 2>&1) || true

  # (b) SUITE-COUNT GATE verdict block. The verdict heads are the literal strings
  # emitted by scripts/test/redis-db-launch.mjs; the drift check below fails
  # loudly if a head stops existing there, so the corpus cannot go stale.
  log "capturing (b) SUITE-COUNT GATE verdicts"
  local launcher="$repo/scripts/test/redis-db-launch.mjs" frag
  for frag in 'BASELINED FILE(S) WERE NOT RUN' 'FILE(S) RAN BUT ARE NOT BASELINED' \
              'FILE NEVER RAN' 'SUITE-COUNT GATE FAILED (issue #4020)' \
              'SUITE-COUNT GATE INCONCLUSIVE (issue #4137)'; do
    grep -qF -- "$frag" "$launcher" || { log "verdict fragment drifted: $frag"; exit 1; }
  done
  cat >"$CORPUS_DIR/b-suite-count.txt" <<'EOF'
[redis-db-launch] SUITE-COUNT GATE FAILED — 2 BASELINED FILE(S) WERE NOT RUN (issue #4141). The suite no longer includes a file the baseline says it should. This is NOT the #4137 truncation artifact — no reporter output was consulted to reach it:
  - test/example-one.test.mts
  - test/example-two.test.mts
[redis-db-launch] SUITE-COUNT GATE FAILED — 1 FILE(S) RAN BUT ARE NOT BASELINED (issue #4141). Every count-based verdict silently exempts them, so they sit outside the gate entirely:
  - test/example-three.test.mts
[redis-db-launch] If this change to the file set is intended, regenerate the baseline IN THIS PR: node scripts/test/suite-count-check.mjs --update-baseline
[redis-db-launch] SUITE-COUNT GATE FAILED — FILE NEVER RAN (issue #4141) — 1 baselined file(s) were part of this run but produced ZERO top-level entries. This is NOT the #4137 reporter truncation:
  test/example-six.test.mts: expected 2, observed 0
[redis-db-launch] SUITE-COUNT GATE FAILED (issue #4020) — 2 file(s) reported FEWER top-level suites/tests than expected. This is the silent --test-force-exit drop, not a project-code regression:
  test/example-four.test.mts: expected 12, observed 9
  test/example-seven.test.mts: expected 30, observed 21
[redis-db-launch] SUITE-COUNT GATE INCONCLUSIVE (issue #4137) — 1 file(s) could not be measured: every isolated retry failed to COMPLETE. This is NOT evidence that the file dropped tests, and regenerating the baseline will not fix it:
  test/example-five.test.mts: retry timed out (baseline expects 8)
EOF

  # (c) read-only REST (not GraphQL) issue + PR JSON lists.
  log "capturing (c) gh api issue / PR JSON"
  gh api 'repos/gaberoo322/hydra/issues?state=all&per_page=40' >"$CORPUS_DIR/c1-issues.json"
  gh api 'repos/gaberoo322/hydra/pulls?state=all&per_page=30' >"$CORPUS_DIR/c2-pulls.json"

  # (d) journal excerpt.
  log "capturing (d) journalctl excerpt"
  journalctl --user -u hydra-orchestrator.service -n 300 --no-pager >"$CORPUS_DIR/d-journal.txt" 2>&1 || true

  ( cd "$CORPUS_DIR" && wc -c ./* | sed 's/^/  /' >&2 )
}

# The compressor runs in-process via the uv tool's interpreter, credential-free.
stage_compress() {
  [ -x "$HEADROOM_PY" ] || { log "run 'install' first"; exit 1; }
  [ -d "$CORPUS_DIR" ] || { log "run 'capture' first"; exit 1; }
  env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL \
      -u GH_TOKEN -u GITHUB_TOKEN \
    HEADROOM_BEACON=off DO_NOT_TRACK=1 HEADROOM_UPDATE_CHECK=off \
    HF_HUB_DISABLE_TELEMETRY=1 HF_HOME="$SPIKE_DIR/hf" \
    "$HEADROOM_PY" - "$CORPUS_DIR" "$RESULTS_JSON" <<'PYEOF'
import hashlib, importlib.metadata, json, re, sys
from pathlib import Path

import headroom
from headroom import compress

# Kompress (the HuggingFace text model) loads lazily in the BACKGROUND on a cold
# cache and passes text through untouched until ready — which would make every
# text payload "preserved" for the trivial reason that nothing was compressed.
# Preload it synchronously so the text path is actually exercised.
KOMPRESS_STATUS = "ready"
try:
    from headroom.transforms.kompress_compressor import KompressCompressor
    print("kompress backend:", KompressCompressor().preload(), file=sys.stderr)
except Exception as exc:  # noqa: BLE001 - recorded in the results, never silent
    KOMPRESS_STATUS = f"NOT ready: {type(exc).__name__}: {exc}"
    print("kompress preload failed:", KOMPRESS_STATUS, file=sys.stderr)

corpus = Path(sys.argv[1])
results_path = Path(sys.argv[2])
out_dir = results_path.parent
MODEL = "claude-sonnet-4-5-20250929"

TAP_NAME = "planted-failing-test-4769 detects the planted regression"
VERDICTS = [
    "SUITE-COUNT GATE FAILED — 2 BASELINED FILE(S) WERE NOT RUN",
    "SUITE-COUNT GATE FAILED — 1 FILE(S) RAN BUT ARE NOT BASELINED",
    "SUITE-COUNT GATE FAILED — FILE NEVER RAN",
    "SUITE-COUNT GATE FAILED (issue #4020)",
    "SUITE-COUNT GATE INCONCLUSIVE (issue #4137)",
]
VERDICT_FILES = [
    "test/example-four.test.mts: expected 12, observed 9",
    "test/example-six.test.mts: expected 2, observed 0",
]

journal = (corpus / "d-journal.txt").read_text(errors="replace")
journal_err_lines = [l for l in journal.splitlines() if re.search(r"error|fail|warn", l, re.I)]

# (name, file, must-survive strings, counts toward the GO criterion?)
PAYLOADS = [
    ("a-red-tap", "a-red-tap.txt",
     [l.strip() for l in (corpus / "a-red-tap.txt").read_text().splitlines()
      if TAP_NAME in l], True),
    ("b-suite-count", "b-suite-count.txt", VERDICTS + VERDICT_FILES, True),
    ("c1-issues-json", "c1-issues.json", [], False),
    ("c2-pulls-json", "c2-pulls.json", [], False),
    ("d-journal", "d-journal.txt", journal_err_lines[:25], False),
]


def flatten(content):
    if isinstance(content, str):
        return content
    parts = []
    for block in content or []:
        if isinstance(block, str):
            parts.append(block)
        elif isinstance(block, dict):
            if block.get("type") == "tool_result":
                parts.append(flatten(block.get("content")))
            elif "text" in block:
                parts.append(block["text"])
            elif "content" in block:
                parts.append(flatten(block["content"]))
    return "\n".join(parts)


def pad(msgs):
    """Later turns so the payload is NOT in the protected-recent window — the shape
    of real agent traffic (the tool output is consumed, then work continues)."""
    for i in range(5):
        msgs.append({"role": "assistant", "content": f"Noted, continuing analysis step {i}."})
        msgs.append({"role": "user", "content": f"Proceed with step {i}."})
    return msgs


def conv_anthropic(payload):
    # Claude Code's wire shape: tool results ride in a USER-role message.
    return pad([
        {"role": "user", "content": "Investigate the failing run and report which test failed."},
        {"role": "assistant", "content": [
            {"type": "tool_use", "id": "toolu_01spike", "name": "Bash", "input": {"command": "capture"}}]},
        {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "toolu_01spike", "content": payload}]},
    ])


def conv_openai(payload):
    # OpenAI-style: a dedicated role=tool message.
    return pad([
        {"role": "user", "content": "Investigate the failing run and report which test failed."},
        {"role": "assistant", "content": None, "tool_calls": [
            {"id": "call_spike", "type": "function", "function": {"name": "Bash", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "call_spike", "content": payload},
    ])


# name -> (conversation builder, compress kwargs). The FIRST variant is the primary
# one the 15% bar is judged on (a tool result wrapped as Claude Code sends it, with
# the user-message guard lifted — see the write-up for why the default skips it).
VARIANTS = {
    "anthropic_tool_result__compress_user_messages": (conv_anthropic, {"compress_user_messages": True}),
    "anthropic_tool_result__default_config": (conv_anthropic, {}),
    "openai_role_tool__default_config": (conv_openai, {}),
}


def run(builder, kw, payload):
    r = compress(builder(payload), model=MODEL, **kw)
    text = "\n".join(flatten(m.get("content")) for m in r.messages)
    return r, text


rows = []
agg = {v: {"before": 0, "saved": 0, "must": 0, "kept": 0} for v in VARIANTS}
for name, fname, must, gating in PAYLOADS:
    raw = (corpus / fname).read_text(errors="replace")
    row = {"payload": name, "bytes": len(raw.encode()),
           "sha256": hashlib.sha256(raw.encode()).hexdigest(),
           "must_survive": len(must), "gating": gating, "variants": {}}
    for vname, (builder, kw) in VARIANTS.items():
        base, _ = run(builder, kw, "ok")
        r, text = run(builder, kw, raw)
        before = r.tokens_before - base.tokens_before
        saved = r.tokens_saved - base.tokens_saved
        kept = [s for s in must if s in text]
        row["variants"][vname] = {
            "tokens_before": before, "tokens_after": before - saved,
            "ratio_saved": round(saved / before, 4) if before else 0.0,
            "survived_verbatim": len(kept),
            "lost": [s for s in must if s not in text],
            "ccr_marker_in_output": bool(re.search(r"headroom_retrieve|ccr|hash=", text, re.I)),
            "transforms": sorted(set(r.transforms_applied)),
        }
        agg[vname]["before"] += before
        agg[vname]["saved"] += saved
        if gating:
            agg[vname]["must"] += len(must)
            agg[vname]["kept"] += len(kept)
        (out_dir / f"compressed-{name}.{vname}.txt").write_text(text)
    rows.append(row)

primary = next(iter(VARIANTS))
preserved_everywhere = all(a["must"] == a["kept"] for a in agg.values())
ratios = {v: (a["saved"] / a["before"] if a["before"] else 0.0) for v, a in agg.items()}
go = preserved_everywhere and ratios[primary] >= 0.15
summary = {
    "headroom_version": importlib.metadata.version("headroom-ai"),
    "token_count_method": "headroom CompressResult.tokens_before/tokens_after minus an 'ok' baseline conversation (no Anthropic count_tokens; no API key)",
    "caveat": "single-conversation offline test: all content is live-zone, CacheAligner is not exercised",
    "kompress_text_model": KOMPRESS_STATUS,
    "primary_variant": primary,
    "rows": rows,
    "aggregate_ratio_saved": {v: round(x, 4) for v, x in ratios.items()},
    "gating_strings": {v: [a["kept"], a["must"]] for v, a in agg.items()},
    "go_criteria": {"all_gating_strings_verbatim_in_every_variant": preserved_everywhere,
                    "primary_aggregate_ratio_ge_15pct": ratios[primary] >= 0.15},
    "verdict": "GO" if go else "NO-GO",
}
results_path.write_text(json.dumps(summary, indent=2, ensure_ascii=False))

for vname in VARIANTS:
    print(f"\n### {vname}\n")
    print("| payload | bytes | tokens before | tokens after | saved | must-survive kept |")
    print("|---|---|---|---|---|---|")
    for r in rows:
        v = r["variants"][vname]
        kept = f'{v["survived_verbatim"]}/{r["must_survive"]}' if r["must_survive"] else "n/a"
        print(f'| {r["payload"]} | {r["bytes"]} | {v["tokens_before"]} | {v["tokens_after"]} | '
              f'{v["ratio_saved"]:.1%} | {kept} |')
    a = agg[vname]
    print(f'\naggregate saved {ratios[vname]:.1%}; gating strings kept {a["kept"]}/{a["must"]}')
    for r in rows:
        lost = r["variants"][vname]["lost"]
        if lost and r["gating"]:
            print(f'LOST in {r["payload"]}: {lost[:5]}')
print(f'\nVERDICT: {summary["verdict"]}  {summary["go_criteria"]}')
PYEOF
}

main() {
  local stage="${1:-all}"
  case "$stage" in
    clean) rm -rf "$SPIKE_DIR" "$WORK_DIR"; log "removed $SPIKE_DIR and $WORK_DIR"; exit 0 ;;
    install|capture|compress|all) ;;
    *) echo "usage: $0 [all|install|capture|compress|clean]" >&2; exit 2 ;;
  esac

  local before after
  before="$(sha256sum "$CLAUDE_JSON" | awk '{print $1}')"
  log "~/.claude.json sha256 BEFORE: $before"

  case "$stage" in
    install) stage_install ;;
    capture) stage_capture ;;
    compress) stage_compress ;;
    all) stage_install; stage_capture; stage_compress ;;
  esac

  after="$(sha256sum "$CLAUDE_JSON" | awk '{print $1}')"
  log "~/.claude.json sha256 AFTER:  $after"
  if [ "$before" != "$after" ]; then
    log "FAIL: ~/.claude.json changed during the spike"
    exit 1
  fi
  log "~/.claude.json byte-identical before/after"
}

main "$@"
