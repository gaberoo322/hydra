/**
 * scripts/autopilot/admission.py — the ONE dispatch-admission verdict (#5478).
 * Table test at the module's interface: each gate alone, then gate order for
 * pairs of simultaneously failing gates.
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const DIR = resolve(import.meta.dirname, "../scripts/autopilot");

interface Case {
  cls?: string;
  dispatch_blocked?: boolean;
  shed?: string[];
  slots?: Record<string, unknown>;
  freed?: string[];
  scope?: string;
  burned?: string[];
  share?: boolean;
  lazy?: boolean;
}

const ROWS = [
  { name: "dev_orch", scope: "orch" },
  { name: "dev_target", scope: "target" },
  { name: "health", scope: "both" },
];

function admit(c: Case): string | null {
  return admitFull(c)[0];
}

function admitFull(c: Case): [string | null, number] {
  const payload = JSON.stringify({ rows: ROWS, ...c });
  const code = `
import json, sys
sys.path.insert(0, ${JSON.stringify(DIR)})
import admission
c = json.loads(sys.stdin.read())
calls = []
v = admission.admit(
    c.get("cls", "dev_orch"),
    dispatch_blocked=c.get("dispatch_blocked", False),
    shed_classes=set(c.get("shed", [])),
    slots=c.get("slots", {}),
    freed_slots=set(c.get("freed", [])),
    scope=c.get("scope", "all"),
    burned_classes=set(c.get("burned", [])),
    orch_share_exceeded=(
        (lambda: (calls.append(1), c["share"])[1]) if c.get("lazy") else c.get("share", False)
    ),
    rows=c["rows"],
)
print(json.dumps([v.gate, len(calls)]))
`;
  const r = spawnSync("python3", ["-I", "-c", code], { input: payload, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim());
}

const FAIL: Record<string, Case> = {
  usage_dispatch_blocked: { dispatch_blocked: true },
  usage_shed: { shed: ["dev_orch"] },
  slot_busy: { slots: { dev_orch: "agent-1" } },
  scope_excluded: { scope: "target-only" },
  burned: { burned: ["dev_orch"] },
  orch_realm_share_exceeded: { share: true },
};
const ORDER = Object.keys(FAIL);

describe("admission.admit", () => {
  test("admits a class with no failing gate", () => {
    assert.equal(admit({}), null);
  });

  for (const [gate, c] of Object.entries(FAIL)) {
    test(`gate alone: ${gate}`, () => {
      assert.equal(admit(c), gate);
    });
  }

  test("slot gate: a free slot, an absent slot and a freed slot all pass", () => {
    assert.equal(admit({ slots: { dev_orch: null } }), null);
    assert.equal(admit({ slots: { other: "x" } }), null);
    assert.equal(admit({ slots: { dev_orch: "a" }, freed: ["dev_orch"] }), null);
  });

  test("share gate applies to orch-scope classes only", () => {
    assert.equal(admit({ cls: "dev_target", share: true }), null);
    assert.equal(admit({ cls: "health", share: true }), null);
  });

  test("share callable is evaluated lazily: never for an earlier refusal or a non-orch class", () => {
    assert.deepEqual(admitFull({ lazy: true, share: true, burned: ["dev_orch"] }), ["burned", 0]);
    assert.deepEqual(admitFull({ lazy: true, share: true, cls: "dev_target" }), [null, 0]);
    // sibling shape: an orch class reaching the gate still evaluates it once
    assert.deepEqual(admitFull({ lazy: true, share: true }), ["orch_realm_share_exceeded", 1]);
    assert.deepEqual(admitFull({ lazy: true, share: false }), [null, 1]);
  });

  test("gate order: first failing gate wins for every pair", () => {
    for (let i = 0; i < ORDER.length; i++) {
      for (let j = i + 1; j < ORDER.length; j++) {
        const merged = { ...FAIL[ORDER[i]!], ...FAIL[ORDER[j]!] };
        assert.equal(admit(merged), ORDER[i], `${ORDER[i]} before ${ORDER[j]}`);
      }
    }
  });

});
