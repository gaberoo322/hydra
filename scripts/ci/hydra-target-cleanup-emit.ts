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
 * Findings sink: the Hydra Redis target backlog via the orchestrator API
 * (POST /api/backlog), NOT GitHub issues — the Target's tracker is the
 * backlog (hydra-betting docs/agents/issue-tracker.md). Items are filed with
 * labels [cleanup-scan, ready-for-agent] and moved to the `queued` lane
 * (the ready-for-agent lane per docs/agents/triage-labels.md).
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
 *   # apply: files one cleanup-scan + ready-for-agent backlog item per file
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

/** Label stamped on every emitted item — the saturation/dedup count seam. */
export const CLEANUP_SCAN_LABEL = "cleanup-scan";

export const TARGET_ROOT = "/home/gabe/hydra-betting";
export const TARGET_WEB = `${TARGET_ROOT}/web`;
const API_BASE = "http://localhost:4000/api";

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
 * Performs NO I/O — `readSource` (file text) and `fileAgeDays` (days since the
 * last commit touching the file, or null when unknown) are injected.
 *
 * Fail-closed posture (Target CLAUDE.md rule 6): a finding whose source can't
 * be read (`classifyExportFix` → "unknown") or whose file age can't be
 * established (fileAgeDays → null) is DROPPED, never emitted on a guess.
 */
export function planTargetCleanupEmit(
  report: KnipReport,
  openItemTitles: string[],
  readSource: (path: string) => string,
  fileAgeDays: (path: string) => number | null,
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
  const ageByPath = new Map<string, number | null>();
  const aged: CleanupFinding[] = [];
  for (const finding of demotable) {
    if (!ageByPath.has(finding.path)) ageByPath.set(finding.path, fileAgeDays(finding.path));
    const age = ageByPath.get(finding.path)!;
    if (age === null) {
      dropped.push({ finding, reason: "file age unknown — fail closed, not emitted" });
      continue;
    }
    if (age < WIRING_GRACE_DAYS) {
      dropped.push({
        finding,
        reason: `within the ${WIRING_GRACE_DAYS}-day wiring grace period (${age}d old)`,
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
  const items: PlannedTargetCleanupItem[] = toEmit.map((group) => ({
    path: group.path,
    symbols: group.symbols,
    ageDays: ageByPath.get(group.path)!,
    title: renderTargetTitle(group.path, group.symbols),
    body: renderTargetBody(group.path, group.symbols, ageByPath.get(group.path)!, isoDate),
  }));

  return { items, dropped, rawCount: raw.length };
}

// ---------------------------------------------------------------------------
// Thin CLI wrapper (the only part that touches fs / git / the orchestrator API).
// ---------------------------------------------------------------------------

interface BacklogItemRow {
  id?: string | number;
  title?: string;
  labels?: string[];
}

/**
 * Read every NON-done backlog item carrying the cleanup-scan label. Aborts the
 * run when the board can't be read — emitting without the dedup/saturation
 * inputs is exactly how a flood happens (fail closed).
 */
async function readOpenCleanupItems(): Promise<BacklogItemRow[]> {
  const res = await fetch(`${API_BASE}/backlog`);
  if (!res.ok) {
    throw new Error(`GET /backlog returned ${res.status}`);
  }
  const lanes = (await res.json()) as Record<string, unknown>;
  const open: BacklogItemRow[] = [];
  for (const [lane, rows] of Object.entries(lanes)) {
    if (lane === "done" || lane === "counts" || !Array.isArray(rows)) continue;
    for (const row of rows as BacklogItemRow[]) {
      const labels = Array.isArray(row?.labels) ? row.labels : [];
      if (labels.includes(CLEANUP_SCAN_LABEL)) open.push(row);
    }
  }
  return open;
}

/** File one item: POST /backlog, then move it to the queued lane (ready-for-agent). */
async function createBacklogItem(title: string, body: string): Promise<string> {
  const res = await fetch(`${API_BASE}/backlog`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title,
      description: body,
      category: "cleanup",
      labels: [CLEANUP_SCAN_LABEL, "ready-for-agent"],
    }),
  });
  if (!res.ok) throw new Error(`POST /backlog returned ${res.status}`);
  const out = (await res.json()) as { added?: boolean; id?: string | number; reason?: string };
  if (!out.added || out.id === undefined) {
    return `skipped (${out.reason ?? "not added"})`;
  }
  const move = await fetch(`${API_BASE}/backlog/${out.id}/move`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lane: "queued" }),
  });
  if (!move.ok) {
    // The item exists but stayed in the backlog lane — report it loudly so the
    // operator (or a sweep) promotes it; never silently lose the filing.
    return `filed as ${out.id} but move-to-queued failed (${move.status})`;
  }
  return `filed as ${out.id} → queued`;
}

/** Days since the last commit touching web/<path> in the Target repo, or null. */
function gitFileAgeDays(path: string): number | null {
  try {
    const out = execFileSync(
      "git",
      ["-C", TARGET_ROOT, "log", "-1", "--format=%ct", "--", `web/${path}`],
      { encoding: "utf-8" },
    ).trim();
    if (!/^\d+$/.test(out)) return null;
    const ageSec = Date.now() / 1000 - Number(out);
    return Math.floor(ageSec / 86400);
  } catch {
    return null; /* intentional: unknown age fails closed in the planner */
  }
}

async function main(argv: string[]): Promise<void> {
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

  let openItems: BacklogItemRow[];
  try {
    openItems = await readOpenCleanupItems();
  } catch (err) {
    console.error(
      "hydra-target-cleanup-emit: failed to read the target backlog — aborting (cannot dedup or check saturation safely):",
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  }

  if (openItems.length > TARGET_SATURATION_CAP) {
    console.log(
      `hydra-target-cleanup-emit: board saturated (${openItems.length} open cleanup-scan items > ${TARGET_SATURATION_CAP} cap) — emitting nothing.`,
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
  const openTitles = openItems.map((i) => (typeof i.title === "string" ? i.title : "")).filter(Boolean);

  const plan = planTargetCleanupEmit(report, openTitles, readSource, gitFileAgeDays, isoDate);

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
      const outcome = await createBacklogItem(item.title, item.body);
      console.log(`  ✓ ${outcome}`);
    }
  }

  const reasons = new Map<string, number>();
  for (const d of plan.dropped) reasons.set(d.reason, (reasons.get(d.reason) ?? 0) + 1);
  for (const [reason, count] of reasons) console.log(`dropped ${count}: ${reason}`);

  if (!apply) {
    console.log("");
    console.log("(dry-run; no backlog items created — pass --apply to file them)");
  }
}

// Only run when executed directly (not when imported by the test).
if (import.meta.url === `file://${process.argv[1]}`) {
  void main(process.argv);
}
