/**
 * scripts/ci/hydra-emit-shell.ts — the shared "run an emit plan" CLI harness
 * (issue #4393).
 *
 * WHY THIS EXISTS — the pure parse/classify/render layer of the three
 * scan-a-report → dedup-against-the-board → emit-issues pipelines was already
 * unified (scripts/ci/hydra-cleanup-render.ts), but the CLI shell wrapping
 * each runner's `main()` was still hand-copied three times: argv/`--apply`
 * parsing, the source-file-missing guard, the fail-closed board read, the
 * saturation-cap early return, the dry-run-vs-apply print/create loop, and the
 * dry-run footer. The copies had begun to drift — the orch runner's
 * `createIssue()` threw uncaught and aborted the whole batch while both Target
 * siblings caught-and-continued (#3720 acceptance criterion 2), and the orch
 * board reader `process.exit(1)`'d privately instead of throwing like its
 * siblings. This module is the ONE copy of that shell: each runner's `main()`
 * collapses to a spec object plus a single {@link runEmitShell} call.
 *
 * OWNERSHIP LINE — the shell owns only the mechanical CLI loop (the ordered
 * control flow in {@link runEmitShell}); everything domain-specific stays in
 * each runner and is passed through the spec: the header banner, the summary
 * block, the per-item line, the footer lines, the source loader (each report
 * format — knip JSON, knip JSON with a staleness guard, ledger markdown —
 * parses differently), the board reader and issue creator (each runner talks
 * to a different repo with different labels via `gh`, and `gh` spawning stays
 * script-owned — this module imports nothing from `node:child_process`).
 *
 * PURITY CONTRACT — {@link runEmitShell} never throws and never calls
 * `process.exit`; it returns the exit code, and each caller's guard assigns it
 * to `process.exitCode` (natural exit). All IO is an injectable `io` object
 * (log / error / exists / now) so tests drive the shell with fakes. This module
 * also imports nothing from `src/` and touches no filesystem other than the
 * default `exists` probe.
 */

import { existsSync } from "node:fs";

/** The minimum every plannable item carries: what gets filed as title + body. */
export type EmitItem = {
  title: string;
  body: string;
};

/**
 * Result of a spec-owned source load. `ok: false` makes the shell print the
 * error (prefixed with the runner name) and exit 1 — the fail-closed contract
 * for a missing, stale, or unparseable report/ledger.
 */
export type EmitSourceResult<TSource> =
  | { ok: true; source: TSource }
  | { ok: false; error: string };

/** The slice of a plan the shell renders: items plus the surrounding blocks. */
export type EmitPlanView<TItem> = {
  /** Items to print/file, in plan order. */
  items: TItem[];
  /** Lines printed between the header and the item loop. */
  summaryLines: string[];
  /** Lines printed after the item loop (e.g. the Target drop tally). */
  footerLines: string[];
};

/** All environment touchpoints of {@link runEmitShell}, injectable for tests. */
export type EmitShellIo = {
  log: (line: string) => void;
  error: (line: string) => void;
  exists: (path: string) => boolean;
  now: () => Date;
};

const DEFAULT_IO: EmitShellIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
  exists: (path) => existsSync(path),
  now: () => new Date(),
};

/** Everything the shell needs to run one pipeline; every piece is script-owned. */
export type EmitShellSpec<TSource, TOpenItem, TItem extends EmitItem> = {
  /** Runner name — prefixes every diagnostic and leads the header line. */
  name: string;
  /** Header banner, e.g. `Orchestrator (~/hydra)` / `Target ledger`. */
  banner: string;
  /** Noun for open items in the saturation message, e.g. `cleanup-scan issues`. */
  openItemNoun: string;
  /** Open items strictly ABOVE this count → emit nothing, exit 0. */
  saturationCap: number;
  /** Source path when argv carries no positional. */
  defaultSourcePath: string;
  /** stderr text (without the `name:` prefix) when the source file is absent. */
  missingSourceMessage: (path: string) => string;
  /** Load + validate the source (staleness, JSON parse, …) — script-owned order. */
  loadSource: (path: string) => EmitSourceResult<TSource>;
  /** Read the open board (throws on failure — the shell is the fail-closed site). */
  readOpenItems: () => TOpenItem[];
  /** Pure plan: source + open items + isoDate → items/summary/footer. */
  buildPlan: (source: TSource, openItems: TOpenItem[], isoDate: string) => EmitPlanView<TItem>;
  /** Headline for one item (domain-rendered, script-owned). */
  itemLine: (item: TItem) => string;
  /** File one item; returns the `✓` outcome text, throws on failure. */
  createItem: (item: TItem) => string;
};

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Group dropped-finding reasons into `dropped N: reason` footer lines, in
 * first-seen order (JS Map iteration is insertion-ordered). Shared by the two
 * Target runners, whose drop reasons repeat; the orch runner does NOT use it —
 * its drop reasons are per-finding unique, so a grouped tally there would
 * print one line per finding anyway.
 */
export function tallyDropReasons(dropped: ReadonlyArray<{ reason: string }>): string[] {
  const counts = new Map<string, number>();
  for (const d of dropped) counts.set(d.reason, (counts.get(d.reason) ?? 0) + 1);
  return Array.from(counts, ([reason, count]) => `dropped ${count}: ${reason}`);
}

/**
 * Run one emit pipeline end to end and return the exit code (never throws,
 * never exits — the caller assigns `process.exitCode`).
 *
 * Ordered control flow:
 *  1. argv — `--apply` anywhere in `argv.slice(2)`; the FIRST token not
 *     starting with `--` is the source path, else `spec.defaultSourcePath`;
 *  2. source-exists guard → stderr + exit 1;
 *  3. `spec.loadSource` — `ok:false` → stderr + exit 1;
 *  4. `spec.readOpenItems` in try/catch — a throw → stderr + exit 1 (fail
 *     closed: emitting without dedup/saturation inputs is how a flood happens);
 *  5. saturation (strict `>`; a board AT the cap proceeds) → the
 *     `board saturated … — emitting nothing.` line on stdout + exit 0 —
 *     deliberately BEFORE buildPlan, so a saturated board skips the plan's
 *     own expensive/dangerous reads (the orch planner fetches covering PRs);
 *  6. isoDate;
 *  7. `spec.buildPlan`;
 *  8. header + blank + summaryLines + blank;
 *  9. per-item loop in plan order — item line; dry-run prints the body
 *     two-space-indented, apply calls `spec.createItem` (`  ✓ <outcome>`, and a
 *     throw logs `  ✗ filing failed: <msg>` to stderr and CONTINUES — #3720
 *     acceptance criterion 2: one filing failure must not abort the rest);
 * 10. footerLines;
 * 11. dry-run only: blank + the fixed footer literal.
 */
export function runEmitShell<TSource, TOpenItem, TItem extends EmitItem>(
  spec: EmitShellSpec<TSource, TOpenItem, TItem>,
  argv: string[],
  io: EmitShellIo = DEFAULT_IO,
): number {
  const args = argv.slice(2);
  const apply = args.includes("--apply");
  const sourcePath = args.find((a) => !a.startsWith("--")) ?? spec.defaultSourcePath;

  if (!io.exists(sourcePath)) {
    io.error(`${spec.name}: ${spec.missingSourceMessage(sourcePath)}`);
    return 1;
  }

  const loaded = spec.loadSource(sourcePath);
  // `=== false`, not `!loaded.ok`: under this repo's strictNullChecks:false
  // setting TS 6 does NOT narrow boolean-discriminated unions through `!`
  // (verified: `!loaded.ok` leaves `loaded` unnarrowed and errors on `.error`).
  if (loaded.ok === false) {
    io.error(`${spec.name}: ${loaded.error}`);
    return 1;
  }

  let openItems: TOpenItem[];
  try {
    openItems = spec.readOpenItems();
  } catch (err) {
    io.error(
      `${spec.name}: failed to read the board — aborting (cannot dedup or check saturation safely): ${errMessage(err)}`,
    );
    return 1;
  }

  if (openItems.length > spec.saturationCap) {
    io.log(
      `${spec.name}: board saturated (${openItems.length} open ${spec.openItemNoun} > ${spec.saturationCap} cap) — emitting nothing.`,
    );
    return 0;
  }

  const isoDate = io.now().toISOString().slice(0, 10);
  const plan = spec.buildPlan(loaded.source, openItems, isoDate);

  io.log(`${spec.name} — ${spec.banner} — ${io.now().toISOString()} — ${apply ? "apply" : "dry-run"}`);
  io.log("");
  for (const line of plan.summaryLines) io.log(line);
  io.log("");

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
        io.error(`  ✗ filing failed: ${errMessage(err)}`);
      }
    }
  }

  for (const line of plan.footerLines) io.log(line);

  if (!apply) {
    io.log("");
    io.log("(dry-run; no issues created — pass --apply to file them on GitHub)");
  }

  return 0;
}
