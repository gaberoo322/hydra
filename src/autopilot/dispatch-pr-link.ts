/**
 * Autopilot **dispatch → PR link** write — the single home for recording the
 * dispatch-to-PR link that the **Builder-Health Scorecard** derives Autonomy
 * Rate + time-to-merge from (issue #732).
 *
 * Extracted from `runs.ts` (issue #3205) so the concept lives in the Builder
 * Health instrumentation domain rather than buried among the run/turn lifecycle
 * writers (`startRun`/`endRun`/`recordTurn`). `recordDispatchPr` is NOT part of
 * the run/turn lifecycle path: its only live caller is `src/api/builder-health.ts`,
 * and its sibling reader `listAutopilotPrLinksSince` is read from
 * `src/aggregators/autonomy-rate.ts`. This sibling module makes the writer + reader
 * a symmetric pair (`dispatch-pr-link.ts` writer / `autonomy-rate.ts` reader), both
 * referenced from `builder-health.ts`, and completes the future clean-up the
 * `run-reads.ts` header already anticipated.
 *
 * It follows the same per-concern sibling-extraction precedent as
 * `cycle-close.ts` (#2768), `run-projections.ts` (#1183), `sweep-reader.ts`
 * (#2568), and `run-reads.ts`: one Module per concern. It imports the Redis
 * Adapter `putAutopilotPrLink` and the shared `errRedis` result-helper from the
 * zero-I/O leaf `run-result.ts` — the same surface the current impl used, no
 * caller logic changes.
 *
 * Errors are returned as result objects, never thrown, matching the
 * `merge/grounding/verification` convention in CLAUDE.md.
 */

import { putAutopilotPrLink } from "../redis/autopilot-runs.ts";
import { errRedis } from "./run-result.ts";
import type { Ok, Err } from "./run-result.ts";

export interface RecordDispatchPrBody {
  prNumber: number;
  runId?: string;
  dispatchId?: string;
  skill?: string;
  issueRef?: string;
  openedAt?: string;
}

export type RecordDispatchPrResult =
  | Ok<{ prNumber: number; openedAtMs: number }>
  | Err;

/**
 * Stamp a dispatch->PR link when a dispatched subagent opens a PR. The
 * Builder-Health Scorecard derives Autonomy Rate + time-to-merge from this
 * link (the open timestamp + PR number) joined against GitHub on read; no
 * per-dispatch intervention flag is stored. Idempotent on `prNumber`.
 */
export async function recordDispatchPr(
  body: RecordDispatchPrBody,
): Promise<RecordDispatchPrResult> {
  try {
    const prNumber = Number(body.prNumber);
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      return { ok: false, code: "invalid", detail: "prNumber must be a positive integer" };
    }
    const openedAtMs = body.openedAt ? Date.parse(body.openedAt) : Date.now();
    const resolvedMs = Number.isFinite(openedAtMs) ? openedAtMs : Date.now();
    const fields: Record<string, string> = {};
    if (body.runId) fields.runId = String(body.runId);
    if (body.dispatchId) fields.dispatchId = String(body.dispatchId);
    if (body.skill) fields.skill = String(body.skill);
    if (body.issueRef) fields.issueRef = String(body.issueRef);
    await putAutopilotPrLink(prNumber, fields, resolvedMs);
    return { ok: true, prNumber, openedAtMs: resolvedMs };
  } catch (err: any) {
    return errRedis(err);
  }
}
