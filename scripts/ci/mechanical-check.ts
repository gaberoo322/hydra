/**
 * scripts/ci/mechanical-check.ts — Pure helper for the autopilot Tier-0
 * carve-out (issue #425).
 *
 * Background: under the autopilot Option C merge policy, mechanical Tier-0 PRs
 * (file deletions, renames, 1:1 substitutions, literal-to-helper replacements)
 * may auto-apply the `operator-approved` label, while non-mechanical Tier-0
 * changes (new conditionals, loops, classes, control flow) MUST queue for
 * operator review. The autopilot decision-brain rewrite (the gamma issue)
 * consumes this classifier; the gate stays under operator control either way.
 *
 * This is the 5th deterministic pure helper in the family started by
 * `qa-verdict.ts` / `pr-rebase.ts` / `epic-close.ts` / `scope-check.ts`.
 * Same architectural shape:
 *
 *   - Pure function — zero fs / network / process side effects.
 *   - Same input -> same output. Easy to unit-test from `test/*.test.mts`.
 *   - No external deps. Regex parsing only.
 *
 * Classification semantics (mirroring the acceptance criteria of #425):
 *
 *   "mechanical"      — no Tier-0 files touched, OR Tier-0 hunks contain only
 *                       deletions, OR added Tier-0 lines do not match any
 *                       non-mechanical pattern AND total added lines on Tier-0
 *                       files is <= 50.
 *   "non-mechanical"  — ANY added line on a Tier-0 file matches one of the
 *                       non-mechanical regex patterns (new conditionals, loops,
 *                       switch/case, try/catch/finally, async fn/await, `new
 *                       ClassName`, top-level function declarations, arrow-fn
 *                       assignments).
 *   "unclear"         — added-lines-on-tier-0 > 50 (large change needs review
 *                       even if regex-clean), OR the diff cannot be parsed.
 *
 * The function is intentionally conservative: when in doubt, return "unclear"
 * so the caller queues for operator review. The cost of a false "mechanical"
 * is an unsupervised Tier-0 merge; the cost of a false "unclear" is one
 * extra operator glance.
 *
 * NOTE on diff parsing: we only consume unified-diff text (the output of
 * `git diff` / `gh pr diff`). The parser is intentionally permissive about
 * what it accepts but strict about what it counts:
 *
 *   - We track the CURRENT FILE PATH from `diff --git a/<x> b/<y>` and
 *     `+++ b/<y>` headers. The `b/<y>` (post-change) name wins, because that
 *     is what matches a tier0Files list extracted from the live PR diff.
 *   - "Added lines" are lines starting with `+` and NOT `+++ `. "Removed
 *     lines" are lines starting with `-` and NOT `--- `.
 *   - Binary file markers (`Binary files ... differ`) are recognised and
 *     surface as "unclear" only if they belong to a Tier-0 file; otherwise
 *     they are ignored. Binary edits to Tier-0 paths are not something the
 *     mechanical classifier can reason about.
 *   - File deletions (`deleted file mode`) and pure renames (`rename from /
 *     rename to`) on Tier-0 paths count as mechanical even when the patch
 *     body is empty — that is the primary use case for the carve-out.
 */

export type Classification = "mechanical" | "non-mechanical" | "unclear";

/**
 * Tier-0 added-line threshold above which we refuse to call it mechanical
 * even when no non-mechanical regex pattern fires. 50 lines is the AC value.
 * Bigger changes always go to operator review.
 */
const TIER0_ADDED_LINE_LIMIT = 50;

/**
 * Regex patterns that mark an added line as non-mechanical. Any match on any
 * added line of a Tier-0 file flips the classification to "non-mechanical".
 *
 * Each pattern is anchored on a leading-whitespace prefix (the diff format
 * keeps the original source indentation after the `+` marker). We allow an
 * optional leading `}` to catch `} else if (...)` and `} catch (e) {`
 * trailing-brace forms.
 *
 * Word boundaries (`\b`) on the keyword guarantee we don't match identifiers
 * like `forEach`, `whileFlag`, `whilePolling`, etc.
 *
 * Order is irrelevant — first match wins, returning "non-mechanical".
 */
const NON_MECHANICAL_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  // New control flow: if / else if / else
  { name: "if/else conditional", re: /^\s*(\}\s*)?(if|else\s+if|else)\s*[({]/ },
  // Else with a following block-open on the next physical char (handles `} else {`)
  { name: "else block", re: /^\s*\}?\s*else\s*\{/ },
  // Loops: for / while / do
  { name: "for/while/do loop", re: /^\s*(for|while|do)\s*[({]/ },
  // switch / case
  { name: "switch statement", re: /^\s*switch\s*\(/ },
  { name: "case clause", re: /^\s*(case\s+[^:]+:|default\s*:)/ },
  // try / catch / finally
  { name: "try/catch/finally", re: /^\s*(\}\s*)?(try|catch|finally)\s*[({]/ },
  // async function declarations and await expressions
  { name: "async function", re: /^\s*(export\s+)?(async\s+function\b|async\s*\()/ },
  { name: "await expression", re: /(^|[^A-Za-z0-9_$])await\s+[A-Za-z0-9_$(]/ },
  // new ClassName(...) — capitalised identifier required to avoid `new Date()`-style
  // false negatives on lowercase, and to avoid `newValue`-style false positives.
  { name: "new ClassName", re: /(^|[^A-Za-z0-9_$])new\s+[A-Z][A-Za-z0-9_$]*\s*[(<]/ },
  // function name(...) declarations (top-level or method-shorthand).
  // Requires `function` keyword followed by an identifier and an open paren.
  { name: "function declaration", re: /^\s*(export\s+(default\s+)?)?function\s+[A-Za-z_$][A-Za-z0-9_$]*\s*\(/ },
  // Top-level arrow `const x = (` / `let x = (` / `var x = (` assigned to a function.
  // Match `=> {` or `=> (` on the same line to confirm function-ness; otherwise the
  // `const x = (1 + 2)` shape would flip the classifier on every constant tuple.
  {
    name: "top-level arrow assignment",
    re: /^\s*(export\s+)?(const|let|var)\s+[A-Za-z_$][A-Za-z0-9_$]*\s*(:\s*[^=]+)?\s*=\s*(async\s+)?\([^)]*\)\s*(:\s*[^=]+)?\s*=>/,
  },
];

/**
 * Internal: per-file state collected while walking the unified diff.
 */
interface FileDiffState {
  path: string;
  /** Number of `+`-prefixed lines (excluding the `+++ b/...` header). */
  added: number;
  /** Number of `-`-prefixed lines (excluding the `--- a/...` header). */
  removed: number;
  /** True if the file was deleted in this diff (`deleted file mode` marker). */
  deleted: boolean;
  /** True if the file was renamed-only (no content delta). */
  renamedOnly: boolean;
  /** True if the file is a binary file (marked by `Binary files ... differ`). */
  binary: boolean;
  /** First non-mechanical pattern hit on an added line, if any. */
  nonMechanicalHit: string | null;
  /** Sample of the first matching added line, for debugging. */
  nonMechanicalSample: string | null;
}

function emptyState(path: string): FileDiffState {
  return {
    path,
    added: 0,
    removed: 0,
    deleted: false,
    renamedOnly: false,
    binary: false,
    nonMechanicalHit: null,
    nonMechanicalSample: null,
  };
}

/**
 * Parse a unified-diff body into a map of `path -> FileDiffState`.
 *
 * Defensive: returns `null` if the diff is clearly malformed (e.g. lines
 * appear before any `diff --git` / `+++` header), so the caller can return
 * "unclear" without leaking partial state.
 */
function parseDiff(diff: string): Map<string, FileDiffState> | null {
  if (!diff || diff.trim() === "") return new Map();

  const lines = diff.split(/\r?\n/);
  const files = new Map<string, FileDiffState>();
  let current: FileDiffState | null = null;
  // Tracks whether we are inside a hunk (after the first `@@ ... @@` marker
  // for the current file). Lines starting with `+` / `-` outside a hunk are
  // metadata (e.g. `--- a/foo`), not real adds/removes.
  let inHunk = false;
  // Tracks a pending rename pair until we see the post-change name.
  let pendingRenameFrom: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // New file block: `diff --git a/<x> b/<y>`
    const diffHeader = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (diffHeader) {
      const postPath = diffHeader[2];
      current = emptyState(postPath);
      files.set(postPath, current);
      inHunk = false;
      pendingRenameFrom = null;
      continue;
    }

    if (!current) {
      // Some diffs (no `diff --git` line, just `--- a/x` / `+++ b/y`) — accept
      // the `+++ b/...` header as a file boundary.
      const plusplus = line.match(/^\+\+\+ b\/(.+)$/);
      if (plusplus) {
        current = emptyState(plusplus[1]);
        files.set(plusplus[1], current);
        inHunk = false;
        continue;
      }
      // Stray content before any header — ignore quietly. (Some tools prefix
      // the diff with a commit message; we don't want to choke on it.)
      continue;
    }

    // `deleted file mode 100644` — file deletion. Patch body may still
    // contain `-` lines; we still classify it as mechanical-eligible.
    if (/^deleted file mode\s+\d+/.test(line)) {
      current.deleted = true;
      continue;
    }

    // Binary marker. Either `Binary files a/x and b/y differ` or
    // `GIT binary patch`.
    if (
      /^Binary files .* differ$/.test(line) ||
      /^GIT binary patch$/.test(line)
    ) {
      current.binary = true;
      continue;
    }

    // Rename markers. We don't update `current.path` here (the `diff --git`
    // header already pinned us to the post-change name) but we do mark
    // `renamedOnly: true` so deletion-free no-add renames are mechanical.
    if (/^rename from /.test(line)) {
      pendingRenameFrom = line.slice("rename from ".length);
      current.renamedOnly = true;
      continue;
    }
    if (/^rename to /.test(line)) {
      // pair confirmed
      if (pendingRenameFrom !== null) current.renamedOnly = true;
      pendingRenameFrom = null;
      continue;
    }

    // `--- a/<x>` and `+++ b/<y>` — file headers, not content.
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      // If the `+++ b/<y>` arrives after a header-less section we already
      // anchored on, switch the file path. Otherwise leave it alone.
      const plusplus = line.match(/^\+\+\+ b\/(.+)$/);
      if (plusplus && plusplus[1] !== current.path && plusplus[1] !== "/dev/null") {
        // Update the file key — the diff --git header was authoritative,
        // but if it disagrees we trust `+++` for the post-change name.
        files.delete(current.path);
        current = { ...current, path: plusplus[1] };
        files.set(plusplus[1], current);
      }
      inHunk = false;
      continue;
    }

    // Hunk header: `@@ -a,b +c,d @@ ...`
    if (/^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/.test(line)) {
      inHunk = true;
      // Once a real hunk appears, `renamedOnly` is no longer accurate —
      // there is real content delta.
      current.renamedOnly = false;
      continue;
    }

    if (!inHunk) continue;

    if (line.startsWith("+")) {
      current.added++;
      // The added line content with the leading `+` stripped.
      const content = line.slice(1);
      if (!current.nonMechanicalHit) {
        for (const pattern of NON_MECHANICAL_PATTERNS) {
          if (pattern.re.test(content)) {
            current.nonMechanicalHit = pattern.name;
            current.nonMechanicalSample = content;
            break;
          }
        }
      }
    } else if (line.startsWith("-")) {
      current.removed++;
    }
    // Context lines (starting with " ") are ignored.
  }

  return files;
}

/**
 * Build a normalised lookup set for the tier0Files list, with leading
 * `./` stripped. Substring/prefix matching is intentional so directories
 * like `src/untouchable.ts` match exactly and `src/gate/` matches any file
 * underneath.
 */
function buildTier0Matcher(tier0Files: string[]): (path: string) => boolean {
  const norm = (s: string) => s.replace(/^\.\//, "").replace(/^\/+/, "");
  const set = new Set<string>();
  const prefixes: string[] = [];
  for (const raw of tier0Files) {
    if (!raw || typeof raw !== "string") continue;
    const n = norm(raw.trim());
    if (n === "") continue;
    if (n.endsWith("/")) {
      prefixes.push(n);
    } else {
      set.add(n);
    }
  }
  return (path: string): boolean => {
    const p = norm(path);
    if (set.has(p)) return true;
    for (const pre of prefixes) {
      if (p.startsWith(pre)) return true;
    }
    return false;
  };
}

/**
 * Classify a unified-diff string as mechanical / non-mechanical / unclear
 * with respect to the provided tier0Files list.
 *
 * @param diff        Unified diff text (output of `git diff`, `gh pr diff`,
 *                    etc). Empty string is mechanical (nothing to change).
 * @param tier0Files  Paths that count as Tier-0. Trailing slash means
 *                    "everything under this prefix"; otherwise exact match.
 *                    A diff that touches NO entry in this list is mechanical
 *                    by definition — the carve-out only cares about Tier-0
 *                    risk.
 *
 * @returns Classification literal. Never throws.
 */
export function classifyDiff(diff: string, tier0Files: string[]): Classification {
  // Empty input -> mechanical (no change at all).
  if (!diff || diff.trim() === "") return "mechanical";

  const parsed = parseDiff(diff);
  if (parsed === null) return "unclear";

  const isTier0 = buildTier0Matcher(tier0Files ?? []);

  // Collect Tier-0 files actually touched.
  const tier0Touched: FileDiffState[] = [];
  for (const state of parsed.values()) {
    if (isTier0(state.path)) tier0Touched.push(state);
  }

  // No Tier-0 files touched -> mechanical.
  if (tier0Touched.length === 0) return "mechanical";

  // Binary edits to a Tier-0 file -> unclear. We can't reason about content.
  for (const t of tier0Touched) {
    if (t.binary) return "unclear";
  }

  // Any non-mechanical regex hit on an added line of a Tier-0 file -> non-mechanical.
  for (const t of tier0Touched) {
    if (t.nonMechanicalHit) return "non-mechanical";
  }

  // Total added lines across Tier-0 files. If it's a deletion-only set, this is 0.
  const totalAdded = tier0Touched.reduce((acc, t) => acc + t.added, 0);

  // Deletion-only or rename-only Tier-0 changes are mechanical by design.
  // (totalAdded === 0 covers both: deleted files have 0 adds, rename-only
  //  hunks never set added.)
  if (totalAdded === 0) return "mechanical";

  // Large changes always go to operator review even when regex-clean.
  if (totalAdded > TIER0_ADDED_LINE_LIMIT) return "unclear";

  // Small, regex-clean, additive change -> mechanical.
  return "mechanical";
}
