/**
 * Regression tests for scripts/glm-beachhead-report.sh (issue #3690,
 * ADR-0032 Decision 6).
 *
 * Two layers, mirroring the conventions already established for the sibling
 * GLM scripts:
 *
 *  1. Pure-function unit tests — spawn `bash -c "source <script>; <call>"`
 *     (the script guards `main` behind a `BASH_SOURCE == $0` check, exactly
 *     like scripts/glm/drainer-loop.sh, so sourcing it never runs main) and
 *     assert on stdout for the date-math / classification / averaging /
 *     recommendation helpers directly — no gh/curl/network involved.
 *
 *  2. End-to-end integration tests — inject a fake `gh` on PATH (Python
 *     helper, mirrors test/autopilot-recover-stale.test.mts) that serves
 *     canned `pr list` / `pr view --json comments` responses, and a fixture
 *     HTTP server for `GET /api/usage/eligibility` (mirrors
 *     test/glm-drainer-loop.test.mts's `pausedServer`), then assert on the
 *     script's one-line stdout report and the baseline.json it bootstraps.
 *
 * The hard invariant under test throughout: the script is READ-ONLY except
 * for creating its own baseline file once — it never labels anything, never
 * calls decide.py, never disables the drainer. There is nothing here that
 * could "auto-flip" keep/kill/expand; the recommendation is text only.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "glm-beachhead-report.sh");

// ---------------------------------------------------------------------------
// Layer 1 — pure helpers
// ---------------------------------------------------------------------------

/** Source the script (main never runs) and evaluate a bash expression. */
function callHelper(expr: string): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("bash", ["-c", `source ${JSON.stringify(SCRIPT)} >/dev/null 2>&1 || true; ${expr}`], {
    encoding: "utf8",
  });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

describe("glm-beachhead-report.sh — pure helpers", () => {
  test("avg: mean of several numbers", () => {
    const r = callHelper("avg 1 2 3");
    assert.equal(r.stdout.trim(), "2.00");
  });

  test("avg: empty input -> empty string", () => {
    const r = callHelper('echo "[$(avg)]"');
    assert.equal(r.stdout.trim(), "[]");
  });

  test("ratio: a/b to 2dp", () => {
    const r = callHelper("ratio 210 180");
    assert.equal(r.stdout.trim(), "1.17");
  });

  test("ratio: zero denominator -> empty string (never divide by zero)", () => {
    const r = callHelper('echo "[$(ratio 10 0)]"');
    assert.equal(r.stdout.trim(), "[]");
  });

  test("ratio: empty inputs -> empty string", () => {
    const r = callHelper('echo "[$(ratio "" 5)]"');
    assert.equal(r.stdout.trim(), "[]");
  });

  test("classify_qa_verdict: PASS-pending-CI counts as pass", () => {
    const r = callHelper("classify_qa_verdict 'blah **Verdict:** `PASS-pending-CI` blah'");
    assert.equal(r.stdout.trim(), "pass");
  });

  test("classify_qa_verdict: PASS counts as pass", () => {
    const r = callHelper("classify_qa_verdict 'blah **Verdict:** `PASS` blah'");
    assert.equal(r.stdout.trim(), "pass");
  });

  test("classify_qa_verdict: FAIL-pending-CI counts as fail (a FAIL-bounce)", () => {
    const r = callHelper("classify_qa_verdict 'blah **Verdict:** `FAIL-pending-CI` blah'");
    assert.equal(r.stdout.trim(), "fail");
  });

  test("classify_qa_verdict: FAIL counts as fail", () => {
    const r = callHelper("classify_qa_verdict 'blah **Verdict:** `FAIL` blah'");
    assert.equal(r.stdout.trim(), "fail");
  });

  test("classify_qa_verdict: no Verdict line -> unknown", () => {
    const r = callHelper("classify_qa_verdict 'no verdict anywhere in this comment'");
    assert.equal(r.stdout.trim(), "unknown");
  });

  test("classify_qa_verdict: a LATER PASS after an earlier FAIL does not matter here — this function classifies ONE comment body only", () => {
    // The "first-pass" semantics (later PASS doesn't retroactively count) live
    // in first_pass_pass_rate's use of sort_by(.createdAt) + .[0] — this
    // helper just classifies whichever single body it's given.
    const r = callHelper("classify_qa_verdict 'blah **Verdict:** `FAIL` blah'");
    assert.equal(r.stdout.trim(), "fail");
  });

  test("elapsed_days: whole days between two epochs", () => {
    const r = callHelper("elapsed_days 1000000 1864000"); // 864000s = 10 days
    assert.equal(r.stdout.trim(), "10");
  });

  test("elapsed_days: empty inputs -> 0 (never crash the report over a bad anchor)", () => {
    const r = callHelper('elapsed_days "" ""');
    assert.equal(r.stdout.trim(), "0");
  });

  // --- window position + quota-relief rate helpers (issue #4049) ---
  // percentLast7d is a position WITHIN the weekly window (it doubles as
  // percentSinceReset in src/cost/eligibility-usage.ts), so quota relief is
  // compared as a window-relative %/day rate -- never a raw subtraction of
  // two differently-phased readings. Named "relief rate", deliberately NOT
  // the term CONTEXT.md's Pacing Curve entry reserves for another concept.

  test("days_into_window: fractional days between anchor and reading, 2dp", () => {
    const r = callHelper("days_into_window 1205632 1000000"); // 205632s = 2.38d
    assert.equal(r.stdout.trim(), "2.38");
  });

  test("days_into_window: missing epoch -> empty string", () => {
    const r = callHelper('echo "[$(days_into_window 1205632 "")]"');
    assert.equal(r.stdout.trim(), "[]");
  });

  test("days_into_window: zero/negative span (anchor at or after the reading) -> empty string", () => {
    assert.equal(callHelper('echo "[$(days_into_window 1000000 1000000)]"').stdout.trim(), "[]");
    assert.equal(callHelper('echo "[$(days_into_window 1000000 1205632)]"').stdout.trim(), "[]");
  });

  test("relief_rate: percent / days-into-window to 2dp", () => {
    assert.equal(callHelper("relief_rate 64 2.38").stdout.trim(), "26.89");
    assert.equal(callHelper("relief_rate 16 1.07").stdout.trim(), "14.95");
  });

  test("relief_rate: empty or zero days -> empty string (never divide by zero)", () => {
    assert.equal(callHelper('echo "[$(relief_rate 64 "")]"').stdout.trim(), "[]");
    assert.equal(callHelper('echo "[$(relief_rate 64 0)]"').stdout.trim(), "[]");
  });

  test("relief_change: signed whole-percent change of current vs baseline rate", () => {
    assert.equal(callHelper("relief_change 14.95 26.89").stdout.trim(), "-44");
    assert.equal(callHelper("relief_change 30 20").stdout.trim(), "+50");
  });

  test("relief_change: zero baseline rate -> empty string", () => {
    assert.equal(callHelper('echo "[$(relief_change 10 0)]"').stdout.trim(), "[]");
  });

  test("quota_relief_line: #4049 scenario -- baseline 64% @2.38d in one window vs current 16% @1.07d in the next -> honest -44% rate change, NOT the spurious raw -48", () => {
    // baseline: anchor 1000000, reading 1205632 (2.38d into its window).
    // current:  anchor 1604800 (one window later), reading 1697248 (1.07d in).
    // A raw subtraction of the two percents prints -48 and reads as "quota
    // nearly eliminated"; normalised to %/day the honest change is -44%.
    const r = callHelper("quota_relief_line 16 1697248 1604800 64 1205632 1000000 0.25");
    assert.equal(r.stdout.trim(), "14.95 vs 26.89 %/day (-44%)");
    assert.doesNotMatch(r.stdout, /-48/);
  });

  test("quota_relief_line: same underlying rate at different window phases -> ~0% change (raw subtraction would print +80 and invert the sign)", () => {
    // baseline 20% @1.00d into its window (rate 20%/day); current 100% @5.00d
    // (rate 20%/day). Same pace, wildly different window positions.
    const r = callHelper("quota_relief_line 100 3432000 3000000 20 2086400 2000000 0.25");
    assert.equal(r.stdout.trim(), "20.00 vs 20.00 %/day (+0%)");
  });

  test("quota_relief_line: legacy baseline.json (no weeklyResetAnchor captured) -> explicit not-comparable, never a misleading delta", () => {
    const r = callHelper('quota_relief_line 16 1697248 1604800 64 1205632 "" 0.25');
    assert.match(r.stdout, /^not comparable/);
    assert.match(r.stdout, /legacy baseline\.json predates weeklyResetAnchor capture/);
  });

  test("quota_relief_line: live response missing weeklyResetAnchor -> explicit not-comparable for the CURRENT reading", () => {
    const r = callHelper('quota_relief_line 16 1697248 "" 64 1205632 1000000 0.25');
    assert.match(r.stdout, /^not comparable/);
    assert.match(r.stdout, /current reading has no usable window position/);
  });

  test("quota_relief_line: reading too early in its window (under the minimum) -> not comparable rather than a noisy rate", () => {
    // current 8640s (0.10d) into its window -- under the 0.25d default minimum.
    const r = callHelper("quota_relief_line 16 1613440 1604800 64 1205632 1000000 0.25");
    assert.match(r.stdout, /^not comparable/);
    assert.match(r.stdout, /only 0\.10d into its window -- under the 0\.25d minimum/);
  });

  test("quota_relief_line: the minimum is honored for BOTH readings (baseline 2.38d fails a 3d minimum)", () => {
    const r = callHelper("quota_relief_line 16 1697248 1604800 64 1205632 1000000 3");
    assert.match(r.stdout, /^not comparable/);
    assert.match(r.stdout, /under the 3d minimum/);
  });

  test("quota_relief_line: baseline percent never captured (null) -> not comparable", () => {
    const r = callHelper("quota_relief_line 16 1697248 1604800 null 1205632 1000000 0.25");
    assert.match(r.stdout, /^not comparable/);
    assert.match(r.stdout, /baseline percentLast7d was never captured/);
  });

  test("quota_relief_line: current percent unavailable -> not comparable", () => {
    const r = callHelper('quota_relief_line "" 1697248 1604800 64 1205632 1000000 0.25');
    assert.match(r.stdout, /^not comparable/);
    assert.match(r.stdout, /current percentLast7d unavailable/);
  });

  test("recommend: zero PRs -> insufficient-data", () => {
    const r = callHelper("recommend 0 '' '' 0 14 25");
    assert.match(r.stdout, /^insufficient-data/);
  });

  test("recommend: PASS-rate below 0.5 -> KILL-signal regardless of window completion", () => {
    const r = callHelper("recommend 5 0.30 1.0 3 14 25");
    assert.match(r.stdout, /^KILL-signal/);
  });

  test("recommend: window in progress, healthy metrics -> KEEP, no action yet", () => {
    const r = callHelper("recommend 10 0.9 1.0 5 14 25");
    assert.match(r.stdout, /^KEEP/);
    assert.match(r.stdout, /window in progress/);
  });

  test("recommend: window complete via days, PASS-rate high, churn within bound -> EXPAND-signal", () => {
    const r = callHelper("recommend 10 0.9 1.1 14 14 25");
    assert.match(r.stdout, /^EXPAND-signal/);
  });

  test("recommend: window complete via PR count, PASS-rate high, churn within bound -> EXPAND-signal", () => {
    const r = callHelper("recommend 25 0.9 1.1 5 14 25");
    assert.match(r.stdout, /^EXPAND-signal/);
  });

  test("recommend: window complete but churn too high -> KEEP (mixed signal), not EXPAND", () => {
    const r = callHelper("recommend 25 0.9 1.8 14 14 25");
    assert.match(r.stdout, /^KEEP/);
    assert.match(r.stdout, /mixed signal/);
  });

  test("recommend: window complete but PASS-rate mediocre (0.5-0.8) -> KEEP (mixed signal)", () => {
    const r = callHelper("recommend 25 0.6 1.0 14 14 25");
    assert.match(r.stdout, /^KEEP/);
    assert.match(r.stdout, /mixed signal/);
  });

  test("recommend: no churn baseline sample (empty ratio) doesn't block EXPAND on its own", () => {
    const r = callHelper("recommend 25 0.9 '' 14 14 25");
    assert.match(r.stdout, /^EXPAND-signal/);
  });

  // --- recommend() + the corrected quota-relief figure (issue #4049) ---
  // The figure rides along as DESCRIPTIVE text appended to the judgment
  // branches; every branch THRESHOLD is pinned unchanged (design-concept
  // invariant: the figure never gates keep/kill/expand).

  test("recommend: the corrected quota-relief figure rides along as descriptive text (KEEP branch)", () => {
    const r = callHelper("recommend 10 0.9 1.0 5 14 25 '14.95 vs 26.89 %/day (-44%)'");
    assert.match(r.stdout, /^KEEP/);
    assert.match(r.stdout, /quota-relief: 14\.95 vs 26\.89 %\/day \(-44%\)/);
  });

  test("recommend: relief figure never gates -- a bad PASS-rate still KILL-signals with the figure appended", () => {
    const r = callHelper("recommend 5 0.30 1.0 3 14 25 '14.95 vs 26.89 %/day (-44%)'");
    assert.match(r.stdout, /^KILL-signal/);
    assert.match(r.stdout, /quota-relief: 14\.95 vs 26\.89 %\/day \(-44%\)/);
  });

  test("recommend: EXPAND branch also carries the relief figure as description only (a not-comparable figure doesn't block EXPAND)", () => {
    const r = callHelper("recommend 10 0.9 1.1 14 14 25 'not comparable (baseline reading has no usable window position)'");
    assert.match(r.stdout, /^EXPAND-signal/);
    assert.match(r.stdout, /quota-relief: not comparable/);
  });

  test("recommend: six-arg call (no relief descriptor) still works -- the suffix is purely additive", () => {
    const r = callHelper("recommend 10 0.9 1.0 5 14 25");
    assert.match(r.stdout, /^KEEP/);
    assert.doesNotMatch(r.stdout, /quota-relief/);
  });

  test("recommend text is advisory prose, never a directive the caller could execute", () => {
    // Regression pin for the hard invariant: the string is always prefixed
    // with a status token + "(informational, operator-driven)" (or
    // insufficient-data), never a bare imperative like "disable" or "flip".
    const r = callHelper("recommend 25 0.9 1.1 14 14 25");
    assert.doesNotMatch(r.stdout, /disable|flip|--label|gh issue edit|decide\.py/);
    assert.match(r.stdout, /informational, operator-driven/);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — end-to-end with a fake `gh` + fixture usage-eligibility server
// ---------------------------------------------------------------------------

interface FakePr {
  number: number;
  createdAt: string;
  additions: number;
  deletions: number;
  // Matches gh's real --json labels shape ([{name, id, ...}]), NOT a plain
  // string array — the script's jq filter reads `.labels | map(.name)`.
  labels: Array<{ name: string }>;
}

interface FakeComment {
  createdAt: string;
  body: string;
}

/**
 * Write a fake `gh` onto PATH serving the exact three read-only shapes this
 * script issues (all RAW --json, filtered by our own jq afterward — see the
 * script header's "never gh's own --jq" note, which is precisely what makes
 * this stub tractable):
 *   gh pr list --repo R --state merged --json additions,deletions,labels --limit 100
 *   gh pr list --repo R --label glm-authored --state all --json number,createdAt,additions,deletions --limit 100
 *   gh pr view N --repo R --json comments
 */
function makeGhStub(
  dir: string,
  opts: { mergedBaselinePrs: FakePr[]; glmAuthoredPrs: FakePr[]; commentsByPr: Record<number, FakeComment[]> },
): string {
  const binDir = join(dir, "bin");
  const fixtureFile = join(dir, "fixture.json");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(fixtureFile, JSON.stringify(opts));

  const helper = `#!/usr/bin/env python3
import json
import sys

FIXTURE_FILE = ${JSON.stringify(fixtureFile)}


def load():
    with open(FIXTURE_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def find_flag(argv, name):
    for i, tok in enumerate(argv):
        if tok == name and i + 1 < len(argv):
            return argv[i + 1]
    return None


def main():
    argv = sys.argv[1:]
    fx = load()
    if argv[:2] == ["pr", "list"]:
        state = find_flag(argv, "--state")
        label = find_flag(argv, "--label")
        if state == "merged":
            rows = fx["mergedBaselinePrs"]
        elif label == "glm-authored":
            rows = fx["glmAuthoredPrs"]
        else:
            rows = []
        sys.stdout.write(json.dumps(rows))
        return
    if argv[:2] == ["pr", "view"]:
        number = int(argv[2])
        comments = fx["commentsByPr"].get(str(number), [])
        sys.stdout.write(json.dumps({"comments": comments}))
        return
    sys.stderr.write("gh-stub: unsupported invocation: " + " ".join(argv) + "\\n")
    sys.exit(99)


if __name__ == "__main__":
    main()
`;
  const helperPath = join(dir, "gh-stub.py");
  writeFileSync(helperPath, helper);
  chmodSync(helperPath, 0o755);

  const stubScript = `#!/usr/bin/env bash
exec python3 ${JSON.stringify(helperPath)} "$@"
`;
  const ghPath = join(binDir, "gh");
  writeFileSync(ghPath, stubScript);
  chmodSync(ghPath, 0o755);
  return binDir;
}

/** Serve `{usage: {percentLast7d: N, weeklyResetAnchor?: ISO}}` on an ephemeral port. */
function usageServer(
  percentLast7d: number,
  weeklyResetAnchor?: string,
): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      const usage: Record<string, unknown> = { percentLast7d };
      if (weeklyResetAnchor !== undefined) {
        usage.weeklyResetAnchor = weeklyResetAnchor;
      }
      res.end(JSON.stringify({ usage }));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as any;
      resolve({ url: `http://127.0.0.1:${addr.port}/api/usage/eligibility`, close: () => server.close() });
    });
  });
}

function runReport(env: Record<string, string>): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [SCRIPT], { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ status: code ?? -1, stdout, stderr }));
  });
}

const AUTOMATED_QA_PREFIX = "> *Automated QA";

describe("glm-beachhead-report.sh — end-to-end (issue #3690)", () => {
  test("no glm-authored PRs yet -> insufficient-data, baseline still bootstrapped (now including the weekly reset anchor)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-beachhead-"));
    const usage = await usageServer(55, "2026-08-05T17:00:00Z");
    const nowEpoch = Math.floor(Date.parse("2026-08-08T00:00:00Z") / 1000);
    try {
      const binDir = makeGhStub(tmp, {
        mergedBaselinePrs: [
          { number: 1, createdAt: "2026-07-01T00:00:00Z", additions: 100, deletions: 50, labels: [] },
        ],
        glmAuthoredPrs: [],
        commentsByPr: {},
      });
      const baselineFile = join(tmp, "baseline.json");
      const r = await runReport({
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        HYDRA_GLM_BEACHHEAD_USAGE_URL: usage.url,
        HYDRA_GLM_BEACHHEAD_BASELINE_FILE: baselineFile,
        HYDRA_GLM_BEACHHEAD_NOW_EPOCH: String(nowEpoch),
      });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /insufficient-data/);
      assert.match(r.stdout, /window 0\/14d, 0\/25 PRs/);
      // Days-into-window is printed for the reading (#4049): 2026-08-08T00:00
      // minus the 2026-08-05T17:00 anchor is 2.29d.
      assert.match(r.stdout, /percentLast7d 55% @2\.29d-in-window/);
      const baseline = JSON.parse(readFileSync(baselineFile, "utf8"));
      assert.equal(baseline.percentLast7dBaseline, 55);
      assert.equal(baseline.weeklyResetAnchorBaseline, "2026-08-05T17:00:00Z");
      assert.equal(baseline.churnBaseline, 150);
    } finally {
      usage.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("baseline is bootstrapped ONCE and never silently overwritten on a second run", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-beachhead-"));
    const usageFirst = await usageServer(40, "2026-08-05T17:00:00Z");
    const now1 = String(Math.floor(Date.parse("2026-08-08T00:00:00Z") / 1000));
    try {
      const binDir = makeGhStub(tmp, { mergedBaselinePrs: [], glmAuthoredPrs: [], commentsByPr: {} });
      const baselineFile = join(tmp, "baseline.json");
      const r1 = await runReport({
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        HYDRA_GLM_BEACHHEAD_USAGE_URL: usageFirst.url,
        HYDRA_GLM_BEACHHEAD_BASELINE_FILE: baselineFile,
        HYDRA_GLM_BEACHHEAD_NOW_EPOCH: now1,
      });
      assert.equal(r1.status, 0);
      const baselineAfterFirst = readFileSync(baselineFile, "utf8");
      assert.match(baselineAfterFirst, /"percentLast7dBaseline": 40/);
      assert.match(baselineAfterFirst, /"weeklyResetAnchorBaseline": "2026-08-05T17:00:00Z"/);

      // Second run: usage value, window anchor, AND "now" have all moved on —
      // if the baseline were silently overwritten, this run would show the new
      // values. It must not.
      const usageSecond = await usageServer(90, "2026-08-12T17:00:00Z");
      const now2 = String(Math.floor(Date.parse("2026-08-12T17:00:00Z") / 1000) + 92448); // 1.07d into the new window
      try {
        const r2 = await runReport({
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          HYDRA_GLM_BEACHHEAD_USAGE_URL: usageSecond.url,
          HYDRA_GLM_BEACHHEAD_BASELINE_FILE: baselineFile,
          HYDRA_GLM_BEACHHEAD_NOW_EPOCH: now2,
        });
        assert.equal(r2.status, 0);
        const baselineAfterSecond = readFileSync(baselineFile, "utf8");
        assert.equal(baselineAfterFirst, baselineAfterSecond);
        // The CURRENT percent + window position in the report reflect the new
        // live values (90, 1.07d into the new window), while the baseline stays
        // frozen at 40 @2.29d -- proving the comparison is live-vs-frozen, not
        // live-vs-live.
        assert.match(r2.stdout, /percentLast7d 90% @1\.07d-in-window \(baseline 40% @2\.29d-in-window\)/);
      } finally {
        usageSecond.close();
      }
    } finally {
      usageFirst.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("first-pass PASS-rate: FIRST verdict wins even when a later comment on the same PR passed", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-beachhead-"));
    const usage = await usageServer(50);
    try {
      const binDir = makeGhStub(tmp, {
        mergedBaselinePrs: [],
        glmAuthoredPrs: [
          { number: 100, createdAt: "2026-07-27T00:00:00Z", additions: 10, deletions: 5, labels: [{ name: "glm-authored" }] },
        ],
        commentsByPr: {
          "100": [
            { createdAt: "2026-07-27T01:00:00Z", body: `${AUTOMATED_QA_PREFIX}*\n\n**Verdict:** \`FAIL\` — first pass failed.` },
            { createdAt: "2026-07-28T01:00:00Z", body: `${AUTOMATED_QA_PREFIX}*\n\n**Verdict:** \`PASS\` — re-review passed.` },
          ],
        },
      });
      const r = await runReport({
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        HYDRA_GLM_BEACHHEAD_USAGE_URL: usage.url,
        HYDRA_GLM_BEACHHEAD_BASELINE_FILE: join(tmp, "baseline.json"),
      });
      assert.equal(r.status, 0);
      // 0 pass, 1 fail -> rate 0.00, matching the FIRST comment (FAIL), not
      // the later PASS.
      assert.match(r.stdout, /PASS-rate 0\.00 \(0 pass, 1 fail, 0 excluded no-verdict, of 1 total\)/);
    } finally {
      usage.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a PR with no QA-verdict comment yet is excluded from the denominator, not counted as a fail", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-beachhead-"));
    const usage = await usageServer(50);
    try {
      const binDir = makeGhStub(tmp, {
        mergedBaselinePrs: [],
        glmAuthoredPrs: [
          { number: 200, createdAt: "2026-07-27T00:00:00Z", additions: 10, deletions: 5, labels: [{ name: "glm-authored" }] },
          { number: 201, createdAt: "2026-07-27T00:00:00Z", additions: 20, deletions: 10, labels: [{ name: "glm-authored" }] },
        ],
        commentsByPr: {
          "200": [{ createdAt: "2026-07-27T01:00:00Z", body: `${AUTOMATED_QA_PREFIX}*\n\n**Verdict:** \`PASS\`` }],
          "201": [{ createdAt: "2026-07-27T01:00:00Z", body: "unrelated comment, not a QA verdict" }],
        },
      });
      const r = await runReport({
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        HYDRA_GLM_BEACHHEAD_USAGE_URL: usage.url,
        HYDRA_GLM_BEACHHEAD_BASELINE_FILE: join(tmp, "baseline.json"),
      });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /PASS-rate 1\.00 \(1 pass, 0 fail, 1 excluded no-verdict, of 2 total\)/);
    } finally {
      usage.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("churn ratio compares glm-authored mean additions+deletions against the bootstrapped non-glm baseline sample", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-beachhead-"));
    const usage = await usageServer(50);
    try {
      const binDir = makeGhStub(tmp, {
        // Baseline sample average: (100+100)/2 = 100.
        mergedBaselinePrs: [
          { number: 1, createdAt: "2026-06-01T00:00:00Z", additions: 60, deletions: 40, labels: [] },
          { number: 2, createdAt: "2026-06-02T00:00:00Z", additions: 60, deletions: 40, labels: [] },
          // A merged PR that ALSO carries glm-authored must be excluded from
          // the non-glm baseline sample.
          { number: 3, createdAt: "2026-06-03T00:00:00Z", additions: 900, deletions: 900, labels: [{ name: "glm-authored" }] },
        ],
        // glm-authored sample average: (150+50)/2 = 100 -> ratio 1.00.
        glmAuthoredPrs: [
          { number: 300, createdAt: "2026-07-27T00:00:00Z", additions: 100, deletions: 50, labels: [{ name: "glm-authored" }] },
          { number: 301, createdAt: "2026-07-27T00:00:00Z", additions: 30, deletions: 20, labels: [{ name: "glm-authored" }] },
        ],
        commentsByPr: {},
      });
      const r = await runReport({
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        HYDRA_GLM_BEACHHEAD_USAGE_URL: usage.url,
        HYDRA_GLM_BEACHHEAD_BASELINE_FILE: join(tmp, "baseline.json"),
      });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /churn avg 100\.00 vs baseline 100\.00 \(ratio 1\.00\)/);
    } finally {
      usage.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("window clock anchors to the EARLIEST glm-authored PR's createdAt, not the baseline bootstrap moment", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-beachhead-"));
    const usage = await usageServer(50);
    const nowEpoch = Math.floor(new Date("2026-08-08T00:00:00Z").getTime() / 1000);
    try {
      const binDir = makeGhStub(tmp, {
        mergedBaselinePrs: [],
        glmAuthoredPrs: [
          // Earliest: 2026-07-27 (out of createdAt order on purpose, proving
          // the script sorts rather than trusting list order).
          { number: 400, createdAt: "2026-07-30T00:00:00Z", additions: 5, deletions: 5, labels: [{ name: "glm-authored" }] },
          { number: 401, createdAt: "2026-07-27T00:00:00Z", additions: 5, deletions: 5, labels: [{ name: "glm-authored" }] },
        ],
        commentsByPr: {},
      });
      const r = await runReport({
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        HYDRA_GLM_BEACHHEAD_USAGE_URL: usage.url,
        HYDRA_GLM_BEACHHEAD_BASELINE_FILE: join(tmp, "baseline.json"),
        HYDRA_GLM_BEACHHEAD_NOW_EPOCH: String(nowEpoch),
      });
      assert.equal(r.status, 0);
      // 2026-07-27 -> 2026-08-08 is 12 days, not 0 (which is what a
      // bootstrap-moment anchor would have produced, since the baseline file
      // is created in this same invocation).
      assert.match(r.stdout, /window 12\/14d, 2\/25 PRs/);
    } finally {
      usage.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("#4049 regression: baseline 64% late in one window vs current 16% early in the next -> honest -44% rate change, days-into-window for BOTH, no raw delta", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-beachhead-"));
    const ANCHOR_A = "2026-08-05T17:00:00Z";
    const ANCHOR_B = "2026-08-12T17:00:00Z";
    // The issue's measured instance, reconstructed: baseline captured 2.38d
    // into its window, current read 1.07d into the NEXT window. The old raw
    // subtraction printed delta -48 and read as "quota nearly eliminated";
    // normalised to %/day the honest change is -44%.
    const now1 = Math.floor(Date.parse(ANCHOR_A) / 1000) + 205632; // 2.38d into window A
    const now2 = Math.floor(Date.parse(ANCHOR_B) / 1000) + 92448; // 1.07d into window B
    const usage1 = await usageServer(64, ANCHOR_A);
    const usage2 = await usageServer(16, ANCHOR_B);
    try {
      const binDir = makeGhStub(tmp, {
        mergedBaselinePrs: [],
        glmAuthoredPrs: [
          { number: 500, createdAt: "2026-08-13T00:00:00Z", additions: 10, deletions: 5, labels: [{ name: "glm-authored" }] },
        ],
        commentsByPr: {
          "500": [{ createdAt: "2026-08-13T01:00:00Z", body: `${AUTOMATED_QA_PREFIX}*\n\n**Verdict:** \`PASS\`` }],
        },
      });
      const baselineFile = join(tmp, "baseline.json");
      // Run 1 bootstraps the baseline from window A.
      const r1 = await runReport({
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        HYDRA_GLM_BEACHHEAD_USAGE_URL: usage1.url,
        HYDRA_GLM_BEACHHEAD_BASELINE_FILE: baselineFile,
        HYDRA_GLM_BEACHHEAD_NOW_EPOCH: String(now1),
      });
      assert.equal(r1.status, 0);
      const baseline = JSON.parse(readFileSync(baselineFile, "utf8"));
      assert.equal(baseline.percentLast7dBaseline, 64);
      assert.equal(baseline.weeklyResetAnchorBaseline, ANCHOR_A);

      // Run 2 reads window B early-phase current against that baseline.
      const r2 = await runReport({
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        HYDRA_GLM_BEACHHEAD_USAGE_URL: usage2.url,
        HYDRA_GLM_BEACHHEAD_BASELINE_FILE: baselineFile,
        HYDRA_GLM_BEACHHEAD_NOW_EPOCH: String(now2),
      });
      assert.equal(r2.status, 0);
      // The window phase is VISIBLE for both readings instead of hidden.
      assert.match(r2.stdout, /percentLast7d 16% @1\.07d-in-window \(baseline 64% @2\.38d-in-window\)/);
      // The corrected, window-relative figure — and no raw subtraction delta.
      assert.match(r2.stdout, /quota-relief 14\.95 vs 26\.89 %\/day \(-44%\)/);
      assert.doesNotMatch(r2.stdout, /delta/);
      // The recommendation string consumes the corrected figure.
      assert.match(r2.stdout, /recommendation: KEEP \(informational, operator-driven\)[^\n]*quota-relief: 14\.95 vs 26\.89 %\/day \(-44%\)/);
    } finally {
      usage1.close();
      usage2.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("#4049 legacy baseline.json without weeklyResetAnchorBaseline -> explicit not-comparable, never a crash, never a misleading delta", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-beachhead-"));
    const ANCHOR_B = "2026-08-12T17:00:00Z";
    const now2 = Math.floor(Date.parse(ANCHOR_B) / 1000) + 92448; // 1.07d into window B
    const usage = await usageServer(16, ANCHOR_B);
    try {
      const binDir = makeGhStub(tmp, {
        mergedBaselinePrs: [],
        glmAuthoredPrs: [
          { number: 501, createdAt: "2026-08-13T00:00:00Z", additions: 10, deletions: 5, labels: [{ name: "glm-authored" }] },
        ],
        commentsByPr: {},
      });
      const baselineFile = join(tmp, "baseline.json");
      // A LEGACY baseline bootstrapped before this fix: percentLast7d is
      // present but the weekly reset anchor was never captured, so the two
      // readings cannot be placed on a comparable footing.
      writeFileSync(baselineFile, JSON.stringify({
        day0: "2026-08-08T02:07:12Z",
        percentLast7dBaseline: 64,
        churnBaseline: 100,
        churnSampleSize: 2,
      }));
      const r = await runReport({
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        HYDRA_GLM_BEACHHEAD_USAGE_URL: usage.url,
        HYDRA_GLM_BEACHHEAD_BASELINE_FILE: baselineFile,
        HYDRA_GLM_BEACHHEAD_NOW_EPOCH: String(now2),
      });
      assert.equal(r.status, 0); // graceful — never a crash, never an awk blowup
      assert.match(r.stdout, /percentLast7d 16% @1\.07d-in-window \(baseline 64% @n\/ad-in-window\)/);
      assert.match(
        r.stdout,
        /quota-relief not comparable \(baseline reading has no usable window position -- legacy baseline\.json predates weeklyResetAnchor capture; delete the baseline file to re-bootstrap\)/,
      );
      // The recommendation still carries the honest not-comparable verdict.
      assert.match(r.stdout, /quota-relief: not comparable/);
      // And the legacy file is left untouched (bootstrap never overwrites).
      const after = JSON.parse(readFileSync(baselineFile, "utf8"));
      assert.equal(after.weeklyResetAnchorBaseline, undefined);
      assert.equal(after.percentLast7dBaseline, 64);
    } finally {
      usage.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("missing gh/jq/curl fails loud but exits 0 (never blocks hydra-review over a tooling gap)", () => {
    // Source the script (loads require_tools + friends as bash functions,
    // using whatever PATH the test runner has), THEN restrict PATH to an
    // empty dir before invoking require_tools -- this isolates "the checked
    // tools are unreachable" from "bash/coreutils used to source/run the
    // script are unreachable" (a full-PATH-replacement spawn would break the
    // latter too, since `bash` itself must resolve on PATH for node's spawn
    // to find it).
    const r = callHelper('PATH=/nonexistent-empty-dir require_tools; echo "exit=$?"');
    assert.match(r.stderr, /ERROR required tool/);
    assert.match(r.stdout, /exit=1/);
  });
});
