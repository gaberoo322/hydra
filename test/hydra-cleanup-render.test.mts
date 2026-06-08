/**
 * Regression tests for the hydra-cleanup skill's rendering + dedup helpers
 * (issue #1167).
 *
 * `hydra-cleanup` (docs/operator-playbooks/hydra-cleanup.md) files one GitHub
 * issue per provably-unused finding knip reports. On autopilot run ef0a9847 it
 * DOUBLE-FILED: a draft set with malformed/blank titles
 * (`cleanup: remove unused export  (src/scheduler/heartbeat.ts)` — double-space
 * where the symbol name belongs; `cleanup: remove unused file ` — trailing
 * space, no path) was emitted alongside the canonical, correctly-titled set,
 * leaving 8 junk duplicates on the board (#1151–#1158).
 *
 * Two root causes (now owned by scripts/ci/hydra-cleanup-render.ts):
 *
 *   1. A finding whose symbol name (export) or path (file) failed to parse
 *      still got RENDERED, producing a malformed/blank title.
 *   2. The dedup key was the TITLE. Malformed draft titles didn't match the
 *      canonical titles, so dedup didn't recognise the drafts as duplicates.
 *
 * These tests guard both:
 *
 *   - validateFinding() REJECTS an empty path / empty export name BEFORE
 *     render, and renderTitle/renderBody THROW on an invalid finding — so no
 *     blank/double-space title can ever be emitted (cause 1).
 *   - findingIdentity() + dedupAgainstOpen() key on the stable `path::symbol`
 *     identity, NOT the title, so a malformed draft is recognised as a
 *     duplicate of its canonical sibling (cause 2).
 *   - parseKnipReport() extracts the symbol name / path from the same knip
 *     object the title is later derived from.
 *   - renderTitle / renderBody H1 / `## Files in scope` all name the same
 *     target (the #1005 off-by-one drift guard, re-checked at this seam).
 *   - The full parse → validate → dedup pipeline, run twice against a board
 *     already holding the canonical issues, emits ZERO new issues (the
 *     recurrence-prevention assertion #1167's acceptance asks for).
 *
 * The helpers are pure — no fs/network/process — so these tests run in
 * milliseconds with zero setup.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseKnipReport,
  validateFinding,
  findingIdentity,
  renderTitle,
  renderBody,
  identityFromOpenIssueTitle,
  dedupAgainstOpen,
  type CleanupFinding,
  type KnipReport,
} from "../scripts/ci/hydra-cleanup-render.ts";

const ISO = "2026-06-08";

describe("parseKnipReport — normalises knip JSON into well-formed findings", () => {
  test("extracts whole-file findings from the top-level files array", () => {
    const report: KnipReport = {
      files: ["dashboard/src/components/Card.jsx", "dashboard/src/components/Toast.jsx"],
      issues: [],
    };
    const findings = parseKnipReport(report);
    assert.deepEqual(findings, [
      { kind: "file", path: "dashboard/src/components/Card.jsx", name: "" },
      { kind: "file", path: "dashboard/src/components/Toast.jsx", name: "" },
    ]);
  });

  test("extracts export findings (name from the {name,line,col,pos} object) per file", () => {
    const report: KnipReport = {
      files: [],
      issues: [
        {
          file: "src/scheduler/heartbeat.ts",
          exports: [{ name: "_unusedHelper", line: 12, col: 3, pos: 200 }],
          types: [],
        },
        {
          file: "src/capacity-floor.ts",
          exports: [],
          types: [{ name: "DeadType", line: 4, col: 1, pos: 30 }],
        },
      ],
    };
    const findings = parseKnipReport(report);
    assert.deepEqual(findings, [
      { kind: "export", path: "src/scheduler/heartbeat.ts", name: "_unusedHelper" },
      { kind: "export", path: "src/capacity-floor.ts", name: "DeadType" },
    ]);
  });

  test("tolerates a bare-string export entry (edge knip shape) by reading it as the name", () => {
    const report: KnipReport = {
      issues: [{ file: "src/foo.ts", exports: ["legacyExport"], types: [] }],
    };
    const findings = parseKnipReport(report);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].name, "legacyExport");
  });

  test("an export entry with a missing/blank name parses to an empty name (so validate can drop it)", () => {
    // This is the #1167 cause-1 shape: an export object whose name didn't
    // populate. parseKnipReport must surface it as empty, NOT silently skip,
    // so validateFinding is the single chokepoint that drops it.
    const report: KnipReport = {
      issues: [
        { file: "src/scheduler/heartbeat.ts", exports: [{ line: 12, col: 3, pos: 200 }], types: [] },
      ],
    };
    const findings = parseKnipReport(report);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].name, "");
    assert.equal(findings[0].path, "src/scheduler/heartbeat.ts");
  });
});

describe("validateFinding — the blank-title root-cause guard (#1167 cause 1)", () => {
  test("accepts a well-formed file finding", () => {
    assert.equal(
      validateFinding({ kind: "file", path: "dashboard/src/components/Card.jsx", name: "" }),
      null,
    );
  });

  test("accepts a well-formed export finding", () => {
    assert.equal(
      validateFinding({ kind: "export", path: "src/x.ts", name: "foo" }),
      null,
    );
  });

  test("REJECTS a file finding with an empty path (the `remove unused file ` draft)", () => {
    const reason = validateFinding({ kind: "file", path: "", name: "" });
    assert.ok(reason, "empty-path file finding must be rejected");
    assert.match(reason!, /empty path/);
  });

  test("REJECTS an export finding with an empty name (the `remove unused export  (...)` draft)", () => {
    const reason = validateFinding({ kind: "export", path: "src/scheduler/heartbeat.ts", name: "" });
    assert.ok(reason, "empty-name export finding must be rejected");
    assert.match(reason!, /empty symbol name/);
  });

  test("REJECTS a whitespace-only export name (trailing-space artifact)", () => {
    assert.ok(validateFinding({ kind: "export", path: "src/x.ts", name: "   " }));
  });
});

describe("renderTitle / renderBody — never emit a malformed title", () => {
  test("file finding renders the canonical title", () => {
    assert.equal(
      renderTitle({ kind: "file", path: "dashboard/src/components/Card.jsx", name: "" }),
      "cleanup: remove unused file `dashboard/src/components/Card.jsx`",
    );
  });

  test("export finding renders the canonical title with the symbol name present", () => {
    assert.equal(
      renderTitle({ kind: "export", path: "src/scheduler/heartbeat.ts", name: "_unusedHelper" }),
      "cleanup: remove unused export `_unusedHelper` (src/scheduler/heartbeat.ts)",
    );
  });

  test("renderTitle THROWS on an invalid finding rather than emitting a blank title", () => {
    assert.throws(
      () => renderTitle({ kind: "export", path: "src/scheduler/heartbeat.ts", name: "" }),
      /refusing to render an invalid finding/,
    );
    assert.throws(
      () => renderTitle({ kind: "file", path: "", name: "" }),
      /refusing to render an invalid finding/,
    );
  });

  test("a rendered title never contains the double-space / trailing-space artifacts seen in #1167", () => {
    const finding: CleanupFinding = { kind: "export", path: "src/scheduler/heartbeat.ts", name: "_unusedHelper" };
    const title = renderTitle(finding);
    assert.ok(!/  /.test(title), "title must not contain a double space");
    assert.ok(!/ $/.test(title), "title must not end with a trailing space");
  });

  test("renderBody H1 + `## Files in scope` name the SAME target as the title (#1005 drift guard)", () => {
    const finding: CleanupFinding = { kind: "export", path: "src/capacity-floor.ts", name: "_resetCapacityHistory" };
    const title = renderTitle(finding);
    const body = renderBody(finding, ISO);
    // Title symbol + path appear in the H1.
    assert.ok(body.startsWith("# cleanup: remove unused export `_resetCapacityHistory` (src/capacity-floor.ts)"));
    // Files in scope lists exactly the finding's path.
    assert.match(body, /## Files in scope\n\n- `src\/capacity-floor\.ts`\n/);
    // And the title agrees.
    assert.ok(title.includes("_resetCapacityHistory"));
    assert.ok(title.includes("src/capacity-floor.ts"));
  });

  test("renderBody for a file finding carries the canonical scope section", () => {
    const body = renderBody({ kind: "file", path: "dashboard/src/components/Toast.jsx", name: "" }, ISO);
    assert.ok(body.startsWith("# cleanup: remove unused file `dashboard/src/components/Toast.jsx`"));
    assert.match(body, /## Files in scope\n\n- `dashboard\/src\/components\/Toast\.jsx`\n/);
  });

  test("renderBody THROWS on an invalid finding", () => {
    assert.throws(() => renderBody({ kind: "file", path: "", name: "" }, ISO), /refusing to render/);
  });
});

describe("findingIdentity / identityFromOpenIssueTitle — stable identity, not title (#1167 cause 2)", () => {
  test("export and file findings get distinct stable identities", () => {
    assert.equal(
      findingIdentity({ kind: "export", path: "src/scheduler/heartbeat.ts", name: "_unusedHelper" }),
      "src/scheduler/heartbeat.ts::_unusedHelper",
    );
    assert.equal(
      findingIdentity({ kind: "file", path: "dashboard/src/components/Card.jsx", name: "" }),
      "dashboard/src/components/Card.jsx::<file>",
    );
  });

  test("a finding's identity matches the identity recovered from its own canonical title", () => {
    const finding: CleanupFinding = { kind: "export", path: "src/scheduler/heartbeat.ts", name: "_unusedHelper" };
    const fromTitle = identityFromOpenIssueTitle(renderTitle(finding));
    assert.equal(fromTitle, findingIdentity(finding));
  });

  test("trailing-space artifact in a raw finding collapses onto the canonical identity", () => {
    const clean = findingIdentity({ kind: "export", path: "src/x.ts", name: "foo" });
    const dirty = findingIdentity({ kind: "export", path: "src/x.ts ", name: " foo" });
    assert.equal(dirty, clean);
  });

  test("identityFromOpenIssueTitle returns null for a malformed/blank-title draft", () => {
    // The exact malformed titles from #1167 must NOT parse to a real identity —
    // a blank-title draft is junk to be closed, not the canonical record.
    assert.equal(identityFromOpenIssueTitle("cleanup: remove unused export  (src/scheduler/heartbeat.ts)"), null);
    assert.equal(identityFromOpenIssueTitle("cleanup: remove unused file "), null);
    assert.equal(identityFromOpenIssueTitle("some unrelated issue title"), null);
  });
});

describe("dedupAgainstOpen — recognises duplicates by identity, recurrence-prevention (#1167)", () => {
  test("drops a finding whose canonical issue is already open", () => {
    const findings: CleanupFinding[] = [
      { kind: "file", path: "dashboard/src/components/Card.jsx", name: "" },
      { kind: "export", path: "src/scheduler/heartbeat.ts", name: "_unusedHelper" },
    ];
    const openTitles = [
      "cleanup: remove unused file `dashboard/src/components/Card.jsx`",
    ];
    const { kept, dropped } = dedupAgainstOpen(findings, openTitles);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].name, "_unusedHelper");
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].path, "dashboard/src/components/Card.jsx");
  });

  test("a malformed-title draft on the board does NOT shield the canonical finding from being filed", () => {
    // The draft title is junk → it parses to no identity → it does not register
    // as an open issue for this finding. The canonical finding is therefore
    // still emitted (and the junk draft gets closed separately). This documents
    // that dedup keys on identity, and junk drafts simply don't participate.
    const findings: CleanupFinding[] = [
      { kind: "export", path: "src/scheduler/heartbeat.ts", name: "_unusedHelper" },
    ];
    const openTitles = ["cleanup: remove unused export  (src/scheduler/heartbeat.ts)"];
    const { kept } = dedupAgainstOpen(findings, openTitles);
    assert.equal(kept.length, 1, "canonical finding still emitted; junk draft ignored");
  });

  test("in-batch dedup: a finding identity is emitted at most once per run", () => {
    const findings: CleanupFinding[] = [
      { kind: "export", path: "src/x.ts", name: "foo" },
      { kind: "export", path: "src/x.ts", name: "foo" }, // duplicate within the same batch
    ];
    const { kept, dropped } = dedupAgainstOpen(findings, []);
    assert.equal(kept.length, 1);
    assert.equal(dropped.length, 1);
  });

  test("RECURRENCE: re-running the full pipeline against the board it just filled emits ZERO new issues", () => {
    // Simulate run ef0a9847: knip reports 6 real findings.
    const report: KnipReport = {
      files: ["dashboard/src/components/Card.jsx", "dashboard/src/components/Toast.jsx"],
      issues: [
        { file: "src/scheduler/heartbeat.ts", exports: [{ name: "_unusedHelper" }], types: [] },
        { file: "src/capacity-floor.ts", exports: [{ name: "_resetCapacityHistory" }], types: [] },
        { file: "src/publish.ts", exports: [{ name: "deadPublish" }], types: [] },
        { file: "src/slot-events-bridge.ts", exports: [{ name: "deadBridge" }], types: [] },
      ],
    };

    // First pass: parse, validate, dedup against an empty board, render.
    const first = parseKnipReport(report).filter((f) => validateFinding(f) === null);
    const firstPass = dedupAgainstOpen(first, []);
    assert.equal(firstPass.kept.length, 6, "all 6 real findings emitted on the first run");
    // Every emitted issue gets a well-formed canonical title (no junk drafts).
    const emittedTitles = firstPass.kept.map((f) => renderTitle(f));
    for (const t of emittedTitles) {
      assert.ok(!/  /.test(t) && !/ $/.test(t), `emitted title is well-formed: ${t}`);
    }

    // Second pass: the SAME knip findings, but now the board holds the
    // canonical issues from pass 1. Dedup must drop all of them → zero new.
    const second = parseKnipReport(report).filter((f) => validateFinding(f) === null);
    const secondPass = dedupAgainstOpen(second, emittedTitles);
    assert.equal(secondPass.kept.length, 0, "re-run double-files nothing — board stays at the real finding count");
    assert.equal(secondPass.dropped.length, 6);
  });
});
