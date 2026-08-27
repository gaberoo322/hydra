---
name: hydra-retro
description: Per-run retrospective for hydra-autopilot — consumes the retro bundle, deep-reads only the flagged transcripts, synthesises findings, drops speculative/duplicate ones via an adversarial self-check, then emits a tiered + capped set of improvement proposals (≤2 GitHub issues, ≤1 gated PR, artifact-only notes).
when_to_use: "When the user says 'retro', 'retrospective', 'analyze the last run', or autopilot wants to turn a completed run into conservative, recurrence-gated improvement proposals. Invoked as /hydra-retro [run_id] (default: latest completed run)."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*) Agent(*)
---

# Hydra Retro

Per-run retrospective for `hydra-autopilot`. Consumes the **retro bundle**
(issue #918), deep-reads **only the flagged transcripts**, synthesises
findings, runs an **adversarial self-check** to drop speculative/duplicate
findings, then emits a **tiered + capped** set of proposals. The pure
caps/dedup/recurrence-gate logic lives in
`scripts/ci/hydra-retro-emit.ts` (unit-tested in
`test/hydra-retro-emit.test.mts`) — this playbook orchestrates the
signals-first read, the synthesis, and the `gh`/git emit.

> **Safety:** `--audit` (dry-run) is the DEFAULT. The skill NEVER silently
> edits files — the only file-mutation path is a single gated PR, and it only
> runs under `--apply`. Without `--apply` the skill prints the emit plan and
> stops.

## 0. When the autopilot dispatches this (pre-check, issue #3871)

`retro_orch`'s daily trigger used to be a single signal: `retro_run_available`
(a COMPLETED run exists to analyse), enforced once/day by the 24h
`SIGNAL_COOLDOWNS["retro_orch"]`. That was too coarse — a completed run
existing does not mean it has anything worth drilling, and a clean run still
cost a full `/hydra-retro` dispatch (~115k tokens / 28 tool calls, observed on
the 2026-08-05 run `2bcba309`) just to discover the bundle's `reflections` /
`stuckSignals` / `recommendations` were all empty and no dispatch was flagged.

`collect-state.sh` now precomputes a second signal, `retro_run_drillable`, from
the SAME candidate run's retro bundle (`GET /autopilot/runs/:runId/retro`) —
`true` iff any `dispatches[].flagged` is set OR `reflections` /
`stuckSignals` / `recommendations` is non-empty. `decide.py`'s `retro_orch`
selector now dispatches only when **both** `retro_run_available` AND
`retro_run_drillable` are true — a clean run is skipped entirely, for the cost
of one extra HTTP GET instead of a full agent dispatch.

Two correctness backstops, both from 2026-08-19 operator grilling of the
original design:

- **A skipped (non-drillable) turn never stamps the cooldown.** If it did, and
  a *different* run completed an hour later carrying real findings,
  `retro_run_available` would track that newer run while the stale cooldown
  stamp suppressed it for the rest of the 24h window — by which time it is no
  longer the most-recent run and may never be retro'd. Skipping leaves
  `signal_last_fired.retro_orch` untouched.
- **A mandatory weekly override fires regardless of `retro_run_drillable`.**
  The entire savings rest on that predicate staying correct; if it silently
  breaks (a renamed bundle field, a flag that stops being set), "filed no
  findings" and "was never dispatched" look identical from outside, and
  nothing would surface the bug. `decide.py` forces a real dispatch at least
  once every 7 days (`RETRO_ORCH_WEEKLY_OVERRIDE_SEC`) no matter what
  `retro_run_drillable` says — ~115k/week against the ~800k/week the
  pre-check saves, and the only mechanism that turns a silent predicate bug
  into an observable one.

`retro_run_drillable` degrades to `true` (dispatch anyway) on ANY failure of
its own bundle fetch — a down orchestrator, a network error, an empty body, or
unparseable JSON — the OPPOSITE direction from `retro_run_available`
(which degrades to `false`, "nothing to retro"). A wasted dispatch is
recoverable; a silently dark retro loop is not.

None of this changes what happens once `/hydra-retro` actually runs — steps 1
through 9 below are unaffected. It only changes whether the autopilot
dispatches it at all on a given day.

## 1. Resolve the run id

`/hydra-retro [run_id]` — argument is optional. Parse via the pure helper so
`--audit` / `--apply` are honoured and dry-run is the default:

```bash
# parseArgs(args) → { apply, runId? }  (apply defaults to false)
```

If no `run_id` was given, default to the latest **completed** run:

```bash
RUN_ID=$(curl -sf http://localhost:4000/api/autopilot/runs/current | jq -r '.run_id // empty')
# If `current` is still in-flight, walk the index for the most recent
# status=ended run instead — never retro an in-flight run.
```

## 2. Fetch the retro bundle (signals-first)

The bundle is the read-only, never-throw join of the run's lifecycle data
(issue #918). Fetch it once:

```bash
BUNDLE=$(curl -sf "http://localhost:4000/api/autopilot/runs/${RUN_ID}/retro")
```

The bundle already carries the **flagged dispatches** signal — `dispatches[]`
plus the pure `flagDispatchesForDrill` selection (failed QA / stalled / churned
/ errored). The bundle's `reflections[]` are pre-bounded to the flagged subset.
Use those, the `stuckSignals`, the `recommendations`, and the
`frictionPatterns` as the structured inputs; do NOT re-derive them.

If `bundle.errors[]` is non-empty, note the partial-ness in the artifact but
proceed — the bundle is intentionally partial-not-thrown.

## 3. Deep-read ONLY the flagged transcripts

For each flagged dispatch (the ones the bundle flagged for drill), and ONLY
those, read the full transcript:

```bash
curl -sf "http://localhost:4000/api/dispatches/<id>/transcript"
```

This is the cost bound: a clean run flags nothing and reads no transcripts. A
happy-path (merged, regression-free) dispatch is never drilled.

## 4. Synthesise findings

From the flagged transcripts + bundle signals, synthesise candidate findings.
Each finding is one of two kinds:

- **`code`** — a recurring code-level gotcha (a real bug or a brittle seam the
  run tripped on). Routed to a GitHub issue.
- **`prompt`** — a prompt-shaped fix: a skill-lesson edit, a CLAUDE.md /
  CONTEXT.md gotcha note. Routed to the single gated PR (only if it clears the
  recurrence + confidence gates).

Every finding MUST carry a stable, kebab-case **`cue`** matching the friction
store's grammar (so the same gotcha lines up across the friction patterns, the
seen-list, and the recurrence ledger), a one-line `title`, and a `confidence`
in `[0, 1]`.

## 5. Adversarial self-check (drop before emit)

Before ANY emit, adversarially challenge each finding and DROP it if:

- **Speculative** — not grounded in a transcript line, a stuck-signal, or a
  friction-pattern count. "Might be flaky" is not a finding.
- **Duplicate** — already covered by another surviving finding, OR already an
  open / recently-closed GitHub issue (live scan below), OR already in the
  persisted seen-list.

Live duplicate scan (the live half of the dedup contract):

```bash
gh issue list --repo gaberoo322/hydra --state open --json number,title \
  --jq '.[] | "\(.number): \(.title)"'
gh issue list --repo gaberoo322/hydra --state closed --json number,title,closedAt \
  --jq '[.[] | select(.closedAt > (now - 7*24*3600 | todate))] | .[] | "\(.number): \(.title)"'
```

Word-overlap > 50% with an existing title → drop (or comment on the existing
issue instead of filing a new one).

## 6. Bump recurrence, snapshot the ledgers

For every cue OBSERVED this run (whether or not it survives), bump its
cross-run recurrence count once, then snapshot both ledgers for the planner.
Both go through the typed Redis seam `src/redis/retro-seen.ts` — never raw Redis.
Use a tiny `tsx` shim:

```bash
# Bump recurrence for each observed cue, then print {seenCues, recurrence}.
npx tsx -e '
  import { bumpRetroRecurrence, getRetroSeen, getRetroRecurrence } from "./src/redis/retro-seen.ts";
  const cues = JSON.parse(process.env.CUES || "[]");
  for (const c of cues) await bumpRetroRecurrence(c);
  const seen = await getRetroSeen();
  const recurrence = await getRetroRecurrence();
  process.stdout.write(JSON.stringify({ seenCues: Object.keys(seen), recurrence }));
  process.exit(0);
'
```

## 7. Plan the emit (pure, capped, gated)

Hand the surviving findings + the ledger snapshot to the pure planner. It caps
issues at **≤2**, the PR at **≤1**, dedups against the seen-list, and gates the
PR on recurrence ≥3 AND confidence ≥ floor:

```bash
# validateFindings(findings) → []  (hard-stop on any error)
# planEmit(findings, { seenCues: new Set(seenCues), recurrence })
#   → { issues[], pr|null, artifactOnly[], skipped[] }
```

`plan.issues` are the code gotchas to file; `plan.pr` (if non-null) is the
single prompt/doc fix to open as a gated PR; `plan.artifactOnly` + `skipped`
are recorded in the artifact, never emitted.

## 8. Emit (ONLY under --apply)

If `apply === false` (the default), PRINT the plan and STOP — no issues, no PR.

Under `--apply`:

- For each `plan.issues[]`: `gh issue create --repo gaberoo322/hydra --label needs-triage --title <title> --body <evidence + cue + Source>`. Then record the cue in the seen-list:

      npx tsx -e 'import {recordRetroSeen} from "./src/redis/retro-seen.ts"; await recordRetroSeen({cue: process.env.CUE, decision: "issue", runId: process.env.RUN_ID, ref: process.env.REF, at: new Date().toISOString()}); process.exit(0);'

- For `plan.pr` (if non-null): open a feature branch, apply the prompt/doc fix
  (skill lesson / CLAUDE.md / CONTEXT.md note), run `npm run typecheck:test`
  AND `npm test`, then `gh pr create` with `Tier:` populated from
  `GET /api/tier` and a `## Files in scope` mirror. Record the cue in the
  seen-list with `decision: "pr"`. This is the ONLY file-mutation path.

Caps mean at most 2 issues + 1 PR ever leave a single retro run.

## 9. Artifact (always)

Write the persisted retro artifact (issues filed, PR opened, artifact-only
notes, dropped findings + reasons, bundle errors). Under `--audit` this is the
sole output. The dashboard surface for the artifact is retro-4 (#921).

## Summary output

```
[hydra-retro] run <RUN_ID> (apply=<bool>). Flagged <N>/<M> dispatches, drilled <N> transcripts.
  Findings: <C> code, <P> prompt (after adversarial drop of <D>).
  Emitted: <I> issues (cap 2), <pr|none> PR (cap 1, recurrence-gated ≥3).
  Artifact-only: <A>. Deduped (seen-list/live): <S>.
```

## Domain context
- `~/hydra/CONTEXT.md` — canonical vocabulary
- `~/hydra/docs/adr/` — don't contradict existing ADRs
- `src/autopilot/retro-bundle.ts` — the bundle shape this skill consumes (#918)
- `scripts/ci/hydra-retro-emit.ts` — the pure caps/dedup/recurrence logic
- `src/redis/retro-seen.ts` — the seen-list + recurrence Redis seam
- `src/redis/retro-artifacts.ts` — the persisted per-run retro-artifact Redis seam

## Slot lifecycle events — PostToolUse hook (issue #671)

Every tool call inside this skill emits a `subagent_tool_call` event onto the
Redis stream `hydra:autopilot:slot-events`. The classification is done at
emit-time so the /now-pixel dashboard can route on `category` without
re-deriving it from the tool name:

- `milestone` — Write, Edit, MultiEdit, NotebookEdit, MCP write surfaces, and
  Bash matching `^(git commit|gh pr|npm test|npm run build|npm run typecheck)`
- `io` — other Bash, WebFetch, WebSearch, MCP read surfaces
- `background` — Read, Grep, Glob

**Hook script:** `scripts/autopilot/hooks/on-subagent-tool-call.sh`
**Hook registration:** sibling `<this-playbook>.settings.json` →
`~/.claude/skills/<this-skill>/.claude/settings.json` (propagated by
`scripts/sync-skills.sh`)

The hook MUST NEVER propagate errors back to this skill's session — a Redis
outage, a malformed payload, or a missing `jq` all result in a stderr
warning and `exit 0`. See `test/on-subagent-tool-call.test.mts` for the
pinned behavior.
