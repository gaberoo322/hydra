/**
 * test/vlm-image-materializer.test.mts — pin the pure image-handling leaf
 * (issue #3633) extracted from src/api/vlm.ts. This leaf needs NO spawn mock —
 * that is the deepening leverage the split rewards: the pure content-part
 * collection + data-URI decode + temp-file materialization cluster is testable
 * on its own.
 *
 * New top-level describe with its own trivial lifecycle — it touches no shared
 * Redis seam, so it never piggybacks a sibling suite's teardown.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  collectImageUrls,
  collectText,
  decodeDataUri,
  extensionForMime,
  materializeImage,
  messageText,
} from "../src/vlm/image-materializer.ts";

/** A 1x1 transparent PNG as a base64 data URI. */
const PNG_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

describe("vlm image-materializer leaf (issue #3633)", () => {
  test("extensionForMime maps known image MIME types, defaults to png", () => {
    assert.equal(extensionForMime("image/png"), "png");
    assert.equal(extensionForMime("image/jpeg"), "jpg");
    assert.equal(extensionForMime("image/jpg"), "jpg");
    assert.equal(extensionForMime("image/gif"), "gif");
    assert.equal(extensionForMime("image/webp"), "webp");
    assert.equal(extensionForMime("IMAGE/PNG"), "png"); // case-insensitive
    assert.equal(extensionForMime(undefined), "png");
    assert.equal(extensionForMime("application/octet-stream"), "png");
  });

  test("decodeDataUri decodes base64 and percent-encoded data URIs, null for non-data", () => {
    const decoded = decodeDataUri(PNG_DATA_URI);
    assert.ok(decoded);
    assert.equal(decoded.ext, "png");
    assert.ok(Buffer.isBuffer(decoded.bytes));
    // PNG magic bytes.
    assert.equal(decoded.bytes[0], 0x89);
    assert.equal(decoded.bytes.subarray(1, 4).toString("ascii"), "PNG");

    const urlEncoded = decodeDataUri("data:text/plain,hello%20world");
    assert.ok(urlEncoded);
    assert.equal(urlEncoded.bytes.toString("utf8"), "hello world");

    assert.equal(decodeDataUri("https://example.com/cat.png"), null);
  });

  test("messageText flattens string and content-part text", () => {
    assert.equal(messageText({ role: "user", content: "plain string" }), "plain string");
    assert.equal(
      messageText({
        role: "user",
        content: [
          { type: "text", text: "first" },
          { type: "image_url", image_url: { url: PNG_DATA_URI } },
          { type: "text", text: "second" },
        ],
      }),
      "first\nsecond",
    );
  });

  test("collectImageUrls and collectText gather across messages", () => {
    const messages = [
      { role: "user" as const, content: "leading instruction" },
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "describe it" },
          { type: "image_url" as const, image_url: { url: PNG_DATA_URI } },
        ],
      },
    ];
    assert.deepEqual(collectImageUrls(messages), [PNG_DATA_URI]);
    assert.equal(collectText(messages), "leading instruction\n\ndescribe it");
  });

  test("materializeImage writes a data URI under os.tmpdir() and cleanup removes it", async () => {
    const { reference, cleanup } = await materializeImage(PNG_DATA_URI);
    try {
      assert.ok(reference.startsWith(tmpdir()), "temp file must live under os.tmpdir()");
      assert.ok(reference.endsWith(".png"));
      assert.ok(existsSync(reference), "temp file exists after materialize");
      // Bytes on disk match the decoded PNG.
      assert.equal(readFileSync(reference)[0], 0x89);
    } finally {
      await cleanup();
    }
    assert.ok(!existsSync(reference), "cleanup removes the temp file");
  });

  test("materializeImage passes an http(s) URL through verbatim with a no-op cleanup", async () => {
    const url = "https://example.com/cat.png";
    const { reference, cleanup } = await materializeImage(url);
    assert.equal(reference, url);
    // No-op cleanup must not throw.
    await cleanup();
  });
});
