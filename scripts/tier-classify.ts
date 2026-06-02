#!/usr/bin/env -S npx tsx
/**
 * CLI wrapper for `classifyChange()` — used by the `tier-gate` CI job.
 *
 * Usage:
 *   tsx scripts/tier-classify.ts <file1> <file2> ...
 *   gh pr diff --name-only NNN | xargs tsx scripts/tier-classify.ts
 *
 * Output: a single JSON object on stdout with `{tier, reason, files}`.
 *
 * Exit codes:
 *   0 — any valid classification (the gate reports the tier; it no longer
 *       blocks T4 on a label)
 *   1 — usage / unexpected error
 *
 * T4 (Verifier Core) PRs no longer fail this gate for lack of an
 * `operator-approved` label (ADR-0020 Slice 2 / #743): the T4 depth guarantee
 * is now the base-ref `deep-qa-gate` required check (the SHA-bound Deep-QA PASS
 * marker) plus the mutation floor (#778) and base-ref Live-Gate (#738), not a
 * label. `operator-approved` survives only as the #744 operator emergency
 * brake. The `--operator-approved` flag is accepted as a no-op for caller
 * back-compat (live-gate.sh / older invocations).
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
  const files: string[] = [];

  for (const arg of argv) {
    if (arg === "--operator-approved") {
      // Accepted as a no-op for caller back-compat (ADR-0020 Slice 2 / #743):
      // T4 is no longer blocked on the label, so the flag no longer affects
      // the exit code. Kept so older invocations don't trip "Unknown flag".
      continue;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: tier-classify.ts [--operator-approved (no-op)] <file1> <file2> ...\n" +
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
    perFile: result.perFile || [],
  };
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");

  // ADR-0020 Slice 2 (#743): the gate reports the tier but no longer blocks
  // T4 on the operator-approved label. The T4 depth guarantee relocated to
  // the base-ref `deep-qa-gate` required check (SHA-bound Deep-QA PASS marker)
  // + the mutation floor (#778) + base-ref Live-Gate (#738). Any valid
  // classification exits 0.
  return 0;
}

const code = main();
process.exit(code);
