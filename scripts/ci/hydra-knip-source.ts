/**
 * scripts/ci/hydra-knip-source.ts — the shared knip-report source loader
 * (issue #4523).
 *
 * WHY THIS EXISTS — `scripts/ci/hydra-cleanup-emit.ts` (the Orchestrator's
 * dead-export sweep) and `scripts/ci/hydra-target-cleanup-emit.ts` (its
 * Target mirror) each hand-declared a private `loadKnipReport()` and wired it
 * into `runEmitShell()` as `spec.loadSource`. The copies drifted: the
 * Orchestrator's checked the report file's age against a staleness window
 * (`KNIP_REPORT_MAX_AGE_MS`, issue #1766 — "a stale report re-files findings
 * already fixed on master") and refused a stale report; the Target's had no
 * such check, so the exact bug class #1766 fixed for the Orchestrator lane
 * stayed silently unfixed for the Target lane. This module is the ONE
 * shared declaration both runners import instead of hand-copying.
 *
 * SEAM PLACEMENT — deliberately neither of the two modules the originating
 * issue proposed. `scripts/ci/hydra-cleanup-render.ts` commits to a purity
 * contract ("no fs / network / process") that this loader's `statSync` +
 * `readFileSync` + `Date.now()` would break. `scripts/ci/hydra-emit-shell.ts`
 * keeps its own OWNERSHIP LINE that the source loader stays script-owned
 * (each report format — knip JSON, ledger markdown — parses differently) and
 * that the shell "touches no filesystem other than the default exists
 * probe". A knip-specific loader inside that generic three-runner shell
 * would violate its own contract and couple the ledger/wire-or-retire
 * runner to knip's report shape. This sibling module — named after the
 * shell's `loadSource` / `EmitSourceResult<TSource>` vocabulary — is the IO
 * adapter that sits between the pure render layer and the generic shell,
 * respecting both existing contracts.
 *
 * The stale-report message is lane-neutral ("Re-fetch the scan base") with
 * the caller supplying its own re-run instruction via `opts.rerunCommand` —
 * the Orchestrator's base is `origin/master` and its knip runs from the repo
 * root; the Target's base is `origin/main` and its knip must run from
 * `$TARGET_WEB`. Hard-coding either lane's instruction into a shared message
 * would print the wrong hint in the other lane.
 */

import { readFileSync, statSync } from "node:fs";
import type { KnipReport } from "./hydra-cleanup-render.ts";
import type { EmitSourceResult } from "./hydra-emit-shell.ts";

/**
 * Open cleanup issues above this age cannot be trusted to reflect the
 * scan base — a knip report older than one scan cadence re-files findings
 * already fixed upstream (issue #1766). Shared by both lanes: they run knip
 * immediately before the emit, in the same pass, on the same 1h cadence.
 */
export const KNIP_REPORT_MAX_AGE_MS = 60 * 60 * 1000;

/** Options for {@link loadKnipReport}. */
export interface LoadKnipReportOptions {
  /** Lane-specific re-run instruction embedded in the stale-report message. */
  rerunCommand: string;
  /** Injectable clock for deterministic tests; defaults to `Date.now()`. */
  nowMs?: number;
}

/**
 * Load + validate a knip report (issue #1766 staleness guard, issue #4523
 * consolidation). Result-shaped so the shared emit shell stays the one
 * fail-closed exit site; never throws.
 *
 * A report older than {@link KNIP_REPORT_MAX_AGE_MS} cannot be trusted to
 * reflect the current scan base — the 2026-06-11 dup wave reproduced a
 * 5-hour-old batch title-for-title, the signature of a stale report feeding
 * the emit. Refuse it loudly (citing #1766, the observed + max age, and the
 * caller's re-run command) rather than filing already-fixed findings. The
 * age check is strict `>` — a report exactly `KNIP_REPORT_MAX_AGE_MS` old is
 * accepted.
 */
export function loadKnipReport(
  path: string,
  opts: LoadKnipReportOptions,
): EmitSourceResult<KnipReport> {
  const now = opts.nowMs ?? Date.now();
  const reportAgeMs = now - statSync(path).mtimeMs;
  if (reportAgeMs > KNIP_REPORT_MAX_AGE_MS) {
    return {
      ok: false,
      error: `knip report at ${path} is ${Math.round(reportAgeMs / 60_000)} min old (max ${KNIP_REPORT_MAX_AGE_MS / 60_000} min, #1766) — a stale report re-files findings already fixed on master. Re-fetch the scan base (playbook Step 1) and re-run ${opts.rerunCommand} first.`,
    };
  }
  try {
    return { ok: true, source: JSON.parse(readFileSync(path, "utf-8")) as KnipReport };
  } catch (err) {
    return {
      ok: false,
      error: `failed to parse ${path} as JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
