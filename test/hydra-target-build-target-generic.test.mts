/**
 * Drift guard for issue #4525 — hydra-target-build must stay Target-generic
 * (ADR-0013: generality lives in the swap, not the session).
 *
 * The first successor-Target smoke build found the playbook still carried
 * prior-Target literals: a hardcoded `web/` app subdir, the `test:raw` suite
 * alias, that Target's service names in the post-merge health prose, a
 * `betting-…` friction cue, and a merge flow that fast-forwarded and restarted
 * the serving tree by hand. Every path must derive from the Target Manifest
 * (`verify.appSubdir`, `verify.*`) and the seam
 * (`scripts/target/print-target-facts.ts`); the Target deploys itself through
 * its own CI.
 *
 * This test reads the playbook's EFFECTIVE source — the top-level playbook,
 * every `@include`d fragment, and every `reference_files` sibling — and fails
 * if any of those literals reappear.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLAYBOOK_DIR = join(REPO_ROOT, "docs", "operator-playbooks");
const PLAYBOOK_REL = "hydra-target-build.md";

/** Collect the playbook plus every fragment it includes or references. */
function effectiveSources(): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (rel: string): void => {
    if (out.has(rel)) return;
    const text = readFileSync(join(PLAYBOOK_DIR, rel), "utf-8");
    out.set(rel, text);
    for (const m of text.matchAll(/^@include\s+(\S+)\s*$/gm)) visit(m[1]);
    const refs = text.match(/^reference_files:\s*\[([^\]]*)\]/m);
    if (refs) {
      for (const r of refs[1].split(",").map((x) => x.trim()).filter(Boolean)) visit(r);
    }
  };
  visit(PLAYBOOK_REL);
  return out;
}

/** Prior-Target literals that must never reappear (issue #4525). */
const BANNED: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: "hardcoded `web/` app subdir", re: /(?<![\w$.-])web\//g },
  { label: "`test:raw` suite alias", re: /test:raw/g },
  { label: "prior-Target service name", re: /\b(scanner|ingestion|pinnacle|fairline)\b/gi },
  { label: "`betting-emulated-automerge` cue", re: /betting-emulated-automerge/g },
  { label: "`betting-…` friction cue", re: /\bbetting-[a-z]/g },
];

/** Serving-tree deploy moves the build must never make (issue #4525). */
const FORBIDDEN_DEPLOY: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: "systemctl restart of the Target service", re: /systemctl\s+--user\s+restart/g },
  { label: "fast-forward of a checkout", re: /--ff-only/g },
  { label: "merge/pull run against the serving tree", re: /git -C "\$TARGET_WS" (merge|pull|checkout|reset)/g },
  { label: "cd into the serving tree inside a code block", re: /^\s*cd "\$TARGET_WS"\s*(#.*)?$/gm },
  { label: "push straight to main", re: /git push origin main/g },
];

function hits(text: string, re: RegExp): string[] {
  return [...text.matchAll(new RegExp(re.source, re.flags))].map((m) => m[0]);
}

describe("hydra-target-build stays Target-generic (issue #4525)", () => {
  const sources = effectiveSources();

  test("the effective source includes the merge-flow fragment and the seam preamble", () => {
    assert.ok(sources.has("_fragments/hydra-target-build-merge-flow.md"));
    assert.ok(sources.has("_fragments/target-seam-preamble.md"));
  });

  for (const { label, re } of BANNED) {
    test(`no ${label} in the playbook or its fragments`, () => {
      for (const [rel, text] of sources) {
        assert.deepEqual(hits(text, re), [], `${rel} reintroduced a ${label}`);
      }
    });
  }

  for (const { label, re } of FORBIDDEN_DEPLOY) {
    test(`merge flow never makes a ${label}`, () => {
      for (const [rel, text] of sources) {
        assert.deepEqual(hits(text, re), [], `${rel} reintroduced a ${label}`);
      }
    });
  }

  test("the ban list catches planted violations (guards against a vacuous pass)", () => {
    const planted =
      'grep -rn foo web/src\neval "$TEST_CMD" # npm run test:raw\nscanner: ok -> degraded\n' +
      "cue betting-emulated-automerge-lands\nsystemctl --user restart x\ngit pull --ff-only origin main\n";
    for (const { label, re } of [...BANNED, ...FORBIDDEN_DEPLOY]) {
      if (label.startsWith("merge/pull") || label.startsWith("cd into") || label.startsWith("push straight")) continue;
      assert.ok(hits(planted, re).length > 0, `ban '${label}' failed to catch its planted violation`);
    }
    assert.deepEqual(hits('"$TARGET_WEB_URL/deploy-sha.txt"', BANNED[0].re), [], "the seam's web-URL var is not a `web/` subdir");
  });

  test("the merge flow verifies the Target's own deploy instead of deploying by hand", () => {
    const flow = sources.get("_fragments/hydra-target-build-merge-flow.md") ?? "";
    assert.match(flow, /actions\/runs\?branch=main/, "must locate the main-branch CI run covering the merge");
    assert.match(flow, /tolower\(\$1\) ~ \/deploy\//, "must read the run's deploy job");
    assert.match(flow, /\$TARGET_WEB_URL\/deploy-sha\.txt/, "must compare the optional deployed-SHA marker");
    assert.match(flow, /merge-base --is-ancestor "\$COMMIT_SHA" "\$DEPLOYED_SHA"/, "a later cumulative deploy must count");
    assert.match(flow, /absence is not a failure/, "the marker must be optional");
  });

  test("optional Target docs are read only when present", () => {
    const build = sources.get(PLAYBOOK_REL) ?? "";
    assert.match(build, /if \[ -f "\$DOMAIN_DOC" \]/, "Step 6.5 must guard the Target's domain.md");
    const preamble = sources.get("_fragments/target-seam-preamble.md") ?? "";
    assert.match(preamble, /Each of these is optional/, "the seam preamble must mark the Target's docs optional");
  });
});
