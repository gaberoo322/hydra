/**
 * `qaBounce` — the ONE way a QA FAIL (or a QA defer) leaves `needs-qa` (#5659,
 * parent #5658). The lifecycle seam alone decides where the issue goes, from ONE
 * live PR-state read: `needs-dev-resume` while the PR is OPEN, `ready-for-agent`
 * once it is CLOSED, `pr-merged` for a MERGED PR (reconcile owns that exit).
 *
 * The exit target is derived from the very fetch the `qa-verdict` gate then
 * validates: `advance` runs over a deps view whose `qaLive` read is taken once,
 * so the target and the gate can never disagree about a PR that closes in
 * between (no `qa-verdict-mismatch` race). Callers never name a target.
 *
 * A function, not a CLI verb: the QA route is the only caller. Never throws
 * (STD-VERIFY-NEVER-THROW); every outcome is a result object.
 */
import { logger } from "../logger.ts";
import type { CapCount, CapExitCode } from "./caps.ts";
import { qaBounceTargetOf, type Fetched, type QaLivePr } from "./gates.ts";
import { advance } from "./seam.ts";
import type { SeamDeps } from "./seam-deps.ts";

export interface QaBounceInput {
  issue: number;
  pr: number;
  actor: string;
  /** The trailer-less defer arm (no verdict was emitted): admits only this bounce. */
  defer?: boolean;
}

export type QaBounceResult =
  | { ok: true; to: "needs-dev-resume" | "ready-for-agent" }
  | { ok: false; code: CapExitCode; counts: readonly CapCount[]; /** Whether the cap-exit label write landed. */ written?: boolean }
  | { ok: false; code: string };

export async function qaBounce(input: QaBounceInput, deps: SeamDeps): Promise<QaBounceResult> {
  try {
    const fetchLive = deps.fetch.qaLive;
    if (fetchLive === undefined) return { ok: false, code: "fetch-failed" };
    // The ONE live read: taken here, replayed to the gate by the wrapped dep.
    const live: Fetched<QaLivePr> = await fetchLive(input.pr);
    if (live.ok === false) return { ok: false, code: "fetch-failed" };
    const to = qaBounceTargetOf(live.value.state);
    if (to === null) return { ok: false, code: live.value.state === "MERGED" ? "pr-merged" : "pr-not-open" };

    const once: SeamDeps = { ...deps, fetch: { ...deps.fetch, qaLive: async () => live } };
    const res = await advance(
      {
        issue: input.issue,
        to,
        evidence: { pr: String(input.pr), ...(input.defer === true ? { defer: "1" } : {}) },
        actor: input.actor,
      },
      once,
    );
    if (res.ok === true) return { ok: true, to };
    if ((res.code.startsWith("parked:") || res.code.startsWith("escalated:")) && res.counts !== undefined) {
      return { ok: false, code: res.code as CapExitCode, counts: res.counts, written: res.written };
    }
    return { ok: false, code: res.code };
  } catch (err) {
    logger.error({ err, issue: input.issue }, "[lifecycle] qaBounce crashed");
    return { ok: false, code: "crashed" };
  }
}
