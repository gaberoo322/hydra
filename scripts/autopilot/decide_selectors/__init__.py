"""decide_selectors — per-family selector handlers for decide.py (issue #4511).

One module per dispatch family, named by the class stem, with the orch/target
twins co-located (qa.py holds qa_orch and qa_target). Each module defines its
family's `_select_slot_*` / `_select_signal_*` handlers plus the helpers and
constants only that family uses, and imports the standard library and
`decide_base` only — never `decide`, never a sibling selector module.

This package file is deliberately empty of imports and re-exports: decide.py is
the composition root and binds every handler BY NAME into the explicit
`_SLOT_SELECTORS` / `_SIGNAL_SELECTORS` dict literals. There is no
auto-registration here.

The package is NOT named `selectors`: with scripts/autopilot/ on sys.path[0]
that name would shadow the standard-library module of the same name.
"""
