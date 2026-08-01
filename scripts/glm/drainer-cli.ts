#!/usr/bin/env node
/**
 * drainer-cli.ts — thin CLI bridge for scripts/glm/drainer-loop.sh (#3689).
 *
 * The dev-drainer loop is a bash script (systemd Type=oneshot ExecStart), but
 * two of its steps are already-approved TypeScript seams that must not be
 * reimplemented in shell:
 *
 *   heartbeat  — write the "able to author" liveness heartbeat through the
 *                typed Redis accessor (`src/redis/autopilot.ts`
 *                `setGlmDrainerHeartbeat`, issue #3754/#3689 amendment).
 *   preflight <path...> — run the pre-`gh pr create` Verifier-Core/T4 +
 *                secret-scan gate (`src/glm/drainer-runner.ts`
 *                `preflightBeforePr`, issue #3688 invariant 8).
 *
 * Bash cannot `import` an ESM module and `await` an async function; this file
 * is the minimal bridge process the loop shells out to (`node
 * --experimental-strip-types scripts/glm/drainer-cli.ts <cmd> ...`), run from
 * the repo root (WorkingDirectory=%h/hydra in the systemd unit) so the
 * relative imports below resolve.
 *
 * Contract: each subcommand prints ONE machine-greppable line to stdout on
 * success, prints the failure detail to stderr, and exits 0 (pass) or 1
 * (blocked/failed) — the loop branches on exit code, never on stdout parsing.
 * Never throws uncaught: any unexpected error is caught in `main()` and
 * reported the same way, per the repo's never-throw-from-verification
 * convention.
 */

import { setGlmDrainerHeartbeat } from "../../src/redis/autopilot.ts";
import { preflightBeforePr } from "../../src/glm/drainer-runner.ts";

async function runHeartbeat(): Promise<number> {
  const result = await setGlmDrainerHeartbeat();
  // `=== false`, not `!result.ok`: this repo's tsconfig runs with
  // `strict: false` (no `strictNullChecks`), and TypeScript only narrows a
  // discriminated union on a negated bare boolean member when
  // strictNullChecks is on — a bare `!result.ok` silently fails to narrow
  // here and `result.message` would be a type error on the `{ok:true}` arm.
  // The explicit `=== false` comparison narrows regardless (repo convention;
  // see e.g. src/holdback.ts, src/worktree-orphan.ts).
  if (result.ok === false) {
    console.error(`heartbeat-write-failed: ${result.message}`);
    return 1;
  }
  console.log("heartbeat-ok");
  return 0;
}

async function runPreflight(changedPaths: string[]): Promise<number> {
  const result = await preflightBeforePr({ changedPaths });
  // See the narrowing note in runHeartbeat above — same reason for
  // `=== false` here.
  if (result.ok === false) {
    console.error(`preflight-blocked: ${result.message}`);
    return 1;
  }
  console.log(`preflight-ok checked=${result.checkedPaths}`);
  return 0;
}

async function main(): Promise<number> {
  const [, , cmd, ...rest] = process.argv;

  if (cmd === "heartbeat") {
    return runHeartbeat();
  }

  if (cmd === "preflight") {
    return runPreflight(rest.filter((p) => p.length > 0));
  }

  console.error(
    `drainer-cli: unknown subcommand "${cmd ?? ""}" (expected "heartbeat" or "preflight <path...>")`,
  );
  return 2;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    console.error(
      `drainer-cli: unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  });
