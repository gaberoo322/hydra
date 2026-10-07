/**
 * Turn Snapshot — orch board, untriaged-orphan and needs-qa collectors
 * (ADR-0043 slice 2, #4930).
 *
 * Both suites run at the TS interface with NO `gh` / `hydra` on PATH:
 *
 * 1. GOLDEN (ADR-0043 Decision 4): every test/fixtures/turn-snapshot/orch-board-*.json
 *    was captured by running the OLD bash collectors (`collect_orch_board`,
 *    `collect_untriaged_orphans`, `collect_needs_qa_numbers`, at the slice's
 *    base SHA) over each fixture the pre-slice tests used — the service-down
 *    degraded path and failed reads included. Each is replayed through the
 *    real CLI `main` + the production port/adapter over recording transports:
 *    stdout byte for byte, the `orch …` stderr-note set, the exported
 *    globals, and the same gh/hydra calls in the same order (gh argv compared
 *    without the client-side `--jq` filter, which the TS classifiers replace).
 *
 * 2. PORTED behavioural cases, 1:1, from the suites that regex-extracted the
 *    committed jq/python out of collect-state.sh: the untriaged_orphans cases
 *    (test/autopilot-scripts.test.mts #2828/#2958, #3728, #3817, #4025;
 *    test/autopilot-collect-state-signals.test.mts #4096;
 *    test/collect-state-orphans.test.mts #4220) and the orch counts
 *    degraded-flag cases (test/autopilot-arch-fallback-signals.test.mts #4130).
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { main } from "../scripts/autopilot/turn-snapshot.ts";
import {
  collectOrchBoard,
  countUntriagedOrphans,
  healthyBoardState,
  needsQaNumbers,
  needsTriageItems,
  UNTRIAGED_ORPHAN_EXCLUDED_LABELS,
} from "../src/autopilot/turn-snapshot/orch-board.ts";
import {
  createTurnSnapshotGithub,
  type GhJsonRead,
  type GhTransport,
  type TurnSnapshotGithub,
} from "../src/autopilot/turn-snapshot/github-port.ts";
import { createTurnSnapshotHydra, type HydraTransport, type TurnSnapshotHydra } from "../src/autopilot/turn-snapshot/hydra-http.ts";
import { renderNeedsQaNumbersKv, renderOrchBoardKv } from "../src/autopilot/turn-snapshot/render-kv.ts";
import { pyJsonDumps } from "../src/autopilot/turn-snapshot/py-compat.ts";
import { deriveBoardState } from "../src/autopilot/board-state.ts";
import { STALE_BLOCKED_SECONDS, STALE_IN_PROGRESS_SECONDS } from "../src/board-labels.ts";
import { DEFAULT_GITHUB_REPO } from "../src/github/issues.ts";

const GOLDEN_DIR = resolve(import.meta.dirname, "fixtures", "turn-snapshot");

// ---------------------------------------------------------------------------
// 1. Golden files
// ---------------------------------------------------------------------------

interface GoldenRead {
  stdout: string;
  stderr: string;
  exitCode: number;
}

type GhKey = "boardRows" | "needsTriage" | "orphanRows" | "needsQa";

interface Golden {
  name: string;
  collector: string;
  nowMs: number;
  hydra?: GoldenRead;
  gh: Partial<Record<GhKey, GoldenRead>>;
  expected: {
    stdout: string;
    stderrNotes: string[];
    exports: Record<string, string>;
    ghCalls: string[][];
    hydraCalls: string[][];
  };
}

/** Route an argv to the golden read the old fake `gh` served for it. */
function goldenKey(args: string[]): GhKey | null {
  const joined = args.join(" ");
  if (joined.includes("--label needs-triage")) return "needsTriage";
  if (joined.includes("--label needs-qa")) return "needsQa";
  if (joined.includes("--json number,labels,updatedAt")) return "boardRows";
  if (joined.includes("--json number,labels")) return "orphanRows";
  return null;
}

/**
 * A gh call in canonical form: the subcommand words, then the `--flag value`
 * pairs sorted, without `--jq` (the client-side filter the bash ran and the TS
 * classifiers replace — the API query is the same either way).
 */
function canonicalGhCall(args: readonly string[]): string {
  const words: string[] = [];
  const flags: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a.startsWith("--")) {
      if (a !== "--jq") flags.push(`${a}=${args[i + 1]}`);
      i++;
    } else words.push(a);
  }
  return [...words, ...flags.sort()].join(" ");
}

function parseExports(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

const goldenFiles = readdirSync(GOLDEN_DIR).filter((f) => f.startsWith("orch-board-") && f.endsWith(".json")).sort();

describe("Turn Snapshot orch-board — golden files from the bash collectors (ADR-0043 D4)", () => {
  test("the golden corpus is present (guards a vacuous pass)", () => {
    assert.ok(goldenFiles.length >= 40, `expected the captured corpus, found ${goldenFiles.length} files`);
  });

  for (const file of goldenFiles) {
    const g = JSON.parse(readFileSync(join(GOLDEN_DIR, file), "utf-8")) as Golden;
    test(`golden: ${g.name}`, async () => {
      const ghCalls: string[][] = [];
      const transport: GhTransport = async (args) => {
        ghCalls.push([...args]);
        const key = goldenKey(args);
        const r = key === null ? undefined : g.gh[key];
        if (r === undefined) return { ok: false, stderr: `unscripted call: ${args.join(" ")}` };
        return r.exitCode === 0 ? { ok: true, stdout: r.stdout, stderr: r.stderr } : { ok: false, stderr: r.stderr };
      };
      const hydraCalls: string[][] = [];
      const hydraTransport: HydraTransport = async (args) => {
        hydraCalls.push([...args]);
        const r = g.hydra;
        if (r === undefined) return { ok: false, stderr: "unscripted hydra call" };
        // The hydra CLI prints the body plus a newline on a 2xx.
        return r.exitCode === 0 ? { ok: true, stdout: `${r.stdout}\n` } : { ok: false, stderr: r.stderr };
      };
      let stdout = "";
      let stderr = "";
      let exportsText = "";
      const code = await main(
        ["--collectors", g.collector, "--format", "kv", "--gh-list-limit", "100", "--exports-file", "exports"],
        {
          github: createTurnSnapshotGithub({ transport, repo: DEFAULT_GITHUB_REPO }),
          hydra: createTurnSnapshotHydra({ transport: hydraTransport }),
          now: () => g.nowMs,
          sleep: async () => {},
        },
        {
          stdout: (t) => (stdout += t),
          stderr: (t) => (stderr += t),
          writeFile: (_p, t) => (exportsText = t),
        },
      );
      assert.equal(code, 0);
      assert.equal(stdout, g.expected.stdout, "stdout must match the bash byte for byte");
      const notes = stderr.split("\n").filter((l) => l.startsWith("orch "));
      assert.deepEqual([...notes].sort(), [...g.expected.stderrNotes].sort(), "the stderr-note set must match");

      const exp = parseExports(exportsText);
      const want = g.expected.exports;
      if (want.ORCH_BOARD_DEGRADED !== undefined) {
        assert.equal(exp.ORCH_BOARD_DEGRADED, want.ORCH_BOARD_DEGRADED, "ORCH_BOARD_DEGRADED");
        assert.equal(exp.BOARD_STATE_DEGRADED, want.BOARD_STATE_DEGRADED, "BOARD_STATE_DEGRADED");
        // The healthy body is re-serialised to one compact line (semantically the
        // same JSON the bash held); a degraded read exports nothing — its only
        // consumer reads the body solely when BOARD_STATE_DEGRADED=0.
        if (want.BOARD_STATE_DEGRADED === "0") {
          assert.deepEqual(JSON.parse(exp.BOARD_STATE_JSON as string), JSON.parse(want.BOARD_STATE_JSON as string));
        } else {
          assert.equal(exp.BOARD_STATE_JSON, "");
        }
      } else {
        assert.deepEqual(exp, {}, "the orphan/needs-qa collectors export nothing");
      }
      assert.deepEqual(ghCalls.map(canonicalGhCall), g.expected.ghCalls.map(canonicalGhCall), "the same gh calls, in the same order");
      assert.deepEqual(hydraCalls, g.expected.hydraCalls, "the same hydra call");
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Ported behavioural cases — untriaged_orphans
// ---------------------------------------------------------------------------

const ok = (data: unknown): GhJsonRead => ({ kind: "ok", data });
const EMPTY: GhJsonRead = { kind: "empty" };

/** The ported `count()`: the classifier over `number,labels` rows, as the emitted string. */
function count(issues: readonly { labels: string[] }[]): string {
  const n = countUntriagedOrphans(ok(issues.map((i, idx) => ({ number: idx + 1, labels: i.labels.map((name) => ({ name })) }))));
  assert.notEqual(n, null);
  return String(n);
}

describe("untriaged_orphans exclusion set (#2828, #2958)", () => {
  test("every lifecycle + operator-wait label excludes the issue on its own", () => {
    const required = [
      "ready-for-agent",
      "in-progress",
      "blocked",
      "needs-qa",
      "needs-triage",
      "needs-research",
      "target-backlog",
      "ready-for-human",
      "needs-info",
      "needs-tickets",
      "hitl-grill",
    ];
    for (const label of required) {
      assert.ok(UNTRIAGED_ORPHAN_EXCLUDED_LABELS.includes(label), `exclusion set missing "${label}"`);
      assert.equal(count([{ labels: [label] }]), "0", `"${label}" alone must not be an orphan`);
    }
    assert.ok(
      !UNTRIAGED_ORPHAN_EXCLUDED_LABELS.includes("needs-design-concept"),
      'untriaged_orphans must NOT unconditionally exclude "needs-design-concept" (#4096)',
    );
  });
});

describe("untriaged_orphans wayfinder prefix exclusion (#3728)", () => {
  test("an issue labelled only wayfinder:grilling is NOT an untriaged orphan", () => {
    assert.equal(count([{ labels: ["wayfinder:grilling"] }]), "0");
  });

  test("an issue with genuinely no labels IS still an untriaged orphan (backstop intact)", () => {
    assert.equal(count([{ labels: [] }]), "1");
  });

  test("every known wayfinder label type is excluded", () => {
    assert.equal(
      count([
        { labels: ["wayfinder:map"] },
        { labels: ["wayfinder:grilling"] },
        { labels: ["wayfinder:research"] },
        { labels: ["wayfinder:task"] },
        { labels: ["wayfinder:prototype"] },
        { labels: ["wayfinder:destination-pending"] },
      ]),
      "0",
    );
  });

  test("a FUTURE wayfinder label type is excluded too (prefix test, not enumeration)", () => {
    assert.equal(count([{ labels: ["wayfinder:foo"] }]), "0");
  });

  test("a mixed board counts exactly the non-wayfinder orphans", () => {
    assert.equal(
      count([
        { labels: ["wayfinder:map"] },
        { labels: ["wayfinder:grilling"] },
        { labels: [] },
        { labels: ["needs-triage"] },
        { labels: ["ready-for-human"] },
        { labels: ["enhancement"] },
      ]),
      "2",
    );
  });

  test("a label that merely contains the substring is NOT excluded (prefix, not substring)", () => {
    assert.equal(count([{ labels: ["xwayfinder:y"] }]), "1");
  });
});

describe("untriaged_orphans needs-tickets exclusion (#3817; needs-design-concept half narrowed by #4096)", () => {
  test("an issue with only [enhancement, needs-design-concept] IS an untriaged orphan (#4096 flip)", () => {
    assert.equal(count([{ labels: ["enhancement", "needs-design-concept"] }]), "1");
  });

  test("an issue labelled only needs-tickets is NOT an untriaged orphan", () => {
    assert.equal(count([{ labels: ["needs-tickets"] }]), "0");
  });

  test("a meta-friction-only issue IS still an untriaged orphan (backstop's motivating example intact)", () => {
    assert.equal(count([{ labels: ["meta-friction"] }]), "1");
  });

  test("an issue with genuinely no labels IS still an untriaged orphan (backstop intact)", () => {
    assert.equal(count([{ labels: [] }]), "1");
  });

  test("a mixed board counts exactly the non-excluded orphans", () => {
    assert.equal(
      count([
        { labels: ["needs-design-concept"] },
        { labels: ["needs-tickets"] },
        { labels: ["wayfinder:grilling"] },
        { labels: ["meta-friction"] },
        { labels: [] },
        { labels: ["ready-for-agent"] },
      ]),
      "3",
    );
  });
});

describe("untriaged_orphans hitl-grill exclusion (#4025)", () => {
  test("an issue labelled only hitl-grill is NOT an untriaged orphan", () => {
    assert.equal(count([{ labels: ["hitl-grill"] }]), "0");
  });

  test("an issue with [enhancement, hitl-grill] is NOT an untriaged orphan", () => {
    assert.equal(count([{ labels: ["enhancement", "hitl-grill"] }]), "0");
  });

  test("a meta-friction-only issue IS still an untriaged orphan (backstop's motivating example intact)", () => {
    assert.equal(count([{ labels: ["meta-friction"] }]), "1");
  });

  test("an issue with genuinely no labels IS still an untriaged orphan (backstop intact)", () => {
    assert.equal(count([{ labels: [] }]), "1");
  });

  test("a mixed board counts exactly the non-excluded orphans", () => {
    assert.equal(
      count([
        { labels: ["hitl-grill"] },
        { labels: ["needs-design-concept"] },
        { labels: ["wayfinder:grilling"] },
        { labels: ["meta-friction"] },
        { labels: [] },
        { labels: ["ready-for-agent"] },
      ]),
      "3",
    );
  });
});

describe("untriaged_orphans needs-design-concept reachability (#4096)", () => {
  test("INV-1: [bug, needs-design-concept] (the #4093 label state) IS an untriaged orphan", () => {
    assert.equal(count([{ labels: ["bug", "needs-design-concept"] }]), "1");
  });

  test("INV-1: needs-design-concept alone IS an untriaged orphan", () => {
    assert.equal(count([{ labels: ["needs-design-concept"] }]), "1");
  });

  test("INV-2: [needs-design-concept, ready-for-agent] is NOT an untriaged orphan (parked-and-routed state)", () => {
    assert.equal(count([{ labels: ["needs-design-concept", "ready-for-agent"] }]), "0");
  });

  test("INV-2: category labels alongside the pair change nothing", () => {
    assert.equal(count([{ labels: ["enhancement", "needs-design-concept", "ready-for-agent"] }]), "0");
  });

  test("INV-3: needs-tickets alone stays excluded (its consumer is tickets_orch, #4014)", () => {
    assert.equal(count([{ labels: ["needs-tickets"] }]), "0");
  });

  test("INV-3: hitl-grill alone stays excluded (terminal park state, #4025)", () => {
    assert.equal(count([{ labels: ["hitl-grill"] }]), "0");
  });

  test("backstop intact: a genuinely label-less issue IS still an orphan", () => {
    assert.equal(count([{ labels: [] }]), "1");
  });

  test("backstop intact: a meta-friction-only issue IS still an orphan (motivating example)", () => {
    assert.equal(count([{ labels: ["meta-friction"] }]), "1");
  });

  test("mixed board: the recovered lane counts alongside the genuine orphans", () => {
    assert.equal(
      count([
        { labels: ["bug", "needs-design-concept"] },
        { labels: ["needs-design-concept", "ready-for-agent"] },
        { labels: ["needs-tickets"] },
        { labels: ["meta-friction"] },
        { labels: [] },
      ]),
      "3",
    );
  });
});

describe("untriaged_orphans excludes needs-dev-resume (#4220)", () => {
  test("headline: a needs-dev-resume-only issue is NOT an untriaged orphan", () => {
    assert.equal(count([{ labels: ["needs-dev-resume"] }]), "0");
  });

  test("needs-dev-resume survives alongside non-lifecycle tags (the #3870 shape)", () => {
    assert.equal(count([{ labels: ["needs-dev-resume", "glm-eligible"] }]), "0");
  });

  test("backstop intact: a genuinely label-less issue IS still an orphan", () => {
    assert.equal(count([{ labels: [] }]), "1");
  });

  test("backstop intact: a meta-friction-only issue IS still an orphan (motivating example)", () => {
    assert.equal(count([{ labels: ["meta-friction"] }]), "1");
  });

  test("backstop intact: a wayfinder-prefixed issue stays excluded (prefix family, #3728)", () => {
    assert.equal(count([{ labels: ["wayfinder:map"] }]), "0");
  });

  test("sibling lanes unchanged: needs-tickets alone stays excluded (#3817)", () => {
    assert.equal(count([{ labels: ["needs-tickets"] }]), "0");
  });

  test("sibling lanes unchanged: hitl-grill alone stays excluded (#4025)", () => {
    assert.equal(count([{ labels: ["hitl-grill"] }]), "0");
  });

  test("sibling lanes unchanged: needs-design-concept alone stays an orphan (#4096)", () => {
    assert.equal(count([{ labels: ["needs-design-concept"] }]), "1");
  });

  test("mixed board: the resume-pending anchor is excluded, genuine orphans counted", () => {
    assert.equal(
      count([
        { labels: ["needs-dev-resume"] },
        { labels: ["needs-tickets"] },
        { labels: ["needs-design-concept", "ready-for-agent"] },
        { labels: ["meta-friction"] },
        { labels: [] },
      ]),
      "2",
    );
  });

  test("the exclusion set lists needs-dev-resume", () => {
    assert.ok(UNTRIAGED_ORPHAN_EXCLUDED_LABELS.includes("needs-dev-resume"));
  });
});

describe("untriaged_orphans / needs_qa_numbers degrade (failed reads)", () => {
  test("a failed orphan read is null (rendered 0 — never a spurious sweep)", () => {
    assert.equal(countUntriagedOrphans(EMPTY), null);
    assert.equal(countUntriagedOrphans({ kind: "unparseable", error: "x" }), null);
  });

  test("needs_qa_numbers keeps gh's order; a failed read renders empty", () => {
    assert.deepEqual(needsQaNumbers(ok([{ number: 9 }, { number: 100 }, { number: 3 }])), { ok: true, value: [9, 100, 3] });
    assert.equal(renderNeedsQaNumbersKv(needsQaNumbers(EMPTY)), "needs_qa_numbers=\n");
  });

  test("orch_needs_triage_items is sorted ascending", () => {
    assert.deepEqual(needsTriageItems(ok([{ number: 300 }, { number: 12 }, { number: 4905 }])), { ok: true, value: [12, 300, 4905] });
  });
});

// ---------------------------------------------------------------------------
// 3. Ported — the orch counts degraded flag (#4130) + the degraded path IS deriveBoardState
// ---------------------------------------------------------------------------

const NOW_MS = 1_800_000_000_000;
const iso = (secondsAgo: number) => new Date(NOW_MS - secondsAgo * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
const row = (number: number, labels: string[], updatedAt = iso(60)) => ({ number, labels: labels.map((name) => ({ name })), updatedAt });

function fakeGithub(boardRows: GhJsonRead, triage: GhJsonRead = ok([])): Pick<TurnSnapshotGithub, "listOpenIssueBoardRows" | "openIssueNumbersByLabel"> {
  return {
    async listOpenIssueBoardRows() {
      return boardRows;
    },
    async openIssueNumbersByLabel() {
      return triage;
    },
  };
}
const serviceDown: TurnSnapshotHydra = { orchBoardState: async () => EMPTY };

describe("orch board degraded flag (#4130)", () => {
  test("a failed orch COUNTS read emits NO counts line (never a legitimate zero) and flags the lane", async () => {
    const out = await collectOrchBoard({ github: fakeGithub(EMPTY), hydra: serviceDown, now: () => NOW_MS, ghListLimit: 100 });
    assert.equal(out.value.orchBoardDegraded, true);
    assert.equal(renderOrchBoardKv(out.value), "orch_needs_triage_items=\n");
    assert.ok(out.notes.some((n) => n.startsWith("orch board read FAILED")));
  });

  test("BEHAVIOURAL: the degraded path prints a full object over an EMPTY board — empty output ⟺ read failure", async () => {
    const out = await collectOrchBoard({ github: fakeGithub(ok([])), hydra: serviceDown, now: () => NOW_MS, ghListLimit: 100 });
    assert.equal(out.value.orchBoardDegraded, false);
    const line = renderOrchBoardKv(out.value).split("\n")[0] as string;
    const parsed = JSON.parse(line);
    assert.equal(parsed.ready_for_agent, 0);
    assert.deepEqual(parsed.stale_in_progress, []);
  });
});

describe("orch board degraded path = deriveBoardState (ADR-0043 Decision 2)", () => {
  const board = [
    row(1, ["in-progress"], iso(STALE_IN_PROGRESS_SECONDS + 1)),
    row(2, ["in-progress"], iso(STALE_IN_PROGRESS_SECONDS - 1)),
    row(3, ["blocked"], iso(STALE_BLOCKED_SECONDS + 1)),
    row(4, ["blocked"], iso(STALE_BLOCKED_SECONDS - 1)),
    row(5, ["ready-for-agent", "glm-eligible"]),
    row(6, ["ready-for-agent", "target-backlog"]),
    row(7, ["ready-for-agent"], "not-a-date"),
  ];

  test("the counts line is deriveBoardState's projection (stale-heartbeat arm), using the board-labels windows", async () => {
    const out = await collectOrchBoard({ github: fakeGithub(ok(board)), hydra: serviceDown, now: () => NOW_MS, ghListLimit: 100 });
    assert.equal(out.value.counts.source, "derived");
    const line = renderOrchBoardKv(out.value).split("\n")[0] as string;
    const expected = deriveBoardState(
      board.map((r) => ({ number: r.number, labels: r.labels.map((l) => l.name), updatedAt: r.updatedAt, title: "", url: "", createdAt: "", body: "", state: "" })),
      NOW_MS,
    );
    assert.deepEqual(JSON.parse(line), expected);
    assert.deepEqual(Object.keys(JSON.parse(line)), Object.keys(expected).sort(), "gh --jq (gojq) prints object keys sorted");
    assert.deepEqual(JSON.parse(line).stale_in_progress, [1]);
    assert.deepEqual(JSON.parse(line).stale_blocked, [3]);
    assert.equal(JSON.parse(line).ready_for_agent, 2, "glm-eligible counted (fail-open, #3754); target-backlog excluded (#2704)");
  });

  test("a healthy service read wins; no gh board read is issued", async () => {
    let boardReads = 0;
    const github = {
      async listOpenIssueBoardRows() {
        boardReads++;
        return ok(board);
      },
      async openIssueNumbersByLabel() {
        return ok([]);
      },
    };
    const body = { needs_qa: 1, ready_for_agent: 2, needs_triage: 0, needs_research: 0, in_progress: 0, blocked: 0, stale_in_progress: [], stale_blocked: [], degraded: false, glm_withheld: [9] };
    const out = await collectOrchBoard({ github, hydra: { orchBoardState: async () => ok(body) }, now: () => NOW_MS, ghListLimit: 100 });
    assert.equal(boardReads, 0);
    assert.equal(out.value.counts.source, "service");
    assert.deepEqual(out.value.boardState, body);
  });

  test("the healthy-read test: degraded / non-object / missing ready_for_agent are unusable; null degraded is healthy", () => {
    assert.equal(healthyBoardState(ok({ ready_for_agent: 1, degraded: true })), null);
    assert.equal(healthyBoardState(ok([1, 2])), null);
    assert.equal(healthyBoardState(ok({ needs_qa: 1 })), null);
    assert.equal(healthyBoardState(EMPTY), null);
    assert.notEqual(healthyBoardState(ok({ ready_for_agent: 1, degraded: null })), null);
  });
});

describe("pyJsonDumps — python json.dumps defaults", () => {
  test("separators and ensure_ascii match python", () => {
    assert.equal(pyJsonDumps({ a: "é\u007f", b: [1, 2], c: {}, d: [] }), '{"a": "\\u00e9\\u007f", "b": [1, 2], "c": {}, "d": []}');
  });
});

describe("turn-snapshot CLI — slice-2 collectors", () => {
  test("a crashing orch-board collector renders the all-reads-failed fallback and flags the lane", async () => {
    let stdout = "";
    let stderr = "";
    let exportsText = "";
    const broken = createTurnSnapshotGithub({
      transport: async () => {
        throw new Error("boom");
      },
      repo: DEFAULT_GITHUB_REPO,
    });
    const code = await main(
      ["--collectors", "orch-board", "--exports-file", "x"],
      { github: broken, hydra: serviceDown, now: () => NOW_MS, sleep: async () => {} },
      { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), writeFile: (_p, t) => (exportsText = t) },
    );
    assert.equal(code, 0);
    assert.equal(stdout, "orch_needs_triage_items=\n");
    assert.match(stderr, /orch turn-snapshot orch-board collector crashed \(boom\)/);
    assert.equal(exportsText, "ORCH_BOARD_DEGRADED=1\nBOARD_STATE_DEGRADED=1\nBOARD_STATE_JSON=\n");
  });

  test("the production hydra adapter issues `hydra raw GET /autopilot/board-state`", async () => {
    const seen: string[][] = [];
    const adapter = createTurnSnapshotHydra({
      transport: async (args) => {
        seen.push(args);
        return { ok: false, stderr: "down" };
      },
    });
    assert.deepEqual(await adapter.orchBoardState(), EMPTY);
    assert.deepEqual(seen, [["raw", "GET", "/autopilot/board-state"]]);
  });
});
