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
 *
 * `--mode changed-tests` (issue #5447, advisory) reuses the same merge-base
 * worktree + `test:file` + TAP proof to annotate test files a PR adds/extends
 * whose every case already passes at the merge-base (STD-TEST-CAN-FAIL). It
 * never reddens a merge: exit 0 on every path except usage (2).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateQaFixProof,
  parseTapAssertionProof,
  type QaFixCommit,
  type TapProofResult,
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

const gitSync = (args: string[], cwd?: string): string =>
  execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
    ...(cwd !== undefined ? { cwd } : {}),
  });

/**
 * Run `npm run test:file -- <proofFiles>` in a throwaway worktree at `mergeBase`
 * with `overlayFiles` checked out from `head` on top. Returns the captured
 * output; THROWS on infrastructure failure (worktree / spawn). The worktree is
 * removed in `finally` on every path. Shared by both modes.
 */
export function runMergeBaseProof(opts: {
  mergeBase: string;
  head: string;
  overlayFiles: readonly string[];
  proofFiles: readonly string[];
}): { stdout: string; stderr: string } {
  const wt = join(mkdtempSync(join(tmpdir(), "qa-fix-proof-")), "wt");
  let added = false;
  try {
    gitSync(["worktree", "add", "--detach", wt, opts.mergeBase]);
    added = true;
    const nm = resolve("node_modules");
    if (existsSync(nm)) symlinkSync(nm, join(wt, "node_modules"));
    gitSync(["checkout", opts.head, "--", ...opts.overlayFiles], wt);
    const run = spawnSync("npm", ["run", "test:file", "--", ...opts.proofFiles], {
      cwd: wt,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 128,
      timeout: 15 * 60 * 1000,
    });
    if (run.error) throw run.error;
    return { stdout: run.stdout, stderr: run.stderr };
  } finally {
    if (added) {
      try {
        gitSync(["worktree", "remove", "--force", wt]);
      } catch (err) {
        console.error(`[qa-fix-proof] worktree cleanup failed for ${wt}:`, err);
      }
    }
  }
}

// ── changed-tests mode (issue #5447) ─────────────────────────────────────────

export interface ChangedTestEntry {
  /** First char of `git diff --name-status` (A/M/D/R/C/T...). */
  status: string;
  /** Path at head (the new path for a rename). */
  path: string;
  /** For M entries: the `-U0` diff adds a `test(`/`it(` call line. */
  addsCase: boolean;
}

export interface ChangedTestSelection {
  candidates: string[];
  skipped: Array<{ path: string; reason: string }>;
  /** Every changed `test/**` path present at head: overlaid onto the merge-base. */
  overlay: string[];
}

const TEST_FILE_RE = /^test\/.+\.test\.mts$/;
const ADDED_CASE_RE = /^\+.*\b(test|it)\(/m;

/** True when a `-U0` diff adds a `test(`/`it(` call line. Pure. */
export function diffAddsTestCase(diff: string): boolean {
  return ADDED_CASE_RE.test(diff);
}

/** Pure candidate selection (INV-5/INV-6). Deleted/renamed files are never candidates. */
export function selectChangedTestCandidates(entries: readonly ChangedTestEntry[]): ChangedTestSelection {
  const candidates: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  const overlay: string[] = [];
  for (const e of entries) {
    if (e.status === "D") continue;
    overlay.push(e.path);
    if (!TEST_FILE_RE.test(e.path) || e.path.startsWith("test/helpers/")) continue;
    if (e.status === "A") candidates.push(e.path);
    else if (e.status === "M") {
      if (e.addsCase) candidates.push(e.path);
      else skipped.push({ path: e.path, reason: "no-new-case" });
    }
  }
  return { candidates, skipped, overlay };
}

export type ChangedTestOutcome = "proven" | "inconclusive" | "passes-at-merge-base";

export interface ChangedTestClassification {
  proven: string[];
  inconclusive: string[];
  passesAtMergeBase: string[];
  files: Record<string, { outcome: ChangedTestOutcome; assertionFailures: number; crashed: boolean }>;
}

/** Three-way per-file outcome over `parseTapAssertionProof` output. Pure. */
export function classifyChangedTestProof(
  tapProof: TapProofResult,
  candidates: readonly string[],
): ChangedTestClassification {
  const out: ChangedTestClassification = { proven: [], inconclusive: [], passesAtMergeBase: [], files: {} };
  for (const c of candidates) {
    const f = tapProof.files[c];
    const assertionFailures = f?.assertionFailures ?? 0;
    const crashed = f?.crashed ?? false;
    let outcome: ChangedTestOutcome;
    if (crashed) outcome = "inconclusive";
    else if (assertionFailures >= 1) outcome = "proven";
    else outcome = "passes-at-merge-base";
    out.files[c] = { outcome, assertionFailures, crashed };
    if (outcome === "proven") out.proven.push(c);
    else if (outcome === "inconclusive") out.inconclusive.push(c);
    else out.passesAtMergeBase.push(c);
  }
  return out;
}

/** True when the runner output carries at least one TAP `ok`/`not ok` header. Pure. */
export function hasTapEvidence(tap: string | null | undefined): boolean {
  return typeof tap === "string" && /^\s*(not ok|ok)\s+\d+\b/m.test(tap);
}

/** Annotation wording (INV-9): never asserts vacuity. */
export function changedTestWarning(file: string): string {
  return (
    `::warning file=${file}::${file}: every case passes against the merge-base — either it cannot be ` +
    "pinning this change (STD-TEST-CAN-FAIL) or it pins an invariant already true on master; " +
    "fix the case or justify in the PR body"
  );
}

/** Advisory runner for `--mode changed-tests`. Never throws; the caller exits 0. */
export function runChangedTestsMode(base: string, head: string): { lines: string[]; body: unknown } {
  const lines: string[] = [];
  let mergeBase = "";
  try {
    mergeBase = gitSync(["merge-base", base, head]).trim();
    const entries: ChangedTestEntry[] = [];
    const nameStatus = gitSync(["diff", "--name-status", "-M", `${mergeBase}...${head}`, "--", "test"]);
    for (const line of nameStatus.split("\n")) {
      if (line.trim() === "") continue;
      const parts = line.split("\t");
      const st = (parts[0] as string).charAt(0);
      const path = parts[parts.length - 1] as string;
      let addsCase = false;
      if (st === "M" && TEST_FILE_RE.test(path)) {
        addsCase = diffAddsTestCase(gitSync(["diff", "-U0", `${mergeBase}...${head}`, "--", path]));
      }
      entries.push({ status: st, path, addsCase });
    }
    const sel = selectChangedTestCandidates(entries);
    const head0 = { mode: "changed-tests", mergeBase, candidates: sel.candidates, skipped: sel.skipped };
    if (sel.candidates.length === 0) {
      return { lines, body: { ...head0, files: {}, findings: [] } };
    }
    const run = runMergeBaseProof({
      mergeBase,
      head,
      overlayFiles: sel.overlay,
      proofFiles: sel.candidates,
    });
    if (!hasTapEvidence(run.stdout)) {
      // INV-3/INV-4: no TAP at all is an infrastructure failure, never "passes at merge-base".
      lines.push("::warning::test-can-fail proof produced no TAP output (infrastructure failure); skipping verdicts");
      const files: Record<string, unknown> = {};
      for (const c of sel.candidates) files[c] = { outcome: "inconclusive", assertionFailures: 0, crashed: false };
      return { lines, body: { ...head0, files, findings: [], error: "no-tap-output" } };
    }
    const cls = classifyChangedTestProof(parseTapAssertionProof(run.stdout, sel.candidates), sel.candidates);
    for (const f of cls.passesAtMergeBase) lines.push(changedTestWarning(f));
    return { lines, body: { ...head0, files: cls.files, findings: cls.passesAtMergeBase } };
  } catch (err) {
    console.error("[qa-fix-proof] changed-tests proof run failed:", err);
    const reason = err instanceof Error ? err.message : String(err);
    lines.push(`::warning::test-can-fail proof could not run: ${reason.split("\n")[0]}`);
    return {
      lines,
      body: { mode: "changed-tests", mergeBase, candidates: [], skipped: [], files: {}, findings: [], error: reason },
    };
  }
}

const isMain = (() => {
  try {
    if (typeof process === "undefined" || !Array.isArray(process.argv) || process.argv[1] === undefined) {
      return false;
    }
    // realpath both sides: a symlinked or space-containing argv[1] must still match.
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch (err) {
    console.error("[qa-fix-proof] could not resolve entrypoint; treating as not-main:", err);
    return false;
  }
})();

if (isMain) {
  const parseArg = (flag: string): string => {
    const idx = process.argv.indexOf(flag);
    if (idx === -1 || idx === process.argv.length - 1) return "";
    return process.argv[idx + 1] as string;
  };
  const base = parseArg("--base");
  const head = parseArg("--head");
  const modeArg = parseArg("--mode");
  if (base === "" || head === "" || (modeArg !== "" && modeArg !== "qa-fix" && modeArg !== "changed-tests")) {
    console.error("usage: qa-fix-proof.ts --base <sha> --head <sha> [--mode qa-fix|changed-tests]");
    process.exit(2);
  }
  if (modeArg === "changed-tests") {
    const r = runChangedTestsMode(base, head);
    for (const l of r.lines) console.log(l);
    console.log(JSON.stringify(r.body));
    process.exit(0);
  }

  const git = gitSync;
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
      // A class-B commit may not delete/rename a test file: the removal would pass unproven.
      const missing = result.classBTestFiles.filter((f) => {
        try {
          git(["cat-file", "-e", `${head}:${f}`]);
          return false;
        } catch {
          /* intentional: path absent at head (deleted/renamed) — reported as a violation below */
          return true;
        }
      });
      if (missing.length > 0) {
        emit(
          {
            ...result,
            ok: false,
            reason: "class-b-deletes-test",
            stage,
            violations: [...result.violations, ...missing.map((path) => ({ reason: "class-b-deletes-test", path }))],
          },
          1,
        );
      }
      const files = result.classBTestFiles;
      let outcome: { code: number; body: unknown } = { code: 1, body: { ok: false, reason: "proof-run-failed" } };
      try {
        const run = runMergeBaseProof({ mergeBase, head, overlayFiles: files, proofFiles: files });
        const proof = parseTapAssertionProof(run.stdout, files);
        if (!proof.ok) {
          console.error(run.stderr);
          outcome = { code: 1, body: { ...result, ok: false, reason: "unproven", stage, proof } };
        } else {
          outcome = { code: 0, body: { ...result, stage, proof } };
        }
      } catch (err) {
        console.error("[qa-fix-proof] merge-base test run failed:", err);
      }
      emit(outcome.body, outcome.code);
    }
    emit({ ...result, stage }, 0);
  } catch (err) {
    console.error("[qa-fix-proof] proof run failed:", err);
    emit({ ok: false, reason: "proof-run-failed", violations: [] }, 1);
  }
}
