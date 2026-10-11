// Unit tests for src/cost/transcript-fold.ts (issue #4791, ADR-0042 Decision 6):
// the pure per-file parse core + the pure transcript-content helpers. No fs, no
// Redis — `parseTranscriptFile` is driven with in-memory content.

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import {
  firstUserMessageText,
  parseTranscriptFile,
  sumSessionTokens,
} from "../src/cost/transcript-fold.ts";
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
