/**
 * Coverage for scripts/autopilot/reap_state.py (issue #4366) — the bounded
 * first slice of the reap.py six-way split surfaced by an architecture-scan.
 *
 * reap_state.py is a pure move-and-import extraction: `load_state`,
 * `save_state`, `redis_cli`, `mirror_cross_run_state_to_redis`,
 * `ensure_reaped_list`, `bound_reaped` (formerly `_load_state` etc. inside
 * reap.py) plus their four owning constants. This file exercises the six
 * functions directly, in-process, via the same importlib.util.
 * spec_from_file_location pattern test/autopilot-dedup-reap.test.mts already
 * uses to load reap.py — the module has no CLI (no shebang, no `__main__`),
 * so it is loaded by path via a REAP_STATE_PATH env var rather than spawned.
 *
 * reap.py's own pinned suites (test/autopilot-dedup-reap.test.mts,
 * test/autopilot-cooldown-redis-mirror.test.mts,
 * test/autopilot-reap-task-id-mismatch.test.mts,
 * test/autopilot-cycle-record-branch-cycleid.test.mts,
 * test/autopilot-scripts.test.mts) continue to exercise the same behavior
 * end-to-end through reap.py's CLI and are unedited by this change — this
 * file is the new, focused unit-level coverage for the extracted module.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPTS = join(REPO_ROOT, "scripts", "autopilot");
const REAP_STATE = join(SCRIPTS, "reap_state.py");

interface Tmp {
  dir: string;
  state: string;
}

function makeTmp(): Tmp {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-reap-state-test-"));
  return { dir, state: join(dir, "state.json") };
}

/** Write an executable stub that impersonates `redis-cli`. */
function writeStub(dir: string, name: string, script: string): string {
  const p = join(dir, name);
  writeFileSync(p, script, { mode: 0o755 });
  return p;
}

function runPython(
  code: string,
  env: Record<string, string>,
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("python3", ["-c", code], {
    env: { ...process.env, REAP_STATE_PATH: REAP_STATE, ...env },
    encoding: "utf-8",
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// Every probe loads reap_state.py fresh via the same by-path loader reap.py
// itself uses at runtime (issue #4366's INV-2), registering the module in
// sys.modules BEFORE exec_module — mirroring the dedup-reap test's own
// precaution for reap.py, even though reap_state.py declares no @dataclass
// that would need it today; keeping the two loaders identical avoids a
// silent divergence later.
const LOAD_PREAMBLE = `
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("reap_state_u", os.environ["REAP_STATE_PATH"])
reap_state = importlib.util.module_from_spec(spec)
sys.modules["reap_state_u"] = reap_state
spec.loader.exec_module(reap_state)
`;

describe("scripts/autopilot/reap_state.py — load_state / save_state (issue #4366)", () => {
  test("load_state on a missing path returns None and logs the exact stderr line", () => {
    const tmp = makeTmp();
    try {
      const missing = join(tmp.dir, "does-not-exist.json");
      const r = runPython(
        `${LOAD_PREAMBLE}
print(repr(reap_state.load_state()))
`,
        { HYDRA_AUTOPILOT_STATE: missing },
      );
      assert.equal(r.status, 0, `python probe failed: ${r.stderr}`);
      assert.equal(r.stdout.trim(), "None");
      assert.match(
        r.stderr,
        new RegExp(`\\[autopilot\\] reap: state file missing at ${missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}; skipping`),
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("save_state then load_state round-trips honouring HYDRA_AUTOPILOT_STATE", () => {
    const tmp = makeTmp();
    try {
      const r = runPython(
        `${LOAD_PREAMBLE}
import json
reap_state.save_state({"cumulative_tokens": 42, "reaped_task_ids": ["a", "b"]})
print(json.dumps(reap_state.load_state()))
`,
        { HYDRA_AUTOPILOT_STATE: tmp.state },
      );
      assert.equal(r.status, 0, `python probe failed: ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.deepEqual(out, { cumulative_tokens: 42, reaped_task_ids: ["a", "b"] });
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});

describe("scripts/autopilot/reap_state.py — reaped-list bookkeeping (issue #4366)", () => {
  test("ensure_reaped_list defaults to [] and installs the field on state lacking it", () => {
    const tmp = makeTmp();
    try {
      const r = runPython(
        `${LOAD_PREAMBLE}
import json
state = {}
ids = reap_state.ensure_reaped_list(state)
print(json.dumps({"returned": ids, "installed": state.get("reaped_task_ids")}))
`,
        {},
      );
      assert.equal(r.status, 0, `python probe failed: ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.deepEqual(out.returned, []);
      assert.deepEqual(out.installed, []);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("ensure_reaped_list returns the existing list untouched when already present", () => {
    const tmp = makeTmp();
    try {
      const r = runPython(
        `${LOAD_PREAMBLE}
import json
state = {"reaped_task_ids": ["task-1", "task-2"]}
ids = reap_state.ensure_reaped_list(state)
print(json.dumps(ids))
`,
        {},
      );
      assert.equal(r.status, 0, `python probe failed: ${r.stderr}`);
      assert.deepEqual(JSON.parse(r.stdout), ["task-1", "task-2"]);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("bound_reaped FIFO-bounds 1001 entries down to the most-recent 1000", () => {
    const tmp = makeTmp();
    try {
      const r = runPython(
        `${LOAD_PREAMBLE}
import json
ids = [f"task-{i}" for i in range(1001)]
bounded = reap_state.bound_reaped(ids)
print(json.dumps({"len": len(bounded), "first": bounded[0], "last": bounded[-1]}))
`,
        {},
      );
      assert.equal(r.status, 0, `python probe failed: ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.len, 1000);
      assert.equal(out.first, "task-1", "the oldest entry (task-0) must be dropped");
      assert.equal(out.last, "task-1000");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});

describe("scripts/autopilot/reap_state.py — redis_cli (issue #4366 / #2715 / #3785)", () => {
  test("capture=False is fire-and-forget: returns None and still invokes the argv", () => {
    const tmp = makeTmp();
    try {
      const recordLog = join(tmp.dir, "calls.log");
      const stub = writeStub(
        tmp.dir,
        "redis-recorder.sh",
        `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(recordLog)}\nexit 0\n`,
      );
      const r = runPython(
        `${LOAD_PREAMBLE}
print(repr(reap_state.redis_cli("SET", "some-key", "some-value")))
`,
        { HYDRA_AUTOPILOT_REDIS_CLI: `bash ${stub}` },
      );
      assert.equal(r.status, 0, `python probe failed: ${r.stderr}`);
      assert.equal(r.stdout.trim(), "None");
      assert.ok(existsSync(recordLog), "redis_cli must still invoke the stub argv");
      assert.equal(readFileSync(recordLog, "utf-8").trim(), "SET some-key some-value");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("capture=True returns the stripped stdout of a successful call", () => {
    const tmp = makeTmp();
    try {
      const stub = writeStub(
        tmp.dir,
        "redis-recorder.sh",
        `#!/usr/bin/env bash\nprintf '  some-value  \\n'\nexit 0\n`,
      );
      const r = runPython(
        `${LOAD_PREAMBLE}
print(repr(reap_state.redis_cli("GET", "some-key", capture=True)))
`,
        { HYDRA_AUTOPILOT_REDIS_CLI: `bash ${stub}` },
      );
      assert.equal(r.status, 0, `python probe failed: ${r.stderr}`);
      assert.equal(r.stdout.trim(), "'some-value'");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("capture=True with a non-zero exit returns None, never raises", () => {
    const tmp = makeTmp();
    try {
      const stub = writeStub(
        tmp.dir,
        "redis-recorder.sh",
        `#!/usr/bin/env bash\nexit 3\n`,
      );
      const r = runPython(
        `${LOAD_PREAMBLE}
print(repr(reap_state.redis_cli("GET", "some-key", capture=True)))
`,
        { HYDRA_AUTOPILOT_REDIS_CLI: `bash ${stub}` },
      );
      assert.equal(r.status, 0, `python probe failed: ${r.stderr}`);
      assert.equal(r.stdout.trim(), "None");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("a missing redis-cli binary returns None without raising", () => {
    const tmp = makeTmp();
    try {
      const r = runPython(
        `${LOAD_PREAMBLE}
print(repr(reap_state.redis_cli("GET", "some-key", capture=True)))
`,
        { HYDRA_AUTOPILOT_REDIS_CLI: join(tmp.dir, "does-not-exist-binary") },
      );
      assert.equal(r.status, 0, `python probe failed: ${r.stderr}`);
      assert.equal(r.stdout.trim(), "None");
      assert.match(r.stderr, /redis mirror .* failed/);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});

describe("scripts/autopilot/reap_state.py — mirror_cross_run_state_to_redis (issue #4366 / #2715)", () => {
  test("writes exactly one HSET on signal-last-fired and one SET on research-force-counter", () => {
    const tmp = makeTmp();
    try {
      const recordLog = join(tmp.dir, "calls.log");
      const stub = writeStub(
        tmp.dir,
        "redis-recorder.sh",
        `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(recordLog)}\nexit 0\n`,
      );
      const r = runPython(
        `${LOAD_PREAMBLE}
state = {
    "signal_last_fired": {"health": 0, "sweep_orch": 1780000000, "bad": "not-an-int"},
    "research_force_counter": {"2026-09-04": {"orch": 1}},
}
reap_state.mirror_cross_run_state_to_redis(state)
`,
        { HYDRA_AUTOPILOT_REDIS_CLI: `bash ${stub}` },
      );
      assert.equal(r.status, 0, `python probe failed: ${r.stderr}`);
      assert.ok(existsSync(recordLog), "mirror must invoke redis_cli");
      const lines = readFileSync(recordLog, "utf-8").split("\n").filter((l) => l.length > 0);
      assert.equal(lines.length, 2, `expected exactly 2 redis-cli calls, got: ${lines.join(" | ")}`);
      assert.match(lines[0], /^HSET hydra:autopilot:signal-last-fired /);
      assert.doesNotMatch(lines[0], /\bbad\b/, "a non-int-coercible value must be skipped");
      assert.match(lines[0], /\bhealth 0\b/);
      assert.match(lines[0], /\bsweep_orch 1780000000\b/);
      assert.match(lines[1], /^SET hydra:autopilot:research-force-counter /);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("a failing redis-cli stub is swallowed — the mirror never raises", () => {
    const tmp = makeTmp();
    try {
      const stub = writeStub(
        tmp.dir,
        "redis-recorder.sh",
        `#!/usr/bin/env bash\nexit 1\n`,
      );
      const r = runPython(
        `${LOAD_PREAMBLE}
state = {"signal_last_fired": {"health": 0}, "research_force_counter": {}}
reap_state.mirror_cross_run_state_to_redis(state)
print("no-exception")
`,
        { HYDRA_AUTOPILOT_REDIS_CLI: `bash ${stub}` },
      );
      assert.equal(r.status, 0, `mirror must not raise even when redis-cli exits non-zero: ${r.stderr}`);
      assert.equal(r.stdout.trim(), "no-exception");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});
