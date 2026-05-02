/**
 * Specs — Redis-backed persistent task decomposition for multi-cycle work.
 *
 * When research or the operator identifies work that spans multiple cycles,
 * a spec is created with a decomposed task list. The planner reads the spec
 * and picks the next unchecked task each cycle, giving multi-cycle work a
 * persistent skeleton that survives across cycles.
 *
 * Lifecycle: active → completed → archived
 *
 * Redis schema:
 *   hydra:specs:{slug}     → Hash: spec fields (title, tasks JSON, status, etc.)
 *   hydra:specs:index      → Sorted Set: slug scored by creation timestamp
 */

import { redisKeys } from "./redis-keys.ts";
import {
  hashGetAll, hashSet, hashSetField, expireKey, zAdd, zRevRange,
  keyExists,
} from "./redis-adapter.ts";

const SPECS_INDEX = redisKeys.specsIndex();
const specKey = (slug) => redisKeys.spec(slug);

// Specs auto-expire after 30 days to prevent unbounded growth
const SPEC_TTL = 30 * 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SpecTask = {
  id: string;
  title: string;
  description?: string;
  completed: boolean;
  cycleId?: string;      // cycle that completed this task
  completedAt?: string;  // ISO timestamp
};

export type Spec = {
  slug: string;
  title: string;
  rationale: string;
  source: string;         // "research", "operator", "reframe"
  sourceId?: string;      // e.g. research ID or backlog item ID
  tasks: SpecTask[];
  status: "active" | "completed" | "archived";
  createdAt: string;
  completedAt?: string;
};

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/**
 * Create a new spec with decomposed tasks.
 * Returns the created spec, or null if a spec with the same slug already exists.
 */
export async function createSpec(opts: {
  title: string;
  rationale: string;
  source: string;
  sourceId?: string;
  tasks: Array<{ title: string; description?: string }>;
}): Promise<Spec | null> {
  const slug = slugify(opts.title);
  const key = specKey(slug);

  // Don't overwrite existing specs
  const exists = await keyExists(key);
  if (exists) {
    console.log(`[Specs] Spec "${slug}" already exists — skipping creation`);
    return null;
  }

  const tasks: SpecTask[] = opts.tasks.map((t, i) => ({
    id: String(i + 1),
    title: t.title,
    description: t.description,
    completed: false,
  }));

  const spec: Spec = {
    slug,
    title: opts.title,
    rationale: opts.rationale,
    source: opts.source,
    sourceId: opts.sourceId,
    tasks,
    status: "active",
    createdAt: new Date().toISOString(),
  };

  await hashSet(key,
    "slug", spec.slug,
    "title", spec.title,
    "rationale", spec.rationale,
    "source", spec.source,
    "sourceId", spec.sourceId || "",
    "tasks", JSON.stringify(spec.tasks),
    "status", spec.status,
    "createdAt", spec.createdAt,
  );
  await expireKey(key, SPEC_TTL);
  await zAdd(SPECS_INDEX, Date.now(), slug);

  console.log(`[Specs] Created spec "${slug}" with ${tasks.length} tasks (source: ${opts.source})`);
  return spec;
}

/**
 * Get a spec by slug.
 */
export async function getSpec(slug): Promise<Spec | null> {
  const raw = await hashGetAll(specKey(slug));
  if (!raw || !raw.slug) return null;
  return {
    ...raw,
    tasks: JSON.parse(raw.tasks || "[]"),
  } as Spec;
}

/**
 * List all active specs (specs with pending tasks).
 */
export async function getActiveSpecs(): Promise<Spec[]> {
  const slugs = await zRevRange(SPECS_INDEX, 0, -1);
  const specs: Spec[] = [];
  for (const slug of slugs) {
    const spec = await getSpec(slug);
    if (spec && spec.status === "active") {
      specs.push(spec);
    }
  }
  return specs;
}

/**
 * Get the next pending task from a spec, respecting task order.
 * Returns null if all tasks are complete.
 */
export function getNextTask(spec: Spec): SpecTask | null {
  return spec.tasks.find(t => !t.completed) || null;
}

/**
 * Get the next pending task across ALL active specs (oldest spec first).
 * Returns { spec, task } or null if nothing pending.
 */
export async function getNextSpecTask(): Promise<{ spec: Spec; task: SpecTask } | null> {
  const specs = await getActiveSpecs();
  for (const spec of specs) {
    const task = getNextTask(spec);
    if (task) return { spec, task };
  }
  return null;
}

/**
 * Mark a task as completed within a spec.
 * If all tasks are now complete, transitions spec to "completed".
 * Returns the updated spec.
 */
export async function markTaskComplete(slug, taskId, cycleId): Promise<Spec | null> {
  const spec = await getSpec(slug);
  if (!spec) return null;

  const task = spec.tasks.find(t => t.id === taskId);
  if (!task) {
    console.error(`[Specs] Task ${taskId} not found in spec "${slug}"`);
    return null;
  }

  task.completed = true;
  task.cycleId = cycleId;
  task.completedAt = new Date().toISOString();

  const allComplete = spec.tasks.every(t => t.completed);
  if (allComplete) {
    spec.status = "completed";
    spec.completedAt = new Date().toISOString();
    console.log(`[Specs] Spec "${slug}" completed — all ${spec.tasks.length} tasks done`);
  } else {
    const remaining = spec.tasks.filter(t => !t.completed).length;
    console.log(`[Specs] Spec "${slug}" task ${taskId} complete — ${remaining} remaining`);
  }

  await hashSet(specKey(slug),
    "tasks", JSON.stringify(spec.tasks),
    "status", spec.status,
    ...(spec.completedAt ? ["completedAt", spec.completedAt] : []),
  );

  return spec;
}

/**
 * Archive a completed spec (removes from active index).
 */
export async function archiveSpec(slug): Promise<boolean> {
  const spec = await getSpec(slug);
  if (!spec) return false;

  await hashSetField(specKey(slug), "status", "archived");
  // Keep in index for history but it won't show in getActiveSpecs
  console.log(`[Specs] Archived spec "${slug}"`);
  return true;
}

/**
 * List all specs (for dashboard/API).
 */
export async function listSpecs(limit = 20): Promise<Spec[]> {
  const slugs = await zRevRange(SPECS_INDEX, 0, limit - 1);
  const specs: Spec[] = [];
  for (const slug of slugs) {
    const spec = await getSpec(slug);
    if (spec) specs.push(spec);
  }
  return specs;
}

/**
 * Format a spec for injection into the planner prompt.
 * Concise: shows the spec title, completed tasks, and the next pending task.
 */
export function formatSpecForPrompt(spec: Spec, nextTask: SpecTask): string {
  const completed = spec.tasks.filter(t => t.completed);
  const remaining = spec.tasks.filter(t => !t.completed);

  const lines = [
    `## ACTIVE SPEC: "${spec.title}"`,
    `Rationale: ${spec.rationale.slice(0, 200)}`,
    `Progress: ${completed.length}/${spec.tasks.length} tasks complete`,
    ``,
  ];

  if (completed.length > 0) {
    lines.push(`Completed:`);
    for (const t of completed) {
      lines.push(`  [x] ${t.id}. ${t.title} (${t.cycleId})`);
    }
  }

  lines.push(`Remaining:`);
  for (const t of remaining) {
    lines.push(`  [ ] ${t.id}. ${t.title}${t.description ? ` — ${t.description}` : ""}`);
  }

  lines.push(``);
  lines.push(`YOUR TASK: Implement task ${nextTask.id} ("${nextTask.title}") from this spec.`);
  lines.push(`Keep scope narrow — just this one task. The remaining tasks will be handled in future cycles.`);

  return lines.join("\n");
}
