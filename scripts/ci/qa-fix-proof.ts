/**
 * scripts/ci/qa-fix-proof.ts — CLI behind the `qa-fix-proof` sibling workflow
 * (issue #5266, ADR-0046 Decision 2).
 *
 * Verifies every commit in `<merge-base>..<head>` carrying a `QA-Fix:` trailer
 * (path allowlist per class, rollout stage read at the BASE ref, class-B tests
 * must fail BY ASSERTION at the merge-base). Zero QA-Fix commits => immediate
 * pass with no `npm ci` and no test run.
 *
 * Exit: 0 = ok, 1 = violation / unproven / proof-run-failed (fail closed),
 * 2 = usage. stdout is one JSON result object.
 *
 *   node --experimental-strip-types scripts/ci/qa-fix-proof.ts --base <sha> --head <sha>
 */

import {
  evaluateQaFixProof,
  parseTapAssertionProof,
  type QaFixCommit,
} from "../../src/qa/fix-proof.ts";
import {
  COHORT_BASELINE_PATH,
  QA_ROLLOUT_CONFIG_PATH,
  resolveRolloutSwitches,
  tripFromBaseline,
  type ReviewerCommitsValue,
} from "../../src/qa/rollout-switches.ts";
import { parseQaFixCommitTrailer } from "../../src/qa/verdict-trailer.ts";

/** Parse `git log --format=%H%x1f%B%x1e` output into commits (paths filled later). */
export function parseGitLog(out: string): Array<{ sha: string; message: string }> {
  const commits: Array<{ sha: string; message: string }> = [];
  for (const rec of out.split("\x1e")) {
    const trimmed = rec.replace(/^\n+/, "");
    if (trimmed.trim() === "") continue;
    const idx = trimmed.indexOf("\x1f");
    if (idx === -1) continue;
    commits.push({ sha: trimmed.slice(0, idx).trim(), message: trimmed.slice(idx + 1) });
  }
  return commits;
}

const isMain = (() => {
  try {
    return (
      typeof process !== "undefined" &&
      Array.isArray(process.argv) &&
      typeof import.meta.url === "string" &&
      process.argv[1] !== undefined &&
      import.meta.url === `file://${process.argv[1]}`
    );
  } catch {
    /* intentional: import.meta may be unavailable under some loaders; treat as not-main */
    return false;
  }
})();

if (isMain) {
  const { execFileSync, spawnSync } = await import("node:child_process");
  const { mkdtempSync, symlinkSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");

  const parseArg = (flag: string): string => {
    const idx = process.argv.indexOf(flag);
    if (idx === -1 || idx === process.argv.length - 1) return "";
    return process.argv[idx + 1] as string;
  };
  const base = parseArg("--base");
  const head = parseArg("--head");
  if (base === "" || head === "") {
    console.error("usage: qa-fix-proof.ts --base <sha> --head <sha>");
    process.exit(2);
  }

  const git = (args: string[], cwd?: string): string =>
    execFileSync("git", args, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 64,
      ...(cwd !== undefined ? { cwd } : {}),
    });
  const emit = (obj: unknown, code: number): never => {
    console.log(JSON.stringify(obj));
    process.exit(code);
  };

  try {
    const mergeBase = git(["merge-base", base, head]).trim();
    const log = parseGitLog(
      git(["log", "--no-merges", "--format=%H%x1f%B%x1e", `${mergeBase}..${head}`]),
    );

    // Fast path: no trailer anywhere => pass without reading config or npm ci.
    if (!log.some((c) => parseQaFixCommitTrailer(c.message).present)) {
      emit({ ok: true, reason: "no-qa-fix-commits", qaFixCommits: [], violations: [] }, 0);
    }

    const commits: QaFixCommit[] = log.map((c) => ({
      ...c,
      paths: git(["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", c.sha])
        .split("\n")
        .filter((l) => l.trim() !== ""),
    }));
    const changedFiles = git(["diff", "--name-only", `${mergeBase}...${head}`])
      .split("\n")
      .filter((l) => l.trim() !== "");

    // Rollout stage is read at the BASE ref, never the head tree.
    const showAtBase = (path: string): string | undefined => {
      try {
        return git(["show", `${base}:${path}`]);
      } catch (err) {
        console.error(`[qa-fix-proof] ${path} unreadable at base ${base} (treated as missing):`, err);
        return undefined;
      }
    };
    const cfgText = showAtBase(QA_ROLLOUT_CONFIG_PATH);
    let raw: unknown = undefined;
    if (cfgText !== undefined) {
      try {
        raw = JSON.parse(cfgText);
      } catch {
        /* intentional: unparsable config resolves to config-malformed => off */
        raw = "malformed";
      }
    }
    const baselineText = showAtBase(COHORT_BASELINE_PATH);
    const trip = baselineText === undefined ? "unknown" : tripFromBaseline(baselineText);
    const stage: ReviewerCommitsValue = resolveRolloutSwitches(raw, trip).effective["reviewer-commits"];

    const result = evaluateQaFixProof({ commits, changedFiles, stage });
    if (!result.ok) emit({ ...result, stage }, 1);

    if (result.classBTestFiles.length > 0) {
      // A class-B commit may delete a test file; only files present at head can be checked out.
      const files = result.classBTestFiles.filter((f) => {
        try {
          git(["cat-file", "-e", `${head}:${f}`]);
          return true;
        } catch {
          /* intentional: path absent at head (deleted/renamed) — nothing to prove */
          return false;
        }
      });
      if (files.length > 0) {      const wt = join(mkdtempSync(join(tmpdir(), "qa-fix-proof-")), "wt");
      let added = false;
      let outcome: { code: number; body: unknown } = { code: 1, body: { ok: false, reason: "proof-run-failed" } };
      try {
        git(["worktree", "add", "--detach", wt, mergeBase]);
        added = true;
        const nm = resolve("node_modules");
        if (existsSync(nm)) symlinkSync(nm, join(wt, "node_modules"));
        git(["checkout", head, "--", ...files], wt);
        const run = spawnSync("npm", ["run", "test:file", "--", ...files], {
          cwd: wt,
          encoding: "utf8",
          maxBuffer: 1024 * 1024 * 128,
          timeout: 15 * 60 * 1000,
        });
        if (run.error) throw run.error;
        const proof = parseTapAssertionProof(run.stdout, files);
        if (!proof.ok) {
          console.error(run.stderr);
          outcome = { code: 1, body: { ...result, ok: false, reason: "unproven", stage, proof } };
        } else {
          outcome = { code: 0, body: { ...result, stage, proof } };
        }
      } catch (err) {
        console.error("[qa-fix-proof] merge-base test run failed:", err);
      } finally {
        if (added) {
          try {
            git(["worktree", "remove", "--force", wt]);
          } catch (err) {
            console.error(`[qa-fix-proof] worktree cleanup failed for ${wt}:`, err);
          }
        }
      }
      emit(outcome.body, outcome.code);
      }
    }
    emit({ ...result, stage }, 0);
  } catch (err) {
    console.error("[qa-fix-proof] proof run failed:", err);
    emit({ ok: false, reason: "proof-run-failed", violations: [] }, 1);
  }
}
