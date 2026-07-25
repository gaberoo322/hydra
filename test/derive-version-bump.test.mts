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
import { test, describe } from "node:test";
import assert from "node:assert/strict";

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
