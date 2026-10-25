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
  for (const k of [
    "research_force_counter",
    "dev_resume_pending",
    "zero_yield_backoff",
    "slots",
    "signal_last_fired",
  ]) {
    out.push(`${k}=${JSON.stringify(doc[k])}`);
  }
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
