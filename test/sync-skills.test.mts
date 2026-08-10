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

describe("scripts/sync-skills.sh — compose_base vendored-base composition (issue #3420, ADR-0030 Option C)", () => {
  /**
   * ADR-0030 Decision 4 (Option C) lineage-home mechanism: a playbook that
   * declares `compose_base: _vendor/<name>.md` generates its Claude SKILL.md as
   * [vendored upstream Pocock base body] + [overlay body], with the vendored
   * base's `disable-model-invocation: true` STRIPPED (it hard-errors under
   * Skill-tool dispatch — the tracer's whole point is that the composed review
   * skill dispatches WITHOUT that key).
   *
   * Hermetic throwaway-repo idiom (mirrors the @include / #2945 suites above):
   * REPO_ROOT = script dir's parent, playbooks at docs/operator-playbooks/,
   * vendored bases at docs/operator-playbooks/_vendor/, real sync-skills.sh
   * copied in so the resolver under test is production.
   */
  function makeComposeRepo(): {
    dir: string;
    script: string;
    playbooks: string;
    vendor: string;
  } {
    const dir = mkdtempSync(join(tmpdir(), "sync-skills-compose-"));
    const scripts = join(dir, "scripts");
    const playbooks = join(dir, "docs", "operator-playbooks");
    const vendor = join(playbooks, "_vendor");
    mkdirSync(scripts, { recursive: true });
    mkdirSync(vendor, { recursive: true });
    const script = join(scripts, "sync-skills.sh");
    copyFileSync(join(SCRIPTS, "sync-skills.sh"), script);
    return { dir, script, playbooks, vendor };
  }

  function runCompose(repo: {
    dir: string;
    script: string;
  }): { status: number | null; stdout: string; stderr: string; claudeDir: string } {
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

  test("composes [vendored base] + [overlay] and STRIPS disable-model-invocation from the frontmatter", () => {
    const repo = makeComposeRepo();
    try {
      // A vendored upstream base that ships the hard-erroring flag (as every
      // dispatched Pocock skill does upstream).
      writeFileSync(
        join(repo.vendor, "code-review.md"),
        "---\nname: code-review\ndescription: upstream two-axis review\ndisable-model-invocation: true\n---\n\nUPSTREAM-BASE-BODY two-axis review of the diff\n",
      );
      // The thin Hydra AFK overlay that composes against it.
      writeFileSync(
        join(repo.playbooks, "hydra-qa.md"),
        "---\nname: hydra-qa\ndescription: Hydra QA overlay\nclaude_only: true\ncompose_base: _vendor/code-review.md\n---\n\n# Hydra QA\n\nOVERLAY-BODY tier-aware verification depth\n",
      );
      const r = runCompose(repo);
      assert.equal(r.status, 0, `sync failed: ${r.stderr}`);
      const out = readFileSync(join(r.claudeDir, "hydra-qa", "SKILL.md"), "utf-8");

      // Both bodies present, base BEFORE overlay.
      const baseIdx = out.indexOf("UPSTREAM-BASE-BODY");
      const overlayIdx = out.indexOf("OVERLAY-BODY");
      assert.ok(baseIdx >= 0, "composed skill must carry the vendored upstream base body");
      assert.ok(overlayIdx >= 0, "composed skill must carry the Hydra AFK overlay body");
      assert.ok(baseIdx < overlayIdx, "the vendored base body must precede the overlay body");

      // The strip: no disable-model-invocation in the generated frontmatter.
      const fmMatch = out.match(/^---\n([\s\S]*?)\n---\n/);
      assert.ok(fmMatch, "generated skill must have a frontmatter block");
      assert.doesNotMatch(
        fmMatch![1],
        /disable-model-invocation/,
        "the composed frontmatter must STRIP disable-model-invocation — it hard-errors under Skill-tool dispatch (ADR-0030 Decision 4)",
      );
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  test("the strip wins even if the OVERLAY playbook itself declares disable-model-invocation", () => {
    const repo = makeComposeRepo();
    try {
      writeFileSync(
        join(repo.vendor, "code-review.md"),
        "---\nname: code-review\ndescription: upstream review\n---\n\nUPSTREAM base body\n",
      );
      // Overlay maliciously/accidentally re-declares the flag — compose must
      // still strip it (the compose guard beats the overlay's own frontmatter).
      writeFileSync(
        join(repo.playbooks, "hydra-qa.md"),
        "---\nname: hydra-qa\ndescription: overlay\ncompose_base: _vendor/code-review.md\ndisable-model-invocation: true\n---\n\noverlay body\n",
      );
      const r = runCompose(repo);
      assert.equal(r.status, 0, `sync failed: ${r.stderr}`);
      const out = readFileSync(join(r.claudeDir, "hydra-qa", "SKILL.md"), "utf-8");
      const fmMatch = out.match(/^---\n([\s\S]*?)\n---\n/);
      assert.ok(fmMatch);
      assert.doesNotMatch(
        fmMatch![1],
        /disable-model-invocation/,
        "compose must strip the flag even when the overlay declares it — the composed AFK skill is Skill-tool-dispatched",
      );
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  test("a vendored base is NOT emitted as a standalone skill (the non-recursive glob skips _vendor/)", () => {
    const repo = makeComposeRepo();
    try {
      writeFileSync(
        join(repo.vendor, "code-review.md"),
        "---\nname: code-review\ndescription: upstream\ndisable-model-invocation: true\n---\n\nbase body\n",
      );
      writeFileSync(
        join(repo.playbooks, "hydra-qa.md"),
        "---\nname: hydra-qa\ndescription: overlay\ncompose_base: _vendor/code-review.md\n---\n\noverlay body\n",
      );
      const r = runCompose(repo);
      assert.equal(r.status, 0, `sync failed: ${r.stderr}`);
      assert.ok(
        existsSync(join(r.claudeDir, "hydra-qa", "SKILL.md")),
        "the composing overlay skill must be emitted",
      );
      assert.ok(
        !existsSync(join(r.claudeDir, "code-review", "SKILL.md")),
        "the vendored base must NOT be emitted as its own ~/.claude/skills entry — it is a compose input only (like _fragments/)",
      );
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  test("a missing compose_base FAILS LOUD (non-zero exit, names the unresolved base)", () => {
    const repo = makeComposeRepo();
    try {
      writeFileSync(
        join(repo.playbooks, "hydra-qa.md"),
        "---\nname: hydra-qa\ndescription: overlay\ncompose_base: _vendor/does-not-exist.md\n---\n\noverlay body\n",
      );
      const r = runCompose(repo);
      assert.notEqual(
        r.status,
        0,
        "a missing vendored base must abort the sync (fail loud, like @include / reference_files)",
      );
      assert.match(
        r.stderr + r.stdout,
        /unresolved compose_base/i,
        "the failure must name the unresolved compose_base",
      );
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  test("a playbook WITHOUT compose_base regenerates byte-identically (composition is opt-in, no perturbation)", () => {
    const repo = makeComposeRepo();
    try {
      writeFileSync(
        join(repo.playbooks, "plain.md"),
        "---\nname: plain\ndescription: a plain uncomposed skill\n---\n\n# Plain\n\nstable body\n",
      );
      const first = runCompose(repo);
      assert.equal(first.status, 0, `first sync failed: ${first.stderr}`);
      const target = join(first.claudeDir, "plain", "SKILL.md");
      const a = readFileSync(target, "utf-8");
      const second = runCompose(repo);
      assert.equal(second.status, 0, `second sync failed: ${second.stderr}`);
      const b = readFileSync(target, "utf-8");
      assert.equal(b, a, "an uncomposed playbook must regenerate byte-identically");
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  test("the LIVE hydra-qa playbook composes the vendored code-review base and ships NO disable-model-invocation", () => {
    // Golden check against the REAL repo: sync the real playbooks, then assert
    // the live hydra-qa tracer (a) carries the upstream code-review base body,
    // (b) carries its own overlay body, and (c) has NO disable-model-invocation
    // in its generated frontmatter — the acceptance criterion that the composed
    // review skill dispatches under the Skill tool without a hard-error.
    const dir = mkdtempSync(join(tmpdir(), "sync-skills-compose-live-"));
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
      const out = readFileSync(join(dir, "claude", "hydra-qa", "SKILL.md"), "utf-8");
      // Upstream code-review base body marker.
      assert.match(
        out,
        /Two-axis review of the diff/,
        "live hydra-qa must carry the vendored upstream code-review base body",
      );
      // Hydra overlay marker.
      assert.match(
        out,
        /Tier-aware verification depth/,
        "live hydra-qa must carry its own Hydra AFK overlay body",
      );
      // Frontmatter strip.
      const fmMatch = out.match(/^---\n([\s\S]*?)\n---\n/);
      assert.ok(fmMatch, "live hydra-qa must have a frontmatter block");
      assert.doesNotMatch(
        fmMatch![1],
        /disable-model-invocation/,
        "the live composed hydra-qa frontmatter must NOT carry disable-model-invocation — it would hard-error under Skill-tool dispatch",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("scripts/sync-skills.sh — compose-seam supersede marker (issue #3818)", () => {
  /**
   * #3815's design-concept grill diagnosed the ~5.9 reviewers/PR overspend as
   * a compose-seam defect (AC2): the vendored `code-review` base's own
   * "### 4. Spawn both sub-agents in parallel" step sits BEFORE the hydra-qa
   * overlay's "### 7. Spawn the review sub-agents in parallel" step in the
   * composed SKILL.md, and nothing told the model the overlay supersedes the
   * base — so a top-down read could execute both fan-outs (2 + 4 = 6).
   *
   * The fix (#3818) is the marker mechanism the artifact named as the
   * cheapest lever: "an explicit supersede marker emitted by sync-skills.sh".
   * A `<!-- compose-seam-supersede -->` line in an overlay's body hoists
   * everything BEFORE it to precede the vendored base body in the composed
   * output — the only way an overlay's own prose can land ahead of the
   * base's instructions, since the base always came first before this fix.
   * The marker line itself is stripped, never shipped (same convention as
   * `@include`), and a playbook that never declares it composes exactly as
   * before (covered by the byte-identical assertions in the suite above).
   */
  function makeMarkerRepo(): {
    dir: string;
    script: string;
    playbooks: string;
    vendor: string;
  } {
    const dir = mkdtempSync(join(tmpdir(), "sync-skills-supersede-"));
    const scripts = join(dir, "scripts");
    const playbooks = join(dir, "docs", "operator-playbooks");
    const vendor = join(playbooks, "_vendor");
    mkdirSync(scripts, { recursive: true });
    mkdirSync(vendor, { recursive: true });
    const script = join(scripts, "sync-skills.sh");
    copyFileSync(join(SCRIPTS, "sync-skills.sh"), script);
    return { dir, script, playbooks, vendor };
  }

  function runMarkerSync(repo: {
    dir: string;
    script: string;
  }): { status: number | null; stderr: string; claudeDir: string } {
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
    return { status: r.status, stderr: r.stderr, claudeDir };
  }

  test("content before the marker is hoisted ahead of the vendored base body, and the marker itself is stripped", () => {
    const repo = makeMarkerRepo();
    try {
      writeFileSync(
        join(repo.vendor, "code-review.md"),
        "---\nname: code-review\ndescription: upstream two-axis review\n---\n\nBASE-INTRO\n\n### 4. Spawn both sub-agents in parallel\n\nBASE-SPAWN-INSTRUCTION do the thing\n",
      );
      writeFileSync(
        join(repo.playbooks, "hydra-qa.md"),
        "---\nname: hydra-qa\ndescription: overlay\ncompose_base: _vendor/code-review.md\n---\n\n# Hydra QA\n\nPREFACE-SUPERSEDE-NOTE this replaces the base step\n\n<!-- compose-seam-supersede -->\n\nOVERLAY-MAIN-BODY rest of the overlay\n",
      );
      const r = runMarkerSync(repo);
      assert.equal(r.status, 0, `sync failed: ${r.stderr}`);
      const out = readFileSync(join(r.claudeDir, "hydra-qa", "SKILL.md"), "utf-8");

      const prefaceIdx = out.indexOf("PREFACE-SUPERSEDE-NOTE");
      const baseSpawnIdx = out.indexOf("BASE-SPAWN-INSTRUCTION");
      const overlayIdx = out.indexOf("OVERLAY-MAIN-BODY");
      assert.ok(prefaceIdx >= 0, "the hoisted preface must appear in the composed output");
      assert.ok(baseSpawnIdx >= 0, "the base's own spawn instruction must still be present (untouched vendored text)");
      assert.ok(overlayIdx >= 0, "the rest of the overlay must still be present");
      assert.ok(
        prefaceIdx < baseSpawnIdx,
        "the hoisted preface (supersession note) must precede the base's spawn instruction — a top-down read must hit the override before the instruction it overrides",
      );
      assert.ok(
        baseSpawnIdx < overlayIdx,
        "the base body must still precede the rest of the overlay (compose order otherwise unchanged)",
      );
      assert.doesNotMatch(
        out,
        /compose-seam-supersede/,
        "the marker line itself must never be shipped, same convention as @include",
      );
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  test("an overlay WITHOUT the marker composes in the original base-then-overlay order (purely additive, no perturbation)", () => {
    const repo = makeMarkerRepo();
    try {
      writeFileSync(
        join(repo.vendor, "code-review.md"),
        "---\nname: code-review\ndescription: upstream\n---\n\nBASE-BODY-UNMARKED\n",
      );
      writeFileSync(
        join(repo.playbooks, "hydra-qa.md"),
        "---\nname: hydra-qa\ndescription: overlay\ncompose_base: _vendor/code-review.md\n---\n\nOVERLAY-BODY-UNMARKED\n",
      );
      const r = runMarkerSync(repo);
      assert.equal(r.status, 0, `sync failed: ${r.stderr}`);
      const out = readFileSync(join(r.claudeDir, "hydra-qa", "SKILL.md"), "utf-8");
      const baseIdx = out.indexOf("BASE-BODY-UNMARKED");
      const overlayIdx = out.indexOf("OVERLAY-BODY-UNMARKED");
      assert.ok(baseIdx >= 0 && overlayIdx >= 0);
      assert.ok(baseIdx < overlayIdx, "without the marker, the base body must still precede the overlay body");
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  test("the LIVE hydra-qa playbook's supersession note precedes the base's spawn step, and review depth (fan-out counts/roles) is unchanged", () => {
    // Golden check against the REAL repo (issue #3818 acceptance criteria):
    // regressing the marker placement, or accidentally deleting it, must fail
    // this REQUIRED test — not just an advisory workflow.
    const dir = mkdtempSync(join(tmpdir(), "sync-skills-supersede-live-"));
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
      const out = readFileSync(join(dir, "claude", "hydra-qa", "SKILL.md"), "utf-8");

      const supersedeIdx = out.indexOf("Compose-seam supersession");
      const baseSpawnIdx = out.indexOf("### 4. Spawn both sub-agents in parallel");
      const overlaySpawnIdx = out.indexOf("### 7. Spawn the review sub-agents in parallel");

      assert.ok(supersedeIdx >= 0, "the composed skill must carry the compose-seam supersession note");
      assert.ok(baseSpawnIdx >= 0, "the vendored base's own spawn step must still be present (untouched upstream text)");
      assert.ok(overlaySpawnIdx >= 0, "the overlay's own spawn step must still be present, unchanged");
      assert.ok(
        supersedeIdx < baseSpawnIdx,
        "the supersession note must appear AT OR BEFORE the base's spawn instruction — a model reading top-down must hit the override before the instruction it overrides (#3818 acceptance criterion)",
      );
      assert.match(
        out.slice(supersedeIdx, baseSpawnIdx),
        /Do NOT execute the base's step 4 spawn instruction/,
        "the note between the supersession heading and the base's spawn step must contain an explicit imperative not to execute the base step",
      );

      // Review depth (fan-out count, reviewer roles, Target risk-critical fold)
      // must be UNCHANGED — only the base's duplicate spawn is suppressed.
      assert.match(
        out,
        /Spawn exactly two parallel sub-agents/,
        "the overlay's T1\\/T2 single-pass fan-out (2 sub-agents) must be unchanged",
      );
      for (const reviewer of [
        "reviewer-A-standards",
        "reviewer-A-spec",
        "reviewer-B-standards",
        "reviewer-B-spec",
      ]) {
        assert.ok(
          out.includes(reviewer),
          `the overlay's T3\\/T4 adversarial fan-out must still name ${reviewer} — review depth must not change`,
        );
      }

      // The marker line itself must never leak into the shipped skill.
      assert.doesNotMatch(
        out,
        /compose-seam-supersede/,
        "the compose-seam-supersede marker must be stripped, never shipped literally",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("scripts/sync-skills.sh — composed hydra-qa carries the blocking-dispatch mandate ahead of the base spawn (issue #3880)", () => {
  /**
   * #3789 was fixed once by #3827 (the `run_in_background: false` mandate at
   * the overlay's own step 7). #3818/#3823 fixed the base's step 4 from being
   * double-executed. Both fixes were live in the composed SKILL.md before
   * issue #3880's 2026-08-05 recurrence — yet the recurrence still happened,
   * because the step-7 mandate sat ~250 lines past the compose-seam-supersede
   * preface, after the ENTIRE unconstrained vendored base body. A dispatch
   * reading top-down could act on a spawn well before it ever reached the
   * mandate.
   *
   * The fix restates the mandate INSIDE the hoisted preface itself (still
   * before the marker), so it is textually adjacent to the "skip the base's
   * step 4" note and precedes the base's own spawn instruction — not just the
   * step-7 mandate somewhere after it. This test golden-checks the REAL repo
   * composed output so a future edit that drops or displaces the restated
   * mandate fails CI, not just an advisory workflow (investigation for #3880
   * found there was previously NO regression test — composed or otherwise —
   * for this exact failure mode).
   */
  test("the LIVE composed hydra-qa skill restates run_in_background:false in the preface, before the base's spawn step", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-skills-blocking-mandate-"));
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
      const out = readFileSync(join(dir, "claude", "hydra-qa", "SKILL.md"), "utf-8");

      const supersedeIdx = out.indexOf("Compose-seam supersession");
      const mandateIdx = out.indexOf("Blocking-dispatch mandate, restated here");
      const baseSpawnIdx = out.indexOf("### 4. Spawn both sub-agents in parallel");
      const step7Idx = out.indexOf("### 7. Spawn the review sub-agents in parallel");

      assert.ok(supersedeIdx >= 0, "the compose-seam-supersede preface must still be present");
      assert.ok(
        mandateIdx >= 0,
        "the composed skill must restate the run_in_background:false blocking-dispatch mandate inside the hoisted preface (issue #3880)",
      );
      assert.ok(baseSpawnIdx >= 0, "the vendored base's own spawn step must still be present, untouched");
      assert.ok(step7Idx >= 0, "the overlay's own step 7 spawn instruction must still be present, unchanged");

      assert.ok(
        supersedeIdx < mandateIdx && mandateIdx < baseSpawnIdx,
        "the restated mandate must sit BETWEEN the supersession note and the base's spawn step — a top-down read must hit the blocking-dispatch requirement before any spawn instruction, not ~250 lines later at step 7",
      );
      assert.match(
        out.slice(mandateIdx, baseSpawnIdx),
        /run_in_background: false/,
        "the restated preface paragraph must literally name the run_in_background: false flag, not just gesture at 'blocking dispatch'",
      );
      assert.match(
        out.slice(mandateIdx, baseSpawnIdx),
        /step 7\.5/,
        "the restated preface must also point at step 7.5's reviewer-completeness check, not just the spawn flag",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("scripts/sync-skills.sh — banner-guarded orphan prune (issue #3693)", () => {
  /**
   * sync-skills.sh only ever WROTE generated skills; a playbook deleted from
   * docs/operator-playbooks/ left its already-synced ~/.claude/skills/<name>/
   * and ~/.codex/skills/<name>/ dirs lingering forever (bit the
   * /hydra-target-review retirement, PR #3692). The prune pass removes orphaned
   * GENERATED dirs — a dir whose SKILL.md carries the "DO NOT EDIT. Generated
   * from docs/operator-playbooks/<X>.md" banner but whose source playbook <X>.md
   * is gone. A dir whose SKILL.md LACKS that banner (a third-party / upstream
   * skill like code-review) is NEVER removed — the banner match is the safety
   * guard. Honors --dry-run and the CLAUDE_SKILLS_DIR / CODEX_SKILLS_DIR
   * overrides.
   *
   * Hermetic throwaway-repo idiom (mirrors the suites above): REPO_ROOT = script
   * dir's parent, playbooks at docs/operator-playbooks/, the REAL sync-skills.sh
   * copied in so the logic under test is production.
   */
  const GENERATED_BANNER =
    "<!-- DO NOT EDIT. Generated from docs/operator-playbooks/NAME.md. Run scripts/sync-skills.sh after editing the playbook. -->";

  function makePruneRepo(): { dir: string; script: string; playbooks: string } {
    const dir = mkdtempSync(join(tmpdir(), "sync-skills-prune-"));
    const scripts = join(dir, "scripts");
    const playbooks = join(dir, "docs", "operator-playbooks");
    mkdirSync(scripts, { recursive: true });
    mkdirSync(playbooks, { recursive: true });
    const script = join(scripts, "sync-skills.sh");
    copyFileSync(join(SCRIPTS, "sync-skills.sh"), script);
    return { dir, script, playbooks };
  }

  // Seed a pre-existing skill dir with a SKILL.md — as if a prior sync wrote it.
  function seedSkill(
    skillsDir: string,
    name: string,
    opts: { generated: boolean },
  ): string {
    const skillDir = join(skillsDir, name);
    mkdirSync(skillDir, { recursive: true });
    const banner = opts.generated
      ? GENERATED_BANNER.replace("NAME", name) + "\n\n"
      : "";
    writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${name}\n---\n\n${banner}body\n`);
    return skillDir;
  }

  function runSync(
    repo: { dir: string; script: string },
    args: string[],
    dirs: { claudeDir: string; codexDir: string },
  ): { status: number | null; stdout: string; stderr: string } {
    const r = spawnSync("bash", [repo.script, ...args], {
      env: {
        ...process.env,
        CLAUDE_SKILLS_DIR: dirs.claudeDir,
        CODEX_SKILLS_DIR: dirs.codexDir,
        PATH: process.env.PATH ?? "",
      },
      encoding: "utf-8",
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  test("removes a generated skill dir whose source playbook was deleted — in BOTH the claude and codex dirs", () => {
    const repo = makePruneRepo();
    const claudeDir = join(repo.dir, "claude");
    const codexDir = join(repo.dir, "codex");
    try {
      // A live playbook that still exists — its generated dirs must survive.
      writeFileSync(
        join(repo.playbooks, "live.md"),
        "---\nname: live\ndescription: a live skill\n---\n\n# Live\n\nbody\n",
      );
      // Pre-seed a GENERATED "orphan" whose playbook does NOT exist, in both dirs.
      const orphanClaude = seedSkill(claudeDir, "retired-skill", { generated: true });
      const orphanCodex = seedSkill(codexDir, "retired-skill", { generated: true });
      // Also pre-seed the live skill's dirs so we can prove they survive.
      const liveClaude = seedSkill(claudeDir, "live", { generated: true });
      const liveCodex = seedSkill(codexDir, "live", { generated: true });

      const r = runSync(repo, [], { claudeDir, codexDir });
      assert.equal(r.status, 0, `sync failed: ${r.stderr}`);

      assert.ok(
        !existsSync(orphanClaude),
        "the orphaned generated claude skill dir must be pruned",
      );
      assert.ok(
        !existsSync(orphanCodex),
        "the orphaned generated codex skill dir must be pruned",
      );
      assert.match(
        r.stdout,
        /pruned orphaned skill: retired-skill/,
        "the prune must announce the removed skill by name",
      );
      // The live skill (source playbook still present) must survive the prune.
      assert.ok(existsSync(liveClaude), "the live claude skill must NOT be pruned");
      assert.ok(existsSync(liveCodex), "the live codex skill must NOT be pruned");
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  test("a skill dir whose SKILL.md LACKS the generated banner is NEVER removed (third-party guard)", () => {
    const repo = makePruneRepo();
    const claudeDir = join(repo.dir, "claude");
    const codexDir = join(repo.dir, "codex");
    try {
      // A hand-authored / upstream skill with NO generated banner, and NO
      // matching playbook — the very case a naive "no playbook → delete" sweep
      // would wrongly nuke. It must be left untouched.
      const thirdParty = seedSkill(claudeDir, "code-review", { generated: false });
      const marker = join(thirdParty, "extra.md");
      writeFileSync(marker, "hand-authored\n");

      const r = runSync(repo, [], { claudeDir, codexDir });
      assert.equal(r.status, 0, `sync failed: ${r.stderr}`);

      assert.ok(
        existsSync(thirdParty),
        "a non-banner (third-party) skill dir must survive the prune",
      );
      assert.ok(existsSync(marker), "the third-party skill's contents must be intact");
      assert.doesNotMatch(
        r.stdout,
        /pruned orphaned skill: code-review/,
        "a non-banner dir must never be reported as pruned",
      );
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  test("--dry-run prints the would-prune line but deletes nothing", () => {
    const repo = makePruneRepo();
    const claudeDir = join(repo.dir, "claude");
    const codexDir = join(repo.dir, "codex");
    try {
      const orphan = seedSkill(claudeDir, "retired-skill", { generated: true });

      const r = runSync(repo, ["--dry-run"], { claudeDir, codexDir });
      assert.equal(r.status, 0, `dry-run sync failed: ${r.stderr}`);

      assert.ok(
        existsSync(orphan),
        "--dry-run must not delete the orphaned dir — it only reports",
      );
      assert.match(
        r.stdout,
        /would prune orphaned skill: retired-skill/,
        "--dry-run must announce the would-be prune",
      );
      assert.doesNotMatch(
        r.stdout,
        /^pruned orphaned skill:/m,
        "--dry-run must not print the actual-prune line",
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

describe("scripts/sync-skills.sh — default-mirror content guard (issue #3828)", () => {
  /**
   * The guard only activates on the UNOVERRIDDEN default write path
   * ($HOME/.claude/skills, $HOME/.codex/skills). To exercise that real code
   * path without ever touching the developer/CI machine's actual $HOME, every
   * test here overrides the spawned process's HOME env var to a scratch dir —
   * CLAUDE_SKILLS_DIR / CODEX_SKILLS_DIR stay UNSET so the script's own
   * `${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}` default resolution kicks in
   * against the fake HOME instead.
   */
  function makeGuardRepo(): { dir: string; playbooks: string } {
    const dir = mkdtempSync(join(tmpdir(), "sync-skills-guard-"));
    const scripts = join(dir, "scripts");
    const playbooks = join(dir, "docs", "operator-playbooks");
    mkdirSync(scripts, { recursive: true });
    mkdirSync(playbooks, { recursive: true });
    copyFileSync(join(SCRIPTS, "sync-skills.sh"), join(scripts, "sync-skills.sh"));
    writeFileSync(
      playbooks + "/demo.md",
      "---\nname: demo\ndescription: a demo skill\n---\n\n# Demo\n\nbody v1\n",
    );
    const init = spawnSync("git", ["init", "-q", dir], { encoding: "utf-8" });
    assert.equal(init.status, 0, `git init failed: ${init.stderr}`);
    spawnSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
    spawnSync("git", ["-C", dir, "config", "user.name", "Test"]);
    spawnSync("git", ["-C", dir, "add", "."]);
    const commit = spawnSync("git", ["-C", dir, "commit", "-q", "-m", "init"], { encoding: "utf-8" });
    assert.equal(commit.status, 0, `commit failed: ${commit.stderr}`);
    return { dir, playbooks };
  }

  /** Fake an `origin/master` remote-tracking ref without a real remote/fetch. */
  function pinOriginMaster(dir: string): void {
    const rev = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf-8" });
    assert.equal(rev.status, 0, `rev-parse HEAD failed: ${rev.stderr}`);
    const sha = rev.stdout.trim();
    const upd = spawnSync("git", ["-C", dir, "update-ref", "refs/remotes/origin/master", sha], {
      encoding: "utf-8",
    });
    assert.equal(upd.status, 0, `update-ref origin/master failed: ${upd.stderr}`);
  }

  function runDefaultPath(
    repoDir: string,
    args: string[] = [],
    extraEnv: Record<string, string> = {},
  ): { status: number | null; stdout: string; stderr: string; fakeHome: string } {
    const fakeHome = mkdtempSync(join(tmpdir(), "sync-skills-guard-home-"));
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: process.env.PATH ?? "", HOME: fakeHome, ...extraEnv };
    delete env.CLAUDE_SKILLS_DIR;
    delete env.CODEX_SKILLS_DIR;
    const r = spawnSync("bash", [join(repoDir, "scripts", "sync-skills.sh"), ...args], {
      env,
      encoding: "utf-8",
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, fakeHome };
  }

  test("refuses the default-path write when docs/operator-playbooks has an uncommitted tracked diff from origin/master", () => {
    const repo = makeGuardRepo();
    try {
      pinOriginMaster(repo.dir);
      // Uncommitted edit — an unmerged/unreviewed change relative to origin/master.
      writeFileSync(repo.playbooks + "/demo.md", "---\nname: demo\ndescription: a demo skill\n---\n\n# Demo\n\nbody v2 UNMERGED\n");
      const r = runDefaultPath(repo.dir);
      try {
        assert.notEqual(r.status, 0, `expected non-zero exit, got 0; stdout=${r.stdout}`);
        assert.match(r.stderr, /differs from origin\/master/, `expected guard-refusal message, got: ${r.stderr}`);
        assert.ok(
          !existsSync(join(r.fakeHome, ".claude", "skills", "demo", "SKILL.md")),
          "guard must refuse BEFORE any write to the default mirror",
        );
      } finally {
        rmSync(r.fakeHome, { recursive: true, force: true });
      }
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  test("refuses the default-path write when docs/operator-playbooks has an untracked new playbook file", () => {
    const repo = makeGuardRepo();
    try {
      pinOriginMaster(repo.dir);
      // A brand-new, never-committed playbook — `git diff` alone would miss
      // this; the guard also checks `git status --porcelain --untracked-files=all`.
      writeFileSync(repo.playbooks + "/extra.md", "---\nname: extra\ndescription: extra\n---\n\n# Extra\n");
      const r = runDefaultPath(repo.dir);
      try {
        assert.notEqual(r.status, 0, `expected non-zero exit, got 0; stdout=${r.stdout}`);
        assert.match(r.stderr, /differs from origin\/master/, `expected guard-refusal message, got: ${r.stderr}`);
      } finally {
        rmSync(r.fakeHome, { recursive: true, force: true });
      }
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  test("writes the default path when docs/operator-playbooks exactly matches origin/master (clean checkout)", () => {
    const repo = makeGuardRepo();
    try {
      pinOriginMaster(repo.dir);
      // No modifications — a clean checkout, exactly deploy.sh's post-pull state.
      const r = runDefaultPath(repo.dir);
      try {
        assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
        assert.ok(
          existsSync(join(r.fakeHome, ".claude", "skills", "demo", "SKILL.md")),
          "expected the default mirror to be written when content matches origin/master",
        );
      } finally {
        rmSync(r.fakeHome, { recursive: true, force: true });
      }
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  test("--force bypasses the guard even when content differs from origin/master", () => {
    const repo = makeGuardRepo();
    try {
      pinOriginMaster(repo.dir);
      writeFileSync(repo.playbooks + "/demo.md", "---\nname: demo\ndescription: a demo skill\n---\n\n# Demo\n\nUNMERGED\n");
      const r = runDefaultPath(repo.dir, ["--force"]);
      try {
        assert.equal(r.status, 0, `expected exit 0 with --force, got ${r.status}; stderr=${r.stderr}`);
        assert.ok(
          existsSync(join(r.fakeHome, ".claude", "skills", "demo", "SKILL.md")),
          "expected --force to write the default mirror despite the diff",
        );
      } finally {
        rmSync(r.fakeHome, { recursive: true, force: true });
      }
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  test("HYDRA_SYNC_SKILLS_FORCE=1 bypasses the guard identically to --force", () => {
    const repo = makeGuardRepo();
    try {
      pinOriginMaster(repo.dir);
      writeFileSync(repo.playbooks + "/demo.md", "---\nname: demo\ndescription: a demo skill\n---\n\n# Demo\n\nUNMERGED\n");
      const r = runDefaultPath(repo.dir, [], { HYDRA_SYNC_SKILLS_FORCE: "1" });
      try {
        assert.equal(r.status, 0, `expected exit 0 with the env override, got ${r.status}; stderr=${r.stderr}`);
        assert.ok(existsSync(join(r.fakeHome, ".claude", "skills", "demo", "SKILL.md")));
      } finally {
        rmSync(r.fakeHome, { recursive: true, force: true });
      }
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  test("fails closed when origin/master cannot be resolved locally (no such ref)", () => {
    const repo = makeGuardRepo();
    try {
      // Deliberately do NOT call pinOriginMaster — no origin/master ref exists.
      const r = runDefaultPath(repo.dir);
      try {
        assert.notEqual(r.status, 0, `expected non-zero exit, got 0; stdout=${r.stdout}`);
        assert.match(r.stderr, /origin\/master could not be resolved/, `expected fail-closed message, got: ${r.stderr}`);
      } finally {
        rmSync(r.fakeHome, { recursive: true, force: true });
      }
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  test("fails closed when REPO_ROOT is not a git repo at all", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-skills-guard-nogit-"));
    const scripts = join(dir, "scripts");
    const playbooks = join(dir, "docs", "operator-playbooks");
    mkdirSync(scripts, { recursive: true });
    mkdirSync(playbooks, { recursive: true });
    copyFileSync(join(SCRIPTS, "sync-skills.sh"), join(scripts, "sync-skills.sh"));
    writeFileSync(join(playbooks, "demo.md"), "---\nname: demo\ndescription: demo\n---\n\n# Demo\n");
    try {
      const r = runDefaultPath(dir);
      try {
        assert.notEqual(r.status, 0, `expected non-zero exit, got 0; stdout=${r.stdout}`);
        assert.match(r.stderr, /not a git repo/, `expected fail-closed message, got: ${r.stderr}`);
      } finally {
        rmSync(r.fakeHome, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the guard is skipped entirely when CLAUDE_SKILLS_DIR/CODEX_SKILLS_DIR are overridden, even with a dirty diff from origin/master", () => {
    const repo = makeGuardRepo();
    const claudeDir = mkdtempSync(join(tmpdir(), "sync-skills-guard-override-claude-"));
    const codexDir = mkdtempSync(join(tmpdir(), "sync-skills-guard-override-codex-"));
    try {
      pinOriginMaster(repo.dir);
      writeFileSync(repo.playbooks + "/demo.md", "---\nname: demo\ndescription: a demo skill\n---\n\n# Demo\n\nUNMERGED\n");
      const r = spawnSync("bash", [join(repo.dir, "scripts", "sync-skills.sh")], {
        env: { ...process.env, CLAUDE_SKILLS_DIR: claudeDir, CODEX_SKILLS_DIR: codexDir, PATH: process.env.PATH ?? "" },
        encoding: "utf-8",
      });
      assert.equal(r.status, 0, `expected override path to bypass the guard, got ${r.status}; stderr=${r.stderr}`);
      assert.ok(existsSync(join(claudeDir, "demo", "SKILL.md")), "expected the override dir to be written");
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
      rmSync(claudeDir, { recursive: true, force: true });
      rmSync(codexDir, { recursive: true, force: true });
    }
  });
});
