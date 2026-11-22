/**
 * seam-check-lib.ts — the measure-side helpers behind the nine CI Seam checks
 * (redis / schema / query / github / host-probe / journal / claude-cli /
 * anthropic / telegram) and the other ratchet adapters.
 *
 * The baseline ENGINE (diff, shrink-only writer, advice text, CLI flags, the
 * JSON read/write) lives in `ratchet.ts` (`defineRatchet`); each adapter
 * declares a policy and measures with the helpers below: `stripComments`, the
 * tracked-file scan (`listTrackedFiles`), `seamMeasure`, `escapeRegExp` and
 * `isCliEntrypoint`. Nothing here reads or writes a baseline. The dependency
 * direction is one-way: `ratchet.ts` imports this module; this module never
 * imports `ratchet.ts`.
 *
 * Each adapter's `predicate(relPath, body)` is the SINGLE owner of all
 * exemption logic (directory carve-outs and sanctioned-owner Sets).
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Repo root, resolved relative to this file (scripts/ci/seam-check-lib.ts → ../../). */
export const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");

/**
 * Characters after which a `/` starts a REGEX literal rather than a division.
 * Deliberately excludes `)` and `]`, after which a `/` is division
 * (`(a + b) / 2`, `xs[i] / 2`). Misjudging in the conservative direction is
 * safe here: an unrecognised regex literal is scanned as ordinary code, and a
 * `/` inside a regex body must be escaped (`\/`), so no unescaped `//` or `/*`
 * can arise to be mistaken for a comment.
 */
const REGEX_START_PREDECESSORS = "(,=:[!&|?{};+-*%<>~^";

/**
 * Strip JavaScript/TypeScript comments from `source`, PRESERVING string and
 * template literals (issue #3703).
 *
 * Token-keyed Seam checks (journal's `journalctl`, and the same shape in the
 * anthropic / telegram ratchets) ask "does this file name binary X
 * AND hold a spawn capability?". Matching the token against RAW source conflates
 * two very different facts: *spawning* `journalctl` and merely *writing the word*
 * in a doc comment. The journal ratchet's own docstring already drew that line —
 * "Naming `journalctl` in prose/comments alone ... is not a violation" — but the
 * regex never stripped comments, so the stated contract and the implementation
 * disagreed.
 *
 * That gap is a trap for exactly the files most likely to name a sibling seam:
 * a new process Adapter whose header documents the other Adapters. It fired on
 * `src/claude-cli/exec.ts`, and the historical fix was worse than the bug — the
 * `src/github/` and `src/host-probe/` families carry directory carve-outs in
 * `journal-seam-check.ts` PURELY so their doc-prose would stop tripping the
 * gate. Stripping comments removes the need to keep minting such carve-outs.
 *
 * String literals are deliberately KEPT: a spawned binary name lives in one
 * (`spawn("journalctl", …)`), so stripping them would make the gate permissive.
 * The scanner tracks quote state precisely (including backslash escapes) so a
 * `//` inside a URL string never truncates the line — the classic naive-stripper
 * bug, which would silently hide a real violation.
 */
export function stripComments(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  /** Last non-whitespace character emitted — decides regex-vs-division. */
  let prev = "";

  while (i < n) {
    const c = source[i]!;
    const next = i + 1 < n ? source[i + 1] : "";

    // Line comment — drop through end of line, keep the newline.
    if (c === "/" && next === "/") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }

    // Block comment — drop, leaving a space so neighbouring tokens don't glue.
    if (c === "/" && next === "*") {
      i += 2;
      let nl = "";
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") nl += "\n"; // keep line numbers stable for site reports
        i++;
      }
      i += 2;
      out += nl || " ";
      continue;
    }

    // String or template literal — copy verbatim, honouring escapes.
    if (c === '"' || c === "'" || c === "`") {
      out += c;
      i++;
      while (i < n) {
        const ch = source[i]!;
        if (ch === "\\") {
          out += ch + (i + 1 < n ? source[i + 1] : "");
          i += 2;
          continue;
        }
        out += ch;
        i++;
        if (ch === c) break;
      }
      prev = c;
      continue;
    }

    // Regex literal — copy verbatim so an escaped slash never reads as a comment.
    if (c === "/" && (prev === "" || REGEX_START_PREDECESSORS.includes(prev))) {
      out += c;
      i++;
      let inClass = false;
      while (i < n) {
        const ch = source[i]!;
        if (ch === "\\") {
          out += ch + (i + 1 < n ? source[i + 1] : "");
          i += 2;
          continue;
        }
        if (ch === "\n") break;
        out += ch;
        i++;
        if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) break;
      }
      prev = "/";
      continue;
    }

    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }

  return out;
}

/**
 * Run `git ls-files` for the given globs and return the tracked repo-relative
 * paths. Faster than a manual walk and respects `.gitignore`.
 */
export async function listTrackedFiles(globs: string[], cwd: string = REPO_ROOT): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["ls-files", ...globs], {
    cwd,
  });
  return stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The shared Seam measure: scan the tracked files under `globs` (relative to
 * `root`), apply the Adapter's predicate, and return the sorted repo-relative
 * paths for which `predicate(relPath, body)` is true. Unreadable files are
 * skipped. An Adapter's `RatchetPolicy.measure` is `(root) => seamMeasure(root, {...})`.
 */
export async function seamMeasure(
  root: string,
  spec: { globs: string[]; predicate: (relPath: string, body: string) => boolean },
): Promise<string[]> {
  const tracked = await listTrackedFiles(spec.globs, root);
  const violations: string[] = [];
  for (const relPath of tracked) {
    let body: string;
    try {
      body = await readFile(join(root, relPath), "utf8");
    } catch {
      /* intentional: a tracked-but-unreadable file (deleted in the worktree) cannot violate */
      continue;
    }
    if (spec.predicate(relPath, body)) violations.push(relPath);
  }
  return violations.sort();
}

/**
 * Whether `import.meta.url` of an Adapter module is the script Node was invoked
 * with — i.e. the Adapter is running as a CLI, not being imported by a test.
 * `runIfCli` (ratchet.ts) gates on this so importing an Adapter never triggers
 * a scan or `process.exit`.
 */
export function isCliEntrypoint(moduleUrl: string): boolean {
  return Boolean(
    process.argv[1] && fileURLToPath(moduleUrl) === resolve(process.argv[1]),
  );
}

/** Escape a string for literal use inside a RegExp source. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
