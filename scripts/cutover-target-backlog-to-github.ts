/**
 * cutover-target-backlog-to-github — one-shot, re-runnable migration of the
 * currently-actionable Redis backlog lanes onto the Target's GitHub-Issues board
 * (`gaberoo322/hydra-betting`), throttled under the GitHub secondary
 * content-creation rate limit. Slice 4 of ADR-0031 (#3438, parent epic #3429).
 *
 * WHY (ADR-0031 Decision 6 — drain-and-fresh cutover):
 * Target task tracking moves from Redis (kanban lanes) to GitHub Issues. Redis
 * backlog items are *transient work*, not durable data, so the cutover files
 * only the currently-ACTIONABLE items — the `backlog`, `queued`, and `blocked`
 * lanes — as GitHub issues. `inProgress` / `done` (and the ~243 vestigial
 * hydra-betting issue numbers) are NOT migrated; they drain naturally. After
 * this the Target loop runs entirely off the GitHub board.
 *
 * THE BINDING SAFETY INVARIANT (#3427): a bulk `gh issue create` fan-out trips
 * the GitHub secondary content-creation rate limit. So creations are paced under
 * a hard `--rate` ceiling (default 500/hr) — {@link throttleDelayMs} computes the
 * minimum inter-create delay and the create loop sleeps it. This is net-new;
 * there is no pre-existing throttle constant in scripts/ or autopilot.
 *
 * HARD CONSTRAINTS (ADR-0031 Decision 6):
 *   - REST-first: the dedup search uses `gh api search/issues` (REST pool),
 *     never `gh --json` / GraphQL — the money-critical Target loop must stay off
 *     the Orchestrator's saturated GraphQL pool.
 *   - Read-only over Redis: this reads the backlog lanes via `loadBacklog()` and
 *     NEVER deletes/mutates Redis state. The Redis-subsystem teardown is the
 *     separate later slice 5, gated on a no-Orchestrator-dependency check. Keeping
 *     this slice non-destructive preserves re-run rollback safety.
 *   - Idempotent: before each `gh issue create`, a lexical title search dedups so
 *     a partial run that is re-invoked does not double-file.
 *   - Dry-run by default: previews the filing set + creation count; only writes
 *     under an explicit `--apply`, matching the orch cleanup/scan convention.
 *
 * The lane→label vocabulary is IMPORTED from the #3434 leaf
 * (`src/target-board-labels.ts`); this script does not define labels.
 *
 * This is the DEEP module of the slice: it owns the cutover POLICY (lane
 * selection, lane→label mapping, throttle pacing, dedup, dry-run). The pure
 * policy functions are exported and unit-tested; all I/O (loadBacklog, gh) is at
 * the `main()` edge behind seams so the tests never spawn `gh` or touch Redis.
 */

import { loadBacklog, type Backlog } from "../src/backlog/reads.ts";
import type { BacklogItem } from "../src/backlog/types.ts";
import { TARGET_BOARD_LABELS } from "../src/target-board-labels.ts";
import { getTargetGithubRepo } from "../src/target-config.ts";
import { ghExec } from "../src/github/gh.ts";
import { runExec, ghBin } from "../src/github/exec.ts";

// ---------------------------------------------------------------------------
// Pure policy — lane selection, lane→label mapping, body rendering, throttle
// ---------------------------------------------------------------------------

/**
 * The three currently-ACTIONABLE lanes the cutover migrates (ADR-0031
 * Decision 6). `triage` (undescribed), `inProgress` (claimed work), and `done`
 * (terminal) are deliberately excluded — they drain naturally.
 */
export const ACTIONABLE_LANES = ["backlog", "queued", "blocked"] as const;
export type ActionableLane = (typeof ACTIONABLE_LANES)[number];

/** The default content-creation ceiling — under the GitHub secondary limit (#3427). */
export const DEFAULT_RATE_PER_HOUR = 500;

/**
 * Select the actionable items to migrate, in a stable deterministic order.
 *
 * Only the `backlog`, `queued`, and `blocked` lanes are drawn (ADR-0031
 * Decision 6 — `inProgress`/`done`/`triage` are never migrated). Within the
 * selection, items are ordered by lane precedence (queued → backlog → blocked)
 * then by priority (1=urgent first, 0/unset last) so that if a run is
 * interrupted the most valuable work is filed first. Each item is tagged with
 * its source lane so the caller can map it to labels.
 */
export function selectActionableItems(
  backlog: Backlog,
): Array<{ item: BacklogItem; lane: ActionableLane }> {
  const lanePrecedence: Record<ActionableLane, number> = {
    queued: 0,
    backlog: 1,
    blocked: 2,
  };
  const selected: Array<{ item: BacklogItem; lane: ActionableLane }> = [];
  for (const lane of ACTIONABLE_LANES) {
    for (const item of backlog[lane] ?? []) {
      selected.push({ item, lane });
    }
  }
  selected.sort((a, b) => {
    const lp = lanePrecedence[a.lane] - lanePrecedence[b.lane];
    if (lp !== 0) return lp;
    const pa = a.item.priority || 0;
    const pb = b.item.priority || 0;
    const orderA = pa === 0 ? 99 : pa;
    const orderB = pb === 0 ? 99 : pb;
    return orderA - orderB;
  });
  return selected;
}

/**
 * Derive the GitHub board labels for a migrated item from its Redis lane + flags
 * (ADR-0031 Decision 4/5). The vocabulary is IMPORTED from the #3434 leaf
 * ({@link TARGET_BOARD_LABELS}); this only maps.
 *
 *   - queued / backlog → `ready-for-agent`
 *   - blocked          → `blocked`
 *   - a `money-critical` flag carried in `item.labels` → the `money-critical`
 *     label survives onto the issue.
 *
 * The lane→board-state label is deduped against any label already present so a
 * re-run over an already-labelled item is stable.
 */
export function itemToLabels(item: BacklogItem, lane: ActionableLane): string[] {
  const labels = new Set<string>();
  labels.add(
    lane === "blocked"
      ? TARGET_BOARD_LABELS.blocked
      : TARGET_BOARD_LABELS.ready_for_agent,
  );
  // Preserve the surviving Target-specific flag labels carried on the item.
  const carried = Array.isArray(item.labels) ? item.labels : [];
  for (const flag of [
    TARGET_BOARD_LABELS.money_critical,
    TARGET_BOARD_LABELS.reframe,
    TARGET_BOARD_LABELS.wire_or_retire,
  ]) {
    if (carried.includes(flag)) labels.add(flag);
  }
  return [...labels];
}

/**
 * The dedup search key for an item — its exact title. Lexical, never semantic
 * (ADR-0031 Decision 5). Titles are trimmed and collapsed so a whitespace-only
 * difference does not defeat the dedup.
 */
export function dedupTitle(item: BacklogItem): string {
  return String(item.title ?? "").trim().replace(/\s+/g, " ");
}

/**
 * Render the issue body for a migrated item. Priority is PRESERVED (ADR-0031
 * invariant) as a body line since there is no orch priority label; the source
 * lane and Redis id are recorded for traceability of the one-time cutover.
 */
export function renderIssueBody(item: BacklogItem, lane: ActionableLane): string {
  const lines: string[] = [];
  const desc = typeof item.description === "string" ? item.description.trim() : "";
  lines.push(desc.length > 0 ? desc : "_(migrated from the Redis backlog; no description)_");
  lines.push("");
  lines.push("---");
  lines.push(`Migrated from the Redis backlog by the ADR-0031 cutover (#3438).`);
  lines.push(`- Source lane: \`${lane}\``);
  lines.push(`- Priority: ${item.priority ?? 0}`);
  if (item.id !== undefined && item.id !== null) {
    lines.push(`- Redis id: \`${String(item.id)}\``);
  }
  const reason = item.meta?.blockedReason;
  if (lane === "blocked" && typeof reason === "string" && reason.trim()) {
    lines.push(`- Blocked reason: ${reason.trim()}`);
  }
  return lines.join("\n");
}

/**
 * The minimum delay (ms) between consecutive `gh issue create` calls to stay at
 * or under `perHour` content-creations per rolling hour. A simple even-pacing
 * throttle: `3_600_000 / perHour` ms between creates keeps the cumulative rate
 * under the ceiling without a stateful token bucket. `perHour <= 0` disables the
 * throttle (returns 0) — reserved for tests; the CLI floors `--rate` at 1.
 */
export function throttleDelayMs(perHour: number): number {
  if (!Number.isFinite(perHour) || perHour <= 0) return 0;
  return Math.ceil(3_600_000 / perHour);
}

// ---------------------------------------------------------------------------
// CLI arg parsing (pure)
// ---------------------------------------------------------------------------

export interface CutoverArgs {
  apply: boolean;
  ratePerHour: number;
  repo: string | null;
  limit: number | null;
}

/**
 * Parse the cutover CLI argv (WITHOUT the leading `node script.ts`). Dry-run by
 * default; `--apply` writes. `--rate N` overrides the per-hour ceiling (floored
 * at 1). `--repo owner/repo` overrides the Target repo (defaults to
 * `getTargetGithubRepo()` at the I/O edge). `--limit N` caps how many items are
 * considered (a safety valve for a first --apply run).
 */
export function parseArgs(argv: string[]): CutoverArgs {
  const apply = argv.includes("--apply");
  const readValue = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    if (i === -1 || i + 1 >= argv.length) return null;
    return argv[i + 1];
  };
  const rawRate = readValue("--rate");
  const parsedRate = rawRate === null ? DEFAULT_RATE_PER_HOUR : Number(rawRate);
  const ratePerHour =
    Number.isFinite(parsedRate) && parsedRate >= 1 ? Math.floor(parsedRate) : DEFAULT_RATE_PER_HOUR;
  const repo = readValue("--repo");
  const rawLimit = readValue("--limit");
  const parsedLimit = rawLimit === null ? null : Number(rawLimit);
  const limit =
    parsedLimit !== null && Number.isFinite(parsedLimit) && parsedLimit >= 0
      ? Math.floor(parsedLimit)
      : null;
  return { apply, ratePerHour, repo, limit };
}

// ---------------------------------------------------------------------------
// I/O edge — dedup search + create (REST-first, gh)
// ---------------------------------------------------------------------------

/**
 * Lexical dedup: is there already an OPEN issue on `repo` whose title matches
 * `title`? Uses `gh api search/issues` (REST search pool) — never `gh --json` /
 * GraphQL (ADR-0031 Decision 6). Returns `true` (skip) on any lookup failure so
 * a search-side error can NEVER cause a double-file — the cutover errs toward
 * skipping, and a genuinely-missing item is re-filed on a later clean re-run.
 */
export async function issueTitleExists(repo: string, title: string): Promise<boolean> {
  const q = `repo:${repo} is:issue is:open in:title "${title.replace(/"/g, '\\"')}"`;
  // REST search endpoint via gh api; --jq is client-side post-processing of REST
  // JSON (NOT the gh --json/GraphQL path the ADR forbids).
  const res = await runExec(ghBin(), [
    "api",
    "-X",
    "GET",
    "search/issues",
    "-f",
    `q=${q}`,
    "--jq",
    ".total_count",
  ]);
  if (res.exitCode !== 0 || res.timedOut || res.spawnErrorCode) {
    console.error(
      `[cutover] dedup search failed for "${title}" — SKIPPING to avoid a double-file: ${res.stderr.slice(0, 200)}`,
    );
    return true;
  }
  const n = Number(res.stdout.trim());
  return Number.isFinite(n) && n > 0;
}

/**
 * File one migrated item as a GitHub issue via `gh issue create`.
 */
export async function createIssue(
  repo: string,
  title: string,
  body: string,
  labels: string[],
): Promise<{ ok: boolean; error?: string }> {
  const args = ["issue", "create", "--repo", repo, "--title", title, "--body", body];
  for (const l of labels) args.push("--label", l);
  const res = await ghExec(args);
  if (res.ok === true) return { ok: true };
  // res is now the failure arm of the discriminated GhResult union.
  return { ok: false, error: res.code };
}

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const repo = args.repo ?? getTargetGithubRepo();
  const delayMs = throttleDelayMs(args.ratePerHour);

  const backlog = await loadBacklog();
  let selected = selectActionableItems(backlog);
  if (args.limit !== null) selected = selected.slice(0, args.limit);

  const plan = selected.map(({ item, lane }) => ({
    item,
    lane,
    title: dedupTitle(item),
    labels: itemToLabels(item, lane),
  }));

  const laneCounts = plan.reduce<Record<string, number>>((acc, p) => {
    acc[p.lane] = (acc[p.lane] ?? 0) + 1;
    return acc;
  }, {});

  console.log(`[cutover] Target repo: ${repo}`);
  console.log(
    `[cutover] Actionable items to migrate: ${plan.length} ` +
      `(${ACTIONABLE_LANES.map(l => `${l}=${laneCounts[l] ?? 0}`).join(", ")})`,
  );
  console.log(
    `[cutover] Throttle: <=${args.ratePerHour} creations/hr => ${delayMs}ms between creates` +
      (args.limit !== null ? `; --limit ${args.limit}` : ""),
  );

  if (plan.length === 0) {
    console.log("[cutover] Nothing actionable to migrate — exiting.");
    return 0;
  }

  if (!args.apply) {
    console.log("[cutover] DRY-RUN (no --apply). Would file:");
    for (const p of plan) {
      console.log(`  - [${p.lane}] "${p.title}"  labels=[${p.labels.join(", ")}]`);
    }
    console.log(
      `[cutover] DRY-RUN complete — ${plan.length} candidate creations. Re-run with --apply to write.`,
    );
    return 0;
  }

  let created = 0;
  let skipped = 0;
  let failed = 0;
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i];
    if (!p.title) {
      console.error(`[cutover] SKIP item with empty title (Redis id ${String(p.item.id)})`);
      skipped++;
      continue;
    }
    const exists = await issueTitleExists(repo, p.title);
    if (exists) {
      console.log(`[cutover] skip (lexical dup): "${p.title}"`);
      skipped++;
      continue;
    }
    const body = renderIssueBody(p.item, p.lane);
    const res = await createIssue(repo, p.title, body, p.labels);
    if (res.ok) {
      created++;
      console.log(
        `[cutover] filed (${created}) [${p.lane}] "${p.title}"  labels=[${p.labels.join(", ")}]`,
      );
    } else {
      failed++;
      console.error(`[cutover] FAILED to file "${p.title}" (${res.error})`);
    }
    // Throttle only after an actual create; a dedup-skip did not spend the
    // content-creation budget, so it need not pace.
    if (res.ok && i < plan.length - 1) await sleep(delayMs);
  }

  console.log(
    `[cutover] DONE — created=${created}, skipped=${skipped} (dups/empty), failed=${failed}.`,
  );
  return failed > 0 ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    code => process.exit(code),
    err => {
      console.error("[cutover] crash:", err);
      process.exit(2);
    },
  );
}
