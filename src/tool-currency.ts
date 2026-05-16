/**
 * Tool-currency check (issue #480).
 *
 * Compares installed versions of the CLI tools Hydra shells out to against
 * their upstream "latest" reference, and reports drift. Surfaced by the
 * `hydra-doctor` playbook so the operator sees stale tooling before it
 * breaks autopilot.
 *
 * Motivating incident: 2026-05-15, the Ubuntu apt `gh 2.45.0` package was
 * ~47 versions behind upstream. `gh pr edit --add-label` stopped working
 * silently against the current GraphQL schema, autopilot looped on a bad
 * label-add for ~hours. A passive currency check would have surfaced it as
 * an `outdated` verdict before the first cycle ran.
 *
 * This module is the **pure-logic** half — version parsing + drift
 * classification + report shaping. All I/O (running subprocesses, fetching
 * upstream APIs, writing Redis alerts) lives in
 * `scripts/tool-currency-check.ts`. The split is intentional so the test
 * suite can mock both halves cleanly without touching the network.
 *
 * Read-only by contract: nothing here can install, upgrade, or modify a
 * binary. The doctor reports; the operator decides.
 */

export type Verdict = "ok" | "stale" | "outdated" | "unknown";

export type Severity = "info" | "warning";

export interface ToolReport {
  tool: string;
  installed: string;
  latest: string;
  verdict: Verdict;
  severity: Severity;
  note?: string;
}

export interface SemverParts {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Parse a version string into numeric semver parts. Strips a leading `v`,
 * tolerates extra suffixes (`-rc.1`, `+build`, trailing whitespace) and
 * returns null on anything we can't confidently parse.
 *
 * We deliberately accept partial versions — `gh --version` emits
 * `gh version 2.92.0 (2025-...)` so we run the regex against the matched
 * triple. `node --version` emits `v22.11.0` cleanly. Both flow through
 * the same path.
 */
export function parseSemver(raw: string | null | undefined): SemverParts | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  // Match the first MAJOR.MINOR.PATCH triple. Allows `v` prefix and
  // ignores anything after the patch number.
  const m = trimmed.match(/v?(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return null;
  }
  return { major, minor, patch };
}

/**
 * Extract a version triple from arbitrary `<tool> --version` output. Many
 * tools print decorations (`gh version 2.92.0 (...)`, `Node.js v22.11.0`).
 * Returns the first triple found, or null.
 */
export function extractVersionFromOutput(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = String(raw).match(/v?(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

/**
 * Compare an installed version to a latest version and return the drift
 * verdict. Rules (from the issue body):
 *
 *   - installed >= latest         -> ok
 *   - 1 minor version behind      -> stale (info)
 *   - >= 1 major version behind   -> outdated (warning)
 *   - latest unknown / unparseable -> unknown (info, never warn)
 *
 * "Behind by >= 6 months" is a separate concern that requires a release
 * date, which not every upstream exposes consistently. That branch is
 * handled by `classifyByAge()` below and merged in `mergeVerdicts()` so
 * the version-based and date-based signals can both vote.
 *
 * If the installed version is AHEAD of latest (e.g. an operator built
 * from main), we treat it as `ok` — being ahead is never a doctor finding.
 */
export function classifyByVersion(
  installed: string | null,
  latest: string | null,
): Verdict {
  const a = parseSemver(installed);
  const b = parseSemver(latest);
  if (!a || !b) return "unknown";

  if (a.major < b.major) return "outdated";
  if (a.major > b.major) return "ok";
  // same major
  if (a.minor + 1 < b.minor) {
    // Behind by 2+ minor versions on the same major — still "stale" by
    // the spec (we only escalate to "outdated" on a major-version delta
    // or on age). Operators tend to care about majors; minors are noisy.
    return "stale";
  }
  if (a.minor < b.minor) return "stale";
  // same major.minor — installed >= latest patch, or behind by patches.
  // Patch drift is below the noise floor; report ok.
  return "ok";
}

/**
 * Classify by release age. If `latest` was released >= 6 months ago and
 * the installed version is parseably the same, we don't escalate — that
 * means the tool itself is just slow-moving. But if the INSTALLED version
 * was released >= 6 months before `latest`, that's the warning condition
 * the issue body calls out.
 *
 * Because per-version release dates require a second API call we don't
 * always want to make, this function only fires when the caller supplies
 * a `latestReleasedAt` (Date or ISO string). When omitted, returns null
 * and the caller falls back to the version-only verdict.
 */
export function classifyByAge(
  latestReleasedAt: string | Date | null | undefined,
  now: Date = new Date(),
  thresholdMs: number = 6 * 30 * 24 * 60 * 60 * 1000, // ~6 months
): "outdated" | null {
  if (!latestReleasedAt) return null;
  const released = latestReleasedAt instanceof Date
    ? latestReleasedAt
    : new Date(latestReleasedAt);
  if (Number.isNaN(released.getTime())) return null;
  const ageMs = now.getTime() - released.getTime();
  return ageMs >= thresholdMs ? "outdated" : null;
}

/**
 * Combine version-based and age-based verdicts into a single verdict +
 * severity. The most-severe signal wins:
 *
 *   outdated > stale > ok > unknown
 *
 * `unknown` is the floor — if we have no signal, we say so rather than
 * pretending the tool is fine. But `unknown` is always info severity:
 * the doctor must never warn the operator about something it failed to
 * check.
 */
export function mergeVerdicts(verdicts: ReadonlyArray<Verdict>): {
  verdict: Verdict;
  severity: Severity;
} {
  if (verdicts.some(v => v === "outdated")) return { verdict: "outdated", severity: "warning" };
  if (verdicts.some(v => v === "stale")) return { verdict: "stale", severity: "info" };
  if (verdicts.some(v => v === "ok")) return { verdict: "ok", severity: "info" };
  return { verdict: "unknown", severity: "info" };
}

/**
 * Compare a Node major version against the current LTS major. Returns
 * `outdated` if installed is two LTS lines behind or older (N-4 in raw
 * major number terms — Node ships even-only LTS majors: 18, 20, 22, 24).
 *
 * Mapping the issue's "N-2 or older" rule onto Node's release cadence:
 *   - same major (22)            -> ok
 *   - one LTS line behind  (20)  -> stale  (raw delta 2)
 *   - two LTS lines behind (18)  -> outdated (raw delta 4)
 *   - newer than LTS             -> ok (operator built from edge)
 *
 * Odd majors (21, 23) are "Current" lines, not LTS. We treat one major
 * behind LTS (e.g. 21 when LTS is 22) as `stale` — it's not an LTS
 * release at all but it isn't dramatically out of date either.
 *
 * We don't try to detect the LTS major from the network — `node` doesn't
 * have a clean release-feed shape that's worth the complexity. The LTS
 * major is supplied by the caller (the script reads it from a constant
 * or env var). This keeps the function pure and unit-testable.
 */
export function classifyNodeMajor(
  installed: string | null,
  currentLtsMajor: number,
): Verdict {
  const a = parseSemver(installed);
  if (!a) return "unknown";
  if (!Number.isFinite(currentLtsMajor) || currentLtsMajor <= 0) return "unknown";
  const delta = currentLtsMajor - a.major;
  if (delta <= 0) return "ok"; // installed equal or ahead
  if (delta <= 2) return "stale"; // one LTS line back (or interim Current)
  return "outdated"; // two or more LTS lines back
}

/**
 * Format a list of tool reports as a fixed-width table. Used by the
 * doctor playbook to render the `Tool currency` section.
 *
 * Columns: tool / installed / latest / verdict.
 *
 * We don't import any table library — this is one screen of code and
 * keeps the orchestrator at its four-runtime-deps invariant.
 */
export function formatReportTable(reports: ReadonlyArray<ToolReport>): string {
  if (reports.length === 0) return "(no tools checked)";

  const headers = ["tool", "installed", "latest", "verdict"];
  const rows = reports.map(r => [
    r.tool,
    r.installed || "?",
    r.latest || "?",
    r.severity === "warning" ? `${r.verdict} (warn)` : r.verdict,
  ]);

  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(row => row[i].length)),
  );

  const fmtRow = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();

  const sep = widths.map(w => "-".repeat(w)).join("  ");

  const lines = [fmtRow(headers), sep, ...rows.map(fmtRow)];

  // Notes after the table — one line per tool that has one. Keeps the
  // grid clean while still surfacing context like "no upstream check".
  for (const r of reports) {
    if (r.note) {
      lines.push(`  - ${r.tool}: ${r.note}`);
    }
  }

  return lines.join("\n");
}

/**
 * Shape a single tool's outputs into a ToolReport. Centralised so the
 * driver script doesn't repeat the merge logic per tool.
 */
export function buildReport(args: {
  tool: string;
  installed: string | null;
  latest: string | null;
  verdicts: ReadonlyArray<Verdict>;
  note?: string;
}): ToolReport {
  const merged = mergeVerdicts(args.verdicts);
  return {
    tool: args.tool,
    installed: args.installed ?? "?",
    latest: args.latest ?? "?",
    verdict: merged.verdict,
    severity: merged.severity,
    note: args.note,
  };
}

/**
 * Build the human-readable alert message body when a tool is `outdated`.
 * The format is intentionally short — operators see this in
 * `hydra alerts ls` output truncated to ~90 chars.
 */
export function buildAlertMessage(report: ToolReport): string {
  return `Tool ${report.tool} is ${report.verdict} (installed ${report.installed}, latest ${report.latest})`;
}
