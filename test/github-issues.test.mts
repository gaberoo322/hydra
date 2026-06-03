/**
 * Regression tests for the GitHub Issue/PR Read seam (issue #908).
 *
 * Splits into two halves:
 *   - PURE: repo-handle resolution, the single dispatch-class taxonomy + its two
 *     classifier flavors, and the canonical row parsers — no subprocess.
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
  KNOWN_CLASS_LABELS,
  UNCLASSIFIED,
  classFromLabels,
  classLabelFromLabels,
  parseIssueRows,
  parsePrRows,
  listIssuesByLabel,
  listIssuesBySearch,
  listOpenPrs,
  viewPr,
  listIssuesByLabelOrEmpty,
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
// PURE — one taxonomy, two classifier flavors
// ---------------------------------------------------------------------------

describe("dispatch-class taxonomy", () => {
  test("KNOWN_CLASS_LABELS carries the autopilot classes", () => {
    assert.ok(KNOWN_CLASS_LABELS.includes("dev_orch"));
    assert.ok(KNOWN_CLASS_LABELS.includes("dev_target"));
    assert.ok(KNOWN_CLASS_LABELS.includes("qa"));
    assert.ok(KNOWN_CLASS_LABELS.includes("sweep_target"));
  });

  test("classFromLabels returns the first known class", () => {
    assert.equal(classFromLabels(["ready-for-agent", "dev_orch"]), "dev_orch");
    assert.equal(classFromLabels(["qa", "dev_orch"]), "qa");
  });

  test("classFromLabels returns the unclassified sentinel when none match", () => {
    assert.equal(classFromLabels(["bug", "needs-info"]), UNCLASSIFIED);
    assert.equal(classFromLabels([]), UNCLASSIFIED);
    assert.equal(UNCLASSIFIED, "unclassified");
  });

  test("classLabelFromLabels returns null (not the sentinel) when none match", () => {
    assert.equal(classLabelFromLabels(["bug"]), null);
    assert.equal(classLabelFromLabels(["sweep_target", "tier:2"]), "sweep_target");
  });

  test("both flavors agree on the same taxonomy — no array-vs-Set drift", () => {
    for (const cls of KNOWN_CLASS_LABELS) {
      assert.equal(classFromLabels([cls]), cls);
      assert.equal(classLabelFromLabels([cls]), cls);
    }
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

  test("viewPr returns the raw parsed object", async () => {
    process.env.FAKE_SCENARIO = "one";
    const view = await viewPr<{ number: number; labels: Array<{ name: string }> }>(
      33,
      "number,labels",
    );
    assert.ok(view);
    assert.equal(view!.number, 33);
  });

  test("a gh failure maps to the never-throw failure arm with a code", async () => {
    process.env.FAKE_SCENARIO = "fail";
    const res = await listIssuesByLabel("blocked");
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.code, /^gh-/);
  });

  test("viewPr returns null on failure (no throw)", async () => {
    process.env.FAKE_SCENARIO = "fail";
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
