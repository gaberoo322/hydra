#!/usr/bin/env -S npx tsx
/**
 * Skill-size ratchet — issue #2946 (parent epic #2944), on the Ratchet module (#5654).
 *
 * # The gap this closes
 *
 * Every playbook under docs/operator-playbooks/ is compiled by
 * scripts/sync-skills.sh into a ~/.claude/skills/<name>/SKILL.md that loads
 * into agent context, and every frontmatter `description` loads into EVERY
 * session's skill list. Nothing bounded their growth, so context load could
 * only creep upward. This check is a SHRINK-ONLY word-count ratchet over the
 * skill sources: a COUNTED ceiling (`ratchet.ts`) whose rows are keyed by
 * repo-relative path.
 *
 *   - `<path>`              body word count of every skill source
 *   - `<path>/description`  description word count, emitted ONLY when it
 *                           exceeds DESCRIPTION_WORD_CAP (50)
 *
 *   - a row above its baseline, or a new row → FAIL (growth needs a deliberate
 *                                              baseline raise in the same PR; a
 *                                              new playbook declares its size at
 *                                              birth; a description over 50
 *                                              words is a new row)
 *   - a row below its baseline, or a vanished file → HINT (the output lists the
 *                                              tightenable rows; --write-baseline
 *                                              only ever tightens)
 *
 * # What is measured
 *
 * Skill SOURCES only — the files sync-skills.sh actually turns into context
 * load: frontmattered docs/operator-playbooks/*.md (body = everything after
 * the closing frontmatter delimiter) plus docs/operator-playbooks/_fragments/*.md
 * content fragments (whole file; inlined into generated skills via @include).
 * Exempt: README.md at both levels and frontmatter-less docs (e.g. the
 * hydra-target-adversarial.md stub) — sync-skills never emits them as
 * skills. "Word" = whitespace token (split on /\s+/, drop
 * empties): dependency-free, deterministic, and monotone with token load.
 *
 * # Where it is enforced
 *
 * REQUIRED, via the required `test` job: the "the real playbooks" case in
 * test/skill-size-ratchet.test.mts runs this ratchet over the real playbooks
 * and the committed baseline, and fails `npm test` on any violation (#5631).
 * ci.yml (Verifier Core, ADR-0001/ADR-0015) is not edited for this — the
 * check rides the suite ci.yml already requires. The CLI step in
 * .github/workflows/advisory-checks.yml still runs too, as a readable
 * per-PR report.
 *
 * Usage:
 *   npx tsx scripts/ci/skill-size-ratchet.ts                    # check
 *   npx tsx scripts/ci/skill-size-ratchet.ts --write-baseline   # tighten only
 *
 * Update flow when a playbook must deliberately grow (STD-BASELINE-EDIT-ROWS):
 * make the change, raise exactly that file's row in
 * scripts/ci/skill-size-baseline.json to the measured count in the same PR
 * (hand-edit; never commit a blanket --write-baseline), and add a PR-body line
 * `Baseline-raise: scripts/ci/skill-size-baseline.json <path> - <reason>`.
 * A new playbook or fragment adds its own row the same way. Descriptions are
 * never raised: shorten them under the cap instead.
 */

import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { GateInvariantError } from "../../src/errors.ts";
import { frontmatterText, parseFrontmatter } from "../../src/skills/playbook.ts";
import { REPO_ROOT } from "./seam-check-lib.ts";
import { defineRatchet, runIfCli } from "./ratchet.ts";

/** Frontmatter description length above which a description becomes a (growth) row. */
export const DESCRIPTION_WORD_CAP = 50;

/** Word counts measured from a skill source file. */
export interface MeasuredEntry {
  /** Body word count (post-frontmatter for playbooks; whole file for fragments). */
  body: number;
  /** Frontmatter description word count. Absent for fragments. */
  description?: number;
}

/**
 * Measure one frontmattered playbook source using the shared ADR-0041 core
 * grammar (`src/skills/playbook.ts`). Returns `null` for a frontmatter-less
 * file (sync-skills skips those - not a skill source). Throws on MALFORMED
 * frontmatter (opens with `---` but never closes): silently exempting a
 * truncated header would hide a real skill source from the ratchet. That
 * fail-loud policy lives here, not in the core (the core's null means "skip").
 */
export function measureSkillSource(text: string): MeasuredEntry | null {
  const parsed = parseFrontmatter(text);
  if (parsed === null) {
    if (text.startsWith("---\n")) {
      throw new GateInvariantError(
        "malformed frontmatter: file opens with `---` but has no closing `---` delimiter",
      );
    }
    return null;
  }
  return {
    body: countWords(parsed.body),
    description: countWords(frontmatterText(parsed.fm, "description")),
  };
}

/** Whitespace-token word count: split on /\s+/, drop empties. Pure. */
export function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

async function listMarkdown(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "README.md")
    .map((e) => e.name)
    .sort();
}

/**
 * Measure every skill source under `root`: frontmattered playbooks (body +
 * description counts) and _fragments content fragments (whole-file body count).
 * Frontmatter-less playbook-dir docs are exempt (sync-skills skips them).
 */
export async function measureSkillSources(
  root: string = REPO_ROOT,
): Promise<Record<string, MeasuredEntry>> {
  const playbooksDir = join(root, "docs/operator-playbooks");
  const fragmentsDir = join(playbooksDir, "_fragments");
  const measured: Record<string, MeasuredEntry> = {};

  for (const name of await listMarkdown(playbooksDir)) {
    const abs = join(playbooksDir, name);
    const rel = relative(root, abs);
    const text = await readFile(abs, "utf8");
    let entry: MeasuredEntry | null;
    try {
      entry = measureSkillSource(text);
    } catch (err) {
      throw new GateInvariantError(`${rel}: ${(err as Error).message}`);
    }
    if (entry === null) continue; // not a skill source - exempt
    measured[rel] = entry;
  }

  for (const name of await listMarkdown(fragmentsDir)) {
    const abs = join(fragmentsDir, name);
    const rel = relative(root, abs);
    measured[rel] = { body: countWords(await readFile(abs, "utf8")) };
  }

  return measured;
}

export const skillSizeRatchet = defineRatchet({
  id: "skill-size-ratchet",
  baseline: "scripts/ci/skill-size-baseline.json",
  shape: "counted",
  polarity: "ceiling",
  stale: "hint",
  enforcement: "required",
  async measure(root) {
    const rows: Record<string, number> = {};
    for (const [path, entry] of Object.entries(await measureSkillSources(resolve(root)))) {
      rows[path] = entry.body;
      if (entry.description !== undefined && entry.description > DESCRIPTION_WORD_CAP) {
        rows[`${path}/description`] = entry.description;
      }
    }
    return rows;
  },
  help: [
    "Generated skills load into agent context on every dispatch; this ratchet only shrinks.",
    "Shrink the file (or shorten a description to 50 words or fewer) rather than raising the row.",
  ],
});

runIfCli(import.meta.url, skillSizeRatchet);
