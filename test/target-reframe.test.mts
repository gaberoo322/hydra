/**
 * test/target-reframe.test.mts — the Target build's single reframe write:
 * the pure label/event plan, and the CLI wrapper through PATH stubs
 * (non-destructive, fail-soft semantics the playbook prose asserts).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildReframePlan } from "../scripts/target/target-reframe.ts";

const SCRIPT = resolve(import.meta.dirname, "..", "scripts", "target", "target-reframe.ts");

describe("buildReframePlan", () => {
  test("a board anchor swaps in-progress/ready-for-agent for reframe", () => {
    const plan = buildReframePlan({ repo: "o/t", anchorNum: "431", anchorRef: "issue-431", reason: "r", hits: "a\nb\n" });
    assert.deepEqual(plan.ghArgs, [
      "issue", "edit", "431", "--repo", "o/t",
      "--remove-label", "in-progress", "--remove-label", "ready-for-agent", "--add-label", "reframe",
    ]);
    assert.deepEqual(plan.event.payload, { anchorRef: "issue-431", reason: "r", hits: "a;b;" });
    assert.equal(plan.event.type, "target:reframe-save");
  });

  test("no anchor number means no relabel, and a missing ref reads as unknown", () => {
    const plan = buildReframePlan({ repo: "o/t", reason: "r", hits: "x" });
    assert.equal(plan.ghArgs, null);
    assert.equal(plan.event.payload.anchorRef, "unknown");
  });
});

function runCli(opts: { ghExit: number; hydraExit: number; anchor: string; hits: string }) {
  const dir = mkdtempSync(join(tmpdir(), "reframe-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    for (const [name, code] of [["gh", opts.ghExit], ["hydra", opts.hydraExit]] as const) {
      const p = join(bin, name);
      writeFileSync(p, `#!/usr/bin/env bash\nprintf '${name} %s\\n' "$*" >> "\${LOG_DIR:?}/${name}.log"\nexit ${code}\n`);
      chmodSync(p, 0o755);
    }
    const res = spawnSync(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", SCRIPT, "--repo", "o/t", "--anchor", opts.anchor,
        "--anchor-ref", "issue-431", "--reason", "why", "--hits-stdin"],
      { input: opts.hits, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LOG_DIR: dir } },
    );
    const read = (n: string) => (existsSync(join(dir, n)) ? readFileSync(join(dir, n), "utf8") : "");
    return { status: res.status, stderr: res.stderr, gh: read("gh.log"), hydra: read("hydra.log") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("target-reframe CLI", () => {
  test("relabels the anchor and publishes the reframe event", () => {
    const r = runCli({ ghExit: 0, hydraExit: 0, anchor: "431", hits: "mod-a\nmod-b\n" });
    assert.equal(r.status, 0);
    assert.match(r.gh, /issue edit 431 --repo o\/t --remove-label in-progress --remove-label ready-for-agent --add-label reframe/);
    assert.match(r.hydra, /raw POST \/events\/publish .*target:reframe-save/);
    assert.match(r.hydra, /mod-a;mod-b;/);
  });

  test("an absent anchor makes no gh call but still publishes", () => {
    const r = runCli({ ghExit: 0, hydraExit: 0, anchor: "", hits: "x" });
    assert.equal(r.status, 0);
    assert.equal(r.gh, "");
    assert.match(r.hydra, /target:reframe-save/);
  });

  test("a failing gh or hydra call warns and still exits 0", () => {
    const r = runCli({ ghExit: 1, hydraExit: 1, anchor: "431", hits: "x" });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /reframe relabel failed \(non-fatal\)/);
    assert.match(r.stderr, /event publish failed \(non-fatal\)/);
  });
});
