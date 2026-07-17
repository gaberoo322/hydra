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
 *   - target_needs_research   (surfaced for symmetry)
 *
 * The `ready_for_agent` count the endpoint returns is already open-blocker
 * excluded via the inherited #3059 filter (ADR-0031 Decision 5), so the
 * blocked-exclusion is enforced upstream at the board read — this collector
 * just surfaces the already-filtered count.
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
  test("emits the three target_-prefixed counts decide.py's Target branch reads", () => {
    const out = runEmitter({
      ready_for_agent: 3,
      needs_qa: 2,
      needs_research: 1,
      // Extra board fields the endpoint returns must be ignored — the Target
      // branch only consumes these three counts.
      needs_triage: 5,
      in_progress: 4,
      blocked: 7,
      stale_in_progress: [10, 11],
      stale_blocked: [12],
    });
    assert.equal(out.target_ready_for_agent, "3");
    assert.equal(out.target_needs_qa, "2");
    assert.equal(out.target_needs_research, "1");
    // Never leak the orch-collision-prone unprefixed keys.
    assert.equal(out.ready_for_agent, undefined);
    assert.equal(out.needs_qa, undefined);
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
