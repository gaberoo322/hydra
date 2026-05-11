# Ineffective promoted patterns (issue #289)

The learning system promotes a Redis-backed pattern to `config/feedback/to-{agent}.md`
once its hit count reaches `PROMOTION_THRESHOLD` (currently 3). Promotion is
supposed to durably change agent behavior — once the rule is in the feedback
file, every subsequent agent call sees it, so the failure mode should taper off.

In practice it doesn't always work. Two real-world examples (May 2026):

| Pattern               | Agent    | Hits at promotion | Hits today | Days since promotion | Post-promotion rate |
|-----------------------|----------|-------------------|------------|----------------------|---------------------|
| `scope-creep`         | planner  | 5                 | 231        | ~9                   | ~25/day             |
| `verification-failure`| executor | 5                 | 438        | ~14                  | ~31/day             |

Both rules grew at roughly the same rate before and after promotion. The
prompt text isn't actually preventing the failure mode it describes — it just
gets quoted back at the agent and ignored.

## How Hydra detects this

`src/learning/agent-memory.ts` now records two extra fields on every pattern
at promotion time:

- `promotedAt` — ISO date (YYYY-MM-DD)
- `hitsAtPromotion` — hit count at the moment of promotion

`getIneffectivePromotedPatterns(agent)` returns every pattern whose
post-promotion firing rate is **at least as high** as its pre-promotion rate
(see `evaluatePromotedPatternEffectiveness()` for the exact math). Patterns
promoted in the last `MIN_DAYS_POST_PROMOTION` (3) days are skipped — we need
a comparable window before judging.

Legacy patterns promoted before this instrumentation lack the new fields and
are silently skipped. They'll be re-evaluated the next time they fire and
the new fields get populated (or, if you want immediate visibility, run a
one-off script that backfills `promotedAt` from the `<!-- auto-promoted ... -->`
comment in the feedback file).

## How to check

```bash
curl -s http://localhost:4000/api/learning/ineffective-rules | jq
```

Example response:

```json
{
  "planner": [
    {
      "category": "scope-creep",
      "promotedAt": "2026-04-28",
      "hitsAtPromotion": 5,
      "hitsSincePromotion": 226,
      "daysToPromotion": 10,
      "daysSincePromotion": 9,
      "preRate": 0.5,
      "postRate": 25.11,
      "rateRatio": 50.22,
      "lastSeen": "2026-05-07"
    }
  ],
  "executor": [...],
  "skeptic": [],
  "totalIneffective": 2
}
```

`rateRatio` > 1 means the post-promotion rate is higher than pre — the rule
isn't doing anything. `rateRatio` near 1 means it's flat: the rule is firing
at the same cadence as before promotion, which is also a no-op.

## What to do about a flagged pattern

Decide between two paths:

1. **Rewrite the rule text** — the current action string is too vague or
   too easy to ignore. Edit `config/feedback/to-{agent}.md` directly, replace
   the generic `### scope-creep (231x ...)` block with something concrete
   ("When `scopeBoundary.in` lists a test file's source module, ALSO include
   the test file"). Commit on a feature branch; the next planner call will
   pick up the new text.

2. **Split into more specific sub-patterns** — `scope-creep` at 231x is a
   bucket. Look at the `examples` field of the Redis pattern
   (`redis-cli get hydra:memory:planner:patterns | jq`) and find the
   recurring shape: is it always "test file outside scope"? "shared module
   outside scope"? Open a hydra issue to add separate categories in
   `recordPlannerLesson()` (`src/learning/agent-memory.ts`) so future
   instances fall into narrower buckets, then delete the catch-all
   `scope-creep` rule from the feedback file.

Either path can be done by a hydra-dev agent — file a `ready-for-agent` issue
referencing the specific pattern and the rateRatio you saw. This dovetails
with issue #7 (GEPA-style prompt evolution): an ineffective rule is exactly
the kind of input the evolution loop should consume.

## Related

- `src/learning/agent-memory.ts` — `evaluatePromotedPatternEffectiveness`,
  `getIneffectivePromotedPatterns`, `MIN_DAYS_POST_PROMOTION`.
- `src/api/learning.ts` — `/api/learning/ineffective-rules` handler.
- `test/learning-ineffective-promoted-patterns.test.mts` — regression tests.
- Issue #7 — prompt evolution (consumer of these signals).
- Issue #289 — origin of this instrumentation.
