/**
 * scripts/ci/hydra-cleanup-render.ts — Pure helpers for the hydra-cleanup skill
 * (issue #1167).
 *
 * Background: `hydra-cleanup` (docs/operator-playbooks/hydra-cleanup.md) is a
 * non-interactive dead-code detector. It runs `knip --reporter json`, filters
 * the findings, and files one GitHub issue per surviving finding on
 * `gaberoo322/hydra`. The detection is deterministic (it is whatever knip
 * reports), and so is the rendering — but until #1167 the *parse → render →
 * dedup* path lived only as prose inside the playbook, executed by the LLM.
 *
 * That prose path double-filed on autopilot run ef0a9847 (issue #1167): a
 * draft set with malformed/blank titles (`cleanup: remove unused export
 *  (src/scheduler/heartbeat.ts)` — note the double-space where the symbol
 * name belongs, and `cleanup: remove unused file ` with a trailing space and
 * no path) was emitted alongside the canonical, correctly-titled set. Two
 * root causes compounded:
 *
 *   1. A finding whose symbol name (export) or path (file) failed to parse
 *      still got rendered, producing a malformed/blank title.
 *   2. The dedup key was the *title*. Because the draft titles were
 *      malformed, they did not match the canonical titles, so the dedup pass
 *      did not recognise the drafts as duplicates of their own canonical
 *      siblings.
 *
 * This module re-homes the deterministic part of that path as pure, unit-
 * testable functions (mirroring scripts/ci/hydra-prd-render.ts):
 *
 *   - parseKnipReport()  — knip JSON → normalised CleanupFinding[], extracting
 *                          the symbol name (exports/types) or path (files)
 *                          from the SAME object the title is later derived from.
 *   - validateFinding()  — REJECTS any finding with an empty name/path BEFORE
 *                          it can become an issue. This is the root-cause guard
 *                          for the blank-title drafts (#1167 cause 1).
 *   - findingIdentity()  — a STABLE `path::symbol` identity key, NOT the title.
 *                          Dedup keys on this so a malformed-title finding can
 *                          still be recognised as a duplicate (#1167 cause 2).
 *   - renderTitle()/renderBody() — title, body H1, and `## Files in scope`
 *                          path all derived from the one CleanupFinding, so
 *                          they cannot drift (the #1005 off-by-one guard).
 *   - dedupAgainstOpen() — drop findings whose identity already has an open
 *                          cleanup-scan issue.
 *
 * This module is pure — no fs / network / process — so it can be unit tested
 * directly. See test/hydra-cleanup-render.test.mts.
 */

/** The two deterministic finding kinds hydra-cleanup files issues for. */
export type CleanupFindingKind = "file" | "export";

/**
 * One normalised, ready-to-render dead-code finding.
 *
 * - `kind: "file"`  → a provably-unused whole file. `path` is the file; `name`
 *   is the empty string (a whole-file deletion has no symbol).
 * - `kind: "export"` → a provably-unused named export (or exported type) inside
 *   a still-used file. `path` is the file, `name` is the symbol.
 */
export interface CleanupFinding {
  kind: CleanupFindingKind;
  /** Repo-relative file path. Always non-empty for a valid finding. */
  path: string;
  /**
   * The unused symbol name for `kind: "export"`. Empty string for
   * `kind: "file"` (a whole-file deletion names no symbol).
   */
  name: string;
}

/**
 * The subset of knip's `--reporter json` shape this skill consumes. knip emits
 * a top-level `files` array (unused whole files, as path strings) plus an
 * `issues` array of per-file objects whose `exports` / `types` arrays hold the
 * unused-symbol objects (`{ name, line, col, pos }`). We deliberately ignore
 * knip's softer categories (dependencies, unlisted, unresolved, duplicates).
 */
export interface KnipReport {
  /** Unused whole files, as repo-relative path strings. */
  files?: unknown;
  /** Per-file finding objects. */
  issues?: unknown;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Extract the symbol name from one knip export/type entry. knip emits these as
 * objects `{ name, line, col, pos }`, but older/edge shapes have emitted bare
 * strings — handle both, and return "" for anything else so validateFinding
 * can reject it rather than rendering a blank title.
 */
function exportName(entry: unknown): string {
  if (typeof entry === "string") return entry.trim();
  if (entry && typeof entry === "object" && "name" in entry) {
    return asString((entry as { name: unknown }).name);
  }
  return "";
}

/**
 * Parse a knip JSON report into normalised findings. Whole-file findings come
 * from the top-level `files` array; export/type findings come from each
 * `issues[].exports` and `issues[].types` array, paired with that issue's
 * `file`.
 *
 * Crucially, the symbol `name` (for exports) and the `path` (for files) are
 * read HERE, from the same object — so a finding that fails to yield a name or
 * path arrives at validateFinding() with an empty field and is dropped, rather
 * than silently rendering a blank-title issue (#1167 cause 1).
 *
 * Note: this parser does NOT apply the confidence filter (verifier-core /
 * test-only / entrypoint exclusions) — that stays in the playbook prose, which
 * has the path context. It only normalises the raw report into well-formed,
 * non-empty findings.
 */
export function parseKnipReport(report: KnipReport): CleanupFinding[] {
  const out: CleanupFinding[] = [];

  // Top-level unused whole files.
  if (Array.isArray(report.files)) {
    for (const f of report.files) {
      const path = asString(f);
      out.push({ kind: "file", path, name: "" });
    }
  }

  // Per-file unused exports / exported types.
  if (Array.isArray(report.issues)) {
    for (const issue of report.issues) {
      if (!issue || typeof issue !== "object") continue;
      const file = asString((issue as { file?: unknown }).file);
      const exportsArr = (issue as { exports?: unknown }).exports;
      const typesArr = (issue as { types?: unknown }).types;
      for (const arr of [exportsArr, typesArr]) {
        if (!Array.isArray(arr)) continue;
        for (const entry of arr) {
          out.push({ kind: "export", path: file, name: exportName(entry) });
        }
      }
    }
  }

  return out;
}

/**
 * Validate one finding. Returns null when the finding is well-formed; returns
 * a one-line reason string when it must be DROPPED.
 *
 * This is the root-cause guard for #1167 cause 1: a finding whose path is empty
 * (`remove unused file ` with a trailing space) or whose export name is empty
 * (`remove unused export  (...)` with a double-space) is rejected here, BEFORE
 * renderTitle / gh issue create — so no malformed/blank-title draft can ever be
 * emitted. The caller (skill prose or a future runner) must skip any finding
 * for which this returns non-null.
 */
export function validateFinding(finding: CleanupFinding): string | null {
  if (finding.kind !== "file" && finding.kind !== "export") {
    return `unknown finding kind "${String(finding.kind)}"`;
  }
  if (!finding.path || !finding.path.trim()) {
    return "finding has an empty path — would render a blank-title issue (#1167)";
  }
  if (finding.kind === "export" && (!finding.name || !finding.name.trim())) {
    return `export finding in ${finding.path} has an empty symbol name — would render a double-space title (#1167)`;
  }
  return null;
}

/**
 * A STABLE identity key for a finding — `path::symbol` for an export,
 * `path::<file>` for a whole-file finding. Dedup keys on THIS, never on the
 * rendered title (#1167 cause 2): a malformed-title draft still produces the
 * same identity as its canonical sibling, so it is recognised as a duplicate.
 *
 * The key is normalised (trimmed) so trailing-space artifacts in a raw finding
 * collapse onto the canonical identity instead of forking a near-duplicate.
 */
export function findingIdentity(finding: CleanupFinding): string {
  const path = finding.path.trim();
  if (finding.kind === "file") return `${path}::<file>`;
  return `${path}::${finding.name.trim()}`;
}

/**
 * Render the GitHub issue title for a finding. Title, body H1, and the
 * `## Files in scope` path are all derived from the one finding (see
 * renderBody), so they cannot drift.
 *
 * Throws if the finding is invalid — callers MUST run validateFinding() first
 * and skip on a non-null result. The throw is a defensive backstop so a
 * malformed finding that slipped past the validate gate fails loud (a thrown
 * render is visible in the run) rather than quietly emitting a blank title.
 */
export function renderTitle(finding: CleanupFinding): string {
  const reason = validateFinding(finding);
  if (reason) {
    throw new Error(`renderTitle: refusing to render an invalid finding — ${reason}`);
  }
  if (finding.kind === "file") {
    return `cleanup: remove unused file \`${finding.path}\``;
  }
  return `cleanup: remove unused export \`${finding.name}\` (${finding.path})`;
}

/**
 * Render the GitHub issue body for a finding. Mirrors the schema in the
 * hydra-cleanup playbook (Step 3). The body H1 and the `## Files in scope`
 * path are derived from the SAME finding the title is — no parallel arrays,
 * no index-aligned zip (the #1005 drift guard).
 *
 * `isoDate` is the scan date (e.g. new Date().toISOString().slice(0, 10)),
 * injected so this function stays pure/deterministic for tests.
 */
export function renderBody(finding: CleanupFinding, isoDate: string): string {
  const reason = validateFinding(finding);
  if (reason) {
    throw new Error(`renderBody: refusing to render an invalid finding — ${reason}`);
  }

  const isFile = finding.kind === "file";
  const h1Subject = isFile
    ? `file \`${finding.path}\``
    : `export \`${finding.name}\` (${finding.path})`;
  const findingSubject = isFile
    ? `\`${finding.path}\``
    : `the named export \`${finding.name}\` in \`${finding.path}\``;
  const removeSubject = isFile ? "file" : "export";
  const acceptanceSubject = isFile
    ? `\`${finding.path}\``
    : `the named export \`${finding.name}\` (in \`${finding.path}\`)`;

  const lines: string[] = [];
  lines.push(`# cleanup: remove unused ${h1Subject}`);
  lines.push("");
  lines.push(`> Surfaced by \`/hydra-cleanup\` on ${isoDate} against the Orchestrator (~/hydra).`);
  lines.push("> Deterministic detection via `knip` (devDependency). High-confidence mechanical cleanup.");
  lines.push("");
  lines.push("## Finding");
  lines.push("");
  lines.push(`\`knip\` reports ${findingSubject} as **provably unused** — it has no remaining references in the orchestrator codebase.`);
  lines.push("");
  lines.push("## What to do");
  lines.push("");
  lines.push(`Remove the unused ${removeSubject} and any now-orphaned imports it leaves behind.`);
  lines.push("");
  lines.push("## Files in scope");
  lines.push("");
  lines.push(`- \`${finding.path}\``);
  lines.push("");
  lines.push("## Acceptance criteria");
  lines.push("");
  lines.push(`- [ ] ${acceptanceSubject} is removed, along with any imports/re-exports that only existed to reference it.`);
  lines.push("- [ ] `npm test` still passes (the deletion breaks no test).");
  lines.push("- [ ] `tsc` (`npm run typecheck` and `npm run typecheck:test`) still passes (the deletion breaks no type).");
  lines.push("- [ ] No new `knip` finding is introduced by the change.");
  lines.push("");
  lines.push("## Why this is safe (deterministic check)");
  lines.push("");
  lines.push("This is a mechanically-verifiable cleanup: the deletion is correct **iff** the test suite and the type-checker still pass afterward. If either fails, the export/file was not actually dead and the PR should be abandoned, not forced.");
  lines.push("");
  lines.push("---");
  lines.push("*Generated by hydra-cleanup (issue #960, epic #958). Routes to `ready-for-agent` because the acceptance check is deterministic.*");

  return lines.join("\n").trimEnd() + "\n";
}

/**
 * Recover a finding identity from an *already-open* cleanup-scan issue title.
 * The skill reads open cleanup-scan issue titles from the board; this parses a
 * canonical title back into the `path::symbol` / `path::<file>` identity so
 * dedupAgainstOpen() can match new findings against them WITHOUT relying on a
 * byte-for-byte title comparison (which is what failed in #1167).
 *
 * Returns null for a title that does not parse — including the malformed
 * blank-title drafts, which intentionally do not match any well-formed
 * finding's identity (a blank-title draft should be closed as junk, not
 * treated as the canonical record of a finding).
 */
export function identityFromOpenIssueTitle(title: string): string | null {
  const t = title.trim();
  // Export: cleanup: remove unused export `<name>` (<path>)
  const exp = t.match(/^cleanup: remove unused export\s+`([^`]+)`\s+\(([^)]+)\)$/);
  if (exp) {
    const name = exp[1].trim();
    const path = exp[2].trim();
    if (name && path) return `${path}::${name}`;
    return null;
  }
  // File: cleanup: remove unused file `<path>`
  const file = t.match(/^cleanup: remove unused file\s+`([^`]+)`$/);
  if (file) {
    const path = file[1].trim();
    if (path) return `${path}::<file>`;
    return null;
  }
  return null;
}

/**
 * Drop findings whose identity already has an open cleanup-scan issue.
 *
 * `openIssueTitles` is the list of open cleanup-scan issue titles read from the
 * board (Step 0). They are normalised to identities via
 * identityFromOpenIssueTitle, so dedup is keyed on the stable `path::symbol`
 * identity — NOT on title equality (#1167 cause 2).
 *
 * Returns `{ kept, dropped }` so the caller can both emit the survivors and
 * report the de-duplicated count.
 */
export function dedupAgainstOpen(
  findings: CleanupFinding[],
  openIssueTitles: string[],
): { kept: CleanupFinding[]; dropped: CleanupFinding[] } {
  const openIdentities = new Set<string>();
  for (const title of openIssueTitles) {
    const id = identityFromOpenIssueTitle(title);
    if (id) openIdentities.add(id);
  }

  const kept: CleanupFinding[] = [];
  const dropped: CleanupFinding[] = [];
  // Also dedup within THIS batch: a finding identity already emitted in this
  // pass is dropped, so a single run cannot file two issues for one identity
  // (the in-batch half of the #1167 double-file).
  const seenThisBatch = new Set<string>();

  for (const finding of findings) {
    const id = findingIdentity(finding);
    if (openIdentities.has(id) || seenThisBatch.has(id)) {
      dropped.push(finding);
      continue;
    }
    seenThisBatch.add(id);
    kept.push(finding);
  }
  return { kept, dropped };
}
