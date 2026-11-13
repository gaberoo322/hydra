"""taxonomy.py -- the ONE loader for the Dispatch-Class Taxonomy (classes.json).

Every Python reader under scripts/autopilot/ (decide.py, render-dispatch.py,
run_ledger.py, heartbeat.py, assert_invariants.py) loads classes.json through
this module, so the validation, the HYDRA_CLASSES_JSON override, the scope
derivation and the per-skill completion obligations live in exactly one place
(epic #5471, issues #5472, #5473). The table holds per-class and per-skill
facts; decide.py keeps dispatch policy (order, gating, preemption).

HYDRA_CLASSES_JSON (issue #5202) is a TEST SEAM: when set (non-empty) it names
the taxonomy file and ONLY that file is loaded -- a missing or invalid override
raises TaxonomyError naming the override path, never a fallback to the shipped
classes.json. No production entrypoint sets it.

Stdlib only. Imports neither `decide` nor `decide_base` (leaf module): decide
imports this, never the reverse.

TaxonomyError subclasses RuntimeError (NOT SystemExit) and is NEVER caught
internally to fall back to embedded tuples. The one carve-out is reap.py's
`_obligations_for`, which fails open (logged) so a bad file cannot abort a reap.
"""

from __future__ import annotations

import json
import os
from typing import Iterable, NamedTuple

_DEFAULT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "classes.json")


def taxonomy_path() -> str:
    """The taxonomy file every reader loads: the override, else the sibling classes.json."""
    return os.environ.get("HYDRA_CLASSES_JSON") or _DEFAULT_PATH


# Every column must be PRESENT on every row (nullable columns carry an
# explicit null, never an absent key) so a projection miss is loud.
_TAXONOMY_REQUIRED_COLUMNS = (
    "name",
    "kind",
    "skill",
    "costClass",
    "learningAgent",
    "cooldownSeconds",
    "scope",
    "provenanceLabel",
    "stage",
    "model",
    "cycleRecord",
    "worktreeGc",
    "reflectionDeposit",
)

# The three completion-obligation columns (#5473): required booleans that
# describe the row's DEFAULT `skill` (reap resolves them by the skill that ran).
_TAXONOMY_OBLIGATION_COLUMNS = ("cycleRecord", "worktreeGc", "reflectionDeposit")

_TAXONOMY_KINDS = ("pipeline", "signal")
_TAXONOMY_SCOPES = ("orch", "target", "both")
_TAXONOMY_LEARNING_AGENTS = ("planner", "executor")
# The eight stage values a CLASS row may carry (#4592). The two skill-only
# values ("operator-interactive", "brain") are deliberately NOT members: they
# exist only on docs/generated/skills.json rows, and rejecting them here is
# what makes "exactly one brain" enforceable. Kept textually identical to
# CLASS_STAGES in src/taxonomy/classes.ts — pinned by the parity test.
_TAXONOMY_STAGES = (
    "plan",
    "spec",
    "tickets",
    "implement",
    "review",
    "pre-plan-producer",
    "ops",
    "target",
)
# The five closed model values (#4592). DOCUMENTATION-ONLY on a class row:
# decide.py validates the column and otherwise ignores it — the model lever
# lives in the playbook (issue #1093), which reads the column at dispatch
# time. Kept textually identical to DISPATCH_CLASS_MODELS in
# src/taxonomy/classes.ts — pinned by the parity test.
_TAXONOMY_MODELS = ("fable", "sonnet", "haiku", "opus", "inherit")


class TaxonomyError(RuntimeError):
    """classes.json is missing, malformed, or violates the row contract.

    Raised at import time (issue #1670) -- the brain refuses to start without
    a valid Dispatch-Class Taxonomy. NEVER caught internally to fall back to
    embedded tuples.
    """


def taxonomy_fail(reason: str, path: str | None = None) -> TaxonomyError:
    return TaxonomyError(
        f"taxonomy.py: dispatch-class taxonomy {path or taxonomy_path()}: {reason} "
        "-- refusing to start (no fallback tuples; epic #1669 / issue #1670)"
    )


def load_taxonomy(path: str | None = None) -> tuple[dict, ...]:
    """Load + validate classes.json. Hard-fails on any contract violation.

    `path` None resolves via `taxonomy_path()` (the HYDRA_CLASSES_JSON override,
    else the sibling classes.json).
    """
    path = path or taxonomy_path()

    def _fail(reason: str) -> TaxonomyError:
        return taxonomy_fail(reason, path)

    try:
        with open(path, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
    except FileNotFoundError:
        raise _fail("file is missing") from None
    except json.JSONDecodeError as exc:
        raise _fail(f"malformed JSON ({exc})") from None

    if not isinstance(raw, dict) or not isinstance(raw.get("classes"), list):
        raise _fail('top level must be an object with a "classes" list')
    rows = raw["classes"]
    if not rows:
        raise _fail('"classes" list is empty')

    seen_names: set[str] = set()
    for i, row in enumerate(rows):
        if not isinstance(row, dict):
            raise _fail(f"row {i} is not an object")
        missing = [c for c in _TAXONOMY_REQUIRED_COLUMNS if c not in row]
        if missing:
            raise _fail(
                f"row {i} ({row.get('name', '?')}) lacks required column(s): "
                + ", ".join(missing)
            )
        name = row["name"]
        if not isinstance(name, str) or not name:
            raise _fail(f"row {i}: name must be a non-empty string")
        if name in seen_names:
            raise _fail(f"duplicate class name: {name}")
        seen_names.add(name)
        if row["kind"] not in _TAXONOMY_KINDS:
            raise _fail(
                f"{name}: kind must be one of {_TAXONOMY_KINDS}, got {row['kind']!r}"
            )
        if not isinstance(row["skill"], str) or not row["skill"]:
            raise _fail(f"{name}: skill must be a non-empty string")
        if row["stage"] not in _TAXONOMY_STAGES:
            raise _fail(
                f"{name}: stage must be one of {_TAXONOMY_STAGES} — the skill-only "
                "values (operator-interactive, brain) are rejected on class rows "
                f"(#4592), got {row['stage']!r}"
            )
        if row["model"] not in _TAXONOMY_MODELS:
            raise _fail(
                f"{name}: model must be one of {_TAXONOMY_MODELS} (non-nullable; "
                "inherit means the dispatch omits the model kwarg), got "
                f"{row['model']!r}"
            )
        if "skill_by_ticket_type" in row and row["skill_by_ticket_type"] is not None:
            mapping = row["skill_by_ticket_type"]
            if (
                not isinstance(mapping, dict)
                or not mapping
                or any(
                    not isinstance(k, str) or not k or not isinstance(v, str) or not v
                    for k, v in mapping.items()
                )
            ):
                raise _fail(
                    f"{name}: skill_by_ticket_type must be a non-empty object "
                    "mapping non-empty ticket-type strings to non-empty skill names"
                )
            if row["skill"] not in mapping.values():
                raise _fail(
                    f"{name}: one skill_by_ticket_type value must equal the row's "
                    f"skill {row['skill']!r} (the default stays reachable)"
                )
        for col in _TAXONOMY_OBLIGATION_COLUMNS:
            if not isinstance(row[col], bool):
                raise _fail(f"{name}: {col} must be a boolean, got {row[col]!r}")
        if not isinstance(row["costClass"], str) or not row["costClass"]:
            raise _fail(f"{name}: costClass must be a non-empty string")
        if row["learningAgent"] is not None and (
            row["learningAgent"] not in _TAXONOMY_LEARNING_AGENTS
        ):
            raise _fail(
                f"{name}: learningAgent must be null or one of "
                f"{_TAXONOMY_LEARNING_AGENTS}, got {row['learningAgent']!r}"
            )
        if row["scope"] not in _TAXONOMY_SCOPES:
            raise _fail(
                f"{name}: scope must be one of {_TAXONOMY_SCOPES}, got {row['scope']!r}"
            )
        if row["provenanceLabel"] is not None and (
            not isinstance(row["provenanceLabel"], str) or not row["provenanceLabel"]
        ):
            raise _fail(
                f"{name}: provenanceLabel must be null or a non-empty string"
            )
        cooldown = row["cooldownSeconds"]
        if row["kind"] == "signal":
            # bool is an int subclass in Python — exclude it explicitly.
            if isinstance(cooldown, bool) or not isinstance(cooldown, int) or cooldown < 0:
                raise _fail(
                    f"{name}: signal rows need a non-negative integer "
                    f"cooldownSeconds, got {cooldown!r}"
                )
        elif cooldown is not None:
            raise _fail(
                f"{name}: pipeline rows must carry cooldownSeconds: null "
                f"(slots have no class cooldown), got {cooldown!r}"
            )

    # Obligations are per-SKILL facts: rows sharing a default skill must agree,
    # and every ticket-type route must land on a skill some row dispatches by
    # default (so the lookup below never meets a routed skill it cannot answer).
    by_skill: dict[str, tuple[str, tuple[bool, ...]]] = {}
    for row in rows:
        flags = tuple(row[c] for c in _TAXONOMY_OBLIGATION_COLUMNS)
        prior = by_skill.setdefault(row["skill"], (row["name"], flags))
        if prior[1] != flags:
            raise _fail(
                f"rows {prior[0]} and {row['name']} share skill {row['skill']!r} "
                f"but disagree on {_TAXONOMY_OBLIGATION_COLUMNS}"
            )
    for row in rows:
        for ticket_type, routed in (row.get("skill_by_ticket_type") or {}).items():
            if routed not in by_skill:
                raise _fail(
                    f"{row['name']}: skill_by_ticket_type[{ticket_type!r}] = {routed!r} "
                    "is not any row's default skill"
                )

    return tuple(rows)


# ---------------------------------------------------------------------------
# Completion obligations -- per-skill facts reap.py resolves by the skill that ran
# ---------------------------------------------------------------------------


class SkillObligations(NamedTuple):
    cycle_record: bool
    worktree_gc: bool
    reflection_deposit: bool


_NO_OBLIGATIONS = SkillObligations(False, False, False)


def _cached_taxonomy() -> tuple[dict, ...]:
    """load_taxonomy() memoised on (resolved path, mtime_ns, size): one reap asks
    for obligations up to three times, and an edited classes.json still reloads."""
    path = taxonomy_path()
    if not os.path.isfile(path):
        return load_taxonomy(path)  # raises the typed "file is missing" error
    st = os.stat(path)
    key = (path, st.st_mtime_ns, st.st_size)
    if _TAXONOMY_CACHE.get("key") != key:
        _TAXONOMY_CACHE["rows"] = load_taxonomy(path)
        _TAXONOMY_CACHE["key"] = key
    return _TAXONOMY_CACHE["rows"]


_TAXONOMY_CACHE: dict = {}


def skill_obligations(skill: str, rows: Iterable[dict] | None = None) -> SkillObligations:
    """The three completion obligations of `skill` -- the skill that RAN, which for
    a ticket-routed dispatch (a wayfinder_orch `task` ticket) is the routed skill,
    not the class's default. An unknown skill owes nothing. `rows` defaults to the
    loaded taxonomy."""
    for row in rows if rows is not None else _cached_taxonomy():
        if row["skill"] == skill:
            return SkillObligations(
                row["cycleRecord"], row["worktreeGc"], row["reflectionDeposit"]
            )
    return _NO_OBLIGATIONS


# ---------------------------------------------------------------------------
# Row projections (kind / cooldown) -- every reader derives these, none hand-keeps them
# ---------------------------------------------------------------------------


def pipeline_slots(rows: Iterable[dict]) -> tuple[str, ...]:
    return tuple(r["name"] for r in rows if r["kind"] == "pipeline")


def signal_classes(rows: Iterable[dict]) -> tuple[str, ...]:
    return tuple(r["name"] for r in rows if r["kind"] == "signal")


def signal_cooldowns(rows: Iterable[dict]) -> dict[str, int]:
    return {r["name"]: r["cooldownSeconds"] for r in rows if r["kind"] == "signal"}


# ---------------------------------------------------------------------------
# Scope exclusion -- DERIVED from the `scope` column (issue #5472)
# ---------------------------------------------------------------------------

# autopilot scope -> the row scope it excludes. `all` excludes nothing and
# `scope: both` rows (health) are never excluded under any scope.
_SCOPE_EXCLUDES = {"orch-only": "target", "target-only": "orch"}


def scope_excluded(scope: str, cls: str, rows: Iterable[dict] | None = None) -> bool:
    """Is class `cls` excluded under the autopilot `scope`?

    `orch-only` excludes every `scope: target` row, `target-only` excludes every
    `scope: orch` row, `scope: both` rows and the `all` scope exclude nothing. A
    class with no taxonomy row is never excluded (it has no scope to violate).
    `rows` defaults to the loaded taxonomy.
    """
    excluded_row_scope = _SCOPE_EXCLUDES.get(scope)
    if excluded_row_scope is None:
        return False
    for row in rows if rows is not None else load_taxonomy():
        if row["name"] == cls:
            return row["scope"] == excluded_row_scope
    return False


# ---------------------------------------------------------------------------
# Order tuples are POLICY (they stay in decide.py) but must cover the rows exactly
# ---------------------------------------------------------------------------


def check_order_tuple(
    tuple_name: str, order: Iterable[str], rows: Iterable[dict], kind: str, path: str | None = None
) -> None:
    """Raise TaxonomyError unless `order` is exactly the set of `kind` rows (no
    missing class, no unknown class, no duplicate), naming the tuple and class."""
    wanted = [r["name"] for r in rows if r["kind"] == kind]
    seen: set[str] = set()
    for cls in order:
        if cls in seen:
            raise taxonomy_fail(f"order tuple {tuple_name}: duplicate class {cls!r}", path)
        seen.add(cls)
        if cls not in wanted:
            raise taxonomy_fail(
                f"order tuple {tuple_name}: unknown class {cls!r} (not a {kind} row)", path
            )
    for cls in wanted:
        if cls not in seen:
            raise taxonomy_fail(f"order tuple {tuple_name}: missing {kind} class {cls!r}", path)
