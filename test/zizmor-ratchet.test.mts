/**
 * zizmor finding ratchet (issue #5640). Pure: every case drives the adapter with
 * inline json-v1 fixtures, never the scanner and never the network.
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UNKNOWN_FILE,
  ZizmorInputError,
  buildBaseline,
  compareAgainstBaseline,
  countFindings,
  formatReport,
  loadBaseline,
  loadFindings,
  mergeBaselineForFiles,
  repoRelative,
  type Baseline,
} from "../scripts/ci/zizmor-ratchet.ts";

const root = join(import.meta.dirname, "..");

function finding(ident: string, path: string | null, extra: Record<string, unknown> = {}) {
  const locations = path === null ? [] : [{ symbolic: { key: { Local: { verbatim_path: path } } } }];
  return { ident, determinations: { severity: "High" }, locations, ...extra };
}

const WF_A = ".github/workflows/a.yml";
const WF_B = ".github/workflows/b.yml";

const base = (files: Baseline["files"]): Baseline => ({ note: "n", files });

describe("countFindings", () => {
  test("counts per workflow x ident and keys rows by the repo-relative path", () => {
    const found = countFindings([
      finding("unpinned-uses", `/runner/work/hydra/${WF_A}`),
      finding("unpinned-uses", `/other/checkout/${WF_A}`),
      finding("artipacked", WF_A),
      finding("unpinned-uses", WF_B),
    ]);
    assert.deepEqual(found, { [WF_A]: { "unpinned-uses": 2, artipacked: 1 }, [WF_B]: { "unpinned-uses": 1 } });
  });

  test("ignored findings are not counted", () => {
    assert.deepEqual(countFindings([finding("unpinned-uses", WF_A, { ignored: true })]), {});
  });

  test("a finding with no location falls back to the unknown row", () => {
    assert.deepEqual(countFindings([finding("anonymous-definition", null)]), { [UNKNOWN_FILE]: { "anonymous-definition": 1 } });
  });

  test("a non-array or ident-less input is a ZizmorInputError", () => {
    assert.throws(() => countFindings({}), ZizmorInputError);
    assert.throws(() => countFindings([{ locations: [] }]), ZizmorInputError);
  });

  test("repoRelative keeps the .github/workflows tail and leaves other paths alone", () => {
    assert.equal(repoRelative(`/x/y/${WF_A}`), WF_A);
    assert.equal(repoRelative("elsewhere.yml"), "elsewhere.yml");
  });
});

describe("compareAgainstBaseline", () => {
  test("a clean tree (counts equal the baseline) reports nothing", () => {
    const found = countFindings([finding("unpinned-uses", WF_A)]);
    const cmp = compareAgainstBaseline(found, base({ [WF_A]: { "unpinned-uses": 1 } }));
    assert.deepEqual(cmp, { exceeded: [], stale: [] });
    assert.equal(formatReport(cmp), "");
  });

  test("a count above its cell is exceeded, and every ident is ratcheted (not just two)", () => {
    const found = countFindings([finding("template-injection", WF_A), finding("unpinned-uses", WF_A)]);
    const cmp = compareAgainstBaseline(found, base({ [WF_A]: { "unpinned-uses": 1 } }));
    assert.deepEqual(cmp.exceeded, [{ file: WF_A, key: "template-injection", count: 1, baseline: 0 }]);
    assert.match(formatReport(cmp), /a\.yml: template-injection count 1 > baseline 0/);
  });

  test("a count below its cell is stale (nudge), never exceeded", () => {
    const found = countFindings([finding("unpinned-uses", WF_A)]);
    const cmp = compareAgainstBaseline(found, base({ [WF_A]: { "unpinned-uses": 3 }, [WF_B]: { artipacked: 1 } }));
    assert.deepEqual(cmp.exceeded, []);
    assert.equal(cmp.stale.length, 2);
    assert.match(formatReport(cmp), /lower/);
  });

  test("fixing a finding in one file does not mask a new one in another", () => {
    const found = countFindings([finding("unpinned-uses", WF_B)]);
    const cmp = compareAgainstBaseline(found, base({ [WF_A]: { "unpinned-uses": 1 } }));
    assert.equal(cmp.exceeded.length, 1);
    assert.equal(cmp.exceeded[0]?.file, WF_B);
    assert.equal(cmp.stale.length, 1);
  });
});

describe("baseline writers", () => {
  test("buildBaseline sorts file and ident keys and drops empty rows", () => {
    const b = buildBaseline({ [WF_B]: { z: 1, a: 2 }, [WF_A]: { "unpinned-uses": 1 }, ".github/workflows/empty.yml": {} });
    assert.deepEqual(Object.keys(b.files), [WF_A, WF_B]);
    assert.deepEqual(Object.keys(b.files[WF_B] ?? {}), ["a", "z"]);
  });

  test("a rebuild from the same findings is byte-identical", () => {
    const found = countFindings([finding("b", WF_B), finding("a", WF_A), finding("a", WF_A)]);
    assert.equal(JSON.stringify(buildBaseline(found)), JSON.stringify(buildBaseline(countFindings([finding("a", WF_A), finding("a", WF_A), finding("b", WF_B)]))));
  });

  test("a scoped re-seed replaces only the named files' rows and keeps the note", () => {
    const existing = base({ [WF_A]: { "unpinned-uses": 3 }, [WF_B]: { artipacked: 2 } });
    const found = countFindings([finding("unpinned-uses", WF_A), finding("artipacked", WF_B)]);
    const merged = mergeBaselineForFiles(existing, found, [WF_A]);
    assert.deepEqual(merged.files, { [WF_A]: { "unpinned-uses": 1 }, [WF_B]: { artipacked: 2 } });
    assert.equal(merged.note, "n");
  });

  test("the committed baseline is sorted, positive-only and keyed by repo-relative workflow paths", async () => {
    const committed = await loadBaseline();
    assert.deepEqual(Object.keys(committed.files), Object.keys(committed.files).sort());
    for (const [file, row] of Object.entries(committed.files)) {
      assert.match(file, /^\.github\/workflows\/[^/]+\.ya?ml$/);
      assert.deepEqual(Object.keys(row), Object.keys(row).sort());
      for (const n of Object.values(row)) assert.ok(Number.isInteger(n) && n > 0);
    }
  });
});

describe("CLI exit codes", () => {
  const script = join(root, "scripts/ci/zizmor-ratchet.ts");
  const run = (args: string[]) =>
    spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", script, ...args], { encoding: "utf8", timeout: 30_000 });

  test("a missing input exits 2 with its own message", () => {
    const r = run(["--input", join(mkdtempSync(join(tmpdir(), "zizmor-ratchet-")), "missing.json")]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /cannot read zizmor input/);
  });

  test("an unparseable input exits 2, distinct from a ratchet failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "zizmor-ratchet-"));
    const file = join(dir, "bad.json");
    writeFileSync(file, "not json");
    const r = run(["--input", file]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /not valid JSON/);
    assert.throws(() => loadFindings(file), ZizmorInputError);
  });

  test("a finding above the committed baseline exits 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "zizmor-ratchet-"));
    const file = join(dir, "found.json");
    writeFileSync(file, JSON.stringify([finding("brand-new-ident", WF_A)]));
    const r = run(["--input", file]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /brand-new-ident count 1 > baseline 0/);
  });
});
