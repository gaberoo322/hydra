/**
 * turn-snapshot/hydra-http.ts — `TurnSnapshotHydra`, the narrow typed hydra
 * HTTP adapter the Turn Snapshot collectors read the orchestrator service
 * through (ADR-0043 Decision 1: the gh port "plus the hydra HTTP client").
 *
 * ONE typed method per service read a collector needs, mirroring the
 * `TurnSnapshotGithub` port — never a generic `get(path)`. Production rides
 * the `hydra` CLI (`hydra raw GET <path>` = GET `$HYDRA_BASE_URL/api<path>`,
 * default http://localhost:4000), the very call `collect-state.sh` issued, so
 * the read is byte-identical on the wire (Decision 4): the CLI's own
 * non-2xx / HTML-body refusal still turns into a failed read, `HYDRA_BASE_URL`
 * still redirects it, and a fake `hydra` on PATH still stands in for the
 * service under the bash-level tests. A failed call collapses to an EMPTY read
 * (the `2>/dev/null || true` degrade), distinguishable from a parsed body.
 *
 * The service being down is an EXPECTED state here (Decision 2: the autopilot
 * keeps deciding while the data plane is down), so a failed read is data the
 * collector degrades on, never a thrown error.
 */

import { runExec } from "../../github/exec.ts";
import { pyJsonLoads } from "./py-compat.ts";
import type { GhJsonRead } from "./github-port.ts";

/** A service JSON read: parsed, EMPTY (call failed / printed nothing), or unparseable. Same shape as a gh read. */
export type HydraJsonRead = GhJsonRead;

/** The service reads the Turn Snapshot collectors need — one method each. */
export interface TurnSnapshotHydra {
  /** `GET /autopilot/board-state` — the orch board counts + glm_withheld (src/api/autopilot-board.ts). */
  orchBoardState(): Promise<HydraJsonRead>;
}

/** The raw `hydra` invocation the production adapter is built on (injectable for argv tests). */
export type HydraTransport = (args: string[]) => Promise<{ ok: true; stdout: string } | { ok: false; stderr: string }>;

/** Per-call timeout: one local HTTP read; generous so a busy service is not misread as down. */
const HYDRA_TIMEOUT_MS = 30_000;

/**
 * The default transport: the `hydra` CLI on PATH, spawned through the exec
 * seam's `runExec` (the same primitive the gh port's transport rides).
 */
export const hydraCliTransport: HydraTransport = async (args) => {
  const raw = await runExec("hydra", args, { timeout: HYDRA_TIMEOUT_MS });
  if (raw.exitCode === 0 && !raw.timedOut && !raw.spawnErrorCode) return { ok: true, stdout: raw.stdout };
  return { ok: false, stderr: raw.stderr };
};

/** `$(...)` semantics: strip every trailing newline, then parse like Python's `json.load`. */
function serviceRead(stdout: string): HydraJsonRead {
  const text = stdout.replace(/\n+$/, "");
  if (text === "") return { kind: "empty" };
  const parsed = pyJsonLoads(text);
  return "error" in parsed ? { kind: "unparseable", error: parsed.error } : { kind: "ok", data: parsed.value };
}

export interface TurnSnapshotHydraOptions {
  /** Override the transport (tests record argv through this). Defaults to {@link hydraCliTransport}. */
  transport?: HydraTransport;
}

/** The production adapter over the `hydra` CLI. */
export function createTurnSnapshotHydra(opts: TurnSnapshotHydraOptions = {}): TurnSnapshotHydra {
  const run = opts.transport ?? hydraCliTransport;
  return {
    async orchBoardState() {
      const res = await run(["raw", "GET", "/autopilot/board-state"]);
      return res.ok ? serviceRead(res.stdout) : { kind: "empty" };
    },
  };
}
