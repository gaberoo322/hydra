/**
 * scripts/qa/commit-graduation.ts — graduation check for the `reviewer-commits`
 * switch's A -> A+B step (issue #5268, ADR-0046 Decision 6; sibling of
 * scripts/qa/pair-graduation.ts).
 *
 * A READ-ONLY, zero-token check. It counts CLEAN class-A reviewer fixes and
 * plans — at most once — the `ready-for-human` flip item. It never calls a
 * model, never writes Redis, never edits config/orchestrator/qa-rollout.json
 * or any repo file; its only side effect is `gh issue create` under `--apply`.
 * The flip itself is an operator-merged config PR. The count gates ONLY whether
 * the flip item is filed: decideReviewerCommit() takes no count input and the
 * effective switch is the sole runtime authority.
 *
 * A clean class-A fix = a merged PR whose latest QA-Verdict trailer carries
 * `qa-fixes=`, whose PR commits' `QA-Fix:` trailers are ALL `A`, that merged at
 * least MATURITY_DAYS before `until` (not in the cohort's `pending[]`) and that
 * is not in the cohort's `escapes[].pr`. Sources are the PR thread and the PR
 * commits via gh: squash merges strip the trailer from master, so `git log` of
 * master is never the source.
 *
 *   npx tsx scripts/qa/commit-graduation.ts                     # live, dry-run
 *   npx tsx scripts/qa/commit-graduation.ts --apply             # file the flip item
 *   npx tsx scripts/qa/commit-graduation.ts --from-inputs x.json
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { loadRolloutSwitches, type TripState } from "../../src/qa/rollout-switches.ts";
import { parseQaFixCommitTrailer } from "../../src/qa/verdict-trailer.ts";
import { MATURITY_DAYS } from "./cohort-baseline.ts";

/** ADR-0046 D6: "~10 clean class-A fixes". */
export const GRADUATION_MIN_CLEAN_A = 10;
export const FLIP_ITEM_TITLE = "Flip reviewer-commits: A -> A+B (commit graduation ready)";
export const FLIP_ITEM_MARKER = "<!-- commit-graduation-flip reviewer-commits -->";
export const FLIP_ITEM_LABEL = "ready-for-human";
const COHORT_FIXTURE_PATH = "test/fixtures/qa-cohort-baseline.json";
const DAY_MS = 86_400_000;

export type CommitGraduationState = "ready" | "collecting" | "not-in-a" | "already-a+b" | "tripped";

export interface CommitGraduationPr {
  number: number;
  mergedAt: string;
  /** `qa-fixes=` shas of the PR's LATEST QA-Verdict trailer (empty = no reviewer commit). */
  latestQaFixes: readonly string[];
  /** Full messages of the PR's commits (the source of the `QA-Fix:` trailers). */
  commitMessages: readonly string[];
}

export interface CommitGraduationInputs {
  prs: CommitGraduationPr[];
  /** ISO instant the maturity window is measured against. */
  until: string;
  /** Cohort `metrics.pending` (PRs merged inside the maturity window). */
  pending: readonly number[];
  /** Cohort `metrics.escapes[].pr`. */
  escapes: readonly number[];
  switches: { configured: string; trip: TripState };
}

export interface CommitGraduationReport {
  state: CommitGraduationState;
  ready: boolean;
  cleanA: { count: number; needed: number; prs: number[] };
  excluded: { immature: number; escaped: number; notClassA: number };
  trip: TripState;
  configured: string;
}

/** True iff every `QA-Fix:` trailer across the messages is a well-formed `A` and at least one exists. */
function allClassA(messages: readonly string[]): boolean {
  let seen = 0;
  for (const m of messages) {
    const t = parseQaFixCommitTrailer(m);
    if (!t.present) continue;
    if (t.cls !== "A") return false;
    seen += 1;
  }
  return seen > 0;
}

/** Pure, total, never throws; malformed rows warn and are skipped. */
export function assessCommitGraduation(inputs: CommitGraduationInputs): {
  report: CommitGraduationReport;
  warnings: string[];
} {
  const warnings: string[] = [];
  const rows = Array.isArray(inputs?.prs) ? inputs.prs : [];
  const pending = new Set(Array.isArray(inputs?.pending) ? inputs.pending : []);
  const escaped = new Set(Array.isArray(inputs?.escapes) ? inputs.escapes : []);
  const untilMs = Date.parse(String(inputs?.until ?? ""));
  if (Number.isNaN(untilMs)) warnings.push("until is not a valid instant; no PR can mature");
  const clean: number[] = [];
  const seen = new Set<number>();
  let immature = 0;
  let escapedN = 0;
  let notClassA = 0;
  for (const [i, p] of rows.entries()) {
    if (!p || !Number.isInteger(p.number) || p.number < 1) {
      warnings.push(`prs[${i}]: missing number, skipped`);
      continue;
    }
    if (seen.has(p.number)) {
      warnings.push(`prs[${i}] #${p.number}: duplicate PR row, skipped`);
      continue;
    }
    seen.add(p.number);
    if (!Array.isArray(p.latestQaFixes) || p.latestQaFixes.length === 0) continue; // no reviewer commit at all
    if (!allClassA(Array.isArray(p.commitMessages) ? p.commitMessages : [])) {
      notClassA += 1;
      continue;
    }
    const mergedMs = Date.parse(String(p.mergedAt ?? ""));
    if (pending.has(p.number) || Number.isNaN(mergedMs) || Number.isNaN(untilMs) || mergedMs + MATURITY_DAYS * DAY_MS > untilMs) {
      immature += 1;
      continue;
    }
    if (escaped.has(p.number)) {
      escapedN += 1;
      continue;
    }
    clean.push(p.number);
  }
  const configured = String(inputs?.switches?.configured ?? "off");
  const trip: TripState = inputs?.switches?.trip ?? "unknown";
  const ready = clean.length >= GRADUATION_MIN_CLEAN_A && configured === "A" && trip === "not-tripped";
  let state: CommitGraduationState;
  if (configured === "A+B") state = "already-a+b";
  else if (configured !== "A") state = "not-in-a";
  else if (trip === "tripped") state = "tripped";
  else state = ready ? "ready" : "collecting";
  return {
    report: {
      state,
      ready,
      cleanA: { count: clean.length, needed: GRADUATION_MIN_CLEAN_A, prs: clean.sort((a, b) => a - b) },
      excluded: { immature, escaped: escapedN, notClassA },
      trip,
      configured,
    },
    warnings,
  };
}

export interface OpenIssue {
  number: number;
  title: string;
  body?: string | null;
}

export type FlipPlan =
  | { file: false; reason: string; existing: number | null }
  | { file: true; title: string; body: string; labels: string[] };

export function renderFlipItemBody(report: CommitGraduationReport): string {
  return [
    FLIP_ITEM_MARKER,
    "",
    "Reviewer commits have graduated from class A (ADR-0046 D6).",
    "",
    "## Proposed change",
    "",
    "In `config/orchestrator/qa-rollout.json`:",
    "",
    "```diff",
    '-  "reviewer-commits": "A"',
    '+  "reviewer-commits": "A+B"',
    "```",
    "",
    "## Evidence snapshot",
    "",
    `- clean class-A fixes: ${report.cleanA.count} (need ${report.cleanA.needed})`,
    `- excluded: ${report.excluded.immature} immature, ${report.excluded.escaped} escaped, ${report.excluded.notClassA} with a non-A reviewer commit`,
    `- cohort trip: ${report.trip}`,
    "",
    "Wiring of the reviewer-commit block into the QA route (#5415) must have landed before this flip.",
    "This flip is operator-merged. It is never autopilot-opened or auto-merged (ADR-0046 D6).",
    "",
  ].join("\n");
}

/** Pure. Files only when ready and no open issue already has the title or marker. */
export function planFlipItem(report: CommitGraduationReport, openIssues: OpenIssue[]): FlipPlan {
  if (!report.ready) return { file: false, reason: `not-ready:${report.state}`, existing: null };
  const dupes = (Array.isArray(openIssues) ? openIssues : []).filter(
    (i) => i && (i.title === FLIP_ITEM_TITLE || (typeof i.body === "string" && i.body.includes(FLIP_ITEM_MARKER))),
  );
  if (dupes.length > 0) {
    return { file: false, reason: "flip-item-already-open", existing: (dupes[0] as OpenIssue).number };
  }
  return { file: true, title: FLIP_ITEM_TITLE, body: renderFlipItemBody(report), labels: [FLIP_ITEM_LABEL] };
}

// ---------------------------------------------------------------------------
// CLI helpers (gh) — the pure folds above are the tested surface
// ---------------------------------------------------------------------------

/** Null (after logging) when any gh read fails: the caller exits 1, never grades a partial harvest. */
async function harvest(repo: string, repoRoot: string): Promise<{ inputs: CommitGraduationInputs } | null> {
  const { ghJson } = await import("../../src/github/gh.ts");
  const fixture = JSON.parse(readFileSync(`${repoRoot}/${COHORT_FIXTURE_PATH}`, "utf8")) as any;
  const until = new Date().toISOString();
  const candidates: Array<{ number: number; mergedAt: string; latestQaFixes: string[] }> = [];
  for (const pr of fixture?.inputs?.prs ?? []) {
    const trailers = Array.isArray(pr?.trailers) ? pr.trailers : [];
    const latest = trailers.reduce((a: any, t: any) => (!a || t.round >= a.round ? t : a), null);
    if (latest && Array.isArray(latest.qaFixes) && latest.qaFixes.length > 0) {
      candidates.push({ number: pr.number, mergedAt: pr.mergedAt, latestQaFixes: latest.qaFixes });
    }
  }
  const prs: CommitGraduationPr[] = [];
  for (const c of candidates) {
    const res = await ghJson<Array<{ commit: { message: string } }>[]>(
      ["api", `repos/${repo}/pulls/${c.number}/commits?per_page=100`, "--paginate", "--slurp"],
      { timeout: 120_000 },
    );
    if (res.ok === false) {
      console.error(`[commit-graduation] gh api pulls/${c.number}/commits failed: ${res.code}`);
      return null;
    }
    prs.push({ ...c, commitMessages: res.data.flat().map((x) => x.commit.message) });
  }
  const sw = await loadRolloutSwitches(repoRoot);
  return {
    inputs: {
      prs,
      until,
      pending: fixture?.metrics?.pending ?? [],
      escapes: (fixture?.metrics?.escapes ?? []).map((e: any) => e.pr),
      switches: { configured: sw.configured["reviewer-commits"], trip: sw.trip.state },
    },
  };
}

const isMain = (() => {
  try {
    return (
      Array.isArray(process.argv) &&
      process.argv[1] !== undefined &&
      import.meta.url === `file://${process.argv[1]}`
    );
  } catch {
    /* intentional: import.meta unavailable outside a module host — not the CLI */
    return false;
  }
})();

if (isMain) {
  const arg = (flag: string): string | null => {
    const i = process.argv.indexOf(flag);
    return i === -1 || i === process.argv.length - 1 ? null : (process.argv[i + 1] as string);
  };
  const repo = arg("--repo") ?? "gaberoo322/hydra";
  const apply = process.argv.includes("--apply");
  const fromInputs = arg("--from-inputs");

  let inputs: CommitGraduationInputs;
  let openIssues: OpenIssue[] = [];
  if (fromInputs !== null) {
    const doc = JSON.parse(readFileSync(fromInputs, "utf8"));
    inputs = doc.inputs ?? doc;
    openIssues = doc.openIssues ?? [];
  } else {
    try {
      const harvested = await harvest(repo, process.cwd());
      if (harvested === null) process.exit(1);
      inputs = harvested.inputs;
      const { ghJson } = await import("../../src/github/gh.ts");
      const res = await ghJson<OpenIssue[]>(
        [
          "issue", "list", "--repo", repo, "--label", FLIP_ITEM_LABEL, "--state", "open",
          "--limit", "200", "--json", "number,title,body",
        ],
        { timeout: 60_000 },
      );
      if (res.ok === false) {
        console.error(`[commit-graduation] gh issue list failed: ${res.code}`);
        process.exit(1);
      }
      openIssues = res.data;
    } catch (err) {
      console.error("[commit-graduation] harvest failed:", err);
      process.exit(1);
    }
  }
  const { report, warnings } = assessCommitGraduation(inputs);
  for (const w of warnings) console.error(`[commit-graduation] warning: ${w}`);
  const plan = planFlipItem(report, openIssues);
  let flipItem: Record<string, unknown>;
  if (plan.file === false) {
    flipItem = { filed: false, existing: plan.existing, reason: plan.reason };
  } else if (!apply) {
    flipItem = { filed: false, wouldFile: { title: plan.title, labels: plan.labels, body: plan.body } };
  } else {
    try {
      // REST create with a JSON body on stdin: a flip item is filed, never state-transitioned.
      const created = execFileSync("gh", ["api", `repos/${repo}/issues`, "--method", "POST", "--input", "-"], {
        encoding: "utf8",
        input: JSON.stringify({ title: plan.title, body: plan.body, labels: plan.labels }),
      });
      flipItem = { filed: true, url: (JSON.parse(created) as { html_url?: string }).html_url ?? null };
    } catch (err) {
      console.error("[commit-graduation] filing the flip item failed:", err);
      process.exit(1);
    }
  }
  process.stdout.write(JSON.stringify({ report, flipItem }, null, 2) + "\n", () => process.exit(0));
}
