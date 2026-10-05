/**
 * test/hydra-target-build-anchor-preflight.test.mts — pin the Step 2.1
 * shipped-anchor preflight contract (issues #4167, #4279) and the Step 3.1
 * ledger-missing guard's expected-vs-not-expected split (issue #4531).
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
 * Skip predicate (issue #4279): an origin/main commit carries a closing-keyword
 * ref to the anchor's own number (#431 in these scenarios) AND the issue has no
 * `reopened` event. Vocabulary overlap is never evidence.
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

/** Single-quote a string for safe interpolation into the wrapper script. */
function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

interface RunOpts {
  /** Commit subject+body blobs, one per recent origin/main commit. */
  blobs: string[];
  /** When true the `git` stub exits 1 (detached/empty repo posture). */
  gitFails?: boolean;
  /** gh api events stub: "none" (default), "reopened", or "fail". */
  events?: "none" | "reopened" | "fail";
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
const FAKE_SHA = "abc1234def5678";

function runStep21(opts: RunOpts): RunResult {
  const dir = mkdtempSync(join(tmpdir(), "preflight-4167-"));
  try {
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    // One \x1e-sentinel record per blob — what `git log --format='%x1e%H%n%s%n%b'`
    // emits, and what the recipe's awk stage splits records on.
    const records = opts.blobs.map((b) => `\x1e${FAKE_SHA}\n${b}\n`).join("");
    writeFileSync(join(dir, "records.txt"), records);

    const stubs: Array<[string, string]> = [
      // The §2.1 recipe makes exactly one git call (the sentinel-separated
      // log); the stub ignores its args and serves the canned records.
      [
        "git",
        `#!/usr/bin/env bash\nif [ "\${GIT_FAIL:-0}" = "1" ]; then exit 1; fi\ncat "${join(dir, "records.txt")}"\n`,
      ],
      [
        "gh",
        // Serves raw event JSON and applies the recipe's REAL --jq filter via
        // jq, so the reopened-event select() is exercised, not bypassed.
        `#!/usr/bin/env bash\nprintf 'gh %s\\n' "$*" >> "\${GH_LOG:?}"\n` +
          `if [ "$1" = "api" ]; then\n  JQ=""\n  while [ $# -gt 0 ]; do [ "$1" = "--jq" ] && JQ="$2"; shift; done\n` +
          `  case "\${GH_EVENTS:-none}" in\n    fail) exit 1;;\n    reopened) RAW='[{"event":"closed"},{"event":"reopened"}]';;\n    *) RAW='[{"event":"closed"},{"event":"labeled"}]';;\n  esac\n` +
          `  if [ -n "$JQ" ]; then echo "$RAW" | jq -r "$JQ"; else echo "$RAW"; fi\nfi\nexit 0\n`,
      ],
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
      `TARGET_GH_REPO='example/target'`,
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
        GH_EVENTS: opts.events ?? "none",
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

const CLOSING = "feat: wire the thing\n\nCloses #431";

test("vocabulary-only overlap with no closing ref to the anchor keeps it", () => {
  // The #4279 defect regression: topically adjacent commits never skip.
  const r = runStep21({
    blobs: [
      "alpha bravo charlie delta echo foxtrot golf hotel india juliet",
      "docs(ops): systemd reconcile\n\nrefactoring exposure gate",
    ],
  });
  assert.equal(r.shipped, 0, "no closing ref to #431 means no evidence");
  assert.equal(r.ghLog, "", "a keep verdict must not touch the board (not even the events read)");
  assert.equal(r.hydraLog, "", "a keep verdict must not emit a friction cue");
});

test("a commit body saying Closes #431 skips the anchor", () => {
  const r = runStep21({ blobs: ["unrelated change", CLOSING] });
  assert.equal(r.shipped, 1);
  assert.ok(r.stdout.includes(FAKE_SHA), "the verdict names the matched commit");
});

test("closing keywords are matched case-insensitively with optional colon", () => {
  for (const body of ["Fixes: #431", "resolved #431.", "CLOSED #431", "fix #431"]) {
    const r = runStep21({ blobs: [`subject\n\n${body}`] });
    assert.equal(r.shipped, 1, `"${body}" is a closing ref`);
  }
});

test("plain mentions of the anchor number keep the anchor", () => {
  for (const body of ["part of #431", "refs #431", "after #431 lands", "feat: thing (#431)", "prefix #431"]) {
    const r = runStep21({ blobs: [`${body}\n\n${body}`] });
    assert.equal(r.shipped, 0, `"${body}" is not a closing ref`);
  }
});

test("a closing ref to a different number keeps the anchor", () => {
  const r = runStep21({ blobs: ["x\n\nCloses #4310", "y\n\nFixes #43", "z\n\nCloses #1431"] });
  assert.equal(r.shipped, 0, "#4310, #43 and #1431 are not #431");
});

test("a reopened issue keeps the anchor and posts nothing", () => {
  const r = runStep21({ blobs: [CLOSING], events: "reopened" });
  assert.equal(r.shipped, 0, "an operator reopen overrides the closing-ref hit");
  assert.ok(r.ghLog.includes("api repos/example/target/issues/431/events"), `events read expected; saw: ${r.ghLog}`);
  assert.ok(!r.ghLog.includes("issue edit"), "a keep verdict must not relabel");
  assert.equal(r.hydraLog, "", "a keep verdict must not emit a friction cue");
});

test("negated or newline-separated closing keywords keep the anchor", () => {
  for (const body of ["does not close #431", "doesn't fix #431", "never resolves #431", "closes\n#431", "fixes\n\n#431"]) {
    const r = runStep21({ blobs: [`subject\n\n${body}`] });
    assert.equal(r.shipped, 0, `"${body}" is not a closing ref`);
  }
});

test("negation guard has word boundaries: n?t-ending words do not disqualify a closing ref", () => {
  for (const body of ["unit closes #431", "net fixes #431", "cannot resolves #431", "Closes #431"]) {
    const r = runStep21({ blobs: [`subject\n\n${body}`] });
    assert.equal(r.shipped, 1, `"${body}" is a genuine closing ref`);
  }
  for (const body of ["doesn't close #431", "doesn\u2019t close #431", "not fixes #431", "without closing #431"]) {
    const r = runStep21({ blobs: [`subject\n\n${body}`] });
    assert.equal(r.shipped, 0, `"${body}" is negated`);
  }
});

test("the log scan has no -n commit window (INV-6)", () => {
  assert.ok(!/log origin\/main -n\b/.test(extractStep21Block()), "no -n cap expected");
});

test("a quote/backslash-adjacent closing ref cannot corrupt the friction-cue payload", () => {
  const r = runStep21({ blobs: ['subject\n\n"Closes #431\\"'] });
  assert.equal(r.shipped, 1);
  const m = r.hydraLog.match(/\{[\s\S]*\}/);
  assert.ok(m, `cue payload expected; saw: ${r.hydraLog}`);
  JSON.parse(m[0]);
});

test("a failed events read fails open and keeps the anchor", () => {
  const r = runStep21({ blobs: [CLOSING], events: "fail" });
  assert.equal(r.shipped, 0);
  assert.ok(!r.ghLog.includes("issue edit"));
  assert.equal(r.hydraLog, "");
});

test("unreachable git log fails open and keeps the anchor", () => {
  const r = runStep21({ blobs: [CLOSING], gitFails: true });
  assert.equal(r.shipped, 0, "failure must degrade to no evidence, so keep");
  assert.equal(r.ghLog, "", "fail-open must not touch the board");
  assert.equal(r.hydraLog, "", "fail-open must not emit a friction cue");
});

// ---------------------------------------------------------------------------
// The positive verdict's board side-effects
// ---------------------------------------------------------------------------

test("a positive verdict never closes the board issue", () => {
  const r = runStep21({ blobs: [CLOSING] });
  assert.equal(r.shipped, 1, "scenario must produce a positive verdict");
  assert.ok(!/issue close/.test(r.ghLog), `gh stub must never be asked to close; saw: ${r.ghLog}`);
  assert.ok(!r.ghLog.includes("--reason completed"), `no close-reason either; saw: ${r.ghLog}`);
});

test("a positive verdict clears the in-progress claim label", () => {
  const r = runStep21({ blobs: [CLOSING] });
  assert.equal(r.shipped, 1, "scenario must produce a positive verdict");
  assert.ok(
    r.ghLog.includes("issue edit") && r.ghLog.includes("--remove-label in-progress"),
    `claim-clear is the one sanctioned board write; saw: ${r.ghLog}`,
  );
});

test("a positive verdict still posts the friction cue naming the matched commit", () => {
  const r = runStep21({ blobs: [CLOSING] });
  assert.equal(r.shipped, 1, "scenario must produce a positive verdict");
  assert.ok(r.hydraLog.includes("/memory/subagent-friction"), `cue POST must fire; saw: ${r.hydraLog}`);
  assert.ok(
    r.hydraLog.includes("target-build-anchor-skip-suspected-shipped"),
    `cue name must stay byte-identical; saw: ${r.hydraLog}`,
  );
  assert.ok(r.hydraLog.includes(FAKE_SHA), "context names the matched commit");
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
  assert.ok(block.includes("$(mktemp)"), "the log blob flows through a temp file");
  assert.equal(
    (block.match(/git -C "\$TARGET_WT" log/g) ?? []).length,
    1,
    "exactly one log call",
  );
  assert.ok(!/graphql/i.test(block), "REST only - never GraphQL (ADR-0031 Decision 6)");
  assert.ok(
    block.includes('git -C "$TARGET_WT" log'),
    "origin/main is read via git -C $TARGET_WT log (worktree isolation; issue #4411 dropped " +
      "the hardcoded /web suffix — the worktree itself is now nested under $TARGET_APP_DIR, " +
      "which may be the workspace root when appSubdir is empty)",
  );
  assert.ok(
    !/git[ \t]+(checkout|pull)\b/.test(shellOnly),
    "the recipe must never checkout/pull — least of all in the Target's main tree ($TARGET_WS)",
  );
});

test("the step 2.1 prose keeps the residual-guard framing behind close-discipline", () => {
  assert.ok(
    STEP_21.includes("residual guard") && STEP_21.includes("close-discipline"),
    "§2.1 must stay framed as the residual guard behind enforced Closes #N close-discipline (ADR-0031 Decision 5)",
  );
});

// ---------------------------------------------------------------------------
// Step 3.1 ledger-missing guard (issue #4531)
//
// A Target that ships no ledger generator (no `deadcode:ledger` script in its
// app package.json) legitimately has no docs/agents/wiring-status.md, so a
// missing ledger there is not friction. The §3.1 bash block is extracted and
// executed against a temp TARGET_WS, same harness style as §2.1 above.
// ---------------------------------------------------------------------------

const LEDGER_MISSING_CUE = "grounding-preflight-ledger-missing";
const FELL_THROUGH = "PREFLIGHT_FELL_THROUGH";

/** The §3.1 bash recipe: the first ```bash fence after the `### 3.1.` heading. */
function extractStep31Block(): string {
  const heading = FRAGMENT.indexOf("### 3.1.");
  assert.ok(heading >= 0, "fragment must contain the ### 3.1. heading");
  const open = FRAGMENT.indexOf("```bash", heading);
  assert.ok(open >= 0, "§3.1 must contain a ```bash fence");
  const start = open + "```bash".length;
  const end = FRAGMENT.indexOf("\n```", start);
  assert.ok(end > start, "§3.1 bash fence must close");
  return FRAGMENT.slice(start + 1, end);
}

/** The ledger-missing branch only: from the `! -f` guard to its top-level `else`. */
function extractLedgerMissingBranch(): string {
  const block = extractStep31Block();
  const open = block.indexOf('if [ ! -f "$WIRING_STATUS_PATH" ]; then');
  assert.ok(open >= 0, "§3.1 must keep the `! -f $WIRING_STATUS_PATH` guard");
  const close = block.indexOf("\nelse\n", open);
  assert.ok(close > open, "the guard must keep its top-level else (the ledger-present branch)");
  return block.slice(open, close);
}

interface Run31Opts {
  /** wiring-status.md content; omitted → the ledger file does not exist. */
  ledger?: string;
  /** Raw package.json text; omitted → no package.json at all. */
  packageJson?: string;
  /** TARGET_APP_SUBDIR ("" for a repo-root Target, "web" for a nested app). */
  appSubdir?: string;
}

interface Run31Result {
  status: number | null;
  /** stdout lines, minus the wrapper's fell-through trailer. */
  lines: string[];
  /** True iff the block reached its end without `exit` (⇒ proceeds to Step 3.5). */
  fellThrough: boolean;
  ghLog: string;
  hydraLog: string;
  /** Sorted paths under TARGET_WS before / after the run. */
  treeBefore: string[];
  treeAfter: string[];
}

function listTree(root: string): string[] {
  const res = spawnSync("find", [root, "-mindepth", "1"], { encoding: "utf8" });
  return (res.stdout ?? "").split("\n").filter(Boolean).sort();
}

function runStep31(opts: Run31Opts): Run31Result {
  const dir = mkdtempSync(join(tmpdir(), "preflight-4531-"));
  try {
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    const ws = join(dir, "ws");
    const subdir = opts.appSubdir ?? "";
    const appDir = subdir ? join(ws, subdir) : ws;
    mkdirSync(appDir, { recursive: true });
    if (opts.packageJson !== undefined) writeFileSync(join(appDir, "package.json"), opts.packageJson);
    if (opts.ledger !== undefined) {
      mkdirSync(join(ws, "docs/agents"), { recursive: true });
      writeFileSync(join(ws, "docs/agents/wiring-status.md"), opts.ledger);
    }

    const stubs: Array<[string, string]> = [
      ["gh", `#!/usr/bin/env bash\nprintf 'gh %s\\n' "$*" >> "\${GH_LOG:?}"\nexit 0\n`],
      ["hydra", `#!/usr/bin/env bash\nprintf 'hydra %s\\n' "$*" >> "\${HYDRA_LOG:?}"\nexit 0\n`],
    ];
    for (const [name, body] of stubs) {
      const p = join(binDir, name);
      writeFileSync(p, body);
      chmodSync(p, 0o755);
    }

    const wrapper = [
      `TARGET_WS=${shSingleQuote(ws)}`,
      `TARGET_APP_SUBDIR=${shSingleQuote(subdir)}`,
      `TARGET_GH_REPO='example/target'`,
      `ANCHOR_NUM='431'`,
      `ANCHOR_REF='issue-431'`,
      `CYCLE_ID='test-cycle'`,
      extractStep31Block(),
      `echo "${FELL_THROUGH}"`,
      "",
    ].join("\n");
    const wrapperPath = join(dir, "run.sh");
    writeFileSync(wrapperPath, wrapper);

    const ghLogPath = join(dir, "gh.log");
    const hydraLogPath = join(dir, "hydra.log");
    const treeBefore = listTree(ws);
    const res = spawnSync("bash", [wrapperPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        GH_LOG: ghLogPath,
        HYDRA_LOG: hydraLogPath,
      },
    });
    const all = (res.stdout ?? "").split("\n").filter((l) => l.length > 0);
    return {
      status: res.status,
      lines: all.filter((l) => l !== FELL_THROUGH),
      fellThrough: all.includes(FELL_THROUGH),
      ghLog: existsSync(ghLogPath) ? readFileSync(ghLogPath, "utf-8") : "",
      hydraLog: existsSync(hydraLogPath) ? readFileSync(hydraLogPath, "utf-8") : "",
      treeBefore,
      treeAfter: listTree(ws),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PKG_NO_GENERATOR = JSON.stringify({
  name: "ledgerless-target",
  scripts: { "deadcode:check": "knip", "deadcode:report": "knip --reporter json" },
});
const PKG_WITH_GENERATOR = JSON.stringify({
  name: "ledger-target",
  scripts: { "deadcode:ledger": "node scripts/build-wiring-ledger.mjs" },
});

/** Shared "a missing ledger never blocks the build" assertions. */
function assertNeverBlocks(r: Run31Result): void {
  assert.equal(r.status, 0, "a missing ledger must never exit non-zero");
  assert.ok(r.fellThrough, "a missing ledger must fall through to Step 3.5, not `exit`");
  assert.equal(r.ghLog, "", `a missing ledger must never relabel the anchor; saw: ${r.ghLog}`);
  assert.ok(
    !r.hydraLog.includes("/events/publish"),
    `a missing ledger must never publish target:reframe-save; saw: ${r.hydraLog}`,
  );
}

test("a missing ledger with no deadcode:ledger generator is a silent skip with no friction post", () => {
  const r = runStep31({ packageJson: PKG_NO_GENERATOR });
  assert.equal(r.hydraLog, "", `no ledger expected ⇒ no Pattern Memory write; saw: ${r.hydraLog}`);
  assert.equal(r.lines.length, 1, `exactly one informational stdout line; saw: ${JSON.stringify(r.lines)}`);
  assert.match(r.lines[0], /declares no wiring ledger/);
  assert.match(r.lines[0], /skipped/);
  assertNeverBlocks(r);
});

test("a missing ledger with a deadcode:ledger generator still posts the unchanged friction cue", () => {
  const r = runStep31({ packageJson: PKG_WITH_GENERATOR });
  assert.ok(r.hydraLog.includes("/memory/subagent-friction"), `expected ledger ⇒ friction POST; saw: ${r.hydraLog}`);
  assert.ok(
    r.hydraLog.includes(`"cue":"${LEDGER_MISSING_CUE}"`),
    `the cue string must stay byte-identical; saw: ${r.hydraLog}`,
  );
  assert.ok(
    r.hydraLog.includes(`"skill":"hydra-target-build"`),
    `the skill must stay hydra-target-build; saw: ${r.hydraLog}`,
  );
  assertNeverBlocks(r);
});

test("a missing ledger with a nested-app generator resolves package.json under the app subdir", () => {
  const r = runStep31({ packageJson: PKG_WITH_GENERATOR, appSubdir: "web" });
  assert.ok(r.hydraLog.includes(LEDGER_MISSING_CUE), `web/package.json generator ⇒ friction; saw: ${r.hydraLog}`);
  assertNeverBlocks(r);
});

test("a missing ledger with no package.json is a silent skip because uncertainty never emits friction", () => {
  const r = runStep31({});
  assert.equal(r.hydraLog, "", `missing package.json ⇒ not expected ⇒ no friction; saw: ${r.hydraLog}`);
  assert.equal(r.lines.length, 1, `exactly one informational stdout line; saw: ${JSON.stringify(r.lines)}`);
  assertNeverBlocks(r);
});

test("a missing ledger with a malformed package.json is a silent skip because uncertainty never emits friction", () => {
  const r = runStep31({ packageJson: '{ "scripts": { "deadcode:ledger": ' });
  assert.equal(r.hydraLog, "", `malformed package.json ⇒ not expected ⇒ no friction; saw: ${r.hydraLog}`);
  assertNeverBlocks(r);
});

test("a present ledger that does not intersect the scope reports no ledger hits and posts no friction", () => {
  const r = runStep31({
    packageJson: PKG_WITH_GENERATOR,
    ledger: [
      "| Module | Status |",
      "|---|---|",
      "| `web/src/unrelated/retired-thing.ts` | wire-or-retire |",
      "| `web/src/unrelated/pending-thing.ts` | awaiting-wiring |",
      "",
    ].join("\n"),
  });
  assert.equal(r.status, 0);
  assert.ok(
    r.lines.some((l) => l.includes("no ledger hits")),
    `the ledger-present clean-scope message must be unchanged; saw: ${JSON.stringify(r.lines)}`,
  );
  assert.ok(
    !r.lines.some((l) => l.includes("declares no wiring ledger")),
    "the generator probe must not run when the ledger exists",
  );
  assert.equal(r.hydraLog, "", `a clean ledger-present run posts nothing; saw: ${r.hydraLog}`);
  assert.equal(r.ghLog, "", `a clean ledger-present run relabels nothing; saw: ${r.ghLog}`);
});

test("the ledger-missing probe never writes into the Target workspace", () => {
  const scenarios: Run31Opts[] = [{ packageJson: PKG_NO_GENERATOR }, { packageJson: PKG_WITH_GENERATOR }, {}];
  for (const opts of scenarios) {
    const r = runStep31(opts);
    assert.deepEqual(r.treeAfter, r.treeBefore, "the probe is a pure read — no file may appear in TARGET_WS");
  }
});

test("the ledger-missing branch stays guard-compatible: one flat jq probe, no loops, no nested substitution", () => {
  const branch = extractLedgerMissingBranch();
  const shellOnly = branch
    .replace(/'[\s\S]*?'/g, "''")
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  assert.ok(!/<\(/.test(shellOnly), "no process substitution — the #3896 guard refuses it");
  assert.ok(!/\$\([^)]*\$\(/.test(shellOnly), "no nested command substitution — refused");
  assert.ok(
    !/^[ \t]*(for|while|until)[ \t]/m.test(shellOnly) && !/^[ \t]*done\b/m.test(shellOnly),
    "no shell loop in the ledger-missing branch",
  );
  assert.equal((shellOnly.match(/\$\(/g) ?? []).length, 1, "exactly one command substitution: the jq generator probe");
  assert.ok(branch.includes(`.scripts["deadcode:ledger"] // empty`), "the probe reads scripts[\"deadcode:ledger\"]");
  assert.ok(
    branch.includes('"$TARGET_WS/${TARGET_APP_SUBDIR:+$TARGET_APP_SUBDIR/}package.json"'),
    "the probe reads package.json from $TARGET_WS — the same tree the ledger is read from",
  );
  assert.ok(!/git[ \t]+(checkout|pull)\b/.test(shellOnly), "the probe must never checkout/pull");
  assert.ok(!/\bexit\b/.test(shellOnly), "no ledger-missing branch may exit the build");
});

test("the step 3.1 prose describes the two-branch ledger-missing behaviour", () => {
  const step31 = FRAGMENT.slice(FRAGMENT.indexOf("### 3.1."), FRAGMENT.indexOf("### 3.2."));
  assert.ok(step31.includes("deadcode:ledger"), "the prose must name the generator that makes a ledger expected");
  assert.ok(
    !step31.includes("`grep` exits non-zero"),
    "the stale claim that grep runs against a missing ledger must be gone — the guard short-circuits first",
  );
  assert.ok(step31.includes("Never fail the build on a missing"), "the never-block contract stays stated");
});

// ---------------------------------------------------------------------------
// Step 3.1 ledger-present extraction is appSubdir-agnostic (issue #4553)
//
// The WOR_ROWS/AW_ROWS extraction used to anchor on a literal `web/` prefix,
// so a repo-root Target (appSubdir "") never extracted a clean path. The
// extraction now takes the backticked FIRST table column, whatever its prefix.
// ---------------------------------------------------------------------------

function ledgerWithWireOrRetireRow(path: string): string {
  return [
    "| Module | Status | Imported by | Last touched |",
    "|---|---|---|---|",
    `| \`${path}\` | wire-or-retire | tests only | 2026-04-01 |`,
    "",
  ].join("\n");
}

test("a repo-root Target ledger row intersecting the scope stops the build with the clean extracted path", () => {
  const r = runStep31({
    packageJson: PKG_WITH_GENERATOR,
    appSubdir: "",
    ledger: ledgerWithWireOrRetireRow("src/example-module/example-file.ts"),
  });
  assert.equal(r.status, 0);
  assert.ok(!r.fellThrough, `a wire-or-retire hit must STOP, not fall through; saw: ${JSON.stringify(r.lines)}`);
  assert.ok(
    r.lines.some((l) => l.includes("GROUNDING PREFLIGHT STOP: wire-or-retire")),
    `expected the wire-or-retire STOP banner; saw: ${JSON.stringify(r.lines)}`,
  );
  assert.ok(
    r.lines.some((l) => l.trim().startsWith("src/example-module/example-file.ts (hits scope:")),
    `the hit must name the clean first-column path (no backticks, no table debris); saw: ${JSON.stringify(r.lines)}`,
  );
  assert.match(r.ghLog, /--add-label reframe/, `the anchor must be relabelled reframe; saw: ${r.ghLog}`);
});

test("a nested web Target ledger row intersecting the scope still stops the build", () => {
  const r = runStep31({
    packageJson: PKG_WITH_GENERATOR,
    appSubdir: "web",
    ledger: ledgerWithWireOrRetireRow("web/src/example-module/example-file.ts"),
  });
  assert.equal(r.status, 0);
  assert.ok(!r.fellThrough, `a wire-or-retire hit must STOP, not fall through; saw: ${JSON.stringify(r.lines)}`);
  assert.ok(
    r.lines.some((l) => l.trim().startsWith("web/src/example-module/example-file.ts (hits scope:")),
    `the hit must name the clean first-column path; saw: ${JSON.stringify(r.lines)}`,
  );
  assert.match(r.ghLog, /--add-label reframe/, `the anchor must be relabelled reframe; saw: ${r.ghLog}`);
});
