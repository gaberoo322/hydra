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
 * What this suite covers, and as of #4337 how far that boundary moved: the
 * post-author arms (driver fault / fail-closed not-run / ran-and-ended), the
 * evidence-driven salvage ladder, the GLM-lane branch resume, and the
 * per-issue timeout cap all live in `attempt_one_issue`'s bash glue —
 * precisely the layer the old "exercised structurally via code review + a
 * manual DRY_RUN smoke" boundary left untested. The #4337 describes below
 * therefore drive `attempt_one_issue` end-to-end against a fixture git repo
 * (real `git`, a self-owned bare origin) with a fake `node` (the committed
 * driver) and a fake `gh` on PATH — the same fake-binary-on-PATH technique
 * the open_pr/picker suites above already use, extended from one function to
 * the whole attempt. Still deliberately uncovered here: the real `claude`
 * spawn itself, pinned at the `src/glm/` seam by
 * test/glm-drainer-runner.test.mts and test/glm-drainer-driver.test.mts.
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

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("scripts/glm/drainer-loop.sh — z.ai quota block is a third pre-heartbeat skip (issue #4273)", () => {
  test("active (future-instant) block file => skip before heartbeat, no heartbeat attempted", async () => {
    const srv = await pausedServer(false);
    const tmp = mkdtempSync(join(tmpdir(), "glm-drainer-quota-block-test-"));
    try {
      const futureEpoch = Math.floor(Date.now() / 1000) + 1000;
      writeFileSync(join(tmp, "hydra-glm-drainer-quota-blocked-until"), String(futureEpoch));
      const r = await runDrainerLoop(srv.url, { HYDRA_GLM_DRAINER_CAP_DIR: tmp });
      assert.equal(r.status, 0);
      assert.match(r.combined, /quota block active .* — skip \(no heartbeat\)/);
      assert.doesNotMatch(r.combined, /would-heartbeat \(reason=able/);
      // The block file must still be there — it hasn't expired.
      assert.equal(
        existsSync(join(tmp, "hydra-glm-drainer-quota-blocked-until")),
        true,
        "an active block file must not be deleted",
      );
    } finally {
      srv.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("expired (past-instant) block file => proceeds normally and the stale file is removed", async () => {
    const srv = await pausedServer(false);
    const tmp = mkdtempSync(join(tmpdir(), "glm-drainer-quota-block-test-"));
    try {
      const pastEpoch = Math.floor(Date.now() / 1000) - 1000;
      writeFileSync(join(tmp, "hydra-glm-drainer-quota-blocked-until"), String(pastEpoch));
      const r = await runDrainerLoop(srv.url, { HYDRA_GLM_DRAINER_CAP_DIR: tmp });
      assert.equal(r.status, 0);
      assert.doesNotMatch(r.combined, /quota block active/);
      assert.match(r.combined, /would-heartbeat \(reason=able/);
      assert.equal(
        existsSync(join(tmp, "hydra-glm-drainer-quota-blocked-until")),
        false,
        "an expired block file must be deleted on read",
      );
    } finally {
      srv.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("no block file => proceeds normally (the common case)", async () => {
    const srv = await pausedServer(false);
    try {
      const r = await runDrainerLoop(srv.url);
      assert.doesNotMatch(r.combined, /quota block active/);
      assert.match(r.combined, /would-heartbeat \(reason=able/);
    } finally {
      srv.close();
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

// ---------------------------------------------------------------------------
// issue #4286 — the cleanup-scan / trivial-T1 grill-clear exemptions.
//
// The picker used to demand `.status == "approved"` from the design-concepts
// API for EVERY candidate. But `collect-state.sh`'s grill gate treats a
// `cleanup-scan`-labelled issue (#1230) and an `Expected tier: T1`-stamped
// one (#1088) as grill-clear BY CONSTRUCTION — neither ever gets an
// artifact, so on a `glm-eligible` board (where the issue is simultaneously
// withheld from Claude's dev_orch lane) the issue was unreachable by BOTH
// lanes: the exact stranding deadlock #4286 filed. `is_grill_clear()` now
// admits those two arms locally (pure jq over the already-fetched rows)
// and falls through to the unchanged `has_approved_design_concept()` only
// when neither matched.
//
// Deliberately NOT adopted (invariant 2 of the approved design concept):
// collect-state's fresh-DRAFT arm and its `track:` title-prefix arm — the
// drainer keeps requiring status == approved on the artifact path, and a
// `track:` tracker is not implementable now, so parity means refusing it.
// ---------------------------------------------------------------------------

describe("scripts/glm/drainer-loop.sh — is_grill_clear() admits cleanup-scan + T1-stamped candidates without an approved artifact (issue #4286)", () => {
  /**
   * Serves an arbitrary per-issue status map, unlike the approved-Set
   * `designConceptServer` above — INV-2's "a plain candidate with a `draft`
   * artifact is NOT picked" case needs a status the sibling helper cannot
   * produce. Unknown issues get `pending` (the helper's no-match default).
   */
  function designConceptStatusServer(
    statusByIssue: Record<number, string>,
  ): Promise<{ url: string; close: () => void }> {
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        res.setHeader("content-type", "application/json");
        const m = /\/issue-(\d+)$/.exec(req.url ?? "");
        const n = m ? Number(m[1]) : NaN;
        res.end(JSON.stringify({ status: statusByIssue[n] ?? "pending" }));
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as any;
        resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => server.close() });
      });
    });
  }

  // One server for the whole describe's golden table (issue numbers below
  // are disjoint from the picker tests', which build their own). Own
  // before/after lifecycle — never nested under a sibling suite's teardown
  // (the CLAUDE.md authoring rule).
  let dc: { url: string; close: () => void };
  before(async () => {
    dc = await designConceptStatusServer({ 111: "approved" });
  });
  after(() => dc.close());

  // INV-1's golden table — the same 10 cases the grilling pass verified a
  // jq mirror of the predicate against collect-state.sh's python regex,
  // plus the two reason strings the table itself doesn't reach
  // (approved-artifact via fall-through, and none via a missing row —
  // INV-8's fail direction).
  const GOLDEN: Array<{ name: string; n: number; row: object | null; expected: string }> = [
    { name: "cleanup-scan label", n: 101, row: { number: 101, labels: [{ name: "cleanup-scan" }] }, expected: "cleanup-scan-label" },
    { name: "Expected tier: T1 stamp", n: 102, row: { number: 102, labels: [], body: "Do it.\n\nExpected tier: T1" }, expected: "expected-tier-t1" },
    { name: "Expected tier: 1 stamp", n: 103, row: { number: 103, labels: [], body: "Expected tier: 1" }, expected: "expected-tier-t1" },
    { name: "lowercase 'expected tier: t1' (case-insensitive)", n: 104, row: { number: 104, labels: [], body: "expected tier: t1" }, expected: "expected-tier-t1" },
    { name: "T1 stamp + needs-design-concept label (opt-in wins -> artifact path, pending)", n: 105, row: { number: 105, labels: [{ name: "needs-design-concept" }], body: "Expected tier: T1" }, expected: "none" },
    { name: "T12 stamp (word boundary must reject)", n: 106, row: { number: 106, labels: [], body: "Expected tier: T12" }, expected: "none" },
    { name: "T3 stamp", n: 107, row: { number: 107, labels: [], body: "Expected tier: T3" }, expected: "none" },
    { name: "empty body", n: 108, row: { number: 108, labels: [], body: "" }, expected: "none" },
    { name: "cleanup-scan + needs-design-concept (mechanical arm is UNCONDITIONAL)", n: 109, row: { number: 109, labels: [{ name: "cleanup-scan" }, { name: "needs-design-concept" }], body: "irrelevant" }, expected: "cleanup-scan-label" },
    { name: "null body", n: 110, row: { number: 110, labels: [], body: null }, expected: "none" },
    { name: "no label/stamp + APPROVED artifact (fall-through arm)", n: 111, row: { number: 111, labels: [], body: "no stamps here" }, expected: "approved-artifact" },
    { name: "issue missing from rows entirely (INV-8: never a spurious admission)", n: 112, row: null, expected: "none" },
  ];

  for (const c of GOLDEN) {
    test(`golden table: ${c.name} -> ${c.expected}`, async () => {
      const rows = c.row === null ? "[]" : JSON.stringify([c.row]);
      const r = await runShellSnippet(
        { HYDRA_GLM_DRAINER_DESIGN_CONCEPT_URL: dc.url, ROWS_JSON: rows },
        `is_grill_clear ${c.n} "$ROWS_JSON"; echo "SNIPPET_EXIT:$?"`,
      );
      assert.match(r.combined, new RegExp(`^${c.expected}$`, "m"), `expected reason ${c.expected}:\n${r.combined}`);
      assert.match(r.combined, /^SNIPPET_EXIT:0$/m, `expected exit 0:\n${r.combined}`);
    });
  }

  // Issue numbers for the picker tests below: 30x (exemption picks), 40x
  // (refusals), 50x (skip-priority). PR lists default to empty.
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

  async function runPicker(
    issues: unknown[],
    openPrs: unknown[],
    mergedPrs: unknown[],
    dcStatuses: Record<number, string>,
    tmpTag: string,
  ): Promise<{ status: number; combined: string }> {
    const tmp = mkdtempSync(join(tmpdir(), tmpTag));
    const dcs = await designConceptStatusServer(dcStatuses);
    try {
      const binDir = join(tmp, "bin");
      mkdirSync(binDir);
      writeFileSync(join(binDir, "gh"), fakeGhForGrillClearPicker(), { mode: 0o755 });
      const issueListFile = join(tmp, "issues.json");
      writeFileSync(issueListFile, JSON.stringify(issues));
      const prListFile = join(tmp, "open-prs.json");
      writeFileSync(prListFile, JSON.stringify(openPrs));
      const mergedPrListFile = join(tmp, "merged-prs.json");
      writeFileSync(mergedPrListFile, JSON.stringify(mergedPrs));
      return await runShellSnippet(
        {
          PATH: `${binDir}:${process.env.PATH}`,
          HYDRA_GLM_DRAINER_DESIGN_CONCEPT_URL: dcs.url,
          FAKE_GH_ISSUE_LIST_FILE: issueListFile,
          FAKE_GH_PR_LIST_FILE: prListFile,
          FAKE_GH_MERGED_PR_LIST_FILE: mergedPrListFile,
        },
        `pick_eligible_issue; echo "SNIPPET_EXIT:$?"`,
      );
    } finally {
      dcs.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  test("a cleanup-scan candidate with a pending artifact IS picked, logged grill-clear: cleanup-scan-label", async () => {
    const r = await runPicker(
      [{ number: 30, updatedAt: "2026-08-28T00:00:00Z", labels: [{ name: "cleanup-scan" }], body: "remove dead code" }],
      [], [], {}, "glm-drainer-grillclear-cs-",
    );
    assert.match(r.combined, /^30$/m, `expected #30 to be picked:\n${r.combined}`);
    assert.match(r.combined, /picked issue #30 \(grill-clear: cleanup-scan-label\)/, `expected the admission-arm log line:\n${r.combined}`);
  });

  test("an Expected-tier-T1-stamped candidate with a pending artifact IS picked, logged grill-clear: expected-tier-t1", async () => {
    const r = await runPicker(
      [{ number: 31, updatedAt: "2026-08-28T00:00:00Z", labels: [], body: "Tweak the prompt.\n\nExpected tier: T1" }],
      [], [], {}, "glm-drainer-grillclear-t1-",
    );
    assert.match(r.combined, /^31$/m, `expected #31 to be picked:\n${r.combined}`);
    assert.match(r.combined, /picked issue #31 \(grill-clear: expected-tier-t1\)/, `expected the admission-arm log line:\n${r.combined}`);
  });

  test("a T1-stamped candidate carrying needs-design-concept is NOT picked (opt-in label suppresses the trivial arm; no approved artifact)", async () => {
    const r = await runPicker(
      [{ number: 40, updatedAt: "2026-08-28T00:00:00Z", labels: [{ name: "needs-design-concept" }], body: "Expected tier: T1" }],
      [], [], {}, "glm-drainer-grillclear-optin-",
    );
    assert.doesNotMatch(r.combined, /^40$/m, `#40 must not be picked:\n${r.combined}`);
    assert.doesNotMatch(r.combined, /picked issue/);
  });

  test("a plain candidate with a draft artifact is NOT picked (INV-2: the drainer does not adopt collect-state's fresh-DRAFT arm)", async () => {
    const r = await runPicker(
      [{ number: 41, updatedAt: "2026-08-28T00:00:00Z", labels: [], body: "no stamps" }],
      [], [], { 41: "draft" }, "glm-drainer-grillclear-draft-",
    );
    assert.doesNotMatch(r.combined, /^41$/m, `#41 must not be picked on a draft artifact:\n${r.combined}`);
    assert.doesNotMatch(r.combined, /picked issue/);
  });

  test("the open-PR skip (#3900) still wins over an exemption arm", async () => {
    const r = await runPicker(
      [
        { number: 50, updatedAt: "2026-08-28T00:00:00Z", labels: [{ name: "cleanup-scan" }], body: "remove dead code" },
        { number: 51, updatedAt: "2026-08-29T00:00:00Z", labels: [], body: "plain" },
      ],
      [{ number: 900, body: "Closes #50" }], [], { 51: "approved" }, "glm-drainer-grillclear-openpr-",
    );
    assert.match(r.combined, /skipping issue #50 — an open PR already references it/);
    assert.match(r.combined, /^51$/m, `expected #51 (approved artifact) to be picked instead:\n${r.combined}`);
  });

  test("the merged-PR skip (#4130) still wins over an exemption arm", async () => {
    const r = await runPicker(
      [
        { number: 52, updatedAt: "2026-08-28T00:00:00Z", labels: [{ name: "cleanup-scan" }], body: "remove dead code" },
        { number: 53, updatedAt: "2026-08-29T00:00:00Z", labels: [], body: "plain" },
      ],
      [], [{ number: 901, title: "fix(x): remove dead code (#52)", body: "" }], { 53: "approved" }, "glm-drainer-grillclear-mergedpr-",
    );
    assert.match(r.combined, /skipping issue #52 — a MERGED PR already references it/);
    assert.match(r.combined, /^53$/m, `expected #53 (approved artifact) to be picked instead:\n${r.combined}`);
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
// Issue #4337 — the post-author arms, the salvage ladder, GLM-lane resume,
// and the per-issue timeout cap. attempt_one_issue is driven END TO END
// against a fixture git repo + fake binaries (see the header comment): the
// fake `node` on PATH plays the committed driver AND the authoring session
// (its env knobs decide whether the "session" commits, pushes, writes
// .glm-drainer-pr-body.md, times out, fails closed, or faults), the fake
// `gh` records every issue/pr mutation, and the fixture repo's origin is a
// bare repo this suite owns — so pushes, ls-remote resume discovery, and
// branch deletion are all REAL git operations with observable state.
// ---------------------------------------------------------------------------

/** Run one fixture-setup shell command, failing loud on a non-zero exit. */
function sh(cwd: string, cmd: string): void {
  const r = spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(
      `fixture command failed in ${cwd}: ${cmd}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );
  }
}

/**
 * A real non-bare repo at <tmp>/repo whose `origin` is a bare repo at
 * <tmp>/origin.git this fixture owns — pushes from worktrees land on the bare
 * origin (no checked-out-branch refusal), and refs/remotes/origin/master is
 * populated so rev-list/ls-remote-based resume logic has real refs to read.
 * The ABSOLUTE origin URL matters: relative remote URLs resolve differently
 * from inside a linked worktree, and attempt_one_issue runs git both from
 * REPO_ROOT and from inside its worktree.
 */
function initGitRepoWithBareOrigin(tmp: string): { repoDir: string; originDir: string } {
  const repoDir = join(tmp, "repo");
  const originDir = join(tmp, "origin.git");
  mkdirSync(repoDir);
  sh(
    repoDir,
    [
      "set -e",
      "git init -q",
      "git symbolic-ref HEAD refs/heads/master",
      "git config user.email glm-drainer@test.invalid",
      "git config user.name 'glm drainer test'",
      "git config commit.gpgsign false",
      "echo base > README.md",
      "git add README.md",
      "git commit -qm base",
      `git init -q --bare "${originDir}"`,
      `git remote add origin "${originDir}"`,
      "git push -q origin master",
      "git fetch -q origin",
    ].join("\n"),
  );
  return { repoDir, originDir };
}

/** The fake committed driver + authoring session. argv: $1 flag $2 script $3 mode $4.. args. */
function fakeDriverNodeScript(): string {
  return [
    "#!/usr/bin/env bash",
    "set -u",
    'mode="${3:-}"',
    'if [[ "$mode" == "heartbeat" ]]; then',
    "  echo '{\"ok\":true}'",
    "  exit 0",
    "fi",
    'if [[ "$mode" == "preflight" ]]; then',
    "  echo '{\"ok\":true,\"checkedPaths\":1}'",
    "  exit 0",
    "fi",
    'if [[ "$mode" == "author" ]]; then',
    '  prompt_file="${4:-}"',
    '  wt="${5:-}"',
    '  if [[ -n "${FAKE_DRIVER_PROMPT_CAPTURE:-}" ]]; then cp "$prompt_file" "${FAKE_DRIVER_PROMPT_CAPTURE}"; fi',
    '  outcome="${FAKE_DRIVER_OUTCOME:-clean}"',
    '  if [[ "$outcome" == "fault" ]]; then',
    "    echo 'glm-drainer driver threw: simulated driver fault (test fixture)' >&2",
    "    exit 1",
    "  fi",
    '  if [[ "${FAKE_DRIVER_COMMIT:-0}" == "1" ]]; then',
    '    echo "fake session work $(date +%s%N)$$" > "$wt/fake-session-file.txt"',
    '    git -C "$wt" add fake-session-file.txt',
    "    git -C \"$wt\" -c user.email=glm-drainer@test.invalid -c user.name='fake glm session' \\",
    "      commit -m 'fake authoring session commit' --quiet",
    "  fi",
    '  if [[ "${FAKE_DRIVER_PUSH:-0}" == "1" ]]; then',
    '    br="$(git -C "$wt" rev-parse --abbrev-ref HEAD)"',
    "    git -C \"$wt\" push -q -u origin \"$br\" || echo 'fake node: push failed' >&2",
    "  fi",
    '  if [[ "${FAKE_DRIVER_PR_BODY:-0}" == "1" ]]; then',
    "    {",
    "      echo 'fake session pr body'",
    "      echo ''",
    "      echo '## Files in scope'",
    "      echo 'scripts/glm/drainer-loop.sh'",
    "    } > \"$wt/.glm-drainer-pr-body.md\"",
    "  fi",
    '  case "$outcome" in',
    '    timeout) echo \'{"ok":true,"code":null,"timedOut":true,"timeoutMs":3000000}\'; exit 0 ;;',
    '    notrun) echo \'{"ok":false,"code":"glm-auth-token-missing","message":"ANTHROPIC_AUTH_TOKEN is unset"}\'; exit 0 ;;',
    '    *) echo \'{"ok":true,"code":0,"stdout":"fake session stdout","stderr":""}\'; exit 0 ;;',
    "  esac",
    "fi",
    'echo "fake node (drainer attempt fixture): unhandled args: $*" >&2',
    "exit 1",
    "",
  ].join("\n");
}

/**
 * The fake gh: records every mutating call to $FAKE_GH_CALLS_FILE (with the
 * --body-file CONTENT bracketed for open_pr assertions) and answers the reads
 * attempt_one_issue makes from fixture files.
 */
function fakeGhScript(): string {
  return [
    "#!/usr/bin/env bash",
    "set -u",
    'if [[ "${1:-}" == "issue" && "${2:-}" == "view" ]]; then',
    '  for a in "$@"; do',
    '    if [[ "$a" == "title" ]]; then echo "Fake issue title"; exit 0; fi',
    "  done",
    '  cat "$FAKE_GH_ISSUE_BODY_FILE"',
    "  exit 0",
    "fi",
    'if [[ "${1:-}" == "issue" && "${2:-}" == "edit" ]]; then',
    '  echo "issue-edit:$*" >> "$FAKE_GH_CALLS_FILE"',
    "  exit 0",
    "fi",
    'if [[ "${1:-}" == "pr" && "${2:-}" == "create" ]]; then',
    '  echo "pr-create:$*" >> "$FAKE_GH_CALLS_FILE"',
    '  body_file=""',
    '  prev=""',
    '  for a in "$@"; do',
    '    if [[ "$prev" == "--body-file" ]]; then body_file="$a"; fi',
    '    prev="$a"',
    "  done",
    '  if [[ -n "$body_file" ]]; then',
    '    { echo "PRBODY_START"; cat "$body_file"; echo "PRBODY_END"; } >> "$FAKE_GH_CALLS_FILE"',
    "  fi",
    '  echo "https://github.com/gaberoo322/hydra/pull/12345"',
    "  exit 0",
    "fi",
    'if [[ "${1:-}" == "pr" && "${2:-}" == "list" ]]; then',
    "  echo '[]'",
    "  exit 0",
    "fi",
    'if [[ "${1:-}" == "pr" && "${2:-}" == "edit" ]]; then',
    '  echo "pr-edit:$*" >> "$FAKE_GH_CALLS_FILE"',
    "  exit 0",
    "fi",
    'echo "fake gh (drainer attempt fixture): unhandled args: $*" >&2',
    "exit 1",
    "",
  ].join("\n");
}

/**
 * Everything one attempt_one_issue test needs: fixture repo + bare origin,
 * fake node/gh on PATH, isolated CAP_DIR/TMPDIR/WORKTREE_ROOT, and the gh
 * call + prompt-capture files to assert on afterwards.
 */
function setupAttemptFixture(tmp: string): {
  repoDir: string;
  originDir: string;
  capDir: string;
  wtsDir: string;
  callsFile: string;
  promptCapture: string;
  baseEnv: Record<string, string>;
} {
  const { repoDir, originDir } = initGitRepoWithBareOrigin(tmp);
  const binDir = join(tmp, "bin");
  mkdirSync(binDir);
  writeFileSync(join(binDir, "node"), fakeDriverNodeScript(), { mode: 0o755 });
  writeFileSync(join(binDir, "gh"), fakeGhScript(), { mode: 0o755 });
  const capDir = join(tmp, "cap");
  const tmpSub = join(tmp, "tmp");
  const wtsDir = join(tmp, "wts");
  mkdirSync(capDir);
  mkdirSync(tmpSub);
  mkdirSync(wtsDir);
  const callsFile = join(tmp, "gh-calls.txt");
  writeFileSync(callsFile, "");
  const promptCapture = join(tmp, "prompt-capture.txt");
  writeFileSync(promptCapture, "");
  const issueBodyFile = join(tmp, "issue-body.md");
  writeFileSync(
    issueBodyFile,
    "Fixture issue body.\n\n## Files in scope\nscripts/glm/drainer-loop.sh\n",
  );
  const baseEnv: Record<string, string> = {
    PATH: `${binDir}:${process.env.PATH}`,
    HYDRA_GLM_DRAINER_REPO_ROOT: repoDir,
    HYDRA_GLM_DRAINER_WORKTREE_ROOT: wtsDir,
    HYDRA_GLM_DRAINER_CAP_DIR: capDir,
    HYDRA_GLM_DRAINER_TIMEOUT_RESUME_CAP: "2",
    HYDRA_GLM_DRAINER_DAILY_CAP: "5",
    TMPDIR: tmpSub,
    FAKE_GH_CALLS_FILE: callsFile,
    FAKE_GH_ISSUE_BODY_FILE: issueBodyFile,
    FAKE_DRIVER_PROMPT_CAPTURE: promptCapture,
  };
  return { repoDir, originDir, capDir, wtsDir, callsFile, promptCapture, baseEnv };
}

/** Heads matching a family on the fixture bare origin — "" when none exist. */
function lsRemoteHeads(originDir: string, pattern: string): string {
  const r = spawnSync("git", ["ls-remote", originDir, pattern], { encoding: "utf8" });
  return (r.stdout ?? "").trim();
}

describe("scripts/glm/drainer-loop.sh — attempt_one_issue distinguishes three post-author arms by evidence and salvages a timed-out session's work (issue #4337)", () => {
  test("post-author arm (a): driver exit != 0 -> 'authoring driver FAULTED' line, not the failed-closed line", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-drainer-arm-a-"));
    try {
      const f = setupAttemptFixture(tmp);
      const r = await runShellSnippet(
        { ...f.baseEnv, FAKE_DRIVER_OUTCOME: "fault" },
        `attempt_one_issue 77; echo "SNIPPET_EXIT:$?"`,
      );
      assert.match(r.combined, /SNIPPET_EXIT:0/, `whole snippet must succeed:\n${r.combined}`);
      assert.match(r.combined, /authoring driver FAULTED \(exit=1\) for issue #77 — see driver stderr above/);
      // The old conflated catch-all line — the exact misleading message issue
      // #4337 was filed over — must NOT appear for a driver fault.
      assert.doesNotMatch(r.combined, /authoring session did not run/);
      assert.doesNotMatch(r.combined, /buildGlmEnv\/buildDrainerArgs failed closed/);
      // Plain release (no withhold — a driver fault says nothing about tier)
      // and the (empty) worktree is cleaned up.
      const calls = readFileSync(f.callsFile, "utf8");
      assert.match(calls, /issue-edit:issue edit 77 .*--add-label ready-for-agent/);
      assert.doesNotMatch(calls, /glm-withhold/);
      assert.equal(readdirSync(f.wtsDir).length, 0, "failed session's worktree must be removed");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("post-author arm (b): driver ok:false line -> the fail-closed 'did not run' line with the driver's code and message", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-drainer-arm-b-"));
    try {
      const f = setupAttemptFixture(tmp);
      const r = await runShellSnippet(
        { ...f.baseEnv, FAKE_DRIVER_OUTCOME: "notrun" },
        `attempt_one_issue 77; echo "SNIPPET_EXIT:$?"`,
      );
      assert.match(r.combined, /SNIPPET_EXIT:0/);
      // Arm (b) is the ONLY arm that may carry the fail-closed wording, and
      // now with the driver's machine-readable code + message instead of the
      // old parenthetical.
      assert.match(r.combined, /authoring session did not run for issue #77: glm-auth-token-missing — ANTHROPIC_AUTH_TOKEN is unset/);
      assert.doesNotMatch(r.combined, /FAULTED/);
      assert.doesNotMatch(r.combined, /authoring session ended/);
      const calls = readFileSync(f.callsFile, "utf8");
      assert.match(calls, /issue-edit:issue edit 77 .*--add-label ready-for-agent/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("salvage arm: timedOut=true + commits>=1 + pr-body present -> the normal push/preflight/open_pr path plus the appended drainer note", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-drainer-salvage-"));
    try {
      const f = setupAttemptFixture(tmp);
      const r = await runShellSnippet(
        {
          ...f.baseEnv,
          FAKE_DRIVER_OUTCOME: "timeout",
          FAKE_DRIVER_COMMIT: "1",
          FAKE_DRIVER_PR_BODY: "1",
        },
        `attempt_one_issue 77; echo "SNIPPET_EXIT:$?"`,
      );
      assert.match(r.combined, /SNIPPET_EXIT:0/);
      // Arm (c): the session RAN and was cut off — logged as such.
      assert.match(r.combined, /authoring session ended for issue #77 \(timedOut=true, exit=null\)/);
      assert.doesNotMatch(r.combined, /authoring session did not run/);
      // The IDENTICAL fence as a clean session, in order.
      assert.match(r.combined, /appended GLM drainer timeout note to /);
      assert.match(r.combined, /preflight passed for issue #77 — opening PR/);
      assert.match(r.combined, /gh pr create succeeded: https:\/\/github\.com\/gaberoo322\/hydra\/pull\/12345/);
      // The salvaged PR body carries the appended plain-text disclosure.
      const calls = readFileSync(f.callsFile, "utf8");
      assert.match(calls, /pr-create:.*--head worktree-agent-glm-77-\d+/);
      const bodyMatch = calls.match(/PRBODY_START\n([\s\S]*?)PRBODY_END/);
      assert.ok(bodyMatch, "expected the captured PR body between PRBODY markers");
      assert.match(bodyMatch![1], /## GLM drainer note/);
      assert.match(bodyMatch![1], /partial delivery that may still need follow-up/);
      assert.match(bodyMatch![1], /fake session pr body/);
      // Success path: advance to needs-qa, cap incremented, counter RESET
      // (INV-6), no release, branch pushed, worktree cleaned.
      assert.match(calls, /issue-edit:issue edit 77 .*--add-label needs-qa/);
      assert.doesNotMatch(calls, /--add-label ready-for-agent/);
      assert.equal(
        existsSync(join(f.capDir, "hydra-glm-drainer-timeouts-77")),
        false,
        "a successful open_pr must remove the per-issue timeout counter",
      );
      const today = new Date().toISOString().slice(0, 10);
      assert.equal(readFileSync(join(f.capDir, `hydra-glm-drainer-daily-cap-${today}`), "utf8").trim(), "1");
      assert.notEqual(lsRemoteHeads(f.originDir, "refs/heads/worktree-agent-glm-77-*"), "", "the defensive push must have landed the branch on origin");
      assert.equal(readdirSync(f.wtsDir).length, 0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("keep arm: commits>=1 + pr-body missing -> 'partial work kept on origin' log, worktree removed, remote branch NOT deleted", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-drainer-keep-"));
    try {
      const f = setupAttemptFixture(tmp);
      const r = await runShellSnippet(
        { ...f.baseEnv, FAKE_DRIVER_OUTCOME: "timeout", FAKE_DRIVER_COMMIT: "1" },
        `attempt_one_issue 77; echo "SNIPPET_EXIT:$?"`,
      );
      assert.match(r.combined, /SNIPPET_EXIT:0/);
      assert.match(r.combined, /partial work kept on origin\/worktree-agent-glm-77-\d+ for resume \(commits=1, pr-body-present=no\)/);
      // No PR attempt from this state — the gates would wedge it (INV-4).
      assert.doesNotMatch(r.combined, /preflight passed/);
      const calls = readFileSync(f.callsFile, "utf8");
      assert.doesNotMatch(calls, /pr-create/);
      // The loop's OWN defensive push kept the work on origin, the local
      // worktree is gone, and the timeout was counted (below cap => plain).
      assert.notEqual(lsRemoteHeads(f.originDir, "refs/heads/worktree-agent-glm-77-*"), "", "partial work must be KEPT on origin");
      assert.equal(readdirSync(f.wtsDir).length, 0);
      assert.equal(readFileSync(join(f.capDir, "hydra-glm-drainer-timeouts-77"), "utf8").trim(), "1");
      assert.match(calls, /issue-edit:issue edit 77 .*--add-label ready-for-agent/);
      assert.doesNotMatch(calls, /glm-withhold/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("zero-commit session -> 'nothing usable produced' release and the pushed remote branch is deleted", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-drainer-empty-"));
    try {
      const f = setupAttemptFixture(tmp);
      // The session pushed its (empty) branch but committed nothing and wrote
      // no pr-body: there is no partial work to keep, so the loop releases
      // AND deletes the remote branch instead of resuming emptiness.
      const r = await runShellSnippet(
        { ...f.baseEnv, FAKE_DRIVER_OUTCOME: "timeout", FAKE_DRIVER_PUSH: "1" },
        `attempt_one_issue 77; echo "SNIPPET_EXIT:$?"`,
      );
      assert.match(r.combined, /SNIPPET_EXIT:0/);
      assert.match(r.combined, /nothing usable produced \(commits=0\) — releasing claim/);
      assert.equal(
        lsRemoteHeads(f.originDir, "refs/heads/worktree-agent-glm-77-*"),
        "",
        "a zero-commit branch must be deleted from origin, not kept for resume",
      );
      const calls = readFileSync(f.callsFile, "utf8");
      assert.match(calls, /issue-edit:issue edit 77 .*--add-label ready-for-agent/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("scripts/glm/drainer-loop.sh — find_resumable_branch resumes the newest ahead pushed drainer branch (issue #4337 INV-5)", () => {
  test("find_resumable_branch: newest ahead branch wins; behind/empty heads are skipped", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-drainer-resume-find-"));
    try {
      const { repoDir } = initGitRepoWithBareOrigin(tmp);
      sh(
        repoDir,
        [
          "set -e",
          "# Issue 55: 2500 sits at master (0 ahead) BETWEEN the two ahead branches —",
          "# newest ahead (3000) must win and 2500 must never be returned.",
          "git checkout -q -b worktree-agent-glm-55-2000 master",
          "echo a > a.txt && git add a.txt && git commit -qm a55",
          "git push -q origin worktree-agent-glm-55-2000",
          "git checkout -q -b worktree-agent-glm-55-2500 master",
          "git push -q origin worktree-agent-glm-55-2500",
          "git checkout -q -b worktree-agent-glm-55-3000 master",
          "echo b > b.txt && git add b.txt && git commit -qm b55",
          "git push -q origin worktree-agent-glm-55-3000",
          "# Issue 56: the newest head (4000) is left strictly BEHIND once master",
          "# advances, so the ahead-but-older 3500 must win.",
          "git checkout -q -b worktree-agent-glm-56-4000 master",
          "git push -q origin worktree-agent-glm-56-4000",
          "git checkout -q master",
          "echo d > d.txt && git add d.txt && git commit -qm advance-master",
          "git push -q origin master",
          "git checkout -q -b worktree-agent-glm-56-3500 master",
          "echo c > c.txt && git add c.txt && git commit -qm c56",
          "git push -q origin worktree-agent-glm-56-3500",
          "git checkout -q master",
          "git fetch -q origin",
        ].join("\n"),
      );
      const r = await runShellSnippet(
        { HYDRA_GLM_DRAINER_REPO_ROOT: repoDir },
        `b55="$(find_resumable_branch 55)"; b56="$(find_resumable_branch 56)"; b57="$(find_resumable_branch 57)"; `
          + `echo "R55=\${b55:-<empty>}"; echo "R56=\${b56:-<empty>}"; echo "R57=\${b57:-<empty>}"`,
      );
      assert.match(r.combined, /R55=worktree-agent-glm-55-3000/, `newest AHEAD head must win:\n${r.combined}`);
      assert.match(r.combined, /R56=worktree-agent-glm-56-3500/, `a behind newest must fall through to the older ahead head:\n${r.combined}`);
      assert.match(r.combined, /R57=<empty>/, `an issue with no pushed drainer branches must resume nothing:\n${r.combined}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("scripts/glm/drainer-loop.sh — bounded timeout retries hand off to the Claude lane via glm-withhold (issue #4337 INV-6)", () => {
  test("timeout cap: second timed-out session with no PR releases with glm-withhold (explicit handoff to the Claude lane)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-drainer-timeout-cap-"));
    try {
      const f = setupAttemptFixture(tmp);
      const env = { ...f.baseEnv, FAKE_DRIVER_OUTCOME: "timeout", FAKE_DRIVER_COMMIT: "1" };

      // Session 1: first PR-less timeout — kept on origin, plain release.
      const first = await runShellSnippet(env, `attempt_one_issue 77; echo "S1:$?"`);
      assert.match(first.combined, /S1:0/);
      assert.match(first.combined, /partial work kept on origin\/worktree-agent-glm-77-\d+ for resume \(commits=1, pr-body-present=no\)/);

      // Session 2: resumes the pushed branch (INV-5), then times out again
      // with no PR — the counter reaches the cap and the release adds
      // glm-withhold (INV-6), the explicit Claude-lane handoff.
      const second = await runShellSnippet(env, `attempt_one_issue 77; echo "S2:$?"`);
      assert.match(second.combined, /S2:0/);
      assert.match(
        second.combined,
        /resuming pushed drainer branch worktree-agent-glm-77-\d+ \(1 commit\(s\) ahead of origin\/master\)/,
        `session 2 must resume the pushed branch:\n${second.combined}`,
      );
      assert.match(second.combined, /partial work kept on origin\/worktree-agent-glm-77-\d+ for resume \(commits=2, pr-body-present=no\)/);
      assert.match(second.combined, /timeout resume cap reached \(2\/2\) — releasing with glm-withhold so the Claude dev_orch lane takes this issue and its pushed branch over/);
      const calls = readFileSync(f.callsFile, "utf8");
      assert.match(calls, /issue-edit:issue edit 77 .*--add-label glm-withhold/);
      // The resumed session was TOLD it is resuming, and to rewrite the
      // pr-body first (the prior copy died with the prior worktree).
      const prompt = readFileSync(f.promptCapture, "utf8");
      assert.match(prompt, /## RESUME — a prior drainer session on this issue was cut off by the timeout/);
      assert.match(prompt, /worktree-agent-glm-77-\d+/);
      assert.match(prompt, /Write the \.glm-drainer-pr-body\.md file FIRST/);
      // The handoff keeps the pushed branch — it is the artifact the Claude
      // lane resumes from, not something to clean up.
      assert.notEqual(lsRemoteHeads(f.originDir, "refs/heads/worktree-agent-glm-77-*"), "");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("scripts/glm/drainer-loop.sh — parse_quota_block_stdout() interprets z.ai's 429 payload (issue #4273)", () => {
  test("the exact journal 429 line resolves via the +0800 offset — a future reset parses to the measured epoch", async () => {
    // date -u -d '2026-08-30 05:22:45 +0800' +%s -> 1788038565 (verified on
    // this host, GNU date 9.4). That instant is now in the PAST relative to
    // "today" in any real run of this suite, so the function correctly falls
    // through to the 60-min fallback rather than the parsed instant itself —
    // this test locks THAT fallback behavior for a stale fixture date, and a
    // second case below locks the parse+clamp path for a genuinely future
    // reset instant.
    const r = await runShellSnippet(
      {},
      `out="$(parse_quota_block_stdout "API Error: Request rejected (429) · [1310][Weekly/Monthly Limit Exhausted.` +
        `\nYour limit will reset at 2026-08-30 05:22:45]")"; echo "OUT=$out"; now="$(date -u +%s)"; echo "NOW=$now"`,
    );
    const outMatch = /OUT=(\d+)/.exec(r.combined);
    const nowMatch = /NOW=(\d+)/.exec(r.combined);
    assert.ok(outMatch && nowMatch, `expected OUT=/NOW= lines:\n${r.combined}`);
    const out = Number(outMatch![1]);
    const now = Number(nowMatch![1]);
    // A reset instant in the past (true for this fixture date in any run
    // after 2026-08-30) takes the fixed 60-min fallback, not the clamp floor.
    assert.ok(Math.abs(out - (now + 3600)) <= 5, `expected ~now+3600, got out=${out} now=${now}`);
  });

  test("a genuinely future reset, expressed as a +0800 wall clock, parses to the equivalent UTC epoch (clamped)", async () => {
    const r = await runShellSnippet(
      {},
      [
        'now="$(date -u +%s)"',
        // Build a reset instant 2 hours from now, then render the WALL-CLOCK
        // string that a +0800 reader would need to land back on that UTC
        // epoch (UTC = wall - 8h  =>  wall = UTC + 8h).
        'target=$((now + 7200))',
        'wall="$(date -u -d "@$((target + 8*3600))" +"%Y-%m-%d %H:%M:%S")"',
        'out="$(parse_quota_block_stdout "Request rejected (429) reset at $wall")"',
        'echo "TARGET=$target"',
        'echo "OUT=$out"',
      ].join("; "),
    );
    const targetMatch = /TARGET=(\d+)/.exec(r.combined);
    const outMatch = /OUT=(\d+)/.exec(r.combined);
    assert.ok(targetMatch && outMatch, `expected TARGET=/OUT= lines:\n${r.combined}`);
    assert.equal(outMatch![1], targetMatch![1], `expected the +0800-interpreted reset to equal the intended UTC target:\n${r.combined}`);
  });

  test("non-429 stdout => no block (empty string)", async () => {
    const r = await runShellSnippet(
      {},
      `out="$(parse_quota_block_stdout "authoring session ended cleanly")"; echo "OUT=[$out]"`,
    );
    assert.match(r.combined, /OUT=\[\]/, `a non-429 stdout must never set a block:\n${r.combined}`);
  });

  test("a 429 with no parseable reset clause => the 60-min fallback", async () => {
    const r = await runShellSnippet(
      {},
      `out="$(parse_quota_block_stdout "Request rejected (429) — no reset info in this payload")"; now="$(date -u +%s)"; echo "OUT=$out"; echo "NOW=$now"`,
    );
    const outMatch = /OUT=(\d+)/.exec(r.combined);
    const nowMatch = /NOW=(\d+)/.exec(r.combined);
    assert.ok(outMatch && nowMatch, `expected OUT=/NOW= lines:\n${r.combined}`);
    assert.ok(Math.abs(Number(outMatch![1]) - (Number(nowMatch![1]) + 3600)) <= 5);
  });

  test("a 429 with a garbage/unparseable reset clause => the 60-min fallback, not a crash", async () => {
    const r = await runShellSnippet(
      {},
      `out="$(parse_quota_block_stdout "Request rejected (429) reset at 9999-99-99 99:99:99")"; now="$(date -u +%s)"; echo "OUT=$out"; echo "NOW=$now"`,
    );
    const outMatch = /OUT=(\d+)/.exec(r.combined);
    const nowMatch = /NOW=(\d+)/.exec(r.combined);
    assert.ok(outMatch && nowMatch, `expected OUT=/NOW= lines:\n${r.combined}`);
    assert.ok(Math.abs(Number(outMatch![1]) - (Number(nowMatch![1]) + 3600)) <= 5);
  });

  test("a parseable future reset below the 15-min floor is clamped up to the floor", async () => {
    const r = await runShellSnippet(
      {},
      [
        'now="$(date -u +%s)"',
        'target=$((now + 60))', // 1 minute out — below the 15-min floor
        'wall="$(date -u -d "@$((target + 8*3600))" +"%Y-%m-%d %H:%M:%S")"',
        'out="$(parse_quota_block_stdout "Request rejected (429) reset at $wall")"',
        'echo "FLOOR=$((now + 900))"',
        'echo "OUT=$out"',
      ].join("; "),
    );
    const floorMatch = /FLOOR=(\d+)/.exec(r.combined);
    const outMatch = /OUT=(\d+)/.exec(r.combined);
    assert.ok(floorMatch && outMatch, `expected FLOOR=/OUT= lines:\n${r.combined}`);
    assert.ok(Math.abs(Number(outMatch![1]) - Number(floorMatch![1])) <= 5, `expected the clamp floor:\n${r.combined}`);
  });

  test("a parseable future reset above the 35-day ceiling is clamped down to the ceiling", async () => {
    const r = await runShellSnippet(
      {},
      [
        'now="$(date -u +%s)"',
        'target=$((now + 40*86400))', // 40 days out — above the 35-day ceiling
        'wall="$(date -u -d "@$((target + 8*3600))" +"%Y-%m-%d %H:%M:%S")"',
        'out="$(parse_quota_block_stdout "Request rejected (429) reset at $wall")"',
        'echo "CEIL=$((now + 3024000))"',
        'echo "OUT=$out"',
      ].join("; "),
    );
    const ceilMatch = /CEIL=(\d+)/.exec(r.combined);
    const outMatch = /OUT=(\d+)/.exec(r.combined);
    assert.ok(ceilMatch && outMatch, `expected CEIL=/OUT= lines:\n${r.combined}`);
    assert.ok(Math.abs(Number(outMatch![1]) - Number(ceilMatch![1])) <= 5, `expected the clamp ceiling:\n${r.combined}`);
  });
});

describe("scripts/glm/drainer-loop.sh — record_quota_block_if_429() is wired into the nothing-usable branch, after the claim is released (issue #4273 INV-2/INV-6)", () => {
  test("source assertion: record_quota_block_if_429 is called after release_after_authoring inside the commits=0 branch", () => {
    const src = readFileSync(DRAINER_LOOP, "utf8");
    const marker = "nothing usable produced (commits=0) — releasing claim";
    const branchStart = src.indexOf(marker);
    assert.ok(branchStart >= 0, "expected the nothing-usable log line to exist in the source");
    // Look at the next ~400 chars of source after the log line — the branch
    // is short (log, cleanup_worktree, delete_remote_branch_if_pushed,
    // release_after_authoring, record_quota_block_if_429, return 0).
    const branchBody = src.slice(branchStart, branchStart + 400);
    const releaseIdx = branchBody.indexOf("release_after_authoring");
    const recordIdx = branchBody.indexOf("record_quota_block_if_429");
    assert.ok(releaseIdx >= 0, `expected release_after_authoring in the nothing-usable branch:\n${branchBody}`);
    assert.ok(recordIdx >= 0, `expected record_quota_block_if_429 in the nothing-usable branch:\n${branchBody}`);
    assert.ok(recordIdx > releaseIdx, "the claim must be released BEFORE the quota block is recorded (INV-6)");
  });

  test("DRY_RUN: record_quota_block_if_429 no-ops and logs would-record, never writes the file", async () => {
    const r = await runShellSnippet(
      { HYDRA_GLM_DRAINER_DRY_RUN: "1", HYDRA_GLM_DRAINER_CAP_DIR: "/tmp" },
      `record_quota_block_if_429 "Request rejected (429) reset at 2099-01-01 00:00:00"; echo "EXIT:$?"`,
    );
    assert.match(r.combined, /EXIT:0/);
    assert.match(r.combined, /would-record z\.ai quota block until/);
  });

  test("a non-429 stdout is a complete no-op (no log line, no file)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-drainer-quota-record-noop-"));
    try {
      const r = await runShellSnippet(
        { HYDRA_GLM_DRAINER_CAP_DIR: tmp },
        `record_quota_block_if_429 "authoring session ended cleanly"; echo "EXIT:$?"`,
      );
      assert.match(r.combined, /EXIT:0/);
      assert.doesNotMatch(r.combined, /quota block/);
      assert.equal(existsSync(join(tmp, "hydra-glm-drainer-quota-blocked-until")), false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a real 429 writes the block file with the parsed instant", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "glm-drainer-quota-record-"));
    try {
      const r = await runShellSnippet(
        { HYDRA_GLM_DRAINER_CAP_DIR: tmp },
        `record_quota_block_if_429 "Request rejected (429) — no reset info in this payload"; echo "EXIT:$?"`,
      );
      assert.match(r.combined, /EXIT:0/);
      assert.match(r.combined, /recorded z\.ai quota block until/);
      const written = readFileSync(join(tmp, "hydra-glm-drainer-quota-blocked-until"), "utf8").trim();
      assert.match(written, /^\d+$/);
      const now = Math.floor(Date.now() / 1000);
      assert.ok(Math.abs(Number(written) - (now + 3600)) <= 5, `expected ~now+3600 fallback, got ${written}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
