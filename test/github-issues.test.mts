/**
 * Regression tests for the GitHub Issue/PR Read seam (issue #908).
 *
 * Splits into two halves:
 *   - PURE: repo-handle resolution and the canonical row parsers — no
 *     subprocess. (The dispatch-class label classifiers this seam once
 *     carried were deleted by #1672 — provenance classification now lives in
 *     the taxonomy Module and is pinned in `taxonomy-classes.test.mts`.)
 *   - WIRED: the list/view readers driven through a fake `gh` binary
 *     (HYDRA_GH_BIN, the same DI point github-seam.test.mts uses) so the argv
 *     construction, the JSON parse, and the never-throw failure mapping are all
 *     exercised end-to-end without a real `gh`.
 */

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

import {
  DEFAULT_GITHUB_REPO,
  resolveGithubRepo,
  parseIssueRows,
  parsePrRows,
  listIssuesByLabel,
  listIssuesBySearch,
  listOpenPrs,
  viewPr,
  listIssuesByLabelOrEmpty,
  normalizePrViewFromRest,
  _clearViewPrCache,
} from "../src/github/issues.ts";

// ---------------------------------------------------------------------------
// PURE — repo handle
// ---------------------------------------------------------------------------

describe("resolveGithubRepo", () => {
  let saved: string | undefined;
  before(() => {
    saved = process.env.HYDRA_GITHUB_REPO;
  });
  beforeEach(() => {
    delete process.env.HYDRA_GITHUB_REPO;
  });
  after(() => {
    if (saved === undefined) delete process.env.HYDRA_GITHUB_REPO;
    else process.env.HYDRA_GITHUB_REPO = saved;
  });

  test("default when no override and no env", () => {
    assert.equal(resolveGithubRepo(), DEFAULT_GITHUB_REPO);
    assert.equal(DEFAULT_GITHUB_REPO, "gaberoo322/hydra");
  });

  test("env override wins over the default", () => {
    process.env.HYDRA_GITHUB_REPO = "acme/widgets";
    assert.equal(resolveGithubRepo(), "acme/widgets");
  });

  test("explicit override wins over env (legacy deps.githubRepo seam)", () => {
    process.env.HYDRA_GITHUB_REPO = "acme/widgets";
    assert.equal(resolveGithubRepo("other/repo"), "other/repo");
  });

  test("empty-string override is returned verbatim (the historical skip sentinel)", () => {
    assert.equal(resolveGithubRepo(""), "");
  });

  test("blank env is ignored, falls back to default", () => {
    process.env.HYDRA_GITHUB_REPO = "   ";
    assert.equal(resolveGithubRepo(), DEFAULT_GITHUB_REPO);
  });
});

// ---------------------------------------------------------------------------
// PURE — row parsers
// ---------------------------------------------------------------------------

describe("parseIssueRows", () => {
  test("maps the canonical fields and flattens labels", () => {
    const rows = parseIssueRows(
      [
        {
          number: 42,
          title: "T",
          url: "https://example/42",
          createdAt: "2026-06-01T00:00:00Z",
          labels: [{ name: "dev_orch" }, { name: "blocked" }],
          body: "hi",
          state: "open",
        },
      ],
      "acme/widgets",
    );
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].labels, ["dev_orch", "blocked"]);
    assert.equal(rows[0].state, "OPEN");
    assert.equal(rows[0].body, "hi");
  });

  test("drops rows without a positive integer number; synthesizes url fallback", () => {
    const rows = parseIssueRows(
      [{ number: 0 }, { number: -1 }, { number: 7 }],
      "acme/widgets",
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].number, 7);
    assert.equal(rows[0].url, "https://github.com/acme/widgets/issues/7");
    assert.equal(rows[0].title, "Issue #7");
  });

  test("non-array input → []", () => {
    assert.deepEqual(parseIssueRows(null, "x/y"), []);
    assert.deepEqual(parseIssueRows({ number: 1 }, "x/y"), []);
  });
});

describe("parsePrRows", () => {
  test("normalizes the status-check rollup and synthesizes a pull URL", () => {
    const rows = parsePrRows(
      [
        {
          number: 5,
          title: "PR",
          updatedAt: "2026-06-01T00:00:00Z",
          statusCheckRollup: [
            { conclusion: "FAILURE", name: "ci" },
            "garbage",
            { context: "legacy-status" },
          ],
        },
      ],
      "acme/widgets",
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].url, "https://github.com/acme/widgets/pull/5");
    assert.equal(rows[0].statusCheckRollup.length, 2);
    assert.equal(rows[0].statusCheckRollup[0].conclusion, "FAILURE");
    assert.equal(rows[0].statusCheckRollup[1].context, "legacy-status");
  });
});

// ---------------------------------------------------------------------------
// PURE — REST -> --json view normalization (issue #968)
// ---------------------------------------------------------------------------

describe("normalizePrViewFromRest", () => {
  test("projects only the requested inline fields, snake_case -> camelCase", () => {
    const out = normalizePrViewFromRest(
      {
        number: 99,
        title: "Fix it",
        html_url: "https://github.com/acme/widgets/pull/99",
        merged_at: "2026-06-01T00:00:00Z",
        body: "ignored — not requested",
      },
      "number,title,url,mergedAt",
    );
    assert.deepEqual(out, {
      number: 99,
      title: "Fix it",
      url: "https://github.com/acme/widgets/pull/99",
      mergedAt: "2026-06-01T00:00:00Z",
    });
  });

  test("flattens REST labels to the [{name}] shape recent-merges expects", () => {
    const out = normalizePrViewFromRest(
      { labels: [{ name: "dev_orch", color: "abc" }, { name: "tier:3" }, "garbage"] },
      "labels",
    );
    assert.deepEqual(out.labels, [{ name: "dev_orch" }, { name: "tier:3" }]);
  });

  test("maps merged_by + a Bot type into the {login,is_bot} actor shape", () => {
    const out = normalizePrViewFromRest(
      { merged_by: { login: "github-actions[bot]", type: "Bot" } },
      "mergedBy",
    );
    assert.deepEqual(out.mergedBy, { login: "github-actions[bot]", is_bot: true });
  });

  test("a human merger has no is_bot flag (classifyAutonomy keys off login suffix)", () => {
    const out = normalizePrViewFromRest(
      { merged_by: { login: "alice", type: "User" } },
      "mergedBy",
    );
    assert.deepEqual(out.mergedBy, { login: "alice" });
  });

  test("reviews/commits come from sub-results, normalized to author actors", () => {
    const out = normalizePrViewFromRest(
      {},
      "reviews,commits",
      {
        reviews: [{ user: { login: "alice", type: "User" } }],
        commits: [{ author: { login: "github-actions[bot]", type: "Bot" } }],
      },
    );
    assert.deepEqual(out.reviews, [{ author: { login: "alice" } }]);
    assert.deepEqual(out.commits, [{ author: { login: "github-actions[bot]", is_bot: true } }]);
  });

  test("missing sub-results degrade to empty arrays, never throw", () => {
    const out = normalizePrViewFromRest({}, "reviews,commits");
    assert.deepEqual(out.reviews, []);
    assert.deepEqual(out.commits, []);
  });
});

// ---------------------------------------------------------------------------
// WIRED — readers through a fake gh binary
// ---------------------------------------------------------------------------

describe("GitHub Issue/PR Read seam — wired readers", () => {
  let workDir: string;
  let fakeBinPath: string;
  let invocationsPath: string;
  let originalGhBin: string | undefined;

  async function writeFakeBin(path: string, log: string) {
    const body = `#!/usr/bin/env bash
set -u
SCENARIO=\${FAKE_SCENARIO:-issues}
printf '%s\\n' "$(printf '%s ' "$@")" >> "${log}"
# REST transport: 'gh api repos/<repo>/pulls/<n>[/reviews|/commits]'
if [ "\${1:-}" = "api" ]; then
  case "\${2:-}" in
    */reviews) echo '[{"user":{"login":"alice","type":"User"}}]'; exit 0 ;;
    */commits) echo '[{"author":{"login":"github-actions[bot]","type":"Bot"}}]'; exit 0 ;;
    *)
      if [ "\${FAKE_API_FAIL:-}" = "1" ]; then echo "boom" >&2; exit 1; fi
      echo '{"number":33,"title":"R","html_url":"https://x/pull/33","merged_at":"2026-06-01T00:00:00Z","labels":[{"name":"qa"}],"merged_by":{"login":"github-actions[bot]","type":"Bot"}}'
      exit 0 ;;
  esac
fi
case "$SCENARIO" in
  issues) echo '[{"number":11,"title":"A","labels":[{"name":"dev_orch"}],"state":"open"}]'; exit 0 ;;
  prs)    echo '[{"number":22,"title":"P","statusCheckRollup":[{"conclusion":"FAILURE","name":"ci"}]}]'; exit 0 ;;
  one)    echo '{"number":33,"labels":[{"name":"qa"}]}'; exit 0 ;;
  empty)  exit 0 ;;
  fail)   echo "boom" >&2; exit 1 ;;
  *)      echo '[]'; exit 0 ;;
esac
`;
    await writeFile(path, body, "utf-8");
    await chmod(path, 0o755);
  }

  async function readInvocations(): Promise<string[]> {
    if (!existsSync(invocationsPath)) return [];
    const raw = await readFile(invocationsPath, "utf-8");
    return raw.split("\n").filter((l) => l.trim().length > 0);
  }

  before(async () => {
    workDir = await mkdtemp(join(tmpdir(), "hydra-gh-issues-"));
    fakeBinPath = join(workDir, "fake-gh");
    invocationsPath = join(workDir, "invocations.log");
    await writeFakeBin(fakeBinPath, invocationsPath);
    originalGhBin = process.env.HYDRA_GH_BIN;
    process.env.HYDRA_GH_BIN = fakeBinPath;
  });

  beforeEach(async () => {
    await writeFile(invocationsPath, "", "utf-8");
    delete process.env.FAKE_SCENARIO;
    delete process.env.FAKE_API_FAIL;
    _clearViewPrCache();
  });

  after(async () => {
    if (originalGhBin === undefined) delete process.env.HYDRA_GH_BIN;
    else process.env.HYDRA_GH_BIN = originalGhBin;
    delete process.env.FAKE_SCENARIO;
    await rm(workDir, { recursive: true, force: true });
  });

  test("listIssuesByLabel builds the expected argv and parses rows", async () => {
    process.env.FAKE_SCENARIO = "issues";
    const res = await listIssuesByLabel("blocked", { repo: "acme/widgets" });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.rows.length, 1);
      assert.equal(res.rows[0].number, 11);
      assert.deepEqual(res.rows[0].labels, ["dev_orch"]);
    }
    const inv = await readInvocations();
    const line = inv.find((l) => l.startsWith("issue list "));
    assert.ok(line, "expected an `issue list` invocation");
    assert.match(line!, /--repo acme\/widgets/);
    assert.match(line!, /--label blocked/);
    assert.match(line!, /--state open/);
    assert.match(line!, /--json number,title,url,createdAt,labels,body,state/);
  });

  test("listIssuesBySearch injects --search and optional --label", async () => {
    process.env.FAKE_SCENARIO = "issues";
    await listIssuesBySearch("created:>=2026-06-01", {
      label: "meta-friction",
      state: "all",
    });
    const inv = await readInvocations();
    const line = inv.find((l) => l.startsWith("issue list "));
    assert.match(line!, /--search created:>=2026-06-01/);
    assert.match(line!, /--label meta-friction/);
    assert.match(line!, /--state all/);
  });

  test("listOpenPrs parses the status rollup", async () => {
    process.env.FAKE_SCENARIO = "prs";
    const res = await listOpenPrs();
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.rows[0].number, 22);
      assert.equal(res.rows[0].statusCheckRollup[0].conclusion, "FAILURE");
    }
  });

  test("viewPr defaults to the REST transport (gh api), not GraphQL pr view (issue #968)", async () => {
    const view = await viewPr<{
      number: number;
      title: string;
      url: string;
      mergedAt: string;
      labels: Array<{ name: string }>;
    }>(33, "number,title,url,mergedAt,labels");
    assert.ok(view);
    assert.equal(view!.number, 33);
    assert.equal(view!.url, "https://x/pull/33");
    assert.deepEqual(view!.labels, [{ name: "qa" }]);
    const inv = await readInvocations();
    assert.ok(
      inv.some((l) => l.startsWith("api repos/")),
      "expected a REST `gh api` invocation",
    );
    assert.ok(
      !inv.some((l) => l.startsWith("pr view")),
      "must NOT use the GraphQL `gh pr view` transport by default",
    );
  });

  test("viewPr fans out REST sub-calls only for reviews/commits", async () => {
    const view = await viewPr<{
      mergedBy: { login: string; is_bot?: boolean };
      reviews: Array<{ author: { login: string } }>;
      commits: Array<{ author: { login: string; is_bot?: boolean } }>;
    }>(33, "mergedBy,reviews,commits");
    assert.ok(view);
    assert.deepEqual(view!.mergedBy, { login: "github-actions[bot]", is_bot: true });
    assert.deepEqual(view!.reviews, [{ author: { login: "alice" } }]);
    assert.deepEqual(view!.commits, [
      { author: { login: "github-actions[bot]", is_bot: true } },
    ]);
    const inv = await readInvocations();
    assert.ok(inv.some((l) => l.includes("/reviews")), "expected a reviews sub-call");
    assert.ok(inv.some((l) => l.includes("/commits")), "expected a commits sub-call");
  });

  test("viewPr transport:'graphql' opts back into the legacy gh pr view path", async () => {
    process.env.FAKE_SCENARIO = "one";
    const view = await viewPr<{ number: number }>(33, "number,labels", {
      transport: "graphql",
    });
    assert.ok(view);
    assert.equal(view!.number, 33);
    const inv = await readInvocations();
    assert.ok(inv.some((l) => l.startsWith("pr view 33")), "expected `gh pr view`");
    assert.ok(!inv.some((l) => l.startsWith("api ")), "must not hit REST");
  });

  test("viewPr caches a successful read — a second call does not re-spawn gh", async () => {
    const first = await viewPr<{ number: number }>(33, "number,title");
    assert.ok(first);
    await writeFile(invocationsPath, "", "utf-8"); // reset the spawn log
    const second = await viewPr<{ number: number }>(33, "number,title");
    assert.ok(second);
    assert.equal(second!.number, 33);
    const inv = await readInvocations();
    assert.equal(inv.length, 0, "second call should be served from cache");
  });

  test("viewPr does NOT cache a null (transient failure must not pin)", async () => {
    process.env.FAKE_API_FAIL = "1";
    const miss = await viewPr(33, "number");
    assert.equal(miss, null);
    delete process.env.FAKE_API_FAIL;
    const hit = await viewPr<{ number: number }>(33, "number");
    assert.ok(hit, "a later success must not be shadowed by a cached null");
  });

  test("a gh failure maps to the never-throw failure arm with a code", async () => {
    process.env.FAKE_SCENARIO = "fail";
    const res = await listIssuesByLabel("blocked");
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.code, /^gh-/);
  });

  test("viewPr returns null on failure (no throw)", async () => {
    process.env.FAKE_API_FAIL = "1";
    const view = await viewPr(1, "number");
    assert.equal(view, null);
  });

  test("*OrEmpty wrapper degrades a failure to [] (Promise.allSettled contract)", async () => {
    process.env.FAKE_SCENARIO = "fail";
    const rows = await listIssuesByLabelOrEmpty("blocked", "test");
    assert.deepEqual(rows, []);
  });

  test("empty-string repo short-circuits without spawning gh", async () => {
    const res = await listIssuesByLabel("blocked", { repo: "" });
    assert.equal(res.ok, true);
    if (res.ok) assert.deepEqual(res.rows, []);
    const inv = await readInvocations();
    assert.equal(inv.length, 0, "should not have shelled out");
  });
});
