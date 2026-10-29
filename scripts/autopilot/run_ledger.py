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

Slice 2 of epic #5071 (issue #5073) adds the carry-forward half:

  * carry_forward(prev_doc, classes, now, mirror=None) -- the ONE function that
    reads a prior run's document for the next run. Carry POLICY is data on the
    FIELDS rows (`carry`, `normalize`, `mirror`); the carried signal_last_fired
    set is DERIVED from classes.json (cooldownSeconds vs the Pace Gate relaunch
    interval), never a hand-maintained list;
  * read_prior(path) / RedisMirror -- the two continuity adapters (ADR-0012 D2):
    the prior run's file, then the Redis hash/string mirror (host reboot);
  * mirror_to_redis(doc, redis_cli) -- the single Redis mirror WRITER.

CLI (bash callers never touch the file directly):

  run_ledger.py path [--default]
  run_ledger.py schema-version
  run_ledger.py carry-classes
  run_ledger.py seed <path> [--carry-from <prev_path>] [--mirror]
                     key=<json-literal>... [slots_overlay=<json>]
  run_ledger.py get <path> <dotted.key> [--prior] [--default <v>]
  run_ledger.py project <path> [--prior] <key>...
  run_ledger.py slot-fields

`get --default <v>` prints <v> (exit 0) when the key is absent or null, the
`jq -r '.key // <v>'` shape bash callers used to open-code.
`get`/`project` read the LIVE run's document strictly (a declared-key type
mismatch exits 1); `--prior` reads a possibly-dead run's document leniently
(read_prior: never raises, a missing/corrupt file degrades to "key absent").
`project` prints ONE JSON object of the requested dotted keys (absent -> null).
"""
import datetime
import json
import os
import re
import subprocess
import sys
import tempfile

SCHEMA_VERSION = 2  # the one home of the integer (ADR-0007 handshake)
DEFAULT_STATE_PATH = "/tmp/hydra-autopilot-state.json"
CRASH_ENV = "HYDRA_RUN_LEDGER_TEST_CRASH"  # test-only seam: "before-replace" | "before-replace-2nd"
_persist_calls = 0  # per-process persist counter (drives the "2nd" crash seam)

RESET = "reset-per-run"
CARRY = "carry-across-relaunch"
MIRRORED = "mirrored-to-Redis"
SEEDED = "seeded-from-orchestrator"  # source is GET /api/autopilot/inflight-slots (#1352)
REQUIRED = object()

# The Pace Gate relaunch interval (hydra-pace-gate.timer OnUnitActiveSec=15min).
# A signal class whose cooldown exceeds it must survive a relaunch, so it is
# carried; shorter cooldowns are re-armed each run. ONE home; a test pins it
# equal to the systemd timer's OnUnitActiveSec.
PACE_GATE_RELAUNCH_SEC = 900
DEV_RESUME_PENDING_CAP = 20  # the ONE home (#5075); queue_dev_resume enforces it, reap_stall.py calls that
REDIS_SIGNAL_LAST_FIRED_KEY = "hydra:autopilot:signal-last-fired"
REDIS_RESEARCH_FORCE_KEY = "hydra:autopilot:research-force-counter"
DEFAULT_REDIS_ARGV = ["docker", "exec", "hydra-redis-1", "redis-cli"]
CLASSES_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "classes.json")

# JSON type names. "number" accepts int or float (but never bool).
_TYPES = {
    "str": lambda v: isinstance(v, str),
    "int": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "bool": lambda v: isinstance(v, bool),
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
    # #4213 legacy container: slot_events is a bare array OR {events,last_id}.
    # Collector-injected blobs decide() deliberately tolerates malformed
    # (fail-safe/fail-open per signal), so the ledger must not reject them.
    "any": lambda v: True,
    "array|object": lambda v: isinstance(v, (list, dict)),
}


class LedgerTypeError(Exception):
    """A declared key holds the wrong JSON type. `code` is machine-readable."""

    code = "ledger-type-mismatch"


class SimulatedCrash(RuntimeError):
    """The HYDRA_RUN_LEDGER_TEST_CRASH seam's dedicated exception (#5075): the
    ONLY failure persist() re-raises WITHOUT unlinking its temp file, so any other
    RuntimeError subclass (e.g. RecursionError on an unserialisable blob) still
    reaches the cleanup arm."""


def _row(name, typ, default, carry, seeded=True, decide_owned=False, **policy):
    """One field-table row. `policy` holds the carry data of a carried row:
    `normalize(value, ctx)`, an optional `mirror` descriptor, and the exception
    tuples the row's normalizer reads."""
    row = {"name": name, "type": typ, "default": default, "carry": carry, "seeded": seeded,
           "decide_owned": decide_owned}
    row.update(policy)
    return row


def _is_number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _utc_day(now):
    return datetime.datetime.fromtimestamp(now, datetime.timezone.utc).strftime("%Y-%m-%d")


# --- per-key SHAPE rules (pure; referenced from the FIELDS rows) -------------
# Each is normalize(value, ctx) -> carried value. `value` is the prior run's
# raw value (None when absent); a shape problem degrades to the key's default.


def _norm_research_force_counter(value, ctx):
    """#1666: keep only TODAY's UTC key (decide.py's prune-on-write semantics)."""
    today = _utc_day(ctx["now"])
    if isinstance(value, dict) and isinstance(value.get(today), dict):
        return {today: value[today]}
    return {}


def queue_dev_resume(pending, record):
    """The ONE dev_resume_pending queue policy (#5075): append `record`, deduped
    by its `anchor` keeping the LATEST record at the FIFO tail, then FIFO-capped
    at DEV_RESUME_PENDING_CAP. Returns a new list; `pending` is not mutated.
    A record without a non-empty string `anchor` is dropped."""
    kept = [e for e in (pending if isinstance(pending, list) else []) if isinstance(e, dict)]
    a = record.get("anchor") if isinstance(record, dict) else None
    if isinstance(a, str) and a != "":
        kept = [k for k in kept if k.get("anchor") != a] + [record]
    return kept[-DEV_RESUME_PENDING_CAP:]


def _norm_dev_resume_pending(value, ctx):
    """#4518: objects with a non-empty string `anchor`, deduped by anchor keeping
    the LATEST record in its FIFO position, FIFO-capped at DEV_RESUME_PENDING_CAP."""
    if not isinstance(value, list):
        return []
    kept = []
    for e in value:
        kept = queue_dev_resume(kept, e)
    return kept


def _integral(v):
    return _is_number(v) and float(v).is_integer()


def _norm_zero_yield_backoff(value, ctx):
    """#4999: keep entries that are objects with integral `streak` + `last_fired`
    (bool rejected, integral floats floored to int); drop the rest."""
    if not isinstance(value, dict):
        return {}
    out = {}
    for k, v in value.items():
        if isinstance(v, dict) and _integral(v.get("streak")) and _integral(v.get("last_fired")):
            out[k] = {"streak": int(v["streak"]), "last_fired": int(v["last_fired"])}
    return out


def _norm_signal_last_fired(value, ctx):
    """#2575/#4909: every derived key present; a carried class keeps its prior
    numeric stamp else 0, every other key re-arms to 0."""
    prior = value if isinstance(value, dict) else {}
    out = {}
    for k in ctx["all_signal_keys"]:
        v = prior.get(k) if k in ctx["carry_classes"] else None
        out[k] = v if _is_number(v) else 0
    return out


# --- Redis tier of the seed order (prior-file -> Redis -> default) -----------


def _seed_research_force_from_mirror(value, mirror, ctx):
    """#2715: when the pruned prior is {}, try the Redis string mirror."""
    if value:
        return value
    raw = mirror.get(REDIS_RESEARCH_FORCE_KEY)
    if not raw:
        return value
    try:
        return _norm_research_force_counter(json.loads(raw), ctx)
    except ValueError as exc:
        sys.stderr.write("[run-ledger] WARN redis research_force_counter unparseable: %s\n" % exc)
        return value


def _seed_signal_from_mirror(value, mirror, ctx):
    """#2715: per carried class whose prior-file value is 0, HGET the Redis hash."""
    for cls in ctx["carry_classes"]:
        if value.get(cls) != 0:
            continue
        raw = mirror.hget(REDIS_SIGNAL_LAST_FIRED_KEY, cls)
        raw = raw.replace('"', "") if raw else raw
        if raw and re.fullmatch(r"[0-9]+", raw) and int(raw) > 0:
            value[cls] = int(raw)
    return value


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
    _row(
        "research_force_counter", "object", REQUIRED, MIRRORED, decide_owned=True,
        normalize=_norm_research_force_counter,
        mirror={"key": REDIS_RESEARCH_FORCE_KEY, "kind": "string",
                "seed": _seed_research_force_from_mirror},
    ),
    _row("dev_resume_pending", "array", REQUIRED, CARRY, decide_owned=True, normalize=_norm_dev_resume_pending),
    _row("zero_yield_backoff", "object", REQUIRED, CARRY, decide_owned=True, normalize=_norm_zero_yield_backoff),
    # Source is the orchestrator's durable in-flight ledger (#1352), not the
    # prior file: carry_forward never reads prior `slots`.
    _row("slots", "object", REQUIRED, SEEDED),
    _row(
        "signal_last_fired", "object", REQUIRED, MIRRORED, decide_owned=True,
        normalize=_norm_signal_last_fired,
        mirror={"key": REDIS_SIGNAL_LAST_FIRED_KEY, "kind": "hash",
                "seed": _seed_signal_from_mirror},
        # The two exception tuples of the derived carry set (the ONLY literal
        # class names in this module). rearm_each_run: cooldown > relaunch but
        # re-armed by design. pipeline_refire_stamps: pipeline slots whose
        # plan-time re-fire stamp lives here (== decide.PIPELINE_REFIRE_SEC).
        rearm_each_run=("discover_target",),
        pipeline_refire_stamps=("research_target",),
    ),
    # Written by other autopilot scripts after seed (not seeded here).
    _row("turn_snapshot", "object", {}, RESET, seeded=False),
    _row("slot_events", "array|object", [], RESET, seeded=False),
    _row("slot_history", "array", [], RESET, seeded=False),
    _row("quota_baseline", "object", {}, RESET, seeded=False, decide_owned=True),
    _row("scout_spend_usd_today", "number", 0, RESET, seeded=False),
    _row("dev_target_resume_inflight", "object", {}, RESET, seeded=False, decide_owned=True),
    _row("target_triage_item_stamps", "object", {}, RESET, seeded=False, decide_owned=True),
    _row("orch_triage_item_stamps", "object", {}, RESET, seeded=False, decide_owned=True),
    _row("target_stale_item_stamps", "object", {}, RESET, seeded=False, decide_owned=True),
    _row("target_blocked_item_stamps", "object", {}, RESET, seeded=False, decide_owned=True),
    _row("qa_orch_item_attempts", "object", {}, RESET, seeded=False, decide_owned=True),
    _row("red_forward_fix_attempts", "object", {}, RESET, seeded=False, decide_owned=True),
    _row("dev_target_spend_usd_cycle", "number", 0, RESET, seeded=False),
    # turn_snapshot BLOB_FIELDS (type "any": decide() fails safe on malformed blobs)
    _row("usage_eligibility", "any", {}, RESET, seeded=False),
    _row("emergency_brake", "any", {}, RESET, seeded=False),
    _row("target_risk_surface", "any", {}, RESET, seeded=False),
    _row("class_stats", "any", {}, RESET, seeded=False),
    _row("candidate_exclusions", "any", [], RESET, seeded=False),
]

_FIELD_BY_NAME = {f["name"]: f for f in FIELDS}

# Declared slots.<class> record (#5075). A slot is built by stamp-slot.py
# build_slot, read by decide.py / reap.py, and seeded by TS
# (deriveInflightSlotSeed). Same policy as the top-level table: a PRESENT key of
# the wrong type raises, an absent key is tolerated, an undeclared key warns once
# and is preserved. `required` marks the core every real slot carries.
SLOT_FIELDS = [
    {"name": "skill", "type": "str", "required": True},
    {"name": "task_id", "type": "str", "required": True},
    {"name": "started", "type": "str", "required": True},
    {"name": "started_epoch", "type": "int", "required": True},
    {"name": "branch", "type": "str", "required": False},
    {"name": "worktreeBranch", "type": "str", "required": False},
    {"name": "dispatch_id", "type": "str", "required": False},
    {"name": "model", "type": "str", "required": False},
    {"name": "isolation", "type": "str", "required": False},
    {"name": "anchor", "type": "str", "required": False},
    {"name": "_source", "type": "str", "required": False},
    {"name": "turn", "type": "int", "required": False},
    {"name": "attempt", "type": "int", "required": False},
]
_SLOT_FIELD_BY_NAME = {f["name"]: f for f in SLOT_FIELDS}

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
    slots = doc.get("slots")
    if isinstance(slots, dict):
        for cls, slot in slots.items():
            if not isinstance(slot, dict):
                continue  # a released slot is null; a non-object is decide()'s to tolerate
            for key, value in slot.items():
                f = _SLOT_FIELD_BY_NAME.get(key)
                if f is not None:
                    _check("slots.%s.%s" % (cls, key), value, f["type"])


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
    if isinstance(doc.get("slots"), dict):
        warned = set()
        for slot in doc["slots"].values():
            for key in (slot if isinstance(slot, dict) else ()):
                if key not in _SLOT_FIELD_BY_NAME and key not in warned:
                    warned.add(key)
                    sys.stderr.write("[run-ledger] WARN undeclared slot key %s preserved\n" % key)
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
    global _persist_calls
    _persist_calls += 1
    _validate(ledger)
    directory = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(prefix=".run-ledger-", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(_ordered(ledger), fh, indent=2, ensure_ascii=False)
            fh.write("\n")
        crash_mode = os.environ.get(CRASH_ENV)
        if crash_mode == "before-replace" or (crash_mode == "before-replace-2nd" and _persist_calls == 2):
            # Test seam: simulate a crash between write and rename. The temp
            # file is deliberately left behind (that is the crash state).
            raise SimulatedCrash("[run-ledger] simulated crash before replace")
        os.replace(tmp, path)
    except SimulatedCrash:
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


# --- carry-forward (issue #5073) ---------------------------------------------


def load_classes(path=None):
    """The classes.json rows (the Dispatch-Class Taxonomy alphabet)."""
    with open(path or CLASSES_PATH, encoding="utf-8") as fh:
        return json.load(fh)["classes"]


def _carry_ctx(classes, now):
    """Everything the row normalizers need, DERIVED from classes.json and the
    signal_last_fired row's exception tuples -- no hand-maintained class list."""
    row = _FIELD_BY_NAME["signal_last_fired"]
    rearm = set(row["rearm_each_run"])
    stamps = list(row["pipeline_refire_stamps"])
    signal_rows = [c for c in classes if c.get("kind") == "signal"]
    carry = [
        c["name"]
        for c in signal_rows
        if c.get("cooldownSeconds", 0) > PACE_GATE_RELAUNCH_SEC and c["name"] not in rearm
    ]
    carry += [s for s in stamps if s not in carry]
    keys = [c["name"] for c in signal_rows]
    keys += [s for s in stamps if s not in keys]
    return {
        "now": now,
        "carry_classes": carry,
        "all_signal_keys": keys,
        "pipeline_slots": [c["name"] for c in classes if c.get("kind") == "pipeline"],
    }


def carry_classes(classes):
    """The derived carried signal_last_fired set, in a stable order."""
    return list(_carry_ctx(classes, 0)["carry_classes"])


def read_prior(path):
    """Prior-file adapter: lenient JSON read of the previous run's document.
    None when the file is absent, unreadable or unparseable -- never raises.
    The result is UNTRUSTED input (it may be any JSON value)."""
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as exc:
        sys.stderr.write("[run-ledger] WARN prior state %s unreadable: %s\n" % (path, exc))
        return None


class RedisMirror:
    """Redis continuity adapter (ADR-0012 D2): reads the cross-run mirror.
    Every call is fail-open -- any failure returns None and never raises."""

    def __init__(self, argv_prefix):
        self.argv_prefix = list(argv_prefix)

    @classmethod
    def from_env(cls, env=None):
        env = os.environ if env is None else env
        override = (env.get("HYDRA_AUTOPILOT_REDIS_CLI") or "").strip()
        return cls(override.split() if override else DEFAULT_REDIS_ARGV)

    def run(self, *args):
        try:
            r = subprocess.run(
                [*self.argv_prefix, *args],
                check=False,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                timeout=3,
            )
        except (subprocess.TimeoutExpired, OSError) as exc:
            sys.stderr.write("[run-ledger] WARN redis %s failed (%s); degrading\n" % (args[:1], exc))
            return None
        if r.returncode != 0:
            return None
        return r.stdout.decode("utf-8", errors="replace").strip()

    def hget(self, key, field):
        return self.run("HGET", key, field)

    def get(self, key):
        return self.run("GET", key)


def _carry_one(row, raw, ctx, mirror):
    """Normalize one carried row: prior-file tier, then the Redis tier."""
    try:
        value = row["normalize"](raw, ctx)
    except Exception as exc:  # per-key degrade: the prior document is untrusted
        sys.stderr.write("[run-ledger] WARN carry %s degraded to default: %s\n" % (row["name"], exc))
        value = row["normalize"](None, ctx)
    desc = row.get("mirror")
    if mirror is not None and desc is not None:
        try:
            value = desc["seed"](value, mirror, ctx)
        except Exception as exc:  # the mirror is best-effort by contract
            sys.stderr.write("[run-ledger] WARN redis seed %s skipped: %s\n" % (row["name"], exc))
    return value


def carry_forward(prev_doc, classes, now, mirror=None):
    """The ONE reader of a prior run's state for the next run (INV-1).

    Returns the carried keys only. A single loop over FIELDS: rows whose policy
    is reset-per-run (or seeded-from-orchestrator, i.e. `slots`) are NEVER
    carried even when present in `prev_doc`. `prev_doc` is the raw parsed JSON
    (or None) and each key degrades to its default on any shape problem; this
    function never raises on a bad prior document and never touches the network
    (only the injected `mirror` adapter may).
    """
    prev = prev_doc if isinstance(prev_doc, dict) else {}
    ctx = _carry_ctx(classes, now)
    out = {}
    for row in FIELDS:
        if row["carry"] not in (CARRY, MIRRORED):
            continue
        out[row["name"]] = _carry_one(row, prev.get(row["name"]), ctx, mirror)
    return out


def build_slots(classes, overlay):
    """#1352: the pipeline-slot null base (classes.json row order) overlaid with
    the orchestrator payload's `.slots` object when it is an object."""
    base = {c["name"]: None for c in classes if c.get("kind") == "pipeline"}
    if isinstance(overlay, dict) and isinstance(overlay.get("slots"), dict):
        base.update(overlay["slots"])
    return base


def mirror_to_redis(doc, redis_cli):
    """The single Redis mirror WRITER (INV-10). The write set is derived from
    the FIELDS rows whose policy is mirrored-to-Redis: HSET field/value pairs
    for a hash row, SET canonical sorted-key JSON for a string row.
    `redis_cli(*args)` is best-effort and must not raise."""
    for row in FIELDS:
        desc = row.get("mirror")
        if row["carry"] != MIRRORED or desc is None:
            continue
        value = doc.get(row["name"])
        if desc["kind"] == "hash":
            if not isinstance(value, dict) or not value:
                continue
            args = ["HSET", desc["key"]]
            for field, ts in value.items():
                try:
                    args.extend([str(field), str(int(ts))])
                except (TypeError, ValueError):
                    continue  # intentional: skip a non-int field rather than corrupt the hash
            if len(args) > 2:
                redis_cli(*args)
        elif isinstance(value, dict):
            # An empty {} is still written: it records "none today" and never
            # resurrects a stale day.
            redis_cli("SET", desc["key"], json.dumps(value, sort_keys=True))


def _parse_pairs(args, allowed, optional=()):
    out = {}
    for a in args:
        if "=" not in a:
            raise ValueError("expected key=<json>, got %r" % a)
        k, v = a.split("=", 1)
        if k not in allowed and k not in optional:
            raise ValueError("unknown seed key %s" % k)
        if k in optional:
            out[k] = v  # raw text; the caller degrades a bad literal itself
            continue
        try:
            out[k] = json.loads(v)
        except ValueError as e:
            raise ValueError("seed key %s is not a JSON literal: %s" % (k, e))
    missing = [k for k in allowed if k not in out]
    if missing:
        raise ValueError("missing seed keys: %s" % ", ".join(missing))
    return out


def _compact(v):
    return json.dumps(v, separators=(",", ":"), ensure_ascii=False)


def _seed_cmd(rest):
    if not rest:
        sys.stderr.write("usage: run_ledger.py seed <path> [--carry-from <prev>] [--mirror] key=<json>...\n")
        return 2
    path = rest[0]
    carry_from = None
    use_mirror = False
    pairs = []
    i = 1
    while i < len(rest):
        if rest[i] == "--carry-from":
            if i + 1 >= len(rest):
                sys.stderr.write("[run-ledger] --carry-from needs a path\n")
                return 2
            carry_from = rest[i + 1]
            i += 2
        elif rest[i] == "--mirror":
            use_mirror = True
            i += 1
        else:
            pairs.append(rest[i])
            i += 1
    allowed = ("now",) + _IDENTITY_KEYS + _LIMIT_SEED_KEYS
    try:
        vals = _parse_pairs(pairs, allowed, optional=("slots_overlay",))
    except ValueError as e:
        sys.stderr.write("[run-ledger] %s\n" % e)
        return 2
    now = vals["now"]
    if not _TYPES["int"](now):
        sys.stderr.write("[run-ledger] seed key now must be an int\n")
        return 2
    overlay = None
    if vals.get("slots_overlay"):
        try:
            overlay = json.loads(vals["slots_overlay"])
        except ValueError as e:
            sys.stderr.write("[run-ledger] WARN slots_overlay unparseable, using null base: %s\n" % e)
    try:
        classes = load_classes()
        prev = read_prior(carry_from) if carry_from else None
        mirror = RedisMirror.from_env() if use_mirror else None
        carry = carry_forward(prev, classes, now, mirror)
        carry["slots"] = build_slots(classes, overlay)
        doc = seed_initial(
            {k: vals[k] for k in _IDENTITY_KEYS},
            {k: vals[k] for k in _LIMIT_SEED_KEYS},
            carry,
            now,
        )
        persist(doc, path)
    except LedgerTypeError as e:
        sys.stderr.write("%s\n" % e)
        return 1
    except (OSError, RuntimeError, ValueError, KeyError) as e:
        sys.stderr.write("[run-ledger] seed failed: %s\n" % e)
        return 1
    if carry["dev_resume_pending"]:
        print("[autopilot] carried dev_resume_pending forward from prior state: %s (issue #4518)"
              % _compact(carry["dev_resume_pending"]))
    if carry["zero_yield_backoff"]:
        print("[autopilot] carried zero_yield_backoff forward from prior state: %s (issue #4999)"
              % _compact(carry["zero_yield_backoff"]))
    return 0


_MISSING = object()


def _dig(doc, dotted, default=None):
    cur = doc
    for part in dotted.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return default
        cur = cur[part]
    return cur


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
    if cmd == "carry-classes":
        try:
            names = carry_classes(load_classes())
        except (OSError, ValueError, KeyError) as e:
            sys.stderr.write("[run-ledger] carry-classes failed: %s\n" % e)
            return 1
        print("\n".join(names))
        return 0
    if cmd == "seed":
        return _seed_cmd(rest)
    if cmd == "slot-fields":
        print(json.dumps(SLOT_FIELDS))
        return 0
    if cmd in ("get", "project"):
        prior = "--prior" in rest
        rest = [a for a in rest if a != "--prior"]
        default = None
        if cmd == "get" and "--default" in rest:
            i = rest.index("--default")
            if i + 1 >= len(rest):
                sys.stderr.write("[run-ledger] --default needs a value\n")
                return 2
            default = rest[i + 1]
            rest = rest[:i] + rest[i + 2:]
        if (cmd == "get" and len(rest) != 2) or (cmd == "project" and len(rest) < 2):
            sys.stderr.write("usage: run_ledger.py get <path> <dotted.key> [--prior] | project <path> [--prior] <key>...\n")
            return 2
        if prior:
            doc = read_prior(rest[0])
            if not isinstance(doc, dict):
                doc = {}
        else:
            try:
                doc = load(rest[0], fill_defaults=(cmd == "get"))
            except (OSError, ValueError, LedgerTypeError) as e:
                sys.stderr.write("[run-ledger] %s failed: %s\n" % (cmd, e))
                return 1
        if cmd == "project":
            print(json.dumps({k: _dig(doc, k) for k in rest[1:]}, ensure_ascii=False))
            return 0
        cur = _dig(doc, rest[1], _MISSING)
        if default is not None and (cur is _MISSING or cur is None):
            print(default)
            return 0
        if cur is _MISSING:
            return 1
        print(cur if isinstance(cur, str) else json.dumps(cur, ensure_ascii=False))
        return 0
    sys.stderr.write("[run-ledger] unknown subcommand %s\n" % cmd)
    return 2


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
