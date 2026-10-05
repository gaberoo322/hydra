/**
 * test/hydra-target-build-anchor-preflight.test.mts — pin the Step 2.1
 * shipped-anchor preflight contract (issues #4167, #4694) and the Step 3.1
 * ledger-missing guard's expected-vs-not-expected split (issue #4531).
 *
 * The preflight is a bash recipe embedded in
 * docs/operator-playbooks/_fragments/hydra-target-build-anchor-preflight.md
 * (sync-skills.sh copies it into ~/.claude/skills/hydra-target-build/), so its
 * behavioural invariants are pinned two ways:
 *
 *   - FUNCTIONALLY: the §2.1 bash block is extracted from the fragment,
 *     wrapped with PATH-shimmed `gh` / `hydra` stubs, and executed.
 *     What passes here is what a dispatched hydra-target-build agent runs.
 *   - STRUCTURALLY: the recipe must stay guard-compatible (no process
 *     substitution, no shell loops, no nested command substitution — the
 *     worktree-isolation Bash guard refuses all three, #3896) and must keep
 *     its residual-guard framing (issue #4167's design-concept invariants).
 *
 * Scenario shape (issue #4694): the `gh api` stub serves canned REST pulls JSON;
 * only a MERGED PR whose body carries a closing verb for the anchor skips.
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

interface PullRow {
  /** null => closed-unmerged PR. */
  merged_at: string | null;
  head: { ref: string };
  body: string | null;
}

interface RunOpts {
  /** Canned `gh api .../pulls` payload (REST shape). Omit with ghFails. */
  pulls?: PullRow[] | string;
  /** When true the `gh api` stub exits 1 (unreachable gh posture). */
  ghFails?: boolean;
  /** Anchor issue number (default 431). */
  anchor?: string;
}

interface RunResult {
  /** The wrapper's stdout, ending in `SHIPPED_ON_MAIN=0|1`. */
  stdout: string;
  shipped: 0 | 1;
  /** gh calls other than the `api` read (the board writes). */
  ghLog: string;
  /** The `gh api` argv, if called. */
  apiLog: string;
  hydraLog: string;
}

/** A merged pulls row whose body is `body`. */
function merged(body: string, ref = "feature-x"): PullRow {
  return { merged_at: "2026-09-25T00:00:00Z", head: { ref }, body };
}

/**
 * Execute the extracted §2.1 recipe against stubbed gh/hydra. The `gh api`
 * call serves canned REST pulls JSON; pr-refs.py runs for real, resolved via
 * HYDRA_ROOT -> this checkout (a CI runner's ~/hydra is master and would not
 * yet carry --closing).
 */
function runStep21(opts: RunOpts): RunResult {
  const dir = mkdtempSync(join(tmpdir(), "preflight-4694-"));
  try {
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    const payload = typeof opts.pulls === "string" ? opts.pulls : JSON.stringify(opts.pulls ?? []);
    writeFileSync(join(dir, "pulls.json"), payload);

    const stubs: Array<[string, string]> = [
      [
        "gh",
        `#!/usr/bin/env bash\nif [ "$1" = "api" ]; then\n  printf 'gh %s\\n' "$*" >> "\${API_LOG:?}"\n  if [ "\${GH_FAIL:-0}" = "1" ]; then exit 1; fi\n  cat "${join(dir, "pulls.json")}"\n  exit 0\nfi\nprintf 'gh %s\\n' "$*" >> "\${GH_LOG:?}"\nexit 0\n`,
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
      `ANCHOR_NUM='${opts.anchor ?? "431"}'`,
      `TARGET_GH_REPO='example/target'`,
      `CYCLE_ID='test-cycle'`,
      block,
      `echo "SHIPPED_ON_MAIN=\${SHIPPED_ON_MAIN:-unset}"`,
      "",
    ].join("\n");
    const wrapperPath = join(dir, "run.sh");
    writeFileSync(wrapperPath, wrapper);

    const ghLogPath = join(dir, "gh.log");
    const apiLogPath = join(dir, "api.log");
    const hydraLogPath = join(dir, "hydra.log");
    const res = spawnSync("bash", [wrapperPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        HYDRA_ROOT: REPO_ROOT,
        GH_LOG: ghLogPath,
        API_LOG: apiLogPath,
        HYDRA_LOG: hydraLogPath,
        GH_FAIL: opts.ghFails ? "1" : "0",
      },
    });
    assert.equal(res.status, 0, `wrapper bash exited non-zero: ${res.stderr}`);
    const m = /SHIPPED_ON_MAIN=(\d)/.exec(res.stdout ?? "");
    assert.ok(m, `wrapper stdout must report SHIPPED_ON_MAIN: ${res.stdout}`);
    const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf-8") : "");
    return {
      stdout: res.stdout ?? "",
      shipped: Number(m![1]) as 0 | 1,
      ghLog: read(ghLogPath),
      apiLog: read(apiLogPath),
      hydraLog: read(hydraLogPath),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Functional verdicts (the extracted recipe, executed)
// ---------------------------------------------------------------------------

test("a commit or PR that cites the anchor and covers its whole subject without a closing verb keeps the anchor", () => {
  // THE #4694 regression (CSB #5 / 7d13385): a citation is not a ship.
  const r = runStep21({
    pulls: [
      merged("alpha bravo charlie delta echo foxtrot golf hotel india juliet (#431) - groundwork for #431", "issue-431-alpha"),
    ],
  });
  assert.equal(r.shipped, 0, "citing #431 (even with branch name + full subject overlap) is never positive evidence");
  assert.equal(r.ghLog, "", "a keep verdict must not touch the board");
  assert.equal(r.hydraLog, "", "a keep verdict must not emit a friction cue");
});

test("a merged PR carrying a closing verb for the anchor skips the anchor", () => {
  const r = runStep21({ pulls: [merged("Some other work.\n\nCloses #431")] });
  assert.equal(r.shipped, 1);
  assert.ok(r.apiLog.includes("pulls?state=closed"), `the merged-PR read must be a REST pulls call; saw: ${r.apiLog}`);
});

test("a closed-unmerged PR carrying Closes for the anchor keeps the anchor", () => {
  const r = runStep21({
    pulls: [{ merged_at: null, head: { ref: "abandoned" }, body: "Closes #431" }],
  });
  assert.equal(r.shipped, 0, "merged_at null (closed without merging) shipped nothing");
});

test("a merged PR that only Refs the anchor keeps the anchor", () => {
  const r = runStep21({ pulls: [merged("Refs #431")] });
  assert.equal(r.shipped, 0, "the non-closing Refs form is never positive evidence");
});

test("a merged PR closing a longer number sharing the anchor's digits keeps the anchor", () => {
  const r = runStep21({ anchor: "5", pulls: [merged("Closes #15"), merged("Fixes #50")] });
  assert.equal(r.shipped, 0, "membership is an exact whole-number match: #5 never matches 15 or 50");
  const hit = runStep21({ anchor: "5", pulls: [merged("Closes #15"), merged("Resolved #5")] });
  assert.equal(hit.shipped, 1, "an exact #5 closing link still skips");
});

test("unreachable gh fails open and keeps the anchor", () => {
  const r = runStep21({ ghFails: true });
  assert.equal(r.shipped, 0, "gh failing must degrade to an empty set -> keep");
  assert.equal(r.ghLog, "", "fail-open must not touch the board");
  assert.equal(r.hydraLog, "", "fail-open must not emit a friction cue");
});

test("a non-JSON or empty payload fails open and keeps the anchor", () => {
  for (const pulls of ["", "not json", '{"message":"rate limited"}']) {
    const r = runStep21({ pulls });
    assert.equal(r.shipped, 0, `payload ${JSON.stringify(pulls)} must keep the anchor`);
  }
});

// ---------------------------------------------------------------------------
// The positive verdict's board side-effects (all three on one skip run)
// ---------------------------------------------------------------------------

test("a positive verdict never closes the board issue", () => {
  const r = runStep21({
    pulls: [merged("Closes #431")],
  });
  assert.equal(r.shipped, 1, "scenario must produce a positive verdict");
  assert.ok(!r.ghLog.includes("close"), `gh stub must never be asked to close; saw: ${r.ghLog}`);
  assert.ok(!r.ghLog.includes("--reason completed"), `no close-reason either; saw: ${r.ghLog}`);
});

test("a positive verdict clears the in-progress claim label", () => {
  const r = runStep21({
    pulls: [merged("Closes #431")],
  });
  assert.equal(r.shipped, 1, "scenario must produce a positive verdict");
  assert.ok(
    r.ghLog.includes("issue edit") && r.ghLog.includes("--remove-label in-progress"),
    `claim-clear is the one sanctioned board write; saw: ${r.ghLog}`,
  );
});

test("a positive verdict still posts the friction cue", () => {
  const r = runStep21({
    pulls: [merged("Closes #431")],
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
    block.includes('gh api "repos/$TARGET_GH_REPO/pulls?state=closed') && !/gh\s+pr\s+list/.test(block),
    "the merged-PR read is one REST pulls page (ADR-0031 Decision 6) — never gh pr list --json / GraphQL",
  );
  assert.ok(
    block.includes('pr-refs.py" --closing') && block.includes("HYDRA_ROOT:-$HOME/hydra"),
    "the closing-verb rule lives ONCE in pr-refs.py --closing, resolved via the overridable HYDRA_ROOT",
  );
  assert.ok(
    !/SIG_WORDS|SIG_COUNT|MAX_OVERLAP|awk/.test(block),
    "the subject-word overlap scorer is deleted outright, not kept as a second arm",
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
