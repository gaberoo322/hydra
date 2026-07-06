#!/usr/bin/env -S npx tsx
/**
 * Skill-size ratchet — issue #2946 (parent epic #2944).
 *
 * # The gap this closes
 *
 * Every playbook under docs/operator-playbooks/ is compiled by
 * scripts/sync-skills.sh into a ~/.claude/skills/<name>/SKILL.md that loads
 * into agent context, and every frontmatter `description` loads into EVERY
 * session's skill list. Nothing bounded their growth, so context load could
 * only creep upward. This check is a SHRINK-ONLY word-count ratchet over the
 * skill sources, in the spirit of the deadcode / seam-check baseline idiom:
 *
 *   - body words  > baseline entry            → FAIL (growth needs a deliberate
 *                                                baseline raise in the same PR)
 *   - body words <= baseline entry            → PASS (an untightened shrink
 *                                                stays green; output nudges
 *                                                running --write-baseline)
 *   - description words > max(50, baseline)   → FAIL (grandfathered over-cap
 *                                                descriptions can only shrink;
 *                                                everything at/below 50 — and
 *                                                every NEW playbook — is
 *                                                hard-capped at 50)
 *   - skill source missing from baseline      → FAIL (seed with --write-baseline)
 *   - baseline entry whose file is gone       → FAIL (prune with --write-baseline)
 *
 * # What is measured
 *
 * Skill SOURCES only — the files sync-skills.sh actually turns into context
 * load: frontmattered docs/operator-playbooks/*.md (body = everything after
 * the closing frontmatter delimiter) plus docs/operator-playbooks/_fragments/*.md
 * content fragments (whole file; inlined into generated skills via @include).
 * Exempt: README.md at both levels and frontmatter-less docs (e.g.
 * ollama-recovery.md, the hydra-target-adversarial.md stub) — sync-skills
 * never emits them as skills. "Word" = whitespace token (split on /\s+/, drop
 * empties): dependency-free, deterministic, and monotone with token load.
 *
 * # Why a separate workflow, not ci.yml
 *
 * ci.yml is Verifier Core (ADR-0001/ADR-0015). A NEW verification lands as a
 * Tier-3 sibling workflow (.github/workflows/skill-size-ratchet.yml) — the
 * ast-grep-lint / comby-check / test-typecheck precedent. Advisory in the
 * seam-checks sense: the job goes red on violation but is never a required
 * branch-protection check.
 *
 * Usage:
 *   npx tsx scripts/ci/skill-size-ratchet.ts                    # check
 *   npx tsx scripts/ci/skill-size-ratchet.ts --write-baseline   # (re)seed
 *
 * Update flow when a playbook must deliberately grow: make the change, re-run
 * with --write-baseline, and commit the raised baseline entry alongside it —
 * the reviewed-growth escape valve of the baseline-ratchet idiom.
 */

import { readFile, writeFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const PLAYBOOKS_DIR = join(REPO_ROOT, "docs/operator-playbooks");
const FRAGMENTS_DIR = join(PLAYBOOKS_DIR, "_fragments");
const BASELINE_PATH = join(REPO_ROOT, "scripts/ci/skill-size-baseline.json");
const BASELINE_REL = "scripts/ci/skill-size-baseline.json";
const WRITE_BASELINE_CMD =
  "npx tsx scripts/ci/skill-size-ratchet.ts --write-baseline";

/** Hard cap on frontmatter description length for new / at-cap playbooks. */
export const DESCRIPTION_WORD_CAP = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Word counts measured from a skill source file. */
export interface MeasuredEntry {
  /** Body word count (post-frontmatter for playbooks; whole file for fragments). */
  body: number;
  /** Frontmatter description word count. Absent for fragments. */
  description?: number;
}

/** A committed baseline entry — same shape as MeasuredEntry. */
export type BaselineEntry = MeasuredEntry;

export interface BaselineFile {
  note: string;
  files: Record<string, BaselineEntry>;
}

export type ViolationRule =
  | "baseline-missing"
  | "missing-baseline-entry"
  | "body-grew"
  | "description-over-cap"
  | "stale-baseline-entry";

export interface Violation {
  path: string;
  rule: ViolationRule;
  current?: number;
  allowed?: number;
  message: string;
}

export interface CompareResult {
  violations: Violation[];
  /** Files measuring BELOW baseline — green, but the baseline could tighten. */
  shrunk: Array<{ path: string; current: number; baseline: number }>;
}

// ---------------------------------------------------------------------------
// Pure core — exported for the regression test (test/skill-size-ratchet.test.mts)
// ---------------------------------------------------------------------------

/**
 * Split a playbook into frontmatter + body, mirroring sync-skills.sh's parse
 * (`^---\n(.*?)\n---\n(.*)$` DOTALL). Returns `frontmatter: null` for a
 * frontmatter-less file (sync-skills skips those — they are not skill sources).
 * Throws on MALFORMED frontmatter (opens with `---` but never closes): silently
 * exempting a truncated header would hide a real skill source from the ratchet.
 */
export function splitFrontmatter(text: string): {
  frontmatter: string | null;
  body: string;
} {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (m) return { frontmatter: m[1], body: m[2] };
  if (text.startsWith("---\n")) {
    throw new Error(
      "malformed frontmatter: file opens with `---` but has no closing `---` delimiter",
    );
  }
  return { frontmatter: null, body: text };
}

/**
 * Extract the `description:` value from raw frontmatter, mirroring
 * sync-skills.sh's line-based `k: v` parse (strip one layer of quotes).
 * Returns "" when absent.
 */
export function extractDescription(frontmatterRaw: string): string {
  for (const rawLine of frontmatterRaw.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith("#") || !line.includes(":")) continue;
    const idx = line.indexOf(":");
    const key = line.slice(0, idx).trim();
    if (key !== "description") continue;
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return "";
}

/** Whitespace-token word count: split on /\s+/, drop empties. Pure. */
export function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

/**
 * Effective description cap for a file: max(50, grandfathered baseline count).
 * Playbooks seeded over 50 words can only shrink; everything at/below 50 —
 * and every new playbook (no baseline entry) — is hard-capped at 50.
 */
export function effectiveDescriptionCap(baselineEntry?: BaselineEntry): number {
  return Math.max(DESCRIPTION_WORD_CAP, baselineEntry?.description ?? 0);
}

/**
 * Compare measured skill-source sizes against the committed baseline.
 * Pure — no I/O. `baseline === null` means the baseline file does not exist.
 */
export function compareAgainstBaseline(
  measured: Record<string, MeasuredEntry>,
  baseline: BaselineFile | null,
): CompareResult {
  const violations: Violation[] = [];
  const shrunk: CompareResult["shrunk"] = [];

  if (baseline === null) {
    violations.push({
      path: BASELINE_REL,
      rule: "baseline-missing",
      message:
        `baseline file ${BASELINE_REL} is missing — seed it with ` +
        `\`${WRITE_BASELINE_CMD}\` and commit the result.`,
    });
    return { violations, shrunk };
  }

  for (const [path, entry] of Object.entries(measured)) {
    const base = baseline.files[path];

    if (base === undefined) {
      violations.push({
        path,
        rule: "missing-baseline-entry",
        current: entry.body,
        message:
          `${path} is a skill source with NO baseline entry (new playbook/fragment ` +
          `makes its size declaration at birth) — run \`${WRITE_BASELINE_CMD}\` ` +
          `and commit the updated ${BASELINE_REL}.`,
      });
    } else {
      if (entry.body > base.body) {
        violations.push({
          path,
          rule: "body-grew",
          current: entry.body,
          allowed: base.body,
          message:
            `${path} body grew: ${entry.body} words > baseline ${base.body} ` +
            `(+${entry.body - base.body}). Shrink the file, or for DELIBERATE growth ` +
            `run \`${WRITE_BASELINE_CMD}\` and commit the raised entry in this PR.`,
        });
      } else if (entry.body < base.body) {
        shrunk.push({ path, current: entry.body, baseline: base.body });
      }
    }

    if (entry.description !== undefined) {
      const cap = effectiveDescriptionCap(base);
      if (entry.description > cap) {
        const grandfathered = cap > DESCRIPTION_WORD_CAP;
        violations.push({
          path,
          rule: "description-over-cap",
          current: entry.description,
          allowed: cap,
          message:
            `${path} frontmatter description is ${entry.description} words > ` +
            `allowed ${cap} (${grandfathered ? `grandfathered baseline — shrink-only` : `hard cap ${DESCRIPTION_WORD_CAP}`}). ` +
            `Shorten the description — the cap never rises above its baselined count.`,
        });
      }
    }
  }

  for (const path of Object.keys(baseline.files)) {
    if (!(path in measured)) {
      violations.push({
        path,
        rule: "stale-baseline-entry",
        message:
          `baseline entry ${path} has no matching skill source (file deleted or ` +
          `no longer a skill source) — run \`${WRITE_BASELINE_CMD}\` to prune it.`,
      });
    }
  }

  return { violations, shrunk };
}

// ---------------------------------------------------------------------------
// I/O — walking the skill sources, loading/writing the baseline
// ---------------------------------------------------------------------------

async function listMarkdown(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "README.md")
    .map((e) => e.name)
    .sort();
}

/**
 * Measure every skill source: frontmattered playbooks (body + description
 * counts) and _fragments content fragments (whole-file body count).
 * Frontmatter-less playbook-dir docs are exempt (sync-skills skips them).
 */
export async function measureSkillSources(): Promise<Record<string, MeasuredEntry>> {
  const measured: Record<string, MeasuredEntry> = {};

  for (const name of await listMarkdown(PLAYBOOKS_DIR)) {
    const abs = join(PLAYBOOKS_DIR, name);
    const rel = relative(REPO_ROOT, abs);
    const text = await readFile(abs, "utf8");
    let split;
    try {
      split = splitFrontmatter(text);
    } catch (err) {
      throw new Error(`${rel}: ${(err as Error).message}`);
    }
    if (split.frontmatter === null) continue; // not a skill source — exempt
    measured[rel] = {
      body: countWords(split.body),
      description: countWords(extractDescription(split.frontmatter)),
    };
  }

  for (const name of await listMarkdown(FRAGMENTS_DIR)) {
    const abs = join(FRAGMENTS_DIR, name);
    const rel = relative(REPO_ROOT, abs);
    const text = await readFile(abs, "utf8");
    measured[rel] = { body: countWords(text) };
  }

  return measured;
}

async function loadBaseline(): Promise<BaselineFile | null> {
  let raw: string;
  try {
    raw = await readFile(BASELINE_PATH, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `malformed baseline JSON at ${BASELINE_REL}: ${(err as Error).message} — ` +
        `fix it or regenerate with \`${WRITE_BASELINE_CMD}\`.`,
    );
  }
  const candidate = parsed as BaselineFile;
  if (typeof candidate !== "object" || candidate === null || typeof candidate.files !== "object" || candidate.files === null) {
    throw new Error(
      `malformed baseline at ${BASELINE_REL}: expected {note, files:{...}} — ` +
        `regenerate with \`${WRITE_BASELINE_CMD}\`.`,
    );
  }
  for (const [path, entry] of Object.entries(candidate.files)) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.body !== "number" ||
      (entry.description !== undefined && typeof entry.description !== "number")
    ) {
      throw new Error(
        `malformed baseline entry for ${path} in ${BASELINE_REL}: expected ` +
          `{body:number, description?:number} — regenerate with \`${WRITE_BASELINE_CMD}\`.`,
      );
    }
  }
  return candidate;
}

async function writeBaselineFile(measured: Record<string, MeasuredEntry>): Promise<void> {
  const files: Record<string, BaselineEntry> = {};
  for (const path of Object.keys(measured).sort()) files[path] = measured[path];
  const payload: BaselineFile = {
    note:
      `Auto-generated by ${WRITE_BASELINE_CMD} on ${new Date().toISOString()}. ` +
      `Issue #2946 shrink-only word-count ratchet over playbook-generated skill sources ` +
      `(docs/operator-playbooks/*.md with frontmatter + _fragments/*.md). Body counts may ` +
      `only be raised deliberately in the same PR that grows the file; description caps ` +
      `are max(50, baselined count) and only shrink.`,
    files,
  };
  await writeFile(BASELINE_PATH, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const measured = await measureSkillSources();

  if (process.argv.includes("--write-baseline")) {
    await writeBaselineFile(measured);
    console.log(
      `[skill-size-ratchet] Wrote baseline for ${Object.keys(measured).length} skill source(s) to ${BASELINE_REL}`,
    );
    return 0;
  }

  const baseline = await loadBaseline();
  const { violations, shrunk } = compareAgainstBaseline(measured, baseline);

  for (const s of shrunk) {
    console.log(
      `[skill-size-ratchet] note: ${s.path} shrank (${s.current} < baseline ${s.baseline}) — ` +
        `green, but consider tightening via \`${WRITE_BASELINE_CMD}\`.`,
    );
  }

  if (violations.length > 0) {
    console.error(
      `[skill-size-ratchet] FAIL — ${violations.length} violation(s) (issue #2946 shrink-only skill-size ratchet):`,
    );
    for (const v of violations) {
      console.error(`  [${v.rule}] ${v.message}`);
    }
    console.error("");
    console.error(
      "Generated skills load into agent context on every dispatch; this ratchet only shrinks.",
    );
    return 1;
  }

  console.log(
    `[skill-size-ratchet] OK — ${Object.keys(measured).length} skill source(s) within baseline; descriptions within cap.`,
  );
  return 0;
}

// Only run as a CLI — importing the module (from the regression test) must not
// walk the filesystem or process.exit.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error("[skill-size-ratchet] crash:", err);
      process.exit(2);
    },
  );
}
