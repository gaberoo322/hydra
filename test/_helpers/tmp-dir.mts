/**
 * Tracked temp dirs for test files (issue #5326).
 *
 * `/tmp` is a tmpfs shared by the four CI runners and every agent worktree,
 * with a hard inode cap. A test that calls `mkdtempSync(tmpdir())` without a
 * matching `rmSync` leaks one dir per run per runner; on 2026-10-31 those
 * leaks helped exhaust every inode on the box.
 *
 * `tmpDirTracker()` returns a `makeTmpDir(prefix)` that creates a dir under
 * `os.tmpdir()` and records it; the tracker registers ONE file-level `after`
 * hook that removes every recorded dir once the file's tests finish. Call it
 * at module top level (where `after` attaches to the file's root suite):
 *
 *   const makeTmpDir = tmpDirTracker();
 *   const dir = makeTmpDir("pmh-e2e-");
 */
import { after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tmpDirTracker(): (prefix: string) => string {
  const dirs: string[] = [];
  after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  return (prefix: string): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  };
}
