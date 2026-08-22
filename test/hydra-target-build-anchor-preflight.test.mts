/**
 * test/hydra-target-build-anchor-preflight.test.mts — pin the Step 2.1
 * shipped-anchor preflight contract (issue #4167).
 *
 * The preflight is a bash recipe embedded in
 * docs/operator-playbooks/_fragments/hydra-target-build-anchor-preflight.md
 * (sync-skills.sh copies it into ~/.claude/skills/hydra-target-build/), so its
 * behavioural invariants are pinned two ways:
 *
 *   - FUNCTIONALLY: the §2.1 bash block is extracted from the fragment,
 *     wrapped with PATH-shimmed `git` / `gh` / `hydra` stubs, and executed.
 *     What passes here is what a dispatched hydra-target-build agent runs.
 *   - STRUCTURALLY: the recipe must stay guard-compatible (no process
 *     substitution, no shell loops, no nested command substitution — the
 *     worktree-isolation Bash guard refuses all three, #3896) and must keep
 *     its residual-guard framing (issue #4167's design-concept invariants).
 *
 * The scenario vocabulary: the anchor subject
 * "alpha bravo charlie delta echo foxtrot golf hotel india juliet" has 10
 * significant words (length > 3), so 0.70 coverage ⇔ ≥ 7 words in ONE commit.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const FRAGMENT_PATH = join(
  REPO_ROOT,
  "docs/operator-playbooks/_fragments/hydra-target-build-anchor-preflight.md",
);
const FRAGMENT = readFileSync(FRAGMENT_PATH, "utf-8");

/** The §2.1 prose + recipe: everything before the Step 3.1 heading. */
const STEP_21 = FRAGMENT.split("### 3.1.")[0];

/** The §2.1 bash recipe: the first ```bash fence in the fragment. */
function extractStep21Block(): string {
  const open = FRAGMENT.indexOf("```bash");
  assert.ok(open >= 0, "fragment must contain a ```bash fence");
  const start = open + "```bash".length;
  const end = FRAGMENT.indexOf("\n```", start);
  assert.ok(end > start, "§2.1 bash fence must close");
  return FRAGMENT.slice(start + 1, end); // +1: skip the newline after ```bash
}

const ANCHOR_SUBJECT_10 = "alpha bravo charlie delta echo foxtrot golf hotel india juliet";

/** Single-quote a string for safe interpolation into the wrapper script. */
function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

interface RunOpts {
  subject: string;
  /** Commit subject+body blobs, one per recent origin/main commit. */
  blobs: string[];
  /** When true the `git` stub exits 1 (detached/empty repo posture). */
  gitFails?: boolean;
}

interface RunResult {
  /** The wrapper's stdout, ending in `SHIPPED_ON_MAIN=0|1`. */
  stdout: string;
  shipped: 0 | 1;
  ghLog: string;
  hydraLog: string;
}

/**
 * Execute the extracted §2.1 recipe against stubbed git/gh/hydra. Each call
 * gets a fresh temp dir, its own stub log files, and PATH with the stub dir
 * first — no shared mutable state between tests.
 */
function runStep21(opts: RunOpts): RunResult {
  const dir = mkdtempSync(join(tmpdir(), "preflight-4167-"));
  try {
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    // One \x1e-sentinel record per blob — what `git log --format='%x1e%s%n%b'`
    // emits, and what the recipe's awk stage splits records on.
    const records = opts.blobs.map((b) => `\x1e${b}\n`).join("");
    writeFileSync(join(dir, "records.txt"), records);

    const stubs: Array<[string, string]> = [
      // The §2.1 recipe makes exactly one git call (the sentinel-separated
      // log); the stub ignores its args and serves the canned records.
      [
        "git",
        `#!/usr/bin/env bash\nif [ "\${GIT_FAIL:-0}" = "1" ]; then exit 1; fi\ncat "${join(dir, "records.txt")}"\n`,
      ],
      ["gh", `#!/usr/bin/env bash\nprintf 'gh %s\\n' "$*" >> "\${GH_LOG:?}"\nexit 0\n`],
      ["hydra", `#!/usr/bin/env bash\nprintf 'hydra %s\\n' "$*" >> "\${HYDRA_LOG:?}"\nexit 0\n`],
    ];
    for (const [name, body] of stubs) {
      const p = join(binDir, name);
      writeFileSync(p, body);
      chmodSync(p, 0o755);
    }

    const block = extractStep21Block();
    const wrapper = [
      `ANCHOR_NUM='431'`,
      `ANCHOR_SUBJECT=${shSingleQuote(opts.subject)}`,
      `CYCLE_ID='test-cycle'`,
      `TARGET_WT='${dir}/wt'`,
      block,
      `echo "SHIPPED_ON_MAIN=\${SHIPPED_ON_MAIN:-unset}"`,
      "",
    ].join("\n");
    const wrapperPath = join(dir, "run.sh");
    writeFileSync(wrapperPath, wrapper);

    const ghLogPath = join(dir, "gh.log");
    const hydraLogPath = join(dir, "hydra.log");
    const res = spawnSync("bash", [wrapperPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        GH_LOG: ghLogPath,
        HYDRA_LOG: hydraLogPath,
        GIT_FAIL: opts.gitFails ? "1" : "0",
      },
    });
    assert.equal(res.status, 0, `wrapper bash exited non-zero: ${res.stderr}`);
    const m = /SHIPPED_ON_MAIN=(\d)/.exec(res.stdout ?? "");
    assert.ok(m, `wrapper stdout must report SHIPPED_ON_MAIN: ${res.stdout}`);
    return {
      stdout: res.stdout ?? "",
      shipped: Number(m![1]) as 0 | 1,
      ghLog: existsSync(ghLogPath) ? readFileSync(ghLogPath, "utf-8") : "",
      hydraLog: existsSync(hydraLogPath) ? readFileSync(hydraLogPath, "utf-8") : "",
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Functional verdicts (the extracted recipe, executed)
// ---------------------------------------------------------------------------

test("union of commits covering the anchor but no single commit reaching 70 percent keeps the anchor", () => {
  // THE #4167 defect regression: under the old union-of-100 matcher these
  // four commits cover 10/10 anchor words (100% ≥ 0.70 → old predicate
  // skipped, and used to CLOSE the issue); per-commit max is 3/10 = 30%.
  const r = runStep21({
    subject: ANCHOR_SUBJECT_10,
    blobs: [
      "alpha bravo charlie refactoring",
      "delta echo foxtrot refactoring",
      "golf hotel india refactoring",
      "juliet alpha echo refactoring",
    ],
  });
  assert.equal(r.shipped, 0, "union coverage must not skip — per-commit max is 30%");
  assert.equal(r.ghLog, "", "a keep verdict must not touch the board");
  assert.equal(r.hydraLog, "", "a keep verdict must not emit a friction cue");
});

test("a single commit covering 70 percent of the anchor subject skips the anchor", () => {
  const r = runStep21({
    subject: ANCHOR_SUBJECT_10,
    blobs: [
      "alpha bravo charlie delta echo foxtrot golf merge changelog",
      "nothing here matches the anchor vocabulary at all",
    ],
  });
  assert.equal(r.shipped, 1, "7/10 words in ONE commit is exactly the 0.70 threshold");
});

test("a best single commit at 60 percent keeps the anchor because the threshold stays at 70 percent", () => {
  const r = runStep21({
    subject: ANCHOR_SUBJECT_10,
    blobs: [
      "alpha bravo charlie delta echo foxtrot merge",
      "golf hotel india delta bravo charlie merge",
    ],
  });
  assert.equal(r.shipped, 0, "6/10 in one commit (union 9/10) must keep — threshold is unchanged at 0.70");
});

test("unreachable git log fails open and keeps the anchor", () => {
  const r = runStep21({
    subject: ANCHOR_SUBJECT_10,
    blobs: ["alpha bravo charlie delta echo foxtrot golf hotel india juliet"],
    gitFails: true,
  });
  assert.equal(r.shipped, 0, "git failing must degrade to zero coverage → keep");
  assert.equal(r.ghLog, "", "fail-open must not touch the board");
  assert.equal(r.hydraLog, "", "fail-open must not emit a friction cue");
});

test("a short subject with fewer than four significant words keeps the anchor", () => {
  // "fix the flaky test" → significant words (length > 3): flaky, test → 2 < 4.
  const r = runStep21({
    subject: "fix the flaky test",
    blobs: ["fix the flaky test now permanently"],
  });
  assert.equal(r.shipped, 0, "SIG_COUNT < 4 must never subject-match");
});

// ---------------------------------------------------------------------------
// The positive verdict's board side-effects (all three on one skip run)
// ---------------------------------------------------------------------------

test("a positive verdict never closes the board issue", () => {
  const r = runStep21({
    subject: ANCHOR_SUBJECT_10,
    blobs: ["alpha bravo charlie delta echo foxtrot golf merge changelog"],
  });
  assert.equal(r.shipped, 1, "scenario must produce a positive verdict");
  assert.ok(!r.ghLog.includes("close"), `gh stub must never be asked to close; saw: ${r.ghLog}`);
  assert.ok(!r.ghLog.includes("--reason completed"), `no close-reason either; saw: ${r.ghLog}`);
});

test("a positive verdict clears the in-progress claim label", () => {
  const r = runStep21({
    subject: ANCHOR_SUBJECT_10,
    blobs: ["alpha bravo charlie delta echo foxtrot golf merge changelog"],
  });
  assert.equal(r.shipped, 1, "scenario must produce a positive verdict");
  assert.ok(
    r.ghLog.includes("issue edit") && r.ghLog.includes("--remove-label in-progress"),
    `claim-clear is the one sanctioned board write; saw: ${r.ghLog}`,
  );
});

test("a positive verdict still posts the friction cue", () => {
  const r = runStep21({
    subject: ANCHOR_SUBJECT_10,
    blobs: ["alpha bravo charlie delta echo foxtrot golf merge changelog"],
  });
  assert.equal(r.shipped, 1, "scenario must produce a positive verdict");
  assert.ok(
    r.hydraLog.includes("/memory/subagent-friction"),
    `the cue POST must fire on every positive verdict; saw: ${r.hydraLog}`,
  );
  assert.ok(
    r.hydraLog.includes("target-build-anchor-skip-suspected-shipped"),
    `skip-only cue must stay separable from the retired close-path cue; saw: ${r.hydraLog}`,
  );
});

// ---------------------------------------------------------------------------
// Structural pins over the recipe text (guard compatibility + framing)
// ---------------------------------------------------------------------------

test("the step 2.1 recipe stays guard-compatible: no process substitution, no shell loops, no nested substitution", () => {
  const block = extractStep21Block();
  // Strip single-quoted spans (the awk program + format strings) then comment
  // lines, so only executable shell text is inspected.
  const shellOnly = block
    .replace(/'[\s\S]*?'/g, "''")
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

  assert.ok(!/\b<\(/.test(shellOnly), "no process substitution — the #3896 guard refuses it");
  assert.ok(!/\$\([^)]*\$\(/.test(shellOnly), "no nested command substitution — refused");
  assert.ok(
    !/^[ \t]*(for|while|until)[ \t]/m.test(shellOnly) && !/^[ \t]*done\b/m.test(shellOnly) && !/;\s*do\b/.test(shellOnly),
    "no shell for/while/until loops — the guard refuses them categorically; per-commit iteration lives inside awk",
  );
  assert.ok(
    block.includes('> "$WORDS_TMP"') && block.includes("$(mktemp)"),
    "the anchor word set still flows through temp files (the old comm idiom's discipline)",
  );
  assert.ok(
    block.includes('git -C "$TARGET_WT/web" log'),
    "origin/main is read via git -C $TARGET_WT/web log (worktree isolation)",
  );
  assert.ok(
    !/git[ \t]+(checkout|pull)\b/.test(shellOnly),
    "the recipe must never checkout/pull — least of all in the ~/hydra-betting main tree",
  );
});

test("the step 2.1 prose keeps the residual-guard framing behind close-discipline", () => {
  assert.ok(
    STEP_21.includes("residual guard") && STEP_21.includes("close-discipline"),
    "§2.1 must stay framed as the residual guard behind enforced Closes #N close-discipline (ADR-0031 Decision 5)",
  );
});
