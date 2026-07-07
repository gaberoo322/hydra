---
name: hydra-retro
disable_model_invocation: true
description: Per-run retrospective that deep-reads flagged transcripts, self-checks against duplicates, and emits a small capped set of conservative improvement proposals.
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
