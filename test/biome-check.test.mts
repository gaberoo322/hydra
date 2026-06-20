/**
 * test/biome-check.test.mts — pin the biome-check decision contract at the pure
 * -function level (no npx spawn, no process.exit), issue #2204.
 *
 * scripts/ci/biome-check.ts is a thin Adapter over @biomejs/biome: it shells
 * out, parses the JSON result, and maps it to an exit code. The mapping lives in
 * the pure, side-effect-free `decideBiomeCheck(result, failOnError)` so the
 * advisory-vs-blocking contract can be pinned WITHOUT touching the network — the
 * same "export the pure predicate, test it without shelling out" pattern the
 * dep-boundary-check and seam-check tests use. Importing the module must NOT
 * trigger the npx spawn (guarded by isCliEntrypoint), which this very test
 * relies on.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { decideBiomeCheck } = await import("../scripts/ci/biome-check.ts");

type Diagnostic = {
  severity: string;
  message: string;
  category: string;
  location?: { path?: string; start?: { line?: number; column?: number } };
};

function result(opts: {
  diagnostics?: Diagnostic[];
  errors?: number;
  warnings?: number;
  infos?: number;
  changed?: number;
  unchanged?: number;
}) {
  return {
    summary: {
      errors: opts.errors ?? 0,
      warnings: opts.warnings ?? 0,
      infos: opts.infos ?? 0,
      changed: opts.changed ?? 0,
      unchanged: opts.unchanged ?? 271,
    },
    diagnostics: opts.diagnostics ?? [],
  };
}

const warnDiag: Diagnostic = {
  severity: "warning",
  message: "This import is unused.",
  category: "lint/correctness/noUnusedImports",
  location: { path: "src/foo.ts", start: { line: 3, column: 1 } },
};

const errorDiag: Diagnostic = {
  severity: "error",
  message: "Control character in a regular expression.",
  category: "lint/suspicious/noControlCharactersInRegex",
  location: { path: "src/bar.ts", start: { line: 12, column: 5 } },
};

describe("biome-check: decision contract", () => {
  test("clean scan (no diagnostics) exits 0", () => {
    const d = decideBiomeCheck(result({ unchanged: 271 }), false);
    assert.equal(d.exitCode, 0);
    assert.equal(d.byCategory.size, 0);
    assert.match(d.headline, /clean/);
  });

  test("warn-severity findings are ADVISORY — exit 0 even with --error", () => {
    const d = decideBiomeCheck(result({ diagnostics: [warnDiag], warnings: 1 }), true);
    assert.equal(d.exitCode, 0, "a warn-only diagnostic must never block, even under --error");
    assert.equal(d.byCategory.get("lint/correctness/noUnusedImports")?.length, 1);
  });

  test("warn findings without --error are advisory exit 0", () => {
    const d = decideBiomeCheck(result({ diagnostics: [warnDiag], warnings: 1 }), false);
    assert.equal(d.exitCode, 0);
    assert.match(d.headline, /advisory/);
  });

  test("error-severity finding UNDER --error blocks (exit 1)", () => {
    const d = decideBiomeCheck(result({ diagnostics: [errorDiag], errors: 1 }), true);
    assert.equal(d.exitCode, 1);
    assert.match(d.headline, /failing/);
  });

  test("error-severity finding WITHOUT --error stays advisory (exit 0)", () => {
    const d = decideBiomeCheck(result({ diagnostics: [errorDiag], errors: 1 }), false);
    assert.equal(
      d.exitCode,
      0,
      "default (advisory) mode never blocks — promoting to a gate requires --error",
    );
  });

  test("zero files scanned is a TOOL error (exit 2), never a clean pass", () => {
    const d = decideBiomeCheck(result({ changed: 0, unchanged: 0 }), false);
    assert.equal(d.exitCode, 2, "0 files means biome saw nothing — config/glob regression");
    assert.match(d.headline, /0 files/);
  });

  test("groups diagnostics by category (biome rule id)", () => {
    const d = decideBiomeCheck(
      result({
        diagnostics: [
          warnDiag,
          { ...warnDiag, location: { path: "src/baz.ts", start: { line: 9, column: 1 } } },
          errorDiag,
        ],
        warnings: 2,
        errors: 1,
      }),
      false,
    );
    assert.equal(d.byCategory.get("lint/correctness/noUnusedImports")?.length, 2);
    assert.equal(d.byCategory.get("lint/suspicious/noControlCharactersInRegex")?.length, 1);
  });

  test("changed + unchanged both count toward files scanned", () => {
    // A run that auto-fixed some files would report changed>0; both halves count.
    const d = decideBiomeCheck(result({ changed: 5, unchanged: 266 }), false);
    assert.equal(d.exitCode, 0, "5 changed + 266 unchanged = 271 scanned, not a tool error");
  });
});
