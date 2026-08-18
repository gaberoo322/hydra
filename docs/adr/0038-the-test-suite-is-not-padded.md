---
status: accepted
---

# ADR-0038: The test suite is not padded — consolidate it, never shrink it

A 2026-08-17 audit measured the Orchestrator's test suite end to end, prompted by three
plausible-sounding suspicions: that it has too many tests, that running tests wastes
operator Claude quota, and that flaky tests re-run CI many times per PR. **All three are
false**, and each of them is the kind of idea that regenerates on its own — `discover_orch`,
`cleanup_orch`, and `architecture_orch` will re-propose them from first principles unless
the measurements are written down.

This ADR exists to stop that. It records negative decisions: four lines of work that look
obviously correct and are not worth doing, each with the evidence that killed it.

## What was measured

| | |
|---|---|
| Test files | 452 |
| `test()`/`it()` call sites | 7,329 |
| Test LOC vs `src/` LOC | 146,556 vs 79,071 — **1.85 : 1** |
| Full local run | **667.5 s / 11.1 min**, 7,470 pass, 0 fail |
| Mean `ci.yml` runs per merged PR | **1.59** (median 1) |
| Explicit CI re-runs (`run_attempt > 1`) | 2 of 60 — 3.3% |

Composition, by what each file actually asserts:

| bucket | files | tests | lines |
|---|---:|---:|---:|
| behavior — imports `src/`, real inputs | 249 | 4,214 | 69,183 |
| redis-integration — behavior, live DB | 85 | 1,154 | 27,844 |
| subprocess — spawns real `.py`/`.sh` | 68 | 1,090 | 28,704 |
| grep-the-source | 22 | 453 | 11,065 |
| doc-drift / doc-lint | 20 | 274 | 7,000 |
| config / schema shape | 5 | 117 | 2,262 |
| **tautological** | **3** | **27** | **498** |

**402 of 452 files exercise real code.** Exactly three are worthless
(`test/planner-model-routing.test.mts`, `test/autopilot-token-cap.test.mts`,
`test/reflection-injection.test.mts` — each re-implements the thing it tests), together
0.34% of test LOC.

## Decision

**The suite's problem is organisation, not size. Consolidate it mechanically; do not
delete, rewrite, or parallelise it.**

### Decision 1 — Do not delete tests to shrink the suite

There is nothing meaningful to delete. The 1.85:1 test-to-source ratio is not evidence of
padding; it is what a suite covering 371 source files across Redis, subprocess, and HTTP
seams costs. A proposal to "trim the test suite" must first name which of the 402
behavior-bearing files it would remove and what coverage is lost.

### Decision 2 — Do not semantically rewrite tests to reduce 146k lines

Rewriting overlapping cases into fewer, denser ones is where coverage silently dies: the
agent doing the rewriting is the only thing checking that the new assertions still pin the
old behavior, and nothing downstream can tell a dropped case from a deliberate merge. It is
also a large agent spend against a metric it does not improve.

**Mechanical merges are the sanctioned alternative** — concatenate files, keep every test
verbatim, preserve each source file's top-level `describe`, and verify the per-file
suite-count baseline sum is unchanged. That is machine-checkable; a semantic rewrite is not.

### Decision 3 — Do not parallelise the test runner

`--test-concurrency=1` is load-bearing: `scripts/test/redis-db-launch.mjs` assigns one Redis
DB index **per run**, not per file, so in parallel the sibling files' `beforeEach`
keyspace-cleans would wipe each other.

More decisively, the work does not pay. CI runs on self-hosted runners and consumes **zero**
Claude tokens; the binding constraint is operator quota, not runner minutes. An 11-minute
suite costs agent *waiting*, not spend. Anyone proposing this must first re-argue the metric
in Decision 5, not just the speedup.

### Decision 4 — Do not redesign Redis test isolation

This is the prerequisite for Decision 3 and falls with it. It was already considered and
rejected once in #1231, and the alternative (a key-prefix namespace) was rejected again in
`redis-db-launch.mjs`'s own header: 87 test files open raw `new Redis(...)` connections that
a prefix would not isolate.

### Decision 5 — The metric is operator Claude quota, not CI minutes

Every proposal above is judged against agent-hours lost, not wall-clock. Under that metric
the real cost was never *running* tests — it was one test file per **issue** rather than per
module (`scripts/autopilot/decide.py` owned 20 test files; 14 files carry a bare issue number
in their basename), so every dispatch touching one module had to discover and read a dozen
files. That is what #4134's ratchet and the #4136/#4139/#4140 merges address.

### Decision 6 — Flakiness is not a merge-throughput problem, but it is not zero either

Flakiness does not drive CI re-runs: **1.59 `ci.yml` runs per merged PR**, and explicit
re-runs are 2 of 60. Do not open a sweep hunting flaky tests on throughput grounds.

It is not zero, though, and this ADR will not pretend otherwise. Two files were observed
during the audit failing under **full-suite load** while passing in isolation —
`test/watchdog-launch-flow.test.mts` (tracked as #4135, also intermittently red on master)
and `test/autopilot-cycle-records.test.mts` (4/4 clean isolated, red once in a full run of an
unrelated docs-only change). Both signatures point at cross-file contention under load, not
at the file's own logic.

The rule: a **named file with reproduction evidence** is actionable work. A general
suspicion that "the suite is flaky" is not, and must not be used to justify Decisions 1–4.

## Consequences

A `SUITE-COUNT GATE FAILED` block is **not** evidence for any of the above. #4137 measured
that a shortfall is the parent process truncating the child's reporter stream under
`--test-force-exit`, not tests being skipped: all 60 execution markers appeared on runs whose
TAP reported 30, and a planted regression in the most-truncated position failed the build on
27 of 27 runs. Verification holds. Removing `--test-force-exit` is not available either — a
run without it completed 1 of ~1,900 top-level entries in 25 minutes.
