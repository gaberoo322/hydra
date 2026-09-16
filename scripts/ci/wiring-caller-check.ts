#!/usr/bin/env -S npx tsx
/**
 * Wiring caller-reachability + signal-parity checks — wiring-liveness gamma
 * (issue #2289, parent epic #2286) and iota (issue #4519).
 *
 * Catches the ORIGINAL no-caller failure class at PR time: an exported,
 * production-critical symbol with zero references anywhere outside its own
 * definition. That is the class of bug that shipped `seedVerifiedPairRegistry`
 * wired into nothing — it type-checked, it passed tests in isolation, and it
 * silently never ran because no live caller referenced it. The runtime
 * wiring-liveness chore (src/scheduler/chores/wiring-liveness.ts, #2287) catches
 * a declared TIMER that never went live; this static check is its complement on
 * the CALLER axis: it would have flagged the orphaned symbol at review time,
 * before merge.
 *
 * Issue #4519 adds the SIGNAL axis (`type: signal` entries): the interface
 * between collect-state.sh (~150 named `key=value` emissions), decide.py (a
 * pure function that only sees whatever lands in state.json), and the
 * playbook's hand-maintained Signal wiring table is not code — nothing
 * mechanically checked that every emitted signal has a table row, or that
 * every row's target field is actually read in decide.py. That gap shipped
 * `design_qa_target_due` (#4342) and `retro_run_drillable` (#3871/#4244) as
 * absent-and-falsy. The signal check cross-references all three artifacts and
 * flags emitted-but-unrowed / row-field-never-read drift, with explicit
 * manifest-carried exemptions (observability-only emissions, and unrowed
 * signals whose verified decide.py consumer is named so its death is still
 * caught).
 *
 * Source of truth: config/direction/liveness.yaml. Each declared `type: caller`
 * entry names a `symbol` that MUST be referenced somewhere outside the file
 * that defines it; each declared `type: signal` entry names the three
 * artifacts of the autopilot signal contract plus its exemption lists. The
 * check exits non-zero (and names the offender) on any violation.
 *
 * ADVISORY, not a merge gate: this script is wired only into the standalone
 * .github/workflows/advisory-checks.yml advisory workflow — deliberately NOT
 * added to ci.yml and NOT a required branch-protection check (ci.yml is
 * Verifier Core / Tier-4, ADR-0001/ADR-0015; a new verification lands as a
 * Tier-3 sibling per the same pattern ast-grep-lint / eval-gate / comby-check
 * follow, operator memory feedback_ci_gate_separate_workflow_avoids_tier0).
 *
 * "knip-backed reachability": knip (a devDependency) is the project's
 * authoritative whole-project dead-export detector. This check narrows knip's
 * signal to the SPECIFIC declared symbols — it counts references to each caller
 * symbol across the project source, excluding the symbol's own definition file,
 * so a symbol whose only mention is its own `export` is flagged. The reference
 * scan reuses the same project glob knip is configured with (src/ + scripts/),
 * so the two stay in agreement about what "the project" is.
 *
 * NEVER THROWS into the caller of the pure functions (CLAUDE.md fail-loud +
 * the repo's check-script convention): a manifest read/parse error is surfaced
 * as a non-zero exit with a diagnostic, not an uncaught exception. The pure
 * functions return result objects so the test can assert on them directly.
 *
 * Usage:
 *   node --no-warnings --experimental-strip-types scripts/ci/wiring-caller-check.ts
 *   npx tsx scripts/ci/wiring-caller-check.ts
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

/** Repo root — three levels up from scripts/ci/. */
const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");

/** Default manifest path; the test points the loader at a fixture instead. */
const DEFAULT_MANIFEST_PATH = join(REPO_ROOT, "config", "direction", "liveness.yaml");

/**
 * Project source roots scanned for references. Mirrors the `project` globs in
 * knip.json (`src/**`, `scripts/**`) so the reference scan agrees with knip
 * about what "the project" is. Kept as directory roots (the scanner walks them)
 * rather than globs to avoid a glob dependency.
 */
const PROJECT_ROOTS = ["src", "scripts"] as const;

/** File extensions the reference scan considers source. */
const SOURCE_EXTENSIONS = [".ts", ".mts", ".tsx", ".js", ".mjs", ".jsx"] as const;

// ---------------------------------------------------------------------------
// Manifest-entry parsing (shared row walker + per-type row shapes)
//
// A minimal YAML-subset parser scoped to the rows of liveness.yaml this script
// cares about (`type: caller`, `type: signal`). It follows the PATTERN of
// src/scheduler/chores/wiring-liveness.ts (a tiny no-dependency tokenizer; no
// js-yaml/yaml runtime dependency, ADR-0005) but is intentionally
// self-contained to this in-scope script rather than importing the chore's
// parser — this check owns only the caller/signal axes and must not couple to
// the timer-axis chore module.
//
// CONSTRAINT (issue #4519, measured against parseConfigYaml): every entry must
// stay a FLAT `key: scalar` row. The runtime chore's YAML subset rejects
// nested lists under an entry key ("unrecognized indented syntax") and
// silently mis-parses nested list-of-maps into phantom entries, so the
// signal entry carries its exemption lists as comma-separated scalars.
//
// A caller entry looks like:
//   - unit: seedVerifiedPairRegistry        # symbol falls back to `unit` if no `symbol`
//     type: caller
//     symbol: seedVerifiedPairRegistry      # the exported symbol that must have a live caller
//     defFile: src/registry/seed.ts         # (optional) file that DEFINES the symbol
//     description: ...                       # (optional)
//
// A signal entry looks like:
//   - unit: autopilot-signal-parity
//     type: signal
//     collectScript: scripts/autopilot/collect-state.sh
//     decideScript: scripts/autopilot/decide.py
//     playbookDoc: docs/operator-playbooks/hydra-autopilot.md
//     observabilityOnly: redis,scheduler    # (optional) emitted, deliberately unrowed+unread
//     unrowedConsumes: slot_events_json=slot_events  # (optional) emitted, unrowed, consumed via field
//     description: ...                       # (optional)
// ---------------------------------------------------------------------------

/** A declared caller entry from the manifest. */
export interface CallerEntry {
  /** The exported symbol that must be referenced outside its own definition. */
  symbol: string;
  /**
   * Optional path to the file that DEFINES the symbol. References inside this
   * file are excluded from the reachability count (a symbol referencing itself
   * inside its own definition is not a live caller). Repo-relative.
   */
  defFile?: string;
  /** Optional human-readable note. */
  description?: string;
}

/**
 * A declared signal-parity entry from the manifest (issue #4519). Names the
 * three artifacts of the autopilot signal contract plus the explicit
 * exemption lists that keep the advisory check green on intentional
 * non-promotions.
 */
export interface SignalEntry {
  /** Entry name — the manifest's primary key (informational here). */
  unit: string;
  /** Repo-relative path of the emitting collector (collect-state.sh). */
  collectScript: string;
  /** Repo-relative path of the pure consumer (decide.py). */
  decideScript: string;
  /** Repo-relative path of the playbook holding the Signal wiring table. */
  playbookDoc: string;
  /**
   * Emitted signals that are deliberately NOT promoted: no table row, no
   * decide.py read (observability-only — the operator/model reads them inline
   * in the collect-state stream). Kept honest by the exempt-stale verdict.
   */
  observabilityOnly: string[];
  /**
   * Emitted signals with no table row but a VERIFIED decide.py consumer,
   * resolved as `signal=field`: the autopilot merges the emission into
   * state.json under `field` (the `*_json` → state-field rename convention) or
   * reads it from state.signals under `field`. The check verifies the field is
   * still read, so the consumer's death stays caught.
   */
  unrowedConsumes: Array<{ signal: string; field: string }>;
  /** Optional human-readable note. */
  description?: string;
}

/** Strip a trailing `# ...` comment that is not inside a quoted scalar. */
function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) return line.slice(0, i);
  }
  return line;
}

/** Unquote a scalar token (drop matching surrounding quotes), else trim. */
function parseScalar(raw: string): string {
  const v = raw.trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    return v.slice(1, -1);
  }
  return v;
}

/** Split a comma-separated scalar into a trimmed, de-emptyed list. */
function parseCsvList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Walk the `entries:` list of a liveness-manifest YAML string into raw
 * `key → scalar` records. Shared by the caller and signal row parsers so both
 * axes stay in agreement about what a row is.
 *
 * Pure and never-throws: a structurally odd line is skipped rather than fatal,
 * matching the repo's lenient-subset-parser precedent.
 */
function parseManifestRows(raw: string): Array<Record<string, string>> {
  const rows: Array<Record<string, string>> = [];
  let current: Record<string, string> | null = null;
  let inEntries = false;

  for (const rawLine of raw.split("\n")) {
    const line = stripComment(rawLine);
    if (line.trim() === "") continue;

    // Top-level `entries:` introduces the list.
    if (/^entries\s*:/.test(line)) {
      inEntries = true;
      continue;
    }
    // Any other top-level (column-0, non-list) key ends the entries list.
    if (inEntries && /^[^\s-]/.test(line)) {
      inEntries = false;
    }
    if (!inEntries) continue;

    const listItem = line.match(/^\s*-\s*(.*)$/);
    if (listItem) {
      // New list item. The remainder after `- ` may be a `key: value` pair.
      current = {};
      rows.push(current);
      const rest = listItem[1];
      const kv = rest.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
      if (kv) current[kv[1]] = parseScalar(kv[2]);
      continue;
    }

    // A `  key: value` line belonging to the most recent list item.
    if (current) {
      const kv = line.match(/^\s+([A-Za-z0-9_]+)\s*:\s*(.*)$/);
      if (kv) current[kv[1]] = parseScalar(kv[2]);
    }
  }

  return rows;
}

/**
 * Parse the `type: caller` entries out of a liveness-manifest YAML string.
 *
 * Returns only caller entries — timer (or any other type) rows are ignored, so
 * the shared manifest can carry both axes. A row with no `symbol:` falls back to
 * its `unit:` value as the symbol (the manifest's primary key), so a caller can
 * be declared with just `unit` + `type: caller`.
 *
 * Pure and never-throws: a structurally odd line is skipped rather than fatal,
 * matching the repo's lenient-subset-parser precedent.
 */
export function parseCallerEntries(raw: string): CallerEntry[] {
  const callers: CallerEntry[] = [];
  for (const row of parseManifestRows(raw)) {
    if (row.type !== "caller") continue;
    const symbol = (row.symbol ?? row.unit ?? "").trim();
    if (symbol === "") continue;
    const entry: CallerEntry = { symbol };
    if (row.defFile) entry.defFile = row.defFile;
    if (row.description) entry.description = row.description;
    callers.push(entry);
  }
  return callers;
}

/**
 * Parse the `type: signal` entries out of a liveness-manifest YAML string
 * (issue #4519). Non-signal rows are ignored, so the shared manifest can carry
 * the timer/output/caller axes alongside this one.
 *
 * `unrowedConsumes` pairs are `signal=field`, comma-separated; a pair without
 * `=` is skipped (a malformed exemption must never widen or crash the check —
 * the well-formed remainder still runs). The CLI validates that the artifact
 * paths are present; the parser itself stays total.
 */
export function parseSignalEntries(raw: string): SignalEntry[] {
  const signals: SignalEntry[] = [];
  for (const row of parseManifestRows(raw)) {
    if (row.type !== "signal") continue;
    const unit = (row.unit ?? "").trim();
    if (unit === "") continue;
    const entry: SignalEntry = {
      unit,
      collectScript: (row.collectScript ?? "").trim(),
      decideScript: (row.decideScript ?? "").trim(),
      playbookDoc: (row.playbookDoc ?? "").trim(),
      observabilityOnly: parseCsvList(row.observabilityOnly),
      unrowedConsumes: parseCsvList(row.unrowedConsumes)
        .map((pair) => {
          const eq = pair.indexOf("=");
          if (eq <= 0) return null;
          return { signal: pair.slice(0, eq).trim(), field: pair.slice(eq + 1).trim() };
        })
        .filter((p): p is { signal: string; field: string } => p !== null),
    };
    if (row.description) entry.description = row.description;
    signals.push(entry);
  }
  return signals;
}

// ---------------------------------------------------------------------------
// Reachability check
// ---------------------------------------------------------------------------

/** One source file the reference scan considers: its repo-relative path + text. */
export interface SourceFile {
  /** Repo-relative path, e.g. `src/registry/seed.ts`. */
  path: string;
  /** Full file contents. */
  content: string;
}

/** A single unreferenced-caller finding. */
export interface CallerViolation {
  symbol: string;
  message: string;
}

/** The outcome of a reachability check over a set of caller entries. */
export interface CallerCheckResult {
  ok: boolean;
  violations: CallerViolation[];
  /** Per-symbol reference count (outside its own definition), for diagnostics. */
  counts: Record<string, number>;
}

/**
 * Count whole-word references to `symbol` in `content`. A word boundary on both
 * sides avoids matching `seedVerifiedPairRegistryV2` when looking for
 * `seedVerifiedPairRegistry`. The symbol is regex-escaped so a literal name with
 * regex metacharacters cannot break the match.
 */
function countReferences(symbol: string, content: string): number {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`, "g");
  const matches = content.match(re);
  return matches ? matches.length : 0;
}

/**
 * Pure reachability check. For each declared caller symbol, count references
 * across all project source files EXCEPT the symbol's own definition file
 * (`defFile`). A symbol with zero references outside its definition is a
 * violation — it is exported (or declared critical) but wired into nothing.
 *
 * `defFile` matching is by suffix so `src/registry/seed.ts` matches a scanned
 * path of the same value; if no `defFile` is declared, every file counts (the
 * symbol must be referenced somewhere in the project at all).
 */
export function checkCallerReachability(
  callers: CallerEntry[],
  files: SourceFile[],
): CallerCheckResult {
  const violations: CallerViolation[] = [];
  const counts: Record<string, number> = {};

  for (const entry of callers) {
    let refs = 0;
    for (const file of files) {
      const isDefFile = entry.defFile
        ? file.path === entry.defFile || file.path.endsWith(`/${entry.defFile}`)
        : false;
      if (isDefFile) continue;
      refs += countReferences(entry.symbol, file.content);
    }
    counts[entry.symbol] = refs;
    if (refs === 0) {
      const where = entry.defFile ? ` (defined in ${entry.defFile})` : "";
      violations.push({
        symbol: entry.symbol,
        message:
          `Declared caller symbol '${entry.symbol}'${where} has NO reference ` +
          `outside its own definition — it is wired into nothing. Either add a ` +
          `live caller or remove the entry from config/direction/liveness.yaml.`,
      });
    }
  }

  return { ok: violations.length === 0, violations, counts };
}

// ---------------------------------------------------------------------------
// Signal-parity check (issue #4519) — `type: signal` entries
//
// The autopilot signal contract spans three artifacts:
//
//   scripts/autopilot/collect-state.sh  emits ~150 named `key=value` signals
//   docs/operator-playbooks/hydra-autopilot.md  the Signal wiring table (the
//                                       hand-maintained signal→field mapping)
//   scripts/autopilot/decide.py         reads fields off state.json/state.signals
//
// The middle hop is PROSE, so an emitted-but-never-promoted signal ships
// silently (#4342 design_qa_target_due, #3871/#4244 retro_run_drillable —
// decide.py read them absent-and-falsy). These extractors + the parity verdict
// below make that drift mechanical. All are pure functions over file TEXT so
// the test pins them with fixtures, exactly like the caller axis above.
// ---------------------------------------------------------------------------

/**
 * Extract every signal name collect-state.sh emits to stdout.
 *
 * The emission surface is heterogeneous by design (the STRUCTURE comment,
 * issue #4266): `echo "name=value"`, `echo -n "name="` + a computed tail,
 * python `print('name=' + …)` / `print(f'name={…} other={…}')` heredoc bodies
 * (composite single lines!), and multi-arg `printf '%s\n' "name=…" "name=…"`.
 * The common denominator: a quoted string literal on a line containing an
 * `echo`/`print`/`printf` command, carrying a `name=` token at the literal's
 * start or after whitespace. A word boundary on the left keeps
 * `prefix_bearer=` from matching `bearer=`; deduping collapses fallback paths
 * that re-emit the same name.
 *
 * Comment lines are skipped (a retired emission stays retired). Assignments
 * and `sed`/`jq` expressions never contain an `echo`/`print`/`printf` command
 * on the same line, so they are invisible here by construction.
 */
export function extractEmittedSignals(collectStateText: string): string[] {
  const names = new Set<string>();
  const tokenRe = /(?:^|\s)([a-z][a-z0-9_]*)=/g;
  for (const rawLine of collectStateText.split("\n")) {
    if (rawLine.trimStart().startsWith("#")) continue;
    if (!/\b(echo|print|printf)\b/.test(rawLine)) continue;
    const spanRe = /"([^"\n]*)"|'([^'\n]*)'/g;
    let span: RegExpExecArray | null;
    while ((span = spanRe.exec(rawLine)) !== null) {
      const literal = span[1] ?? span[2] ?? "";
      let tok: RegExpExecArray | null;
      tokenRe.lastIndex = 0;
      while ((tok = tokenRe.exec(literal)) !== null) {
        names.add(tok[1]);
      }
    }
  }
  return [...names].sort();
}

/** One parsed row of the playbook's Signal wiring table. */
export interface SignalTableRow {
  /**
   * Every leading identifier of every backtick code-span in every cell — the
   * row's coverage set for "is this signal mentioned anywhere in the table".
   * Column 1 is prose with thresholds (`ready_for_agent > 0`), so matching is
   * by mention, not by exact name.
   */
  mentioned: string[];
  /**
   * The promoted state field named by column 2's first code-span, with a
   * leading `state.signals.` / `state.` prefix stripped (the emitted name and
   * the merged field are the same seam, differently addressed). Undefined when
   * column 2 carries no code-span (e.g. `(advisory only)`).
   */
  field?: string;
  /**
   * True when the row's own text declares non-consumption ("advisory only" /
   * "observability only") — the row documents deliberate non-promotion and is
   * exempt from the field-read requirement.
   */
  selfExempt: boolean;
  /** The full row text (diagnostics). */
  text: string;
}

/**
 * Extract the Signal wiring table rows from the playbook.
 *
 * The table lives under the `## Signal wiring` heading and ends at the next
 * `## ` heading. Markdown table cells escape pipes as `\|` (e.g.
 * `target_wip_saturated=true\|false`); splitting on bare `|` would shred those
 * rows into phantom cells, so escaped pipes are protected before the split and
 * restored after. The header row and the `|---|` separator are skipped.
 */
export function extractSignalTable(playbookText: string): SignalTableRow[] {
  const startMatch = /^## Signal wiring/m.exec(playbookText);
  if (!startMatch || startMatch.index === undefined) return [];
  const afterStart = playbookText.slice(startMatch.index + startMatch[0].length);
  const nextSection = /^## /m.exec(afterStart);
  const section = nextSection ? afterStart.slice(0, nextSection.index) : afterStart;

  const rows: SignalTableRow[] = [];
  for (const line of section.split("\n")) {
    if (!line.trimStart().startsWith("|")) continue;
    // Protect `\|` escapes, split on real pipes, restore.
    const protectedLine = line.replace(/\\\|/g, "\x00");
    const cells = protectedLine
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim().replace(/\x00/g, "|"));
    if (cells.length < 2) continue;
    if (cells[0].startsWith("---")) continue; // separator row
    if (/^collect-state output$/i.test(cells[0].replace(/`/g, "").trim())) continue;

    const mentioned: string[] = [];
    for (const cell of cells) {
      for (const span of cell.matchAll(/`([^`]+)`/g)) {
        const id = /^([a-z_][a-z0-9_]*)/.exec(span[1]);
        if (id) mentioned.push(id[1]);
      }
    }

    let field: string | undefined;
    const col2span = /`([^`]+)`/.exec(cells[1]);
    if (col2span) {
      const cleaned = col2span[1]
        .replace(/^state\.signals\./, "")
        .replace(/^state\./, "");
      const id = /^([a-z_][a-z0-9_]*)/.exec(cleaned);
      if (id && id[1] !== "state" && id[1] !== "signals") field = id[1];
    }

    rows.push({
      mentioned,
      field,
      selfExempt: /advisory only|observability only/i.test(line),
      text: line.trim(),
    });
  }
  return rows;
}

/**
 * Extract every field name decide.py could be reading, as the set of
 * whole-content identifier STRING LITERALS in the source.
 *
 * decide.py's read surface is `_signal_present(state, events, "name")`,
 * `(state.get("signals") or {}).get("name")`, `state.get("field")`, and
 * table-driven passes whose VALUES are signal names
 * (`ESCALATION_SATURATION_SIGNAL = {slot: "name"}` — the name is later handed
 * to `_signal_present` via variable). The common denominator across all four
 * is a quoted literal whose ENTIRE content is the identifier. Docstring
 * mentions don't qualify: they appear as `` `name=true` `` prose, not as a
 * bare quoted identifier, so a documented-but-unread signal still fails the
 * parity check instead of hiding inside its own documentation.
 */
export function extractReadFields(decidePyText: string): string[] {
  const names = new Set<string>();
  const re = /"([a-z_][a-z0-9_]*)"|'([a-z_][a-z0-9_]*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(decidePyText)) !== null) {
    names.add(m[1] ?? m[2] ?? "");
  }
  return [...names].sort();
}

/** One signal-parity finding. `kind` is the failure class, `name` the offender. */
export interface SignalParityViolation {
  kind:
    | "emitted-no-row"
    | "row-field-never-read"
    | "exempt-consumer-gone"
    | "exempt-stale";
  name: string;
  message: string;
}

/** The outcome of a signal-parity check over one manifest entry's artifacts. */
export interface SignalCheckResult {
  ok: boolean;
  violations: SignalParityViolation[];
  /** Diagnostic totals: emitted names, table-mentioned names, decide.py read literals, exemptions. */
  counts: {
    emitted: number;
    rowed: number;
    readFields: number;
    observabilityOnly: number;
    unrowedConsumes: number;
  };
}

/**
 * Pure parity check over the three artifacts named by a `type: signal`
 * manifest entry (issue #4519). Failure classes, each the mechanical form of
 * a shipped incident:
 *
 * - `emitted-no-row` — collect-state.sh emits the signal but the playbook's
 *   Signal wiring table never mentions it and no manifest exemption covers
 *   it: decide.py reads it absent-and-falsy (the #4342/#4244 class).
 * - `row-field-never-read` — a table row promotes a state field decide.py
 *   never reads (a stale row naming dead wiring), unless the row's own text
 *   declares "advisory only" / "observability only".
 * - `exempt-consumer-gone` — an `unrowedConsumes` exemption names a decide.py
 *   field that is no longer read: the documented consumer died.
 * - `exempt-stale` — an exemption names a signal collect-state.sh no longer
 *   emits: the exemption list itself drifted.
 */
export function checkSignalParity(
  entry: SignalEntry,
  texts: {
    collectStateText: string;
    decideText: string;
    playbookText: string;
  },
): SignalCheckResult {
  const emitted = new Set(extractEmittedSignals(texts.collectStateText));
  const read = new Set(extractReadFields(texts.decideText));
  const rows = extractSignalTable(texts.playbookText);
  const mentioned = new Set<string>();
  for (const row of rows) {
    for (const name of row.mentioned) mentioned.add(name);
    if (row.field) mentioned.add(row.field);
  }
  const obs = new Set(entry.observabilityOnly);

  const violations: SignalParityViolation[] = [];

  for (const signal of emitted) {
    if (mentioned.has(signal) || obs.has(signal)) continue;
    if (entry.unrowedConsumes.some((p) => p.signal === signal)) continue;
    violations.push({
      kind: "emitted-no-row",
      name: signal,
      message:
        `Signal '${signal}' is emitted by ${entry.collectScript} but has NO row in ` +
        `${entry.playbookDoc}'s Signal wiring table and no manifest exemption — ` +
        `${entry.decideScript} will read it as absent-and-falsy (the ` +
        `#4342/#4244 emitted-but-never-promoted class). Add a wiring row, or ` +
        `declare it observabilityOnly/unrowedConsumes in config/direction/liveness.yaml.`,
    });
  }

  for (const row of rows) {
    if (!row.field || row.selfExempt) continue;
    if (read.has(row.field)) continue;
    violations.push({
      kind: "row-field-never-read",
      name: row.field,
      message:
        `Signal wiring row promotes field '${row.field}' but ${entry.decideScript} ` +
        `never reads that name (no whole-content string literal) — the row names ` +
        `dead wiring. Row: ${row.text.slice(0, 160)}`,
    });
  }

  for (const pair of entry.unrowedConsumes) {
    if (read.has(pair.field)) continue;
    violations.push({
      kind: "exempt-consumer-gone",
      name: pair.signal,
      message:
        `Signal '${pair.signal}' is exempted as consumed via field '${pair.field}', ` +
        `but ${entry.decideScript} never reads that field — the documented consumer ` +
        `died. Re-wire the signal or drop the exemption.`,
    });
  }

  const exemptNames = [
    ...entry.observabilityOnly,
    ...entry.unrowedConsumes.map((p) => p.signal),
  ];
  for (const name of exemptNames) {
    if (emitted.has(name)) continue;
    violations.push({
      kind: "exempt-stale",
      name,
      message:
        `Exemption '${name}' is stale — ${entry.collectScript} no longer emits ` +
        `that signal. Remove it from config/direction/liveness.yaml.`,
    });
  }

  return {
    ok: violations.length === 0,
    violations,
    counts: {
      emitted: emitted.size,
      rowed: mentioned.size,
      readFields: read.size,
      observabilityOnly: entry.observabilityOnly.length,
      unrowedConsumes: entry.unrowedConsumes.length,
    },
  };
}

// ---------------------------------------------------------------------------
// CLI plumbing (filesystem-backed; the pure functions above are tested)
// ---------------------------------------------------------------------------

/** Recursively collect source files under a directory root, relative to base. */
async function collectSourceFiles(
  absRoot: string,
  base: string,
): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
  let names: string[];
  try {
    // `readdir` without `withFileTypes` returns `string[]` names — avoids the
    // `Dirent<NonSharedBuffer>` generic the test-tsconfig infers; each entry is
    // then classified with a `stat` call below.
    names = await readdir(absRoot);
  } catch {
    // A missing root is not fatal — it just contributes no files.
    return out;
  }
  for (const name of names) {
    if (name === "node_modules" || name === ".git") continue;
    const abs = join(absRoot, name);
    const rel = join(base, name);
    let isDir: boolean;
    try {
      isDir = (await stat(abs)).isDirectory();
    } catch (err) {
      console.error(`[wiring-caller-check] could not stat ${rel}:`, err);
      continue;
    }
    if (isDir) {
      out.push(...(await collectSourceFiles(abs, rel)));
    } else if (SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext))) {
      try {
        out.push({ path: rel, content: await readFile(abs, "utf8") });
      } catch (err) {
        console.error(`[wiring-caller-check] could not read ${rel}:`, err);
      }
    }
  }
  return out;
}

/** Run the checks against the real manifest + project source. Returns an exit code. */
async function runCli(manifestPath = DEFAULT_MANIFEST_PATH): Promise<number> {
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (err) {
    console.error(
      `[wiring-caller-check] could not read manifest ${manifestPath}:`,
      err,
    );
    return 2;
  }

  let exitCode = 0;

  // ── caller axis (`type: caller`) ────────────────────────────────────────
  const callers = parseCallerEntries(raw);
  if (callers.length === 0) {
    console.log(
      "[wiring-caller-check] no `type: caller` entries declared — nothing to check.",
    );
  } else {
    const files: SourceFile[] = [];
    for (const root of PROJECT_ROOTS) {
      files.push(...(await collectSourceFiles(join(REPO_ROOT, root), root)));
    }

    const result = checkCallerReachability(callers, files);
    if (result.ok) {
      console.log(
        `[wiring-caller-check] OK — all ${callers.length} declared caller symbol(s) have a live reference.`,
      );
    } else {
      for (const v of result.violations) {
        console.error(`[wiring-caller-check] FAIL: ${v.message}`);
      }
      exitCode = 1;
    }
  }

  // ── signal axis (`type: signal`, issue #4519) ───────────────────────────
  const signalEntries = parseSignalEntries(raw);
  for (const entry of signalEntries) {
    if (!entry.collectScript || !entry.decideScript || !entry.playbookDoc) {
      console.error(
        `[wiring-signal-check] entry '${entry.unit}' is missing collectScript/decideScript/playbookDoc — cannot check.`,
      );
      exitCode = exitCode === 0 ? 2 : exitCode;
      continue;
    }
    const texts: Record<string, string> = {};
    let missing = false;
    for (const [label, path] of [
      ["collectStateText", entry.collectScript],
      ["decideText", entry.decideScript],
      ["playbookText", entry.playbookDoc],
    ] as const) {
      try {
        texts[label] = await readFile(join(REPO_ROOT, path), "utf8");
      } catch (err) {
        console.error(
          `[wiring-signal-check] entry '${entry.unit}': could not read ${path}:`,
          err,
        );
        missing = true;
      }
    }
    if (missing) {
      exitCode = exitCode === 0 ? 2 : exitCode;
      continue;
    }

    const result = checkSignalParity(entry, {
      collectStateText: texts.collectStateText!,
      decideText: texts.decideText!,
      playbookText: texts.playbookText!,
    });
    if (result.ok) {
      console.log(
        `[wiring-signal-check] OK (${entry.unit}) — ${result.counts.emitted} emitted / ` +
          `${result.counts.rowed} rowed / ${result.counts.readFields} read literals / ` +
          `${result.counts.observabilityOnly + result.counts.unrowedConsumes} exempt.`,
      );
    } else {
      for (const v of result.violations) {
        console.error(`[wiring-signal-check] FAIL (${v.kind}): ${v.message}`);
      }
      exitCode = 1;
    }
  }

  return exitCode;
}

/** True when this module is the process entrypoint (not imported by a test). */
function isCliEntrypoint(moduleUrl: string): boolean {
  return Boolean(
    process.argv[1] && fileURLToPath(moduleUrl) === resolve(process.argv[1]),
  );
}

if (isCliEntrypoint(import.meta.url)) {
  runCli().then(
    (code) => process.exit(code),
    (err) => {
      console.error("[wiring-caller-check] crash:", err);
      process.exit(2);
    },
  );
}
