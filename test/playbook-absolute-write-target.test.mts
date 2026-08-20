/**
 * Regression guard for issue #4174 — architecture_orch (hydra-architect)
 * wrote its Phase 5 report to the absolute `~/hydra/config/direction/
 * architecture-review.md` path, which IS the live deploy checkout. The
 * resulting uncommitted tracked change blocked two consecutive `deploy` jobs
 * on master and left prod six commits behind for ~80 minutes, with only a
 * WARN-level watchdog alarm (#734's drift backstop does not escalate).
 *
 * The fix (see docs/operator-playbooks/hydra-architect.md) made the write
 * target and the verification `npm test` run resolve against the dispatch's
 * own worktree instead. This test scans every dispatch playbook for the two
 * prose idioms that carried the bug, so a future edit can't reintroduce an
 * absolute `~/hydra/...` write target undetected. Reads from `~/hydra` are
 * fine and are NOT what this guard flags — only patterns shaped like a write
 * target are.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const PLAYBOOKS_DIR = join(REPO_ROOT, "docs", "operator-playbooks");

/**
 * Matches a line that is (once trimmed) ENTIRELY a backticked absolute
 * `~/hydra/...` path followed by a colon — the "field declaration" idiom
 * the pre-fix `hydra-architect.md` used for its Phase 5 write target:
 *   `~/hydra/config/direction/architecture-review.md`:
 */
const WRITE_TARGET_DECLARATION = /^`~\/hydra\/[^`]+`:\s*$/;

/**
 * Matches "report:"/"output:"/"write(s/ing) to" immediately followed by an
 * absolute `~/hydra/...` path anywhere on the line — the idiom the pre-fix
 * `hydra-architect.md` used in its closing operator summary:
 *   Full report: ~/hydra/config/direction/architecture-review.md
 */
const WRITE_TARGET_PROSE =
  /(?:report|output|write(?:s|ing)?\s+to)\s*:?\s*~\/hydra\/\S+/i;

function findAbsoluteWriteTargets(text: string): string[] {
  const hits: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (
      WRITE_TARGET_DECLARATION.test(trimmed) ||
      WRITE_TARGET_PROSE.test(trimmed)
    ) {
      hits.push(trimmed);
    }
  }
  return hits;
}

function listMarkdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => join(dir, e.name));
}

describe("dispatch playbooks never name an absolute ~/hydra/... write target (issue #4174)", () => {
  test("the detector itself catches the pre-fix hydra-architect.md idioms", () => {
    // Self-test: prove the regexes actually fire on the exact strings that
    // caused #4174, so a future edit to the detector can't silently go blind
    // while the real scan below stays green for the wrong reason.
    const buggyDeclaration =
      "`~/hydra/config/direction/architecture-review.md`:";
    const buggyProse =
      "Full report: ~/hydra/config/direction/architecture-review.md";
    assert.deepEqual(findAbsoluteWriteTargets(buggyDeclaration), [
      buggyDeclaration,
    ]);
    assert.deepEqual(findAbsoluteWriteTargets(buggyProse), [buggyProse]);
  });

  test("the detector does not flag ordinary read references", () => {
    // Reads (context files, prose cross-references) are the documented safe
    // case — this guard exists to catch WRITE-shaped patterns only.
    const readRef = "- `~/hydra/config/direction/vision.md`";
    const readSentence =
      "Vision in `~/hydra/config/direction/vision.md`. Architecture in `~/hydra/`.";
    assert.deepEqual(findAbsoluteWriteTargets(readRef), []);
    assert.deepEqual(findAbsoluteWriteTargets(readSentence), []);
  });

  test("top-level operator playbooks are clean", () => {
    const files = listMarkdownFiles(PLAYBOOKS_DIR);
    const offenders: Record<string, string[]> = {};
    for (const file of files) {
      const hits = findAbsoluteWriteTargets(readFileSync(file, "utf-8"));
      if (hits.length > 0) offenders[file] = hits;
    }
    assert.deepEqual(
      offenders,
      {},
      `dispatch playbook(s) name an absolute ~/hydra/... path as a write target -- this is the #4174 bug shape (report writes must resolve against the dispatch's own worktree, never the live deploy checkout). Offenders:\n${JSON.stringify(offenders, null, 2)}`,
    );
  });

  test("composed fragments (_fragments/) are clean", () => {
    const files = listMarkdownFiles(join(PLAYBOOKS_DIR, "_fragments"));
    const offenders: Record<string, string[]> = {};
    for (const file of files) {
      const hits = findAbsoluteWriteTargets(readFileSync(file, "utf-8"));
      if (hits.length > 0) offenders[file] = hits;
    }
    assert.deepEqual(
      offenders,
      {},
      `fragment(s) name an absolute ~/hydra/... path as a write target -- see #4174. Offenders:\n${JSON.stringify(offenders, null, 2)}`,
    );
  });
});
