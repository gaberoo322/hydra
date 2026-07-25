import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { VlmContentPart, VlmMessage } from "../schemas/vlm.ts";

/**
 * VLM image-handling leaf (issue #3633) — the pure content-part collection +
 * data-URI decode + temp-file materialization cluster extracted from
 * `src/api/vlm.ts` so it is testable with NO spawn mock. Every function here is
 * either pure (`messageText`/`collectImageUrls`/`collectText`/`decodeDataUri`/
 * `extensionForMime`) or writes bytes ONLY under `os.tmpdir()` (never the
 * repo/git tree) and returns a self-cleaning cleanup thunk (`materializeImage`).
 *
 * The route (`src/api/vlm.ts`) composes this leaf with `claude-cli-runner.ts`:
 * it collects the image URLs + text instruction, materializes the first image,
 * and runs the cleanup in a `finally` on BOTH success and error paths so a
 * failed claude call never leaks image bytes on disk.
 */

/** Flatten a message's `content` into its text parts, joined. */
export function messageText(message: VlmMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part): part is Extract<VlmContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/** Collect every image content-part URL across all messages. */
export function collectImageUrls(messages: VlmMessage[]): string[] {
  const urls: string[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "image_url") urls.push(part.image_url.url);
    }
  }
  return urls;
}

/** Collect every text instruction across all messages, joined. */
export function collectText(messages: VlmMessage[]): string {
  return messages
    .map((message) => messageText(message))
    .filter((text) => text.length > 0)
    .join("\n\n")
    .trim();
}

const DATA_URI_RE = /^data:(?<mime>[^;,]+)?(?<base64>;base64)?,(?<data>.*)$/s;

/** Map an image MIME type to a file extension for the temp file. */
export function extensionForMime(mime: string | undefined): string {
  switch ((mime ?? "").toLowerCase()) {
    case "image/png":
      return "png";
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return "png";
  }
}

/**
 * Decode a `data:` URI into raw bytes + extension. Returns null for a non-data
 * URL (e.g. an http(s) URL, which is handed to the model as-is). Base64 and
 * URL-encoded (percent) data URIs are both handled.
 */
export function decodeDataUri(url: string): { bytes: Buffer; ext: string } | null {
  const match = DATA_URI_RE.exec(url);
  if (!match || !match.groups) return null;
  const { mime, base64, data } = match.groups;
  const bytes = base64
    ? Buffer.from(data, "base64")
    : Buffer.from(decodeURIComponent(data), "utf8");
  return { bytes, ext: extensionForMime(mime) };
}

/** A materialized image reference plus the cleanup to run in a `finally`. */
export type MaterializedImage = {
  reference: string;
  cleanup: () => Promise<void>;
};

/**
 * Materialize the first image reference for `claude -p`. A `data:` URI decodes
 * to a temp file under `os.tmpdir()` (NEVER the repo tree) and the returned
 * `cleanup` unlinks the temp dir; an http(s) URL is passed through as-is with a
 * no-op cleanup (the model fetches it via the Read/WebFetch path — but the shim
 * only allows Read, so a remote URL is best-effort). Returns the on-disk path
 * or URL the prompt should reference, plus the cleanup to run in a `finally`.
 */
export async function materializeImage(url: string): Promise<MaterializedImage> {
  const decoded = decodeDataUri(url);
  if (!decoded) {
    // Non-data URL: hand it to the model verbatim, nothing to clean up.
    return { reference: url, cleanup: async () => {} };
  }
  const dir = await mkdtemp(join(tmpdir(), "hydra-vlm-"));
  const file = join(dir, `image-${randomBytes(6).toString("hex")}.${decoded.ext}`);
  await writeFile(file, decoded.bytes);
  return {
    reference: file,
    cleanup: async () => {
      // rm the whole temp dir; recursive+force so a partially-written file or
      // an already-removed dir cannot throw out of the finally.
      await rm(dir, { recursive: true, force: true });
    },
  };
}
