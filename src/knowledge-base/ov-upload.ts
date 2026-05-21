/**
 * ov-upload.ts — OpenViking resource upload helpers.
 *
 * Extracted from src/learning.ts (issue #211, partial extraction of
 * #210's source-indexing block). These are the low-level fetch helpers
 * used by both the config-file watcher and the source-file indexer to
 * push content into OpenViking. Pure HTTP — no state, no Redis.
 *
 * Behavior preserved verbatim from the prior in-file definitions; the
 * callers (knowledge indexer + source indexer + Redis poller) keep
 * working unchanged via re-exports from learning.ts.
 */

import { readFile, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep as pathSep } from "node:path";
import { createHash } from "node:crypto";

// Issue #231: import the canonical OV connection config instead of duplicating
// the literal API key default that diverged across src/ files.
import { OPENVIKING_URL, OPENVIKING_API_KEY } from "./ov-config.ts";

const OV_URL = OPENVIKING_URL;
const OV_KEY = OPENVIKING_API_KEY;
const OV_CONFIG_MOUNT = process.env.OV_CONFIG_MOUNT || "/config";
const CONFIG_PATH =
  process.env.HYDRA_CONFIG_PATH ||
  resolve(process.env.HOME!, "hydra", "config");

// Per-file content hashes so unchanged re-writes (priorities-agent rewriting
// the same content, fs.watch firing twice, etc.) skip the OV round-trip.
const indexedConfigHashes = new Map<string, string>();

// Translate a config-relative path into the OV virtual-fs URI under
// viking://resources. Without an explicit `to:` target, OV defaults the
// destination to a top-level basename — stripping the directory prefix
// and the file extension — which both clobbers nested layout and
// conflicts with prior orphan entries on every subsequent re-index.
export function indexerTargetUri(rel: string): string {
  return `viking://resources/${rel.split(pathSep).join("/")}`;
}

/**
 * Index a file already mounted into the OV container (config tree).
 * Tells OV to ingest the file by container-relative path.
 */
export async function indexFile(filePath: string): Promise<void> {
  const rel = relative(CONFIG_PATH, filePath);
  const containerPath = join(OV_CONFIG_MOUNT, rel);
  const targetUri = indexerTargetUri(rel);

  let hash: string | undefined;
  try {
    const buf = await readFile(filePath);
    hash = createHash("sha256").update(buf).digest("hex");
    if (indexedConfigHashes.get(filePath) === hash) return;
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      indexedConfigHashes.delete(filePath);
      return;
    }
    /* intentional: hash failure is non-fatal — fall through and try to index */
  }

  try {
    const res = await fetch(`${OV_URL}/api/v1/resources`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": OV_KEY },
      body: JSON.stringify({ path: containerPath, to: targetUri }),
      signal: AbortSignal.timeout(60000),
    });
    if (res.ok) {
      if (hash) indexedConfigHashes.set(filePath, hash);
      console.log(`[Learning:Indexer] Indexed file: ${rel} -> ${targetUri}`);
    } else {
      const err = await res.text();
      if (err.includes("not exist") || err.includes("ENOENT")) {
        console.log(`[Learning:Indexer] Skipped (removed): ${rel}`);
        indexedConfigHashes.delete(filePath);
      } else if (err.includes("file exists") || err.includes("point lock")) {
        console.warn(
          `[Learning:Indexer] Transient OV conflict on ${rel} — will retry on next change: ${err.slice(0, 160)}`
        );
      } else {
        console.error(
          `[Learning:Indexer] Failed to index ${rel}: ${err.slice(0, 200)}`
        );
      }
    }
  } catch (err: any) {
    console.error(`[Learning:Indexer] Failed to index ${rel}: ${err.message}`);
  }
}

/**
 * Index an arbitrary text blob by uploading it as a temp file then
 * registering it as a hydra-memory resource. Used for Redis-derived
 * content (reality reports, memory patterns) and source-file payloads.
 */
export async function indexText(title: string, content: string): Promise<void> {
  const safeName = title.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  const tmpFile = join(tmpdir(), `hydra-indexer-${safeName}-${Date.now()}.md`);
  try {
    await writeFile(tmpFile, `# ${title}\n\n${content}`, "utf-8");

    const { readFile: rf } = await import("node:fs/promises");
    const fileContent = await rf(tmpFile);
    const formData = new FormData();
    formData.append(
      "file",
      new Blob([fileContent], { type: "text/markdown" }),
      `${safeName}.md`
    );

    const uploadRes = await fetch(`${OV_URL}/api/v1/resources/temp_upload`, {
      method: "POST",
      headers: { "X-Api-Key": OV_KEY },
      body: formData,
      signal: AbortSignal.timeout(30000),
    });

    if (uploadRes.ok) {
      // OpenViking wraps responses as {status, result, error, telemetry}.
      // The temp_upload endpoint returns the path under `result.temp_path` —
      // older code read `uploadData.temp_path` directly and silently no-op'd
      // on every call (issue #313 in src/redis/work-queue.ts; same bug here
      // per #318). Read both wrapped and legacy unwrapped shapes for safety.
      const uploadData = (await uploadRes.json()) as any;
      const result = uploadData?.result ?? {};
      const tempPath =
        result.temp_path ?? result.path ?? uploadData.temp_path ?? uploadData.path;

      if (tempPath) {
        const addRes = await fetch(`${OV_URL}/api/v1/resources`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Api-Key": OV_KEY,
          },
          body: JSON.stringify({
            temp_path: tempPath,
            to: `viking://resources/hydra-memory/${safeName}`,
          }),
          signal: AbortSignal.timeout(60000),
        });
        if (addRes.ok) {
          console.log(`[Learning:Indexer] Indexed text: ${title}`);
        } else {
          const body = await addRes.text().catch(() => "");
          console.error(
            `[Learning:Indexer] Failed to add text "${title}": ${addRes.status} body=${body.slice(
              0,
              200
            )}`
          );
        }
      } else {
        // Fail loud (CLAUDE.md convention): log the full response body so a
        // future API shape change is debuggable from logs alone.
        console.error(
          `[Learning:Indexer] indexText "${title}": no temp_path in upload response — body=${JSON.stringify(
            uploadData
          ).slice(0, 300)}`
        );
      }
    } else {
      const body = await uploadRes.text().catch(() => "");
      console.error(
        `[Learning:Indexer] Failed to upload text "${title}": ${uploadRes.status} body=${body.slice(
          0,
          200
        )}`
      );
    }
  } catch (err: any) {
    console.error(
      `[Learning:Indexer] Failed to index text "${title}": ${err.message}`
    );
  } finally {
    await unlink(tmpFile).catch(() => {
      /* intentional: best-effort temp file cleanup */
    });
  }
}
