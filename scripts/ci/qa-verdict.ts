/**
 * scripts/ci/qa-verdict.ts — Pure helpers for the hydra-qa skill's
 * one-pass verdict classifier (issue #405).
 *
 * Background: before #405, the hydra-qa subagent looped waiting on pending
 * required CI checks (e.g. `mutation-test`) before emitting a verdict. This
 * meant a single QA run could span hours, sometimes long enough that the PR
 * auto-merged in the background. The new behaviour: run the code-review pass
 * once, then return one of four verdicts based on (review verdict + CI
 * state):
 *
 *   PASS              — review passed AND all required checks have concluded successfully
 *   FAIL              — review failed (regardless of CI), OR a required check failed/errored
 *   PASS-pending-CI   — review passed BUT some required checks are still queued/running
 *   FAIL-pending-CI   — reserved tier: review passed but a NON-required pending check would
 *                       likely block merge if it later fails. (Currently behaves like
 *                       PASS-pending-CI for the classifier; documented for the operator playbook
 *                       so autopilot can route accordingly.)
 *
 * The autopilot loop polls CI separately and re-dispatches QA (or merges) once
 * the pending state resolves. The subagent itself never blocks waiting on CI.
 *
 * Since issue #5079 (qa-verdict-engine slice 2/4, ADR-0038) the helpers live
 * under src/qa/ — one module per QA phase (change-shape, admission, fanout,
 * fold, prior-round, round-action, verdict-trailer). This file is only the
 * workflow-facing facade: explicit named re-exports (never `export *`) of the
 * names the hydra-qa.md shims, scripts/autopilot/qa-verdict-event.sh, the
 * checks-fetch fragment and .github/workflows/deep-qa-gate.yml (via
 * hasFreshDeepQaPass) import from this path. Shrinks to hasFreshDeepQaPass
 * once #5081 rewires the playbook shims.
 *
 * Since issue #5080 (slice 3/4) this file is also the engine's CLI — one
 * subcommand per phase, JSON in / JSON out, run only under the main guard
 * below (the qa-merge-guard.ts pattern) so importers see zero side effects:
 *
 *   node --experimental-strip-types scripts/ci/qa-verdict.ts <phase> \
 *     [--input <path>|-] [--repo owner/name]
 *
 * phases: checks | admission | fanout | prior-context | fold | trailer |
 * round-action. Input is ONE JSON object from `--input` (stdin by default —
 * never env vars or argv: the PRIOR_BODIES_FILE 128 KiB E2BIG lesson); output
 * is ONE JSON object on stdout; stderr carries logs only. Exit 0 = a result
 * was produced (possibly degraded — see its `degraded[]`), 1 = no result
 * could be produced, 2 = usage / input-schema failure (stderr carries
 * `{code:"schema-validation-failed", issues}`). The production fetcher is
 * `await import()`ed inside the guard so the static graph gains no
 * ioredis/pino edge.
 */

export {
  compareMergeDanger,
  isPromptOnlyChange,
  parseMergeDangerField,
} from "../../src/qa/change-shape.ts";
export { detectOneWayDoor, requiresOneWayDepth } from "../../src/qa/one-way-door.ts";
export {
  buildCheckStates,
  classifyVerdict,
  decideReviewAdmission,
  redRequiredChecks,
  renderCiSummary,
} from "../../src/qa/admission.ts";
export type { RawRollupEntry } from "../../src/qa/admission.ts";
export { decideReviewerFanout } from "../../src/qa/fanout.ts";
export {
  foldReviewFindings,
  renderReviewReport,
  trailerBlockerCounts,
} from "../../src/qa/fold.ts";
export {
  decideReReviewContext,
  priorFindingsSection,
  qaVerdictHistory,
} from "../../src/qa/prior-round.ts";
export {
  DEEP_QA_FAIL_MARKER,
  QA_ESCALATION_LABELS,
  decideDeepQaAction,
  decideQaRoundAction,
  hasFreshDeepQaPass,
  renderDeepQaPassMarker,
  renderQaEscalationSummary,
} from "../../src/qa/round-action.ts";

// temporary bridge — removed when #5081 rewires the playbook shims.
// The trailer grammar now lives in src/qa/verdict-trailer.ts; the hydra-qa.md
// shims still `import('./scripts/ci/qa-verdict.ts')` for these names.
export {
  QA_VERDICT_TRAILER_PREFIX,
  QA_VERDICT_UNKNOWN_SHA,
  QA_VERDICT_ERROR_PREFIX,
  parseQaVerdictTrailers,
  parseQaVerdictTrailer,
  isFailVerdict,
  nextQaVerdictRound,
  qaVerdictShaMatches,
  parseQaVerdictErrors,
  renderQaVerdictErrorLine,
  renderQaVerdictTrailer,
  buildQaVerdictTrailer,
} from "../../src/qa/verdict-trailer.ts";
export type {
  QaSeverity,
  QaVerdictTrailer,
  QaVerdictError,
  FinalVerdict,
} from "../../src/qa/verdict-trailer.ts";

// ---------------------------------------------------------------------------
// CLI (issue #5080) — runs only when this file is the entrypoint.
// ---------------------------------------------------------------------------

const isMain = (() => {
  try {
    return (
      typeof process !== "undefined" &&
      Array.isArray(process.argv) &&
      typeof import.meta.url === "string" &&
      process.argv[1] !== undefined &&
      import.meta.url === `file://${process.argv[1]}`
    );
  } catch {
    /* intentional: import.meta may be unavailable under some loaders; treat as not-main */
    return false;
  }
})();

if (isMain) {
  const code = await (async (): Promise<number> => {
    const { readFileSync } = await import("node:fs");
    const { QA_VERDICT_PHASES, QaVerdictCliSchemas } = await import(
      "../../src/schemas/qa-verdict-cli.ts"
    );
    const argv = process.argv.slice(2);
    const flag = (name: string, fallback: string): string => {
      const idx = argv.indexOf(name);
      return idx === -1 || idx === argv.length - 1 ? fallback : (argv[idx + 1] as string);
    };
    const usage = (issues: unknown[]): number => {
      console.error(JSON.stringify({ code: "schema-validation-failed", issues }));
      return 2;
    };

    const phase = argv[0];
    if (!phase || !(QA_VERDICT_PHASES as readonly string[]).includes(phase)) {
      return usage([
        {
          message: `usage: qa-verdict.ts <${QA_VERDICT_PHASES.join("|")}> [--input <path>|-] [--repo owner/name]`,
        },
      ]);
    }

    let raw: string;
    try {
      const inputPath = flag("--input", "-");
      raw = readFileSync(inputPath === "-" ? 0 : inputPath, "utf8");
    } catch (err) {
      console.error("[qa-verdict] cannot read input:", err);
      return usage([{ message: "cannot read input" }]);
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      console.error("[qa-verdict] input is not valid JSON:", err);
      return usage([{ message: "input is not valid JSON" }]);
    }
    const key = phase as keyof typeof QaVerdictCliSchemas;
    const parsed = QaVerdictCliSchemas[key].safeParse(json);
    if (!parsed.success) return usage(parsed.error.issues);

    try {
      const { createGhQaVerdictFetchers } = await import("../../src/qa/fetchers.ts");
      const { runQaVerdictPhase } = await import("../../src/qa/phases.ts");
      const fetchers = createGhQaVerdictFetchers(flag("--repo", "gaberoo322/hydra"));
      const result = await runQaVerdictPhase(key, parsed.data, fetchers);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return 0;
    } catch (err) {
      console.error(`[qa-verdict] ${phase} failed, no result produced:`, err);
      return 1;
    }
  })();
  // Explicit exit once stdout drains: a lazily opened ioredis handle (the
  // GitHub CLI Adapter's rate-limit side channel) must never hold the process.
  process.stdout.write("", () => process.exit(code));
}
