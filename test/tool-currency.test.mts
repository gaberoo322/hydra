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
 * The driver script `scripts/tool-currency-check.ts` is exercised ONLY on its
 * alert-emit path (the `--alert` suite at the bottom): that path was re-routed
 * through the typed `pushAlert` seam in #3743, so it no longer depends on
 * subprocess/docker I/O and is safe to drive against Redis. The rest of the
 * driver — subprocess (`safeVersion`) + network (`safeFetchJson`) I/O — stays
 * untested: both fail closed to `null` and the merge logic produces `unknown`,
 * so an integration test would only re-prove the unit tests above.
 */
import test, { describe, after, beforeEach } from "node:test";
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
} from "../scripts/tool-currency-logic.ts";
import { emitAlert } from "../scripts/tool-currency-check.ts";
import { readAllAlerts, clearAlerts } from "../src/redis/alerts.ts";
import { closeRedisConnections } from "../src/redis/connection.ts";

// The driver's `emitAlert` routes through the `pushAlert` seam, which lazily
// opens an ioredis connection. The test runner injects an isolated DB via
// REDIS_URL; fall back to localhost DB 1 (same pattern as
// scout-alert-listener.test.mts).
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

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

// ===========================================================================
// Driver --alert emit (issue #3743). The `emitAlert` path must push a REAL,
// parseable alert through the `pushAlert` seam — never the empty string the
// prior `input`-on-async-execFile shell-out silently LPUSHed (which dropped
// the payload AND 500'd GET /api/alerts). This suite is a NEW top-level
// describe with its own Redis lifecycle (per the CLAUDE.md shared-Redis
// teardown pitfall): beforeEach clears `hydra:alerts`; after closes the
// singleton connection `pushAlert` opened.
// ===========================================================================

describe("scripts/tool-currency-check.ts — emitAlert (issue #3743, Redis-backed)", () => {
  beforeEach(async () => {
    await clearAlerts();
  });

  after(() => {
    // Release the singleton ioredis connection pushAlert opened so the test
    // process exits cleanly (mirrors scout-alert-listener.test.mts teardown).
    closeRedisConnections();
  });

  test("pushes a real, parseable alert that round-trips the tool payload", async () => {
    const report = buildReport({
      tool: "gh",
      installed: "2.45.0",
      latest: "2.92.0",
      verdicts: ["outdated"],
    });
    assert.equal(report.severity, "warning", "precondition: warning severity");

    await emitAlert(report);

    const all = await readAllAlerts();
    assert.equal(all.length, 1, "expected exactly one alert pushed");
    // The stored element must PARSE — the old shell-out silently LPUSHed "".
    const parsed = JSON.parse(all[0]);
    assert.equal(parsed.type, "tool-currency");
    assert.equal(parsed.severity, "warning");
    assert.equal(parsed.dismissed, false);
    // Round-trip the payload fields — NOT just that the command exited 0 (an
    // exit-code-only assertion is exactly what let the bug ship; issue #3743).
    assert.equal(parsed.payload.tool, report.tool);
    assert.equal(parsed.payload.installed, report.installed);
    assert.equal(parsed.payload.latest, report.latest);
    assert.equal(parsed.payload.verdict, report.verdict);
    assert.match(parsed.message, /Tool gh is outdated/);
  });

  test("never writes an empty string to hydra:alerts", async () => {
    const report = buildReport({
      tool: "node",
      installed: "18.20.0",
      latest: "20.11.0",
      verdicts: ["outdated"],
    });
    await emitAlert(report);

    const all = await readAllAlerts();
    assert.equal(all.length, 1);
    for (const raw of all) {
      assert.ok(raw.length > 0, "no empty-string element may be stored");
      // Every entry must parse — GET /api/alerts and the scout reader
      // JSON.parse each one; an empty/corrupt element 500s the route.
      JSON.parse(raw);
    }
  });
});
