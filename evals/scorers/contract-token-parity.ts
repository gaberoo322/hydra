// evals/scorers/contract-token-parity.ts — the skill_prune DELETION TEST,
// made deterministic against the REAL before/after pair (issue #4268).
//
// THE GAP THIS CLOSES
// =====================================================================
// evals/skill-prune.yaml (pre-#4268) asserted `contains` against a hardcoded
// `skill_body` literal through the `echo` provider — a constant string
// containing substrings of itself. It returned 2/2 for every possible prune,
// including one that deleted every contract token in the real playbook (see
// issue #4268 for the measured demonstration). This module is the fix: it
// computes parity from the ACTUAL before/after pair (the pre-prune playbook
// body vs. the pruned one), not a fixture that never reads the diff under
// test.
//
// NO `promptfoo` IMPORT (issue #4268, INV-5)
// =====================================================================
// Deliberately no import of any kind from the `promptfoo` package — only
// local, minimal types below. `test/skill-prune-contract-token-parity.test.mts`
// imports the pure functions in this file directly, which pulls this file into
// `tsconfig.test.json`'s program (it widens to `test/**` + `scripts/**`, and an
// imported file is compiled regardless of its own directory). `promptfoo` is a
// pinned-`npx` tool, never a `package.json` dependency (ADR-0005, docs/evals.md)
// — a type-only import of its ambient types would leave that program unable to
// resolve them, breaking `npm run typecheck:test`. Avoiding the import keeps
// this file plain, portable TypeScript that both `tsc` and promptfoo's own
// esbuild loader can each type-check independently.
//
// SET SEMANTICS, NOT COUNTS (INV-2, INV-3)
// =====================================================================
// A load-bearing contract token is a member of one of five classes a Hydra
// dispatch child-flow depends on (docs/operator-playbooks/hydra-skill-prune.md
// Step 2 already enumerates them as never-a-no-op even when the surrounding
// prose reads like filler): a `closes #<n>` reference, the never-push-to-master
// branch invariant, a verification command, an `ADR-NNNN` reference, and the
// worktree-guard preamble. Parity is SET membership: every token PRESENT in
// BEFORE must be present somewhere in AFTER; a token absent from BEFORE is
// never required, and a DUPLICATE occurrence collapsing to one copy still
// passes (a legitimate duplication prune). This is deliberately skill-agnostic
// — no hardcoded per-skill literal list — because a fixed list is correct for
// exactly one playbook's accidental vocabulary and false-fails or vacuously
//
// WORKTREE-GUARD-PREAMBLE IS BLOCK-SCOPED, NOT JUST PHRASE-SCOPED (QA fold on
// PR #4490, issue #4268 follow-up; see the PR body's "QA follow-up" section)
// =====================================================================
// QA's adversarial pass found a real false-PASS: the class's original flat
// `/critical safety rule/i` presence check collapses to ONE token no matter
// how many `## CRITICAL SAFETY RULE …` blocks a doc carries, so a prune that
// deletes one of several such blocks — each real, distinct, and sometimes
// behaviorally OPPOSITE (docs/operator-playbooks/hydra-autopilot.md's default
// vs. `dev_target` variant, issue #4178) — still reports the class present via
// the surviving sibling. This does not change SET semantics (INV-3): a
// literal duplicate block (byte-identical heading + first content line) still
// collapses to one token via `dedupe`, so a genuine duplication prune still
// passes. What changes is granularity — two blocks that merely SHARE a
// generic heading but differ in content are no longer conflated into a single
// token. `extractSafetyRuleHeadingBlocks` below fingerprints each markdown
// heading line containing the phrase (`^#{1,6} …critical safety rule…`)
// together with its first non-blank following line — "the heading plus its
// first distinguishing line" — so distinct blocks get distinct tokens while
// identical ones still dedupe. Prose that never uses a markdown heading (e.g.
// this file's own unit-test fixtures, or a one-line mention) produces zero
// block tokens and falls back to the original flat phrase-presence tokens
// unchanged — this is additive, not a replacement, so existing skill_prune
// callers with no heading-styled preamble see no behavior change.
// passes every other one (issue #4268's `## Rejected alternatives`).

/** Minimal local stand-in for promptfoo's `AssertionValueFunctionContext`. */
type MinimalAssertionContext = { vars?: Record<string, unknown> };

/** Minimal local stand-in for promptfoo's `GradingResult`. */
type MinimalGradingResult = { pass: boolean; score: number; reason: string };

/** One load-bearing contract-token class: a name plus a pure extractor. */
export type TokenClass = {
  /** Short, stable identifier — surfaces in dropped-token diagnostics. */
  name: string;
  /** Returns every distinct, canonicalised token of this class found in `text`. */
  extract: (text: string) => string[];
};

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function matchAll(text: string, re: RegExp): string[] {
  return [...(text ?? "").matchAll(re)].map((m) => m[0]);
}

function canonicalizeLine(line: string): string {
  return line.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Fingerprint every markdown-heading-styled `## … CRITICAL SAFETY RULE …`
 * block in `text` individually, keyed by the heading line plus its first
 * non-blank following line (its "first distinguishing line"). Two blocks
 * with byte-identical heading + first line collapse to one token via the
 * caller's `dedupe` (a literal duplicate still passes, INV-3); two blocks
 * that merely share a generic heading but diverge in body content — the
 * false-PASS QA demonstrated on `docs/operator-playbooks/hydra-autopilot.md`'s
 * default vs. `dev_target` variant — produce distinct tokens. Prose that
 * never uses a markdown heading line (no line starting with `#`) yields no
 * block tokens at all, so this is additive to the pre-existing flat
 * phrase-presence tokens, never a replacement.
 */
function extractSafetyRuleHeadingBlocks(text: string): string[] {
  const lines = (text ?? "").split(/\r?\n/);
  const headingRe = /^#{1,6}\s.*critical safety rule/i;
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!headingRe.test(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && lines[j].trim().length === 0) j++;
    const firstContentLine = j < lines.length ? lines[j] : "";
    blocks.push(
      `worktree-guard-block:${canonicalizeLine(lines[i])}::${canonicalizeLine(firstContentLine)}`,
    );
  }
  return dedupe(blocks);
}

/**
 * The five load-bearing contract-token classes named by
 * `docs/operator-playbooks/hydra-skill-prune.md` Step 2. Exported so the
 * class list is one reviewable constant (INV-2) rather than logic scattered
 * across call sites.
 */
export const TOKEN_CLASSES: TokenClass[] = [
  {
    // `closes #<n>` — a specific issue reference. Each distinct number is its
    // own token: dropping `closes #2949` from a body that also carries
    // `closes #3001` must still be caught.
    name: "closes-issue-ref",
    extract: (text) =>
      dedupe(
        matchAll(text, /\bcloses\s*#\d+\b/gi).map((s) =>
          s.toLowerCase().replace(/\s+/g, " ").trim(),
        ),
      ),
  },
  {
    // The never-push-to-master branch invariant — one canonical token,
    // case-insensitive.
    name: "never-push-to-master",
    extract: (text) =>
      matchAll(text, /never\s+push\s+directly\s+to\s+master/gi).length > 0
        ? ["never push directly to master"]
        : [],
  },
  {
    // Verification commands the child-flow requires before opening a PR.
    // Substring presence per literal (not regex) — the exact command text.
    name: "verification-command",
    extract: (text) =>
      ["npm test", "npm run typecheck", "npm run typecheck:test", "npm run build"].filter((cmd) =>
        text.includes(cmd),
      ),
  },
  {
    // `ADR-NNNN` references — each distinct ADR number is its own token.
    name: "adr-reference",
    extract: (text) => dedupe(matchAll(text, /\bADR-\d{4}\b/gi).map((s) => s.toUpperCase())),
  },
  {
    // The worktree-guard preamble. Two independent flat markers (either
    // surviving its own presence in BEFORE is tracked separately from the
    // other), PLUS one block-scoped token per distinct `## … CRITICAL SAFETY
    // RULE …` heading block found (see the module-level comment above) so a
    // prune that deletes one of several such blocks sharing a generic
    // heading is caught even when a sibling block keeps the flat markers
    // alive.
    name: "worktree-guard-preamble",
    extract: (text) => {
      const out: string[] = [];
      if (/critical safety rule/i.test(text)) out.push("critical safety rule");
      if (/git worktree/i.test(text)) out.push("git worktree");
      out.push(...extractSafetyRuleHeadingBlocks(text));
      return dedupe(out);
    },
  },
];

/** Union of every load-bearing token found in `text`, across all classes. */
export function extractLoadBearingTokens(text: string): Set<string> {
  const set = new Set<string>();
  for (const cls of TOKEN_CLASSES) {
    for (const token of cls.extract(text ?? "")) set.add(token);
  }
  return set;
}

/** Outcome of a before/after contract-token parity check. */
export type ParityResult = {
  pass: boolean;
  /** Load-bearing tokens present in `before` but absent from `after`. */
  droppedTokens: string[];
  reason: string;
};

/**
 * Compute contract-token parity between a pre-prune (`before`) and
 * post-prune (`after`) skill body. Fails CLOSED (INV-4) on every
 * cannot-verify shape: missing/empty input, an identical pair (nothing was
 * pruned, so nothing was exercised), or a `before` that carries zero
 * load-bearing tokens (this eval cannot exercise the chosen skill).
 */
export function computeContractTokenParity(
  before: string | null | undefined,
  after: string | null | undefined,
): ParityResult {
  const b = typeof before === "string" ? before : "";
  const a = typeof after === "string" ? after : "";

  if (b.trim().length === 0) {
    return {
      pass: false,
      droppedTokens: [],
      reason: "before is missing or empty — nothing to verify parity against",
    };
  }
  if (a.trim().length === 0) {
    return {
      pass: false,
      droppedTokens: [],
      reason: "after is missing or empty — cannot verify the pruned skill",
    };
  }
  if (b.trim() === a.trim()) {
    return {
      pass: false,
      droppedTokens: [],
      reason: "before and after are identical — nothing was pruned, so parity cannot be exercised",
    };
  }

  const beforeTokens = extractLoadBearingTokens(b);
  if (beforeTokens.size === 0) {
    return {
      pass: false,
      droppedTokens: [],
      reason: "before carries zero load-bearing contract tokens — this eval cannot exercise the chosen skill",
    };
  }

  const afterTokens = extractLoadBearingTokens(a);
  const dropped = [...beforeTokens].filter((t) => !afterTokens.has(t)).sort();
  if (dropped.length > 0) {
    return {
      pass: false,
      droppedTokens: dropped,
      reason: `dropped load-bearing token(s): ${dropped.join(", ")}`,
    };
  }

  return {
    pass: true,
    droppedTokens: [],
    reason: `all ${beforeTokens.size} load-bearing token(s) survived the prune`,
  };
}

/**
 * The thin promptfoo `(output, context) => GradingResult` adapter (INV-5).
 * `output` (the echo provider's rendered prompt) is unused — the real inputs
 * are read straight off `context.vars.before` / `context.vars.after`, which
 * promptfoo populates from the `file://` vars in `evals/skill-prune/parity.yaml`
 * (real pair) or the inline fixture strings in `evals/skill-prune.yaml`
 * (self-test).
 */
export default function scoreContractTokenParity(
  _output: string,
  context: MinimalAssertionContext,
): MinimalGradingResult {
  const vars = (context?.vars ?? {}) as Record<string, unknown>;
  const before = typeof vars.before === "string" ? vars.before : "";
  const after = typeof vars.after === "string" ? vars.after : "";
  const result = computeContractTokenParity(before, after);
  return { pass: result.pass, score: result.pass ? 1 : 0, reason: result.reason };
}
