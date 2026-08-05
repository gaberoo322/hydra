/**
 * scripts/ci/hydra-target-cleanup-emit.ts — Deterministic emit runner for the
 * `hydra-target-cleanup` skill: the TARGET mirror of hydra-cleanup-emit.ts.
 *
 * Scope: the demote-only dead-export sweep over the Target
 * (~/hydra-betting/web) — step 2 of the Target's dead-code cleanup plan. The
 * Target's CLAUDE.md (rule 3 + "Dead-code ratchet" section, shipped with the
 * ratchet in hydra-betting PR #93) authorises cleanup commits ONLY when they
 * cite a `npm run deadcode` finding, the code is past the 45-day wiring grace
 * period, and `src/lib/providers/` is demote-only. This runner enforces every
 * one of those constraints at EMIT time, so a picked-up item can never ask an
 * agent to do something the Target's own policy forbids:
 *
 *   - DEMOTE-ONLY: only export findings classified `demote` by
 *     classifyExportFix() (still referenced within their own file) are emitted.
 *     `delete`-class findings and whole-file findings are counted and dropped —
 *     they belong to the later wire-or-retire phase, not this sweep.
 *   - WIRING GRACE: a finding whose file was touched within the last
 *     WIRING_GRACE_DAYS (45) is dropped — Hydra builds modules first and wires
 *     them later, so young dead exports are usually wiring-in-flight. An
 *     unknown file age fails closed (dropped).
 *   - PROVIDERS: demoting is allowed everywhere including src/lib/providers/
 *     (rule 1 forbids file deletion there, not visibility demotion).
 *
 * Findings sink: GitHub Issues on gaberoo322/hydra-betting (ADR-0031) via
 * `gh issue create` — the Target's tracker is the GitHub-Issues board, not
 * the Redis backlog. Items are filed with labels [cleanup-scan, ready-for-agent].
 * Dedup and saturation checks use lexical `gh issue list --search` (REST-first).
 *
 * ONE ITEM PER FILE, not per symbol. Two reasons:
 *   1. addToBacklog() fuzzy-dedups on title word overlap (70%); per-symbol
 *      titles ("cleanup(target): demote unused export `A` (path)") differ in
 *      only one word, so sibling findings would reject each other. Per-file
 *      titles lead with the first symbol name, keeping cross-file overlap
 *      under the threshold.
 *   2. The picking agent ships one small PR per file — all demotes in a file
 *      are one coherent finding-set with one baseline tightening.
 *
 * The PURE core is {@link planTargetCleanupEmit} (no fs / network / process) —
 * source text, file age, and the open board are injected, so the full
 * parse → classify → grace → group → dedup → render plan unit-tests directly
 * (test/hydra-target-cleanup-emit.test.mts). Only the thin CLI wrapper at the
 * bottom touches fs, git (file age), and the orchestrator API.
 *
 * Usage (the playbook invokes this, NOT a hand-rolled loop — the #1449 lesson):
 *
 *   # dry-run: prints the plan (titles + bodies) and files nothing
 *   npx tsx scripts/ci/hydra-target-cleanup-emit.ts /tmp/knip-target-report.json
 *
 *   # apply: files one cleanup-scan + ready-for-agent GitHub issue per file on hydra-betting
 *   npx tsx scripts/ci/hydra-target-cleanup-emit.ts /tmp/knip-target-report.json --apply
 */

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  parseKnipReport,
  validateFinding,
  classifyExportFix,
  type CleanupFinding,
  type KnipReport,
} from "./hydra-cleanup-render.ts";

/** Max backlog items (= files) a single target cleanup run files. */
export const TARGET_EMIT_CAP = 8;

/** Open cleanup-scan items above this → the run emits nothing (anti-flood). */
export const TARGET_SATURATION_CAP = 10;

/** The Target CLAUDE.md wiring grace period: younger files are never swept. */
export const WIRING_GRACE_DAYS = 45;

/**
 * Introduction-anchored deferral ceiling (issue #3727) — two full grace
 * windows. The last-touch scalar alone is non-monotonic: any commit
 * (relocation, docs, cleanup) resets it, so a condemned module can be
 * shielded forever by its own migration commits. A file only defers on
 * grace when it is BOTH recently touched AND young by introduction; once a
 * file's introduction crosses this ceiling, no later commit of any intent
 * can push the deferral back — see the gate predicate in
 * planTargetCleanupEmit(). Deliberately NOT equal to WIRING_GRACE_DAYS: an
 * equal ceiling would collapse to "any relocation removes grace entirely."
 */
export const WIRING_GRACE_CEILING_DAYS = 90;

/** Label stamped on every emitted item — the saturation/dedup count seam. */
export const CLEANUP_SCAN_LABEL = "cleanup-scan";

export const TARGET_ROOT = "/home/gabe/hydra-betting";
export const TARGET_WEB = `${TARGET_ROOT}/web`;
export const TARGET_REPO = "gaberoo322/hydra-betting";

/**
 * The widened age probe for one file (issue #3727) — replaces the old
 * `(path) => number | null` last-touch scalar. One `git log --follow`
 * invocation yields all three fields: `lastTouchDays` (first line — same
 * value the old scalar returned, --follow is a no-op on the newest commit),
 * `introDays` (last line — the file's TRUE introduction date, resolved
 * across renames), and `resetCommit` (the last-touch commit's short SHA +
 * subject, i.e. what most recently reset the last-touch clock — for the
 * grace-drop audit trail). Any field is null when unknown (fail-closed).
 */
export interface FileAgeProbe {
  /** Days since the most recent commit touching the current path, or null. */
  lastTouchDays: number | null;
  /** Days since the file's earliest commit under --follow (introduction), or null. */
  introDays: number | null;
  /** The last-touch commit — what reset the clock. Null iff lastTouchDays is null. */
  resetCommit: { shortSha: string; subject: string } | null;
}

/** One planned backlog item: every demote-class symbol in one target file. */
export interface PlannedTargetCleanupItem {
  /** web-relative file path as knip reports it (e.g. "src/lib/foo.ts"). */
  path: string;
  /** Demote-class symbols in this file, in knip report order. */
  symbols: string[];
  /** Days since the last commit touching the file (>= WIRING_GRACE_DAYS). */
  ageDays: number;
  title: string;
  body: string;
}

/** A finding dropped before emit, with the reason (for the audit report). */
export interface DroppedTargetCleanupFinding {
  finding: CleanupFinding;
  reason: string;
}

/** The deterministic emit plan {@link planTargetCleanupEmit} returns. */
export interface TargetCleanupEmitPlan {
  /** Items to file, in emit order (length ≤ cap). One per file. */
  items: PlannedTargetCleanupItem[];
  /** Findings dropped before emit, with the reason. */
  dropped: DroppedTargetCleanupFinding[];
  /** Raw finding count straight out of parseKnipReport (pre-filter). */
  rawCount: number;
}

/**
 * Render the backlog item title for one file's demote batch. The first symbol
 * leads the title (it is what keeps cross-file fuzzy-title overlap low — see
 * the module comment), the full web-relative path closes it (it is what
 * {@link identityFromOpenItemTitle} recovers for dedup).
 */
export function renderTargetTitle(path: string, symbols: string[]): string {
  if (!path.trim() || symbols.length === 0 || !symbols[0].trim()) {
    throw new Error(
      `renderTargetTitle: refusing to render an empty path/symbol batch (path=${JSON.stringify(path)})`,
    );
  }
  const rest = symbols.length > 1 ? ` +${symbols.length - 1} more` : "";
  return `cleanup(target): demote \`${symbols[0]}\`${rest} in ${path.trim()}`;
}

/**
 * Recover the file-path identity from an already-open cleanup-scan backlog
 * item title (the dedup seam, mirroring identityFromOpenIssueTitle). Dedup is
 * per FILE: while any cleanup item for a path is open, no new item for that
 * path is filed. Returns null for a title that does not parse.
 */
export function identityFromOpenItemTitle(title: string): string | null {
  const m = title
    .trim()
    .match(/^cleanup\(target\): demote\s+`[^`]+`(?:\s+\+\d+ more)?\s+in\s+(\S+)$/);
  if (!m) return null;
  const path = m[1].trim();
  return path ? path : null;
}

/**
 * Render the backlog item description for one file's demote batch. Title and
 * body come from the SAME (path, symbols) group in one pass — the #1449/#1005
 * title/body drift guard carried over from the orch emitter.
 *
 * The body is what the picking hydra-target-build agent reads, so it carries
 * the Target policy verbatim: demote only, cite the scan, tighten the
 * baseline, never delete.
 */
export function renderTargetBody(
  path: string,
  symbols: string[],
  ageDays: number,
  isoDate: string,
): string {
  if (!path.trim() || symbols.length === 0) {
    throw new Error("renderTargetBody: refusing to render an empty path/symbol batch");
  }
  const symbolList = symbols.map((s) => `\`${s}\``).join(", ");
  const plural = symbols.length > 1 ? "exports" : "export";

  const lines: string[] = [];
  lines.push(`# cleanup(target): demote ${symbols.length} unused ${plural} in \`${path}\``);
  lines.push("");
  lines.push(`> Surfaced by \`/hydra-target-cleanup\` on ${isoDate} against the Target (~/hydra-betting/web).`);
  lines.push("> Deterministic detection via `knip` (tests count as usage) — the same scan `npm run deadcode` runs.");
  lines.push("> Demote-only sweep: this item NEVER asks for a deletion.");
  lines.push("");
  lines.push("## Finding");
  lines.push("");
  lines.push(
    `\`knip\` reports ${symbolList} in \`web/${path}\` as having **no importers anywhere in the target codebase — not even a test**. Each symbol IS still referenced within its own file, so the only dead aspect is its \`export\` visibility. The file was last touched ${ageDays} days ago — past the ${WIRING_GRACE_DAYS}-day wiring grace period, so this is not wiring-in-flight.`,
  );
  lines.push("");
  lines.push("## What to do — demote, do NOT delete");
  lines.push("");
  lines.push(`In \`~/hydra-betting/web/${path}\`:`);
  lines.push("");
  for (const s of symbols) {
    lines.push(`- [ ] Drop only the \`export\` keyword from \`${s}\`. Keep the definition module-private and otherwise untouched.`);
  }
  lines.push("");
  lines.push(
    "Do **not** delete any symbol or file (deletion is wire-or-retire territory, a later phase; `src/lib/providers/` is demote-only by Target CLAUDE.md rule 1). If dropping an `export` breaks `tsc` or a test, that symbol is a scan false positive — leave it exported and note it in the PR body; never force the change.",
  );
  lines.push("");
  lines.push("Then, from `~/hydra-betting/web`:");
  lines.push("");
  lines.push("```bash");
  lines.push("npm run typecheck && npm test");
  lines.push("npm run deadcode:update-baseline   # locks in the reduced unused-export counts");
  lines.push("```");
  lines.push("");
  lines.push(
    `Commit the demotes together with the tightened \`web/deadcode-baseline.json\`, citing this finding in the commit message (symbols, file, scan date ${isoDate}) — Target CLAUDE.md rule 3 requires the citation.`,
  );
  lines.push("");
  lines.push("## Files in scope");
  lines.push("");
  lines.push(`- \`web/${path}\``);
  lines.push("- `web/deadcode-baseline.json` (tightened by `npm run deadcode:update-baseline`)");
  lines.push("");
  lines.push("## Acceptance criteria");
  lines.push("");
  lines.push(`- [ ] The \`export\` keyword is dropped from ${symbolList} in \`web/${path}\`; no definition is deleted or altered.`);
  lines.push("- [ ] `npm test` and `npm run typecheck` still pass.");
  lines.push("- [ ] `npm run deadcode:check` passes with a TIGHTENED baseline (unused exports/types reduced, committed).");
  lines.push("- [ ] No file deletions anywhere; no behavior change.");
  lines.push("");
  lines.push("## Why this is safe (deterministic check)");
  lines.push("");
  lines.push(
    "`knip` proved no external importer exists (tests included), and the in-file references keep compiling because the symbol stays defined — only its visibility changes. The deadcode ratchet (CI) pins the improvement so the dead export cannot silently come back.",
  );
  lines.push("");
  lines.push("---");
  lines.push("*Generated by hydra-target-cleanup (demote-only sweep, step 2 of the Target dead-code cleanup plan). Routes to `ready-for-agent` because the acceptance check is deterministic.*");

  return lines.join("\n").trimEnd() + "\n";
}

/**
 * The PURE emit planner: parse → validate/filter → classify (demote-only) →
 * wiring-grace gate → group per file → dedup vs open items → cap → render.
 * Performs NO I/O — `readSource` (file text) and `fileAge` (the widened
 * {@link FileAgeProbe}, or a probe with all-null fields when unknown) are
 * injected.
 *
 * Fail-closed posture (Target CLAUDE.md rule 6): a finding whose source can't
 * be read (`classifyExportFix` → "unknown") or whose last-touch age can't be
 * established (`fileAge().lastTouchDays` → null) is DROPPED, never emitted on
 * a guess.
 */
export function planTargetCleanupEmit(
  report: KnipReport,
  openItemTitles: string[],
  readSource: (path: string) => string,
  fileAge: (path: string) => FileAgeProbe,
  isoDate: string,
  cap: number = TARGET_EMIT_CAP,
): TargetCleanupEmitPlan {
  const raw = parseKnipReport(report);
  const dropped: DroppedTargetCleanupFinding[] = [];
  const demotable: CleanupFinding[] = [];

  const sourceCache = new Map<string, string>();
  const cachedSource = (path: string): string => {
    if (!sourceCache.has(path)) sourceCache.set(path, readSource(path));
    return sourceCache.get(path)!;
  };

  for (const finding of raw) {
    const invalid = validateFinding(finding);
    if (invalid) {
      dropped.push({ finding, reason: invalid });
      continue;
    }
    if (finding.kind === "file") {
      dropped.push({ finding, reason: "whole-file finding — wire-or-retire territory, not a demote" });
      continue;
    }
    const path = finding.path;
    if (path.includes(".test.") || path.includes(".spec.") || path.endsWith(".d.ts")) {
      dropped.push({ finding, reason: "test-only / type-declaration file" });
      continue;
    }
    const fix = classifyExportFix(finding, cachedSource(path));
    if (fix === "delete") {
      dropped.push({ finding, reason: "delete-class (no in-file reference) — deferred to wire-or-retire" });
      continue;
    }
    if (fix === "unknown") {
      dropped.push({ finding, reason: "source unavailable — fail closed, not emitted" });
      continue;
    }
    demotable.push({ ...finding, fix });
  }

  // Wiring-grace gate, evaluated once per file (age is a file property).
  // Introduction-anchored deferral ceiling (issue #3727): defer only when
  // the file is BOTH recently touched AND young by introduction. Unknown
  // last-touch age fails closed (unchanged); unknown introduction age is
  // treated as WITHIN the ceiling (still defers) — same fail-closed
  // direction as the last-touch measure. This makes the gate monotonic: no
  // commit of any intent (relocation, docs, cleanup) can push the ceiling
  // back, only the true introduction date matters.
  const ageByPath = new Map<string, FileAgeProbe>();
  const aged: CleanupFinding[] = [];
  for (const finding of demotable) {
    if (!ageByPath.has(finding.path)) ageByPath.set(finding.path, fileAge(finding.path));
    const probe = ageByPath.get(finding.path)!;
    if (probe.lastTouchDays === null) {
      dropped.push({ finding, reason: "file age unknown — fail closed, not emitted" });
      continue;
    }
    const withinCeiling = probe.introDays === null || probe.introDays < WIRING_GRACE_CEILING_DAYS;
    if (probe.lastTouchDays < WIRING_GRACE_DAYS && withinCeiling) {
      const introPart =
        probe.introDays !== null ? `introduced ${probe.introDays}d ago` : "introduction unknown";
      const resetPart = probe.resetCommit
        ? `; reset by ${probe.resetCommit.shortSha} "${probe.resetCommit.subject}"`
        : "";
      dropped.push({
        finding,
        reason: `within the ${WIRING_GRACE_DAYS}-day wiring grace period (${probe.lastTouchDays}d old) — ${introPart}${resetPart}`,
      });
      continue;
    }
    aged.push(finding);
  }

  // Group per file — one backlog item per file (see module comment).
  const byPath = new Map<string, string[]>();
  for (const finding of aged) {
    const list = byPath.get(finding.path) ?? [];
    if (!list.includes(finding.name)) list.push(finding.name);
    byPath.set(finding.path, list);
  }

  // Dedup per FILE against the open cleanup-scan board: while any item for a
  // path is open, no new item for that path is filed (the churn guard).
  const openPaths = new Set<string>();
  for (const title of openItemTitles) {
    const id = identityFromOpenItemTitle(title);
    if (id) openPaths.add(id);
  }

  const groups: Array<{ path: string; symbols: string[] }> = [];
  for (const [path, symbols] of byPath) {
    if (openPaths.has(path)) {
      for (const name of symbols) {
        dropped.push({
          finding: { kind: "export", path, name },
          reason: "an open cleanup-scan item already covers this file",
        });
      }
      continue;
    }
    groups.push({ path, symbols });
  }

  // Rank: most symbols first (one PR reclaims the most surface), then cap.
  groups.sort((a, b) => b.symbols.length - a.symbols.length || a.path.localeCompare(b.path));
  const toEmit = groups.slice(0, cap);
  for (const group of groups.slice(cap)) {
    for (const name of group.symbols) {
      dropped.push({
        finding: { kind: "export", path: group.path, name },
        reason: `over the per-run cap of ${cap} files`,
      });
    }
  }

  // Render title + body from the SAME group in ONE pass (the drift guard).
  const items: PlannedTargetCleanupItem[] = toEmit.map((group) => {
    const lastTouchDays = ageByPath.get(group.path)!.lastTouchDays!;
    return {
      path: group.path,
      symbols: group.symbols,
      ageDays: lastTouchDays,
      title: renderTargetTitle(group.path, group.symbols),
      body: renderTargetBody(group.path, group.symbols, lastTouchDays, isoDate),
    };
  });

  return { items, dropped, rawCount: raw.length };
}

// ---------------------------------------------------------------------------
// Thin CLI wrapper (the only part that touches fs / git / gh).
// ---------------------------------------------------------------------------

interface IssueTitle {
  title?: string;
}

/**
 * Read every open GitHub Issue on the Target repo carrying the cleanup-scan
 * label (used for dedup and saturation check). Aborts if the board can't be
 * read — emitting without dedup/saturation inputs is exactly how a flood
 * happens (fail closed).
 */
function readOpenCleanupItemTitles(): string[] {
  try {
    const out = execFileSync(
      "gh",
      [
        "issue",
        "list",
        "--repo",
        TARGET_REPO,
        "--label",
        CLEANUP_SCAN_LABEL,
        "--json",
        "title",
      ],
      { encoding: "utf-8" },
    );
    const issues = JSON.parse(out) as IssueTitle[];
    return issues.map((i) => i.title ?? "").filter(Boolean);
  } catch (err) {
    throw new Error(
      `gh issue list --label ${CLEANUP_SCAN_LABEL} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** File one item via GitHub Issues on the Target repo with the cleanup-scan label. */
function createTargetIssue(title: string, body: string): string {
  try {
    const out = execFileSync(
      "gh",
      [
        "issue",
        "create",
        "--repo",
        TARGET_REPO,
        "--title",
        title,
        "--body",
        body,
        "--label",
        CLEANUP_SCAN_LABEL,
        "--label",
        "ready-for-agent",
      ],
      { encoding: "utf-8" },
    );
    // gh issue create prints the issue URL on success
    const urlMatch = out.trim().match(/github\.com\/.*\/issues\/(\d+)/);
    const issueNum = urlMatch?.[1] ?? "?";
    return `filed as #${issueNum}`;
  } catch (err) {
    throw new Error(
      `gh issue create failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * The widened age probe (issue #3727) for web/<path> in the Target repo.
 * ONE `git log --follow` invocation yields last-touch (first line, same
 * value the old non-`--follow` scalar returned — `--follow` never changes
 * the newest commit) AND introduction (last line, the file's true
 * introduction resolved across renames). `--follow` relies on git's rename
 * detection: an independent COPY (not a rename) is not linked, so its
 * introduction dates from the copy itself — the honest answer, since by
 * path identity it IS a new module.
 */
function gitFileAgeProbe(path: string): FileAgeProbe {
  const unknown: FileAgeProbe = { lastTouchDays: null, introDays: null, resetCommit: null };
  try {
    const out = execFileSync(
      "git",
      ["-C", TARGET_ROOT, "log", "--follow", "--format=%ct%x1f%h%x1f%s", "--", `web/${path}`],
      { encoding: "utf-8" },
    ).trim();
    if (!out) return unknown;
    const lines = out.split("\n").filter(Boolean);
    const parse = (line: string): { ct: string; sha: string; subject: string } => {
      const [ct = "", sha = "", ...rest] = line.split("\x1f");
      return { ct, sha, subject: rest.join("\x1f") };
    };
    const newest = parse(lines[0]);
    const oldest = parse(lines[lines.length - 1]);
    if (!/^\d+$/.test(newest.ct)) return unknown;
    const nowSec = Date.now() / 1000;
    const lastTouchDays = Math.floor((nowSec - Number(newest.ct)) / 86400);
    const introDays = /^\d+$/.test(oldest.ct) ? Math.floor((nowSec - Number(oldest.ct)) / 86400) : null;
    return {
      lastTouchDays,
      introDays,
      resetCommit: { shortSha: newest.sha, subject: newest.subject },
    };
  } catch {
    return unknown; /* intentional: unknown age fails closed in the planner */
  }
}

function main(argv: string[]): void {
  const args = argv.slice(2);
  const apply = args.includes("--apply");
  const reportPath = args.find((a) => !a.startsWith("--")) ?? "/tmp/knip-target-report.json";

  if (!existsSync(reportPath)) {
    console.error(
      `hydra-target-cleanup-emit: knip report not found at ${reportPath}. Run \`cd ${TARGET_WEB} && npx knip --reporter json --no-exit-code > ${reportPath}\` first.`,
    );
    process.exit(1);
  }

  let report: KnipReport;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf-8")) as KnipReport;
  } catch (err) {
    console.error(
      `hydra-target-cleanup-emit: failed to parse ${reportPath} as JSON:`,
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  }

  let openTitles: string[];
  try {
    openTitles = readOpenCleanupItemTitles();
  } catch (err) {
    console.error(
      "hydra-target-cleanup-emit: failed to read the target board — aborting (cannot dedup or check saturation safely):",
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  }

  if (openTitles.length > TARGET_SATURATION_CAP) {
    console.log(
      `hydra-target-cleanup-emit: board saturated (${openTitles.length} open cleanup-scan items > ${TARGET_SATURATION_CAP} cap) — emitting nothing.`,
    );
    return;
  }

  const isoDate = new Date().toISOString().slice(0, 10);
  const readSource = (p: string): string => {
    try {
      const full = `${TARGET_WEB}/${p}`;
      return existsSync(full) ? readFileSync(full, "utf-8") : "";
    } catch {
      return ""; /* intentional: classification falls back to unknown → fail closed */
    }
  };

  const plan = planTargetCleanupEmit(report, openTitles, readSource, gitFileAgeProbe, isoDate);

  console.log(
    `hydra-target-cleanup-emit — Target (~/hydra-betting/web) — ${new Date().toISOString()} — ${apply ? "apply" : "dry-run"}`,
  );
  console.log("");
  console.log(`knip raw findings:   ${plan.rawCount}`);
  console.log(`After filter+dedup:  ${plan.items.length} file-items to emit (cap ${TARGET_EMIT_CAP})`);
  console.log(`Dropped findings:    ${plan.dropped.length}`);
  console.log("");

  for (const item of plan.items) {
    console.log(`• ${item.title}  [${item.symbols.length} demote(s), file ${item.ageDays}d old]`);
    if (!apply) {
      console.log("  --- body ---");
      console.log(item.body.replace(/^/gm, "  "));
      console.log("");
    } else {
      try {
        const outcome = createTargetIssue(item.title, item.body);
        console.log(`  ✓ ${outcome}`);
      } catch (err) {
        console.error(
          `  ✗ filing failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  const reasons = new Map<string, number>();
  for (const d of plan.dropped) reasons.set(d.reason, (reasons.get(d.reason) ?? 0) + 1);
  for (const [reason, count] of reasons) console.log(`dropped ${count}: ${reason}`);

  if (!apply) {
    console.log("");
    console.log("(dry-run; no issues created — pass --apply to file them on GitHub)");
  }
}

// Only run when executed directly (not when imported by the test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv);
}
