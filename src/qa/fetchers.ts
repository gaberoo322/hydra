/**
 * src/qa/fetchers.ts — the PRODUCTION `QaVerdictFetchers` adapter (issue
 * #5080, INV-7): built solely from GitHub CLI Adapter accessors (`ghJson`,
 * `listRequiredStatusContextsOrNull`, `gitExec`). No `node:child_process`
 * lives here. The second adapter is the in-process fixture fetcher in tests.
 *
 * Imported DYNAMICALLY by `scripts/ci/qa-verdict.ts` inside its main guard:
 * `src/github/gh.ts` pulls in ioredis + pino, which must never enter the
 * facade's static import graph (deep-qa-gate.yml imports the facade).
 *
 * Every getter returns null on failure and never throws. `gh pr view` reads
 * are memoised per (pr, field-set) so one phase run costs one read per kind.
 */

import { ghJson } from "../github/gh.ts";
import { gitExec } from "../github/git.ts";
import { isGhFailure } from "../github/exec.ts";
import { listRequiredStatusContextsOrNull } from "../github/prs.ts";
import type { RawRollupEntry } from "./admission.ts";
import type { QaAncestryFacts, QaVerdictFetchers } from "./phases.ts";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function createGhQaVerdictFetchers(repo: string): QaVerdictFetchers {
  const prViewCache = new Map<string, Promise<Record<string, unknown> | null>>();

  /** `gh pr view <pr> --json <fields>`, memoised. */
  const prView = (pr: number, fields: string): Promise<Record<string, unknown> | null> => {
    const key = `${pr}:${fields}`;
    let hit = prViewCache.get(key);
    if (!hit) {
      hit = (async () => {
        const res = await ghJson<unknown>(["pr", "view", String(pr), "--repo", repo, "--json", fields]);
        if (isGhFailure(res)) {
          console.error(`[qa-verdict] gh pr view ${pr} --json ${fields} failed (${res.code})`);
          return null;
        }
        if (!isRecord(res.data)) {
          console.error(`[qa-verdict] gh pr view ${pr} --json ${fields}: payload is not an object`);
          return null;
        }
        return res.data;
      })();
      prViewCache.set(key, hit);
    }
    return hit;
  };

  const lines = (stdout: string): string[] =>
    stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

  return {
    async rollup(pr) {
      const v = await prView(pr, "statusCheckRollup");
      if (!v) return null;
      const r = v.statusCheckRollup;
      if (r === null || r === undefined) return [];
      return Array.isArray(r) ? (r as RawRollupEntry[]) : null;
    },

    requiredContexts() {
      return listRequiredStatusContextsOrNull("qa-verdict", { repo });
    },

    async headSha(pr) {
      const v = await prView(pr, "headRefOid,mergeStateStatus");
      return v && typeof v.headRefOid === "string" ? v.headRefOid : null;
    },

    async mergeStateStatus(pr) {
      const v = await prView(pr, "headRefOid,mergeStateStatus");
      return v && typeof v.mergeStateStatus === "string" ? v.mergeStateStatus : null;
    },

    async changedFiles(pr) {
      const res = await ghJson<unknown>(["api", `repos/${repo}/pulls/${pr}/files`, "--paginate"]);
      if (isGhFailure(res)) {
        console.error(`[qa-verdict] changed-files read failed for PR #${pr} (${res.code})`);
        return null;
      }
      if (!Array.isArray(res.data)) return null;
      return res.data
        .map((f) => (isRecord(f) ? f.filename : undefined))
        .filter((n): n is string => typeof n === "string");
    },

    async priorBodies(pr) {
      const v = await prView(pr, "comments,reviews");
      if (!v) return null;
      if (!Array.isArray(v.comments) || !Array.isArray(v.reviews)) return null;
      return [...v.comments, ...v.reviews]
        .map((e) => (isRecord(e) && typeof e.body === "string" ? e.body : ""))
        .filter((b) => b.length > 0);
    },

    async ancestry(priorSha, headSha): Promise<QaAncestryFacts> {
      // `rev-list --count head..prior` is 0 iff prior is reachable from head.
      // gitExec cannot tell exit 1 from exit 128, so the count form (success
      // either way) keeps "not an ancestor" distinct from "unverifiable".
      const count = await gitExec(["rev-list", "--count", `${headSha}..${priorSha}`]);
      const n = isGhFailure(count) ? Number.NaN : Number.parseInt(count.data.stdout.trim(), 10);
      const isAncestor = Number.isNaN(n) ? null : n === 0;
      const diff = await gitExec(["diff", "--name-only", priorSha, headSha]);
      const changedSince = isGhFailure(diff) ? null : lines(diff.data.stdout);
      return { isAncestor, changedSince };
    },
  };
}
