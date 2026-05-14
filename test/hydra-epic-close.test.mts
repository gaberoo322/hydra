/**
 * Regression tests for the hydra-epic-close skill's classifier (issue #408).
 *
 * Before #408, epics like #380 (codex-removal) would stay OPEN after all four
 * sub-issues merged — closing the parent required an operator nudge. The new
 * skill walks open epic candidates and emits one of three actions per row:
 *
 *   close → all referenced sub-issues are CLOSED, parent should close
 *   wait  → at least one referenced sub-issue is still OPEN
 *   skip  → no parseable references in the body
 *
 * These tests guard the parser, the classifier, the rendering helpers, *and*
 * the idempotency contract — re-running the skill on an already-closed epic
 * is the harness's job (the skill filters to state:open before classifying),
 * but classifying an epic with all-CLOSED sub-issues must remain a stable
 * `close` recommendation no matter how often it runs. The acceptance criteria
 * lists three scenarios explicitly: all-closed → close, partial-closed →
 * wait, no-references → skip. Those are the first three test groups below.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseEpicReferences,
  classifyEpic,
  classifyEpicBatch,
  renderClosingComment,
  renderSummary,
  parseArgs,
  type EpicRow,
} from "../scripts/ci/epic-close.ts";

function epic(
  number: number,
  body: string,
  opts: { title?: string; labels?: string[]; state?: "OPEN" | "CLOSED" } = {},
): EpicRow {
  return {
    number,
    title: opts.title ?? `Epic ${number}`,
    body,
    labels: (opts.labels ?? []).map((name) => ({ name })),
    state: opts.state ?? "OPEN",
  };
}

describe("parseEpicReferences — closing keywords", () => {
  test("recognises closes/closed/close/fixes/fixed/fix/resolves/resolved/resolve", () => {
    const body = [
      "closes #1",
      "Closed #2",
      "close #3",
      "fix #4",
      "Fixes #5",
      "fixed #6",
      "Resolves #7",
      "resolve #8",
      "RESOLVED #9",
    ].join("\n");
    assert.deepEqual(parseEpicReferences(body), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test("dedupes repeated references in source order", () => {
    const body = "closes #10\nfixes #11\ncloses #10\nresolves #12";
    assert.deepEqual(parseEpicReferences(body), [10, 11, 12]);
  });

  test("ignores standalone hashes that are not preceded by a keyword or checkbox", () => {
    const body = "See #999 for context.\nNote: #888 is unrelated.";
    assert.deepEqual(parseEpicReferences(body), []);
  });
});

describe("parseEpicReferences — blocked-by markers", () => {
  test("'blocked by #N' and 'blocked-by #N' are both recognised", () => {
    const body = "blocked by #100\nBlocked-by #101\nblocks #102";
    assert.deepEqual(parseEpicReferences(body), [100, 101, 102]);
  });
});

describe("parseEpicReferences — markdown checkboxes", () => {
  test("- [x] #N and - [ ] #N are both treated as references", () => {
    const body = ["- [x] #20", "- [ ] #21", "  - [X] #22", "* [x] #23"].join("\n");
    assert.deepEqual(parseEpicReferences(body), [20, 21, 22, 23]);
  });

  test("merges checkbox refs with keyword refs, preserves source order, dedupes", () => {
    const body = ["closes #30", "- [x] #31", "fixes #30", "- [x] #32"].join("\n");
    assert.deepEqual(parseEpicReferences(body), [30, 31, 32]);
  });
});

describe("parseEpicReferences — robustness", () => {
  test("null/undefined/empty body returns []", () => {
    assert.deepEqual(parseEpicReferences(null), []);
    assert.deepEqual(parseEpicReferences(undefined), []);
    assert.deepEqual(parseEpicReferences(""), []);
  });

  test("does not throw on malformed input", () => {
    assert.doesNotThrow(() => parseEpicReferences("closes #\nfixes #abc\nblocked by"));
    assert.deepEqual(parseEpicReferences("closes #\nfixes #abc\nblocked by"), []);
  });
});

describe("classifyEpic — acceptance criteria scenarios (issue #408 AC)", () => {
  test("AC scenario 1: all-closed → close", () => {
    const e = epic(
      380,
      "## Sub-issues\n- [x] #100\n- [x] #101\n- [x] #102\nblocked by #103",
    );
    const states = new Map<number, "OPEN" | "CLOSED">([
      [100, "CLOSED"],
      [101, "CLOSED"],
      [102, "CLOSED"],
      [103, "CLOSED"],
    ]);
    const r = classifyEpic(e, states);
    assert.equal(r.action, "close");
    assert.deepEqual(r.references, [103, 100, 101, 102]);
    assert.deepEqual(r.openReferences, []);
    assert.match(r.reason, /all 4 referenced sub-issues are CLOSED/);
  });

  test("AC scenario 2: partial-closed → wait (no-op)", () => {
    const e = epic(381, "closes #200\ncloses #201\ncloses #202");
    const states = new Map<number, "OPEN" | "CLOSED">([
      [200, "CLOSED"],
      [201, "OPEN"],
      [202, "CLOSED"],
    ]);
    const r = classifyEpic(e, states);
    assert.equal(r.action, "wait");
    assert.deepEqual(r.openReferences, [201]);
    assert.match(r.reason, /1\/3 referenced sub-issues still OPEN/);
  });

  test("AC scenario 3: no-references → skip (no-op)", () => {
    const e = epic(382, "Just a plain feature request with no sub-issue refs.");
    const r = classifyEpic(e, new Map());
    assert.equal(r.action, "skip");
    assert.deepEqual(r.references, []);
    assert.match(r.reason, /no parseable sub-issue references/);
  });
});

describe("classifyEpic — safety nets", () => {
  test("missing entry in subStates defaults to OPEN (never close on unknown state)", () => {
    const e = epic(383, "closes #300\ncloses #301");
    // Only #300's state is known.
    const states = new Map<number, "OPEN" | "CLOSED">([[300, "CLOSED"]]);
    const r = classifyEpic(e, states);
    assert.equal(r.action, "wait");
    assert.deepEqual(r.openReferences, [301]);
  });

  test("zero references returns skip even with a populated subStates map", () => {
    const e = epic(384, "Nothing parseable here.");
    const states = new Map<number, "OPEN" | "CLOSED">([[1, "CLOSED"]]);
    assert.equal(classifyEpic(e, states).action, "skip");
  });
});

describe("classifyEpicBatch — buckets partition correctly", () => {
  test("mixed batch produces three independent buckets in input order", () => {
    const epics: EpicRow[] = [
      epic(401, "closes #1\ncloses #2"), // close (both CLOSED)
      epic(402, "closes #3"),             // wait (#3 OPEN)
      epic(403, "no refs"),               // skip
      epic(404, "blocked by #4"),         // close (#4 CLOSED)
    ];
    const subStates = new Map<number, Map<number, "OPEN" | "CLOSED">>([
      [401, new Map([[1, "CLOSED"], [2, "CLOSED"]])],
      [402, new Map([[3, "OPEN"]])],
      [404, new Map([[4, "CLOSED"]])],
    ]);
    const buckets = classifyEpicBatch(epics, subStates);
    assert.deepEqual(buckets.close.map((b) => b.epic.number), [401, 404]);
    assert.deepEqual(buckets.wait.map((b) => b.epic.number), [402]);
    assert.deepEqual(buckets.skip.map((b) => b.epic.number), [403]);
  });

  test("empty input produces empty buckets", () => {
    const b = classifyEpicBatch([], new Map());
    assert.deepEqual(b.close, []);
    assert.deepEqual(b.wait, []);
    assert.deepEqual(b.skip, []);
  });

  test("missing sub-state map for an epic is tolerated (defaults to all-OPEN)", () => {
    const epics: EpicRow[] = [epic(405, "closes #50")];
    const buckets = classifyEpicBatch(epics, new Map()); // no sub-states supplied
    assert.equal(buckets.wait.length, 1);
    assert.equal(buckets.close.length, 0);
  });
});

describe("idempotency — repeated classification is stable (issue #408 AC)", () => {
  test("an all-closed epic classifies as 'close' identically on repeat runs", () => {
    const e = epic(406, "closes #60\nfixes #61");
    const states = new Map<number, "OPEN" | "CLOSED">([
      [60, "CLOSED"],
      [61, "CLOSED"],
    ]);
    const r1 = classifyEpic(e, states);
    const r2 = classifyEpic(e, states);
    assert.deepEqual(r1, r2);
    assert.equal(r1.action, "close");
  });

  test("a no-refs epic classifies as 'skip' identically on repeat runs", () => {
    const e = epic(407, "Just text.");
    const r1 = classifyEpic(e, new Map());
    const r2 = classifyEpic(e, new Map());
    assert.deepEqual(r1, r2);
    assert.equal(r1.action, "skip");
  });
});

describe("renderClosingComment", () => {
  test("renders sub-issues with titles and PR numbers when supplied", () => {
    const e = epic(408, "closes #70\ncloses #71", { title: "Big epic" });
    const out = renderClosingComment(
      e,
      [70, 71],
      new Map([
        [70, "first sub"],
        [71, "second sub"],
      ]),
      new Map([
        [70, 500],
        [71, 501],
      ]),
    );
    assert.match(out, /Automated by `\/hydra-epic-close`/);
    assert.match(out, /All 2 referenced sub-issues are CLOSED/);
    assert.match(out, /- #70 — first sub \(PR #500\)/);
    assert.match(out, /- #71 — second sub \(PR #501\)/);
  });

  test("renders bare #N when titles and PRs are missing", () => {
    const e = epic(409, "closes #80");
    const out = renderClosingComment(e, [80]);
    assert.match(out, /All 1 referenced sub-issue is CLOSED/);
    assert.match(out, /- #80\n?$/m);
  });
});

describe("renderSummary — deterministic single-pass report", () => {
  test("dry-run header says 'Would close' and 'no action taken'", () => {
    const epics: EpicRow[] = [
      epic(501, "closes #1\ncloses #2", { title: "all-closed epic" }),
      epic(502, "closes #3", { title: "partial epic" }),
      epic(503, "no refs", { title: "no-refs epic" }),
    ];
    const buckets = classifyEpicBatch(
      epics,
      new Map<number, Map<number, "OPEN" | "CLOSED">>([
        [501, new Map([[1, "CLOSED"], [2, "CLOSED"]])],
        [502, new Map([[3, "OPEN"]])],
      ]),
    );
    const out = renderSummary(buckets, "2026-05-14", "dry-run");
    assert.match(out, /Hydra Epic Close — 2026-05-14 \(dry-run\)/);
    assert.match(out, /Scanned: 3 candidate epics/);
    assert.match(out, /Would close[\s\S]*dry-run, no action taken[\s\S]*#501 all-closed epic/);
    assert.match(out, /Waiting[\s\S]*#502 partial epic[\s\S]*open: #3/);
    assert.match(out, /Skipped[\s\S]*#503 no-refs epic/);
  });

  test("apply header says 'Closed' (past tense)", () => {
    const epics: EpicRow[] = [epic(504, "closes #1", { title: "epic" })];
    const buckets = classifyEpicBatch(
      epics,
      new Map<number, Map<number, "OPEN" | "CLOSED">>([
        [504, new Map([[1, "CLOSED"]])],
      ]),
    );
    const out = renderSummary(buckets, "2026-05-14", "apply");
    assert.match(out, /Hydra Epic Close — 2026-05-14 \(apply\)/);
    assert.match(out, /### Closed \(all sub-issues resolved\)/);
    assert.doesNotMatch(out, /Would close/);
  });

  test("empty buckets render without crashing", () => {
    const out = renderSummary(
      { close: [], wait: [], skip: [] },
      "2026-05-14",
      "dry-run",
    );
    assert.match(out, /Scanned: 0 candidate epics/);
    assert.match(out, /_none_/);
  });
});

describe("parseArgs — dry-run by default", () => {
  test("empty/null/undefined → apply=false (dry-run)", () => {
    assert.deepEqual(parseArgs(""), { apply: false });
    assert.deepEqual(parseArgs(null), { apply: false });
    assert.deepEqual(parseArgs(undefined), { apply: false });
  });

  test("--apply flag enables apply mode", () => {
    assert.deepEqual(parseArgs("--apply"), { apply: true });
    assert.deepEqual(parseArgs("  --apply  "), { apply: true });
  });

  test("apply=true / apply=1 / apply=yes enable apply mode", () => {
    assert.deepEqual(parseArgs("apply=true"), { apply: true });
    assert.deepEqual(parseArgs("apply=1"), { apply: true });
    assert.deepEqual(parseArgs("apply=yes"), { apply: true });
  });

  test("apply=false explicitly stays in dry-run", () => {
    assert.deepEqual(parseArgs("apply=false"), { apply: false });
    assert.deepEqual(parseArgs("apply=no"), { apply: false });
  });

  test("unrecognised tokens are ignored, default stays dry-run", () => {
    assert.deepEqual(parseArgs("frobnicate=42 verbose"), { apply: false });
  });
});
