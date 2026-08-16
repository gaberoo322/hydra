# hydra-dev — CHILD execution contract (in-worktree implementation)

You reached this file because you are the **CHILD**: dispatched into a fresh
worktree with NO `Agent`/`Task` spawn tool (the autopilot inline-dispatch case).
The dispatcher already selected your issue, prepended the worktree-guard /
path-anchoring / EnterWorktree / scope-respect preambles, and placed you in the
worktree. Do NOT spawn another agent; do NOT re-select or re-label the issue.
Run these numbered steps.

## The child execution contract

1. **Verify isolation** — `pwd` + `git rev-parse --git-dir` under `.git/worktrees/`.
   Abort loudly if cwd is `/home/gabe/hydra` (never fall back to the main tree).
2. Read CLAUDE.md / AGENTS.md, CONTEXT.md, relevant ADRs.
3. Extract the `## Files in scope` + `## Files out of scope` lists from the issue body.
4. **Fetch per-anchor Reflections via the live API** (see "Reflection injection"
   below) and weave any returned narrative into your implementation plan. Never
   skip — a retry of a prior-failure anchor depends on it.
4a. **MANDATORY — deposit the reflection-source telemetry file AND the anchor
   deposit** (issue #1136/#1912/#2112). Immediately after the step-4 fetch, run
   the deposit recipe in "Reflection injection" below. It writes
   `${HYDRA_AUTOPILOT_REFL_DIR:-/tmp}/hydra-refl-sources-<task_id>` so `reap.py`
   can stamp the `reflectionMatchSource` metric, AND
   `${HYDRA_AUTOPILOT_REFL_DIR:-/tmp}/hydra-refl-anchor-<task_id>` so `reap.py`
   can fire the per-anchor reflection PRODUCER on a non-merged failure. NOT
   optional and NOT conditional on reflections being served — ALWAYS run it. The
   deposit is best-effort on I/O error but the step is mandatory.
5. Grep/read the source for context, then implement — touching out-of-scope
   files only with a `scope-justification:` block in the PR body. Follow the
   upstream `implement` cadence (Pocock v1.1): use **TDD at pre-agreed seams**
   where practical — **red before green, one slice at a time** (the `tdd` skill
   is reference-only in v1.1: refactoring is NOT part of the loop, it belongs in
   review) — and run `npm run typecheck` plus **single test files**
   (`node --test --test-force-exit test/<name>.test.mts`) **regularly as you go**,
   reserving the full `npm test` sweep for step 8.
6. **Declare glossary/ADR impact** — per `docs/agents/domain.md`, add a
   `Glossary impact:` / `ADR impact:` line to the PR body for any term resolved
   or decision made. Do NOT edit `CONTEXT.md` in the code PR — that delta lands
   in a separate `ubiquitous-language`-labelled PR.
7. Run `npm test` + `npm run typecheck` + `npm run build`.
8a. **MANDATORY — deposit the grounding test-count telemetry file** (issue
   #2754). Immediately after `npm test` passes, run the grounding-deposit recipe
   in "Reflection injection" below. Best-effort on I/O error but mandatory.
8b. **Author a changelog fragment (or opt out) BEFORE tier classification** (issue
    #3658, epic #3676). This MUST run before step 9 so the `.changelog/<issue>-<slug>.md`
    file is part of the diff the tier classifier reads. If the change ships anything
    user- or operator-visible, write **one** file `.changelog/<issue>-<slug>.md` —
    `<issue>` is the issue this PR closes, `<slug>` a short kebab-case description —
    whose sole line is a curated, imperative, user-facing note (NOT the issue title):
    ```
    - <type>: <description> (#<issue>)
    ```
    `<type>` is a Conventional-Commits type (`feat`/`fix`/`perf`/`refactor`/
    `docs`/`test`/`build`/`ci`/`chore`/`revert`); the dashboard groups by type at
    render time and links the note to the issue. Commit the fragment with your
    change. For a genuinely user-invisible change (pure chore, test-only, internal
    refactor with no observable effect) apply the **`skip-changelog`** label to the
    PR instead of adding an empty fragment. There is no committed `CHANGELOG.md`;
    per-PR fragment files are conflict-free across parallel PRs. Full convention:
    `.changelog/README.md`. The advisory `changelog-check.yml` workflow posts a
    non-blocking sticky comment when a PR adds no fragment and lacks the label — it
    never blocks merge.
8. **Classify the change via the live tier API** (see "Tier classification"
   below). Never self-classify by path patterns.
9a. **Reconcile the diff against the design-concept artifact BEFORE opening
   the PR** (issues #2537, #2528). ALWAYS fetch it first — run the one-liner
   in "Design-concept artifact — live API" below unconditionally, even when
   the dispatch prompt referenced no artifact and the issue went straight to
   `ready-for-agent`. The RESPONSE decides — not your memory of planning and
   not the issue's labels: non-empty → run the "Design-concept
   reconciliation gate" below and write its section into the PR body; empty
   (404 or unreachable orchestrator) → clean no-op. This is **mechanically
   enforced inside the REQUIRED `test` job** — the gate re-fetches the
   artifact for your `Closes #N` anchor whether or not you did, so a
   missing, miscounted, misquoted or falsified entry fails `npm test` and
   blocks auto-merge. If ANY invariant cannot be satisfied, do NOT open the
   PR — emit a `## Friction Report` naming the unmet invariant and stop.
9. Open a PR with `closes #$issue_number`, a `## Files in scope` mirror of the
    issue's section, and a `Tier: <0|1|2|3>` line from the API. Acceptance
    criteria MUST be checkboxes with a mechanical "verified by:" assertion —
    each names the exact command or observable output a reviewer can check:
    ```
    - [ ] Criterion A — verified by: `npm test -- --test-name-pattern "criterion-A"` exits 0
    - [ ] Criterion B — verified by: `curl -s http://localhost:4000/api/foo | jq '.status'` returns "ok"
    - [ ] Criterion C — verified by: `git diff --name-only origin/master...HEAD` includes path/to/file.ts
    ```
    Prose-only criteria are rejected by QA.
10. Return: PR URL + summary table, then emit the `## Friction Report` (see below).

## Reflection injection — live API (issue #841)

A prior **failed** attempt on the same anchor (or, post-#326, a different anchor
that touched the same files) leaves a per-anchor **Reflection** — "what was
attempted, why it failed, what to change". Fetch it at planning time and weave it
into the plan. The endpoint composes the per-anchor + by-file reads server-side.

**Endpoint:** `GET /api/reflections?anchor=<anchor.reference>&files=<csv>`.
Response `{ anchor, formatted, count, blocks: [{source, count}] }`. `formatted`
is prompt-ready markdown; `count: 0` / `formatted: ""` is a clean no-op.

**Fetch recipe (planning time, before writing code):**
```bash
# ANCHOR_REF is anchor.reference, e.g. "issue-841". FILES_CSV is the
# `## Files in scope` list, comma-separated.
# Guard-compatible form (issue #3896): the worktree-isolation Bash guard refuses
# nested command substitution `$( ... $(...) ...)`. URL-encode each query value
# into a plain variable first, then interpolate into the curl URL.
ANCHOR_ENC=$(printf '%s' "$ANCHOR_REF" | jq -sRr @uri)
FILES_ENC=$(printf '%s' "$FILES_CSV" | jq -sRr @uri)
REFL_JSON=$(curl -sf --max-time 5 \
  "http://localhost:4000/api/reflections?anchor=${ANCHOR_ENC}&files=${FILES_ENC}")
REFL_FORMATTED=$(printf '%s' "$REFL_JSON" | jq -r '.formatted // ""')
[ -n "$REFL_FORMATTED" ] && printf '%s\n' "$REFL_FORMATTED"  # prepend to plan; do NOT repeat prior approach
# Empty / unreachable → graceful no-op. Never fail the dispatch over a miss.
```

**Reflection-source + anchor telemetry deposit (issue #1136/#1912/#2112 —
MANDATORY, child-step 4a).** The deposit key-derivation (#1945: derive the
harness `task_id` from the `agent-<HASH>` worktree cwd, not env vars) and the
unconditional anchor deposit (#2112) now live in the deterministic helper
`scripts/reflection-deposit.sh` — run it right after the step-4 fetch. reap.py
reads the deposit on its single authoritative `cycle-record` write; do NOT POST
`cycle-record` yourself (reap is the sole writer):
```bash
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || printf '%s' "$PWD")"
bash "$REPO_ROOT/scripts/reflection-deposit.sh" reflect "hydra-dev" "$ANCHOR_REF" "$REFL_JSON"
```

**Grounding test-count deposit (issue #2754 — MANDATORY, child-step 8a, right
after `npm test` passes).** The helper runs `npm test`, parses the node:test
footer, and deposits `hydra-grounding-tests-<task_id>` (`testsAfter` /
`testsPassingAfter`) keyed on the SAME harness `task_id`. Best-effort:
```bash
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || printf '%s' "$PWD")"
bash "$REPO_ROOT/scripts/reflection-deposit.sh" grounding "hydra-dev"
```

**Reap-time deposit-presence diagnostic (issue #2020).** A
`reflectionMatchSource` of `'none'` is ambiguous; `reap.py completion` stamps
`refl_presence=<token>` (`deposit-absent` / `deposit-empty` / `deposit-present` /
`read-error` / `no-task-id`) on the `slot_complete` log line so an honest none
(nothing served → nothing deposited) is distinguishable from a false none (the
#1945-shaped plumbing failure). Verify reflections-reach-retry with
`/api/reflections`, NOT `/api/learning/context-trace` (the latter reports
composition, not delivery).

## Design-concept artifact — live API (cue: design-concept-endpoint-path-plural)

A grilled anchor carries a **design-concept artifact**. Fetch it UNCONDITIONALLY
— at planning time and again at step 9a — whether or not the dispatch prompt
referenced one: existence is not visible from the issue's labels (an issue that
went straight to `ready-for-agent` can still carry one), and the reconciliation
gate fetches unconditionally, so an unfetched artifact is not a no-op — it is a
future red required job. Exact one-liner, so there is nothing to improvise:
```bash
DC_JSON=$(curl -sf --max-time 5 "http://localhost:4000/api/design-concepts/${ANCHOR_REF}" || echo '')
# empty  -> 404 or unreachable: genuine clean no-op, say so in the PR body
# non-empty -> you MUST reconcile every .invariants[] entry and cite .artifactHash
```
**Endpoint:** `GET /api/design-concepts/<anchor.reference>` — **plural** resource
name, anchor ref as a **path param** (e.g. `/api/design-concepts/issue-1699`).
There is no `/api/design-concept` route and no `?anchor=` query form. Response
(200): the artifact fields at the **top level** plus a `gate` sub-object — there
is NO `.concept` envelope, read `.invariants` directly. 404 → no artifact; do not
retry alternate spellings.

**Design-concept reconciliation gate (issues #2537, #2528 — MANDATORY pre-PR
step; the fetch above decides whether there is anything to reconcile).** Run as
child-step 9a — AFTER the change is committed and tier-classified, BEFORE
`gh pr create`. **Mechanical, not advisory:**
`test/design-concept-reconcile-check.test.mts` runs in the REQUIRED `test` job,
re-fetches the artifact for your `Closes #N` anchor — regardless of whether you
fetched — and re-executes every assertion you declare. "Not applicable" is
only ever valid for a 404 (or unreachable-orchestrator) response, never for
"I did not fetch": an artifact can exist for an anchor whose issue went straight to
`ready-for-agent`, and asserting N/A while one exists produces
`missing-artifact-hash`, `entry-count-mismatch`, and one `missing-entry` per
invariant — the most expensive possible way to be wrong, because the gate reads
the PR body from the webhook payload and clearing it needs a NEW COMMIT, not a
body edit.

Write this into the PR body as a TOP-LEVEL `##` heading, never nested inside
`## Files in scope` (`scope-check` reads that section to the next heading and
would swallow these backticked paths as scope entries):

```
## Design-concept reconciliation

Artifact: `<first 12+ chars of .artifactHash>`

- INV-1: "<verbatim prefix of invariants[0], >=16 chars>" — verified by: `file-contains: src/x.ts :: doThing(`
- INV-2: "<verbatim prefix of invariants[1]>" — verified by: `file-lacks: src/api.ts :: pruneIndex(`
```

Rules: one `INV-<n>` bullet per invariant (count must match); the quote must be
a verbatim whitespace-normalised **prefix** of that invariant (paraphrase
fails); the cited hash must prefix the live `artifactHash`; and an invariant
containing **MUST NOT / MUST NEVER cannot be discharged with `manual:` prose**.
The `INV-<n>` label may optionally be wrapped in Markdown emphasis —
`**INV-1**`, `*INV-2*`, `__INV-3__` all parse identically to the plain
`INV-1` form shown above (issue #4037); the bullet-marker anchor still means a
mid-sentence mention of "INV-1" elsewhere in a bullet's prose is never
mistaken for a label.

Assertion grammar (Node-stdlib only, evaluated against the tree at HEAD — never
`git diff`; the `test` job checks out at depth 1): `file-exists: <path>` ·
`file-absent: <path>` · `file-contains: <path> :: <literal>` ·
`file-lacks: <path> :: <literal>` · `file-matches: <path> :: /<re>/<flags>` ·
`file-not-matches: <path> :: /<re>/<flags>` ·
`occurrences: <path> :: <literal> == <n>` (also `<=`, `>=`) · `manual: <prose>`
(positive invariants only). `file-lacks` / `file-not-matches` FAIL on a missing
file — never a vacuous pass.

**If ANY invariant cannot be satisfied, do NOT open the PR**: emit a
`## Friction Report` naming the unmet invariant and stop. A 404 (or an
unreachable orchestrator) RESPONSE is the clean no-op — "I did not fetch"
never is. The gate fails OPEN on transport misses (no artifact, orchestrator
unreachable) so it never reddens on downtime.

## Tier classification — live API (issue #406)

The service exposes a deterministic classifier at
`GET http://localhost:4000/api/tier?files=<comma-separated repo-relative paths>`.
Call it with the exact files you changed and use the returned `tier` verbatim.
Never infer tier from path patterns. Response (200):
`{ "tier": 0|1|2|3, "reason": "<string>", "perFile": [...] }`; (400) missing-files.
```bash
# After committing on the feature branch, before opening the PR. Diff against
# origin/master, never local master (the shared gitdir's local master goes stale
# as sibling PRs merge; cue: stale-local-master-ref).
git fetch origin --quiet
CHANGED=$(git diff --name-only origin/master...HEAD | paste -sd, -)
# Guard-compatible form (issue #3896): encode CHANGED into a plain variable first
# to avoid nested `$( ... $(...) ...)` in the curl URL.
CHANGED_ENC=$(printf '%s' "$CHANGED" | jq -sRr @uri)
TIER_JSON=$(curl -sf --max-time 5 \
  "http://localhost:4000/api/tier?files=${CHANGED_ENC}")
if [ -z "$TIER_JSON" ]; then
  TIER_LINE="Tier: unknown (live classifier unreachable; needs operator triage)"
  TIER_LABEL_FLAG="--label needs-triage"
else
  TIER_VALUE=$(printf '%s' "$TIER_JSON" | jq -r '.tier')
  TIER_REASON=$(printf '%s' "$TIER_JSON" | jq -r '.reason')
  TIER_LINE="Tier: ${TIER_VALUE} (${TIER_REASON})"
  TIER_LABEL_FLAG=""
fi
```
`gh pr create` MUST include `$TIER_LINE` as its own line (near the top, starting
`Tier:`) and pass `$TIER_LABEL_FLAG` so an unreachable classifier yields a
`needs-triage` label, not a silently-wrong tier. GET not POST — `src/api/tier.ts`
reads `req.query.files`; a POST body returns 400. The authoritative logic is
`src/tier-classifier.ts` (the only source the CI merge gate consults) — a
self-asserted tier that disagrees wastes a QA cycle.

## Friction Report (issue #512 — ALWAYS, even on success)

Emit a `## Friction Report` at the bottom of your return describing each piece of
soft friction you worked around, so the next dispatch doesn't re-discover it:
```markdown
## Friction Report

- cue: stale-local-master-ref
  workaround: used origin/master for diff base instead of master
  context: git rev-parse origin/master
```
Rules: `cue` MUST be kebab-case and stable across runs (NOT free text);
`workaround` and `context` are exactly one line each. No friction worth noting →
emit `## Friction Report` with the literal body `- (none)`.

## Critical test/verification rules

- **Run tests via `npm test`, or `--test-force-exit` for a single file. NEVER a
  bare `node --test <file>`** — orchestrator modules keep a long-lived ioredis
  connection + scheduler timeout alive, so `node:test` hangs forever after the
  assertions pass (froze an 11h autopilot session, 2026-05-28). `npm test`
  already includes `--test-force-exit`; for a subset use
  `node --test --test-force-exit <file>`.
- **To identify WHICH test failed in one run, use `npm run test:debug`, never
  re-run + grep** (issue #1076). The default reporter buffers stdout and
  force-exit tears down before the per-test `not ok` lines flush. `test:debug`
  keeps the same flags plus a `tap → test-debug.tap` sink; read the `not ok`
  lines out of `test-debug.tap`. Do NOT edit the `test` script (CI greps its
  footer for the `MIN_TESTS` ratchet).
