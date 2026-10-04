/**
 * github/repo.ts — read-only repo-METADATA seam (issue #4625).
 *
 * Sibling of `labels.ts` / `prs.ts`: one narrow read through the Adapter's
 * `ghJson`. Never throws — `null` means UNKNOWN (a failed or malformed read),
 * which callers must render as UNKNOWN, never as "not archived".
 */

import { logger } from "../logger.ts";
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
    logger.error({ repo, code: res.code }, "[github/repo] archived read failed");
    return null;
  }
  const archived = parseArchived(res.data);
  if (archived === null) logger.error({ repo }, "[github/repo] archived read: payload malformed");
  return archived;
}

/** Pure parser: the payload's boolean `archived` field, else null (UNKNOWN). */
export function parseArchived(data: unknown): boolean | null {
  const archived = (data as { archived?: unknown } | null)?.archived;
  return typeof archived === "boolean" ? archived : null;
}
