/**
 * Dispatch-Class Taxonomy — the typed TS view over the single machine-readable
 * class table at `scripts/autopilot/classes.json` (epic #1669, slice #1670).
 *
 * `decide.py` (the brain, ADR-0012) derives its `PIPELINE_SLOTS` /
 * `SIGNAL_CLASSES` / `SIGNAL_COOLDOWNS` tuples from the SAME file at import
 * time, so the Python and TS views can never drift: there is exactly one
 * alphabet. This module re-exports that alphabet as typed rows + per-class
 * lookups so every hand-maintained TS projection (slice #1671 folds
 * `skillToCostClass` in `src/cost/cost-attribution.ts`,
 * `agentForSkill`/`VALID_SKILLS` in `src/pattern-memory/subagent-capture.ts`,
 * and the hand-mirrored scout cooldown in `src/scout/calendar-walk.ts`;
 * slice #1672 replaces the fictional hand-listed class-label plane that
 * lived in `src/github/issues.ts` with the derived provenance vocabulary
 * below)
 * becomes a column read — adding a class then forces an explicit decision on
 * every projection instead of a silent fallthrough to `other`/`unclassified`.
 *
 * # Fail-loud contract
 *
 * The table is loaded ONCE at module import. A missing/malformed file or a
 * row violating the column contract throws `InvariantViolationError`
 * (`code: "invariant-violation"`) — mirroring decide.py's `TaxonomyError`
 * hard-fail. There is DELIBERATELY no fallback row set: a silent fallback
 * would resurrect the four-file taxonomy drift this table exists to kill.
 * (This is a boundary/invariant guard, not merge/grounding/verification
 * code, so throwing is the documented convention — CLAUDE.md.)
 *
 * The raw parser is exported as {@link parseClassTaxonomy} (pure: JSON text
 * in, validated rows out) so tests can pin the failure modes without
 * touching the real file.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { InvariantViolationError } from "../errors.ts";

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

/** `pipeline` = slot semantics (≤1 in flight); `signal` = cooldown-gated. */
type DispatchClassKind = "pipeline" | "signal";

/** Which side of the system the class works on; `health` alone is `both`. */
type DispatchClassScope = "orch" | "target" | "both";

/** Which pattern-memory agent the class's lessons train (null = neither). */
type LearningAgent = "planner" | "executor";

/** One row of the Dispatch-Class Taxonomy. Nullable columns are always
 * present (explicit `null`, never absent) so a projection miss is loud. */
export interface DispatchClassRow {
  /** The class name decide.py dispatches on, e.g. `dev_orch`. */
  readonly name: string;
  readonly kind: DispatchClassKind;
  /** The Claude Code skill the class dispatches, e.g. `hydra-dev`. */
  readonly skill: string;
  /** Cost-attribution bucket (`src/cost/cost-attribution.ts` CostClass). */
  readonly costClass: string;
  readonly learningAgent: LearningAgent | null;
  /** Signal classes: seconds (≥0). Pipeline slots: null (no class cooldown). */
  readonly cooldownSeconds: number | null;
  readonly scope: DispatchClassScope;
  /** GitHub label the class's filing skill stamps; null = files nothing. */
  readonly provenanceLabel: string | null;
  /** Free-form design rationale (formerly inline comments in decide.py). */
  readonly notes?: string;
}

// ---------------------------------------------------------------------------
// Parser (pure — exported for tests)
// ---------------------------------------------------------------------------

const REQUIRED_COLUMNS = [
  "name",
  "kind",
  "skill",
  "costClass",
  "learningAgent",
  "cooldownSeconds",
  "scope",
  "provenanceLabel",
] as const;

const KINDS: readonly string[] = ["pipeline", "signal"];
const SCOPES: readonly string[] = ["orch", "target", "both"];
const LEARNING_AGENTS: readonly string[] = ["planner", "executor"];

function fail(reason: string): never {
  throw new InvariantViolationError(
    `dispatch-class taxonomy (scripts/autopilot/classes.json): ${reason} — ` +
      "no fallback row set exists (epic #1669 / issue #1670)",
  );
}

/**
 * Parse + validate the classes.json text. Pure: never reads the filesystem.
 * Throws `InvariantViolationError` on any contract violation — identical
 * rules to decide.py's `_load_class_taxonomy`.
 */
export function parseClassTaxonomy(jsonText: string): readonly DispatchClassRow[] {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch (err) {
    fail(`malformed JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (
    typeof raw !== "object" ||
    raw === null ||
    !Array.isArray((raw as { classes?: unknown }).classes)
  ) {
    fail('top level must be an object with a "classes" list');
  }
  const rows = (raw as { classes: unknown[] }).classes;
  if (rows.length === 0) fail('"classes" list is empty');

  const seen = new Set<string>();
  const out: DispatchClassRow[] = [];
  for (const [i, rowRaw] of rows.entries()) {
    if (typeof rowRaw !== "object" || rowRaw === null || Array.isArray(rowRaw)) {
      fail(`row ${i} is not an object`);
    }
    const row = rowRaw as Record<string, unknown>;
    const missing = REQUIRED_COLUMNS.filter((c) => !(c in row));
    if (missing.length > 0) {
      fail(
        `row ${i} (${String(row.name ?? "?")}) lacks required column(s): ` +
          missing.join(", "),
      );
    }
    const name = row.name;
    if (typeof name !== "string" || name === "") {
      fail(`row ${i}: name must be a non-empty string`);
    }
    if (seen.has(name)) fail(`duplicate class name: ${name}`);
    seen.add(name);
    if (typeof row.kind !== "string" || !KINDS.includes(row.kind)) {
      fail(`${name}: kind must be one of ${KINDS.join("|")}`);
    }
    if (typeof row.skill !== "string" || row.skill === "") {
      fail(`${name}: skill must be a non-empty string`);
    }
    if (typeof row.costClass !== "string" || row.costClass === "") {
      fail(`${name}: costClass must be a non-empty string`);
    }
    if (
      row.learningAgent !== null &&
      (typeof row.learningAgent !== "string" ||
        !LEARNING_AGENTS.includes(row.learningAgent))
    ) {
      fail(`${name}: learningAgent must be null or ${LEARNING_AGENTS.join("|")}`);
    }
    if (typeof row.scope !== "string" || !SCOPES.includes(row.scope)) {
      fail(`${name}: scope must be one of ${SCOPES.join("|")}`);
    }
    if (
      row.provenanceLabel !== null &&
      (typeof row.provenanceLabel !== "string" || row.provenanceLabel === "")
    ) {
      fail(`${name}: provenanceLabel must be null or a non-empty string`);
    }
    const cooldown = row.cooldownSeconds;
    if (row.kind === "signal") {
      if (typeof cooldown !== "number" || !Number.isInteger(cooldown) || cooldown < 0) {
        fail(`${name}: signal rows need a non-negative integer cooldownSeconds`);
      }
    } else if (cooldown !== null) {
      fail(`${name}: pipeline rows must carry cooldownSeconds: null`);
    }
    out.push({
      name,
      kind: row.kind as DispatchClassKind,
      skill: row.skill,
      costClass: row.costClass,
      learningAgent: row.learningAgent as LearningAgent | null,
      cooldownSeconds: cooldown as number | null,
      scope: row.scope as DispatchClassScope,
      provenanceLabel: row.provenanceLabel as string | null,
      ...(typeof row.notes === "string" ? { notes: row.notes } : {}),
    });
  }
  return Object.freeze(out);
}

// ---------------------------------------------------------------------------
// The loaded table + per-class lookups
// ---------------------------------------------------------------------------

const TAXONOMY_PATH = resolve(
  import.meta.dirname,
  "../../scripts/autopilot/classes.json",
);

function loadClassTaxonomy(): readonly DispatchClassRow[] {
  let text: string;
  try {
    text = readFileSync(TAXONOMY_PATH, "utf-8");
  } catch (err) {
    fail(
      `cannot read ${TAXONOMY_PATH} (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  return parseClassTaxonomy(text);
}

/** Every dispatch class, in dispatch order (file order — pipeline rows
 * first, then signal rows, matching decide.py's derived tuple order). */
export const DISPATCH_CLASSES: readonly DispatchClassRow[] = loadClassTaxonomy();

/** Pipeline-slot names, in slot order — mirrors decide.py `PIPELINE_SLOTS`. */
export const PIPELINE_SLOT_NAMES: readonly string[] = Object.freeze(
  DISPATCH_CLASSES.filter((r) => r.kind === "pipeline").map((r) => r.name),
);

/** Signal-class names, in order — mirrors decide.py `SIGNAL_CLASSES`. */
export const SIGNAL_CLASS_NAMES: readonly string[] = Object.freeze(
  DISPATCH_CLASSES.filter((r) => r.kind === "signal").map((r) => r.name),
);

/** Signal-class cooldowns (s) — mirrors decide.py `SIGNAL_COOLDOWNS`. */
export const SIGNAL_CLASS_COOLDOWNS: Readonly<Record<string, number>> =
  Object.freeze(
    Object.fromEntries(
      DISPATCH_CLASSES.filter((r) => r.kind === "signal").map((r) => [
        r.name,
        r.cooldownSeconds as number,
      ]),
    ),
  );

const BY_NAME: ReadonlyMap<string, DispatchClassRow> = new Map(
  DISPATCH_CLASSES.map((r) => [r.name, r]),
);

const BY_SKILL: ReadonlyMap<string, DispatchClassRow> = new Map(
  DISPATCH_CLASSES.map((r) => [r.skill, r]),
);

/** Look up a class row by class name (`dev_orch`, …). Undefined = unknown. */
export function classByName(name: string): DispatchClassRow | undefined {
  return BY_NAME.get(name);
}

/** Look up a class row by the skill it dispatches (`hydra-dev`, …). */
export function classBySkill(skill: string): DispatchClassRow | undefined {
  return BY_SKILL.get(skill);
}

/**
 * The trailing `_orch` / `_target` class token an autopilot `cycleId` ends with
 * (e.g. `worktree-agent-<uuid>-t8-dev_orch` → `dev_orch`). The third class
 * lookup alongside {@link classByName} / {@link classBySkill}: it names a class
 * by the cycleId format the dispatch harness stamps.
 */
const CYCLE_ID_CLASS_SUFFIX = /([a-z0-9]+_(?:orch|target))\s*$/i;

/**
 * Derive the producer class from a dispatch `cycleId`. Autopilot cycle ids end
 * with the signal class token (e.g. `worktree-agent-<uuid>-t8-dev_orch` →
 * `dev_orch`). We take the trailing `_orch` / `_target` token; anything we can't
 * parse maps to `"unknown"` so a merge is still counted (never dropped). PURE.
 *
 * The complement of {@link classByName} / {@link classBySkill}: this is the
 * "cycleId → class name" lookup, keeping all three ways to name a Dispatch Class
 * in the Taxonomy Module (issue #2920). Callers that want the full row can pass
 * the result to `classByName`.
 */
export function producerClassFromCycleId(cycleId: string | null | undefined): string {
  if (!cycleId) return "unknown";
  const m = cycleId.match(CYCLE_ID_CLASS_SUFFIX);
  return m ? m[1].toLowerCase() : "unknown";
}

// ---------------------------------------------------------------------------
// Provenance labels (slice #1672)
// ---------------------------------------------------------------------------

/**
 * The **provenance labels** the filing skills actually stamp on issues —
 * derived from the non-null `provenanceLabel` column rows, in file order.
 * "Provenance" = *which filing pipeline produced this issue*, NOT *which
 * autopilot class will handle it*: the repo's label inventory carries none of
 * the class names (`dev_orch`, …), so classifying issues by class labels was
 * fiction (#1672 deleted that plane from `src/github/issues.ts`).
 */
export const PROVENANCE_LABELS: readonly string[] = Object.freeze(
  DISPATCH_CLASSES.filter((r) => r.provenanceLabel !== null).map(
    (r) => r.provenanceLabel as string,
  ),
);

/**
 * Filing labels with NO owning dispatch class. Sentry incident filing stamps
 * `sentry` but no taxonomy row owns it — and a fake classes.json row would
 * pollute decide.py's `PIPELINE_SLOTS`/`SIGNAL_CLASSES` derivations, so the
 * residual list lives here as a constant instead (the honest shape). This is
 * the ONLY place provenance vocabulary may be hand-listed.
 */
export const RESIDUAL_PROVENANCE_LABELS: readonly string[] = Object.freeze([
  "sentry",
]);

const PROVENANCE_SET: ReadonlySet<string> = new Set([
  ...PROVENANCE_LABELS,
  ...RESIDUAL_PROVENANCE_LABELS,
]);

/**
 * Return the first provenance label on an issue/PR's labels, or `null` when
 * none match. Pure function over a labels array — no IO, never throws.
 * Case-sensitive (the `gh` payload preserves labels as stored). Consumers
 * that want a bucket name instead of `null` fold the null arm themselves
 * (e.g. backlog-flow's `"unclassified"` residual bucket).
 */
export function provenanceFromLabels(labels: readonly string[]): string | null {
  for (const label of labels) {
    if (typeof label === "string" && PROVENANCE_SET.has(label)) return label;
  }
  return null;
}
