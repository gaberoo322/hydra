/**
 * cli-args — the ONE shared CLI-argument seam for `scripts/*.ts` CLIs (issue #4565).
 *
 * A thin, pure wrapper over Node's built-in `node:util` `parseArgs` (zero new
 * dependencies — ADR-0005). It owns only the *mechanics* of reading
 * `--flag value` / `--flag=value` off argv; each script keeps its own flag SET,
 * defaults, coercion and validation locally (divergence, not drift — the same
 * call #4535 made for `src/retro-inputs.ts`).
 *
 * Contract:
 *   - Always strict (unknown flags rejected) and positional-free.
 *   - NEVER throws: every `ERR_PARSE_ARGS_*` is returned as `{ ok: false, error }`.
 *   - Unknown flags (and stray positionals) are normalised to exactly
 *     `Unknown argument: <flag>` — one wording repo-wide.
 *   - Missing-value / ambiguous-value errors keep node's message, which names
 *     the flag. A value that itself starts with `-` must use `--flag=-x`.
 *   - Values come back as node:util's strings / booleans (arrays for
 *     `multiple: true`); absent flags without a `default` are absent keys.
 *
 * Pure leaf: imports only `node:util`; no env, fs, stdout or process.exit —
 * printing usage and choosing the exit code stay in each script's `main()`.
 * Kept stdlib-only because `scripts/sync-target-gate.sh` mirrors it into
 * Target worktrees (it is in the gate closure of post-merge-health.ts and
 * verify-install-decision.ts).
 */

import { parseArgs, type ParseArgsOptionsConfig } from "node:util";

type StrictConfig<T extends ParseArgsOptionsConfig> = {
  args: string[];
  options: T;
  strict: true;
  allowPositionals: false;
};

/** The typed `values` object node:util infers for option config `T`. */
export type CliValues<T extends ParseArgsOptionsConfig> = ReturnType<
  typeof parseArgs<StrictConfig<T>>
>["values"];

export type CliArgsResult<T extends ParseArgsOptionsConfig> =
  | { ok: true; values: CliValues<T> }
  | { ok: false; error: string };

/** Pull the first single-quoted token out of a node:util error message. */
function quotedToken(message: string): string | null {
  const m = /'([^']*)'/.exec(message);
  return m ? m[1] : null;
}

/**
 * Parse `argv` against `options` (a node:util `ParseArgsOptionsConfig`).
 * Never throws — see the module doc for the full contract.
 */
export function parseCliArgs<T extends ParseArgsOptionsConfig>(
  argv: readonly string[],
  options: T,
): CliArgsResult<T> {
  try {
    const { values } = parseArgs({
      args: [...argv],
      options,
      strict: true,
      allowPositionals: false,
    } as StrictConfig<T>);
    return { ok: true, values: values as CliValues<T> };
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    const message = err instanceof Error ? err.message : String(err);
    if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" || code === "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL") {
      const token = quotedToken(message);
      return { ok: false, error: `Unknown argument: ${token ?? message}` };
    }
    // ERR_PARSE_ARGS_INVALID_OPTION_VALUE (missing / ambiguous / boolean-with-value)
    // already names the flag; keep only the first line for a one-line error.
    return { ok: false, error: message.split("\n")[0] };
  }
}
