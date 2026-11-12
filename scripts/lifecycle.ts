/**
 * scripts/lifecycle.ts — CLI adapter for the lifecycle writer seam
 * (ADR-0047 Decision 3, issue #5310).
 *
 *   npx tsx scripts/lifecycle.ts advance <issue> <to> [--evidence k=v]...
 *       [--reason R] [--rationale T] [--close-reason completed|"not planned"] [--actor A]
 *   npx tsx scripts/lifecycle.ts claim <issue> --dispatch ID --class C --run R [--artifact-hash H]
 *   npx tsx scripts/lifecycle.ts release [<issue>] --dispatch ID [--outcome O]
 *   npx tsx scripts/lifecycle.ts claim-show <issue>
 *   npx tsx scripts/lifecycle.ts dispatch <issue> --dispatch ID --class C --run R [--pr N] [--purpose P]
 *   npx tsx scripts/lifecycle.ts reconcile [--dry-run | --report]
 *
 * Talks to GitHub (gh) and Redis directly: no :4000 dependency. Prints one JSON
 * line. Exit codes: 0 ok (including a shadow `wouldRefuse`), 1 refused / failed
 * (enforce refusals, human-hold exits, claim-held), 2 usage error. There is no
 * `--operator` flag: human-hold exits are refused for every caller.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  CLAIM_OUTCOMES,
  advance,
  defaultSeamDeps,
  dispatch,
  openClaim,
  releaseClaim,
  releaseClaimByDispatch,
  type ClaimOutcome,
  type ClaimPurpose,
} from "../src/lifecycle/index.ts";
import { CLAIM_PURPOSES } from "../src/lifecycle/seam.ts";

const USAGE =
  "[lifecycle] usage: advance <issue> <to> | claim <issue> --dispatch <id> ... | " +
  "release [<issue>] --dispatch <id> [--outcome <o>] | claim-show <issue> | " +
  "dispatch <issue> --dispatch <id> --class <c> --run <r> [--pr N] [--purpose p] | reconcile";
import { closeRedisConnections } from "../src/redis/connection.ts";
import { resolveGithubRepo } from "../src/github/issues.ts";
import { readReconcileReport } from "../src/redis/lifecycle-journal.ts";
import { runLifecycleReconcile } from "../src/scheduler/chores/lifecycle-reconcile.ts";

/** Flags that take no value (`reconcile --dry-run | --report`). */
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(["dry-run", "report"]);

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
    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = "true";
      continue;
    }
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

/**
 * `reconcile` (ADR-0047 D5, #5316): no flag runs one live pass and prints its
 * report; `--dry-run` classifies with every write skipped; `--report` prints the
 * last persisted report (the enforce-readiness data) without scanning.
 */
async function runReconcileVerb(flags: Record<string, string>): Promise<number> {
  if (flags.report === "true") {
    const res = await readReconcileReport(resolveGithubRepo());
    if (res.ok === false) {
      emit({ ok: false, error: res.error });
      return 1;
    }
    emit({ ok: true, ts: res.ts, report: res.report });
    return 0;
  }
  const report = await runLifecycleReconcile({ dryRun: flags["dry-run"] === "true" });
  if (report === null) {
    emit({ ok: false, error: "reconcile-crashed" });
    return 1;
  }
  emit({ ok: report.errors.length === 0, report });
  return report.errors.length === 0 ? 0 : 1;
}

export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    console.error(`[lifecycle] usage error: ${parsed.error}`);
    return 2;
  }
  const [verb, issueRaw, to] = parsed.positional;
  if (verb === "reconcile") return runReconcileVerb(parsed.flags);
  const verbs = ["advance", "claim", "release", "claim-show", "dispatch"];
  if (verb === undefined || !verbs.includes(verb)) {
    console.error(USAGE);
    return 2;
  }
  const issue = parseIssue(issueRaw);
  // `release` is the only verb whose issue is optional (SCAN by dispatch id).
  if (issue === null && !(verb === "release" && issueRaw === undefined)) {
    console.error(USAGE);
    return 2;
  }
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const deps = defaultSeamDeps(repoRoot);

  if (verb === "claim-show") {
    const read = await deps.journal.readClaim(deps.repo, issue as number);
    if (read.ok === false) {
      emit({ ok: false, error: read.error });
      return 1;
    }
    emit({ claim: read.claim });
    return 0;
  }

  if (verb === "dispatch") {
    const { class: cls, run } = parsed.flags;
    const dispatchId = parsed.flags.dispatch ?? parsed.flags["dispatch-id"];
    if (!dispatchId || !cls || !run) {
      console.error("[lifecycle] dispatch requires --dispatch, --class and --run");
      return 2;
    }
    const purpose = parsed.flags.purpose;
    if (purpose !== undefined && !(CLAIM_PURPOSES as readonly string[]).includes(purpose)) {
      console.error(`[lifecycle] unknown --purpose '${purpose}' (expected ${CLAIM_PURPOSES.join("|")})`);
      return 2;
    }
    const pr = parsed.flags.pr === undefined ? undefined : parseIssue(parsed.flags.pr);
    if (pr === null) {
      console.error("[lifecycle] --pr expects a positive integer");
      return 2;
    }
    const res = await dispatch(
      { issue: issue as number, dispatchId, class: cls, run, actor: parsed.flags.actor, pr, purpose: purpose as ClaimPurpose | undefined },
      deps,
    );
    emit(res);
    return res.ok ? 0 : 1;
  }

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

  // INV-11: release is always ownership-checked; there is no unowned/force path.
  const releaseDispatch = parsed.flags.dispatch ?? parsed.flags["dispatch-id"];
  if (!releaseDispatch) {
    console.error("[lifecycle] release requires --dispatch <id>");
    return 2;
  }
  const outcome = parsed.flags.outcome;
  if (outcome !== undefined && !(CLAIM_OUTCOMES as readonly string[]).includes(outcome)) {
    console.error(`[lifecycle] unknown --outcome '${outcome}' (expected ${CLAIM_OUTCOMES.join("|")})`);
    return 2;
  }
  const res =
    issue === null
      ? await releaseClaimByDispatch(releaseDispatch, deps, parsed.flags.actor, outcome as ClaimOutcome | undefined)
      : await releaseClaim(issue, releaseDispatch, deps, parsed.flags.actor, outcome as ClaimOutcome | undefined);
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
