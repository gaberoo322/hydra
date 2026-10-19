/**
 * src/skills/plan.ts — pure whole-corpus write plan for operator playbooks
 * (ADR-0041 Decision 2; issue #4719, skills-epic 3/6).
 *
 * `planCorpus` turns the playbook corpus (contents already read by the caller)
 * into the exact set of files `scripts/sync-skills.sh` writes: each Claude
 * SKILL.md, each `reference_files` sibling (`{{SKILL_NAME}}` substituted), and
 * the companion `.claude/settings.json` copy. Fail-soft cases surface as
 * `skips`; fail-loud grammar/reference problems are AGGREGATED into `errors`
 * (never first-wins across the corpus).
 *
 * PURITY: no filesystem reads/writes, no process spawns. The only node import is
 * `node:path` (posix math, via playbook.ts's containment helper). `path` in each
 * write is SKILLS-DIR-RELATIVE posix; the caller joins the destination dir.
 *
 * NO THROW for grammar failures — same contract as `renderPlaybook`.
 */
import { posix } from "node:path";
import {
  containedPath,
  parseFrontmatter,
  renderPlaybook,
  stripTrailingNewlines,
  type PlaybookErrorCode,
} from "./playbook.ts";

export type PlanErrorCode = PlaybookErrorCode | "reference-escape" | "reference-unresolved" | "duplicate-write-path";

export interface CorpusInput {
  /** Absolute playbooks dir; used ONLY for containment path math + messages. */
  playbooksDir: string;
  /** Top-level playbooks (README.md already excluded by the caller). */
  playbooks: Array<{ fileName: string; text: string }>;
  /**
   * Fragment / vendored-base / `<name>.settings.json` contents keyed by the
   * playbooksDir-relative posix path (settings keyed by basename).
   */
  sources: ReadonlyMap<string, string>;
}

export interface PlanWrite {
  path: string;
  content: string;
}

export interface PlanSkip {
  playbook: string;
  reason: "no-frontmatter" | "missing-name-or-description";
}

export interface PlanError {
  playbook: string;
  code: PlanErrorCode;
  message: string;
}

export interface CorpusPlan {
  writes: PlanWrite[];
  skips: PlanSkip[];
  errors: PlanError[];
}

function baseName(fileName: string): string {
  return fileName.replace(/\.md$/, "");
}

/** The `reference_files` entries of a playbook, in declaration order. */
function referenceEntries(text: string): string[] {
  const parsed = parseFrontmatter(text);
  if (!parsed) return [];
  const v = parsed.fm.get("reference_files");
  if (v === undefined) return [];
  if (Array.isArray(v)) return v.filter((x) => x !== "");
  if (typeof v === "boolean") return v ? ["True"] : [];
  return v !== "" ? [v] : [];
}

/** Plan the whole corpus. Deterministic: playbooks in code-point order. */
export function planCorpus(input: CorpusInput): CorpusPlan {
  const writes: PlanWrite[] = [];
  const skips: PlanSkip[] = [];
  const errors: PlanError[] = [];
  const owner = new Map<string, string>();

  const addWrite = (playbook: string, path: string, content: string): void => {
    const prior = owner.get(path);
    if (prior !== undefined) {
      errors.push({
        playbook,
        code: "duplicate-write-path",
        message: `sync-skills: duplicate write path ${path} (from ${prior} and ${playbook})`,
      });
      return;
    }
    owner.set(path, playbook);
    writes.push({ path, content });
  };

  const sorted = [...input.playbooks].sort((a, b) => (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0));
  for (const pb of sorted) {
    const base = baseName(pb.fileName);
    const r = renderPlaybook({
      fileName: pb.fileName,
      text: pb.text,
      playbooksDir: input.playbooksDir,
      sources: input.sources,
    });
    if (r.kind === "skip") {
      skips.push({ playbook: base, reason: r.reason });
      continue;
    }
    if (r.kind === "error") {
      errors.push({ playbook: base, code: r.code, message: r.message });
      continue;
    }
    const name = r.name;

    // Resolve every reference first so ALL bad entries are reported together.
    const refWrites: PlanWrite[] = [];
    let refFailed = false;
    for (const ref of referenceEntries(pb.text)) {
      const contained = containedPath(input.playbooksDir, ref);
      if (!contained) {
        refFailed = true;
        errors.push({
          playbook: base,
          code: "reference-escape",
          message: `sync-skills: reference_files path escapes operator-playbooks/: ${ref} (in ${name})`,
        });
        continue;
      }
      const raw = input.sources.get(contained.key);
      if (raw === undefined) {
        refFailed = true;
        errors.push({
          playbook: base,
          code: "reference-unresolved",
          message: `sync-skills: unresolved reference_files ${ref} (in ${name}): no such fragment at ${contained.abs}`,
        });
        continue;
      }
      refWrites.push({
        path: `${name}/${posix.basename(ref)}`,
        content: stripTrailingNewlines(raw.split("{{SKILL_NAME}}").join(name)),
      });
    }
    if (refFailed) continue;

    addWrite(base, `${name}/SKILL.md`, r.content);
    const settings = input.sources.get(`${name}.settings.json`);
    if (settings !== undefined) addWrite(base, `${name}/.claude/settings.json`, settings);
    for (const w of refWrites) addWrite(base, w.path, w.content);
  }

  return { writes, skips, errors };
}
