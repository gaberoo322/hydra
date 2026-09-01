- fix: give dev_target dispatches a forbidden-ending preamble that permits the delegated build spawn but blocks the parent on it in the foreground, instead of allowing a silent zero-deliverable exit (#4196)

Reconciliation note: INV-6 and INV-7 quotes in the PR body were truncated and
failed the design-concept-reconcile gate (quote-mismatch, needs a verbatim
>=16-char prefix). Body corrected to quote both invariants verbatim; this commit
exists to re-trigger the gate, which reads the body from the push webhook
payload rather than live state.
