#!/usr/bin/env -S npx tsx
/**
 * Signal-parity check over the autopilot signal contract — wiring-liveness
 * iota (issue #4519, design-concept artifact dd29b4f22272).
 *
 * The contract spans three committed artifacts:
 *
 *   scripts/autopilot/collect-state.sh (+ its declared leaf producer
 *   scripts/autopilot/target-wip.py)  emits ~150 named `key=value` signals
 *   docs/operator-playbooks/hydra-autopilot.md  the "Signal wiring
 *                                       (state.signals)" table — the
 *                                       hand-maintained promotion hop
 *   scripts/autopilot/decide.py        reads keys off state.signals / events
 *
 * The middle hop is PROSE, so an emitted-but-never-promoted signal ships
 * silently as absent-and-falsy (#4342 design_qa_target_due — no, the read
 * side of that incident — and #3871/#4244 retro_run_drillable). This module
 * makes the drift mechanical with three TEXTUAL legs (issue #4519 INV-3):
 *
 *   L1 read→row   every signal literal decide.py reads has a row in the
 *                 playbook's Signal wiring table (or a PRODUCERLESS_SIGNALS
 *                 exemption) — the #4342 defect class, widened beyond
 *                 `_signal_present` to EVERY read shape (INV-4).
 *   L2 row→emit   every row's column-1 producer identifier is emitted by
 *                 collect-state.sh or the leaf producer target-wip.py (or a
 *                 NON_KV_PRODUCERS exemption for the board-state JSON line).
 *   L3 row→read   every column-2 promoted state.signals key is read by
 *                 decide.py (or an OBSERVATORY_ONLY_ROWS exemption) — a
 *                 promoted key nobody reads is a dead row.
 *
 * All legs are textual over committed sources: collect-state.sh is NEVER
 * executed (it needs gh auth, Redis, the hydra CLI and the live orchestrator;
 * its STRUCTURE comment, issue #4266, commits to a fixed greppable emit shape
 * precisely so tests can slice it textually) and no network is touched.
 *
 * ENFORCEMENT LIVES IN THE REQUIRED `test` JOB (INV-2): the assertions run
 * in test/decide-signal-classes.test.mts (the #4342 block this module
 * replaces), so a red verdict reddens the required check. The CLI below is a
 * LOCAL convenience for devs to run the report before opening a PR — it is
 * deliberately NOT wired into any workflow and has no package.json script
 * (INV-7; ci.yml is Verifier Core, ADR-0001/ADR-0015, and stays untouched).
 *
 * This module is a READ-ONLY observer of the seam (INV-10): decide.py,
 * collect-state.sh, config/direction/liveness.yaml, the wiring-liveness
 * chore and wiring-caller-check.ts are never modified by anything that
 * ships from this check's lineage. ADR-0007 purity is untouched.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = join(import.meta.dirname, "..", "..");

/** Default artifact paths — the three ends of the contract (INV-3). */
export const SIGNAL_CONTRACT_PATHS = {
  decide: "scripts/autopilot/decide.py",
  collect: "scripts/autopilot/collect-state.sh",
  /** Declared leaf producer (emits the target_wip_* / target_in_progress keys). */
  leaf: "scripts/autopilot/target-wip.py",
  playbook: "docs/operator-playbooks/hydra-autopilot.md",
} as const;

// ---------------------------------------------------------------------------
// Exemption lists (INV-6) — name → rationale Maps, honesty-tested in BOTH
// directions by test/decide-signal-classes.test.mts (the #4342 pattern: an
// exempted entry that gains a table row / a decide.py reader / a key=value
// producer fails the suite with a message naming the entry to delete).
// ---------------------------------------------------------------------------

/**
 * Signals decide.py reads that have NO collect-state.sh producer, and so can
 * never have a Signal-wiring row (a row would claim a promotion hop that does
 * not exist). Each reads absent-as-false forever — the safe direction for a
 * suppressor or a mothballed lane's trigger. An entry that GAINS a real
 * producer must be removed at the same time its table row is added.
 * (Verbatim continuation of the #4342 list — INV-6 keeps its three entries.)
 */
export const PRODUCERLESS_SIGNALS = new Map<string, string>([
  [
    "skill_prune_board_saturated",
    "anti-flood cap emitted by no script — decide.py reads it as a defensive suppressor; absent-as-false fail-opens the class",
  ],
  [
    "target_research_due",
    "legacy Redis-substrate signal, unproduced since the ADR-0031 GitHub-board migration (target_board_research_due is the produced mirror)",
  ],
  [
    "target_idle",
    "discover_target's gate — the playbook itself flags its production as 'a separate Target-side question'",
  ],
]);

/**
 * Row producer identifiers emitted by collect-state.sh's board-state JSON
 * LINE (`print(json.dumps({k:d[k] for k in keys}))`), not as a `key=value`
 * literal — L2's literal extractor cannot see them, so each is exempted here
 * and honesty-tested against the `keys=[...]` python list literal that
 * actually emits it (INV-6: the exemption fails the suite the moment the key
 * leaves that list, or the row leaves the table).
 */
export const NON_KV_PRODUCERS = new Map<string, string>([
  [
    "needs_qa",
    "orch board count, emitted only inside the board-state JSON line (print(json.dumps({k:d[k] for k in keys}))) — no key=value literal exists",
  ],
  [
    "ready_for_agent",
    "orch board count, emitted only inside the board-state JSON line — no key=value literal exists",
  ],
  [
    "needs_triage",
    "orch board count, emitted only inside the board-state JSON line — no key=value literal exists",
  ],
  [
    "needs_research",
    "orch board count, emitted only inside the board-state JSON line — no key=value literal exists",
  ],
]);

/**
 * Promoted state.signals keys that are deliberately NOT read by decide.py —
 * observability-only rows (the operator/model reads them inline in the
 * collect-state stream; dashboards read them off state). Honesty-tested both
 * ways: an entry that GAINS a decide.py reader fails the suite (the row is
 * now live wiring), and an entry whose ROW disappears fails the suite (the
 * exemption is stale).
 */
export const OBSERVATORY_ONLY_ROWS = new Map<string, string>([
  [
    "hitl_grill_open",
    "observability only — the depth of the operator-admission inbox under the 2026-08-19 admission rule (issue #4391); decide.py gates nothing on it, the operator reads it inline",
  ],
  [
    "orch_prs_glm_red",
    "observability only — the #4460 DEBUG bucket behind the orch_glm_red_forward_fix pick; the row's own text records that no rule consumes it directly (the pick, not the bucket, drives the forward-fix)",
  ],
]);

/** The three exemption lists together, as checkSignalParity consumes them. */
export interface ParityExemptions {
  producerless?: Map<string, string>;
  nonKvProducers?: Map<string, string>;
  observatoryOnlyRows?: Map<string, string>;
}

// ---------------------------------------------------------------------------
// L1 input: decide.py's read surface (INV-4)
// ---------------------------------------------------------------------------

/**
 * Every signal name decide.py could be reading — the union of SIX read
 * shapes (INV-4; the #4342 guard covered only the first and silently missed
 * the rest, which is exactly how three live reads shipped unrowed):
 *
 *  1. `_signal_present(<args>, "k")`            — the #4342 shape (28 literals)
 *  2. `(state.get("signals") or {}).get("k")`   — the direct-dict fallback
 *  3. `<ident>.get("k")` for `signals` / `_tk_signals` locals bound from
 *     `state.get("signals")`
 *  4. `_orch_anchor_signal(signals, "k")`       — the anchor-string accessor
 *  5. `_triage_item_set(state, events, "k")`    — the item-set accessor
 *  6. the VALUES of the ESCALATION_SATURATION_SIGNAL dict (table-driven:
 *     the name is later handed to a reader via variable)
 *  7. `_pr_gate_numbers(state, events, "k")`    — the PR-gate bucket accessor
 *     (#4240). Not in the artifact's INV-4 enumeration, but found by the
 *     exhaustive `(state, events, "literal")` sweep the invariant's intent
 *     ("EVERY read shape") demands — without it the orch_prs_dirty/
 *     unchecked/behind rows would false-flag as unread (they ARE read, via
 *     exactly this helper). `_triage_stamps(state, "k")` reads PLAIN state
 *     fields (persisted stamp maps), not signals — deliberately excluded.
 *
 * Rot guard lives in the test (≥35 distinct reads AND one pinned member per
 * shape: orch_realm_weekly_share, orch_dev_ready_anchor_design_concept_status,
 * scout_alert_eligible_count, orch_needs_triage_items, orch_pending_grill_anchor,
 * cleanup_board_saturated, orch_board_signals_degraded, orch_prs_dirty) so a
 * regex that rots against a refactor fails loud instead of shrinking the
 * checked set to zero.
 */
export function extractDecideReads(decideSrc: string): string[] {
  const names = new Set<string>();
  const add = (re: RegExp) => {
    for (const m of decideSrc.matchAll(re)) names.add(m[1] as string);
  };

  // 1. _signal_present(<args>, "k") — the arg prefix excludes parens and
  // quotes, so the lazy scan can never escape a call's own closing paren.
  add(/_signal_present\(\s*[^()"']*?\s*"([^"]+)"\s*\)/g);
  // 2. (state.get("signals") or {}).get("k")
  add(/\(state\.get\("signals"\)\s+or\s+\{\}\)\.get\("([^"]+)"\)/g);
  // 3. signals/_tk_signals local .get("k") — the receiver must be the bare
  // identifier, so the `or {}).get(` arm of shape 2 never double-counts.
  add(/\b(?:signals|_tk_signals)\.get\("([^"]+)"\)/g);
  // 4. _orch_anchor_signal(<recv>, "k")
  add(/_orch_anchor_signal\(\s*[^,()"']*?,\s*"([^"]+)"\s*\)/g);
  // 5. _triage_item_set(<state>, <events>, "k") — and 7. _pr_gate_numbers,
  // the same 3-arg literal-last family.
  add(/(?:_triage_item_set|_pr_gate_numbers)\(\s*[^,()"']*?,\s*[^,()"']*?,\s*"([^"]+)"\s*\)/g);
  // 6. ESCALATION_SATURATION_SIGNAL dict values (the table-driven names).
  const dict = decideSrc.match(/ESCALATION_SATURATION_SIGNAL\s*=\s*\{([^}]*)\}/);
  if (dict) {
    for (const m of (dict[1] as string).matchAll(/:\s*"([^"]+)"/g)) {
      names.add(m[1] as string);
    }
  }

  return [...names].sort();
}

// ---------------------------------------------------------------------------
// L2 input: the emission surface (INV-5)
// ---------------------------------------------------------------------------

/**
 * Every signal name the collector sources emit, extracted TEXTUALLY (never
 * executed — issue #4266's STRUCTURE contract). The literal emission shapes:
 *
 *   shell   `echo -n "k="` / `echo "k="` / `printf … "k="` / `$'k=…'`
 *   python  `print('k=' …)` / `print(f'k={…}')` / mid-fstring ` k={…}` /
 *           a bare `f"k={…}"` continuation-line argument of a multi-line
 *           print(...) call (target-wip.py's four-key block)
 *
 * The common denominator: a quoted string literal (double, single, or
 * ANSI-C `$'…'`) on an emission-command line, whose content STARTS with
 * `identifier=`, plus `identifier={` tokens inside f-string literals (the
 * composite single-line emissions: `print(f'health={…} redis={…}')`).
 * Comment lines are skipped — a retired emission stays retired.
 */
/**
 * Truncate `rawLine` at its first UNQUOTED `#` — a trailing shell/python
 * comment — leaving quoted content (single, double, or ANSI-C `$'…'`)
 * untouched. A whole-line comment truncates to an empty/whitespace string,
 * so callers can treat "nothing left after stripping" as "skip this line"
 * without a separate `startsWith("#")` check (issue #4519 PR #4522 QA
 * Reviewer B finding 1: the old whole-line-only check let a trailing `#
 * comment` containing a quoted `"name=value"` — e.g. `foo=1  # don't emit
 * "test_signal=1" again` — leak a phantom name into the emitted set, since
 * the scan-gate and literal scan both ran over the RAW line, comment tail
 * included).
 */
function stripTrailingComment(rawLine: string): string {
  let inSingle = false;
  let inDouble = false;
  let inAnsiC = false;
  for (let i = 0; i < rawLine.length; i++) {
    const ch = rawLine[i];
    if (inAnsiC) {
      // Inside a $'...' ANSI-C literal, a backslash escapes the next char —
      // notably `\'` is a literal quote, not the terminator — so skip it
      // rather than letting it flip inAnsiC off early (which would desync
      // the rest of the scan and re-leak a phantom trailing-comment match).
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === "'") inAnsiC = false;
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "#") return rawLine.slice(0, i);
    if (ch === "'") {
      if (i > 0 && rawLine[i - 1] === "$") inAnsiC = true;
      else inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    }
  }
  return rawLine;
}

export function extractEmittedSignals(...sources: string[]): string[] {
  const names = new Set<string>();
  // A quoted literal: `"…"`, `'…'`, or ANSI-C `$'…'` (capture group 1 = content;
  // the other quote type is allowed inside, matching python's mixed quoting).
  const literalRe = /\$?'([^'\n]*)'|"([^"\n]*)"/g;
  const prefixRe = /^([a-z_][a-z0-9_]*)=/;
  const midFstringRe = /([a-z_][a-z0-9_]*)=\{/g;

  for (const src of sources) {
    for (const rawLine of src.split("\n")) {
      const line = stripTrailingComment(rawLine);
      if (!line.trim()) continue;
      // Emission-command anchor: the line must carry an echo/printf/print
      // command, BE a bare f-string print argument on its own line (the
      // multi-line print(...) shape), or carry an ANSI-C `$'…'` literal
      // (which exists in these scripts exactly for kv fallback blocks).
      const bareFstringArg = /^\s*f["'][a-z_][a-z0-9_]*=/.test(line);
      if (!bareFstringArg && !/\$'/.test(line) && !/\b(echo|printf|print)\b/.test(line)) {
        continue;
      }

      literalRe.lastIndex = 0;
      let span: RegExpExecArray | null;
      while ((span = literalRe.exec(line)) !== null) {
        const content = span[1] ?? span[2] ?? "";
        const prefix = prefixRe.exec(content);
        if (prefix) names.add(prefix[1]);
        // An ANSI-C `$'…'` literal emits one `name=value` line PER embedded
        // \n (the target board-count fallback) — every line-start name
        // counts, not just the first.
        if (span[0].startsWith("$'")) {
          for (const m of content.matchAll(/(?:^|\\n)([a-z_][a-z0-9_]*)=/g)) {
            names.add(m[1] as string);
          }
        }
        // Mid-fstring ` name={` tokens only count inside f-string literals —
        // an f-prefix is the char immediately before the opening quote.
        const quotePos = span.index + (span[0].startsWith("$'") ? 1 : 0);
        const prev = quotePos > 0 ? line[quotePos - 1] : "";
        const prevPrev = quotePos > 1 ? line[quotePos - 2] : "";
        const isFstring = prev === "f" && !/[a-zA-Z0-9_]/.test(prevPrev);
        if (!isFstring) continue;
        midFstringRe.lastIndex = 0;
        let tok: RegExpExecArray | null;
        while ((tok = midFstringRe.exec(content)) !== null) {
          names.add(tok[1] as string);
        }
      }
    }
  }
  return [...names].sort();
}

// ---------------------------------------------------------------------------
// The middle hop: the playbook's Signal wiring table (INV-9)
// ---------------------------------------------------------------------------

/** One parsed row of the playbook's Signal wiring table. */
export interface WiringRow {
  /**
   * Column 1's FIRST code-span's leading `[a-z][a-z0-9_]*` identifier — the
   * producer name L2 checks. Undefined when the first span carries no
   * identifier (e.g. `/api/autopilot/runs`): the row names no producer and
   * L2 skips it.
   */
  producer?: string;
  /**
   * Column 2's first code-span with any `state.signals.` prefix stripped —
   * the promoted key L3 checks. Undefined for `state.<other>` spans (merged
   * verbatim state fields such as state.usage_eligibility) and prose-only
   * cells (`(advisory only)`, `(read directly from state)`): those rows
   * promote no state.signals key and L3 skips them.
   */
  key?: string;
  /**
   * True when column 2 carries NO code-span at all — pure prose like
   * "(read directly from state)". Such a row documents a state-field read
   * (e.g. dev_target_spend_usd_cycle, written into state.json by the
   * harness, not emitted by collect-state.sh's kv stream) and claims no
   * promotion hop, so L2 skips it too: there is no hop to verify.
   */
  col2Prose?: boolean;
  /** The full row text — diagnostics for failure messages. */
  text: string;
}

/** extractWiringRows result — `error` set when the section heading is gone. */
export interface WiringRowsResult {
  rows: WiringRow[];
  /** Set when the `## Signal wiring (state.signals)` heading is absent (INV-9: a rename fails loud). */
  error?: string;
}

/**
 * Parse the "Signal wiring (state.signals)" table out of the playbook.
 * Splits on UNESCAPED pipes (a `\|` inside a code-span is data, not a cell
 * boundary); the header row and the `|---|` separator are skipped. Column
 * conventions are #4342's, kept verbatim (INV-9).
 */
export function extractWiringRows(playbookSrc: string): WiringRowsResult {
  const section = playbookSrc.match(
    /^## Signal wiring \(state\.signals\)\s*$([\s\S]*?)^## /m,
  );
  if (!section) {
    return {
      rows: [],
      error:
        "playbook must still contain the `## Signal wiring (state.signals)` section heading — a rename must update this extractor in the same PR",
    };
  }

  const rows: WiringRow[] = [];
  for (const line of (section[1] as string).split("\n")) {
    if (!line.trimStart().startsWith("|")) continue;
    // Protect `\|` escapes, split on real pipes, restore (INV-9's unescaped-pipe rule).
    const protectedLine = line.replace(/\\\|/g, "\x00");
    const cells = protectedLine
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim().replace(/\x00/g, "|"));
    if (cells.length < 2) continue;
    if (/^[-:\s]*$/.test(cells[0] as string)) continue; // separator row
    if (/^collect-state output$/i.test((cells[0] as string).replace(/`/g, "").trim())) {
      continue; // header row
    }

    // Column 1 → producer: leading identifier of the FIRST code-span.
    let producer: string | undefined;
    let col2Prose = false;
    const col1span = /`([^`]+)`/.exec(cells[0] as string);
    if (col1span) {
      const id = /^([a-z][a-z0-9_]*)/.exec(col1span[1] as string);
      if (id) producer = id[1];
    }

    // Column 2 → promoted key: first code-span, `state.signals.` stripped;
    // `state.<other>` spans and prose-only cells contribute no key.
    let key: string | undefined;
    const col2span = /`([^`]+)`/.exec(cells[1] as string);
    if (col2span) {
      const cleaned = (col2span[1] as string).replace(/^state\.signals\./, "");
      if (!cleaned.startsWith("state.")) {
        const id = /^([a-z_][a-z0-9_]*)/.exec(cleaned);
        if (id && id[1] !== "state" && id[1] !== "signals") key = id[1];
      }
    } else {
      col2Prose = true;
    }

    rows.push({ producer, key, col2Prose, text: line.trim() });
  }
  return { rows };
}

// ---------------------------------------------------------------------------
// The parity check (INV-3 / INV-7 — pure, never-throws, result objects)
// ---------------------------------------------------------------------------

/** A source artifact: its text, or a structured read error (never a throw). */
export type SourceText = string | { readonly error: string };

/** The outcome of the three-leg parity check. */
export interface SignalParityResult {
  /** True iff every leg is clean (or a source error made the run inconclusive — `error` set). */
  ok: boolean;
  /** Set when a source was unreadable: the run is inconclusive, not green. */
  error?: string;
  /** L1 — decide.py reads with no table row and no producerless exemption. */
  missingRows: string[];
  /** L2 — row producers collect-state.sh / target-wip.py never emit (no non-kv exemption). */
  unproducedRows: string[];
  /** L3 — promoted keys decide.py never reads (no observability-only exemption). */
  unreadRows: string[];
  /** Diagnostic totals. */
  stats: {
    reads: number;
    emitted: number;
    rows: number;
    producers: number;
    keys: number;
  };
}

const EMPTY_STATS = { reads: 0, emitted: 0, rows: 0, producers: 0, keys: 0 };

/**
 * Run the three parity legs over the contract's artifacts (INV-3). Pure and
 * never-throws: an unreadable source returns `{ok: false, error}` — the
 * caller decides how to report it (INV-7).
 */
export function checkSignalParity(
  sources: {
    decide?: SourceText;
    collect?: SourceText;
    leaf?: SourceText;
    playbook?: SourceText;
  },
  exemptions: ParityExemptions = {},
): SignalParityResult {
  const resolve = (s: SourceText | undefined, label: string): string | null => {
    if (s === undefined) return null; // optional source (leaf)
    if (typeof s !== "string") return `unreadable ${label}: ${s.error}`;
    return null;
  };
  const sourceError =
    resolve(sources.decide, "decide.py") ??
    resolve(sources.collect, "collect-state.sh") ??
    resolve(sources.leaf, "target-wip.py") ??
    resolve(sources.playbook, "playbook");
  if (sourceError) {
    return {
      ok: false,
      error: sourceError,
      missingRows: [],
      unproducedRows: [],
      unreadRows: [],
      stats: { ...EMPTY_STATS },
    };
  }

  const reads = new Set(extractDecideReads(sources.decide as string));
  const emitted = new Set(
    extractEmittedSignals(
      ...(sources.collect ? [sources.collect as string] : []),
      ...(sources.leaf && typeof sources.leaf === "string" ? [sources.leaf] : []),
    ),
  );
  const { rows, error } = extractWiringRows(sources.playbook as string);
  if (error) {
    return {
      ok: false,
      error,
      missingRows: [],
      unproducedRows: [],
      unreadRows: [],
      stats: { ...EMPTY_STATS },
    };
  }

  const producerless = exemptions.producerless ?? new Map<string, string>();
  const nonKv = exemptions.nonKvProducers ?? new Map<string, string>();
  const observatory = exemptions.observatoryOnlyRows ?? new Map<string, string>();

  const keys = new Set<string>();
  const producers = new Set<string>();
  for (const row of rows) {
    if (row.key) keys.add(row.key);
    if (row.producer) producers.add(row.producer);
  }

  const missingRows = [...reads]
    .filter((r) => !keys.has(r) && !producerless.has(r))
    .sort();
  const unproducedRows = [
    ...new Set(
      rows
        .filter(
          (row) =>
            row.producer !== undefined &&
            !row.col2Prose && // no promoted hop → nothing for L2 to verify
            !emitted.has(row.producer) &&
            !nonKv.has(row.producer),
        )
        .map((row) => row.producer as string),
    ),
  ].sort();
  const unreadRows = [...keys]
    .filter((k) => !reads.has(k) && !observatory.has(k))
    .sort();

  return {
    ok: missingRows.length === 0 && unproducedRows.length === 0 && unreadRows.length === 0,
    missingRows,
    unproducedRows,
    unreadRows,
    stats: {
      reads: reads.size,
      emitted: emitted.size,
      rows: rows.length,
      producers: producers.size,
      keys: keys.size,
    },
  };
}

// ---------------------------------------------------------------------------
// CLI — a LOCAL convenience only (INV-7): no workflow, no package.json
// script, no ci.yml edit. Prints the full report; exits 1 on any verdict,
// 2 on an unreadable source.
// ---------------------------------------------------------------------------

async function runCli(): Promise<number> {
  const load = async (path: string): Promise<SourceText> => {
    try {
      return await readFile(join(REPO_ROOT, path), "utf8");
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };

  const result = checkSignalParity(
    {
      decide: await load(SIGNAL_CONTRACT_PATHS.decide),
      collect: await load(SIGNAL_CONTRACT_PATHS.collect),
      leaf: await load(SIGNAL_CONTRACT_PATHS.leaf),
      playbook: await load(SIGNAL_CONTRACT_PATHS.playbook),
    },
    {
      producerless: PRODUCERLESS_SIGNALS,
      nonKvProducers: NON_KV_PRODUCERS,
      observatoryOnlyRows: OBSERVATORY_ONLY_ROWS,
    },
  );

  if (result.error) {
    console.error(`[signal-parity-check] ERROR: ${result.error}`);
    return 2;
  }
  const { stats } = result;
  console.log(
    `[signal-parity-check] ${result.ok ? "OK" : "FAIL"} — ${stats.reads} reads / ` +
      `${stats.emitted} emitted / ${stats.rows} rows (${stats.producers} producers, ${stats.keys} keys).`,
  );
  for (const r of result.missingRows) {
    console.error(
      `[signal-parity-check] L1 read→row FAIL: decide.py reads '${r}' but the Signal wiring table never promotes it — state.signals will stay without it (#4342's defect class). Add a playbook row, or a PRODUCERLESS_SIGNALS exemption if no producer exists.`,
    );
  }
  for (const p of result.unproducedRows) {
    console.error(
      `[signal-parity-check] L2 row→emit FAIL: a row's producer '${p}' is emitted by neither collect-state.sh nor target-wip.py — the row claims a promotion hop that does not exist. Fix the row's producer name, or a NON_KV_PRODUCERS exemption if it rides the board-state JSON line.`,
    );
  }
  for (const k of result.unreadRows) {
    console.error(
      `[signal-parity-check] L3 row→read FAIL: the table promotes '${k}' but decide.py never reads it — a dead row. Add the decide.py reader, or an OBSERVATORY_ONLY_ROWS exemption with a rationale.`,
    );
  }
  return result.ok ? 0 : 1;
}

/** True when this module is the process entrypoint (not imported by a test). */
function isMainModule(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  runCli().then((code) => process.exit(code));
}
