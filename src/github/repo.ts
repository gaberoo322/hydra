/**
 * github/repo.ts — read-only repo-METADATA seam (issue #4625).
 *
 * Sibling of `labels.ts` / `prs.ts`: one narrow read through the Adapter's
 * `ghJson`. Never throws — `null` means UNKNOWN (a failed or malformed read),
 * which callers must render as UNKNOWN, never as "not archived".
 */

import { ghJson } from "./gh.ts";
import { isGhFailure } from "./exec.ts";
import { DEFAULT_MAX_BUFFER, DEFAULT_TIMEOUT_MS } from "./issues.ts";

export interface RepoQueryOptions {
  timeout?: number;
  maxBuffer?: number;
}

/**
 * Is `repo` (`owner/name`) archived? Reads `gh api repos/<repo>` and returns
 * the payload's `archived` field. `null` = UNKNOWN (gh failure / bad payload;
 * logged).
 */
export async function getRepoArchivedOrNull(
  repo: string,
  opts: RepoQueryOptions = {},
): Promise<boolean | null> {
  if (!repo) return null;
  const res = await ghJson<unknown>(["api", `repos/${repo}`], {
    timeout: opts.timeout ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
  });
  if (isGhFailure(res)) {
    console.error(`[github/repo] archived read for ${repo} failed (${res.code})`);
    return null;
  }
  const archived = (res.data as { archived?: unknown } | null)?.archived;
  if (typeof archived !== "boolean") {
    console.error(`[github/repo] archived read for ${repo}: payload malformed`);
    return null;
  }
  return archived;
}
