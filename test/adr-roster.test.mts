/**
 * Drift guard for the ADR routing layer (issue #4015, follow-up to PR #4013).
 *
 * ## Why this is a test and not a sibling workflow
 *
 * `docs/adr/README.md` (the roster) and `CONTEXT-MAP.md` (the code-area → ADR
 * tables) are the *routing* layer ADR-0037 Decision 6 names as the alternative
 * to compacting the corpus. Both are hand-maintained, and both have already
 * drifted: PR #4013 landed with three stale `CONTEXT-MAP` rows to fix, and a
 * duplicate ADR number (`0016`) that had shipped unnoticed and whose citations
 * resolved ambiguously across live docs, `src/` comments and tests.
 *
 * Routing that rots is worse than no routing — an agent that trusts a stale map
 * reads the wrong ADRs and never learns it did. So the guard lives inside the
 * REQUIRED `npm test` gate. An advisory sibling workflow could not block a merge
 * (no seam-check workflow in this repo is a required check), which is exactly
 * the failure mode that lets a routing defect land.
 *
 * ## Four assertions
 *
 * 1. ROSTER COVERAGE — every `docs/adr/NNNN-*.md` has a roster row, and every
 *    roster row resolves to a file that exists. Both directions, because either
 *    half alone permits a silent hole.
 *
 * 2. UNIQUE NUMBERS — no two ADR files share a 4-digit number. This currently
 *    passes and the point is to keep it that way: the `0016` collision above is
 *    what an unenforced numbering scheme produces, and at the time of writing
 *    issue #3989 and PR #4004 *both* claim `ADR-0034`, so whichever merges
 *    second must renumber. The failure message says so and names the files.
 *
 * 3. MANDATORY STATUS — ADR-0037 Decision 5 makes `Status` required, because a
 *    Hydra ADR states rules an agent must obey and the agent must be able to
 *    tell a live rule from a retired one. THREE spellings are in use and all
 *    three are valid — YAML frontmatter `status:` (0004, 0015, 0002), an inline
 *    `Status:` line under the H1 (0008, 0012), and a `## Status` section (0006).
 *    This guard deliberately accepts all three and does NOT normalise them:
 *    pinning one spelling would be a corpus-wide reformat, which is precisely
 *    the compaction ADR-0037 Decision 6 forbids.
 *
 * 4. PER-AREA NON-GROWTH RATCHET — ADR-0037 Decision 6 holds *routed* weight
 *    flat rather than capping the corpus. The area → ADR mapping is derived
 *    from `CONTEXT-MAP.md`, never hand-written here: one home for the routing
 *    data, only the numbers get baselined in
 *    `test/fixtures/adr-area-baseline.json`. Deliberately raising a baseline in
 *    the same PR is the intended escape hatch; silently growing an area is not.
 *    A side effect worth keeping: deriving the mapping means a `CONTEXT-MAP`
 *    row citing an ADR number that does not exist fails here too.
 *
 * Out of scope, per ADR-0037 Decision 6: this file NEVER motivates trimming,
 * merging or shortening an existing ADR. When an area is over baseline the
 * legitimate resolutions are to re-route (move the ADR to a narrower area) or
 * to bump the baseline on purpose in the same PR.
 *
 * No Redis, no network, no running service — pure filesystem reads.
 *
 * ## Why the assertions aggregate instead of generating one test per ADR / area
 *
 * The first draft generated a subtest per ADR file and per routing row (66 in
 * total, all fully synchronous). Measured directly: `node --test
 * --test-force-exit` reports a NON-DETERMINISTIC count for an all-synchronous
 * file once it gets large — repeated identical runs of that draft returned 66,
 * 47, 38, 23 tests and still exited 0, silently dropping whole suites. A
 * standalone repro (40 trivial `assert.ok(true)` tests, no I/O) reproduces it
 * with no code of ours involved, and the flakiness disappears at this file's
 * size. So each assertion collects ALL offenders and reports them in one
 * message — which is also the better failure report for a drift guard. Do not
 * "improve" this back into a per-item loop.
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ADR_DIR = resolve(REPO_ROOT, "docs/adr");
const ROSTER = resolve(ADR_DIR, "README.md");
const CONTEXT_MAP = resolve(REPO_ROOT, "CONTEXT-MAP.md");
const BASELINE = resolve(REPO_ROOT, "test/fixtures/adr-area-baseline.json");

/** An ADR file on disk: its 4-digit number, filename and byte size. */
export interface AdrFile {
  number: string;
  filename: string;
  bytes: number;
}

/** One `CONTEXT-MAP.md` routing row: an area and the ADR numbers it cites. */
export interface AreaRow {
  area: string;
  adrs: string[];
}

/**
 * Every `docs/adr/NNNN-*.md` on disk, sorted by filename.
 *
 * `README.md` is the roster, not an ADR, so the `NNNN-` prefix is the filter.
 * Duplicate numbers are NOT collapsed here — assertion 2 needs to see them.
 */
export function listAdrFiles(dir: string = ADR_DIR): AdrFile[] {
  return readdirSync(dir)
    .filter((name) => /^\d{4}-.+\.md$/.test(name))
    .sort()
    .map((filename) => ({
      number: filename.slice(0, 4),
      filename,
      bytes: statSync(resolve(dir, filename)).size,
    }));
}

/**
 * The ADR links in the roster table of `docs/adr/README.md`.
 *
 * Rows look like `| [0001](./0001-untouchable-core-and-gate-extraction.md) | … |`
 * so the link target is the filename the row claims. Returns number → filename;
 * both halves of assertion 1 read it.
 */
export function parseRoster(markdown: string): Map<string, string> {
  const rows = new Map<string, string>();
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|")) continue;
    const match = /^\|\s*\[(\d{4})\]\(\.\/(\d{4}-[^)]+\.md)\)/.exec(line);
    if (match) rows.set(match[1], match[2]);
  }
  return rows;
}

/** Strip the markdown a `CONTEXT-MAP` area cell wraps its path in. */
export function normaliseArea(cell: string): string {
  return cell
    .replace(/~~/g, "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Every routing row in `CONTEXT-MAP.md` that carries a "Relevant ADRs" column.
 *
 * Generic over the table shape on purpose — the domain-map table has four
 * columns and the non-`src/` table has two, so the column index is read off
 * each header rather than hardcoded. A table that loses the column simply stops
 * being parsed, which is why the caller asserts on the table count.
 */
export function parseContextMapAreas(markdown: string): { tables: number; rows: AreaRow[] } {
  const lines = markdown.split("\n");
  const rows: AreaRow[] = [];
  let tables = 0;
  let adrColumn = -1;

  const cells = (line: string): string[] =>
    line.replace(/^\|/, "").replace(/\|\s*$/, "").split("|");

  for (const line of lines) {
    if (!line.trim().startsWith("|")) {
      adrColumn = -1;
      continue;
    }
    const parts = cells(line);
    // Header row: the one naming the ADR column.
    const header = parts.findIndex((c) => /relevant adrs/i.test(c));
    if (header !== -1) {
      adrColumn = header;
      tables++;
      continue;
    }
    if (adrColumn === -1) continue;
    if (/^[\s|:-]+$/.test(line)) continue; // `|---|---|` separator
    if (parts.length <= adrColumn) continue;

    const area = normaliseArea(parts[0]);
    if (!area) continue;
    const adrs = [...parts[adrColumn].matchAll(/ADR-(\d{4})/g)].map((m) => m[1]);
    rows.push({ area, adrs: [...new Set(adrs)].sort() });
  }
  return { tables, rows };
}

/**
 * Does this ADR declare a status? All three in-use spellings count.
 *
 * Scoped to the head of the file so a `Status:` mention buried in prose (or a
 * `## Status` reference inside an `Alternatives considered` block) cannot
 * satisfy the gate — a real declaration sits above the body.
 */
export function declaresStatus(markdown: string): boolean {
  const lines = markdown.split("\n");

  // (a) YAML frontmatter `status:`
  if (lines[0]?.trim() === "---") {
    const close = lines.slice(1).findIndex((l) => l.trim() === "---");
    if (close !== -1) {
      const frontmatter = lines.slice(1, close + 1);
      if (frontmatter.some((l) => /^status\s*:/i.test(l.trim()))) return true;
    }
  }

  // (b) inline `Status:` line, or (c) a `## Status` section heading
  return lines
    .slice(0, 30)
    .some((l) => /^\s*(?:\*\*)?status(?:\*\*)?\s*:/i.test(l) || /^#{2,}\s+status\b/i.test(l));
}

const adrFiles = listAdrFiles();
const rosterRows = parseRoster(readFileSync(ROSTER, "utf8"));
const contextMap = parseContextMapAreas(readFileSync(CONTEXT_MAP, "utf8"));
const baseline: Record<string, number> = JSON.parse(readFileSync(BASELINE, "utf8"));

describe("ADR roster coverage (assertion 1)", () => {
  test("the corpus is non-empty and the roster parsed (guards a vacuous pass)", () => {
    assert.ok(adrFiles.length >= 30, `expected 30+ ADR files, found ${adrFiles.length}`);
    assert.ok(rosterRows.size >= 30, `expected 30+ roster rows, parsed ${rosterRows.size}`);
  });

  test("every ADR file has a row in docs/adr/README.md", () => {
    // Matched on FILENAME, not number: a duplicate-numbered file would otherwise
    // borrow its twin's row and slip through this half of the coverage check.
    const rostered = new Set(rosterRows.values());
    const missing = adrFiles.filter((f) => !rostered.has(f.filename)).map((f) => f.filename);
    assert.deepEqual(
      missing,
      [],
      `ADR file(s) with no row in docs/adr/README.md: ${missing.join(", ")}\n` +
        `Fix: add a roster row (number, status, one-sentence decision, "read when") — ` +
        `ADR-0037 Decision 6 makes the roster the routing layer, so an unrostered ADR is invisible.`,
    );
  });

  test("every roster row resolves to an ADR file that exists", () => {
    const onDisk = new Set(adrFiles.map((f) => f.filename));
    const dangling = [...rosterRows.entries()]
      .filter(([, filename]) => !onDisk.has(filename))
      .map(([number, filename]) => `${number} -> ${filename}`);
    assert.deepEqual(
      dangling,
      [],
      `docs/adr/README.md row(s) pointing at a file that does not exist: ${dangling.join(", ")}\n` +
        `Fix: correct the link target, or drop the row if the ADR was renumbered.`,
    );
  });
});

describe("ADR numbers are unique (assertion 2)", () => {
  test("no two ADR files share a 4-digit number", () => {
    const byNumber = new Map<string, string[]>();
    for (const f of adrFiles) {
      byNumber.set(f.number, [...(byNumber.get(f.number) ?? []), f.filename]);
    }
    const collisions = [...byNumber.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([number, files]) => `${number}: ${files.join(" + ")}`);
    assert.deepEqual(
      collisions,
      [],
      `Duplicate ADR number(s) — two unrelated ADRs share one number, so every ` +
        `ADR-NNNN citation to them resolves ambiguously:\n  ${collisions.join("\n  ")}\n` +
        `Fix: RENUMBER the newer file to the next free number (see the reserved-number ` +
        `note at the top of docs/adr/README.md), update its roster row, and re-point its ` +
        `citations. This already happened once: 0036 is a renumbered duplicate 0016.`,
    );
  });
});

describe("every ADR declares a Status (assertion 3 — ADR-0037 Decision 5)", () => {
  test("no ADR is missing its Status declaration", () => {
    const statusless = adrFiles
      .filter((f) => !declaresStatus(readFileSync(resolve(ADR_DIR, f.filename), "utf8")))
      .map((f) => f.filename);
    assert.deepEqual(
      statusless,
      [],
      `ADR(s) declaring no Status: ${statusless.join(", ")}\n` +
        `ADR-0037 Decision 5 makes Status mandatory — an agent must be able to tell a live ` +
        `rule from a retired one.\n` +
        `Fix: add ONE of the three accepted spellings (all three are valid; do NOT normalise ` +
        `the others to match):\n` +
        `  - YAML frontmatter:  ---(newline)status: accepted(newline)---\n` +
        `  - an inline line under the H1:  Status: Accepted\n` +
        `  - a section heading:  ## Status`,
    );
  });

  test("all three status spellings are recognised (guards the detector itself)", () => {
    assert.ok(declaresStatus("---\nstatus: accepted\n---\n\n# ADR-9999: x\n"), "frontmatter");
    assert.ok(declaresStatus("# ADR-9999: x\n\nStatus: Accepted\n"), "inline line");
    assert.ok(declaresStatus("# ADR-9999: x\n\n## Status\n\nAccepted\n"), "section heading");
    assert.ok(!declaresStatus("# ADR-9999: x\n\nSome prose.\n"), "no declaration");
  });
});

describe("per-area ADR weight ratchet (assertion 4 — ADR-0037 Decision 6)", () => {
  test("both CONTEXT-MAP.md routing tables were parsed", () => {
    assert.equal(
      contextMap.tables,
      2,
      `Expected 2 tables with a "Relevant ADRs" column in CONTEXT-MAP.md, found ` +
        `${contextMap.tables}. A table that loses that column stops being ratcheted ` +
        `silently — restore the column, or update this count deliberately.`,
    );
    assert.ok(contextMap.rows.length >= 15, `parsed only ${contextMap.rows.length} area rows`);
  });

  test("every ADR cited by CONTEXT-MAP.md exists on disk", () => {
    const onDisk = new Set(adrFiles.map((f) => f.number));
    const dangling: string[] = [];
    for (const row of contextMap.rows) {
      for (const number of row.adrs) {
        if (!onDisk.has(number)) dangling.push(`${row.area} cites ADR-${number}`);
      }
    }
    assert.deepEqual(
      dangling,
      [],
      `CONTEXT-MAP.md routes to ADR(s) that do not exist:\n  ${dangling.join("\n  ")}\n` +
        `Fix: correct the number in CONTEXT-MAP.md (a typo, or an ADR that was renumbered).`,
    );
  });

  test("the baseline covers exactly the areas CONTEXT-MAP.md declares", () => {
    const areas = [...new Set(contextMap.rows.map((r) => r.area))].sort();
    const keys = Object.keys(baseline).sort();
    const missing = areas.filter((a) => !(a in baseline));
    const stale = keys.filter((k) => !areas.includes(k));
    assert.deepEqual(
      { missing, stale },
      { missing: [], stale: [] },
      `test/fixtures/adr-area-baseline.json is out of sync with CONTEXT-MAP.md.\n` +
        `  Areas with no baseline entry: ${missing.join(", ") || "(none)"}\n` +
        `  Baseline entries with no CONTEXT-MAP row: ${stale.join(", ") || "(none)"}\n` +
        `Fix: add/remove the entry to match the routing tables. A new area starts at its ` +
        `measured byte sum; a removed row drops its key.`,
    );
  });

  test("no area exceeds its baseline routed ADR weight", () => {
    const sizes = new Map(adrFiles.map((f) => [f.number, f.bytes]));
    const over: string[] = [];
    for (const row of new Map(contextMap.rows.map((r) => [r.area, r])).values()) {
      const limit = baseline[row.area];
      if (typeof limit !== "number") continue; // covered by the key-sync test above
      const actual = row.adrs.reduce((sum, n) => sum + (sizes.get(n) ?? 0), 0);
      if (actual > limit) {
        over.push(
          `${row.area}\n` +
            `      ADRs:     ${row.adrs.map((n) => `ADR-${n}`).join(", ") || "(none)"}\n` +
            `      baseline: ${limit} bytes\n` +
            `      actual:   ${actual} bytes (+${actual - limit})`,
        );
      }
    }
    assert.deepEqual(
      over,
      [],
      `Routed ADR weight grew past baseline for:\n    ${over.join("\n    ")}\n` +
        `ADR-0037 Decision 6 holds routed weight flat so a task loads 2-4 ADRs, not 35.\n` +
        `Fix (pick one): re-route — move the ADR to a narrower CONTEXT-MAP.md area — OR raise ` +
        `that area's number in test/fixtures/adr-area-baseline.json IN THIS PR, deliberately.\n` +
        `Do NOT trim, merge or shorten an existing ADR: ADR-0037 Decision 6 forbids managing ` +
        `the corpus by compaction.`,
    );
  });
});
