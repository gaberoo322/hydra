/**
 * pr-lifecycle-bridge.ts — emit `pr_lifecycle` events onto the slot-events
 * stream when orchestrator / target PRs transition OPEN → MERGED or CLOSED
 * (issue #673).
 *
 * # Concern split (issue #2239)
 *
 * This module owns the **I/O + lifecycle** half of the bridge: the `gh` CLI
 * read (`defaultGhFetcher`), the `setInterval` timer lifecycle
 * (`startPrLifecycleBridge`), and the Redis stream emission
 * (`emitPrLifecycleEvent`). The **pure** snapshot grammar — the snapshot
 * types, the `gh`-state→snapshot projection (`prRowToSnapshot`), the
 * snapshot differ (`diffPrSnapshots`), task_id extraction, and field
 * sanitization — lives in the sibling `pr-lifecycle-snapshot.ts`, where it is
 * exercisable with plain inputs (no subprocess stub, no EventBus stub). The
 * split mirrors the `run-projections.ts` / `runs.ts` write-vs-read seam split.
 *
 * # What it does
 *
 * Polls `gh pr list --json` on a configurable interval for both repos
 * (the orchestrator's own repo and the configured target, resolved from
 * `target-config.ts`) and diffs the result against the last-seen snapshot
 * kept in process memory.
 * Each new state OR transition emits a single XADD onto
 * `hydra:autopilot:slot-events` so the existing `slot-events-bridge` can
 * fan it out to dashboard WS clients. Dashboard tiles like BattleCardRow
 * (slice D, #672) read the resulting frames and light up reactively when a
 * subagent's PR opens or merges.
 *
 * Event payload shape (per #673):
 *
 *     event:        "pr_lifecycle"
 *     transition:   "opened" | "merged" | "closed"
 *     repo:         "owner/name"
 *     pr_number:    "<int>"
 *     title:        "<truncated 200ch>"
 *     url:          "https://github.com/owner/name/pull/N"
 *     task_id:      "<extracted-from-head-branch-or-empty>"
 *     head_branch:  "<branch-name>"
 *     ts_epoch:     "<unix-seconds>"
 *
 * # Why polling, not webhooks
 *
 * The PRD lists "polls `gh` (or, if configured, listens to the GitHub
 * webhook the deploy box already receives)" as the contract. The deploy-
 * box webhook today only triggers the GitHub Actions self-hosted runner
 * (see CLAUDE.md "Deploy runs automatically on merge to master") and does
 * NOT expose a queryable feed back to the orchestrator. Standing up a
 * dedicated webhook receiver would require new port + reverse-proxy work
 * and is operator-credential territory (ADR-0005). Polling `gh pr list`
 * is the operationally cheapest option that respects the operator's
 * existing `gh` credentials, and the slot-events stream is the
 * downstream contract — the source can swap to webhooks later without
 * touching the consumer.
 *
 * # task_id extraction
 *
 * Each `hydra-dev` / `hydra-target-build` dispatch creates a branch named
 * with an embedded task_id (e.g. `issue-673-dev` for `hydra-dev`,
 * `agent-<hex>` for autopilot Agent-tool sessions). We extract the FIRST
 * `agent-[0-9a-f]+` or `issue-\d+` token from the head branch as the
 * task_id hint. If neither pattern matches, the event still fires with an
 * empty task_id — the dashboard can still render it as a repo-scoped PR
 * event without subagent attribution.
 *
 * # Failure handling
 *
 * Per `gh` invocation is wrapped — a missing `gh` binary, a network blip,
 * or a transient 5xx logs and continues. The bridge never throws into the
 * parent setInterval (which would silently die). On `gh pr list` failure
 * we keep the existing snapshot so the NEXT successful poll diffs against
 * the right baseline (rather than re-firing every open PR as "opened" the
 * first poll after recovery).
 *
 * # Lifecycle
 *
 * `startPrLifecycleBridge()` returns a `stop()` function. `src/index.ts`
 * calls it on SIGTERM. Stop is idempotent.
 */

import { EventBus } from "../event-bus.ts";
import { getTargetGithubRepo } from "../target-config.ts";
import { listOpenPrs, isIssueReadFailure } from "../github/issues.ts";
import {
  prRowToSnapshot,
  diffPrSnapshots,
  sanitizeField,
  type PullRequestSnapshot,
  type PrLifecycleEvent,
} from "./pr-lifecycle-snapshot.ts";

/** The orchestrator's own repo — the one constant across target swaps. */
const ORCHESTRATOR_REPO = "gaberoo322/hydra";

export const SLOT_EVENTS_STREAM = "hydra:autopilot:slot-events";

const DEFAULT_POLL_INTERVAL_MS = 60_000; // 1 minute — gh API rate-friendly.
const STREAM_MAXLEN = 1000;

/**
 * Lazy module-singleton Event Bus used when the caller does not inject one.
 * The bridge routes its XADD through `eventBus.publishRaw` (ADR-0017 Category
 * B) instead of the raw connection. In production `src/index.ts` injects the
 * service-wide bus (so `publishRaw`'s WS-registry broadcast reaches the live
 * WS clients); the lazy fallback exists for tests and any direct
 * `emitPrLifecycleEvent` caller.
 */
let _defaultEventBus: EventBus | null = null;
function getDefaultEventBus(): EventBus {
  if (!_defaultEventBus) _defaultEventBus = new EventBus();
  return _defaultEventBus;
}

/**
 * Default repo list — the orchestrator's own repo plus the configured target,
 * resolved from `target-config.ts` (NOT hardcoded) so the bridge follows a
 * target swap (ADR-0013, ADR-0002). Computed at call-time because the target
 * env vars may be set after this module is imported.
 */
function defaultRepos(): readonly string[] {
  return [ORCHESTRATOR_REPO, getTargetGithubRepo()];
}

// ---------------------------------------------------------------------------
// gh fetch + bridge entrypoint
//
// The pure snapshot grammar (snapshot types, `prRowToSnapshot`,
// `diffPrSnapshots`, `extractTaskId`, `sanitizeField`) lives in the sibling
// `pr-lifecycle-snapshot.ts` (#2239) and is imported above. Everything below
// is I/O-bound or lifecycle: the `gh` read, the timer, and the stream emission.
// ---------------------------------------------------------------------------

interface GhFetcher {
  (repo: string): Promise<PullRequestSnapshot[]>;
}

/**
 * Default fetcher — reads through the GitHub Issue/PR Read seam
 * ({@link listOpenPrs}, `src/github/issues.ts`, issue #908) with
 * `{state:"all", limit:50, fields}` so MERGED / CLOSED transitions are visible
 * and the head-branch + created-at attribution fields are populated. `--state
 * all` ensures we see merged/closed PRs; `--limit 50` is a sane cap given the
 * orchestrator's realistic in-flight PR count is <10.
 *
 * The seam owns the repo handle, the `gh` argv, the JSON parse, and the
 * four external-process error modes (it never throws). On its failure arm we
 * degrade to [] so the bridge continues against its existing snapshot —
 * preserving the pre-migration "returns [] on any failure" contract. The
 * `state,headRefName,createdAt` fields are requested explicitly so the seam's
 * defensive parser populates them (they are part of the canonical
 * PR_LIST_JSON_FIELDS, but naming them here documents the bridge's needs).
 */
async function defaultGhFetcher(repo: string): Promise<PullRequestSnapshot[]> {
  const res = await listOpenPrs({
    repo,
    state: "all",
    limit: 50,
    fields: "number,state,title,url,headRefName,createdAt",
    timeout: 15_000,
  });
  // `strict:false` (no strictNullChecks) means a plain `if (!res.ok)` does NOT
  // narrow the union — use the seam's type guard, mirroring its own *OrEmpty
  // wrappers (see github/issues.ts docstring on isIssueReadFailure).
  if (isIssueReadFailure(res)) {
    console.error(`[pr-lifecycle-bridge] gh pr list ${repo} failed (${res.code})`);
    return [];
  }
  return res.rows.map(prRowToSnapshot);
}

export interface PrLifecycleBridgeOpts {
  /** Override poll interval (ms). Defaults to 60s. Tests pass tiny values. */
  pollIntervalMs?: number;
  /** Override the repo list. Defaults to [orchestrator repo, configured target]. */
  repos?: readonly string[];
  /** Inject a custom gh fetcher — tests stub this with a deterministic generator. */
  ghFetcher?: GhFetcher;
  /**
   * Single-shot mode for tests. When true, runs exactly one tick and
   * returns; otherwise spins up setInterval and returns a stop fn.
   */
  oneShot?: boolean;
  /**
   * Inject the Event Bus used to publish lifecycle events. Defaults to the
   * lazy module singleton. `src/index.ts` passes the service-wide bus so the
   * WS broadcast reaches live dashboard clients (ADR-0017 Category B).
   */
  eventBus?: EventBus;
}

export interface PrLifecycleBridge {
  /** Stop the polling loop. Idempotent. */
  stop(): void;
}

/**
 * Start the PR-lifecycle bridge. Returns a `PrLifecycleBridge` with a
 * `stop()` method. The caller is responsible for calling `stop()` on
 * graceful shutdown.
 *
 * The first poll happens immediately (no `setInterval` wait) so a service
 * restart inside a day with in-flight PRs surfaces them to fresh dashboard
 * connections without a 60-second delay.
 */
export async function startPrLifecycleBridge(
  opts: PrLifecycleBridgeOpts = {},
): Promise<PrLifecycleBridge> {
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const repos = opts.repos ?? defaultRepos();
  const fetcher = opts.ghFetcher ?? defaultGhFetcher;
  const eventBus = opts.eventBus ?? getDefaultEventBus();

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const snapshots = new Map<string, Map<number, PullRequestSnapshot>>();
  for (const repo of repos) snapshots.set(repo, new Map());

  async function tick(): Promise<void> {
    if (stopped) return;
    for (const repo of repos) {
      try {
        const rows = await fetcher(repo);
        if (rows.length === 0) continue; // Either empty list or gh failure — leave snapshot intact.

        const curr = new Map<number, PullRequestSnapshot>();
        for (const row of rows) curr.set(row.number, row);

        const prev = snapshots.get(repo) ?? new Map();
        const events = diffPrSnapshots(prev, curr, repo);

        for (const event of events) {
          await emitPrLifecycleEvent(event, eventBus);
        }

        snapshots.set(repo, curr);
      } catch (err: any) {
        console.error(
          `[pr-lifecycle-bridge] tick ${repo} failed: ${err?.message || err}`,
        );
      }
    }
  }

  if (opts.oneShot) {
    await tick();
    return {
      stop() {
        stopped = true;
      },
    };
  }

  console.log(
    `[pr-lifecycle-bridge] starting (interval=${pollIntervalMs}ms repos=${repos.join(",")})`,
  );

  timer = setInterval(() => {
    void tick();
  }, pollIntervalMs);
  void tick();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      console.log("[pr-lifecycle-bridge] stopped");
    },
  };
}

// ---------------------------------------------------------------------------
// Stream emission
// ---------------------------------------------------------------------------

/**
 * XADD a `pr_lifecycle` event onto the slot-events stream. The flat field-
 * value layout matches `on-subagent-stop.sh` — `event` is the discriminator
 * and consumers (slot-events-bridge, dashboard subscribers) pattern-match
 * on it. Exported for tests so the field shape is pinned independently of
 * the Redis round-trip.
 */
export async function emitPrLifecycleEvent(
  event: PrLifecycleEvent,
  eventBus: EventBus = getDefaultEventBus(),
): Promise<string> {
  const fields = [
    "event", "pr_lifecycle",
    "transition", event.transition,
    "repo", event.repo,
    "pr_number", String(event.pr_number),
    "title", sanitizeField(event.title),
    "url", event.url,
    "task_id", event.task_id,
    "head_branch", event.head_branch,
    "ts_epoch", String(Math.floor(Date.now() / 1000)),
  ];
  // ADR-0017 Category B: route the flat, `event`-discriminated wire shape
  // through the sanctioned Event Bus instead of the raw connection. The XADD
  // emitted is identical (flat fields, MAXLEN ~ STREAM_MAXLEN, "*" id) — this
  // is a wire-format-preserving migration, not a behaviour change. publishRaw
  // also fans out to WS clients so dashboard subscribers light up live.
  return eventBus.publishRaw(SLOT_EVENTS_STREAM, fields, { maxlen: STREAM_MAXLEN });
}
