/**
 * src/cost/transcript-fold.ts — the pure parse core of the transcript walk
 * (ADR-0042 Decision 6, part 1; issue #4791).
 *
 * Layer L3 (pure fold): VALUE-imports only from L1 (`token-math.ts`,
 * `token-breakdown.ts`) and takes `FileParseMemoEntry` / `MemoLineEntry` as
 * TYPE-only imports from the Redis parse-memo seam. No fs, no transcript-store,
 * no Redis values, and it never imports `transcript-scan.ts` (L4) — the I/O
 * shell there reads the file, stats it, and owns the session-keyed skill/kind
 * cache; this module only turns one file's already-read content into the
 * memoizable per-file contribution.
 *
 * Also home of the two pure transcript-content helpers `firstUserMessageText`
 * and `sumSessionTokens`, moved DOWN from `transcript-scan.ts` (which re-exports
 * them at the same names).
 */

import {
  modelToFamily,
  isForeignProviderModel,
  parseUsageLine,
  parseObservedResetMs,
} from "./token-math.ts";
import type { ModelFamily } from "./token-math.ts";
import type { DispatchKind } from "./token-breakdown.ts";
import type { FileParseMemoEntry, MemoLineEntry } from "../redis/transcript-parse-memo.ts";

/**
 * Extract the text of a transcript's FIRST user message from its already-read
 * content (issue #2402) — the signal `deriveSkill` reads. Walks the JSONL lines
 * the scan already split, returns the text of the first `type:"user"` record
 * that is NOT a harness-injected meta line (`isMeta:true`, e.g. the
 * `<local-command-caveat>` banner or the skill-template echo), and whose content
 * is non-empty. `content` may be a plain string OR an array of content blocks
 * (the harness emits both shapes); text blocks are concatenated. Returns `null`
 * when no readable first user message exists. Cheap: stops at the first match.
 */
export function firstUserMessageText(lines: readonly string[]): string | null {
  for (const line of lines) {
    if (!line || line[0] !== "{") continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      /* intentional: a non-JSON line cannot be the first user message — skip it */
      continue;
    }
    if (obj?.type !== "user" || obj?.isMeta === true) continue;
    const content = obj?.message?.content;
    let text: string;
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .map((b: any) => (b && typeof b.text === "string" ? b.text : ""))
        .join(" ");
    } else {
      continue;
    }
    if (text.trim() === "") continue;
    return text;
  }
  return null;
}

/**
 * Sum the total tokens across every usage-bearing line of ONE session's
 * transcript content (issue #3250). Pure and Redis-free — reuses
 * `parseUsageLine` (the same authoritative parser the windowed scan uses), so
 * the per-dispatch count is reconcilable with the per-skill/per-family
 * cross-tabs. Non-JSON lines, lines with no usage block, and zero-usage lines
 * all contribute nothing. Unlike the rolling-window scan this applies NO time
 * cutoff. Total: always returns a non-negative integer.
 */
export function sumSessionTokens(lines: readonly string[]): number {
  let total = 0;
  for (const line of lines) {
    if (!line || line[0] !== "{") continue;
    const parsed = parseUsageLine(line);
    if (parsed === null || parsed === "skip") continue;
    total += parsed.tokens.total;
  }
  return total;
}

/** What the shell's `attribute` callback resolves for one contributing file. */
export interface FileAttribution {
  skill: string;
  dispatchKind: DispatchKind;
}

/** Result of {@link parseTranscriptFile}. */
export interface ParsedTranscriptFile {
  /** The memoizable per-file contribution — everything but the stat facts. */
  entry: Omit<FileParseMemoEntry, "size" | "mtimeMs">;
  /** REAL unrecognised (family `unknown`) model strings, first-seen order, deduped. */
  unknownModels: string[];
  /** REAL foreign-provider model strings, first-seen order, deduped. */
  foreignModels: string[];
}

/**
 * Parse ONE transcript file's content into its memoizable contribution. Pure
 * and total: never throws, does no I/O and no logging; it splits `content` on
 * `\n` itself.
 *
 * `attribute(lines)` is invoked AT MOST ONCE, and only when the file had at
 * least one in-7d non-foreign (Anthropic) usage line — otherwise `skill` and
 * `dispatchKind` are both `null`. Keeping it a callback leaves the session-keyed
 * skill/kind cache (and `sessionIdFromPath`) in the I/O shell.
 *
 * `observedResetMs` is probed on EVERY JSON line regardless of the Weekly Reset
 * Anchor env, so a later scan that does set the anchor can replay it from the
 * memo. Only in-7d usage-bearing lines are kept in `entry.entries`.
 */
export function parseTranscriptFile(
  content: string,
  cutoff7d: number,
  attribute: (lines: readonly string[]) => FileAttribution,
): ParsedTranscriptFile {
  const lines = content.split("\n");
  const entries: MemoLineEntry[] = [];
  const unknownModels: string[] = [];
  const foreignModels: string[] = [];
  let linesParsed = 0;
  let linesWithUsage = 0;
  let parseErrors = 0;
  let observedResetMs: number | null = null;
  let hadInWindow7d = false;

  for (const line of lines) {
    if (!line || line[0] !== "{") continue;
    linesParsed++;

    const observed = parseObservedResetMs(line);
    if (observed !== null && (observedResetMs === null || observed > observedResetMs)) {
      observedResetMs = observed;
    }

    const parsed = parseUsageLine(line);
    if (parsed === null) {
      parseErrors++;
      continue;
    }
    if (parsed === "skip") continue;
    linesWithUsage++;

    const tsMs = parsed.tsMs;
    if (tsMs < cutoff7d) continue;

    if (isForeignProviderModel(parsed.model)) {
      if (!foreignModels.includes(parsed.model)) foreignModels.push(parsed.model);
      entries.push({ tsMs, tokens: parsed.tokens, foreign: true, family: "unknown" });
      continue;
    }

    const family: ModelFamily = modelToFamily(parsed.model);
    if (family === "unknown" && !unknownModels.includes(parsed.model)) {
      unknownModels.push(parsed.model);
    }
    hadInWindow7d = true;
    entries.push({ tsMs, tokens: parsed.tokens, foreign: false, family });
  }

  let skill: string | null = null;
  let dispatchKind: DispatchKind | null = null;
  if (hadInWindow7d) {
    const attributed = attribute(lines);
    skill = attributed.skill;
    dispatchKind = attributed.dispatchKind;
  }

  return {
    entry: {
      entries,
      skill,
      dispatchKind,
      observedResetMs,
      linesParsed,
      linesWithUsage,
      parseErrors,
    },
    unknownModels,
    foreignModels,
  };
}
