/**
 * zizmor finding ratchet (issue #5640). Pure: every case drives the adapter with
 * inline json-v1 fixtures, never the scanner and never the network.
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BASELINE_REL,
  DEFAULT_INPUT,
  UNKNOWN_FILE,
  ZizmorInputError,
  countFindings,
  loadFindings,
  repoRelative,
  toRows,
  zizmorRatchet,
} from "../scripts/ci/zizmor-ratchet.ts";

const root = join(import.meta.dirname, "..");

function finding(ident: string, path: string | null, extra: Record<string, unknown> = {}) {
  const locations = path === null ? [] : [{ symbolic: { key: { Local: { verbatim_path: path } } } }];
  return { ident, determinations: { severity: "High" }, locations, ...extra };
}

const WF_A = ".github/workflows/a.yml";
const WF_B = ".github/workflows/b.yml";

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

describe("zizmorRatchet verdict", () => {
  const withBaseline = async (baseline: Record<string, number>, findings: unknown[]) => {
    const dir = mkdtempSync(join(tmpdir(), "zizmor-ratchet-"));
    mkdirSync(join(dir, "scripts/ci"), { recursive: true });
    writeFileSync(join(dir, BASELINE_REL), JSON.stringify(baseline));
    writeFileSync(join(dir, DEFAULT_INPUT), JSON.stringify(findings));
    return zizmorRatchet.verdict(dir);
  };
  const key = (file: string, ident: string) => `${file}\t${ident}`;

  test("a clean tree (counts equal the baseline) passes", async () => {
    const v = await withBaseline({ [key(WF_A, "unpinned-uses")]: 1 }, [finding("unpinned-uses", WF_A)]);
    assert.equal(v.ok, true);
    assert.deepEqual(v.stale, []);
  });

  test("a count above its row is a violation, and every ident is ratcheted (not just two)", async () => {
    const v = await withBaseline({ [key(WF_A, "unpinned-uses")]: 1 }, [
      finding("template-injection", WF_A),
      finding("unpinned-uses", WF_A),
    ]);
    assert.equal(v.ok, false);
    assert.deepEqual(v.added, [key(WF_A, "template-injection")]);
    assert.match(v.advice, /template-injection/);
  });

  test("a count below its row is a stale hint, never a violation", async () => {
    const v = await withBaseline({ [key(WF_A, "unpinned-uses")]: 3, [key(WF_B, "artipacked")]: 1 }, [
      finding("unpinned-uses", WF_A),
    ]);
    assert.equal(v.ok, true);
    assert.equal(v.stale.length, 2);
  });

  test("fixing a finding in one file does not mask a new one in another", async () => {
    const v = await withBaseline({ [key(WF_A, "unpinned-uses")]: 1 }, [finding("unpinned-uses", WF_B)]);
    assert.equal(v.ok, false);
    assert.deepEqual(v.added, [key(WF_B, "unpinned-uses")]);
    assert.deepEqual(v.stale, [key(WF_A, "unpinned-uses")]);
  });

  test("toRows flattens per-file counts to tab-keyed rows", () => {
    assert.deepEqual(toRows({ [WF_A]: { "unpinned-uses": 2, artipacked: 1 } }), {
      [key(WF_A, "unpinned-uses")]: 2,
      [key(WF_A, "artipacked")]: 1,
    });
  });
});

describe("the committed baseline", () => {
  test("parses as a counted {key: positive integer} object against the live repo", async () => {
    // A scope that measures nothing and keeps no row: only the baseline read + shape validation run.
    const v = await zizmorRatchet.verdict(root, { measure: async () => ({}), keep: () => false });
    assert.equal(v.crashed, undefined, v.advice);
    assert.equal(v.ok, true);
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
    assert.match(r.stderr, /brand-new-ident/);
  });

  test("the retired --files flag is an unknown flag (exit 2)", () => {
    const r = run(["--input", join(mkdtempSync(join(tmpdir(), "zizmor-ratchet-")), "x.json"), "--files", "a"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown flag --files/);
  });
});
