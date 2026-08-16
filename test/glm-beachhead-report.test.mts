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

  // --- issue #4049: window-phase helpers ----------------------------------
  // percentLast7d is a position within a window that resets weekly, not a
  // trailing average, so a quota-relief comparison needs each reading's
  // days-into-window (from the same usage response's weeklyResetAnchor).

  test("days_into_window: fractional days between anchor and now, 2dp", () => {
    const r = callHelper("days_into_window 1000000 1205632"); // 205632s = 2.38d
    assert.equal(r.stdout.trim(), "2.38");
  });

  test("days_into_window: empty anchor or now -> empty string (never a bogus 0)", () => {
    const r = callHelper('echo "[$(days_into_window "" 1205632)][$(days_into_window 1000000 "")]"');
    assert.equal(r.stdout.trim(), "[][]");
  });

  test("days_into_window: now at/before the anchor -> empty string (a reading before its own window start is not comparable)", () => {
    const r = callHelper('echo "[$(days_into_window 1000000 1000000)][$(days_into_window 1000100 1000000)]"');
    assert.equal(r.stdout.trim(), "[][]");
  });

  test("rate_per_day: percent divided by days-into-window, 2dp", () => {
    const r = callHelper("rate_per_day 64 2.38");
    assert.equal(r.stdout.trim(), "26.89");
  });

  test("rate_per_day: zero, empty, or null inputs -> empty string (never divide by zero)", () => {
    const r = callHelper('echo "[$(rate_per_day 10 0)][$(rate_per_day 10 "")][$(rate_per_day null 2.38)]"');
    assert.equal(r.stdout.trim(), "[][][]");
  });

  test("fmt_days: 2dp days -> '<n>d'; empty -> n/a", () => {
    const r = callHelper('echo "$(fmt_days 2.38)/$(fmt_days "")"');
    assert.equal(r.stdout.trim(), "2.38d/n/a");
  });

  test("relief_description: issue #4049's worked instance -- 64% @ 2.38d baseline vs 16% @ 1.07d now -> %/day comparison, never a raw subtraction", () => {
    const r = callHelper(
      'relief_description "2026-08-05T18:00:00Z" 2.38 "2026-08-12T17:00:00Z" 1.07 64 16 0.1',
    );
    assert.equal(r.stdout.trim(), "rate 14.95%/day vs baseline 26.89%/day (-44%)");
  });

  test("relief_description: legacy baseline.json with no anchor -> explicit not-comparable naming the operator's reset lever", () => {
    const r = callHelper('relief_description "" 2.38 "2026-08-12T17:00:00Z" 1.07 64 16 0.1');
    assert.match(r.stdout, /^not comparable \(baseline predates window-tracking/);
    assert.match(r.stdout, /delete the baseline file/);
  });

  test("relief_description: no anchor on the live usage response -> explicit not-comparable", () => {
    const r = callHelper('relief_description "2026-08-05T18:00:00Z" 2.38 "" 1.07 64 16 0.1');
    assert.match(r.stdout, /^not comparable \(no weeklyResetAnchor/);
  });

  test("relief_description: days-into-window present but unusable (snapshot at/before its anchor) -> not comparable", () => {
    const r = callHelper('relief_description "2026-08-05T18:00:00Z" "" "2026-08-12T17:00:00Z" 1.07 64 16 0.1');
    assert.match(r.stdout, /^not comparable \(baseline snapshot sits at or before/);
  });

  test("relief_description: missing percent reading -> not comparable, never arithmetic on null", () => {
    const r = callHelper('relief_description "2026-08-05T18:00:00Z" 2.38 "2026-08-12T17:00:00Z" 1.07 null 16 0.1');
    assert.match(r.stdout, /^not comparable \(missing percentLast7d reading\)/);
  });

  test("relief_description: current reading too soon into its window -> not comparable, never a noise spike", () => {
    const r = callHelper('relief_description "2026-08-05T18:00:00Z" 2.38 "2026-08-12T17:00:00Z" 0.05 64 16 0.1');
    assert.match(r.stdout, /^not comparable \(insufficient time into window now: 0\.05d\)/);
  });

  test("relief_description: baseline reading too soon into ITS window -> names the baseline side", () => {
    const r = callHelper('relief_description "2026-08-05T18:00:00Z" 0.05 "2026-08-12T17:00:00Z" 1.07 64 16 0.1');
    assert.match(r.stdout, /^not comparable \(insufficient time into window at baseline: 0\.05d\)/);
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

  // --- issue #4049: the corrected relief figure rides along as descriptive
  // text ONLY -- the branch thresholds above are unchanged.

  test("recommend: 7th arg (relief description) is appended as trailing text, branch text unchanged", () => {
    const r = callHelper('recommend 10 0.9 1.0 5 14 25 "rate 14.95%/day vs baseline 26.89%/day (-44%)"');
    assert.match(r.stdout, /^KEEP/);
    assert.match(r.stdout, /window in progress/);
    assert.match(r.stdout, /; quota-relief: rate 14\.95%\/day vs baseline 26\.89%\/day \(-44%\)\s*$/);
  });

  test("recommend: empty relief arg -> no quota-relief tail (existing 6-arg callers stay byte-identical)", () => {
    const r = callHelper('recommend 10 0.9 1.0 5 14 25 ""');
    assert.match(r.stdout, /^KEEP/);
    assert.doesNotMatch(r.stdout, /quota-relief/);
  });

  test("recommend: a not-comparable relief state still reaches the recommendation string verbatim", () => {
    const r = callHelper(
      'recommend 10 0.9 1.0 5 14 25 "not comparable (baseline predates window-tracking -- delete the baseline file to re-bootstrap)"',
    );
    assert.match(r.stdout, /quota-relief: not comparable \(baseline predates window-tracking/);
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

/**
 * Serve `{usage: {percentLast7d: N, weeklyResetAnchor?: ISO}}` on an ephemeral
 * port. The anchor is optional: omitting it reproduces a pre-#4049 fixture
 * (or a live response that somehow lacks the field), which the script must
 * treat as a not-comparable window position, never a crash.
 */
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
  test("no glm-authored PRs yet -> insufficient-data, baseline still bootstrapped", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-beachhead-"));
    const usage = await usageServer(55);
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
      });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /insufficient-data/);
      assert.match(r.stdout, /window 0\/14d, 0\/25 PRs/);
      const baseline = JSON.parse(readFileSync(baselineFile, "utf8"));
      assert.equal(baseline.percentLast7dBaseline, 55);
      assert.equal(baseline.churnBaseline, 150);
    } finally {
      usage.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("baseline is bootstrapped ONCE and never silently overwritten on a second run", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-beachhead-"));
    const usageFirst = await usageServer(40);
    try {
      const binDir = makeGhStub(tmp, { mergedBaselinePrs: [], glmAuthoredPrs: [], commentsByPr: {} });
      const baselineFile = join(tmp, "baseline.json");
      const r1 = await runReport({
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        HYDRA_GLM_BEACHHEAD_USAGE_URL: usageFirst.url,
        HYDRA_GLM_BEACHHEAD_BASELINE_FILE: baselineFile,
      });
      assert.equal(r1.status, 0);
      const baselineAfterFirst = readFileSync(baselineFile, "utf8");
      assert.match(baselineAfterFirst, /"percentLast7dBaseline": 40/);

      // Second run: usage value has changed AND the fixture's usage server is
      // now different — if the baseline were silently overwritten, this run
      // would show a different baseline percent. It must not.
      const usageSecond = await usageServer(90);
      try {
        const r2 = await runReport({
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          HYDRA_GLM_BEACHHEAD_USAGE_URL: usageSecond.url,
          HYDRA_GLM_BEACHHEAD_BASELINE_FILE: baselineFile,
        });
        assert.equal(r2.status, 0);
        const baselineAfterSecond = readFileSync(baselineFile, "utf8");
        assert.equal(baselineAfterFirst, baselineAfterSecond);
        // The CURRENT percent in the report reflects the new live value (90),
        // while the baseline stays 40 -- proving the delta is live-vs-frozen,
        // not live-vs-live.
        assert.match(r2.stdout, /percentLast7d 90% \(baseline 40%/);
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

  test("quota-relief is phase-normalised: baseline late in one window vs current early in the next (issue #4049's measured instance)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-beachhead-"));
    // Window A anchors 2026-08-05T18:00:00Z: baseline sampled 2.38 days in
    // (205632s), reading 64%. Window B anchors 2026-08-12T17:00:00Z: current
    // reading 1.07 days in (92448s), 16%. The pre-#4049 script printed a raw
    // subtraction of the two percents; the fix must normalise each reading by
    // its own days-into-window instead.
    const anchorA = Math.floor(new Date("2026-08-05T18:00:00Z").getTime() / 1000);
    const anchorB = Math.floor(new Date("2026-08-12T17:00:00Z").getTime() / 1000);
    const usageA = await usageServer(64, "2026-08-05T18:00:00Z");
    const baselineFile = join(tmp, "baseline.json");
    try {
      const binDir = makeGhStub(tmp, {
        mergedBaselinePrs: [],
        glmAuthoredPrs: [
          { number: 500, createdAt: "2026-08-05T00:00:00Z", additions: 10, deletions: 5, labels: [{ name: "glm-authored" }] },
        ],
        commentsByPr: {
          "500": [{ createdAt: "2026-08-05T01:00:00Z", body: `${AUTOMATED_QA_PREFIX}*\n\n**Verdict:** \`PASS\`` }],
        },
      });
      // Run 1 bootstraps the baseline 2.38 days into window A.
      const r1 = await runReport({
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        HYDRA_GLM_BEACHHEAD_USAGE_URL: usageA.url,
        HYDRA_GLM_BEACHHEAD_BASELINE_FILE: baselineFile,
        HYDRA_GLM_BEACHHEAD_NOW_EPOCH: String(anchorA + 205632),
      });
      assert.equal(r1.status, 0);
      const baseline = JSON.parse(readFileSync(baselineFile, "utf8"));
      assert.equal(baseline.percentLast7dBaseline, 64);
      assert.equal(baseline.weeklyResetAnchorBaseline, "2026-08-05T18:00:00Z");

      // Run 2: a DIFFERENT window (new anchor), current reading only 1.07
      // days in -- the phase mismatch that made the raw subtraction lie.
      const usageB = await usageServer(16, "2026-08-12T17:00:00Z");
      try {
        const r2 = await runReport({
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          HYDRA_GLM_BEACHHEAD_USAGE_URL: usageB.url,
          HYDRA_GLM_BEACHHEAD_BASELINE_FILE: baselineFile,
          HYDRA_GLM_BEACHHEAD_NOW_EPOCH: String(anchorB + 92448),
        });
        assert.equal(r2.status, 0);
        // Days-into-window is printed for BOTH readings -- the phase
        // mismatch is visible, not hidden.
        assert.match(r2.stdout, /days-into-window current 1\.07d \/ baseline 2\.38d/);
        // The relief figure is the %/day comparison (14.95 = 16/1.07,
        // 26.89 = 64/2.38, -44%), roughly half the magnitude the raw -48
        // subtraction implied -- never the raw subtraction itself.
        assert.match(r2.stdout, /relief rate 14\.95%\/day vs baseline 26\.89%\/day \(-44%\)/);
        assert.doesNotMatch(r2.stdout, /delta/);
        // The recommendation string consumes the corrected figure.
        assert.match(r2.stdout, /quota-relief: rate 14\.95%\/day/);
      } finally {
        usageB.close();
      }
    } finally {
      usageA.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("legacy baseline.json without weeklyResetAnchorBaseline degrades to an explicit not-comparable, never a crash (issue #4049)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-beachhead-"));
    // The issue's measured current reading: 2026-08-13T18:43:23Z is 1.07
    // days after the 2026-08-12T17:00:00Z anchor.
    const nowEpoch = Math.floor(new Date("2026-08-13T18:43:23Z").getTime() / 1000);
    const usage = await usageServer(16, "2026-08-12T17:00:00Z");
    try {
      const binDir = makeGhStub(tmp, {
        mergedBaselinePrs: [],
        glmAuthoredPrs: [
          { number: 600, createdAt: "2026-08-05T00:00:00Z", additions: 10, deletions: 5, labels: [{ name: "glm-authored" }] },
        ],
        commentsByPr: {
          "600": [{ createdAt: "2026-08-05T01:00:00Z", body: `${AUTOMATED_QA_PREFIX}*\n\n**Verdict:** \`PASS\`` }],
        },
      });
      // A baseline bootstrapped by a pre-#4049 run: no anchor field, so the
      // baseline's window position can never be reconstructed.
      const baselineFile = join(tmp, "baseline.json");
      writeFileSync(baselineFile, JSON.stringify({
        day0: "2026-08-08T02:02:46Z",
        percentLast7dBaseline: 64,
        churnBaseline: 100,
        churnSampleSize: 2,
      }));
      const r = await runReport({
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        HYDRA_GLM_BEACHHEAD_USAGE_URL: usage.url,
        HYDRA_GLM_BEACHHEAD_BASELINE_FILE: baselineFile,
        HYDRA_GLM_BEACHHEAD_NOW_EPOCH: String(nowEpoch),
      });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /relief not comparable \(baseline predates window-tracking/);
      assert.match(r.stdout, /days-into-window current 1\.07d \/ baseline n\/a/);
      // The rest of the report still prints (graceful degradation).
      assert.match(r.stdout, /percentLast7d 16% \(baseline 64%/);
      // And the legacy file is NOT silently migrated.
      const after = JSON.parse(readFileSync(baselineFile, "utf8"));
      assert.equal(after.weeklyResetAnchorBaseline, undefined);
    } finally {
      usage.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a current reading taken minutes into a fresh window -> explicit insufficient-time not-comparable, never a noise spike (issue #4049)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-beachhead-"));
    const anchorD = Math.floor(new Date("2026-08-05T18:00:00Z").getTime() / 1000);
    const anchorE = Math.floor(new Date("2026-08-12T17:00:00Z").getTime() / 1000);
    const usageD = await usageServer(64, "2026-08-05T18:00:00Z");
    const baselineFile = join(tmp, "baseline.json");
    try {
      const binDir = makeGhStub(tmp, {
        mergedBaselinePrs: [],
        glmAuthoredPrs: [
          { number: 700, createdAt: "2026-08-05T00:00:00Z", additions: 10, deletions: 5, labels: [{ name: "glm-authored" }] },
        ],
        commentsByPr: {},
      });
      const r1 = await runReport({
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        HYDRA_GLM_BEACHHEAD_USAGE_URL: usageD.url,
        HYDRA_GLM_BEACHHEAD_BASELINE_FILE: baselineFile,
        HYDRA_GLM_BEACHHEAD_NOW_EPOCH: String(anchorD + 205632), // 2.38d into window D
      });
      assert.equal(r1.status, 0);
      // Current reading 0.05 days (4320s) into a fresh window: dividing by
      // it would manufacture a spike out of nothing.
      const usageE = await usageServer(30, "2026-08-12T17:00:00Z");
      try {
        const r2 = await runReport({
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          HYDRA_GLM_BEACHHEAD_USAGE_URL: usageE.url,
          HYDRA_GLM_BEACHHEAD_BASELINE_FILE: baselineFile,
          HYDRA_GLM_BEACHHEAD_NOW_EPOCH: String(anchorE + 4320), // 0.05d into window E
        });
        assert.equal(r2.status, 0);
        assert.match(r2.stdout, /days-into-window current 0\.05d \/ baseline 2\.38d/);
        assert.match(r2.stdout, /relief not comparable \(insufficient time into window now: 0\.05d\)/);
        assert.doesNotMatch(r2.stdout, /delta/);
      } finally {
        usageE.close();
      }
    } finally {
      usageD.close();
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
