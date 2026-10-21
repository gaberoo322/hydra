/**
 * Operator Channel core (ADR-0045, issue #5045): HTML renderer + escaper,
 * closed page list, credential loader, and the edge-triggered, fail-open
 * delivery state machine — all against an in-memory store and a fake
 * transport, so no Redis and no Telegram.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  OperatorChannel,
  REMINDER_INTERVAL_MS,
  escapeHtml,
  isPageKind,
  isPageEvent,
  loadTelegramCredentials,
  messageFromEvent,
  nextDedupState,
  renderMessage,
  MAX_RENDERED_CHARS,
  type OperatorChannelStore,
  type OperatorMessage,
} from "../src/operator-channel/index.ts";
import type { DedupState, DeliveryLogEntry } from "../src/redis/operator-channel.ts";
import type { TelegramTransportFn, TelegramTransportResult } from "../src/operator-channel/transport.ts";

const HOUR = 60 * 60 * 1000;

function pageMsg(over: Partial<OperatorMessage> = {}): OperatorMessage {
  return {
    severity: "page",
    kind: "infra:node_modules_wiped",
    title: "node_modules wiped",
    facts: [{ label: "root", value: "/home/x/node_modules" }],
    links: [],
    dedupKey: "infra:node_modules_wiped",
    ...over,
  };
}

/** In-memory store; `broken` makes every call fail the way an unreachable Redis does. */
function memoryStore(mode: "ok" | "reject" | "hang" = "ok") {
  const dedup = new Map<string, DedupState>();
  const briefs: Record<string, unknown>[] = [];
  const log: DeliveryLogEntry[] = [];
  const guard = async <T,>(fn: () => T): Promise<T> => {
    if (mode === "reject") throw new Error("ECONNREFUSED");
    if (mode === "hang") return new Promise<T>(() => {});
    return fn();
  };
  const store: OperatorChannelStore = {
    readDedup: (k) => guard(() => dedup.get(k) ?? null),
    writeDedup: (k, s) => guard(() => void dedup.set(k, { ...s })),
    incrSuppressed: (k) =>
      guard(() => {
        const s = dedup.get(k);
        if (s) s.suppressed += 1;
      }),
    delDedup: (k) => guard(() => void dedup.delete(k)),
    appendBrief: (i) => guard(() => void briefs.push(i)),
    appendLog: (e) => guard(() => void log.push(e)),
  };
  return { store, dedup, briefs, log };
}

function fakeTransport(result: TelegramTransportResult = { ok: true, mode: "HTML" }) {
  const sent: string[] = [];
  const transport: TelegramTransportFn = async (text) => {
    sent.push(text);
    return result;
  };
  return { transport, sent };
}

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

// ---------------------------------------------------------------------------
// Escaper + renderer
// ---------------------------------------------------------------------------

describe("escapeHtml", () => {
  test("rewrites & < > and nothing else", () => {
    assert.equal(escapeHtml("a & b < c > d"), "a &amp; b &lt; c &gt; d");
    assert.equal(escapeHtml(`_*\`"'`), `_*\`"'`);
    assert.equal(escapeHtml("&lt;"), "&amp;lt;", "& is escaped first so entities are not double-decoded");
  });
});

describe("renderMessage escaping (property-style)", () => {
  // Seeded xorshift32 — deterministic, no fast-check dependency (ADR-0005).
  function rng(seed: number) {
    let x = seed >>> 0;
    return () => {
      x ^= x << 13;
      x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5;
      x >>>= 0;
      return x;
    };
  }
  const ALPHABET = ["_", "*", "<", ">", "&", '"', "`", "a", "Z", "9", " ", "/", "node_modules"];
  const gen = (next: () => number, max = 24) =>
    Array.from({ length: next() % max }, () => ALPHABET[next() % ALPHABET.length]).join("");
  const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const FIXED_TAG = /<\/?(b|code|a)( href="[^"<>]*")?>/g;

  test("underscore/asterisk/angle-bracket payloads never leave a raw '<' or a bare '&' outside the fixed tags", () => {
    const next = rng(0x5045);
    for (let i = 0; i < 200; i++) {
      const msg = pageMsg({
        title: gen(next),
        facts: [{ label: gen(next), value: gen(next) }],
        links: [{ label: gen(next), url: `https://example.test/${gen(next)}` }],
      });
      const out = renderMessage(msg);
      const stripped = out.replace(FIXED_TAG, "");
      assert.ok(!/[<>]/.test(stripped), `raw angle bracket survived: ${out}`);
      assert.ok(!/&(?!amp;|lt;|gt;)/.test(out), `bare ampersand survived: ${out}`);
    }
  });

  test("the plain-text projection of the title round-trips to the input", () => {
    const next = rng(0xbeef);
    for (let i = 0; i < 200; i++) {
      const title = gen(next);
      const out = renderMessage(pageMsg({ title, facts: [], links: [] }));
      const m = /^🚨 <b>([\s\S]*)<\/b>$/.exec(out);
      assert.ok(m, `unexpected shape: ${out}`);
      assert.equal(decode(m![1]), title);
    }
  });

  test("a link whose url fails new URL() or contains a double quote is plain escaped text, never an <a> tag", () => {
    const bad = renderMessage(pageMsg({ links: [{ label: "x<y", url: "not a url" }] }));
    assert.ok(!bad.includes("<a "), bad);
    assert.ok(bad.includes("x&lt;y: not a url"), bad);
    const quoted = renderMessage(pageMsg({ links: [{ label: "L", url: 'https://e.test/"onclick=1' }] }));
    assert.ok(!quoted.includes("<a "), quoted);
    const good = renderMessage(pageMsg({ links: [{ label: "L&M", url: "https://e.test/?a=1&b=2" }] }));
    assert.ok(good.includes('<a href="https://e.test/?a=1&amp;b=2">L&amp;M</a>'), good);
  });

  test("a rendered page never exceeds the cap; whole facts are trimmed with a '+N more' marker", () => {
    const facts = Array.from({ length: 200 }, (_, i) => ({ label: `k${i}`, value: "&".repeat(100) }));
    const out = renderMessage(pageMsg({ facts }));
    assert.ok(out.length <= MAX_RENDERED_CHARS, `length ${out.length}`);
    assert.match(out, /… \+\d+ more/);
    // No fact line is cut mid-tag or mid-entity.
    for (const line of out.split("\n").filter((l) => l.startsWith("k"))) {
      assert.match(line, /^k\d+: <code>(&amp;)+<\/code>$/);
    }
  });

  test("reminder and recovered variants change only the prefix; extra facts and action render", () => {
    const base = pageMsg({ facts: [] });
    assert.match(renderMessage(base, { variant: "reminder" }), /^🔁 still failing — <b>/);
    assert.match(renderMessage(base, { variant: "recovered" }), /^✅ recovered — <b>/);
    const out = renderMessage(base, { actionCommand: "/hydra-review", extraFacts: [{ label: "suppressed", value: "3" }] });
    assert.ok(out.includes("suppressed: <code>3</code>"));
    assert.ok(out.endsWith("Action: <code>/hydra-review</code>"));
  });
});

// ---------------------------------------------------------------------------
// Page list
// ---------------------------------------------------------------------------

describe("severity is decided by the page list, never the producer", () => {
  test("page() throws InvalidArgumentError (code invalid-argument) for a kind not on the list", async () => {
    const ch = new OperatorChannel({ store: memoryStore().store, transport: fakeTransport().transport });
    await assert.rejects(ch.page(pageMsg({ kind: "cycle:completed" })), (e: any) => e.code === "invalid-argument");
  });

  test("brief() refuses a page kind", async () => {
    const ch = new OperatorChannel({ store: memoryStore().store, transport: fakeTransport().transport });
    await assert.rejects(ch.brief(pageMsg()), (e: any) => e.code === "invalid-argument");
  });

  test("messageFromEvent stamps severity from the list and derives dedup keys", () => {
    assert.equal(messageFromEvent({ type: "infra:node_modules_wiped", payload: { signal: "/x" } }).severity, "page");
    assert.equal(messageFromEvent({ type: "cycle:completed" }).severity, "brief");
    assert.equal(
      messageFromEvent({ type: "consumer:dead", payload: { consumer: "dlq", restarts: 6 } }).dedupKey,
      "consumer:dead:dlq",
    );
    assert.equal(
      messageFromEvent({ type: "dlq:alert", payload: { originalStream: "s", eventType: "e" } }).dedupKey,
      "dlq:s:e",
    );
    assert.equal(isPageKind("dlq:alert"), false);
  });

  test("a self-healed origin identity (repair=repaired) is a brief item, a failed/unattempted one still pages", async () => {
    const kind = "infra:origin_identity_wrong";
    assert.equal(messageFromEvent({ type: kind, payload: { repair: "repaired" } }).severity, "brief");
    assert.equal(messageFromEvent({ type: kind, payload: { repair: "failed" } }).severity, "page");
    assert.equal(messageFromEvent({ type: kind, payload: { repair: "not-attempted" } }).severity, "page");
    assert.equal(messageFromEvent({ type: kind, payload: {} }).severity, "page");
    assert.equal(isPageEvent(kind, { repair: "repaired" }), false);
    const ch = new OperatorChannel({ store: memoryStore().store, transport: fakeTransport().transport });
    const res = await ch.brief(messageFromEvent({ type: kind, payload: { repair: "repaired" } }));
    assert.equal(res.appended, true);
  });
});

// ---------------------------------------------------------------------------
// Dedup reducer
// ---------------------------------------------------------------------------

describe("nextDedupState (pure)", () => {
  const bad = (lastSentAt: number, suppressed = 0): DedupState => ({ state: "bad", firstAt: 0, lastSentAt, suppressed });

  test("absent key sends a page and goes bad", () => {
    assert.deepEqual(nextDedupState(null, 100, "page"), {
      send: "page",
      next: { state: "bad", firstAt: 100, lastSentAt: 100, suppressed: 0 },
      suppressedBefore: 0,
    });
  });
  test("a repeat inside 6h suppresses and counts", () => {
    const t = nextDedupState(bad(0, 2), REMINDER_INTERVAL_MS - 1, "page");
    assert.equal(t.send, null);
    assert.equal(t.next?.suppressed, 3);
  });
  test("a repeat at exactly 6h sends one reminder and resets the counter", () => {
    const t = nextDedupState(bad(0, 4), REMINDER_INTERVAL_MS, "page");
    assert.equal(t.send, "reminder");
    assert.equal(t.suppressedBefore, 4);
    assert.deepEqual(t.next, { state: "bad", firstAt: 0, lastSentAt: REMINDER_INTERVAL_MS, suppressed: 0 });
  });
  test("resolve on a bad key recovers and clears; on an absent key it is a no-op", () => {
    assert.deepEqual(nextDedupState(bad(0), 5, "resolve").send, "recovered");
    assert.equal(nextDedupState(bad(0), 5, "resolve").next, null);
    assert.equal(nextDedupState(null, 5, "resolve").send, null);
  });
});

// ---------------------------------------------------------------------------
// Channel behaviour
// ---------------------------------------------------------------------------

describe("OperatorChannel edge-triggered delivery", () => {
  test("first page sends once, repeats within 6h are suppressed and counted, one reminder after 6h, one recovered on resolve", async () => {
    const { store, dedup, log } = memoryStore();
    const { transport, sent } = fakeTransport();
    const c = clock();
    const ch = new OperatorChannel({ store, transport, now: c.now });

    assert.deepEqual(await ch.page(pageMsg()), { sent: true, kind: "page" });
    assert.equal(sent.length, 1);
    assert.match(sent[0], /^🚨 <b>node_modules wiped<\/b>/);

    c.advance(HOUR);
    assert.deepEqual(await ch.page(pageMsg()), { sent: false, reason: "suppressed" });
    c.advance(HOUR);
    assert.deepEqual(await ch.page(pageMsg()), { sent: false, reason: "suppressed" });
    assert.equal(sent.length, 1, "repeats inside 6h send nothing");
    assert.equal(dedup.get("infra:node_modules_wiped")?.suppressed, 2);

    c.advance(5 * HOUR);
    assert.deepEqual(await ch.page(pageMsg()), { sent: true, kind: "reminder" });
    assert.equal(sent.length, 2);
    assert.match(sent[1], /^🔁 still failing/);
    assert.match(sent[1], /suppressed: <code>2 since /);
    assert.equal(dedup.get("infra:node_modules_wiped")?.suppressed, 0);

    assert.deepEqual(await ch.resolve("infra:node_modules_wiped", "node_modules restored"), { sent: true, kind: "recovered" });
    assert.match(sent[2], /^✅ recovered — <b>node_modules restored<\/b>/);
    assert.equal(dedup.size, 0);
    assert.deepEqual(await ch.resolve("infra:node_modules_wiped"), { sent: false, reason: "not-bad" });
    assert.equal(sent.length, 3);

    assert.deepEqual(log.map((e) => e.kind), ["page", "reminder", "recovered"]);
    assert.ok(log.every((e) => e.outcome === "sent-html"));
  });

  test("a page after recovery starts a fresh episode", async () => {
    const { store } = memoryStore();
    const { transport, sent } = fakeTransport();
    const ch = new OperatorChannel({ store, transport });
    await ch.page(pageMsg());
    await ch.resolve("infra:node_modules_wiped");
    await ch.page(pageMsg());
    assert.equal(sent.length, 3);
  });

  test("delivery log records sent-plain after the plain-text backstop and failed with status", async () => {
    const m1 = memoryStore();
    await new OperatorChannel({ store: m1.store, transport: fakeTransport({ ok: true, mode: "plain" }).transport }).page(pageMsg());
    assert.equal(m1.log[0].outcome, "sent-plain");

    const m2 = memoryStore();
    const failed = await new OperatorChannel({
      store: m2.store,
      transport: fakeTransport({ ok: false, status: 403, error: "forbidden" }).transport,
    }).page(pageMsg());
    assert.deepEqual(failed, { sent: false, reason: "transport-failed" });
    assert.deepEqual([m2.log[0].outcome, m2.log[0].status], ["failed", 403]);
    assert.equal(m2.dedup.size, 0, "a failed send is not recorded as delivered, so the next repeat retries");
  });

  test("missing credentials: no throw, result no-credentials, delivery log skipped-no-credentials", async () => {
    const m = memoryStore();
    const ch = new OperatorChannel({
      store: m.store,
      transport: fakeTransport({ ok: false, reason: "no-credentials", error: "x" }).transport,
    });
    assert.deepEqual(await ch.page(pageMsg()), { sent: false, reason: "no-credentials" });
    assert.equal(m.log[0].outcome, "skipped-no-credentials");
  });

  test("brief() appends a bounded-list item and reports appended", async () => {
    const m = memoryStore();
    const ch = new OperatorChannel({ store: m.store, transport: fakeTransport().transport });
    const r = await ch.brief({ ...pageMsg(), severity: "brief", kind: "cycle:completed", dedupKey: "cycle:completed" });
    assert.deepEqual(r, { appended: true });
    assert.equal(m.briefs[0].kind, "cycle:completed");
    assert.equal(m.briefs[0].severity, "brief");
  });

  test("an action name resolves to the registry command; an unknown name omits the line but still sends", async () => {
    const m = memoryStore();
    const t = fakeTransport();
    const ch = new OperatorChannel({ store: m.store, transport: t.transport });
    await ch.page(pageMsg({ dedupKey: "a1", action: { name: "no-such-action" } }));
    assert.equal(t.sent.length, 1);
    assert.ok(!t.sent[0].includes("Action:"));
  });
});

describe("OperatorChannel fails OPEN when Redis is unreachable", () => {
  test("a rejecting store still produces one page, and a repeat is bounded by the process-local map", async () => {
    const m = memoryStore("reject");
    const { transport, sent } = fakeTransport();
    const c = clock();
    const ch = new OperatorChannel({ store: m.store, transport, now: c.now });
    assert.equal((await ch.page(pageMsg())).sent, true);
    assert.equal(sent.length, 1, "the page is sent despite ECONNREFUSED");
    c.advance(HOUR);
    assert.deepEqual(await ch.page(pageMsg()), { sent: false, reason: "suppressed" });
    assert.equal(sent.length, 1, "fail-open cannot become a flood");
    c.advance(5 * HOUR);
    assert.equal((await ch.page(pageMsg())).sent, true);
    assert.equal(sent.length, 2);
  });

  test("a store that never resolves is cut off by the timeout and the page is still sent", async () => {
    const m = memoryStore("hang");
    const { transport, sent } = fakeTransport();
    const ch = new OperatorChannel({ store: m.store, transport, timeoutMs: 20 });
    const r = await ch.page(pageMsg());
    assert.equal(r.sent, true);
    assert.equal(sent.length, 1);
  });

  test("concurrent pages for one dedupKey send exactly once (serialized per key)", async () => {
    const { store } = memoryStore();
    const { transport, sent } = fakeTransport();
    const ch = new OperatorChannel({ store, transport, now: clock().now });
    const results = await Promise.all([ch.page(pageMsg()), ch.page(pageMsg()), ch.page(pageMsg())]);
    assert.equal(sent.length, 1);
    assert.equal(results.filter((r) => r.sent).length, 1);
  });

  test("resolve clears the dedup key even when the recovered send fails", async () => {
    const { store, dedup } = memoryStore();
    const c = clock();
    const ok = fakeTransport();
    const chOk = new OperatorChannel({ store, transport: ok.transport, now: c.now });
    await chOk.page(pageMsg());
    assert.equal(dedup.has("infra:node_modules_wiped"), true);
    const failing = fakeTransport({ ok: false, error: "boom", status: 500 } as TelegramTransportResult);
    const chBad = new OperatorChannel({ store, transport: failing.transport, now: c.now });
    assert.equal((await chBad.resolve("infra:node_modules_wiped")).sent, false);
    assert.equal(dedup.has("infra:node_modules_wiped"), false);
  });

  test("brief() and resolve() never throw when the store is down", async () => {
    const m = memoryStore("reject");
    const ch = new OperatorChannel({ store: m.store, transport: fakeTransport().transport });
    assert.deepEqual(await ch.brief({ ...pageMsg(), severity: "brief", kind: "cycle:completed" }), { appended: false });
    assert.deepEqual(await ch.resolve("never-seen"), { sent: false, reason: "not-bad" });
  });
});

// ---------------------------------------------------------------------------
// Credentials: one loader
// ---------------------------------------------------------------------------

describe("single credential loader", () => {
  test("loadTelegramCredentials returns both values, or null when either is absent", () => {
    assert.deepEqual(loadTelegramCredentials({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "42" }), { token: "t", chatId: "42" });
    assert.equal(loadTelegramCredentials({ TELEGRAM_BOT_TOKEN: "t" }), null);
    assert.equal(loadTelegramCredentials({ TELEGRAM_CHAT_ID: "42" }), null);
    assert.equal(loadTelegramCredentials({}), null);
  });

  test("no src file carries a literal chat id or reads the Telegram credentials except credentials.ts", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|mts)$/.test(name)) files.push(p);
      }
    };
    walk(new URL("../src", import.meta.url).pathname);
    assert.ok(files.length > 50);
    for (const f of files) {
      const src = readFileSync(f, "utf-8");
      assert.ok(!src.includes("8291726150"), `${f} carries a hard-coded chat id`);
      if (f.endsWith("src/operator-channel/credentials.ts")) continue;
      assert.ok(!src.includes("TELEGRAM_CHAT_ID"), `${f} reads the chat id outside the loader`);
      assert.ok(!src.includes("TELEGRAM_BOT_TOKEN"), `${f} reads the bot token outside the loader`);
    }
  });
});

describe("checkOperatorChannelCredentials (boot check)", () => {
  test("reports false for an empty env and true when both vars are set", async () => {
    const { checkOperatorChannelCredentials } = await import("../src/operator-channel/channel.ts");
    assert.equal(checkOperatorChannelCredentials({}), false);
    assert.equal(checkOperatorChannelCredentials({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "1" }), true);
  });
});
