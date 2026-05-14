/**
 * scripts/ci/epic-close.ts — Pure helpers for the hydra-epic-close skill
 * (issue #408).
 *
 * Background: epics in `gaberoo322/hydra` accumulate sub-issue references in
 * their body (e.g. via `closes #N`, `blocked-by #N`, or a markdown
 * `- [x] #N` checklist). When every sub-issue closes, the parent epic
 * lingers OPEN until an operator notices — observed on the codex-removal
 * epic #380, manually closed on 2026-05-14 after all four sub-issues
 * merged.
 *
 * The hydra-epic-close skill walks candidate epics and classifies each as:
 *
 *   close — every referenced sub-issue is CLOSED, parent should close
 *   wait  — at least one referenced sub-issue is still OPEN
 *   skip  — no parseable references, nothing to do
 *
 * Idempotency rules:
 *
 *  - An epic that is itself already CLOSED is never reclassified (the skill
 *    filters to state:open *before* feeding rows to this module).
 *  - An epic with zero parsed references is `skip`, never `close` — closing
 *    on no evidence would be a footgun.
 *  - `close` is purely a recommendation; the skill applies it only when the
 *    operator (or autopilot) passes `--apply`. Dry-run is the default.
 *
 * This module is pure — no fs / network / process — so it can be unit
 * tested directly. See test/hydra-epic-close.test.mts.
 */

/**
 * Minimal sub-issue shape we need from `gh issue view N --json number,state`.
 */
export interface SubIssueRow {
  number: number;
  /** GitHub's REST/GraphQL state — "OPEN" or "CLOSED". */
  state: "OPEN" | "CLOSED";
}

/**
 * Minimal epic shape we need from `gh issue list --json number,title,body,labels,state`.
 *
 * `body` is the markdown source of the epic — we parse references out of it.
 */
export interface EpicRow {
  number: number;
  title: string;
  body: string;
  labels: Array<{ name: string }>;
  state: "OPEN" | "CLOSED";
}

export type EpicAction = "close" | "wait" | "skip";

export interface EpicClassification {
  action: EpicAction;
  /** Sub-issue numbers parsed out of the epic body, in source order, deduplicated. */
  references: number[];
  /** Open sub-issues (subset of `references`) — only populated when action === "wait". */
  openReferences: number[];
  /** Human-readable explanation for the action — used in the report body. */
  reason: string;
}

/**
 * Parse sub-issue references from an epic body.
 *
 * Recognised forms:
 *
 *   closes #123              — GitHub keyword (case-insensitive, also "close",
 *                              "closed", "fix", "fixes", "fixed", "resolve",
 *                              "resolves", "resolved")
 *   blocked-by #123          — explicit dependency marker used by /to-issues
 *   blocked by #123          — space variant
 *   - [x] #123               — markdown checkbox referencing a sub-issue
 *   - [ ] #123               — unchecked checkbox (still a reference; the skill
 *                              checks GitHub for the real state)
 *
 * Numbers are returned in source order, deduplicated. The function never
 * throws — malformed bodies yield an empty array.
 *
 * NOTE on inline code: refs embedded in `` `closes #123` `` or fenced ``` ```
 * blocks are intentionally still parsed. Epics are operator-authored and we'd
 * rather over-detect than miss a real sub-issue; the worst case is one extra
 * `gh issue view` call per false positive.
 */
export function parseEpicReferences(body: string | null | undefined): number[] {
  if (!body) return [];

  const seen = new Set<number>();
  const ordered: number[] = [];

  // Pattern 1: GitHub closing keywords.
  //   keyword + optional ":" + whitespace + "#N"
  const closingKeyword =
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s*#(\d+)/gi;

  // Pattern 2: "blocked by #N" / "blocked-by #N" / "blocks #N".
  const blockedBy = /\bblock(?:ed|s)?(?:[\s-]+by)?\s*:?\s*#(\d+)/gi;

  // Pattern 3: markdown checkbox " - [x] #N" or "- [ ] #N" (any indentation,
  // checked or unchecked).
  const checkbox = /^[ \t]*[-*]\s*\[[ xX]\]\s*#(\d+)/gm;

  for (const re of [closingKeyword, blockedBy, checkbox]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const n = Number.parseInt(m[1], 10);
      if (Number.isFinite(n) && n > 0 && !seen.has(n)) {
        seen.add(n);
        ordered.push(n);
      }
    }
  }

  return ordered;
}

/**
 * Classify an epic given its parsed references and the resolved state of each.
 *
 * `subStates` is a map keyed by sub-issue number. Numbers in `references` that
 * are missing from the map are treated as OPEN — we never close an epic on the
 * basis of an unknown sub-issue. (The skill is expected to resolve every
 * reference via `gh issue view` before calling this function; the safety net
 * is here to make the function total.)
 */
export function classifyEpic(
  epic: EpicRow,
  subStates: Map<number, "OPEN" | "CLOSED">,
): EpicClassification {
  const references = parseEpicReferences(epic.body);

  if (references.length === 0) {
    return {
      action: "skip",
      references: [],
      openReferences: [],
      reason: "no parseable sub-issue references in body",
    };
  }

  const openReferences = references.filter(
    (n) => (subStates.get(n) ?? "OPEN") === "OPEN",
  );

  if (openReferences.length === 0) {
    return {
      action: "close",
      references,
      openReferences: [],
      reason: `all ${references.length} referenced sub-issues are CLOSED`,
    };
  }

  return {
    action: "wait",
    references,
    openReferences,
    reason: `${openReferences.length}/${references.length} referenced sub-issues still OPEN`,
  };
}

export interface ClassifyEpicsBuckets {
  close: Array<{ epic: EpicRow; classification: EpicClassification }>;
  wait: Array<{ epic: EpicRow; classification: EpicClassification }>;
  skip: Array<{ epic: EpicRow; classification: EpicClassification }>;
}

/**
 * Classify a batch of epics. Input order is preserved within each bucket.
 *
 * `subStatesByEpic.get(epic.number)` should be a Map of sub-issue number →
 * state, populated by the caller from `gh issue view`. An epic with no entry
 * in `subStatesByEpic` is treated as having no resolved states (every parsed
 * reference defaults to OPEN, so the epic lands in `wait` or `skip`, never
 * `close`).
 */
export function classifyEpicBatch(
  epics: EpicRow[],
  subStatesByEpic: Map<number, Map<number, "OPEN" | "CLOSED">>,
): ClassifyEpicsBuckets {
  const buckets: ClassifyEpicsBuckets = { close: [], wait: [], skip: [] };
  for (const epic of epics) {
    const subStates = subStatesByEpic.get(epic.number) ?? new Map();
    const classification = classifyEpic(epic, subStates);
    if (classification.action === "close") buckets.close.push({ epic, classification });
    else if (classification.action === "wait") buckets.wait.push({ epic, classification });
    else buckets.skip.push({ epic, classification });
  }
  return buckets;
}

/**
 * Render the closing-comment body that the skill posts on a `close` epic
 * before transitioning it to CLOSED. Pure — deterministic for testability.
 *
 * `subTitles` maps sub-issue number → title (best-effort; missing entries are
 * rendered as `#N` only). `mergedPRs` maps sub-issue number → PR number (also
 * best-effort).
 */
export function renderClosingComment(
  epic: EpicRow,
  references: number[],
  subTitles: Map<number, string> = new Map(),
  mergedPRs: Map<number, number> = new Map(),
): string {
  const lines: string[] = [];
  lines.push("> *Automated by `/hydra-epic-close`*");
  lines.push("");
  const n = references.length;
  const noun = n === 1 ? "sub-issue is" : "sub-issues are";
  lines.push(`All ${n} referenced ${noun} CLOSED. Closing this epic.`);
  lines.push("");
  lines.push("### Sub-issues resolved");
  for (const n of references) {
    const title = subTitles.get(n);
    const pr = mergedPRs.get(n);
    const titleStr = title ? ` — ${title}` : "";
    const prStr = pr ? ` (PR #${pr})` : "";
    lines.push(`- #${n}${titleStr}${prStr}`);
  }
  return lines.join("\n");
}

/**
 * Render a single-pass dry-run / apply report. Pure — deterministic for
 * testability.
 *
 * `mode` controls the header: "dry-run" makes it clear nothing was actually
 * closed; "apply" reports the closures as completed.
 */
export function renderSummary(
  buckets: ClassifyEpicsBuckets,
  when: string,
  mode: "dry-run" | "apply",
): string {
  const lines: string[] = [];
  const modeLabel = mode === "apply" ? "apply" : "dry-run";
  lines.push(`## Hydra Epic Close — ${when} (${modeLabel})`);
  lines.push("");
  lines.push(
    `Scanned: ${
      buckets.close.length + buckets.wait.length + buckets.skip.length
    } candidate epics`,
  );
  lines.push("");

  const closeHeader =
    mode === "apply"
      ? "### Closed (all sub-issues resolved)"
      : "### Would close (all sub-issues resolved) — dry-run, no action taken";
  lines.push(closeHeader);
  if (buckets.close.length === 0) {
    lines.push("- _none_");
  } else {
    for (const { epic, classification } of buckets.close) {
      lines.push(
        `- #${epic.number} ${epic.title} — ${classification.references.length} sub-issues`,
      );
    }
  }
  lines.push("");

  lines.push("### Waiting (some sub-issues still OPEN)");
  if (buckets.wait.length === 0) {
    lines.push("- _none_");
  } else {
    for (const { epic, classification } of buckets.wait) {
      const openStr = classification.openReferences.map((n) => `#${n}`).join(", ");
      lines.push(`- #${epic.number} ${epic.title} — open: ${openStr}`);
    }
  }
  lines.push("");

  lines.push("### Skipped (no parseable sub-issue references)");
  if (buckets.skip.length === 0) {
    lines.push("- _none_");
  } else {
    for (const { epic } of buckets.skip) {
      lines.push(`- #${epic.number} ${epic.title}`);
    }
  }

  return lines.join("\n");
}

/**
 * Parse the skill's CLI-style args (passed via Skill `args` or operator
 * invocation) into a normalised options object.
 *
 * Recognised forms:
 *   --apply              → apply=true
 *   apply=true           → apply=true
 *   apply=false          → apply=false (explicit dry-run)
 *   <anything else>      → ignored
 *
 * Dry-run is the default — `parseArgs("")` returns `{ apply: false }`.
 */
export function parseArgs(args: string | null | undefined): { apply: boolean } {
  if (!args) return { apply: false };
  const tokens = args
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  let apply = false;
  for (const t of tokens) {
    if (t === "--apply") {
      apply = true;
      continue;
    }
    const [k, v] = t.split("=", 2);
    if (k === "apply") {
      apply = v === "true" || v === "1" || v === "yes";
    }
  }
  return { apply };
}
