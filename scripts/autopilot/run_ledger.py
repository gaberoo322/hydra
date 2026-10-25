#!/usr/bin/env python3
"""
run_ledger.py -- the Run Ledger: the Autopilot Run's per-run cache of
Redis-backed continuous state (ADR-0012 D2), i.e. the state.json document.

Slice 1 of epic #5071 (issue #5072). This module owns:

  * FIELDS -- the declared field table: every top-level key of the state
    document with its JSON type, default, and carry policy
    (reset-per-run / carry-across-relaunch / mirrored-to-Redis);
  * resolve_state_path(env) -- the single home of the state-path resolution;
  * load(path) -- fail-loud on a declared key of the wrong JSON type
    (LedgerTypeError), warn-and-preserve on an undeclared key;
  * persist(ledger, path) -- the ONE atomic write (mkstemp in the same
    directory -> json.dump(indent=2) + newline -> os.replace);
  * seed_initial(identity, limits, carry, now) -- the initial document
    bootstrap.sh used to write with a heredoc.

Other scripts under scripts/autopilot keep their own reads/writes of the
document until slices 3-4 migrate them. This module is a leaf: stdlib only,
no network, and it must NOT import decide / decide_base.

CLI (bash callers never touch the file directly):

  run_ledger.py path [--default]
  run_ledger.py schema-version
  run_ledger.py seed <path> key=<json-literal>...
  run_ledger.py get <path> <dotted.key>
"""
import datetime
import json
import os
import sys
import tempfile

SCHEMA_VERSION = 2  # the one home of the integer (ADR-0007 handshake)
DEFAULT_STATE_PATH = "/tmp/hydra-autopilot-state.json"
CRASH_ENV = "HYDRA_RUN_LEDGER_TEST_CRASH"  # test-only seam: "before-replace"

RESET = "reset-per-run"
CARRY = "carry-across-relaunch"
MIRRORED = "mirrored-to-Redis"
REQUIRED = object()

# JSON type names. "number" accepts int or float (but never bool).
_TYPES = {
    "str": lambda v: isinstance(v, str),
    "int": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "bool": lambda v: isinstance(v, bool),
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
    # #4213 legacy container: slot_events is a bare array OR {events,last_id}.
    "array|object": lambda v: isinstance(v, (list, dict)),
}


class LedgerTypeError(Exception):
    """A declared key holds the wrong JSON type. `code` is machine-readable."""

    code = "ledger-type-mismatch"


def _row(name, typ, default, carry, seeded=True, decide_owned=False):
    return {
        "name": name,
        "type": typ,
        "default": default,
        "carry": carry,
        "seeded": seeded,
        "decide_owned": decide_owned,
    }


# Declared limits.* sub-table. REQUIRED = bootstrap resolves + validates the
# value (env defaults stay in bootstrap.sh); only schema_version is owned here.
LIMITS = [
    _row("token_budget", "int", REQUIRED, RESET),
    _row("wall_clock_max_sec", "int", REQUIRED, RESET),
    _row("idle_drain_turns", "int", REQUIRED, RESET),
    _row("context_compaction_turns", "int", REQUIRED, RESET),
    _row("quota_5h_max_pts", "number", REQUIRED, RESET),
    _row("quota_week_max_pts", "number", REQUIRED, RESET),
    _row("scope", "str", REQUIRED, RESET),
    _row("subagent_max_tokens", "int", REQUIRED, RESET),
    _row("subagent_hard_max_tokens", "int", REQUIRED, RESET),
    _row("unattended", "bool", REQUIRED, RESET),
    _row("schema_version", "int", SCHEMA_VERSION, RESET),
    _row("daily_spend_cap_usd", "number", REQUIRED, RESET),
    _row("scout_cost_share", "number", REQUIRED, RESET),
    _row("orch_realm_weekly_share_cap", "number", None, RESET, seeded=False),
]

# Declared top-level table, in the heredoc's key order. `seeded=False` rows are
# written by other scripts after seed; seed does NOT write them (a default
# run's document stays byte-identical to pre-change, the #3867 contract).
FIELDS = [
    _row("started", "str", REQUIRED, RESET),
    _row("started_epoch", "int", REQUIRED, RESET),
    _row("pid", "int", REQUIRED, RESET),
    _row("run_id", "str", REQUIRED, RESET),
    _row("slot_events_last_id", "str", REQUIRED, RESET),
    _row("limits", "object", REQUIRED, RESET),
    _row("cumulative_tokens", "int", 0, RESET),
    _row("dispatches", "int", 0, RESET),
    _row("turn", "int", 0, RESET),
    _row("burned_classes", "array", [], RESET),
    _row("reaped_task_ids", "array", [], RESET),
    _row("failure_log", "array", [], RESET),
    _row("research_force_counter", "object", REQUIRED, MIRRORED, decide_owned=True),
    _row("dev_resume_pending", "array", REQUIRED, CARRY, decide_owned=True),
    _row("zero_yield_backoff", "object", REQUIRED, CARRY, decide_owned=True),
    _row("slots", "object", REQUIRED, CARRY),
    _row("signal_last_fired", "object", REQUIRED, MIRRORED, decide_owned=True),
    # Written by other autopilot scripts after seed (not seeded here).
    _row("idle_turns", "int", 0, RESET, seeded=False),
    _row("turn_snapshot", "object", {}, RESET, seeded=False),
    _row("slot_events", "array|object", [], RESET, seeded=False),
    _row("slot_history", "array", [], RESET, seeded=False),
    _row("quota_baseline", "object", {}, RESET, seeded=False, decide_owned=True),
    _row("warnings", "array", [], RESET, seeded=False),
    _row("scout_spend_usd_today", "number", 0, RESET, seeded=False),
    _row("dev_target_resume_inflight", "object", {}, RESET, seeded=False, decide_owned=True),
    _row("target_triage_item_stamps", "object", {}, RESET, seeded=False, decide_owned=True),
    _row("orch_triage_item_stamps", "object", {}, RESET, seeded=False, decide_owned=True),
    _row("target_stale_item_stamps", "object", {}, RESET, seeded=False, decide_owned=True),
    _row("target_blocked_item_stamps", "object", {}, RESET, seeded=False, decide_owned=True),
    _row("qa_orch_item_attempts", "object", {}, RESET, seeded=False, decide_owned=True),
    _row("red_forward_fix_attempts", "object", {}, RESET, seeded=False, decide_owned=True),
    _row("dev_target_spend_usd_cycle", "number", 0, RESET, seeded=False),
    # turn_snapshot BLOB_FIELDS
    _row("usage_eligibility", "object", {}, RESET, seeded=False),
    _row("emergency_brake", "object", {}, RESET, seeded=False),
    _row("target_risk_surface", "object", {}, RESET, seeded=False),
    _row("class_stats", "object", {}, RESET, seeded=False),
    _row("candidate_exclusions", "array", [], RESET, seeded=False),
]

_FIELD_BY_NAME = {f["name"]: f for f in FIELDS}

# Keys decide() may mutate in-memory that main() must persist post-decide
# (the former nine hand-listed snapshot/compare pairs, #5074). slot_events /
# slot_history / failure_log are deliberately absent (#4213 INV-8); `turn` is
# written by the pre-decide bump.
DECIDE_OWNED_KEYS = frozenset(f["name"] for f in FIELDS if f["decide_owned"])

_IDENTITY_KEYS = ("pid", "run_id")
_LIMIT_SEED_KEYS = tuple(f["name"] for f in LIMITS if f["default"] is REQUIRED)
_CARRY_KEYS = (
    "research_force_counter",
    "dev_resume_pending",
    "zero_yield_backoff",
    "slots",
    "signal_last_fired",
)


def _json_type_name(v):
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "bool"
    if isinstance(v, int):
        return "int"
    if isinstance(v, float):
        return "float"
    if isinstance(v, str):
        return "str"
    if isinstance(v, list):
        return "array"
    return "object"


def _check(key, value, typ):
    if not _TYPES[typ](value):
        raise LedgerTypeError(
            "[run-ledger] type mismatch for %s: expected %s, got %s"
            % (key, typ, _json_type_name(value))
        )


def _validate(doc):
    for f in FIELDS:
        if f["name"] in doc:
            _check(f["name"], doc[f["name"]], f["type"])
    limits = doc.get("limits")
    if isinstance(limits, dict):
        for f in LIMITS:
            if f["name"] in limits:
                _check("limits." + f["name"], limits[f["name"]], f["type"])


def resolve_state_path(env=None):
    env = os.environ if env is None else env
    return env.get("HYDRA_AUTOPILOT_STATE") or DEFAULT_STATE_PATH


def load(path, fill_defaults=True):
    """Read the document. Raises LedgerTypeError on a declared-key type
    mismatch; an undeclared top-level key is preserved and warned once.
    fill_defaults=False leaves absent keys absent (the decide read path: a
    key a tracker never wrote must never appear in state.json, #5074)."""
    with open(path, encoding="utf-8") as fh:
        doc = json.load(fh)
    if not isinstance(doc, dict):
        raise LedgerTypeError(
            "[run-ledger] type mismatch for <document>: expected object, got %s"
            % _json_type_name(doc)
        )
    _validate(doc)
    for key in doc:
        if key not in _FIELD_BY_NAME:
            sys.stderr.write("[run-ledger] WARN undeclared key %s preserved\n" % key)
    if fill_defaults:
        for f in FIELDS:
            if f["name"] not in doc and f["default"] is not REQUIRED:
                doc[f["name"]] = json.loads(json.dumps(f["default"]))
    return doc


_ABSENT = "\x00absent"  # sentinel string: an ABSENT key differs from {} / null


def snapshot(ledger):
    """Serialised view of the decide-owned keys. An absent key is encoded
    distinctly from {} / null so a selector that first CREATES a key is a diff."""
    return {
        k: (json.dumps(ledger[k], sort_keys=True) if k in ledger else _ABSENT)
        for k in sorted(DECIDE_OWNED_KEYS)
    }


def diff(baseline, ledger):
    """Sorted list of decide-owned keys whose value changed since `baseline`
    (a snapshot() taken before decide())."""
    after = snapshot(ledger)
    return [k for k in sorted(DECIDE_OWNED_KEYS) if baseline.get(k) != after[k]]


def _ordered(ledger):
    out = {}
    for f in FIELDS:
        if f["name"] in ledger:
            value = ledger[f["name"]]
            if f["name"] == "limits" and isinstance(value, dict):
                lim = {}
                for lf in LIMITS:
                    if lf["name"] in value:
                        lim[lf["name"]] = value[lf["name"]]
                for k, v in value.items():
                    if k not in lim:
                        lim[k] = v
                value = lim
            out[f["name"]] = value
    for k, v in ledger.items():
        if k not in out:
            out[k] = v
    return out


def persist(ledger, path):
    """The ONE state.json writer: temp file in the same directory, then
    os.replace. A crash before the rename leaves the prior file untouched."""
    _validate(ledger)
    directory = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(prefix=".run-ledger-", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(_ordered(ledger), fh, indent=2, ensure_ascii=False)
            fh.write("\n")
        if os.environ.get(CRASH_ENV) == "before-replace":
            # Test seam: simulate a crash between write and rename. The temp
            # file is deliberately left behind (that is the crash state).
            raise RuntimeError("[run-ledger] simulated crash before replace")
        os.replace(tmp, path)
    except RuntimeError:
        raise
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:  # intentional: best-effort temp cleanup; original error re-raised
            pass
        raise


def seed_initial(identity, limits, carry, now):
    """The initial document the bootstrap heredoc used to write."""
    started = datetime.datetime.fromtimestamp(now, datetime.timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )
    lim = {}
    for f in LIMITS:
        if f["name"] == "schema_version":
            lim["schema_version"] = SCHEMA_VERSION
        elif f["name"] in limits:
            lim[f["name"]] = limits[f["name"]]
    missing = [f["name"] for f in LIMITS if f["default"] is REQUIRED and f["name"] not in lim]
    if missing:
        raise LedgerTypeError("[run-ledger] seed missing limits: %s" % ", ".join(missing))
    doc = {
        "started": started,
        "started_epoch": now,
        "pid": identity["pid"],
        "run_id": identity["run_id"],
        "slot_events_last_id": "%d000-0" % now,
        "limits": lim,
        "cumulative_tokens": 0,
        "dispatches": 0,
        "turn": 0,
        "burned_classes": [],
        "reaped_task_ids": [],
        "failure_log": [],
    }
    for key in _CARRY_KEYS:
        doc[key] = carry[key]
    _validate(doc)
    return doc


def _parse_pairs(args, allowed):
    out = {}
    for a in args:
        if "=" not in a:
            raise ValueError("expected key=<json>, got %r" % a)
        k, v = a.split("=", 1)
        if k not in allowed:
            raise ValueError("unknown seed key %s" % k)
        try:
            out[k] = json.loads(v)
        except ValueError as e:
            raise ValueError("seed key %s is not a JSON literal: %s" % (k, e))
    missing = [k for k in allowed if k not in out]
    if missing:
        raise ValueError("missing seed keys: %s" % ", ".join(missing))
    return out


def _main(argv):
    if not argv:
        sys.stderr.write(__doc__)
        return 2
    cmd, rest = argv[0], argv[1:]
    if cmd == "path":
        print(DEFAULT_STATE_PATH if rest == ["--default"] else resolve_state_path())
        return 0
    if cmd == "schema-version":
        print(SCHEMA_VERSION)
        return 0
    if cmd == "seed":
        if not rest:
            sys.stderr.write("usage: run_ledger.py seed <path> key=<json>...\n")
            return 2
        path = rest[0]
        allowed = ("now",) + _IDENTITY_KEYS + _LIMIT_SEED_KEYS + _CARRY_KEYS
        try:
            vals = _parse_pairs(rest[1:], allowed)
        except ValueError as e:
            sys.stderr.write("[run-ledger] %s\n" % e)
            return 2
        now = vals["now"]
        if not _TYPES["int"](now):
            sys.stderr.write("[run-ledger] seed key now must be an int\n")
            return 2
        try:
            doc = seed_initial(
                {k: vals[k] for k in _IDENTITY_KEYS},
                {k: vals[k] for k in _LIMIT_SEED_KEYS},
                {k: vals[k] for k in _CARRY_KEYS},
                now,
            )
            persist(doc, path)
        except LedgerTypeError as e:
            sys.stderr.write("%s\n" % e)
            return 1
        except (OSError, RuntimeError) as e:
            sys.stderr.write("[run-ledger] seed failed: %s\n" % e)
            return 1
        return 0
    if cmd == "get":
        if len(rest) != 2:
            sys.stderr.write("usage: run_ledger.py get <path> <dotted.key>\n")
            return 2
        try:
            cur = load(rest[0])
        except (OSError, ValueError, LedgerTypeError) as e:
            sys.stderr.write("[run-ledger] get failed: %s\n" % e)
            return 1
        for part in rest[1].split("."):
            if not isinstance(cur, dict) or part not in cur:
                return 1
            cur = cur[part]
        print(cur if isinstance(cur, str) else json.dumps(cur, ensure_ascii=False))
        return 0
    sys.stderr.write("[run-ledger] unknown subcommand %s\n" % cmd)
    return 2


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
