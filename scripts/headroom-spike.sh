#!/usr/bin/env bash
set -euo pipefail

# headroom-spike.sh — OFFLINE measurement of Headroom (headroomlabs-ai/headroom)
# context compression on real Hydra payloads (tool-scout spike, issue #4769).
#
# WHAT THIS IS: a one-shot, reproducible, credential-free measurement. It answers
# two questions about the compressors, in-process, with NO proxy:
#   1. How many tokens does Headroom save on Hydra-shaped tool output?
#   2. Do the exact strings agents verify against (failing `not ok` / `# Subtest:`
#      names, SUITE-COUNT GATE verdicts) survive VERBATIM in the compressed text?
#
# WHAT THIS IS NOT (operator-approved envelope, see the issue): no proxy is
# started, no `headroom wrap`, no MCP server, no systemd unit, no ANTHROPIC_BASE_URL
# change, no model credentials. Headroom is called as a Python library
# (`headroom.compress(messages, model=...)`) — it exposes no offline CLI subcommand.
#
# TOOLCHAIN LANE (ADR-0005): nothing goes into package.json and nothing is
# installed host-wide. A pinned uv release binary is downloaded and SHA256-verified
# (the scripts/osv-scan.sh pattern), and uv's tool/python/cache dirs plus a
# throwaway HOME are all confined to ONE directory, removable with a single rm -rf:
#   ~/.cache/hydra-headroom-spike/
#
# SAFETY INVARIANTS (design-concept issue-4769):
#   - The compressor runs under `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN
#     -u ANTHROPIC_BASE_URL -u GH_TOKEN -u GITHUB_TOKEN` with HEADROOM_BEACON=off,
#     DO_NOT_TRACK=1, HEADROOM_UPDATE_CHECK=off, HF_HUB_DISABLE_TELEMETRY=1. The
#     Kompress model weights come from HuggingFace, which needs no credential.
#     The GitHub corpus is captured in a SEPARATE earlier step (it needs gh auth).
#   - ~/.claude.json is sha256'd at start and end; a mismatch exits 3 and both
#     hashes are printed. As belt and braces the install/compress stages run with
#     HOME pointed at the spike dir, so they cannot even resolve the real file.
#     NOTE: a *running* Claude Code session rewrites ~/.claude.json on its own
#     (session metadata), so a mismatch on a busy host is not by itself proof that
#     Headroom touched it — the HOME confinement plus the spike-home check below
#     is what attributes it. Both signals are printed.
#   - The raw corpus is NEVER committed: journal logs / API JSON can carry secrets.
#     It lives under /tmp/hydra-headroom-spike/corpus/. Only a manifest (source
#     command, bytes, sha256) is printed for the write-up.
#
# Usage:  scripts/headroom-spike.sh            # full run, prints report + verdict
#         HEADROOM_SPIKE_JOURNAL_LINES=600 scripts/headroom-spike.sh
# Cleanup: rm -rf ~/.cache/hydra-headroom-spike /tmp/hydra-headroom-spike

# ---- pins (bump together) ---------------------------------------------------
UV_VERSION="0.12.23"
UV_SHA256="9167d72b3319674b6303c4cbe071854bba13ebdf3d76b1a7cbdc175471fb66d6"
UV_ASSET="uv-x86_64-unknown-linux-gnu.tar.gz"
HEADROOM_VERSION="0.40.0"
# The [ml] extra (PyTorch + transformers) is what loads the Kompress TEXT model.
# Without it only the JSON/code compressors run and logs/TAP pass through
# untouched, which would make a "preserved" verdict vacuous. [proxy] is the
# issue-mandated extra; the proxy itself is never started.
HEADROOM_EXTRAS="${HEADROOM_SPIKE_EXTRAS:-proxy,ml}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPIKE_DIR="${HEADROOM_SPIKE_DIR:-$HOME/.cache/hydra-headroom-spike}"
WORK="${HEADROOM_SPIKE_WORK:-/tmp/hydra-headroom-spike}"
CORPUS="$WORK/corpus"
OUT="$WORK/out"
JOURNAL_LINES="${HEADROOM_SPIKE_JOURNAL_LINES:-400}"
REAL_CLAUDE_JSON="$HOME/.claude.json"

sha_of() { if [ -f "$1" ]; then sha256sum "$1" | awk '{print $1}'; else echo "absent"; fi; }

CJ_BEFORE="$(sha_of "$REAL_CLAUDE_JSON")"
echo "[headroom-spike] ~/.claude.json sha256 (start): $CJ_BEFORE" >&2

mkdir -p "$SPIKE_DIR/bin" "$SPIKE_DIR/home" "$CORPUS" "$OUT"

# ---- stage 1: bootstrap pinned uv (SHA256-verified, spike-local) ------------
UV_BIN="$SPIKE_DIR/bin/uv"
if [ ! -x "$UV_BIN" ] || [ "$("$UV_BIN" --version 2>/dev/null | awk '{print $2}')" != "$UV_VERSION" ]; then
  TMP_TGZ="$(mktemp "$SPIKE_DIR/uv.XXXXXX.tgz")"
  echo "[headroom-spike] downloading uv $UV_VERSION" >&2
  curl -sSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${UV_ASSET}" -o "$TMP_TGZ"
  ACTUAL="$(sha256sum "$TMP_TGZ" | awk '{print $1}')"
  if [ "$ACTUAL" != "$UV_SHA256" ]; then
    echo "[headroom-spike] SHA256 mismatch for uv: expected $UV_SHA256 got $ACTUAL" >&2
    rm -f "$TMP_TGZ"
    exit 1
  fi
  UNPACK="$(mktemp -d "$SPIKE_DIR/uv-unpack.XXXXXX")"
  tar -xzf "$TMP_TGZ" -C "$UNPACK"
  cp "$UNPACK"/*/uv "$UV_BIN"
  chmod +x "$UV_BIN"
  rm -rf "$UNPACK" "$TMP_TGZ"
fi

# ---- stage 2: pinned headroom install (spike-local, beacon off) -------------
export UV_TOOL_DIR="$SPIKE_DIR/tools"
export UV_TOOL_BIN_DIR="$SPIKE_DIR/bin"
export UV_PYTHON_INSTALL_DIR="$SPIKE_DIR/python"
export UV_CACHE_DIR="$SPIKE_DIR/cache"
PY="$UV_TOOL_DIR/headroom-ai/bin/python"
NEED_IMPORT="import headroom"
case ",$HEADROOM_EXTRAS," in *,ml,*) NEED_IMPORT="import torch" ;; esac
if [ ! -x "$PY" ] || ! "$PY" -c "import importlib.metadata as m,sys; sys.exit(0 if m.version('headroom-ai')=='$HEADROOM_VERSION' else 1)" 2>/dev/null \
   || ! "$PY" -c "$NEED_IMPORT" 2>/dev/null; then
  echo "[headroom-spike] installing headroom-ai[${HEADROOM_EXTRAS}]==$HEADROOM_VERSION (proxy never started)" >&2
  env HOME="$SPIKE_DIR/home" HEADROOM_BEACON=off DO_NOT_TRACK=1 \
    "$UV_BIN" tool install --force --python 3.13 "headroom-ai[${HEADROOM_EXTRAS}]==${HEADROOM_VERSION}" >&2
fi

# ---- stage 3: capture the corpus (needs gh auth; runs BEFORE the compressor) -
rm -rf "$CORPUS" && mkdir -p "$CORPUS" "$WORK/planted"
: > "$OUT/manifest.tsv"
record() { # name, source-command
  local f="$CORPUS/$1"
  printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$(wc -c < "$f")" "$(sha256sum "$f" | awk '{print $1}')" >> "$OUT/manifest.tsv"
}

# (a) red node:test TAP — deterministic, from a throwaway planted-failing file
#     under /tmp (never under test/, so the suite-count FILE-SET baseline is untouched).
PLANTED="$WORK/planted/planted-spike.test.mjs"
{
  echo "import { describe, it } from 'node:test';"
  echo "import assert from 'node:assert/strict';"
  echo "describe('planted spike suite', () => {"
  for i in $(seq 1 40); do
    echo "  it('passing case $i keeps the invariant', () => { assert.equal(1 + $i, $i + 1); });"
  done
  echo "  it('planted failing case: counts merged PRs per class', () => { assert.deepEqual({ merged: 3, class: 'dev_orch' }, { merged: 4, class: 'dev_orch' }); });"
  for i in $(seq 41 60); do
    echo "  it('passing case $i keeps the invariant', () => { assert.equal(1 + $i, $i + 1); });"
  done
  echo "});"
} > "$PLANTED"
node --test --test-force-exit --test-reporter=tap "$PLANTED" > "$CORPUS/tap-red.txt" 2>&1 || true
record tap-red.txt "node --test --test-force-exit --test-reporter=tap <planted-failing test under /tmp>"

# (b) SUITE-COUNT GATE verdict block — headline strings taken literally from the
#     emitter (scripts/test/redis-db-launch.mjs; the FILE-SET/COUNT arms live there).
EMITTER="$REPO_ROOT/scripts/test/redis-db-launch.mjs"
VERDICTS=(
  "SUITE-COUNT GATE FAILED — "
  "BASELINED FILE(S) WERE NOT RUN (issue #4141)"
  "FILE(S) RAN BUT ARE NOT BASELINED (issue #4141)"
  "SUITE-COUNT GATE FAILED (issue #4020) — "
  "SUITE-COUNT GATE INCONCLUSIVE (issue #4137) — "
  "FILE NEVER RAN (issue #4141)"
)
for v in "${VERDICTS[@]}"; do
  grep -qF -- "$v" "$EMITTER" || { echo "[headroom-spike] verdict string not found in emitter: $v" >&2; exit 1; }
done
{
  echo "[redis-db-launch] SUITE-COUNT GATE FAILED — 2 BASELINED FILE(S) WERE NOT RUN (issue #4141). The suite no longer includes a file the baseline says it should. This is NOT the #4137 truncation artifact — no reporter output was consulted to reach it:"
  echo "  - test/backlog.test.mts"
  echo "  - test/api-maintenance-timing.test.mts"
  echo "[redis-db-launch] SUITE-COUNT GATE FAILED — 1 FILE(S) RAN BUT ARE NOT BASELINED (issue #4141). Every count-based verdict silently exempts them, so they sit outside the gate entirely:"
  echo "  - test/new-thing.test.mts"
  echo "[redis-db-launch] If this change to the file set is intended, regenerate the baseline IN THIS PR: node scripts/test/suite-count-check.mjs --update-baseline"
  echo "[redis-db-launch] SUITE-COUNT GATE FAILED (issue #4020) — 3 file(s) reported FEWER top-level suites/tests than expected. This is the silent --test-force-exit drop, not a project-code regression:"
  echo "  test/metrics.test.mts: expected 14, observed 11"
  echo "  test/scheduler.test.mts: expected 9, observed 6"
  echo "  test/design-concept-reconcile-check.test.mts: expected 2, observed 0"
  echo "[redis-db-launch] SUITE-COUNT GATE INCONCLUSIVE (issue #4137) — 1 file(s) could not be measured: every isolated retry failed to COMPLETE. This is NOT evidence that the file dropped tests, and regenerating the baseline will not fix it:"
  echo "  test/heartbeat.test.mts: retry timed out (baseline expects 7)"
  echo "[redis-db-launch] SUITE-COUNT GATE FAILED — FILE NEVER RAN (issue #4141) — a baselined, in-run file reported ZERO entries:"
  echo "  test/design-concept-reconcile-check.test.mts"
} > "$CORPUS/suite-count-verdict.txt"
record suite-count-verdict.txt "literal verdict strings from scripts/test/redis-db-launch.mjs (+ synthetic file names/counts)"

# (c) read-only REST (not `gh --json` GraphQL) issue + PR JSON lists
gh api "repos/gaberoo322/hydra/issues?state=open&per_page=40" > "$CORPUS/gh-issues.json"
record gh-issues.json "gh api repos/gaberoo322/hydra/issues?state=open&per_page=40"
gh api "repos/gaberoo322/hydra/pulls?state=all&per_page=40" > "$CORPUS/gh-pulls.json"
record gh-pulls.json "gh api repos/gaberoo322/hydra/pulls?state=all&per_page=40"

# (d) journalctl excerpt
journalctl --user -u hydra-orchestrator.service -n "$JOURNAL_LINES" --no-pager > "$CORPUS/journal.txt" 2>&1 || true
record journal.txt "journalctl --user -u hydra-orchestrator.service -n $JOURNAL_LINES --no-pager"

printf '%s\n' "${VERDICTS[@]}" > "$OUT/verdict-needles.txt"
cp "$OUT/manifest.tsv" "$OUT/manifest.snapshot.tsv"

# ---- stage 4: compress, credential-free, HOME confined ----------------------
echo "[headroom-spike] compressing corpus (credentials scrubbed, beacon off)" >&2
set +e
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL -u GH_TOKEN -u GITHUB_TOKEN \
  HOME="$SPIKE_DIR/home" HEADROOM_BEACON=off DO_NOT_TRACK=1 HEADROOM_UPDATE_CHECK=off HF_HUB_DISABLE_TELEMETRY=1 \
  "$PY" - "$CORPUS" "$OUT" <<'PYEOF'
import json, os, re, sys

corpus, out = sys.argv[1], sys.argv[2]
from headroom import compress

MODEL = "claude-sonnet-4-5"
verdicts = [l.rstrip("\n") for l in open(os.path.join(out, "verdict-needles.txt"), encoding="utf-8")]
read = lambda n: open(os.path.join(corpus, n), encoding="utf-8", errors="replace").read()

payloads = []  # (name, text, gated_needles, informational_needles)
tap = read("tap-red.txt")
tap_needles = []
for line in tap.splitlines():
    m = re.match(r"\s*not ok \d+ - (.+)$", line)
    if m:
        tap_needles.append(line.strip())
        tap_needles.append(m.group(1).strip())
for line in tap.splitlines():
    if line.strip().startswith("# Subtest: planted failing case"):
        tap_needles.append(line.strip())
payloads.append(("tap-red.txt", tap, sorted(set(tap_needles)), []))
payloads.append(("suite-count-verdict.txt", read("suite-count-verdict.txt"), verdicts, []))

def gh_info(name):
    data = json.loads(read(name))
    # Informational: the first and last item's number + title must be readable.
    needles = []
    for item in (data[0], data[-1]) if data else ():
        needles.append(str(item["number"]))
        needles.append(item["title"])
    return needles
payloads.append(("gh-issues.json", read("gh-issues.json"), [], gh_info("gh-issues.json")))
payloads.append(("gh-pulls.json", read("gh-pulls.json"), [], gh_info("gh-pulls.json")))
jl = [l for l in read("journal.txt").splitlines() if re.search(r"error|fail|warn", l, re.I)]
payloads.append(("journal.txt", read("journal.txt"), [], jl[:5]))

FILLER = [
    {"role": "assistant", "content": "Noted. Continuing with the next step."},
    {"role": "user", "content": "ok go on"},
    {"role": "assistant", "content": "Reading the next file."},
    {"role": "user", "content": "thanks, proceed"},
    {"role": "assistant", "content": "Applying the change."},
    {"role": "user", "content": "looks good, what is next?"},
]

def build(text):
    return [
        {"role": "user", "content": "Run the checks and tell me what failed."},
        {"role": "assistant", "content": [{"type": "tool_use", "id": "toolu_spike", "name": "Bash", "input": {"command": "spike"}}]},
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_spike", "content": text}]},
    ] + FILLER

def result_text(msgs):
    for m in msgs:
        if isinstance(m.get("content"), list):
            for b in m["content"]:
                if b.get("type") == "tool_result":
                    c = b.get("content")
                    if isinstance(c, str):
                        return c
                    return "".join(x.get("text", "") for x in c if isinstance(x, dict))
    return ""

# Warm-up: Kompress fetches its model in the BACKGROUND on a cold cache and passes
# requests through until it is loaded, so measuring immediately would report "no
# compression" for a reason unrelated to Headroom's quality. Poll with throwaway
# nonce text (defeats the result cache) until the loader logs success, bounded at
# ~3 minutes, so the measured run reflects the text compressor actually being live.
import logging, time

class _Cap(logging.Handler):
    def __init__(self):
        super().__init__()
        self.seen = []
    def emit(self, rec):
        self.seen.append(rec.getMessage())

_cap = _Cap()
_klog = logging.getLogger("headroom.transforms.kompress_compressor")
_klog.addHandler(_cap)
_klog.setLevel(logging.INFO)
kompress_live = False
for attempt in range(18):
    nonce = "warmup-%d-%d" % (os.getpid(), attempt)
    words = " ".join("%s token%d value%d status ok worker idle" % (nonce, j, j * 7) for j in range(900))
    compress(build(words), model=MODEL)
    if any("Kompress ONNX loaded" in m or "backend=" in m for m in _cap.seen):
        kompress_live = True
        break
    time.sleep(10)
print("kompress_live=%s" % kompress_live, file=sys.stderr)

MODES = [("default", {}), ("protect_recent=0", {"protect_recent": 0})]
report = {"headroom_version": None, "kompress_live": kompress_live, "modes": {}}
try:
    import importlib.metadata as md
    report["headroom_version"] = md.version("headroom-ai")
except Exception as e:  # noqa
    print("version lookup failed: %r" % (e,), file=sys.stderr)

for mode, kw in MODES:
    rows = []
    for name, text, gated, info in payloads:
        r = compress(build(text), model=MODEL, **kw)
        ctext = result_text(r.messages)
        if name == "tap-red.txt":
            open(os.path.join(out, "tap-red.compressed.%s.txt" % mode.replace("=", "")), "w", encoding="utf-8").write(ctext)
        ccr = bool(re.search(r"headroom_retrieve|ccr|retrieve", ctext, re.I)) and ctext != text
        def survive(needles):
            return [(n, n in ctext) for n in needles]
        g, i = survive(gated), survive(info)
        rows.append({
            "payload": name,
            "bytes": len(text.encode()),
            "tokens_before": r.tokens_before,
            "tokens_after": r.tokens_after,
            "tokens_saved": r.tokens_saved,
            "ratio": round(1 - (r.tokens_after / r.tokens_before), 4) if r.tokens_before else 0.0,
            "reported_compression_ratio": r.compression_ratio,
            "changed": ctext != text,
            "ccr_marker": ccr,
            "transforms": r.transforms_applied,
            "gated_total": len(g), "gated_preserved": sum(1 for _, ok in g if ok),
            "gated_missing": [n for n, ok in g if not ok],
            "info_total": len(i), "info_preserved": sum(1 for _, ok in i if ok),
        })
    tb = sum(r["tokens_before"] for r in rows)
    ta = sum(r["tokens_after"] for r in rows)
    gt = sum(r["gated_total"] for r in rows)
    gp = sum(r["gated_preserved"] for r in rows)
    report["modes"][mode] = {
        "rows": rows,
        "aggregate_reduction": round(1 - ta / tb, 4) if tb else 0.0,
        "tokens_before": tb, "tokens_after": ta,
        "gated_preserved": gp, "gated_total": gt,
    }

json.dump(report, open(os.path.join(out, "report.json"), "w"), indent=2)

print("\n=== Headroom %s offline spike (token counts: Headroom's own tokens_before/after) ===" % report["headroom_version"])
for mode, m in report["modes"].items():
    print("\n-- mode: %s --" % mode)
    print("%-26s %8s %8s %8s %7s  %s" % ("payload", "bytes", "tok_in", "tok_out", "ratio", "gated needles kept / info kept"))
    for r in m["rows"]:
        print("%-26s %8d %8d %8d %6.1f%%  %d/%d  info %d/%d%s" % (
            r["payload"], r["bytes"], r["tokens_before"], r["tokens_after"], r["ratio"] * 100,
            r["gated_preserved"], r["gated_total"], r["info_preserved"], r["info_total"],
            "  CCR-marker" if r["ccr_marker"] else ""))
        for miss in r["gated_missing"]:
            print("    MISSING verbatim: %r" % miss)
    print("aggregate token reduction: %.1f%%   gated strings preserved: %d/%d" % (
        m["aggregate_reduction"] * 100, m["gated_preserved"], m["gated_total"]))

d = report["modes"]["default"]
go = d["gated_preserved"] == d["gated_total"] and d["aggregate_reduction"] >= 0.15
verdict = "GO" if go else "NO-GO"
if not kompress_live:
    verdict = "INCONCLUSIVE (Kompress text model never loaded; TAP/log text was not compressed)"
print("\nKompress text model live during measurement: %s" % kompress_live)
print("VERDICT (default config): %s  [rule: 100%% gated strings verbatim AND aggregate reduction >= 15%%]" % verdict)
PYEOF
RC=$?
set -e

# ---- stage 5: manifest + ~/.claude.json integrity ---------------------------
echo
echo "=== corpus manifest (name | source | bytes | sha256) ==="
cat "$OUT/manifest.snapshot.tsv"

CJ_AFTER="$(sha_of "$REAL_CLAUDE_JSON")"
SPIKE_HOME_CJ="absent"
[ -e "$SPIKE_DIR/home/.claude.json" ] && SPIKE_HOME_CJ="PRESENT"
echo
echo "~/.claude.json sha256 before: $CJ_BEFORE"
echo "~/.claude.json sha256 after:  $CJ_AFTER"
echo "spike-home .claude.json:      $SPIKE_HOME_CJ (must be absent: nothing wrote a Claude config)"
if [ "$RC" -ne 0 ]; then
  echo "[headroom-spike] compression stage failed (exit $RC)" >&2
  exit "$RC"
fi
if [ "$CJ_BEFORE" != "$CJ_AFTER" ] || [ "$SPIKE_HOME_CJ" != "absent" ]; then
  echo "[headroom-spike] ~/.claude.json CHANGED during the spike (see NOTE in the header: a live Claude Code session also rewrites it)" >&2
  exit 3
fi
echo "[headroom-spike] ~/.claude.json byte-identical before/after"
