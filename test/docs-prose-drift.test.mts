/**
 * test/docs-prose-drift.test.mts — docs-epic 11/13 (issue #4597).
 *
 * Two aggregate baseline guards (new offenders / stale rows) over the real
 * tree, plus rule tests that pin the GRAMMAR of scripts/docs/prose-drift.ts
 * on throwaway trees and injected text — the test imports the scanner's
 * functions and never re-implements a regex, so there is one extraction
 * truth and the assertions here are about its rules, not today's corpus
 * contents. Aggregate offenders (never per-row subtests) so a truncated
 * TAP tail cannot hide the failing row.
 */

import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { before, describe, test } from "node:test";
import {
  BASELINE_FILE,
  FIX_COMMAND,
  NEW_FIX_COMMAND,
  RETIRED_TERMS_FILE,
  kindOfRow,
  blankProse,
  classifyToken,
  compareBaseline,
  countClaimsIn,
  envVarClaimResolves,
  normaliseRedisKey,
  offenderRowsAndIndex,
  paragraphSpans,
  pathClaimResolves,
  placeholderSkipped,
  readBaseline,
  runProseDriftCli,
  redisKeyClaimResolves,
  renderReport,
  routeClaimResolves,
  retiredTermAdmitted,
  scanProseDrift,
  skillClaimResolves,
  termRegex,
  type Offender,
} from "../scripts/docs/prose-drift.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Build a throwaway tree, run `fn(root)`, always remove the tree. */
async function withFixture(files: Record<string, string>, fn: (root: string) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "prose-drift-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
    await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("docs-prose-drift", () => {
  let scanRows: string[];
  let byRow: Map<string, Offender>;

  before(() => {
    // One scan of the real tree feeds both aggregate guards — it reads every
    // scoped doc plus the env-var source blob and is far too slow to repeat.
    const offenders = scanProseDrift(REPO_ROOT);
    ({ rows: scanRows, byRow } = offenderRowsAndIndex(offenders));
  });

  // -- the two baseline guards (the required drift arms) ---------------------

  test("no NEW prose offenders since the baseline — identifier existence, retired terms, counts, links all backed", () => {
    const baseline = JSON.parse(readFileSync(join(REPO_ROOT, BASELINE_FILE), "utf8")) as string[];
    const { added } = compareBaseline(scanRows, baseline);
    deepStrictEqual(added, [], renderReport("new", added, byRow));
  });

  test("no STALE baseline rows — the baseline shrinks only via regeneration", () => {
    const baseline = JSON.parse(readFileSync(join(REPO_ROOT, BASELINE_FILE), "utf8")) as string[];
    const { removed } = compareBaseline(scanRows, baseline);
    deepStrictEqual(removed, [], renderReport("stale", removed, byRow));
  });

  test("the baseline fixture is sorted and deduped (one row per file:kind:token)", () => {
    const baseline = JSON.parse(readFileSync(join(REPO_ROOT, BASELINE_FILE), "utf8")) as string[];
    deepStrictEqual(baseline, [...new Set(baseline)].sort());
  });

  test("the retired-terms fixture is well-formed and carries the epic's seed terms", () => {
    const terms = JSON.parse(readFileSync(join(REPO_ROOT, RETIRED_TERMS_FILE), "utf8")) as Array<{ term: string; retiredBy: string }>;
    const seeded = new Map(terms.map((t) => [t.term, t.retiredBy]));
    for (const [term, retiredBy] of [
      ["Codex", "ADR-0006"],
      ["OpenViking", "ADR-0033"],
      ["src/gate.ts", "ADR-0006"],
      ["in-process control loop", "ADR-0006"],
      ["src/anchor-selection/", "ADR-0036"],
      ["Candidate Feed", "#3455"],
      ["Autopilot Focus", "#4538"],
      ["Research Floor", "#710"],
      ["Feedback File", "#2975"],
    ] as const) {
      strictEqual(seeded.get(term), retiredBy, `retired-terms fixture must seed ${term} -> ${retiredBy}`);
    }
    for (const t of terms) ok(/^(ADR-\d{4}|#\d+)$/.test(t.retiredBy), `retiredBy must be an ADR-NNNN or #NNNN, got ${t.retiredBy}`);
    ok(!seeded.has("hydra-betting"), "hydra-betting is mothballed, not retired — it must not be denied");
  });

  // -- grammar rules on injected text ----------------------------------------

  test("classifyToken dispatches by shape, and shell variables are not env-var claims", () => {
    strictEqual(classifyToken("src/foo.ts:12"), "path");
    strictEqual(classifyToken("test/backlog.test.mts"), "path");
    strictEqual(classifyToken("GET /api/health"), "route");
    strictEqual(classifyToken("/api/health"), "route");
    strictEqual(classifyToken("hydra:autopilot:slots"), "redis-key");
    strictEqual(classifyToken("hydra-dev"), "skill");
    strictEqual(classifyToken("/hydra-target-build"), "skill");
    strictEqual(classifyToken("PORT"), null, "no underscore — not an env-var claim");
    strictEqual(classifyToken("$MY_VAR"), null, "$NAME shell form is not a claim");
    strictEqual(classifyToken("${MY_VAR}"), null, "${NAME} shell form is not a claim");
    strictEqual(classifyToken("hydra-redis-1"), null, "digits fail the skill grammar (hydra-redis-1 is a hostname)");
    strictEqual(classifyToken("plain prose"), null);
  });

  test("placeholders are skipped after redis-key normalisation but not for other kinds", () => {
    ok(placeholderSkipped("path", "src/foo/*.ts"), "glob path is a shape");
    ok(placeholderSkipped("path", "docs/generated/<file>"), "angle-bracket path is a shape");
    ok(placeholderSkipped("env-var", "MY_{INDEX}_VAR"), "brace token is a shape");
    strictEqual(placeholderSkipped("redis-key", "hydra:dc:{anchorRef}"), false, "typed params normalise to * and STAY claims");
    ok(placeholderSkipped("redis-key", "hydra:logs:NNNN"), "NNNN stays a placeholder");
  });

  test("normaliseRedisKey maps param holders to * and strips a trailing family wildcard", () => {
    strictEqual(normaliseRedisKey("hydra:dc:{anchorRef}:meta"), "hydra:dc:*:meta", "mid-pattern holders become *");
    strictEqual(normaliseRedisKey("hydra:autopilot:<slot>"), "hydra:autopilot");
    strictEqual(normaliseRedisKey("hydra:foo:*"), "hydra:foo");
    strictEqual(normaliseRedisKey("hydra:plain:key"), "hydra:plain:key");
  });

  test("path claims resolve against the tracked set: line suffixes, trailing slash, directory prefixes", () => {
    const tracked = new Set(["src/real.ts", "scripts/docs/prose-drift.ts", ".github/workflows/ci.yml"]);
    ok(pathClaimResolves("src/real.ts", tracked));
    ok(pathClaimResolves("src/real.ts:42", tracked));
    ok(pathClaimResolves("src/real.ts:42-48", tracked));
    ok(pathClaimResolves("src/", tracked), "trailing slash is a directory-prefix claim");
    ok(pathClaimResolves("scripts/docs", tracked));
    ok(pathClaimResolves(".github/workflows/ci.yml", tracked), "dot-directories are tracked paths too");
    ok(!pathClaimResolves("src/gone.ts", tracked));
    ok(!pathClaimResolves("dashboard/dist/", tracked), "gitignored build output is not tracked");
  });

  test("route claims ignore method and query, and match :param rows segment-by-segment", () => {
    const rows = ["/api/health", "/api/design-concepts/:ref"];
    ok(routeClaimResolves("/api/health", rows));
    ok(routeClaimResolves("GET /api/health", rows));
    ok(routeClaimResolves("/api/health?verbose=1", rows));
    ok(routeClaimResolves("/api/design-concepts/issue-4597", rows));
    ok(!routeClaimResolves("/api/health/extra", rows), "segment count differs");
    ok(!routeClaimResolves("/api/missing", rows));
  });

  test("redis-key claims resolve equal, as a : boundary prefix, and through typed-param normalisation", () => {
    ok(redisKeyClaimResolves("hydra:real", ["hydra:real:*"]), "family claim matches its family pattern");
    ok(redisKeyClaimResolves("hydra:dc:{anchor}", ["hydra:dc:{anchorRef}"]), "claim and pattern normalise to the same *");
    ok(redisKeyClaimResolves("hydra:stream:events", ["hydra:stream:events"]), "streams.json keys are patterns too");
    ok(redisKeyClaimResolves("hydra:autopilot", ["hydra:autopilot:slots:*"]), "claim may be a : boundary prefix of a pattern");
    ok(!redisKeyClaimResolves("hydra:ghost", ["hydra:real:*"]));
    ok(!redisKeyClaimResolves("hydra:realx", ["hydra:real:*"]), "prefix must land on a : boundary");
  });

  test("skill claims strip a leading slash against the skills inventory", () => {
    ok(skillClaimResolves("hydra-dev", new Set(["hydra-dev"])));
    ok(skillClaimResolves("/hydra-dev", new Set(["hydra-dev"])));
    ok(!skillClaimResolves("hydra-quantum", new Set(["hydra-dev"])));
  });

  test("env-var claims resolve from the inventory or as a whole word in tracked source", () => {
    const known = new Set(["KNOWN_VAR"]);
    ok(envVarClaimResolves("KNOWN_VAR", known, ""));
    ok(envVarClaimResolves("VERIFIER_CORE_PATHS", new Set(), "export const VERIFIER_CORE_PATHS = [];"));
    ok(!envVarClaimResolves("GHOST_VAR", new Set(), "export const OTHER_VAR = 1;"));
    ok(!envVarClaimResolves("MY_VARI", new Set(), "MY_VARIABLE = 1"), "word boundary — a longer name does not satisfy a shorter claim");
  });

  test("count claims map number words and multi-word nouns to counts.json rows", () => {
    const claims = countClaimsIn("six chores, 12 routes, three dispatch classes and one CI job");
    deepStrictEqual(
      claims.map((c) => [c.phrase, c.value, `${c.row.family}/${c.row.metric}`]),
      [
        ["six chores", 6, "chores/rows"],
        ["12 routes", 12, "routes/routes"],
        ["three dispatch classes", 3, "classes/rows"],
      ],
    );
    strictEqual(countClaimsIn("one CI job").length, 0, "the noun list is the plural forms");
    strictEqual(countClaimsIn("nine roman emperors").length, 0, "unlisted noun");
  });

  test("compareBaseline is two-directional: current minus baseline and baseline minus current", () => {
    deepStrictEqual(compareBaseline(["a", "b", "c"], ["b", "c", "d"]), { added: ["a"], removed: ["d"] });
    deepStrictEqual(compareBaseline(["x"], ["x"]), { added: [], removed: [] });
  });

  test("renderReport rows read file:line — kind — token — fix and end with the regeneration command", () => {
    const byRow = new Map<string, Offender>([
      ["docs/x.md:path:src/gone.ts", { file: "docs/x.md", line: 9, kind: "path", token: "src/gone.ts", fix: "fix the path" }],
    ]);
    const report = renderReport("new", ["docs/x.md:path:src/gone.ts"], byRow);
    ok(report.includes("docs/x.md:9 — path — src/gone.ts — fix the path"), report);
    // The NEW arm cannot be fixed by a bare --update-baseline (it refuses to
    // grow): it points at the prose, or a deliberate --allow-grow.
    ok(report.endsWith(NEW_FIX_COMMAND), report);
    ok(NEW_FIX_COMMAND.includes("--allow-grow"), NEW_FIX_COMMAND);
    // A row with no live offender takes the fix hint of its OWN kind.
    const orphan = renderReport("new", ["docs/y.md:route:/api/gone"], new Map());
    ok(orphan.includes("docs/y.md:route:/api/gone — not in docs/generated/routes.json"), orphan);
    ok(!orphan.includes("counts.json disagrees"), orphan);
    strictEqual(kindOfRow("docs/y.md:route:/api/gone"), "route");
    strictEqual(kindOfRow("docs/y.md:retired-term:codex"), "retired-term");
    strictEqual(kindOfRow("no-kind-here"), null);
    const stale = renderReport("stale", ["docs/x.md:path:src/gone.ts"], byRow);
    ok(stale.includes("docs/x.md:path:src/gone.ts — stale baseline row — regenerate"), stale);
    ok(stale.endsWith(FIX_COMMAND), stale);
  });

  test("blankProse keeps offsets: fenced code, frontmatter and HTML comments never yield claims, line numbers stay true", () => {
    const src = "---\ntitle: frontmatter hides `src/gone-meta.ts`\n---\n\nfirst prose mentions `src/real.ts`.\n\n```ts\nconst x = `src/gone-fenced.ts`;\n```\n\n<!-- `src/gone-comment.ts` -->\n\nlast prose has `src/gone-prose.ts` here.\n";
    deepStrictEqual(blankProse(src).split("\n").map((l) => l.trim() === ""), [
      true, true, true, true, false, true, true, true, true, true, true, true, false, true,
    ]);
    const blanked = blankProse(src);
    strictEqual(blanked.indexOf("gone-fenced"), -1, "fence contents are blanked");
    strictEqual(blanked.indexOf("gone-comment"), -1, "HTML comment contents are blanked");
    strictEqual(blanked.indexOf("gone-meta"), -1, "frontmatter is blanked");
    strictEqual(blanked.split("\n")[12], "last prose has `src/gone-prose.ts` here.", "prose line is untouched");
  });

  test("fence closer follows CommonMark: a longer opener is not closed by a shorter run or an info-string line", () => {
    const src = "````md\n```ts\n`src/gone-inner.ts`\n```\n`src/gone-still-fenced.ts`\n````\n\nprose `src/gone-prose.ts`\n";
    const blanked = blankProse(src);
    strictEqual(blanked.indexOf("gone-inner"), -1);
    strictEqual(blanked.indexOf("gone-still-fenced"), -1, "inner ``` must not close a 4-backtick fence");
    ok(blanked.includes("gone-prose"), "prose after the real closer is live");
  });

  test("directory-shaped terms match sub-files; retiredBy admits on a digit boundary; a path name cannot self-admit", async () => {
    ok(termRegex("src/anchor-selection/").test("see src/anchor-selection/foo.ts"));
    strictEqual(termRegex("Codex").test("Codexes"), false, "word terms keep the trailing boundary");
    strictEqual(retiredTermAdmitted("Feedback File (#7100)", "#710"), false);
    ok(retiredTermAdmitted("Research Floor (#710).", "#710"));
    await withFixture({ "docs/self.md": "Mentions `docs/retired-foo.md` here.\n" }, async (root) => {
      const offenders = scanProseDrift(root, {
        corpusRows: [{ path: "docs/self.md", tier: "living" }],
        fragmentFiles: [],
        tracked: ["docs/self.md"],
        retiredTerms: [],
        routePaths: [],
        redisKeyPatterns: [],
        skillNames: [],
        envVarNames: [],
        counts: [],
        sourceBlob: "",
      });
      deepStrictEqual(offenders.map((o) => o.token), ["docs/retired-foo.md"]);
    });
  });

  test("paragraphSpans: table rows and list items are their own paragraphs; continuations attach to their item", () => {
    const spans = paragraphSpans("| a | b |\n| --- | --- |\n| Codex | live |\n\n- item one\n- item two\n  continuation of two\n");
    deepStrictEqual(spans.map((s) => s.text.replace(/\s+/g, " ").trim()), [
      "| a | b |",
      "| --- | --- |",
      "| Codex | live |",
      "- item one",
      "- item two continuation of two",
    ]);
  });

  // -- end-to-end scans on throwaway trees ------------------------------------

  test("fences and comments are exempt and line numbers survive blanking (fixture scan)", async () => {
    await withFixture(
      {
        "docs/live.md":
          "---\ntitle: x\n---\n\nfirst para mentions `src/real.ts` ok.\n\n```ts\nconst x = `src/gone.ts`;\n```\n\n<!-- `src/also-gone.ts` -->\n\nline thirteen has `src/gone.ts` claim.\n",
      },
      async (root) => {
        const offenders = scanProseDrift(root, {
          corpusRows: [{ path: "docs/live.md", tier: "living" }],
          fragmentFiles: [],
          tracked: ["docs/live.md", "src/real.ts"],
          routePaths: [],
          redisKeyPatterns: [],
          skillNames: [],
          envVarNames: [],
          counts: [],
          retiredTerms: [],
          sourceBlob: "",
        });
        deepStrictEqual(offenders, [
          {
            file: "docs/live.md",
            line: 13,
            kind: "path",
            token: "src/gone.ts",
            fix: "path not tracked; fix the path or say retired/removed/deleted in the same paragraph",
          },
        ]);
      },
    );
  });

  test("the admit rule is paragraph-scoped: same-paragraph citations admit, next-paragraph do not; paths get the removal lexicon", async () => {
    const doc = [
      "Codex is gone.",
      "",
      "Codex (ADR-0006) is cited here.",
      "",
      "Codex points at docs/historical/ here.",
      "",
      "| term | note |",
      "| --- | --- |",
      "| Codex | see docs/historical/ |",
      "| Codex | still live |",
      "",
      "- `src/gone-x/` (removed)",
      "- `src/gone-y/`",
      "",
      "- `src/gone-z/`",
      "  was removed in a continuation line",
      "",
      "`src/gone-a/` was removed in its own paragraph.",
      "",
      "`src/gone-b/` remains.",
      "",
    ].join("\n");
    await withFixture({ "docs/admit.md": doc }, async (root) => {
      const offenders = scanProseDrift(root, {
        corpusRows: [{ path: "docs/admit.md", tier: "living" }],
        fragmentFiles: [],
        tracked: ["docs/admit.md"],
        routePaths: [],
        redisKeyPatterns: [],
        skillNames: [],
        envVarNames: [],
        counts: [],
        retiredTerms: [{ term: "Codex", retiredBy: "ADR-0006" }],
        sourceBlob: "",
      });
      const rows = offenderRowsAndIndex(offenders).rows;
      deepStrictEqual(rows, [
        "docs/admit.md:path:src/gone-b/",
        "docs/admit.md:path:src/gone-y/",
        "docs/admit.md:retired-term:Codex",
      ]);
      // Both unadmitted occurrences are offenders (occurrences, not rows) and
      // each reports its own paragraph's line: the bare line 1 and the table row.
      deepStrictEqual(
        offenders.filter((o) => o.kind === "retired-term").map((o) => o.line),
        [1, 10],
      );
    });
  });

  test("a living doc's claims resolve against the injected inventories; playbook docs skip counts and links; adr docs are exempt", async () => {
    const living = [
      "# Living",
      "",
      "Good refs: `src/real.ts`, `GET /api/health?x=1`, `hydra:real`, `/hydra-dev`, `VERIFIER_CORE_PATHS`.",
      "",
      "Bad refs: `src/gone.ts`, `/api/nope`, `hydra:ghost`, `hydra-quantum`, `NOT_EVERYWHERE_VAR`.",
      "",
      "Six chores stand; [home](./live.md) works and [ghost](./missing.md) does not.",
      "",
      "Seven chores do not.",
      "Codex is gone.",
      "",
      "Codex (ADR-0006) is cited here.",
      "",
      "Codex points at docs/historical/ here.",
      "",
    ].join("\n");
    const playbook = ["# Playbook", "", "Codex lurks here.", "", "`GHOST_VAR` is unknown. Nine routes claimed.", ""].join("\n");
    const adr = ["# ADR", "", "Codex, `src/gone.ts`, `GHOST_VAR`, nine chores and [x](./nope.md) all exempt.", ""].join("\n");
    await withFixture(
      {
        "docs/live.md": living,
        "docs/play.md": playbook,
        "docs/adr.md": adr,
        "src/real.ts": "export const VERIFIER_CORE_PATHS: string[] = [];\n",
      },
      async (root) => {
        const offenders = scanProseDrift(root, {
          corpusRows: [
            { path: "docs/live.md", tier: "living" },
            { path: "docs/play.md", tier: "playbook" },
            { path: "docs/adr.md", tier: "adr" },
          ],
          fragmentFiles: [],
          tracked: ["docs/live.md", "docs/play.md", "docs/adr.md", "src/real.ts"],
          routePaths: ["/api/health"],
          redisKeyPatterns: ["hydra:real:*"],
          skillNames: ["hydra-dev"],
          envVarNames: [],
          counts: [{ family: "chores", metric: "rows", value: 6 }],
          retiredTerms: [{ term: "Codex", retiredBy: "ADR-0006" }],
          sourceBlob: "export const VERIFIER_CORE_PATHS: string[] = [];\n",
        });
        deepStrictEqual(offenderRowsAndIndex(offenders).rows, [
          "docs/live.md:count:Seven chores",
          "docs/live.md:env-var:NOT_EVERYWHERE_VAR",
          "docs/live.md:link:./missing.md",
          "docs/live.md:path:src/gone.ts",
          "docs/live.md:redis-key:hydra:ghost",
          "docs/live.md:retired-term:Codex",
          "docs/live.md:route:/api/nope",
          "docs/live.md:skill:hydra-quantum",
          "docs/play.md:env-var:GHOST_VAR",
          "docs/play.md:retired-term:Codex",
        ]);
      },
    );
  });
});

describe("prose-drift: verification never throws on unreadable inputs", () => {
  test("a missing inventory yields an unreadable-input offender row, not a throw", () => {
    const root = mkdtempSync(join(tmpdir(), "prose-drift-noinputs-"));
    try {
      const offenders = scanProseDrift(root, { tracked: [] });
      strictEqual(offenders.length, 1);
      strictEqual(offenders[0].kind, "unreadable-input");
      ok(!offenders[0].token.includes(root), `sentinel token must not embed the absolute repo root: ${offenders[0].token}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a programming error (malformed inventory row) propagates instead of becoming unreadable-input", async () => {
    // corpus.json parses fine but a row is null → `r.tier` is a TypeError,
    // which is a scanner/inventory bug, not "could not be read".
    await withFixture({ "docs/generated/corpus.json": JSON.stringify({ rows: [null] }) }, (root) => {
      throws(
        () =>
          scanProseDrift(root, {
            tracked: [],
            retiredTerms: [],
            routePaths: [],
            redisKeyPatterns: [],
            skillNames: [],
            envVarNames: [],
            counts: [],
            sourceBlob: "",
            fragmentFiles: [],
          }),
        TypeError,
      );
    });
  });

  test("an unreadable scoped doc aborts the scan as unreadable-input, never a fake link row", async () => {
    await withFixture({ "docs/present.md": "# Present\n" }, (root) => {
      const offenders = scanProseDrift(root, {
        corpusRows: [
          { path: "docs/present.md", tier: "living" },
          { path: "docs/vanished.md", tier: "living" },
        ],
        fragmentFiles: [],
        tracked: ["docs/present.md"],
        retiredTerms: [],
        routePaths: [],
        redisKeyPatterns: [],
        skillNames: [],
        envVarNames: [],
        counts: [],
        sourceBlob: "",
      });
      strictEqual(offenders.length, 1);
      strictEqual(offenders[0].kind, "unreadable-input");
      ok(offenders[0].token.includes("docs/vanished.md"), offenders[0].token);
      ok(!offenders.some((o) => o.kind === "link"), JSON.stringify(offenders));
    });
  });

  // CLI: an aborted scan never rewrites the baseline.
  const SEED = ["docs/a.md:path:src/gone.ts", "docs/b.md:route:/api/gone"];

  for (const argv of [["--update-baseline", "--allow-grow"], ["--update-baseline"], []]) {
    test(`argv=${JSON.stringify(argv)}: unreadable inputs exit 1 and leave the baseline byte-identical`, async () => {
      const seeded = `${JSON.stringify(SEED, null, 2)}\n`;
      // No git repo and no generated inventories → the scan aborts.
      await withFixture({ [BASELINE_FILE]: seeded }, (root) => {
        strictEqual(runProseDriftCli(root, argv), 1);
        strictEqual(readFileSync(join(root, BASELINE_FILE), "utf8"), seeded);
      });
    });
  }

  // CLI --update-baseline on a scannable throwaway tree: the refuse-to-grow
  // branch and the successful write (sorted + deduped rows).
  const LIVE_ROWS = ["docs/live.md:path:src/also-gone.ts", "docs/live.md:path:src/gone.ts"];
  const scannableTree = (baseline: string): Record<string, string> => {
    const empty = JSON.stringify({ rows: [] });
    return {
      // `src/gone.ts` is claimed twice → one deduped row; neither path is tracked.
      "docs/live.md": "# Live\n\n`src/gone.ts` and `src/also-gone.ts` exist.\n\nAgain `src/gone.ts`.\n",
      "docs/generated/corpus.json": JSON.stringify({ rows: [{ path: "docs/live.md", tier: "living" }] }),
      "docs/generated/routes.json": empty,
      "docs/generated/redis-keys.json": empty,
      "docs/generated/streams.json": empty,
      "docs/generated/skills.json": empty,
      "docs/generated/env-vars.json": empty,
      "docs/generated/counts.json": empty,
      [RETIRED_TERMS_FILE]: "[]\n",
      [BASELINE_FILE]: baseline,
    };
  };
  /** The CLI's default scan lists tracked files via `git ls-files`. */
  const gitTrack = (root: string): void => {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "-A"], { cwd: root });
  };

  test("--update-baseline without --allow-grow refuses to grow: exit 1, baseline byte-identical", async () => {
    const seeded = `${JSON.stringify([LIVE_ROWS[1]], null, 2)}\n`;
    await withFixture(scannableTree(seeded), (root) => {
      gitTrack(root);
      strictEqual(runProseDriftCli(root, ["--update-baseline"]), 1);
      strictEqual(readFileSync(join(root, BASELINE_FILE), "utf8"), seeded);
    });
  });

  test("--update-baseline that only shrinks writes the live rows sorted and deduped", async () => {
    // Unsorted, duplicated, plus a stale row the scan no longer produces.
    const seeded = `${JSON.stringify(["docs/live.md:path:src/fixed.ts", LIVE_ROWS[1], LIVE_ROWS[0], LIVE_ROWS[1]], null, 2)}\n`;
    await withFixture(scannableTree(seeded), (root) => {
      gitTrack(root);
      strictEqual(runProseDriftCli(root, ["--update-baseline"]), 0);
      strictEqual(readFileSync(join(root, BASELINE_FILE), "utf8"), `${JSON.stringify(LIVE_ROWS, null, 2)}\n`);
      strictEqual(runProseDriftCli(root, []), 0, "the written baseline must satisfy the check arm");
    });
  });

  test("--update-baseline --allow-grow grows the baseline, sorted and deduped", async () => {
    await withFixture(scannableTree("[]\n"), (root) => {
      gitTrack(root);
      strictEqual(runProseDriftCli(root, ["--update-baseline", "--allow-grow"]), 0);
      const written = JSON.parse(readFileSync(join(root, BASELINE_FILE), "utf8")) as string[];
      deepStrictEqual(written, LIVE_ROWS);
      deepStrictEqual(written, [...new Set(written)].sort());
    });
  });

  test("readBaseline rejects valid JSON that is not an array of strings (null, not a throw)", async () => {
    await withFixture({ [BASELINE_FILE]: JSON.stringify({ rows: [] }) }, (root) => {
      strictEqual(readBaseline(root), null);
    });
    await withFixture({ [BASELINE_FILE]: JSON.stringify([1, 2]) }, (root) => {
      strictEqual(readBaseline(root), null);
    });
    await withFixture({ [BASELINE_FILE]: JSON.stringify(["a:path:b"]) }, (root) => {
      deepStrictEqual(readBaseline(root), ["a:path:b"]);
    });
  });
});
