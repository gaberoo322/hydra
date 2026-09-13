/**
 * github/labels.ts — the read-only label-inventory seam sibling (issue #4363).
 *
 * # Why this exists
 *
 * The GLM eligibility sweep's write vocabulary (`glm-eligible`,
 * `glm-ab-control` — `ORCH_BOARD_LABELS`) silently assumed both labels exist
 * on the repo. #4124 shipped a coin flip for the control arm without ever
 * creating `glm-ab-control`, so every control-arm write to `addIssueLabel`
 * failed hourly with `'glm-ab-control' not found` (issue #4363) — and, worse,
 * `recordGlmAbAssignment` runs BEFORE the label write, so each failed tick
 * minted a durable, permanently-unlabelled "orphan" assignment record.
 *
 * This module is the READ-ONLY preflight the sweep now runs once per tick,
 * before it commits to anything: list the repo's actual label inventory and
 * let the caller check its write vocabulary against it, so a missing label
 * pauses the whole tick with one loud, attributable log line instead of
 * quietly minting orphans forever.
 *
 * # Deliberately check-only — no `gh label create` here or anywhere in `src/`
 *
 * (issue #4363's rejectedAlternatives.) The sibling seam `src/github/issues.ts`
 * already commits to "add ONE label to ONE issue, nothing more" — widening a
 * chore's write authority to repo-label-CONFIG mutation would also silently
 * paper over genuine vocabulary drift: a hand-deleted or renamed label would
 * reappear an hour later with a default colour/description instead of
 * surfacing as one visible error. Creating a missing label is a one-shot,
 * operator-visible step taken in the fixing PR's flow (recorded in that PR's
 * body and in `ORCH_BOARD_LABELS.glm_ab_control`'s doc comment), never a
 * runtime behaviour this module performs.
 *
 * # Why its own module, not folded into `issues.ts`
 *
 * `issues.ts` is already ~500 lines, and the repo's precedent for a focused
 * read surface is a sibling module — `prs.ts` for `listOpenPrs`, `view-pr.ts`
 * for `viewPr` (architecture-scan #3370, #2224) — rather than growing the
 * shared file. A separate `labels.ts` also keeps `issues.ts`'s "the ONE narrow
 * label-WRITE surface" claim (`addIssueLabel`) literally true: the read/write
 * asymmetry is obvious to the next reader instead of buried in one big file.
 *
 * # Never throws (CLAUDE.md)
 *
 * Rides the Adapter's `ghJson` and returns the discriminated
 * {@link ListRepoLabelsResult} — `ok:true` carries the flat label-name
 * inventory, `ok:false` carries the seam's machine-readable `gh-*` code.
 * NEVER thrown; the caller (the sweep chore) decides how to report a failure.
 */

import { ghJson } from "./gh.ts";
import { isGhFailure } from "./exec.ts";
import type { GhErrorCode, GhExecOptions, GhResult } from "./exec.ts";
import { resolveGithubRepo, type IssueQueryOptions } from "./issues.ts";

/**
 * Default `--limit` for the label-inventory read (issue #4363 INV-8). `gh
 * label list` defaults to a 30-row page; this repo carries 51 labels today, so
 * a default-limit call would silently omit `glm-*` labels from the inventory
 * and the sweep would read that as "missing", permanently pausing itself — a
 * self-inflicted outage. 500 sits comfortably above any plausible near-term
 * label growth.
 */
export const DEFAULT_LABEL_LIMIT = 500;

/**
 * The transport `listRepoLabels` rides — `ghJson` by default, injectable so
 * tests record the argv and return a canned result without spawning `gh`.
 */
export type LabelListTransport = (
  args: string[],
  opts?: GhExecOptions,
) => Promise<GhResult<Array<{ name?: unknown }>>>;

/** Per-call knobs, reusing the shared {@link IssueQueryOptions} dials. */
export type ListRepoLabelsOptions = Pick<
  IssueQueryOptions,
  "repo" | "timeout" | "maxBuffer"
> & {
  /** `--limit`. Defaults to {@link DEFAULT_LABEL_LIMIT} (issue #4363 INV-8: must stay >= 200). */
  limit?: number;
  /** Read transport. Defaults to the Adapter's {@link ghJson}. */
  transport?: LabelListTransport;
};

/**
 * The discriminated result a label-inventory read returns. `ok:true` carries
 * the flat list of label names on the repo; `ok:false` carries the seam's
 * machine-readable `gh-*` code. NEVER thrown.
 */
export type ListRepoLabelsResult =
  | { ok: true; labels: string[] }
  | { ok: false; code: GhErrorCode };

/**
 * Type guard narrowing a {@link ListRepoLabelsResult} to its failure arm. The
 * orchestrator's `tsconfig.json` runs `strict: false` (no `strictNullChecks`),
 * so a boolean `ok` does not narrow via plain `if (!res.ok)` — see
 * `isIssueReadFailure` (`src/github/issues.ts`) for the full rationale.
 * Prefer this guard over `if (!res.ok)` in consumers.
 */
export function isListRepoLabelsFailure(
  res: ListRepoLabelsResult,
): res is { ok: false; code: GhErrorCode } {
  return res.ok === false;
}

/**
 * List every label name on the repo via `gh label list --repo <repo> --json
 * name --limit <n>` (never `gh label create` — see the module docstring).
 * Never throws.
 */
export async function listRepoLabels(
  opts: ListRepoLabelsOptions = {},
): Promise<ListRepoLabelsResult> {
  const repo = resolveGithubRepo(opts.repo);
  // Mirrors the read seam's empty-repo skip-guard (issues.ts, prs.ts): an
  // empty-string override is an explicit test/operator "skip this call" and
  // never occurs in production, where the repo resolves to the default handle.
  if (!repo) return { ok: true, labels: [] };
  const transport: LabelListTransport = opts.transport ?? (ghJson as unknown as LabelListTransport);
  const res = await transport(
    [
      "label",
      "list",
      "--repo",
      repo,
      "--json",
      "name",
      "--limit",
      String(opts.limit ?? DEFAULT_LABEL_LIMIT),
    ],
    { timeout: opts.timeout, maxBuffer: opts.maxBuffer },
  );
  if (isGhFailure(res)) {
    return { ok: false, code: res.code };
  }
  const labels = Array.isArray(res.data)
    ? res.data
        .filter(
          (row): row is { name: string } =>
            !!row && typeof row === "object" && typeof row.name === "string",
        )
        .map((row) => row.name)
    : [];
  return { ok: true, labels };
}
