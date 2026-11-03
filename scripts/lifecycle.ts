/**
 * scripts/lifecycle.ts — CLI adapter for the lifecycle writer seam
 * (ADR-0047 Decision 3, issue #5310).
 *
 *   npx tsx scripts/lifecycle.ts advance <issue> <to> [--evidence k=v]...
 *       [--reason R] [--rationale T] [--close-reason completed|"not planned"] [--actor A]
 *   npx tsx scripts/lifecycle.ts claim <issue> --dispatch ID --class C --run R [--artifact-hash H]
 *   npx tsx scripts/lifecycle.ts release <issue> [--dispatch ID]
 *
 * Talks to GitHub (gh) and Redis directly: no :4000 dependency. Prints one JSON
 * line. Exit codes: 0 ok (including a shadow `wouldRefuse`), 1 refused / failed
 * (enforce refusals, human-hold exits, claim-held), 2 usage error. There is no
 * `--operator` flag: human-hold exits are refused for every caller.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { advance, defaultSeamDeps, openClaim, releaseClaim } from "../src/lifecycle/index.ts";
import { closeRedisConnections } from "../src/redis/connection.ts";

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string>;
  evidence: Record<string, string>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs | { error: string } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  const evidence: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const name = a.slice(2);
    const value = argv[i + 1];
    if (value === undefined) return { error: `--${name} requires a value` };
    i++;
    if (name === "evidence") {
      const eq = value.indexOf("=");
      if (eq <= 0) return { error: `--evidence expects k=v, got '${value}'` };
      evidence[value.slice(0, eq)] = value.slice(eq + 1);
    } else {
      flags[name] = value;
    }
  }
  return { positional, flags, evidence };
}

function emit(obj: Record<string, unknown>): void {
  console.log(JSON.stringify(obj));
}

function parseIssue(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    console.error(`[lifecycle] usage error: ${parsed.error}`);
    return 2;
  }
  const [verb, issueRaw, to] = parsed.positional;
  const issue = parseIssue(issueRaw);
  if (issue === null || (verb !== "advance" && verb !== "claim" && verb !== "release")) {
    console.error("[lifecycle] usage: advance <issue> <to> | claim <issue> | release <issue>");
    return 2;
  }
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const deps = defaultSeamDeps(repoRoot);

  if (verb === "advance") {
    if (!to) {
      console.error("[lifecycle] advance requires <to>");
      return 2;
    }
    const res = await advance(
      {
        issue,
        to,
        evidence: parsed.evidence,
        reason: parsed.flags.reason,
        rationale: parsed.flags.rationale,
        closeReason: parsed.flags["close-reason"],
        actor: parsed.flags.actor,
      },
      deps,
    );
    emit(res);
    return res.ok ? 0 : 1;
  }

  if (verb === "claim") {
    const { class: cls, run } = parsed.flags;
    const dispatchId = parsed.flags.dispatch ?? parsed.flags["dispatch-id"];
    if (!dispatchId || !cls || !run) {
      console.error("[lifecycle] claim requires --dispatch, --class and --run");
      return 2;
    }
    const res = await openClaim(
      { issue, dispatchId, class: cls, run, artifactHash: parsed.flags["artifact-hash"] ?? null, actor: parsed.flags.actor },
      deps,
    );
    emit(res);
    return res.ok ? 0 : 1;
  }

  const res = await releaseClaim(issue, deps, parsed.flags.actor, parsed.flags.dispatch ?? parsed.flags["dispatch-id"]);
  emit(res);
  return res.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2))
    .then((code) => {
      closeRedisConnections();
      process.exitCode = code;
    })
    .catch((err) => {
      console.error("[lifecycle] fatal:", err);
      closeRedisConnections();
      process.exitCode = 1;
    });
}
