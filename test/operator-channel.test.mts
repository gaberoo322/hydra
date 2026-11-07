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
  type ChannelResult,
  type OperatorChannelStore,
  type OperatorMessage,
} from "../src/operator-channel/index.ts";
import { ALERT_TYPES, KIND_TABLE, PAGE_KINDS, renderBriefLine, type BriefItem } from "../src/operator-channel/index.ts";
import { REPO_ROOT, listTrackedFiles, stripComments } from "../scripts/ci/seam-check-lib.ts";
import type { DashboardAlert } from "../src/redis/alerts.ts";
import type { DedupState, DeliveryLogEntry } from "../src/redis/operator-channel.ts";
import type { TelegramTransportFn, TelegramTransportResult } from "../src/operator-channel/transport.ts";

/**
 * page()/brief() are private to the channel (issue #5391). The dedup-reducer
 * drives below exercise the edge-trigger state machine with hand-built
 * messages, which report() derives from the per-kind table instead, so they
 * reach the private methods through this one typed cast.
 */
function priv(ch: OperatorChannel) {
  return ch as unknown as {
    page(msg: OperatorMessage): Promise<ChannelResult>;
    brief(msg: OperatorMessage): Promise<{ appended: boolean }>;
  };
}

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
  test("report() routes a brief kind to the Morning Brief and never pages it", async () => {
    const m = memoryStore();
    const t = fakeTransport();
    const ch = new OperatorChannel({ store: m.store, transport: t.transport, alerts: async () => true });
    const r = await ch.report("cycle:completed", { cycleId: "c1" });
    assert.equal(r.disposition, "brief");
    assert.deepEqual(r.outcome, { appended: true });
    assert.equal(t.sent.length, 0, "a brief kind sends nothing immediately");
    assert.equal(m.briefs.length, 1);
  });

  test("report() routes a page kind to a page and never appends a brief item", async () => {
    const m = memoryStore();
    const t = fakeTransport();
    const ch = new OperatorChannel({ store: m.store, transport: t.transport, alerts: async () => true });
    const r = await ch.report("service:tunnel_failed", { unit: "hydra-tunnel.service" });
    assert.equal(r.disposition, "page");
    assert.deepEqual(r.outcome, { sent: true, kind: "page" });
    assert.equal(t.sent.length, 1);
    assert.equal(m.briefs.length, 0);
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
    const res = await ch.report(kind, { repair: "repaired" });
    assert.equal(res.disposition, "brief");
    assert.deepEqual(res.outcome, { appended: true });
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

    assert.deepEqual(await priv(ch).page(pageMsg()), { sent: true, kind: "page" });
    assert.equal(sent.length, 1);
    assert.match(sent[0], /^🚨 <b>node_modules wiped<\/b>/);

    c.advance(HOUR);
    assert.deepEqual(await priv(ch).page(pageMsg()), { sent: false, reason: "suppressed" });
    c.advance(HOUR);
    assert.deepEqual(await priv(ch).page(pageMsg()), { sent: false, reason: "suppressed" });
    assert.equal(sent.length, 1, "repeats inside 6h send nothing");
    assert.equal(dedup.get("infra:node_modules_wiped")?.suppressed, 2);

    c.advance(5 * HOUR);
    assert.deepEqual(await priv(ch).page(pageMsg()), { sent: true, kind: "reminder" });
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
    await priv(ch).page(pageMsg());
    await ch.resolve("infra:node_modules_wiped");
    await priv(ch).page(pageMsg());
    assert.equal(sent.length, 3);
  });

  test("delivery log records sent-plain after the plain-text backstop and failed with status", async () => {
    const m1 = memoryStore();
    await priv(new OperatorChannel({ store: m1.store, transport: fakeTransport({ ok: true, mode: "plain" }).transport })).page(pageMsg());
    assert.equal(m1.log[0].outcome, "sent-plain");

    const m2 = memoryStore();
    const failed = await priv(new OperatorChannel({
      store: m2.store,
      transport: fakeTransport({ ok: false, status: 403, error: "forbidden" }).transport,
    })).page(pageMsg());
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
    assert.deepEqual(await priv(ch).page(pageMsg()), { sent: false, reason: "no-credentials" });
    assert.equal(m.log[0].outcome, "skipped-no-credentials");
  });

  test("brief() appends a bounded-list item and reports appended", async () => {
    const m = memoryStore();
    const ch = new OperatorChannel({ store: m.store, transport: fakeTransport().transport });
    const r = await priv(ch).brief({ ...pageMsg(), severity: "brief", kind: "cycle:completed", dedupKey: "cycle:completed" });
    assert.deepEqual(r, { appended: true });
    assert.equal(m.briefs[0].kind, "cycle:completed");
    assert.equal(m.briefs[0].severity, "brief");
  });

  test("an action name resolves to the registry command; an unknown name omits the line but still sends", async () => {
    const m = memoryStore();
    const t = fakeTransport();
    const ch = new OperatorChannel({ store: m.store, transport: t.transport });
    await priv(ch).page(pageMsg({ dedupKey: "a1", action: { name: "no-such-action" } }));
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
    assert.equal((await priv(ch).page(pageMsg())).sent, true);
    assert.equal(sent.length, 1, "the page is sent despite ECONNREFUSED");
    c.advance(HOUR);
    assert.deepEqual(await priv(ch).page(pageMsg()), { sent: false, reason: "suppressed" });
    assert.equal(sent.length, 1, "fail-open cannot become a flood");
    c.advance(5 * HOUR);
    assert.equal((await priv(ch).page(pageMsg())).sent, true);
    assert.equal(sent.length, 2);
  });

  test("a store that never resolves is cut off by the timeout and the page is still sent", async () => {
    const m = memoryStore("hang");
    const { transport, sent } = fakeTransport();
    const ch = new OperatorChannel({ store: m.store, transport, timeoutMs: 20 });
    const r = await priv(ch).page(pageMsg());
    assert.equal(r.sent, true);
    assert.equal(sent.length, 1);
  });

  test("concurrent pages for one dedupKey send exactly once (serialized per key)", async () => {
    const { store } = memoryStore();
    const { transport, sent } = fakeTransport();
    const ch = new OperatorChannel({ store, transport, now: clock().now, alerts: async () => true });
    const results = await Promise.all([1, 2, 3].map(() => ch.report("infra:redis_backup_stale", { reason: "stale" })));
    assert.equal(sent.length, 1);
    assert.equal(results.filter((r) => r.delivered).length, 1);
  });

  test("resolve clears the dedup key even when the recovered send fails", async () => {
    const { store, dedup } = memoryStore();
    const c = clock();
    const ok = fakeTransport();
    const chOk = new OperatorChannel({ store, transport: ok.transport, now: c.now });
    await priv(chOk).page(pageMsg());
    assert.equal(dedup.has("infra:node_modules_wiped"), true);
    const failing = fakeTransport({ ok: false, error: "boom", status: 500 } as TelegramTransportResult);
    const chBad = new OperatorChannel({ store, transport: failing.transport, now: c.now });
    assert.equal((await chBad.resolve("infra:node_modules_wiped")).sent, false);
    assert.equal(dedup.has("infra:node_modules_wiped"), false);
  });

  test("brief() and resolve() never throw when the store is down", async () => {
    const m = memoryStore("reject");
    const ch = new OperatorChannel({ store: m.store, transport: fakeTransport().transport });
    assert.deepEqual(await priv(ch).brief({ ...pageMsg(), severity: "brief", kind: "cycle:completed" }), { appended: false });
    assert.deepEqual(await ch.resolve("never-seen"), { sent: false, reason: "not-bad" });
  });
});

describe("page() and brief() are private to the Operator Channel (issue #5391, seam)", () => {
  test("no tracked file under src/ or scripts/ outside src/operator-channel/ calls .page( or .brief(", async () => {
    const offenders: string[] = [];
    for (const file of await listTrackedFiles(["src/**", "scripts/**"])) {
      if (file.startsWith("src/operator-channel/") || !/\.(ts|mts|js|mjs)$/.test(file)) continue;
      const text = stripComments(readFileSync(join(REPO_ROOT, file), "utf8"));
      if (/\.(page|brief)\(/.test(text)) offenders.push(file);
    }
    assert.deepEqual(offenders, []);
  });

  test("severityOf is not re-introduced anywhere in the Operator Channel module", () => {
    for (const f of readdirSync(join(REPO_ROOT, "src/operator-channel"))) {
      assert.ok(!readFileSync(join(REPO_ROOT, "src/operator-channel", f), "utf8").includes("severityOf"), f);
    }
  });

});

describe("OperatorChannel episode probes: isOpen / clear / reminderDue / briefOnce", () => {
  const KEY = "infra:node_modules_wiped";
  const briefMsg = (): OperatorMessage => ({ ...pageMsg(), severity: "brief", kind: "infra:tmpfs_pressure", dedupKey: "infra:tmpfs_pressure:/tmp:warn" });

  test("isOpen: false before a page, true after, false once resolved (and it never sends)", async () => {
    const { store } = memoryStore();
    const { transport, sent } = fakeTransport();
    const ch = new OperatorChannel({ store, transport, now: clock().now });
    assert.equal(await ch.isOpen(KEY), false);
    await priv(ch).page(pageMsg());
    assert.equal(await ch.isOpen(KEY), true);
    assert.equal(sent.length, 1, "isOpen is read-only");
    await ch.resolve(KEY);
    assert.equal(await ch.isOpen(KEY), false);
  });

  test("isOpen: null when the store is unreadable and nothing was sent; true from the process-local map once a page went out", async () => {
    const m = memoryStore("reject");
    const ch = new OperatorChannel({ store: m.store, transport: fakeTransport().transport, now: clock().now });
    assert.equal(await ch.isOpen(KEY), null);
    await priv(ch).page(pageMsg());
    assert.equal(await ch.isOpen(KEY), true);
  });

  test("clear: closes an open key silently (no recovered message) and is a no-op on a closed key", async () => {
    const { store, dedup } = memoryStore();
    const { transport, sent } = fakeTransport();
    const ch = new OperatorChannel({ store, transport, now: clock().now });
    await priv(ch).page(pageMsg());
    assert.equal(dedup.has(KEY), true);
    await ch.clear(KEY);
    assert.equal(dedup.has(KEY), false);
    assert.equal(await ch.isOpen(KEY), false);
    assert.equal(sent.length, 1, "clear sends nothing — unlike resolve");
    await ch.clear(KEY); // idempotent
    assert.equal(sent.length, 1);
    assert.equal((await priv(ch).page(pageMsg())).sent, true, "a cleared key pages again as a fresh episode");
  });

  test("clear: also drops the process-local fallback when the store is down", async () => {
    const m = memoryStore("reject");
    const ch = new OperatorChannel({ store: m.store, transport: fakeTransport().transport, now: clock().now });
    await priv(ch).page(pageMsg());
    await ch.clear(KEY);
    assert.equal(await ch.isOpen(KEY), null);
  });

  test("reminderDue: false for a closed key and inside 6h, true after 6h", async () => {
    const { store } = memoryStore();
    const c = clock();
    const ch = new OperatorChannel({ store, transport: fakeTransport().transport, now: c.now });
    assert.equal(await ch.reminderDue(KEY), false);
    await priv(ch).page(pageMsg());
    c.advance(5 * HOUR);
    assert.equal(await ch.reminderDue(KEY), false);
    c.advance(HOUR);
    assert.equal(await ch.reminderDue(KEY), true);
  });

  test("briefOnce: appends once per episode, sends no message, and re-arms after clear", async () => {
    const { store, briefs } = memoryStore();
    const { transport, sent } = fakeTransport();
    const ch = new OperatorChannel({ store, transport, now: clock().now });
    assert.deepEqual(await ch.briefOnce(briefMsg()), { appended: true });
    assert.deepEqual(await ch.briefOnce(briefMsg()), { appended: false });
    assert.equal(briefs.length, 1);
    assert.equal(sent.length, 0, "a brief never goes to Telegram");
    await ch.clear(briefMsg().dedupKey);
    assert.deepEqual(await ch.briefOnce(briefMsg()), { appended: true });
    assert.equal(briefs.length, 2);
  });

  test("briefOnce: refuses a page kind", async () => {
    const { store } = memoryStore();
    const ch = new OperatorChannel({ store, transport: fakeTransport().transport, now: clock().now });
    await assert.rejects(() => ch.briefOnce({ ...pageMsg(), severity: "brief" }));
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

// ---------------------------------------------------------------------------
// The per-kind table + report() (issue #5389)
// ---------------------------------------------------------------------------

describe("KIND_TABLE — the one per-kind table", () => {
  test("every notification event type and every CLI kind has a row", async () => {
    const { NOTIFICATION_EVENT_TYPES } = await import("../src/event-bus-vocabulary.ts");
    const { UNIT_PAGE_KINDS, UNIT_FAILED_BRIEF_KIND } = await import("../scripts/operator-notify.ts");
    const watchdog = readFileSync(new URL("../scripts/hydra-watchdog.sh", import.meta.url), "utf8");
    const cliKinds = [...watchdog.matchAll(/--kind "([^"]+)"/g)].map((m) => m[1]);
    const expected = new Set<string>([
      ...Object.values(NOTIFICATION_EVENT_TYPES),
      ...Object.values(UNIT_PAGE_KINDS),
      UNIT_FAILED_BRIEF_KIND,
      ...cliKinds,
    ]);
    const missing = [...expected].filter((k) => !Object.hasOwn(KIND_TABLE, k));
    assert.deepEqual(missing, [], `kinds with no KIND_TABLE row: ${missing.join(", ")}`);
    assert.equal(Object.keys(KIND_TABLE).length, 30);
  });

  test("PAGE_KINDS, BRIEF_KINDS and ALERT_TYPES are derived from the table", () => {
    assert.equal(PAGE_KINDS.length, 19);
    assert.deepEqual(
      [...ALERT_TYPES].sort(),
      Object.entries(KIND_TABLE).filter(([, r]) => r.alert !== false).map(([k]) => k).sort(),
    );
    assert.equal(ALERT_TYPES.size, 7);
    assert.equal(ALERT_TYPES.has("launch:pause_forgotten"), false);
    assert.equal(isPageKind("constructor"), false, "prototype keys are not kinds");
  });
});

describe("per-kind table import direction", () => {
  test("alert-grammar.ts stays a leaf: it does not import from the operator-channel module", () => {
    const grammar = readFileSync(new URL("../src/notification/alert-grammar.ts", import.meta.url), "utf8");
    assert.doesNotMatch(grammar, /from\s+["'][^"']*operator-channel/);
    const table = readFileSync(new URL("../src/operator-channel/page-list.ts", import.meta.url), "utf8");
    const imports = [...table.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]).sort();
    assert.deepEqual(imports, ["../event-bus-vocabulary.ts", "../notification/alert-grammar.ts", "./message.ts"]);
  });
});

describe("OperatorChannel.report()", () => {
  function setup(alertsImpl?: (a: DashboardAlert) => Promise<boolean>) {
    const mem = memoryStore();
    const tr = fakeTransport();
    const alerts: DashboardAlert[] = [];
    const ch = new OperatorChannel({
      store: mem.store,
      transport: tr.transport,
      now: clock().now,
      alerts: alertsImpl ?? (async (a) => (alerts.push(a), true)),
    });
    return { ch, mem, tr, alerts };
  }

  test("a page kind with an alert pages and writes an error alert with the bus id/timestamp", async () => {
    const { ch, tr, alerts } = setup();
    const res = await ch.report("launch:quota_stretch", { reason: "5h cap" }, { id: "e1", timestamp: "2026-11-05T00:00:00.000Z" });
    assert.equal(res.disposition, "page");
    assert.equal(res.delivered, true);
    assert.equal(res.alertWritten, true);
    assert.equal(res.unknownKind, false);
    assert.equal(tr.sent.length, 1);
    assert.equal(alerts[0].severity, "error");
    assert.equal(alerts[0].id, "e1");
    assert.equal(alerts[0].timestamp, "2026-11-05T00:00:00.000Z");
    assert.equal(alerts[0].dismissed, false);
    assert.deepEqual(alerts[0].payload, { reason: "5h cap" });
    assert.match(alerts[0].message, /^Launch quota stretch/);
  });

  test("a suppressed repeat page is delivered:false with reason suppressed, but still writes the alert", async () => {
    const { ch, alerts } = setup();
    await ch.report("consumer:dead", { consumer: "dlq", restarts: 6 });
    const second = await ch.report("consumer:dead", { consumer: "dlq", restarts: 6 });
    assert.equal(second.delivered, false);
    assert.deepEqual(second.outcome, { sent: false, reason: "suppressed" });
    assert.equal(alerts.length, 2);
    assert.match(alerts[0].id, /^alert-/);
  });

  test("a brief kind with an alert is appended and gets an info alert (dlq:alert)", async () => {
    const { ch, mem, alerts } = setup();
    const res = await ch.report("dlq:alert", { originalStream: "s", eventType: "e", deliveryCount: 3 });
    assert.equal(res.disposition, "brief");
    assert.equal(res.delivered, true);
    assert.equal(mem.briefs.length, 1);
    assert.equal(alerts[0].severity, "info");
  });

  test("a page kind without an alert flag writes none", async () => {
    const { ch, alerts } = setup();
    const res = await ch.report("launch:pause_forgotten", {});
    assert.equal(res.alertWritten, false);
    assert.equal(alerts.length, 0);
  });

  test("an unknown kind is briefed with the generic line, flagged, never thrown", async () => {
    const { ch, mem, tr, alerts } = setup();
    const res = await ch.report("totally:unknown", { a: "x", n: 2, nested: { z: 1 } });
    assert.equal(res.disposition, "brief");
    assert.equal(res.unknownKind, true);
    assert.equal(res.alertWritten, false);
    assert.equal(res.delivered, true);
    assert.equal(tr.sent.length, 0);
    assert.equal(alerts.length, 0);
    assert.equal(mem.briefs[0].title, "totally:unknown");
    assert.deepEqual(mem.briefs[0].facts, [{ label: "a", value: "x" }, { label: "n", value: "2" }]);
  });

  test("a repaired origin identity is a dedicated brief line, no page and no alert; unrepaired still pages with an alert", async () => {
    const { ch, mem, tr, alerts } = setup();
    const kind = "infra:origin_identity_wrong";
    const repaired = await ch.report(kind, { reason: "wrong-origin-url", url: "https://evil", repair: "repaired", newUrl: "https://good", fetch: "ok" });
    assert.equal(repaired.disposition, "brief");
    assert.equal(repaired.alertWritten, false);
    assert.equal(tr.sent.length, 0);
    const line = renderBriefLine({ ...(mem.briefs[0] as object), at: 1 } as BriefItem);
    assert.equal(line, "~/hydra origin identity auto-repaired: wrong-origin-url — origin https://evil -> https://good, fetch ok");
    const failed = await ch.report(kind, { reason: "wrong-origin-url", url: "https://evil", repair: "failed" });
    assert.equal(failed.disposition, "page");
    assert.equal(failed.alertWritten, true);
    assert.equal(alerts[0].severity, "error");
  });

  test("the alert write starts before delivery: a transport that waits on the alert still completes (QA #5394 finding 2)", async () => {
    let seen!: () => void;
    const alertSeen = new Promise<void>((r) => (seen = r));
    const ch = new OperatorChannel({
      store: memoryStore().store,
      transport: async () => {
        await alertSeen; // deadlocks if the alert is only written after the page step
        return { ok: true, mode: "HTML" };
      },
      now: clock().now,
      alerts: async () => (seen(), true),
    });
    const res = await Promise.race([
      ch.report("launch:quota_stretch", {}),
      new Promise<"hung">((r) => setTimeout(() => r("hung"), 1000)),
    ]);
    assert.notEqual(res, "hung");
    assert.equal((res as { alertWritten: boolean }).alertWritten, true);
  });

  test("a hung alert write is bounded by the channel timeout: report() resolves, alertWritten=false (QA #5394 round 3)", async () => {
    const tr = fakeTransport();
    const ch = new OperatorChannel({
      store: memoryStore().store,
      transport: tr.transport,
      now: clock().now,
      timeoutMs: 30,
      alerts: () => new Promise<boolean>(() => {}), // never settles
    });
    const res = await Promise.race([
      ch.report("launch:quota_stretch", {}),
      new Promise<"hung">((r) => setTimeout(() => r("hung"), 1000)),
    ]);
    assert.notEqual(res, "hung");
    assert.equal((res as { alertWritten: boolean }).alertWritten, false);
    assert.equal((res as { delivered: boolean }).delivered, true);
  });

  test("meta.alert=false suppresses the dashboard alert but still delivers the page", async () => {
    const { ch, tr, alerts } = setup();
    const res = await ch.report("launch:quota_stretch", {}, { alert: false });
    assert.equal(res.delivered, true);
    assert.equal(res.alertWritten, false);
    assert.equal(tr.sent.length, 1);
    assert.equal(alerts.length, 0);
  });

  test("sibling shape: omitting meta.alert still writes the alert for an alert kind", async () => {
    const { ch, alerts } = setup();
    const res = await ch.report("launch:quota_stretch", {});
    assert.equal(res.alertWritten, true);
    assert.equal(alerts.length, 1);
  });

  test("sibling shape: a page-only kind (no alert) still delivers and writes none", async () => {
    const { ch, tr, alerts } = setup();
    const res = await ch.report("launch:pause_forgotten", {});
    assert.equal(res.delivered, true);
    assert.equal(tr.sent.length, 1);
    assert.equal(alerts.length, 0);
  });

  test("never throws: a failing alert writer and a failing store both resolve to a result", async () => {
    const boom = setup(async () => {
      throw new Error("redis down");
    });
    const res = await boom.ch.report("launch:quota_stretch", {});
    assert.equal(res.delivered, true);
    assert.equal(res.alertWritten, false);
    const rejecting = new OperatorChannel({
      store: memoryStore("reject").store,
      transport: async () => {
        throw new Error("net down");
      },
      alerts: async () => true,
    });
    await assert.doesNotReject(rejecting.report("consumer:dead", { consumer: "x" }));
    await assert.doesNotReject(rejecting.report("cycle:completed", {}));
  });
});
