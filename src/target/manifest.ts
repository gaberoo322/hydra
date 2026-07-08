/**
 * Target Manifest loader (epic #3014, ADR-0026).
 *
 * A leaf `loadManifest(rootDir)` that reads `<rootDir>/.hydra/manifest.json`,
 * `JSON.parse`s it, and validates it against `TargetManifestSchema`. It returns a
 * result object on every path and NEVER throws — mirroring the result-object
 * shape of `src/outcomes.ts`'s loader — with ONE critical inversion documented
 * below.
 *
 * # Fail loud, fail CLOSED (ADR-0026 decision 7 — the key divergence)
 *
 * UNLIKE `src/outcomes.ts`, which maps a missing file (ENOENT) to
 * `{ ok: true, outcomes: [] }` (missing is a valid empty state), a missing OR
 * malformed manifest here MUST return `{ ok: false, errors }` with no defaults,
 * so the downstream build aborts with an operator-facing error rather than
 * silently proceeding on empty config. This is the single most important
 * difference from the `outcomes.ts` template. Every failure is logged with the
 * `[target-manifest]` prefix per the fail-loud CLAUDE.md convention.
 *
 * # Read-fresh, no memoization (ADR-0026 decision 6)
 *
 * `loadManifest` reads the file on every call — there is no cache. The `rootDir`
 * parameter lets the same leaf serve build-time (workspace), synced-gate
 * (worktree), and in-process grounding call sites; the loader deliberately does
 * NOT hardcode `getTargetWorkspace()`.
 *
 * # Sync (ADR-0026 decision, dev choice)
 *
 * `readFileSync` matches the pure/sync sibling `src/target/risk-critical.ts` and
 * the synchronous gate-script call sites. The load is read-fresh with no
 * concurrency benefit, so sync is the simpler shape.
 *
 * No production callers in this slice — this is a pure leaf (schema + loader +
 * unit tests) that a later sibling wires into the build machinery.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TargetManifestSchema, type TargetManifest } from "../schemas/target-manifest.ts";

/**
 * The result of loading a Target Manifest. Never a thrown exception — callers
 * discriminate on `.ok`. `errors` are human-readable, `[target-manifest]`-
 * prefixed plain strings (typed error codes are deliberately deferred for this
 * slice, matching the `errors: string[]` house style of the sibling file loaders
 * `src/outcomes.ts` and `src/project-goals.ts`).
 */
export type LoadManifestResult =
  | { ok: true; manifest: TargetManifest }
  | { ok: false; errors: string[] };

/**
 * Load and validate `<rootDir>/.hydra/manifest.json`.
 *
 * Never throws. Returns:
 *   - `{ ok: true, manifest }` when the file exists, is valid JSON, and passes
 *     `TargetManifestSchema`.
 *   - `{ ok: false, errors }` on EVERY failure path — missing file (ENOENT),
 *     unreadable file, malformed JSON, or schema-invalid content — so the caller
 *     can abort the build with an operator-facing error (fail loud, fail closed;
 *     ADR-0026 decision 7).
 *
 * @param rootDir the target workspace/worktree root; the manifest is read from
 *   `<rootDir>/.hydra/manifest.json`.
 */
export function loadManifest(rootDir: string): LoadManifestResult {
  const manifestPath = join(rootDir, ".hydra", "manifest.json");

  // 1. Read the file. A missing manifest is fail-closed here (the inversion from
  //    outcomes.ts): ENOENT is NOT a valid empty state for the manifest.
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf-8");
  } catch (err: any) {
    const detail =
      err && err.code === "ENOENT"
        ? `manifest not found at ${manifestPath} (a Target Manifest is required; see ADR-0026)`
        : `failed to read ${manifestPath}: ${err?.message || String(err)}`;
    const msg = `[target-manifest] ${detail}`;
    console.error(msg);
    return { ok: false, errors: [msg] };
  }

  // 2. Parse JSON. Malformed JSON is a fail-closed error, not a silent default.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    const msg = `[target-manifest] invalid JSON in ${manifestPath}: ${err?.message || String(err)}`;
    console.error(msg);
    return { ok: false, errors: [msg] };
  }

  // 3. Validate against the schema. `safeParse` never throws; on failure map each
  //    zod issue to a `[target-manifest]`-prefixed string (path + message).
  const result = TargetManifestSchema.safeParse(parsed);
  if (!result.success) {
    const errors = result.error.issues.map((issue) => {
      const path = issue.path.join(".");
      return `[target-manifest] ${manifestPath}: ${path ? `${path}: ` : ""}${issue.message}`;
    });
    for (const e of errors) console.error(e);
    return { ok: false, errors };
  }

  return { ok: true, manifest: result.data };
}
