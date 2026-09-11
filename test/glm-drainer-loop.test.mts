/**
 * Regression tests for the GLM dev-drainer loop's control flow (issue #3689,
 * ADR-0032 as amended by #3753/#3758).
 *
 * Mirrors `test/pace-gate-allow.test.mts`'s technique: spawn the real shell
 * script under `HYDRA_GLM_DRAINER_DRY_RUN=1` (every mutating/network action
 * logs "would-<action>" to stderr and no-ops instead of executing — see the
 * script's own header) against a fixture HTTP server for the one live call
 * this suite needs to control (`GET /api/autopilot/paused`), and assert on
 * the combined stdout+stderr transcript. This drives the pure gating logic —
 * flock / operator-paused-only / daily-cap / heartbeat-only-when-able —
 * with no gh/git/claude/Redis dependency.
 *
 * What this suite does NOT attempt to cover end-to-end (deliberately, same
 * boundary `pace-gate-allow.test.mts` draws around its own script): worktree
 * creation and the claude authoring spawn shell out to `git`/the generated
 * Node driver in production and are exercised structurally via code review +
 * the manual DRY_RUN smoke test this PR's author ran against the live repo
 * (see the PR description) rather than mocked line-by-line here —
 * `hydra-dev-parent-flow.md`'s own worktree-spawn logic (the closest
 * analogue) carries no automated test either, for the same reason: it is
 * orchestration glue over already-covered primitives (`src/glm/drainer-runner.ts`,
 * `src/redis/autopilot.ts`, `recover-stale.sh`).
 *
 * Issue selection (`pick_eligible_issue()`) and PR creation (`open_pr()`) are
 * the exception (issue #3900): `runShellSnippet()` below sources the script
 * and calls one function directly against a fake `gh` on `PATH`, narrower
 * unit coverage of just those two functions' `gh`-response-branching logic
 * — not a full DRY_RUN process spawn like the rest of this suite — because
 * #3900's regression (an "already exists" `gh pr create` collision silently
 * discarding a real PR) lives entirely inside that branching and would not
 * be caught by DRY_RUN's no-op gh calls.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const DRAINER_LOOP = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "glm",
  "drainer-loop.sh",
);

/** Serve a fixed `{paused: bool}` JSON on an ephemeral port. */
function pausedServer(paused: boolean | null): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      if (paused === null) {
        // Malformed body — exercises the "unparseable" fail-safe arm.
        res.end("not json");
        return;
      }
      res.end(JSON.stringify({ paused }));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as any;
      resolve({
        url: `http://127.0.0.1:${addr.port}/api/autopilot/paused`,
        close: () => server.close(),
      });
    });
  });
}

function runDrainerLoop(
  pausedUrl: string,
  extraEnv: Record<string, string> = {},
): Promise<{ status: number; combined: string }> {
  return new Promise((resolve, reject) => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-drainer-test-"));
    const child = spawn("bash", [DRAINER_LOOP], {
      env: {
        ...process.env,
        HYDRA_GLM_DRAINER_DRY_RUN: "1",
        HYDRA_GLM_DRAINER_PAUSED_URL: pausedUrl,
        HYDRA_GLM_DRAINER_LOCKFILE: join(tmp, "lock"),
        HYDRA_GLM_DRAINER_CAP_DIR: tmp,
        HYDRA_GLM_DRAINER_DAILY_CAP: "5",
        ...extraEnv,
      },
    });
    let combined = "";
    child.stdout.on("data", (d) => { combined += d.toString(); });
    child.stderr.on("data", (d) => { combined += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      rmSync(tmp, { recursive: true, force: true });
      resolve({ status: code ?? -1, combined });
    });
  });
}

/**
 * Sources drainer-loop.sh (never runs main() — see the script's own
 * `[[ "${BASH_SOURCE[0]}" == "${0}" ]]` guard) and then runs `snippet`
 * (typically a single function call) in the SAME bash process, so the
 * snippet can call the script's functions directly. Used below to unit-test
 * `open_pr()` and `pick_eligible_issue()` against a fake `gh` on PATH,
 * without spawning the full DRY_RUN control-flow tested above (open_pr and
 * pick_eligible_issue are exactly the two functions that suite's own header
 * comment documents as NOT covered end-to-end — issue #3900 adds this
 * narrower, function-level coverage instead of mocking the whole tick).
 */
function runShellSnippet(
  extraEnv: Record<string, string>,
  snippet: string,
): Promise<{ status: number; combined: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "bash",
      ["-c", `set -uo pipefail; source "$DRAINER_LOOP_PATH"; ${snippet}`],
      { env: { ...process.env, DRAINER_LOOP_PATH: DRAINER_LOOP, ...extraEnv } },
    );
    let combined = "";
    child.stdout.on("data", (d) => { combined += d.toString(); });
    child.stderr.on("data", (d) => { combined += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ status: code ?? -1, combined }));
  });
}

/** Serve `{"status": "approved"}` (or a given map by issue) for design-concept lookups. */
function designConceptServer(approvedIssues: Set<number>): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      const m = /\/issue-(\d+)$/.exec(req.url ?? "");
      const n = m ? Number(m[1]) : NaN;
      res.end(JSON.stringify({ status: approvedIssues.has(n) ? "approved" : "pending" }));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as any;
      resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => server.close() });
    });
  });
}

describe("scripts/glm/drainer-loop.sh — kill-switch honors ONLY operator paused (ADR-0032 Decision 6, issue #3689)", () => {
  test("paused:true => skip, no heartbeat", async () => {
    const srv = await pausedServer(true);
    try {
      const r = await runDrainerLoop(srv.url);
      assert.equal(r.status, 0);
      assert.match(r.combined, /operator paused — skip \(no heartbeat/);
      assert.doesNotMatch(r.combined, /would-heartbeat/);
    } finally {
      srv.close();
    }
  });

  test("paused:false => proceeds past the kill-switch (heartbeat attempted)", async () => {
    const srv = await pausedServer(false);
    try {
      const r = await runDrainerLoop(srv.url);
      assert.equal(r.status, 0);
      assert.doesNotMatch(r.combined, /operator paused — skip/);
      assert.match(r.combined, /would-heartbeat \(reason=able/);
    } finally {
      srv.close();
    }
  });

  test("unreachable pause endpoint => fails safe (treated as paused, no heartbeat)", async () => {
    // Port 1 is never listening — connection refused, deterministic.
    const r = await runDrainerLoop("http://127.0.0.1:1/api/autopilot/paused");
    assert.equal(r.status, 0);
    assert.match(r.combined, /pause endpoint unreachable/);
    assert.match(r.combined, /operator paused — skip \(no heartbeat/);
    assert.doesNotMatch(r.combined, /would-heartbeat/);
  });

  test("unparseable pause response => fails safe (treated as paused, no heartbeat)", async () => {
    const srv = await pausedServer(null);
    try {
      const r = await runDrainerLoop(srv.url);
      assert.equal(r.status, 0);
      assert.match(r.combined, /pause response unparseable/);
      assert.match(r.combined, /operator paused — skip \(no heartbeat/);
      assert.doesNotMatch(r.combined, /would-heartbeat/);
    } finally {
      srv.close();
    }
  });

  test("paused:false is NOT misread as unparseable (jq `//` false-is-falsy trap, mirrors pace-gate #1790)", async () => {
    // Regression pin: `.paused // "parse-error"` would collapse a legitimate
    // `false` into the parse-error branch (jq's `//` treats `false` as
    // falsy). The fix uses bare `.paused` + strict string matching, exactly
    // like pace-gate.sh's own `.allow` fix. This test would have failed
    // against the buggy version (it would have hit the "unparseable" log
    // line and skipped instead of proceeding).
    const srv = await pausedServer(false);
    try {
      const r = await runDrainerLoop(srv.url);
      assert.doesNotMatch(r.combined, /pause response unparseable/);
    } finally {
      srv.close();
    }
  });

  test("Anthropic-shaped fields in the response body are irrelevant — only .paused is read", async () => {
    // A server that ALSO carries Anthropic emergencyStop-shaped noise must
    // not influence the verdict — this endpoint (GET /api/autopilot/paused)
    // only ever returns {paused, since?} in production, but a hostile/buggy
    // fixture proves the script reads no other field.
    const server = http.createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ paused: false, emergencyStop: true, weeklyEmergencyStop: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as any;
    const url = `http://127.0.0.1:${addr.port}/api/autopilot/paused`;
    try {
      const r = await runDrainerLoop(url);
      assert.doesNotMatch(r.combined, /operator paused — skip/);
      assert.match(r.combined, /would-heartbeat \(reason=able/);
    } finally {
      server.close();
    }
  });
});

describe("scripts/glm/drainer-loop.sh — daily PR cap (issue #3689)", () => {
  test("cap not yet reached => proceeds (heartbeat attempted)", async () => {
    const srv = await pausedServer(false);
    try {
      const r = await runDrainerLoop(srv.url, { HYDRA_GLM_DRAINER_DAILY_CAP: "5" });
      assert.doesNotMatch(r.combined, /daily PR cap reached/);
      assert.match(r.combined, /would-heartbeat \(reason=able/);
    } finally {
      srv.close();
    }
  });

  test("cap already at the limit => skip, no heartbeat", async () => {
    const srv = await pausedServer(false);
    const tmp = mkdtempSync(join(tmpdir(), "glm-drainer-cap-test-"));
    try {
      const today = new Date().toISOString().slice(0, 10);
      writeFileSync(join(tmp, `hydra-glm-drainer-daily-cap-${today}`), "3");
      const r = await new Promise<{ status: number; combined: string }>((resolve, reject) => {
        const child = spawn("bash", [DRAINER_LOOP], {
          env: {
            ...process.env,
            HYDRA_GLM_DRAINER_DRY_RUN: "1",
            HYDRA_GLM_DRAINER_PAUSED_URL: srv.url,
            HYDRA_GLM_DRAINER_LOCKFILE: join(tmp, "lock"),
            HYDRA_GLM_DRAINER_CAP_DIR: tmp,
            HYDRA_GLM_DRAINER_DAILY_CAP: "3",
          },
        });
        let combined = "";
        child.stdout.on("data", (d) => { combined += d.toString(); });
        child.stderr.on("data", (d) => { combined += d.toString(); });
        child.on("error", reject);
        child.on("close", (code) => resolve({ status: code ?? -1, combined }));
      });
      assert.equal(r.status, 0);
      assert.match(r.combined, /daily PR cap reached \(3\/3\)/);
      assert.doesNotMatch(r.combined, /would-heartbeat/);
    } finally {
      srv.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("scripts/glm/drainer-loop.sh — flock concurrency=1 (ADR-0032 invariant 5, issue #3689)", () => {
  test("a held lock is detected as blocked and STILL refreshes the heartbeat (2026-07-27 AMENDMENTS #3)", async () => {
    const srv = await pausedServer(false);
    const tmp = mkdtempSync(join(tmpdir(), "glm-drainer-flock-test-"));
    const lockfile = join(tmp, "lock");
    // Hold the lock from a separate process for the duration of the test —
    // `flock <fd>` with no command blocks until the fd is closed or the
    // process exits; killed in the `finally` block below.
    const holder = spawn("bash", ["-c", `exec 9>"${lockfile}"; flock 9; sleep 30`]);
    try {
      // Give the holder a moment to actually acquire the lock before racing it.
      await new Promise((r) => setTimeout(r, 300));
      const r = await runDrainerLoop(srv.url, { HYDRA_GLM_DRAINER_LOCKFILE: lockfile, HYDRA_GLM_DRAINER_CAP_DIR: tmp });
      assert.equal(r.status, 0);
      assert.match(r.combined, /flock blocked/);
      assert.match(r.combined, /would-heartbeat \(reason=blocked/);
      // The blocked branch must exit BEFORE the paused/cap gating — it never
      // even reaches those checks (the still-running "other tick" already
      // passed them when IT started).
      assert.doesNotMatch(r.combined, /would-heartbeat \(reason=able/);
    } finally {
      holder.kill("SIGKILL");
      rmSync(tmp, { recursive: true, force: true });
      srv.close();
    }
  });

  test("no held lock => acquires cleanly and proceeds past the flock step", async () => {
    const srv = await pausedServer(false);
    try {
      const r = await runDrainerLoop(srv.url);
      assert.doesNotMatch(r.combined, /flock blocked/);
    } finally {
      srv.close();
    }
  });
});

describe("scripts/glm/drainer-loop.sh — open_pr() adopts an already-exists collision instead of discarding it (issue #3900)", () => {
  // The bug: a single `gh pr create` call `||`'d straight into `return 1` on
  // ANY failure, including "a pull request for branch X already exists" — a
  // real GitHub answer meaning a PR already exists, not a genuine failure.
  // The caller then release_issue'd the claim, discarding the PR reference
  // and letting pick_eligible_issue re-dispatch the same issue.

  function fakeGhForOpenPr(): string {
    return `#!/usr/bin/env bash
set -u
if [[ "\${1:-}" == "issue" && "\${2:-}" == "view" ]]; then
  echo "Fake Issue Title"
  exit 0
fi
if [[ "\${1:-}" == "pr" && "\${2:-}" == "create" ]]; then
  echo 'GraphQL: a pull request for branch "glm-test-branch" into branch "master" already exists:' >&2
  echo "https://github.com/gaberoo322/hydra/pull/999" >&2
  exit 1
fi
if [[ "\${1:-}" == "pr" && "\${2:-}" == "list" ]]; then
  cat "$FAKE_GH_PR_LIST_FILE"
  exit 0
fi
if [[ "\${1:-}" == "pr" && "\${2:-}" == "edit" ]]; then
  echo "$*" >> "$FAKE_GH_EDIT_CALLS_FILE"
  exit 0
fi
echo "fake gh (open_pr test): unhandled args: $*" >&2
exit 1
`;
  }

  function setupFakeGh(
    tmp: string,
    prListContents: string,
  ): { binDir: string; wtDir: string; prListFile: string; editCallsFile: string } {
    const binDir = join(tmp, "bin");
    mkdirSync(binDir);
    writeFileSync(join(binDir, "gh"), fakeGhForOpenPr(), { mode: 0o755 });
    const wtDir = join(tmp, "wt");
    mkdirSync(wtDir);
    writeFileSync(join(wtDir, ".glm-drainer-pr-body.md"), "test pr body\n");
    const prListFile = join(tmp, "pr-list.json");
    writeFileSync(prListFile, prListContents);
    const editCallsFile = join(tmp, "edit-calls.txt");
    writeFileSync(editCallsFile, "");
    return { binDir, wtDir, prListFile, editCallsFile };
  }

  test("gh pr create fails with 'already exists' AND gh pr list finds a matching PR => adopts it (exit 0, ANOMALY logged, PR number surfaced, glm-authored re-applied)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-drainer-openpr-adopt-"));
    try {
      const { binDir, wtDir, prListFile, editCallsFile } = setupFakeGh(
        tmp,
        JSON.stringify([{ number: 999, url: "https://github.com/gaberoo322/hydra/pull/999" }]),
      );
      const r = await runShellSnippet(
        {
          PATH: `${binDir}:${process.env.PATH}`,
          WT_DIR: wtDir,
          FAKE_GH_PR_LIST_FILE: prListFile,
          FAKE_GH_EDIT_CALLS_FILE: editCallsFile,
        },
        `open_pr 42 glm-test-branch "$WT_DIR"; echo "SNIPPET_EXIT:$?"`,
      );
      assert.match(r.combined, /SNIPPET_EXIT:0/, `expected adoption to return success:\n${r.combined}`);
      assert.match(r.combined, /ANOMALY/i);
      assert.match(r.combined, /#999/);
      assert.doesNotMatch(r.combined, /^ERROR gh pr create failed.*genuine failure/m);
      // The most likely origin of an adopted PR (see the script's own
      // investigation note) is a prior gh pr create succeeding at PR
      // creation but failing non-zero on its separate --label mutation — so
      // the adopted PR is exactly the one most likely to be missing
      // glm-authored, the sole discriminator from Opus dev_orch PRs
      // (ADR-0032 Decision 5). Confirm open_pr() re-applies it.
      const editCalls = readFileSync(editCallsFile, "utf8");
      assert.match(editCalls, /pr edit 999 .*--add-label glm-authored/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("gh pr create fails AND gh pr list finds NO matching PR => genuine failure preserved (non-zero exit, ERROR logged)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-drainer-openpr-fail-"));
    try {
      const { binDir, wtDir, prListFile } = setupFakeGh(tmp, "[]");
      const r = await runShellSnippet(
        {
          PATH: `${binDir}:${process.env.PATH}`,
          WT_DIR: wtDir,
          FAKE_GH_PR_LIST_FILE: prListFile,
        },
        `open_pr 42 glm-test-branch "$WT_DIR"; echo "SNIPPET_EXIT:$?"`,
      );
      assert.match(r.combined, /SNIPPET_EXIT:1/, `expected genuine failure to return non-zero:\n${r.combined}`);
      assert.match(r.combined, /ERROR gh pr create failed.*genuine failure/);
      assert.doesNotMatch(r.combined, /ANOMALY/i);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("scripts/glm/drainer-loop.sh — pick_eligible_issue() skips a candidate with an existing open PR (issue #3900)", () => {
  function fakeGhForPicker(): string {
    return `#!/usr/bin/env bash
set -u
if [[ "\${1:-}" == "issue" && "\${2:-}" == "list" ]]; then
  cat "$FAKE_GH_ISSUE_LIST_FILE"
  exit 0
fi
if [[ "\${1:-}" == "pr" && "\${2:-}" == "list" ]]; then
  cat "$FAKE_GH_PR_LIST_FILE"
  exit 0
fi
echo "fake gh (picker test): unhandled args: $*" >&2
exit 1
`;
  }

  test("a candidate already referenced by an open PR's 'Closes #N' is skipped; the next eligible candidate is picked", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-drainer-picker-skip-"));
    const dc = await designConceptServer(new Set([10, 20]));
    try {
      const binDir = join(tmp, "bin");
      mkdirSync(binDir);
      writeFileSync(join(binDir, "gh"), fakeGhForPicker(), { mode: 0o755 });
      const issueListFile = join(tmp, "issues.json");
      writeFileSync(
        issueListFile,
        JSON.stringify([
          { number: 10, updatedAt: "2026-08-01T00:00:00Z", labels: [] },
          { number: 20, updatedAt: "2026-08-02T00:00:00Z", labels: [] },
        ]),
      );
      const prListFile = join(tmp, "prs.json");
      writeFileSync(
        prListFile,
        JSON.stringify([{ number: 500, body: "Implements the thing.\n\nCloses #10" }]),
      );
      const r = await runShellSnippet(
        {
          PATH: `${binDir}:${process.env.PATH}`,
          HYDRA_GLM_DRAINER_DESIGN_CONCEPT_URL: dc.url,
          FAKE_GH_ISSUE_LIST_FILE: issueListFile,
          FAKE_GH_PR_LIST_FILE: prListFile,
        },
        `pick_eligible_issue; echo "SNIPPET_EXIT:$?"`,
      );
      assert.match(r.combined, /skipping issue #10 — an open PR already references it/);
      assert.match(r.combined, /^20$/m, `expected #20 to be picked instead:\n${r.combined}`);
      assert.doesNotMatch(r.combined, /^10$/m);
    } finally {
      dc.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("no open PR references any candidate => the oldest-updated candidate is picked unchanged (no false-positive skip)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-drainer-picker-nomatch-"));
    const dc = await designConceptServer(new Set([10, 20]));
    try {
      const binDir = join(tmp, "bin");
      mkdirSync(binDir);
      writeFileSync(join(binDir, "gh"), fakeGhForPicker(), { mode: 0o755 });
      const issueListFile = join(tmp, "issues.json");
      writeFileSync(
        issueListFile,
        JSON.stringify([
          { number: 10, updatedAt: "2026-08-01T00:00:00Z", labels: [] },
          { number: 20, updatedAt: "2026-08-02T00:00:00Z", labels: [] },
        ]),
      );
      const prListFile = join(tmp, "prs.json");
      // An open PR exists but references an unrelated issue (#999) — must
      // not be mistaken for a match on #10 or #20.
      writeFileSync(prListFile, JSON.stringify([{ number: 501, body: "Closes #999" }]));
      const r = await runShellSnippet(
        {
          PATH: `${binDir}:${process.env.PATH}`,
          HYDRA_GLM_DRAINER_DESIGN_CONCEPT_URL: dc.url,
          FAKE_GH_ISSUE_LIST_FILE: issueListFile,
          FAKE_GH_PR_LIST_FILE: prListFile,
        },
        `pick_eligible_issue; echo "SNIPPET_EXIT:$?"`,
      );
      assert.doesNotMatch(r.combined, /skipping issue/);
      assert.match(r.combined, /^10$/m, `expected #10 (oldest updatedAt) to be picked:\n${r.combined}`);
    } finally {
      dc.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("scripts/glm/drainer-loop.sh — pick_eligible_issue() skips a candidate already shipped by a MERGED PR (issue #4130)", () => {
  // The merged fetch is a SECOND `gh pr list` call scoped `--state merged`,
  // so this fake dispatches on whether "merged" appears in the args (the
  // sibling picker fake above cats one fixture for every pr list and cannot
  // distinguish the two calls).
  function fakeGhForMergedPicker(): string {
    return `#!/usr/bin/env bash
set -u
if [[ "\${1:-}" == "issue" && "\${2:-}" == "list" ]]; then
  cat "$FAKE_GH_ISSUE_LIST_FILE"
  exit 0
fi
if [[ "\${1:-}" == "pr" && "\${2:-}" == "list" ]]; then
  for a in "$@"; do
    if [[ "$a" == "merged" ]]; then
      if [[ "\${FAKE_GH_MERGED_PR_FAIL:-0}" == "1" ]]; then exit 1; fi
      cat "$FAKE_GH_MERGED_PR_LIST_FILE"
      exit 0
    fi
  done
  cat "$FAKE_GH_PR_LIST_FILE"
  exit 0
fi
echo "fake gh (merged-picker test): unhandled args: $*" >&2
exit 1
`;
  }

  function setupMergedPicker(tmp: string, mergedPrs: unknown[]) {
    const binDir = join(tmp, "bin");
    mkdirSync(binDir);
    writeFileSync(join(binDir, "gh"), fakeGhForMergedPicker(), { mode: 0o755 });
    const issueListFile = join(tmp, "issues.json");
    writeFileSync(
      issueListFile,
      JSON.stringify([
        { number: 10, updatedAt: "2026-08-01T00:00:00Z", labels: [] },
        { number: 20, updatedAt: "2026-08-02T00:00:00Z", labels: [] },
      ]),
    );
    const prListFile = join(tmp, "prs-open.json");
    writeFileSync(prListFile, JSON.stringify([]));
    const mergedPrListFile = join(tmp, "prs-merged.json");
    writeFileSync(mergedPrListFile, JSON.stringify(mergedPrs));
    return {
      env: {
        PATH: `${binDir}:${process.env.PATH}`,
        FAKE_GH_ISSUE_LIST_FILE: issueListFile,
        FAKE_GH_PR_LIST_FILE: prListFile,
        FAKE_GH_MERGED_PR_LIST_FILE: mergedPrListFile,
      },
    };
  }

  test("a candidate referenced only by a MERGED PR's title anchor — no closing keyword anywhere, the exact #4236/#4130 shape — is skipped", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-drainer-merged-skip-"));
    const dc = await designConceptServer(new Set([10, 20]));
    try {
      // Reproduces the live 2026-08-27 incident verbatim in miniature: PR
      // #4236 merged carrying issue #4130 ONLY as the title's "(#4130)"
      // anchor suffix — its body had no "Closes #4130" — so GitHub never
      // auto-closed the issue and the loop re-picked it the same day.
      const { env } = setupMergedPicker(tmp, [
        {
          number: 4236,
          title: "fix(autopilot): distinguish failed orch board reads from empty ones (#10) (#4236)",
          body: "Autopilot no longer mistakes a failed GitHub board read for an empty board (#10)\n\n## Files in scope\n- scripts/x\n",
        },
      ]);
      const r = await runShellSnippet(
        { ...env, HYDRA_GLM_DRAINER_DESIGN_CONCEPT_URL: dc.url },
        `pick_eligible_issue; echo "SNIPPET_EXIT:$?"`,
      );
      assert.match(r.combined, /skipping issue #10 — a MERGED PR already references it/);
      assert.match(r.combined, /^20$/m, `expected #20 to be picked instead:\n${r.combined}`);
      assert.doesNotMatch(r.combined, /^10$/m);
    } finally {
      dc.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a MERGED PR body carrying a closing keyword also skips the candidate", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-drainer-merged-keyword-"));
    const dc = await designConceptServer(new Set([10, 20]));
    try {
      const { env } = setupMergedPicker(tmp, [
        { number: 502, title: "unrelated title", body: "Reworks the lane.\n\nFixes #10" },
      ]);
      const r = await runShellSnippet(
        { ...env, HYDRA_GLM_DRAINER_DESIGN_CONCEPT_URL: dc.url },
        `pick_eligible_issue; echo "SNIPPET_EXIT:$?"`,
      );
      assert.match(r.combined, /skipping issue #10 — a MERGED PR already references it/);
      assert.match(r.combined, /^20$/m, `expected #20 to be picked instead:\n${r.combined}`);
    } finally {
      dc.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a merged PR referencing only OTHER issues, or mentioning #10 with neither keyword nor title anchor, does NOT skip (no false-positive)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-drainer-merged-nomatch-"));
    const dc = await designConceptServer(new Set([10, 20]));
    try {
      const { env } = setupMergedPicker(tmp, [
        { number: 503, title: "fix(core): something else (#999)", body: "Discusses #10 in prose but neither closes nor anchors it. Closes #999" },
      ]);
      const r = await runShellSnippet(
        { ...env, HYDRA_GLM_DRAINER_DESIGN_CONCEPT_URL: dc.url },
        `pick_eligible_issue; echo "SNIPPET_EXIT:$?"`,
      );
      assert.doesNotMatch(r.combined, /skipping issue/);
      assert.match(r.combined, /^10$/m, `expected #10 (oldest updatedAt) to be picked:\n${r.combined}`);
    } finally {
      dc.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("the merged-PR fetch failing degrades to no skip (WARN, not blocked) — same fail-open as the open-PR list", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-drainer-merged-fail-"));
    const dc = await designConceptServer(new Set([10, 20]));
    try {
      const { env } = setupMergedPicker(tmp, []);
      const r = await runShellSnippet(
        { ...env, FAKE_GH_MERGED_PR_FAIL: "1", HYDRA_GLM_DRAINER_DESIGN_CONCEPT_URL: dc.url },
        `pick_eligible_issue; echo "SNIPPET_EXIT:$?"`,
      );
      assert.match(r.combined, /WARN gh pr list --state merged failed/);
      assert.match(r.combined, /^10$/m, `expected #10 to still be picked without the merged list:\n${r.combined}`);
    } finally {
      dc.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("scripts/glm/drainer-loop.sh — pick_eligible_issue() skips a candidate carrying glm-ab-control (issue #4124, defense in depth)", () => {
  // Mirrors the sibling glm-withhold picker fakes above: `gh issue list`
  // cats a fixture (regardless of the real --label filters, which the
  // eligibility sweep + the candidate query already enforce server-side),
  // and every `gh pr list` call (open or merged) returns an empty array —
  // this suite is only exercising the client-side jq label filter, not the
  // open/merged-PR skip guards covered by the sibling describes above.
  function fakeGhForAbControlSkip(): string {
    return `#!/usr/bin/env bash
set -u
if [[ "\${1:-}" == "issue" && "\${2:-}" == "list" ]]; then
  cat "$FAKE_GH_ISSUE_LIST_FILE"
  exit 0
fi
if [[ "\${1:-}" == "pr" && "\${2:-}" == "list" ]]; then
  echo "[]"
  exit 0
fi
echo "fake gh (ab-control picker test): unhandled args: $*" >&2
exit 1
`;
  }

  test("a candidate labelled glm-ab-control is skipped client-side; the next eligible candidate is picked", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-drainer-abcontrol-skip-"));
    const dc = await designConceptServer(new Set([10, 20]));
    try {
      const binDir = join(tmp, "bin");
      mkdirSync(binDir);
      writeFileSync(join(binDir, "gh"), fakeGhForAbControlSkip(), { mode: 0o755 });
      const issueListFile = join(tmp, "issues.json");
      writeFileSync(
        issueListFile,
        JSON.stringify([
          { number: 10, updatedAt: "2026-08-01T00:00:00Z", labels: [{ name: "glm-ab-control" }] },
          { number: 20, updatedAt: "2026-08-02T00:00:00Z", labels: [] },
        ]),
      );
      const r = await runShellSnippet(
        {
          PATH: `${binDir}:${process.env.PATH}`,
          HYDRA_GLM_DRAINER_DESIGN_CONCEPT_URL: dc.url,
          FAKE_GH_ISSUE_LIST_FILE: issueListFile,
        },
        `pick_eligible_issue; echo "SNIPPET_EXIT:$?"`,
      );
      assert.match(
        r.combined,
        /^20$/m,
        `expected #20 to be picked instead of the glm-ab-control-labelled #10:\n${r.combined}`,
      );
      assert.doesNotMatch(r.combined, /^10$/m);
    } finally {
      dc.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("no glm-ab-control label present => the oldest-updated candidate is picked unchanged (no false-positive skip)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-drainer-abcontrol-nomatch-"));
    const dc = await designConceptServer(new Set([10, 20]));
    try {
      const binDir = join(tmp, "bin");
      mkdirSync(binDir);
      writeFileSync(join(binDir, "gh"), fakeGhForAbControlSkip(), { mode: 0o755 });
      const issueListFile = join(tmp, "issues.json");
      writeFileSync(
        issueListFile,
        JSON.stringify([
          { number: 10, updatedAt: "2026-08-01T00:00:00Z", labels: [] },
          { number: 20, updatedAt: "2026-08-02T00:00:00Z", labels: [] },
        ]),
      );
      const r = await runShellSnippet(
        {
          PATH: `${binDir}:${process.env.PATH}`,
          HYDRA_GLM_DRAINER_DESIGN_CONCEPT_URL: dc.url,
          FAKE_GH_ISSUE_LIST_FILE: issueListFile,
        },
        `pick_eligible_issue; echo "SNIPPET_EXIT:$?"`,
      );
      assert.doesNotMatch(r.combined, /skipping issue/);
      assert.match(
        r.combined,
        /^10$/m,
        `expected #10 (oldest updatedAt) to be picked:\n${r.combined}`,
      );
    } finally {
      dc.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("scripts/glm/drainer-loop.sh — systemd units mirror the pace-gate shape (issue #3689)", () => {
  test("the .service is Type=oneshot with a WorkingDirectory and journal logging, like hydra-pace-gate.service", async () => {
    const fs = await import("node:fs");
    const svc = fs.readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "systemd", "hydra-glm-drainer.service"),
      "utf8",
    );
    assert.match(svc, /Type=oneshot/);
    assert.match(svc, /WorkingDirectory=%h\/hydra/);
    assert.match(svc, /ExecStart=.*drainer-loop\.sh/);
    assert.match(svc, /StandardOutput=journal/);
    assert.match(svc, /StandardError=journal/);
  });

  test("the .timer fires ~15 min with jitter and Persistent=true, like hydra-pace-gate.timer", async () => {
    const fs = await import("node:fs");
    const timer = fs.readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "systemd", "hydra-glm-drainer.timer"),
      "utf8",
    );
    assert.match(timer, /OnUnitActiveSec=15min/);
    assert.match(timer, /Persistent=true/);
    assert.match(timer, /RandomizedDelaySec=/);
    assert.match(timer, /Unit=hydra-glm-drainer\.service/);
    assert.match(timer, /WantedBy=timers\.target/);
  });
});

describe("scripts/glm/drainer-loop.sh — never produces a dispatch cost-join record, by construction (issue #4126 INV-6)", () => {
  test("the script never references reap.py or the dispatch-cost-join write path", () => {
    // Issue #4126's join write (`_post_dispatch_cost_join` in
    // scripts/autopilot/reap.py, POSTing to /api/usage/dispatch-cost) is
    // fired ONLY from reap.py's `run_completion` — the SubagentStop hook /
    // reap.py fallback that owns this write path. The GLM drainer is a
    // wholly separate lane (ADR-0032): it never sources, execs, or shells out
    // to reap.py, so a GLM-authored dev_orch run structurally cannot reach
    // this write path — there is no code path connecting the two scripts.
    // This is the intended behavior, not a defect: it's exactly what lets a
    // GLM-arm issue's dev_orch entry read near-zero-Anthropic while its
    // later qa_orch entry (which DOES run through the normal harness) still
    // carries real Anthropic cost, satisfying the epic's "GLM issues must
    // not read as free" acceptance criterion.
    const source = readFileSync(DRAINER_LOOP, "utf8");
    assert.doesNotMatch(
      source,
      /reap\.py/,
      "drainer-loop.sh must never reference reap.py — the two lanes stay structurally disjoint",
    );
    assert.doesNotMatch(
      source,
      /dispatch-cost/,
      "drainer-loop.sh must never reference the /api/usage/dispatch-cost write path directly either",
    );
  });
});

describe("scripts/glm/drainer-loop.sh — run_driver() invokes the COMMITTED driver file, not a regenerated /tmp heredoc (issue #4371)", () => {
  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

  test("run_driver invokes the exact argv against the committed scripts/glm/drainer-driver.ts, and never writes a /tmp driver file", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-drainer-rundriver-"));
    try {
      const binDir = join(tmp, "bin");
      mkdirSync(binDir);
      // Fake `node` on PATH: echoes its own argv verbatim so the snippet can
      // assert the exact invocation run_driver() makes, without actually
      // spawning a real node process (and therefore without touching Redis
      // or claude at all).
      writeFileSync(
        join(binDir, "node"),
        `#!/usr/bin/env bash\necho "NODE_ARGV:$*"\nexit 0\n`,
        { mode: 0o755 },
      );
      const r = await runShellSnippet(
        { PATH: `${binDir}:${process.env.PATH}`, TMPDIR: tmp },
        `run_driver preflight /fake/changed-files.txt; echo "SNIPPET_EXIT:$?"`,
      );
      assert.match(r.combined, /SNIPPET_EXIT:0/, `expected run_driver to exit 0:\n${r.combined}`);
      assert.match(
        r.combined,
        new RegExp(
          `NODE_ARGV:--experimental-strip-types ${REPO_ROOT}/scripts/glm/drainer-driver\\.ts preflight /fake/changed-files\\.txt`,
        ),
        `expected the exact committed-driver argv:\n${r.combined}`,
      );
      // The heredoc-generated /tmp driver must no longer be written — the
      // committed file is invoked directly.
      const legacyDriverPath = join(tmp, "hydra-glm-drainer-driver.mts");
      assert.equal(
        existsSync(legacyDriverPath),
        false,
        "run_driver must never (re)write a /tmp driver file",
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("write_node_driver / node_driver_path no longer exist as functions", async () => {
    const r = await runShellSnippet(
      {},
      `declare -F write_node_driver >/dev/null 2>&1; echo "WND_EXIT:$?"; ` +
        `declare -F node_driver_path >/dev/null 2>&1; echo "NDP_EXIT:$?"`,
    );
    assert.match(r.combined, /WND_EXIT:1/, "write_node_driver must no longer be a defined function");
    assert.match(r.combined, /NDP_EXIT:1/, "node_driver_path must no longer be a defined function");
  });

  test("real-process smoke: the committed entrypoint resolves its import graph and exits 1 with the fault prefix on an unknown mode", async () => {
    const driverPath = join(REPO_ROOT, "scripts", "glm", "drainer-driver.ts");
    const result = await new Promise<{ status: number | null; combined: string }>((resolve, reject) => {
      const child = spawn("node", ["--experimental-strip-types", driverPath, "no-such-mode"]);
      let combined = "";
      child.stdout.on("data", (d) => { combined += d.toString(); });
      child.stderr.on("data", (d) => { combined += d.toString(); });
      child.on("error", reject);
      child.on("close", (code) => resolve({ status: code, combined }));
    });
    assert.equal(result.status, 1, `expected exit 1:\n${result.combined}`);
    assert.match(result.combined, /glm-drainer driver threw: unknown mode: no-such-mode/);
  });
});

// ---------------------------------------------------------------------------
// issue #4286 — is_grill_clear(): the picker's admission gate, the
// drainer-side MIRROR of collect-state.sh's MECHANICAL (#1230) / TRIVIAL
// (#1088) by-construction exemptions. The deadlock this closes: six
// cleanup-scan glm-eligible issues sat unreachable by BOTH lanes — dev_orch
// never saw them (subtracted as withheld-for-GLM while the drainer heartbeat
// was fresh) and the drainer demanded the approved artifact that the
// exemption exists to skip. The mirror is pinned two ways: reciprocal
// comments at both gate blocks, and this golden-fixture parity describe
// (design INV-6 / INV-7). Top-level on purpose — never nested under a
// sibling suite's lifecycle; each test below owns its fixture server and
// tmp dir in try/finally.
// ---------------------------------------------------------------------------

describe("scripts/glm/drainer-loop.sh — is_grill_clear() mirrors collect-state.sh's by-construction exemptions (issue #4286)", () => {
  /**
   * Serve arbitrary per-issue artifact statuses (default "pending") so the
   * fall-through arm can be told apart from the exemption arms (the sibling
   * designConceptServer helper above only speaks approved/pending — INV-2's
   * draft case needs a third string, and this suite deliberately does not
   * touch the shared helper the older describes use).
   */
  function designConceptStatusServer(
    statuses: Record<number, string>,
  ): Promise<{ url: string; close: () => void }> {
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        res.setHeader("content-type", "application/json");
        const m = /\/issue-(\d+)$/.exec(req.url ?? "");
        const n = m ? Number(m[1]) : NaN;
        res.end(JSON.stringify({ status: statuses[n] ?? "pending" }));
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as any;
        resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => server.close() });
      });
    });
  }

  // A port nothing listens on. is_grill_clear() must decide the two
  // by-construction arms from the already-fetched rows alone (design INV-3:
  // the API is consulted ONLY on fall-through) — pointing the override here
  // proves no round-trip happens: a wrong implementation that curled first
  // would fail closed and return none, failing these assertions.
  const UNREACHABLE_DC_URL = "http://127.0.0.1:1/api/design-concepts";

  /**
   * Fake gh for the grill-clear picker tests: `gh issue list` cats a fixture
   * (now carrying `body` — the picker's --json field list gained it), and the
   * two `gh pr list` calls (open / --state merged) each cat their own
   * fixture, mirroring fakeGhForMergedPicker's arg dispatch.
   */
  function fakeGhForGrillClearPicker(): string {
    return `#!/usr/bin/env bash
set -u
if [[ "\${1:-}" == "issue" && "\${2:-}" == "list" ]]; then
  cat "$FAKE_GH_ISSUE_LIST_FILE"
  exit 0
fi
if [[ "\${1:-}" == "pr" && "\${2:-}" == "list" ]]; then
  for a in "$@"; do
    if [[ "$a" == "merged" ]]; then
      cat "$FAKE_GH_MERGED_PR_LIST_FILE"
      exit 0
    fi
  done
  cat "$FAKE_GH_PR_LIST_FILE"
  exit 0
fi
echo "fake gh (grill-clear picker test): unhandled args: $*" >&2
exit 1
`;
  }

  function setupGrillClearPicker(
    tmp: string,
    issues: unknown[],
    openPrs: unknown[],
    mergedPrs: unknown[],
  ): Record<string, string> {
    const binDir = join(tmp, "bin");
    mkdirSync(binDir);
    writeFileSync(join(binDir, "gh"), fakeGhForGrillClearPicker(), { mode: 0o755 });
    const issueListFile = join(tmp, "issues.json");
    writeFileSync(issueListFile, JSON.stringify(issues));
    const prListFile = join(tmp, "prs-open.json");
    writeFileSync(prListFile, JSON.stringify(openPrs));
    const mergedPrListFile = join(tmp, "prs-merged.json");
    writeFileSync(mergedPrListFile, JSON.stringify(mergedPrs));
    return {
      PATH: `${binDir}:${process.env.PATH}`,
      FAKE_GH_ISSUE_LIST_FILE: issueListFile,
      FAKE_GH_PR_LIST_FILE: prListFile,
      FAKE_GH_MERGED_PR_LIST_FILE: mergedPrListFile,
    };
  }

  /** Drive is_grill_clear directly over the ROWS_JSON env fixture; echo the reason. */
  function grillClearSnippet(issue: number): string {
    return `reason=$(is_grill_clear ${issue} "$ROWS_JSON"); echo "REASON:$reason"`;
  }

  test("golden table: the by-construction arms admit WITHOUT consulting the design-concepts API (INV-1, INV-3)", async () => {
    // The ten golden cases the grill verified against collect-state.sh's own
    // python gate — the five positive-exemption ones here, with the artifact
    // URL pointed at a dead port so a curl proves the arm never fired.
    const cases = [
      {
        name: "cleanup-scan label",
        issue: 1,
        rows: [{ number: 1, updatedAt: "2026-08-01T00:00:00Z", labels: [{ name: "cleanup-scan" }], body: "Remove the dead export." }],
        want: "cleanup-scan-label",
      },
      {
        name: "Expected tier: T1 stamp",
        issue: 2,
        rows: [{ number: 2, updatedAt: "2026-08-01T00:00:00Z", labels: [], body: "Tweak the lesson file.\n\nExpected tier: T1" }],
        want: "expected-tier-t1",
      },
      {
        name: "Expected tier: 1 stamp",
        issue: 3,
        rows: [{ number: 3, updatedAt: "2026-08-01T00:00:00Z", labels: [], body: "Expected tier: 1" }],
        want: "expected-tier-t1",
      },
      {
        name: "lowercase expected tier: t1 stamp",
        issue: 4,
        rows: [{ number: 4, updatedAt: "2026-08-01T00:00:00Z", labels: [], body: "expected tier: t1" }],
        want: "expected-tier-t1",
      },
      {
        name: "cleanup-scan + needs-design-concept — the label arm is unconditional (#1230 parity)",
        issue: 5,
        rows: [{
          number: 5,
          updatedAt: "2026-08-01T00:00:00Z",
          labels: [{ name: "cleanup-scan" }, { name: "needs-design-concept" }],
          body: "Remove the dead export.",
        }],
        want: "cleanup-scan-label",
      },
    ];
    for (const c of cases) {
      const r = await runShellSnippet(
        { ROWS_JSON: JSON.stringify(c.rows), HYDRA_GLM_DRAINER_DESIGN_CONCEPT_URL: UNREACHABLE_DC_URL },
        grillClearSnippet(c.issue),
      );
      assert.match(
        r.combined,
        new RegExp(`^REASON:${c.want}$`, "m"),
        `case "${c.name}" — expected reason ${c.want}:\n${r.combined}`,
      );
    }
  });

  test("golden table: non-exempt shapes yield none via the fall-through (fail direction, INV-8)", async () => {
    // The remaining golden cases: every shape collect-state.sh would still
    // grill must fall through to the (here pending) artifact check and print
    // none — the exemption can never manufacture a spurious admission.
    const dc = await designConceptStatusServer({});
    try {
      const cases: Array<{ name: string; issue: number; rows: string }> = [
        {
          name: "T1 stamp + needs-design-concept label (fail-toward-grill)",
          issue: 6,
          rows: JSON.stringify([{ number: 6, updatedAt: "2026-08-01T00:00:00Z", labels: [{ name: "needs-design-concept" }], body: "Expected tier: T1" }]),
        },
        {
          name: "Expected tier: T12 — word boundary holds",
          issue: 7,
          rows: JSON.stringify([{ number: 7, updatedAt: "2026-08-01T00:00:00Z", labels: [], body: "Expected tier: T12" }]),
        },
        {
          name: "Expected tier: T3 — not trivial",
          issue: 8,
          rows: JSON.stringify([{ number: 8, updatedAt: "2026-08-01T00:00:00Z", labels: [], body: "Expected tier: T3" }]),
        },
        {
          name: "empty body, no labels",
          issue: 9,
          rows: JSON.stringify([{ number: 9, updatedAt: "2026-08-01T00:00:00Z", labels: [], body: "" }]),
        },
        {
          name: "null body",
          issue: 10,
          rows: JSON.stringify([{ number: 10, updatedAt: "2026-08-01T00:00:00Z", labels: [], body: null }]),
        },
        {
          name: "row absent from rows",
          issue: 11,
          rows: JSON.stringify([{ number: 99, updatedAt: "2026-08-01T00:00:00Z", labels: [], body: "Expected tier: T1" }]),
        },
        {
          name: "malformed rows JSON",
          issue: 12,
          rows: "not-json",
        },
      ];
      for (const c of cases) {
        const r = await runShellSnippet(
          { ROWS_JSON: c.rows, HYDRA_GLM_DRAINER_DESIGN_CONCEPT_URL: dc.url },
          grillClearSnippet(c.issue),
        );
        assert.match(
          r.combined,
          /^REASON:none$/m,
          `case "${c.name}" — expected none (fall through to artifact check):\n${r.combined}`,
        );
      }
    } finally {
      dc.close();
    }
  });

  test("golden table: fall-through keeps strict approved-only semantics — approved => approved-artifact, draft => none (INV-2)", async () => {
    const dc = await designConceptStatusServer({ 21: "approved", 22: "draft" });
    try {
      const rows = JSON.stringify([
        { number: 21, updatedAt: "2026-08-01T00:00:00Z", labels: [], body: "A plain issue body." },
        { number: 22, updatedAt: "2026-08-02T00:00:00Z", labels: [], body: "Another plain issue body." },
      ]);
      const approved = await runShellSnippet(
        { ROWS_JSON: rows, HYDRA_GLM_DRAINER_DESIGN_CONCEPT_URL: dc.url },
        grillClearSnippet(21),
      );
      assert.match(approved.combined, /^REASON:approved-artifact$/m, approved.combined);
      const draft = await runShellSnippet(
        { ROWS_JSON: rows, HYDRA_GLM_DRAINER_DESIGN_CONCEPT_URL: dc.url },
        grillClearSnippet(22),
      );
      assert.match(draft.combined, /^REASON:none$/m, `a fresh draft must NOT admit (INV-2):\n${draft.combined}`);
    } finally {
      dc.close();
    }
  });

  test("picker end-to-end: a cleanup-scan candidate is picked and logged grill-clear: cleanup-scan-label — the API is never consulted", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-drainer-grillclear-cs-"));
    try {
      const env = setupGrillClearPicker(
        tmp,
        [{
          number: 30,
          updatedAt: "2026-08-01T00:00:00Z",
          labels: [{ name: "cleanup-scan" }],
          body: "Remove the unused export; verified by npm test.",
        }],
        [],
        [],
      );
      const r = await runShellSnippet(
        { ...env, HYDRA_GLM_DRAINER_DESIGN_CONCEPT_URL: UNREACHABLE_DC_URL },
        `pick_eligible_issue; echo "SNIPPET_EXIT:$?"`,
      );
      assert.match(r.combined, /^30$/m, `expected #30 to be picked:\n${r.combined}`);
      assert.match(r.combined, /picked issue #30 \(grill-clear: cleanup-scan-label\)/, r.combined);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("picker end-to-end: a T1-stamped candidate is picked and logged grill-clear: expected-tier-t1", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-drainer-grillclear-t1-"));
    try {
      const env = setupGrillClearPicker(
        tmp,
        [{
          number: 30,
          updatedAt: "2026-08-01T00:00:00Z",
          labels: [],
          body: "Adjust the prompt template wording.\n\nExpected tier: T1",
        }],
        [],
        [],
      );
      const r = await runShellSnippet(
        { ...env, HYDRA_GLM_DRAINER_DESIGN_CONCEPT_URL: UNREACHABLE_DC_URL },
        `pick_eligible_issue; echo "SNIPPET_EXIT:$?"`,
      );
      assert.match(r.combined, /^30$/m, `expected #30 to be picked:\n${r.combined}`);
      assert.match(r.combined, /picked issue #30 \(grill-clear: expected-tier-t1\)/, r.combined);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("picker end-to-end: a T1-stamped candidate carrying needs-design-concept is NOT picked; the approved-artifact sibling is", async () => {
    const dc = await designConceptStatusServer({ 30: "pending", 31: "approved" });
    const tmp = mkdtempSync(join(tmpdir(), "glm-drainer-grillclear-ndc-"));
    try {
      const env = setupGrillClearPicker(
        tmp,
        [
          {
            number: 30,
            updatedAt: "2026-08-01T00:00:00Z",
            labels: [{ name: "needs-design-concept" }],
            body: "Expected tier: T1",
          },
          { number: 31, updatedAt: "2026-08-02T00:00:00Z", labels: [], body: "Plain body, approved artifact." },
        ],
        [],
        [],
      );
      const r = await runShellSnippet(
        { ...env, HYDRA_GLM_DRAINER_DESIGN_CONCEPT_URL: dc.url },
        `pick_eligible_issue; echo "SNIPPET_EXIT:$?"`,
      );
      assert.doesNotMatch(r.combined, /^30$/m, `#30 (T1 + needs-design-concept) must not be picked:\n${r.combined}`);
      assert.match(r.combined, /^31$/m, `expected #31 to be picked instead:\n${r.combined}`);
      assert.match(r.combined, /picked issue #31 \(grill-clear: approved-artifact\)/, r.combined);
    } finally {
      dc.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("picker end-to-end: a plain candidate with a DRAFT artifact is NOT picked (INV-2 — no fresh-draft arm)", async () => {
    const dc = await designConceptStatusServer({ 30: "draft" });
    const tmp = mkdtempSync(join(tmpdir(), "glm-drainer-grillclear-draft-"));
    try {
      const env = setupGrillClearPicker(
        tmp,
        [{ number: 30, updatedAt: "2026-08-01T00:00:00Z", labels: [], body: "Plain body, draft artifact." }],
        [],
        [],
      );
      const r = await runShellSnippet(
        { ...env, HYDRA_GLM_DRAINER_DESIGN_CONCEPT_URL: dc.url },
        `pick_eligible_issue; echo "SNIPPET_EXIT:$?"`,
      );
      assert.match(r.combined, /SNIPPET_EXIT:0/, r.combined);
      assert.doesNotMatch(r.combined, /^30$/m, `a draft artifact must not admit #30:\n${r.combined}`);
      assert.doesNotMatch(r.combined, /picked issue/, r.combined);
    } finally {
      dc.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("picker end-to-end: the open-PR skip (#3900) still wins over the cleanup-scan exemption", async () => {
    const dc = await designConceptStatusServer({ 31: "approved" });
    const tmp = mkdtempSync(join(tmpdir(), "glm-drainer-grillclear-openpr-"));
    try {
      const env = setupGrillClearPicker(
        tmp,
        [
          {
            number: 30,
            updatedAt: "2026-08-01T00:00:00Z",
            labels: [{ name: "cleanup-scan" }],
            body: "Exempt, but someone is already on it.",
          },
          { number: 31, updatedAt: "2026-08-02T00:00:00Z", labels: [], body: "Plain body, approved artifact." },
        ],
        [{ number: 700, body: "Implements the cleanup.\n\nCloses #30" }],
        [],
      );
      const r = await runShellSnippet(
        { ...env, HYDRA_GLM_DRAINER_DESIGN_CONCEPT_URL: dc.url },
        `pick_eligible_issue; echo "SNIPPET_EXIT:$?"`,
      );
      assert.match(r.combined, /skipping issue #30 — an open PR already references it/, r.combined);
      assert.doesNotMatch(r.combined, /^30$/m, r.combined);
      assert.match(r.combined, /^31$/m, `expected #31 to be picked instead:\n${r.combined}`);
    } finally {
      dc.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("picker end-to-end: the merged-PR skip (#4130) still wins over the cleanup-scan exemption", async () => {
    const dc = await designConceptStatusServer({ 31: "approved" });
    const tmp = mkdtempSync(join(tmpdir(), "glm-drainer-grillclear-merged-"));
    try {
      const env = setupGrillClearPicker(
        tmp,
        [
          {
            number: 30,
            updatedAt: "2026-08-01T00:00:00Z",
            labels: [{ name: "cleanup-scan" }],
            body: "Exempt, but the work already shipped.",
          },
          { number: 31, updatedAt: "2026-08-02T00:00:00Z", labels: [], body: "Plain body, approved artifact." },
        ],
        [],
        [
          {
            number: 800,
            title: "chore: remove the dead export (#30) (#800)",
            body: "No closing keyword — only the title anchor.",
          },
        ],
      );
      const r = await runShellSnippet(
        { ...env, HYDRA_GLM_DRAINER_DESIGN_CONCEPT_URL: dc.url },
        `pick_eligible_issue; echo "SNIPPET_EXIT:$?"`,
      );
      assert.match(r.combined, /skipping issue #30 — a MERGED PR already references it/, r.combined);
      assert.doesNotMatch(r.combined, /^30$/m, r.combined);
      assert.match(r.combined, /^31$/m, `expected #31 to be picked instead:\n${r.combined}`);
    } finally {
      dc.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
