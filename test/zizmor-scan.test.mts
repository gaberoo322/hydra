/**
 * Structural tests for scripts/zizmor-scan.sh and its advisory-checks.yml step
 * (issue #5368). Text-only: no network IO, never executes the binary.
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
