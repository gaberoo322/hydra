/**
 * Telegram transport tests (issue #5040) — `createTelegramSender`'s
 * plain-text resend when Telegram rejects a message's Markdown entities.
 * The `fetchImpl` seam replaces the network; no real Bot API call is made.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTelegramSender, createTelegramTransport, isEntityParseError } from "../src/notify.ts";

interface Call {
  url: string;
  body: Record<string, unknown>;
}

/** A fake `fetch` that records each request and replays scripted responses. */
function fakeFetch(responses: Array<{ status: number; body: string }>) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const r = responses[calls.length - 1] ?? { status: 200, body: "{}" };
    return new Response(r.body, { status: r.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const PARSE_400 = JSON.stringify({
  ok: false,
  error_code: 400,
  description: "Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 77",
});

describe("isEntityParseError", () => {
  it("matches only a 400 that names an entity-parse failure", () => {
    assert.equal(isEntityParseError(400, PARSE_400), true);
    assert.equal(isEntityParseError(400, "Bad Request: chat not found"), false);
    assert.equal(isEntityParseError(429, PARSE_400), false);
  });
});

describe("createTelegramSender", () => {
  it("sends once with Markdown when Telegram accepts it", async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: "{}" }]);
    await createTelegramSender({ token: "t", defaultTarget: "42", fetchImpl: impl })("hi *there*");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.parse_mode, "Markdown");
    assert.equal(calls[0].body.chat_id, "42");
  });

  it("resends the same text once as plain text after an entity-parse 400", async () => {
    const { impl, calls } = fakeFetch([
      { status: 400, body: PARSE_400 },
      { status: 200, body: "{}" },
    ]);
    await createTelegramSender({ token: "t", defaultTarget: "42", fetchImpl: impl })("node_modules wiped");
    assert.equal(calls.length, 2);
    assert.equal(calls[1].body.parse_mode, undefined);
    assert.equal(calls[1].body.text, "node_modules wiped");
  });

  it("does not resend on any other error", async () => {
    const { impl, calls } = fakeFetch([{ status: 400, body: "Bad Request: chat not found" }]);
    await createTelegramSender({ token: "t", defaultTarget: "42", fetchImpl: impl })("x");
    assert.equal(calls.length, 1);
  });

  it("resends at most once even if the plain-text send also fails", async () => {
    const { impl, calls } = fakeFetch([
      { status: 400, body: PARSE_400 },
      { status: 400, body: PARSE_400 },
    ]);
    await createTelegramSender({ token: "t", defaultTarget: "42", fetchImpl: impl })("x");
    assert.equal(calls.length, 2);
  });

  it("skips the network entirely without a token", async () => {
    const { impl, calls } = fakeFetch([]);
    await createTelegramSender({ token: "", defaultTarget: "42", fetchImpl: impl })("x");
    assert.equal(calls.length, 0);
  });
});

describe("createTelegramTransport (issue #5045)", () => {
  it("posts parse_mode HTML and reports mode HTML on success", async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: "{}" }]);
    const r = await createTelegramTransport({ token: "t", defaultTarget: "42", fetchImpl: impl, parseMode: "HTML" })("<b>x</b>");
    assert.deepEqual(r, { ok: true, mode: "HTML" });
    assert.equal(calls[0].body.parse_mode, "HTML");
  });

  it("resends once as plain text after an HTML entity-parse 400 and reports mode plain", async () => {
    const { impl, calls } = fakeFetch([
      { status: 400, body: PARSE_400 },
      { status: 200, body: "{}" },
    ]);
    const r = await createTelegramTransport({ token: "t", defaultTarget: "42", fetchImpl: impl, parseMode: "HTML" })("<b>x");
    assert.deepEqual(r, { ok: true, mode: "plain" });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].body.parse_mode, undefined);
  });

  it("reports failure with status and never throws", async () => {
    const { impl } = fakeFetch([{ status: 500, body: "boom" }]);
    const r = await createTelegramTransport({ token: "t", defaultTarget: "42", fetchImpl: impl })("x");
    assert.equal(r.ok, false);
    assert.equal((r as { status?: number }).status, 500);
  });

  it("reports no-credentials without touching the network when the token is empty", async () => {
    const { impl, calls } = fakeFetch([]);
    const r = await createTelegramTransport({ token: "", defaultTarget: "42", fetchImpl: impl })("x");
    assert.equal(r.ok, false);
    assert.equal((r as { reason?: string }).reason, "no-credentials");
    assert.equal(calls.length, 0);
  });
});
