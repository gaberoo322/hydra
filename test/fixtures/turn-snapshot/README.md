# Turn Snapshot golden fixtures (ADR-0043 Decision 4)

Every `*.json` in this tree is a GOLDEN: behaviour recorded from the retired
bash collectors (`scripts/autopilot/collect-state.sh`, deleted by #4950) or
from the HTTP data plane at a fixed clock, replayed exactly by the
`test/turn-snapshot-*.test.mts` suites. A golden's `expected` block changes
only through the replay suite's opt-in re-record mode, in a PR that
intentionally changes a collector's behaviour and says so — the regenerated
diff is the review artefact. Hand-editing an `expected` block, or rewriting
scenario inputs, deletes the guard.

## Families

| Files | Slice | Replayed by |
|---|---|---|
| root `*.json` (93, minus `orch-board-*`) | 1 (#4929) | `test/turn-snapshot-pr-gate.test.mts` |
| root `orch-board-*.json` (42) | 2 (#4930) | `test/turn-snapshot-orch-board.test.mts` |
| `picks/` | 3 (#4931) | `test/turn-snapshot-picks.test.mts` |
| `target-board/` | 4 (#4932) | `test/turn-snapshot-target-board.test.mts` |
| `passthrough/` | 5A (#4933) | `test/turn-snapshot-passthrough.test.mts` |
| `remaining/` | 5B (#4933) | `test/turn-snapshot-remaining.test.mts` |

`remaining/` is the only family with a committed capture harness
(`remaining/capture/` — recipe in `remaining/README.md`). Every other
family's capture story lives in its replay test's docblock (which old bash
functions ran, what was faked, what each file records); this README carries
the root corpus's recipe, which the slice-1 harness (a scratch script, never
committed) followed.

## The root (slice-1) corpus — capture recipe

Provenance is recorded per file: `source` names the pre-slice test suite the
scenario came from, `capturedFrom` names the bash and its base SHA
(`289ee94263de07be748ad23f9d071185a8014a1c`). The 93 files were captured ONCE
by running the OLD `collect_orch_inflight_prs` + `collect_pr_gate_reachability`
over every fixture the pre-slice tests in
`test/collect-state-inflight-exclusion.test.mts` drove, plus deliberate
failure fixtures (gh error, unparseable payloads, missing timestamps, bad env
windows, `pr-refs.py` unavailable). The harness worked like
`remaining/capture/capture.mjs`:

1. a fake `gh` on PATH, keyed by the six read shapes the replay test's
   `goldenKey` routes on (the wide PR-list read / the `number,mergeStateStatus`
   re-poll / `event=push` run / `event=pull_request` run / required-contexts /
   needs-dev-resume), serving each scenario's raw `--json` payload or a
   scripted non-zero exit, and recording the argv of every call;
2. a fake `sleep` on PATH recording its argument (the #4812 re-poll delay);
3. a fixed clock, recorded per file as `nowMs`, so the quiescence/grace
   windows are deterministic;
4. `prRefsUnavailable: true` scenarios modelled the bash's
   `pr-refs.py import FAILED` fail-closed arm (#4460 INV-5, #4807 INV-4).

Each file records the scenario INPUTS (`nowMs`, `env`, `gh`, `prRefsUnavailable`)
and the captured OUTPUTS (`expected.stderrNotes`, `expected.ghCalls` — exact
argv, in order — and `expected.sleeps`).

`expected.values` has a different lineage: it was captured at #4934 time by
replaying every scenario through the TS CLI's `--format values` WHILE the
retired kv wire still rendered the bash byte for byte — kv byte-equality was
the proof the typed values matched the captured bash output. The dead kv
fields (`expected.stdout`, `expected.exports`) were stripped afterwards
(#4951–#4953).

### Refreshing `expected` blocks (the sanctioned path)

An intentional collector behaviour change refreshes the root corpus through
the replay suite's opt-in re-record mode — never by hand:

```bash
UPDATE_TURN_SNAPSHOT_PR_GATE_GOLDEN=1 npm run test:file -- test/turn-snapshot-pr-gate.test.mts
```

With the flag set, the suite rewrites ONLY each golden's `expected` block
from the TS replay and leaves the scenario inputs (`name`, `nowMs`, `env`,
`prRefsUnavailable`, `gh`) untouched — the same convention as
UPDATE_DECIDE_GOLDEN (test/decide-golden.test.mts) and
UPDATE_TURN_SNAPSHOT_JSON_GOLDEN (test/turn-snapshot-json.test.mts). With the
flag unset the suite never writes under this directory. A no-op run of the
mode is byte-stable (it round-trips every file unchanged), so the diff in
your PR is exactly the behaviour delta a reviewer should scrutinise.

### Re-capturing a scenario (break glass)

The bash collectors exist on no branch; recovery is
`git show 289ee9426:scripts/autopilot/collect-state.sh`. But a rebuilt bash
harness cannot produce `expected.values`: the typed values' authority is the
#4934 kv-byte-equality replay, and the kv renderer retired with the bash. A
NEW scenario is therefore hand-authored — scenario inputs (`nowMs`, `env`,
`gh`, `prRefsUnavailable`) by hand after the historical recipe above,
`expected` filled in by one run of the re-record mode.
