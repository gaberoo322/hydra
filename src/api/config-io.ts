/**
 * Config I/O primitives for the env-var routes (issue #3056).
 *
 * Extracted from `src/api/config.ts` so the `.env` parsing contract, the
 * secret-masking policy, and the Bearer-auth guard have a focused, one-home
 * leaf. This leaf grows when the parse/mask/auth semantics change; the route
 * factory in `config.ts` grows when Express request/response wiring changes —
 * two independent axes, two files.
 *
 * Design contract:
 * - **Downward import edge**: `config.ts` imports from this leaf; this leaf
 *   never imports from `config.ts` (same shape as `ov-upload.ts` ← `indexer.ts`).
 * - `parseEnvFile` and `maskValue` are **pure**: no filesystem, no network, no
 *   clock — a `string` in, a value out. Directly unit-testable.
 * - `makeEnvAuthGuard` is a small factory: it takes the resolved `CRON_SECRET`
 *   and returns an Express middleware. The captured secret keeps the guard a
 *   pure function of `(secret, req)` — a test can build a guard with a known
 *   secret and drive the 401 path without mounting the router.
 * - The filesystem primitives (`listConfigSection`, `readConfigFile`,
 *   `writeConfigFile`, `readEnvFile`, `upsertEnvVar`, `deleteEnvVar`) take
 *   **resolved absolute paths** as arguments and accept an injectable `fs`
 *   dependency (issue #3104). They never read `process.env` — env-project and
 *   config-root resolution stays in the route factory — so a test can inject
 *   in-memory `readFile`/`writeFile`/`readdir` stubs and drive the read/write
 *   policy without touching disk (the same never-touch-disk pattern as
 *   `parseEnvFile`).
 */
import type { RequestHandler } from "express";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/** One parsed `.env` line: the trimmed key, the unquoted value, and the raw line. */
export interface EnvVar {
  key: string;
  value: string;
  line: string;
}

/**
 * Parse raw `.env` text into `{ key, value, line }` records.
 *
 * Skips blank lines, comment lines (`#…`), and any line without an `=`. The
 * value is everything after the FIRST `=` (so embedded `=` signs in the value
 * are preserved), trimmed, with a single layer of matching surrounding single
 * or double quotes stripped.
 */
export function parseEnvFile(raw: string): EnvVar[] {
  return raw.split("\n").filter(l => l && !l.startsWith("#") && l.includes("=")).map(line => {
    const eq = line.indexOf("=");
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return { key, value, line };
  });
}

/**
 * Mask a secret value for display.
 *
 * Contract: values of length ≤ 6 render as all-bullets (`••••••`); longer
 * values render as the 3-char prefix + bullets + 3-char suffix, with the bullet
 * run capped at 20 so a very long secret does not bloat the response.
 */
export function maskValue(v: string): string {
  if (v.length <= 6) return "••••••";
  return v.slice(0, 3) + "•".repeat(Math.min(v.length - 6, 20)) + v.slice(-3);
}

/**
 * Build an Express middleware that requires `Authorization: Bearer <secret>`.
 *
 * Returns 401 when the configured `secret` is empty (no secret set ⇒ deny) or
 * when the presented Bearer token does not match. Capturing the secret at build
 * time keeps the guard a pure function of `(secret, req)` and makes the 401 path
 * testable without the route factory.
 */
export function makeEnvAuthGuard(secret: string): RequestHandler {
  return function requireEnvAuth(req, res, next) {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!secret || token !== secret) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  };
}

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
  readdir: (path: string) => Promise<string[]>;
  readFile: (path: string, encoding: "utf-8") => Promise<string>;
  writeFile: (path: string, data: string) => Promise<void>;
}

const DEFAULT_CONFIG_FS: ConfigFsDeps = {
  readdir: (path) => readdir(path) as Promise<string[]>,
  readFile: (path, encoding) => readFile(path, encoding),
  writeFile: (path, data) => writeFile(path, data),
};

/**
 * List the config-file names (extension stripped) in a section directory.
 *
 * `configPath` is the resolved absolute config root; `section` is a
 * `{ dir, ext }` entry from `CONFIG_SECTIONS`. Filters to files matching the
 * section extension and strips it. A missing directory (`ENOENT`) yields `[]`
 * — matching the route's "empty section" contract; any other error propagates.
 */
export async function listConfigSection(
  configPath: string,
  section: ConfigSection,
  fs: ConfigFsDeps = DEFAULT_CONFIG_FS,
): Promise<string[]> {
  try {
    const files = await fs.readdir(join(configPath, section.dir));
    return files.filter(f => f.endsWith(section.ext)).map(f => f.replace(section.ext, ""));
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
}

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

// ---------------------------------------------------------------------------
// Env-file file I/O (issue #3104)
//
// The read/write+edit filesystem operations for the `.env` routes. These build
// on `parseEnvFile` (above) and preserve the exact upsert/delete policy the
// route handlers used inline.
// ---------------------------------------------------------------------------

/**
 * Read a raw `.env` file, treating a missing file as empty text.
 *
 * `path` is the resolved absolute env-file path. A missing file (`ENOENT`)
 * returns `""` — the "init-as-empty if absent" policy the `GET`/`PUT` env
 * routes rely on; any other error propagates.
 */
export async function readEnvFile(
  path: string,
  fs: Pick<ConfigFsDeps, "readFile"> = DEFAULT_CONFIG_FS,
): Promise<string> {
  try {
    return await fs.readFile(path, "utf-8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return "";
    throw err;
  }
}

/** The outcome of an `upsertEnvVar` write: whether the key was added or updated. */
export type UpsertAction = "added" | "updated";

/**
 * Set or update a single variable in a `.env` file, preserving the exact
 * upsert-format policy the route used inline.
 *
 * Policy (byte-preserved): the value is quoted when it contains a space, `#`,
 * `"`, or a newline (embedded `"` escaped); an existing `KEY=` / `KEY =` line
 * is replaced in place, otherwise the assignment is appended with a blank-line
 * separator when the file is non-empty. Returns `"updated"` when a line was
 * replaced, `"added"` when appended.
 */
export async function upsertEnvVar(
  path: string,
  key: string,
  value: string,
  fs: Pick<ConfigFsDeps, "readFile" | "writeFile"> = DEFAULT_CONFIG_FS,
): Promise<UpsertAction> {
  const raw = await readEnvFile(path, fs);
  const lines = raw.split("\n");
  const needle = `${key}=`;
  const idx = lines.findIndex(l => l.startsWith(needle) || l.startsWith(`${key} =`));
  const needsQuotes = value.includes(" ") || value.includes("#") || value.includes('"') || value.includes("\n");
  const formatted = needsQuotes ? `${key}="${value.replace(/"/g, '\\"')}"` : `${key}=${value}`;
  if (idx >= 0) {
    lines[idx] = formatted;
  } else {
    if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
    lines.push(formatted);
  }
  await fs.writeFile(path, lines.join("\n"));
  return idx >= 0 ? "updated" : "added";
}

/**
 * Delete a single variable from a `.env` file.
 *
 * Filters lines matching `KEY=` / `KEY =`. Returns `false` when no line was
 * removed (the route shapes a 404) — the file is left untouched; returns `true`
 * after rewriting when at least one line was removed. Unlike the env `PUT`
 * path, a missing file is NOT initialized-as-empty: `readFile`'s error (e.g.
 * `ENOENT`) propagates so the route shapes a 500, byte-preserving the original
 * inline DELETE handler which read the file without an empty-on-ENOENT catch.
 */
export async function deleteEnvVar(
  path: string,
  key: string,
  fs: Pick<ConfigFsDeps, "readFile" | "writeFile"> = DEFAULT_CONFIG_FS,
): Promise<boolean> {
  const raw = await fs.readFile(path, "utf-8");
  const lines = raw.split("\n");
  const filtered = lines.filter(l => !l.startsWith(`${key}=`) && !l.startsWith(`${key} =`));
  if (filtered.length === lines.length) return false;
  await fs.writeFile(path, filtered.join("\n"));
  return true;
}
