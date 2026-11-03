/**
 * scripts/qa/common.ts — shared seams for the hydra-qa plumbing scripts
 * (issue #5269, ADR-0046 Decision 7): the `gh`/`git` runners, the engine phase
 * runner and the argv helpers `preflight.ts`, `packet.ts`, `route.ts` and
 * `poll.ts` have in common.
 *
 * No verdict rule lives here or in any sibling script: every decision is
 * reached through the qa-verdict engine (`runQaVerdictPhase`,
 * `src/qa/phases.ts`), in-process, over the injected fetch port. The only
 * runtime import is node stdlib + the pure engine; the production fetch
 * adapter (ioredis/pino edge) is `await import()`ed by {@link productionPhaseRunner}.
 */

import { spawnSync } from "node:child_process";

export const DEFAULT_REPO = "gaberoo322/hydra";

export interface CmdResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command to completion. Never throws: a spawn error is `ok:false`. */
export type CmdRunner = (args: string[], stdin?: string) => CmdResult;

function spawnRunner(bin: string): CmdRunner {
  return (args, stdin) => {
    const r = spawnSync(bin, args, {
      encoding: "utf8",
      input: stdin,
      maxBuffer: 256 * 1024 * 1024,
    });
    if (r.error) {
      console.error(`[qa-plumbing] ${bin} ${args.slice(0, 3).join(" ")} could not run:`, r.error);
      return { ok: false, code: r.status ?? 127, stdout: r.stdout ?? "", stderr: String(r.error) };
    }
    return { ok: r.status === 0, code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
}

export const defaultGh: CmdRunner = spawnRunner("gh");
export const defaultGit: CmdRunner = spawnRunner("git");

/** GET a URL; null only on a transport failure (any HTTP status is returned). Never throws. */
export type HttpGet = (url: string) => Promise<{ status: number; body: string } | null>;

export const defaultHttpGet: HttpGet = async (url) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return { status: res.status, body: await res.text() };
  } catch (err) {
    console.error(`[qa-plumbing] GET ${url} failed:`, err);
    return null;
  }
};

/**
 * One engine phase, in-process. Returns null when the phase throws (a
 * pre-verdict condition the caller decides on) — the throw is logged here.
 */
export type PhaseRunner = (phase: PhaseName, input: unknown) => Promise<Record<string, unknown> | null>;
export type PhaseName =
  | "checks"
  | "admission"
  | "fanout"
  | "prior-context"
  | "fold"
  | "trailer"
  | "round-action";

/** Wrap a `runQaVerdictPhase` over a fetch port as a {@link PhaseRunner}. */
export function phaseRunnerFor(
  run: (phase: PhaseName, input: unknown) => Promise<Record<string, unknown>>,
): PhaseRunner {
  return async (phase, input) => {
    try {
      return await run(phase, input);
    } catch (err) {
      console.error(`[qa-plumbing] engine phase ${phase} failed, no result:`, err);
      return null;
    }
  };
}

/** The production runner: gh/git-backed fetchers, imported lazily (ioredis edge). */
export async function productionPhaseRunner(repo: string): Promise<PhaseRunner> {
  const { createGhQaVerdictFetchers } = await import("../../src/qa/fetchers.ts");
  const { runQaVerdictPhase } = await import("../../src/qa/phases.ts");
  const fetchers = createGhQaVerdictFetchers(repo);
  return phaseRunnerFor((phase, input) => runQaVerdictPhase(phase, input, fetchers));
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `--name value` lookup; `fallback` when absent or valueless. */
export function flagValue(argv: readonly string[], name: string, fallback?: string): string | undefined {
  const idx = argv.indexOf(name);
  return idx === -1 || idx === argv.length - 1 ? fallback : (argv[idx + 1] as string);
}

export const hasFlag = (argv: readonly string[], name: string): boolean => argv.includes(name);

/** Positive integer flag, or undefined. */
export function intFlag(argv: readonly string[], name: string): number | undefined {
  const v = flagValue(argv, name);
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) && n > 0 && String(n) === v.trim() ? n : undefined;
}

export class UsageError extends Error {
  readonly code = "usage";
}

/** True when `metaUrl` is the process entrypoint (the qa-merge-guard.ts pattern). */
export function isEntrypoint(metaUrl: string): boolean {
  try {
    return typeof process.argv[1] === "string" && metaUrl === `file://${process.argv[1]}`;
  } catch {
    /* intentional: import.meta/argv unavailable under some loaders; treat as not-main */
    return false;
  }
}

/** Print the one JSON result and exit once stdout drains (a lazy ioredis handle must never hold the process). */
export function finish(code: number, result?: unknown): void {
  if (result !== undefined) process.stdout.write(`${JSON.stringify(result)}\n`);
  process.stdout.write("", () => process.exit(code));
}

/** Exit 2 with the `schema-validation-failed` envelope the engine CLI uses. */
export function usageExit(issues: unknown[]): void {
  console.error(JSON.stringify({ code: "schema-validation-failed", issues }));
  finish(2);
}
