/**
 * src/github/remote-url.ts — the ONE home of the git-remote URL rule (issue
 * #5098, INV-10). The redactUrlUserinfo cases moved here from
 * test/aggregator-recent-merges.test.mts; the normaliser and host extractor are
 * the TypeScript port of the watchdog's bash `sed` chain, pinned by the same
 * table the bash suite exercised end to end.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  normaliseRemoteRepo,
  redactUrlUserinfo,
  redactUrlUserinfoText,
  remoteHost,
} from "../src/github/remote-url.ts";

describe("redactUrlUserinfo", () => {
  test("scp-style user@host:path has no scheme and is left alone", () => {
    assert.equal(redactUrlUserinfo("git@github.com:a/b.git"), "git@github.com:a/b.git");
  });

  test("strips through the LAST @ (a token containing @ never leaks)", () => {
    assert.equal(redactUrlUserinfo("https://user:ghp_ab@cd@github.com/a/b.git"), "https://github.com/a/b.git");
  });

  test("a token containing `/` before the @ never leaks (QA round 4)", () => {
    assert.equal(redactUrlUserinfo("https://user:ghp_a/b@github.com/a/b.git"), "https://github.com/a/b.git");
  });

  test("RFC 3986 scheme chars (digits, `.`, `-`, `+`)", () => {
    assert.equal(redactUrlUserinfo("git+ssh://u:t@host/a/b.git"), "git+ssh://host/a/b.git");
    assert.equal(redactUrlUserinfo("s3.x-1://u:t@host/a"), "s3.x-1://host/a");
  });

  test("no userinfo: unchanged; an @ in the PATH is over-stripped (fail-safe for a log sink)", () => {
    assert.equal(redactUrlUserinfo("https://github.com/a/b.git"), "https://github.com/a/b.git");
    assert.equal(redactUrlUserinfo("https://github.com/a/b@v1"), "https://v1");
  });
});

describe("redactUrlUserinfoText (free-text git stderr)", () => {
  test("strips userinfo anywhere in the text, greedy to the last @ of the whitespace/quote-free run", () => {
    assert.equal(
      redactUrlUserinfoText("fatal: unable to access 'https://u:tok/en@github.com/a/b.git/': 403"),
      "fatal: unable to access 'https://github.com/a/b.git/': 403",
    );
    assert.equal(redactUrlUserinfoText("remote: https://a:b@h/x and https://c:d@h2/y"), "remote: https://h/x and https://h2/y");
  });

  test("text without userinfo is unchanged", () => {
    assert.equal(redactUrlUserinfoText("fatal: could not resolve host"), "fatal: could not resolve host");
  });
});

describe("normaliseRemoteRepo", () => {
  const table: Array<[string, string]> = [
    ["https://github.com/gaberoo322/hydra.git", "gaberoo322/hydra"],
    ["https://github.com/gaberoo322/hydra", "gaberoo322/hydra"],
    ["https://github.com/gaberoo322/hydra/", "gaberoo322/hydra"],
    ["git@github.com:gaberoo322/hydra.git", "gaberoo322/hydra"],
    ["ssh://git@github.com/gaberoo322/hydra.git", "gaberoo322/hydra"],
    ["https://user:tok/en@github.com/gaberoo322/hydra.git", "gaberoo322/hydra"],
    ["", ""],
  ];
  for (const [url, want] of table) {
    test(`${JSON.stringify(url)} -> ${JSON.stringify(want)}`, () => {
      assert.equal(normaliseRemoteRepo(url), want);
    });
  }
});

describe("remoteHost", () => {
  const table: Array<[string, string]> = [
    ["https://github.com/gaberoo322/hydra.git", "github.com"],
    ["git@github.com:gaberoo322/hydra.git", "github.com"],
    ["https://GitHub.com:443/a/b.git", "github.com"],
    ["https://u:t@gitlab.example.com/a/b.git", "gitlab.example.com"],
    ["git@gh-alias:a/b.git", "gh-alias"],
    ["", ""],
  ];
  for (const [url, want] of table) {
    test(`${JSON.stringify(url)} -> ${JSON.stringify(want)}`, () => {
      assert.equal(remoteHost(url), want);
    });
  }
});

describe("one home (INV-10)", () => {
  test("recent-merges.ts imports redactUrlUserinfo and no longer exports or re-exports it", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "src", "aggregators", "recent-merges.ts"), "utf8");
    assert.match(src, /import \{ redactUrlUserinfo \} from "\.\.\/github\/remote-url\.ts";/);
    assert.doesNotMatch(src, /export (function|const) redactUrlUserinfo|export \{[^}]*redactUrlUserinfo/);
  });

  test("the watchdog origin check uses the same functions, not its own copies", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "src", "watchdog", "origin-identity.ts"), "utf8");
    assert.match(src, /from "\.\.\/github\/remote-url\.ts"/);
    assert.doesNotMatch(src, /function (redact|normalise)\w*\(/);
  });
});
