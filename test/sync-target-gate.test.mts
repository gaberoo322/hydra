/**
 * Regression tests for issue #1451 — Target SDLC gate scripts absent in the
 * hydra-betting worktree (money-critical mutation gate a recurring no-op).
 *
 * Root cause: scripts/target/{mutation-check,target-design-concept,
 * post-merge-health}.ts are authored in the orchestrator repo and import
 * `../../src/…`, so they do not exist inside the hydra-betting worktree where a
 * Target build runs. The fix is scripts/sync-target-gate.sh — a worktree-setup
 * mirror that copies the gate scripts + their src dependency closure into a
 * git-excluded `.hydra-gate/` dir at the betting worktree root, preserving the
 * `scripts/target/` + `src/` layout so the relative imports resolve unchanged.
 *
 * What each test pins:
 *
 *   closure completeness   — every gate script + its transitive src import is
 *                            mirrored under .hydra-gate/, preserving layout.
 *   git-exclude            — .hydra-gate/ is registered in the worktree's
 *                            info/exclude, so the mirror never pollutes the
 *                            Target PR diff (git status stays clean).
 *   imports resolve        — the mirrored mutation-check.ts actually runs from
 *                            the worktree (the `../../src/…` imports resolve),
 *                            proving the ERR_MODULE_NOT_FOUND friction is gone.
 *   web/ normalization     — the mirrored classifier flags a web/-rooted
 *                            money-critical path WITHOUT hand-stripping web/
 *                            (the #1235 bug the hand-rolled path reintroduced).
 *   missing-source fail    — a drifted/incomplete closure aborts loud (exit 2)
 *                            instead of silently mirroring a partial gate.
 *   bad args               — missing / nonexistent worktree arg exits non-zero.
 *   playbook wiring        — Step 0.6 calls sync-target-gate.sh and the gate
 *                            steps invoke the mirrored .hydra-gate/ paths, not
 *                            ~/hydra and not a hand-stripped web/ classifier.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SYNC_SCRIPT = join(REPO_ROOT, "scripts", "sync-target-gate.sh");

// The exact files the mirror must contain (closure for issue #1451). If this
// list drifts from the script's GATE_FILES, a test below will catch it.
const EXPECTED_MIRROR_FILES = [
  "scripts/target/mutation-check.ts",
  "scripts/target/target-design-concept.ts",
  "scripts/target/post-merge-health.ts",
  "src/mutation.ts",
  "src/exec-with-timeout.ts",
  "src/target/money-critical.ts",
];

/**
 * Create a throwaway git repo + a linked worktree to stand in for the
 * hydra-betting worktree. Returns the worktree path and a cleanup fn.
 */
function makeFakeWorktree(): { wt: string; cleanup: () => void } {
  const repo = mkdtempSync(join(tmpdir(), "sgt-repo-"));
  const run = (...args: string[]) =>
    spawnSync("git", ["-C", repo, ...args], { encoding: "utf-8" });
  assert.equal(
    spawnSync("git", ["init", "-q", repo], { encoding: "utf-8" }).status,
    0,
    "git init failed",
  );
  run("config", "user.email", "t@t.com");
  run("config", "user.name", "t");
  writeFileSync(join(repo, "seed"), "x");
  run("add", "seed");
  assert.equal(run("commit", "-q", "-m", "init").status, 0, "seed commit failed");
  const wt = `${repo}-wt`;
  const add = run("worktree", "add", "-q", "-b", "feat", wt);
  assert.equal(add.status, 0, `worktree add failed: ${add.stderr}`);
  return {
    wt,
    cleanup: () => {
      spawnSync("git", ["-C", repo, "worktree", "remove", "--force", wt]);
      rmSync(repo, { recursive: true, force: true });
      rmSync(wt, { recursive: true, force: true });
    },
  };
}

function runSync(wt: string) {
  return spawnSync("bash", [SYNC_SCRIPT, wt], { encoding: "utf-8" });
}

describe("scripts/sync-target-gate.sh (issue #1451)", () => {
  test("mirrors the full gate-script + src closure under .hydra-gate/, layout preserved", () => {
    const { wt, cleanup } = makeFakeWorktree();
    try {
      const r = runSync(wt);
      assert.equal(r.status, 0, `sync failed: ${r.stderr}`);
      for (const rel of EXPECTED_MIRROR_FILES) {
        const mirrored = join(wt, ".hydra-gate", rel);
        assert.ok(
          existsSync(mirrored),
          `expected mirrored file at .hydra-gate/${rel}`,
        );
        // Content must match the orchestrator source-of-truth byte-for-byte.
        assert.equal(
          readFileSync(mirrored, "utf-8"),
          readFileSync(join(REPO_ROOT, rel), "utf-8"),
          `mirrored .hydra-gate/${rel} must match the orchestrator source`,
        );
      }
    } finally {
      cleanup();
    }
  });

  test("registers .hydra-gate/ in the worktree git-exclude so it stays out of the PR diff", () => {
    const { wt, cleanup } = makeFakeWorktree();
    try {
      assert.equal(runSync(wt).status, 0);
      // The mirror exists on disk...
      assert.ok(existsSync(join(wt, ".hydra-gate")), "mirror dir must exist");
      // ...but git status must NOT show it as untracked (excluded).
      const status = spawnSync(
        "git",
        ["-C", wt, "status", "--porcelain"],
        { encoding: "utf-8" },
      );
      assert.equal(status.status, 0, `git status failed: ${status.stderr}`);
      assert.ok(
        !status.stdout.includes(".hydra-gate"),
        `.hydra-gate must be git-excluded — git status showed it:\n${status.stdout}`,
      );
    } finally {
      cleanup();
    }
  });

  test("idempotent: a second run overwrites the mirror cleanly", () => {
    const { wt, cleanup } = makeFakeWorktree();
    try {
      assert.equal(runSync(wt).status, 0);
      // Drop a stale file into the mirror; a re-sync must remove it.
      const stale = join(wt, ".hydra-gate", "scripts", "target", "stale.ts");
      writeFileSync(stale, "// stale");
      const r2 = runSync(wt);
      assert.equal(r2.status, 0, `re-sync failed: ${r2.stderr}`);
      assert.ok(!existsSync(stale), "stale mirror file must be removed on re-sync");
      assert.ok(
        existsSync(join(wt, ".hydra-gate", "scripts", "target", "mutation-check.ts")),
        "re-sync must restore the real gate scripts",
      );
    } finally {
      cleanup();
    }
  });

  test("the mirrored mutation-check.ts runs from the worktree (imports resolve)", () => {
    const { wt, cleanup } = makeFakeWorktree();
    try {
      assert.equal(runSync(wt).status, 0);
      // No changed files → fast skip path, exits 0. This is the cheap proof
      // that `../../src/mutation.ts` + `../../src/target/money-critical.ts`
      // resolve from the worktree (the ERR_MODULE_NOT_FOUND friction is gone).
      const r = spawnSync(
        "npx",
        ["tsx", join(wt, ".hydra-gate", "scripts", "target", "mutation-check.ts")],
        { cwd: wt, encoding: "utf-8", env: { ...process.env, CHANGED_FILES: "" } },
      );
      assert.equal(r.status, 0, `mirrored mutation-check failed: ${r.stderr}`);
      assert.match(
        r.stdout,
        /"status":"skipped"/,
        "no-changed-files run must emit the skipped status",
      );
    } finally {
      cleanup();
    }
  });

  test("the mirrored classifier normalizes web/ (no hand-strip needed — #1235)", () => {
    const { wt, cleanup } = makeFakeWorktree();
    try {
      assert.equal(runSync(wt).status, 0);
      // Feed a raw web/-rooted money-critical path + a safe UI path. The
      // mirrored classifier must flag the staking path WITHOUT the caller
      // stripping web/ — exactly what kills the hand-rolled friction.
      const r = spawnSync(
        "node",
        [
          "--input-type=module",
          "-e",
          `import { classifyTargetRisk } from "./.hydra-gate/src/target/money-critical.ts";` +
            `const r = classifyTargetRisk(["web/src/lib/staking/kelly.ts","web/src/components/Foo.tsx"]);` +
            `process.stdout.write(JSON.stringify(r));`,
        ],
        { cwd: wt, encoding: "utf-8" },
      );
      assert.equal(r.status, 0, `classifier run failed: ${r.stderr}`);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.moneyCritical, true, "web/-rooted staking path must classify money-critical");
      assert.deepEqual(
        parsed.matchedPaths,
        ["web/src/lib/staking/kelly.ts"],
        "only the money-critical web/ path matches; the safe UI path is dropped",
      );
    } finally {
      cleanup();
    }
  });

  test("aborts loud (exit 2) when a source file in the closure is missing", () => {
    // Run the script with a temporarily-broken REPO_ROOT by pointing it at a
    // copy with one closure file removed. Simplest: copy the script into an
    // isolated fake repo-root missing src/mutation.ts, then run it.
    const fakeRoot = mkdtempSync(join(tmpdir(), "sgt-root-"));
    const { wt, cleanup } = makeFakeWorktree();
    try {
      // Recreate the layout the script resolves (scripts/ sibling of src/).
      mkdirSync(join(fakeRoot, "scripts", "target"), { recursive: true });
      mkdirSync(join(fakeRoot, "src", "target"), { recursive: true });
      // Copy the real sync script in (it resolves REPO_ROOT from its own dir).
      writeFileSync(
        join(fakeRoot, "scripts", "sync-target-gate.sh"),
        readFileSync(SYNC_SCRIPT, "utf-8"),
      );
      // Provide all-but-one of the closure so the missing-file branch fires.
      for (const rel of EXPECTED_MIRROR_FILES) {
        if (rel === "src/mutation.ts") continue; // deliberately absent
        mkdirSync(join(fakeRoot, rel, ".."), { recursive: true });
        writeFileSync(join(fakeRoot, rel), readFileSync(join(REPO_ROOT, rel), "utf-8"));
      }
      const r = spawnSync(
        "bash",
        [join(fakeRoot, "scripts", "sync-target-gate.sh"), wt],
        { encoding: "utf-8" },
      );
      assert.equal(r.status, 2, "missing closure file must exit 2");
      assert.match(r.stderr, /src\/mutation\.ts/, "must name the missing file");
      assert.ok(
        !existsSync(join(wt, ".hydra-gate")),
        "no partial mirror must be written when the closure is incomplete",
      );
    } finally {
      cleanup();
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

  test("rejects a missing or nonexistent worktree argument", () => {
    const noArg = spawnSync("bash", [SYNC_SCRIPT], { encoding: "utf-8" });
    assert.equal(noArg.status, 2, "missing arg must exit 2");
    const bad = spawnSync(
      "bash",
      [SYNC_SCRIPT, "/nonexistent/worktree/path-xyz"],
      { encoding: "utf-8" },
    );
    assert.equal(bad.status, 2, "nonexistent worktree must exit 2");
  });
});

describe("hydra-target-build playbook wiring (issue #1451)", () => {
  const PLAYBOOK = readFileSync(
    join(REPO_ROOT, "docs", "operator-playbooks", "hydra-target-build.md"),
    "utf-8",
  );

  test("Step 0.6 invokes sync-target-gate.sh against the betting worktree", () => {
    assert.match(
      PLAYBOOK,
      /sync-target-gate\.sh\s+"\$TARGET_WT"/,
      "Step 0.6 must call sync-target-gate.sh on the worktree it just created",
    );
  });

  test("the gate steps invoke the mirrored .hydra-gate/ scripts, never ~/hydra", () => {
    for (const script of [
      "mutation-check.ts",
      "target-design-concept.ts",
      "post-merge-health.ts",
    ]) {
      assert.ok(
        PLAYBOOK.includes(`.hydra-gate/scripts/target/${script}`),
        `playbook must invoke the mirrored .hydra-gate/scripts/target/${script}`,
      );
    }
    // The old "run scripts/target/<x>.ts" invocation (implicitly from ~/hydra)
    // must not survive as a bare `npx tsx scripts/target/…` call.
    assert.doesNotMatch(
      PLAYBOOK,
      /npx tsx scripts\/target\/(mutation-check|post-merge-health)\.ts/,
      "playbook must not run the gate scripts from a bare scripts/target/ path (implies ~/hydra)",
    );
  });

  test("Step 6.6 instructs NOT to hand-strip web/ (the gate normalizes it)", () => {
    assert.match(
      PLAYBOOK,
      /do NOT hand-strip the `web\/` prefix/,
      "Step 6.6 must explicitly forbid hand-stripping web/ (classifyTargetRisk does it)",
    );
  });
});
