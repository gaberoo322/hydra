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

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { posix as posixPath } from "node:path";
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
  type PullRequestRef,
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
 * Trailing window for merged-PR dedup (issue #1766, default 24h). A finding
 * whose path was changed by a PR merged within this window is suppressed: the
 * motivating 2026-06-11 incident filed dup batch #1747–#1755 at 15:57Z when
 * ALL covering fix PRs (#1719/#1720/#1722/#1723/#1743) had already MERGED
 * (11:30–11:40Z and 15:26Z) — an open-PR-only check would have caught nothing,
 * so the dedup surface must include just-merged PRs the knip report may
 * predate. 24h comfortably covers a stale-report race at the 1h scan cadence
 * while keeping the suppression horizon short (one day's PRs).
 */
export const MERGED_PR_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Max age of the knip report the runner will consume (issue #1766, ~60 min).
 * The 15:57Z dup wave reproduced the 10:40Z batch title-for-title HOURS after
 * the fixes merged — the signature of a stale /tmp/knip-report.json (or a
 * skipped fresh-base fetch) feeding the emit. A report older than one scan
 * cadence (1h) cannot be trusted to reflect origin/master; fail loud with a
 * re-run instruction rather than filing findings a merged PR already fixed.
 */
export const KNIP_REPORT_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Keep only the PR refs that belong in the dedup surface at `nowMs` (issue
 * #1766, pure): every OPEN PR (no `mergedAt`), plus every merged PR whose
 * `mergedAt` parses and lies within the trailing window. A merged ref with an
 * unparseable timestamp is excluded — coverage cannot be asserted for it.
 *
 * This is the single time-aware decision of the #1766 mechanism; it runs in
 * the impure CLI shell's data path so dedupAgainstOpen (and planCleanupEmit)
 * stay deterministic and time-free.
 */
export function filterPrsInDedupWindow(
  prs: ReadonlyArray<PullRequestRef>,
  nowMs: number,
  windowMs: number = MERGED_PR_DEDUP_WINDOW_MS,
): PullRequestRef[] {
  return prs.filter((pr) => {
    if (pr.mergedAt === undefined) return true; // open PR — always covering
    const merged = Date.parse(pr.mergedAt);
    return !Number.isNaN(merged) && nowMs - merged <= windowMs;
  });
}

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
 * Resolve the namespace-import targets of one source file (issue #1737, pure).
 *
 * Finds every `import * as <ns> from "<spec>"` in `source` and resolves each
 * RELATIVE spec against the importer's directory to a repo-rooted path. Bare
 * package specifiers (`@sentry/node`, `zod`) are skipped — only repo-local
 * modules can be cleanup-finding targets. Extension handling is deliberately
 * generous (string-only, no fs probing, so the helper stays pure): a `.js` /
 * `.mjs` / `.jsx` spec additionally yields its TS twin, and an extensionless
 * spec yields `.ts` / `.mts` / `/index.ts` candidates — knip reports findings
 * against the on-disk TS path, so the candidate set just has to contain it.
 */
export function resolveNamespaceImportTargets(importerPath: string, source: string): string[] {
  const targets: string[] = [];
  const namespaceImportRe = /import\s*\*\s*as\s+[A-Za-z_$][\w$]*\s+from\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(namespaceImportRe)) {
    const spec = match[1];
    if (!spec.startsWith("./") && !spec.startsWith("../")) continue; // bare package specifier
    const resolved = posixPath.normalize(posixPath.join(posixPath.dirname(importerPath), spec));
    const extension = /\.([cm]?[jt]sx?)$/.exec(resolved)?.[1];
    if (extension === undefined) {
      targets.push(`${resolved}.ts`, `${resolved}.mts`, `${resolved}/index.ts`);
    } else {
      targets.push(resolved);
      const tsTwin = resolved.replace(/\.js$/, ".ts").replace(/\.mjs$/, ".mts").replace(/\.jsx$/, ".tsx");
      if (tsTwin !== resolved) targets.push(tsTwin);
    }
  }
  return targets;
}

/**
 * Drop reason for an export finding whose module is consumed via a namespace
 * import (issue #1737). Machine-readable family name first so the dropped
 * audit list groups the suppression with its recurrence cue.
 */
const NAMESPACE_FACADE_DROP_REASON =
  "namespace-import / DI-facade consumer — knip loses per-export liveness through `import * as` folded into a deps.x ?? defaultX facade (#1737)";

/**
 * Decide whether a finding is dropped by the high-confidence filter (playbook
 * Step 2), returning the drop reason or null to keep. validateFinding (the
 * blank-title guard) runs FIRST and is the single chokepoint — a finding with
 * an empty name/path can never reach render.
 *
 * `namespaceConsumedModules` (issue #1737) is the set of repo-rooted module
 * paths consumed somewhere via `import * as` — knip's per-export liveness for
 * those modules is untrustworthy wholesale (the namespace object escapes
 * through DI facades like `deps.redis ?? defaultRedis`), so EXPORT findings
 * against them are dropped with an audit reason. File-kind findings are
 * unaffected: a namespace-imported file is never flagged as an unused file.
 */
function filterReason(
  finding: CleanupFinding,
  namespaceConsumedModules: ReadonlySet<string>,
): string | null {
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
  if (finding.kind === "export" && namespaceConsumedModules.has(path)) {
    return NAMESPACE_FACADE_DROP_REASON; // #1737 false-positive family
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
 *
 * `namespaceConsumedModules` (issue #1737, OPTIONAL — an absent/empty set
 * degrades to the pre-#1737 behavior, never a crash) is computed by the CLI
 * wrapper (`collectNamespaceConsumedModules`) and injected so the planner
 * stays pure: export findings against a module consumed via `import * as`
 * anywhere in src/ or scripts/ are dropped in the step-1 filter — knip cannot
 * attribute member usage once the namespace object escapes through a
 * `deps.x ?? defaultX` DI facade, so those findings are the false-positive
 * family that burnt 11/15 findings on #1724.
 *
 * `coveringPrs` (issue #1766, OPTIONAL — an absent/empty list degrades to the
 * pre-#1766 behavior, never a crash) is fetched by the CLI wrapper
 * (`readCoveringPrs`: open PRs + PRs merged within MERGED_PR_DEDUP_WINDOW_MS,
 * already window-filtered via filterPrsInDedupWindow) and injected, mirroring
 * the #1737 parameter shape. A finding whose path is in the changed files of
 * any provided PR is dropped in step 3 with a reason citing the covering PR
 * number(s) — an in-flight or just-merged sibling fix means the finding is
 * (or is about to be) resolved, and re-filing it is the #1747–#1755 dup wave.
 */
export function planCleanupEmit(
  report: KnipReport,
  openIssues: Array<string | OpenIssueRef>,
  readSource: (path: string) => string,
  isoDate: string,
  cap: number = EMIT_CAP,
  symbolsPerBatch: number = SYMBOLS_PER_BATCH,
  namespaceConsumedModules: ReadonlySet<string> = new Set(),
  coveringPrs: ReadonlyArray<PullRequestRef> = [],
): CleanupEmitPlan {
  const raw = parseKnipReport(report);
  const dropped: DroppedCleanupFinding[] = [];

  // 1. Validate + high-confidence filter.
  const kept: CleanupFinding[] = [];
  for (const finding of raw) {
    const reason = filterReason(finding, namespaceConsumedModules);
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

  // 3. Dedup against the open board AND within this run (identity-keyed),
  //    AND against covering PRs (path-keyed, #1766). Identities are recovered
  //    from legacy titles AND batch body manifests (#1653), so both issue
  //    generations dedup correctly; PR coverage drops a finding whose path an
  //    open / recently-merged PR changed, citing the covering PR number(s) —
  //    never silently.
  const { kept: deduped, dropped: dups, prCovered } = dedupAgainstOpen(
    classified,
    openIssues,
    coveringPrs,
  );
  for (const finding of dups) {
    dropped.push({ finding, reason: "duplicate of an open cleanup-scan issue (or in-batch dup)" });
  }
  for (const { finding, prs } of prCovered) {
    const cites = prs.map((pr) =>
      pr.mergedAt === undefined
        ? `open PR #${pr.number}`
        : `recently-merged PR #${pr.number} (merged ${pr.mergedAt})`,
    );
    dropped.push({
      finding,
      reason: `covered by ${cites.join(" + ")} — ${finding.path.trim()} is in its changed files (#1766)`,
    });
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

  const batches: Array<{
    moduleDir: string;
    findings: CleanupFinding[];
    chunkIndex: number;
    totalChunks: number;
  }> = [];
  for (const [moduleDir, group] of groups) {
    // Invariant 6 (#1653 forward-fix): whole files first, then an explicit
    // (path, name) sort within each kind — chunk boundaries are deterministic
    // across runs and machines, never dependent on knip's output order.
    const ordered = [...group].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "file" ? -1 : 1;
      if (a.path !== b.path) return a.path.localeCompare(b.path);
      return a.name.localeCompare(b.name);
    });
    const totalChunks = Math.ceil(ordered.length / symbolsPerBatch);
    for (let i = 0; i < ordered.length; i += symbolsPerBatch) {
      batches.push({
        moduleDir,
        findings: ordered.slice(i, i + symbolsPerBatch),
        chunkIndex: i / symbolsPerBatch + 1,
        totalChunks,
      });
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
  //    An UNSPLIT 1-finding batch keeps the legacy single-finding format (its
  //    identity lives in the title); every other batch — including a 1-finding
  //    remainder chunk of a SPLIT module (Invariant 6: all chunks of a split
  //    carry the [i/k] suffix) — renders the checklist body whose identities
  //    live in the cleanup-identities manifest.
  const issues: PlannedCleanupIssue[] = toEmit.map(({ moduleDir, findings, chunkIndex, totalChunks }) =>
    findings.length === 1 && totalChunks === 1
      ? {
          moduleDir,
          findings,
          title: renderTitle(findings[0]),
          body: renderBody(findings[0], isoDate),
        }
      : {
          moduleDir,
          findings,
          title: renderBatchTitle(moduleDir, findings, { index: chunkIndex, total: totalChunks }),
          body: renderBatchBody(moduleDir, findings, isoDate, { index: chunkIndex, total: totalChunks }),
        },
  );

  return { issues, dropped, rawCount: raw.length };
}

// ---------------------------------------------------------------------------
// Thin CLI wrapper (the only part that touches fs / gh).
// ---------------------------------------------------------------------------

const REPO = "gaberoo322/hydra";

/**
 * Scan src/ and scripts/ for `import * as` consumers and return the set of
 * repo-rooted module paths they consume (issue #1737). Runs in the impure CLI
 * shell — the result is injected into {@link planCleanupEmit} so the planner
 * stays pure (mirrors the injected readSource).
 */
function collectNamespaceConsumedModules(): Set<string> {
  const consumed = new Set<string>();
  for (const root of ["src", "scripts"]) {
    if (!existsSync(root)) continue;
    let entries: string[];
    try {
      entries = readdirSync(root, { recursive: true, encoding: "utf-8" });
    } catch (err) {
      console.error(
        `hydra-cleanup-emit: failed to scan ${root}/ for namespace-import consumers (#1737 probe degrades to empty for this root):`,
        err instanceof Error ? err.message : String(err),
      );
      continue;
    }
    for (const entry of entries) {
      if (!/\.(ts|mts)$/.test(entry)) continue;
      const filePath = posixPath.join(root, entry);
      let source: string;
      try {
        source = readFileSync(filePath, "utf-8");
      } catch {
        continue; /* intentional: an unreadable file contributes no consumers; missing a consumer only re-admits a knip finding, never breaks the emit */
      }
      for (const target of resolveNamespaceImportTargets(filePath, source)) consumed.add(target);
    }
  }
  return consumed;
}

/**
 * Fetch the covering-PR dedup surface (issue #1766): every OPEN PR plus every
 * PR merged within MERGED_PR_DEDUP_WINDOW_MS of `nowMs`, each expanded to its
 * changed-file paths. The result is already window-filtered (via the pure
 * filterPrsInDedupWindow) and ready to inject into {@link planCleanupEmit}.
 *
 * Uses `gh api repos/...` REST deliberately — the GraphQL pool that backs
 * `gh pr list --json` gets exhausted under a running autopilot, and a failed
 * fetch here ABORTS the emit (fail loud, mirroring readBoardIssues): an emit
 * that cannot dedup against in-flight/just-merged fixes safely must emit
 * nothing, because degrading to an empty PR set silently re-opens the exact
 * duplicate-wave hole (#1747–#1755) this surface exists to close.
 */
function readCoveringPrs(nowMs: number): PullRequestRef[] {
  try {
    // --jq projects the payload down to the consumed fields BEFORE it reaches
    // this process — a raw 100-entry PR page (full bodies included) blows past
    // execFileSync's default 1 MiB stdout buffer (ENOBUFS). The raised
    // maxBuffer is belt-and-braces on top.
    const fetchJson = (path: string, jq: string): unknown =>
      JSON.parse(
        execFileSync("gh", ["api", path, "--jq", jq], {
          encoding: "utf-8",
          maxBuffer: 16 * 1024 * 1024,
        }),
      );

    const candidates: PullRequestRef[] = [];
    const openRaw = fetchJson(`repos/${REPO}/pulls?state=open&per_page=100`, "[.[] | {number}]");
    for (const pr of Array.isArray(openRaw) ? openRaw : []) {
      const number = (pr as { number?: unknown }).number;
      if (typeof number === "number") candidates.push({ number, paths: [] });
    }
    // Closed PRs sorted by most-recently-updated: a PR merged within the last
    // 24h is necessarily near the top, so one 100-entry page covers the window.
    const closedRaw = fetchJson(
      `repos/${REPO}/pulls?state=closed&sort=updated&direction=desc&per_page=100`,
      "[.[] | {number, merged_at}]",
    );
    for (const pr of Array.isArray(closedRaw) ? closedRaw : []) {
      const number = (pr as { number?: unknown }).number;
      const mergedAt = (pr as { merged_at?: unknown }).merged_at;
      if (typeof number !== "number" || typeof mergedAt !== "string") continue; // closed-unmerged
      candidates.push({ number, paths: [], mergedAt });
    }

    const covering = filterPrsInDedupWindow(candidates, nowMs);
    for (const ref of covering) {
      const filesRaw = fetchJson(`repos/${REPO}/pulls/${ref.number}/files?per_page=100`, "[.[].filename]");
      ref.paths = (Array.isArray(filesRaw) ? filesRaw : [])
        .map((f) => (typeof f === "string" ? f : ""))
        .filter((p) => p.length > 0);
    }
    return covering;
  } catch (err) {
    console.error(
      "hydra-cleanup-emit: failed to read open/recently-merged PRs via gh REST — aborting (cannot dedup against in-flight fixes safely, #1766):",
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  }
}

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
      // Cleanup-scan findings are mechanically-verifiable dead-code deletions that
      // never go through hydra-grill, so they carry no design-concept artifact.
      // The design-concept-exempt label tells hydra-qa to skip the Spec axis rather
      // than logging a QA resolve MISS and falling through in Phase A shadow mode
      // (issue #3013).
      "--label",
      "design-concept-exempt",
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

  // Staleness guard (#1766): a knip report older than one scan cadence cannot
  // be trusted to reflect origin/master — the 2026-06-11 dup wave reproduced a
  // 5-hour-old batch title-for-title, the signature of a stale report feeding
  // the emit. Refuse it loudly rather than filing already-fixed findings.
  const reportAgeMs = Date.now() - statSync(reportPath).mtimeMs;
  if (reportAgeMs > KNIP_REPORT_MAX_AGE_MS) {
    console.error(
      `hydra-cleanup-emit: knip report at ${reportPath} is ${Math.round(reportAgeMs / 60_000)} min old (max ${KNIP_REPORT_MAX_AGE_MS / 60_000} min, #1766) — a stale report re-files findings already fixed on master. Re-fetch origin/master (playbook Step 1) and re-run \`npx knip --reporter json --no-exit-code > ${reportPath}\` first.`,
    );
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

  const coveringPrs = readCoveringPrs(Date.now());

  const plan = planCleanupEmit(
    report,
    openIssues,
    readSource,
    isoDate,
    EMIT_CAP,
    SYMBOLS_PER_BATCH,
    collectNamespaceConsumedModules(),
    coveringPrs,
  );
  const plannedFindings = plan.issues.reduce((n, i) => n + i.findings.length, 0);
  const prCoveredDrops = plan.dropped.filter((d) => /covered by .*PR #/.test(d.reason));

  console.log(`hydra-cleanup-emit — Orchestrator (~/hydra) — ${new Date().toISOString()} — ${apply ? "apply" : "dry-run"}`);
  console.log("");
  console.log(`knip raw findings:   ${plan.rawCount}`);
  console.log(`PR dedup surface:    ${coveringPrs.length} PR(s) (open + merged within ${MERGED_PR_DEDUP_WINDOW_MS / 3_600_000}h, #1766)`);
  console.log(`After filter+dedup:  ${plan.issues.length} batch issue(s) covering ${plannedFindings} finding(s) (cap ${EMIT_CAP} issues, ≤${SYMBOLS_PER_BATCH} findings each)`);
  console.log(`Dropped:             ${plan.dropped.length}${prCoveredDrops.length ? ` (${prCoveredDrops.length} covered by in-flight/just-merged PRs)` : ""}`);
  for (const drop of prCoveredDrops) {
    console.log(`  ↳ ${drop.reason}`);
  }
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
