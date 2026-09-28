/**
 * Unit tests for the design-concept reconciliation gate's standalone CI
 * adapter (issue #4132).
 *
 * The adapter moved out of the required `test` job — where a lint on the PR
 * DESCRIPTION cost a full ~11-minute suite run to report itself, and where it
 * caused 12 of 19 red `test` jobs across a 60-run sample. Its rules did not
 * change; only its home did. These tests pin the fail-OPEN skip ladder and the
 * one fail-CLOSED path, with every I/O edge injected, so the contract is
 * verifiable without GITHUB_EVENT_PATH or a live orchestrator.
 *
 * The load-bearing property: every ENVIRONMENTAL uncertainty exits 0. Only a
 * resolved, APPROVED artifact whose invariants the PR body fails to reconcile
 * exits non-zero. An orchestrator outage must never redden the merge gate —
 * that is state outside the PR's own diff.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  runReconcileCheck,
  runLocalReconcileCheck,
  parseLocalArgs,
  makeRepoFileReader,
  type RunDeps,
} from "../scripts/ci/design-concept-reconcile-run.ts";

const HASH = "826e0adbf7dab6b1cbe8403a16ecdceaf19cbf6c";
const INVARIANT = "INV-1 The gate MUST only bind an approved artifact to a PR.";

/** A PR body that closes #7 and reconciles INV-1 verbatim against the hash. */
const GOOD_BODY = [
  "Closes #7",
  "",
  "## Design-concept reconciliation",
  "",
  `Artifact: ${HASH}`,
  "",
  `- INV-1: "${INVARIANT.replace(/^INV-1 /, "")}" — verified by: manual review`,
].join("\n");

/** Same anchor, no reconciliation section at all. */
const BAD_BODY = "Closes #7\n\n## Summary\nno reconciliation section here";

function deps(over: Partial<RunDeps> & { prBody?: string; artifact?: any; status?: number }): RunDeps {
  return {
    readEventPayload: () =>
      JSON.stringify({ pull_request: { body: over.prBody ?? GOOD_BODY } }),
    fetchArtifact: async () => ({
      status: over.status ?? 200,
      body: over.artifact ?? { status: "approved", invariants: [INVARIANT], artifactHash: HASH },
    }),
    readFile: () => null,
    ...over,
  };
}

describe("design-concept-reconcile-run — fail-open skip ladder (#4132)", () => {
  test("no readable GITHUB_EVENT_PATH skips (the local-run case)", async () => {
    const r = await runReconcileCheck(deps({ readEventPayload: () => null }));
    assert.equal(r.outcome, "skip");
  });

  test("an unparseable payload skips rather than throwing", async () => {
    const r = await runReconcileCheck(deps({ readEventPayload: () => "{not json" }));
    assert.equal(r.outcome, "skip");
    assert.match(r.outcome === "skip" ? r.why : "", /unreadable GITHUB_EVENT_PATH/);
  });

  test("a payload with no pull_request skips (push/schedule run)", async () => {
    const r = await runReconcileCheck(
      deps({ readEventPayload: () => JSON.stringify({ ref: "refs/heads/master" }) }),
    );
    assert.equal(r.outcome, "skip");
    assert.match(r.outcome === "skip" ? r.why : "", /no pull_request/);
  });

  test("a PR body with no Closes/Fixes/Resolves ref skips (not a dev PR)", async () => {
    const r = await runReconcileCheck(deps({ prBody: "## Summary\njust a chore" }));
    assert.equal(r.outcome, "skip");
    assert.match(r.outcome === "skip" ? r.why : "", /no Closes\/Fixes\/Resolves/);
  });

  test("a 404 artifact skips — most PRs have no design concept", async () => {
    const r = await runReconcileCheck(deps({ status: 404, artifact: null }));
    assert.equal(r.outcome, "skip");
    assert.match(r.outcome === "skip" ? r.why : "", /no design-concept artifact/);
  });

  test("a non-OK status skips rather than binding on an unknown body", async () => {
    const r = await runReconcileCheck(deps({ status: 500, artifact: null }));
    assert.equal(r.outcome, "skip");
    assert.match(r.outcome === "skip" ? r.why : "", /HTTP 500/);
  });

  test("an unreachable orchestrator skips — an outage must NOT redden the merge gate", async () => {
    const r = await runReconcileCheck(
      deps({
        fetchArtifact: async () => {
          throw new Error("connect ECONNREFUSED 127.0.0.1:4000");
        },
      }),
    );
    assert.equal(r.outcome, "skip");
    assert.match(r.outcome === "skip" ? r.why : "", /ECONNREFUSED/);
  });

  test("a DRAFT artifact does not bind, even carrying real invariants + a hash (#3849)", async () => {
    const r = await runReconcileCheck(
      deps({
        prBody: BAD_BODY,
        artifact: { status: "draft", invariants: [INVARIANT], artifactHash: HASH },
      }),
    );
    assert.equal(r.outcome, "skip");
    assert.match(r.outcome === "skip" ? r.why : "", /not approved/);
  });

  test("an artifact with no invariants or no hash does not bind", async () => {
    const noInv = await runReconcileCheck(
      deps({ prBody: BAD_BODY, artifact: { status: "approved", invariants: [], artifactHash: HASH } }),
    );
    assert.equal(noInv.outcome, "skip");
    const noHash = await runReconcileCheck(
      deps({
        prBody: BAD_BODY,
        artifact: { status: "approved", invariants: [INVARIANT], artifactHash: "" },
      }),
    );
    assert.equal(noHash.outcome, "skip");
  });
});

describe("design-concept-reconcile-run — fail-closed path (#4132)", () => {
  test("an APPROVED artifact whose invariants the body omits is a violation", async () => {
    const r = await runReconcileCheck(deps({ prBody: BAD_BODY }));
    assert.equal(r.outcome, "violation");
    assert.equal(r.outcome === "violation" ? r.anchorRef : 0, 7);
  });

  test("the violation message names the push-a-commit remedy, not a re-run", async () => {
    const r = await runReconcileCheck(deps({ prBody: BAD_BODY }));
    // A GitHub re-run replays the ORIGINAL webhook payload, so an edited body
    // alone cannot clear this gate — the message must not imply otherwise.
    assert.match(r.outcome === "violation" ? r.message : "", /PUSH A COMMIT/);
  });

  test("a stale artifact hash in the body is a violation, not a skip", async () => {
    const staleBody = GOOD_BODY.replace(HASH, "0000000000000000000000000000000000000000");
    const r = await runReconcileCheck(deps({ prBody: staleBody }));
    assert.equal(r.outcome, "violation");
  });
});

describe("design-concept-reconcile-run — repo file reader traversal guard (#4132)", () => {
  test("rejects traversal and absolute paths, returning null rather than reading", () => {
    const read = makeRepoFileReader();
    assert.equal(read("../../../etc/passwd"), null);
    assert.equal(read("/etc/passwd"), null);
  });

  test("returns null for a missing in-repo path instead of throwing", () => {
    const read = makeRepoFileReader();
    assert.equal(read("definitely/not/a/real/file.txt"), null);
  });

  test("reads a real repo-relative file", () => {
    const read = makeRepoFileReader();
    const pkg = read("package.json");
    assert.ok(pkg && pkg.includes("hydra-orchestrator"));
  });
});

describe("design-concept-reconcile-run — local pre-PR dry-run mode (#4731)", () => {
  const localDeps = (artifact?: any, status = 200) => ({
    fetchArtifact: async () => ({
      status,
      body: artifact ?? { status: "approved", invariants: [INVARIANT], artifactHash: HASH },
    }),
    readFile: () => null,
  });

  test("no flags selects CI mode, so the workflow invocation is unchanged", () => {
    assert.deepEqual(parseLocalArgs([]), { kind: "ci" });
  });

  test("parses --body-file and --anchor in both N and issue-N spellings", () => {
    assert.deepEqual(parseLocalArgs(["--body-file", "/tmp/b.md", "--anchor", "issue-4731"]), {
      kind: "local",
      bodyFile: "/tmp/b.md",
      anchorRef: 4731,
    });
    assert.deepEqual(parseLocalArgs(["--body-file=/tmp/b.md", "--anchor=7"]), {
      kind: "local",
      bodyFile: "/tmp/b.md",
      anchorRef: 7,
    });
    assert.deepEqual(parseLocalArgs(["--body-file", "/tmp/b.md"]), {
      kind: "local",
      bodyFile: "/tmp/b.md",
      anchorRef: null,
    });
  });

  test("rejects a missing --body-file, a malformed anchor, and unknown flags", () => {
    assert.equal(parseLocalArgs(["--anchor", "7"]).kind, "error");
    assert.equal(parseLocalArgs(["--body-file", "b.md", "--anchor", "seven"]).kind, "error");
    assert.equal(parseLocalArgs(["--body-file"]).kind, "error");
    assert.equal(parseLocalArgs(["--bodyfile", "b.md"]).kind, "error");
  });

  /** A body that genuinely reconciles: verbatim quote + a grammar-valid assertion. */
  const RECONCILED_BODY = [
    "Closes #7",
    "",
    "## Design-concept reconciliation",
    "",
    `Artifact: \`${HASH}\``,
    "",
    `- INV-1: "${INVARIANT}" — verified by: \`manual: reviewed the binding path\``,
  ].join("\n");

  test("a reconciled body passes the dry-run exactly as it would in CI", async () => {
    const r = await runLocalReconcileCheck({ prBody: RECONCILED_BODY, anchorRef: 7 }, localDeps());
    assert.equal(r.outcome, "pass", r.outcome === "violation" ? r.message : "");
    const ci = await runReconcileCheck(deps({ prBody: RECONCILED_BODY }));
    assert.equal(ci.outcome, "pass");
  });

  test("a body missing the section is the SAME violation CI reports", async () => {
    const local = await runLocalReconcileCheck({ prBody: BAD_BODY, anchorRef: 7 }, localDeps());
    const ci = await runReconcileCheck(deps({ prBody: BAD_BODY }));
    assert.equal(local.outcome, "violation");
    assert.deepEqual(local, ci);
  });

  test("a paraphrased invariant quote is a violation in the dry-run", async () => {
    const paraphrased = RECONCILED_BODY.replace("MUST only bind", "should only attach");
    const r = await runLocalReconcileCheck({ prBody: paraphrased, anchorRef: 7 }, localDeps());
    assert.equal(r.outcome, "violation");
  });

  test("a body whose Closes ref does not match --anchor is a violation", async () => {
    const r = await runLocalReconcileCheck({ prBody: RECONCILED_BODY, anchorRef: 8 }, localDeps());
    assert.equal(r.outcome, "violation");
    assert.match(r.outcome === "violation" ? r.message : "", /expected Closes #8/);
  });

  test("a body with no Closes ref is a violation when --anchor is given", async () => {
    const r = await runLocalReconcileCheck(
      { prBody: "## Summary\nno closes ref", anchorRef: 7 },
      localDeps(),
    );
    assert.equal(r.outcome, "violation");
    assert.match(r.outcome === "violation" ? r.message : "", /no Closes\/Fixes\/Resolves/);
  });

  test("no artifact (404) is a clean skip in the dry-run too", async () => {
    const r = await runLocalReconcileCheck({ prBody: BAD_BODY, anchorRef: 7 }, localDeps(null, 404));
    assert.equal(r.outcome, "skip");
  });
});

describe("design-concept-reconcile-run — hydra-dev child flow documents the pre-PR gate (#4731)", () => {
  test("the child-flow fragment makes the three pre-PR gates mandatory with their exact commands", () => {
    const md = readFileSync(
      join(import.meta.dirname, "..", "docs/operator-playbooks/_fragments/hydra-dev-child-flow.md"),
      "utf-8",
    );
    assert.match(md, /9b\. \*\*MANDATORY — run the pre-PR mechanical gate BEFORE `gh pr create`\*\*/);
    assert.match(md, /## Pre-PR mechanical gate \(issue #4731\)/);
    // Gate 1 — the dry-run reuses THIS script's --body-file mode, not a re-implementation.
    assert.match(md, /npx tsx scripts\/ci\/design-concept-reconcile-run\.ts \\\n\s+--body-file "\$PR_BODY_FILE" --anchor "\$ANCHOR_REF"/);
    // Gate 2 — both ratchet baselines.
    assert.match(md, /node scripts\/test\/suite-count-check\.mjs --update-baseline/);
    assert.match(md, /npx tsx scripts\/ci\/test-subject-map\.ts --update-baseline/);
    // Gate 3 — foreground suite + test typecheck.
    assert.match(md, /^npm test\b/m);
    assert.match(md, /^npm run typecheck:test\b/m);
    assert.match(md, /gh pr create --body-file/);
  });
});
