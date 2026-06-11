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
 * The recommended safe fix for an export finding, classified deterministically
 * from the defining file's source (issue #1449).
 *
 * knip flags a symbol as an "unused export" whenever nothing OUTSIDE the file
 * imports it — but the symbol may still be referenced WITHIN its own file (a
 * sibling schema, a `z.infer<typeof X>` type alias, an in-file caller). Deleting
 * such a symbol breaks compilation; the only dead aspect is its `export`
 * visibility, so the correct fix is to DROP the `export` keyword, not delete it.
 *
 * - `delete` — no in-file reference beyond the definition site: the symbol is
 *   truly dead and can be removed.
 * - `demote` — the symbol IS referenced within its own file: drop only the
 *   `export` keyword (make it module-private), NEVER delete (the #1449
 *   recurrence `knip-unused-export-demote-not-delete` /
 *   `knip-unused-export-is-internally-referenced-not-dead`).
 * - `unknown` — the file source was unavailable, so the classification could
 *   not be made deterministically; the issue body falls back to the full probe.
 *
 * Whole-file findings never carry a fix class (deleting a whole unused file has
 * no demote alternative).
 */
export type ExportFixClass = "delete" | "demote" | "unknown";

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
  /**
   * Deterministic safe-fix classification for an export finding (issue #1449),
   * set by classifyExportFix() when the defining file's source is available.
   * Absent → the renderer emits the full classification probe (the pre-#1449
   * behaviour) instead of leading with a pre-computed recommendation. Always
   * absent for `kind: "file"`.
   */
  fix?: ExportFixClass;
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
 * Deterministically classify the safe fix for an EXPORT finding from the
 * defining file's source text (issue #1449).
 *
 * knip's "unused export" only means "no importer OUTSIDE this file". The
 * recurring `cleanup_orch` defect (`knip-unused-export-demote-not-delete`,
 * cross-run recurrence 6+) is a naive DELETE on a symbol that is still
 * referenced WITHIN its own file — a sibling `z.infer<typeof X>` type alias, a
 * schema composed into another schema in the same file, an in-file caller.
 * Deleting it breaks `tsc`. The correct fix is to drop only the `export`
 * keyword (demote to module-private).
 *
 * This is the deterministic version of probe #1 from the issue body, scoped to
 * the symbol's OWN file: count word-boundary references to `name` in
 * `fileSource` that are NOT the export/declaration site. If any remain → the
 * symbol is internally referenced → `demote`. If none remain → `delete`.
 *
 * Detecting references in the symbol's own file is the deterministic, low-false-
 * positive half of the taxonomy — it never needs to grep the whole repo (knip
 * already proved there are no external importers). Cross-file re-export (case c)
 * and coupled-Redis-key (case d) disambiguation stay in the issue-body probe,
 * which the picking hydra-dev agent runs; this classifier resolves the most
 * common false positive (case b, internally referenced) up front so the emitted
 * issue says "demote" instead of inviting a build-breaking delete.
 *
 * Returns:
 * - `"demote"` when at least one in-file reference survives stripping the
 *   declaration site(s).
 * - `"delete"` when no in-file reference survives.
 * - `"unknown"` for a non-export finding, an empty symbol name, or empty
 *   `fileSource` (source unavailable) — the renderer then falls back to the
 *   full probe rather than asserting a fix it could not verify.
 *
 * Pure: takes the file text as an argument, performs no fs/IO, so it unit-tests
 * directly. The caller (the emit runner) is responsible for reading the file.
 */
export function classifyExportFix(
  finding: CleanupFinding,
  fileSource: string,
): ExportFixClass {
  if (finding.kind !== "export") return "unknown";
  const name = finding.name.trim();
  if (!name) return "unknown";
  if (typeof fileSource !== "string" || fileSource.length === 0) return "unknown";

  // Escape the symbol for a literal word-boundary regex.
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const wordRef = new RegExp(`\\b${esc}\\b`);

  // Walk the file line by line. A line is the symbol's own DECLARATION site
  // (and so does not count as an internal reference) when it both mentions the
  // symbol AND carries a declaration keyword for it. Every OTHER line that
  // mentions the symbol by word boundary is an internal reference → demote.
  //
  // We deliberately treat a `z.infer<typeof Name>` type-alias line, a
  // `field: Name` schema-composition line, and an in-file call site all as
  // internal references — those are exactly the demote cases the recurrence
  // is about.
  const declAtThisLine = new RegExp(
    // export? (const|let|var|function|class|type|interface|enum) ... Name
    `\\b(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:const|let|var|function|class|type|interface|enum)\\s+${esc}\\b`,
  );

  let internalRefs = 0;
  for (const rawLine of fileSource.split("\n")) {
    if (!wordRef.test(rawLine)) continue;
    if (declAtThisLine.test(rawLine)) continue; // the declaration itself, not a use
    internalRefs++;
    if (internalRefs > 0) break; // one is enough to demote
  }

  return internalRefs > 0 ? "demote" : "delete";
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
 * The `## What to do` section embeds the knip false-positive classification
 * taxonomy (issue #1299): the classification probe plus the four sub-cases
 * (a delete / b demote-export / c drop-re-export / d coupled Redis-key-set),
 * pointing at Step 2.5 of the playbook for the full table. The picking
 * hydra-dev agent reads THIS rendered body, not the playbook prose, so the
 * taxonomy MUST live here for the doc and the emitted issue to agree — a body
 * that only said "remove the unused export" left the recurrence (naive delete
 * on a false-positive "unused export") unbroken.
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
  const acceptanceSubject = isFile
    ? `\`${finding.path}\``
    : `the named export \`${finding.name}\` (in \`${finding.path}\`)`;
  // For the classification probe, substitute the finding's actual symbol/path.
  // A whole-file finding has no symbol, so probe on its path — the grep still
  // surfaces remaining references to the file (e.g. residual imports).
  const probeName = isFile ? finding.path : finding.name;

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
  // ## Recommended fix — a deterministic, pre-computed demote-vs-delete verdict
  // when the emit runner classified the finding from its own file's source
  // (issue #1449). knip's "unused export" only means "no EXTERNAL importer"; a
  // symbol still referenced WITHIN its own file (a sibling `z.infer<typeof X>`
  // alias, a schema composed into another schema, an in-file caller) must be
  // DEMOTED (drop the `export` keyword), never deleted — deleting it breaks
  // `tsc`. Leading with this verdict is what stops the recurring
  // `knip-unused-export-demote-not-delete` defect: the picking agent reads the
  // classification BEFORE the generic probe, so the default action is correct.
  if (!isFile && finding.fix === "demote") {
    lines.push("## Recommended fix: **demote** (drop the `export` keyword) — NOT delete");
    lines.push("");
    lines.push(
      `The emit scan found that \`${finding.name}\` is still **referenced within its own file** (\`${finding.path}\`) — e.g. a sibling schema composes it, a \`z.infer<typeof ${finding.name}>\` type alias derives from it, or an in-file caller uses it. knip flagged it only because nothing OUTSIDE the file imports it. **Deleting it would break \`tsc\`.** The correct, deterministic fix is to **drop only the \`export\` keyword** so the symbol stays module-private. Do NOT delete the definition. Confirm with the probe below, then demote.`,
    );
    lines.push("");
  } else if (!isFile && finding.fix === "delete") {
    lines.push("## Recommended fix: **delete** (no in-file references found)");
    lines.push("");
    lines.push(
      `The emit scan found no reference to \`${finding.name}\` within \`${finding.path}\` beyond its declaration site, so a delete is safe. **Still run the probe below before deleting** — a cross-file re-export (case c) or a coupled Redis key generator (case d) can make even an in-file-dead symbol a false positive. If \`npm test\` / \`tsc\` go red after the delete, revert to the demote / drop-re-export fix.`,
    );
    lines.push("");
  }
  // ## What to do — MUST mirror the Step 3 template in
  // docs/operator-playbooks/hydra-cleanup.md. The picking hydra-dev agent reads
  // THIS emitted body, NOT the playbook, so the knip false-positive taxonomy
  // (issue #1299) has to live in the rendered body — otherwise the doc and the
  // code contradict and emitted issues still lack the classification guidance
  // (the recurrence: a naive delete on a false-positive "unused export" breaks
  // the build / orphans coupled Redis-key sets).
  lines.push("## What to do");
  lines.push("");
  lines.push(
    '**`knip` reports an "unused export" without telling you *why* it is dead — classify before you delete.** A naive delete is correct only when the symbol is *truly* dead; if its only dead aspect is `export` visibility, a still-live re-export, or a coupled Redis key generator, a delete breaks the build or orphans coupled code. Run this classification probe first (for the flagged `<name>` in `<path>`):',
  );
  lines.push("");
  lines.push("```bash");
  lines.push("# 1. Still referenced ANYWHERE (src + test), ignoring its own definition site?");
  lines.push(`rg -n --no-heading -w "${probeName}" src test | grep -v "${finding.path}"`);
  lines.push("# 2. Is the flagged line a re-export (`export { x } from './y'` / `export *`) rather than the definition?");
  lines.push(`rg -n "export .*\\b${probeName}\\b" "${finding.path}"`);
  lines.push("# 3. Redis key generator? Are sibling generators referenced only by the same test assertions?");
  lines.push(`rg -n "${probeName}" src/redis test/redis-keys.test.mts`);
  lines.push("```");
  lines.push("");
  lines.push(
    "Then apply the matching fix — **delete is the exception, not the default** (full table with evidence anchors lives in Step 2.5 of the hydra-cleanup playbook, `docs/operator-playbooks/hydra-cleanup.md`):",
  );
  lines.push("");
  lines.push(
    "- **(a) Truly dead** — probe 1 empty, not a re-export, no coupled keys → **delete** the symbol/file and any imports/re-exports that only existed to reference it.",
  );
  lines.push(
    "- **(b) Internally referenced** — probe 1 shows in-file callers, probe 2 shows it's the definition → **drop only the `export` keyword**, keep the definition module-private. Do NOT delete (the build breaks).",
  );
  lines.push(
    "- **(c) Re-export, definition live elsewhere** — probe 2 shows a `from` clause, probe 1 finds live uses of the definition → **remove only the re-export line**, leave the definition and its consumers.",
  );
  lines.push(
    "- **(d) Coupled Redis key generator** — probe 3 shows sibling generators coupled to assertions in `test/redis-keys.test.mts` → **remove the full coupled set atomically** (generator(s) + their test assertions) under a `scope-justification:` block naming the test file.",
  );
  lines.push("");
  lines.push(
    "If `npm test` / `tsc` go red after a delete, that is knip's false positive surfacing — revert to the demote / drop-re-export fix; never force the deletion.",
  );
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
 * An open cleanup-scan board entry, as read from `gh issue list --json
 * title,body`. The `body` is optional so legacy callers (and tests) that only
 * have titles keep working — a bare string is accepted as a title-only ref.
 */
export interface OpenIssueRef {
  title: string;
  body?: string;
}

/**
 * Recover the finding identities recorded in a BATCH issue's body manifest
 * (issue #1653). A batch issue covers N findings, so its title cannot carry N
 * identities the way a legacy single-finding title does — instead the batch
 * body embeds a machine-readable HTML-comment manifest:
 *
 *   <!-- cleanup-identities:
 *   src/schemas/explore-page.ts::AnomalyMetricSchema
 *   src/schemas/dead.ts::<file>
 *   -->
 *
 * Each non-empty line is one `findingIdentity()` key (`path::symbol` /
 * `path::<file>`). Lines without the `::` separator are ignored (junk-tolerant:
 * a hand-edited manifest line can degrade to a missed dedup, never a crash).
 * Returns [] for a body with no manifest — including every legacy single-
 * finding body, whose identity is recovered from the title instead.
 */
export function identitiesFromIssueBody(body: string): string[] {
  if (typeof body !== "string" || body.length === 0) return [];
  const m = body.match(/<!--\s*cleanup-identities:\s*\n([\s\S]*?)-->/);
  if (!m) return [];
  return m[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("::"));
}

/**
 * Drop findings whose identity already has an open cleanup-scan issue.
 *
 * `openIssues` is the open cleanup-scan board read in Step 0 — either bare
 * title strings (legacy callers) or `{ title, body }` refs. Identities are
 * recovered from BOTH surfaces (issue #1653):
 *
 *   - the title, via identityFromOpenIssueTitle() — legacy single-finding
 *     issues carry their one identity in the canonical title;
 *   - the body's `cleanup-identities` manifest, via identitiesFromIssueBody()
 *     — batch issues carry N identities in the HTML-comment manifest.
 *
 * Either way dedup is keyed on the stable `path::symbol` identity — NOT on
 * title equality (#1167 cause 2). A closed batch issue releases ALL its
 * identities at once; the next scan re-files only the findings knip still
 * reports (partial-completion handling, #1653).
 *
 * Returns `{ kept, dropped }` so the caller can both emit the survivors and
 * report the de-duplicated count.
 */
export function dedupAgainstOpen(
  findings: CleanupFinding[],
  openIssues: Array<string | OpenIssueRef>,
): { kept: CleanupFinding[]; dropped: CleanupFinding[] } {
  const openIdentities = new Set<string>();
  for (const ref of openIssues) {
    const title = typeof ref === "string" ? ref : ref.title;
    const id = identityFromOpenIssueTitle(title);
    if (id) openIdentities.add(id);
    if (typeof ref !== "string" && ref.body) {
      for (const bodyId of identitiesFromIssueBody(ref.body)) {
        openIdentities.add(bodyId);
      }
    }
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

// ---------------------------------------------------------------------------
// Batch rendering (issue #1653) — one issue per module dir, not per symbol.
// ---------------------------------------------------------------------------

/**
 * The batch key for a finding: its containing module directory, truncated to
 * the top-2 path segments (issue #1653). Examples:
 *
 *   src/schemas/explore-page.ts          → src/schemas
 *   src/outcomes.ts                      → src
 *   src/redis/sub/deep.ts                → src/redis
 *   dashboard/src/components/Card.jsx    → dashboard/src
 *   standalone.ts                        → (root)
 *
 * Grouping on the module dir (not per-file) is the judgement call from the
 * accepted proposal: per-file batching leaves a long tail of 1–2-finding
 * issues, while per-module compresses the same backlog ~88% and the merged
 * multi-file precedent (PR #1597) shows the gate is batch-indifferent.
 */
export function moduleDirKey(path: string): string {
  const parts = path.trim().split("/").filter(Boolean);
  parts.pop(); // drop the filename — the key is the containing directory
  if (parts.length === 0) return "(root)";
  return parts.slice(0, 2).join("/");
}

/** Pluralisation helper for batch titles ("1 unused export" / "3 unused exports"). */
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Render the title for a BATCH issue covering every finding in one module-dir
 * group (issue #1653). Like renderTitle(), it throws on any invalid finding —
 * callers MUST validate first; the throw is the same loud backstop.
 *
 * The title deliberately does NOT match the legacy single-finding patterns
 * `identityFromOpenIssueTitle()` parses — a batch's identities live in the
 * body manifest (see renderBatchBody), never the title.
 *
 * When a module dir splits into multiple chunks (artifact Invariant 6,
 * forward-fix #1653), pass `chunk` so the title carries an ` [i/k]` suffix —
 * equal-sized single-file chunks would otherwise render identical titles.
 * Omitted (or `total: 1`) → no suffix, the unsplit-batch format is unchanged.
 */
export interface BatchChunkRef {
  /** 1-based chunk index within the split module dir. */
  index: number;
  /** Total chunks the module dir split into. */
  total: number;
}

export function renderBatchTitle(
  moduleDir: string,
  findings: CleanupFinding[],
  chunk?: BatchChunkRef,
): string {
  if (findings.length === 0) {
    throw new Error("renderBatchTitle: refusing to render an empty batch");
  }
  if (chunk && (!Number.isInteger(chunk.index) || !Number.isInteger(chunk.total) || chunk.index < 1 || chunk.total < 1 || chunk.index > chunk.total)) {
    throw new Error(
      `renderBatchTitle: invalid chunk ref ${chunk.index}/${chunk.total} — index must be 1-based and ≤ total`,
    );
  }
  for (const finding of findings) {
    const reason = validateFinding(finding);
    if (reason) {
      throw new Error(`renderBatchTitle: refusing to render an invalid finding — ${reason}`);
    }
  }
  const fileCount = findings.filter((f) => f.kind === "file").length;
  const exportCount = findings.length - fileCount;
  const distinctPaths = new Set(findings.map((f) => f.path.trim())).size;
  // Invariant 6 (#1653 forward-fix): a split module's chunks each carry an
  // ` [i/k]` suffix so sibling chunks are independently identifiable.
  const suffix = chunk && chunk.total > 1 ? ` [${chunk.index}/${chunk.total}]` : "";

  if (exportCount === 0) {
    return `cleanup(${moduleDir}): remove ${plural(fileCount, "unused file")}${suffix}`;
  }
  const exportsPart = `demote/remove ${plural(exportCount, "unused export")} (${plural(distinctPaths, "file")})`;
  if (fileCount === 0) {
    return `cleanup(${moduleDir}): ${exportsPart}${suffix}`;
  }
  return `cleanup(${moduleDir}): remove ${plural(fileCount, "unused file")} + ${exportsPart}${suffix}`;
}

/** One checklist line for a finding inside a batch body, leading with its verdict. */
function checklistLine(finding: CleanupFinding): string {
  if (finding.kind === "file") {
    return `- [ ] \`${finding.path}\` — fix: **delete the whole file** (knip reports it provably unused)`;
  }
  const subject = `\`${finding.name}\` (\`${finding.path}\`)`;
  switch (finding.fix) {
    case "demote":
      return `- [ ] ${subject} — fix: **demote** (drop only the \`export\` keyword — still referenced within its own file; deleting breaks \`tsc\`)`;
    case "delete":
      return `- [ ] ${subject} — fix: **delete** (no in-file reference found — still run the probe below before deleting)`;
    default:
      return `- [ ] ${subject} — fix: unknown (source unavailable at scan time — classify via the probe below)`;
  }
}

/**
 * Render the body for a BATCH issue (issue #1653). Structure:
 *
 *   - H1 derived from renderBatchTitle() on the SAME findings (coherence by
 *     construction — the #1005/#1449 drift guard extends to batches).
 *   - `## Findings (per-symbol checklist)` — one checkbox per finding, leading
 *     with its pre-computed demote/delete verdict from classifyExportFix().
 *   - `## What to do` — the knip false-positive taxonomy + probe ONCE for the
 *     whole batch (generic `<name>` / `<path>` placeholders).
 *   - `## Files in scope` — every distinct path, one code-span bullet each
 *     (the section scope-check matches; code-spans ONLY in the bullets).
 *   - `## Acceptance criteria` — the deterministic "resolve every checklist
 *     item AND test/tsc green" check.
 *   - the `cleanup-identities` HTML-comment manifest — one findingIdentity()
 *     per line, the machine-readable dedup surface identitiesFromIssueBody()
 *     parses back.
 *
 * Throws on an empty batch or any invalid finding (same backstop as
 * renderTitle/renderBody — validateFinding gates earlier in the pipeline).
 */
export function renderBatchBody(
  moduleDir: string,
  findings: CleanupFinding[],
  isoDate: string,
  chunk?: BatchChunkRef,
): string {
  // renderBatchTitle performs the empty/invalid validation backstop. The
  // chunk ref is forwarded so the H1 carries the same [i/k] suffix as the
  // issue title (coherence by construction — the #1005/#1449 drift guard).
  const title = renderBatchTitle(moduleDir, findings, chunk);
  const distinctPaths = [...new Set(findings.map((f) => f.path.trim()))];

  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(`> Surfaced by \`/hydra-cleanup\` on ${isoDate} against the Orchestrator (~/hydra).`);
  lines.push("> Deterministic detection via `knip` (devDependency). High-confidence mechanical cleanup,");
  lines.push(`> batched per module dir (issue #1653) — one PR resolves every finding below in \`${moduleDir}\`.`);
  lines.push("");
  lines.push("## Findings (per-symbol checklist)");
  lines.push("");
  lines.push("`knip` reports each entry below as **provably unused** — no remaining external references in the orchestrator codebase. Resolve every checkbox per its verdict; if a probe proves one a false positive, skip it and note the evidence in the PR body (the next scan re-files only true survivors).");
  lines.push("");
  for (const finding of findings) {
    lines.push(checklistLine(finding));
  }
  lines.push("");
  lines.push("## What to do");
  lines.push("");
  lines.push(
    '**`knip` reports an "unused export" without telling you *why* it is dead — classify before you delete.** A naive delete is correct only when the symbol is *truly* dead; if its only dead aspect is `export` visibility, a still-live re-export, or a coupled Redis key generator, a delete breaks the build or orphans coupled code. For each checklist symbol `<name>` in `<path>` whose verdict you need to confirm, run this classification probe first:',
  );
  lines.push("");
  lines.push("```bash");
  lines.push("# 1. Still referenced ANYWHERE (src + test), ignoring its own definition site?");
  lines.push('rg -n --no-heading -w "<name>" src test | grep -v "<path>"');
  lines.push("# 2. Is the flagged line a re-export (`export { x } from './y'` / `export *`) rather than the definition?");
  lines.push('rg -n "export .*\\b<name>\\b" "<path>"');
  lines.push("# 3. Redis key generator? Are sibling generators referenced only by the same test assertions?");
  lines.push('rg -n "<name>" src/redis test/redis-keys.test.mts');
  lines.push("```");
  lines.push("");
  lines.push(
    "Then apply the matching fix — **delete is the exception, not the default** (full table with evidence anchors lives in Step 2.5 of the hydra-cleanup playbook, `docs/operator-playbooks/hydra-cleanup.md`):",
  );
  lines.push("");
  lines.push(
    "- **(a) Truly dead** — probe 1 empty, not a re-export, no coupled keys → **delete** the symbol/file and any imports/re-exports that only existed to reference it.",
  );
  lines.push(
    "- **(b) Internally referenced** — probe 1 shows in-file callers, probe 2 shows it's the definition → **drop only the `export` keyword**, keep the definition module-private. Do NOT delete (the build breaks).",
  );
  lines.push(
    "- **(c) Re-export, definition live elsewhere** — probe 2 shows a `from` clause, probe 1 finds live uses of the definition → **remove only the re-export line**, leave the definition and its consumers.",
  );
  lines.push(
    "- **(d) Coupled Redis key generator** — probe 3 shows sibling generators coupled to assertions in `test/redis-keys.test.mts` → **remove the full coupled set atomically** (generator(s) + their test assertions) under a `scope-justification:` block naming the test file.",
  );
  lines.push("");
  lines.push(
    "If `npm test` / `tsc` go red after a delete, that is knip's false positive surfacing — revert to the demote / drop-re-export fix; never force the deletion.",
  );
  lines.push("");
  lines.push("## Files in scope");
  lines.push("");
  for (const path of distinctPaths) {
    lines.push(`- \`${path}\``);
  }
  lines.push("");
  lines.push("## Acceptance criteria");
  lines.push("");
  lines.push(
    "- [ ] Every checklist item above is resolved per its verdict (demote / delete / drop-re-export / atomic coupled-set removal), or recorded in the PR body as a knip false positive with probe evidence.",
  );
  lines.push("- [ ] `npm test` still passes (the change breaks no test).");
  lines.push("- [ ] `tsc` (`npm run typecheck` and `npm run typecheck:test`) still passes (the change breaks no type).");
  lines.push("- [ ] No new `knip` finding is introduced by the change.");
  lines.push("");
  lines.push("## Why this is safe (deterministic check)");
  lines.push("");
  lines.push(
    "This is a mechanically-verifiable cleanup: each removal is correct **iff** the test suite and the type-checker still pass afterward. If either fails, that export/file was not actually dead — skip it (note the false positive in the PR body) rather than forcing it. Partial completion is fine: closing this issue releases every identity below, and the next scan re-files only the findings knip still reports.",
  );
  lines.push("");
  lines.push("<!-- cleanup-identities:");
  for (const finding of findings) {
    lines.push(findingIdentity(finding));
  }
  lines.push("-->");
  lines.push("");
  lines.push("---");
  lines.push("*Generated by hydra-cleanup (issue #960, epic #958; batched per #1653). Routes to `ready-for-agent` because the acceptance check is deterministic.*");

  return lines.join("\n").trimEnd() + "\n";
}
