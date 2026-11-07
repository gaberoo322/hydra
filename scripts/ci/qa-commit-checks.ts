/**
 * scripts/ci/qa-commit-checks.ts — deterministic re-verify checks for the
 * hydra-qa step 9.4 reviewer commit (issue #5267). Run by absolute path from
 * the dedicated master worktree ($MASTER_WT), never from the PR tree (the PR is data, not code).
 *
 *   node --experimental-strip-types scripts/ci/qa-commit-checks.ts body-scope-check <orig-file> <new-file>
 *   node --experimental-strip-types scripts/ci/qa-commit-checks.ts row-loc <location>
 *   <unified-diff -U0 of ONE file> | node --experimental-strip-types scripts/ci/qa-commit-checks.ts row-hunk-check <line>
 *
 * Exit 0 = ok, 1 = check failed (fail closed), 2 = usage.
 */

import { readFileSync } from "node:fs";
import { checkBodyScopeEdit, diffHasHunkNearLine, reviewerCommitLocationRef } from "../../src/qa/round-action.ts";

const [cmd, a, b] = process.argv.slice(2);
if (cmd === "body-scope-check" && a && b) {
  const res = checkBodyScopeEdit(readFileSync(a, "utf8"), readFileSync(b, "utf8"));
  console.log(JSON.stringify(res));
  process.exit(res.ok ? 0 : 1);
} else if (cmd === "row-hunk-check" && a) {
  const ok = diffHasHunkNearLine(readFileSync(0, "utf8"), Number(a));
  process.exit(ok ? 0 : 1);
} else if (cmd === "row-loc" && a !== undefined) {
  // Prints {"file":...,"line":...|null} for a finding location; exit 1 when it names no repo path.
  const ref = reviewerCommitLocationRef(a);
  if (ref) console.log(JSON.stringify({ file: ref.path, line: ref.line }));
  process.exit(ref ? 0 : 1);
} else {
  console.error("usage: qa-commit-checks.ts body-scope-check <orig> <new> | row-hunk-check <line> < diff | row-loc <location>");
  process.exit(2);
}
