/**
 * Regression test for issue #512 — auto-escalation to GitHub via gh CLI.
 *
 * Strategy: stub the `gh` binary with a fake bash script controlled via
 * env vars (FAKE_GH_OUTPUT_DIR, FAKE_GH_SCENARIO). The escalation module
 * picks up the fake via HYDRA_GH_BIN. Each scenario writes the gh argv to
 * a file so the assertions can inspect what was invoked, and returns the
 * canned stdout the production code would parse.
 *
 * Scenarios:
 *   - `none`     : `gh issue list` returns []  → escalation creates a new issue.
 *   - `open`     : `gh issue list` returns one OPEN issue → comment-bump.
 *   - `closed`   : `gh issue list` returns one CLOSED issue → reopen + comment.
 *   - `error`    : `gh` exits non-zero → escalation returns status="error".
 */

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import Redis from "ioredis";

import type {
  EscalationInput,
  EscalationResult,
} from "../src/pattern-memory/escalation.ts";

let workDir: string;
let fakeGhPath: string;
let invocationsPath: string;

let originalGhBin: string | undefined;
let originalDisabled: string | undefined;
let originalRepo: string | undefined;

let escalatePatternToIssue: typeof import("../src/pattern-memory/escalation.ts").escalatePatternToIssue;
let shouldEscalateAtHitCount: typeof import("../src/pattern-memory/escalation.ts").shouldEscalateAtHitCount;
let findExistingIssue: typeof import("../src/pattern-memory/escalation.ts").findExistingIssue;
let escalationThresholdForCue: typeof import("../src/pattern-memory/escalation.ts").escalationThresholdForCue;
let isMetadataCue: typeof import("../src/pattern-memory/escalation.ts").isMetadataCue;

/** Render a fake gh script that dispatches by SCENARIO env var. */
async function writeFakeGh(path: string, invocationsLog: string) {
  // The fake script appends its argv to a JSONL log file, then emits the
  // scenario-appropriate stdout. `gh issue list` returns JSON; everything
  // else returns a short success line.
  const body = `#!/usr/bin/env bash
set -u
SCENARIO=\${FAKE_GH_SCENARIO:-none}
LOGFILE="${invocationsLog}"
printf '%s\\n' "$(printf '%s ' "$@")" >> "$LOGFILE"

# Recognise the sub-command.
CMD="\${1:-}"; SUBCMD="\${2:-}"

if [ "$SCENARIO" = "error" ]; then
  echo "fake gh: simulated failure" >&2
  exit 1
fi

if [ "$CMD" = "issue" ] && [ "$SUBCMD" = "list" ]; then
  case "$SCENARIO" in
    none)
      echo '[]'
      ;;
    open)
      echo '[{"number": 999, "state": "OPEN", "title": "meta(friction): some-cue hit 3 times across hydra-dev"}]'
      ;;
    closed)
      echo '[{"number": 999, "state": "CLOSED", "title": "meta(friction): some-cue hit 3 times across hydra-dev"}]'
      ;;
    *)
      echo '[]'
      ;;
  esac
  exit 0
fi

if [ "$CMD" = "issue" ] && [ "$SUBCMD" = "create" ]; then
  echo "https://github.com/gaberoo322/hydra/issues/1234"
  exit 0
fi

if [ "$CMD" = "issue" ] && [ "$SUBCMD" = "comment" ]; then
  echo "https://github.com/gaberoo322/hydra/issues/999#issuecomment-1"
  exit 0
fi

if [ "$CMD" = "issue" ] && [ "$SUBCMD" = "reopen" ]; then
  echo "reopened"
  exit 0
fi

if [ "$CMD" = "label" ]; then
  # The label-create call. Treat "already exists" as success.
  exit 0
fi

# Unknown — succeed silently.
exit 0
`;
  await writeFile(path, body, "utf-8");
  await chmod(path, 0o755);
}

async function readInvocations(): Promise<string[]> {
  if (!existsSync(invocationsPath)) return [];
  const raw = await readFile(invocationsPath, "utf-8");
  return raw.split("\n").filter(l => l.trim().length > 0);
}

async function resetInvocations() {
  await writeFile(invocationsPath, "", "utf-8");
}

describe("escalation to GitHub (issue #512)", () => {
  before(async () => {
    workDir = await mkdtemp(join(tmpdir(), "hydra-escalation-"));
    await mkdir(workDir, { recursive: true });
    fakeGhPath = join(workDir, "fake-gh");
    invocationsPath = join(workDir, "invocations.log");
    await writeFakeGh(fakeGhPath, invocationsPath);

    originalGhBin = process.env.HYDRA_GH_BIN;
    originalDisabled = process.env.HYDRA_ESCALATION_DISABLED;
    originalRepo = process.env.HYDRA_GH_REPO;
    process.env.HYDRA_GH_BIN = fakeGhPath;
    process.env.HYDRA_GH_REPO = "gaberoo322/hydra";
    delete process.env.HYDRA_ESCALATION_DISABLED;

    const mod = await import("../src/pattern-memory/escalation.ts");
    escalatePatternToIssue = mod.escalatePatternToIssue;
    shouldEscalateAtHitCount = mod.shouldEscalateAtHitCount;
    findExistingIssue = mod.findExistingIssue;
    escalationThresholdForCue = mod.escalationThresholdForCue;
    isMetadataCue = mod.isMetadataCue;
  });

  beforeEach(async () => {
    await resetInvocations();
  });

  after(async () => {
    if (originalGhBin === undefined) delete process.env.HYDRA_GH_BIN;
    else process.env.HYDRA_GH_BIN = originalGhBin;
    if (originalDisabled === undefined) delete process.env.HYDRA_ESCALATION_DISABLED;
    else process.env.HYDRA_ESCALATION_DISABLED = originalDisabled;
    if (originalRepo === undefined) delete process.env.HYDRA_GH_REPO;
    else process.env.HYDRA_GH_REPO = originalRepo;
    delete process.env.FAKE_GH_SCENARIO;
    await rm(workDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // shouldEscalateAtHitCount — pure helper
  // -------------------------------------------------------------------------

  test("shouldEscalateAtHitCount: fires at threshold-cross", () => {
    assert.equal(shouldEscalateAtHitCount(3, 3), true);
  });

  test("shouldEscalateAtHitCount: silent between threshold-cross and next decade", () => {
    for (const n of [4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      assert.equal(shouldEscalateAtHitCount(n, 3), false, `hitCount=${n} should NOT fire`);
    }
  });

  test("shouldEscalateAtHitCount: fires on each multiple-of-10 above threshold", () => {
    assert.equal(shouldEscalateAtHitCount(13, 3), true);
    assert.equal(shouldEscalateAtHitCount(23, 3), true);
    assert.equal(shouldEscalateAtHitCount(33, 3), true);
    assert.equal(shouldEscalateAtHitCount(14, 3), false);
    assert.equal(shouldEscalateAtHitCount(2, 3), false);
  });

  // -------------------------------------------------------------------------
  // findExistingIssue
  // -------------------------------------------------------------------------

  test("findExistingIssue: returns null when gh issue list is empty", async () => {
    process.env.FAKE_GH_SCENARIO = "none";
    const got = await findExistingIssue("some-cue");
    assert.equal(got, null);
  });

  test("findExistingIssue: returns OPEN match", async () => {
    process.env.FAKE_GH_SCENARIO = "open";
    const got = await findExistingIssue("some-cue");
    assert.notEqual(got, null);
    assert.equal(got!.number, 999);
    assert.equal(got!.state, "OPEN");
  });

  test("findExistingIssue: returns CLOSED match", async () => {
    process.env.FAKE_GH_SCENARIO = "closed";
    const got = await findExistingIssue("some-cue");
    assert.notEqual(got, null);
    assert.equal(got!.state, "CLOSED");
  });

  // -------------------------------------------------------------------------
  // escalatePatternToIssue: create / comment / reopen branches
  // -------------------------------------------------------------------------

  test("creates a new issue when no existing match is found", async () => {
    process.env.FAKE_GH_SCENARIO = "none";
    const result = await escalatePatternToIssue({
      kind: "friction",
      cue: "stale-local-master-ref",
      hitCount: 3,
      skills: ["hydra-dev"],
      workarounds: ["used origin/master"],
      lastReference: "issue-512",
    });
    assert.equal(result.status, "created");
    if (result.status === "created") {
      assert.equal(result.issueNumber, 1234);
    }
    const invocations = await readInvocations();
    // Should have called: issue list (search), label create, issue create.
    assert.ok(invocations.some(l => l.startsWith("issue list ")), "expected `gh issue list` invocation");
    assert.ok(invocations.some(l => l.startsWith("issue create ")), "expected `gh issue create` invocation");
    assert.ok(invocations.some(l => l.includes("meta-friction")), "expected meta-friction label in args");
  });

  test("comment-bumps when an OPEN issue with the cue already exists", async () => {
    process.env.FAKE_GH_SCENARIO = "open";
    const result = await escalatePatternToIssue({
      kind: "friction",
      cue: "some-cue",
      hitCount: 13,
      skills: ["hydra-dev"],
      workarounds: ["w1", "w2"],
    });
    assert.equal(result.status, "commented");
    if (result.status === "commented") {
      assert.equal(result.issueNumber, 999);
    }
    const invocations = await readInvocations();
    assert.ok(invocations.some(l => l.startsWith("issue comment 999")), "expected comment on issue 999");
    assert.ok(
      !invocations.some(l => l.startsWith("issue create ")),
      "must NOT create a duplicate issue",
    );
  });

  test("reopens + comments when the only matching issue is CLOSED", async () => {
    process.env.FAKE_GH_SCENARIO = "closed";
    const result = await escalatePatternToIssue({
      kind: "friction",
      cue: "some-cue",
      hitCount: 3,
      skills: ["hydra-target-build"],
    });
    assert.equal(result.status, "reopened");
    if (result.status === "reopened") {
      assert.equal(result.issueNumber, 999);
    }
    const invocations = await readInvocations();
    assert.ok(invocations.some(l => l.startsWith("issue reopen 999")), "expected reopen on 999");
    assert.ok(invocations.some(l => l.startsWith("issue comment 999")), "expected comment after reopen");
    assert.ok(!invocations.some(l => l.startsWith("issue create ")), "must NOT create a duplicate");
  });

  test("returns status=error when gh fails — never throws", async () => {
    process.env.FAKE_GH_SCENARIO = "error";
    const result = await escalatePatternToIssue({
      kind: "friction",
      cue: "broken-cue",
      hitCount: 3,
      skills: ["hydra-dev"],
    });
    assert.equal(result.status, "error");
  });

  test("returns status=skipped when HYDRA_ESCALATION_DISABLED is set", async () => {
    process.env.HYDRA_ESCALATION_DISABLED = "1";
    try {
      const result = await escalatePatternToIssue({
        kind: "friction",
        cue: "any-cue",
        hitCount: 3,
        skills: ["hydra-dev"],
      });
      assert.equal(result.status, "skipped");
    } finally {
      delete process.env.HYDRA_ESCALATION_DISABLED;
    }
  });

  test("returns status=skipped when cue is empty", async () => {
    process.env.FAKE_GH_SCENARIO = "none";
    const result = await escalatePatternToIssue({
      kind: "friction",
      cue: "",
      hitCount: 3,
      skills: ["hydra-dev"],
    });
    assert.equal(result.status, "skipped");
  });

  // -------------------------------------------------------------------------
  // Issue #524 — acceptance-criterion-deferred vs unmet cue split
  // -------------------------------------------------------------------------

  test("escalationThresholdForCue: acceptance-criterion-unmet keeps the default (3)", () => {
    assert.equal(escalationThresholdForCue("acceptance-criterion-unmet", 3), 3);
  });

  test("escalationThresholdForCue: acceptance-criterion-deferred uses the higher 20-hit threshold", () => {
    assert.equal(escalationThresholdForCue("acceptance-criterion-deferred", 3), 20);
  });

  test("escalationThresholdForCue: unknown cues fall back to the default", () => {
    assert.equal(escalationThresholdForCue("scope-creep", 3), 3);
    assert.equal(escalationThresholdForCue("verification-failure", 3), 3);
    // Falsy/odd inputs also fall back.
    assert.equal(escalationThresholdForCue("", 3), 3);
    assert.equal(escalationThresholdForCue(undefined as unknown as string, 7), 7);
  });

  test("isMetadataCue: deferred is metadata, unmet and others are not", () => {
    assert.equal(isMetadataCue("acceptance-criterion-deferred"), true);
    assert.equal(isMetadataCue("acceptance-criterion-unmet"), false);
    assert.equal(isMetadataCue("scope-creep"), false);
    assert.equal(isMetadataCue(""), false);
  });

  test("shouldEscalateAtHitCount with deferred threshold (20): silent below 20", () => {
    for (const n of [1, 3, 5, 10, 15, 19]) {
      assert.equal(
        shouldEscalateAtHitCount(n, 20),
        false,
        `hitCount=${n} should NOT escalate at threshold=20`,
      );
    }
  });

  test("shouldEscalateAtHitCount with deferred threshold (20): fires at 20", () => {
    assert.equal(shouldEscalateAtHitCount(20, 20), true);
  });

  test("shouldEscalateAtHitCount with deferred threshold (20): fires on +10 multiples", () => {
    assert.equal(shouldEscalateAtHitCount(30, 20), true);
    assert.equal(shouldEscalateAtHitCount(40, 20), true);
    assert.equal(shouldEscalateAtHitCount(50, 20), true);
    // Off-by-one sanity checks — must remain silent between decade marks.
    assert.equal(shouldEscalateAtHitCount(21, 20), false);
    assert.equal(shouldEscalateAtHitCount(29, 20), false);
    assert.equal(shouldEscalateAtHitCount(31, 20), false);
  });

  // -------------------------------------------------------------------------
  // Integration-ish: agent-memory.recordPattern() should populate
  // `result.escalation` as null for the deferred cue at hit 3 (its threshold
  // is higher), while the unmet cue still fires at hit 3 as it always has.
  //
  // We exercise this via the pure threshold-resolution helpers rather than
  // running through Redis. Since issue #823 folded the dispatch into
  // recordPattern (record-then-escalate in one operation), the decision under
  // test here is the same one recordPattern uses both to populate its returned
  // `escalation` field and to drive the internal escalate() dispatch.
  // -------------------------------------------------------------------------

  test("deferred cue suppresses escalation at hit 3 (unmet still fires)", () => {
    const unmetThreshold = escalationThresholdForCue("acceptance-criterion-unmet", 3);
    const deferredThreshold = escalationThresholdForCue("acceptance-criterion-deferred", 3);

    // Hit 3 (the legacy `PROMOTION_THRESHOLD`) — unmet fires, deferred does not.
    assert.equal(shouldEscalateAtHitCount(3, unmetThreshold), true);
    assert.equal(shouldEscalateAtHitCount(3, deferredThreshold), false);

    // Hit 20 — deferred fires for the first time; unmet would NOT (only
    // multiples of 10 above its threshold of 3 fire, i.e. 13, 23, 33...).
    assert.equal(shouldEscalateAtHitCount(20, deferredThreshold), true);
    assert.equal(shouldEscalateAtHitCount(20, unmetThreshold), false);
  });

  // -------------------------------------------------------------------------
  // Issue #1789 — no-agent-spawn-tool-run-inline never escalates
  // -------------------------------------------------------------------------
  //
  // The hydra-target-build Step-2 inline-mode contract (#1782) fires this cue
  // by design on every autopilot-dispatched inline build, so a finite
  // threshold would just defer noise and the escalator would reopen the closed
  // issue forever. The cue is mapped to POSITIVE_INFINITY: the threshold
  // resolves to Infinity and shouldEscalateAtHitCount is false at every finite
  // hit count, while the default path for unrelated cues is unchanged.

  test("escalationThresholdForCue: no-agent-spawn-tool-run-inline resolves to Infinity", () => {
    assert.equal(
      escalationThresholdForCue("no-agent-spawn-tool-run-inline", 3),
      Number.POSITIVE_INFINITY,
    );
  });

  test("no-agent-spawn-tool-run-inline never escalates at any finite hit count", () => {
    const threshold = escalationThresholdForCue("no-agent-spawn-tool-run-inline", 3);
    for (const h of [3, 4, 13, 23, 33, 1003]) {
      assert.equal(
        shouldEscalateAtHitCount(h, threshold),
        false,
        `hitCount=${h} should NOT escalate for the never-escalate cue`,
      );
    }
  });

  test("Infinity override does not regress the default path — an unrelated cue still escalates at 3", () => {
    const threshold = escalationThresholdForCue("verification-failure", 3);
    assert.equal(threshold, 3);
    assert.equal(shouldEscalateAtHitCount(3, threshold), true);
    assert.equal(shouldEscalateAtHitCount(13, threshold), true);
  });

  test("uses meta(lesson) title for kind=lesson, meta(friction) for kind=friction", async () => {
    process.env.FAKE_GH_SCENARIO = "none";
    await escalatePatternToIssue({
      kind: "lesson",
      cue: "verification-failure",
      hitCount: 3,
      skills: ["hydra-dev"],
    });
    const invocations = await readInvocations();
    // Find the `issue create` invocation and check the title arg.
    const createLine = invocations.find(l => l.startsWith("issue create "));
    assert.ok(createLine, "expected an issue create invocation");
    assert.ok(createLine!.includes("meta(lesson)"), `expected meta(lesson) in title, got: ${createLine}`);
  });
});

// ===========================================================================
// Issue #843 — Escalation Outcome threaded up + stamped on the record
//
// recordPattern now returns the EscalationResult (`escalationResult`) and
// stamps `MemoryPattern.lastEscalation` via a best-effort SECOND save AFTER the
// escalation, ONLY when an escalation actually fired. These tests inject the
// `escalate` dep so they never shell out to `gh`, and round-trip through Redis
// to assert the stamp is durable.
// ===========================================================================

describe("Escalation Outcome threading + stamp (issue #843)", () => {
  const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/1";
  process.env.REDIS_URL = REDIS_URL;

  let redis: InstanceType<typeof Redis>;
  let recordPattern: typeof import("../src/pattern-memory/agent-memory.ts").recordPattern;
  let originalConfigPath: string | undefined;
  let tempConfigRoot: string;

  // A friction-namespace agent so we never write to-{agent}.md feedback files.
  const SKILL = "issue-843-skill";

  async function loadFrictionPatterns(skill: string): Promise<any[]> {
    const raw = await redis.get(`hydra:friction:${skill}:patterns`);
    if (!raw) return [];
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  async function cleanKeys() {
    const keys = await redis.keys(`hydra:friction:${SKILL}:patterns`);
    if (keys.length > 0) await redis.del(...keys);
  }

  before(async () => {
    tempConfigRoot = await mkdtemp(join(tmpdir(), "hydra-esc-outcome-"));
    await mkdir(join(tempConfigRoot, "feedback"), { recursive: true });
    originalConfigPath = process.env.HYDRA_CONFIG_PATH;
    process.env.HYDRA_CONFIG_PATH = tempConfigRoot;

    redis = new Redis(REDIS_URL);
    const mod = await import("../src/pattern-memory/agent-memory.ts");
    recordPattern = mod.recordPattern;
  });

  beforeEach(async () => {
    await cleanKeys();
  });

  after(async () => {
    if (redis) {
      await cleanKeys();
      redis.disconnect();
    }
    if (originalConfigPath === undefined) delete process.env.HYDRA_CONFIG_PATH;
    else process.env.HYDRA_CONFIG_PATH = originalConfigPath;
    await rm(tempConfigRoot, { recursive: true, force: true });
  });

  /** Build a recordPattern args tuple for the friction namespace. */
  const args = (i: number, escalate: any) =>
    [SKILL, "issue-843-cue", {
      namespace: "friction" as const,
      action: "Observe the escalation outcome.",
      example: `cycle-${i}: issue-843-cue`,
      cycleId: `cycle-${i}`,
      escalate,
    }] as const;

  test("escalationResult is null below threshold; lastEscalation unstamped", async () => {
    // An escalate spy that would record if called — it must NOT fire below
    // threshold (intent is null, so recordPattern passes null and the spy
    // returns null without doing anything observable).
    const escalate = async (
      escalation: EscalationInput | null,
    ): Promise<EscalationResult | null> => {
      return escalation ? { status: "skipped", reason: "spy" } : null;
    };

    const r1 = await recordPattern(...args(1, escalate));
    assert.equal(r1.escalationResult, null, "1st hit: no escalation → null result");
    assert.equal(r1.pattern.lastEscalation, undefined, "no stamp below threshold");

    const r2 = await recordPattern(...args(2, escalate));
    assert.equal(r2.escalationResult, null);
    assert.equal(r2.pattern.lastEscalation, undefined);

    // Confirm durability: the stored record has no lastEscalation field.
    const stored = await loadFrictionPatterns(SKILL);
    const row = stored.find(p => p.category === "issue-843-cue");
    assert.ok(row, "pattern should be stored");
    assert.equal(row.lastEscalation, undefined, "below-threshold record must lack lastEscalation");
  });

  test("at threshold: escalationResult returned AND lastEscalation stamped + durable", async () => {
    const escalate = async (
      escalation: EscalationInput | null,
    ): Promise<EscalationResult | null> => {
      return escalation ? { status: "created", issueNumber: 4242 } : null;
    };

    await recordPattern(...args(1, escalate));
    await recordPattern(...args(2, escalate));
    const r3 = await recordPattern(...args(3, escalate)); // hit 3 == PROMOTION_THRESHOLD

    assert.ok(r3.escalation, "intent should be populated at threshold");
    assert.ok(r3.escalationResult, "outcome should be threaded up");
    assert.equal(r3.escalationResult!.status, "created");
    assert.equal(
      r3.escalationResult!.status === "created" ? r3.escalationResult!.issueNumber : -1,
      4242,
    );

    // Stamp on the in-memory pattern.
    assert.ok(r3.pattern.lastEscalation, "lastEscalation should be stamped");
    assert.equal(r3.pattern.lastEscalation!.status, "created");
    assert.equal(r3.pattern.lastEscalation!.issueNumber, 4242);
    assert.ok(
      !Number.isNaN(Date.parse(r3.pattern.lastEscalation!.at)),
      "lastEscalation.at must be a parseable ISO timestamp",
    );

    // Load the record back: the second best-effort save must have persisted it.
    const stored = await loadFrictionPatterns(SKILL);
    const row = stored.find(p => p.category === "issue-843-cue");
    assert.ok(row?.lastEscalation, "stamp must survive the Redis round-trip");
    assert.equal(row.lastEscalation.status, "created");
    assert.equal(row.lastEscalation.issueNumber, 4242);
  });

  test("best-effort preserved: escalate returns error → record saved + lastEscalation.status === 'error'", async () => {
    const escalate = async (
      escalation: EscalationInput | null,
    ): Promise<EscalationResult | null> => {
      return escalation ? { status: "error", error: "simulated gh outage" } : null;
    };

    await recordPattern(...args(1, escalate));
    await recordPattern(...args(2, escalate));
    const r3 = await recordPattern(...args(3, escalate));

    // recordPattern resolved (did not throw) and the core fields are intact.
    assert.equal(r3.pattern.hitCount, 3, "core record fields must be durably saved");
    assert.ok(r3.escalationResult, "error outcome is still a value");
    assert.equal(r3.escalationResult!.status, "error");
    assert.equal(r3.pattern.lastEscalation!.status, "error");
    assert.equal(r3.pattern.lastEscalation!.error, "simulated gh outage");

    const stored = await loadFrictionPatterns(SKILL);
    const row = stored.find(p => p.category === "issue-843-cue");
    assert.equal(row.hitCount, 3, "hit must never be lost to a gh outage");
    assert.equal(row.lastEscalation.status, "error");
  });

  test("best-effort preserved: escalate THROWS → recordPattern still resolves with the hit saved", async () => {
    // The default escalateIfNeeded never throws, but a misbehaving injected dep
    // could. recordPattern must not throw; the hit must still be committed.
    // Note: the throw happens during the dispatch, so the stamp-save is skipped
    // (no result), but the FIRST save (the core record) is already committed.
    const escalate = async (): Promise<EscalationResult | null> => {
      throw new Error("dispatcher blew up");
    };

    await assert.doesNotReject(async () => {
      await recordPattern(...args(1, escalate));
    }, "recordPattern must never throw even when the injected escalate throws");

    const stored = await loadFrictionPatterns(SKILL);
    const row = stored.find(p => p.category === "issue-843-cue");
    assert.ok(row, "the core record must be committed before the dispatch");
    assert.equal(row.hitCount, 1);
  });
});
