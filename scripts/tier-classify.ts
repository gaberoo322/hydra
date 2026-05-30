#!/usr/bin/env -S npx tsx
/**
 * CLI wrapper for `classifyChange()` — used by the `tier-gate` CI job.
 *
 * Usage:
 *   tsx scripts/tier-classify.ts <file1> <file2> ...
 *   tsx scripts/tier-classify.ts --operator-approved <file1> ...
 *   gh pr diff --name-only NNN | xargs tsx scripts/tier-classify.ts
 *
 * Output: a single JSON object on stdout with `{tier, reason, files}`.
 *
 * Exit codes:
 *   0 — non-T4 result, or T4 (Verifier Core) with `--operator-approved`
 *   2 — T4 (Verifier Core) without `--operator-approved` (CI must fail)
 *   1 — usage / unexpected error
 *
 * The script never crashes on a deleted file — `gh pr diff --name-only`
 * lists deletions and they're treated as touching the path just like
 * additions. Files don't need to exist on disk.
 *
 * This file itself is in the Verifier Core (see `src/untouchable.ts`) —
 * it classifies as T4, the deepest tier — because bypassing the wrapper
 * bypasses the gate.
 */

import { classifyChange } from "../src/tier-classifier.ts";

function main(): number {
  const argv = process.argv.slice(2);
  let operatorApproved = false;
  const files: string[] = [];

  for (const arg of argv) {
    if (arg === "--operator-approved") {
      operatorApproved = true;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: tier-classify.ts [--operator-approved] <file1> <file2> ...\n" +
        "Reads files from stdin if no positional args provided.\n",
      );
      return 0;
    } else if (arg.startsWith("--")) {
      process.stderr.write(`Unknown flag: ${arg}\n`);
      return 1;
    } else {
      files.push(arg);
    }
  }

  // Allow piping from `gh pr diff --name-only ...`
  if (files.length === 0 && !process.stdin.isTTY) {
    let buf = "";
    try {
      // Synchronous read of all stdin — small inputs (file lists), simple.
      const chunk = require("node:fs").readFileSync(0, "utf-8");
      buf = chunk;
    } catch (err: any) {
      // No stdin — fall through.
    }
    for (const line of buf.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length > 0) files.push(trimmed);
    }
  }

  const result = classifyChange(files);

  const out = {
    tier: result.tier,
    reason: result.reason,
    files,
    operatorApproved,
    perFile: result.perFile || [],
  };
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");

  if (result.tier === 4 && !operatorApproved) {
    process.stderr.write(
      "\n" +
      "============================================================\n" +
      "TIER 4 (Verifier Core) — operator-approved label required\n" +
      "============================================================\n" +
      `${result.reason}\n\n` +
      "This PR touches the Verifier Core (ADR-0001 / ADR-0015). Auto-merge is\n" +
      "blocked. To unblock, the operator must apply the\n" +
      "`operator-approved` label to this PR. The label is operator-only\n" +
      "by convention; merging without it requires admin override.\n" +
      "\n" +
      "If you are the operator and this change is intentional, apply\n" +
      "the label, then re-run this CI job.\n",
    );
    return 2;
  }
  return 0;
}

const code = main();
process.exit(code);
