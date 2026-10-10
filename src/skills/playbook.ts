/**
 * src/skills/playbook.ts — pure TypeScript core for operator-playbook -> Claude
 * SKILL.md rendering (ADR-0041 Decision 1; issue #4718, skills-epic 2/6).
 *
 * This lands BESIDE the `scripts/sync-skills.sh` Python heredoc (strangler
 * step 1): the heredoc stays the production path and is byte-unchanged. A live
 * parity test (`test/skills-playbook-parity.test.mts`) proves this core renders
 * the exact bytes the script writes, for every live playbook.
 *
 * PURITY: no filesystem reads/writes, no process spawns. The only node import
 * is `node:path` (posix path math). Fragments and vendored bases arrive as a
 * `ReadonlyMap` keyed by the playbooks-dir-relative posix path.
 *
 * NO THROW for grammar failures: `renderPlaybook` returns a discriminated
 * result so callers (the whole-corpus plan, #4719) can aggregate every error.
 *
 * Accepted divergences from the heredoc (no live playbook triggers them; the
 * parity test is the oracle over live playbooks):
 *  - the bash `grep -q '"error"'` false-skip on a frontmatter key/item literally
 *    named `error`;
 *  - Python's full unicode `str.strip()` set beyond the explicit class below, and
 *    `repr()` escaping of non-printable unicode beyond control characters;
 *  - non-string `name` / `compose_base` values (the heredoc crashes on them).
 */
import { posix } from "node:path";

export type FrontmatterValue = string | boolean | string[];
export type Frontmatter = Map<string, FrontmatterValue>;

export type PlaybookErrorCode =
  | "include-escape"
  | "include-unresolved"
  | "include-nested"
  | "supersedes-without-compose"
  | "compose-base-escape"
  | "compose-base-unresolved"
  | "compose-base-no-frontmatter"
  | "supersedes-unresolved"
  | "supersedes-ambiguous";

export type RenderResult =
  | { kind: "skill"; name: string; content: string }
  | { kind: "skip"; reason: "no-frontmatter" | "missing-name-or-description" }
  | { kind: "error"; code: PlaybookErrorCode; message: string };

export interface RenderInput {
  /** Playbook file basename, e.g. "hydra-dev.md" (used only in messages). */
  fileName: string;
  /** Raw playbook markdown. */
  text: string;
  /** Absolute playbooks dir; used ONLY for containment path math + messages. */
  playbooksDir: string;
  /** Fragment / vendored-base contents keyed by playbooksDir-relative posix path. */
  sources: ReadonlyMap<string, string>;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
const INCLUDE_RE = /^[ \t]*@include[ \t]+(\S+)[ \t]*$/;
const HEADING_RE = /^(#{1,6})[ \t]+([^\n]*?)[ \t]*$/;
const SUPERSEDE_MARKER = "<!-- compose-seam-supersede -->";
const DEFAULT_ALLOWED_TOOLS = "Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*)";

class PlaybookFailure {
  code: PlaybookErrorCode;
  message: string;
  constructor(code: PlaybookErrorCode, message: string) {
    this.code = code;
    this.message = message;
  }
}

// ---- Python-semantics helpers ---------------------------------------------

const PY_WS = "\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_STRIP_RE = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "g");
const PY_RSTRIP_RE = new RegExp(`[${PY_WS}]+$`);

function pyStrip(s: string): string {
  return s.replace(PY_STRIP_RE, "");
}

function pyRstrip(s: string): string {
  return s.replace(PY_RSTRIP_RE, "");
}

/** Python `str.splitlines()` (no keepends). */
function pySplitlines(s: string): string[] {
  if (s === "") return [];
  const parts = s.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** Python `repr()` of a str. */
function pyRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const code = ch.codePointAt(0) as number;
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += "\\" + quote;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += "\\x" + code.toString(16).padStart(2, "0");
    else out += ch;
  }
  return out + quote;
}

/** Python `str(value)` for a frontmatter value. */
function pyStr(v: FrontmatterValue): string {
  if (typeof v === "boolean") return v ? "True" : "False";
  if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
  return v;
}

function pyTruthy(v: FrontmatterValue | undefined): boolean {
  if (v === undefined) return false;
  if (typeof v === "boolean") return v;
  return v.length > 0;
}

/** Bash `$(...)` semantics: trailing newlines removed. */
function stripTrailingNewlines(s: string): string {
  return s.replace(/\n+$/, "");
}

function stripOneQuotePair(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// ---- Frontmatter parse -----------------------------------------------------

export interface ParsedPlaybook {
  fm: Frontmatter;
  body: string;
}

/** Parse playbook text; `null` when the frontmatter regex does not match. */
export function parseFrontmatter(text: string): ParsedPlaybook | null {
  const m = FRONTMATTER_RE.exec(text);
  if (!m) return null;
  const fm: Frontmatter = new Map();
  const lines = pySplitlines(m[1]);
  let i = 0;
  while (i < lines.length) {
    const line = pyRstrip(lines[i]);
    i += 1;
    if (line === "" || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const k = pyStrip(line.slice(0, colon));
    let v: string = pyStrip(line.slice(colon + 1));
    if (v === "") {
      const items: string[] = [];
      while (i < lines.length) {
        const item = pyStrip(lines[i]);
        if (!item.startsWith("- ")) break;
        items.push(stripOneQuotePair(pyStrip(item.slice(2))));
        i += 1;
      }
      if (items.length > 0) {
        fm.set(k, items);
        continue;
      }
    }
    v = stripOneQuotePair(v);
    if (v.startsWith("[") && v.endsWith("]")) {
      const inner = pyStrip(v.slice(1, -1));
      const list = inner
        .split(",")
        .filter((x) => pyStrip(x) !== "")
        .map((x) => pyStrip(x).replace(/^"+|"+$/g, "").replace(/^'+|'+$/g, ""));
      fm.set(k, list);
    } else if (v.toLowerCase() === "true" || v.toLowerCase() === "false") {
      fm.set(k, v.toLowerCase() === "true");
    } else {
      fm.set(k, v);
    }
  }
  return { fm, body: m[2] };
}

// ---- @include resolution ---------------------------------------------------

function normDir(playbooksDir: string): string {
  const n = posix.normalize(playbooksDir);
  return n.length > 1 ? n.replace(/\/+$/, "") : n;
}

/** Resolve `rel` against the playbooks dir; `null` when it escapes it. */
function containedPath(playbooksDir: string, rel: string): { abs: string; key: string } | null {
  // Python `os.path.join` parity: an absolute `rel` REPLACES the dir.
  const abs = posix.normalize(rel.startsWith("/") ? rel : posix.join(playbooksDir, rel));
  const dir = normDir(playbooksDir);
  if (!abs.startsWith(dir + "/")) return null;
  return { abs, key: posix.relative(playbooksDir, abs) };
}

export interface IncludeContext {
  fileName: string;
  playbooksDir: string;
  sources: ReadonlyMap<string, string>;
  skillName: string;
}

/**
 * Resolve `@include <path>` lines in a body. Returns the resolved body, or a
 * failure for the first (top-down) offending include.
 */
export function resolveIncludes(body: string, ctx: IncludeContext): string | PlaybookFailure {
  const out: string[] = [];
  for (const line of body.split("\n")) {
    const mm = INCLUDE_RE.exec(line);
    if (!mm) {
      out.push(line);
      continue;
    }
    const fragRel = mm[1];
    const resolved = containedPath(ctx.playbooksDir, fragRel);
    if (!resolved) {
      return new PlaybookFailure(
        "include-escape",
        `sync-skills: @include path escapes operator-playbooks/: ${fragRel} (in ${ctx.fileName})`,
      );
    }
    const raw = ctx.sources.get(resolved.key);
    if (raw === undefined) {
      return new PlaybookFailure(
        "include-unresolved",
        `sync-skills: unresolved @include ${fragRel} (in ${ctx.fileName}): no such fragment at ${resolved.abs}`,
      );
    }
    let frag = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    frag = frag.split("{{SKILL_NAME}}").join(ctx.skillName);
    for (const fl of pySplitlines(frag)) {
      if (INCLUDE_RE.test(fl)) {
        return new PlaybookFailure(
          "include-nested",
          `sync-skills: nested @include in fragment ${fragRel} — includes are non-recursive (one level)`,
        );
      }
    }
    out.push(frag);
  }
  return out.join("\n");
}

// ---- compose_base ----------------------------------------------------------

function normHeading(s: string): string {
  return pyStrip(s.replace(/^#+/, ""));
}

/**
 * Compose a vendored base with the (include-resolved) overlay body. Returns the
 * composed body, or a failure.
 */
export function composeBase(
  resolvedOverlay: string,
  fm: Frontmatter,
  composeBaseRel: string,
  ctx: IncludeContext,
): string | PlaybookFailure {
  const { fileName, playbooksDir, sources, skillName } = ctx;
  const contained = containedPath(playbooksDir, composeBaseRel);
  if (!contained) {
    return new PlaybookFailure(
      "compose-base-escape",
      `sync-skills: compose_base path escapes operator-playbooks/: ${composeBaseRel} (in ${fileName})`,
    );
  }
  const baseText = sources.get(contained.key);
  if (baseText === undefined) {
    return new PlaybookFailure(
      "compose-base-unresolved",
      `sync-skills: unresolved compose_base ${composeBaseRel} (in ${fileName}): no such vendored base at ${contained.abs}`,
    );
  }
  const bm = FRONTMATTER_RE.exec(baseText);
  if (!bm) {
    return new PlaybookFailure(
      "compose-base-no-frontmatter",
      `sync-skills: compose_base ${composeBaseRel} has no frontmatter (in ${fileName}): a vendored base must be a well-formed upstream SKILL.md`,
    );
  }
  let baseBody = bm[2];

  const declared = fm.get("supersedes");
  let supersedes: string[];
  if (typeof declared === "string") supersedes = pyStrip(declared) !== "" ? [declared] : [];
  else if (Array.isArray(declared)) supersedes = declared;
  else supersedes = [];

  if (supersedes.length > 0) {
    const baseLines = baseBody.split("\n");
    for (const target of supersedes) {
      const want = normHeading(target);
      const headings: Array<{ idx: number; depth: number; text: string }> = [];
      baseLines.forEach((ln, idx) => {
        const hm = HEADING_RE.exec(ln);
        if (hm) headings.push({ idx, depth: hm[1].length, text: pyStrip(ln) });
      });
      const matches = headings.filter((h) => normHeading(h.text) === want);
      if (matches.length === 0) {
        return new PlaybookFailure(
          "supersedes-unresolved",
          `sync-skills: unresolved \`supersedes:\` heading ${pyRepr(target)} (in ${fileName}): the vendored base ${composeBaseRel} has no such heading. Its headings are: ` +
            (headings.length > 0 ? headings.map((h) => h.text).join("; ") : "(none)"),
        );
      }
      if (matches.length > 1) {
        return new PlaybookFailure(
          "supersedes-ambiguous",
          `sync-skills: ambiguous \`supersedes:\` heading ${pyRepr(target)} (in ${fileName}): it matches ${matches.length} headings in ${composeBaseRel} at lines ` +
            matches.map((h) => String(h.idx + 1)).join(", ") +
            " — a supersedes entry must identify exactly one section.",
        );
      }
      const { idx: start, depth } = matches[0];
      let end = baseLines.length;
      for (let j = start + 1; j < baseLines.length; j++) {
        const h3 = HEADING_RE.exec(baseLines[j]);
        if (h3 && h3[1].length <= depth) {
          end = j;
          break;
        }
      }
      baseLines.splice(
        start,
        end - start,
        `<!-- superseded by the ${skillName} overlay: ${pyRepr(target)} excised at compose time (issue #3990) -->`,
        "",
      );
    }
    baseBody = baseLines.join("\n");
  }

  let preface = "";
  let overlayRest = resolvedOverlay;
  const seam = resolvedOverlay.indexOf(SUPERSEDE_MARKER);
  if (seam >= 0) {
    preface = resolvedOverlay.slice(0, seam).replace(/^\n+|\n+$/g, "");
    overlayRest = resolvedOverlay.slice(seam + SUPERSEDE_MARKER.length).replace(/^\n+/, "");
  }

  const segments: string[] = [];
  if (preface) {
    segments.push(preface);
    segments.push("---");
  }
  segments.push(baseBody.replace(/\n+$/, ""));
  segments.push("---");
  segments.push(`## Hydra AFK overlay (${skillName})`);
  segments.push(overlayRest.replace(/^\n+/, ""));
  return segments.join("\n\n");
}

// ---- Render ----------------------------------------------------------------

export interface RenderParts {
  fm: Frontmatter;
  body: string;
  compose: boolean;
}

/** Project frontmatter + body into the Claude SKILL.md string (or a skip). */
export function renderSkillMd(parts: RenderParts): RenderResult {
  const { fm, compose } = parts;
  const field = (key: string): string => {
    const v = fm.get(key);
    return v === undefined ? "" : stripTrailingNewlines(pyStr(v));
  };
  const name = field("name");
  const desc = field("description");
  if (name === "" || desc === "") {
    return { kind: "skip", reason: "missing-name-or-description" };
  }
  const when = field("when_to_use");
  const allowedRaw = fm.get("allowed_tools_claude");
  const allowed = allowedRaw === undefined ? DEFAULT_ALLOWED_TOOLS : stripTrailingNewlines(pyStr(allowedRaw));

  const argsRaw = fm.get("arguments");
  let args = "";
  if (Array.isArray(argsRaw)) args = "[" + argsRaw.join(", ") + "]";
  else if (pyTruthy(argsRaw)) args = stripTrailingNewlines(pyStr(argsRaw as FrontmatterValue));

  const banner = `<!-- DO NOT EDIT. Generated from docs/operator-playbooks/${name}.md. Run scripts/sync-skills.sh after editing the playbook. -->`;

  let out = `---\nname: ${name}\ndescription: ${desc}\n`;
  if (when !== "") out += `when_to_use: "${when}"\n`;
  out += `allowed-tools: ${allowed}\n`;
  if (pyTruthy(fm.get("disable-model-invocation")) && !compose) out += "disable-model-invocation: true\n";
  if (args !== "") out += `arguments: ${args}\n`;
  out += `---\n\n${banner}\n\n${stripTrailingNewlines(parts.body)}\n`;
  return { kind: "skill", name, content: out };
}

/**
 * Render one playbook to its Claude SKILL.md. Never throws for grammar
 * failures; the FIRST error wins, in the heredoc's evaluation order.
 */
export function renderPlaybook(input: RenderInput): RenderResult {
  const parsed = parseFrontmatter(input.text);
  if (!parsed) return { kind: "skip", reason: "no-frontmatter" };
  const { fm, body } = parsed;
  const nameRaw = fm.get("name");
  const skillName = nameRaw === undefined ? "" : pyStr(nameRaw);
  const ctx: IncludeContext = {
    fileName: input.fileName,
    playbooksDir: input.playbooksDir,
    sources: input.sources,
    skillName,
  };

  const resolved = resolveIncludes(body, ctx);
  if (resolved instanceof PlaybookFailure) {
    return { kind: "error", code: resolved.code, message: resolved.message };
  }

  const composeRaw = fm.get("compose_base");
  const composeBaseRel = pyTruthy(composeRaw) ? pyStr(composeRaw as FrontmatterValue) : "";
  if (pyTruthy(fm.get("supersedes")) && composeBaseRel === "") {
    return {
      kind: "error",
      code: "supersedes-without-compose",
      message: `sync-skills: \`supersedes:\` without \`compose_base:\` in ${input.fileName} — there is no vendored base to excise sections from.`,
    };
  }

  let finalBody = resolved;
  let compose = false;
  if (composeBaseRel !== "") {
    compose = true;
    const composed = composeBase(resolved, fm, composeBaseRel, ctx);
    if (composed instanceof PlaybookFailure) {
      return { kind: "error", code: composed.code, message: composed.message };
    }
    finalBody = composed;
  }

  return renderSkillMd({ fm, body: finalBody, compose });
}
