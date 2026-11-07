/**
 * Behavioural tests for scripts/zizmor-scan.sh and its advisory-checks.yml step
 * (issue #5368). The script is RUN in a sandbox with stub curl / sha256sum /
 * cached-binary on PATH: no network IO, never the real zizmor.
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const SCRIPT = join(root, "scripts/zizmor-scan.sh");

interface Sandbox {
  dir: string;
  bin: string;
  cache: string;
  repo: string;
}

function sandbox(withWorkflows = true): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "zizmor-test-"));
  const bin = join(dir, "bin");
  const cache = join(dir, "cache");
  const repo = join(dir, "repo");
  mkdirSync(bin);
  mkdirSync(cache);
  mkdirSync(repo);
  if (withWorkflows) mkdirSync(join(repo, ".github/workflows"), { recursive: true });
  return { dir, bin, cache, repo };
}

function stub(sb: Sandbox, name: string, body: string): void {
  writeFileSync(join(sb.bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(sb.bin, name), 0o755);
}

function runScript(sb: Sandbox, extraEnv: Record<string, string> = {}) {
  return spawnSync("bash", [SCRIPT, sb.repo], {
    env: { ...process.env, PATH: `${sb.bin}:${process.env.PATH}`, ZIZMOR_CACHE_DIR: sb.cache, ...extraEnv },
    encoding: "utf8",
    timeout: 30_000,
  });
}

/** Stub sha256sum that reports one hash for *.tgz files and another for everything else. */
function stubSha(sb: Sandbox, tgz: string, binary: string): void {
  stub(sb, "sha256sum", `case "$1" in *.tgz) echo "${tgz}  $1";; *) echo "${binary}  $1";; esac`);
}

/** curl stub that "downloads" a real tar.gz containing the given fake zizmor script. */
function writeFakeTarball(sb: Sandbox, zizmorScript: string): void {
  const src = join(sb.dir, "tarsrc");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "zizmor"), zizmorScript);
  chmodSync(join(src, "zizmor"), 0o755);
  const tgz = join(sb.dir, "fake.tgz");
  const t = spawnSync("tar", ["-czf", tgz, "-C", src, "zizmor"]);
  assert.equal(t.status, 0);
  stub(sb, "curl", `for a; do o="$a"; done; cp "${tgz}" "$o"`);
}

/** Learn the pinned hashes from the script's own mismatch diagnostics (no text-pinning of the source). */
function pinnedHashes(): { tgz: string; binary: string } {
  const sb = sandbox();
  stubSha(sb, "0".repeat(64), "0".repeat(64));
  stub(sb, "curl", 'for a; do o="$a"; done; echo x > "$o"');
  const tgz = /expected: ([0-9a-f]{64})/.exec(runScript(sb).stderr)?.[1];
  assert.ok(tgz, "tarball expected hash reported");
  const sb2 = sandbox();
  stubSha(sb2, tgz, "0".repeat(64));
  writeFakeTarball(sb2, "#!/bin/sh\nexit 0\n");
  const binary = /expected: ([0-9a-f]{64})/.exec(runScript(sb2).stderr)?.[1];
  assert.ok(binary, "binary expected hash reported");
  return { tgz, binary };
}

const FAKE_ZIZMOR = '#!/bin/sh\necho "ARGV:$*"\nexit ${FAKE_EXIT:-0}\n';

describe("zizmor-scan.sh download + verify path", () => {
  test("tampered tarball: exits 1 on SHA mismatch, never installs a binary, cleans the work dir", () => {
    const sb = sandbox();
    stub(sb, "curl", 'for a; do o="$a"; done; echo tampered > "$o"');
    const r = runScript(sb);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /SHA256 mismatch/);
    assert.deepEqual(readdirSync(sb.cache), [], "no cached binary and no leaked dl.* dir");
  });

  test("tarball with right hash but wrong binary hash: exits 1, binary never installed", () => {
    const h = pinnedHashes();
    const sb = sandbox();
    stubSha(sb, h.tgz, "f".repeat(64));
    writeFakeTarball(sb, FAKE_ZIZMOR);
    const r = runScript(sb);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /SHA256 mismatch/);
    assert.deepEqual(readdirSync(sb.cache), []);
  });

  test("download failure: exits 1 with a distinct download-failed message", () => {
    const sb = sandbox();
    stub(sb, "curl", "exit 22");
    const r = runScript(sb);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /download failed/);
    assert.ok(!/SHA256 mismatch/.test(r.stderr));
    assert.deepEqual(readdirSync(sb.cache), []);
  });

  test("curl is invoked fail-fast with retry and timeout", () => {
    const sb = sandbox();
    stub(sb, "curl", 'echo "ARGS:$*" >&2; exit 22');
    const r = runScript(sb);
    assert.match(r.stderr, /ARGS:-fsSL --retry 3 --max-time 120 /);
  });

  test("good download: installs, runs offline JSON scan on the workflows dir, scan-only argv", () => {
    const h = pinnedHashes();
    const sb = sandbox();
    stubSha(sb, h.tgz, h.binary);
    writeFakeTarball(sb, FAKE_ZIZMOR);
    const r = runScript(sb);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), `ARGV:--offline --format json --no-progress ${sb.repo}/.github/workflows`);
    assert.ok(!r.stdout.includes("--fix"), "scan-only: never --fix");
    assert.ok(readdirSync(sb.cache).some((f) => f.startsWith("zizmor-")), "binary cached");
    assert.ok(!readdirSync(sb.cache).some((f) => f.startsWith("dl.")), "work dir cleaned");
  });
});

describe("zizmor-scan.sh cached-binary path", () => {
  /** Pre-seed the cache with a fake binary whose (stubbed) hash verifies. */
  function seedCache(sb: Sandbox, h: { tgz: string; binary: string }): void {
    const tmp = sandbox();
    stubSha(tmp, h.tgz, h.binary);
    writeFakeTarball(tmp, FAKE_ZIZMOR);
    assert.equal(runScript(tmp).status, 0);
    const name = readdirSync(tmp.cache).find((f) => f.startsWith("zizmor-"));
    assert.ok(name);
    writeFileSync(join(sb.cache, name), FAKE_ZIZMOR);
    chmodSync(join(sb.cache, name), 0o755);
    stubSha(sb, h.tgz, h.binary);
    stub(sb, "curl", "echo UNEXPECTED_DOWNLOAD >&2; exit 99");
  }

  test("valid cached binary: no download, exit code passes through (0 and non-zero)", () => {
    const sb = sandbox();
    seedCache(sb, pinnedHashes());
    const ok = runScript(sb);
    assert.equal(ok.status, 0);
    assert.ok(!ok.stderr.includes("UNEXPECTED_DOWNLOAD"));
    const bad = runScript(sb, { FAKE_EXIT: "14" });
    assert.equal(bad.status, 14, "zizmor's findings exit code is not swallowed");
  });

  test("cached binary with wrong hash is not executed: re-download path taken", () => {
    const h = pinnedHashes();
    const sb = sandbox();
    seedCache(sb, h);
    stubSha(sb, h.tgz, "e".repeat(64)); // cache no longer verifies
    const r = runScript(sb);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /UNEXPECTED_DOWNLOAD/);
    assert.ok(!r.stdout.includes("ARGV:"), "unverified binary never ran");
  });

  test("missing .github/workflows: exits 1 with a clear message", () => {
    const sb = sandbox(false);
    seedCache(sb, pinnedHashes());
    const r = runScript(sb);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no \.github\/workflows/);
  });
});

describe("advisory-checks.yml zizmor step", () => {
  const workflow = readFileSync(join(root, ".github/workflows/advisory-checks.yml"), "utf8");

  test("is an if: always() advisory step that swallows the exit code", () => {
    const i = workflow.indexOf("name: zizmor workflow scan");
    assert.ok(i > 0);
    assert.match(workflow.slice(i, i + 400), /if: always\(\)/);
    assert.match(workflow, /scripts\/zizmor-scan\.sh > zizmor-results\.json \|\| true/);
  });

  test("uploads the JSON artifact with if: always() and 14-day retention", () => {
    const i = workflow.indexOf("name: Upload zizmor results");
    assert.ok(i > 0);
    assert.match(workflow.slice(i, i + 400), /if: always\(\)/);
    assert.match(workflow.slice(i, i + 400), /retention-days: 14/);
  });

  test("zizmor is not wired into the required ci.yml or deep-qa-gate.yml", () => {
    for (const f of ["ci.yml", "deep-qa-gate.yml"]) {
      assert.ok(!readFileSync(join(root, ".github/workflows", f), "utf8").includes("zizmor"));
    }
  });
});
