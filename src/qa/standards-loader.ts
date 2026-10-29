/**
 * Coding-standards loader (S4, #5260; ADR-0046, #5186).
 *
 * `CODING_STANDARDS.md` at a reviewed repo's ROOT is the Standards reviewer's
 * rule catalog. This module owns the file's rule grammar, its integrity rules
 * and the word-count ratchet comparison. Everything is pure except the one
 * injected read; nothing here throws — callers get result objects.
 *
 * Grammar: an h2 area section (`## Code`, `## Tests`, `## Design`, ...) holds
 * h3 rules `### STD-<AREA>-<NAME>`. A rule body runs to the next heading and
 * holds exactly one `enforced-by: <v>[, <v>...]` line, each `<v>` the literal
 * `reviewer` or a repo-relative path.
 *
 * `countWords` mirrors scripts/ci/skill-size-ratchet.ts (whitespace-split
 * tokens); src/ cannot import scripts/ (tsconfig rootDir), so it is defined here.
 */
import { readFile as fsReadFile } from "node:fs/promises";
import { join } from "node:path";

/** The catalog is inlined into every Standards review, so size is a per-PR token cost. */
export const CODING_STANDARDS_WORD_CEILING = 2000;

export const CODING_STANDARDS_FILENAME = "CODING_STANDARDS.md";

const RULE_ID_RE = /^STD-[A-Z]+(-[A-Z0-9]+)+$/;
const ID_TOKEN_RE = /\bSTD-[A-Z]+(?:-[A-Z0-9]+)+\b/g;

export interface StandardsRule {
  id: string;
  area: string;
  enforcedBy: string[];
  /** Count of `enforced-by:` lines found in the body (integrity wants exactly 1). */
  enforcedByLines: number;
  body: string;
}

export interface StandardsSection {
  area: string;
  ruleIds: string[];
}

export interface ParsedStandards {
  sections: StandardsSection[];
  rules: StandardsRule[];
}

export type IntegrityCode =
  | "ceiling-exceeded"
  | "duplicate-rule-id"
  | "invalid-rule-id"
  | "missing-enforced-by"
  | "dangling-enforced-by"
  | "dangling-fence-id"
  | "missing-section"
  | "empty-section";

export interface IntegrityProblem {
  code: IntegrityCode;
  message: string;
}

export type LoadResult =
  | { ok: true; found: true; path: string; text: string; parsed: ParsedStandards }
  | { ok: true; found: false; path: string }
  | { ok: false; code: "standards-read-failed"; path: string; message: string };

/** Whitespace-token word count. Pure. */
export function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

/** Parse the catalog. Pure; never throws. */
export function parseCodingStandards(text: string): ParsedStandards {
  const sections: StandardsSection[] = [];
  const rules: StandardsRule[] = [];
  let area: string | null = null;
  let current: StandardsRule | null = null;
  let section: StandardsSection | null = null;
  const bodyLines: string[] = [];

  const flush = () => {
    if (!current) return;
    current.body = bodyLines.join("\n").trim();
    const values: string[] = [];
    let count = 0;
    for (const line of bodyLines) {
      const m = /^\s*enforced-by:\s*(.*)$/.exec(line);
      if (!m) continue;
      count++;
      for (const v of m[1].split(",")) {
        const t = v.trim();
        if (t) values.push(t);
      }
    }
    current.enforcedBy = values;
    current.enforcedByLines = count;
    bodyLines.length = 0;
    current = null;
  };

  for (const line of String(text ?? "").split(/\r?\n/)) {
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    const h3 = /^###\s+(.+?)\s*$/.exec(line);
    if (h3) {
      flush();
      const id = h3[1];
      current = { id, area: area ?? "", enforcedBy: [], enforcedByLines: 0, body: "" };
      rules.push(current);
      section?.ruleIds.push(id);
      continue;
    }
    if (h2 && !line.startsWith("###")) {
      flush();
      area = h2[1];
      section = { area, ruleIds: [] };
      sections.push(section);
      continue;
    }
    if (/^#\s/.test(line)) {
      flush();
      continue;
    }
    if (current) bodyLines.push(line);
  }
  flush();
  return { sections, rules };
}

export interface IntegrityDeps {
  /** Raw CLAUDE.md text, scanned for `STD-*` fence tokens. Omit to skip. */
  claudeMdText?: string;
  /** Does this repo-relative path exist? Injected so tests need no filesystem. */
  pathExists: (relPath: string) => boolean;
  /** Section areas that must exist with >=1 rule. Default: Tests, Design. */
  requiredSections?: string[];
}

/** Check the catalog's structural integrity. Pure; never throws. */
export function checkStandardsIntegrity(
  text: string,
  parsed: ParsedStandards,
  deps: IntegrityDeps,
): IntegrityProblem[] {
  const problems: IntegrityProblem[] = [];
  const add = (code: IntegrityCode, message: string) => problems.push({ code, message });

  const words = countWords(text);
  if (words > CODING_STANDARDS_WORD_CEILING) {
    add("ceiling-exceeded", `${CODING_STANDARDS_FILENAME} has ${words} words; ceiling is ${CODING_STANDARDS_WORD_CEILING}`);
  }

  const seen = new Set<string>();
  for (const r of parsed.rules) {
    if (!RULE_ID_RE.test(r.id)) add("invalid-rule-id", `rule heading "${r.id}" does not match ${RULE_ID_RE}`);
    if (seen.has(r.id)) add("duplicate-rule-id", `rule id ${r.id} is defined more than once`);
    seen.add(r.id);
    if (r.enforcedByLines !== 1 || r.enforcedBy.length === 0) {
      add("missing-enforced-by", `${r.id} needs exactly one non-empty "enforced-by:" line (found ${r.enforcedByLines})`);
    }
    for (const v of r.enforcedBy) {
      if (v === "reviewer") continue;
      let exists = false;
      try {
        exists = deps.pathExists(v);
      } catch (err) {
        console.error(`[standards-loader] pathExists(${v}) threw:`, err);
      }
      if (!exists) add("dangling-enforced-by", `${r.id} cites enforced-by path "${v}" which does not exist`);
    }
  }

  for (const area of deps.requiredSections ?? ["Tests", "Design"]) {
    const s = parsed.sections.find((x) => x.area.toLowerCase() === area.toLowerCase());
    if (!s) add("missing-section", `required section "## ${area}" is missing`);
    else if (s.ruleIds.length === 0) add("empty-section", `section "## ${area}" has no rules`);
  }

  const defined = new Set(parsed.rules.map((r) => r.id));
  const scan = (source: string, label: string, stripOwnHeadings: boolean) => {
    const body = stripOwnHeadings ? source.replace(/^###\s+.*$/gm, "") : source;
    for (const tok of new Set(body.match(ID_TOKEN_RE) ?? [])) {
      if (!defined.has(tok)) add("dangling-fence-id", `${label} references ${tok}, which names no defined rule`);
    }
  };
  scan(text, CODING_STANDARDS_FILENAME, true);
  if (typeof deps.claudeMdText === "string") scan(deps.claudeMdText, "CLAUDE.md", false);

  return problems;
}

export interface WordBaselineEntry {
  words: number;
}
export interface WordBaseline {
  files: Record<string, WordBaselineEntry>;
}
export type RatchetCode = "word-count-grew" | "word-count-untightened" | "baseline-over-ceiling" | "baseline-missing";
export interface RatchetProblem {
  code: RatchetCode;
  file: string;
  message: string;
}

/**
 * Two-sided word ratchet: growth fails, shrink fails (print the number to
 * paste), and a baseline may never exceed the ceiling. Pure; never throws.
 */
export function compareWordBaseline(
  baseline: WordBaseline,
  actual: Record<string, number>,
): RatchetProblem[] {
  const out: RatchetProblem[] = [];
  for (const [file, words] of Object.entries(actual)) {
    const entry = baseline?.files?.[file];
    if (!entry || typeof entry.words !== "number") {
      out.push({ code: "baseline-missing", file, message: `${file} has no baseline; set words to ${words}` });
      continue;
    }
    if (file === CODING_STANDARDS_FILENAME && entry.words > CODING_STANDARDS_WORD_CEILING) {
      out.push({ code: "baseline-over-ceiling", file, message: `${file} baseline ${entry.words} exceeds ceiling ${CODING_STANDARDS_WORD_CEILING}` });
    }
    if (words > entry.words) {
      out.push({ code: "word-count-grew", file, message: `${file} grew to ${words} words (baseline ${entry.words}); trim it, or bump the baseline deliberately in this PR` });
    } else if (words < entry.words) {
      out.push({ code: "word-count-untightened", file, message: `${file} shrank to ${words} words (baseline ${entry.words}); tighten the baseline: set "words": ${words}` });
    }
  }
  return out;
}

export interface LoaderDeps {
  readFile: (path: string) => Promise<string>;
}

/**
 * Load `<repoRoot>/CODING_STANDARDS.md` and nothing else. ENOENT is a
 * legitimate "no catalog" state; any other read error is surfaced.
 */
export async function loadCodingStandards(
  repoRoot: string,
  deps: Partial<LoaderDeps> = {},
): Promise<LoadResult> {
  const readFile = deps.readFile ?? ((p: string) => fsReadFile(p, "utf8"));
  const path = join(repoRoot, CODING_STANDARDS_FILENAME);
  let text: string;
  try {
    text = await readFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { ok: true, found: false, path };
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[standards-loader] failed to read ${path}:`, err);
    return { ok: false, code: "standards-read-failed", path, message };
  }
  return { ok: true, found: true, path, text, parsed: parseCodingStandards(text) };
}
