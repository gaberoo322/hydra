#!/usr/bin/env python3
"""
Plan parity over a fixed corpus of real decide() inputs (ADR-0043 slice 6,
issue #4934; legacy conversion retired by #5442).

Each entry of decide-inputs.jsonl.gz is `(state, candidates, events, now)`
with `state` ALREADY in the JSON Turn Snapshot form: no `state.signals`, no
blob fields, and a v1 `state.turn_snapshot` carrying them in the structured
shapes src/schemas/turn-snapshot.ts defines. decide() plans over it, and the
serialised Plan must be byte-identical to the GOLDEN Plan recorded for that
entry in decide-plans.jsonl.gz. Because the state has no `signals` key and no
blob fields, a decide.py read that bypassed scripts/autopilot/turn_snapshot.py
would see nothing and the Plans would diverge.

The corpus is a FIXED historical regression set: it was captured once
(2026-10-07), converted once from the retired legacy form, and is never
re-captured. Signals added to the schema after the capture stay ABSENT from
the entries (not backfilled); turn_snapshot.py reads an absent key as its
ordinary absent value outside replay mode, and this harness does not set
replay mode.

The golden Plans were recorded from the 6a expand PR's JSON path, then
re-recorded for intentional decide.py changes (#5058 GLM signals folded into
the resume pick, #5318 red-CI cap tracker retired, #5078 `qa-verdict` without
`verdict_at_head` is stale).

  python3 plan_parity.py [--dump <path>] [corpus.jsonl.gz]
      compare against the golden Plans; `--dump` writes each entry's
      `turn_snapshot` as JSONL so the test can zod-check every value
  python3 plan_parity.py --write-golden [--autopilot-dir <dir>]
      record the golden Plans, planning with the decide.py / turn_snapshot.py
      in <dir> (default: this checkout's scripts/autopilot) - e.g. a
      worktree of the reference commit
  python3 plan_parity.py --all-degraded <doc.json> [...]
      also plan every entry twice more - over the TS all-degraded document in
      <doc.json> (what `turn-snapshot.ts --all-degraded` prints) and over the
      accessor's MARKER document (no signals: node could not run, #5083) - and
      count the entries whose two Plans are byte-identical (`marker_identical`)

Prints one JSON summary line; exit 0 iff every entry is identical.
"""

import copy
import gzip
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
GOLDEN_PLANS = os.path.join(HERE, "decide-plans.jsonl.gz")

_argv = sys.argv[1:]
AUTOPILOT_DIR = os.path.join(REPO, "scripts", "autopilot")
if "--autopilot-dir" in _argv:
    _i = _argv.index("--autopilot-dir")
    AUTOPILOT_DIR = os.path.abspath(_argv[_i + 1])
    del _argv[_i : _i + 2]
sys.path.insert(0, AUTOPILOT_DIR)

for var in ("HYDRA_AUTOPILOT_SUBAGENT_MAX_WALL_SECONDS", "HYDRA_AUTOPILOT_EMIT_TURN_EVENTS"):
    os.environ.pop(var, None)
os.environ["HYDRA_AUTOPILOT_RUN_END_POST"] = "off"

import decide  # noqa: E402
import turn_snapshot as ts  # noqa: E402


def run(entry: dict, state: dict) -> str:
    try:
        events = copy.deepcopy(entry["events"])
        plan = decide.decide(state, copy.deepcopy(entry["candidates"]), events, now=entry["now"])
        return plan.to_json()
    except Exception as exc:  # a crash must crash identically in both forms
        return f"RAISED {type(exc).__name__}: {exc}"


def main() -> int:
    args = list(_argv)
    write_golden = "--write-golden" in args
    if write_golden:
        args.remove("--write-golden")
    dump = None
    if "--dump" in args:
        i = args.index("--dump")
        dump = args[i + 1]
        del args[i : i + 2]
    all_degraded = None
    if "--all-degraded" in args:
        i = args.index("--all-degraded")
        with open(args[i + 1], encoding="utf-8") as fh:
            all_degraded = json.load(fh)
        del args[i : i + 2]
    path = args[0] if args else os.path.join(HERE, "decide-inputs.jsonl.gz")
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        entries = [json.loads(line) for line in fh if line.strip()]
    golden: list[str] = []
    if not write_golden:
        with gzip.open(GOLDEN_PLANS, "rt", encoding="utf-8") as fh:
            golden = [json.loads(line)["plan"] for line in fh if line.strip()]
    dumped = open(dump, "w", encoding="utf-8") if dump else None
    identical = 0
    with_signals = 0
    diverged: list[dict] = []
    plans: list[str] = []
    marker_checked = 0
    marker_identical = 0
    marker_diverged: list[int] = []
    for i, entry in enumerate(entries):
        state = entry["state"]
        snapshot = state.get("turn_snapshot") if isinstance(state, dict) else None
        if isinstance(snapshot, dict) and snapshot.get("signals"):
            with_signals += 1
        json_state = state
        if dumped is not None and isinstance(snapshot, dict):
            dumped.write(json.dumps(snapshot) + "\n")
        plan = run(entry, json_state)
        plans.append(plan)
        if all_degraded is not None and isinstance(json_state, dict):
            bare = {k: v for k, v in json_state.items() if k != "turn_snapshot"}
            marker_checked += 1
            ts_plan = run(entry, ts.apply(copy.deepcopy(all_degraded), copy.deepcopy(bare)))
            if ts_plan == run(entry, ts.apply(None, copy.deepcopy(bare), "node could not run")):
                marker_identical += 1
            else:
                marker_diverged.append(i)
        if not write_golden:
            if i < len(golden) and golden[i] == plan:
                identical += 1
            else:
                diverged.append({"index": i, "golden": (golden[i] if i < len(golden) else "<missing>")[:400], "plan": plan[:400]})
    if dumped is not None:
        dumped.close()
    if write_golden:
        body = "".join(json.dumps({"plan": plan}) + "\n" for plan in plans).encode("utf-8")
        with open(GOLDEN_PLANS, "wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", compresslevel=9, mtime=0) as fh:
            fh.write(body)  # mtime=0: a re-record of the same Plans is byte-identical
        identical = len(plans)
    distinct = len(set(plans))
    print(
        json.dumps(
            {
                "entries": len(entries),
                "golden": len(golden) if not write_golden else len(plans),
                "with_signals": with_signals,
                "identical": identical,
                "distinct_plans": distinct,
                "diverged": diverged[:5],
                "diverged_count": len(diverged),
                "autopilot_dir": os.path.relpath(AUTOPILOT_DIR, REPO) if AUTOPILOT_DIR.startswith(REPO + os.sep) else AUTOPILOT_DIR,
                "marker_checked": marker_checked,
                "marker_identical": marker_identical,
                "marker_diverged": marker_diverged[:10],
            }
        )
    )
    return 0 if identical == len(entries) else 1


if __name__ == "__main__":
    sys.exit(main())
