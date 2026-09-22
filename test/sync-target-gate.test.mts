/**
 * Regression tests for issue #1451 — Target SDLC gate scripts absent in the
 * hydra-betting worktree (money-critical mutation gate a recurring no-op).
 *
 * Root cause: scripts/target/{mutation-check,target-design-concept,
 * post-merge-health}.ts are authored in the orchestrator repo and import
 * `../../src/…`, so they do not exist inside the hydra-betting worktree where
 * a Target build runs. The fix is scripts/sync-target-gate.sh — a
 * worktree-setup mirror that copies the gate scripts + their src dependency
 * closure into a git-excluded dir, preserving the `scripts/target/` + `src/`
 * layout so the relative imports resolve unchanged.
 *
 * Since issue #4526 the mirror lives in a SIBLING scratch dir
 * `<worktree-dir>.hydra-gate` — NEXT TO the worktree, not inside it. The old
 * in-worktree `$TARGET_WT/.hydra-gate/` copy sat inside the cwd of every
 * Target tool: CSB's `eslint .` descended into it and failed with 6
 * `no-explicit-any` errors before any change was made. The sibling stays
 * nested under `$TARGET_APP_DIR/.worktrees/` so the mirror's bare `zod`
 * import still resolves through the ancestor node_modules walk (the #4177
 * mechanism) with NO symlink.
 *
 * What each test pins:
 *
 *   closure completeness   — every gate script + its transitive src import is
 *                            mirrored under the sibling gate dir, preserving
 *                            layout; NOTHING is written under the worktree
 *                            itself (#4526 INV-1).
 *   git-exclude            — the `.worktrees/` scratch area is registered in
 *                            the shared info/exclude, so the mirror never
 *                            shows as untracked in the worktree OR the main
 *                            checkout.
 *   imports resolve        — the mirrored mutation-check.ts actually runs from
 *                            the worktree (the `../../src/…` imports resolve),
 *                            proving the ERR_MODULE_NOT_FOUND friction is gone.
 *   web/ normalization     — the mirrored classifier flags a web/-rooted
 *                            money-critical path WITHOUT hand-stripping web/
 *                            (the #1235 bug the hand-rolled path reintroduced).
 *   missing-source fail    — a drifted/incomplete closure aborts loud (exit 2)
 *                            instead of silently mirroring a partial gate.
 *   bad args               — missing / nonexistent worktree arg exits non-zero.
 *   playbook wiring        — Step 0.6 calls sync-target-gate.sh, exports
 *                            HYDRA_GATE_DIR as the sibling dir, and the gate
 *                            steps invoke the mirrored scripts through
 *                            $HYDRA_GATE_DIR/… — never ~/hydra, never a
 *                            hand-stripped web/ classifier, and never an
 *                            in-worktree .hydra-gate path (#4526 INV-1).
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, basename } from "node:path";
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The betting-shaped manifest the fake worktree ships at .hydra/manifest.json.
// The synced gate scripts now source their risk surface from THIS file (issue
// #3018), so a realistic fake worktree must provide it. Six risk globs +
// appSubdir "web" mirror hydra-betting's real manifest. No `verify.lint` key:
// the optional lint command (#4526) must keep every manifest that predates it
// valid unchanged.
const FAKE_MANIFEST = {
  version: 1,
  verify: {
    install: "npm ci",
    test: "npm run test:raw",
    typecheck: "npm run typecheck",
    build: "npm run build",
    appSubdir: "web",
  },
  riskCritical: {
    surface: [
      "src/lib/providers/",
      "src/lib/execution/",
      "src/lib/staking/",
      "src/lib/bet-math/",
      "src/lib/arbitrage/",
      "src/lib/markets/",
      "src/bin/",
    ],
    mutationKillFloor: 60,
  },
};

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SYNC_SCRIPT = join(REPO_ROOT, "scripts", "sync-target-gate.sh");

/** The sibling scratch dir the sync script mirrors into (#4526 INV-1). */
function gateDir(wt: string): string {
  return `${wt}.hydra-gate`;
}

// The fake worktree is nested inside a fake `web/` dir the same way #4177
// nests the real hydra-betting worktree under `web/.worktrees/<name>` — so
// `web/node_modules` sits on the Node ancestor-walk path from
// `<gate-dir>/src/schemas/target-manifest.ts` and `zod` (imported by that
// manifest schema, in the closure) resolves with NO symlink inside the mirror
// itself (sync-target-gate.sh stopped creating one in #4177 — the nesting
// alone is now sufficient). The gate dir is a SIBLING of the worktree
// (`<wt>.hydra-gate`, #4526) but still under `web/.worktrees/`, so the walk
// reaches `web/node_modules` identically. `web/node_modules` is symlinked to
// the REAL node_modules dir that actually contains `zod`, hermetically — no
// dependency on a hydra-betting checkout. In a git worktree the repo's own
// `node_modules/` may not exist as a real dir (deps resolve via Node's upward
// walk to an ancestor), so we resolve zod's ACTUAL location rather than
// assuming `REPO_ROOT/node_modules`. zod is an orchestrator runtime dep
// (ADR-0005), so it is always resolvable.
const ORCH_NODE_MODULES = (() => {
  const require = createRequire(import.meta.url);
  let dir = dirname(require.resolve("zod"));
  while (basename(dir) !== "node_modules" && dir !== "/") dir = dirname(dir);
  return dir;
})();

// The exact files the mirror must contain (closure for issue #1451; manifest
// wiring per issue #3018 — the gate scripts source the risk surface from the
// worktree's .hydra/manifest.json via loadRiskSurface, so the manifest loader
// + schema + resolver + target-config seam join the closure and the
// transitional betting-risk-surface.ts const is gone; issue #4526 adds the
// Step-6 install decision leaf). If this list drifts from the script's
// GATE_FILES, a test below will catch it.
const EXPECTED_MIRROR_FILES = [
  "scripts/target/mutation-check.ts",
  "scripts/target/target-design-concept.ts",
  "scripts/target/post-merge-health.ts",
  "scripts/target/target-risk-surface.ts",
  "scripts/target/verify-install-decision.ts",
  "src/mutation-gate-inputs.ts",
  "src/mutation.ts",
  "src/exec-with-timeout.ts",
  "src/target/risk-critical.ts",
  "src/target/manifest.ts",
  "src/schemas/target-manifest.ts",
  "src/target-config.ts",
  "src/cli-args.ts",
];

/**
 * Create a throwaway git repo + a linked worktree to stand in for the
 * hydra-betting worktree. Returns the main repo path, the worktree path, and
 * a cleanup fn.
 */
function makeFakeWorktree(): { repo: string; wt: string; cleanup: () => void } {
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
  // Provide `web/node_modules` on the fake repo BEFORE creating the worktree
  // (issue #4177): it is an untracked, ancestor-shared dir — exactly like the
  // real `~/hydra-betting/web/node_modules` — symlinked to the orchestrator's
  // own node_modules so `zod` resolves hermetically. Not part of the git
  // history (a real worktree add wouldn't need it to be either).
  mkdirSync(join(repo, "web"), { recursive: true });
  try {
    symlinkSync(ORCH_NODE_MODULES, join(repo, "web", "node_modules"), "dir");
  } catch (err) {
    // intentional: a pre-existing symlink (idempotent re-setup) is fine.
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  // Nest the worktree under `web/.worktrees/<name>` (issue #4177) — NOT a
  // sibling `<repo>-wt` dir — so it sits on the SAME ancestor-walk path as
  // the real hydra-betting layout and `web/node_modules` above resolves with
  // no symlink inside the worktree or the gate mirror.
  const wt = join(repo, "web", ".worktrees", "feat");
  const add = run("worktree", "add", "-q", "-b", "feat", wt);
  assert.equal(add.status, 0, `worktree add failed: ${add.stderr}`);
  // Ship a realistic Target Manifest (issue #3018): the synced gate scripts read
  // the risk surface from <wt>/.hydra/manifest.json.
  mkdirSync(join(wt, ".hydra"), { recursive: true });
  writeFileSync(join(wt, ".hydra", "manifest.json"), JSON.stringify(FAKE_MANIFEST), "utf-8");
  return {
    repo,
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

describe("scripts/sync-target-gate.sh (issue #1451, sibling dir since #4526)", () => {
  test("mirrors the full gate-script + src closure into the SIBLING dir, nothing under the worktree", () => {
    const { wt, cleanup } = makeFakeWorktree();
    try {
      const r = runSync(wt);
      assert.equal(r.status, 0, `sync failed: ${r.stderr}`);
      for (const rel of EXPECTED_MIRROR_FILES) {
        const mirrored = join(gateDir(wt), rel);
        assert.ok(
          existsSync(mirrored),
          `expected mirrored file at ${gateDir(wt)}/${rel}`,
        );
        // Content must match the orchestrator source-of-truth byte-for-byte.
        assert.equal(
          readFileSync(mirrored, "utf-8"),
          readFileSync(join(REPO_ROOT, rel), "utf-8"),
          `mirrored ${gateDir(wt)}/${rel} must match the orchestrator source`,
        );
      }
      // #4526 INV-1: no gate file may live UNDER the worktree — the old
      // in-worktree copy is what CSB's `eslint .` descended into.
      assert.ok(
        !existsSync(join(wt, ".hydra-gate")),
        "no gate dir may be written under the worktree itself (issue #4526 INV-1)",
      );
    } finally {
      cleanup();
    }
  });

  test("the sibling mirror stays nested under the app dir so the ancestor walk still reaches node_modules (#4526 INV-2)", () => {
    const { wt, cleanup } = makeFakeWorktree();
    try {
      assert.equal(runSync(wt).status, 0);
      // <wt> = <repo>/web/.worktrees/feat  =>  gate dir must sit inside
      // <repo>/web/.worktrees/ (the $TARGET_APP_DIR scratch area), NOT at a
      // /tmp-style escaped location — that is what keeps bare `zod` resolving
      // via Node's ancestor node_modules walk with no symlink (#4177).
      const gate = gateDir(wt);
      assert.ok(
        dirname(gate).endsWith(".worktrees"),
        `gate dir ${gate} must stay under the .worktrees/ scratch area`,
      );
      assert.ok(gate.startsWith(dirname(wt)), `gate dir ${gate} must be a sibling of ${wt}`);
    } finally {
      cleanup();
    }
  });

  test("writes a package.json declaring type:module at the mirror root (issue #1883)", () => {
    const { wt, cleanup } = makeFakeWorktree();
    try {
      assert.equal(runSync(wt).status, 0);
      const pkgPath = join(gateDir(wt), "package.json");
      assert.ok(
        existsSync(pkgPath),
        "mirror must contain a root package.json so node knows the module type",
      );
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      assert.equal(
        pkg.type,
        "module",
        'mirror package.json must set "type":"module" (the .ts closure is ESM)',
      );
    } finally {
      cleanup();
    }
  });

  test("the mirrored gate runs WITHOUT the MODULE_TYPELESS warning (issue #1883)", () => {
    const { wt, cleanup } = makeFakeWorktree();
    try {
      assert.equal(runSync(wt).status, 0);
      // Run the mirrored mutation-check (fast skip path) from INSIDE the
      // worktree — its cwd is exactly what must stay gate-file-free — and
      // assert stderr is free of the type-reparse noise the mirror's
      // package.json silences.
      const r = spawnSync(
        "npx",
        ["tsx", join(gateDir(wt), "scripts", "target", "mutation-check.ts")],
        { cwd: wt, encoding: "utf-8", env: { ...process.env, CHANGED_FILES: "" } },
      );
      assert.equal(r.status, 0, `mirrored mutation-check failed: ${r.stderr}`);
      assert.doesNotMatch(
        r.stderr,
        /MODULE_TYPELESS_PACKAGE_JSON|Reparsing/,
        `gate stderr must be free of MODULE_TYPELESS/Reparsing noise:\n${r.stderr}`,
      );
    } finally {
      cleanup();
    }
  });

  test("the mirror stays out of every git view — worktree AND main checkout (issue #1883, #4526)", () => {
    const { repo, wt, cleanup } = makeFakeWorktree();
    try {
      assert.equal(runSync(wt).status, 0);
      assert.ok(
        existsSync(join(gateDir(wt), "package.json")),
        "mirror package.json must exist on disk",
      );
      // The worktree's own status: the sibling mirror is outside its root, so
      // it is invisible BY CONSTRUCTION — but assert it anyway.
      const wtStatus = spawnSync(
        "git",
        ["-C", wt, "status", "--porcelain"],
        { encoding: "utf-8" },
      );
      assert.equal(wtStatus.status, 0, `git status failed: ${wtStatus.stderr}`);
      assert.ok(
        !wtStatus.stdout.includes(".hydra-gate"),
        `the worktree view must be free of the mirror:\n${wtStatus.stdout}`,
      );
      // The MAIN checkout's status: the sibling dir IS inside its tree
      // (web/.worktrees/feat.hydra-gate), so only the shared info/exclude
      // registration keeps it out — root-anchored patterns miss the
      // appSubdir-nested layout, the registration must match at any depth.
      const mainStatus = spawnSync(
        "git",
        ["-C", repo, "status", "--porcelain"],
        { encoding: "utf-8" },
      );
      assert.equal(mainStatus.status, 0, `git status failed: ${mainStatus.stderr}`);
      assert.ok(
        !mainStatus.stdout.includes(".hydra-gate"),
        `the main checkout view must be free of the mirror (shared info/exclude):\n${mainStatus.stdout}`,
      );
    } finally {
      cleanup();
    }
  });

  test("registers the .worktrees/ scratch area in the shared git-exclude", () => {
    const { repo, wt, cleanup } = makeFakeWorktree();
    try {
      assert.equal(runSync(wt).status, 0);
      // The mirror exists on disk, as a sibling of the worktree...
      assert.ok(existsSync(gateDir(wt)), "sibling gate dir must exist");
      // ...and the shared info/exclude (git-common-dir) carries the
      // any-depth .worktrees/ pattern, so neither the worktree's nor the
      // main checkout's git status shows the mirror or the worktree dir as
      // untracked.
      const commonDir = spawnSync(
        "git",
        ["-C", wt, "rev-parse", "--git-common-dir"],
        { encoding: "utf-8" },
      );
      assert.equal(commonDir.status, 0, `rev-parse failed: ${commonDir.stderr}`);
      // Anchor like the script does: an absolute common-dir is used as-is, a
      // relative one is resolved against the worktree.
      const raw = commonDir.stdout.trim();
      const gitCommon = raw.startsWith("/") ? raw : join(wt, raw);
      const excludeFile = join(gitCommon, "info", "exclude");
      const exclude = readFileSync(excludeFile, "utf-8");
      assert.ok(
        exclude.split("\n").includes(".worktrees/"),
        `info/exclude must carry the any-depth .worktrees/ pattern:\n${exclude}`,
      );
      for (const cwd of [wt, repo]) {
        const status = spawnSync("git", ["-C", cwd, "status", "--porcelain"], {
          encoding: "utf-8",
        });
        assert.equal(status.status, 0, `git status failed in ${cwd}: ${status.stderr}`);
        assert.ok(
          !status.stdout.includes(".hydra-gate"),
          `git status in ${cwd} must not show the mirror:\n${status.stdout}`,
        );
      }
    } finally {
      cleanup();
    }
  });

  test("idempotent: a second run overwrites the mirror cleanly", () => {
    const { wt, cleanup } = makeFakeWorktree();
    try {
      assert.equal(runSync(wt).status, 0);
      // Drop a stale file into the mirror; a re-sync must remove it.
      const stale = join(gateDir(wt), "scripts", "target", "stale.ts");
      writeFileSync(stale, "// stale");
      const r2 = runSync(wt);
      assert.equal(r2.status, 0, `re-sync failed: ${r2.stderr}`);
      assert.ok(!existsSync(stale), "stale mirror file must be removed on re-sync");
      assert.ok(
        existsSync(join(gateDir(wt), "scripts", "target", "mutation-check.ts")),
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
      // that `../../src/mutation.ts` + `../../src/target/risk-critical.ts`
      // resolve from the sibling mirror (the ERR_MODULE_NOT_FOUND friction
      // is gone) while the worktree cwd itself stays gate-file-free.
      const r = spawnSync(
        "npx",
        ["tsx", join(gateDir(wt), "scripts", "target", "mutation-check.ts")],
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

  test("the mirrored gate sources the surface from the worktree manifest + normalizes web/ (#1235, #3018)", () => {
    const { wt, cleanup } = makeFakeWorktree();
    try {
      assert.equal(runSync(wt).status, 0);
      // Feed a raw web/-rooted risk-critical path + a safe UI path. The
      // mirrored classifier must flag the staking path WITHOUT the caller
      // stripping web/ (the hand-rolled friction #1235). The surface +
      // appSubdir come from the mirrored loadRiskSurface reading
      // <wt>/.hydra/manifest.json (issue #3018: the surface is
      // manifest-sourced, not a hardcoded const). The mirror is a SIBLING of
      // the worktree (#4526), so the imports go by absolute file:// URL from
      // $HYDRA_GATE_DIR — the same form the playbook now uses.
      const r = spawnSync(
        "node",
        [
          "--input-type=module",
          "-e",
          `import { pathToFileURL } from "node:url";` +
            `const g = process.env.HYDRA_GATE_DIR;` +
            `const rc = await import(pathToFileURL(g + "/src/target/risk-critical.ts").href);` +
            `const rs = await import(pathToFileURL(g + "/scripts/target/target-risk-surface.ts").href);` +
            `const s = rs.loadRiskSurface(process.env.TARGET_MANIFEST_ROOT);` +
            `if (!s.ok) { process.stderr.write("surface load failed: " + s.errors.join("; ")); process.exit(3); }` +
            `const out = rc.classifyRisk(["web/src/lib/staking/kelly.ts","web/src/components/Foo.tsx"], s.surface, s.appSubdir);` +
            `process.stdout.write(JSON.stringify(out));`,
        ],
        {
          cwd: wt,
          encoding: "utf-8",
          env: {
            ...process.env,
            HYDRA_GATE_DIR: gateDir(wt),
            TARGET_MANIFEST_ROOT: wt,
          },
        },
      );
      assert.equal(r.status, 0, `classifier run failed: ${r.stderr}`);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.riskCritical, true, "web/-rooted staking path must classify risk-critical");
      assert.deepEqual(
        parsed.matchedPaths,
        ["web/src/lib/staking/kelly.ts"],
        "only the risk-critical web/ path matches; the safe UI path is dropped",
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
        !existsSync(gateDir(wt)),
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

describe("hydra-target-build playbook wiring (issue #1451, #4526)", () => {
  // The playbook's merge-flow steps (incl. the post-merge-health invocation)
  // live in the _fragments/ include, so the wiring assertions read BOTH the
  // top-level playbook and its merge-flow fragment as the effective source.
  const PLAYBOOK = [
    join(REPO_ROOT, "docs", "operator-playbooks", "hydra-target-build.md"),
    join(
      REPO_ROOT,
      "docs",
      "operator-playbooks",
      "_fragments",
      "hydra-target-build-merge-flow.md",
    ),
  ]
    .map((p) => readFileSync(p, "utf-8"))
    .join("\n");

  test("Step 0.6 invokes sync-target-gate.sh against the betting worktree", () => {
    assert.match(
      PLAYBOOK,
      /sync-target-gate\.sh\s+"\$TARGET_WT"/,
      "Step 0.6 must call sync-target-gate.sh on the worktree it just created",
    );
  });

  test("Step 0.6 exports HYDRA_GATE_DIR as the SIBLING scratch dir (#4526 INV-1)", () => {
    assert.match(
      PLAYBOOK,
      /HYDRA_GATE_DIR="\$\{TARGET_WT\}\.hydra-gate"/,
      "Step 0.6 must derive the gate dir as the worktree's sibling, not a child",
    );
  });

  test("the gate steps invoke the mirrored scripts via $HYDRA_GATE_DIR, never ~/hydra and never inside the worktree", () => {
    for (const script of [
      "mutation-check.ts",
      "target-design-concept.ts",
      "post-merge-health.ts",
    ]) {
      assert.ok(
        PLAYBOOK.includes(`$HYDRA_GATE_DIR/scripts/target/${script}`),
        `playbook must invoke the mirrored $HYDRA_GATE_DIR/scripts/target/${script}`,
      );
    }
    // #4526 INV-1: no gate path may point INSIDE the worktree anymore — the
    // old `$TARGET_WT/.hydra-gate/` form is exactly what CSB's `eslint .`
    // descended into (6 no-explicit-any failures before any change was made).
    assert.ok(
      !PLAYBOOK.includes("$TARGET_WT/.hydra-gate"),
      "playbook must not reference an in-worktree .hydra-gate path (issue #4526)",
    );
    // The old "run scripts/target/<x>.ts" invocation (implicitly from ~/hydra)
    // must not survive as a bare `npx tsx scripts/target/…` call.
    assert.doesNotMatch(
      PLAYBOOK,
      /npx tsx scripts\/target\/(mutation-check|post-merge-health)\.ts/,
      "playbook must not run the gate scripts from a bare scripts/target/ path (implies ~/hydra)",
    );
  });

  test("Step 6 verifies lint, typecheck, test AND build from the manifest (#4526 INV-5)", () => {
    // The verify ladder reads every command from the worktree manifest via
    // jq — lint is optional (jq '.verify.lint // empty'), the other three
    // are required — and build is a gate like the rest, not a nice-to-have.
    assert.match(
      PLAYBOOK,
      /jq -r '\.verify\.lint \/\/ empty' "\$MANIFEST"/,
      "Step 6 must read the optional lint command from the manifest",
    );
    for (const key of ["test", "typecheck", "build"]) {
      assert.ok(
        PLAYBOOK.includes(`jq -r '.verify.${key}' "$MANIFEST"`),
        `Step 6 must read verify.${key} from the manifest`,
      );
    }
    // The install decision routes through the mirrored leaf — never a
    // hand-rolled grep in the playbook (#4526 INV-6).
    assert.ok(
      PLAYBOOK.includes("$HYDRA_GATE_DIR/scripts/target/verify-install-decision.ts"),
      "the playbook must invoke the mirrored install-decision leaf",
    );
  });

  test("Step 8.5 removes the sibling gate dir alongside the worktree (#4526 INV-9)", () => {
    assert.match(
      PLAYBOOK,
      /rm -rf "\$HYDRA_GATE_DIR"/,
      "Step 8.5 must clean up the sibling gate scratch dir on success",
    );
  });

  test("Step 6.6 instructs NOT to hand-strip the appSubdir prefix (the gate normalizes it)", () => {
    // Target-generic since #4525: the prefix is the manifest's declared
    // `appSubdir` (possibly empty), never a hardcoded subdirectory literal.
    assert.match(
      PLAYBOOK,
      /do NOT hand-strip the `appSubdir` prefix/,
      "Step 6.6 must explicitly forbid hand-stripping the appSubdir prefix (classifyTargetRisk does it)",
    );
  });

  test("the operator-review fence lookup fails CLOSED on a gh lookup failure (#4224, #4230 QA remediation)", () => {
    // A transient `gh` failure (API error, rate limit, auth) is
    // indistinguishable from a confirmed "not fenced", so it must count as
    // FENCED — the build's explicit-merge fallback must never resolve that
    // ambiguity toward merging a possibly money-critical PR unreviewed.
    assert.match(
      PLAYBOOK,
      /FENCE_LOOKUP="failed"/,
      "a failed gh lookup must be recorded as a distinct lookup state",
    );
    assert.match(
      PLAYBOOK,
      /if ! ISSUE_LABELS=\$\(gh issue view/,
      "every per-issue label read must branch on gh's exit code, not on empty output",
    );
    assert.match(
      PLAYBOOK,
      /\|\| FENCE_LOOKUP="failed"/,
      "the linked-issue list read must fail closed too — a failed closingIssuesReferences lookup must not read as \"no links\"",
    );
    // The #4230 fail-open shape — FENCED assigned directly from the gh
    // pipeline, `|| true` swallowing the failure into "" (unfenced) — must
    // not return.
    assert.doesNotMatch(
      PLAYBOOK,
      /FENCED=\$\(gh (issue view|pr view)/,
      "FENCED must not be assigned directly from a gh pipeline: that shape turns a lookup failure into a silent not-fenced",
    );
  });

  test("the fence lookup resolves the PR's linked issues — the same subject the workflow's fence resolves (#4224 predicate alignment)", () => {
    // The workflow-side fence (hydra-betting automerge.yml, PR
    // gaberoo322/hydra-betting#1076) skips a PR when any SAME-REPO issue it
    // links (closingIssuesReferences) carries a fencing label. The
    // build-side lookup must resolve the same subject: keying it on the
    // anchor alone desyncs the two fences — a PR linked to a DIFFERENT
    // money-critical issue passes an anchor-only check, and the "attempt the
    // explicit merge yourself" branch would then merge the exact PR the
    // workflow just withheld.
    assert.match(
      PLAYBOOK,
      /closingIssuesReferences/,
      "the fence lookup must resolve the PR's closingIssuesReferences, mirroring the workflow's fence",
    );
    assert.match(
      PLAYBOOK,
      /for N in \$\(printf '%s' "\$LINKED"\) \$\{ANCHOR_NUM:-\}; do/,
      "the lookup must read every linked issue plus the anchor (belt-and-braces)",
    );
    // The pre-alignment shape — the lookup gated on ANCHOR_NUM wrapping a
    // single anchor-only gh issue view — must not return. (Step 9's residual
    // close guard keeps its own, unrelated ANCHOR_NUM gate.)
    assert.doesNotMatch(
      PLAYBOOK,
      /if \[ -n "\$\{ANCHOR_NUM:-\}" \]; then\s+if ! ANCHOR_LABELS=\$\(gh issue view/,
      "an anchor-only lookup gated on ANCHOR_NUM desyncs from the workflow's linked-issue fence",
    );
  });

  test("a non-board anchor that links no issue is not phantom-fenced (#4224)", () => {
    // The intent the old ANCHOR_NUM gate carried, now expressed against the
    // aligned predicate: a failing-test / priorities-doc pick links no issue
    // and has no anchor number, so its lookup resolves nothing and it
    // proceeds unfenced — mirroring the workflow, which merges a PR with an
    // empty closingIssuesReferences list.
    assert.match(
      PLAYBOOK,
      /Empty \$LINKED with an empty anchor/,
      "the lookup's empty case must be documented: no linked issues and no anchor means unfenced",
    );
  });

  test("a fenced anchor whose PR lacks its Closes link is fence-blind — held by draft and reported, never quietly merged (#4224)", () => {
    // The workflow's fence resolves labels ONLY through the PR's linked
    // issues, so the Closes link is load-bearing for the fence itself: a
    // fenced anchor without it cannot be held by the workflow, which
    // squash-merges on green unreviewed (the PR #1026 class).
    assert.match(
      PLAYBOOK,
      /without the `Closes #<ANCHOR_NUM>` link the workflow's fence cannot see the anchor/,
      "the close-discipline must name the Closes link as load-bearing for the fence",
    );
    assert.match(
      PLAYBOOK,
      /gh pr ready --undo/,
      "the fence-blind branch must take the one mechanical hold available (mark the PR draft) before reporting",
    );
  });
});
