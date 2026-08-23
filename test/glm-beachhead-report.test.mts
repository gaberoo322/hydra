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
  // Head branch name, served for the branch-scan / merged-baseline fetches
  // (issue #4048). Optional as in the pre-#4048 fixtures — gh only returns
  // requested fields, and the script's jq guards with `// ""`.
  headRefName?: string;
}

interface FakeComment {
  createdAt: string;
  body: string;
}

/**
 * Write a fake `gh` onto PATH serving the exact read-only shapes this
 * script issues (all RAW --json, filtered by our own jq afterward — see the
 * script header's "never gh's own --jq" note, which is precisely what makes
 * this stub tractable):
 *   gh pr list --repo R --state merged --json additions,deletions,labels,headRefName --limit 100
 *   gh pr list --repo R --label glm-authored --state all --json number,createdAt,additions,deletions,labels,headRefName --limit 100
 *   gh pr list --repo R --state all --json number,createdAt,additions,deletions,labels,headRefName --limit 500   (branch scan, issue #4048)
 *   gh pr view N --repo R --json comments
 */
function makeGhStub(
  dir: string,
  opts: {
    mergedBaselinePrs: FakePr[];
    glmAuthoredPrs: FakePr[];
    /** Served to the label-less `--state all` branch scan (issue #4048). */
    allPrsForBranchScan?: FakePr[];
    commentsByPr: Record<number, FakeComment[]>;
  },
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
        elif state == "all":
            rows = fx.get("allPrsForBranchScan", [])
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
 * port. The anchor is the live eligibility response's weekly-window start
 * (`.usage.weeklyResetAnchor`) — omitted when not passed, mirroring an
 * orchestrator too old (or a fetch too broken) to expose it (issue #4049).
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

/** Unix seconds for an ISO instant (feeds HYDRA_GLM_BEACHHEAD_NOW_EPOCH). */
function epochOf(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

/** ISO instant exactly `days` before `iso` (a weeklyResetAnchor fixture). */
function isoMinusDays(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() - days * 86_400_000).toISOString();
}

/** Hand-write a baseline.json exactly as a prior run left it. */
function seedBaselineFile(file: string, fields: Record<string, unknown>): void {
  writeFileSync(file, JSON.stringify({ churnSampleSize: 2, ...fields }, null, 2));
}

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
        // while the baseline stays 40 -- proving the comparison is
        // live-vs-frozen, not live-vs-live. Neither fixture server serves a
        // weeklyResetAnchor, so both window positions print n/a and the relief
        // figure is explicitly "not comparable" (issue #4049) rather than a
        // raw subtraction.
        assert.match(r2.stdout, /percentLast7d 90% @ n\/a into window \(baseline 40% @ n\/a into window; relief: not comparable/);
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

// ---------------------------------------------------------------------------
// Label-OR-branch provenance (issue #4048)
//
// `gh pr create` and its separate `--label glm-authored` mutation are not
// atomic (drainer-loop.sh's #3900 investigation note), so 29 of 62 real
// drainer PRs sat on their worktree-agent-glm-* branch with the label
// missing — and this report's label-only query judged the lane on 53% of
// its output. The fix counts a PR as drainer output when it carries the
// label OR its head branch carries the drainer's exact literal
// `worktree-agent-glm-` prefix (label stays PRIMARY per ADR-0032 Decision 5;
// the prefix is a perfect discriminator because Opus harness branches are
// `worktree-agent-<hex-hash>-...` and a hex hash cannot contain g or l).
// ---------------------------------------------------------------------------

describe("glm-beachhead-report.sh — label-OR-branch provenance (issue #4048)", () => {
  test("a PR on a worktree-agent-glm-* branch with NO label is counted as drainer output, side by side with the label count, deduped, and without false positives", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-beachhead-4048-"));
    const usage = await usageServer(50);
    try {
      const labeled = {
        number: 500,
        createdAt: "2026-07-27T00:00:00Z",
        additions: 10,
        deletions: 5,
        labels: [{ name: "glm-authored" }],
        headRefName: "worktree-agent-glm-3990-1111",
      };
      // THE regression: label lost to the non-atomic `--label` mutation —
      // only the branch prefix says "drainer".
      const unlabeled = {
        number: 501,
        createdAt: "2026-07-28T00:00:00Z",
        additions: 20,
        deletions: 10,
        labels: [],
        headRefName: "worktree-agent-glm-3991-2222",
      };
      // Opus dev_orch harness PR — hex-hash branch, must NOT match.
      const opusHexHash = {
        number: 502,
        createdAt: "2026-07-29T00:00:00Z",
        additions: 40,
        deletions: 30,
        labels: [],
        headRefName: "worktree-agent-a802a6552d648d1c8-3333",
      };
      // Prefix-EXACTness: starts like the drainer prefix but diverges before
      // the trailing dash — must NOT match a loose "contains glm" test.
      const glmLookalike = {
        number: 503,
        createdAt: "2026-07-29T00:00:00Z",
        additions: 40,
        deletions: 30,
        labels: [],
        headRefName: "worktree-agent-glmtree-not-the-drainer",
      };
      const binDir = makeGhStub(tmp, {
        mergedBaselinePrs: [],
        glmAuthoredPrs: [labeled],
        // The branch scan sees every recent PR, including the labelled one —
        // the union must dedupe it back to a single row.
        allPrsForBranchScan: [labeled, unlabeled, opusHexHash, glmLookalike],
        commentsByPr: {},
      });
      const r = await runReport({
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        HYDRA_GLM_BEACHHEAD_USAGE_URL: usage.url,
        HYDRA_GLM_BEACHHEAD_BASELINE_FILE: join(tmp, "baseline.json"),
      });
      assert.equal(r.status, 0);
      // 2 drainer PRs of 4 scanned: the union counts the unlabelled one, the
      // labelled one is not double-counted, and neither Opus PR counts. The
      // side-by-side provenance counts (label 1 / branch 2) make the gap
      // visible instead of silent.
      assert.match(
        r.stdout,
        /, 2\/25 PRs \(glm-authored label 1 \/ worktree-agent-glm-\* branch 2\)/,
      );
      assert.doesNotMatch(r.stdout, /of 3 total|of 4 total/);
    } finally {
      usage.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("the churn baseline sample excludes an UNLABELLED worktree-agent-glm-* merged PR — same OR-predicate, negated", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-beachhead-4048-"));
    const usage = await usageServer(50);
    try {
      const binDir = makeGhStub(tmp, {
        mergedBaselinePrs: [
          // Opus PR, counts toward the baseline: 60+40 = 100.
          { number: 1, createdAt: "2026-06-01T00:00:00Z", additions: 60, deletions: 40, labels: [], headRefName: "issue-1234-some-slug" },
          // Opus harness PR on a hex-hash branch, counts: 60+40 = 100.
          { number: 2, createdAt: "2026-06-02T00:00:00Z", additions: 60, deletions: 40, labels: [], headRefName: "worktree-agent-ab12cd34ef567890-1" },
          // Drainer PR with the label LOST — must be excluded exactly like a
          // labelled one, else its 1800-line diff pollutes the Opus baseline.
          { number: 3, createdAt: "2026-06-03T00:00:00Z", additions: 900, deletions: 900, labels: [], headRefName: "worktree-agent-glm-3992-777" },
        ],
        // Drainer sample: (100+50)/2 and (20+30)/2 -> churn avg (150+50)/2 = 100.
        glmAuthoredPrs: [
          { number: 600, createdAt: "2026-07-27T00:00:00Z", additions: 100, deletions: 50, labels: [{ name: "glm-authored" }], headRefName: "worktree-agent-glm-3993-888" },
          { number: 601, createdAt: "2026-07-27T00:00:00Z", additions: 20, deletions: 30, labels: [{ name: "glm-authored" }], headRefName: "worktree-agent-glm-3994-999" },
        ],
        allPrsForBranchScan: [],
        commentsByPr: {},
      });
      const r = await runReport({
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        HYDRA_GLM_BEACHHEAD_USAGE_URL: usage.url,
        HYDRA_GLM_BEACHHEAD_BASELINE_FILE: join(tmp, "baseline.json"),
      });
      assert.equal(r.status, 0);
      // Baseline = mean(100, 100) = 100 — the 1800-line unlabelled drainer PR
      // is excluded by the branch side of the predicate. If it leaked into
      // the Opus baseline, it would be mean(100, 100, 1800) = 666.67 and the
      // ratio would collapse to ~0.15.
      assert.match(r.stdout, /churn avg 100\.00 vs baseline 100\.00 \(ratio 1\.00\)/);
    } finally {
      usage.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Window-phase-corrected quota relief (issue #4049)
//
// percentLast7d is NOT a trailing average — src/cost/eligibility-usage.ts
// assigns percentSinceReset = percentLast7d, so it is a POSITION within a
// window that resets weekly. A raw subtraction of two readings taken at
// different phases of their respective windows measures sampling phase as
// much as quota relief: the operator-review instance (baseline 64% ~2.38
// days into its window vs current 16% ~1.07 days into the next) printed
// "delta -49" when the honest normalised comparison is ~-44% daily use, and
// a day-1-vs-day-6 sampling pair inverts the sign for identical underlying
// use. The fix: normalise each reading to a window-relative daily-use rate
// (%/day = percent / days-into-window, with BOTH positions printed), refuse
// to emit a figure when either position is missing or under the minimum, and
// let the recommendation string carry the corrected figure as descriptive
// text only.
// ---------------------------------------------------------------------------

describe("glm-beachhead-report.sh — relief-figure pure helpers (issue #4049)", () => {
  test("days_into_window: fractional days between anchor and reading, 2dp", () => {
    // 216000s = 2.5 days.
    const r = callHelper("days_into_window 1216000 1000000");
    assert.equal(r.stdout.trim(), "2.50");
  });

  test("days_into_window: reading exactly at the anchor -> 0.00", () => {
    const r = callHelper("days_into_window 1000000 1000000");
    assert.equal(r.stdout.trim(), "0.00");
  });

  test("days_into_window: reading BEFORE the anchor -> empty (clock skew never fabricates a phase)", () => {
    const r = callHelper('echo "[$(days_into_window 999999 1000000)]"');
    assert.equal(r.stdout.trim(), "[]");
  });

  test("days_into_window: empty or non-numeric epochs -> empty", () => {
    const r = callHelper('echo "[$(days_into_window "" 1000000)][$(days_into_window 1000000 "")][$(days_into_window not-a-number 1000000)]"');
    assert.equal(r.stdout.trim(), "[][][]");
  });

  test("relief_rate: percent divided by days-into-window, 1dp", () => {
    const base = callHelper("relief_rate 64 2.38");
    assert.equal(base.stdout.trim(), "26.9");
    const cur = callHelper("relief_rate 16 1.07");
    assert.equal(cur.stdout.trim(), "15.0");
  });

  test("relief_rate: empty / zero-day / negative-day / non-numeric inputs -> empty (never a fabricated figure)", () => {
    const r = callHelper('printf \'[%s][%s][%s][%s][%s]\' "$(relief_rate 10 \'\')" "$(relief_rate \'\' 3)" "$(relief_rate 10 0)" "$(relief_rate 10 -2)" "$(relief_rate abc 3)"');
    assert.equal(r.stdout.trim(), "[][][][][]");
  });

  test("relief_figure: the measured 2026-08-13 instance — normalised %/day figure, not the raw -48 subtraction", () => {
    // Baseline 64% @ 2.38d (26.9 %/day) vs current 16% @ 1.07d (15.0 %/day)
    // -> -44% daily use. The raw subtraction would claim -48.
    const r = callHelper("relief_figure 64 2.38 16 1.07 0.5");
    assert.equal(r.stdout.trim(), "rate 26.9 -> 15.0 %/day (-44% daily use)");
  });

  test("relief_figure: identical daily-use rates sampled at opposite window phases -> ~0% change (a raw subtraction would swing +80)", () => {
    // 16% one day into a window vs 96% 6.4 days into a window are the SAME
    // 15 %/day underlying use — the phase confound a raw subtraction turns
    // into a fabricated "+80 worse" signal.
    const r = callHelper("relief_figure 16 1.07 96 6.40 0.5");
    assert.equal(r.stdout.trim(), "rate 15.0 -> 15.0 %/day (+0% daily use)");
  });

  test("relief_figure: legacy baseline.json without an anchor -> explicitly not comparable", () => {
    const r = callHelper('relief_figure 64 "" 16 1.07 0.5');
    assert.equal(r.stdout.trim(), "not comparable (baseline days-into-window unknown)");
  });

  test("relief_figure: null baseline percent snapshot -> explicitly not comparable", () => {
    // jq -r prints JSON null as the literal string "null".
    const r = callHelper("relief_figure null 2.38 16 1.07 0.5");
    assert.equal(r.stdout.trim(), "not comparable (no baseline percentLast7d snapshot)");
  });

  test("relief_figure: live percent unavailable -> explicitly not comparable", () => {
    const r = callHelper('relief_figure 64 2.38 "" 1.07 0.5');
    assert.equal(r.stdout.trim(), "not comparable (live percentLast7d unavailable)");
  });

  test("relief_figure: current window position unknown -> explicitly not comparable", () => {
    const r = callHelper('relief_figure 64 2.38 16 "" 0.5');
    assert.equal(r.stdout.trim(), "not comparable (current days-into-window unknown)");
  });

  test("relief_figure: current reading too early in its window -> not comparable, with the threshold visible", () => {
    const r = callHelper("relief_figure 64 2.38 16 0.25 0.5");
    assert.equal(r.stdout.trim(), "not comparable (current only 0.25d into its window; need >= 0.5d)");
  });

  test("relief_figure: baseline reading too early in its window -> not comparable", () => {
    const r = callHelper("relief_figure 64 0.10 16 1.07 0.5");
    assert.equal(r.stdout.trim(), "not comparable (baseline only 0.10d into its window; need >= 0.5d)");
  });

  test("relief_figure: a reading exactly AT the minimum is comparable (guard is >=, not >)", () => {
    // 64/0.5 = 128.0 %/day vs 32/1.0 = 32.0 %/day -> -75%.
    const r = callHelper("relief_figure 64 0.5 32 1.0 0.5");
    assert.equal(r.stdout.trim(), "rate 128.0 -> 32.0 %/day (-75% daily use)");
  });
});

describe("glm-beachhead-report.sh — window-phase-corrected relief figure (issue #4049)", () => {
  // The operator-review instance, verbatim: baseline 64% taken
  // 2026-08-08T02:02:46Z into a window anchored 2026-08-05T17:00:00Z
  // (~2.38 days in); current 16% taken 2026-08-13T18:43:23Z into a window
  // anchored 2026-08-12T17:00:00Z (~1.07 days in).
  const NOW_MEASURED = "2026-08-13T18:43:23Z";

  test("late-window baseline vs early-window current prints normalised %/day relief, both window positions, and no raw delta", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-beachhead-4049-"));
    const usage = await usageServer(16, "2026-08-12T17:00:00Z");
    try {
      const baselineFile = join(tmp, "baseline.json");
      seedBaselineFile(baselineFile, {
        day0: "2026-08-08T02:02:46Z",
        percentLast7dBaseline: 64,
        weeklyResetAnchorBaseline: "2026-08-05T17:00:00Z",
        churnBaseline: 100.0,
      });
      const binDir = makeGhStub(tmp, {
        mergedBaselinePrs: [],
        glmAuthoredPrs: [
          // Post-#4122 the PR createdAt must postdate the baseline capture
          // (2026-08-08T02:02:46Z) or the provenance guard correctly reports
          // the baseline as GLM-era-contaminated and no figure is printed.
          { number: 700, createdAt: "2026-08-10T00:00:00Z", additions: 60, deletions: 40, labels: [{ name: "glm-authored" }], headRefName: "worktree-agent-glm-4049-1" },
        ],
        commentsByPr: {},
      });
      const r = await runReport({
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        HYDRA_GLM_BEACHHEAD_USAGE_URL: usage.url,
        HYDRA_GLM_BEACHHEAD_BASELINE_FILE: baselineFile,
        HYDRA_GLM_BEACHHEAD_NOW_EPOCH: String(epochOf(NOW_MEASURED)),
      });
      assert.equal(r.status, 0);
      // Both readings carry their days-into-window (the phase is VISIBLE),
      // and the figure is the %/day comparison — 26.9 -> 15.0 (-44%) — not
      // the phase-confounded raw subtraction (-48).
      assert.match(
        r.stdout,
        /percentLast7d 16% @ 1\.07d into window \(baseline 64% @ 2\.38d into window; relief: rate 26\.9 -> 15\.0 %\/day \(-44% daily use\)\)/,
      );
      // The recommendation string consumes the corrected figure.
      assert.match(
        r.stdout,
        /no action needed yet; quota relief: rate 26\.9 -> 15\.0 %\/day \(-44% daily use\)/,
      );
      // A raw subtraction figure is gone from the line entirely.
      assert.doesNotMatch(r.stdout, /delta/);
    } finally {
      usage.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("regression: a day-1 baseline against a day-6 current with IDENTICAL daily use does NOT produce a large spurious relief delta", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-beachhead-4049-"));
    // Same 15 %/day underlying use on both sides: 16% @ 1.07d baseline,
    // 96% @ 6.40d current. A raw subtraction would print +80 ("use way up");
    // the normalised figure correctly reports no change.
    const usage = await usageServer(96, isoMinusDays(NOW_MEASURED, 6.4));
    try {
      const baselineFile = join(tmp, "baseline.json");
      seedBaselineFile(baselineFile, {
        day0: "2026-08-08T02:02:46Z",
        percentLast7dBaseline: 16,
        weeklyResetAnchorBaseline: isoMinusDays("2026-08-08T02:02:46Z", 1.07),
        churnBaseline: 100.0,
      });
      const binDir = makeGhStub(tmp, {
        mergedBaselinePrs: [],
        glmAuthoredPrs: [
          { number: 710, createdAt: "2026-08-10T00:00:00Z", additions: 60, deletions: 40, labels: [{ name: "glm-authored" }], headRefName: "worktree-agent-glm-4049-2" },
        ],
        commentsByPr: {},
      });
      const r = await runReport({
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        HYDRA_GLM_BEACHHEAD_USAGE_URL: usage.url,
        HYDRA_GLM_BEACHHEAD_BASELINE_FILE: baselineFile,
        HYDRA_GLM_BEACHHEAD_NOW_EPOCH: String(epochOf(NOW_MEASURED)),
      });
      assert.equal(r.status, 0);
      assert.match(
        r.stdout,
        /relief: rate 15\.0 -> 15\.0 %\/day \(\+0% daily use\)/,
      );
      assert.doesNotMatch(r.stdout, /delta/);
    } finally {
      usage.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a legacy baseline.json without weeklyResetAnchorBaseline degrades to an explicit not-comparable, never a crash", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-beachhead-4049-"));
    const usage = await usageServer(16, "2026-08-12T17:00:00Z");
    try {
      const baselineFile = join(tmp, "baseline.json");
      // Exactly the pre-#4049 bootstrap shape: no anchor field.
      seedBaselineFile(baselineFile, {
        day0: "2026-08-08T02:02:46Z",
        percentLast7dBaseline: 64,
        churnBaseline: 100.0,
      });
      const binDir = makeGhStub(tmp, {
        mergedBaselinePrs: [],
        glmAuthoredPrs: [
          { number: 720, createdAt: "2026-08-10T00:00:00Z", additions: 60, deletions: 40, labels: [{ name: "glm-authored" }], headRefName: "worktree-agent-glm-4049-3" },
        ],
        commentsByPr: {},
      });
      const r = await runReport({
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        HYDRA_GLM_BEACHHEAD_USAGE_URL: usage.url,
        HYDRA_GLM_BEACHHEAD_BASELINE_FILE: baselineFile,
        HYDRA_GLM_BEACHHEAD_NOW_EPOCH: String(epochOf(NOW_MEASURED)),
      });
      assert.equal(r.status, 0);
      // The CURRENT reading still prints its window position (visible), the
      // baseline side says n/a, and the report states not-comparable instead
      // of emitting a misleading figure — the recommendation too.
      assert.match(
        r.stdout,
        /percentLast7d 16% @ 1\.07d into window \(baseline 64% @ n\/a into window; relief: not comparable \(baseline days-into-window unknown\)\)/,
      );
      assert.match(r.stdout, /quota relief: not comparable \(baseline days-into-window unknown\)/);
    } finally {
      usage.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a current reading under the minimum days-into-window is explicitly not comparable even when the baseline is fine", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-beachhead-4049-"));
    const usage = await usageServer(16, isoMinusDays(NOW_MEASURED, 0.25));
    try {
      const baselineFile = join(tmp, "baseline.json");
      seedBaselineFile(baselineFile, {
        day0: "2026-08-08T02:02:46Z",
        percentLast7dBaseline: 64,
        weeklyResetAnchorBaseline: "2026-08-05T17:00:00Z",
        churnBaseline: 100.0,
      });
      const binDir = makeGhStub(tmp, {
        mergedBaselinePrs: [],
        glmAuthoredPrs: [
          { number: 730, createdAt: "2026-08-10T00:00:00Z", additions: 60, deletions: 40, labels: [{ name: "glm-authored" }], headRefName: "worktree-agent-glm-4049-4" },
        ],
        commentsByPr: {},
      });
      const r = await runReport({
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        HYDRA_GLM_BEACHHEAD_USAGE_URL: usage.url,
        HYDRA_GLM_BEACHHEAD_BASELINE_FILE: baselineFile,
        HYDRA_GLM_BEACHHEAD_NOW_EPOCH: String(epochOf(NOW_MEASURED)),
      });
      assert.equal(r.status, 0);
      assert.match(
        r.stdout,
        /relief: not comparable \(current only 0\.25d into its window; need >= 0\.5d\)/,
      );
      assert.doesNotMatch(r.stdout, /relief: rate /);
    } finally {
      usage.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("bootstrap captures weeklyResetAnchorBaseline alongside the percent, so the baseline reading's window phase is frozen too", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-beachhead-4049-"));
    const usage = await usageServer(55, "2026-08-05T17:00:00Z");
    try {
      const binDir = makeGhStub(tmp, {
        mergedBaselinePrs: [
          { number: 1, createdAt: "2026-06-01T00:00:00Z", additions: 60, deletions: 40, labels: [] },
        ],
        glmAuthoredPrs: [],
        commentsByPr: {},
      });
      const baselineFile = join(tmp, "baseline.json");
      const r = await runReport({
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        HYDRA_GLM_BEACHHEAD_USAGE_URL: usage.url,
        HYDRA_GLM_BEACHHEAD_BASELINE_FILE: baselineFile,
        HYDRA_GLM_BEACHHEAD_NOW_EPOCH: String(epochOf("2026-08-08T02:02:46Z")),
      });
      assert.equal(r.status, 0);
      // The bootstrap records the anchor of the window the baseline percent
      // was read in; the baseline position (2.38d) matches the reading's own
      // snapshot, not a later window's.
      const baseline = JSON.parse(readFileSync(baselineFile, "utf8"));
      assert.equal(baseline.percentLast7dBaseline, 55);
      assert.equal(baseline.weeklyResetAnchorBaseline, "2026-08-05T17:00:00Z");
      // issue #4122: the bootstrap also records the snapshot's capture moment
      // as an explicit capturedAt (equal to day0 at bootstrap time) so
      // provenance never has to lean on day0, a field documented as a
      // fallback WINDOW anchor.
      assert.equal(baseline.capturedAt, "2026-08-08T02:02:46Z");
      assert.equal(baseline.day0, baseline.capturedAt);
      // First run: baseline and current are the same reading -> 23.1 %/day on
      // both sides, +0% change.
      assert.match(
        r.stdout,
        /percentLast7d 55% @ 2\.38d into window \(baseline 55% @ 2\.38d into window; relief: rate 23\.1 -> 23\.1 %\/day \(\+0% daily use\)\)/,
      );
      assert.match(r.stdout, /nothing to judge\); quota relief: rate 23\.1 -> 23\.1 %\/day/);
    } finally {
      usage.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Baseline provenance guard (issue #4122)
//
// percentLast7d relief asks "did routing dev work to the GLM drainer relieve
// Anthropic quota?" — the comparison is only meaningful when the BASELINE
// side predates the GLM era. The live baseline.json was re-bootstrapped
// 2026-08-17, 21 days after the GLM window's day-0 (earliest glm-authored
// PR #3762, 2026-07-27), so both sides of the comparison are GLM-era: any
// figure computed from it measures week-to-week variance, not GLM's effect.
// Window position expires on its own; contamination never does — so the
// provenance guard runs BEFORE every window-position guard, and a
// contaminated baseline can never surface a window-position reason (which
// would imply the figure turns valid once the window matures). The
// operator's 2026-08-17 ruling stands: keep the file, "not comparable" is
// the honest output until relief is measured prospectively (epic #4123).
// ---------------------------------------------------------------------------

describe("glm-beachhead-report.sh — baseline provenance guard (issue #4122)", () => {
  // The live state this issue was filed against, verbatim: baseline captured
  // 2026-08-17T16:55:57Z; GLM window day-0 (earliest glm-authored PR) at
  // 2026-07-27T00:00:00Z -> the capture sits 21.71 days into the GLM era.
  const CAPTURED = String(epochOf("2026-08-17T16:55:57Z"));
  const GLM_DAY0 = String(epochOf("2026-07-27T00:00:00Z"));
  const PRE_GLM_CAPTURED = String(epochOf("2026-07-20T00:00:00Z"));

  test("relief_figure: a GLM-era-captured baseline is not comparable even when BOTH window positions are mature", () => {
    // 68% @ 4.99d vs 55% @ 1.79d — both well past the 0.5d minimum, so every
    // window-position guard passes and only provenance stands between the
    // operator and a confidently wrong number (the live file was ~6h from
    // becoming one when #4122 was re-scoped).
    const r = callHelper(`relief_figure 68 4.99 55 1.79 0.5 ${CAPTURED} ${GLM_DAY0}`);
    assert.equal(
      r.stdout.trim(),
      "not comparable (baseline captured 21.71d into the GLM era — both sides are GLM-era)",
    );
  });

  test("relief_figure: the provenance guard fires BEFORE the window-position guards — a contaminated baseline never reports a window-position reason", () => {
    // Both readings are ALSO under the 0.5d minimum here; contamination must
    // win because it never expires with window advance, while these reasons
    // would imply exactly that.
    const r = callHelper(`relief_figure 68 0.10 55 0.25 0.5 ${CAPTURED} ${GLM_DAY0}`);
    assert.equal(
      r.stdout.trim(),
      "not comparable (baseline captured 21.71d into the GLM era — both sides are GLM-era)",
    );
    assert.doesNotMatch(r.stdout, /into its window/);
  });

  test("relief_figure: a capture exactly AT GLM day-0 counts as contaminated (the guard is at-or-after, not after)", () => {
    const r = callHelper(`relief_figure 68 4.99 55 1.79 0.5 ${GLM_DAY0} ${GLM_DAY0}`);
    assert.equal(
      r.stdout.trim(),
      "not comparable (baseline captured 0.00d into the GLM era — both sides are GLM-era)",
    );
  });

  test("relief_figure: a pre-GLM-captured baseline with mature window positions still yields a real figure (the guard does not blanket-disable the metric)", () => {
    const r = callHelper(`relief_figure 64 2.38 16 1.07 0.5 ${PRE_GLM_CAPTURED} ${GLM_DAY0}`);
    assert.equal(r.stdout.trim(), "rate 26.9 -> 15.0 %/day (-44% daily use)");
  });

  test("relief_figure: empty provenance inputs skip the guard — absence of evidence is not contamination", () => {
    // No capture moment knowable, or no glm-authored PRs yet to derive an era
    // day-0 from (the era has not started — a baseline captured then is
    // pre-GLM by definition): the guard must not fabricate contamination.
    const noCap = callHelper(`relief_figure 64 2.38 16 1.07 0.5 "" ${GLM_DAY0}`);
    assert.equal(noCap.stdout.trim(), "rate 26.9 -> 15.0 %/day (-44% daily use)");
    const noEra = callHelper(`relief_figure 64 2.38 16 1.07 0.5 ${CAPTURED} ""`);
    assert.equal(noEra.stdout.trim(), "rate 26.9 -> 15.0 %/day (-44% daily use)");
  });

  test("relief_figure: pre-#4122 outputs stay byte-for-byte unchanged (figure format + every existing not-comparable branch)", () => {
    // The provenance guard ADDS a branch on a NEW input dimension (the two
    // trailing epoch args); on the artifact-era 5-arg call shape every
    // pre-existing output keeps its exact bytes (design-concept INV-1).
    const cases: Array<[string, string]> = [
      ["relief_figure 64 2.38 16 1.07 0.5", "rate 26.9 -> 15.0 %/day (-44% daily use)"],
      ["relief_figure null 2.38 16 1.07 0.5", "not comparable (no baseline percentLast7d snapshot)"],
      ['relief_figure 64 2.38 "" 1.07 0.5', "not comparable (live percentLast7d unavailable)"],
      ['relief_figure 64 "" 16 1.07 0.5', "not comparable (baseline days-into-window unknown)"],
      ['relief_figure 64 2.38 16 "" 0.5', "not comparable (current days-into-window unknown)"],
      ["relief_figure 64 0.10 16 1.07 0.5", "not comparable (baseline only 0.10d into its window; need >= 0.5d)"],
      ["relief_figure 64 2.38 16 0.25 0.5", "not comparable (current only 0.25d into its window; need >= 0.5d)"],
    ];
    for (const [expr, expected] of cases) {
      assert.equal(callHelper(expr).stdout.trim(), expected, expr);
    }
  });

  test("end-to-end: the live baseline shape (captured 2026-08-17, GLM day-0 2026-07-27, both windows mature) reports GLM-era contamination, never a figure", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-beachhead-4122-"));
    // Current reading 55% @ 1.79d into its window — mature, so the only thing
    // standing between the operator and a confident wrong number is the
    // provenance guard. The seeded baseline has NO capturedAt (exactly the
    // live file), so its day0 is the fallback capture moment.
    const usage = await usageServer(55, "2026-08-17T17:00:00Z");
    try {
      const baselineFile = join(tmp, "baseline.json");
      seedBaselineFile(baselineFile, {
        day0: "2026-08-17T16:55:57Z",
        percentLast7dBaseline: 68,
        weeklyResetAnchorBaseline: "2026-08-12T17:00:00.401Z",
        churnBaseline: 422.15,
      });
      const binDir = makeGhStub(tmp, {
        mergedBaselinePrs: [],
        glmAuthoredPrs: [
          { number: 800, createdAt: "2026-07-27T00:00:00Z", additions: 200, deletions: 100, labels: [{ name: "glm-authored" }] },
        ],
        commentsByPr: {},
      });
      const r = await runReport({
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        HYDRA_GLM_BEACHHEAD_USAGE_URL: usage.url,
        HYDRA_GLM_BEACHHEAD_BASELINE_FILE: baselineFile,
        HYDRA_GLM_BEACHHEAD_NOW_EPOCH: String(epochOf("2026-08-19T12:00:00Z")),
      });
      assert.equal(r.status, 0);
      // Baseline position 5.00d, current 1.79d — both past the minimum — and
      // still not comparable, naming WHY: the capture is 21.71d into the GLM
      // era. The reason rides both the percentLast7d segment and the
      // recommendation tail.
      assert.match(
        r.stdout,
        /percentLast7d 55% @ 1\.79d into window \(baseline 68% @ 5\.00d into window; relief: not comparable \(baseline captured 21\.71d into the GLM era — both sides are GLM-era\)\)/,
      );
      assert.match(
        r.stdout,
        /quota relief: not comparable \(baseline captured 21\.71d into the GLM era — both sides are GLM-era\)/,
      );
      assert.doesNotMatch(r.stdout, /relief: rate /);
      // The baseline file is operator-owned state (2026-08-17 ruling):
      // read, never rewritten.
      const after = JSON.parse(readFileSync(baselineFile, "utf8"));
      assert.equal(after.day0, "2026-08-17T16:55:57Z");
      assert.equal(after.percentLast7dBaseline, 68);
    } finally {
      usage.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("end-to-end: an explicit capturedAt is the provenance source — a GLM-era capturedAt contaminates even when day0 predates the era", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-beachhead-4122-"));
    const usage = await usageServer(55, "2026-08-17T17:00:00Z");
    try {
      const baselineFile = join(tmp, "baseline.json");
      // day0 (the documented fallback WINDOW anchor) is pre-GLM here, while
      // capturedAt (the unambiguous capture moment) is GLM-era: provenance
      // must read capturedAt, not let the stale day0 launder the baseline.
      seedBaselineFile(baselineFile, {
        day0: "2026-07-20T00:00:00Z",
        capturedAt: "2026-08-17T16:55:57Z",
        percentLast7dBaseline: 68,
        weeklyResetAnchorBaseline: "2026-08-12T17:00:00.401Z",
        churnBaseline: 422.15,
      });
      const binDir = makeGhStub(tmp, {
        mergedBaselinePrs: [],
        glmAuthoredPrs: [
          { number: 810, createdAt: "2026-07-27T00:00:00Z", additions: 200, deletions: 100, labels: [{ name: "glm-authored" }] },
        ],
        commentsByPr: {},
      });
      const r = await runReport({
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        HYDRA_GLM_BEACHHEAD_USAGE_URL: usage.url,
        HYDRA_GLM_BEACHHEAD_BASELINE_FILE: baselineFile,
        HYDRA_GLM_BEACHHEAD_NOW_EPOCH: String(epochOf("2026-08-19T12:00:00Z")),
      });
      assert.equal(r.status, 0);
      assert.match(
        r.stdout,
        /relief: not comparable \(baseline captured 21\.71d into the GLM era — both sides are GLM-era\)/,
      );
      assert.doesNotMatch(r.stdout, /relief: rate /);
    } finally {
      usage.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("end-to-end: the pre-#4049 warning states the pre-GLM requirement and — once now is past the window day-0 — that re-bootstrapping today cannot produce an attributable baseline", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-beachhead-4122-"));
    const usage = await usageServer(16, "2026-08-12T17:00:00Z");
    try {
      const baselineFile = join(tmp, "baseline.json");
      // Legacy shape: percent present, weeklyResetAnchorBaseline absent.
      // Baseline capture 2026-08-08 predates the era day-0 (PR created
      // 2026-08-10), so the relief reason stays the LEGITIMATE legacy one.
      seedBaselineFile(baselineFile, {
        day0: "2026-08-08T02:02:46Z",
        percentLast7dBaseline: 64,
        churnBaseline: 100.0,
      });
      const binDir = makeGhStub(tmp, {
        mergedBaselinePrs: [],
        glmAuthoredPrs: [
          { number: 820, createdAt: "2026-08-10T00:00:00Z", additions: 60, deletions: 40, labels: [{ name: "glm-authored" }] },
        ],
        commentsByPr: {},
      });
      const r = await runReport({
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        HYDRA_GLM_BEACHHEAD_USAGE_URL: usage.url,
        HYDRA_GLM_BEACHHEAD_BASELINE_FILE: baselineFile,
        HYDRA_GLM_BEACHHEAD_NOW_EPOCH: String(epochOf("2026-08-13T18:43:23Z")),
      });
      assert.equal(r.status, 0);
      assert.match(r.stderr, /pre-#4049 bootstrap/);
      assert.match(r.stderr, /pre-GLM-era percentLast7d snapshot/);
      // NOW (2026-08-13) is past the window day-0 (2026-08-10), so the
      // warning carries the re-bootstrap caveat...
      assert.match(r.stderr, /re-bootstrapping today cannot produce an attributable pre-GLM baseline/);
      // ...and no longer advises deletion as an unqualified fix.
      assert.doesNotMatch(r.stderr, /by hand to re-bootstrap/);
      // The relief reason itself stays the legacy-anchor one: the pre-GLM
      // baseline is unusable for phase reasons, not contamination.
      assert.match(r.stdout, /relief: not comparable \(baseline days-into-window unknown\)/);
    } finally {
      usage.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("end-to-end: the re-bootstrap caveat is conditional — before the window day-0 it is absent from the warning", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-beachhead-4122-"));
    const usage = await usageServer(16, "2026-08-05T17:00:00Z");
    try {
      const baselineFile = join(tmp, "baseline.json");
      seedBaselineFile(baselineFile, {
        day0: "2026-08-08T02:02:46Z",
        percentLast7dBaseline: 64,
        churnBaseline: 100.0,
      });
      const binDir = makeGhStub(tmp, {
        mergedBaselinePrs: [],
        glmAuthoredPrs: [
          { number: 830, createdAt: "2026-08-10T00:00:00Z", additions: 60, deletions: 40, labels: [{ name: "glm-authored" }] },
        ],
        commentsByPr: {},
      });
      // NOW = 2026-08-09, before the era/window day-0 (2026-08-10): the
      // warning still fires (percent set, anchor missing) and still states
      // the pre-GLM requirement, but the re-bootstrap caveat does NOT — a
      // snapshot taken now is genuinely pre-GLM.
      const r = await runReport({
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        HYDRA_GLM_BEACHHEAD_USAGE_URL: usage.url,
        HYDRA_GLM_BEACHHEAD_BASELINE_FILE: baselineFile,
        HYDRA_GLM_BEACHHEAD_NOW_EPOCH: String(epochOf("2026-08-09T00:00:00Z")),
      });
      assert.equal(r.status, 0);
      assert.match(r.stderr, /pre-#4049 bootstrap/);
      assert.match(r.stderr, /pre-GLM-era percentLast7d snapshot/);
      assert.doesNotMatch(r.stderr, /re-bootstrapping today/);
    } finally {
      usage.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
