#!/usr/bin/env -S npx tsx
/**
 * blockers-cleared.ts — the one blocker-clearance predicate for autopilot
 * Phase 1.5 (`recover-stale.sh`, issue #4806).
 *
 * Usage: blockers-cleared.ts [--repo owner/name] <ISSUE...>
 *
 * Prints one line per promotable issue: `<issue> <n1>,<n2>,...` (the cleared
 * blocker numbers). READ-ONLY: no label edit, no comment — recover-stale.sh
 * performs every mutation. Exits non-zero on a usage / unexpected failure;
 * the caller treats non-zero OR empty output as "promote nothing".
 */
import { ghJson } from "../../src/github/gh.ts";
import {
  fetchOpenBlockerNumbers,
  findClearedBlockedIssues,
  resolveBlockerRefState,
} from "../../src/github/blockers.ts";
import { hasScopeSection } from "../../src/scope-section.ts";
import { resolveGithubRepo } from "../../src/github/issues.ts";

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  let repoArg: string | undefined;
  const issues: number[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repo") {
      repoArg = argv[++i];
    } else if (/^\d+$/.test(argv[i])) {
      issues.push(Number.parseInt(argv[i], 10));
    } else {
      console.error(`[blockers-cleared] unexpected argument: ${argv[i]}`);
      return 2;
    }
  }
  const repo = resolveGithubRepo(repoArg);

  const verdicts = await findClearedBlockedIssues(issues, {
    readBody: async (n) => {
      const res = await ghJson<{ body?: string }>([
        "issue", "view", String(n), "--repo", repo, "--json", "body",
      ]);
      return res.ok ? (res.data.body ?? "") : null;
    },
    fetchOpen: (ns) => fetchOpenBlockerNumbers(ns, { githubRepo: repo }),
    resolveRef: (n) => resolveBlockerRefState(repo, n),
    hasScope: hasScopeSection,
  });

  for (const v of verdicts) console.log(`${v.issue} ${v.cleared.join(",")}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("[blockers-cleared] fatal:", err);
    process.exit(1);
  },
);
