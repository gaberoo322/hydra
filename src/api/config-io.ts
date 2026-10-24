/**
 * Config I/O primitives for the config routes (issues #3056, #3104).
 *
 * Extracted from `src/api/config.ts` so the config-section registry and its
 * read/write policy have a focused, one-home leaf. This leaf grows when the
 * filesystem semantics change; the route factory in `config.ts` grows when
 * Express request/response wiring changes — two independent axes, two files.
 *
 * The `.env` parse/mask/Bearer-guard and env-file read/upsert/delete
 * primitives were deleted with the retired `/env/:project` routes (issue
 * #4638, ADR-0024 §3) — they had no other caller.
 *
 * Design contract:
 * - **Downward import edge**: `config.ts` imports from this leaf; this leaf
 *   never imports from `config.ts`.
 * - The filesystem primitives (`readConfigFile`,
 *   `writeConfigFile`) take **resolved absolute paths** as arguments and
 *   accept an injectable `fs` dependency (issue #3104). They never read
 *   `process.env` — config-root resolution stays in the route factory — so a
 *   test can inject in-memory `readFile`/`writeFile` stubs and drive
 *   the read/write policy without touching disk.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Config-section file I/O (issue #3104)
//
// The section registry + path-construction + read/write policy for the
// git-tracked markdown config files (`config/{agents,feedback,direction,
// research}`). Migrated out of `createConfigRouter()` so route handlers become
// thin adapters and the filesystem policy is unit-testable with injected stubs.
// ---------------------------------------------------------------------------

/** One config section: its on-disk sub-directory and the file extension it uses. */
export interface ConfigSection {
  dir: string;
  ext: string;
}

/**
 * The config-section registry: section-name → `{ dir, ext }`. The source of
 * truth for which `config/*` sub-directories the config routes expose. A
 * section absent from this map is an unknown section (404 at the route).
 */
export const CONFIG_SECTIONS: Record<string, ConfigSection> = {
  agents: { dir: "agents", ext: ".md" },
  feedback: { dir: "feedback", ext: ".md" },
  direction: { dir: "direction", ext: ".md" },
  research: { dir: "research", ext: ".md" },
};

/** Injectable filesystem seam for the config-section primitives (defaults to `node:fs/promises`). */
export interface ConfigFsDeps {
  readFile: (path: string, encoding: "utf-8") => Promise<string>;
  writeFile: (path: string, data: string) => Promise<void>;
}

const DEFAULT_CONFIG_FS: ConfigFsDeps = {
  readFile: (path, encoding) => readFile(path, encoding),
  writeFile: (path, data) => writeFile(path, data),
};

/**
 * Read a single config file's raw contents.
 *
 * Returns the file text on success. A missing file (`ENOENT`) returns `null`
 * so the route can shape a 404; any other error propagates.
 */
export async function readConfigFile(
  configPath: string,
  section: ConfigSection,
  name: string,
  fs: ConfigFsDeps = DEFAULT_CONFIG_FS,
): Promise<string | null> {
  try {
    return await fs.readFile(join(configPath, section.dir, `${name}${section.ext}`), "utf-8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Write a single config file's contents, returning the absolute path written.
 *
 * Structural/IO errors propagate to the caller (the route shapes a 500).
 */
export async function writeConfigFile(
  configPath: string,
  section: ConfigSection,
  name: string,
  content: string,
  fs: ConfigFsDeps = DEFAULT_CONFIG_FS,
): Promise<string> {
  const filePath = join(configPath, section.dir, `${name}${section.ext}`);
  await fs.writeFile(filePath, content);
  return filePath;
}
