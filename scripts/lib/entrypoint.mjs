import { pathToFileURL } from "node:url";

/**
 * True when the module whose `import.meta.url` is `metaUrl` is the process
 * entrypoint. The single home for the CLI guard under scripts/ (.mjs so bare
 * `node` harness scripts and type-stripped .ts scripts can both import it).
 * Compares against pathToFileURL so paths with spaces or percent-encodable
 * characters still match. No try/catch: a thrown error must surface.
 *
 * @param {string} metaUrl pass `import.meta.url`
 * @returns {boolean}
 */
export function isEntrypoint(metaUrl) {
  return process.argv[1] !== undefined && metaUrl === pathToFileURL(process.argv[1]).href;
}
