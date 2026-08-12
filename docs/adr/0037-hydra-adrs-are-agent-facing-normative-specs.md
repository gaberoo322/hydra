---
status: accepted
---

# ADR-0037: Hydra ADRs are agent-facing normative specs, not one-paragraph memory aids

Hydra's ADR corpus reached 34 records / ~275 KB at a mean of ~8 KB each. The upstream
Pocock `domain-modeling` skill — which Hydra otherwise follows, and whose `ADR-FORMAT.md`
is the format Hydra's `docs/adr/` nominally implements — prescribes a template of a title
plus "1-3 sentences," notes that "an ADR can be a single paragraph," and marks `Status`,
`Considered Options`, and `Consequences` as opt-in sections most ADRs won't need. Measured
against that, Hydra overshoots by ~45×.

The obvious reading is that the corpus drifted and should be compacted back. That reading is
wrong, and this ADR exists to stop the next agent from acting on it.

## Decision

**Hydra's ADRs are a different artifact from Pocock's, deliberately. Adopt Pocock's write
gate; reject its size target.**

### Decision 1 — The reader is an agent, not a colleague

Pocock's format assumes a human teammate with tacit project context, for whom an ADR is a
*memory aid* answering "why did we do this?". Hydra's ADRs are read by fresh subagents with
zero tacit context, for whom the ADR is the *only* source. Rationale a human could infer,
an agent must be told. That asymmetry is the whole justification for the extra length — and
it is a justification, not an excuse: length that does not do that work is still bloat.

### Decision 2 — Numbered `Decision N` blocks are load-bearing and stable

Skills, playbooks, and code cite Hydra ADRs by sub-decision — `ADR-0030 Decision 2`,
`ADR-0031 Decision 6`, `ADR-0029 Decision 3` — 145 such citations at the time of writing,
against 1,445 total `ADR-NNNN` references repo-wide. A one-paragraph ADR cannot *have* a
Decision 6. Numbered decision blocks are therefore a required structure for any ADR whose
decisions will be cited, and **their numbering is stable**: amend a decision in place, never
renumber, because renumbering silently re-points live citations.

### Decision 3 — Pocock's write gate applies unchanged

Offer an ADR only when all three hold: **hard to reverse**, **surprising without context**,
**the result of a real trade-off**. If any is missing, skip it. This is the lever that
controls corpus growth. It is upstream of size, and it is where restraint belongs.

### Decision 4 — `Consequences` and `Alternatives considered` stay opt-in

These are 24% of the corpus (66 KB) and Pocock marks both optional. Include them only when
the downstream effect is genuinely non-obvious, or when a rejected alternative will otherwise
be re-proposed in six months. A `## Consequences` section restating the Decision in the
future tense earns nothing.

### Decision 5 — `Status` is required, not optional

Pocock makes `Status` optional. Hydra requires it on every ADR, because a Hydra ADR states
rules an agent must obey, and an agent must be able to tell a live rule from a retired one.
Three ADRs sat at `Proposed` while being live doctrine (0012, 0021, and the ADR renumbered
to 0036) and four declared no status at all (0002, 0003, 0005, 0010) — 115+ citations rested
on records whose declared status contradicted reality. Enforced by `test/adr-roster.test.mts`.

### Decision 6 — Volume is managed by routing, not by compaction

The corpus is never compacted, merged, or garbage-collected on a count or byte threshold:
compaction destroys the *why*, which is the entire product of an ADR, and it breaks the
citations of Decision 2. Volume is managed instead by **routing** — [`README.md`](./README.md)
is a ~10 KB roster read in full, and `CONTEXT-MAP.md` maps code areas to the ADRs that govern
them, so a task loads 2–4 ADRs rather than the whole corpus. Per-area routed weight is held
flat by a non-growth ratchet in `test/adr-roster.test.mts`: an area may not grow without a
deliberate baseline bump in the same PR.

## Consequences

- Adding an ADR to an already-heavy area fails CI until the author either re-routes, trims
  that area, or raises its baseline on purpose. That friction is the point — it is the trim
  conversation, held at the moment it is cheapest. **`test/fixtures/adr-area-baseline.json`
  is the authoritative per-area weight**; do not restate those numbers in prose, here or
  elsewhere, or they drift. At the time of writing the heaviest areas were
  `scripts/autopilot/` (~67 KB) and `.claude/skills/ + docs/operator-playbooks/` (~42 KB).
- Retired-subsystem tombstones (0006, 0010, 0023, 0033, 0036) are kept, not deleted. They are
  the standing answer to "why don't we just build X?" and deleting them re-opens settled work.

## Alternatives considered

- **Compact on a count or byte threshold.** Rejected: count is not the cost (34 files is
  trivial; the routed working set is), and compaction destroys rationale and breaks citations.
- **Converge on Pocock's one-paragraph format.** Rejected: it cannot express Decision 2's
  numbered blocks, and it assumes tacit reader context that a fresh subagent does not have.
- **Split the artifact — short ADRs in `docs/adr/`, normative rules elsewhere.** Rejected as
  disproportionate: it re-points ~145 sub-decision citations to buy a naming purity that
  Decision 1 says we do not want.
