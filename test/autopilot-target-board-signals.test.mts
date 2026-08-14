/**
 * Regression test for issue #3435 (spec #3432, ADR-0031) —
 * `scripts/autopilot/collect-state.sh` Target board-state emission.
 *
 * ADR-0031 migrates Target task tracking from Redis to GitHub Issues on the
 * Target repo. collect-state.sh reads the scope=target board-state
 * (`GET /api/autopilot/board-state?scope=target`, issue #3434 — the same pure
 * `deriveBoardState` reused byte-for-byte against the Target repo) and emits the
 * counts decide.py's Target branch consumes as dispatch signals, prefixed
 * `target_` so they never collide with the orch board counts:
 *
 *   - target_ready_for_agent  (drives target_board_work_available → dev_target)
 *   - target_needs_qa         (drives needs_qa_target             → qa_target)
 *   - target_needs_triage     (drives needs_triage_target         → sweep_target)
 *   - target_needs_research   (surfaced for symmetry)
 *
 * `target_needs_triage` was added by issue #3709: decide.py's `sweep_target`
 * selector had always read `needs_triage_target`, but collect-state.sh never
 * emitted the count behind it, so the signal had ZERO producers and the arm
 * was permanently dead (the same defect class as #959's `orch_idle`).
 *
 * The `ready_for_agent` count the endpoint returns is already open-blocker
 * excluded via the inherited #3059 filter (ADR-0031 Decision 5), so the
 * blocked-exclusion is enforced upstream at the board read — this collector
 * just surfaces the already-filtered count. That filter applies to
 * `ready_for_agent` ONLY: `needs_triage` is a raw label tally upstream, so the
 * healthy branch and the `gh`-REST fallback agree by construction and NEITHER
 * excludes blocked items (triage is precisely the act of re-examining a
 * blocked item's lane — excluding them would deadlock them out of triage).
 *
 * This test pins the EMISSION side: the exact python emitter the script pipes
 * `$TARGET_BOARD_STATE_JSON` through, exercised against synthetic board JSON so
 * a future edit can't silently drift the seam decide.py reads. (Mirrors
 * test/autopilot-arch-fallback-signals.test.mts.)
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "autopilot", "collect-state.sh");
const src = readFileSync(SCRIPT, "utf-8");

// Extract the python emitter the script pipes TARGET_BOARD_STATE_JSON through
// on the healthy-endpoint path, so the test exercises the exact logic the
// script ships (not a copy that can drift). The block lives between
// `printf '%s' "$TARGET_BOARD_STATE_JSON" | python3 -c "` and its closing `"`.
function extractTargetBoardEmitter(): string {
  // Anchor on the emitter's unique first print line so we bind the emitter
  // block (not the sibling degraded-check block that also pipes the same var).
  const match = src.match(
    /python3 -c "\$\(cat <<'PY'(\nimport json,sys\nd=json\.load\(sys\.stdin\)\n# Emit only the counts decide\.py's Target branch[\s\S]*?)\nPY\n\)"/,
  );
  assert.ok(match, "could not locate the target board emitter python block in collect-state.sh");
  return match[1];
}

function runEmitter(board: Record<string, unknown>): Record<string, string> {
  const r = spawnSync("python3", ["-c", extractTargetBoardEmitter()], {
    input: JSON.stringify(board),
    encoding: "utf-8",
  });
  assert.equal(r.status, 0, `emitter exited non-zero: ${r.stderr}`);
  const out: Record<string, string> = {};
  for (const line of (r.stdout ?? "").trim().split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

describe("collect-state.sh — Target board-state emission (issue #3435, ADR-0031)", () => {
  test("emits the four target_-prefixed counts decide.py's Target branch reads", () => {
    const out = runEmitter({
      ready_for_agent: 3,
      needs_qa: 2,
      needs_triage: 5,
      needs_research: 1,
      // Extra board fields the endpoint returns must be ignored — the Target
      // branch only consumes these four counts.
      in_progress: 4,
      blocked: 7,
      stale_in_progress: [10, 11],
      stale_blocked: [12],
    });
    assert.equal(out.target_ready_for_agent, "3");
    assert.equal(out.target_needs_qa, "2");
    assert.equal(out.target_needs_research, "1");
    assert.equal(
      out.target_needs_triage,
      "5",
      "issue #3709: without this count needs_triage_target has no producer and sweep_target is a dead arm",
    );
    // Never leak the orch-collision-prone unprefixed keys.
    assert.equal(out.ready_for_agent, undefined);
    assert.equal(out.needs_qa, undefined);
    assert.equal(out.needs_triage, undefined);
  });

  test("a triage-only board still emits target_needs_triage (the sweep_target trigger)", () => {
    // The live shape that exposed #3709: the Target board held 9 needs-triage
    // items and nothing else actionable, yet sweep_target reported "no
    // triggering signal" every turn because this count was never printed.
    const out = runEmitter({
      ready_for_agent: 0,
      needs_qa: 0,
      needs_triage: 9,
      needs_research: 0,
    });
    assert.equal(out.target_needs_triage, "9");
    assert.equal(out.target_ready_for_agent, "0");
  });

  test("an empty target board emits zero ready_for_agent (drives research, not dev)", () => {
    const out = runEmitter({
      ready_for_agent: 0,
      needs_qa: 0,
      needs_research: 0,
    });
    assert.equal(
      out.target_ready_for_agent,
      "0",
      "target_ready_for_agent==0 is the board-empty signal the autopilot maps to target_board_research_due",
    );
  });

  test("missing count fields default to 0 (never a crash / never a bare key)", () => {
    // A board-state response that omits a count (shape drift) must degrade to 0
    // for that field, not throw — the collector is best-effort.
    const out = runEmitter({ ready_for_agent: 5 });
    assert.equal(out.target_ready_for_agent, "5");
    assert.equal(out.target_needs_qa, "0");
    assert.equal(out.target_needs_triage, "0");
    assert.equal(out.target_needs_research, "0");
  });
});

describe("collect-state.sh — Target board-state seam wiring (issue #3435)", () => {
  test("reads the scope=target board-state endpoint (ADR-0031 Decision 3 one-seam reuse)", () => {
    assert.match(
      src,
      /hydra raw GET "\/autopilot\/board-state\?scope=target"/,
      "the Target board read must hit the scope=target board-state endpoint, reusing deriveBoardState",
    );
  });

  test("fallback reads the Target repo over REST, never GraphQL (ADR-0031 Decision 6)", () => {
    // The degraded-endpoint fallback must use `gh issue list --json` (REST),
    // NOT `gh api graphql` — the money-critical Target hot path stays off the
    // saturated GraphQL pool.
    assert.match(
      src,
      /gh issue list --repo "\$TARGET_GH_REPO" --state open --limit "\$GH_ISSUE_LIST_LIMIT" --json/,
      "the Target fallback must be a REST gh issue list against the Target repo",
    );
    const targetBlock = src.slice(src.indexOf("TARGET_BOARD_STATE_JSON"));
    assert.doesNotMatch(
      targetBlock.slice(0, targetBlock.indexOf("# untriaged-orphans triage backstop")),
      /gh api graphql/,
      "the Target board block must never reach for GraphQL (ADR-0031 Decision 6 REST-only constraint)",
    );
  });

  test("resolves the Target repo from HYDRA_TARGET_GITHUB_REPO with a hydra-betting default", () => {
    assert.match(
      src,
      /TARGET_GH_REPO="\$\{HYDRA_TARGET_GITHUB_REPO:-gaberoo322\/hydra-betting\}"/,
      "the Target repo handle must be env-overridable with the hydra-betting default (ADR-0002)",
    );
  });
});

/**
 * The degraded/`gh`-REST fallback branch (issue #3709).
 *
 * When the orchestrator endpoint is down or reports `degraded:true`, the same
 * four `target_` counts are re-spelled as an inline `gh issue list --jq`.
 * These cases run the COMMITTED bash filter through real `jq` so the two
 * implementations cannot drift, mirroring the orch-side precedent in
 * test/autopilot-board.test.mts.
 */
describe("collect-state.sh — Target board gh-REST fallback (issue #3709)", () => {
  /** Pull one `<key>: [...] | length` line out of the committed fallback --jq. */
  function extractFilter(key: string): string {
    const match = src.match(new RegExp(`^\\s*${key}: (\\[.*\\] \\| length),?$`, "m"));
    assert.ok(match, `could not locate the fallback ${key} jq filter`);
    return match[1];
  }

  function count(filter: string, issues: readonly { labels: string[] }[]): string {
    const input = issues.map((i) => ({ labels: i.labels.map((name) => ({ name })) }));
    const r = spawnSync("jq", [filter], { input: JSON.stringify(input), encoding: "utf-8" });
    assert.equal(r.status, 0, `jq failed: ${r.stderr}`);
    return (r.stdout ?? "").trim();
  }

  test("counts open needs-triage issues", () => {
    assert.equal(
      count(extractFilter("target_needs_triage"), [
        { labels: ["needs-triage"] },
        { labels: ["needs-triage", "enhancement"] },
        { labels: ["ready-for-agent"] },
        { labels: [] },
      ]),
      "2",
    );
  });

  test("does NOT exclude blocked items — triage is how a blocked lane gets re-examined", () => {
    // Deliberate divergence from `target_ready_for_agent`, which IS
    // open-blocker excluded upstream (#3059). `needs_triage` is a raw label
    // tally on BOTH branches; filtering blocked items here would deadlock them
    // out of triage forever.
    assert.equal(
      count(extractFilter("target_needs_triage"), [
        { labels: ["needs-triage"] },
        { labels: ["needs-triage", "blocked"] },
        { labels: ["needs-triage", "target-backlog"] },
      ]),
      "3",
      "every open needs-triage issue counts, blocked ones included",
    );
  });

  test("no needs-triage labels → 0 (never a phantom sweep_target dispatch)", () => {
    assert.equal(
      count(extractFilter("target_needs_triage"), [
        { labels: ["ready-for-agent"] },
        { labels: ["needs-qa"] },
      ]),
      "0",
    );
  });

  test("total failure of the fallback emits target_needs_triage=0, like its siblings", () => {
    assert.match(
      src,
      /\|\| \{ echo "target_ready_for_agent=0"; echo "target_needs_qa=0"; echo "target_needs_triage=0"; echo "target_needs_research=0"; \}/,
      "a failed fallback read must fail open to zero for all four counts — a degraded read must never phantom-dispatch sweep_target",
    );
  });

  test("the fallback gh read carries the shared limit, matching listOpenIssues DEFAULT_LIMIT", () => {
    // Without a limit gh defaults to 30 and silently truncates: the Target repo
    // had 35 open issues when #3709 was filed, so every target_ count was
    // under-reported on the degraded path. #3709 fixed this site with a literal
    // `--limit 100`; #3710 replaced that literal with the shared
    // GH_ISSUE_LIST_LIMIT constant so the nine call sites cannot drift apart.
    assert.match(
      src,
      /gh issue list --repo "\$TARGET_GH_REPO" --state open --limit "\$GH_ISSUE_LIST_LIMIT" --json number,labels --jq/,
      "the Target fallback must page via the shared constant, not a private literal",
    );
    // Scoped to parsed commands, not raw source: the script's own comments
    // discuss `--limit 100` in prose, and asserting over raw text would fail on
    // documentation. (This is the same class of false positive that makes a
    // grep-based version of the ratchet below untrustworthy.)
    for (const c of logicalCommands(src).filter((x) => x.text.includes("gh issue list"))) {
      assert.doesNotMatch(
        c.text,
        /--limit 100/,
        `line ${c.line}: no site may re-inline the literal 100 — the point of #3710 is one constant`,
      );
    }
  });
});

/**
 * Every `gh issue list` in collect-state.sh carries an explicit `--limit`
 * (issue #3710).
 *
 * `gh issue list` defaults to 30 with no error and no warning, and it sorts
 * newest-first — so an unlimited call silently drops the OLDEST issues, which
 * is precisely the cohort the age-sensitive consumers care about
 * (`wire_or_retire_target_available` gates on a 45-day ledger;
 * `target_backfill_idle` flips true on a board whose only remaining triage
 * items were truncated away). The Target board was already past 30 when #3710
 * was filed: five open issues were invisible to the collector every turn.
 *
 * WHY THIS TEST IS NOT A GREP. The issue originally proposed
 * `grep 'gh issue list' | grep -v -- '--limit'`. That is actively misleading
 * against this file, in BOTH directions:
 *
 *   - FALSE FAILURES: three of the twelve `gh issue list` occurrences are
 *     comment prose (the header docs, the ADR-0031 REST-only note, the
 *     wayfinder cost note), not invocations at all.
 *   - FALSE PASSES: three real invocations span line continuations, so a
 *     line-oriented grep stops reading before the flag. The Target healthy-path
 *     call deliberately carries its `--limit` on a continuation line, which a
 *     naive grep would report as unlimited.
 *
 * So the assertion runs over LOGICAL shell commands: comment lines are dropped
 * at command boundaries only (inside an open quote a leading `#` is data, not a
 * comment), and physical lines are joined across both continuation forms —
 * a trailing backslash AND an unterminated quote (the `--jq '` blocks).
 */

type QuoteState = null | "'" | '"';

/** Advance shell quote state across one physical line. */
function scanQuotes(text: string, state: QuoteState): QuoteState {
  let s = state;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (s === "'") {
      // Single quotes are literal in shell: nothing escapes, only `'` closes.
      if (c === "'") s = null;
      continue;
    }
    if (s === '"') {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === '"') s = null;
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "'" || c === '"') s = c;
  }
  return s;
}

type LogicalCommand = { line: number; text: string };

/** Split shell source into logical commands, skipping whole-line comments. */
function logicalCommands(source: string): LogicalCommand[] {
  const lines = source.split("\n");
  const out: LogicalCommand[] = [];
  let buf = "";
  let startLine = 0;
  let quote: QuoteState = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (buf === "") {
      // A leading `#` is a comment ONLY at a command boundary. Mid-command it
      // is data (a jq comment, prose inside a quoted body) and dropping it
      // would corrupt the join — and comment prose is full of apostrophes
      // ("decide.py's"), which would wreck the quote scanner if fed to it.
      if (raw.trim() === "" || /^\s*#/.test(raw)) continue;
      startLine = i + 1;
      buf = raw;
    } else {
      buf += "\n" + raw;
    }
    quote = scanQuotes(raw, quote);
    // Continue on an unterminated quote (multi-line `--jq '...'`) or on an
    // explicit backslash line continuation.
    if (quote !== null || /\\$/.test(raw)) continue;
    out.push({ line: startLine, text: buf });
    buf = "";
  }
  if (buf !== "") out.push({ line: startLine, text: buf });
  return out;
}

const ghIssueListCommands = () =>
  logicalCommands(src).filter((c) => c.text.includes("gh issue list"));

describe("collect-state.sh — gh issue list page-size ratchet (issue #3710)", () => {
  test("the parser skips comment prose and joins BOTH continuation forms", () => {
    // A miniature of the exact shapes in collect-state.sh. If this fixture
    // parses correctly, the assertion below is trustworthy; if the parser ever
    // regresses to line-oriented matching, this fails first and explains why.
    const fixture = [
      "#!/usr/bin/env bash",
      "# Prose: one `gh issue list` fetch, per decide.py's cost note.",
      "#   - Another `gh issue list` mention, with an apostrophe's worth of risk.",
      "LIMITED=$(gh issue list --repo o/r --state open \\",
      '  --limit "$L" \\',
      "  --json number --jq 'length')",
      "gh issue list --repo o/r --state open --json number --jq '",
      "  [ .[] | .number ]",
      "  | length'",
      "echo done",
    ].join("\n");

    const cmds = logicalCommands(fixture).filter((c) => c.text.includes("gh issue list"));

    assert.equal(
      cmds.length,
      2,
      "three of the five `gh issue list` occurrences are prose — a grep would see five",
    );
    assert.ok(
      cmds[0].text.includes('--limit "$L"'),
      "the backslash-continued invocation must be joined so its continuation-line --limit is visible",
    );
    assert.ok(
      cmds[1].text.includes("| length'"),
      "the unterminated-quote invocation must be joined through its closing quote",
    );
    assert.deepEqual(
      cmds.filter((c) => !c.text.includes("--limit")).map((c) => c.line),
      [7],
      "exactly the one genuinely unlimited invocation is flagged, by its real line number",
    );
  });

  test("every gh issue list invocation carries an explicit --limit", () => {
    const cmds = ghIssueListCommands();
    const unlimited = cmds.filter((c) => !c.text.includes("--limit"));
    assert.deepEqual(
      unlimited.map((c) => `line ${c.line}`),
      [],
      "gh defaults to 30 and truncates newest-first — an unlimited list silently drops the oldest issues",
    );
  });

  test("every invocation sources its limit from the one shared constant", () => {
    for (const c of ghIssueListCommands()) {
      assert.ok(
        c.text.includes('--limit "$GH_ISSUE_LIST_LIMIT"'),
        `line ${c.line}: limit must come from GH_ISSUE_LIST_LIMIT, not a private literal that can drift`,
      );
    }
  });

  test("the parser resolves the file's real invocations without over-joining", () => {
    const cmds = ghIssueListCommands();
    assert.ok(
      cmds.length >= 9,
      `expected at least the 9 known call sites, parsed ${cmds.length} — the parser lost invocations`,
    );
    for (const c of cmds) {
      const occurrences = c.text.split("gh issue list").length - 1;
      assert.equal(
        occurrences,
        1,
        `line ${c.line}: two commands were joined into one, so a missing --limit could hide behind a sibling's`,
      );
    }
  });

  test("the shared constant defaults to 100 — the GitHub API's max single page", () => {
    assert.match(
      src,
      /^GH_ISSUE_LIST_LIMIT="\$\{HYDRA_GH_ISSUE_LIST_LIMIT:-100\}"$/m,
      "100 is one API page (zero extra round trips on a per-turn hot path) and matches DEFAULT_LIMIT in src/github/issues.ts",
    );
  });

  test("never --paginate: unbounded paging is not the fix for a truncated hot-path read", () => {
    // Again scoped to commands — the constant's own docstring names
    // `--paginate` to explain why it was rejected.
    for (const c of ghIssueListCommands()) {
      assert.doesNotMatch(
        c.text,
        /--paginate/,
        `line ${c.line}: paging trades a silent truncation for unbounded per-turn latency and rate-limit cost`,
      );
    }
  });
});

/**
 * `target_board_signals_truncated` — the advisory incompleteness signal
 * (issue #3710).
 *
 * A flat `--limit 100` fixes today's instance but leaves the defect CLASS
 * intact: a truncated read stays indistinguishable from a complete one, just at
 * a higher and rarer threshold — i.e. it next bites long after anyone
 * remembers the fix. So the Target healthy-path read (the only site that both
 * materialises the array AND already owns a published signal contract) checks
 * `len(rows) >= limit` on data already in hand — zero extra API calls — and
 * publishes the result.
 *
 * It is deliberately a SEPARATE key from `target_board_signals_degraded`,
 * because the two mean opposite things:
 *   degraded  = the read failed            -> suppress dispatch (fail closed)
 *   truncated = the read is incomplete     -> keep dispatching
 * Folding truncation into `degraded` would stall the entire Target lane on a
 * merely-large board, which is a worse outcome than the under-count it fixes.
 */
describe("collect-state.sh — Target board truncation signal (issue #3710)", () => {
  /** The Target lane-signal emitter (distinct from the board-state emitter above). */
  function extractLaneEmitter(): string {
    const match = src.match(/python3 -c "\$\(cat <<'PY'(\nimport json, os, sys\ntry:\n  rows = json\.load[\s\S]*?)\nPY\n\)"\s*2>\/dev\/null/);
    assert.ok(match, "could not locate the Target lane-signal python block in collect-state.sh");
    return match[1];
  }

  function runLaneEmitter(
    rows: readonly { labels: string[] }[],
    env: Record<string, string> = {},
  ): Record<string, string> {
    const r = spawnSync("python3", ["-c", extractLaneEmitter()], {
      input: JSON.stringify(rows.map((row) => ({ labels: row.labels }))),
      encoding: "utf-8",
      env: { ...process.env, GH_ISSUE_LIST_LIMIT: "100", ...env },
    });
    assert.equal(r.status, 0, `lane emitter exited non-zero: ${r.stderr}`);
    const out: Record<string, string> = {};
    for (const line of (r.stdout ?? "").trim().split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return out;
  }

  const rows = (n: number, labels: string[] = ["needs-triage"]) =>
    Array.from({ length: n }, () => ({ labels }));

  test("a board under the page size reports truncated=false", () => {
    const out = runLaneEmitter(rows(35), { GH_ISSUE_LIST_LIMIT: "100" });
    assert.equal(out.target_board_signals_truncated, "false");
  });

  test("a row count exactly at the page size reports truncated=true", () => {
    // `length == limit` is the only in-band evidence available without a second
    // request. A board sitting at exactly the limit is itself worth surfacing,
    // so the false-positive case is an acceptable — arguably desirable — cost.
    const out = runLaneEmitter(rows(100), { GH_ISSUE_LIST_LIMIT: "100" });
    assert.equal(out.target_board_signals_truncated, "true");
  });

  test("truncation is ADVISORY — it never flips a dispatch-gating signal", () => {
    // The regression that matters: a large-but-healthy board must keep
    // dispatching. If truncation ever starts suppressing, the Target lane
    // stalls exactly when the board is busiest.
    const out = runLaneEmitter(
      [...rows(60, ["needs-triage"]), ...rows(40, ["wire-or-retire", "needs-triage"])],
      { GH_ISSUE_LIST_LIMIT: "100" },
    );
    assert.equal(out.target_board_signals_truncated, "true");
    assert.equal(
      out.wire_or_retire_target_available,
      "true",
      "a truncated read is still a successful read — it must not suppress the resolver",
    );
    assert.equal(out.target_cleanup_board_saturated, "false");
    assert.equal(out.design_qa_target_due, "true");
  });

  test("truncation and degradation stay separate keys with opposite meanings", () => {
    const out = runLaneEmitter(rows(100), { GH_ISSUE_LIST_LIMIT: "100" });
    assert.equal(
      out.target_board_signals_degraded,
      undefined,
      "degraded is emitted by the shell branch, never folded into the truncation check",
    );
    assert.equal(out.target_board_signals_truncated, "true");
  });

  test("the emitter honours the shared limit rather than hardcoding 100", () => {
    const out = runLaneEmitter(rows(30), { GH_ISSUE_LIST_LIMIT: "30" });
    assert.equal(
      out.target_board_signals_truncated,
      "true",
      "lowering HYDRA_GH_ISSUE_LIST_LIMIT must lower the truncation threshold with it",
    );
  });

  test("the key is emitted on the degraded branch too, so decide.py never sees it missing", () => {
    // A read that never happened is not a truncated read — it is a degraded
    // one. Both branches must still publish the key.
    const degradedBranch = src.slice(src.indexOf('echo "target_board_signals_degraded=true"'));
    assert.match(
      degradedBranch.slice(0, 400),
      /echo "target_board_signals_truncated=false"/,
      "the unreachable-read branch must emit truncated=false, not omit the key",
    );
    assert.equal(
      src.match(/target_board_signals_truncated=/g)?.length,
      4,
      "expected 4 emission sites: healthy, python-except, python-invocation-failure, and degraded",
    );
  });
});

/**
 * `wire_or_retire_target_unlabelled` — advisory visibility signal for
 * wire-or-retire items carrying no lifecycle label (issue #3973).
 *
 * A Target issue carrying `wire-or-retire` but NONE of the recognised lifecycle
 * labels (`needs-triage`, `ready-for-agent`, `ready-for-human`, `blocked`) is
 * invisible to the /hydra-wire-or-retire resolver: collect-state.sh gates that
 * resolver on `wire-or-retire` AND `needs-triage` (the load-bearing AND from
 * #3726), so an item with `wire-or-retire` + a non-lifecycle label like `bug`
 * reads wire_or_retire_target_available=false while sitting in plain sight —
 * the live gaberoo322/hydra-betting#760 case, undetected since a 2026-08-03
 * hand-reframe. This signal is the advisory count of those invisible items.
 *
 * It does NOT relax the AND predicate (that would regress #3726, the reason
 * #3747 was closed) and does NOT gate dispatch, mirroring
 * `target_board_signals_truncated`'s advisory contract. Both already-resolved
 * shapes are correctly excluded: `ready-for-human` is the resolver's own
 * UNCLEAR verdict output, and `ready-for-agent` is a WIRE/RETIRE verdict
 * output — counting either would re-arm the resolver forever, the exact hazard
 * the AND predicate exists to prevent.
 */
describe("collect-state.sh — wire-or-retire unlabelled advisory count (issue #3973)", () => {
  /** The Target lane-signal emitter (same block the truncation tests exercise). */
  function extractLaneEmitter(): string {
    const match = src.match(
      /python3 -c "\$\(cat <<'PY'(\nimport json, os, sys\ntry:\n  rows = json\.load[\s\S]*?)\nPY\n\)"\s*2>\/dev\/null/,
    );
    assert.ok(match, "could not locate the Target lane-signal python block in collect-state.sh");
    return match[1];
  }

  function runLaneEmitter(
    rows: readonly { number?: number; labels: string[] }[],
    env: Record<string, string> = {},
  ): Record<string, string> {
    const r = spawnSync("python3", ["-c", extractLaneEmitter()], {
      input: JSON.stringify(rows.map((row) => ({ number: row.number, labels: row.labels }))),
      encoding: "utf-8",
      env: { ...process.env, GH_ISSUE_LIST_LIMIT: "100", ...env },
    });
    assert.equal(r.status, 0, `lane emitter exited non-zero: ${r.stderr}`);
    const out: Record<string, string> = {};
    for (const line of (r.stdout ?? "").trim().split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return out;
  }

  test("wire-or-retire + bug only is counted (the live #760 case)", () => {
    // The exact shape that sat invisible on the Target board: a hand-reframe
    // stamped wire-or-retire + bug and no lifecycle label, so the AND-gated
    // resolver read available=false while the board's only unresolved item was
    // in plain sight.
    const out = runLaneEmitter([{ number: 760, labels: ["wire-or-retire", "bug"] }]);
    assert.equal(out.wire_or_retire_target_unlabelled, "1");
    // It is genuinely invisible to the resolver — the gap this signal surfaces.
    assert.equal(out.wire_or_retire_target_available, "false");
    assert.equal(out.wire_or_retire_target_triage, "0");
  });

  test("a bare wire-or-retire label (no other label) is counted", () => {
    const out = runLaneEmitter([{ labels: ["wire-or-retire"] }]);
    assert.equal(out.wire_or_retire_target_unlabelled, "1");
  });

  test("wire-or-retire + needs-triage is NOT counted (already resolver-visible)", () => {
    // needs-triage is the lane that makes the AND predicate fire — this item is
    // seen by the resolver and must not be double-counted as invisible.
    const out = runLaneEmitter([{ labels: ["wire-or-retire", "needs-triage"] }]);
    assert.equal(out.wire_or_retire_target_unlabelled, "0");
    assert.equal(out.wire_or_retire_target_triage, "1");
    assert.equal(out.wire_or_retire_target_available, "true");
  });

  test("wire-or-retire + ready-for-human is NOT counted (resolver's UNCLEAR verdict)", () => {
    const out = runLaneEmitter([{ labels: ["wire-or-retire", "ready-for-human"] }]);
    assert.equal(out.wire_or_retire_target_unlabelled, "0");
  });

  test("wire-or-retire + ready-for-agent is NOT counted (WIRE/RETIRE verdict)", () => {
    const out = runLaneEmitter([{ labels: ["wire-or-retire", "ready-for-agent"] }]);
    assert.equal(out.wire_or_retire_target_unlabelled, "0");
  });

  test("wire-or-retire + blocked is NOT counted (blocked is a lifecycle label)", () => {
    const out = runLaneEmitter([{ labels: ["wire-or-retire", "blocked"] }]);
    assert.equal(out.wire_or_retire_target_unlabelled, "0");
  });

  test("a non-wire-or-retire issue is never counted", () => {
    const out = runLaneEmitter([{ labels: ["bug", "enhancement"] }]);
    assert.equal(out.wire_or_retire_target_unlabelled, "0");
  });

  test("the AND predicate is unchanged: wire-or-retire + ready-for-agent stays out of wire_or_retire_target_triage", () => {
    // Issue #3973 explicitly forbids relaxing the AND predicate (#3726 is the
    // reason #3747 was closed). A ready-for-agent wire-or-retire item is a
    // resolved WIRE/RETIRE verdict and must not inflate the resolver's triage
    // count or arm the resolver.
    const out = runLaneEmitter([{ labels: ["wire-or-retire", "ready-for-agent"] }]);
    assert.equal(out.wire_or_retire_target_triage, "0");
    assert.equal(out.wire_or_retire_target_available, "false");
  });

  test("a mixed board counts only the lifecycle-less wire-or-retire items", () => {
    const out = runLaneEmitter([
      { number: 760, labels: ["wire-or-retire", "bug"] }, // counted (#760)
      { labels: ["wire-or-retire", "needs-triage"] }, // resolver-visible
      { labels: ["wire-or-retire", "ready-for-agent"] }, // resolved WIRE/RETIRE
      { labels: ["wire-or-retire", "ready-for-human"] }, // resolved UNCLEAR
      { labels: ["wire-or-retire", "blocked"] }, // lifecycle: blocked
      { labels: ["wire-or-retire"] }, // counted (bare)
      { labels: ["bug"] }, // not wire-or-retire
    ]);
    assert.equal(out.wire_or_retire_target_unlabelled, "2");
    // The AND predicate still counts only the single needs-triage co-present item.
    assert.equal(out.wire_or_retire_target_triage, "1");
    assert.equal(out.wire_or_retire_target_available, "true");
  });

  test("the count is advisory: nothing in decide.py reads or gates on it", () => {
    // Mirrors the precedent set by target_board_signals_truncated /
    // target_board_signals_degraded: both are emitted here and referenced
    // NOWHERE in decide.py. The new advisory signal must clear the same bar — a
    // dispatch gate reading it would re-arm the resolver on the resolved shapes
    // the AND predicate exists to suppress (#3726). decide.py is the sole gate.
    const decide = readFileSync(join(REPO_ROOT, "scripts", "autopilot", "decide.py"), "utf-8");
    assert.doesNotMatch(
      decide,
      /wire_or_retire_target_unlabelled/,
      "wire_or_retire_target_unlabelled is advisory only — decide.py must never read or gate a dispatch on it",
    );
  });

  test("the key is emitted on every branch so decide.py never sees it missing", () => {
    // The four emission sites: healthy try:, python except:, shell
    // invocation-failure (|| { ... }), and the outer degraded else. A missing
    // key on any branch is an invisible zero-set — the exact defect this signal
    // exists to surface, so it must not itself fall victim to it.
    assert.equal(
      src.match(/wire_or_retire_target_unlabelled=/g)?.length,
      4,
      "expected 4 emission sites: healthy, python-except, python-invocation-failure, and degraded",
    );
  });

  test("a degraded/unreachable board read emits 0, never a spurious non-zero", () => {
    // The outer else branch (TARGET_BOARD_ISSUES_JSON empty/unreachable) fails
    // closed to 0 — the suppressing direction, so a transient gh outage never
    // raises a false alarm. Mirrors every sibling target_* count in that branch.
    const degradedBranch = src.slice(src.indexOf('echo "target_board_signals_degraded=true"'));
    assert.match(
      degradedBranch.slice(0, 700),
      /echo "wire_or_retire_target_unlabelled=0"/,
      "the unreachable-read branch must emit wire_or_retire_target_unlabelled=0, not omit it or emit non-zero",
    );
  });
});
