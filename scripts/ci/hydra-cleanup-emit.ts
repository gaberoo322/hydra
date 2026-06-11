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
  renderBatchTitle,
  renderBatchBody,
  moduleDirKey,
  dedupAgainstOpen,
  type CleanupFinding,
  type KnipReport,
  type OpenIssueRef,
} from "./hydra-cleanup-render.ts";

/**
 * Max issues a single cleanup run files. Since #1653 an "issue" is a BATCH
 * (one module dir, up to SYMBOLS_PER_BATCH findings), so the cap counts batch
 * issues — 8 batches can cover ~150 findings, which is the point.
 */
export const EMIT_CAP = 8;

/**
 * Max findings folded into one batch issue (issue #1653). A 70-finding module
 * (src/schemas at the time of writing) splits into reviewable chunks instead
 * of one unreviewable wall — the largest single-batch precedent that cleared
 * the merge gate is 16 exports (PR #1549), so ~20 keeps each PR in the proven
 * reviewable range while still collapsing the per-symbol churn.
 */
export const SYMBOLS_PER_BATCH = 20;

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

/**
 * One issue that survived the full pipeline and will be emitted. Since #1653
 * an issue covers a BATCH of findings sharing one module dir (`moduleDir` is
 * the moduleDirKey the batch grouped on). A batch of exactly one finding is
 * rendered in the legacy single-finding format (renderTitle/renderBody) so
 * the long tail of 1-finding modules keeps the proven shape; multi-finding
 * batches render the checklist + identity-manifest body (renderBatchBody).
 */
export interface PlannedCleanupIssue {
  moduleDir: string;
  findings: CleanupFinding[];
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
  openIssues: Array<string | OpenIssueRef>,
  readSource: (path: string) => string,
  isoDate: string,
  cap: number = EMIT_CAP,
  symbolsPerBatch: number = SYMBOLS_PER_BATCH,
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

  // 3. Dedup against the open board AND within this run (identity-keyed).
  //    Identities are recovered from legacy titles AND batch body manifests
  //    (#1653), so both issue generations dedup correctly.
  const { kept: deduped, dropped: dups } = dedupAgainstOpen(classified, openIssues);
  for (const finding of dups) {
    dropped.push({ finding, reason: "duplicate of an open cleanup-scan issue (or in-batch dup)" });
  }

  // 4. BATCH (issue #1653): group per-symbol findings by module dir — the
  //    granularity flip happens HERE, at the render boundary, so every guard
  //    above (validate/filter/classify/dedup) stayed per-symbol. Within each
  //    group, whole-file deletions lead the checklist (they reclaim the most
  //    surface); groups over symbolsPerBatch split into reviewable chunks.
  const groups = new Map<string, CleanupFinding[]>();
  for (const finding of deduped) {
    const key = moduleDirKey(finding.path);
    groups.set(key, [...(groups.get(key) ?? []), finding]);
  }

  const batches: Array<{ moduleDir: string; findings: CleanupFinding[] }> = [];
  for (const [moduleDir, group] of groups) {
    const ordered = [...group].sort((a, b) => {
      if (a.kind === b.kind) return 0;
      return a.kind === "file" ? -1 : 1; // whole files first, stable otherwise
    });
    for (let i = 0; i < ordered.length; i += symbolsPerBatch) {
      batches.push({ moduleDir, findings: ordered.slice(i, i + symbolsPerBatch) });
    }
  }

  //    Rank batches: most whole-file deletions first, then biggest harvest,
  //    then module dir for a deterministic plan. Cap counts BATCH issues.
  batches.sort((a, b) => {
    const aFiles = a.findings.filter((f) => f.kind === "file").length;
    const bFiles = b.findings.filter((f) => f.kind === "file").length;
    if (aFiles !== bFiles) return bFiles - aFiles;
    if (a.findings.length !== b.findings.length) return b.findings.length - a.findings.length;
    return a.moduleDir < b.moduleDir ? -1 : a.moduleDir > b.moduleDir ? 1 : 0;
  });
  const toEmit = batches.slice(0, cap);
  for (const batch of batches.slice(cap)) {
    for (const finding of batch.findings) {
      dropped.push({ finding, reason: `over the per-run cap of ${cap} batch issues` });
    }
  }

  // 5. Render title + body from the SAME findings, in ONE pass. No hand-built
  //    title, no index-aligned second loop — the #1449 / #1005 drift guard.
  //    A 1-finding batch keeps the legacy single-finding format (its identity
  //    lives in the title); a multi-finding batch renders the checklist body
  //    whose identities live in the cleanup-identities manifest.
  const issues: PlannedCleanupIssue[] = toEmit.map(({ moduleDir, findings }) =>
    findings.length === 1
      ? {
          moduleDir,
          findings,
          title: renderTitle(findings[0]),
          body: renderBody(findings[0], isoDate),
        }
      : {
          moduleDir,
          findings,
          title: renderBatchTitle(moduleDir, findings),
          body: renderBatchBody(moduleDir, findings, isoDate),
        },
  );

  return { issues, dropped, rawCount: raw.length };
}

// ---------------------------------------------------------------------------
// Thin CLI wrapper (the only part that touches fs / gh).
// ---------------------------------------------------------------------------

const REPO = "gaberoo322/hydra";

function readBoardIssues(): OpenIssueRef[] {
  try {
    const out = execFileSync(
      "gh",
      ["issue", "list", "--repo", REPO, "--state", "open", "--label", "cleanup-scan", "--json", "title,body", "--limit", "100"],
      { encoding: "utf-8" },
    );
    const parsed = JSON.parse(out) as Array<{ title?: unknown; body?: unknown }>;
    return parsed
      .filter((i) => typeof i.title === "string" && i.title.length > 0)
      .map((i) => ({
        title: i.title as string,
        body: typeof i.body === "string" ? i.body : undefined,
      }));
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

  const openIssues = readBoardIssues();
  if (openIssues.length > 10) {
    console.log(`hydra-cleanup-emit: board saturated (${openIssues.length} open cleanup-scan issues > 10 cap) — emitting nothing.`);
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

  const plan = planCleanupEmit(report, openIssues, readSource, isoDate);
  const plannedFindings = plan.issues.reduce((n, i) => n + i.findings.length, 0);

  console.log(`hydra-cleanup-emit — Orchestrator (~/hydra) — ${new Date().toISOString()} — ${apply ? "apply" : "dry-run"}`);
  console.log("");
  console.log(`knip raw findings:   ${plan.rawCount}`);
  console.log(`After filter+dedup:  ${plan.issues.length} batch issue(s) covering ${plannedFindings} finding(s) (cap ${EMIT_CAP} issues, ≤${SYMBOLS_PER_BATCH} findings each)`);
  console.log(`Dropped:             ${plan.dropped.length}`);
  console.log("");

  for (const issue of plan.issues) {
    const verdicts = issue.findings
      .filter((f) => f.kind === "export")
      .reduce<Record<string, number>>((acc, f) => {
        const fix = f.fix ?? "unknown";
        acc[fix] = (acc[fix] ?? 0) + 1;
        return acc;
      }, {});
    const fix = Object.keys(verdicts).length
      ? ` [fix: ${Object.entries(verdicts).map(([k, v]) => `${k}×${v}`).join(", ")}]`
      : "";
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
