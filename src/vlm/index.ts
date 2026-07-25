/**
 * VLM shim domain — public barrel (issue #3633).
 *
 * The two sibling leaves in this directory hold the non-HTTP concerns extracted
 * from the flat `src/api/vlm.ts` shim so the route stays a thin HTTP adapter:
 *
 *   - `image-materializer.ts` — the pure content-part collection + data-URI
 *     decode + temp-file materialization cluster (no spawn mock needed to test);
 *   - `claude-cli-runner.ts` — the `runClaude` spawn/SIGKILL-timeout logic with
 *     the `spawnImpl` CI-safety seam preserved verbatim.
 *
 * Mirrors `src/health/index.ts`: this barrel re-exports the surface consumers
 * need so `src/api/vlm.ts` (the single route) and the per-leaf test files import
 * from `../vlm` / `../src/vlm` rather than reaching into each submodule.
 */
export * from "./claude-cli-runner.ts";
export * from "./image-materializer.ts";
