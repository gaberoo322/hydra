// Unit tests for src/cost/transcript-fold.ts (issue #4791, ADR-0042 Decision 6):
// the pure per-file parse core + the pure transcript-content helpers. No fs, no
// Redis — `parseTranscriptFile` is driven with in-memory content.

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import {
  createScanAccumulator,
  firstUserMessageText,
  foldFileContribution,
  parseTranscriptFile,
  sumSessionTokens,
} from "../src/cost/transcript-fold.ts";
import type { ScanCutoffs } from "../src/cost/transcript-fold.ts";
import type { DispatchKind } from "../src/cost/token-breakdown.ts";
import { assistantLine, userLine } from "./_helpers/cost-fixtures.mts";

describe("firstUserMessageText — extractor (issue #2402)", () => {
  test("returns the first non-meta user message text (string content)", () => {
    const lines = [
      assistantLine("2026-05-25T10:00:00Z", { in: 1 }, "claude-opus-4-7"),
      userLine("<local-command-caveat>banner</local-command-caveat>", { meta: true }),
      userLine("/hydra-dev real prompt"),
      userLine("a later message"),
    ];
    assert.equal(firstUserMessageText(lines), "/hydra-dev real prompt");
  });

  test("concatenates text blocks of an array content; skips blank/meta lines", () => {
    const arrayContentLine = JSON.stringify({
      type: "user",
      timestamp: "2026-05-25T10:00:00Z",
      message: {
        role: "user",
        content: [
          { type: "text", text: "<command-name>/hydra-qa</command-name>" },
          { type: "image", source: {} },
        ],
      },
    });
    assert.equal(
      firstUserMessageText([arrayContentLine])?.trim(),
      "<command-name>/hydra-qa</command-name>",
    );
  });

  test("returns null when there is no readable first user message", () => {
    assert.equal(firstUserMessageText([]), null);
    assert.equal(
      firstUserMessageText([assistantLine("2026-05-25T10:00:00Z", { in: 1 }, "claude-opus-4-7")]),
      null,
    );
    // A user line whose content is only whitespace is skipped.
    assert.equal(firstUserMessageText([userLine("   ")]), null);
  });
});

describe("sumSessionTokens — pure re-home (issue #4791)", () => {
  test("sums usage lines with no time cutoff and ignores non-usage lines", () => {
    const lines = [
      assistantLine("2020-01-01T00:00:00Z", { in: 10, out: 5 }, "claude-opus-4-7"),
      userLine("hello"),
      "not json",
      "",
    ];
    assert.equal(sumSessionTokens(lines), 15);
  });
});

describe("parseTranscriptFile — pure parse core (issue #4791)", () => {
  const NOW = Date.parse("2026-05-25T12:00:00Z");
  const CUTOFF_7D = NOW - 7 * 86_400_000;
  const attribution = { skill: "hydra-dev", dispatchKind: "dev" as unknown as DispatchKind };

  test("keeps only in-7d usage lines, counts every JSON line, invokes attribute once", () => {
    const content = [
      userLine("/hydra-dev go"),
      assistantLine("2026-05-25T10:00:00Z", { in: 100, out: 20 }, "claude-opus-4-7"),
      assistantLine("2026-05-24T10:00:00Z", { in: 1 }, "claude-sonnet-4-6"),
      assistantLine("2026-04-01T10:00:00Z", { in: 999 }, "claude-opus-4-7"), // out of window
      "{not valid json",
      "",
    ].join("\n");
    let calls = 0;
    const res = parseTranscriptFile(content, CUTOFF_7D, (lines) => {
      calls++;
      assert.ok(lines.length > 0);
      return attribution;
    });
    assert.equal(calls, 1);
    assert.deepEqual(
      res.entry.entries.map((e) => [e.family, e.foreign]),
      [
        ["opus", false],
        ["sonnet", false],
      ],
    );
    assert.equal(res.entry.skill, "hydra-dev");
    assert.equal(res.entry.dispatchKind, "dev");
    assert.equal(res.entry.linesParsed, 5);
    assert.equal(res.entry.parseErrors, 1);
    assert.deepEqual(res.unknownModels, []);
    assert.deepEqual(res.foreignModels, []);
  });

  test("never calls attribute when the file has no in-7d Anthropic usage", () => {
    const content = [
      assistantLine("2026-04-01T10:00:00Z", { in: 5 }, "claude-opus-4-7"),
      assistantLine("2026-05-25T10:00:00Z", { in: 5 }, "glm-4.6"),
    ].join("\n");
    let calls = 0;
    const res = parseTranscriptFile(content, CUTOFF_7D, () => {
      calls++;
      return attribution;
    });
    assert.equal(calls, 0);
    assert.equal(res.entry.skill, null);
    assert.equal(res.entry.dispatchKind, null);
    assert.equal(res.entry.entries.length, 1);
    assert.equal(res.entry.entries[0].foreign, true);
    assert.equal(res.entry.entries[0].family, "unknown");
    assert.deepEqual(res.foreignModels, ["glm-4.6"]);
  });

  test("dedupes real unknown/foreign model names in first-seen order", () => {
    const content = [
      assistantLine("2026-05-25T10:00:00Z", { in: 1 }, "mystery-model-x"),
      assistantLine("2026-05-25T10:01:00Z", { in: 1 }, "glm-4.6"),
      assistantLine("2026-05-25T10:02:00Z", { in: 1 }, "mystery-model-x"),
      assistantLine("2026-05-25T10:03:00Z", { in: 1 }, "glm-4.5"),
      assistantLine("2026-05-25T10:04:00Z", { in: 1 }, "glm-4.6"),
    ].join("\n");
    const res = parseTranscriptFile(content, CUTOFF_7D, () => attribution);
    assert.deepEqual(res.unknownModels, ["mystery-model-x"]);
    assert.deepEqual(res.foreignModels, ["glm-4.6", "glm-4.5"]);
  });

  test("probes observedResetMs on EVERY JSON line (max wins, ignores window/anchor)", () => {
    const early = "2026-05-26T01:00:00Z";
    const late = "2026-05-27T09:30:00Z";
    const withReset = (iso: string): string => JSON.stringify({ resetsAt: iso });
    const outOfWindowUsage = JSON.parse(
      assistantLine("2026-04-01T10:00:00Z", { in: 5 }, "claude-opus-4-7"),
    );
    outOfWindowUsage.resetsAt = late;
    const content = [
      withReset(late), // non-usage line carries the larger reset, seen first
      assistantLine("2026-05-25T10:00:00Z", { in: 5 }, "claude-opus-4-7"),
      withReset(early), // smaller reset after: must not overwrite the max
      JSON.stringify(outOfWindowUsage), // out-of-7d usage line still probed
    ].join("\n");
    const res = parseTranscriptFile(content, CUTOFF_7D, () => attribution);
    assert.equal(res.entry.observedResetMs, Date.parse(late));

    // Only an out-of-window / non-usage line carries a reset: still observed.
    const only = parseTranscriptFile(
      [withReset(early), JSON.stringify({ ...outOfWindowUsage, resetsAt: late })].join("\n"),
      CUTOFF_7D,
      () => attribution,
    );
    assert.equal(only.entry.observedResetMs, Date.parse(late));
    assert.equal(only.entry.entries.length, 0);
  });

  test("is total on empty content", () => {
    const res = parseTranscriptFile("", CUTOFF_7D, () => attribution);
    assert.equal(res.entry.entries.length, 0);
    assert.equal(res.entry.observedResetMs, null);
    assert.equal(res.entry.linesParsed, 0);
  });
});

describe("foldFileContribution — shared per-file fold (issue #4792)", () => {
  const NOW = Date.parse("2026-10-12T12:00:00Z");
  const H = 3_600_000;
  const cutoffs: ScanCutoffs = {
    cutoff7d: NOW - 7 * 24 * H,
    cutoff24h: NOW - 24 * H,
    cutoff5h: NOW - 5 * H,
  };
  const tok = (n: number) => ({ input: n, output: 0, cacheRead: 0, cacheCreation: 0, total: n });
  const entryOf = (
    entries: { tsMs: number; n: number; foreign?: boolean; family?: string }[],
    over: Partial<{
      skill: string | null;
      dispatchKind: string | null;
      observedResetMs: number | null;
    }> = {},
  ) => ({
    entries: entries.map((e) => ({
      tsMs: e.tsMs,
      tokens: tok(e.n),
      foreign: e.foreign ?? false,
      family: e.family ?? "sonnet",
    })),
    skill: null as string | null,
    dispatchKind: null as string | null,
    observedResetMs: null as number | null,
    linesParsed: 3,
    linesWithUsage: 2,
    parseErrors: 1,
    ...over,
  });

  test("buckets an entry into 5h/24h/7d by the CURRENT cutoffs", () => {
    const acc = createScanAccumulator();
    foldFileContribution(
      acc,
      entryOf([
        { tsMs: NOW - 1 * H, n: 10 },
        { tsMs: NOW - 10 * H, n: 20 },
        { tsMs: NOW - 3 * 24 * H, n: 40 },
      ]),
      cutoffs,
      null,
    );
    assert.equal(acc.acc5h.total, 10);
    assert.equal(acc.tokens24h, 30);
    assert.equal(acc.byModel24h.sonnet.total, 30);
    assert.equal(acc.acc7d.total, 70);
    assert.equal(acc.byModel7d.sonnet.total, 70);
    assert.equal(acc.linesParsed, 3);
    assert.equal(acc.linesWithUsage, 2);
    assert.equal(acc.parseErrors, 1);
  });

  test("an aged-out entry (tsMs < cutoff7d) contributes to no window", () => {
    const acc = createScanAccumulator();
    foldFileContribution(acc, entryOf([{ tsMs: NOW - 8 * 24 * H, n: 99 }]), cutoffs, 1);
    assert.equal(acc.acc7d.total, 0);
    assert.equal(acc.byModel7d.sonnet.total, 0);
    assert.equal(acc.sinceResetEntries.length, 0);
  });

  test("a foreign entry goes ONLY to foreign7d", () => {
    const acc = createScanAccumulator();
    foldFileContribution(
      acc,
      entryOf([{ tsMs: NOW - 1 * H, n: 50, foreign: true, family: "unknown" }]),
      cutoffs,
      1,
    );
    assert.equal(acc.foreign7d.total, 50);
    assert.equal(acc.acc7d.total, 0);
    assert.equal(acc.acc5h.total, 0);
    assert.equal(acc.tokens24h, 0);
    assert.equal(acc.sinceResetEntries.length, 0);
  });

  test("sinceResetEntries + observedResetMs only advance when the anchor is set", () => {
    const e = entryOf([{ tsMs: NOW - 1 * H, n: 5 }], { observedResetMs: 123 });
    const off = createScanAccumulator();
    foldFileContribution(off, e, cutoffs, null);
    assert.equal(off.sinceResetEntries.length, 0);
    assert.equal(off.mostRecentObservedResetMs, null);

    const on = createScanAccumulator();
    foldFileContribution(on, e, cutoffs, 1);
    assert.equal(on.sinceResetEntries.length, 1);
    assert.equal(on.mostRecentObservedResetMs, 123);
    foldFileContribution(on, entryOf([], { observedResetMs: 50 }), cutoffs, 1);
    assert.equal(on.mostRecentObservedResetMs, 123, "never moves backward");
  });

  test("skill row is created even when every entry has aged out; 24h row is not", () => {
    const acc = createScanAccumulator();
    foldFileContribution(
      acc,
      entryOf([{ tsMs: NOW - 8 * 24 * H, n: 9 }], { skill: "hydra-dev", dispatchKind: "autopilot-dispatched" }),
      cutoffs,
      null,
    );
    assert.ok(acc.bySkillByModel["hydra-dev"], "7d skill row exists");
    assert.equal(acc.bySkillByModel24h["hydra-dev"], undefined);
  });

  test("a 24h row appears only with a non-foreign in-24h entry; cross-tab sums match", () => {
    const acc = createScanAccumulator();
    foldFileContribution(
      acc,
      entryOf([{ tsMs: NOW - 2 * H, n: 7 }, { tsMs: NOW - 2 * 24 * H, n: 3 }], {
        skill: "s",
        dispatchKind: "interactive",
      }),
      cutoffs,
      null,
    );
    assert.equal(acc.bySkillByModel24h.s.sonnet.total, 7);
    assert.equal(acc.bySkillByModel.s.sonnet.total, 10);
    assert.equal(acc.byDispatchKind.interactive.sonnet.total, 10);
  });

  test("an unknown dispatchKind skips the cross-tabs entirely", () => {
    const acc = createScanAccumulator();
    foldFileContribution(
      acc,
      entryOf([{ tsMs: NOW - 1 * H, n: 4 }], { skill: "s", dispatchKind: "bogus-kind" }),
      cutoffs,
      null,
    );
    assert.deepEqual(acc.bySkillByModel, {});
    assert.equal(acc.acc7d.total, 4, "window totals still count");
  });
});

describe("message.id de-duplication — one line per content block (issue #5141)", () => {
  const CUTOFF_7D = Date.parse("2026-05-25T12:00:00Z") - 7 * 86_400_000;
  const attribution = { skill: "hydra-dev", dispatchKind: "dev" as unknown as DispatchKind };
  const TS = "2026-05-25T10:00:00Z";
  function withId(line: string, id: string | undefined): string {
    const obj = JSON.parse(line);
    if (id !== undefined) obj.message.id = id;
    return JSON.stringify(obj);
  }

  test("a message split across 3 lines folds to its usage once (sumSessionTokens)", () => {
    const l = withId(assistantLine(TS, { in: 10, out: 5 }, "claude-opus-4-7"), "msg_1");
    assert.equal(sumSessionTokens([l, l, l]), 15);
  });

  test("distinct message ids still sum; lines without an id count as before", () => {
    const lines = [
      withId(assistantLine(TS, { in: 10 }, "claude-opus-4-7"), "msg_1"),
      withId(assistantLine(TS, { in: 10 }, "claude-opus-4-7"), "msg_1"),
      withId(assistantLine(TS, { in: 7 }, "claude-opus-4-7"), "msg_2"),
      withId(assistantLine(TS, { in: 3 }, "claude-opus-4-7"), undefined),
      withId(assistantLine(TS, { in: 3 }, "claude-opus-4-7"), undefined),
    ];
    assert.equal(sumSessionTokens(lines), 10 + 7 + 3 + 3);
  });

  test("parseTranscriptFile emits one entry per message id", () => {
    const l = withId(assistantLine(TS, { in: 10, out: 5 }, "claude-opus-4-7"), "msg_1");
    const other = withId(assistantLine(TS, { in: 1 }, "claude-opus-4-7"), "msg_2");
    const res = parseTranscriptFile([l, l, l, other].join("\n"), CUTOFF_7D, () => attribution);
    assert.deepEqual(
      res.entry.entries.map((e) => e.tokens.total),
      [15, 1],
    );
  });
});
