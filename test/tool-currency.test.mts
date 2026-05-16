/**
 * Tests for the tool-currency check (issue #480).
 *
 * Covers:
 *   - semver parsing edge cases (`v` prefix, trailing decorations, junk).
 *   - drift classification (ok / stale / outdated / unknown).
 *   - merge logic (most-severe verdict wins).
 *   - Node N-2 rule.
 *   - age-based escalation.
 *   - report-table formatting (stable column widths, notes line).
 *   - alert message shape.
 *
 * The driver script `scripts/tool-currency-check.ts` is intentionally NOT
 * exercised here because it does subprocess + network I/O. Per CLAUDE.md
 * test conventions ("Grounding tests mock execFileAsync by testing pure
 * functions") we test the pure logic and trust the wiring. The driver's
 * `safeFetchJson` / `safeVersion` paths fail closed by design — both
 * return null on any error and the merge logic produces `unknown`, so a
 * separate integration test would only re-prove what the unit tests cover.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  parseSemver,
  extractVersionFromOutput,
  classifyByVersion,
  classifyByAge,
  classifyNodeMajor,
  mergeVerdicts,
  formatReportTable,
  buildReport,
  buildAlertMessage,
} from "../src/tool-currency.ts";

test("parseSemver: clean semver", () => {
  assert.deepEqual(parseSemver("1.2.3"), { major: 1, minor: 2, patch: 3 });
});

test("parseSemver: v-prefix", () => {
  assert.deepEqual(parseSemver("v22.11.0"), { major: 22, minor: 11, patch: 0 });
});

test("parseSemver: trailing decorations", () => {
  // gh prints `gh version 2.92.0 (2025-09-01)`.
  assert.deepEqual(
    parseSemver("gh version 2.92.0 (2025-09-01)"),
    { major: 2, minor: 92, patch: 0 },
  );
});

test("parseSemver: junk returns null", () => {
  assert.equal(parseSemver(""), null);
  assert.equal(parseSemver(null), null);
  assert.equal(parseSemver(undefined), null);
  assert.equal(parseSemver("not a version"), null);
});

test("extractVersionFromOutput: typical gh output", () => {
  assert.equal(
    extractVersionFromOutput("gh version 2.92.0 (2025-09-01)\nhttps://..."),
    "2.92.0",
  );
});

test("extractVersionFromOutput: node output", () => {
  assert.equal(extractVersionFromOutput("v22.11.0\n"), "22.11.0");
});

test("classifyByVersion: ok when installed equals latest", () => {
  assert.equal(classifyByVersion("2.92.0", "2.92.0"), "ok");
});

test("classifyByVersion: ok when installed is ahead", () => {
  assert.equal(classifyByVersion("2.93.0", "2.92.0"), "ok");
});

test("classifyByVersion: stale when one minor behind", () => {
  assert.equal(classifyByVersion("2.91.0", "2.92.0"), "stale");
});

test("classifyByVersion: stale when many minor behind (same major)", () => {
  // The 2.45 -> 2.92 incident that motivated the issue. Same major, so
  // we report `stale`, not `outdated` — the major-bump rule is the only
  // escalator on the version axis. The age-based escalator (or
  // operator policy) catches this case in practice.
  assert.equal(classifyByVersion("2.45.0", "2.92.0"), "stale");
});

test("classifyByVersion: outdated when one major behind", () => {
  assert.equal(classifyByVersion("1.99.0", "2.92.0"), "outdated");
});

test("classifyByVersion: unknown when latest unparseable", () => {
  assert.equal(classifyByVersion("2.92.0", null), "unknown");
});

test("classifyByVersion: unknown when installed unparseable", () => {
  assert.equal(classifyByVersion(null, "2.92.0"), "unknown");
});

test("classifyByAge: returns outdated when release is older than threshold", () => {
  const now = new Date("2026-05-16T00:00:00Z");
  const released = new Date("2025-01-01T00:00:00Z"); // ~16 months ago
  assert.equal(classifyByAge(released.toISOString(), now), "outdated");
});

test("classifyByAge: returns null when release is fresh", () => {
  const now = new Date("2026-05-16T00:00:00Z");
  const released = new Date("2026-04-01T00:00:00Z"); // ~1.5 months ago
  assert.equal(classifyByAge(released.toISOString(), now), null);
});

test("classifyByAge: returns null on missing input", () => {
  assert.equal(classifyByAge(null), null);
  assert.equal(classifyByAge(undefined), null);
  assert.equal(classifyByAge("not a date"), null);
});

test("classifyNodeMajor: N is ok", () => {
  assert.equal(classifyNodeMajor("22.11.0", 22), "ok");
});

test("classifyNodeMajor: N+2 (ahead) is ok — operator built from edge", () => {
  assert.equal(classifyNodeMajor("24.0.0", 22), "ok");
});

test("classifyNodeMajor: N-1 is stale", () => {
  assert.equal(classifyNodeMajor("20.11.0", 22), "stale");
});

test("classifyNodeMajor: N-2 is outdated", () => {
  assert.equal(classifyNodeMajor("18.20.0", 22), "outdated");
});

test("classifyNodeMajor: N-3 is outdated", () => {
  assert.equal(classifyNodeMajor("16.20.0", 22), "outdated");
});

test("classifyNodeMajor: unparseable -> unknown", () => {
  assert.equal(classifyNodeMajor(null, 22), "unknown");
});

test("mergeVerdicts: outdated wins over stale and ok", () => {
  assert.deepEqual(
    mergeVerdicts(["ok", "stale", "outdated"]),
    { verdict: "outdated", severity: "warning" },
  );
});

test("mergeVerdicts: stale wins over ok and unknown", () => {
  assert.deepEqual(
    mergeVerdicts(["unknown", "ok", "stale"]),
    { verdict: "stale", severity: "info" },
  );
});

test("mergeVerdicts: only unknowns -> unknown (info, never warn)", () => {
  assert.deepEqual(
    mergeVerdicts(["unknown", "unknown"]),
    { verdict: "unknown", severity: "info" },
  );
});

test("mergeVerdicts: empty -> unknown", () => {
  assert.deepEqual(
    mergeVerdicts([]),
    { verdict: "unknown", severity: "info" },
  );
});

test("buildReport: outdated emits warning severity", () => {
  const r = buildReport({
    tool: "gh",
    installed: "1.0.0",
    latest: "2.92.0",
    verdicts: ["outdated"],
  });
  assert.equal(r.verdict, "outdated");
  assert.equal(r.severity, "warning");
});

test("buildReport: stale emits info severity", () => {
  const r = buildReport({
    tool: "gh",
    installed: "2.91.0",
    latest: "2.92.0",
    verdicts: ["stale"],
  });
  assert.equal(r.severity, "info");
});

test("formatReportTable: renders header, separator, rows", () => {
  const out = formatReportTable([
    {
      tool: "gh",
      installed: "2.92.0",
      latest: "2.92.0",
      verdict: "ok",
      severity: "info",
    },
    {
      tool: "node",
      installed: "18.20.0",
      latest: "22.x (LTS)",
      verdict: "outdated",
      severity: "warning",
      note: "installed is N-2 or older from Node 22 LTS; upgrade soon",
    },
  ]);
  const lines = out.split("\n");
  assert.match(lines[0], /^tool\s+installed\s+latest\s+verdict$/);
  // Separator line: only dashes and double-spaces.
  assert.match(lines[1], /^[-\s]+$/);
  assert.match(out, /gh\s+2\.92\.0\s+2\.92\.0\s+ok/);
  assert.match(out, /node\s+18\.20\.0\s+22\.x \(LTS\)\s+outdated \(warn\)/);
  // The note appears below the table for the outdated tool.
  assert.match(out, /- node: installed is N-2/);
});

test("formatReportTable: empty input", () => {
  assert.equal(formatReportTable([]), "(no tools checked)");
});

test("buildAlertMessage: shape is stable and short", () => {
  const msg = buildAlertMessage({
    tool: "gh",
    installed: "2.45.0",
    latest: "2.92.0",
    verdict: "outdated",
    severity: "warning",
  });
  assert.equal(msg, "Tool gh is outdated (installed 2.45.0, latest 2.92.0)");
  assert.ok(msg.length < 90, "alert message must fit the 90-char doctor truncation");
});

test("end-to-end: simulated outdated gh produces warning verdict", () => {
  // Replicates the 2026-05-15 incident shape: apt gh 2.45.0 vs upstream
  // 2.92.0, with a release date >6mo old.
  const installed = extractVersionFromOutput("gh version 2.45.0 (2024-03-21)");
  const latest = extractVersionFromOutput("v2.92.0");
  const versionVerdict = classifyByVersion(installed, latest);
  const ageVerdict = classifyByAge(
    "2025-09-01T00:00:00Z",
    new Date("2026-05-16T00:00:00Z"),
  );
  const verdicts = [versionVerdict, ...(ageVerdict ? [ageVerdict] : [])];
  const report = buildReport({
    tool: "gh",
    installed,
    latest,
    verdicts,
  });
  // Same major (2.x) so version axis says "stale", but the release is
  // >6mo old, so the age axis escalates to "outdated" and severity is
  // "warning" — exactly the surfacing the issue asks for.
  assert.equal(report.verdict, "outdated");
  assert.equal(report.severity, "warning");
});

test("end-to-end: network failure -> unknown, never warn", () => {
  // Simulate `safeFetchJson` returning null (offline). Caller passes
  // `latest = null` and only the version verdict (unknown) fires.
  const installed = "2.92.0";
  const latest: string | null = null;
  const verdicts = [classifyByVersion(installed, latest)];
  const report = buildReport({
    tool: "gh",
    installed,
    latest,
    verdicts,
    note: "couldn't reach api.github.com — verdict unknown",
  });
  assert.equal(report.verdict, "unknown");
  assert.equal(report.severity, "info");
  assert.match(report.note ?? "", /couldn't reach/);
});
