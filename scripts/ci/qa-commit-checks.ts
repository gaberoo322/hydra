/**
 * scripts/ci/qa-commit-checks.ts — deterministic re-verify checks for the
 * hydra-qa step 9.4 reviewer commit (issue #5267). Run from the QA session's
 * master-based tree, never from the PR tree (the PR is data, not code).
 *
 *   node --experimental-strip-types scripts/ci/qa-commit-checks.ts body-scope-check <orig-file> <new-file>
 *   <unified-diff -U0 of ONE file> | node --experimental-strip-types scripts/ci/qa-commit-checks.ts row-hunk-check <line>
 *
 * Exit 0 = ok, 1 = check failed (fail closed), 2 = usage.
 */

import { readFileSync } from "node:fs";
import { checkBodyScopeEdit, diffHasHunkNearLine } from "../../src/qa/round-action.ts";

const [cmd, a, b] = process.argv.slice(2);
if (cmd === "body-scope-check" && a && b) {
  const res = checkBodyScopeEdit(readFileSync(a, "utf8"), readFileSync(b, "utf8"));
  console.log(JSON.stringify(res));
  process.exit(res.ok ? 0 : 1);
} else if (cmd === "row-hunk-check" && a) {
  const ok = diffHasHunkNearLine(readFileSync(0, "utf8"), Number(a));
  process.exit(ok ? 0 : 1);
} else {
  console.error("usage: qa-commit-checks.ts body-scope-check <orig> <new> | row-hunk-check <line> < diff");
  process.exit(2);
}
