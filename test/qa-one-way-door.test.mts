import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  ONE_WAY_DOOR_RULES,
  detectOneWayDoor,
  requiresOneWayDepth,
} from "../src/qa/one-way-door.ts";

// scripts/ literals are built at runtime so the test-subject map does not
// resolve this test's primary subject to a script.
const sp = (...parts: string[]): string => ["scripts", ...parts].join("/");

function diffFor(path: string, added: string[] = [], removed: string[] = []): string {
  const body = [...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)].join("\n");
  return [
    `diff --git a/${path} b/${path}`,
    "index 111..222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${removed.length || 1} +1,${added.length || 1} @@`,
    body,
    "",
  ].join("\n");
}

describe("detectOneWayDoor", () => {
  test("persistent-state: added redis delete under src/redis", () => {
    const path = "src/redis/thing.ts";
    const r = detectOneWayDoor({ paths: [path], diff: diffFor(path, ["  await r.del(key);"]) });
    assert.equal(r.door, "one-way");
    assert.deepEqual(r.classes, ["persistent-state"]);
    assert.deepEqual(r.signals.map((s) => s.ruleId), ["OWD-STATE-REDIS-DELETE"]);
    assert.equal(r.signals[0].path, path);
    assert.equal(r.signals[0].line, 1);
  });

  test("persistent-state: removed hydra: key literal in keys.ts", () => {
    const path = "src/redis/keys.ts";
    const r = detectOneWayDoor({ paths: [path], diff: diffFor(path, [], ['  foo: "hydra:foo",']) });
    assert.deepEqual(r.signals.map((s) => s.ruleId), ["OWD-STATE-KEY-RENAME"]);
    assert.deepEqual(r.classes, ["persistent-state"]);
  });

  test("a removed r.del call is two-way", () => {
    const path = "src/redis/thing.ts";
    const r = detectOneWayDoor({ paths: [path], diff: diffFor(path, [], ["  await r.del(key);"]) });
    assert.equal(r.door, "two-way");
    assert.deepEqual(r.signals, []);
  });

  test("external-side-effect: gh api DELETE", () => {
    const path = sp("cleanup.sh");
    const r = detectOneWayDoor({
      paths: [path],
      diff: diffFor(path, ["gh api -X DELETE repos/o/r/labels/x"]),
    });
    assert.deepEqual(r.signals.map((s) => s.ruleId), ["OWD-EXTERNAL-GH-DELETE"]);
    assert.deepEqual(r.classes, ["external-side-effect"]);
  });

  test("external-side-effect: bulk gh edit pipeline", () => {
    const path = sp("bulk.sh");
    const r = detectOneWayDoor({
      paths: [path],
      diff: diffFor(path, ["gh issue list --json number -q '.[].number' | xargs -I{} gh issue close {}"]),
    });
    assert.deepEqual(r.signals.map((s) => s.ruleId), ["OWD-EXTERNAL-GH-BULK-EDIT"]);
  });

  test("external-side-effect: riskCriticalPaths prefix fires on path alone", () => {
    const path = "src/money/ledger.ts";
    const r = detectOneWayDoor({
      paths: [path],
      diff: diffFor(path, ["export const x = 1;"]),
      riskCriticalPaths: ["src/money/"],
    });
    assert.deepEqual(r.signals.map((s) => s.ruleId), ["OWD-EXTERNAL-RISK-SURFACE"]);
    const without = detectOneWayDoor({ paths: [path], diff: diffFor(path, ["export const x = 1;"]) });
    assert.equal(without.door, "two-way");
  });

  test("breaking-way-back: deploy path", () => {
    const path = sp("deploy.sh");
    const r = detectOneWayDoor({ paths: [path], diff: diffFor(path, ["echo hi"]) });
    assert.deepEqual(r.signals.map((s) => s.ruleId), ["OWD-WAYBACK-DEPLOY-PATH"]);
    assert.deepEqual(r.classes, ["breaking-way-back"]);
  });

  test("breaking-way-back: node_modules removal", () => {
    const path = sp("setup.sh");
    const r = detectOneWayDoor({ paths: [path], diff: diffFor(path, ['rm -rf "$WT/node_modules"']) });
    assert.deepEqual(r.signals.map((s) => s.ruleId), ["OWD-WAYBACK-NODE-MODULES"]);
  });

  test("out-of-repo-contract: skill surface path", () => {
    const path = sp("sync-skills.sh");
    const r = detectOneWayDoor({ paths: [path], diff: diffFor(path, ["echo x"]) });
    assert.deepEqual(r.signals.map((s) => s.ruleId), ["OWD-CONTRACT-SKILL-SURFACE"]);
    assert.deepEqual(r.classes, ["out-of-repo-contract"]);
  });

  test("out-of-repo-contract: credentials in a systemd unit", () => {
    const path = sp("systemd", "svc.service");
    const r = detectOneWayDoor({ paths: [path], diff: diffFor(path, ["Environment=API_KEY=abc"]) });
    // systemd units are also a deploy path, so both rules fire.
    assert.deepEqual(r.signals.map((s) => s.ruleId).sort(), ["OWD-CONTRACT-CREDENTIALS", "OWD-WAYBACK-DEPLOY-PATH"]);
  });

  test("multi-class diff yields deduplicated, enum-ordered classes", () => {
    const a = "src/redis/thing.ts";
    const b = sp("sync-skills.sh");
    const diff = diffFor(b, ["echo x"]) + diffFor(a, ["await r.unlink(k);"]);
    const r = detectOneWayDoor({ paths: [b, a], diff });
    assert.equal(r.door, "one-way");
    assert.deepEqual(r.classes, ["persistent-state", "out-of-repo-contract"]);
  });

  test("realistic src + test refactor is two-way with zero signals", () => {
    const a = "src/qa/fold.ts";
    const b = "test/qa-fold.test.mts";
    const diff = diffFor(a, ["export const y = 2;"], ["export const y = 1;"]) + diffFor(b, ["// note"]);
    const r = detectOneWayDoor({ paths: [a, b], diff });
    assert.equal(r.door, "two-way");
    assert.deepEqual(r.classes, []);
    assert.deepEqual(r.signals, []);
  });

  test("a prose doc quoting a dangerous command is two-way", () => {
    const path = "docs/pitfalls.md";
    const r = detectOneWayDoor({ paths: [path], diff: diffFor(path, ["Never run gh api -X DELETE here"]) });
    assert.equal(r.door, "two-way");
  });

  test("a playbook quoting a dangerous command IS scanned", () => {
    const path = "docs/operator-playbooks/x.md";
    const r = detectOneWayDoor({ paths: [path], diff: diffFor(path, ["gh api -X DELETE repos/o/r"]) });
    assert.equal(r.door, "one-way");
  });

  test("Verifier Core paths do not fire a class-3 signal on path alone", () => {
    const paths = [
      ".github/workflows/ci.yml",
      ".github/workflows/deep-qa-gate.yml",
      sp("tier-classify.ts"),
      "src/tier-classifier.ts",
      "src/untouchable.ts",
    ];
    const r = detectOneWayDoor({ paths, diff: paths.map((p) => diffFor(p, ["// x"])).join("") });
    assert.equal(r.door, "two-way");
  });

  test("empty input is unknown", () => {
    const r = detectOneWayDoor({ paths: [], diff: "" });
    assert.equal(r.door, "unknown");
    assert.deepEqual(r.classes, []);
  });

  test("garbage diff text with non-empty paths is unknown", () => {
    const r = detectOneWayDoor({ paths: ["src/a.ts"], diff: "not a diff at all\n???" });
    assert.equal(r.door, "unknown");
  });

  test("never throws: malformed input returns the error signal", () => {
    const orig = console.error;
    console.error = () => {};
    try {
      const r = detectOneWayDoor({ paths: [42 as unknown as string], diff: "" });
      assert.equal(r.door, "unknown");
      assert.equal(r.signals[0].ruleId, "OWD-DETECTOR-ERROR");
      assert.equal(r.signals[0].class, null);
      const r2 = detectOneWayDoor(null as unknown as { paths: string[]; diff: string });
      assert.equal(r2.door, "unknown");
    } finally {
      console.error = orig;
    }
  });
});

describe("requiresOneWayDepth", () => {
  test("is true for one-way and unknown, false for two-way", () => {
    assert.equal(requiresOneWayDepth({ door: "one-way" }), true);
    assert.equal(requiresOneWayDepth({ door: "unknown" }), true);
    assert.equal(requiresOneWayDepth({ door: "two-way" }), false);
  });
});

describe("ONE_WAY_DOOR_RULES ratchet", () => {
  test("every seed rule id stays present", () => {
    const seed = [
      "OWD-STATE-REDIS-DELETE",
      "OWD-STATE-KEY-RENAME",
      "OWD-EXTERNAL-GH-DELETE",
      "OWD-EXTERNAL-GH-BULK-EDIT",
      "OWD-EXTERNAL-RISK-SURFACE",
      "OWD-WAYBACK-DEPLOY-PATH",
      "OWD-WAYBACK-NODE-MODULES",
      "OWD-CONTRACT-SKILL-SURFACE",
      "OWD-CONTRACT-CREDENTIALS",
    ];
    const ids = new Set(ONE_WAY_DOOR_RULES.map((r) => r.id));
    for (const id of seed) assert.ok(ids.has(id), `missing rule ${id}`);
  });
});
