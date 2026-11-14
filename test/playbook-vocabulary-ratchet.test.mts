/**
 * test/playbook-vocabulary-ratchet.test.mts — the playbook vocabulary ratchet
 * (issue #5500): the mechanically detectable breaches of the playbook authoring
 * standard (CODING_STANDARDS.md, STD-PLAYBOOK-*) are counted per playbook and
 * per shape, and capped by a shrink-only baseline.
 *
 * The unit cases feed synthetic playbook text through the exported pure
 * functions, so each banned shape is proven detectable without touching the
 * filesystem. The last case runs the real ratchet over the real playbooks:
 * that is the gate.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const {
  SHAPES,
  STANDARD_REL,
  WRITE_BASELINE_CMD,
  parseAvoidTerms,
  findHits,
  countByShape,
  compareAgainstBaseline,
  buildBaseline,
  formatReport,
  scanRepo,
  loadBaseline,
} = await import("../scripts/ci/playbook-vocabulary-ratchet.ts");
const { REPO_ROOT } = await import("../scripts/ci/seam-check-lib.ts");

const PB = "docs/operator-playbooks/hydra-example.md";
const AVOID = ["Untouchable Core", "selectAnchor"];

function hits(text: string, shape?: string): string[] {
  return findHits(PB, text, AVOID)
    .filter((h: { shape: string }) => !shape || h.shape === shape)
    .map((h: { shape: string; line: number; phrase: string }) => `${h.line} ${h.shape} ${h.phrase}`);
}

describe("playbook-vocabulary-ratchet: each banned shape is detected", () => {
  test("status and history phrases", () => {
    assert.deepEqual(
      hits(
        [
          "The lane is not yet wired.",
          "It currently skips the check.",
          "Formerly a cron job; it no longer runs.",
          "The sweep used to label these.",
          "Skip this until #1234 lands.",
          "Runs in shadow mode during the rollout.",
        ].join("\n"),
      ),
      [
        "1 status not yet",
        "2 status currently",
        "3 status Formerly",
        "3 status no longer",
        "4 status used to",
        "5 status until #1234 lands",
        "6 status shadow mode",
        "6 status rollout",
      ],
    );
  });

  test("a passive 'is used to' states purpose and is not a history phrase", () => {
    assert.deepEqual(hits("The key is used to dedupe. Flags are used to gate. It can be used to probe."), []);
  });

  test("a file-and-line-number cite into a source file", () => {
    assert.deepEqual(hits("See `src/gate.ts:42` and scripts/reap.py:10-20, not `docs/x.md:3`."), [
      "1 line-cite src/gate.ts:42",
      "1 line-cite scripts/reap.py:10-20",
    ]);
  });

  test("a hardcoded Target name", () => {
    assert.deepEqual(hits("cd ~/hydra-betting/web && npm test", "target"), ["1 target hydra-betting"]);
  });

  test("a retired glossary term, matched whole and case-insensitively", () => {
    assert.deepEqual(hits("The Untouchable Core list; call selectAnchor; the untouchable core.\nreselectAnchors"), [
      "1 avoid-term Untouchable Core",
      "1 avoid-term selectAnchor",
      "1 avoid-term untouchable core",
    ]);
  });

  test("a clean playbook has no hits", () => {
    assert.deepEqual(hits("Read the class table, then run the script and report its output."), []);
  });
});

describe("playbook-vocabulary-ratchet: the Historical: exemption", () => {
  test("a line marked Historical: is exempt from every shape", () => {
    const body = "not yet at src/gate.ts:42 in hydra-betting, the Untouchable Core";
    assert.deepEqual(new Set(findHits(PB, body, AVOID).map((h: { shape: string }) => h.shape)), new Set(SHAPES));
    assert.deepEqual(hits(`Historical: ${body}`), []);
  });

  test("the exemption covers only its own line", () => {
    assert.deepEqual(hits("Historical: formerly a cron job.\nIt currently runs hourly."), ["2 status currently"]);
  });

  test("the continuation line of a hard-wrapped Historical: note is counted (QA round 1)", () => {
    const wrapped = "> Historical: this was formerly a cron job that\n> used to run hourly.";
    assert.deepEqual(hits(wrapped), ["2 status used to"]);
    assert.deepEqual(hits("> Historical: this was formerly a cron job that used to run hourly."), []);
  });
});

describe("playbook-vocabulary-ratchet: the Avoid list comes from CONTEXT.md", () => {
  test("retired multi-word and identifier terms are taken; live words and non-retired items are not", () => {
    const md = [
      "**Verifier Core**:",
      "The gate.",
      '_Avoid_: Untouchable Core (retired name), "Tier 0" / Tier 0 changes (retired, ADR-0015), gate files',
      "_Avoid_: spec (retired), selectAnchor() (retired with ADR-0036), board, lane (an alias, still live)",
    ].join("\n");
    assert.deepEqual(parseAvoidTerms(md), ["Tier 0", "Tier 0 changes", "Untouchable Core", "selectAnchor"]);
  });

  test("the real glossary yields the retired Verifier Core name", () => {
    const terms = parseAvoidTerms(readFileSync(join(REPO_ROOT, "CONTEXT.md"), "utf8"));
    assert.ok(terms.includes("Untouchable Core"), terms.join(", "));
    assert.ok(terms.length >= 5, terms.join(", "));
  });
});

describe("playbook-vocabulary-ratchet: shrink-only per-file baseline", () => {
  const found = { [PB]: findHits(PB, "ok\nIt currently skips.\nSee src/a.ts:9 — not yet done.", AVOID) };

  test("counts are per shape", () => {
    assert.deepEqual(countByShape(found[PB]), { status: 2, "line-cite": 1 });
  });

  test("counts equal to the baseline pass", () => {
    const cmp = compareAgainstBaseline(found, { note: "", files: { [PB]: { status: 2, "line-cite": 1 } } });
    assert.deepEqual(cmp, { exceeded: [], stale: [] });
    assert.equal(formatReport(cmp), "");
  });

  test("a count above its baseline fails and the report names playbook, line and phrase", () => {
    const cmp = compareAgainstBaseline(found, { note: "", files: { [PB]: { status: 1, "line-cite": 1 } } });
    assert.equal(cmp.exceeded.length, 1);
    assert.deepEqual(
      { file: cmp.exceeded[0].file, shape: cmp.exceeded[0].shape, count: cmp.exceeded[0].count, baseline: cmp.exceeded[0].baseline },
      { file: PB, shape: "status", count: 2, baseline: 1 },
    );
    const report = formatReport(cmp);
    assert.ok(report.includes(`${PB}:2  status  "currently"`), report);
    assert.ok(report.includes(`${PB}:3  status  "not yet"`), report);
    assert.ok(!report.includes("line-cite"), report);
    assert.ok(report.includes(STANDARD_REL));
    assert.match(report, /Historical:/);
    assert.match(report, /Do not raise the baseline/);
  });

  test("a file absent from the baseline is capped at zero", () => {
    const cmp = compareAgainstBaseline(found, { note: "", files: {} });
    assert.deepEqual(cmp.exceeded.map((d: { shape: string }) => d.shape), ["status", "line-cite"]);
  });

  test("a count below its baseline is stale until the baseline is lowered", () => {
    const cmp = compareAgainstBaseline(found, {
      note: "",
      files: { [PB]: { status: 5, "line-cite": 1 }, "docs/operator-playbooks/gone.md": { target: 2 } },
    });
    assert.deepEqual(cmp.exceeded, []);
    assert.deepEqual(
      cmp.stale.map((d: { file: string; shape: string; count: number; baseline: number }) => `${d.file} ${d.shape} ${d.count}<${d.baseline}`),
      ["docs/operator-playbooks/gone.md target 0<2", `${PB} status 2<5`],
    );
    const report = formatReport(cmp);
    assert.match(report, /lower the baseline/);
    assert.ok(report.includes(WRITE_BASELINE_CMD));
  });

  test("buildBaseline is sorted, per file, and omits clean files and zero counts", () => {
    const baseline = buildBaseline({ "b.md": found[PB], "a.md": [] });
    assert.deepEqual(baseline.files, { "b.md": { status: 2, "line-cite": 1 } });
    assert.doesNotMatch(baseline.note, /\d{4}-\d{2}-\d{2}/);
  });
});

describe("playbook-vocabulary-ratchet: the real playbooks", () => {
  test("no playbook or fragment is above or below its baselined count", async () => {
    const report = formatReport(compareAgainstBaseline(scanRepo(), await loadBaseline()));
    assert.equal(report, "", `\n${report}\n`);
  });

  test("the standard the report points at defines the playbook rules", () => {
    const standard = readFileSync(join(REPO_ROOT, STANDARD_REL), "utf8");
    assert.match(standard, /^### STD-PLAYBOOK-CURRENT-BEHAVIOUR$/m);
  });
});
