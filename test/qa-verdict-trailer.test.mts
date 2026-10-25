/**
 * test/qa-verdict-trailer.test.mts — the QA-Verdict trailer grammar owner
 * (src/qa/verdict-trailer.ts; issues #4729, #4746, #5078).
 *
 * The render + parse describes moved 1:1 from
 * test/hydra-qa-prompt-verdict.test.mts; the playbook-executing describes
 * stay there. Also pins that the grammar has exactly one owner.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  QA_VERDICT_TRAILER_PREFIX,
  QA_VERDICT_UNKNOWN_SHA,
  parseQaVerdictErrors,
  renderQaVerdictErrorLine,
  qaVerdictShaMatches,
  type FinalVerdict,
  type QaSeverity,
  renderQaVerdictTrailer,
  parseQaVerdictTrailer,
  parseQaVerdictTrailers,
  isFailVerdict,
  nextQaVerdictRound,
  buildQaVerdictTrailer,
} from "../src/qa/verdict-trailer.ts";

const ALL_VERDICTS = ["PASS", "FAIL", "PASS-pending-CI", "FAIL-pending-CI"] as const;
const FULL_HEAD = "0123456789abcdef0123456789abcdef01234567";

const TRAILER_SHAPE_RE =
  /^QA-Verdict: (PASS|FAIL|PASS-pending-CI|FAIL-pending-CI) pr=\d+ round=\d+ sha=[0-9a-f]{12} blockers=\d+ max_severity=(high|medium|low|none)$/;

describe("QA-Verdict trailer — render + parse (issue #4729)", () => {
  const HEAD = "ABCDEF0123456789abcdef0123456789abcdef01";

  test("renders the exact canonical shape", () => {
    const line = renderQaVerdictTrailer({
      verdict: "FAIL", pr: 4729, round: 2, sha: HEAD, blockers: 3, maxSeverity: "medium",
    });
    assert.equal(
      line,
      "QA-Verdict: FAIL pr=4729 round=2 sha=abcdef012345 blockers=3 max_severity=medium",
    );
    assert.match(line, TRAILER_SHAPE_RE);
    assert.ok(line.startsWith(QA_VERDICT_TRAILER_PREFIX));
  });

  test("zero blockers always renders max_severity=none; blockers with no severity renders high", () => {
    assert.match(
      renderQaVerdictTrailer({ verdict: "PASS", pr: 1, round: 1, sha: HEAD, blockers: 0, maxSeverity: "high" }),
      / blockers=0 max_severity=none$/,
    );
    assert.match(
      renderQaVerdictTrailer({ verdict: "FAIL", pr: 1, round: 1, sha: HEAD, blockers: 2, maxSeverity: "none" }),
      / blockers=2 max_severity=high$/,
    );
  });

  test("render → parse round-trips every verdict literal (PASS never shadows PASS-pending-CI)", () => {
    for (const verdict of ["PASS", "FAIL", "PASS-pending-CI", "FAIL-pending-CI"] as const) {
      const line = renderQaVerdictTrailer({ verdict, pr: 7, round: 3, sha: HEAD, blockers: 1, maxSeverity: "low" });
      assert.deepEqual(parseQaVerdictTrailer(`header\n\n${line}\n`), {
        verdict, pr: 7, round: 3, sha: "abcdef012345", blockers: 1, maxSeverity: "low",
      });
    }
  });

  test("parse returns null for legacy bodies and malformed lines", () => {
    assert.equal(parseQaVerdictTrailer("> *Automated QA — two-axis review*\n\n**Verdict:** `FAIL`"), null);
    assert.equal(parseQaVerdictTrailer(null), null);
    assert.equal(parseQaVerdictTrailer("QA-Verdict: MAYBE pr=1 round=1 sha=abcdef0 blockers=0 max_severity=none"), null);
    assert.equal(parseQaVerdictTrailer("QA-Verdict: PASS pr=0 round=1 sha=abcdef0 blockers=0 max_severity=none"), null);
    assert.equal(parseQaVerdictTrailer("QA-Verdict: PASS round=1 pr=1 sha=abcdef0 blockers=0 max_severity=none"), null);
    // Mid-line mention (e.g. quoted in prose) is not a trailer.
    assert.equal(parseQaVerdictTrailer("see `QA-Verdict: PASS pr=1 round=1 sha=abcdef0 blockers=0 max_severity=none`"), null);
  });

  test("parseQaVerdictTrailers returns every trailer in order; isFailVerdict splits the literals", () => {
    const body = [
      "QA-Verdict: FAIL pr=5 round=1 sha=abcdef012345 blockers=1 max_severity=high",
      "QA-Verdict: PASS pr=5 round=2 sha=abcdef012346 blockers=0 max_severity=none",
    ].join("\r\n");
    const all = parseQaVerdictTrailers(body);
    assert.deepEqual(all.map((t) => t.round), [1, 2]);
    assert.equal(isFailVerdict("FAIL"), true);
    assert.equal(isFailVerdict("FAIL-pending-CI"), true);
    assert.equal(isFailVerdict("PASS"), false);
    assert.equal(isFailVerdict("PASS-pending-CI"), false);
  });

  test("round = prior trailers naming the same PR + 1 (other PRs ignored)", () => {
    const prior = [
      "no trailer here",
      "x\nQA-Verdict: FAIL pr=9 round=1 sha=abcdef012345 blockers=1 max_severity=low",
      "QA-Verdict: FAIL pr=8 round=1 sha=abcdef012345 blockers=1 max_severity=low",
      null,
    ];
    assert.equal(nextQaVerdictRound(prior, 9), 2);
    assert.equal(nextQaVerdictRound(prior, 8), 2);
    assert.equal(nextQaVerdictRound([], 9), 1);
    assert.equal(
      buildQaVerdictTrailer({ verdict: "PASS", pr: 9, headSha: HEAD, blockers: 0, maxSeverity: "none", priorBodies: prior }),
      "QA-Verdict: PASS pr=9 round=2 sha=abcdef012345 blockers=0 max_severity=none",
    );
  });
});

describe("QA-Verdict trailer — every rendered line parses (issue #4746)", () => {
  const SHAS = [FULL_HEAD, FULL_HEAD.toUpperCase(), FULL_HEAD.slice(0, 12), FULL_HEAD.slice(0, 7), "", "   ", "abc", "not-a-sha", "unknown", undefined];
  const BLOCKER_COUNTS = [0, 1, 7, -3, Number.NaN];
  const SEVERITIES = ["high", "medium", "low", "none", "bogus"];

  test("parse(render(x)) round-trips for every verdict × sha × blockers × severity", () => {
    let n = 0;
    for (const verdict of ALL_VERDICTS) {
      for (const sha of SHAS) {
        for (const blockers of BLOCKER_COUNTS) {
          for (const sev of SEVERITIES) {
            const line = renderQaVerdictTrailer({
              verdict, pr: 42, round: 2, sha: sha as string, blockers, maxSeverity: sev as QaSeverity,
            });
            const parsed = parseQaVerdictTrailer(line);
            assert.ok(parsed, `renderer emitted an unparseable line: ${line}`);
            const cut = String(sha ?? "").trim().toLowerCase().slice(0, 12);
            const expectedSha = /^[0-9a-f]{7,12}$/.test(cut) ? cut : QA_VERDICT_UNKNOWN_SHA;
            const b = Number.isFinite(blockers) ? Math.max(0, blockers) : 0;
            assert.deepEqual(parsed, {
              verdict, pr: 42, round: 2, sha: expectedSha, blockers: b,
              maxSeverity: b === 0 ? "none" : sev === "none" || sev === "bogus" ? "high" : sev,
            });
            n += 1;
          }
        }
      }
    }
    assert.equal(n, ALL_VERDICTS.length * SHAS.length * BLOCKER_COUNTS.length * SEVERITIES.length);
  });

  test("empty / unknown head SHA renders the documented sentinel, which never matches a head SHA", () => {
    const line = renderQaVerdictTrailer({ verdict: "PASS", pr: 1, round: 1, sha: "", blockers: 0, maxSeverity: "none" });
    assert.equal(line, "QA-Verdict: PASS pr=1 round=1 sha=unknown blockers=0 max_severity=none");
    const t = parseQaVerdictTrailer(line);
    assert.ok(t);
    assert.equal(t.sha, QA_VERDICT_UNKNOWN_SHA);
    assert.equal(qaVerdictShaMatches(t, FULL_HEAD), false);
    assert.equal(qaVerdictShaMatches(t, ""), false);
    assert.equal(qaVerdictShaMatches(t, "unknown"), false);
  });

  test("qaVerdictShaMatches: the 12-char sha matches its own head only", () => {
    const t = parseQaVerdictTrailer(
      renderQaVerdictTrailer({ verdict: "PASS", pr: 1, round: 1, sha: FULL_HEAD, blockers: 0, maxSeverity: "none" }),
    );
    assert.ok(t);
    assert.equal(qaVerdictShaMatches(t, FULL_HEAD), true);
    assert.equal(qaVerdictShaMatches(t, ` ${FULL_HEAD.toUpperCase()} `), true);
    assert.equal(qaVerdictShaMatches(t, "f".repeat(40)), false);
    assert.equal(qaVerdictShaMatches(t, "   "), false);
  });

  test("an unknown verdict literal renders FAIL (fail toward loud), still parseable", () => {
    const line = renderQaVerdictTrailer({
      verdict: " BOGUS " as unknown as FinalVerdict, pr: 3, round: 1, sha: FULL_HEAD, blockers: 1, maxSeverity: "low",
    });
    assert.equal(parseQaVerdictTrailer(line)?.verdict, "FAIL");
    const padded = renderQaVerdictTrailer({
      verdict: " PASS-pending-CI " as FinalVerdict, pr: 3, round: 1, sha: FULL_HEAD, blockers: 0, maxSeverity: "none",
    });
    assert.equal(parseQaVerdictTrailer(padded)?.verdict, "PASS-pending-CI");
  });

  test("QA-Verdict-Error: render → parse round-trips; unknown verdict/pr parse as null, never vanish", () => {
    for (const verdict of ALL_VERDICTS) {
      const line = renderQaVerdictErrorLine({ verdict, pr: 17, reason: "render\nfailed  twice" });
      assert.equal(line, `QA-Verdict-Error: verdict=${verdict} pr=17 reason=render failed twice`);
      assert.deepEqual(parseQaVerdictErrors(`body\n\n${line}\n`), [{ verdict, pr: 17, reason: "render failed twice" }]);
      assert.equal(parseQaVerdictTrailer(line), null, "an error line is never a trailer");
    }
    assert.deepEqual(
      parseQaVerdictErrors("QA-Verdict-Error: verdict=unknown pr=unknown reason=x"),
      [{ verdict: null, pr: null, reason: "x" }],
    );
    assert.deepEqual(parseQaVerdictErrors("see `QA-Verdict-Error: verdict=FAIL pr=1` mid-line"), []);
    assert.deepEqual(parseQaVerdictErrors(null), []);
  });
});

describe("QA-Verdict grammar has exactly one owner (issue #5078 INV-1)", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  function walk(dir: string, out: string[]): void {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|mts)$/.test(name)) out.push(full);
    }
  }

  test("only src/qa/verdict-trailer.ts declares the trailer regex literal", () => {
    const files: string[] = [];
    walk(join(root, "src"), files);
    walk(join(root, "scripts"), files);
    const needle = "^QA-Verdict:[ \\t]+(";
    const owners = files.filter((f) => readFileSync(f, "utf8").includes(needle)).map((f) => relative(root, f));
    assert.deepEqual(owners, ["src/qa/verdict-trailer.ts"]);
  });

  test("src/qa/verdict-trailer.ts is pure: no scripts/ import, no fs/network/Redis", () => {
    const src = readFileSync(join(root, "src/qa/verdict-trailer.ts"), "utf8");
    const importSpecs = [...src.matchAll(/^(?:import|export)\b[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    assert.deepEqual(importSpecs.filter((s) => /scripts\/|redis|^(node:)?(fs|child_process|http|https|net)$/.test(s)), []);
  });

  test("qaVerdictShaMatches: sha=unknown and a blank head never match", () => {
    assert.equal(qaVerdictShaMatches({ sha: "unknown" }, FULL_HEAD), false);
    assert.equal(qaVerdictShaMatches({ sha: FULL_HEAD.slice(0, 12) }, ""), false);
    assert.equal(qaVerdictShaMatches({ sha: FULL_HEAD.slice(0, 12) }, FULL_HEAD), true);
  });
});
