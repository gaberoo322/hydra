/**
 * QA merge guard (issue #4737, decision #4736 option 2): "may this PR merge
 * now?" answered from the latest `QA-Verdict:` trailer, bound to the PR's
 * current head SHA. Pure-function table tests + the fetcher seam + the CLI's
 * argument contract (no network: a bad `--pr` exits 2 before any gh call).
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  evaluateQaMergeGuard,
  isQaExemptChange,
  isQaExemptPath,
  latestQaVerdictTrailer,
  runQaMergeGuard,
  type QaMergeGuardInput,
} from "../scripts/ci/qa-merge-guard.ts";
import { renderQaVerdictTrailer, type FinalVerdict } from "../scripts/ci/qa-verdict.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const OLD = "fedcba9876543210fedcba9876543210fedcba98";
const PR = 4380;

function trailer(verdict: FinalVerdict, sha: string, pr = PR, round = 1): string {
  return `> *Automated QA*\n\nreview...\n\n${renderQaVerdictTrailer({
    verdict,
    pr,
    round,
    sha,
    blockers: verdict.startsWith("FAIL") ? 1 : 0,
    maxSeverity: verdict.startsWith("FAIL") ? "high" : "none",
  })}`;
}

function input(o: Partial<QaMergeGuardInput>): QaMergeGuardInput {
  return { pr: PR, headSha: HEAD, changedFiles: ["src/x.ts"], bodies: [], ...o };
}

describe("qa-merge-guard — evaluateQaMergeGuard table (#4737)", () => {
  const rows: Array<{
    name: string;
    in: QaMergeGuardInput;
    allowed: boolean;
    reason: string;
  }> = [
    { name: "PASS@head -> allowed", in: input({ bodies: [trailer("PASS", HEAD)] }), allowed: true, reason: "verdict-at-head" },
    { name: "PASS-pending-CI@head -> allowed", in: input({ bodies: [trailer("PASS-pending-CI", HEAD)] }), allowed: true, reason: "verdict-at-head" },
    { name: "PASS@old-sha -> denied stale-verdict", in: input({ bodies: [trailer("PASS", OLD)] }), allowed: false, reason: "stale-verdict" },
    { name: "PASS with sha=unknown -> denied stale-verdict (unknown never matches)", in: input({ bodies: [trailer("PASS", "")] }), allowed: false, reason: "stale-verdict" },
    { name: "PASS@head but head unknown -> denied stale-verdict", in: input({ headSha: "", bodies: [trailer("PASS", HEAD)] }), allowed: false, reason: "stale-verdict" },
    { name: "FAIL@head -> denied", in: input({ bodies: [trailer("FAIL", HEAD)] }), allowed: false, reason: "verdict-fail" },
    { name: "FAIL-pending-CI@head -> denied", in: input({ bodies: [trailer("FAIL-pending-CI", HEAD)] }), allowed: false, reason: "verdict-fail" },
    { name: "#4380 shape: PASS@old then FAIL@head -> denied", in: input({ bodies: [trailer("PASS", OLD), trailer("FAIL", HEAD, PR, 2)] }), allowed: false, reason: "verdict-fail" },
    { name: "FAIL@old then PASS@head -> allowed (latest wins)", in: input({ bodies: [trailer("FAIL", OLD), trailer("PASS", HEAD, PR, 2)] }), allowed: true, reason: "verdict-at-head" },
    { name: "no verdict -> denied not-reviewed", in: input({}), allowed: false, reason: "not-reviewed" },
    { name: "trailer naming another PR is ignored -> not-reviewed", in: input({ bodies: [trailer("PASS", HEAD, 9999)] }), allowed: false, reason: "not-reviewed" },
    { name: "docs/research-only diff with no verdict -> allowed exempt", in: input({ changedFiles: ["docs/research/2026-09-28-x.md"] }), allowed: true, reason: "exempt" },
    { name: "docs/adr + docs/research diff with no verdict -> allowed exempt", in: input({ changedFiles: ["docs/adr/0042-x.md", "docs/research/y.md"] }), allowed: true, reason: "exempt" },
    { name: "exempt diff with a stale PASS -> allowed exempt", in: input({ changedFiles: ["docs/adr/0042-x.md"], bodies: [trailer("PASS", OLD)] }), allowed: true, reason: "exempt" },
    { name: "exempt diff with a FAIL at head -> denied (a FAIL at the reviewed head still holds)", in: input({ changedFiles: ["docs/adr/0042-x.md"], bodies: [trailer("FAIL", HEAD)] }), allowed: false, reason: "verdict-fail" },
    { name: "exempt diff with a FAIL at an old head -> allowed exempt", in: input({ changedFiles: ["docs/adr/0042-x.md"], bodies: [trailer("FAIL", OLD)] }), allowed: true, reason: "exempt" },
    { name: "mixed docs + code diff with no verdict -> not-reviewed", in: input({ changedFiles: ["docs/research/x.md", "src/y.ts"] }), allowed: false, reason: "not-reviewed" },
    { name: "empty changed-file list is never exempt", in: input({ changedFiles: [] }), allowed: false, reason: "not-reviewed" },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const r = evaluateQaMergeGuard(row.in);
      assert.equal(r.allowed, row.allowed);
      assert.equal(r.reason, row.reason);
    });
  }

  test("result carries verdict, verdictSha, headSha, exempt", () => {
    const r = evaluateQaMergeGuard(input({ bodies: [trailer("PASS", OLD)] }));
    assert.deepEqual(r, {
      allowed: false,
      reason: "stale-verdict",
      verdict: "PASS",
      verdictSha: OLD.slice(0, 12),
      headSha: HEAD,
      exempt: false,
    });
  });

  test("a QA-Verdict-Error line (no sha=) is not a verdict -> not-reviewed", () => {
    const r = evaluateQaMergeGuard(
      input({ bodies: ["QA-Verdict-Error: verdict=PASS pr=4380 reason=render failed"] }),
    );
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "not-reviewed");
  });
});

describe("qa-merge-guard — exemption helpers (#4736 default)", () => {
  test("isQaExemptPath covers docs/research/ and docs/adr/ only", () => {
    assert.equal(isQaExemptPath("docs/research/a.md"), true);
    assert.equal(isQaExemptPath("./docs/adr/0001-x.md"), true);
    assert.equal(isQaExemptPath("docs/reference.md"), false);
    assert.equal(isQaExemptPath("docs/researchy/a.md"), false);
    assert.equal(isQaExemptPath("src/docs/adr/x.ts"), false);
  });
  test("isQaExemptChange requires a non-empty all-exempt list", () => {
    assert.equal(isQaExemptChange([]), false);
    assert.equal(isQaExemptChange(["docs/adr/x.md"]), true);
    assert.equal(isQaExemptChange(["docs/adr/x.md", "CLAUDE.md"]), false);
  });
  test("latestQaVerdictTrailer returns the last trailer naming the PR", () => {
    const t = latestQaVerdictTrailer(
      [trailer("PASS", OLD), trailer("FAIL", HEAD, PR, 2), trailer("PASS", HEAD, 1)],
      PR,
    );
    assert.equal(t?.verdict, "FAIL");
    assert.equal(t?.round, 2);
  });
});

describe("qa-merge-guard — runQaMergeGuard fetcher seam", () => {
  test("orders entries chronologically before picking the latest verdict", () => {
    const r = runQaMergeGuard(PR, () => ({
      headSha: HEAD,
      changedFiles: ["src/x.ts"],
      entries: [
        { body: trailer("FAIL", HEAD, PR, 2), at: "2026-09-28T10:00:04Z" },
        { body: trailer("PASS", OLD), at: "2026-09-28T09:00:00Z" },
      ],
    }));
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "verdict-fail");
  });

  test("a null fetch fails closed (fetch-failed)", () => {
    const r = runQaMergeGuard(PR, () => null);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "fetch-failed");
  });

  test("a throwing fetcher fails closed (fetch-failed)", () => {
    const r = runQaMergeGuard(PR, () => {
      throw new Error("boom");
    });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "fetch-failed");
  });
});

describe("qa-merge-guard — CLI contract", () => {
  const CLI = join(REPO_ROOT, "scripts", "ci", "qa-merge-guard.ts");

  test("missing --pr exits 2 (usage) without any gh call", () => {
    const r = spawnSync(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", CLI],
      { encoding: "utf8", env: { ...process.env, PATH: "/nonexistent" } },
    );
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /usage: qa-merge-guard\.ts --pr <N>/);
  });

  test("uses REST gh api, never gh --json GraphQL", () => {
    const src = readFileSync(CLI, "utf8");
    assert.match(src, /\["api", /);
    assert.doesNotMatch(src, /"--json"/);
  });
});
