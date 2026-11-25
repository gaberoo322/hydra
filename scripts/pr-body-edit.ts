/**
 * scripts/pr-body-edit.ts — the one guarded PR-body edit path (issue #5638).
 *
 *   npx tsx scripts/pr-body-edit.ts <pr> --body-file <path> [--anchor <N|issue-N>]
 *
 * Why: a forward-fix worker that ran `gh pr view ... > file && gh pr edit
 * --body-file file` from outside the repo wrote an EMPTY body onto the PR,
 * dropping its `Closes #N` line; every PR lane then lost the anchor. This CLI
 * refuses the edits that would do that, and always passes `--repo`, so it runs
 * from any cwd.
 *
 * Never throws. Exit 0 + `{ok:true, pr, anchor, bytes}`; exit 1 +
 * `{ok:false, code, pr, detail}` with code in {empty-body, closing-ref-missing,
 * anchor-unresolvable, reconcile-violation, gh-failed}; exit 2 on usage error.
 * The closing-ref parser and the reconcile dry-run are the CI ones (imported,
 * never re-implemented).
 */
import { isEntrypoint } from "./lib/entrypoint.mjs";
import { readFileSync } from "node:fs";
import { ghExec, ghJson } from "../src/github/gh.ts";
import { extractAnchorRefFromPrBody } from "./ci/design-concept-reconcile-check.ts";
import {
  defaultDeps,
  runLocalReconcileCheck,
  type ReconcileRunResult,
  type RunDeps,
} from "./ci/design-concept-reconcile-run.ts";

export const PR_BODY_REPO = "gaberoo322/hydra";

export type PrBodyEditCode =
  | "empty-body"
  | "closing-ref-missing"
  | "anchor-unresolvable"
  | "reconcile-violation"
  | "gh-failed";

export type PrBodyEditResult =
  | { ok: true; pr: number; anchor: number; bytes: number }
  | { ok: false; code: PrBodyEditCode; pr: number; detail: string };

export type PrBodyEditArgs =
  | { kind: "edit"; pr: number; bodyFile: string; anchor: number | null }
  | { kind: "error"; message: string };

/** Minimal gh surface, injectable so tests stub it and assert zero edit calls. */
export type PrBodyEditDeps = {
  readBodyFile: (path: string) => string | null;
  /** Live PR body, or null when gh failed. */
  viewBody: (pr: number) => Promise<string | null>;
  /** Write the body; true only on success. */
  editBody: (pr: number, bodyFile: string) => Promise<boolean>;
  reconcile: (input: { prBody: string; anchorRef: number | null }) => Promise<ReconcileRunResult>;
};

export function parsePrBodyEditArgs(argv: string[]): PrBodyEditArgs {
  let pr: number | null = null;
  let bodyFile: string | null = null;
  let anchorRaw: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--body-file" || a === "--anchor") {
      const value = argv[++i];
      if (value === undefined || value === "") return { kind: "error", message: `${a} requires a value` };
      if (a === "--body-file") bodyFile = value;
      else anchorRaw = value;
    } else if (/^\d+$/.test(a) && pr === null) {
      pr = Number(a);
    } else {
      return { kind: "error", message: `unknown argument: ${a}` };
    }
  }
  if (pr === null || pr <= 0) return { kind: "error", message: "<pr> number is required" };
  if (bodyFile === null) return { kind: "error", message: "--body-file <path> is required" };
  let anchor: number | null = null;
  if (anchorRaw !== null) {
    const m = /^(?:issue-|#)?(\d+)$/.exec(anchorRaw.trim());
    if (!m) return { kind: "error", message: `--anchor must be N or issue-N, got: ${anchorRaw}` };
    anchor = Number(m[1]);
  }
  return { kind: "edit", pr, bodyFile, anchor };
}

/** Validate then write. Every refusal leaves the live PR body untouched. */
export async function runPrBodyEdit(
  args: { pr: number; bodyFile: string; anchor: number | null },
  deps: PrBodyEditDeps,
): Promise<PrBodyEditResult> {
  const { pr } = args;
  const refuse = (code: PrBodyEditCode, detail: string): PrBodyEditResult => ({ ok: false, code, pr, detail });

  const body = deps.readBodyFile(args.bodyFile);
  if (body === null || body.trim() === "") {
    return refuse("empty-body", `body file ${args.bodyFile} is missing, empty or whitespace-only`);
  }

  let anchor = args.anchor;
  if (anchor === null) {
    const live = await deps.viewBody(pr);
    if (live === null) return refuse("gh-failed", `could not read the live body of PR #${pr}`);
    anchor = extractAnchorRefFromPrBody(live);
    if (anchor === null) {
      return refuse("anchor-unresolvable", "no --anchor given and the live PR body has no Closes/Fixes/Resolves #N");
    }
  }

  const newRef = extractAnchorRefFromPrBody(body);
  if (newRef !== anchor) {
    const saw = newRef === null ? "no Closes/Fixes/Resolves #N" : `Closes #${newRef}`;
    return refuse("closing-ref-missing", `new body has ${saw}, expected Closes #${anchor}`);
  }

  const rec = await deps.reconcile({ prBody: body, anchorRef: anchor });
  if (rec.outcome === "violation") return refuse("reconcile-violation", rec.message);

  if (!(await deps.editBody(pr, args.bodyFile))) return refuse("gh-failed", `gh pr edit ${pr} failed`);
  return { ok: true, pr, anchor, bytes: Buffer.byteLength(body, "utf8") };
}

export function defaultPrBodyEditDeps(): PrBodyEditDeps {
  const { fetchArtifact, readFile } = defaultDeps();
  const reconcileDeps: Omit<RunDeps, "readEventPayload"> = { fetchArtifact, readFile };
  return {
    readBodyFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch (err: any) {
        console.error(`[pr-body-edit] cannot read ${path}: ${err?.message ?? err}`);
        return null;
      }
    },
    viewBody: async (pr) => {
      const res = await ghJson<{ body?: string }>(["pr", "view", String(pr), "--repo", PR_BODY_REPO, "--json", "body"]);
      return res.ok ? (res.data.body ?? "") : null;
    },
    editBody: async (pr, bodyFile) => {
      const res = await ghExec(["pr", "edit", String(pr), "--repo", PR_BODY_REPO, "--body-file", bodyFile]);
      return res.ok;
    },
    reconcile: (input) => runLocalReconcileCheck(input, reconcileDeps),
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parsePrBodyEditArgs([...argv]);
  if (args.kind === "error") {
    console.error(`[pr-body-edit] usage error: ${args.message}`);
    console.error("usage: pr-body-edit.ts <pr> --body-file <path> [--anchor <N|issue-N>]");
    return 2;
  }
  let result: PrBodyEditResult;
  try {
    result = await runPrBodyEdit(args, defaultPrBodyEditDeps());
  } catch (err: any) {
    console.error("[pr-body-edit] unexpected failure:", err);
    result = { ok: false, code: "gh-failed", pr: args.pr, detail: String(err?.message ?? err) };
  }
  console.log(JSON.stringify(result));
  return result.ok ? 0 : 1;
}


if (isEntrypoint(import.meta.url)) {
  const { closeRedisConnections } = await import("../src/redis/connection.ts");
  const code = await main(process.argv.slice(2));
  await closeRedisConnections();
  process.exit(code);
}
