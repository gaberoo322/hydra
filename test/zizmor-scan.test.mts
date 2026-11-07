/**
 * Structural tests for scripts/zizmor-scan.sh and its advisory-checks.yml step
 * (issue #5368). Text-only: no network IO, never executes the binary.
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const script = readFileSync(join(root, "scripts/zizmor-scan.sh"), "utf8");
const workflow = readFileSync(join(root, ".github/workflows/advisory-checks.yml"), "utf8");
const executable = script
  .split("\n")
  .filter((l) => !l.trim().startsWith("#"))
  .join("\n");

describe("zizmor-scan.sh", () => {
  test("never passes --fix (scan-only)", () => {
    assert.ok(!script.includes("--fix"));
  });

  test("runs offline JSON against the explicit workflows dir", () => {
    assert.match(executable, /--offline --format json --no-progress/);
    assert.match(executable, /\.github\/workflows/);
    assert.ok(!executable.includes("--gh-token"));
  });

  test("pins version and verifies tarball and binary SHA256", () => {
    assert.match(script, /ZIZMOR_VERSION="v1\.32\.0"/);
    assert.match(script, /zizmor-x86_64-unknown-linux-gnu\.tar\.gz/);
    assert.match(script, /bb110cc765eca9cd7efb2e284a956be5974c60027b0970f16397d86208a9957b/);
    assert.match(script, /04d55fb88e582a8e9a9ce6b4753df723fc44c35e0d1a8e8771db9e017066c6df/);
    const tarVerify = script.indexOf('verify_sha "$WORK/zizmor.tgz"');
    const extract = script.indexOf("tar -xzf");
    assert.ok(tarVerify > 0 && extract > tarVerify, "tarball verified before extraction");
  });

  test("no dependency lane: no npx, no npm install", () => {
    assert.ok(!/\bnpx\b|npm (i|install)\b/.test(executable));
  });

  test("passes zizmor's exit code through (no --no-exit-codes)", () => {
    assert.ok(!script.includes("--no-exit-codes"));
    assert.match(executable, /exec "\$BIN"/);
  });
});

describe("advisory-checks.yml zizmor step", () => {
  test("is an if: always() advisory step that swallows the exit code", () => {
    const i = workflow.indexOf("name: zizmor workflow scan");
    assert.ok(i > 0);
    assert.match(workflow.slice(i, i + 400), /if: always\(\)/);
    assert.match(workflow, /scripts\/zizmor-scan\.sh > zizmor-results\.json \|\| true/);
  });

  test("uploads the JSON artifact with if: always()", () => {
    const i = workflow.indexOf("name: Upload zizmor results");
    assert.ok(i > 0);
    assert.match(workflow.slice(i, i + 200), /if: always\(\)/);
    assert.match(workflow, /name: zizmor-results/);
  });
});

describe("zizmor-scan.sh behaviour (runs the script with a stub curl)", () => {
  function run(curlBody: string) {
    const dir = mkdtempSync(join(tmpdir(), "zizmor-test-"));
    const bin = join(dir, "bin");
    const cache = join(dir, "cache");
    mkdirSync(bin);
    writeFileSync(join(bin, "curl"), `#!/bin/sh\n${curlBody}\n`);
    chmodSync(join(bin, "curl"), 0o755);
    const r = spawnSync("bash", [join(root, "scripts/zizmor-scan.sh"), root], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ZIZMOR_CACHE_DIR: cache },
      encoding: "utf8",
      timeout: 30_000,
    });
    return { r, cache };
  }

  test("tampered tarball: exits 1 on SHA mismatch, never installs a binary, cleans the work dir", () => {
    // stub curl writes garbage to the -o target (last arg)
    const { r, cache } = run('for a; do o="$a"; done; echo tampered > "$o"');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /SHA256 mismatch/);
    const left = existsSync(cache) ? readdirSync(cache) : [];
    assert.deepEqual(left, [], "no cached binary and no leaked dl.* dir");
  });

  test("download failure: exits 1 with a distinct download-failed message", () => {
    const { r, cache } = run("exit 22");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /download failed/);
    assert.ok(!/SHA256 mismatch/.test(r.stderr));
    assert.deepEqual(existsSync(cache) ? readdirSync(cache) : [], []);
  });

  test("curl is invoked fail-fast with retry and timeout", () => {
    const { r } = run('echo "ARGS:$*" >&2; exit 22');
    assert.match(r.stderr, /ARGS:-fsSL --retry 3 --max-time 120 /);
  });
});

describe("advisory-checks.yml zizmor step details", () => {
  test("warning counts High-severity only and artifact retention is 14 days", () => {
    assert.match(workflow, /select\(\.determinations\.severity == "High"\)/);
    const i = workflow.indexOf("name: Upload zizmor results");
    assert.match(workflow.slice(i, i + 400), /retention-days: 14/);
  });
  test("zizmor is not wired into the required ci.yml or deep-qa-gate.yml", () => {
    for (const f of ["ci.yml", "deep-qa-gate.yml"]) {
      assert.ok(!readFileSync(join(root, ".github/workflows", f), "utf8").includes("zizmor"));
    }
  });
  test("script is strict-mode", () => {
    assert.match(script, /^set -euo pipefail$/m);
  });
});
