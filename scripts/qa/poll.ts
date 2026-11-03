/**
 * scripts/qa/poll.ts — the bounded foreground CI poll (issue #5269, ADR-0046
 * Decision 7), replacing the 30-line bash fence in hydra-qa.md.
 *
 *   node --experimental-strip-types scripts/qa/poll.ts --pr N [--repo owner/name] [--iterations 40] [--interval 15]
 *
 * Prints `{pending, settled, iterations, checks:[{name, state}]}`. One FIXED
 * iteration budget, never re-armed: an unreadable `gh pr checks` keeps polling
 * with `pending` left null (unknown — never read as terminal), and budget
 * expiry reports `settled:false`. The caller then posts the verdict it can
 * stand behind now (partial-but-posted), it does not poll again.
 */

import { spawnSync } from "node:child_process";
import {
  DEFAULT_REPO,
  defaultGh,
  finish,
  flagValue,
  intFlag,
  isEntrypoint,
  usageExit,
  type CmdRunner,
} from "./common.ts";
import { PollResultSchema, type PollResult } from "../../src/schemas/qa-plumbing-cli.ts";

export interface PollArgs {
  pr: number;
  repo: string;
  iterations: number;
  intervalSeconds: number;
}

export interface PollDeps {
  gh: CmdRunner;
  sleep: (seconds: number) => void;
}

export function runPoll(args: PollArgs, deps: PollDeps): PollResult {
  let pending: number | null = null;
  let settled = false;
  let iterations = 0;
  let checks: Array<{ name: string; state: string }> = [];
  for (let i = 1; i <= args.iterations; i++) {
    iterations = i;
    // `gh pr checks` exits 8 while checks are pending: judge by stdout, not the code.
    const out = deps.gh(["pr", "checks", String(args.pr), "--repo", args.repo]);
    const lines = out.stdout.split("\n").filter((l) => l.trim() !== "");
    if (lines.length > 0) {
      checks = lines.map((l) => {
        const cols = l.split("\t");
        return { name: cols[0] ?? "", state: cols[1] ?? "" };
      });
      pending = checks.filter((c) => c.state === "pending").length;
      if (pending === 0) {
        settled = true;
        break;
      }
    }
    if (i < args.iterations) deps.sleep(args.intervalSeconds);
  }
  return { pending, settled, iterations, checks };
}

const realSleep = (seconds: number): void => {
  spawnSync("sleep", [String(seconds)]);
};

if (isEntrypoint(import.meta.url)) {
  const argv = process.argv.slice(2);
  const pr = intFlag(argv, "--pr");
  if (pr === undefined) {
    usageExit([{ message: "usage: poll.ts --pr N [--repo owner/name] [--iterations 40] [--interval 15]" }]);
  } else {
    const result = runPoll(
      {
        pr,
        repo: flagValue(argv, "--repo", DEFAULT_REPO) as string,
        iterations: intFlag(argv, "--iterations") ?? 40,
        intervalSeconds: intFlag(argv, "--interval") ?? 15,
      },
      { gh: defaultGh, sleep: realSleep },
    );
    const parsed = PollResultSchema.safeParse(result);
    if (!parsed.success) usageExit(parsed.error.issues);
    else finish(0, parsed.data);
  }
}
