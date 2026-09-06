import test, { describe } from "node:test";
import assert from "node:assert/strict";
import {
  runEmitShell,
  tallyDropReasons,
  type EmitShellIo,
  type EmitShellSpec,
  type EmitSourceResult,
} from "../scripts/ci/hydra-emit-shell.ts";

/**
 * test/hydra-emit-shell.test.mts — unit cases for the shared "run an emit
 * plan" CLI harness (issue #4393).
 *
 * The harness's IO is fully injectable (`io.log` / `io.error` / `io.exists` /
 * `io.now`), so every case drives it against captured sinks with a synthetic
 * spec — no fs, no `gh`, no network. The cases pin the ordered control flow
 * and the fail-closed semantics the three emit runners now inherit:
 * missing/stale source, unreadable board, saturation, dry-run vs apply, the
 * #3720 continue-on-filing-failure policy, argv parsing, and the pure
 * drop-reason tally.
 *
 * NOTE (test-subject-map): this file deliberately references exactly ONE
 * scripts/** path — the shared shell. Naming one of the three runner scripts
 * here (even in a comment) would mis-resolve this suite's subject.
 */

/** Fixed clock — every timestamp the shell prints derives from this. */
const NOW = new Date("2026-09-06T12:00:00.000Z");

type FixtureItem = { title: string; body: string };

type FixtureOverrides = {
  items?: FixtureItem[];
  openItems?: string[];
  exists?: (path: string) => boolean;
  loadSource?: (path: string) => EmitSourceResult<string>;
  readOpenItems?: () => string[];
  createItem?: (title: string) => string;
};

/**
 * Build a harness: a synthetic spec whose every function records its calls,
 * an io writing into captured sinks, and a fixed clock. Default source path
 * "/default/source.json" "exists"; "/custom/source.json" exists too (for the
 * positional-path case).
 */
function makeFixture(over: FixtureOverrides = {}) {
  const log: string[] = [];
  const errSink: string[] = [];
  const calls = {
    loadSource: [] as string[],
    readOpenItems: 0,
    buildPlan: 0,
    createItem: [] as string[],
  };
  const items: FixtureItem[] =
    over.items ?? [
      { title: "item one", body: "line1\nline2" },
      { title: "item two", body: "body-two" },
    ];

  const spec: EmitShellSpec<string, string, FixtureItem> = {
    name: "test-emit",
    banner: "Test banner",
    openItemNoun: "test items",
    saturationCap: 3,
    defaultSourcePath: "/default/source.json",
    missingSourceMessage: (path) => `source not found at ${path}`,
    loadSource:
      over.loadSource ??
      ((path) => {
        calls.loadSource.push(path);
        return { ok: true, source: "SOURCE" };
      }),
    readOpenItems:
      over.readOpenItems ??
      (() => {
        calls.readOpenItems += 1;
        return over.openItems ?? [];
      }),
    buildPlan: (source, openItems, isoDate) => {
      calls.buildPlan += 1;
      return {
        items,
        summaryLines: [`summary source=${source} open=${openItems.length} date=${isoDate}`],
        footerLines: ["footer-a"],
      };
    },
    itemLine: (item) => `• ${item.title}`,
    createItem: (item) => {
      calls.createItem.push(item.title);
      if (over.createItem) return over.createItem(item.title);
      return "filed-ok";
    },
  };

  const io: EmitShellIo = {
    log: (line) => log.push(line),
    error: (line) => errSink.push(line),
    exists: over.exists ?? ((path) => path === "/default/source.json" || path === "/custom/source.json"),
    now: () => NOW,
  };

  return { spec, io, log, errSink, calls };
}

describe("runEmitShell source-load guard", () => {
  test("missing source exits 1 with the spec's message before any downstream call", () => {
    const f = makeFixture({ exists: () => false });
    const code = runEmitShell(f.spec, ["node", "x.ts"], f.io);
    assert.equal(code, 1);
    assert.deepEqual(f.errSink, ["test-emit: source not found at /default/source.json"]);
    assert.deepEqual(f.log, []);
    assert.equal(f.calls.loadSource.length, 0);
    assert.equal(f.calls.readOpenItems, 0);
    assert.equal(f.calls.buildPlan, 0);
    assert.equal(f.calls.createItem.length, 0);
  });

  test("loadSource ok:false exits 1 with the error and never reads the board", () => {
    const f = makeFixture({ loadSource: (path) => ({ ok: false, error: `bad source at ${path}` }) });
    const code = runEmitShell(f.spec, ["node", "x.ts"], f.io);
    assert.equal(code, 1);
    assert.deepEqual(f.errSink, ["test-emit: bad source at /default/source.json"]);
    assert.equal(f.calls.readOpenItems, 0);
    assert.equal(f.calls.buildPlan, 0);
  });
});

describe("runEmitShell board read and saturation", () => {
  test("readOpenItems throw aborts before buildPlan with the fail-closed message", () => {
    const f = makeFixture({
      readOpenItems: () => {
        throw new Error("gh exploded");
      },
    });
    const code = runEmitShell(f.spec, ["node", "x.ts"], f.io);
    assert.equal(code, 1);
    assert.equal(f.errSink.length, 1);
    assert.ok(f.errSink[0].startsWith("test-emit: "));
    assert.match(
      f.errSink[0],
      /failed to read the board — aborting \(cannot dedup or check saturation safely\): gh exploded/,
    );
    assert.equal(f.calls.buildPlan, 0);
    assert.equal(f.calls.createItem.length, 0);
  });

  test("a board exactly at the cap proceeds to buildPlan", () => {
    const f = makeFixture({ openItems: ["a", "b", "c"] }); // cap 3 — AT the cap
    const code = runEmitShell(f.spec, ["node", "x.ts"], f.io);
    assert.equal(code, 0);
    assert.equal(f.calls.buildPlan, 1);
    assert.ok(f.log.some((l) => l === "summary source=SOURCE open=3 date=2026-09-06"));
  });

  test("a board above the cap emits nothing, exits 0, and never builds the plan", () => {
    const f = makeFixture({ openItems: ["a", "b", "c", "d"] }); // 4 > cap 3
    const code = runEmitShell(f.spec, ["node", "x.ts"], f.io);
    assert.equal(code, 0);
    assert.deepEqual(f.log, [
      "test-emit: board saturated (4 open test items > 3 cap) — emitting nothing.",
    ]);
    assert.equal(f.calls.buildPlan, 0);
    assert.equal(f.calls.createItem.length, 0);
  });
});

describe("runEmitShell dry-run vs apply", () => {
  test("dry-run prints header, two-space-indented bodies and the footer literal, never calling createItem", () => {
    const f = makeFixture();
    const code = runEmitShell(f.spec, ["node", "x.ts"], f.io);
    assert.equal(code, 0);
    assert.equal(f.calls.createItem.length, 0);
    assert.equal(f.log[0], "test-emit — Test banner — 2026-09-06T12:00:00.000Z — dry-run");
    // The indented body is ONE multi-line log entry ("  line1\n  line2"), so
    // the indented-line assertions run against the joined sink.
    const out = f.log.join("\n");
    assert.ok(out.includes("  --- body ---"));
    assert.ok(out.includes("  line1"));
    assert.ok(out.includes("  line2"));
    assert.ok(out.includes("footer-a"));
    assert.ok(out.includes("(dry-run; no issues created — pass --apply to file them on GitHub)"));
  });

  test("apply calls createItem once per item in plan order and prints checkmark outcomes", () => {
    const f = makeFixture();
    const code = runEmitShell(f.spec, ["node", "x.ts", "--apply"], f.io);
    assert.equal(code, 0);
    assert.deepEqual(f.calls.createItem, ["item one", "item two"]);
    assert.equal(f.log[0], "test-emit — Test banner — 2026-09-06T12:00:00.000Z — apply");
    assert.ok(f.log.includes("  ✓ filed-ok"));
    assert.ok(!f.log.includes("  --- body ---"));
    assert.ok(!f.log.some((l) => l.includes("dry-run; no issues created")));
  });

  test("a throwing createItem logs a cross line on the error sink, remaining items still file, exit 0", () => {
    const f = makeFixture({
      createItem: (title) => {
        if (title === "item one") throw new Error("rate limited");
        return "filed-ok";
      },
    });
    const code = runEmitShell(f.spec, ["node", "x.ts", "--apply"], f.io);
    assert.equal(code, 0);
    assert.deepEqual(f.calls.createItem, ["item one", "item two"]);
    assert.deepEqual(f.errSink, ["  ✗ filing failed: rate limited"]);
    assert.ok(f.log.includes("  ✓ filed-ok"));
  });
});

describe("runEmitShell argv and output shape", () => {
  test("--apply is honoured in any position and a --flag token is never taken as the path", () => {
    const f = makeFixture();
    const code = runEmitShell(f.spec, ["node", "x.ts", "--flag", "--apply"], f.io);
    assert.equal(code, 0);
    assert.ok(f.log[0].endsWith("— apply"));
    assert.deepEqual(f.calls.loadSource, ["/default/source.json"]);
  });

  test("a positional token wins over defaultSourcePath", () => {
    const f = makeFixture();
    const code = runEmitShell(f.spec, ["node", "x.ts", "/custom/source.json", "--apply"], f.io);
    assert.equal(code, 0);
    assert.deepEqual(f.calls.loadSource, ["/custom/source.json"]);
    assert.ok(f.log[0].endsWith("— apply"));
  });

  test("runEmitShell returns a numeric exit code and never throws or exits", () => {
    const f = makeFixture();
    assert.equal(typeof runEmitShell(f.spec, ["node", "x.ts"], f.io), "number");
    assert.equal(typeof runEmitShell(f.spec, ["node", "x.ts", "--apply"], f.io), "number");
  });
});

describe("tallyDropReasons", () => {
  test("groups identical reasons and preserves first-seen order", () => {
    assert.deepEqual(
      tallyDropReasons([
        { reason: "young file" },
        { reason: "delete-class" },
        { reason: "young file" },
        { reason: "already open" },
        { reason: "young file" },
      ]),
      ["dropped 3: young file", "dropped 1: delete-class", "dropped 1: already open"],
    );
  });

  test("returns an empty array for no drops", () => {
    assert.deepEqual(tallyDropReasons([]), []);
  });
});
