/**
 * Unit tests for the shared emit-runner CLI shell (issue #4393).
 *
 * The shell owns the skeleton every "scan a report → dedup against the open
 * board → emit issues" runner shares: argv/--apply parsing, the
 * source-exists guard, the script-owned loadSource result, the ONE
 * fail-closed board-read catch, the saturation early-return (strict `>`),
 * the dry-run/apply print loop with continue-on-error filing, and the
 * dry-run footer. Everything impure is injected — the spec callbacks
 * (loadSource / readOpenItems / buildPlan / createItem) and the io object
 * (log / error / exists / now) — so each control-flow branch pins against
 * captured sinks with zero fs/gh/subprocess.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  runEmitShell,
  parseEmitArgv,
  tallyDropReasons,
  EMIT_DRY_RUN_FOOTER,
  type EmitShellSpec,
  type EmitIo,
} from "../scripts/ci/hydra-emit-shell.ts";

interface WidgetItem {
  title: string;
  body: string;
}

/**
 * Capturing io double: `exists` admits the default source path unless
 * overridden, `now` is pinned so header/isoDate output is deterministic.
 */
function makeIo(opts: { exists?: (path: string) => boolean } = {}): {
  io: EmitIo;
  logs: string[];
  errors: string[];
} {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    io: {
      log: (line) => {
        logs.push(line);
      },
      error: (line) => {
        errors.push(line);
      },
      exists: opts.exists ?? ((path) => path === "/tmp/widget-report.json"),
      now: () => new Date("2026-09-06T12:00:00.000Z"),
    },
  };
}

/** A synthetic spec with per-callback call tracking; every part overridable. */
function makeSpec(overrides: Partial<EmitShellSpec<string, string, WidgetItem>> = {}) {
  const calls = { loadSource: [] as string[], readOpenItems: 0, buildPlan: 0, createItem: [] as string[] };
  const spec: EmitShellSpec<string, string, WidgetItem> = {
    name: "widget-emit",
    banner: "Widget (~/widget)",
    defaultSourcePath: "/tmp/widget-report.json",
    missingSourceMessage: (path) => `widget report not found at ${path}. Regenerate it first.`,
    loadSource: (path) => {
      calls.loadSource.push(path);
      return { ok: true, source: "WIDGET-SOURCE" };
    },
    readOpenItems: () => {
      calls.readOpenItems += 1;
      return ["open-one"];
    },
    openItemNoun: "widget items",
    saturationCap: 2,
    buildPlan: (source, open, isoDate) => {
      calls.buildPlan += 1;
      return {
        items: [
          { title: "T1", body: "B1" },
          { title: "T2", body: "B2" },
        ],
        summaryLines: [`summary src=${source} open=${open.length} date=${isoDate}`],
        footerLines: [],
      };
    },
    itemLine: (item) => `• ${item.title}`,
    createItem: (item) => {
      calls.createItem.push(item.title);
      return `filed ${item.title}`;
    },
    ...overrides,
  };
  return { spec, calls };
}

describe("emit shell control flow", () => {
  test("(a) missing source → exit 1 + prefixed error line; loadSource/readOpenItems/buildPlan/createItem never called", () => {
    const { spec, calls } = makeSpec();
    const { io, errors } = makeIo({ exists: () => false });
    const code = runEmitShell(spec, ["node", "widget-emit.ts"], io);
    assert.equal(code, 1);
    assert.deepEqual(errors, [
      "widget-emit: widget report not found at /tmp/widget-report.json. Regenerate it first.",
    ]);
    assert.equal(calls.loadSource.length, 0);
    assert.equal(calls.readOpenItems, 0);
    assert.equal(calls.buildPlan, 0);
    assert.equal(calls.createItem.length, 0);
  });

  test("(b) loadSource {ok:false} → exit 1 + prefixed error; the board read never runs", () => {
    const { spec, calls } = makeSpec({
      loadSource: (path) => ({ ok: false, error: `failed to parse ${path} as JSON: boom` }),
    });
    const { io, errors } = makeIo();
    const code = runEmitShell(spec, ["node", "widget-emit.ts"], io);
    assert.equal(code, 1);
    assert.deepEqual(errors, ["widget-emit: failed to parse /tmp/widget-report.json as JSON: boom"]);
    assert.equal(calls.readOpenItems, 0);
    assert.equal(calls.buildPlan, 0);
  });

  test("(c) readOpenItems throws → exit 1 with the fail-closed board message; buildPlan never called", () => {
    const { spec, calls } = makeSpec({
      readOpenItems: () => {
        throw new Error("gh exploded");
      },
    });
    const { io, errors } = makeIo();
    const code = runEmitShell(spec, ["node", "widget-emit.ts"], io);
    assert.equal(code, 1);
    assert.equal(errors.length, 1);
    assert.match(
      errors[0],
      /^widget-emit: failed to read the board — aborting \(cannot dedup or check saturation safely\): gh exploded$/,
    );
    assert.equal(calls.buildPlan, 0);
    assert.equal(calls.createItem.length, 0);
  });

  test("(d) saturation is strict: a board AT the cap proceeds, cap+1 stops with exit 0 before buildPlan", () => {
    // AT the cap — proceeds.
    const atCap = makeSpec({ readOpenItems: () => ["a", "b"] });
    const atCapIo = makeIo();
    assert.equal(runEmitShell(atCap.spec, ["node", "widget-emit.ts"], atCapIo.io), 0);
    assert.equal(atCap.calls.buildPlan, 1, "a board at the cap must reach buildPlan");

    // OVER the cap — emits nothing, exits 0, never plans.
    const over = makeSpec({ readOpenItems: () => ["a", "b", "c"] });
    const overIo = makeIo();
    assert.equal(runEmitShell(over.spec, ["node", "widget-emit.ts"], overIo.io), 0);
    assert.deepEqual(overIo.logs, [
      "widget-emit: board saturated (3 open widget items > 2 cap) — emitting nothing.",
    ]);
    assert.equal(over.calls.buildPlan, 0);
    assert.equal(over.calls.createItem.length, 0);
  });

  test("(e) dry-run: header/summary/body transcript exact, createItem never called, footer literal last", () => {
    const { spec, calls } = makeSpec();
    const { io, logs, errors } = makeIo();
    const code = runEmitShell(spec, ["node", "widget-emit.ts"], io);
    assert.equal(code, 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(logs, [
      "widget-emit — Widget (~/widget) — 2026-09-06T12:00:00.000Z — dry-run",
      "",
      "summary src=WIDGET-SOURCE open=1 date=2026-09-06",
      "",
      "• T1",
      "  --- body ---",
      "  B1",
      "",
      "• T2",
      "  --- body ---",
      "  B2",
      "",
      "",
      EMIT_DRY_RUN_FOOTER,
    ]);
    assert.equal(EMIT_DRY_RUN_FOOTER, "(dry-run; no issues created — pass --apply to file them on GitHub)");
    assert.equal(calls.createItem.length, 0, "dry-run must never create");
  });

  test("(f) apply: header says apply, createItem once per item in plan order, no bodies, no dry-run footer", () => {
    const { spec, calls } = makeSpec();
    const { io, logs } = makeIo();
    const code = runEmitShell(spec, ["node", "widget-emit.ts", "--apply"], io);
    assert.equal(code, 0);
    assert.deepEqual(calls.createItem, ["T1", "T2"]);
    assert.deepEqual(logs, [
      "widget-emit — Widget (~/widget) — 2026-09-06T12:00:00.000Z — apply",
      "",
      "summary src=WIDGET-SOURCE open=1 date=2026-09-06",
      "",
      "• T1",
      "  ✓ filed T1",
      "• T2",
      "  ✓ filed T2",
    ]);
    assert.ok(!logs.some((l) => l.includes("--- body ---")));
    assert.ok(!logs.includes(EMIT_DRY_RUN_FOOTER));
  });

  test("(g) apply continue-on-error: a throwing create logs ✗ and the remaining items still file; exit stays 0", () => {
    let n = 0;
    const { spec } = makeSpec({
      createItem: (item) => {
        n += 1;
        if (n === 1) throw new Error("rate limited");
        return `filed ${item.title}`;
      },
    });
    const { io, logs, errors } = makeIo();
    const code = runEmitShell(spec, ["node", "widget-emit.ts", "--apply"], io);
    assert.equal(code, 0, "a filing failure must not flip the exit code");
    assert.deepEqual(errors, ["  ✗ filing failed: rate limited"]);
    assert.ok(logs.includes("• T2"));
    assert.ok(logs.includes("  ✓ filed T2"), "the item after the failure still files");
    assert.equal(n, 2, "createItem ran for every planned item");
  });

  test("(h) argv: --apply in any position, first non-flag token is the path, a flag is never the path", () => {
    assert.deepEqual(parseEmitArgv(["node", "s", "--apply"], "/d.json"), {
      apply: true,
      sourcePath: "/d.json",
    });
    assert.deepEqual(parseEmitArgv(["node", "s", "/custom.json"], "/d.json"), {
      apply: false,
      sourcePath: "/custom.json",
    });
    assert.deepEqual(parseEmitArgv(["node", "s", "--apply", "/custom.json"], "/d.json"), {
      apply: true,
      sourcePath: "/custom.json",
    });
    assert.deepEqual(parseEmitArgv(["node", "s", "/custom.json", "--apply"], "/d.json"), {
      apply: true,
      sourcePath: "/custom.json",
    });
    assert.deepEqual(parseEmitArgv(["node", "s", "--weird"], "/d.json"), {
      apply: false,
      sourcePath: "/d.json",
    }, "a --flag token is never taken as the source path");
  });

  test("(i) tallyDropReasons groups identical reasons and preserves first-seen order", () => {
    assert.deepEqual(
      tallyDropReasons([
        { reason: "duplicate of an open issue" },
        { reason: "over the per-run cap of 8 files" },
        { reason: "duplicate of an open issue" },
        { reason: "within the grace period" },
        { reason: "over the per-run cap of 8 files" },
      ]),
      [
        "dropped 2: duplicate of an open issue",
        "dropped 2: over the per-run cap of 8 files",
        "dropped 1: within the grace period",
      ],
    );
    assert.deepEqual(tallyDropReasons([]), []);
  });

  test("footerLines print after the item loop and before the dry-run footer", () => {
    const { spec } = makeSpec({
      buildPlan: (_source, _open, _isoDate) => ({
        items: [{ title: "T1", body: "B1" }],
        summaryLines: [],
        footerLines: ["dropped 3: duplicate of an open issue"],
      }),
    });
    const { io, logs } = makeIo();
    runEmitShell(spec, ["node", "widget-emit.ts"], io);
    const tallyIdx = logs.indexOf("dropped 3: duplicate of an open issue");
    const footerIdx = logs.indexOf(EMIT_DRY_RUN_FOOTER);
    assert.ok(tallyIdx > logs.indexOf("• T1"), "tally comes after the item loop");
    assert.ok(footerIdx > tallyIdx, "dry-run footer comes after the tally lines");
  });
});
