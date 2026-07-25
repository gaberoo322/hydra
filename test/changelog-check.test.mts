/**
 * Tests for the advisory changelog-fragment checker's pure predicates (#3678).
 *
 * These exercise ONLY the fragment-detection + silence decision — never the
 * gh/network path (which lives in the workflow shell). They lock the invariant
 * that a PR is silenced iff it adds a `.changelog/` fragment OR carries the
 * skip-changelog label, and that the sticky comment always carries the hidden
 * marker so the workflow can update it in place.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  CHANGELOG_COMMENT_MARKER,
  SKIP_CHANGELOG_LABEL,
  CHANGELOG_DIR_PREFIX,
  isChangelogFragment,
  addsChangelogFragment,
  hasSkipLabel,
  shouldNag,
  nagCommentBody,
} from "../scripts/ci/changelog-check.ts";

describe("isChangelogFragment", () => {
  test("matches a file directly under .changelog/", () => {
    assert.equal(isChangelogFragment(".changelog/3678-foo.md"), true);
  });

  test("matches a nested file under .changelog/", () => {
    assert.equal(isChangelogFragment(".changelog/sub/x.md"), true);
  });

  test("normalises a leading ./", () => {
    assert.equal(isChangelogFragment("./.changelog/3678-foo.md"), true);
  });

  test("rejects the bare directory with no file", () => {
    assert.equal(isChangelogFragment(".changelog/"), false);
  });

  test("rejects a non-changelog path", () => {
    assert.equal(isChangelogFragment("src/foo.ts"), false);
  });

  test("rejects a lookalike prefix", () => {
    assert.equal(isChangelogFragment(".changelogger/x.md"), false);
  });

  test("rejects empty / whitespace", () => {
    assert.equal(isChangelogFragment(""), false);
    assert.equal(isChangelogFragment("   "), false);
  });

  test("the README under .changelog/ is itself a fragment path", () => {
    // The README lives under the prefix; the workflow only passes ADDED files,
    // so this is documented behaviour rather than a special-case exclusion.
    assert.equal(isChangelogFragment(".changelog/README.md"), true);
  });
});

describe("addsChangelogFragment", () => {
  test("true when any added file is a fragment", () => {
    assert.equal(addsChangelogFragment(["src/a.ts", ".changelog/3678-x.md"]), true);
  });

  test("false when no added file is a fragment", () => {
    assert.equal(addsChangelogFragment(["src/a.ts", "test/b.test.mts"]), false);
  });

  test("false for empty list", () => {
    assert.equal(addsChangelogFragment([]), false);
  });

  test("tolerates null/undefined", () => {
    assert.equal(addsChangelogFragment(undefined as unknown as string[]), false);
  });
});

describe("hasSkipLabel", () => {
  test("true when the skip-changelog label is present", () => {
    assert.equal(hasSkipLabel(["enhancement", SKIP_CHANGELOG_LABEL]), true);
  });

  test("case-insensitive match", () => {
    assert.equal(hasSkipLabel(["Skip-Changelog"]), true);
  });

  test("false when absent", () => {
    assert.equal(hasSkipLabel(["enhancement", "ready-for-agent"]), false);
  });

  test("false for empty / null", () => {
    assert.equal(hasSkipLabel([]), false);
    assert.equal(hasSkipLabel(undefined as unknown as string[]), false);
  });
});

describe("shouldNag — the silence decision", () => {
  test("silent when a fragment is added", () => {
    assert.equal(shouldNag([".changelog/3678-x.md"], []), false);
  });

  test("silent when skip-changelog label is present (no fragment)", () => {
    assert.equal(shouldNag(["src/a.ts"], [SKIP_CHANGELOG_LABEL]), false);
  });

  test("silent when BOTH fragment and label present", () => {
    assert.equal(shouldNag([".changelog/3678-x.md"], [SKIP_CHANGELOG_LABEL]), false);
  });

  test("NAGS when no fragment and no skip label", () => {
    assert.equal(shouldNag(["src/a.ts", "test/b.test.mts"], ["enhancement"]), true);
  });

  test("NAGS on an empty diff with no label", () => {
    assert.equal(shouldNag([], []), true);
  });
});

describe("nagCommentBody", () => {
  test("always begins with the hidden marker for sticky updates", () => {
    assert.ok(nagCommentBody().startsWith(CHANGELOG_COMMENT_MARKER));
  });

  test("mentions the .changelog/ path convention and the skip label", () => {
    const body = nagCommentBody();
    assert.ok(body.includes(CHANGELOG_DIR_PREFIX));
    assert.ok(body.includes(SKIP_CHANGELOG_LABEL));
  });

  test("advertises itself as non-blocking", () => {
    assert.match(nagCommentBody(), /never blocks/i);
  });
});
