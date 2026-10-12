/**
 * Regression test for issue #4939 (INV-1, INV-2, INV-3).
 *
 * Root cause: a playbook block dereferenced `$TARGET_WS` as a `cd` / `git -C`
 * target after shell state had been lost between Bash tool calls. `cd ""` and
 * `git -C ""` are silent no-ops, so the command ran in the launch cwd
 * (/home/gabe/hydra) and a later `git remote set-url` rewrote the
 * orchestrator's `origin` to the Target repo.
 *
 * Pinned here:
 *   - no fenced block in docs/operator-playbooks/**.md uses a seam var as a
 *     `cd` / `git -C` target without the `${VAR:?...}` abort guard;
 *   - hydra-target-cleanup.md re-resolves the seam inside each block that
 *     dereferences it (per-block self-sufficiency);
 *   - the self-isolation preamble forbids `git remote` mutation.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const PLAYBOOKS = join(REPO_ROOT, "docs", "operator-playbooks");

const SEAM_DEREF =
  /(?:\bcd\s+|\bgit\s+-C\s+)"?\$(?:\{(?:TARGET_WS|TARGET_APP_DIR|TARGET_WT)\}|(?:TARGET_WS|TARGET_APP_DIR|TARGET_WT)\b)/;

function playbookFiles(): string[] {
  const out: string[] = [];
  for (const dir of [PLAYBOOKS, join(PLAYBOOKS, "_fragments")]) {
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".md")) out.push(join(dir, f));
    }
  }
  return out;
}

/** Lines (1-based) inside fenced code blocks, with their text. */
function fencedLines(text: string): Array<{ n: number; line: string }> {
  const out: Array<{ n: number; line: string }> = [];
  let inFence = false;
  text.split("\n").forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) out.push({ n: i + 1, line });
  });
  return out;
}

describe("playbook seam-var abort guard (#4939)", () => {
  it("no fenced block cd's / git -C's an unguarded seam var", () => {
    const offenders: string[] = [];
    for (const file of playbookFiles()) {
      for (const { n, line } of fencedLines(readFileSync(file, "utf8"))) {
        if (SEAM_DEREF.test(line)) {
          offenders.push(`${file.replace(REPO_ROOT + "/", "")}:${n}: ${line.trim()}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "seam var used as cd/git -C target without ${VAR:?...} guard:\n" +
        offenders.join("\n"),
    );
  });

  it("lint regex flags the unguarded form and passes the guarded form", () => {
    assert.ok(SEAM_DEREF.test('cd "$TARGET_WS" && git fetch origin main'));
    assert.ok(SEAM_DEREF.test('git -C "${TARGET_WT}" status'));
    assert.ok(SEAM_DEREF.test("( cd $TARGET_APP_DIR && ls )"));
    assert.ok(!SEAM_DEREF.test('cd "${TARGET_WS:?unset}" && git fetch origin main'));
    assert.ok(!SEAM_DEREF.test('git -C "${TARGET_WT:?unset}/x" status'));
  });

  it("hydra-target-cleanup Step 1 re-resolves the seam in the block that cd's", () => {
    const text = readFileSync(join(PLAYBOOKS, "hydra-target-cleanup.md"), "utf8");
    const blocks: string[] = [];
    let cur: string[] | null = null;
    for (const line of text.split("\n")) {
      if (/^```bash/.test(line)) cur = [];
      else if (/^```/.test(line) && cur) {
        blocks.push(cur.join("\n"));
        cur = null;
      } else if (cur) cur.push(line);
    }
    const derefBlocks = blocks.filter((b) => /\$\{TARGET_(WS|APP_DIR):\?/.test(b));
    assert.ok(derefBlocks.length >= 2, "expected the fetch and knip blocks");
    for (const b of derefBlocks) {
      assert.match(b, /print-target-facts\.ts --sh/, "block must re-resolve the seam itself");
      assert.match(b, /eval "\$_target_seam_sh"/);
    }
  });

  it("self-isolation preamble forbids git remote mutation", () => {
    const text = readFileSync(
      join(PLAYBOOKS, "_fragments", "target-self-isolation-preamble.md"),
      "utf8",
    );
    assert.match(text, /NEVER run `git remote set-url\|add\|remove\|rm\|rename`/);
    assert.match(text, /seam var is EMPTY/);
  });
});
