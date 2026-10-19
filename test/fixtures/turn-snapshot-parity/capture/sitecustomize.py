"""
Test-only capture hook for the Turn Snapshot plan-parity corpus (ADR-0043
slice 6, issue #4934). NOT imported by anything in production.

Python imports `sitecustomize` at start-up when it is on sys.path, so running
the decide.py test files with

  HYDRA_DECIDE_CAPTURE_DIR=<dir> PYTHONPATH=test/fixtures/turn-snapshot-parity/capture \
    npm run test:file -- <every test file that runs decide.py>

records every distinct `decide(state, candidates, events, now)` call those
tests make — the arguments as they were AT CALL TIME (decide() mutates
state) — one JSON file per call, named by content hash. A profile hook (not
an edit to decide.py) does the capture, so the brain under test is the
committed file. `node test/fixtures/turn-snapshot-parity/pack-corpus.mjs
<dir>` then packs them into decide-inputs.jsonl.gz.
"""

import hashlib
import json
import os
import sys
import time

_DIR = os.environ.get("HYDRA_DECIDE_CAPTURE_DIR")


def _profile(frame, event, arg):
    if event != "call" or frame.f_code.co_name != "decide":
        return
    if not frame.f_code.co_filename.replace("\\", "/").endswith("scripts/autopilot/decide.py"):
        return
    loc = frame.f_locals
    events = loc.get("events")
    if not (events is None or isinstance(events, (list, tuple, dict))):
        return
    try:
        blob = json.dumps(
            {
                "state": loc.get("state"),
                "candidates": loc.get("candidates"),
                "events": list(events) if isinstance(events, tuple) else events,
                "now": loc.get("now") if loc.get("now") is not None else int(time.time()),
            },
            sort_keys=True,
        )
    except (TypeError, ValueError) as exc:
        print(f"[decide-capture] skipped an unserialisable call: {exc}", file=sys.stderr)
        return
    name = hashlib.sha1(blob.encode()).hexdigest() + ".json"
    with open(os.path.join(_DIR, name), "w", encoding="utf-8") as fh:
        fh.write(blob)


if _DIR:
    sys.setprofile(_profile)
