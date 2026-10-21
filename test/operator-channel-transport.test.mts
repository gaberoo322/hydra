/**
 * Operator Channel transport tests (issues #5040, #5045, #5049) —
 * `createTelegramTransport`'s HTML send and its plain-text resend when
 * Telegram rejects a message's entities. The `fetchImpl` seam replaces the
 * network; no real Bot API call is made.
 *
 * Issue #5049 moved the transport from `src/notify.ts` into
 * `src/operator-channel/transport.ts` and deleted the legacy Markdown senders
 * (`createTelegramSender` / `sendToTelegram`); the last describe pins that
 * retirement.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import * as transport from "../src/operator-channel/transport.ts";
import { createTelegramTransport, isEntityParseError } from "../src/operator-channel/transport.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

describe("createTelegramTransport (issues #5040, #5045)", () => {
  it("posts parse_mode HTML to the Bot API and reports mode HTML on success", async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: "{}" }]);
    const r = await createTelegramTransport({ token: "t", defaultTarget: "42", fetchImpl: impl })("<b>x</b>");
    assert.deepEqual(r, { ok: true, mode: "HTML" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.parse_mode, "HTML");
    assert.equal(calls[0].body.chat_id, "42");
    assert.ok(calls[0].url.startsWith("https://api.telegram.org/bot"));
  });

  it("never posts Markdown — HTML is the only entity syntax (ADR-0045 Decision 5)", async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: "{}" }]);
    await createTelegramTransport({ token: "t", defaultTarget: "42", fetchImpl: impl })("hi *there*");
    assert.equal(calls[0].body.parse_mode, "HTML");
  });

  it("resends the same text once as plain text after an entity-parse 400 and reports mode plain", async () => {
    const { impl, calls } = fakeFetch([
      { status: 400, body: PARSE_400 },
      { status: 200, body: "{}" },
    ]);
    const r = await createTelegramTransport({ token: "t", defaultTarget: "42", fetchImpl: impl })("node_modules <wiped");
    assert.deepEqual(r, { ok: true, mode: "plain" });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].body.parse_mode, undefined);
    assert.equal(calls[1].body.text, "node_modules <wiped");
  });

  it("does not resend on any other error and reports status without throwing", async () => {
    const { impl, calls } = fakeFetch([{ status: 400, body: "Bad Request: chat not found" }]);
    const r = await createTelegramTransport({ token: "t", defaultTarget: "42", fetchImpl: impl })("x");
    assert.equal(calls.length, 1);
    assert.equal(r.ok, false);
    assert.equal((r as { status?: number }).status, 400);
  });

  it("resends at most once even if the plain-text send also fails", async () => {
    const { impl, calls } = fakeFetch([
      { status: 400, body: PARSE_400 },
      { status: 400, body: PARSE_400 },
    ]);
    const r = await createTelegramTransport({ token: "t", defaultTarget: "42", fetchImpl: impl })("x");
    assert.equal(calls.length, 2);
    assert.equal(r.ok, false);
  });

  it("reports failure with status and never throws on a 5xx", async () => {
    const { impl } = fakeFetch([{ status: 500, body: "boom" }]);
    const r = await createTelegramTransport({ token: "t", defaultTarget: "42", fetchImpl: impl })("x");
    assert.equal(r.ok, false);
    assert.equal((r as { status?: number }).status, 500);
  });

  it("reports a network failure as { ok: false } instead of throwing", async () => {
    const impl = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const r = await createTelegramTransport({ token: "t", defaultTarget: "42", fetchImpl: impl })("x");
    assert.deepEqual(r, { ok: false, error: "ECONNRESET" });
  });

  it("reports no-credentials without touching the network when the token is empty", async () => {
    const { impl, calls } = fakeFetch([]);
    const r = await createTelegramTransport({ token: "", defaultTarget: "42", fetchImpl: impl })("x");
    assert.equal(r.ok, false);
    assert.equal((r as { reason?: string }).reason, "no-credentials");
    assert.equal(calls.length, 0);
  });
});

describe("the legacy Markdown senders are retired (issue #5049)", () => {
  it("the transport module exports only the HTML transport surface", () => {
    assert.deepEqual(Object.keys(transport).sort(), [
      "createTelegramTransport",
      "isEntityParseError",
      "sendHtmlToTelegram",
    ]);
    for (const retired of ["createTelegramSender", "sendToTelegram", "sendNotification", "formatMessage"]) {
      assert.equal(retired in transport, false, `${retired} must not be exported`);
    }
  });

  it("src/notify.ts, src/notify-format.ts, src/digest.ts and src/digest-weekly.ts no longer exist", () => {
    for (const rel of ["src/notify.ts", "src/notify-format.ts", "src/digest.ts", "src/digest-weekly.ts"]) {
      assert.equal(existsSync(resolve(REPO_ROOT, rel)), false, `${rel} must be deleted`);
    }
  });
});
