/**
 * Toolchain pin guard (issue #3952).
 *
 * Hydra had NO Node version pinning anywhere — no `.nvmrc`, no `engines`, no
 * `setup-node` in CI — so every CI job, every worktree, and the operator's
 * shell ran whatever Node the host happened to have. Two documented CLAUDE.md
 * pitfalls (`--experimental-strip-types` rejecting TS parameter properties;
 * `--import tsx` resolution differences) are downstream symptoms of exactly
 * that gap: the `npm test` runner is `node --experimental-strip-types --test …`,
 * so the suite's behaviour is directly coupled to the Node minor, and a
 * drifted runner produces a red CI run that looks exactly like a code
 * regression — the failure the agent then "fixes" for a green-on-its-machine,
 * red-in-CI symptom.
 *
 * This file is the enforcement. `.nvmrc` + `package.json`'s `engines.node`
 * declare the pin; this test reads both and fails loudly — naming the
 * expected and actual version — when the running interpreter drifts.
 *
 * Per the issue's acceptance criteria this is a TEST, not a `ci.yml` step:
 * editing `.github/workflows/ci.yml` is T4 Verifier Core (deep-QA required for
 * a version check), and a sibling advisory workflow cannot gate a merge (no
 * seam-check is a required check). The `test` job IS required, so a test
 * failure there genuinely blocks auto-merge — same mechanism
 * `test/deploy-drift.test.mts` and `test/ci-test-job-pipefail-guard.test.mts`
 * already use.
 *
 * The comparison helper below is hand-rolled (no `semver` dependency —
 * ADR-0005 keeps the runtime-dep allowlist to express/ioredis/ws/@sentry/node/
 * zod/pino). The failure arm is proven by unit-testing the helper directly
 * with synthetic out-of-range inputs (the `semver helper` describe block), NOT
 * by mutating the real `.nvmrc`/`package.json` files (acceptance criterion 3).
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NVMRC_PATH = resolve(REPO_ROOT, ".nvmrc");
const PKG_PATH = resolve(REPO_ROOT, "package.json");

// ---------------------------------------------------------------------------
// Hand-rolled semver (Node stdlib only — no `semver` dependency, ADR-0005).
// Supports the comparator shapes that appear in a real npm `engines.node`
// range (`>=`, `<=`, `>`, `<`, `=`/bare, `^`, `~`); an unsupported shape
// throws so a future range edit can never silently degrade to a vacuous pass.
// ---------------------------------------------------------------------------

interface Version {
  major: number;
  minor: number;
  patch: number;
}

type Operator = ">=" | "<=" | ">" | "<" | "=";
type RangeToken = "^" | "~" | Operator;

interface Comparator {
  op: Operator;
  version: Version;
}

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)/;

/** Parse "v22.23.1" or "22.18.0" into parts (leading `v` tolerated). */
function parseVersion(raw: string): Version {
  const m = raw.trim().match(VERSION_RE);
  if (!m) {
    throw new Error(`toolchain-pin: unparseable version: ${JSON.stringify(raw)}`);
  }
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** Negative when a < b, zero when equal, positive when a > b. */
function compareVersion(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/** `^22.18.0` -> `>=22.18.0 <23.0.0` (models the >=1 major contract). */
function caretBounds(v: Version): { lo: Version; hi: Version } {
  return { lo: v, hi: { major: v.major + 1, minor: 0, patch: 0 } };
}

/** `~22.18.0` -> `>=22.18.0 <22.19.0`. */
function tildeBounds(v: Version): { lo: Version; hi: Version } {
  return { lo: v, hi: { major: v.major, minor: v.minor + 1, patch: 0 } };
}

/**
 * Parse a space-separated npm range into `>= / < …` comparators. `^`/`~`
 * desugar to a `>= lo < hi` pair; `*` / empty mean "no bound". Throws on any
 * token it cannot interpret so a malformed range fails loud rather than
 * passing vacuously.
 */
function parseRange(range: string): Comparator[] {
  const out: Comparator[] = [];
  for (const tokRaw of range.trim().split(/\s+/)) {
    const tok = tokRaw.trim();
    if (tok === "" || tok === "*") continue;
    const m = tok.match(/^(>=|<=|>|<|\^|~|=)?(.+)$/);
    if (!m) {
      throw new Error(`toolchain-pin: unparseable comparator: ${JSON.stringify(tok)}`);
    }
    const op = (m[1] || "=") as RangeToken;
    if (op === "^" || op === "~") {
      const v = parseVersion(m[2]);
      const { lo, hi } = op === "^" ? caretBounds(v) : tildeBounds(v);
      out.push({ op: ">=", version: lo }, { op: "<", version: hi });
    } else {
      out.push({ op, version: parseVersion(m[2]) });
    }
  }
  if (out.length === 0) {
    throw new Error(`toolchain-pin: empty range: ${JSON.stringify(range)}`);
  }
  return out;
}

function satisfiesComparator(v: Version, c: Comparator): boolean {
  const cmp = compareVersion(v, c.version);
  switch (c.op) {
    case ">=":
      return cmp >= 0;
    case "<=":
      return cmp <= 0;
    case ">":
      return cmp > 0;
    case "<":
      return cmp < 0;
    case "=":
      return cmp === 0;
  }
}

/** True iff `version` (e.g. "v22.23.1") satisfies `range` (e.g. ">=22.18.0 <23.0.0"). */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  return parseRange(range).every((c) => satisfiesComparator(v, c));
}

/** Read `.nvmrc`'s pinned version (trimmed, single token expected). */
function readNvmrc(): string {
  return readFileSync(NVMRC_PATH, "utf8").trim();
}

/** Read `package.json`'s `engines.node` range; throws if the field is absent. */
function readEnginesNode(): string {
  const pkg = JSON.parse(readFileSync(PKG_PATH, "utf8")) as {
    engines?: { node?: string };
  };
  const range = pkg.engines?.node;
  if (!range) {
    throw new Error(
      "toolchain-pin: package.json has no engines.node field — the pin is missing",
    );
  }
  return range;
}

// ---------------------------------------------------------------------------
// Unit tests of the comparison helper — these PROVE the failure arm without
// touching the real `.nvmrc` / `package.json` (acceptance criterion 3).
// ---------------------------------------------------------------------------

describe("semver helper", () => {
  test("satisfies: an in-range version passes", () => {
    assert.equal(satisfies("v22.23.1", ">=22.18.0 <23.0.0"), true);
  });

  test("satisfies: below the floor fails (the drift this guard exists to catch)", () => {
    assert.equal(satisfies("v22.17.0", ">=22.18.0 <23.0.0"), false);
    assert.equal(satisfies("v21.7.0", ">=22.18.0 <23.0.0"), false);
  });

  test("satisfies: at or above the ceiling fails", () => {
    assert.equal(satisfies("v23.0.0", ">=22.18.0 <23.0.0"), false);
    assert.equal(satisfies("v24.0.0", ">=22.18.0 <23.0.0"), false);
  });

  test("satisfies: the exact floor is inclusive and the last in-range minor passes", () => {
    assert.equal(satisfies("v22.18.0", ">=22.18.0 <23.0.0"), true);
    assert.equal(satisfies("v22.99.99", ">=22.18.0 <23.0.0"), true);
  });

  test("satisfies: tolerates a leading v or its absence on either side", () => {
    assert.equal(satisfies("22.23.1", ">=22.18.0 <23.0.0"), true);
  });

  test("satisfies: caret desugars to >=lo <next-major", () => {
    assert.equal(satisfies("v22.23.1", "^22.18.0"), true);
    assert.equal(satisfies("v23.0.0", "^22.18.0"), false);
  });

  test("satisfies: tilde desugars to >=lo <next-minor", () => {
    assert.equal(satisfies("v22.18.5", "~22.18.0"), true);
    assert.equal(satisfies("v22.19.0", "~22.18.0"), false);
  });

  test("compareVersion orders across major / minor / patch", () => {
    const lt = (a: string, b: string) =>
      compareVersion(parseVersion(a), parseVersion(b)) < 0;
    assert.equal(lt("22.18.0", "22.23.1"), true);
    assert.equal(lt("22.23.1", "22.18.0"), false);
    assert.equal(
      compareVersion(parseVersion("22.23.1"), parseVersion("22.23.1")),
      0,
    );
  });
});

// ---------------------------------------------------------------------------
// The live assertions: the running interpreter AND `.nvmrc`'s pin must both
// fall inside `package.json`'s `engines.node`. A drifted runner or a
// contradicting pin fails loud and self-diagnoses (names expected vs actual).
// ---------------------------------------------------------------------------

describe("toolchain pin (live)", () => {
  test("`.nvmrc` exists at repo root and holds a single exact version string", () => {
    const nvmrc = readNvmrc();
    assert.equal(
      nvmrc.split(/\s+/).length,
      1,
      `.nvmrc should hold exactly one version, got: ${JSON.stringify(nvmrc)}`,
    );
    assert.match(
      nvmrc,
      /^\d+\.\d+\.\d+$/,
      `.nvmrc should be an exact version (no range operator, no leading 'v'), got: ${JSON.stringify(nvmrc)}`,
    );
  });

  test("package.json declares an engines.node range", () => {
    const range = readEnginesNode();
    assert.ok(range.length > 0, "engines.node must be a non-empty range");
  });

  test("the running interpreter satisfies engines.node (else the runner has drifted)", () => {
    const range = readEnginesNode();
    const nvmrc = readNvmrc();
    assert.equal(
      satisfies(process.version, range),
      true,
      `Node drift: running ${process.version} is outside engines.node "${range}". ` +
        `Fix with: \`nvm use ${nvmrc}\` (or \`nvm install ${nvmrc}\` first).`,
    );
  });

  test(".nvmrc's pinned version itself satisfies engines.node (the two never contradict)", () => {
    const range = readEnginesNode();
    const nvmrc = readNvmrc();
    assert.equal(
      satisfies(nvmrc, range),
      true,
      `.nvmrc (${nvmrc}) contradicts engines.node (${range}) — bump the pin or ` +
        `widen the range on purpose, they must agree.`,
    );
  });
});
