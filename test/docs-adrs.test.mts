/**
 * The adrs inventory family (#4593) — the rules behind docs/generated/adrs.json,
 * the generated-in-place roster table, the /docs ADR views' pure helpers, and
 * the two cross-module parities that keep them honest.
 *
 * Scope split with its siblings:
 *  - test/generated-inventories-drift.test.mts asserts the COMMITTED inventory
 *    bytes equal a fresh registry run (drift) and pins corpus membership.
 *  - test/adr-roster.test.mts guards routing coverage and the marker shape.
 *  - THIS file pins the pure extraction/render rules on injected text and
 *    small throwaway trees, the §N anchor rule in dashboard/vite-plugins/
 *    docs-core.js, the view helpers in dashboard/src/pages/docs/adrs.js, and
 *    the live-corpus parities (strip-vs-extractor, roster-cells-vs-rows).
 *
 * AGGREGATE OFFENDERS only — never one subtest per ADR. `--test-force-exit`
 * drops large synchronous subtest sets non-deterministically (measured at the
 * top of test/adr-roster.test.mts); the live-corpus tests below iterate all
 * ADRs INSIDE one test and report every offender in a single message.
 *
 * No Redis, no network, no running service. dashboard/vite-plugins/docs-core.js
 * and dashboard/src/pages/docs/adrs.js are plain-JS, marked-free modules by
 * design (see docs-core.js's header note), so the root node:test suite can pin
 * them without dashboard/node_modules — same lane as test/docs-page.test.mts.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  citationsByText,
  extractAdrs,
  HEAD_WINDOW,
  parseAdrHeader,
  parseRosterInput,
  renderRosterReadme,
  renderRosterTable,
  ROSTER_BEGIN_MARKER,
  ROSTER_END_MARKER,
} from "../scripts/docs/inventories/adrs.ts";
import type { AdrRow, CorpusRow } from "../scripts/docs/inventories/envelope.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ADR_DIR = join(REPO_ROOT, "docs/adr");
const ROSTER = join(ADR_DIR, "README.md");
const ADRS_JSON: { rows: AdrRow[] } = JSON.parse(readFileSync(join(REPO_ROOT, "docs/generated/adrs.json"), "utf8"));
const CORPUS_JSON: { rows: CorpusRow[] } = JSON.parse(readFileSync(join(REPO_ROOT, "docs/generated/corpus.json"), "utf8"));

/** A synthetic roster README: hand-authored prose around the two markers. */
function rosterMd(rows: string[]): string {
  return [
    "# ADR Roster",
    "",
    "Hand-authored prose above the table.",
    "",
    ROSTER_BEGIN_MARKER,
    "| ADR | Status | Decision | Read when |",
    "|---|---|---|---|",
    ...rows,
    ROSTER_END_MARKER,
    "",
    "## Numbering",
    "",
    "Hand-authored prose below the table.",
    "",
  ].join("\n");
}

/** A throwaway tree of repo-relative files; the caller removes it in `finally`. */
function withTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "hydra-docs-adrs-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

/** A minimal AdrRow — only the fields renderRosterTable/parseRosterInput read. */
function mkRow(overrides: Partial<AdrRow> & { number: string }): AdrRow {
  return {
    file: `docs/adr/${overrides.number}-sample.md`,
    route: `/docs/adr/${overrides.number}`,
    title: "Sample",
    status: "accepted",
    statusLine: "accepted",
    statusDialect: "inline",
    date: null,
    supersedes: [],
    supersededBy: [],
    decision: "The decision.",
    readWhen: "When to read.",
    citedBy: [],
    source: { path: `docs/adr/${overrides.number}-sample.md`, line: 1 },
    ...overrides,
  };
}

/** Heading tokens for outlineTokens WITHOUT marked: a fence-aware ATX scan. */
function headingTokens(
  markdown: string,
): Array<{ type: "heading"; depth: number; text: string; tokens: Array<{ type: "text"; text: string }> }> {
  const out: Array<{ type: "heading"; depth: number; text: string; tokens: Array<{ type: "text"; text: string }> }> = [];
  let fence: string | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const f = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (f) {
      if (fence === null) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) out.push({ type: "heading", depth: h[1].length, text: h[2], tokens: [{ type: "text", text: h[2] }] });
  }
  return out;
}

/** Split a roster row on unescaped pipes, same rule as the extractor's splitRow. */
function rosterCells(line: string): string[] {
  return line
    .replace(/\\\|/g, "\u0000")
    .split("|")
    .map((c) => c.replace(/\u0000/g, "\\|").trim());
}

describe("adrs.ts pure builders (#4593)", () => {
  test("pure builders pin header parse, roster parse/render/splice and the citation scan on injected text", () => {
    // Header parse on injected text — no live tree involved.
    const header = parseAdrHeader(
      "0042-sample.md",
      "---\nstatus: accepted\n---\n\n# ADR-0042: Sample decision\n\nbody\n",
    );
    assert.equal(header.number, "0042");
    assert.equal(header.title, "Sample decision");
    assert.equal(header.status, "accepted");
    assert.equal(header.statusDialect, "frontmatter");

    // Render + splice + re-parse round-trip on an injected README.
    const row = mkRow({ number: "0042", statusLine: "accepted (amended | twice)" });
    const table = renderRosterTable([row]);
    assert.ok(table.startsWith(ROSTER_BEGIN_MARKER));
    assert.ok(table.endsWith(ROSTER_END_MARKER));
    assert.ok(table.includes("| ADR | Status | Decision | Read when |"));
    // A statusLine's literal pipe is escaped, so it cannot break the cell.
    assert.ok(table.includes("accepted (amended \\| twice)"));

    const committed = rosterMd(["| [0042](./0042-sample.md) | stale | Old | cells |"]);
    const spliced = renderRosterReadme(committed, [row]);
    // Fixpoint: a second splice changes nothing.
    assert.equal(renderRosterReadme(spliced, [row]), spliced);
    // Every byte outside the markers is preserved verbatim.
    assert.ok(spliced.startsWith("# ADR Roster\n"));
    assert.ok(spliced.includes("Hand-authored prose above the table."));
    assert.ok(spliced.endsWith("Hand-authored prose below the table.\n"));
    // The hand-authored cells survive a re-parse keyed by number.
    assert.deepEqual(parseRosterInput(spliced).get("0042"), {
      decision: "The decision.",
      readWhen: "When to read.",
    });

    // The citation scan over injected member texts.
    const cites = citationsByText([
      { path: "docs/x.md", text: "see ADR-0042 and ADR-0042 again" },
      { path: "docs/y.md", text: "per ADR-0042." },
    ]);
    assert.deepEqual(cites.get("0042"), ["docs/x.md", "docs/y.md"]);
  });

  test("parseAdrHeader reads all three status spellings and rejects a leading token outside the closed vocabulary", () => {
    const frontmatter = parseAdrHeader("0091-a.md", "---\nstatus: superseded-in-part\n---\n\n# ADR-0091: A\n");
    assert.equal(frontmatter.status, "superseded-in-part");
    assert.equal(frontmatter.statusDialect, "frontmatter");
    assert.equal(frontmatter.statusLine, "superseded-in-part");

    const inline = parseAdrHeader("0092-a.md", "# ADR-0092: B\n\nStatus: Accepted (amended)\n");
    assert.equal(inline.status, "accepted");
    assert.equal(inline.statusDialect, "inline");
    assert.equal(inline.statusLine, "Accepted (amended)");

    const section = parseAdrHeader("0093-a.md", "# ADR-0093: C\n\n## Status\n\nDeprecated — see ADR-0001.\n\n## Decision\n");
    assert.equal(section.status, "deprecated");
    assert.equal(section.statusDialect, "section");
    assert.equal(section.statusLine, "Deprecated — see ADR-0001.");

    // The vocabulary is closed: any other leading token is an extraction error naming the file.
    assert.throws(() => parseAdrHeader("0094-a.md", "# ADR-0094: D\n\nStatus: Boggled\n"), /0094-a\.md.*closed vocabulary/s);
    // Status is mandatory (ADR-0037 Decision 5) — prose alone fails.
    assert.throws(() => parseAdrHeader("0094-a.md", "# ADR-0094: D\n\njust prose\n"), /no Status declaration/s);
    // The filename must be NNNN-slug.md — the number is the join key.
    assert.throws(() => parseAdrHeader("no-number.md", "# X\n\nStatus: Accepted\n"), /not an NNNN-slug\.md/s);
  });

  test("date reads the head Date line or the token after the status word, and relations link symmetrically in both directions", () => {
    assert.equal(parseAdrHeader("0081-a.md", "# ADR-0081: A\n\nDate: 2026-03-04\nStatus: Accepted\n").date, "2026-03-04");
    assert.equal(parseAdrHeader("0082-a.md", "# ADR-0082: B\n\nStatus: Accepted 2026-05-14\n").date, "2026-05-14");
    // No date anywhere — null, never derived from git.
    assert.equal(parseAdrHeader("0083-a.md", "# ADR-0083: C\n\nStatus: Accepted\n").date, null);
    // Relations read from the status line and a head Supersedes: line.
    const declared = parseAdrHeader(
      "0084-a.md",
      "# ADR-0084: D\n\nStatus: Superseded by ADR-0001 and ADR-0002\n",
    );
    assert.deepEqual(declared.supersededByRaw, ["0001", "0002"]);
    assert.deepEqual(
      parseAdrHeader("0085-a.md", "# ADR-0085: E\n\nStatus: Accepted\n\nSupersedes: ADR-0001, ADR-0002\n").supersedesRaw,
      ["0001", "0002"],
    );

    // extractAdrs unions each relation with its inverse: an edge recorded from
    // ONE side lands on both rows, and relations never change status.
    const root = withTree({
      "docs/adr/0001-a.md": "# ADR-0001: A\n\nStatus: Superseded by ADR-0002\n",
      "docs/adr/0002-a.md": "# ADR-0002: B\n\nStatus: Accepted\n\nSupersedes: ADR-0001\n",
      "docs/adr/0003-a.md": "# ADR-0003: C\n\nStatus: Accepted\n\nSupersedes: ADR-0004\n",
      "docs/adr/0004-a.md": "# ADR-0004: D\n\nStatus: Accepted\n",
      "docs/adr/README.md": rosterMd([
        "| [0001](./0001-a.md) | superseded | d | r |",
        "| [0002](./0002-a.md) | accepted | d | r |",
        "| [0003](./0003-a.md) | accepted | d | r |",
        "| [0004](./0004-a.md) | accepted | d | r |",
      ]),
    });
    try {
      const corpus = ["0001-a.md", "0002-a.md", "0003-a.md", "0004-a.md"].map((f): CorpusRow => ({
        path: `docs/adr/${f}`,
        tier: "adr",
        route: `/docs/adr/${f.slice(0, 4)}`,
        title: "fixture",
      }));
      const byNumber = new Map(extractAdrs(root, corpus).rows.map((r) => [r.number, r]));
      // Declared from BOTH sides — one symmetric pair.
      assert.deepEqual(byNumber.get("0001")!.supersededBy, ["0002"]);
      assert.deepEqual(byNumber.get("0002")!.supersedes, ["0001"]);
      // Declared from ONE side only — the inverse still lands on the other row.
      assert.deepEqual(byNumber.get("0003")!.supersedes, ["0004"]);
      assert.deepEqual(byNumber.get("0004")!.supersededBy, ["0003"]);
      // Relations never change status: status comes only from the leading token.
      assert.equal(byNumber.get("0001")!.status, "superseded");
      assert.equal(byNumber.get("0004")!.status, "accepted");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("parseRosterInput reads only Decision and Read-when cells and fails on every malformed roster shape", () => {
    const good = rosterMd(["| [0001](./0001-a.md) | accepted | The decision | When to read |"]);
    assert.deepEqual(parseRosterInput(good).get("0001"), { decision: "The decision", readWhen: "When to read" });

    const row = (cells: string) => rosterMd([cells]);
    assert.throws(() => parseRosterInput(row("| [0001](./0001-a.md) | accepted | | When to read |")), /Decision.*cell is empty/s);
    assert.throws(() => parseRosterInput(row("| [0001](./0001-a.md) | accepted | D | |")), /Read when cell is empty/s);
    // An unescaped pipe becomes a fifth cell — the error names the expected count.
    assert.throws(() => parseRosterInput(row("| [0001](./0001-a.md) | accepted | a | b | c |")), /expected 4/s);
    assert.throws(
      () =>
        parseRosterInput(
          rosterMd(["| [0001](./0001-a.md) | accepted | D | R |", "| [0001](./0001-a.md) | accepted | D | R |"]),
        ),
      /duplicate roster row/s,
    );
    // A row outside the markers is never regenerated — extraction error.
    const lines = good.split("\n");
    const outside = [...lines.slice(0, 3), "| [0009](./0009-a.md) | accepted | D | R |", ...lines.slice(3)].join("\n");
    assert.throws(() => parseRosterInput(outside), /OUTSIDE the adr-roster markers/s);

    // Marker shape: missing, duplicated, out of order.
    assert.throws(() => parseRosterInput(good.replace(`${ROSTER_BEGIN_MARKER}\n`, "")), /adr-roster:begin.*marker/s);
    assert.throws(() => parseRosterInput(good.replace(ROSTER_END_MARKER, `${ROSTER_END_MARKER}\n${ROSTER_END_MARKER}`)), /appears 2 times/s);
    assert.throws(
      () => parseRosterInput(good.replace(ROSTER_END_MARKER, ROSTER_BEGIN_MARKER).replace(ROSTER_BEGIN_MARKER, ROSTER_END_MARKER)),
      /begin marker must precede/s,
    );
  });

  test("extractAdrs joins files, roster and citations into rows and fails loud on coverage gaps", () => {
    // Happy path: citedBy from a text scan over EVERY tier, the ADR itself excluded.
    const root = withTree({
      "docs/adr/0001-a.md": "# ADR-0001: A\n\nStatus: Accepted\n",
      "docs/adr/0002-a.md": "# ADR-0002: B\n\nStatus: Accepted\n\nSee ADR-0001.\n",
      "docs/ref/x.md": "# X\n\nADR-0001 and ADR-0002 cited here.\n",
      "docs/adr/README.md": rosterMd([
        "| [0001](./0001-a.md) | accepted | d | r |",
        "| [0002](./0002-a.md) | accepted | d | r |",
      ]),
    });
    try {
      const corpus: CorpusRow[] = [
        { path: "docs/adr/0001-a.md", tier: "adr", route: "/docs/adr/0001", title: "A" },
        { path: "docs/adr/0002-a.md", tier: "adr", route: "/docs/adr/0002", title: "B" },
        { path: "docs/ref/x.md", tier: "living", route: "/docs/ref/x", title: "X" },
      ];
      const inv = extractAdrs(root, corpus);
      assert.equal(inv.family, "adrs");
      assert.equal(inv.schemaVersion, 1);
      const one = inv.rows.find((r) => r.number === "0001")!;
      assert.deepEqual(one.citedBy, ["docs/adr/0002-a.md", "docs/ref/x.md"]);
      assert.deepEqual(inv.rows.map((r) => r.number), ["0001", "0002"], "rows sorted by number");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    // An ADR file with no roster row.
    const noRow = withTree({
      "docs/adr/0001-a.md": "# ADR-0001: A\n\nStatus: Accepted\n",
      "docs/adr/README.md": rosterMd([]),
    });
    try {
      assert.throws(
        () => extractAdrs(noRow, [{ path: "docs/adr/0001-a.md", tier: "adr", route: "/docs/adr/0001", title: "A" }]),
        /0001-a\.md has no row in/s,
      );
    } finally {
      rmSync(noRow, { recursive: true, force: true });
    }

    // A roster row with no file.
    const dangling = withTree({ "docs/adr/README.md": rosterMd(["| [0007](./0007-a.md) | accepted | d | r |"]) });
    try {
      assert.throws(() => extractAdrs(dangling, []), /row for ADR-0007 but no/s);
    } finally {
      rmSync(dangling, { recursive: true, force: true });
    }

    // Two files sharing a number.
    const dup = withTree({
      "docs/adr/0001-a.md": "# ADR-0001: A\n\nStatus: Accepted\n",
      "docs/adr/0001-b.md": "# ADR-0001: B\n\nStatus: Accepted\n",
      "docs/adr/README.md": rosterMd(["| [0001](./0001-a.md) | accepted | d | r |"]),
    });
    try {
      assert.throws(
        () =>
          extractAdrs(dup, [
            { path: "docs/adr/0001-a.md", tier: "adr", route: "/docs/adr/0001", title: "A" },
            { path: "docs/adr/0001-b.md", tier: "adr", route: "/docs/adr/0001", title: "B" },
          ]),
        /duplicate ADR number 0001/s,
      );
    } finally {
      rmSync(dup, { recursive: true, force: true });
    }
  });

  test("citationsByText is a word-boundary text scan over member texts, path-level, deduplicated", () => {
    const index = citationsByText([
      { path: "a.md", text: "ADR-0001, ADR-0002 and again ADR-0001" },
      { path: "b.md", text: "per ADR-0002." },
      { path: "c.md", text: "ADR-00010 has five digits" },
      { path: "d.md", text: "lowercase adr-0001 never matches" },
      { path: "e.md", text: "ADR-0003" },
    ]);
    assert.deepEqual(index.get("0001"), ["a.md"], "deduplicated, one entry per member");
    assert.deepEqual(index.get("0002"), ["a.md", "b.md"], "word boundary, trailing punctuation fine");
    assert.deepEqual(index.get("0003"), ["e.md"], "a bare token at text start matches");
    assert.equal(index.has("0010"), false, "ADR-00010 is not ADR-0010 — the boundary blocks it");
    assert.equal(index.has("0004"), false, "an uncited number has no entry");
  });

  test("extractAdrs fails loud with the [docs-inventories] prefix on a supersedes edge citing a nonexistent ADR", () => {
    const root = withTree({
      "docs/adr/0001-a.md": "# ADR-0001: A\n\nStatus: Accepted. Supersedes ADR-9999.\n",
      "docs/adr/README.md": rosterMd(["| [0001](./0001-a.md) | accepted | d | r |"]),
    });
    try {
      const corpus: CorpusRow[] = [{ path: "docs/adr/0001-a.md", tier: "adr", route: "/docs/adr/0001", title: "A" }];
      assert.throws(
        () => extractAdrs(root, corpus),
        (e: Error) => /^\[docs-inventories\]/.test(e.message) && e.message.includes("ADR-9999") && e.message.includes("0001-a.md"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("committed inventory parity (#4593)", () => {
  test("adrs.json rows and corpus.json adr-tier rows are the same 1:1 set with the full row shape", () => {
    const adrRows = ADRS_JSON.rows;
    const corpusAdr = CORPUS_JSON.rows.filter((r) => r.tier === "adr");
    assert.ok(adrRows.length >= 30, `expected 30+ ADR rows, found ${adrRows.length} — guards a vacuous pass`);

    const offenders: string[] = [];
    const adrPaths = new Set(adrRows.map((r) => r.file));
    const corpusPaths = new Set(corpusAdr.map((r) => r.path));
    for (const p of adrPaths) if (!corpusPaths.has(p)) offenders.push(`adrs row with no corpus adr row: ${p}`);
    for (const p of corpusPaths) if (!adrPaths.has(p)) offenders.push(`corpus adr row with no adrs row: ${p}`);

    const FIELDS = [
      "number", "file", "route", "title", "status", "statusLine", "statusDialect", "date",
      "supersedes", "supersededBy", "decision", "readWhen", "citedBy", "source",
    ] as const;
    adrRows.forEach((r, i) => {
      for (const f of FIELDS) {
        if (!(f in r)) offenders.push(`ADR-${r.number}: row is missing the "${f}" field`);
      }
      if (r.route !== `/docs/adr/${r.number}`) offenders.push(`ADR-${r.number}: route is ${r.route}, expected /docs/adr/${r.number}`);
      if (r.source?.path !== r.file) offenders.push(`ADR-${r.number}: source.path is ${r.source?.path}, expected ${r.file}`);
      if (r.file === "docs/adr/README.md") offenders.push("the roster README must never be an adrs row");
      if (i > 0 && !(adrRows[i - 1].number < r.number)) offenders.push(`rows are not sorted by number at ADR-${r.number}`);
    });
    assert.deepEqual(
      offenders,
      [],
      `docs/generated/adrs.json row-shape offenders:\n  ${offenders.join("\n  ")}\nFix: regenerate with npm run docs:inventories.`,
    );
  });

  test("every roster Status cell equals its ADR file's statusLine and the moved annotations live in Decision cells", () => {
    const byNumber = new Map(ADRS_JSON.rows.map((r) => [r.number, r]));
    const offenders: string[] = [];
    let rowsSeen = 0;
    for (const line of readFileSync(ROSTER, "utf8").split("\n")) {
      const m = /^\|\s*\[(\d{4})\]\(/.exec(line);
      if (!m) continue;
      rowsSeen += 1;
      const cells = rosterCells(line);
      const row = byNumber.get(m[1]);
      if (!row) {
        offenders.push(`roster row ADR-${m[1]} has no adrs.json row`);
        continue;
      }
      const statusCell = (cells[2] ?? "").replace(/\\\|/g, "|");
      if (statusCell !== row.statusLine) {
        offenders.push(`ADR-${m[1]}: roster Status cell "${statusCell}" != file statusLine "${row.statusLine}"`);
      }
    }
    assert.ok(rowsSeen >= 30, `parsed only ${rowsSeen} roster rows — guards a vacuous pass`);

    // INV-7: annotations that used to live only in roster Status cells moved
    // into the SAME row's Decision cell — not dropped, not pushed into files.
    const MOVED: Array<[string, string]> = [
      ["0024", "Amended twice in 2026-09"],
      ["0034", "Amended 2026-09"],
      ["0035", "Supersedes ADR-0030 Decision 2"],
      ["0036", "Renumbered from a duplicate"],
    ];
    for (const [n, fragment] of MOVED) {
      if (!(byNumber.get(n)?.decision ?? "").includes(fragment)) {
        offenders.push(`ADR-${n}: the annotation "${fragment}" is absent from its Decision cell`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `roster/adrs.json parity offenders:\n  ${offenders.join("\n  ")}\n` +
        `Fix: npm run docs:inventories regenerates every Status cell from the files' own declarations.`,
    );
  });
});

describe("docs-core ADR rules (#4593)", () => {
  test("section ids go only to depth-3 numbered headings inside a Decision section - ADR-0012 Context gets none, D1-D6 do", async () => {
    const core = await import("../dashboard/vite-plugins/docs-core.js");
    // The rule, pinned directly.
    assert.equal(core.sectionNumber(3, "1. First rule", true), "1");
    assert.equal(core.sectionNumber(3, "D1 — Scheduler is bookkeeping-only", true), "1");
    assert.equal(core.sectionNumber(3, "Decision 2: Continuous state", true), "2");
    assert.equal(core.sectionNumber(3, "D10 — the tenth", true), "10");
    assert.equal(core.sectionNumber(3, "1. A Context concern", false), null, "Context headings never qualify");
    assert.equal(core.sectionNumber(2, "1. Not depth three", true), null);
    assert.equal(core.sectionNumber(3, "Positive", true), null, "an unnumbered heading never qualifies");

    // ADR-0012 on the live corpus: six numbered Context concerns badge-free, D1-D6 badged.
    const file = readdirSync(ADR_DIR).find((n) => /^0012-/.test(n));
    assert.ok(file, "docs/adr/0012-*.md not found");
    const { headings } = core.outlineTokens(headingTokens(readFileSync(join(ADR_DIR, file), "utf8")));
    const offenders: string[] = [];
    let contextNumbered = 0;
    let decisionNumbered = 0;
    // The enclosing ## section's TITLE — outlineTokens' own predicate input
    // (h.section is only its slug, which need not spell "decision").
    let sectionTitle = "";
    for (const h of headings) {
      if (h.depth === 2) sectionTitle = h.text;
      const inDecision = /^decisions?\b/i.test(sectionTitle);
      if (h.sec !== null && !inDecision) {
        offenders.push(`§${h.sec} outside a Decision section: "${h.text}" (under "${sectionTitle}")`);
      }
      if (/^context\b/i.test(sectionTitle) && h.depth === 3 && /^\d+\.\s/.test(h.text)) {
        contextNumbered += 1;
        if (h.sec !== null) offenders.push(`Context concern got a § badge: "${h.text}"`);
      }
      const d = /^D(\d+)\b/.exec(h.text);
      if (inDecision && d) {
        decisionNumbered += 1;
        if (h.sec !== d[1]) offenders.push(`"${h.text}" got §${h.sec}, expected §${d[1]}`);
      }
    }
    assert.equal(contextNumbered, 6, `expected ADR-0012's six numbered Context concerns, found ${contextNumbered}`);
    assert.equal(decisionNumbered, 6, `expected ADR-0012's D1-D6, found ${decisionNumbered}`);
    assert.deepEqual(
      offenders,
      [],
      `§N anchor offenders in ADR-0012:\n  ${offenders.join("\n  ")}\n` +
        `Fix: the rule in dashboard/vite-plugins/docs-core.js sectionNumber — §N keys only on Decision-section headings.`,
    );
  });

  test("prepareAdrSource drops frontmatter, header Status and Date lines and the head Status section, keeping later bytes", async () => {
    const core = await import("../dashboard/vite-plugins/docs-core.js");
    // Frontmatter dialect: stripped, its status captured.
    const fm = core.prepareAdrSource("---\nstatus: accepted\n---\n\n# ADR-0091: A\n\nStatus: Accepted\n\nbody\n");
    assert.equal(fm.status, "accepted");
    assert.ok(!fm.source.includes("Status:"), "the redundant inline Status line is dropped");
    assert.ok(fm.source.includes("# ADR-0091: A"));
    assert.ok(fm.source.includes("body"));

    // An all-Key:value first paragraph: Status and Date drop, the rest become bullets.
    const kv = core.prepareAdrSource(
      "# ADR-0092: B\n\nStatus: Accepted\nDate: 2026-01-02\nDeciders: gaberoo\nIssue: 42\n\n## Decision\n\nbody\n",
    );
    assert.equal(kv.status, "Accepted");
    assert.ok(!kv.source.includes("Status: Accepted"));
    assert.ok(!kv.source.includes("Date: 2026-01-02"));
    assert.ok(kv.source.includes("- Deciders: gaberoo"));
    assert.ok(kv.source.includes("- Issue: 42"));
    assert.ok(kv.source.includes("## Decision"));

    // A first paragraph that is not all Key:value stays verbatim.
    const prose = core.prepareAdrSource("# ADR-0093: C\n\nJust prose, no header block.\n\n## Decision\n");
    assert.ok(prose.source.includes("Just prose, no header block."));
    assert.equal(prose.status, null);

    // The section dialect: the whole head ## Status section goes.
    const sec = core.prepareAdrSource("# ADR-0094: D\n\n## Status\n\nAccepted, live doctrine.\n\n## Decision\n\nbody\n");
    assert.equal(sec.status, "Accepted, live doctrine.");
    assert.ok(!sec.source.includes("## Status"));
    assert.ok(sec.source.includes("## Decision"));
  });

  test("for every live ADR the status prepareAdrSource removes equals the extractor's statusLine", async () => {
    const core = await import("../dashboard/vite-plugins/docs-core.js");
    const offenders: string[] = [];
    let seen = 0;
    for (const name of readdirSync(ADR_DIR).filter((n) => /^\d{4}-.+\.md$/.test(n)).sort()) {
      seen += 1;
      const text = readFileSync(join(ADR_DIR, name), "utf8");
      const expected = parseAdrHeader(name, text).statusLine;
      const got = core.prepareAdrSource(text).status;
      if (got !== expected) {
        offenders.push(`${name}\n      extractor statusLine: ${JSON.stringify(expected)}\n      strip removed:        ${JSON.stringify(got)}`);
      }
    }
    assert.ok(seen >= 30, `scanned only ${seen} ADR files — guards a vacuous pass`);
    assert.deepEqual(
      offenders,
      [],
      `prepareAdrSource/extractor status parity offenders (${offenders.length}):\n  ${offenders.join("\n  ")}\n` +
        `Fix: the two readers must agree on every Status spelling — see readStatus in ` +
        `scripts/docs/inventories/adrs.ts and prepareAdrSource in dashboard/vite-plugins/docs-core.js.`,
    );
  });

  test("prepareAdrSource scopes the Status strip to the head window and keeps a later body '## Status' section and subsections when an inline Status heads the file", async () => {
    const core = await import("../dashboard/vite-plugins/docs-core.js");
    const src =
      "# ADR-0095: E\n\nStatus: Accepted\n\n## Decision\n\nbody\n\n## Status of rollout\n\nShipped in phases.\n\n### Phase 1\n\nkept\n";
    const r = core.prepareAdrSource(src);
    assert.equal(r.status, "Accepted");
    assert.ok(r.source.includes("## Status of rollout"), "body Status section survives");
    assert.ok(r.source.includes("Shipped in phases."));
    assert.ok(r.source.includes("### Phase 1"));
    // Head-window section dialect removes only the heading + first paragraph, never ### subsections.
    const sec = core.prepareAdrSource("# ADR-0096: F\n\n## Status\n\nAccepted.\n\n### Notes\n\nkept note\n\n## Decision\n\nx\n");
    assert.equal(sec.status, "Accepted.");
    assert.ok(!sec.source.includes("## Status"));
    assert.ok(sec.source.includes("### Notes") && sec.source.includes("kept note"));
    // A '## Status' past the head window is body content, not the status.
    const late = core.prepareAdrSource("# ADR-0097: G\n\n" + "filler line\n\n".repeat(20) + "## Status\n\nlate para\n");
    assert.ok(late.source.includes("## Status") && late.source.includes("late para"));
  });

  test("sectionNumber and the Decision-section gate follow the INV-11 number and title rules strictly", async () => {
    const core = await import("../dashboard/vite-plugins/docs-core.js");
    assert.equal(core.sectionNumber(3, "1.2 Subpoint", true), null, "decimal is not a section number");
    assert.equal(core.sectionNumber(3, "2026-09 rollout", true), null, "digits then hyphen-digit is a date");
    assert.equal(core.sectionNumber(3, "1; thing", true), null, "semicolon is not a delimiter");
    assert.equal(core.sectionNumber(3, "12345 widgets", true), null, "digit run is capped");
    assert.equal(core.sectionNumber(3, "1. First", true), "1");
    assert.equal(core.sectionNumber(3, "D2 — Two", true), "2");
    const heads = (title: string) =>
      core.outlineTokens(headingTokens(`# T\n\n## ${title}\n\n### 1. First\n`)).headings.find((h: { depth: number }) => h.depth === 3);
    assert.equal(heads("Decision").sec, "1");
    assert.equal(heads("Decisions").sec, "1");
    assert.equal(heads("Decision Drivers").sec, null);
    assert.equal(heads("Decision Log").sec, null);
  });

  test("buildNameIndex lists the ADR entry first, omits Context headings and keeps section-bearing Decision headings", async () => {
    const core = await import("../dashboard/vite-plugins/docs-core.js");
    const path = "docs/adr/0099-sample.md";
    const rows = [{ path, tier: "adr", route: "/docs/adr/0099", title: "ADR-0099: Sample thing" }];
    const outlines = new Map([
      [
        path,
        {
          headings: [
            { depth: 2, text: "Context", slug: "context", sec: null },
            { depth: 3, text: "1. A context concern", slug: "1-a-context-concern", sec: null },
            { depth: 2, text: "Decision", slug: "decision", sec: null },
            { depth: 3, text: "1. Pick it", slug: "1-pick-it", sec: "1" },
          ],
        },
      ],
    ]);
    const hosts = new Map(
      ["context", "1-a-context-concern", "decision", "1-pick-it"].map((s) => [`${path}#${s}`, "docs/adr/0099"]),
    );
    const entries = core.buildNameIndex({
      views: [{ key: "docs/adr/0099", historical: false }],
      outlines,
      hosts,
      rows,
      glossaryTerms: [],
      routeRows: [],
    });
    assert.equal(entries[0].name, "ADR-0099 Sample thing");
    assert.equal(entries[0].kind, "adr");
    const names = entries.map((e: { name: string }) => e.name);
    assert.ok(!names.includes("Context"), "Context heading not indexed");
    assert.ok(!names.includes("1. A context concern"));
    assert.ok(names.includes("1. Pick it"), "section-bearing Decision heading indexed");
  });

  test("docs-core status strip and adrs.ts readStatus agree on the head window and on every status spelling", async () => {
    const core = await import("../dashboard/vite-plugins/docs-core.js");
    assert.equal(core.ADR_HEAD_WINDOW, HEAD_WINDOW, "head windows must match");
    const fixtures: Record<string, string> = {
      frontmatter: "---\nstatus: accepted\n---\n\n# ADR-0091: A\n\nbody\n",
      inline: "# ADR-0092: B\n\nStatus: Accepted (amended)\n\n## Decision\n\nx\n",
      section: "# ADR-0094: D\n\n## Status\n\nAccepted.\n\n## Decision\n\nx\n",
      lateSection: "# ADR-0095: E\n\n" + "filler line\n\n".repeat(20) + "## Status\n\nlate para\n",
    };
    for (const [name, text] of Object.entries(fixtures)) {
      const stripped = core.prepareAdrSource(text);
      let extracted: string | null = null;
      try {
        extracted = parseAdrHeader(`0091-${name}.md`, text).statusLine;
      } catch {
        /* intentional: a fixture with no in-window Status is expected to make the extractor fail */
      }
      assert.equal(stripped.status, extracted, `parity mismatch on fixture "${name}"`);
    }
  });
});

describe("adrs.js view helpers (#4593)", () => {
  test("partitionAdrRows puts live statuses first in number order and mutes superseded or deprecated below the rule", async () => {
    const view = await import("../dashboard/src/pages/docs/adrs.js");
    const row = (number: string, status: string) => ({ number, status });
    const parts = view.partitionAdrRows([
      row("0040", "superseded"),
      row("0002", "accepted"),
      row("0041", "deprecated"),
      row("0001", "superseded-in-part"),
      row("0003", "proposed"),
    ]);
    assert.deepEqual(parts.active.map((r: { number: string }) => r.number), ["0001", "0002", "0003"]);
    assert.deepEqual(parts.demoted.map((r: { number: string }) => r.number), ["0040", "0041"]);
    assert.deepEqual(view.partitionAdrRows(null), { active: [], demoted: [] }, "null rows degrade to empty halves");

    // The strip renders the status line as PLAIN text — markdown syntax stripped.
    assert.equal(
      view.plainStatusLine("**Status:** `accepted` [per ADR-0015](./0015.md) ~~old~~"),
      "Status: accepted per ADR-0015 old",
    );
    assert.equal(view.plainStatusLine(null), "");

    // The one route rule for ADR numbers.
    assert.equal(view.adrRoute("0042"), "/docs/adr/0042");
  });
});
