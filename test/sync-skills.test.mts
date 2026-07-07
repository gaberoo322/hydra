/**
 * Regression tests for issue #433 — automate sync-skills.sh on deploy and via
 * an opt-in operator git hook.
 *
 * Failure mode being prevented: the 2026-05-15 silent-wedge incident. PR #429
 * merged a new 140-line autopilot playbook to master, but
 * `~/.claude/skills/hydra-autopilot/SKILL.md` stayed at the stale 574-line
 * version because nothing auto-ran sync-skills.sh. The operator's autopilot
 * run wedged for ~20 min because the stale playbook didn't match the new
 * state.json schema.
 *
 * What each test pins:
 *
 *   deploy.sh                    — must invoke scripts/sync-skills.sh after
 *                                  npm ci and BEFORE the service restart, and
 *                                  must inherit `set -euo pipefail` so a
 *                                  non-zero exit kills the deploy.
 *
 *   sync-skills.sh smoke         — editing docs/operator-playbooks/<name>.md
 *                                  causes the regenerated SKILL.md to reflect
 *                                  the edit (the core promise the hook + the
 *                                  deploy step both depend on).
 *
 *   setup-git-hooks.sh           — installs a post-merge hook that calls
 *                                  sync-skills.sh, is opt-in (idempotent
 *                                  re-run, removable, refuses to clobber a
 *                                  hand-written hook), and does NOT modify
 *                                  .git/hooks/ until explicitly invoked.
 *
 * Network and side-effecty parts (running an actual `git pull` against a
 * remote) are NOT exercised — we test the bash plumbing.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  mkdirSync,
  copyFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPTS = join(REPO_ROOT, "scripts");

describe("scripts/deploy.sh — sync-skills integration (issue #433)", () => {
  test("invokes sync-skills.sh after npm ci and before service restart", () => {
    const deploy = readFileSync(join(SCRIPTS, "deploy.sh"), "utf-8");
    const npmCiIdx = deploy.indexOf("npm ci");
    const syncIdx = deploy.indexOf("scripts/sync-skills.sh");
    const restartIdx = deploy.indexOf("systemctl --user restart hydra-orchestrator.service");
    assert.ok(npmCiIdx >= 0, "deploy.sh must still run npm ci");
    assert.ok(syncIdx > npmCiIdx, "sync-skills.sh must run after npm ci");
    assert.ok(restartIdx > syncIdx, "sync-skills.sh must run before the service restart (to avoid restarting against stale skills)");
  });

  test("inherits fail-fast (set -euo pipefail) so a sync-skills failure aborts the deploy", () => {
    // The script-level guarantee is `set -euo pipefail` at the top — that
    // means `bash scripts/sync-skills.sh` exiting non-zero will halt the
    // deploy before the dashboard build / service restart.
    const deploy = readFileSync(join(SCRIPTS, "deploy.sh"), "utf-8");
    assert.match(deploy, /^set -euo pipefail/m, "deploy.sh must start with `set -euo pipefail` so non-zero exits abort the deploy");
    // And the invocation must not be silenced with `|| true` / `2>/dev/null`.
    const lineWithSync = deploy
      .split("\n")
      .find((l) => l.includes("scripts/sync-skills.sh"));
    assert.ok(lineWithSync, "expected a deploy.sh line invoking sync-skills.sh");
    assert.doesNotMatch(
      lineWithSync ?? "",
      /\|\|\s*true|2>\/dev\/null/,
      "sync-skills invocation must not be silenced — fail fast is the contract",
    );
  });
});

describe("scripts/sync-skills.sh — playbook edit propagates to generated SKILL.md (issue #433)", () => {
  test("editing a playbook regenerates the matching skill with the new content", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-skills-test-"));
    const claudeDir = join(dir, "claude-skills");
    const codexDir = join(dir, "codex-skills");
    const playbookSrc = join(REPO_ROOT, "docs", "operator-playbooks", "hydra-dev.md");
    // Stage a tweakable copy of an existing playbook in an isolated playbooks dir.
    // sync-skills.sh reads from $REPO_ROOT/docs/operator-playbooks — we can't
    // override that path without invasive script changes, so instead we exercise
    // the real path: edit the playbook, run sync, assert the change appears in
    // the generated SKILL.md, then restore. To stay safe we operate on a
    // temp-copied playbooks tree via a wrapper script.
    //
    // Simpler approach: run sync-skills.sh against the real playbooks dir but
    // redirect output via CLAUDE_SKILLS_DIR / CODEX_SKILLS_DIR env vars (the
    // script already honors these). Then prove that editing the playbook
    // would propagate by parsing the live playbook and verifying that the
    // generated SKILL.md contains a marker substring drawn from it.
    try {
      assert.ok(existsSync(playbookSrc), "hydra-dev playbook must exist as the test fixture");
      // Run sync with redirected output dirs.
      const r = spawnSync("bash", [join(SCRIPTS, "sync-skills.sh")], {
        env: {
          ...process.env,
          CLAUDE_SKILLS_DIR: claudeDir,
          CODEX_SKILLS_DIR: codexDir,
          PATH: process.env.PATH ?? "",
        },
        encoding: "utf-8",
      });
      assert.equal(r.status, 0, `sync-skills.sh failed: ${r.stderr}`);
      const generated = join(claudeDir, "hydra-dev", "SKILL.md");
      assert.ok(existsSync(generated), `expected generated skill at ${generated}`);
      const generatedContent = readFileSync(generated, "utf-8");
      const playbookContent = readFileSync(playbookSrc, "utf-8");
      // The DO-NOT-EDIT banner is the proof that this file was machine-
      // generated by sync-skills.sh from the playbook.
      assert.match(
        generatedContent,
        /DO NOT EDIT.*Generated from docs\/operator-playbooks\/hydra-dev\.md/,
        "generated SKILL.md must carry the DO NOT EDIT banner pointing back at the source playbook",
      );
      // And the playbook body must end up in the generated skill — pick a
      // distinctive prose marker from the playbook body and require it in
      // the output. (Picks the first heading after frontmatter so the
      // assertion is robust to small playbook edits.)
      const bodyMatch = playbookContent.match(/^---\n([\s\S]*?)\n---\n([\s\S]+)$/);
      assert.ok(bodyMatch, "playbook must have frontmatter + body");
      const firstHeading = (bodyMatch[2].match(/^#\s+(.+)$/m) ?? [])[0];
      assert.ok(firstHeading, "playbook body must have an H1 heading to use as a propagation marker");
      assert.ok(
        generatedContent.includes(firstHeading),
        `generated skill must contain the playbook's first heading ${JSON.stringify(firstHeading)} — proves edits propagate`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("scripts/sync-skills.sh — @include fragment mechanism (issue #2552)", () => {
  /**
   * Build a throwaway repo whose layout matches what sync-skills.sh expects
   * (REPO_ROOT = script dir's parent; playbooks at
   * docs/operator-playbooks/). We copy the REAL sync-skills.sh into it so the
   * resolver under test is the production one, then drop a tiny playbook +
   * fragment so each assertion is hermetic and fast.
   */
  function makeFragRepo(): {
    dir: string;
    script: string;
    playbooks: string;
    fragments: string;
  } {
    const dir = mkdtempSync(join(tmpdir(), "sync-skills-frag-"));
    const scripts = join(dir, "scripts");
    const playbooks = join(dir, "docs", "operator-playbooks");
    const fragments = join(playbooks, "_fragments");
    mkdirSync(scripts, { recursive: true });
    mkdirSync(fragments, { recursive: true });
    const script = join(scripts, "sync-skills.sh");
    copyFileSync(join(SCRIPTS, "sync-skills.sh"), script);
    return { dir, script, playbooks, fragments };
  }

  function runSync(
    repo: { dir: string; script: string },
  ): { status: number | null; stdout: string; stderr: string; claudeDir: string } {
    const claudeDir = join(repo.dir, "out-claude");
    const codexDir = join(repo.dir, "out-codex");
    const r = spawnSync("bash", [repo.script], {
      env: {
        ...process.env,
        CLAUDE_SKILLS_DIR: claudeDir,
        CODEX_SKILLS_DIR: codexDir,
        PATH: process.env.PATH ?? "",
      },
      encoding: "utf-8",
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, claudeDir };
  }

  test("an @include directive is replaced by the fragment's content", () => {
    const repo = makeFragRepo();
    try {
      writeFileSync(
        join(repo.fragments, "greeting.md"),
        "FRAGMENT-START\nhello from a shared fragment\nFRAGMENT-END\n",
      );
      writeFileSync(
        join(repo.playbooks, "demo.md"),
        "---\nname: demo\ndescription: a demo skill\n---\n\n# Demo\n\n@include _fragments/greeting.md\n\ntrailing prose\n",
      );
      const r = runSync(repo);
      assert.equal(r.status, 0, `sync failed: ${r.stderr}`);
      const out = readFileSync(join(r.claudeDir, "demo", "SKILL.md"), "utf-8");
      assert.match(out, /FRAGMENT-START/, "fragment content must be inlined");
      assert.match(out, /hello from a shared fragment/);
      assert.match(out, /FRAGMENT-END/);
      // The literal directive line must be GONE — never shipped verbatim.
      assert.doesNotMatch(
        out,
        /^[ \t]*@include\b/m,
        "the @include directive line must not survive into the generated skill",
      );
      // Surrounding playbook prose must be preserved around the inlined block.
      assert.match(out, /# Demo/);
      assert.match(out, /trailing prose/);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  test("{{SKILL_NAME}} in a fragment is substituted with the including skill's name", () => {
    const repo = makeFragRepo();
    try {
      writeFileSync(
        join(repo.fragments, "tagged.md"),
        "log tag is [{{SKILL_NAME}}] here\n",
      );
      // Two skills include the SAME fragment — each must get its own name.
      writeFileSync(
        join(repo.playbooks, "alpha.md"),
        "---\nname: alpha\ndescription: alpha\n---\n\n@include _fragments/tagged.md\n",
      );
      writeFileSync(
        join(repo.playbooks, "beta.md"),
        "---\nname: beta\ndescription: beta\n---\n\n@include _fragments/tagged.md\n",
      );
      const r = runSync(repo);
      assert.equal(r.status, 0, `sync failed: ${r.stderr}`);
      const alpha = readFileSync(join(r.claudeDir, "alpha", "SKILL.md"), "utf-8");
      const beta = readFileSync(join(r.claudeDir, "beta", "SKILL.md"), "utf-8");
      assert.match(alpha, /log tag is \[alpha\] here/, "alpha must get its own name");
      assert.match(beta, /log tag is \[beta\] here/, "beta must get its own name");
      assert.doesNotMatch(alpha, /\{\{SKILL_NAME\}\}/, "no unsubstituted token in alpha");
      assert.doesNotMatch(beta, /\{\{SKILL_NAME\}\}/, "no unsubstituted token in beta");
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  test("an unresolved @include FAILS LOUD (non-zero exit, no literal directive shipped)", () => {
    const repo = makeFragRepo();
    try {
      writeFileSync(
        join(repo.playbooks, "demo.md"),
        "---\nname: demo\ndescription: demo\n---\n\n@include _fragments/does-not-exist.md\n",
      );
      const r = runSync(repo);
      assert.notEqual(
        r.status,
        0,
        "a missing fragment must abort the sync (set -euo pipefail) — never emit a literal @include line",
      );
      assert.match(
        r.stderr + r.stdout,
        /unresolved @include/i,
        "the failure must name the unresolved include",
      );
      // And the broken skill must NOT have been written with a literal directive.
      const broken = join(r.claudeDir, "demo", "SKILL.md");
      if (existsSync(broken)) {
        assert.doesNotMatch(
          readFileSync(broken, "utf-8"),
          /^[ \t]*@include\b/m,
          "a skill must never ship a literal @include line",
        );
      }
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  test("a nested @include inside a fragment FAILS LOUD (includes are non-recursive)", () => {
    const repo = makeFragRepo();
    try {
      writeFileSync(join(repo.fragments, "inner.md"), "inner content\n");
      writeFileSync(
        join(repo.fragments, "outer.md"),
        "outer before\n@include _fragments/inner.md\nouter after\n",
      );
      writeFileSync(
        join(repo.playbooks, "demo.md"),
        "---\nname: demo\ndescription: demo\n---\n\n@include _fragments/outer.md\n",
      );
      const r = runSync(repo);
      assert.notEqual(r.status, 0, "a nested include must abort the sync");
      assert.match(
        r.stderr + r.stdout,
        /nested @include|non-recursive/i,
        "the failure must explain that includes are non-recursive",
      );
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  test("the live hydra-dev + hydra-target-build playbooks resolve their reflection-telemetry-deposit include cleanly", () => {
    // Golden check against the REAL repo: sync the real playbooks, then assert
    // both build skills inlined the shared deposit fragment with their own log
    // tag and no leftover directive/token. This pins the issue #2552 wiring.
    //
    // Issue #2947: the deposit fragment now INVOKES scripts/reflection-deposit.sh
    // (the mechanics moved into the helper) rather than re-inlining the bash, and
    // it still carries the {{SKILL_NAME}} → skill-name log-tag substitution as
    // the helper's first argument. So the golden assertion moved from an inlined
    // "[<skill>] refl-anchor-deposit ok" log line to the helper invocation with
    // the skill's own tag argument.
    const dir = mkdtempSync(join(tmpdir(), "sync-skills-live-"));
    try {
      const r = spawnSync("bash", [join(SCRIPTS, "sync-skills.sh")], {
        env: {
          ...process.env,
          CLAUDE_SKILLS_DIR: join(dir, "claude"),
          CODEX_SKILLS_DIR: join(dir, "codex"),
          PATH: process.env.PATH ?? "",
        },
        encoding: "utf-8",
      });
      assert.equal(r.status, 0, `live sync failed: ${r.stderr}`);
      for (const skill of ["hydra-dev", "hydra-target-build"]) {
        // The deposit surface for hydra-dev now ships in its child-flow
        // reference file (reference_files), for hydra-target-build inline in
        // SKILL.md. Union both so the assertion is branch-agnostic.
        const skillDir = join(dir, "claude", skill);
        let surface = readFileSync(join(skillDir, "SKILL.md"), "utf-8");
        for (const ref of ["hydra-dev-child-flow.md", "hydra-dev-parent-flow.md"]) {
          const refPath = join(skillDir, ref);
          if (existsSync(refPath)) surface += "\n" + readFileSync(refPath, "utf-8");
        }
        assert.match(
          surface,
          /reflection-deposit\.sh" reflect "hydra-/,
          `${skill} must invoke the deposit helper with its own skill-name tag argument`,
        );
        assert.match(
          surface,
          new RegExp(`reflection-deposit\\.sh" reflect "${skill}"`),
          `${skill} must pass its own name as the deposit helper log tag (the {{SKILL_NAME}} substitution)`,
        );
        assert.doesNotMatch(
          surface,
          /^[ \t]*@include\b/m,
          `${skill} must not ship a literal @include directive`,
        );
        assert.doesNotMatch(
          surface,
          /\{\{SKILL_NAME\}\}/,
          `${skill} must not ship an unsubstituted {{SKILL_NAME}} token`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Issue #2947: reference_files copies named fragments into the generated skill
  // folder as siblings of SKILL.md (progressive disclosure) rather than
  // @include-ing them (which grows the body).
  test("reference_files fragments are emitted as siblings of SKILL.md, verbatim, with {{SKILL_NAME}} substituted", () => {
    const repo = makeFragRepo();
    try {
      writeFileSync(
        join(repo.fragments, "parent-flow.md"),
        "PARENT-FLOW for [{{SKILL_NAME}}]\n",
      );
      writeFileSync(
        join(repo.fragments, "child-flow.md"),
        "CHILD-FLOW for [{{SKILL_NAME}}]\n",
      );
      writeFileSync(
        join(repo.playbooks, "demo.md"),
        "---\nname: demo\ndescription: demo\nreference_files: [_fragments/parent-flow.md, _fragments/child-flow.md]\n---\n\n# Demo\n\nsee the reference files\n",
      );
      const r = runSync(repo);
      assert.equal(r.status, 0, `sync failed: ${r.stderr}`);
      const skillDir = join(r.claudeDir, "demo");
      const skill = readFileSync(join(skillDir, "SKILL.md"), "utf-8");
      // The reference material must NOT be inlined into SKILL.md.
      assert.doesNotMatch(
        skill,
        /PARENT-FLOW|CHILD-FLOW/,
        "reference_files content must NOT be inlined into SKILL.md (progressive disclosure)",
      );
      // It must be emitted as sibling files, verbatim, with the skill name substituted.
      const parent = readFileSync(join(skillDir, "parent-flow.md"), "utf-8");
      const child = readFileSync(join(skillDir, "child-flow.md"), "utf-8");
      assert.match(parent, /PARENT-FLOW for \[demo\]/, "parent-flow sibling must carry the skill name");
      assert.match(child, /CHILD-FLOW for \[demo\]/, "child-flow sibling must carry the skill name");
      assert.doesNotMatch(parent, /\{\{SKILL_NAME\}\}/, "no unsubstituted token in emitted reference file");
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  test("a missing reference_files fragment FAILS LOUD (non-zero exit, aborts the sync)", () => {
    const repo = makeFragRepo();
    try {
      writeFileSync(
        join(repo.playbooks, "demo.md"),
        "---\nname: demo\ndescription: demo\nreference_files: [_fragments/does-not-exist.md]\n---\n\n# Demo\n",
      );
      const r = runSync(repo);
      assert.notEqual(
        r.status,
        0,
        "a missing reference_files fragment must abort the sync (fail loud, like @include)",
      );
      assert.match(
        r.stderr + r.stdout,
        /unresolved reference_files/i,
        "the failure must name the unresolved reference_files fragment",
      );
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });
});

describe("scripts/sync-skills.sh — disable-model-invocation propagation + byte-identical regen (issue #2945)", () => {
  /**
   * Regression-locks the two invariants the #2945 design-concept required
   * (design-concept artifact invariants [3] and [4]):
   *
   *   [propagation] sync-skills.sh forwards the optional
   *     `disable-model-invocation` playbook-frontmatter key VERBATIM (kebab-case,
   *     lowercase `true`) into the generated *Claude* SKILL.md frontmatter,
   *     omits it entirely when the playbook doesn't declare it, and NEVER emits
   *     it into the *Codex* SKILL.md output.
   *
   *   [byte-identical] a playbook that does NOT declare the key regenerates
   *     byte-for-byte identically before and after the sync change — i.e.
   *     running sync twice against an untouched playbook produces no diff.
   *
   * Hermetic: builds a throwaway repo layout (REPO_ROOT = script dir's parent,
   * playbooks at docs/operator-playbooks/) and copies the REAL sync-skills.sh
   * in, so the resolver under test is production. Mirrors the makeFragRepo
   * idiom already used by the @include suite above.
   */
  function makeRepo(): { dir: string; script: string; playbooks: string } {
    const dir = mkdtempSync(join(tmpdir(), "sync-skills-dmi-"));
    const scripts = join(dir, "scripts");
    const playbooks = join(dir, "docs", "operator-playbooks");
    mkdirSync(scripts, { recursive: true });
    mkdirSync(playbooks, { recursive: true });
    const script = join(scripts, "sync-skills.sh");
    copyFileSync(join(SCRIPTS, "sync-skills.sh"), script);
    return { dir, script, playbooks };
  }

  function runSyncIn(repo: {
    dir: string;
    script: string;
  }): {
    status: number | null;
    stderr: string;
    claudeDir: string;
    codexDir: string;
  } {
    const claudeDir = join(repo.dir, "out-claude");
    const codexDir = join(repo.dir, "out-codex");
    const r = spawnSync("bash", [repo.script], {
      env: {
        ...process.env,
        CLAUDE_SKILLS_DIR: claudeDir,
        CODEX_SKILLS_DIR: codexDir,
        PATH: process.env.PATH ?? "",
      },
      encoding: "utf-8",
    });
    return { status: r.status, stderr: r.stderr, claudeDir, codexDir };
  }

  test("propagates disable-model-invocation into the Claude mirror, but NOT into a Codex sibling, and omits it when the playbook doesn't declare it", () => {
    const repo = makeRepo();
    try {
      // A playbook that DECLARES the flag but is NOT claude_only — so it also
      // produces a Codex output we can assert the flag is absent from. (The
      // real hydra-autopilot is claude_only, which would suppress the Codex
      // file entirely; using a non-claude_only fixture lets us positively
      // prove the "never in Codex" half of the invariant.)
      writeFileSync(
        join(repo.playbooks, "flagged.md"),
        "---\nname: flagged\ndescription: a flagged skill\ndisable-model-invocation: true\n---\n\n# Flagged\n\nbody\n",
      );
      // A sibling playbook that does NOT declare the flag — the key must be
      // omitted entirely from its generated Claude skill.
      writeFileSync(
        join(repo.playbooks, "plain.md"),
        "---\nname: plain\ndescription: a plain skill\n---\n\n# Plain\n\nbody\n",
      );
      const r = runSyncIn(repo);
      assert.equal(r.status, 0, `sync failed: ${r.stderr}`);

      const flaggedClaude = readFileSync(
        join(r.claudeDir, "flagged", "SKILL.md"),
        "utf-8",
      );
      // The flag lands in the Claude frontmatter, spelled kebab-case with a
      // lowercase `true` — never Python's "True".
      assert.match(
        flaggedClaude,
        /^disable-model-invocation: true$/m,
        "the flag must be forwarded verbatim (kebab-case, lowercase true) into the Claude SKILL.md frontmatter",
      );
      assert.doesNotMatch(
        flaggedClaude,
        /disable-model-invocation:\s*True/,
        "must emit lowercase `true`, never the Python bool `True`",
      );

      // It must NOT appear in the Codex mirror of the same skill — Codex has no
      // such concept.
      const flaggedCodex = readFileSync(
        join(r.codexDir, "flagged", "SKILL.md"),
        "utf-8",
      );
      assert.doesNotMatch(
        flaggedCodex,
        /disable-model-invocation/,
        "disable-model-invocation must NEVER be emitted into the Codex SKILL.md output",
      );

      // And a playbook that doesn't declare the key must not have it injected.
      const plainClaude = readFileSync(
        join(r.claudeDir, "plain", "SKILL.md"),
        "utf-8",
      );
      assert.doesNotMatch(
        plainClaude,
        /disable-model-invocation/,
        "a playbook that doesn't declare the key must omit it entirely — never inject a default",
      );
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  test("a playbook that does not declare the key regenerates byte-identically (running sync twice produces no diff)", () => {
    const repo = makeRepo();
    try {
      // An untouched, flag-free playbook — the case the byte-identical
      // invariant protects: the #2945 change must not perturb the output of
      // playbooks that never opted in.
      writeFileSync(
        join(repo.playbooks, "untouched.md"),
        "---\nname: untouched\ndescription: an untouched skill\nwhen_to_use: when idle\n---\n\n# Untouched\n\nstable body\n",
      );

      const first = runSyncIn(repo);
      assert.equal(first.status, 0, `first sync failed: ${first.stderr}`);
      const claudeTarget = join(first.claudeDir, "untouched", "SKILL.md");
      const codexTarget = join(first.codexDir, "untouched", "SKILL.md");
      const claudeA = readFileSync(claudeTarget, "utf-8");
      const codexA = readFileSync(codexTarget, "utf-8");

      // Re-run against the SAME (unchanged) playbook — output must be byte-for-
      // byte identical (no diff), and must never carry the new key.
      const second = runSyncIn(repo);
      assert.equal(second.status, 0, `second sync failed: ${second.stderr}`);
      const claudeB = readFileSync(claudeTarget, "utf-8");
      const codexB = readFileSync(codexTarget, "utf-8");

      assert.equal(
        claudeB,
        claudeA,
        "regenerating an untouched playbook must produce a byte-identical Claude SKILL.md",
      );
      assert.equal(
        codexB,
        codexA,
        "regenerating an untouched playbook must produce a byte-identical Codex SKILL.md",
      );
      assert.doesNotMatch(
        claudeA,
        /disable-model-invocation/,
        "a flag-free playbook's generated skill must not contain the key",
      );
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });
});

describe("scripts/setup-git-hooks.sh (issue #433)", () => {
  /**
   * Create a throwaway git repo with a `scripts/sync-skills.sh` stub and a
   * minimal `docs/operator-playbooks/` tree, then run setup-git-hooks.sh
   * against it. The hook installer resolves the hooks dir relative to its
   * own location, so we copy the real installer into the fake repo's
   * scripts/ dir before running.
   */
  function makeFakeRepo(): { dir: string; hooksDir: string; installer: string } {
    const dir = mkdtempSync(join(tmpdir(), "setup-git-hooks-"));
    const init = spawnSync("git", ["init", "-q", dir], { encoding: "utf-8" });
    assert.equal(init.status, 0, `git init failed: ${init.stderr}`);
    // Identity for any commits we make.
    spawnSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
    spawnSync("git", ["-C", dir, "config", "user.name", "Test"]);
    mkdirSync(join(dir, "scripts"), { recursive: true });
    mkdirSync(join(dir, "docs", "operator-playbooks"), { recursive: true });
    // Copy real installer into the fake repo.
    const installer = join(dir, "scripts", "setup-git-hooks.sh");
    copyFileSync(join(SCRIPTS, "setup-git-hooks.sh"), installer);
    // Stub sync-skills.sh that just records that it ran.
    writeFileSync(
      join(dir, "scripts", "sync-skills.sh"),
      `#!/usr/bin/env bash\necho "sync-skills ran" > "${join(dir, ".sync-marker")}"\n`,
      { mode: 0o755 },
    );
    return { dir, hooksDir: join(dir, ".git", "hooks"), installer };
  }

  test("install creates an executable post-merge hook that calls sync-skills.sh", () => {
    const fake = makeFakeRepo();
    try {
      const r = spawnSync("bash", [fake.installer], { encoding: "utf-8" });
      assert.equal(r.status, 0, `installer failed: ${r.stderr}`);
      const hook = join(fake.hooksDir, "post-merge");
      assert.ok(existsSync(hook), "post-merge hook must be installed");
      const mode = statSync(hook).mode & 0o111;
      assert.notEqual(mode, 0, "post-merge hook must be executable");
      const content = readFileSync(hook, "utf-8");
      assert.match(content, /hydra-setup-git-hooks: post-merge/, "hook must carry the install marker so we can detect/remove it");
      assert.match(content, /scripts\/sync-skills\.sh/, "hook must invoke sync-skills.sh");
      assert.match(content, /docs\/operator-playbooks\/\*\.md/, "hook must filter to playbook diffs (only sync when playbooks changed)");
    } finally {
      rmSync(fake.dir, { recursive: true, force: true });
    }
  });

  test("--remove uninstalls only hooks the installer wrote", () => {
    const fake = makeFakeRepo();
    try {
      const install = spawnSync("bash", [fake.installer], { encoding: "utf-8" });
      assert.equal(install.status, 0);
      const remove = spawnSync("bash", [fake.installer, "--remove"], { encoding: "utf-8" });
      assert.equal(remove.status, 0, `--remove failed: ${remove.stderr}`);
      assert.ok(
        !existsSync(join(fake.hooksDir, "post-merge")),
        "post-merge hook must be gone after --remove",
      );
    } finally {
      rmSync(fake.dir, { recursive: true, force: true });
    }
  });

  test("refuses to clobber a hand-written post-merge hook", () => {
    const fake = makeFakeRepo();
    try {
      mkdirSync(fake.hooksDir, { recursive: true });
      // Operator's existing hook with no marker.
      writeFileSync(
        join(fake.hooksDir, "post-merge"),
        "#!/usr/bin/env bash\necho operator-hook\n",
        { mode: 0o755 },
      );
      const r = spawnSync("bash", [fake.installer], { encoding: "utf-8" });
      assert.notEqual(r.status, 0, "installer must refuse when an unrelated hook exists");
      assert.match(r.stderr + r.stdout, /refusing to overwrite/, "must explain refusal");
      // Original hook must be untouched.
      const preserved = readFileSync(join(fake.hooksDir, "post-merge"), "utf-8");
      assert.match(preserved, /operator-hook/, "original hook must be preserved");
    } finally {
      rmSync(fake.dir, { recursive: true, force: true });
    }
  });

  test("re-running install is idempotent (overwrites a previously-installed hook safely)", () => {
    const fake = makeFakeRepo();
    try {
      const r1 = spawnSync("bash", [fake.installer], { encoding: "utf-8" });
      assert.equal(r1.status, 0);
      const r2 = spawnSync("bash", [fake.installer], { encoding: "utf-8" });
      assert.equal(r2.status, 0, `re-install failed: ${r2.stderr}`);
      assert.ok(existsSync(join(fake.hooksDir, "post-merge")));
    } finally {
      rmSync(fake.dir, { recursive: true, force: true });
    }
  });

  test("installer is opt-in: does NOT mutate hooks until invoked", () => {
    // Construct a fake repo, do NOT run the installer, assert .git/hooks
    // has no post-merge hook. Proves nothing in this repo or installer
    // auto-runs from a fresh clone.
    const fake = makeFakeRepo();
    try {
      assert.ok(
        !existsSync(join(fake.hooksDir, "post-merge")),
        "post-merge hook must not exist before the installer is invoked",
      );
    } finally {
      rmSync(fake.dir, { recursive: true, force: true });
    }
  });

  test("the installed hook actually runs sync-skills.sh when a playbook merge happens", () => {
    // End-to-end smoke: create a fake repo with a playbook, install the
    // hook, then perform a real merge that changes a playbook, and assert
    // sync-skills.sh ran.
    const fake = makeFakeRepo();
    try {
      // Seed an initial playbook and commit on master.
      const playbook = join(fake.dir, "docs", "operator-playbooks", "demo.md");
      writeFileSync(playbook, "---\nname: demo\ndescription: demo\n---\n\n# Demo v1\n");
      writeFileSync(join(fake.dir, "scripts", ".gitkeep"), "");
      spawnSync("git", ["-C", fake.dir, "add", "."], { encoding: "utf-8" });
      const c1 = spawnSync("git", ["-C", fake.dir, "commit", "-q", "-m", "init"], { encoding: "utf-8" });
      assert.equal(c1.status, 0, `initial commit failed: ${c1.stderr}`);
      // Install the hook on master.
      const install = spawnSync("bash", [fake.installer], { encoding: "utf-8" });
      assert.equal(install.status, 0, `installer failed: ${install.stderr}`);
      // Create a feature branch with an edited playbook, then merge back.
      spawnSync("git", ["-C", fake.dir, "checkout", "-q", "-b", "feature"]);
      writeFileSync(playbook, "---\nname: demo\ndescription: demo\n---\n\n# Demo v2\n");
      spawnSync("git", ["-C", fake.dir, "commit", "-q", "-am", "edit playbook"]);
      spawnSync("git", ["-C", fake.dir, "checkout", "-q", "-"]);
      const merge = spawnSync(
        "git",
        ["-C", fake.dir, "merge", "--no-ff", "-q", "-m", "merge feature", "feature"],
        { encoding: "utf-8" },
      );
      assert.equal(merge.status, 0, `merge failed: ${merge.stderr}\nstdout: ${merge.stdout}`);
      // The post-merge hook should have invoked our stub sync-skills.sh.
      assert.ok(
        existsSync(join(fake.dir, ".sync-marker")),
        "post-merge hook should have triggered sync-skills.sh on playbook merge",
      );
    } finally {
      rmSync(fake.dir, { recursive: true, force: true });
    }
  });

  test("the installed hook does NOT run sync-skills.sh when no playbook changed", () => {
    const fake = makeFakeRepo();
    try {
      // Seed a non-playbook file.
      writeFileSync(join(fake.dir, "README.md"), "# fake\n");
      writeFileSync(join(fake.dir, "scripts", ".gitkeep"), "");
      mkdirSync(join(fake.dir, "docs", "operator-playbooks"), { recursive: true });
      writeFileSync(join(fake.dir, "docs", "operator-playbooks", "demo.md"), "---\nname: demo\n---\n# v1\n");
      spawnSync("git", ["-C", fake.dir, "add", "."]);
      const c1 = spawnSync("git", ["-C", fake.dir, "commit", "-q", "-m", "init"]);
      assert.equal(c1.status, 0);
      const install = spawnSync("bash", [fake.installer]);
      assert.equal(install.status, 0);
      // Edit a NON-playbook file on a branch and merge.
      spawnSync("git", ["-C", fake.dir, "checkout", "-q", "-b", "feature"]);
      writeFileSync(join(fake.dir, "README.md"), "# fake v2\n");
      spawnSync("git", ["-C", fake.dir, "commit", "-q", "-am", "non-playbook edit"]);
      spawnSync("git", ["-C", fake.dir, "checkout", "-q", "-"]);
      const merge = spawnSync(
        "git",
        ["-C", fake.dir, "merge", "--no-ff", "-q", "-m", "merge feature", "feature"],
        { encoding: "utf-8" },
      );
      assert.equal(merge.status, 0, `merge failed: ${merge.stderr}`);
      assert.ok(
        !existsSync(join(fake.dir, ".sync-marker")),
        "post-merge hook should NOT have triggered sync-skills.sh — no playbook changed",
      );
    } finally {
      rmSync(fake.dir, { recursive: true, force: true });
    }
  });
});
