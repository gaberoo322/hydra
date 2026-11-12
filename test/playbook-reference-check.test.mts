/**
 * test/playbook-reference-check.test.mts — the playbook reference check
 * (issue #5499): every path, route, npm script, ADR number and attributed code
 * symbol an operator playbook cites must resolve, or sit in the shrink-only
 * baseline.
 *
 * The unit cases feed synthetic playbook text through the exported pure
 * functions against a fake World, so the scanner is proven non-vacuous without
 * touching the filesystem. The last case runs the real check over the real
 * playbooks: that is the gate.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const {
  extractReferences,
  findUnresolved,
  routeResolves,
  looksLikeSymbol,
  compareAgainstBaseline,
  buildBaseline,
  formatReport,
  scanRepo,
  loadBaseline,
  listPlaybooks,
  WRITE_BASELINE_CMD,
  EXAMPLE_MARKER,
} = await import("../scripts/ci/playbook-reference-check.ts");

const PB = "docs/operator-playbooks/hydra-example.md";
const TARGET_PB = "docs/operator-playbooks/hydra-target-example.md";

const FILES: Record<string, string> = {
  "src/live.ts": "export const LIVE_CONSTANT = 1;\nexport function liveHelper() {}\n",
  "scripts/tool.py": "def handle_stall():\n    pass\n",
  "docs/notes.md": "notes",
};
const world = {
  pathExists: (p: string) => p in FILES || p === "src/redis/",
  fileText: (p: string) => FILES[p] ?? null,
  routes: ["/api/health", "/api/tier", "/api/design-concepts/:slug", "/api/autopilot/board/promote"],
  npmScripts: new Set(["test", "test:file"]),
  adrNumbers: new Set(["0004", "0005", "0047"]),
  supersededAdrs: new Set(["0004"]),
};

function unresolved(text: string, file = PB): string[] {
  return findUnresolved(file, text, world).map((r) => `${r.kind} ${r.ref}`);
}

describe("playbook-reference-check: dead references are caught", () => {
  test("a dead path fails; a live one passes", () => {
    assert.deepEqual(unresolved("Read `src/live.ts` then `src/gone.ts`."), ["path src/gone.ts"]);
  });

  test("a dead directory cite in a code span fails; a live one passes", () => {
    assert.deepEqual(unresolved("Under `src/redis/` and `src/vanished/`."), [
      "path src/vanished/",
    ]);
  });

  test("a dead route fails; a live one passes, including behind a host and port", () => {
    assert.deepEqual(
      unresolved("curl http://localhost:4000/api/health and http://localhost:4000/api/backlog"),
      ["route /api/backlog"],
    );
  });

  test("a dead npm script fails; a live one passes", () => {
    assert.deepEqual(unresolved("Run `npm run test:file` not `npm run deadcode:ledger`."), [
      "npm deadcode:ledger",
    ]);
  });

  test("a missing ADR number fails; a present one passes", () => {
    assert.deepEqual(unresolved("See ADR-0005 and ADR-9999."), ["adr 9999"]);
  });

  test("a symbol the named file no longer contains fails, in either order", () => {
    assert.deepEqual(
      unresolved(
        "`LIVE_CONSTANT` in `src/live.ts`, `GONE_CONSTANT` in `src/live.ts`.\n" +
          "`scripts/tool.py`'s `_handle_removed`; `scripts/tool.py`'s `handle_stall`.\n" +
          "`liveHelper()` (in `src/live.ts`) and `deadHelper()` (in `src/live.ts`).",
      ),
      [
        "symbol src/live.ts#GONE_CONSTANT",
        "symbol scripts/tool.py#_handle_removed",
        "symbol src/live.ts#deadHelper",
      ],
    );
  });

  test("a cite of a superseded ADR fails; an accepted one passes", () => {
    assert.deepEqual(unresolved("Per ADR-0004 and ADR-0005."), ["superseded-adr 0004"]);
  });

  test("a symbol must match as a whole identifier, not a substring", () => {
    assert.deepEqual(unresolved("`LIVE_CONST` in `src/live.ts`"), ["symbol src/live.ts#LIVE_CONST"]);
  });

  test("the reported line is the 1-based line of the first cite", () => {
    const [ref] = findUnresolved(PB, "ok\n\nsee `src/gone.ts`\nagain `src/gone.ts`\n", world);
    assert.deepEqual(ref, { kind: "path", ref: "src/gone.ts", line: 3 });
  });
});

describe("playbook-reference-check: what is deliberately not a reference", () => {
  test("an opt-out-marked example line passes", () => {
    assert.deepEqual(unresolved("Bad: `src/gone.ts` <!-- ref-check: example -->"), []);
    assert.deepEqual(unresolved("touch src/gone.ts  # ref-check: example"), []);
  });

  test("an opt-out block passes, and checking resumes after it", () => {
    assert.deepEqual(
      unresolved(
        "<!-- ref-check: example-start -->\n`src/gone.ts`\nnpm run nope\n" +
          "<!-- ref-check: example-end -->\n`src/after.ts`\n",
      ),
      ["path src/after.ts"],
    );
  });

  test("templates and placeholders are not paths", () => {
    assert.deepEqual(
      unresolved("`docs/adr/NNNN-kebab-slug.md`, `test/<name>.test.mts`, `test/*.test.mts`"),
      [],
    );
  });

  test("a path under another root is not a repo cite; one under the main checkout is", () => {
    assert.deepEqual(unresolved('"$TARGET_WS/docs/agents/domain.md" and <target>/docs/x.md'), []);
    assert.deepEqual(unresolved("cat ~/hydra/docs/missing.md $HOME/hydra/docs/notes.md"), [
      "path docs/missing.md",
    ]);
  });

  test("a source path under src/api/ is a path, never a route", () => {
    assert.deepEqual(unresolved("`src/api/autopilot.ts`"), ["path src/api/autopilot.ts"]);
  });

  test("a route with a placeholder segment matches a parameterised route", () => {
    assert.deepEqual(unresolved("GET /api/design-concepts/issue-$N and /api/tier?files=a,b"), []);
  });

  test("a route family prefix resolves; a response-field suffix is dropped", () => {
    assert.equal(routeResolves("/api/autopilot", world.routes), true);
    assert.equal(routeResolves("/api/autopilot/board/demote", world.routes), false);
    assert.deepEqual(unresolved("compare `/api/health.deployedSha`"), []);
  });

  test("Target-side npm scripts and Target routes are not checked", () => {
    assert.deepEqual(unresolved("Run `npm run e2e:smoke`.", TARGET_PB), []);
    assert.deepEqual(unresolved("a Target-side `npm run deadcode:ledger` concern"), []);
    assert.deepEqual(unresolved('curl "$TARGET_WEB_URL/api/health/full"'), []);
    assert.deepEqual(unresolved('curl "${TARGET_WEB_URL}/api/health/full"'), []);
  });

  test("an ordinary lowercase word next to a file is not a symbol", () => {
    assert.equal(looksLikeSymbol("model"), false);
    assert.equal(looksLikeSymbol("VERIFIER_CORE_PATHS"), true);
    assert.equal(looksLikeSymbol("stuckSignalKey"), true);
    assert.equal(looksLikeSymbol("decide()"), true);
    assert.deepEqual(unresolved("the `model` column of `src/live.ts`"), []);
  });

  test("a symbol merely listed beside a file is not attributed to it", () => {
    assert.deepEqual(
      unresolved(
        "`GONE_CONSTANT`, `src/live.ts` and `OTHER_GONE` and `src/live.ts`.\n" +
          "`src/live.ts`, `GONE_CONSTANT`; `src/live.ts` and `OTHER_GONE`.",
      ),
      [],
    );
  });

  test("a metasyntactic placeholder name is not a reference", () => {
    assert.deepEqual(
      unresolved("`src/foo.ts`, `src/foo/bar.ts`, `test/foo.test.mts`, `src/x.ts`, GET /api/foo"),
      [],
    );
    assert.deepEqual(unresolved("`src/foobar.ts`"), ["path src/foobar.ts"]);
  });

  test("an unterminated example block exempts nothing", () => {
    assert.deepEqual(unresolved("<!-- ref-check: example-start -->\n`src/gone.ts`\n"), [
      "path src/gone.ts",
    ]);
  });

  test("a symbol attributed to a missing file is reported once, as the path", () => {
    assert.deepEqual(unresolved("`GONE_CONSTANT` in `src/gone.ts`"), ["path src/gone.ts"]);
  });

  test("a repeated cite is one reference", () => {
    assert.equal(extractReferences(PB, "`src/a.ts` `src/a.ts`\n`src/a.ts`").length, 1);
  });
});

describe("playbook-reference-check: shrink-only baseline", () => {
  const found = { [PB]: [{ kind: "path" as const, ref: "src/gone.ts", line: 7 }] };

  test("a baselined unresolved reference passes", () => {
    const cmp = compareAgainstBaseline(found, { note: "", files: { [PB]: ["path src/gone.ts"] } });
    assert.deepEqual(cmp, { violations: [], stale: [] });
    assert.equal(formatReport(cmp), "");
  });

  test("a new unresolved reference fails and the report names file, line and reference", () => {
    const cmp = compareAgainstBaseline(found, { note: "", files: {} });
    assert.deepEqual(cmp.violations, [{ file: PB, line: 7, kind: "path", ref: "src/gone.ts" }]);
    const report = formatReport(cmp);
    assert.match(report, new RegExp(`${PB}:7  path src/gone\\.ts`));
    assert.ok(report.includes(EXAMPLE_MARKER));
    assert.ok(report.includes(WRITE_BASELINE_CMD));
  });

  test("a baseline entry that no longer fails is stale and must be removed", () => {
    const cmp = compareAgainstBaseline(
      {},
      { note: "", files: { [PB]: ["path src/gone.ts"] } },
    );
    assert.deepEqual(cmp.stale, [{ file: PB, entry: "path src/gone.ts" }]);
    assert.match(formatReport(cmp), /lower the baseline/);
  });

  test("buildBaseline is sorted, deduplicated and omits clean files", () => {
    const baseline = buildBaseline(
      {
        "b.md": [
          { kind: "route", ref: "/api/x", line: 2 },
          { kind: "path", ref: "src/z.ts", line: 1 },
        ],
        "a.md": [],
      },
    );
    assert.deepEqual(baseline.files, { "b.md": ["path src/z.ts", "route /api/x"] });
    assert.doesNotMatch(baseline.note, /\d{4}-\d{2}-\d{2}/);
  });
});

describe("playbook-reference-check: the real playbooks", () => {
  test("every playbook and fragment is scanned", () => {
    const files = listPlaybooks();
    assert.ok(files.includes("docs/operator-playbooks/hydra-autopilot.md"));
    assert.ok(files.some((f: string) => f.startsWith("docs/operator-playbooks/_fragments/")));
    assert.ok(!files.some((f: string) => f.endsWith("README.md")));
  });

  test("no unresolved reference outside the baseline, and no stale baseline entry", async () => {
    const report = formatReport(compareAgainstBaseline(scanRepo(), await loadBaseline()));
    assert.equal(report, "", `\n${report}\n`);
  });
});
