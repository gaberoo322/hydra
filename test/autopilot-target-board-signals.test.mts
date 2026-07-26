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
    /python3 -c "(\nimport json,sys\nd=json\.load\(sys\.stdin\)\n# Emit only the counts decide\.py's Target branch[\s\S]*?)"/,
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
      /gh issue list --repo "\$TARGET_GH_REPO" --state open --json/,
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

  test("the fallback gh read carries --limit 100, matching listOpenIssues DEFAULT_LIMIT", () => {
    // Without it gh defaults to 30 and silently truncates: the Target repo had
    // 35 open issues when #3709 was filed, so every target_ count was
    // under-reported on the degraded path.
    assert.match(
      src,
      /gh issue list --repo "\$TARGET_GH_REPO" --state open --json number,labels --limit 100 --jq/,
      "the Target fallback must page to the same DEFAULT_LIMIT=100 the healthy path uses",
    );
  });
});
