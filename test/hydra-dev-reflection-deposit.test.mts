/**
 * Regression test for issue #1912 — the hydra-dev and hydra-target-build
 * playbooks must instruct the worktree subagent to DEPOSIT the
 * reflection-source telemetry file (`hydra-refl-sources-<task_id>`) as a
 * MANDATORY child step, not buried optional reference prose.
 *
 * Background:
 *   Slice 2 of #1136 landed the infrastructure for the dispatch-side
 *   reflection-source deposit (the `hydra-refl-sources-<task_id>` file that
 *   `scripts/autopilot/reap.py` reads to stamp the `reflectionMatchSource`
 *   cycle metric). But the deposit recipe lived only at the BOTTOM of the
 *   "Reflection injection" reference subsection — the numbered/sectioned
 *   child execution contract said only "fetch reflections and weave the
 *   narrative" and never pointed at the deposit. Child agents followed the
 *   numbered contract, fetched reflections, and read past the deposit block.
 *   Result: no `/tmp/hydra-refl-sources-*` file ever landed, so
 *   `deriveReflectionMatchSource` returned `'none'` on 100% of cycles.
 *
 * Fix (#1912):
 *   Both playbooks now surface the deposit as an explicit MANDATORY step in
 *   the child execution contract (hydra-dev step 4a; hydra-target-build step
 *   3.6 has-two-halves header), cross-referencing the deposit recipe so it
 *   can't be skipped.
 *
 * This is a grep-style lint on the playbooks, which are the source of truth
 * that `scripts/sync-skills.sh` regenerates into `~/.claude/skills/.../SKILL.md`.
 * Pinning the playbooks pins what gets synced downstream — so the deposit
 * obligation can't silently erode back into optional prose.
 *
 * Issue #2552: the deposit bash recipe was first extracted into a shared
 * fragment (`_fragments/reflection-telemetry-deposit.md`) that both build
 * playbooks pull in via `@include`.
 *
 * Issue #2947: the deposit *mechanics* — task_id derivation, the #1945
 * agent-<HASH> cwd key, the per-anchor/by-file bucket mapping, the fail-loud
 * cues, the #2112 unconditional anchor deposit — were lifted OUT of the
 * fragment prose into a deterministic helper `scripts/reflection-deposit.sh`.
 * So the lint now has two surfaces:
 *   - the EFFECTIVE shipped playbook surface (SKILL.md body + its @included
 *     fragments + its reference_files, resolved exactly as sync-skills.sh does)
 *     must still carry the deposit OBLIGATION (MANDATORY, cites the issues, runs
 *     even on served-nothing, forbids POSTing cycle-record), and
 *   - the helper SCRIPT must carry the key-derivation MECHANICS.
 * This keeps the obligation un-erodable in the playbook while pinning the
 * behavior-preserving mechanics in the one place they now live.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLAYBOOK_DIR = resolve(__dirname, "..", "docs", "operator-playbooks");
const SCRIPTS_DIR = resolve(__dirname, "..", "scripts");

// The deterministic deposit helper the fragments now invoke (issue #2947).
const depositScript = readFileSync(
  resolve(SCRIPTS_DIR, "reflection-deposit.sh"),
  "utf8",
);

// Resolve `@include _fragments/<name>.md` (issue #2552) AND `reference_files:`
// frontmatter fragments (issue #2947) the same way scripts/sync-skills.sh does:
// an @include line is replaced by the fragment's content; each reference_files
// entry is appended (it ships as a sibling of SKILL.md). {{SKILL_NAME}} is
// substituted by the skill name. This gives us the EFFECTIVE shipped surface
// (SKILL.md body + fragments + reference files) that the deposit obligation
// must live somewhere within.
function resolveEffectiveSource(
  playbookFile: string,
  skillName: string,
): string {
  const raw = readFileSync(resolve(PLAYBOOK_DIR, playbookFile), "utf8");
  const includeRe = /^[ \t]*@include[ \t]+(\S+)[ \t]*$/;
  const inlined = raw
    .split("\n")
    .map((line) => {
      const m = line.match(includeRe);
      if (!m) return line;
      let frag = readFileSync(resolve(PLAYBOOK_DIR, m[1]), "utf8");
      if (frag.endsWith("\n")) frag = frag.slice(0, -1);
      return frag.split("{{SKILL_NAME}}").join(skillName);
    })
    .join("\n");

  // Append every reference_files fragment (sibling files sync-skills emits).
  const refMatch = inlined.match(/^reference_files:\s*\[([^\]]*)\]/m);
  let refText = "";
  if (refMatch) {
    const entries = refMatch[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const rel of entries) {
      const frag = readFileSync(resolve(PLAYBOOK_DIR, rel), "utf8");
      refText += "\n" + frag.split("{{SKILL_NAME}}").join(skillName);
    }
  }
  return inlined + refText;
}

const playbooks: Record<string, string> = {
  "hydra-dev.md": resolveEffectiveSource("hydra-dev.md", "hydra-dev"),
  "hydra-target-build.md": resolveEffectiveSource(
    "hydra-target-build.md",
    "hydra-target-build",
  ),
};

// ---------------------------------------------------------------------------
// Playbook-surface obligations (issue #1912) — the deposit must stay a loud,
// MANDATORY, un-erodable step in the EFFECTIVE shipped playbook surface. Post
// #2947 the mechanics moved to the helper script (asserted separately below),
// but the OBLIGATION to run the deposit must remain in the playbook.
// ---------------------------------------------------------------------------
for (const [name, playbook] of Object.entries(playbooks)) {
  describe(`${name} — reflection-source deposit obligation is mandatory (issue #1912)`, () => {
    test("documents the deterministic deposit path reap.py reads", () => {
      // The deposit filename reap.py reads must be named in the shipped surface.
      // (The HYDRA_AUTOPILOT_REFL_DIR deposit-dir env var now lives in the
      // helper script — asserted in the helper-script suite below — since the
      // deposit fragment INVOKES the helper rather than re-inlining the bash.)
      assert.ok(
        /hydra-refl-sources-/.test(playbook),
        `${name} must reference the hydra-refl-sources-<task_id> deposit filename reap.py reads`,
      );
    });

    test("invokes the deterministic deposit helper (issue #2947)", () => {
      // Post-#2947 the deposit mechanics live in scripts/reflection-deposit.sh;
      // the playbook must INVOKE it (not re-inline the bash), so the key
      // derivation stays in one testable place.
      assert.ok(
        /reflection-deposit\.sh/.test(playbook),
        `${name} must invoke scripts/reflection-deposit.sh rather than re-inlining the deposit bash (issue #2947)`,
      );
    });

    test("cites the #1945 key-source rationale so a future edit can't lose it", () => {
      assert.ok(
        /#1945/.test(playbook),
        `${name} must cite issue #1945 (the env-var-only deposit landed under the wrong key)`,
      );
    });

    test("maps served blocks to the bare per-anchor / by-file bucket tokens", () => {
      assert.ok(
        /per-anchor/.test(playbook) && /by-file/.test(playbook),
        `${name} must name the bare per-anchor / by-file bucket tokens deriveReflectionMatchSource matches`,
      );
    });

    test("marks the deposit MANDATORY so it can't be read as optional prose (the #1912 root cause)", () => {
      assert.ok(
        /MANDATORY/.test(playbook),
        `${name} must mark the reflection-source deposit MANDATORY (the #1912 root cause was it reading as optional)`,
      );
    });

    test("explains a served-nothing result truthfully buckets to 'none'", () => {
      assert.ok(
        /\bnone\b/.test(playbook),
        `${name} must explain that an empty/served-nothing result truthfully buckets to 'none'`,
      );
    });

    test("forbids the child POSTing cycle-record itself (reap.py is the sole writer)", () => {
      assert.ok(
        /cycle-record/.test(playbook),
        `${name} must reference cycle-record and warn the child not to POST it (reap.py is the sole authoritative writer)`,
      );
    });

    test("cites issue #1912 so the rationale is discoverable", () => {
      assert.ok(
        /#1912/.test(playbook),
        `${name} should cite issue #1912 in the reflection-deposit section for future archaeology`,
      );
    });
  });
}

// ---------------------------------------------------------------------------
// Helper-script mechanics (issue #2947) — the deposit key-derivation and
// fail-loud semantics now live in scripts/reflection-deposit.sh. These pin the
// behavior-preserving invariants the design-concept required: the same deposit
// keys, the #1945 agent-<HASH> key source, the #2112 unconditional anchor
// deposit, and the FAIL-LOUD-on-stderr cues.
// ---------------------------------------------------------------------------
describe("scripts/reflection-deposit.sh — deposit mechanics preserved (issue #2947)", () => {
  test("writes the three deposit files reap.py reads, keyed on task_id", () => {
    for (const key of [
      "hydra-refl-sources-",
      "hydra-refl-anchor-",
      "hydra-grounding-tests-",
    ]) {
      assert.ok(
        depositScript.includes(key),
        `helper must write the ${key}<task_id> deposit reap.py reads`,
      );
    }
    assert.ok(
      /HYDRA_AUTOPILOT_REFL_DIR/.test(depositScript),
      "helper must honor the HYDRA_AUTOPILOT_REFL_DIR deposit dir reap.py mirrors",
    );
  });

  test("derives the deposit key from the agent-<HASH> worktree cwd (issue #1945)", () => {
    assert.ok(
      /agent-/.test(depositScript) && /\$PWD|basename|PWD/.test(depositScript),
      "helper must derive the harness task_id from the agent-<HASH> worktree cwd (the key reap reads), not solely from env vars (issue #1945)",
    );
    assert.ok(
      /HYDRA_AUTOPILOT_TASK_ID/.test(depositScript) &&
        /CLAUDE_CODE_SESSION_ID/.test(depositScript),
      "helper must keep the env-var fallback chain (HYDRA_AUTOPILOT_TASK_ID → CLAUDE_CODE_SESSION_ID) only as a fallback",
    );
  });

  test("maps API block sources to the bare per-anchor / by-file bucket tokens", () => {
    assert.ok(
      /per-anchor/.test(depositScript) && /by-file/.test(depositScript),
      "helper must map served blocks to the bare per-anchor / by-file bucket tokens deriveReflectionMatchSource matches",
    );
  });

  test("deposits the anchor UNCONDITIONALLY, even when zero reflections were served (issue #2112)", () => {
    // The refl-sources deposit is gated on refl_sources; the anchor deposit is
    // NOT — it must fire even on a served-nothing cycle so reap can write the
    // first-failure reflection. Pin the #2112 rationale + the anchor path.
    assert.ok(
      /#2112/.test(depositScript),
      "helper must cite issue #2112 (the unconditional anchor deposit)",
    );
    assert.ok(
      /hydra-refl-anchor-/.test(depositScript),
      "helper must always write the hydra-refl-anchor-<task_id> deposit",
    );
  });

  test("fails loud (stderr WARN) on a missing key or write error (issue #1945)", () => {
    for (const cue of [
      "refl-deposit-no-task-id",
      "refl-deposit-write-failed",
      "refl-anchor-deposit-write-failed",
      "grounding-tests-deposit-write-failed",
    ]) {
      assert.ok(
        depositScript.includes(cue),
        `helper must surface a loud WARN (cue ${cue}) instead of silently swallowing a deposit miss (issue #1945)`,
      );
    }
  });

  test("does NOT run under set -e (graceful no-op must never abort the caller)", () => {
    // Design-concept invariant: the helper must be best-effort — an I/O error,
    // a missing footer, or an unreachable reflection API must never take down
    // the build. `set -e`/`set -euo pipefail` would violate that.
    assert.doesNotMatch(
      depositScript,
      /^\s*set -e(uo)?\b/m,
      "helper must NOT set -e / set -euo pipefail — it is best-effort telemetry that must never abort the caller",
    );
    assert.match(
      depositScript,
      /exit 0/,
      "helper must always exit 0 (best-effort telemetry never fails the caller)",
    );
  });

  // Issue #3284 — the cascade-routing escalation-provenance WRITER. reap.py's
  // `_read_escalation_deposit` reads `hydra-escalation-<task_id>`, but before
  // this nothing WROTE it, so escalationAttempt/escalatedModel were permanently
  // null. The helper gained an `escalation` mode (harness-invoked at dispatch
  // time, task_id passed EXPLICITLY since the harness is not inside the escalated
  // worktree). Pin the write key + the well-formedness guard so the writer can't
  // silently regress back out (re-opening the 2nd-QA-bounce gap).
  test("writes the hydra-escalation-<task_id> deposit reap.py reads (issue #3284)", () => {
    assert.ok(
      depositScript.includes("hydra-escalation-"),
      "helper must write the hydra-escalation-<task_id> deposit reap.py's _read_escalation_deposit reads",
    );
    assert.match(
      depositScript,
      /escalation\)/,
      "helper must dispatch an `escalation` mode (the WRITE half of the reap read path)",
    );
  });

  test("escalation deposit only fires on well-formed provenance and fails loud (issue #3284)", () => {
    // The blob must carry escalationAttempt (the load-bearing marker the cascade
    // rollup filters on) + escalatedModel — matching what dispatch.sh parses.
    for (const field of ["escalationAttempt", "escalatedModel", "priorAttemptStatus"]) {
      assert.ok(
        depositScript.includes(field),
        `escalation deposit must emit ${field} (kept consistent with dispatch.sh's reader)`,
      );
    }
    for (const cue of [
      "escalation-deposit-no-task-id",
      "escalation-deposit-write-failed",
      "escalation-deposit-malformed",
    ]) {
      assert.ok(
        depositScript.includes(cue),
        `helper must FAIL-LOUD (cue ${cue}) rather than fabricate or silently drop an escalation marker`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #3284 — the autopilot playbook must instruct the harness to DEPOSIT the
// escalation provenance the moment it executes an escalate_model dispatch. This
// is the WRITE half reap.py already reads; without it the cascade cost-delta +
// postEscalationMergeRate are structurally 0. Lint the playbook so the
// obligation can't erode back into optional prose (the 2nd-QA-bounce root cause).
// ---------------------------------------------------------------------------
describe("hydra-autopilot playbook — escalation-provenance deposit obligation (issue #3284)", () => {
  const playbook = readFileSync(
    resolve(PLAYBOOK_DIR, "hydra-autopilot.md"),
    "utf8",
  );

  test("instructs the harness to invoke reflection-deposit.sh escalation on an escalate_model dispatch", () => {
    assert.ok(
      /reflection-deposit\.sh"?\s+escalation/.test(playbook),
      "the Cascade-routing escalation override section must invoke `reflection-deposit.sh escalation` so the provenance is deposited for reap.py to read back",
    );
    assert.ok(
      /#3284/.test(playbook),
      "the deposit instruction must cite issue #3284 for future archaeology",
    );
    assert.ok(
      /escalate_model/.test(playbook) && /task_id/.test(playbook),
      "the instruction must key the deposit on the escalated dispatch's task_id (passed explicitly by the harness)",
    );
  });
});
