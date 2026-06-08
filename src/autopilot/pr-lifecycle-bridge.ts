/**
 * pr-lifecycle-bridge.ts — emit `pr_lifecycle` events onto the slot-events
 * stream when orchestrator / target PRs transition OPEN → MERGED or CLOSED
 * (issue #673).
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
import { ghJson } from "../github/gh.ts";
import { isGhFailure } from "../github/exec.ts";

/** The orchestrator's own repo — the one constant across target swaps. */
const ORCHESTRATOR_REPO = "gaberoo322/hydra";

export const SLOT_EVENTS_STREAM = "hydra:autopilot:slot-events";

const DEFAULT_POLL_INTERVAL_MS = 60_000; // 1 minute — gh API rate-friendly.
const STREAM_MAXLEN = 1000;

/**
 * Lazy module-singleton Event Bus used when the caller does not inject one.
 * The bridge routes its XADD through `eventBus.publishRaw` (ADR-0017 Category
 * B) instead of the raw connection. In production `src/index.ts` injects the
 * service-wide bus (so `_broadcastToClients` reaches the live WS clients); the
 * lazy fallback exists for tests and any direct `emitPrLifecycleEvent` caller.
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
// Pure helpers — exported for tests
// ---------------------------------------------------------------------------

export interface PullRequestSnapshot {
  number: number;
  state: "OPEN" | "MERGED" | "CLOSED";
  title: string;
  url: string;
  headRefName: string;
  /** ISO timestamp — used as a tie-breaker for "just opened" detection. */
  createdAt: string;
}

type PrTransition = "opened" | "merged" | "closed";

export interface PrLifecycleEvent {
  repo: string;
  pr_number: number;
  transition: PrTransition;
  title: string;
  url: string;
  task_id: string;
  head_branch: string;
}

/**
 * Extract a subagent task_id hint from a head-branch name. Matches the
 * conventions in use today:
 *   - hydra-dev:          `issue-<N>-dev` / `issue-<N>`
 *   - hydra-target-build: `issue-<N>` (target-side)
 *   - autopilot Agent():  `agent-<hex>` (worktree-isolated sessions)
 *
 * Returns the first match in priority order (`agent-` outranks `issue-`
 * because the Agent-tool task_id is the more specific identifier — issue
 * branches can be hand-created by an operator with no autopilot binding).
 * Empty string if no recognisable token is found.
 */
export function extractTaskId(headBranch: string | undefined | null): string {
  if (!headBranch || typeof headBranch !== "string") return "";
  const agentMatch = headBranch.match(/agent-[0-9a-f]{8,}/i);
  if (agentMatch) return agentMatch[0];
  const issueMatch = headBranch.match(/issue-\d+/);
  if (issueMatch) return issueMatch[0];
  return "";
}

/**
 * Diff the current poll against the last snapshot and yield the transitions
 * that produced new lifecycle events.
 *
 * Pure — `prev` and `curr` are plain JSON-shaped Maps keyed by PR number.
 *
 * Semantics:
 *   - PR in `curr` but not in `prev`, state=OPEN     → "opened"
 *   - PR in both, prev=OPEN and curr=MERGED          → "merged"
 *   - PR in both, prev=OPEN and curr=CLOSED          → "closed"
 *   - PR drops out of `curr`                         → no event (gh's
 *     OPEN list dropped it because it merged/closed; that transition
 *     is captured the LAST time it was in `curr` AFTER we add MERGED+
 *     CLOSED states to the query, so we always include `--state all`
 *     limited to recent PRs in the actual fetch).
 *
 * Cold-start (empty prev): emits "opened" for every currently-open PR.
 * That's a one-time burst on service startup which is the right behaviour
 * because the dashboard's first connection should know which PRs are
 * currently in flight — but it's also why service restarts inside a busy
 * day don't double-fire (the SETNX-style idempotency for budget thresholds
 * isn't needed here because the snapshot diff itself is the dedup mechanism
 * for ongoing operation; the cold-start burst is a one-time signal).
 */
export function diffPrSnapshots(
  prev: Map<number, PullRequestSnapshot>,
  curr: Map<number, PullRequestSnapshot>,
  repo: string,
): PrLifecycleEvent[] {
  const events: PrLifecycleEvent[] = [];

  for (const [num, snap] of curr.entries()) {
    const before = prev.get(num);
    if (!before) {
      // New PR observed this poll.
      if (snap.state === "OPEN") {
        events.push(buildLifecycleEvent(repo, snap, "opened"));
      } else if (snap.state === "MERGED") {
        events.push(buildLifecycleEvent(repo, snap, "merged"));
      } else if (snap.state === "CLOSED") {
        events.push(buildLifecycleEvent(repo, snap, "closed"));
      }
      continue;
    }
    if (before.state === snap.state) continue;
    if (before.state === "OPEN" && snap.state === "MERGED") {
      events.push(buildLifecycleEvent(repo, snap, "merged"));
    } else if (before.state === "OPEN" && snap.state === "CLOSED") {
      events.push(buildLifecycleEvent(repo, snap, "closed"));
    }
    // Other transitions (CLOSED → OPEN reopen, MERGED → anything) are
    // not in the #673 spec — quietly ignored.
  }

  return events;
}

function buildLifecycleEvent(
  repo: string,
  snap: PullRequestSnapshot,
  transition: PrTransition,
): PrLifecycleEvent {
  return {
    repo,
    pr_number: snap.number,
    transition,
    title: snap.title,
    url: snap.url,
    task_id: extractTaskId(snap.headRefName),
    head_branch: snap.headRefName,
  };
}

/** Truncate to 200 chars + strip CR/LF/tab to match the stream-field convention. */
export function sanitizeField(raw: string): string {
  let s = raw || "";
  s = s.replace(/[\n\r\t]/g, " ");
  if (s.length > 200) s = s.slice(0, 200);
  return s;
}

// ---------------------------------------------------------------------------
// gh fetch + bridge entrypoint
// ---------------------------------------------------------------------------

interface GhFetcher {
  (repo: string): Promise<PullRequestSnapshot[]>;
}

/**
 * Default fetcher — shells out to `gh pr list --repo <repo> --state all
 * --limit 50 --json ...`. The `--state all` flag ensures we see MERGED /
 * CLOSED transitions; `--limit 50` is a sane cap given the orchestrator's
 * realistic in-flight PR count is <10.
 *
 * Returns [] on any failure (missing `gh`, auth error, network blip) so
 * the bridge can continue against its existing snapshot.
 */
async function defaultGhFetcher(repo: string): Promise<PullRequestSnapshot[]> {
  // Routes through the GitHub CLI Adapter seam (issue #899). The seam never
  // throws and owns the JSON parse + the four external-process error modes; a
  // failure arm (missing `gh`, auth error, network blip, empty/malformed JSON)
  // degrades to [] so the bridge continues against its existing snapshot —
  // preserving the pre-seam "returns [] on any failure" contract.
  const result = await ghJson<unknown>(
    [
      "pr", "list",
      "--repo", repo,
      "--state", "all",
      "--limit", "50",
      "--json", "number,state,title,url,headRefName,createdAt",
    ],
    { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
  );
  if (isGhFailure(result)) {
    console.error(
      `[pr-lifecycle-bridge] gh pr list ${repo} failed (${result.code}): ${result.stderr.slice(0, 200)}`,
    );
    return [];
  }
  const parsed = result.data;
  if (!Array.isArray(parsed)) return [];
  return parsed
      .filter((row) => row && typeof row === "object" && Number.isFinite(row.number))
      .map((row): PullRequestSnapshot => ({
        number: Number(row.number),
        state: ((): "OPEN" | "MERGED" | "CLOSED" => {
          const s = String(row.state || "").toUpperCase();
          if (s === "OPEN" || s === "MERGED" || s === "CLOSED") return s;
          return "OPEN";
        })(),
        title: String(row.title || ""),
        url: String(row.url || ""),
        headRefName: String(row.headRefName || ""),
        createdAt: String(row.createdAt || ""),
      }));
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
