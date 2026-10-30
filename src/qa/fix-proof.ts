/**
 * QA-Fix proof (issue #5266; ADR-0046 Decision 2, #5184 §1-§2) — the pure
 * deep module behind the `qa-fix-proof` sibling workflow.
 *
 * A reviewer may push commits to the PR it reviews, but only of two classes,
 * each stamped with a `QA-Fix: <A|B>` commit trailer:
 *
 *   A — non-executable (docs, changelog, generated inventories, ratchet baselines)
 *   B — tests (`test/*.test.mts` + the suite-count / test-source-read baselines)
 *
 * This module answers, without I/O: is every such commit inside its class's
 * explicit path allowlist, permitted by the `reviewer-commits` rollout stage,
 * and (for class B) did each new test fail BY ASSERTION at the merge-base?
 *
 * Pure, total, never throws. The git plumbing and the merge-base test run live
 * in scripts/ci/qa-fix-proof.ts (scripts may import src, never the reverse).
 */

import { isVerifierCore } from "../untouchable.ts";
import {
  parseQaFixCommitTrailer,
  type QaFixClass,
} from "./verdict-trailer.ts";
import type { ReviewerCommitsValue } from "./rollout-switches.ts";

/** Which reviewer classes may touch a path. `deny` = neither. */
export type QaFixPathClass = "A" | "B" | "AB" | "deny";

const CLASS_A_PREFIXES: readonly string[] = [".changelog/", "docs/generated/"];
/** Shrink-only ratchet baselines both classes may regenerate. */
const SHARED_BASELINES: readonly string[] = [
  "test/fixtures/suite-count-baseline.json",
  "test/fixtures/test-source-read-baseline.json",
];
/** Class-A-only ratchet baseline. */
const CLASS_A_BASELINES: readonly string[] = [
  "test/fixtures/coding-standards-baseline.json",
];
/** Retro-owned (Decision 8): never reviewer-editable. */
const RETRO_OWNED: readonly string[] = ["CODING_STANDARDS.md"];

function normalize(path: string): string {
  return String(path ?? "").trim().replace(/^\.\//, "");
}

/**
 * Classify one repo-relative path. Explicit exact/prefix/suffix rules, no
 * globs, so the list stays auditable (VERIFIER_CORE_PATHS style). Everything
 * not named is `deny`, including every Verifier Core path.
 */
export function classifyQaFixPath(path: string): QaFixPathClass {
  const p = normalize(path);
  if (p === "" || isVerifierCore(p)) return "deny";
  if (SHARED_BASELINES.includes(p)) return "AB";
  if (CLASS_A_BASELINES.includes(p)) return "A";
  if (RETRO_OWNED.includes(p)) return "deny";
  if (p.endsWith(".md")) return "A";
  if (CLASS_A_PREFIXES.some((prefix) => p.startsWith(prefix))) return "A";
  if (p.startsWith("test/") && !p.startsWith("test/helpers/") && p.endsWith(".test.mts")) {
    return "B";
  }
  return "deny";
}

/** True iff `path` is a test file a class-B commit must prove by assertion. */
export function isQaFixTestFile(path: string): boolean {
  const p = normalize(path);
  return p.startsWith("test/") && p.endsWith(".test.mts") && classifyQaFixPath(p) === "B";
}

export type QaFixViolationReason =
  | "malformed-trailer"
  | "stage-off"
  | "class-b-not-permitted"
  | "deny-path"
  | "wrong-class-path"
  | "verifier-core-pr";

export interface QaFixViolation {
  sha: string;
  reason: QaFixViolationReason;
  path?: string;
}

export interface QaFixCommit {
  sha: string;
  message: string;
  /** Paths the commit changes (added/modified/deleted). */
  paths: readonly string[];
}

export interface QaFixProofInput {
  commits: readonly QaFixCommit[];
  /** The PR's FULL changed-file list (merge-base...head). */
  changedFiles: readonly string[];
  /** Effective `reviewer-commits` stage read at the BASE ref. */
  stage: ReviewerCommitsValue;
}

export interface QaFixProofResult {
  ok: boolean;
  /** `no-qa-fix-commits` (fast path) | `commits-ok` | `violations`. */
  reason: "no-qa-fix-commits" | "commits-ok" | "violations";
  qaFixCommits: string[];
  violations: QaFixViolation[];
  /** Test files touched by class-B commits that need the assertion proof. */
  classBTestFiles: string[];
}

/** Pure commit-level evaluation. Never throws. */
export function evaluateQaFixProof(input: QaFixProofInput): QaFixProofResult {
  const violations: QaFixViolation[] = [];
  const qaFixCommits: string[] = [];
  const classB = new Set<string>();
  const commits = input.commits ?? [];

  const parsed = commits.map((c) => ({ c, t: parseQaFixCommitTrailer(c?.message) }));
  const present = parsed.filter((x) => x.t.present);
  if (present.length === 0) {
    return { ok: true, reason: "no-qa-fix-commits", qaFixCommits: [], violations: [], classBTestFiles: [] };
  }

  const coreInPr = (input.changedFiles ?? []).find((f) => isVerifierCore(normalize(f)));

  for (const { c, t } of present) {
    qaFixCommits.push(c.sha);
    if (!t.present) continue;
    if (coreInPr !== undefined) {
      violations.push({ sha: c.sha, reason: "verifier-core-pr", path: coreInPr });
    }
    const cls: QaFixClass | null = t.cls;
    if (cls === null) {
      violations.push({ sha: c.sha, reason: "malformed-trailer" });
      continue;
    }
    if (input.stage === "off") {
      violations.push({ sha: c.sha, reason: "stage-off" });
    } else if (cls === "B" && input.stage === "A") {
      violations.push({ sha: c.sha, reason: "class-b-not-permitted" });
    }
    for (const path of c.paths ?? []) {
      const pc = classifyQaFixPath(path);
      if (pc === "deny") {
        violations.push({ sha: c.sha, reason: "deny-path", path });
      } else if (pc !== "AB" && pc !== cls) {
        violations.push({ sha: c.sha, reason: "wrong-class-path", path });
      } else if (cls === "B" && isQaFixTestFile(path)) {
        classB.add(normalize(path));
      }
    }
  }

  const ok = violations.length === 0;
  return {
    ok,
    reason: ok ? "commits-ok" : "violations",
    qaFixCommits,
    violations,
    classBTestFiles: [...classB].sort(),
  };
}

// ---------------------------------------------------------------------------
// TAP assertion proof (STD-TEST-CAN-FAIL made mechanical)
//
// node:test's TAP reporter marks an assert-library failure with
// `code: 'ERR_ASSERTION'`; a file whose import/syntax fails is one file-level
// `not ok` named after the file carrying an `exitCode:` diagnostic; a plain
// `throw` is ERR_TEST_FAILURE without either. A file is PROVEN iff it has at
// least one ERR_ASSERTION failure AND no file-level crash entry.
// ---------------------------------------------------------------------------

export interface TapFileProof {
  proven: boolean;
  assertionFailures: number;
  crashed: boolean;
}

export interface TapProofResult {
  ok: boolean;
  files: Record<string, TapFileProof>;
  unproven: string[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Pure; never throws. Files absent from the TAP are unproven (all passed). */
export function parseTapAssertionProof(
  tap: string | null | undefined,
  files: readonly string[],
): TapProofResult {
  const text = typeof tap === "string" ? tap : "";
  const lines = text.split(/\r?\n/);
  const header = /^\s*(not ok|ok)\s+\d+\b/;
  const blocks: string[][] = [];
  for (const line of lines) {
    if (header.test(line)) blocks.push([line]);
    else if (blocks.length > 0) (blocks[blocks.length - 1] as string[]).push(line);
  }
  const failing = blocks.filter((b) => /^\s*not ok\b/.test(b[0] as string));

  const out: Record<string, TapFileProof> = {};
  const unproven: string[] = [];
  for (const file of files) {
    const f = normalize(file);
    const at = new RegExp(`(^|[/'"\\s:])${escapeRegExp(f)}(?=$|[:'"\\s])`);
    let assertionFailures = 0;
    let crashed = false;
    for (const b of failing) {
      const body = b.join("\n");
      if (!at.test(body)) continue;
      if (/\bcode:\s*'?ERR_ASSERTION'?/.test(body)) assertionFailures += 1;
      if (at.test(b[0] as string) && /\bexitCode:\s*\d+/.test(body)) crashed = true;
    }
    const proven = assertionFailures >= 1 && !crashed;
    out[f] = { proven, assertionFailures, crashed };
    if (!proven) unproven.push(f);
  }
  return { ok: unproven.length === 0, files: out, unproven };
}
