/**
 * scripts/ci/hydra-emit-shell.ts — the shared CLI shell for the deterministic
 * emit runners (issue #4393).
 *
 * WHY THIS EXISTS — the PURE parse/classify/render layer of the three
 * "scan a report → dedup against the open board → emit issues" pipelines was
 * already unified (scripts/ci/hydra-cleanup-render.ts), but the CLI shell
 * wrapping each runner's entrypoint was not: every runner hand-duplicated the
 * same argv/--apply parsing, source-file-missing-or-exit guard, fail-closed
 * open-board read, saturation-cap early return, dry-run-vs-apply print/create
 * loop, and dry-run footer string — and the copies had begun to drift (the
 * orchestrator's board reader exited internally where the Target readers
 * threw; its apply loop aborted the whole run on one filing failure where the
 * Target siblings catch-and-continue, the #3720 acceptance criterion 2
 * behaviour). This module is the single-sourced skeleton those runners
 * collapse onto; each runner now supplies a spec object of the parts that are
 * genuinely its own (source format, board reader, planner, render strings).
 *
 * CONTRACT — runEmitShell() owns exactly this ordered control flow and
 * nothing else:
 *
 *   1. argv parse — `--apply` anywhere in `argv.slice(2)` sets apply; the
 *      FIRST token not starting with `--` is the source path, else
 *      `spec.defaultSourcePath`.
 *   2. source-exists guard — a missing source fails closed (stderr + 1).
 *   3. `spec.loadSource(path)` — script-owned read/parse (the orchestrator's
 *      #1766 staleness guard and the knip JSON guards live there); a
 *      `{ok:false}` result fails closed.
 *   4. `spec.readOpenItems()` inside the shell's ONE fail-closed catch — the
 *      board reader THROWS on gh failure and this is the only place it is
 *      turned into an abort, so no runner can drift back to a private exit.
 *   5. saturation — `open.length > cap` (strict; a board AT the cap
 *      proceeds) prints the saturation line and stops with exit 0.
 *   6.-7. `spec.buildPlan(source, open, isoDate)`. Saturation runs BEFORE
 *      buildPlan on purpose: runners park their expensive board-adjacent
 *      fetches inside buildPlan, so a saturated board must still skip them.
 *   8.-11. header + summary lines, the per-item print/create loop (dry-run
 *      prints the indented body and NEVER calls createItem; apply calls it
 *      once per item in plan order and CONTINUES past a throwing create —
 *      one item's filing failure must not abort the remaining items), the
 *      spec's footer lines (e.g. the drop tally), and the dry-run footer.
 *
 * The shell NEVER calls process.exit and NEVER throws: it returns the exit
 * code and the runner's guard assigns `process.exitCode`, so the process
 * exits naturally with the same observable codes as before. All IO is an
 * injectable `io` object (log / error / exists / now) so tests drive every
 * branch against captured sinks; `loadSource` / `readOpenItems` /
 * `createItem` are the other injection points. The module imports nothing
 * from `node:child_process` and nothing from `src/` — `gh` spawning stays in
 * each runner, so this extraction adds no new subprocess importer.
 */

import { existsSync } from "node:fs";

/**
 * The one dry-run footer literal every emit runner prints (issue #4393). Was
 * three hand-copied strings that had already drifted in wording; consumers
 * grep only the stylised "(dry-run; no GitHub issues created)" header prose,
 * not this literal, so converging on the 2-of-3 wording is safe.
 */
export const EMIT_DRY_RUN_FOOTER =
  "(dry-run; no issues created — pass --apply to file them on GitHub)";

/** Injectable IO seam — defaults touch the real console/fs/clock. */
export interface EmitIo {
  log: (line: string) => void;
  error: (line: string) => void;
  exists: (path: string) => boolean;
  now: () => Date;
}

const DEFAULT_IO: EmitIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
  exists: (path) => existsSync(path),
  now: () => new Date(),
};

/**
 * Parse the shared argv shape: `--apply` anywhere in `argv.slice(2)` sets
 * apply; the FIRST token not starting with `--` is the source path (a flag
 * token is never taken as one), else the runner's default.
 */
export function parseEmitArgv(
  argv: string[],
  defaultSourcePath: string,
): { apply: boolean; sourcePath: string } {
  const args = argv.slice(2);
  const apply = args.includes("--apply");
  const sourcePath = args.find((a) => !a.startsWith("--")) ?? defaultSourcePath;
  return { apply, sourcePath };
}

/**
 * Script-owned source load result: `{ok:true, source}` or a fail-closed
 * `{ok:false, error}` whose text is printed after the runner-name prefix.
 */
export type EmitSourceResult<TSource> =
  | { ok: true; source: TSource }
  | { ok: false; error: string };

/**
 * Every planned item carries at least a title and body — the dry-run print
 * and the apply create both consume exactly this pair, so the shell
 * constraint documents the only shape it relies on (each runner's richer
 * planned type satisfies it structurally).
 */
export interface EmitShellItem {
  title: string;
  body: string;
}

/** What `spec.buildPlan` hands back to the shell's print phase. */
export interface EmitPlan<TItem> {
  /** Items to (print | create), in plan order. */
  items: TItem[];
  /** Summary block lines printed between the header and the item loop. */
  summaryLines: string[];
  /** Lines printed after the item loop (e.g. the dropped-reasons tally). */
  footerLines: string[];
}

/**
 * The per-runner parts of the skeleton. Everything domain-rendered — banner,
 * summary block, per-item line, create plumbing — stays script-owned and is
 * passed through here; the shell owns flow, not content.
 */
export interface EmitShellSpec<TSource, TOpen, TItem extends EmitShellItem> {
  /** Runner name prefixing every diagnostic (e.g. "hydra-cleanup-emit"). */
  name: string;
  /** Header subject (e.g. "Orchestrator (~/hydra)"). */
  banner: string;
  /** Source path when argv carries no positional token. */
  defaultSourcePath: string;
  /** Missing-source message suffix (printed as `${name}: <message>`). */
  missingSourceMessage: (path: string) => string;
  /** Read + parse the (already existence-checked) source file. */
  loadSource: (path: string) => EmitSourceResult<TSource>;
  /**
   * Read the open board for dedup/saturation. THROWS on failure — the
   * shell's step-4 catch is the single fail-closed site.
   */
  readOpenItems: () => TOpen[];
  /** Noun for the saturation line (e.g. "cleanup-scan issues"). */
  openItemNoun: string;
  /** Saturation cap — script-owned constant; the shell never defines one. */
  saturationCap: number;
  /** Plan the emit. Runs only when the board is not saturated. */
  buildPlan: (source: TSource, openItems: TOpen[], isoDate: string) => EmitPlan<TItem>;
  /** The `• …` line for one planned item. */
  itemLine: (item: TItem) => string;
  /**
   * File one item (apply mode only); returns the `✓` outcome note. A throw
   * is caught by the shell and the loop continues (#3720 criterion 2).
   */
  createItem: (item: TItem) => string;
}

/**
 * Group dropped reasons into `dropped N: reason` tally lines, preserving
 * first-seen order. Replaces the hand-copied Map loop at the end of the
 * Target runners' apply reports; callers with per-finding-unique reasons
 * (the orchestrator's PR-covered citations) simply do not use it.
 */
export function tallyDropReasons(dropped: ReadonlyArray<{ reason: string }>): string[] {
  const reasons = new Map<string, number>();
  for (const d of dropped) reasons.set(d.reason, (reasons.get(d.reason) ?? 0) + 1);
  return Array.from(reasons, ([reason, count]) => `dropped ${count}: ${reason}`);
}

/**
 * Drive one emit runner's CLI skeleton end to end. Returns the exit code
 * (0 success / saturation, 1 fail-closed guard); never exits and never
 * throws — the caller assigns `process.exitCode`.
 */
export function runEmitShell<TSource, TOpen, TItem extends EmitShellItem>(
  spec: EmitShellSpec<TSource, TOpen, TItem>,
  argv: string[],
  io: EmitIo = DEFAULT_IO,
): number {
  const { apply, sourcePath } = parseEmitArgv(argv, spec.defaultSourcePath);

  // (2) Source-exists guard — fail closed before anything impure runs.
  if (!io.exists(sourcePath)) {
    io.error(`${spec.name}: ${spec.missingSourceMessage(sourcePath)}`);
    return 1;
  }

  // (3) Script-owned load/parse (orch staleness guard + knip JSON guards).
  // Narrowed with an `"error" in loaded` property-presence check, NOT
  // `!loaded.ok`: the repo tsconfig is `strict: false`, and under TS 6
  // non-strictNullChecks a negated boolean-literal discriminant does NOT
  // narrow the union (verified empirically) — `in`-narrowing does.
  const loaded = spec.loadSource(sourcePath);
  if ("error" in loaded) {
    io.error(`${spec.name}: ${loaded.error}`);
    return 1;
  }

  // (4) THE fail-closed board read: the reader throws, this is the only
  // catch — an emit that cannot dedup/saturate safely emits nothing.
  let openItems: TOpen[];
  try {
    openItems = spec.readOpenItems();
  } catch (err) {
    io.error(
      `${spec.name}: failed to read the board — aborting (cannot dedup or check saturation safely): ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  // (5) Saturation — strict `>`: a board AT the cap proceeds. Runs BEFORE
  // buildPlan so a saturated board still skips the expensive per-runner
  // fetches living inside it.
  if (openItems.length > spec.saturationCap) {
    io.log(
      `${spec.name}: board saturated (${openItems.length} open ${spec.openItemNoun} > ${spec.saturationCap} cap) — emitting nothing.`,
    );
    return 0;
  }

  // (6)+(7) Plan (with the shell-computed scan date).
  const isoDate = io.now().toISOString().slice(0, 10);
  const plan = spec.buildPlan(loaded.source, openItems, isoDate);

  // (8) Header + summary block.
  io.log(`${spec.name} — ${spec.banner} — ${io.now().toISOString()} — ${apply ? "apply" : "dry-run"}`);
  io.log("");
  for (const line of plan.summaryLines) io.log(line);
  io.log("");

  // (9) Per-item loop: dry-run prints the indented body and never creates;
  // apply creates in plan order, continuing past a filing failure.
  for (const item of plan.items) {
    io.log(spec.itemLine(item));
    if (!apply) {
      io.log("  --- body ---");
      io.log(item.body.replace(/^/gm, "  "));
      io.log("");
    } else {
      try {
        const outcome = spec.createItem(item);
        io.log(`  ✓ ${outcome}`);
      } catch (err) {
        // One item's filing failure must not abort the remaining items in
        // the plan (#3720 acceptance criterion 2).
        io.error(`  ✗ filing failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // (10) Footer lines (the Target runners' drop tally lives here).
  for (const line of plan.footerLines) io.log(line);

  // (11) Dry-run footer — the one literal, printed only in dry-run mode.
  if (!apply) {
    io.log("");
    io.log(EMIT_DRY_RUN_FOOTER);
  }

  return 0;
}
