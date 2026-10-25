/**
 * Run Ledger (issue #5072, epic #5071 slice 1) — scripts/autopilot/run_ledger.py
 * driven through its CLI interface only; no script is read as text.
 *
 * Golden fixtures in test/fixtures/run-ledger/ were captured from the
 * pre-change bootstrap.sh heredoc. The heredoc spliced the five carry seeds
 * in as compact inline text, so the golden contract is deep-equal JSON (same
 * keys, values, JSON types, key ORDER); the ledger's persist discipline is
 * indent=2 + trailing newline.
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const LEDGER = join(REPO_ROOT, "scripts", "autopilot", "run_ledger.py");
const FIXTURES = join(REPO_ROOT, "test", "fixtures", "run-ledger");

function ledger(args: string[], env: Record<string, string> = {}) {
  return spawnSync("python3", [LEDGER, ...args], {
    encoding: "utf-8",
    env: { PATH: process.env.PATH ?? "", ...env },
  });
}

/** Build the `seed` key=<json> argv from a captured heredoc document. */
function seedArgsFrom(doc: any): string[] {
  const out = [
    `now=${doc.started_epoch}`,
    `pid=${doc.pid}`,
    `run_id=${JSON.stringify(doc.run_id)}`,
  ];
  for (const [k, v] of Object.entries(doc.limits)) {
    if (k === "schema_version") continue;
    out.push(`${k}=${JSON.stringify(v)}`);
  }
  // Issue #5073: the five carry keys are no longer seed arguments — the ledger
  // derives them (carry_forward / build_slots), so a default seed with no
  // --carry-from reproduces the all-default golden.
  return out;
}

function withDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "run-ledger-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("run_ledger seed — golden vs the pre-change bootstrap heredoc", () => {
  const goldenCase = (name: string) => () => {
      const golden = JSON.parse(readFileSync(join(FIXTURES, name), "utf-8"));
      withDir((dir) => {
        const path = join(dir, "state.json");
        const r = ledger(["seed", path, ...seedArgsFrom(golden)]);
        assert.equal(r.status, 0, r.stderr);
        const text = readFileSync(path, "utf-8");
        const seeded = JSON.parse(text);
        assert.deepEqual(seeded, golden);
        assert.deepEqual(Object.keys(seeded), Object.keys(golden), "top-level key order");
        assert.deepEqual(Object.keys(seeded.limits), Object.keys(golden.limits), "limits key order");
        assert.equal(text, JSON.stringify(seeded, null, 2) + "\n", "indent=2 + trailing newline");
        // JSON types survive: ints stay ints, bool stays bool.
        assert.equal(typeof seeded.limits.unattended, "boolean");
        assert.equal(seeded.limits.schema_version, 2);
      });
  };
  test("seed reproduces heredoc-default.json", goldenCase("heredoc-default.json"));
  test("seed reproduces heredoc-custom.json", goldenCase("heredoc-custom.json"));

  test("ints do not become floats and floats keep their value", () => {
    const golden = JSON.parse(readFileSync(join(FIXTURES, "heredoc-custom.json"), "utf-8"));
    withDir((dir) => {
      const path = join(dir, "state.json");
      assert.equal(ledger(["seed", path, ...seedArgsFrom(golden)]).status, 0);
      const text = readFileSync(path, "utf-8");
      assert.match(text, /"quota_week_max_pts": 30,/);
      assert.match(text, /"quota_5h_max_pts": 12\.5,/);
    });
  });

  test("seed with an unknown key exits 2 and writes nothing", () => {
    const golden = JSON.parse(readFileSync(join(FIXTURES, "heredoc-default.json"), "utf-8"));
    withDir((dir) => {
      const path = join(dir, "state.json");
      const r = ledger(["seed", path, ...seedArgsFrom(golden), "bogus=1"]);
      assert.equal(r.status, 2);
      assert.deepEqual(readdirSync(dir), []);
    });
  });

  test("seed with a missing key exits 2 and writes nothing", () => {
    const golden = JSON.parse(readFileSync(join(FIXTURES, "heredoc-default.json"), "utf-8"));
    withDir((dir) => {
      const path = join(dir, "state.json");
      const args = seedArgsFrom(golden).filter((a) => !a.startsWith("scope="));
      const r = ledger(["seed", path, ...args]);
      assert.equal(r.status, 2);
      assert.deepEqual(readdirSync(dir), []);
    });
  });

  test("seed with a wrong-typed limit exits 1 (LedgerTypeError) and writes nothing", () => {
    const golden = JSON.parse(readFileSync(join(FIXTURES, "heredoc-default.json"), "utf-8"));
    withDir((dir) => {
      const path = join(dir, "state.json");
      const args = seedArgsFrom(golden).map((a) =>
        a.startsWith("token_budget=") ? 'token_budget="lots"' : a,
      );
      const r = ledger(["seed", path, ...args]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /limits\.token_budget/);
      assert.deepEqual(readdirSync(dir), []);
    });
  });
});

describe("run_ledger load/persist via the CLI", () => {
  function seeded(dir: string): string {
    const golden = JSON.parse(readFileSync(join(FIXTURES, "heredoc-default.json"), "utf-8"));
    const path = join(dir, "state.json");
    assert.equal(ledger(["seed", path, ...seedArgsFrom(golden)]).status, 0);
    return path;
  }

  test("get reads dotted keys; absent key exits 1", () => {
    withDir((dir) => {
      const path = seeded(dir);
      assert.equal(ledger(["get", path, "limits.schema_version"]).stdout.trim(), "2");
      assert.equal(ledger(["get", path, "limits.scope"]).stdout.trim(), "all");
      assert.equal(ledger(["get", path, "nope"]).status, 1);
    });
  });

  test("undeclared top-level key is warned once and preserved", () => {
    withDir((dir) => {
      const path = seeded(dir);
      const doc = JSON.parse(readFileSync(path, "utf-8"));
      doc.mystery = { x: 1 };
      writeFileSync(path, JSON.stringify(doc));
      const r = ledger(["get", path, "mystery.x"]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim(), "1");
      assert.equal(
        r.stderr.split("\n").filter((l) => l === "[run-ledger] WARN undeclared key mystery preserved").length,
        1,
      );
    });
  });

  test("a declared key of the wrong JSON type fails loud naming key, expected, actual", () => {
    withDir((dir) => {
      const path = seeded(dir);
      const doc = JSON.parse(readFileSync(path, "utf-8"));
      doc.turn = "7";
      writeFileSync(path, JSON.stringify(doc));
      const r = ledger(["get", path, "turn"]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /turn/);
      assert.match(r.stderr, /expected int/);
      assert.match(r.stderr, /got str/);
    });
  });

  test("re-seed over an existing file replaces it atomically", () => {
    withDir((dir) => {
      const path = seeded(dir);
      const golden = JSON.parse(readFileSync(join(FIXTURES, "heredoc-custom.json"), "utf-8"));
      assert.equal(ledger(["seed", path, ...seedArgsFrom(golden)]).status, 0);
      assert.equal(ledger(["get", path, "limits.scope"]).stdout.trim(), "orch-only");
      assert.deepEqual(readdirSync(dir), ["state.json"]);
    });
  });

  test("crash between write and rename leaves the prior file byte-untouched", () => {
    withDir((dir) => {
      const path = seeded(dir);
      const before = readFileSync(path);
      const golden = JSON.parse(readFileSync(join(FIXTURES, "heredoc-custom.json"), "utf-8"));
      const r = ledger(["seed", path, ...seedArgsFrom(golden)], {
        HYDRA_RUN_LEDGER_TEST_CRASH: "before-replace",
      });
      assert.equal(r.status, 1);
      assert.ok(readFileSync(path).equals(before), "prior bytes unchanged");
      const extras = readdirSync(dir).filter((f) => f !== "state.json");
      assert.equal(extras.length, 1, "at most one orphan temp file");
      assert.match(extras[0], /^\.run-ledger-/);
    });
  });
});

describe("run_ledger path + schema-version", () => {
  test("path defaults to /tmp/hydra-autopilot-state.json", () => {
    assert.equal(ledger(["path"]).stdout.trim(), "/tmp/hydra-autopilot-state.json");
  });

  test("path honours HYDRA_AUTOPILOT_STATE; --default ignores it", () => {
    const env = { HYDRA_AUTOPILOT_STATE: "/tmp/elsewhere.json" };
    assert.equal(ledger(["path"], env).stdout.trim(), "/tmp/elsewhere.json");
    assert.equal(ledger(["path", "--default"], env).stdout.trim(), "/tmp/hydra-autopilot-state.json");
  });

  test("an empty HYDRA_AUTOPILOT_STATE falls back to the default", () => {
    assert.equal(
      ledger(["path"], { HYDRA_AUTOPILOT_STATE: "" }).stdout.trim(),
      "/tmp/hydra-autopilot-state.json",
    );
  });

  test("schema-version prints the integer 2", () => {
    assert.equal(ledger(["schema-version"]).stdout.trim(), "2");
  });
});

describe("run_ledger declared field table (INV-3, INV-4)", () => {
  function py(code: string) {
    const prelude = `import sys\nsys.path.insert(0, ${JSON.stringify(join(REPO_ROOT, "scripts", "autopilot"))})\n`;
    return spawnSync("python3", ["-I", "-c", prelude + code], {
      encoding: "utf-8",
      env: { PATH: process.env.PATH ?? "" },
    });
  }

  test("INV-4: seeded document keys == declared seeded rows; every declared name is unique", () => {
    const r = py(
      "import json,run_ledger as L\n" +
        "names=[f['name'] for f in L.FIELDS]\n" +
        "d=L.seed_initial({'pid':1,'run_id':'r'},{f['name']:{'str':'all','bool':True}.get(f['type'],1) for f in L.LIMITS if f['name'] in L._LIMIT_SEED_KEYS},{k:([] if k=='dev_resume_pending' else {}) for k in L._CARRY_KEYS},1700000000)\n" +
        "print(json.dumps({'names':names,'seeded':[f['name'] for f in L.FIELDS if f['seeded']],'doc':list(d.keys())}))",
    );
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.equal(new Set(o.names).size, o.names.length, "no duplicate declared names");
    assert.deepEqual(o.doc, o.seeded, "seed writes exactly the declared seeded rows, in order");
    assert.ok(o.names.includes("scout_spend_usd_today"));
    assert.ok(o.names.includes("idle_turns"));
  });

  test("INV-4: every top-level key a real autopilot script writes is declared in FIELDS", () => {
    const dir = join(REPO_ROOT, "scripts", "autopilot");
    const written = new Set<string>();
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".py") && n !== "run_ledger.py")) {
      const src = readFileSync(join(dir, f), "utf-8");
      for (const m of src.matchAll(/\b(?:state|s)\[["']([a-z_0-9]+)["']\]\s*=[^=]/g)) written.add(m[1]);
      for (const m of src.matchAll(/\bstate\.setdefault\(["']([a-z_0-9]+)["']/g)) written.add(m[1]);
    }
    assert.ok(written.size >= 10, "scanner found the writers: " + [...written].join(","));
    const r = py(
      "import json,run_ledger as L\n" +
        "w=" + JSON.stringify(JSON.stringify([...written])) + "\n" +
        "print(json.dumps(sorted(set(json.loads(w)) - set(f['name'] for f in L.FIELDS))))",
    );
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), [], "keys written by real scripts but missing from FIELDS");
  });

  test("INV-4 sibling: a genuinely undeclared key still triggers the load WARN and is preserved", () => {
    withDir((d) => {
      const path = join(d, "state.json");
      writeFileSync(path, JSON.stringify({ turn: 1, brand_new_key: 7 }));
      const r = ledger(["get", path, "brand_new_key"]);
      assert.equal(r.stdout.trim(), "7");
      assert.match(r.stderr, /WARN undeclared key brand_new_key/);
    });
  });

  test("INV-3: a missing unseeded defaulted key loads as its declared default", () => {
    withDir((dir) => {
      const golden = JSON.parse(readFileSync(join(FIXTURES, "heredoc-default.json"), "utf-8"));
      const path = join(dir, "state.json");
      assert.equal(ledger(["seed", path, ...seedArgsFrom(golden)]).status, 0);
      assert.equal(ledger(["get", path, "idle_turns"]).stdout.trim(), "0");
      assert.equal(ledger(["get", path, "warnings"]).stdout.trim(), "[]");
      assert.equal(ledger(["get", path, "turn_snapshot"]).stdout.trim(), "{}");
      assert.equal(ledger(["get", path, "scout_spend_usd_today"]).stdout.trim(), "0");
    });
  });

  test("INV-3 sibling: an undeclared key and a REQUIRED-but-absent key stay absent", () => {
    withDir((dir) => {
      const path = join(dir, "state.json");
      writeFileSync(path, JSON.stringify({ turn: 3 }));
      assert.equal(ledger(["get", path, "turn"]).stdout.trim(), "3");
      assert.equal(ledger(["get", path, "run_id"]).status, 1, "REQUIRED rows get no default");
      assert.equal(ledger(["get", path, "not_a_field"]).status, 1);
    });
  });
});

// ---------------------------------------------------------------------------
// Issue #5073 (epic #5071 slice 2) — carry_forward, the ONE reader of a prior
// run's state. Driven in-process (python3 -I, same harness pattern as the
// INV-3/INV-4 field-table tests) so each historical scenario is a regression
// case at the ledger interface, not a bootstrap end-to-end run.
// ---------------------------------------------------------------------------

const AUTOPILOT_DIR = join(REPO_ROOT, "scripts", "autopilot");

/** Run python (isolated) with run_ledger importable; stdout must be JSON. */
function pyJson(code: string, env: Record<string, string> = {}): any {
  const prelude =
    `import sys, json\nsys.path.insert(0, ${JSON.stringify(AUTOPILOT_DIR)})\n` +
    `import run_ledger as L\nCLASSES = L.load_classes()\n`;
  const r = spawnSync("python3", ["-I", "-c", prelude + code], {
    encoding: "utf-8",
    env: { PATH: process.env.PATH ?? "", ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

/** carry_forward(prev, CLASSES, now) with `prev` given as a JSON literal. */
function carry(prevJson: string, now = 1792911953): any {
  return pyJson(`print(json.dumps(L.carry_forward(json.loads(${JSON.stringify(prevJson)}), CLASSES, ${now})))`);
}

const HISTORICAL_SIGNAL_KEYS = [
  "architecture_orch", "cleanup_orch", "cleanup_target", "design_qa_target",
  "discover_orch", "discover_target", "health", "retro_orch", "research_target",
  "scout_orch", "skill_prune", "sweep_orch", "sweep_target", "tickets_orch",
  "wayfinder_orch", "wire_or_retire_target",
];
// 1792911953 = 2026-10-25T07:05:53Z
const TODAY = "2026-10-25";

describe("run_ledger golden key sets survive the derivation (issue #5073)", () => {
  test("regenerated goldens carry exactly the historical 16 signal_last_fired keys (sorted-key semantic equality)", () => {
    for (const name of ["heredoc-default.json", "heredoc-custom.json"]) {
      const golden = JSON.parse(readFileSync(join(FIXTURES, name), "utf-8"));
      assert.deepEqual(Object.keys(golden.signal_last_fired).sort(), [...HISTORICAL_SIGNAL_KEYS].sort());
      assert.deepEqual(Object.keys(golden.slots), [
        "dev_orch", "qa_orch", "research_orch", "dev_target", "qa_target", "research_target",
        "design_concept_orch",
      ]);
    }
  });
});

describe("run_ledger carry_forward — the five historical scenarios (issue #5073)", () => {
  test("#1666 research_force_counter keeps only today's UTC key; a non-object degrades to {}", () => {
    const c = carry(JSON.stringify({ research_force_counter: { [TODAY]: { orch: 2 }, "2026-10-24": { orch: 4 } } }));
    assert.deepEqual(c.research_force_counter, { [TODAY]: { orch: 2 } });
    assert.deepEqual(carry(JSON.stringify({ research_force_counter: [1, 2] })).research_force_counter, {});
    assert.deepEqual(carry(JSON.stringify({ research_force_counter: { [TODAY]: 3 } })).research_force_counter, {});
    assert.deepEqual(carry("{}").research_force_counter, {});
  });

  test("#2575/#4909 signal_last_fired carries a numeric prior stamp for carried classes, re-arms the rest to 0", () => {
    const c = carry(
      JSON.stringify({
        signal_last_fired: {
          retro_orch: 1780000000, research_target: 1780000400, cleanup_target: 1780000500,
          health: 5, sweep_orch: 6, discover_target: 7, // re-armed each run
          scout_orch: "yesterday", skill_prune: true, // non-numeric -> 0
        },
      }),
    );
    const s = c.signal_last_fired;
    assert.equal(s.retro_orch, 1780000000);
    assert.equal(s.research_target, 1780000400);
    assert.equal(s.cleanup_target, 1780000500);
    for (const k of ["health", "sweep_orch", "discover_target", "scout_orch", "skill_prune"]) {
      assert.equal(s[k], 0, k);
    }
    assert.deepEqual(Object.keys(s).sort(), [...HISTORICAL_SIGNAL_KEYS].sort());
  });

  test("#4909 a NEW signal class with cooldownSeconds > 900 is carried with zero code change", () => {
    const out = pyJson(
      "classes = CLASSES + [{'name':'brand_new_orch','kind':'signal','cooldownSeconds':3600}," +
        "{'name':'brand_new_fast','kind':'signal','cooldownSeconds':900}]\n" +
        "c = L.carry_forward({'signal_last_fired':{'brand_new_orch':123,'brand_new_fast':456}}, classes, 1792911953)\n" +
        "print(json.dumps(c['signal_last_fired']))",
    );
    assert.equal(out.brand_new_orch, 123, "cooldown 3600 > 900 is carried");
    assert.equal(out.brand_new_fast, 0, "cooldown == relaunch interval is re-armed (not strictly greater)");
  });

  test("#4518 dev_resume_pending drops malformed, dedups by anchor keeping the LATEST in FIFO position, caps at 20; non-list -> []", () => {
    const e = (anchor: string, n = 0) => ({ anchor, branch: `b${n}` });
    const c = carry(
      JSON.stringify({
        dev_resume_pending: [e("a", 1), "junk", { anchor: "" }, { anchor: 5 }, e("b", 1), e("a", 2), e("c", 1)],
      }),
    );
    assert.deepEqual(c.dev_resume_pending, [e("b", 1), e("a", 2), e("c", 1)]);
    const many = Array.from({ length: 25 }, (_, i) => e(`x${i}`));
    const capped = carry(JSON.stringify({ dev_resume_pending: many })).dev_resume_pending;
    assert.equal(capped.length, 20);
    assert.equal(capped[0].anchor, "x5", "FIFO: the oldest are dropped");
    assert.deepEqual(carry(JSON.stringify({ dev_resume_pending: { anchor: "a" } })).dev_resume_pending, []);
  });

  test("#4999 zero_yield_backoff keeps integral streak+last_fired, floors integral floats, rejects bool/non-int/non-object", () => {
    const c = carry(
      JSON.stringify({
        zero_yield_backoff: {
          ok: { streak: 2, last_fired: 1780000000 },
          floats: { streak: 3.0, last_fired: 1780000001.0 },
          fractional: { streak: 1.5, last_fired: 1 },
          boolean: { streak: true, last_fired: 1 },
          missing: { streak: 1 },
          notobj: 7,
        },
      }),
    );
    assert.deepEqual(c.zero_yield_backoff, {
      ok: { streak: 2, last_fired: 1780000000 },
      floats: { streak: 3, last_fired: 1780000001 },
    });
    assert.deepEqual(carry(JSON.stringify({ zero_yield_backoff: [] })).zero_yield_backoff, {});
  });
});

describe("run_ledger carry_forward — policy is data, the prior document is untrusted (issue #5073)", () => {
  test("a reset-per-run row is never carried even when present in the prior document; slots are never read from it", () => {
    withDir((dir) => {
      const path = join(dir, "state.json");
      writeFileSync(
        path,
        JSON.stringify({
          cumulative_tokens: 999, turn: 7, dispatches: 4, burned_classes: ["dev_orch"],
          slots: { dev_orch: { skill: "hydra-dev" } },
          dev_resume_pending: [{ anchor: "issue-1" }],
        }),
      );
      const golden = JSON.parse(readFileSync(join(FIXTURES, "heredoc-default.json"), "utf-8"));
      const r = ledger(["seed", path, "--carry-from", path, ...seedArgsFrom(golden)]);
      assert.equal(r.status, 0, r.stderr);
      const doc = JSON.parse(readFileSync(path, "utf-8"));
      assert.equal(doc.cumulative_tokens, 0);
      assert.equal(doc.turn, 0);
      assert.equal(doc.dispatches, 0);
      assert.deepEqual(doc.burned_classes, []);
      assert.equal(doc.slots.dev_orch, null, "prior slots must not resurrect");
      assert.deepEqual(doc.dev_resume_pending, [{ anchor: "issue-1" }], "carried rows do carry");
      assert.match(r.stdout, /carried dev_resume_pending forward from prior state: \[\{"anchor":"issue-1"\}\] \(issue #4518\)/);
    });
  });

  test("the policy table: only the declared rows carry, slots is seeded-from-orchestrator", () => {
    const o = pyJson(
      "print(json.dumps({f['name']: f['carry'] for f in L.FIELDS if f['name'] in " +
        "('research_force_counter','dev_resume_pending','zero_yield_backoff','slots','signal_last_fired','turn')}))",
    );
    assert.deepEqual(o, {
      research_force_counter: "mirrored-to-Redis",
      dev_resume_pending: "carry-across-relaunch",
      zero_yield_backoff: "carry-across-relaunch",
      slots: "seeded-from-orchestrator",
      signal_last_fired: "mirrored-to-Redis",
      turn: "reset-per-run",
    });
  });

  test("a missing, unparseable, or legacy/malformed prior file yields the all-default carry and seed exits 0", () => {
    const golden = JSON.parse(readFileSync(join(FIXTURES, "heredoc-default.json"), "utf-8"));
    const legacy = JSON.stringify({
      signal_last_fired: "x", dev_resume_pending: 4, zero_yield_backoff: null, research_force_counter: 9,
    });
    for (const prior of [null, "{not json", "[1,2,3]", '"str"', legacy]) {
      withDir((dir) => {
        const path = join(dir, "state.json");
        if (prior !== null) writeFileSync(path, prior);
        const r = ledger(["seed", path, "--carry-from", path, ...seedArgsFrom(golden)]);
        assert.equal(r.status, 0, `${prior}: ${r.stderr}`);
        assert.deepEqual(JSON.parse(readFileSync(path, "utf-8")), golden, `${prior}`);
      });
    }
  });

  test("carry_forward never raises on garbage input", () => {
    const garbage = [
      "null", "[]", "7", '"s"',
      '{"signal_last_fired":[1],"dev_resume_pending":[null,1,{"anchor":null}],"zero_yield_backoff":{"a":null}}',
    ];
    for (const prev of garbage) {
      const c = carry(prev);
      assert.deepEqual(c.dev_resume_pending, []);
      assert.deepEqual(c.zero_yield_backoff, {});
    }
  });

  test("seed no longer accepts the five carry keys as key=<json>: exits 2 before any write", () => {
    const golden = JSON.parse(readFileSync(join(FIXTURES, "heredoc-default.json"), "utf-8"));
    for (const k of ["research_force_counter", "dev_resume_pending", "zero_yield_backoff", "slots", "signal_last_fired"]) {
      withDir((dir) => {
        const path = join(dir, "state.json");
        const r = ledger(["seed", path, ...seedArgsFrom(golden), `${k}={}`]);
        assert.equal(r.status, 2, k);
        assert.deepEqual(readdirSync(dir), []);
      });
    }
  });

  test("slots_overlay merges an orchestrator `.slots` object onto the 7-null base; a malformed payload degrades to the base", () => {
    const golden = JSON.parse(readFileSync(join(FIXTURES, "heredoc-default.json"), "utf-8"));
    const run = (overlay: string) =>
      withDir((dir) => {
        const path = join(dir, "state.json");
        const r = ledger(["seed", path, ...seedArgsFrom(golden), `slots_overlay=${overlay}`]);
        assert.equal(r.status, 0, r.stderr);
        return JSON.parse(readFileSync(path, "utf-8")).slots;
      });
    const live = run(JSON.stringify({ slots: { dev_orch: { skill: "hydra-dev" } } }));
    assert.deepEqual(live.dev_orch, { skill: "hydra-dev" });
    assert.equal(live.qa_orch, null);
    assert.deepEqual(run("not json at all"), golden.slots);
    assert.deepEqual(run(JSON.stringify({ slots: "nope" })), golden.slots);
    assert.deepEqual(run("[1]"), golden.slots);
  });
});

describe("run_ledger carry set is derived, never enumerated (issue #5073 INV-2/INV-3/INV-4)", () => {
  test("carry-classes prints {signal rows with cooldownSeconds > 900} - rearm_each_run + pipeline_refire_stamps", () => {
    const r = ledger(["carry-classes"]);
    assert.equal(r.status, 0, r.stderr);
    const classes = JSON.parse(readFileSync(join(AUTOPILOT_DIR, "classes.json"), "utf-8")).classes;
    const expected = [
      ...classes
        .filter((c: any) => c.kind === "signal" && c.cooldownSeconds > 900 && c.name !== "discover_target")
        .map((c: any) => c.name),
      "research_target",
    ];
    assert.deepEqual(r.stdout.trim().split("\n"), expected);
    assert.equal(expected.length, 12);
  });

  test("PACE_GATE_RELAUNCH_SEC equals the systemd timer's OnUnitActiveSec (parsed, not retyped)", () => {
    const timer = readFileSync(join(REPO_ROOT, "scripts", "systemd", "hydra-pace-gate.timer"), "utf-8");
    const m = /^OnUnitActiveSec=(\d+)(min|s|h)?$/m.exec(timer);
    assert.ok(m, "timer declares OnUnitActiveSec");
    const sec = Number(m![1]) * ({ min: 60, s: 1, h: 3600 } as Record<string, number>)[m![2] ?? "s"];
    assert.equal(pyJson("print(L.PACE_GATE_RELAUNCH_SEC)"), sec);
  });

  test("the exception tuples are pinned: stamps == decide.PIPELINE_REFIRE_SEC, rearm is a subset of signal rows", () => {
    const o = pyJson(
      "import decide\n" +
        "row = [f for f in L.FIELDS if f['name']=='signal_last_fired'][0]\n" +
        "sig = {c['name'] for c in CLASSES if c['kind']=='signal'}\n" +
        "print(json.dumps({'stamps': sorted(row['pipeline_refire_stamps']), 'refire': sorted(decide.PIPELINE_REFIRE_SEC)," +
        " 'rearm_ok': set(row['rearm_each_run']) <= sig}))",
    );
    assert.deepEqual(o.stamps, o.refire);
    assert.equal(o.rearm_ok, true);
  });

  test("DEV_RESUME_PENDING_CAP lives in run_ledger.py and equals reap_stall.py's twin", () => {
    const stall = readFileSync(join(AUTOPILOT_DIR, "reap_stall.py"), "utf-8");
    const twin = Number(/^DEV_RESUME_PENDING_CAP = (\d+)$/m.exec(stall)?.[1]);
    assert.equal(pyJson("print(L.DEV_RESUME_PENDING_CAP)"), twin);
  });
});

describe("run_ledger Redis continuity — prior-file -> Redis -> default (issue #5073 INV-8/INV-10)", () => {
  const MEM_MIRROR =
    "class Mem:\n" +
    "    def __init__(self, h, g): self.h, self.g, self.calls = h, g, []\n" +
    "    def hget(self, key, field):\n" +
    "        self.calls.append(('HGET', field)); return self.h.get(field)\n" +
    "    def get(self, key):\n" +
    "        self.calls.append(('GET', key)); return self.g\n";

  test("no prior file (host reboot): signal stamps and the force counter seed from the mirror through the ledger", () => {
    const o = pyJson(
      MEM_MIRROR +
        "m = Mem({'retro_orch':'1780000000','scout_orch':'\"1780000300\"','cleanup_orch':'abc','skill_prune':''}," +
        " json.dumps({'2026-10-25':{'orch':1},'2026-10-24':{'orch':9}}))\n" +
        "c = L.carry_forward(None, CLASSES, 1792911953, m)\n" +
        "print(json.dumps({'s': c['signal_last_fired'], 'r': c['research_force_counter']}))",
    );
    assert.equal(o.s.retro_orch, 1780000000);
    assert.equal(o.s.scout_orch, 1780000300, "redis-cli quoting is stripped");
    assert.equal(o.s.cleanup_orch, 0, "non-numeric Redis value keeps the default");
    assert.equal(o.s.skill_prune, 0);
    assert.equal(o.s.health, 0, "an always-on key never consults Redis");
    assert.deepEqual(o.r, { [TODAY]: { orch: 1 } }, "yesterday's counter never resurrects");
  });

  test("prior-file wins: a class with a real prior stamp never touches Redis; a non-empty counter never GETs", () => {
    const o = pyJson(
      MEM_MIRROR +
        "m = Mem({'retro_orch':'5'}, json.dumps({'2026-10-25':{'orch':8}}))\n" +
        "prev = {'signal_last_fired': {'retro_orch': 1780000000}, 'research_force_counter': {'2026-10-25': {'orch': 2}}}\n" +
        "c = L.carry_forward(prev, CLASSES, 1792911953, m)\n" +
        "print(json.dumps({'retro': c['signal_last_fired']['retro_orch'], 'r': c['research_force_counter']," +
        " 'hget_fields': [f for k, f in m.calls if k == 'HGET'], 'gets': [k for k, f in m.calls if k == 'GET']}))",
    );
    assert.equal(o.retro, 1780000000);
    assert.deepEqual(o.r, { [TODAY]: { orch: 2 } });
    assert.ok(!o.hget_fields.includes("retro_orch"), "prior-file value short-circuits the HGET");
    assert.deepEqual(o.gets, [], "a non-empty pruned counter never consults Redis");
  });

  test("RedisMirror is fail-open: a missing binary and a failing command both yield None, never raise", () => {
    const o = pyJson(
      "a = L.RedisMirror(['/nonexistent/redis-cli-5073'])\n" +
        "b = L.RedisMirror(['false'])\n" +
        "print(json.dumps([a.hget('k','f'), a.get('k'), b.hget('k','f'), b.get('k')]))",
    );
    assert.deepEqual(o, [null, null, null, null]);
  });

  test("mirror_to_redis derives its writes from the mirrored rows: one HSET (int-coercible fields only) + one SET", () => {
    const o = pyJson(
      "calls = []\n" +
        "L.mirror_to_redis({'signal_last_fired': {'health': 0, 'retro_orch': 1780000000, 'bad': 'x'}," +
        " 'research_force_counter': {'2026-10-25': {'orch': 1}}, 'turn': 4, 'pid': 99}, lambda *a: calls.append(list(a)))\n" +
        "print(json.dumps(calls))",
    );
    const hset = o.find((c: string[]) => c[0] === "HSET");
    const set = o.find((c: string[]) => c[0] === "SET");
    assert.deepEqual(hset, ["HSET", "hydra:autopilot:signal-last-fired", "health", "0", "retro_orch", "1780000000"]);
    assert.deepEqual(set, ["SET", "hydra:autopilot:research-force-counter", '{"2026-10-25": {"orch": 1}}']);
    assert.equal(o.length, 2);
  });
});

describe("bootstrap.sh holds no carry logic (issue #5073 INV-1)", () => {
  test("no jq between the SCHEMA_VERSION resolution and the run_ledger.py seed call; redis_cooldown_cli is gone", () => {
    const src = readFileSync(join(AUTOPILOT_DIR, "bootstrap.sh"), "utf-8");
    const from = src.indexOf('SCHEMA_VERSION="$(python3 "${RUN_LEDGER}" schema-version)"');
    const to = src.indexOf('python3 "${RUN_LEDGER}" seed');
    assert.ok(from > 0 && to > from, "anchors found");
    assert.doesNotMatch(src.slice(from, to), /\bjq\b/, "the carry-forward jq blocks are deleted, not wrapped");
    assert.doesNotMatch(src, /^redis_cooldown_cli\(\)/m);
    assert.doesNotMatch(src, /COOLDOWN_CARRY_CLASSES=/);
    assert.match(src.slice(to, to + 400), /--carry-from/);
  });

  test("decide.py no longer mirrors research_force_counter to Redis (one writer, in the ledger)", () => {
    const decide = readFileSync(join(AUTOPILOT_DIR, "decide.py"), "utf-8");
    assert.doesNotMatch(decide, /_mirror_research_force_counter_to_redis/);
    assert.doesNotMatch(decide, /hydra:autopilot:research-force-counter/);
  });
});
