/**
 * scripts/qa/poll.ts — the bounded foreground CI poll (issue #5269, ADR-0046
 * Decision 7), replacing the ~30-line bash fence in hydra-qa.md.
 *
 *   node --experimental-strip-types scripts/qa/poll.ts --pr N \
 *     [--repo owner/name] [--iterations 40] [--interval 15]
 *
 * Prints `{pending, settled, iterations, checks:[{name, state}]}`. It runs a
 * FIXED number of iterations (never a deadline computed from $SECONDS, which
 * the worktree Bash guard refuses) and NEVER re-arms: one call, one budget. An
 * unreadable `gh pr checks` keeps polling with `pending` left null (fail closed
 * — an unanswered poll is never read as terminal) and reports `settled:false`
 * at budget expiry. hydra-qa still posts a partial-but-posted verdict rather
 * than wait; this is for the rare dispatch that must observe a process to
 * completion in-turn.
 */

import {
  DEFAULT_REPO,
  UsageError,
  flagValue,
  intFlag,
  isEntrypoint,
  runCli,
  type CmdResult,
} from "./_lib.ts";
import { PollResultSchema, type PollResult } from "../../src/schemas/qa-plumbing-cli.ts";

export interface PollOptions {
  pr: number;
  repo: string;
  iterations: number;
  intervalSeconds: number;
}

export interface PollDeps {
  /** `gh pr checks <pr> --repo <repo>` stdout, tab-separated. */
  checks(pr: number, repo: string): Promise<CmdResult>;
  sleep(seconds: number): Promise<void>;
}

/** Parse `gh pr checks` rows: `name<TAB>state<TAB>elapsed<TAB>url`. */
export function parseChecks(stdout: string): Array<{ name: string; state: string }> {
  const out: Array<{ name: string; state: string }> = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const cols = line.split("\t");
    if (cols.length < 2) continue;
    out.push({ name: (cols[0] as string).trim(), state: (cols[1] as string).trim() });
  }
  return out;
}

export async function runPoll(opts: PollOptions, deps: PollDeps): Promise<PollResult> {
  let pending: number | null = null; // stays null if gh never answers
  let checks: PollResult["checks"] = [];
  let iterations = 0;
  let settled = false;
  for (let i = 0; i < opts.iterations; i++) {
    iterations = i + 1;
    const res = await deps.checks(opts.pr, opts.repo);
    const rows = res.ok ? parseChecks(res.stdout) : [];
    if (!res.ok || rows.length === 0) {
      // gh error / rate limit / no checks yet: keep polling (fail closed).
      if (i < opts.iterations - 1) await deps.sleep(opts.intervalSeconds);
      continue;
    }
    checks = rows;
    pending = rows.filter((r) => r.state === "pending").length;
    if (pending === 0) {
      settled = true;
      break;
    }
    if (i < opts.iterations - 1) await deps.sleep(opts.intervalSeconds);
  }
  return { pending, settled, iterations, checks };
}

if (isEntrypoint(import.meta.url)) {
  await runCli("qa-poll", async () => {
    const argv = process.argv.slice(2);
    const pr = intFlag(argv, "--pr");
    if (pr === undefined) throw new UsageError("usage: poll.ts --pr N [--repo owner/name] [--iterations 40] [--interval 15]");
    const repo = flagValue(argv, "--repo") ?? DEFAULT_REPO;
    const { runExec, ghBin } = await import("../../src/github/exec.ts");
    const result = await runPoll(
      { pr, repo, iterations: intFlag(argv, "--iterations") ?? 40, intervalSeconds: intFlag(argv, "--interval") ?? 15 },
      {
        async checks(n, r) {
          // `gh pr checks` exits 8 while any check is pending — a normal poll
          // state whose stdout is the answer, so the raw exec (not ghExec,
          // which discards stdout on a non-zero exit) is the right primitive.
          const raw = await runExec(ghBin(), ["pr", "checks", String(n), "--repo", r]);
          if (raw.timedOut || raw.spawnErrorCode || raw.stdout.trim() === "") {
            return { ok: false, stderr: raw.stderr };
          }
          return { ok: true, stdout: raw.stdout };
        },
        sleep: (s) => new Promise((resolve) => setTimeout(resolve, s * 1000)),
      },
    );
    return PollResultSchema.parse(result);
  });
}
