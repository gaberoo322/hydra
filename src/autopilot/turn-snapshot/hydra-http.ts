/**
 * turn-snapshot/hydra-http.ts — `TurnSnapshotHydraHttp`, the narrow typed
 * hydra-service HTTP port the Turn Snapshot collectors read through
 * (ADR-0043 Decision 1: "a narrow typed gh port … plus the hydra HTTP
 * client").
 *
 * Same discipline as the `TurnSnapshotGithub` port: ONE typed method per read
 * a collector needs, never a generic `get(path)`; tests hand collectors a
 * fake. Byte-identical on the wire (Decision 4): each method reproduces the
 * read the strangled bash issued — `curl -sf --max-time 3` — so a non-2xx
 * answer, a timeout or a refused connection all collapse to an EMPTY body
 * (the `2>/dev/null || true` degrade), and trailing newlines are stripped
 * (`$(...)`). The autopilot keeps deciding while the data plane is down
 * (Decision 2): a down service is an empty read, never a throw.
 */

/** The service's API root (`hydra raw GET <path>` = GET <root><path>). */
export const DEFAULT_HYDRA_API_BASE = "http://localhost:4000/api";

/** `curl --max-time 3` — the design-concept probe's budget per anchor. */
const DESIGN_CONCEPT_TIMEOUT_MS = 3_000;

export interface TurnSnapshotHydraHttp {
  /**
   * The design-concept artifact body for `issue-<N>`
   * (`GET /design-concepts/issue-<N>`), or `""` when the read failed, timed
   * out or was not 2xx (a 404 = no artifact).
   */
  designConceptBody(issue: number): Promise<string>;
}

export interface TurnSnapshotHydraHttpOptions {
  /** Override `fetch` (tests). Defaults to the global. */
  fetch?: typeof fetch;
  /** Override the API root. Defaults to {@link DEFAULT_HYDRA_API_BASE}. */
  baseUrl?: string;
}

/** The production HTTP port over `fetch`. */
export function createTurnSnapshotHydraHttp(opts: TurnSnapshotHydraHttpOptions = {}): TurnSnapshotHydraHttp {
  const doFetch = opts.fetch ?? fetch;
  const base = opts.baseUrl ?? DEFAULT_HYDRA_API_BASE;

  const getText = async (path: string, timeoutMs: number): Promise<string> => {
    try {
      const res = await doFetch(`${base}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return "";
      return (await res.text()).replace(/\n+$/, "");
    } catch (err) {
      /* intentional: `curl -sf … 2>/dev/null || true` — a down/slow service is an empty read the collector treats as "no artifact" */
      void err;
      return "";
    }
  };

  return {
    designConceptBody: (issue) => getText(`/design-concepts/issue-${issue}`, DESIGN_CONCEPT_TIMEOUT_MS),
  };
}
