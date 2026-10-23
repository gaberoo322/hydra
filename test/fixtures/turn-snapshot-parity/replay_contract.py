#!/usr/bin/env python3
"""
The Python half of the Turn Snapshot replay contract (issue #5085, over the
fail-loud accessor of #5083; test/turn-snapshot-json.test.mts drives it). It is
the ONLY guard between the signals decide.py reads and the signals the zod
schema (src/schemas/turn-snapshot.ts) emits: no test reads decide.py's source.

  python3 replay_contract.py <corpus.jsonl> [--drop <document>:<signal>]... [--autopilot-dir <dir>]

Each corpus line is `{"name": str, "snapshot": str, "entry": int | null,
"overlay"?: {...}}` — a Turn Snapshot document AS THE TS EMITTER PRINTED IT,
plus the decide() input to plan it under: `entry` indexes the plan-parity
corpus (decide-inputs.jsonl.gz: that entry's state as plan_parity.py converts
it, its candidates, events and clock, with the document replacing the
converted snapshot); null is the decide-golden idle-triage-sweep fixture
accessor_check.py also plans over. `overlay` sets top-level state keys on that
input (carried state a branch needs to run at all, e.g. a zero-yield streak).

HYDRA_AUTOPILOT_SNAPSHOT_REPLAY must be set — the harness exits 2 without it,
because a production-mode read of a signal the document lacks returns None and
would pass vacuously. For every document, `turn_snapshot.apply` stores it on
the state exactly as turn.sh does, `signal` events are dropped (an event would
answer the read before the document is consulted), and decide() plans twice:

  1. through a RECORDING accessor: turn_snapshot._state_signal — the one point
     every signal reader resolves a name through — is wrapped to note each
     name, so a read of a signal the document lacks raises UnknownSignalError
     and every name read is reported;
  2. with the document's `signals` map hidden from everything but that
     accessor, and its `observability` section (the values no rule reads)
     removed: the Plan must be byte-identical, so decide() reads no signal
     around scripts/autopilot/turn_snapshot.py and gates on no
     observability value.

`--drop <document>:<signal>` adds a MUTANT: a copy of that document without
that signal, named `<document>-without-<signal>` (the negative case — the
unmutated corpus is replayed as well). `--autopilot-dir` plans with another
checkout's decide.py / turn_snapshot.py (read by plan_parity.py on import).

stdout: `{"documents", "raised": [{name, error}], "crashed": [{name, error}],
"reach_around": [name], "first_reader": {signal: name}}` — `first_reader`
names, for every signal decide() read, the first document whose replay read
it. Exit 0 whenever the corpus was replayed (the caller judges the result).
"""

import copy
import gzip
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, HERE)

import plan_parity  # noqa: E402 — imports decide + turn_snapshot (honouring --autopilot-dir)

decide = plan_parity.decide
ts = plan_parity.ts
BASE_DIR = os.path.join(REPO, "test", "fixtures", "decide-golden", "idle-triage-sweep")

_first_reader: dict[str, str] = {}
_current = [""]
_state_signal = ts._state_signal
_signals = ts._signals


def _recording_state_signal(state, name):
    _first_reader.setdefault(name, _current[0])
    return _state_signal(state, name)


ts._state_signal = _recording_state_signal


def _base_input() -> tuple[dict, object, list, object]:
    with open(os.path.join(BASE_DIR, "state.json"), encoding="utf-8") as fh:
        state = json.load(fh)
    with open(os.path.join(BASE_DIR, "candidates.json"), encoding="utf-8") as fh:
        candidates = json.load(fh)
    with open(os.path.join(BASE_DIR, "meta.json"), encoding="utf-8") as fh:
        now = json.load(fh)["now"]
    for f in (*ts.BLOB_FIELDS, "turn_snapshot", "slot_events", "slot_events_last_id"):
        state.pop(f, None)
    return state, candidates, [], now


def _entry_input(entry: dict) -> tuple[dict, object, object, object]:
    state = plan_parity.to_json_form(entry["state"])
    state.pop("turn_snapshot", None)
    events = entry["events"]
    if isinstance(events, list):
        events = [e for e in events if not (isinstance(e, dict) and e.get("type") == "signal")]
    return state, entry["candidates"], events, entry["now"]


def _plan(doc: dict, decide_input: tuple) -> str:
    state, candidates, events, now = decide_input
    applied = ts.apply(copy.deepcopy(doc), copy.deepcopy(state))
    return decide.decide(applied, copy.deepcopy(candidates), copy.deepcopy(events), now=now).to_json()


def main() -> int:
    args = sys.argv[1:]
    if "--autopilot-dir" in args:
        i = args.index("--autopilot-dir")
        del args[i : i + 2]
    drops: list[tuple[str, str]] = []
    while "--drop" in args:
        i = args.index("--drop")
        document, _, signal = args[i + 1].partition(":")
        drops.append((document, signal))
        del args[i : i + 2]
    if len(args) != 1 or any(not d or not s for d, s in drops):
        print("usage: replay_contract.py <corpus.jsonl> [--drop <document>:<signal>]... [--autopilot-dir <dir>]", file=sys.stderr)
        return 2
    if not os.environ.get(ts.REPLAY_ENV):
        print(f"replay_contract.py: {ts.REPLAY_ENV} is not set — a production-mode replay would pass vacuously", file=sys.stderr)
        return 2

    with open(args[0], encoding="utf-8") as fh:
        corpus = [json.loads(line) for line in fh if line.strip()]
    for document, signal in drops:
        source = next((c for c in corpus if c["name"] == document), None)
        if source is None:
            print(f"replay_contract.py: --drop names no corpus document {document!r}", file=sys.stderr)
            return 2
        mutant = json.loads(source["snapshot"])
        mutant["signals"].pop(signal, None)
        corpus.append({**source, "name": f"{document}-without-{signal}", "snapshot": json.dumps(mutant)})

    entries: list[dict] = []
    if any(c.get("entry") is not None for c in corpus):
        with gzip.open(os.path.join(HERE, "decide-inputs.jsonl.gz"), "rt", encoding="utf-8") as fh:
            entries = [json.loads(line) for line in fh if line.strip()]

    raised: list[dict] = []
    crashed: list[dict] = []
    reach_around: list[str] = []
    for case in corpus:
        name = case["name"]
        doc = json.loads(case["snapshot"])
        decide_input = _base_input() if case.get("entry") is None else _entry_input(entries[case["entry"]])
        decide_input[0].update(case.get("overlay") or {})
        _current[0] = name
        try:
            plan = _plan(doc, decide_input)
        except ts.UnknownSignalError as exc:
            raised.append({"name": name, "error": f"UnknownSignalError: {exc}"})
            continue
        except Exception as exc:  # noqa: BLE001 — any other crash hides the reads after it; report it
            crashed.append({"name": name, "error": f"{type(exc).__name__}: {exc}"})
            continue
        hidden = copy.deepcopy(doc)
        signals = hidden.pop("signals")
        hidden.pop("observability", None)
        ts._signals = lambda _state: signals
        try:
            hidden_plan = _plan(hidden, decide_input)
        except Exception as exc:  # noqa: BLE001 — a crash with the map hidden is a read around the accessor
            hidden_plan = f"RAISED {type(exc).__name__}: {exc}"
        finally:
            ts._signals = _signals
        if hidden_plan != plan:
            reach_around.append(name)

    print(
        json.dumps(
            {
                "documents": len(corpus),
                "raised": raised,
                "crashed": crashed,
                "reach_around": reach_around,
                "first_reader": dict(sorted(_first_reader.items())),
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
