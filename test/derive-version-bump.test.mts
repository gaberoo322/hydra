/**
 * derive-version-bump tests (issue #3677, epic #3676 alpha).
 *
 * Covers scripts/ci/derive-version-bump.ts — the pure Conventional-Commits bump
 * derivation deploy.sh uses to pick the next semver tag. Every case exercises a
 * pure function with commit subjects/bodies as DATA — no git process is spawned
 * (the CLI main() is the only git-touching part and lives behind the
 * import.meta.url guard).
 *
 * Precedence under test:
 *   feat -> MINOR; everything else (fix/chore/refactor/security/... + unknown)
 *   -> PATCH; `!` suffix or BREAKING CHANGE footer -> MAJOR; highest wins.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  bumpForCommit,
  deriveBump,
  applyBump,
  parseSemver,
  formatTag,
  nextTag,
  parseGitLog,
  BASELINE_VERSION,
} from "../scripts/ci/derive-version-bump.ts";

describe("bumpForCommit — single-commit precedence (#3677)", () => {
  test("feat is a minor bump", () => {
    assert.equal(bumpForCommit("feat: add versions panel"), "minor");
  });

  test("scoped feat parses on the type before the scope", () => {
    assert.equal(bumpForCommit("feat(dashboard): add versions panel"), "minor");
  });

  test("fix / chore / refactor / security / perf are patch bumps", () => {
    assert.equal(bumpForCommit("fix: correct off-by-one"), "patch");
    assert.equal(bumpForCommit("chore: bump deps"), "patch");
    assert.equal(bumpForCommit("refactor(core): extract seam"), "patch");
    assert.equal(bumpForCommit("security: pin osv-scanner"), "patch");
    assert.equal(bumpForCommit("perf: cache the read"), "patch");
  });

  test("a `!` suffix is a major bump regardless of type", () => {
    assert.equal(bumpForCommit("feat!: drop the legacy API"), "major");
    assert.equal(bumpForCommit("refactor(core)!: rename the seam"), "major");
    assert.equal(bumpForCommit("fix!: change the error code"), "major");
  });

  test("a BREAKING CHANGE footer in the body is a major bump", () => {
    assert.equal(
      bumpForCommit("feat: rework config", "some detail\n\nBREAKING CHANGE: env vars renamed"),
      "major",
    );
    // The hyphenated spelling is also recognized.
    assert.equal(bumpForCommit("chore: cleanup", "BREAKING-CHANGE: removed flag"), "major");
  });

  test("unknown / non-conventional subjects default to patch (never skip a bump)", () => {
    assert.equal(bumpForCommit("Merge branch 'master'"), "patch");
    assert.equal(bumpForCommit("WIP random text"), "patch");
    assert.equal(bumpForCommit(""), "patch");
  });
});

describe("deriveBump — highest across a range wins (#3677)", () => {
  test("a range of only refactor/chore/fix is patch", () => {
    const bump = deriveBump([
      { subject: "refactor: x" },
      { subject: "chore: y" },
      { subject: "fix: z" },
    ]);
    assert.equal(bump, "patch");
  });

  test("a feat anywhere in the range lifts patch to minor", () => {
    const bump = deriveBump([
      { subject: "fix: a" },
      { subject: "feat: b" },
      { subject: "chore: c" },
    ]);
    assert.equal(bump, "minor");
  });

  test("a breaking commit lifts the range to major", () => {
    const bump = deriveBump([
      { subject: "feat: a" },
      { subject: "fix!: b" },
    ]);
    assert.equal(bump, "major");
  });

  test("an empty range is patch", () => {
    assert.equal(deriveBump([]), "patch");
  });
});

describe("parseSemver / applyBump / formatTag (#3677)", () => {
  test("parses a leading-v and a bare triple; rejects garbage", () => {
    assert.deepEqual(parseSemver("v1.2.3"), { major: 1, minor: 2, patch: 3 });
    assert.deepEqual(parseSemver("10.0.7"), { major: 10, minor: 0, patch: 7 });
    assert.equal(parseSemver("v1.2"), null);
    assert.equal(parseSemver("nope"), null);
  });

  test("applyBump resets lower components per semver", () => {
    const v = { major: 1, minor: 2, patch: 3 };
    assert.deepEqual(applyBump(v, "patch"), { major: 1, minor: 2, patch: 4 });
    assert.deepEqual(applyBump(v, "minor"), { major: 1, minor: 3, patch: 0 });
    assert.deepEqual(applyBump(v, "major"), { major: 2, minor: 0, patch: 0 });
  });

  test("formatTag renders a leading-v tag", () => {
    assert.equal(formatTag({ major: 2, minor: 0, patch: 0 }), "v2.0.0");
  });
});

describe("nextTag — end-to-end derivation (#3677)", () => {
  test("no prior tag yields the baseline v1.0.0", () => {
    assert.equal(nextTag(null, [{ subject: "feat: anything" }]), `v${BASELINE_VERSION}`);
    assert.equal(nextTag("", [{ subject: "fix: anything" }]), `v${BASELINE_VERSION}`);
  });

  test("an unparseable prior tag falls back to the baseline", () => {
    assert.equal(nextTag("release-2024", [{ subject: "feat: x" }]), `v${BASELINE_VERSION}`);
  });

  test("prior tag + a feat range yields a minor bump", () => {
    assert.equal(nextTag("v1.2.3", [{ subject: "feat: x" }, { subject: "fix: y" }]), "v1.3.0");
  });

  test("prior tag + a patch-only range yields a patch bump", () => {
    assert.equal(nextTag("v1.2.3", [{ subject: "chore: x" }]), "v1.2.4");
  });

  test("prior tag + a breaking range yields a major bump", () => {
    assert.equal(nextTag("v1.2.3", [{ subject: "feat!: x" }]), "v2.0.0");
  });
});

describe("parseGitLog — record splitting (#3677)", () => {
  test("splits NUL-subject/RS-record framed log into subject+body pairs", () => {
    // Frame: <subject>\x00<body>\x1e per commit, matching the CLI's
    // `git log --format=%s%x00%b%x1e` contract.
    const raw = "feat: a\x00body one\x1efix: b\x00\x1erefactor: c\x00multi\nline body\x1e";
    const parsed = parseGitLog(raw);
    assert.equal(parsed.length, 3);
    assert.deepEqual(parsed[0], { subject: "feat: a", body: "body one" });
    assert.deepEqual(parsed[1], { subject: "fix: b", body: "" });
    assert.deepEqual(parsed[2], { subject: "refactor: c", body: "multi\nline body" });
  });

  test("an empty log yields no records", () => {
    assert.deepEqual(parseGitLog(""), []);
    assert.deepEqual(parseGitLog("\x1e\x1e"), []);
  });

  test("a subject-only record (no NUL) still parses", () => {
    const parsed = parseGitLog("feat: solo\x1e");
    assert.deepEqual(parsed, [{ subject: "feat: solo", body: "" }]);
  });
});

// ---------------------------------------------------------------------------
// Issue #3733 — the deploy version-stamp TRANSPORT, not the bump math.
//
// The suites above only ever exercised pure functions with literal strings, so
// the transport between deploy.sh and the CLI was never under test. That is how
// a P1 shipped: every master deploy exited 126 at this step (AFTER the service
// was already rebuilt, restarted and health-checked), because the no-prior-tag
// branch shoved the whole 1,575,596-byte history into a single environment
// variable. Linux caps ONE argv/environ string at MAX_ARG_STRLEN (32 pages =
// 131,072 bytes) regardless of the far larger ARG_MAX, so `node` died with
// "Argument list too long". It could not self-heal: zero tags -> whole-history
// branch -> E2BIG -> exit before `git tag` -> still zero tags, forever.
//
// The everything-else-is-fine part is what made it dangerous. A red `deploy` job
// is the ONLY prod-behind-master alarm the system has (the watchdog checks
// health, not SHA drift), so a permanently red deploy job trains operators and
// autopilot to ignore exactly that alarm.
//
// These are NEW TOP-LEVEL suites with their own lifecycle (per CLAUDE.md, never
// nested under a sibling suite's teardown).
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DERIVE_CLI = join(REPO_ROOT, "scripts/ci/derive-version-bump.ts");
const STAMP_SCRIPT = join(REPO_ROOT, "scripts/ci/stamp-version.sh");
const DEPLOY_SCRIPT = join(REPO_ROOT, "scripts/deploy.sh");

/** Linux `MAX_ARG_STRLEN` — 32 pages. The per-STRING cap that E2BIG'd the deploy. */
const MAX_ARG_STRLEN = 32 * 4096;

/** Run the derive CLI exactly as stamp-version.sh does: range on stdin, tag on stdout. */
function runDeriveCli(stdin: string, env: NodeJS.ProcessEnv = {}): string {
  return execFileSync(process.execPath, ["--experimental-strip-types", DERIVE_CLI], {
    input: stdin,
    encoding: "utf-8",
    env: { ...process.env, ...env },
  }).trim();
}

/** A `git log --format=%s%x00%b%x1e` record for one commit. */
function record(subject: string, body = ""): string {
  return `${subject}\x00${body}\x1e`;
}

describe("derive-version-bump CLI — the commit range travels on stdin (#3733)", () => {
  test("a NUL-framed range with a multi-line BREAKING CHANGE body yields a major bump", () => {
    // The exact shape `git log --format='%s%x00%b%x1e'` emits. Bash command
    // substitution CANNOT carry the NUL and silently strips it, which is why the
    // env route destroyed this framing before the parser ever saw it. A pipe is
    // byte-transparent, so the trailer survives and MAJOR is detected.
    const raw =
      record("fix: tighten the retry bound", "no trailer here\nsecond line") +
      record(
        "refactor(core): rework the config seam",
        "Context paragraph that spans\nseveral lines of prose.\n\nBREAKING CHANGE: HYDRA_* env vars renamed.\nCallers must update their drop-ins.",
      ) +
      record("chore: bump deps");
    assert.equal(runDeriveCli(raw, { PREV_TAG: "v1.2.3" }), "v2.0.0");
  });

  test("a range far larger than MAX_ARG_STRLEN is carried without E2BIG", () => {
    // The regression pin. Sized well past the 131,072-byte per-string environ cap
    // that produced "Argument list too long" (exit 126) on every master deploy —
    // routing this same payload through the environment is what a re-regression
    // would look like, and it would die here rather than in production.
    const filler = "x".repeat(400);
    let raw = "";
    for (let i = 0; raw.length < MAX_ARG_STRLEN * 2; i++) {
      raw += record(`fix: bounded transport commit ${i}`, `body ${i}\n${filler}`);
    }
    assert.ok(raw.length > MAX_ARG_STRLEN, "payload must exceed the per-string env limit");
    // A single `feat` in the oversized range must still lift patch -> minor,
    // proving the whole stream was read, not just the first pipe buffer.
    raw += record("feat: the last commit in a very long range");
    assert.equal(runDeriveCli(raw, { PREV_TAG: "v2.5.1" }), "v2.6.0");
  });

  test("the retired GIT_LOG environment variable is ignored", () => {
    // Pins that the env transport is gone, not merely unused: a stale GIT_LOG in
    // the environment must not override (or contribute to) the piped range.
    // Note the value carries NO NUL — node itself refuses to spawn with a
    // null-bearing env value, which is a second, independent reason the old
    // `GIT_LOG=` route could never have carried the %x00 framing intact.
    const tag = runDeriveCli(record("fix: only this counts"), {
      PREV_TAG: "v1.2.3",
      GIT_LOG: "feat!: a breaking change that must NOT be seen\x1e",
    });
    assert.equal(tag, "v1.2.4");
  });

  test("an empty range with no prior tag mints the baseline v1.0.0", () => {
    assert.equal(runDeriveCli("", { PREV_TAG: "" }), `v${BASELINE_VERSION}`);
  });
});

/** Make a throwaway git repo with local identity + signing disabled. */
function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "hydra-stamp-version-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf-8", stdio: "pipe" });
  git("init", "-q", "-b", "master");
  git("config", "user.email", "stamp-test@example.invalid");
  git("config", "user.name", "stamp test");
  git("config", "commit.gpgsign", "false");
  git("config", "tag.gpgSign", "false");
  return dir;
}

function commit(dir: string, subject: string, body = ""): void {
  const args = ["commit", "-q", "--allow-empty", "-m", subject];
  if (body) args.push("-m", body);
  execFileSync("git", args, { cwd: dir, encoding: "utf-8", stdio: "pipe" });
}

/** Run stamp-version.sh against `cwd`, returning its exit code + combined output. */
function runStamp(cwd: string): { code: number; out: string } {
  try {
    const out = execFileSync("bash", [STAMP_SCRIPT], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function tags(dir: string): string[] {
  const raw = execFileSync("git", ["tag", "--list"], { cwd: dir, encoding: "utf-8" });
  return raw.split("\n").filter((t) => t.trim().length > 0);
}

describe("scripts/ci/stamp-version.sh — end-to-end tagging (#3733)", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempRepo();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("a repo with ZERO tags mints v1.0.0 and exits 0 (the bootstrap that could never happen)", () => {
    // Acceptance criterion 1. The old code took the whole-history branch here and
    // died before `git tag`, so the FIRST tag could never be minted and the next
    // deploy hit the identical failure. No tag read happens on this path at all
    // now: nextTag(null, …) is the baseline and never inspects the commits.
    commit(dir, "feat: initial");
    commit(dir, "fix: follow-up");
    commit(dir, "chore: third");

    const { code, out } = runStamp(dir);
    assert.equal(code, 0, `stamp-version.sh must succeed on a zero-tag repo:\n${out}`);
    assert.deepEqual(tags(dir), ["v1.0.0"]);
    // The push has no remote to reach; that must be tolerated, never fatal.
    assert.match(out, /Tagged v1\.0\.0/);
  });

  test("re-running on an already-tagged HEAD is an idempotent no-op", () => {
    commit(dir, "feat: initial");
    assert.equal(runStamp(dir).code, 0);
    const { code, out } = runStamp(dir);
    assert.equal(code, 0);
    assert.match(out, /already tagged v1\.0\.0/);
    assert.deepEqual(tags(dir), ["v1.0.0"]);
  });

  test("a feat since the prior tag bumps MINOR through the real piped range", () => {
    commit(dir, "feat: initial");
    runStamp(dir);
    commit(dir, "fix: a");
    commit(dir, "feat: b");
    const { code, out } = runStamp(dir);
    assert.equal(code, 0, out);
    assert.deepEqual(tags(dir).sort(), ["v1.0.0", "v1.1.0"]);
  });

  test("a BREAKING CHANGE trailer in a multi-line body survives the pipe and bumps MAJOR", () => {
    // The NUL-safety acceptance criterion, exercised through real `git log`
    // output rather than a literal string. Under the old bash-variable transport
    // the %x00 separator was stripped, so the body (and its trailer) fused into
    // the subject and the MAJOR bump was silently lost.
    commit(dir, "feat: initial");
    runStamp(dir);
    commit(
      dir,
      "refactor(core): rework the config seam",
      "Context paragraph that spans\nseveral lines.\n\nBREAKING CHANGE: HYDRA_* env vars renamed.",
    );
    const { code, out } = runStamp(dir);
    assert.equal(code, 0, out);
    assert.deepEqual(tags(dir).sort(), ["v1.0.0", "v2.0.0"]);
  });

  test("it FAILS LOUD in its own process when git is unusable (forced-failure injection)", () => {
    // The child must still honour errexit — otherwise a failed derivation would
    // fall through to `git tag` / `git push` with an empty or wrong tag. deploy.sh
    // is what downgrades this non-zero exit to a warning, not the script itself.
    const notARepo = mkdtempSync(join(tmpdir(), "hydra-stamp-not-a-repo-"));
    try {
      const { code } = runStamp(notARepo);
      assert.notEqual(code, 0, "stamp-version.sh must exit non-zero when git fails");
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });
});

/**
 * Drop whole-line `#` comments so a "this construct must NOT appear" assertion
 * reads the executable shell only. Both scripts document the retired
 * `GIT_LOG=` / `git log HEAD` forms at length precisely so they are never
 * reintroduced, and those prose mentions must not count as code.
 */
function shellCodeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

describe("scripts/deploy.sh — a failed stamp cannot redden a healthy deploy (#3733)", () => {
  const deploySrc = readFileSync(DEPLOY_SCRIPT, "utf-8");
  const stampSrc = readFileSync(STAMP_SCRIPT, "utf-8");
  const deployCode = shellCodeOnly(deploySrc);
  const stampCode = shellCodeOnly(stampSrc);

  test("deploy.sh invokes the stamp as a CHILD PROCESS with its exit code tolerated", () => {
    // `bash child.sh || RC=$?` is the ONLY form that both tolerates the failure at
    // the caller AND keeps errexit live inside the callee. `stamp_fn || warn` and
    // `( set -e; … ) || warn` both suppress errexit for the entire body.
    assert.match(deployCode, /bash scripts\/ci\/stamp-version\.sh \|\| STAMP_RC=\$\?/);
    assert.match(deployCode, /if \[ "\$STAMP_RC" -ne 0 \]; then/);
  });

  test("a stamp failure emits a warning and is distinguishable from a failed deploy", () => {
    // Loud, not red: the annotation surfaces in the Actions UI and the plain
    // WARNING line covers manual runs, while the health gate above still exits 1
    // on a genuinely failed deploy — so "healthy + no tag" and "deploy broken"
    // never look alike in the log.
    assert.match(deployCode, /::warning::Version stamping failed/);
    assert.match(deployCode, /WARNING: version stamping failed/);
    assert.match(deployCode, /==> WARNING: Health check failed after deploy!/);
    assert.match(deployCode, /exit 1/);
  });

  test("the guard really swallows a non-zero child under set -euo pipefail", () => {
    // Behavioural proof of the construct above, run against the REAL failing
    // stamp-version.sh (invoked outside a git repo, exactly as in the injection
    // case) rather than a stand-in.
    const notARepo = mkdtempSync(join(tmpdir(), "hydra-stamp-guard-"));
    try {
      const out = execFileSync(
        "bash",
        [
          "-c",
          'set -euo pipefail\nSTAMP_RC=0\nbash "$1" >/dev/null 2>&1 || STAMP_RC=$?\nif [ "$STAMP_RC" -ne 0 ]; then echo "TOLERATED:$STAMP_RC"; fi\necho REACHED_END',
          "_",
          STAMP_SCRIPT,
        ],
        { cwd: notARepo, encoding: "utf-8" },
      );
      assert.match(out, /TOLERATED:[1-9]/);
      assert.match(out, /REACHED_END/);
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });

  test("neither script routes the commit range through the environment any more", () => {
    // The E2BIG re-regression pin: `GIT_LOG=` in a bash variable is both the size
    // bug (MAX_ARG_STRLEN) and the NUL-stripping bug.
    assert.doesNotMatch(deployCode, /GIT_LOG=/);
    assert.doesNotMatch(stampCode, /GIT_LOG=/);
    assert.match(stampCode, /\| PREV_TAG="\$PREV_TAG" node --experimental-strip-types/);
  });

  test("the unbounded whole-history read is gone by construction", () => {
    // `git log HEAD` with no range is what produced the 1.5 MB payload. The
    // no-prior-tag path must read NO log at all — the baseline is v1.0.0 and
    // nextTag never inspects the commits there.
    assert.doesNotMatch(deployCode, /git log HEAD/);
    assert.doesNotMatch(stampCode, /git log HEAD/);
    // The only `git log` left is the bounded PREV_TAG..HEAD range.
    const gitLogs = stampCode.match(/^\s*(?:\w+="\$\()?git log .*/gm) ?? [];
    assert.equal(gitLogs.length, 1, `expected exactly one bounded git log, got: ${gitLogs}`);
    assert.match(gitLogs[0]!, /\$\{PREV_TAG\}\.\.HEAD/);
  });

  test("the %x00 NUL tripwire is retained as the subject/body separator", () => {
    // Deliberate: a future regression to env transport on a SMALL range would sit
    // under MAX_ARG_STRLEN and corrupt BREAKING-CHANGE detection silently. With
    // %x00, bash re-emits "ignored null byte in input" and the regression is loud.
    assert.match(stampSrc, /%s%x00%b%x1e/);
  });
});
