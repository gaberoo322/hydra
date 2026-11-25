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
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  SHAPES,
  STANDARD_REL,
  parseAvoidTerms,
  findHits,
  countByShape,
  measureRows,
  vocabularyRatchet,
  scanRepo,
  ADR_SHAPES,
  listAdrs,
  measureAdrRows,
  adrVocabularyRatchet,
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
        "5 issue-cite #1234",
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
    const body = "not yet at src/gate.ts:42 in hydra-betting, the Untouchable Core, see #1945, kept for legacy, EMIT_CAP, INV-9, tracked as a follow-up";
    assert.deepEqual(
      new Set(findHits(PB, body, AVOID).map((h: { shape: string }) => h.shape)),
      new Set(SHAPES.filter((s: string) => s !== "shell-lines")),
    );
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

describe("playbook-vocabulary-ratchet: ratchet policy and rows", () => {
  const found = { [PB]: findHits(PB, "ok\nIt currently skips.\nSee src/a.ts:9 — not yet done.", AVOID) };

  test("counts are per shape", () => {
    assert.deepEqual(countByShape(found[PB]), { status: 2, "line-cite": 1 });
  });

  test("one required counted ceiling ratchet, stale rows fail, on its own baseline", () => {
    const p = vocabularyRatchet.policy;
    assert.equal(p.id, "playbook-vocabulary-ratchet");
    assert.equal(p.shape, "counted");
    assert.equal(p.polarity, "ceiling");
    assert.equal(p.stale, "fail");
    assert.equal(p.enforcement, "required");
    assert.match(p.baseline, /playbook-vocabulary-baseline\.json$/);
  });

  test("rows are tab-keyed playbook-first, one per file per shape, valued at the count", () => {
    const rows = measureRows();
    const keys = Object.keys(rows);
    assert.ok(keys.length > 0);
    for (const k of keys) {
      const [file, shape, ...rest] = k.split("\t");
      assert.equal(rest.length, 0, k);
      assert.match(file, /^docs\/operator-playbooks\/.+\.md$/);
      assert.ok((SHAPES as readonly string[]).includes(shape), k);
      assert.ok(rows[k] >= 1);
    }
  });

  test("the remedy the module prints names the standard, Historical: and the per-shape fixes", () => {
    const help = (vocabularyRatchet.policy.help ?? []).join("\n");
    assert.ok(help.includes(STANDARD_REL));
    assert.match(help, /Historical:/);
    assert.match(help, /symbol-cite/);
    assert.match(help, /invariant-cite/);
  });

  test("the retired --shape scope is refused as an unknown flag (exit 2)", async () => {
    assert.equal(await vocabularyRatchet.main(["--shape", "status"]), 2);
  });
});

describe("playbook-vocabulary-ratchet: issue-cite, back-compat and shell-lines shapes", () => {
  const F = "```";

  test("a bare issue or PR number in prose is an issue-cite; placeholders are not", () => {
    assert.deepEqual(hits("per #1945 and issue #4118, see PR #4090. Use #N, #<N>, #$ANCHOR_NUM, #12345678.", "issue-cite"), [
      "1 issue-cite per #1945",
      "1 issue-cite issue #4118",
      "1 issue-cite PR #4090",
    ]);
  });

  test("a template token is exempt by token while another cite on the same line still counts", () => {
    assert.deepEqual(hits("Body ends Closes #1234, Part of #5678 and Blocked by #4321; see #1945.", "issue-cite"), [
      "1 issue-cite #1945",
    ]);
    assert.deepEqual(hits("Refs: #1234 and Parent #5678", "issue-cite"), []);
  });

  test("issue-cite and back-compat skip fenced blocks and Historical: lines", () => {
    const text = ["```text", "see #1945 and legacy path", "```", "Historical: #1945 kept for legacy", "see #1946, legacy"].join("\n");
    assert.deepEqual(hits(text, "issue-cite"), ["5 issue-cite #1946"]);
    assert.deepEqual(hits(text, "back-compat"), ["5 back-compat legacy"]);
  });

  test("back-compat is the closed phrase list", () => {
    assert.deepEqual(
      hits("Kept for readers; a legacy title, retained rows, previously seen, back-compat, back-compatible, Phase B.", "back-compat"),
      [
        "1 back-compat Kept for",
        "1 back-compat legacy",
        "1 back-compat retained",
        "1 back-compat previously",
        "1 back-compat back-compat",
        "1 back-compat back-compatible",
        "1 back-compat Phase B",
      ],
    );
    assert.deepEqual(hits("The phase is over. Phase out the legacies; phase a rollout is not a letter.", "back-compat"), []);
  });

  test("shell-lines emits one hit per shell block with its size and ignores other fences", () => {
    const text = [
      `${F}bash`, "a", "b", F,
      `${F}json`, "{}", F,
      F, "x", F,
      `~~~~Sh title`, "c", F, "~~~~",
      `${F}python`, "print(1)", F,
    ].join("\n");
    assert.deepEqual(hits(text, "shell-lines"), ["1 shell-lines bash fence, 2 lines", "11 shell-lines sh fence, 2 lines"]);
    assert.deepEqual(countByShape(findHits(PB, text, AVOID)), { "shell-lines": 4 });
  });

  test("a longer fence nests a shorter one and a blockquote prefix does not hide the fence", () => {
    const text = ["````bash", `${F}`, "inner", `${F}`, "````", "> ```zsh", "> ls", "> ```", "```bash", "tail"].join("\n");
    assert.deepEqual(hits(text, "shell-lines"), [
      "1 shell-lines bash fence, 3 lines",
      "6 shell-lines zsh fence, 1 lines",
      "9 shell-lines bash fence, 1 lines",
    ]);
  });

  test("the Historical: exemption does not apply to a shell block", () => {
    assert.deepEqual(hits(["```bash", "Historical: echo hi", "```"].join("\n"), "shell-lines"), ["1 shell-lines bash fence, 1 lines"]);
  });

  test("new shapes sit after the original four so existing hit order is unchanged", () => {
    assert.deepEqual(SHAPES.slice(0, 4), ["status", "line-cite", "target", "avoid-term"]);
    assert.deepEqual(SHAPES.slice(4), ["issue-cite", "back-compat", "shell-lines", "symbol-cite", "invariant-cite", "process-meta"]);
  });
});

describe("playbook-vocabulary-ratchet: the symbol-cite shape", () => {
  const sym = (text: string): string[] => hits(text, "symbol-cite");

  test("counts a constant, a camelCase call and a dotted field path, in prose or code spans", () => {
    assert.deepEqual(sym("The cap is EMIT_CAP and `childLabels()` reads .pr.headSha.\nAlso `SYMBOLS_PER_BATCH`."), [
      "1 symbol-cite EMIT_CAP",
      "1 symbol-cite childLabels()",
      "1 symbol-cite .pr.headSha",
      "2 symbol-cite SYMBOLS_PER_BATCH",
    ]);
  });

  test("a bare camelCase word, a one-segment field and a plain constant are not hits", () => {
    assert.deepEqual(sym("Call childLabels then read .headSha on the HTTP OK path."), []);
  });

  test("a $VAR or ${VAR} shell read is exempt, the same name without its sigil is a hit", () => {
    assert.deepEqual(sym("Read $TARGET_WS and ${TARGET_GH_REPO:?unset} here."), []);
    assert.deepEqual(sym("Read TARGET_WS here."), ["1 symbol-cite TARGET_WS"]);
  });

  test("filenames, extensions and globs are not hits", () => {
    assert.deepEqual(sym("See CODING_STANDARDS.md, *.test.mts, .d.ts, foo.test.mts and HYDRA_TARGET_*."), []);
  });

  test("a symbol tied to its file by an attribution phrase is exempt", () => {
    assert.deepEqual(sym("`EMIT_CAP` in `scripts/ci/x.ts` bounds it."), []);
    assert.deepEqual(sym("`scripts/ci/x.ts`'s `childLabels()` renders it."), []);
    assert.deepEqual(sym("`EMIT_CAP` and `OTHER_CAP` in `scripts/ci/x.ts`."), ["1 symbol-cite EMIT_CAP"]);
  });

  test("fenced blocks and a Historical: line are skipped", () => {
    assert.deepEqual(sym(["```text", "EMIT_CAP childLabels() .a.b", "```"].join("\n")), []);
    assert.deepEqual(sym("Historical: EMIT_CAP was here."), []);
  });
});

describe("playbook-vocabulary-ratchet: the invariant-cite shape", () => {
  const inv = (text: string): string[] => hits(text, "invariant-cite");

  test("counts INV-<1-3 digits> and INV-<capital> in prose", () => {
    assert.deepEqual(inv("INV-009 is a WARN; see INV-A and INV-12."), ["1 invariant-cite INV-009", "1 invariant-cite INV-A", "1 invariant-cite INV-12"]);
  });

  test("INV-ABC, INV-1234, INV-a and INVESTOR-1 never match", () => {
    assert.deepEqual(inv("INV-ABC INV-1234 INV-a INVESTOR-1"), []);
  });

  test("a definition bullet loses only its label; another id on it still counts", () => {
    assert.deepEqual(inv("- **INV-H** \u2014 the lever, as INV-007 says."), ["1 invariant-cite INV-007"]);
    assert.deepEqual(inv("- INV-2: a definition."), []);
    assert.deepEqual(inv("Prose with **INV-H** \u2014 not a bullet."), ["1 invariant-cite INV-H"]);
  });

  test("fenced blocks and a Historical: line are skipped", () => {
    assert.deepEqual(inv(["```text", "INV-009", "```"].join("\n")), []);
    assert.deepEqual(inv("Historical: INV-009 was here."), []);
  });
});

describe("playbook-vocabulary-ratchet: the process-meta shape", () => {
  const meta = (text: string): string[] => hits(text, "process-meta");

  test("counts the closed phrase list, case-insensitively", () => {
    assert.deepEqual(
      meta(
        [
          "Tracked as a separate follow-up.",
          "This is tracked separately.",
          "Out of scope for this PR.",
          "Lands in a follow-up slice.",
          "In scope of this change.",
          "Beyond this PR's scope.",
          "Beyond this PR\u2019s scope.",
        ].join("\n"),
      ).map((h) => h.split(" ")[0]),
      ["1", "2", "3", "4", "5", "6", "7"],
    );
  });

  test("bare follow-up, this PR, separate PR and out of scope for this session are not hits", () => {
    assert.deepEqual(meta("File follow-ups for every low. The issue this PR closes. File a separate PR. Out of scope for this session."), []);
  });

  test("fenced blocks and a Historical: line are skipped", () => {
    assert.deepEqual(meta(["```text", "tracked as a follow-up", "```"].join("\n")), []);
    assert.deepEqual(meta("Historical: tracked as a follow-up."), []);
  });
});

describe("playbook-vocabulary-ratchet: the real playbooks", () => {
  test("target-seam-preamble.md carries zero symbol-cite hits (cleaned in this PR; INV-4 amendment)", () => {
    const rel = "docs/operator-playbooks/_fragments/target-seam-preamble.md";
    const hits = scanRepo()[rel] ?? [];
    assert.deepEqual(hits.filter((h) => h.shape === "symbol-cite"), []);
  });

  test("the standard the report points at defines the playbook rules", () => {
    const standard = readFileSync(join(REPO_ROOT, STANDARD_REL), "utf8");
    assert.match(standard, /^### STD-PLAYBOOK-CURRENT-BEHAVIOUR$/m);
  });
});

describe("playbook-vocabulary-ratchet: the ADR corpus", () => {
  test("the ADR policy is a separate required ceiling with its own baseline", () => {
    assert.equal(adrVocabularyRatchet.policy.id, "adr-vocabulary-ratchet");
    assert.match(adrVocabularyRatchet.policy.baseline, /^scripts\/ci\/adr-vocabulary-baseline\.json$/);
    assert.equal(adrVocabularyRatchet.policy.polarity, "ceiling");
    assert.equal(adrVocabularyRatchet.policy.enforcement, "required");
    assert.notEqual(adrVocabularyRatchet.policy.baseline, vocabularyRatchet.policy.baseline);
  });

  test("the corpus is the numbered ADR files, never README.md", () => {
    const files = listAdrs();
    assert.ok(files.length > 0);
    for (const f of files) assert.match(f, /^docs\/adr\/\d{4}-[^/]+\.md$/);
    assert.ok(!files.some((f) => f.endsWith("README.md")));
  });

  test("measured rows are nonempty and carry only invariant-cite and symbol-cite", () => {
    const keys = Object.keys(measureAdrRows());
    assert.ok(keys.length > 0);
    for (const key of keys) {
      assert.ok((ADR_SHAPES as readonly string[]).includes(key.split("\t")[1]), key);
    }
  });

  test("a synthetic ADR yields only invariant-cite and symbol-cite rows, README excluded", () => {
    const root = mkdtempSync(join(tmpdir(), "adr-vocab-"));
    try {
      mkdirSync(join(root, "docs/adr"), { recursive: true });
      writeFileSync(join(root, "CONTEXT.md"), "");
      writeFileSync(
        join(root, "docs/adr/0001-x.md"),
        "# X\n\nSee INV-3 here. It uses `MAX_RETRY_LIMIT` and currently works. Fixed in #123.\n",
      );
      writeFileSync(join(root, "docs/adr/README.md"), "INV-4 and `OTHER_CONST_NAME`\n");
      assert.deepEqual(listAdrs(root), ["docs/adr/0001-x.md"]);
      const rows = measureAdrRows(root);
      assert.deepEqual(Object.keys(rows).sort(), [
        "docs/adr/0001-x.md\tinvariant-cite",
        "docs/adr/0001-x.md\tsymbol-cite",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the help text cites ADR-0037", () => {
    assert.ok(adrVocabularyRatchet.policy.help.some((l: string) => l.includes("ADR-0037")));
  });

  test("baseline keys are <adr path>\\t<shape> with only the two ADR shapes", () => {
    const base = JSON.parse(readFileSync(join(process.cwd(), adrVocabularyRatchet.policy.baseline), "utf8"));
    const rows = base.rows ?? base;
    const keys = Object.keys(rows);
    assert.ok(keys.length > 0);
    for (const k of keys) assert.match(k, /^docs\/adr\/\d{4}-[^\t]+\.md\t(invariant-cite|symbol-cite)$/);
  });

  test("the live ADR tree is within its baseline", async () => {
    const v = await adrVocabularyRatchet.verdict();
    assert.equal(v.ok, true, JSON.stringify(v));
  });
});
