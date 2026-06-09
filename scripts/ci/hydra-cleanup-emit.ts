/**
 * scripts/ci/hydra-cleanup-emit.ts — Deterministic emit runner for the
 * `hydra-cleanup` skill (issue #1449).
 *
 * WHY THIS EXISTS — the #1167 fix regressed because the skill's EMIT step was
 * still LLM-prose-executed. #1167 moved parse → validate → dedup → render into
 * pure, tested helpers (scripts/ci/hydra-cleanup-render.ts), but the playbook
 * still asked the model to drive a bash `gh issue create` loop. On run f6403146
 * the model rendered each issue BODY via renderBody() (so the body H1 carried
 * the correct symbol, e.g. `RecentMergesQuery`) yet HAND-BUILT the issue TITLE
 * by string-interpolating knip's raw output — which lost the symbol, producing
 * the blank `cleanup: remove unused export  (src/schemas/today-page.ts)` titles
 * on #1421–#1426. Title and body diverged because they came from two different
 * sources: renderBody() for the body, a hand-rolled grep for the title.
 *
 * This runner removes that discretionary step entirely. It is a single
 * deterministic pass — parse → validate → filter → classify → dedup → render —
 * where the title, body H1, and `## Files in scope` path for an issue are all
 * produced from the SAME CleanupFinding inside one iteration. The title comes
 * ONLY from renderTitle(); the model can no longer build it by hand, so it can
 * no longer drift from the body. The runner reads the knip report + the open
 * board, plans the emit, and (with --apply) shells out to `gh issue create`.
 *
 * The PURE core is {@link planCleanupEmit} (no fs / network / process), so the
 * full parse→classify→dedup→render plan unit-tests directly. Only the thin CLI
 * wrapper at the bottom touches fs (read the knip report + source files) and
 * `gh` (read the board, create issues). Mirrors the pure-core + thin-shell
 * shape of scripts/ci/hydra-retro-emit.ts.
 *
 * Usage (the playbook invokes this, NOT a hand-rolled bash loop):
 *
 *   # dry-run: prints the plan (titles + bodies) and files nothing
 *   npx tsx scripts/ci/hydra-cleanup-emit.ts /tmp/knip-report.json
 *
 *   # apply: files one ready-for-agent + cleanup-scan issue per planned finding
 *   npx tsx scripts/ci/hydra-cleanup-emit.ts /tmp/knip-report.json --apply
 */

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  parseKnipReport,
  validateFinding,
  classifyExportFix,
  renderTitle,
  renderBody,
  dedupAgainstOpen,
  type CleanupFinding,
  type KnipReport,
} from "./hydra-cleanup-render.ts";

/** Max issues a single cleanup run files (whole-file deletions rank first). */
export const EMIT_CAP = 8;

/**
 * Verifier Core paths (src/untouchable.ts VERIFIER_CORE_PATHS) — operator-only,
 * never steered at by a cleanup issue. Substring-matched against the finding
 * path, mirroring the playbook Step 2 filter.
 */
export const VERIFIER_CORE_SUBSTRINGS = [
  "ci.yml",
  "deploy.yml",
  "scripts/tier-classify.ts",
  "src/tier-classifier.ts",
  "src/untouchable.ts",
];

/** A finding that survived the full pipeline and will be emitted. */
export interface PlannedCleanupIssue {
  finding: CleanupFinding;
  title: string;
  body: string;
}

/** A finding dropped before emit, with the reason (for the audit report). */
export interface DroppedCleanupFinding {
  finding: CleanupFinding;
  reason: string;
}

/** The deterministic emit plan {@link planCleanupEmit} returns. */
export interface CleanupEmitPlan {
  /** Issues to file, in emit order (length ≤ EMIT_CAP). Title from renderTitle. */
  issues: PlannedCleanupIssue[];
  /** Findings dropped before emit, with the reason. */
  dropped: DroppedCleanupFinding[];
  /** Raw finding count straight out of parseKnipReport (pre-filter). */
  rawCount: number;
}

/**
 * Decide whether a finding is dropped by the high-confidence filter (playbook
 * Step 2), returning the drop reason or null to keep. validateFinding (the
 * blank-title guard) runs FIRST and is the single chokepoint — a finding with
 * an empty name/path can never reach render.
 */
function filterReason(finding: CleanupFinding): string | null {
  const invalid = validateFinding(finding);
  if (invalid) return invalid; // blank-title guard (#1167) — runs first, HARD

  const path = finding.path;
  if (VERIFIER_CORE_SUBSTRINGS.some((p) => path.includes(p))) {
    return "verifier-core (operator-only)";
  }
  if (path.includes(".test.") || path.includes(".spec.") || path.endsWith(".d.ts")) {
    return "test-only / type-declaration file";
  }
  if (path === "src/index.ts") {
    return "public entrypoint (src/index.ts)";
  }
  return null;
}

/**
 * The PURE emit planner: parse → validate+filter → classify → dedup → render,
 * returning the deterministic plan. Performs NO I/O — `readSource` is injected
 * so the planner stays pure and testable; the CLI passes a real fs reader, a
 * test passes a stub map.
 *
 * `readSource(path)` returns the file's source text (for the demote-vs-delete
 * classification), or `""` when the file can't be read — in which case the
 * finding's fix is left `unknown` and the body falls back to the full probe.
 *
 * Crucially the TITLE for each planned issue is produced ONLY by renderTitle()
 * from the same finding the body is rendered from — there is no second pass and
 * no hand-built title, so the #1449 title/body divergence is structurally
 * impossible.
 */
export function planCleanupEmit(
  report: KnipReport,
  openIssueTitles: string[],
  readSource: (path: string) => string,
  isoDate: string,
  cap: number = EMIT_CAP,
): CleanupEmitPlan {
  const raw = parseKnipReport(report);
  const dropped: DroppedCleanupFinding[] = [];

  // 1. Validate + high-confidence filter.
  const kept: CleanupFinding[] = [];
  for (const finding of raw) {
    const reason = filterReason(finding);
    if (reason) {
      dropped.push({ finding, reason });
      continue;
    }
    kept.push(finding);
  }

  // 2. Classify export findings demote-vs-delete from their own source (#1449).
  const classified: CleanupFinding[] = kept.map((finding) => {
    if (finding.kind !== "export") return finding;
    const src = readSource(finding.path);
    return { ...finding, fix: classifyExportFix(finding, src) };
  });

  // 3. Dedup against the open board AND within this batch (identity-keyed).
  const { kept: deduped, dropped: dups } = dedupAgainstOpen(classified, openIssueTitles);
  for (const finding of dups) {
    dropped.push({ finding, reason: "duplicate of an open cleanup-scan issue (or in-batch dup)" });
  }

  // 4. Rank whole-file deletions ahead of single-export deletions (they reclaim
  //    the most surface), then cap. Stable within each kind (input order).
  const ranked = [...deduped].sort((a, b) => {
    if (a.kind === b.kind) return 0;
    return a.kind === "file" ? -1 : 1;
  });
  const toEmit = ranked.slice(0, cap);
  for (const finding of ranked.slice(cap)) {
    dropped.push({ finding, reason: `over the per-run cap of ${cap}` });
  }

  // 5. Render title + body from the SAME finding, in ONE pass. No hand-built
  //    title, no index-aligned second loop — the #1449 / #1005 drift guard.
  const issues: PlannedCleanupIssue[] = toEmit.map((finding) => ({
    finding,
    title: renderTitle(finding),
    body: renderBody(finding, isoDate),
  }));

  return { issues, dropped, rawCount: raw.length };
}

// ---------------------------------------------------------------------------
// Thin CLI wrapper (the only part that touches fs / gh).
// ---------------------------------------------------------------------------

const REPO = "gaberoo322/hydra";

function readBoardTitles(): string[] {
  try {
    const out = execFileSync(
      "gh",
      ["issue", "list", "--repo", REPO, "--state", "open", "--label", "cleanup-scan", "--json", "title", "--limit", "100"],
      { encoding: "utf-8" },
    );
    const parsed = JSON.parse(out) as Array<{ title?: unknown }>;
    return parsed.map((i) => (typeof i.title === "string" ? i.title : "")).filter(Boolean);
  } catch (err) {
    console.error(
      "hydra-cleanup-emit: failed to read the open cleanup-scan board via gh — aborting (cannot dedup safely):",
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  }
}

function createIssue(title: string, body: string): void {
  execFileSync(
    "gh",
    [
      "issue",
      "create",
      "--repo",
      REPO,
      "--title",
      title,
      "--label",
      "cleanup-scan",
      "--label",
      "ready-for-agent",
      "--body-file",
      "-",
    ],
    { input: body, encoding: "utf-8", stdio: ["pipe", "inherit", "inherit"] },
  );
}

function main(argv: string[]): void {
  const args = argv.slice(2);
  const apply = args.includes("--apply");
  const reportPath = args.find((a) => !a.startsWith("--")) ?? "/tmp/knip-report.json";

  if (!existsSync(reportPath)) {
    console.error(`hydra-cleanup-emit: knip report not found at ${reportPath}. Run \`npx knip --reporter json --no-exit-code > ${reportPath}\` first.`);
    process.exit(1);
  }

  let report: KnipReport;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf-8")) as KnipReport;
  } catch (err) {
    console.error(`hydra-cleanup-emit: failed to parse ${reportPath} as JSON:`, err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const openTitles = readBoardTitles();
  if (openTitles.length > 10) {
    console.log(`hydra-cleanup-emit: board saturated (${openTitles.length} open cleanup-scan issues > 10 cap) — emitting nothing.`);
    process.exit(0);
  }

  const isoDate = new Date().toISOString().slice(0, 10);
  const readSource = (p: string): string => {
    try {
      return existsSync(p) ? readFileSync(p, "utf-8") : "";
    } catch {
      return ""; // classification falls back to the full probe on a read miss
    }
  };

  const plan = planCleanupEmit(report, openTitles, readSource, isoDate);

  console.log(`hydra-cleanup-emit — Orchestrator (~/hydra) — ${new Date().toISOString()} — ${apply ? "apply" : "dry-run"}`);
  console.log("");
  console.log(`knip raw findings:   ${plan.rawCount}`);
  console.log(`After filter+dedup:  ${plan.issues.length} to emit (cap ${EMIT_CAP})`);
  console.log(`Dropped:             ${plan.dropped.length}`);
  console.log("");

  for (const issue of plan.issues) {
    const fix = issue.finding.kind === "export" ? ` [fix: ${issue.finding.fix ?? "unknown"}]` : "";
    console.log(`• ${issue.title}${fix}`);
    if (!apply) {
      console.log("  --- body ---");
      console.log(issue.body.replace(/^/gm, "  "));
      console.log("");
    } else {
      createIssue(issue.title, issue.body);
      console.log("  ✓ filed");
    }
  }

  if (!apply) {
    console.log("");
    console.log("(dry-run; no GitHub issues created — pass --apply to file them)");
  }
}

// Only run when executed directly (not when imported by the test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv);
}
