import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * True when the module whose `import.meta.url` is `metaUrl` is the process
 * entrypoint. The single home for the CLI guard under scripts/ (.mjs so bare
 * `node` harness scripts and type-stripped .ts scripts can both import it).
 * Compares against pathToFileURL of the realpath of argv[1]: paths with spaces
 * or percent-encodable characters match, and so does a symlinked invocation
 * (Node resolves import.meta.url through symlinks, argv[1] stays as typed).
 * An unresolvable argv[1] (ENOENT/ELOOP) is logged to stderr and reads as
 * "not the entrypoint" (false) rather than throwing at module top level.
 *
 * @param {string} metaUrl pass `import.meta.url`
 * @returns {boolean}
 */
export function isEntrypoint(metaUrl) {
  if (process.argv[1] === undefined) return false;
  try {
    return metaUrl === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch (err) {
    process.stderr.write(`isEntrypoint: cannot resolve argv[1] (${process.argv[1]}): ${err instanceof Error ? err.message : String(err)}\n`);
    return false;
  }
}
