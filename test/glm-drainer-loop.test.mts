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
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
