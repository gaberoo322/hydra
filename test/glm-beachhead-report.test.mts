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
    /**
     * Force selected queries to FAIL gh-style (diagnostic on stderr, exit 1,
     * no stdout) — the 2026-08-17 503-window shape (issue #4128).
     */
    fail?: {
      mergedBaseline?: boolean;
      labelFetch?: boolean;
      branchScan?: boolean;
    };
    /** Label fetch exits 0 but prints NOTHING (gh never legitimately does with --json). */
    labelFetchEmptyOutput?: boolean;
    /** Serve this raw string (exit 0) for the branch scan instead of JSON — the malformed/partial-response class. */
    branchScanRaw?: string;
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


def fail_hard():
    # gh-style failure: diagnostic on stderr, exit 1, NO stdout (issue #4128).
    sys.stderr.write("gh-stub: HTTP 503: Service Unavailable (simulated upstream failure)")
    sys.exit(1)


def main():
    argv = sys.argv[1:]
    fx = load()
    fail = fx.get("fail", {})
    if argv[:2] == ["pr", "list"]:
        state = find_flag(argv, "--state")
        label = find_flag(argv, "--label")
        if state == "merged":
            if fail.get("mergedBaseline"):
                fail_hard()
            rows = fx["mergedBaselinePrs"]
        elif label == "glm-authored":
            if fail.get("labelFetch"):
                fail_hard()
            if fx.get("labelFetchEmptyOutput"):
                return
            rows = fx["glmAuthoredPrs"]
        elif state == "all":
            if fail.get("branchScan"):
                fail_hard()
            if fx.get("branchScanRaw") is not None:
                sys.stdout.write(fx["branchScanRaw"])
                return
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
          { number: 700, createdAt: "2026-08-01T00:00:00Z", additions: 60, deletions: 40, labels: [{ name: "glm-authored" }], headRefName: "worktree-agent-glm-4049-1" },
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
          { number: 710, createdAt: "2026-08-01T00:00:00Z", additions: 60, deletions: 40, labels: [{ name: "glm-authored" }], headRefName: "worktree-agent-glm-4049-2" },
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
          { number: 720, createdAt: "2026-08-01T00:00:00Z", additions: 60, deletions: 40, labels: [{ name: "glm-authored" }], headRefName: "worktree-agent-glm-4049-3" },
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
          { number: 730, createdAt: "2026-08-01T00:00:00Z", additions: 60, deletions: 40, labels: [{ name: "glm-authored" }], headRefName: "worktree-agent-glm-4049-4" },
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
// Fail-loud on failed gh queries (issue #4128)
//
// During a GitHub 503 window on 2026-08-17 both `gh pr list` calls inside
// fetch_glm_authored_prs() failed; `2>/dev/null || echo "[]"` masked each
// failure as an empty array and the script rendered a CONFIDENT, WRONG
// readout — "window 9/14d, 0/25 PRs ... recommendation: insufficient-data" —
// while the true state (minutes later, unchanged repo) was "window 20/14d,
// 83/25 PRs ... KEEP -- window complete". The empty rows cascaded through TWO
// suppressing paths at once: recommend() mapped zero PRs to
// insufficient-data, AND window_day0_epoch_from_rows fell back to the
// baseline epoch, resetting the window clock so a COMPLETED window read as an
// early one. The fix (pinned by the design-concept artifact for this issue):
// a failed query is detected via fetch_glm_authored_prs()'s OWN return code
// (never a global — the function runs in a command-substitution subshell that
// cannot leak assignments back to main), short-circuits main() BEFORE
// window_day0_epoch_from_rows() / recommend() ever run, logs a loud stderr
// diagnostic via log(), prints ONE ERROR line on stdout, and exits non-zero —
// a deliberate divergence from require_tools()'s exit-0 convention (a missing
// tool is the caller environment's problem; a failed query means every number
// in the report is fiction). A genuinely EMPTY result set (query succeeds,
// zero rows) keeps the existing insufficient-data path — the two cases stay
// distinct.
// ---------------------------------------------------------------------------

describe("glm-beachhead-report.sh — fail-loud on failed gh queries (issue #4128)", () => {
  // The drainer PR the 503 window hid: with queries healthy, the window from
  // 2026-07-28 to 2026-08-17 is 20/14 days — COMPLETE — and the honest
  // readout is a KEEP/EXPAND-family line, never insufficient-data.
  const INCIDENT_PR: FakePr = {
    number: 800,
    createdAt: "2026-07-28T00:00:00Z",
    additions: 60,
    deletions: 40,
    labels: [{ name: "glm-authored" }],
    headRefName: "worktree-agent-glm-4128-1",
  };
  // 2026-08-17T00:00:00Z — 20 days after the incident PR's createdAt.
  const NOW_INCIDENT = String(epochOf("2026-08-17T00:00:00Z"));

  test("the 2026-08-17 incident shape: BOTH measurement fetches failing -> exit 1, loud stderr diagnostic, one stdout ERROR line, NO recommendation and NO fabricated window position", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-beachhead-4128-"));
    const usage = await usageServer(55);
    try {
      const binDir = makeGhStub(tmp, {
        mergedBaselinePrs: [
          { number: 1, createdAt: "2026-06-01T00:00:00Z", additions: 100, deletions: 50, labels: [] },
        ],
        glmAuthoredPrs: [INCIDENT_PR],
        allPrsForBranchScan: [INCIDENT_PR],
        commentsByPr: {},
        fail: { labelFetch: true, branchScan: true },
      });
      const baselineFile = join(tmp, "baseline.json");
      const r = await runReport({
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        HYDRA_GLM_BEACHHEAD_USAGE_URL: usage.url,
        HYDRA_GLM_BEACHHEAD_BASELINE_FILE: baselineFile,
        HYDRA_GLM_BEACHHEAD_NOW_EPOCH: NOW_INCIDENT,
      });
      // THE regression: loud, non-zero exit.
      assert.equal(r.status, 1);
      // Loud stderr diagnostic via log() ("hydra-glm-beachhead: ERROR ..."),
      // carrying the failed side + gh's own error text.
      assert.match(r.stderr, /hydra-glm-beachhead: ERROR/);
      assert.match(r.stderr, /503/);
      // Exactly one ERROR line on stdout — never a recommendation of any
      // kind, never a numeric readout built on the masked [].
      assert.match(r.stdout.trim(), /^GLM beachhead: ERROR gh query failed/);
      assert.doesNotMatch(r.stdout, /recommendation:/);
      assert.doesNotMatch(r.stdout, /window \d+\/14d/);
      assert.doesNotMatch(r.stdout, /insufficient-data/);
      // The baseline bootstrap-once behavior is deliberately untouched by
      // this fix (design-concept invariant): the bootstrap that runs BEFORE
      // the measurement fetch still happened, from the fetches that succeeded.
      const baseline = JSON.parse(readFileSync(baselineFile, "utf8"));
      assert.equal(baseline.percentLast7dBaseline, 55);
      assert.equal(baseline.churnBaseline, 150);
    } finally {
      usage.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("partial failure (label fetch OK, branch scan fails) -> same fail-loud exit 1, never a union built on []", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-beachhead-4128-"));
    const usage = await usageServer(55);
    try {
      const binDir = makeGhStub(tmp, {
        mergedBaselinePrs: [],
        glmAuthoredPrs: [INCIDENT_PR],
        allPrsForBranchScan: [INCIDENT_PR],
        commentsByPr: {},
        fail: { branchScan: true },
      });
      const r = await runReport({
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        HYDRA_GLM_BEACHHEAD_USAGE_URL: usage.url,
        HYDRA_GLM_BEACHHEAD_BASELINE_FILE: join(tmp, "baseline.json"),
        HYDRA_GLM_BEACHHEAD_NOW_EPOCH: NOW_INCIDENT,
      });
      // The masked branch scan would silently judge the lane on the label
      // side alone (the #4048 provenance gap, re-introduced by the back door).
      assert.equal(r.status, 1);
      assert.match(r.stderr, /hydra-glm-beachhead: ERROR/);
      assert.match(r.stdout, /ERROR gh query failed/);
      assert.doesNotMatch(r.stdout, /recommendation:/);
      assert.doesNotMatch(r.stdout, /window \d+\/14d/);
    } finally {
      usage.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("partial failure (branch scan OK, label fetch fails) -> same fail-loud exit 1", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-beachhead-4128-"));
    const usage = await usageServer(55);
    try {
      const binDir = makeGhStub(tmp, {
        mergedBaselinePrs: [],
        glmAuthoredPrs: [INCIDENT_PR],
        allPrsForBranchScan: [INCIDENT_PR],
        commentsByPr: {},
        fail: { labelFetch: true },
      });
      const r = await runReport({
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        HYDRA_GLM_BEACHHEAD_USAGE_URL: usage.url,
        HYDRA_GLM_BEACHHEAD_BASELINE_FILE: join(tmp, "baseline.json"),
        HYDRA_GLM_BEACHHEAD_NOW_EPOCH: NOW_INCIDENT,
      });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /hydra-glm-beachhead: ERROR/);
      assert.match(r.stdout, /ERROR gh query failed/);
      assert.doesNotMatch(r.stdout, /recommendation:/);
    } finally {
      usage.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("gh exiting 0 with EMPTY stdout is a failed query, not an empty result set -> fail loud", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-beachhead-4128-"));
    const usage = await usageServer(55);
    try {
      const binDir = makeGhStub(tmp, {
        mergedBaselinePrs: [],
        glmAuthoredPrs: [INCIDENT_PR],
        allPrsForBranchScan: [INCIDENT_PR],
        commentsByPr: {},
        labelFetchEmptyOutput: true,
      });
      const r = await runReport({
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        HYDRA_GLM_BEACHHEAD_USAGE_URL: usage.url,
        HYDRA_GLM_BEACHHEAD_BASELINE_FILE: join(tmp, "baseline.json"),
        HYDRA_GLM_BEACHHEAD_NOW_EPOCH: NOW_INCIDENT,
      });
      // A successful `gh pr list --json` always prints at least []; nothing
      // at all on stdout means the response never arrived — the same class of
      // silent truncation the 2026-08-17 instability exhibited.
      assert.equal(r.status, 1);
      assert.match(r.stderr, /hydra-glm-beachhead: ERROR/);
      assert.doesNotMatch(r.stdout, /recommendation:/);
    } finally {
      usage.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("the branch scan returning invalid JSON (partial response) -> fail loud, never a silent []", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-beachhead-4128-"));
    const usage = await usageServer(55);
    try {
      const binDir = makeGhStub(tmp, {
        mergedBaselinePrs: [],
        glmAuthoredPrs: [INCIDENT_PR],
        commentsByPr: {},
        // Truncated mid-object, exit 0 — the union jq cannot parse this, and
        // the old `|| echo "[]"` mask turned that into a fabricated zero.
        branchScanRaw: '[{"number": 900, "createdAt"',
      });
      const r = await runReport({
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        HYDRA_GLM_BEACHHEAD_USAGE_URL: usage.url,
        HYDRA_GLM_BEACHHEAD_BASELINE_FILE: join(tmp, "baseline.json"),
        HYDRA_GLM_BEACHHEAD_NOW_EPOCH: NOW_INCIDENT,
      });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /hydra-glm-beachhead: ERROR/);
      assert.doesNotMatch(r.stdout, /recommendation:/);
    } finally {
      usage.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("CONTRAST: the same queries succeeding with ZERO rows keeps insufficient-data, exit 0 (a failed query and an empty result set stay distinct)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-beachhead-4128-"));
    const usage = await usageServer(55);
    try {
      const binDir = makeGhStub(tmp, {
        mergedBaselinePrs: [],
        glmAuthoredPrs: [],
        allPrsForBranchScan: [],
        commentsByPr: {},
      });
      const r = await runReport({
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        HYDRA_GLM_BEACHHEAD_USAGE_URL: usage.url,
        HYDRA_GLM_BEACHHEAD_BASELINE_FILE: join(tmp, "baseline.json"),
        HYDRA_GLM_BEACHHEAD_NOW_EPOCH: NOW_INCIDENT,
      });
      // Acceptance criterion 2: `[]` from a SUCCESSFUL query is the genuine
      // no-drainer-PRs-yet state — the empty-rows -> baseline-epoch fallback
      // in window_day0_epoch_from_rows() stays legitimate here (window 0/14d
      // anchored to the bootstrap moment) and the recommendation stays the
      // informational insufficient-data line, exit 0.
      assert.equal(r.status, 0);
      assert.match(r.stdout, /window 0\/14d, 0\/25 PRs/);
      assert.match(r.stdout, /recommendation: insufficient-data/);
    } finally {
      usage.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a failed merged-baseline churn fetch at bootstrap degrades gracefully to a null churnBaseline (deliberately unchanged, do not fix here)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-beachhead-4128-"));
    const usage = await usageServer(55);
    try {
      const binDir = makeGhStub(tmp, {
        mergedBaselinePrs: [],
        glmAuthoredPrs: [INCIDENT_PR],
        allPrsForBranchScan: [INCIDENT_PR],
        commentsByPr: {},
        fail: { mergedBaseline: true },
      });
      const baselineFile = join(tmp, "baseline.json");
      const r = await runReport({
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        HYDRA_GLM_BEACHHEAD_USAGE_URL: usage.url,
        HYDRA_GLM_BEACHHEAD_BASELINE_FILE: baselineFile,
        HYDRA_GLM_BEACHHEAD_NOW_EPOCH: NOW_INCIDENT,
      });
      // The design-concept artifact scopes this fix to the
      // fetch_glm_authored_prs() path ONLY: fetch_baseline_churn_sample()
      // keeps its graceful degradation (gh failure -> "[]" -> null/n-a
      // baseline, report still renders, exit 0). This test PINS that
      // divergence so a later pass cannot "harmonize" it accidentally —
      // extending fail-loud to the baseline bootstrap is a separate decision.
      assert.equal(r.status, 0);
      const baseline = JSON.parse(readFileSync(baselineFile, "utf8"));
      assert.equal(baseline.churnBaseline, null);
      assert.equal(baseline.churnSampleSize, 0);
      assert.match(r.stdout, /vs baseline n\/a \(ratio n\/a\)/);
      assert.match(r.stdout, /recommendation: KEEP/);
    } finally {
      usage.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
