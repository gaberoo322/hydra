/**
 * The typed operator-action registry (issue #4620, ADR-0034 §8.2 — slice 1 of
 * the guidance-epic #4619). Serves one recommended + two alternative
 * `Action`s per admission line, read-only, at `GET /api/operator-actions`
 * (`src/api/operator-actions.ts`).
 *
 * # Fail-loud contract
 *
 * `RAW_ENTRIES` is declared `satisfies readonly OperatorActionEntryInput[]`
 * (shape-checked at compile time) and then run through {@link validateRegistry}
 * at module top level to produce `REGISTRY`. A malformed table — a bad key, a
 * `.strict()` violation, a duplicate `(key, variant)` slot — throws
 * `InvariantViolationError` (`code: "invariant-violation"`) and the module
 * never finishes loading. This mirrors `src/taxonomy/classes.ts`'s
 * fail-loud-at-import precedent: no fallback row set exists, because a silent
 * fallback would hide exactly the drift this registry exists to catch.
 *
 * # Drift assertions (a) and (d) — issue #4620 acceptance criteria
 *
 * {@link missingDefaultLines} and {@link outOfContextPlaceholders} are pure
 * helpers `test/operator-actions-registry.test.mts` drives against both the
 * real `REGISTRY` (expect `[]`) and synthetic fixtures (expect the offending
 * key/placeholder). They are TEST-ONLY assertions, not boot checks — the
 * `#4620` design-concept artifact deliberately keeps import-time validation to
 * schema shape only, so a bad line/placeholder reddens the required `test`
 * job rather than crashing the running service.
 *
 * # Scope
 *
 * This slice ships a DEFAULT entry (no `variant`) for every one of the 18
 * `<bucket>:<line>` admission lines in `BUCKET_LINES` (`src/schemas/operator-actions.ts`).
 * The `class:<name>` namespace is admitted by the schema but ships ZERO
 * entries here — slice 17 authors those against a `classes.json` name pin.
 * Variant entries (`triage-origin`, `dev-failure`, …) are also a later slice
 * (driven by `/hydra-review`'s own classification, plus the composer's
 * mechanical detection) — this slice's default entries are what renders when
 * no variant has been detected.
 *
 * Every `in-dashboard` `route` below names a write route that exists on
 * master TODAY (verified against `src/api/autopilot-control.ts` and
 * `src/api/scheduler.ts`); every other admission line hands off to a terminal
 * skill (`/hydra-review`, `/hydra-hitl-grill`, `/hydra-retro`, or a plain `gh`
 * read) per the issue #4420 resolution: recommend the mechanical action where
 * one exists today, otherwise recommend the operator-cockpit hand-off.
 */

import { InvariantViolationError } from "../errors.ts";
import {
  ADMISSION_LINE_KEYS,
  BUCKET_CONTEXT,
  bucketOfKey,
  OperatorActionRegistrySchema,
  type Action,
  type OperatorActionEntry,
  type OperatorActionEntryInput,
} from "../schemas/operator-actions.ts";

// ---------------------------------------------------------------------------
// Validation (fail-loud at import)
// ---------------------------------------------------------------------------

/**
 * Pure validator: runs the registry array schema's `safeParse` (which also
 * rejects a duplicate `(key, variant ?? "default")` slot via its
 * `superRefine` — see `src/schemas/operator-actions.ts`). Throws
 * `InvariantViolationError` summarising every zod issue on failure; returns
 * the frozen, validated array on success. Exported so tests can drive it
 * against synthetic malformed fixtures without touching the shipped table.
 */
export function validateRegistry(
  entries: readonly OperatorActionEntryInput[],
): readonly OperatorActionEntry[] {
  const parsed = OperatorActionRegistrySchema.safeParse(entries);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new InvariantViolationError(
      `operator-action registry (src/operator-actions/registry.ts) failed validation: ${issues} — no fallback row set exists (issue #4620)`,
    );
  }
  return Object.freeze(parsed.data) as readonly OperatorActionEntry[];
}

// ---------------------------------------------------------------------------
// Template-placeholder extraction
// ---------------------------------------------------------------------------

const PLACEHOLDER_PATTERN = /\{([a-zA-Z0-9_]+)\}/g;

/** Every `{name}` placeholder in a template string, in appearance order
 * (duplicates included — the caller only cares which names appear). */
function extractPlaceholders(template: string): string[] {
  const out: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
    out.push(match[1]);
  }
  return out;
}

/** The template fields a single Action carries: `command` on `terminal-skill`,
 * `route` on `in-dashboard`. Every other kind carries no template field. */
function templateFieldsOf(action: Action): string[] {
  if (action.kind === "terminal-skill") return [action.command];
  if (action.kind === "in-dashboard") return [action.route];
  return [];
}

// ---------------------------------------------------------------------------
// Drift assertion helpers (a) and (d) — issue #4620 acceptance criteria
// ---------------------------------------------------------------------------

/**
 * Assertion (a): every admission line (every `<bucket>:<line>` in
 * `ADMISSION_LINE_KEYS`) has a default entry — one with no `variant`.
 * Returns the admission-line keys missing one; `[]` means the registry is
 * complete. `class:*` keys are never admission lines and are never checked.
 */
export function missingDefaultLines(
  entries: readonly OperatorActionEntry[],
): string[] {
  const defaultKeys = new Set(
    entries.filter((entry) => entry.variant === undefined).map((entry) => entry.key),
  );
  return ADMISSION_LINE_KEYS.filter((key) => !defaultKeys.has(key));
}

/**
 * Assertion (d): every `{name}` placeholder used in a template field
 * (`command` / `route`) of every entry's `recommended` + both `alternatives`
 * must be in that entry's bucket's closed context set (`BUCKET_CONTEXT`).
 * Returns one `{key, placeholder}` row per violation; `[]` means every
 * template stays inside its bucket's context.
 */
export function outOfContextPlaceholders(
  entries: readonly OperatorActionEntry[],
): { key: string; placeholder: string }[] {
  const out: { key: string; placeholder: string }[] = [];
  for (const entry of entries) {
    const bucket = bucketOfKey(entry.key);
    const allowed = bucket ? BUCKET_CONTEXT[bucket] : [];
    // NOTE: deliberately NOT `[entry.recommended, ...entry.alternatives]` —
    // spreading this 2-tuple (of the six-member Action discriminated union)
    // into an array literal makes tsc infer `unknown[]` instead of
    // `Action[]` (a tuple-spread-widening quirk verified in isolation against
    // this exact schema shape). Indexing the tuple directly keeps the type.
    const actions: Action[] = [
      entry.recommended,
      entry.alternatives[0],
      entry.alternatives[1],
    ];
    for (const action of actions) {
      for (const template of templateFieldsOf(action)) {
        for (const placeholder of extractPlaceholders(template)) {
          if (!allowed.includes(placeholder)) {
            out.push({ key: entry.key, placeholder });
          }
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The shipped table — one default entry per admission line
// ---------------------------------------------------------------------------

const HYDRA_REVIEW_DOC = "docs/operator-playbooks/hydra-review.md";
const HITL_GRILL_DOC = "docs/operator-playbooks/hydra-hitl-grill.md";
const REFERENCE_DOC = "docs/reference.md";

const RAW_ENTRIES = [
  // --- machine-stopped (rank 0, aggregate, context {}) ----------------------
  {
    key: "machine-stopped:paused",
    recommended: {
      kind: "in-dashboard",
      route: "/autopilot/paused",
      method: "POST",
      confirmTier: "confirm-first",
      label: "Resume autopilot",
      preconditions: ["confirm the reason autopilot was paused no longer applies"],
      consequence: "clears reasons.paused so the Pace Gate dispatches again",
    },
    alternatives: [
      {
        kind: "terminal-skill",
        command: "/hydra-review",
        label: "Review attention items first",
        preconditions: [],
        consequence: "walks pending decision items while autopilot stays paused",
      },
      {
        kind: "terminal-skill",
        command: "journalctl --user -u hydra-orchestrator.service -n 200 --no-pager",
        label: "Inspect recent logs before resuming",
        preconditions: [],
        consequence: "shows what the service did right before the pause, without changing any state",
      },
    ],
    rationale:
      "reasons.paused is the operator kill switch — stopping the service alone does not clear it (memory: autopilot_paused_killswitch), so the only mechanical fix is the same POST /api/autopilot/paused route the operator used to set it.",
    doc: REFERENCE_DOC,
  },
  {
    key: "machine-stopped:session-blocked",
    recommended: {
      kind: "terminal-skill",
      command: "/hydra-review",
      label: "Review while the quota window is active",
      preconditions: [],
      consequence: "surfaces other attention items during the block; no route clears sessionBlockedUntil early",
    },
    alternatives: [
      {
        kind: "terminal-skill",
        command: "curl -s http://localhost:4000/api/usage/eligibility",
        label: "Check the exact reset time",
        preconditions: [],
        consequence: "reads reasons.sessionBlockedUntil so the operator knows when dispatch resumes",
      },
      {
        kind: "terminal-skill",
        command: "systemctl --user status hydra-orchestrator.service",
        label: "Confirm the service itself is healthy",
        preconditions: [],
        consequence: "rules out a crashed service as a separate cause of the stop",
      },
    ],
    rationale:
      "session-blocked is a 5h/weekly usage-cap self-stop (src/cost/eligibility.ts); it self-clears at sessionBlockedUntil and has no write route to clear early, so the default entry is a read-only hand-off.",
    doc: REFERENCE_DOC,
  },
  {
    key: "machine-stopped:scheduler-deliberate",
    recommended: {
      kind: "in-dashboard",
      route: "/scheduler/start",
      method: "POST",
      confirmTier: "confirm-first",
      label: "Restart the scheduler",
      preconditions: ["confirm the deliberate stop (POST /api/scheduler/stop) is no longer wanted"],
      consequence: "clears stopReason and resumes automatic cycle scheduling at the stored interval",
    },
    alternatives: [
      {
        kind: "terminal-skill",
        command: "curl -s http://localhost:4000/api/scheduler/status",
        label: "Check status before restarting",
        preconditions: [],
        consequence: "reads stopReason and cadence without changing anything",
      },
      {
        kind: "terminal-skill",
        command: "/hydra-review",
        label: "Review before restarting",
        preconditions: [],
        consequence: "walks other attention items while the scheduler stays stopped",
      },
    ],
    rationale:
      'stopReason="deliberate" means an operator (or the watchdog acting on a deliberate stop) called POST /api/scheduler/stop on purpose — the mechanical undo is the sibling POST /api/scheduler/start route.',
    doc: REFERENCE_DOC,
  },
  {
    key: "machine-stopped:sha-drift",
    recommended: {
      kind: "terminal-skill",
      command: "bash scripts/deploy.sh",
      label: "Deploy latest master",
      preconditions: ["no CI/merge is still in flight for the current batch"],
      consequence: "brings the running service to origin/master HEAD, closing the drift",
    },
    alternatives: [
      {
        kind: "terminal-skill",
        command: "gh api repos/gaberoo322/hydra/commits/master",
        label: "Inspect master HEAD before deploying",
        preconditions: [],
        consequence: "confirms which commit would be deployed without changing anything",
      },
      {
        kind: "terminal-skill",
        command: "/hydra-review",
        label: "Review before deploying",
        preconditions: [],
        consequence: "walks stalled PRs and other attention items first",
      },
    ],
    rationale:
      "a deploy job can be cancelled by a back-to-back master merge's CI concurrency group with no alarm from the watchdog beyond SHA drift (CLAUDE.md 'Back-to-back master merges cancel...'); scripts/deploy.sh is the documented manual mitigation once a merge batch has settled.",
    doc: REFERENCE_DOC,
  },

  // --- prs-not-landing (rank 1, per-PR, context {repo, number, kind}) -------
  {
    key: "prs-not-landing:conflicted",
    reviewBucket: "Stalled PR",
    recommended: {
      kind: "terminal-skill",
      command: "/hydra-review",
      label: "Land it",
      preconditions: ["branch is rebased and required checks pass"],
      consequence: "merges now, or arms auto-merge, once the conflict is resolved",
    },
    alternatives: [
      {
        kind: "terminal-skill",
        command: "/hydra-review",
        label: "Update branch",
        preconditions: [],
        consequence: "rebases onto master and surfaces any real conflicts instead of auto-resolving them",
      },
      {
        kind: "terminal-skill",
        command: "/hydra-review",
        label: "Close",
        preconditions: [],
        consequence: "closes the PR as superseded or wrong",
      },
    ],
    rationale:
      "mergeable == CONFLICTING raises no signal on its own — the Stalled PR bucket in /hydra-review §0.9 is the only surface that walks it.",
    doc: HYDRA_REVIEW_DOC,
  },
  {
    key: "prs-not-landing:failed-required",
    recommended: {
      kind: "terminal-skill",
      command: "gh pr checks {number} --repo {repo}",
      label: "Inspect the failing required check",
      preconditions: [
        "confirm the red check is in the branch-protection required set, not advisory-checks",
      ],
      consequence: "shows pass/fail per required context so a targeted fix or dev-resume can be dispatched",
    },
    alternatives: [
      {
        kind: "terminal-skill",
        command: "/hydra-review",
        label: "Hand off to the review loop",
        preconditions: [],
        consequence: "walks the PR alongside other stalled work instead of a one-off check",
      },
      {
        kind: "terminal-skill",
        command: "gh pr close {number} --repo {repo}",
        label: "Close",
        preconditions: [],
        consequence: "closes the PR rather than chasing the failing required check",
      },
    ],
    rationale:
      "a required check failing is a distinct admission line from conflicted/unshepherded — advisory-checks (the ambient-red skill-size ratchet) must NEVER count toward it, so the default entry starts with the required-check table itself.",
    doc: HYDRA_REVIEW_DOC,
  },
  {
    key: "prs-not-landing:unshepherded",
    reviewBucket: "Stalled PR",
    recommended: {
      kind: "terminal-skill",
      command: "/hydra-review",
      label: "Land it",
      preconditions: ["every required check is already green"],
      consequence: "arms auto-merge (or merges now) on a PR nothing else was going to land",
    },
    alternatives: [
      {
        kind: "terminal-skill",
        command: "/hydra-review",
        label: "Update branch",
        preconditions: [],
        consequence: "rebases onto master in case a fresher base changes the picture",
      },
      {
        kind: "terminal-skill",
        command: "/hydra-review",
        label: "Close",
        preconditions: [],
        consequence: "closes the PR as superseded or wrong",
      },
    ],
    rationale:
      "mergeable == MERGEABLE with every required check green and autoMergeRequest == null means nothing will ever merge it — finished work sitting invisible until someone looks.",
    doc: HYDRA_REVIEW_DOC,
  },

  // --- waiting-on-you (rank 2, per-issue, context {repo, number, kind}) -----
  {
    key: "waiting-on-you:ready-for-human",
    recommended: {
      kind: "terminal-skill",
      command: "/hydra-review",
      label: "Classify and resolve",
      preconditions: [],
      consequence:
        "walks the issue as triage-origin, tracking-parent, or dev-failure and offers that entry path's own options",
    },
    alternatives: [
      {
        kind: "terminal-skill",
        command: "gh issue view {number} --repo {repo}",
        label: "Read the issue directly",
        preconditions: [],
        consequence: "reads body, comments and labels without entering the interactive walk",
      },
      {
        kind: "terminal-skill",
        command: "gh issue edit {number} --repo {repo} --add-label blocked",
        label: "Mark blocked instead",
        preconditions: ["a real blocking issue exists to reference"],
        consequence: "moves the item to the stale-blocked admission line until the blocker resolves",
      },
    ],
    rationale:
      "ready-for-human has no single default action — /hydra-review §3 identifies the entry path (triage-origin / tracking-parent / dev-failure) per issue before offering that path's canonical options (§4); a future variant entry carries those specific choices, not this default.",
    doc: HYDRA_REVIEW_DOC,
  },
  {
    key: "waiting-on-you:stale-blocked",
    reviewBucket: "Stale-blocked",
    recommended: {
      kind: "terminal-skill",
      command: "/hydra-review",
      label: "Unblock",
      preconditions: ["the referenced blocker is closed, or was never a real blocker"],
      consequence: "removes the blocked label and returns the issue to normal triage",
    },
    alternatives: [
      {
        kind: "terminal-skill",
        command: "/hydra-review",
        label: "Still blocked (update ref)",
        preconditions: [],
        consequence: "rewrites the blocked-by reference to the still-open issue that actually blocks it",
      },
      {
        kind: "terminal-skill",
        command: "/hydra-review",
        label: "No longer relevant",
        preconditions: [],
        consequence: "closes the issue as no longer needed",
      },
    ],
    rationale:
      "a stale-blocked row is only worth walking after its blocker is verified against the tracker rather than trusted from the label (/hydra-review §2.5) — these labels match that verification's three outcomes exactly.",
    doc: HYDRA_REVIEW_DOC,
  },
  {
    key: "waiting-on-you:needs-info",
    recommended: {
      kind: "terminal-skill",
      command: "gh issue view {number} --repo {repo} --comments",
      label: "Answer the open question",
      preconditions: [],
      consequence: "reads the needs-info comment thread so the operator can reply with the missing detail",
    },
    alternatives: [
      {
        kind: "terminal-skill",
        command: "/hydra-review",
        label: "Hand off to the review loop",
        preconditions: [],
        consequence: "walks it alongside other operator-attention issues",
      },
      {
        kind: "terminal-skill",
        command: "gh issue edit {number} --repo {repo} --remove-label needs-info --add-label wontfix",
        label: "Close as won't-fix",
        preconditions: [],
        consequence: "drops the issue rather than continuing to wait on an answer",
      },
    ],
    rationale:
      "needs-info ages past needsInfoDays (1) with no mechanical unblock — the default entry gives the operator the open question directly rather than only a generic hand-off.",
    doc: HYDRA_REVIEW_DOC,
  },
  {
    key: "waiting-on-you:blocked-live",
    recommended: {
      kind: "terminal-skill",
      command: "/hydra-review",
      label: "Review the live blocker",
      preconditions: [],
      consequence:
        "walks the issue's referenced blocker to decide unblock / still-blocked / no-longer-relevant",
    },
    alternatives: [
      {
        kind: "terminal-skill",
        command: "gh issue view {number} --repo {repo}",
        label: "Read the issue directly",
        preconditions: [],
        consequence: "reads the blocked-by reference and current state without entering the interactive walk",
      },
      {
        kind: "terminal-skill",
        command: "gh issue edit {number} --repo {repo} --add-label ready-for-human",
        label: "Escalate to ready-for-human",
        preconditions: [],
        consequence: "moves the item ahead in drain order once a live blocker needs an operator decision now",
      },
    ],
    rationale:
      "blocked-live crosses at blockedDays (2) while its referenced blocker is still genuinely open, distinct from stale-blocked (blocker is stale/closed) — this default entry is the read-only hand-off until that distinction resolves.",
    doc: HYDRA_REVIEW_DOC,
  },

  // --- target-items (rank 3, per-issue, context {repo, number, kind}) -------
  {
    key: "target-items:ready-for-human",
    reviewBucket: "Target ready-for-human",
    recommended: {
      kind: "terminal-skill",
      command: "/hydra-review",
      label: "Make it agent-ready",
      preconditions: [],
      consequence: "adds enough scope/acceptance-criteria detail for hydra-target-build to pick it up unattended",
    },
    alternatives: [
      {
        kind: "terminal-skill",
        command: "/hydra-review",
        label: "Needs more info",
        preconditions: [],
        consequence: "asks a clarifying question and leaves the item parked until answered",
      },
      {
        kind: "terminal-skill",
        command: "/hydra-review",
        label: "Won't do",
        preconditions: [],
        consequence: "closes the item as out of scope for the Target",
      },
    ],
    rationale:
      "matches /hydra-review §4's Target ready-for-human row verbatim, so a future drift assertion pinning reviewBucket cells lands as a pure test addition.",
    doc: HYDRA_REVIEW_DOC,
  },
  {
    key: "target-items:stale-blocked",
    reviewBucket: "Target stale-blocked",
    recommended: {
      kind: "terminal-skill",
      command: "/hydra-review",
      label: "Unblock",
      preconditions: ["the referenced blocker is closed, or was never a real blocker"],
      consequence: "removes the blocked label and returns the Target issue to normal triage",
    },
    alternatives: [
      {
        kind: "terminal-skill",
        command: "/hydra-review",
        label: "Still blocked (update ref)",
        preconditions: [],
        consequence: "rewrites the blocked-by reference to the still-open issue that actually blocks it",
      },
      {
        kind: "terminal-skill",
        command: "/hydra-review",
        label: "No longer relevant",
        preconditions: [],
        consequence: "closes the Target issue as no longer needed",
      },
    ],
    rationale:
      "matches /hydra-review §4's Target stale-blocked row verbatim — same verification-before-walk discipline as the Orchestrator's own stale-blocked line, applied against the Target repo.",
    doc: HYDRA_REVIEW_DOC,
  },
  {
    key: "target-items:needs-info",
    recommended: {
      kind: "terminal-skill",
      command: "gh issue view {number} --repo {repo} --comments",
      label: "Answer the open question",
      preconditions: [],
      consequence: "reads the needs-info comment thread on the Target issue so the operator can reply",
    },
    alternatives: [
      {
        kind: "terminal-skill",
        command: "/hydra-review",
        label: "Hand off to the review loop",
        preconditions: [],
        consequence: "walks it alongside the Target's other operator-attention issues",
      },
      {
        kind: "terminal-skill",
        command: "gh issue edit {number} --repo {repo} --remove-label needs-info --add-label wontfix",
        label: "Close as won't-fix",
        preconditions: [],
        consequence: "drops the Target issue rather than continuing to wait on an answer",
      },
    ],
    rationale:
      "mirrors waiting-on-you:needs-info against the Target repo — target-items reuses the rank-2 lines verbatim plus its own reframe line.",
    doc: HYDRA_REVIEW_DOC,
  },
  {
    key: "target-items:blocked-live",
    recommended: {
      kind: "terminal-skill",
      command: "/hydra-review",
      label: "Review the live blocker",
      preconditions: [],
      consequence:
        "walks the Target issue's referenced blocker to decide unblock / still-blocked / no-longer-relevant",
    },
    alternatives: [
      {
        kind: "terminal-skill",
        command: "gh issue view {number} --repo {repo}",
        label: "Read the issue directly",
        preconditions: [],
        consequence: "reads the blocked-by reference and current state without entering the interactive walk",
      },
      {
        kind: "terminal-skill",
        command: "gh issue edit {number} --repo {repo} --add-label ready-for-human",
        label: "Escalate to ready-for-human",
        preconditions: [],
        consequence: "moves the Target item ahead in drain order once a live blocker needs an operator decision now",
      },
    ],
    rationale:
      "mirrors waiting-on-you:blocked-live against the Target repo — target-items reuses the rank-2 lines verbatim plus its own reframe line.",
    doc: HYDRA_REVIEW_DOC,
  },
  {
    key: "target-items:reframe",
    reviewBucket: "Target reframe",
    recommended: {
      kind: "terminal-skill",
      command: "/hydra-review",
      label: "Narrow scope",
      preconditions: ["prior attempt history has been read"],
      consequence: "re-files the build with a smaller slice so hydra-target-build can complete it unattended",
    },
    alternatives: [
      {
        kind: "terminal-skill",
        command: "/hydra-review",
        label: "Provide implementation approach",
        preconditions: [],
        consequence: "adds the missing design decision the prior attempts were guessing at",
      },
      {
        kind: "terminal-skill",
        command: "/hydra-review",
        label: "Abandon",
        preconditions: [],
        consequence: "closes the build rather than attempting it a third time",
      },
    ],
    rationale:
      "a reframe is a Target build stamped by hydra-target-qa after failing 2+ times; matches /hydra-review §4's Target reframe row verbatim.",
    doc: HYDRA_REVIEW_DOC,
  },

  // --- repetition (rank 4, aggregate-per-pattern, context {}) ---------------
  {
    key: "repetition:hits",
    recommended: {
      kind: "terminal-skill",
      command: "/hydra-review",
      label: "Review the recurring pattern",
      preconditions: [],
      consequence: "surfaces the friction cue that crossed PROMOTION_THRESHOLD (3) alongside other operator-attention items",
    },
    alternatives: [
      {
        kind: "terminal-skill",
        command: "/hydra-retro",
        label: "Run a retrospective on it",
        preconditions: [],
        consequence: "deep-reads the flagged transcripts and proposes a tiered, capped fix instead of a one-off decision",
      },
      {
        kind: "terminal-skill",
        command: "/hydra-review",
        label: "Dismiss as noise",
        preconditions: [],
        consequence: "leaves the pattern unpromoted if the repeated hits do not warrant a systemic fix",
      },
    ],
    rationale:
      'a friction pattern crossing PROMOTION_THRESHOLD has no repo/number (BUCKET_CONTEXT["repetition"] is {}) and no existing mechanical promotion route, so the default entry is a read-only hand-off.',
    doc: HYDRA_REVIEW_DOC,
  },

  // --- parked-over-cap (rank 5, aggregate, context {}) ----------------------
  {
    key: "parked-over-cap:cap",
    recommended: {
      kind: "terminal-skill",
      command: "/hydra-hitl-grill",
      label: "Drain the park lane",
      preconditions: [],
      consequence: "walks the oldest parked ideas down below HITL_GRILL_CAP (10)",
    },
    alternatives: [
      {
        kind: "terminal-skill",
        command: "gh issue list --repo gaberoo322/hydra --label hitl-grill --state open",
        label: "List the parked items first",
        preconditions: [],
        consequence: "shows the full parked lane without starting the drain walk",
      },
      {
        kind: "terminal-skill",
        command: "/hydra-review",
        label: "Defer to the next session",
        preconditions: [],
        consequence: "leaves the lane over cap for another operator session",
      },
    ],
    rationale:
      "the parked hitl-grill lane is feed bucket 5 as one aggregate row once it holds >= HITL_GRILL_CAP (10) items; /hydra-hitl-grill is the lane's own dedicated drain, distinct from /hydra-review which deliberately excludes it.",
    doc: HITL_GRILL_DOC,
  },
] satisfies readonly OperatorActionEntryInput[];

/**
 * The validated, frozen registry. Import-time `validateRegistry(RAW_ENTRIES)`
 * throws `InvariantViolationError` if `RAW_ENTRIES` (despite its `satisfies`
 * shape check) fails a runtime rule the type system cannot express — a
 * duplicate `(key, variant)` slot, or a value only zod's `.strict()` /
 * `.refine()` catch.
 */
export const REGISTRY: readonly OperatorActionEntry[] = validateRegistry(RAW_ENTRIES);
