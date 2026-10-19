---
status: accepted
---

# ADR-0043: The Turn Snapshot is a typed TypeScript module; `collect-state.sh` is strangled

`scripts/autopilot/collect-state.sh` gathers everything the autopilot brain (`decide.py`) sees on a
turn. It is 3,710 lines and has 31 `collect_*` functions, about 57 `gh` calls and **35 inline
`python3 <<'PY'` heredocs**, roughly 1,200 lines of Python. The biggest heredoc is a 406-line PR-gate classifier.
Its output is about 150 flat `key=value` lines with JSON blobs and packed strings mixed in
(`issue-N:PR:branch`). `decide.py` parses those packed strings back into fields.

Keeping that text in sync with its consumers takes four sync layers, none of which carries behavior:
`merge-signals.py` (52 `Rule()`s), the signal-wiring table
(`_fragments/hydra-autopilot-signal-wiring.md`), parity legs L1–L4 in
`scripts/ci/signal-parity-check.ts`, and the `collect-state.sh` line anchors in
`docs/generated/env-vars.json`. Three classification predicates exist twice, in two languages, held
together by drift tests: the strict-blocker parse (`src/github/blockers.ts` and an inline
`PATTERNS`), PR references (`src/github/pr-refs.ts` and `scripts/autopilot/pr-refs.py`), and the
board-state count projection (`src/autopilot/board-state.ts` and a degraded-path jq copy that
re-hardcodes `5400` / `43200`). Adding one signal touched 12–15 files in recent PRs (#4807,
#4739, #4823).

The script cannot run whole under test because it needs gh auth, Redis, the hydra CLI and the live
service. About 12 test files regex-extract a heredoc by the variable it is assigned to and run it
with `python3 -c`. About 16 more slice the script's text. That is why the script's header forbids
re-indenting bodies: the tests key on text, so the script's interface is its source.

The deletion test settles it. If the collectors returned a typed value, all four sync layers and
all three cross-language twins would disappear rather than move. They are shallow modules, and the
deep module they stand in for does not exist yet.

## Decision

### Decision 1 — The Turn Snapshot is a typed TS module behind injected adapters

The **Turn Snapshot** is everything `decide.py` sees at one turn, gathered once. It lives in
`src/autopilot/turn-snapshot/`. Each collector is `(deps) => Promise<CollectorOutcome>`. `deps`
carries a **narrow typed `gh` port** (`TurnSnapshotGithub`: one typed method per read a collector
needs, implemented over `src/github/`'s `ghJson`/`runExec` seam, with the repo resolved through
`src/github/repo.ts`, never a literal) plus the hydra HTTP client. Tests use a fake port that
returns typed fixtures. The pattern is ADR-0040 Decision 2's: a pure core plus orchestration over
injected deps.

**A generic `gh(args) → stdout` adapter is not acceptable.** It keeps the fake pinned to CLI
argument strings, which is the current problem.

### Decision 2 — It runs as a one-shot CLI each turn, not as an orchestrator route

`scripts/autopilot/turn-snapshot.ts` runs under `node --experimental-strip-types` (about 20 ms to
start). The autopilot must keep deciding while the data plane is down. Serving the snapshot from
the service would bring back a "service down" fallback, which is exactly how the board-state jq
copy came to exist. Board-state counts stay a service read through the HTTP adapter. When that read
fails, the CLI imports `deriveBoardState` directly instead of re-deriving it in another language.
The pure core could still be mounted in the service later as a second adapter if one is ever
needed.

### Decision 3 — Migrate with a strangler: collectors move one at a time, fetch included

Each slice moves whole collectors, fetches included, into TS and deletes their bash, heredocs and
text-shape tests **in the same PR**. Classifiers-only, with bash still doing the fetching, is
rejected: it keeps two languages per collector permanently and leaves the pinned fetch shapes
behind.

**Slice order (by data dependency):**
1. inflight PRs + PR-gate
2. orch board, untriaged orphans, needs-qa
3. grill/dev-ready picks, candidate exclusions, merged PRs (`pr-refs.py` and the inline blocker
   `PATTERNS` are deleted here)
4. the Target board family
5. the HTTP passthrough collectors
6. the JSON switch (Decision 5)

Slices 2–5 depend only on slice 1.

### Decision 4 — Each slice is byte-identical on the wire, proven by golden files

Until the final slice, the TS collectors emit through a `kv` renderer that reproduces today's lines
exactly. `decide.py` and `merge-signals.py` are not touched in slices 1–5. Before a slice deletes a
heredoc, it captures that heredoc's stdout and its stderr-note set over every existing fixture,
failure fixtures included, from the slice's base SHA into `test/fixtures/turn-snapshot/`. The TS
tests assert against those golden files: **stdout byte for byte, and the same set of stderr
notes**.

Degradation is an explicit typed field in the core and never a silent default. It is the `kv`
renderer that turns it back into today's fallback lines.

Behavioral test cases are **ported 1:1**: same fixtures and assertions, called at the TS
interface. Only assertions about the shape of the bash text are deleted, because what they tested
no longer exists. This is not the suite-shrinking ADR-0038 forbids. Each slice PR states its
ported-case count against the original and regenerates the suite-count baseline.

### Decision 5 — The final slice switches `decide.py` to a typed JSON snapshot

Once every collector is in TS, slice 6 makes the CLI emit one JSON Turn Snapshot. A zod schema in
`src/schemas/turn-snapshot.ts` is the single source of truth and is validated on emit. A validation
failure becomes a degraded marker; it never crashes the turn. `decide.py` reads the snapshot only
through one `turn_snapshot.py` accessor. A contract test round-trips the golden snapshots through
both sides, and **no generated schema file is committed**. The packed strings become structured
fields.

Slice 6 deletes `collect-state.sh`, `merge-signals.py`, the signal-wiring table, parity legs L1–L4
and the `collect-state.sh` anchors in `env-vars.json`. ADR-0007 is unchanged: `decide.py` remains
the pure brain returning a typed Plan, and only the shape of its input changes.

### Decision 6 — During the migration, new signals are TS collectors

A new signal is written as a Turn Snapshot collector, even when it sits next to a collector that is
still bash. An *existing* bash collector may still be edited until its slice lands, because
freezing would stall unrelated autopilot fixes for weeks.

A ratchet in `test/autopilot-collect-state-signals.test.mts` enforces this. It sets a shrink-only ceiling on the
script's `python3` heredoc count, and each slice lowers it. The ceiling starts at 37, not master's
35, so that PR #4860 (#4812, written before this ADR) can land. Slice 1 deletes those two heredocs.

## Consequences

- Adding a signal becomes one collector, its test and the `decide.py` policy. The sync layers are
  gone after slice 6.
- The interface is the test surface. Collector logic is reached through a typed call with a fake
  port, not by regex-extracting source text.
- For slices 1–5 the old wire format and the new module coexist. Golden files make that safe and
  slice 6 ends it.
- Slices are `dev_orch` work on Claude, not the GLM worker lane (ADR-0032). They are too deep for a
  fenced shallow drainer.
- Moving `gh` reads from GraphQL to REST is out of scope. Slices keep the same underlying calls so
  output stays byte-identical. Changing them is a separate, behavior-changing ticket.

## Alternatives considered

- **Serve the snapshot from the orchestrator service** (`GET /autopilot/snapshot`). Rejected
  (Decision 2) because it needs a fallback when the service is down, and that fallback is a
  duplicate predicate.
- **Port only the classifiers and keep fetching in bash.** Rejected (Decision 3) because it leaves
  two languages per collector permanently.
- **Switch to JSON on the first slice.** Rejected (Decision 4) because every slice would also have
  to migrate `decide.py` readers while three in-flight PRs touch the same files.
- **Commit a JSON Schema generated from zod for `decide.py`.** Rejected (Decision 5) because it is
  one more committed generated artifact that every change conflicts on.
