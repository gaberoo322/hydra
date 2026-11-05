/**
 * scripts/qa/_lib.ts — the shared seam of the hydra-qa plumbing scripts
 * (issue #5269). Three things only: flag parsing, the {@link PlumbingPorts}
 * port (every outward read/write the scripts make) and its production adapter.
 *
 * No verdict rule lives here or in any `scripts/qa/*.ts` file: decisions come
 * from the qa-verdict engine (`src/qa/phases.ts`, reached through
 * `runQaVerdictPhase`), the scripts only fetch facts and perform effects.
 *
 * The production adapter is built with `await import()` inside the entrypoint
 * guard of each script (the `scripts/ci/qa-verdict.ts` pattern), so importing a
 * script from a test adds no ioredis/pino edge to the static graph.
 */

import { runQaVerdictPhase, type QaVerdictFetchers } from "../../src/qa/phases.ts";
import type { QaVerdictPhase } from "../../src/schemas/qa-verdict-cli.ts";

export const DEFAULT_REPO = "gaberoo322/hydra";
export const DEFAULT_API_BASE = "http://localhost:4000";

/** Result of one `gh` / `git` invocation. Never throws. */
export type CmdResult =
  | { ok: true; stdout: string; stderr?: string }
  | { ok: false; stderr: string; stdout?: string };

export interface HttpResult {
  status: number;
  body: string;
}

export interface PlumbingPorts {
  /** `gh <args>` (no leading `gh`). */
  gh(args: string[]): Promise<CmdResult>;
  /** `git <args>` (no leading `git`), run in the process cwd. */
  git(args: string[]): Promise<CmdResult>;
  /** GET against the orchestrator API; null when unreachable. */
  http(path: string): Promise<HttpResult | null>;
  /** The engine's fact fetchers (gh/git in production, fixtures in tests). */
  fetchers: QaVerdictFetchers;
  /** Run one engine phase in-process. */
  phase(phase: QaVerdictPhase, input: unknown): Promise<Record<string, unknown>>;
}

/** Value of `--name <value>`, or undefined. */
export function flagValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 || i === argv.length - 1 ? undefined : (argv[i + 1] as string);
}

export function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(name);
}

/** A bad invocation: exit 2 with the engine's `schema-validation-failed` envelope. */
export class UsageError extends Error {
  readonly code = "schema-validation-failed";
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** Positive integer from `--name`, undefined when absent; throws on a malformed value. */
export function intFlag(argv: readonly string[], name: string): number | undefined {
  const raw = flagValue(argv, name);
  if (raw === undefined) return undefined;
  if (!/^[0-9]+$/.test(raw) || Number(raw) < 1) {
    throw new UsageError(`${name} must be a positive integer (got '${raw}')`);
  }
  return Number(raw);
}

/** Build the in-process phase runner over a fetcher set. */
export function phaseRunner(fetchers: QaVerdictFetchers): PlumbingPorts["phase"] {
  return (phase, input) => runQaVerdictPhase(phase, input, fetchers);
}

/** The production ports: GitHub CLI Adapter + git seam + global fetch. */
export async function createProductionPorts(repo: string, apiBase: string): Promise<PlumbingPorts> {
  const { ghExec } = await import("../../src/github/gh.ts");
  const { gitExec } = await import("../../src/github/git.ts");
  const { createGhQaVerdictFetchers } = await import("../../src/qa/fetchers.ts");
  const fetchers = createGhQaVerdictFetchers(repo);
  const toCmd = (r: { ok: boolean; data?: { stdout: string }; stderr?: string }): CmdResult =>
    r.ok ? { ok: true, stdout: (r.data as { stdout: string }).stdout } : { ok: false, stderr: r.stderr ?? "" };
  return {
    async gh(args) {
      return toCmd(await ghExec(args));
    },
    async git(args) {
      return toCmd(await gitExec(args));
    },
    async http(path) {
      try {
        const res = await fetch(`${apiBase}${path}`, { signal: AbortSignal.timeout(5000) });
        return { status: res.status, body: await res.text() };
      } catch (err) {
        console.error(`[qa-plumbing] GET ${path} unreachable:`, err);
        return null;
      }
    },
    fetchers,
    phase: phaseRunner(fetchers),
  };
}

/** True when the module is the process entrypoint (the qa-verdict.ts guard). */
export function isEntrypoint(metaUrl: string): boolean {
  return (
    typeof process !== "undefined" &&
    Array.isArray(process.argv) &&
    process.argv[1] !== undefined &&
    metaUrl === `file://${process.argv[1]}`
  );
}

/**
 * Run `body` as a CLI: print its JSON result on stdout and exit once stdout
 * drains (a lazily opened ioredis handle must never hold the process).
 * Exit 0 = a result was produced, 1 = none could be, 2 = usage.
 */
export async function runCli(name: string, body: () => Promise<unknown>): Promise<void> {
  let code = 0;
  try {
    const result = await body();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(JSON.stringify({ code: err.code, issues: [{ message: err.message }] }));
      code = 2;
    } else {
      console.error(`[${name}] failed, no result produced:`, err);
      code = 1;
    }
  }
  process.stdout.write("", () => process.exit(code));
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Parse JSON without throwing; undefined for an unparseable payload. */
export function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    /* intentional: callers treat an unparseable payload as an absent fact */
    return undefined;
  }
}
