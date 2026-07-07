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
5. **Fetch the knowledge context** (see "Knowledge context" below) and weave it in.
6. Grep/read the source for context, then implement — touching out-of-scope
   files only with a `scope-justification:` block in the PR body.
7. **Declare glossary/ADR impact** — per `docs/agents/domain.md`, add a
   `Glossary impact:` / `ADR impact:` line to the PR body for any term resolved
   or decision made. Do NOT edit `CONTEXT.md` in the code PR — that delta lands
   in a separate `ubiquitous-language`-labelled PR.
8. Run `npm test` + `npm run typecheck` + `npm run build`.
8a. **MANDATORY — deposit the grounding test-count telemetry file** (issue
   #2754). Immediately after `npm test` passes, run the grounding-deposit recipe
   in "Reflection injection" below. Best-effort on I/O error but mandatory.
9. **Classify the change via the live tier API** (see "Tier classification"
   below). Never self-classify by path patterns.
9a. **Reconcile the diff against the design-concept artifact BEFORE opening the
   PR** (issue #2537). If an artifact was fetched at planning time, run the
   "Design-concept reconciliation gate" below: cite the diff hunk that satisfies
   each invariant; for each MUST-NOT invariant confirm the diff does not
   introduce the forbidden behavior. If ANY invariant cannot be satisfied, do
   NOT open the PR — emit a `## Friction Report` naming the unmet invariant and
   stop. A 404 at planning time makes this a clean no-op.
10. Open a PR with `closes #$issue_number`, a `## Files in scope` mirror of the
    issue's section, and a `Tier: <0|1|2|3>` line from the API. Acceptance
    criteria MUST be checkboxes with a mechanical "verified by:" assertion —
    each names the exact command or observable output a reviewer can check:
    ```
    - [ ] Criterion A — verified by: `npm test -- --test-name-pattern "criterion-A"` exits 0
    - [ ] Criterion B — verified by: `curl -s http://localhost:4000/api/foo | jq '.status'` returns "ok"
    - [ ] Criterion C — verified by: `git diff --name-only origin/master...HEAD` includes path/to/file.ts
    ```
    Prose-only criteria are rejected by QA.
11. Return: PR URL + summary table, then emit the `## Friction Report` (see below).

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
REFL_JSON=$(curl -sf --max-time 5 \
  "http://localhost:4000/api/reflections?anchor=$(printf '%s' "$ANCHOR_REF" | jq -sRr @uri)&files=$(printf '%s' "$FILES_CSV" | jq -sRr @uri)")
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

## Knowledge context — live API (issue #2647)

At the same planning-time seam, fetch the agent-scoped learned patterns and weave
them in. **Endpoint:** `GET /api/learning/knowledge?agent=hydra-dev&anchor=<ref>`.
Response `{ agent, content, itemCount }`; `content` is prompt-ready markdown,
`itemCount: 0` is a no-op. Use THIS route, NOT `/api/learning/context-trace`
(counts-only, omits `.content`). This route serves the content, records the
per-cycle availability metric server-side, and appends a knowledge-retrieval
ledger row (issue #2717) on its success path.
```bash
KB_JSON=$(curl -sf --max-time 5 \
  "http://localhost:4000/api/learning/knowledge?agent=hydra-dev&anchor=$(printf '%s' "$ANCHOR_REF" | jq -sRr @uri)")
KB_CONTENT=$(printf '%s' "$KB_JSON" | jq -r '.content // ""')
[ -n "$KB_CONTENT" ] && printf '%s\n' "$KB_CONTENT"  # prepend learned patterns to plan
# Empty / unreachable → graceful no-op.
```

## Design-concept artifact — live API (cue: design-concept-endpoint-path-plural)

A grilled anchor carries a **design-concept artifact**. When the dispatch prompt
references one, fetch it at planning time.
**Endpoint:** `GET /api/design-concepts/<anchor.reference>` — **plural** resource
name, anchor ref as a **path param** (e.g. `/api/design-concepts/issue-1699`).
There is no `/api/design-concept` route and no `?anchor=` query form. Response
(200): the artifact fields at the **top level** plus a `gate` sub-object — there
is NO `.concept` envelope, read `.invariants` directly. 404 → no artifact; do not
retry alternate spellings.

**Design-concept reconciliation gate (issue #2537 — MANDATORY pre-PR step when an
artifact was fetched).** Run as child-step 9a — AFTER the change is committed and
tier-classified, BEFORE `gh pr create`:
1. Re-read the `invariants` array from the artifact (`.invariants` directly).
2. For EACH invariant, cite the concrete evidence it holds — the diff hunk
   (`git diff origin/master...HEAD`), a test name, or command output. For each
   MUST-NOT / negative invariant, confirm the diff does not introduce the
   forbidden behavior.
3. Mirror the "verified by:" framing: each invariant pairs with a mechanical check.
4. **If ANY invariant cannot be satisfied, do NOT open the PR.** Emit a
   `## Friction Report` naming the unmet invariant and stop.
5. A 404 at planning time makes this a clean no-op — proceed to `gh pr create`.

Include the reconciliation summary in the PR body so QA can re-verify it.

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
TIER_JSON=$(curl -sf --max-time 5 \
  "http://localhost:4000/api/tier?files=$(printf '%s' "$CHANGED" | jq -sRr @uri)")
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
