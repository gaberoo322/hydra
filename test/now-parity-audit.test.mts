/**
 * test/now-parity-audit.test.mts — pin endpoint parity between /now
 * and /now-pixel via the audit script.
 *
 * Slice 7 of /now-pixel (#642, #649). The test invokes
 * dashboard/scripts/audit-now-parity.js and asserts a zero exit; if
 * /now-pixel ever drops an endpoint that /now still uses, this test
 * fires and CI blocks the merge.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const script = path.join(repoRoot, "dashboard/scripts/audit-now-parity.js");

test("audit-now-parity: /now-pixel covers every /now endpoint", () => {
  // The script exits 0 on parity, 1 on gap, 2 on internal error. We
  // surface its stdout/stderr verbatim in the assertion failure so a
  // future regression spells out exactly which endpoint disappeared.
  let stdout = "";
  let exitCode = 0;
  try {
    stdout = execFileSync(process.execPath, [script], {
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
    });
  } catch (err: any) {
    exitCode = err.status ?? 1;
    stdout = `${err.stdout ?? ""}\n${err.stderr ?? ""}`;
  }
  assert.equal(
    exitCode,
    0,
    `audit-now-parity reported a gap (exit=${exitCode}):\n${stdout}`,
  );
});
