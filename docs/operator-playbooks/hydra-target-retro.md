---
name: hydra-target-retro
description: Per-run (or daily) Target retrospective — deep-reads failed and reframed Target builds plus subagent friction reports, extracts recurring failure patterns, and files them — capped ≤2/run, deduped — as needs-triage issues on the Target board. NO gated PR, NO tier machinery.
when_to_use: "When the user says 'target retro', 'retro the target', 'analyze target builds', or hydra-autopilot wants to turn completed Target builds into conservative cross-build learning. Invoked as /hydra-target-retro [run_id] (default: latest completed run)."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*) Agent(*)
---

# Hydra Target Retro

## Resolve the Target seam (run this first)

@include _fragments/target-seam-preamble.md

Per-run (or daily) retrospective for the **Target** build loop —
the Target analogue of the Orchestrator's `/hydra-retro`. It deep-reads the
**failed and reframed** Target builds plus the Target executor's **subagent
friction reports**, synthesises recurring failure patterns, runs an
**adversarial self-check** to drop speculative/duplicate findings, then routes
what survives — **capped at ≤2 proposals/run, deduped** — as `needs-triage`
issues on the Target board (`$TARGET_GH_REPO`, ADR-0031 Decision 4). Every
observation is `lane: "backlog"`: the former prompt-shaped `feedback` lane (an
append to Target feedback files) is **retired** — that loop was write-only
(#2962) and the Target has no such files. The pure core's `feedback` lane stays
as unused-but-tested code in `scripts/target/target-retro.ts`; this playbook
never produces it.

The pure caps/dedup/routing logic lives in `scripts/target/target-retro.ts`
(unit-tested in `test/target-retro.test.mts`) — this playbook orchestrates the
deep-read, the synthesis, and the issue filing.

> **What this deliberately does NOT mirror from `/hydra-retro`:** there is **NO
> gated PR lane** and **NO Modification-Tier / Verifier-Core / deep-QA
> remediation / operator-escalation** machinery. The Orchestrator retro's single
> prompt-fix PR rides the tier ladder; the Target does not mirror that ladder
> (epic #1052), so a Target retro files issues and never opens a PR. A Target
> retro only ever PROPOSES — it never gates a merge.

> **Safety:** `--audit` (dry-run) is the DEFAULT. Without `--apply` the skill
> prints the emit plan and stops — no issues filed.

> **Liveness (2026-11):** no autopilot class, cadence or admission line invokes
> this skill today — it runs only when the operator asks. Retiring it (playbook,
> skill, pure core, tests, `src/operator-actions/parity.ts` DOCS_ONLY entry) is
> the cleaner long-run outcome but touches files outside this repair's scope;
> tracked as a follow-up.

## 1. Resolve the run id

`/hydra-target-retro [run_id]` — argument is optional. Parse via the pure helper
so `--audit` / `--apply` are honoured and dry-run is the default:

```bash
# parseArgs(args) → { apply, runId? }  (apply defaults to false)
```

If no `run_id` was given, default to the latest **completed** run:

```bash
RUN_ID=$(curl -sf http://localhost:4000/api/autopilot/runs/current | jq -r '.run_id // empty')
# If `current` is still in-flight, walk the index for the most recent
# status=ended run instead — never retro an in-flight run.
```

## 2. Gather the Target signals (signals-first)

Unlike the Orchestrator retro, the Target has no Modification-Tier retro bundle.
Gather the Target's own lifecycle signals directly:

- **Failed / reframed builds** — the `reframe` label on the Target board is the
  failure ledger (`hydra-target-qa` bounces hard findings to it, and the build
  loop's scope-gate reframe writes it). Read it over REST, never GraphQL:

  ```bash
  SINCE=$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ)   # or the run's start time
  gh api -X GET "repos/$TARGET_GH_REPO/issues" -f labels=reframe -f state=all -f since="$SINCE" \
    --jq '.[] | "#\(.number) \(.state) \(.title)"'
  ```

- **Subagent friction reports** — a FIRST-CLASS input, not a parallel
  mechanism. The Target executor's soft-friction patterns live under the
  friction store key `hydra:friction:<skill>:patterns` (the same store
  `hydra-target-build` emits its `## Friction Report` items into). Read them via
  the typed agent-memory seam — never raw Redis from `src/`:

  ```bash
  # The friction namespace shares schema with agent-memory; read it through
  # src/redis/agent-memory.ts (namespace="friction"), not redis/keys directly.
  npx tsx -e '
    import { loadPatternsRaw } from "./src/redis/agent-memory.ts";
    const raw = await loadPatternsRaw("hydra-target-build", "friction");
    process.stdout.write(raw ?? "[]");
    process.exit(0);
  '
  ```

Fold BOTH sources into a single observation list for synthesis — a recurring
friction cue and a transcript-derived gotcha compete on the same cue key.

## 3. Deep-read ONLY the failed / reframed transcripts

For each failed or reframed build (and ONLY those), read the full transcript so
synthesis is grounded in real lines, not speculation:

```bash
curl -sf "http://localhost:4000/api/dispatches/<id>/transcript"
```

This is the cost bound: a clean Target run (no reframes, no recurring friction)
reads no transcripts and emits nothing. A merged, regression-free build is never
drilled.

## 4. Synthesise observations

From the failed/reframed transcripts + the friction patterns, synthesise
candidate observations, each `lane: "backlog"` (see
`scripts/target/target-retro.ts` for the exact `RetroObservation` shape):

- **`backlog`** — the only lane. A code-needing finding (a real bug or brittle
  seam), or a recurring planner/executor gotcha worth a tracked fix. Filed as a
  `needs-triage` issue on `$TARGET_GH_REPO`. (The `feedback` lane is retired.)

Every observation MUST carry a stable, kebab-case **`cue`** matching the
friction-store grammar (so a friction-pattern twin and a transcript gotcha line
up on the same dedup key), a one-line `title`, and a `source` of `transcript`
or `friction` (recorded for the artifact; routing does NOT depend on it).

## 5. Adversarial self-check (drop before emit)

Before ANY emit, adversarially challenge each observation and DROP it if:

- **Speculative** — not grounded in a transcript line or a friction-pattern
  count. "Might be flaky" is not a finding.
- **Duplicate** — already covered by another surviving observation, OR already
  an open issue on the Target board, OR
  already in the persisted seen-list (snapshotted in step 6).

Live duplicate scan (REST, never `gh --json` / GraphQL):

```bash
gh api -X GET search/issues -f q="repo:$TARGET_GH_REPO is:issue is:open" \
  --jq '.items[] | "\(.number): \(.title)"'
```

Word-overlap > 50% with an existing issue → drop.

## 6. Snapshot the seen-list

Snapshot the cross-run dedup ledger (the cues a prior Target retro already
emitted) so the pure planner can hard-skip re-proposals. Reuse the retro seen
seam:

```bash
SEEN=$(npx tsx -e '
  import { getRetroSeen } from "./src/redis/retro-seen.ts";
  const seen = await getRetroSeen();
  process.stdout.write(JSON.stringify(Object.keys(seen)));
  process.exit(0);
')
```

## 7. Plan the emit (pure, capped)

Hand the surviving observations + the seen-list snapshot to the pure planner. It
caps proposals at **≤2 total** (a single shared budget), dedups against the
seen-list, and routes each survivor to its declared lane (always `backlog`):

```bash
# validateObservations(observations) → []  (hard-stop on any error)
# planTargetRetro(observations, { seenCues: new Set(seenCues) })
#   → { feedback[], backlog[], artifactOnly[], skipped[] }
```

`plan.backlog` are the issues to file (`plan.feedback` is always empty here);
`plan.artifactOnly` (over the shared cap) +
`plan.skipped` (deduped) are recorded in the artifact, never emitted.

## 8. Emit (ONLY under --apply)

If `apply === false` (the default), PRINT the plan and STOP — no edits, no items.

Under `--apply`, for each `plan.backlog[]` file one issue on the Target board
(dedup was done in step 5):

    gh issue create --repo "$TARGET_GH_REPO" --label needs-triage \
      --title "$TITLE" --body "$DESC"

Then record the cue in the shared seen-list with `decision: "issue"` (the
Target's issue-shaped lane), `ref` set to the created issue number:

    npx tsx -e 'import {recordRetroSeen} from "./src/redis/retro-seen.ts"; await recordRetroSeen({cue: process.env.CUE, decision: "issue", runId: process.env.RUN_ID, ref: process.env.REF, at: new Date().toISOString()}); process.exit(0);'

The shared cap means at most 2 issues ever leave a single Target retro run.

## 9. Artifact (always)

Write the persisted retro artifact (issues filed, artifact-only notes, dropped
findings + reasons). Under `--audit`
this is the sole output.

## Summary output

```
[hydra-target-retro] run <RUN_ID> (apply=<bool>). Reframed/failed <N> builds, drilled <N> transcripts, folded <F> friction patterns.
  Observations: <B> backlog (after adversarial drop of <D>).
  Emitted: <BE> Target-board issues (shared cap 2).
  Artifact-only (over cap): <A>. Deduped (seen-list/live): <S>.
```

## Domain context
- `~/hydra/CONTEXT.md` — canonical vocabulary
- `~/hydra/docs/adr/` — don't contradict existing ADRs
- `scripts/target/target-retro.ts` — the pure caps/dedup/routing core this skill consumes
- `scripts/ci/hydra-retro-emit.ts` — the Orchestrator retro this one is the Target analogue of
- `src/redis/retro-seen.ts` — the seen-list seam (shared with the Orchestrator retro)
- `src/redis/agent-memory.ts` — the friction-store read seam (`namespace="friction"`)
- Target work is GitHub Issues on `$TARGET_GH_REPO` (ADR-0031); the Redis backlog subsystem is deleted
- `docs/operator-playbooks/hydra-target-build.md` — the build loop whose failures this retro learns from

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
