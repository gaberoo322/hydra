/**
 * Morning Brief (ADR-0045 Decision 7, issue #5047): the pure `briefDue`
 * predicate, the Redis-keyed scheduler (against an in-memory store + injected
 * clock), the exhaustive brief-line renderer map, the best-effort composer,
 * the HTML renderer, the send path, the send-now route, and the
 * review:pickup_ready Page with its `/hydra-review` action. No Redis, no
 * Telegram, no timers: every reader and the transport are injected.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  BRIEF_KINDS,
  BRIEF_LINE_RENDERERS,
  BriefScheduler,
  OperatorChannel,
  REVIEW_PICKUP_ACTION,
  briefDue,
  briefItemFromStored,
  composeBrief,
  localParts,
  messageFromEvent,
  readBriefSources,
  renderBrief,
  renderBriefLine,
  sendMorningBrief,
  type BriefItem,
  type BriefSources,
  type BriefSourcesDeps,
  type BriefStore,
  type OperatorChannelStore,
} from "../src/operator-channel/index.ts";
import { PAGE_KINDS } from "../src/operator-channel/page-list.ts";
import { NOTIFICATION_EVENT_TYPES as E } from "../src/event-bus-vocabulary.ts";
import { createOperatorChannelRouter } from "../src/api/operator-channel.ts";
import { runReviewPickupNotify } from "../src/scheduler/chores/review-pickup-notify.ts";
import type { DedupState, DeliveryLogEntry } from "../src/redis/operator-channel.ts";
import type { TelegramTransportFn, TelegramTransportResult } from "../src/notify.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Epoch ms of a LOCAL wall-clock instant (the process TZ, like the scheduler). */
const local = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).getTime();

// 2026-10-19 is a Monday, 2026-10-20 a Tuesday (any TZ: constructed locally).
const MON = (h: number, mi: number) => local(2026, 10, 19, h, mi);
const TUE = (h: number, mi: number) => local(2026, 10, 20, h, mi);
const WED = (h: number, mi: number) => local(2026, 10, 21, h, mi);

function memoryBriefStore(initial: number | null = null, mode: "ok" | "reject" = "ok") {
  let lastSent = initial;
  const store: BriefStore = {
    getLastSent: async () => {
      if (mode === "reject") throw new Error("ECONNREFUSED");
      return lastSent;
    },
    setLastSent: async (ms) => {
      if (mode === "reject") throw new Error("ECONNREFUSED");
      lastSent = ms;
    },
  };
  return { store, peek: () => lastSent };
}

function clock(start: number) {
  let t = start;
  return { now: () => t, set: (ms: number) => void (t = ms) };
}

/** A send stub whose outcome sequence is scripted; records every call. */
function scriptedSend(outcomes: boolean[], nowRef: () => number) {
  const calls: Array<number | null> = [];
  let i = 0;
  const send = async ({ lastSentAt }: { lastSentAt: number | null }) => {
    calls.push(lastSentAt);
    const ok = outcomes[Math.min(i++, outcomes.length - 1)];
    return { ok, outcome: ok ? ("sent-html" as const) : ("failed" as const), at: nowRef() };
  };
  return { send, calls };
}

function fakeTransport(result: TelegramTransportResult = { ok: true, mode: "HTML" }) {
  const sent: string[] = [];
  const transport: TelegramTransportFn = async (text) => {
    sent.push(text);
    return result;
  };
  return { transport, sent };
}

function item(kind: string, at: number, facts: Record<string, string> = {}, title = kind): BriefItem {
  return {
    severity: "brief",
    kind,
    title,
    facts: Object.entries(facts).map(([label, value]) => ({ label, value })),
    links: [],
    dedupKey: kind,
    at,
  };
}

/** Every reader stubbed to a healthy, mostly-empty answer; override per case. */
function healthyDeps(over: Partial<BriefSourcesDeps> = {}): BriefSourcesDeps {
  return {
    getRecentMerges: async () => [],
    listDispatchOutcomes: async () => ({ ok: true, records: [] }),
    getAttentionFeed: async () => ({ items: [], buckets: [], scanned: 0, sourcesOk: true }),
    getAutopilotPaused: async () => ({ paused: false }),
    listRecentAutopilotRunIds: async () => [],
    getAutopilotRun: async () => ({}),
    getUsage: async () => ({ calibrated: false }),
    getBuilderHealthScorecard: async () => null,
    readBriefItems: async () => [],
    listDedupStates: async () => [],
    buildWeeklySummary: async () => null,
    ...over,
  };
}

function throwingDeps(): BriefSourcesDeps {
  const boom = async () => {
    throw new Error("boom");
  };
  return {
    getRecentMerges: boom,
    listDispatchOutcomes: boom,
    getAttentionFeed: boom,
    getAutopilotPaused: boom,
    listRecentAutopilotRunIds: boom,
    getAutopilotRun: boom,
    getUsage: boom,
    getBuilderHealthScorecard: boom,
    readBriefItems: boom,
    listDedupStates: boom,
    buildWeeklySummary: boom,
  };
}

// ---------------------------------------------------------------------------
// briefDue — pure
// ---------------------------------------------------------------------------

describe("briefDue (pure)", () => {
  test("not due before 07:30 local, even with no last-sent key", () => {
    assert.equal(briefDue(localParts(TUE(7, 29)), null), false);
    assert.equal(briefDue(localParts(TUE(0, 0)), null), false);
  });

  test("due at 07:30 local when no brief was ever sent (absent key)", () => {
    assert.equal(briefDue(localParts(TUE(7, 30)), null), true);
    assert.equal(briefDue(localParts(TUE(23, 59)), null), true);
  });

  test("a brief already sent today is never re-sent", () => {
    assert.equal(briefDue(localParts(TUE(12, 0)), TUE(7, 31)), false);
    // A send-now before 07:30 counts as today's brief too.
    assert.equal(briefDue(localParts(TUE(7, 30)), TUE(6, 0)), false);
  });

  test("a missed 07:30 catches up at the first later tick (yesterday's stamp, 12:00 today)", () => {
    assert.equal(briefDue(localParts(TUE(12, 0)), MON(7, 30)), true);
    assert.equal(briefDue(localParts(TUE(7, 30)), MON(23, 59)), true);
  });

  test("localParts reads the process TZ and a comparable YYYY-MM-DD date key", () => {
    const p = localParts(TUE(7, 30));
    assert.deepEqual({ hour: p.hour, minute: p.minute, dateKey: p.dateKey, weekday: p.weekday }, {
      hour: 7,
      minute: 30,
      dateKey: "2026-10-20",
      weekday: 2,
    });
    assert.ok(localParts(MON(23, 59)).dateKey < localParts(TUE(0, 0)).dateKey);
  });
});

// ---------------------------------------------------------------------------
// BriefScheduler — Redis-keyed timing state, injected store + clock
// ---------------------------------------------------------------------------

describe("BriefScheduler — timing state lives in the store, not the instance", () => {
  test("two scheduler instances over one injected store + clock send exactly once per local day", async () => {
    const { store, peek } = memoryBriefStore();
    const c = clock(TUE(7, 29));
    const { send, calls } = scriptedSend([true], c.now);
    const a = new BriefScheduler({ store, now: c.now, send });
    const b = new BriefScheduler({ store, now: c.now, send }); // "the restarted process"

    assert.equal(await a.tick(), "not-due");
    assert.equal(await b.tick(), "not-due");
    c.set(TUE(7, 30));
    assert.equal(await a.tick(), "sent");
    assert.equal(await b.tick(), "not-due", "the second instance sees the store's stamp, not its own memory");
    c.set(TUE(7, 31));
    assert.equal(await a.tick(), "not-due");
    assert.equal(await b.tick(), "not-due");
    assert.equal(peek(), TUE(7, 30));
    c.set(WED(7, 30));
    assert.equal(await b.tick(), "sent", "the other instance sends tomorrow's brief");
    assert.equal(calls.length, 2);
    assert.deepEqual(calls, [null, TUE(7, 30)], "the send receives the previous stamp as the items window");
  });

  test("a store with yesterday's stamp started at 12:00 sends immediately (catch-up after downtime)", async () => {
    const { store } = memoryBriefStore(MON(7, 30));
    const c = clock(TUE(12, 0));
    const { send } = scriptedSend([true], c.now);
    assert.equal(await new BriefScheduler({ store, now: c.now, send }).tick(), "sent");
  });

  test("last-sent is stamped only after the transport reports ok; a failed send is retried on the next tick", async () => {
    const { store, peek } = memoryBriefStore();
    const c = clock(TUE(7, 30));
    const { send, calls } = scriptedSend([false, true], c.now);
    const s = new BriefScheduler({ store, now: c.now, send });
    assert.equal(await s.tick(), "failed");
    assert.equal(peek(), null, "no stamp after a failed transport");
    c.set(TUE(7, 35));
    assert.equal(await s.tick(), "sent");
    assert.equal(peek(), TUE(7, 35));
    assert.equal(calls.length, 2);
  });

  test("an unreadable store leaves the brief for the next tick and never sends blind", async () => {
    const { store } = memoryBriefStore(null, "reject");
    const c = clock(TUE(9, 0));
    const { send, calls } = scriptedSend([true], c.now);
    assert.equal(await new BriefScheduler({ store, now: c.now, send }).tick(), "store-unavailable");
    assert.equal(calls.length, 0);
  });

  test("a tick while a send is in flight reports in-flight (one send per process at a time)", async () => {
    const { store } = memoryBriefStore();
    const c = clock(TUE(7, 30));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const send = async () => {
      await gate;
      return { ok: true, outcome: "sent-html" as const, at: c.now() };
    };
    const s = new BriefScheduler({ store, now: c.now, send });
    const first = s.tick();
    assert.equal(await s.tick(), "in-flight");
    release();
    assert.equal(await first, "sent");
  });

  test("sendNow sends regardless of the 07:30 gate and stamps last-sent, so the scheduled send is skipped", async () => {
    const { store, peek } = memoryBriefStore();
    const c = clock(TUE(6, 0));
    const { send, calls } = scriptedSend([true], c.now);
    const s = new BriefScheduler({ store, now: c.now, send });
    const out = await s.sendNow();
    assert.deepEqual(out, { sent: true, outcome: "sent-html", at: TUE(6, 0) });
    assert.equal(peek(), TUE(6, 0));
    c.set(TUE(7, 30));
    assert.equal(await s.tick(), "not-due", "send-now counted as today's brief");
    assert.equal(calls.length, 1);
  });

  test("a failed sendNow reports sent:false and leaves last-sent untouched", async () => {
    const { store, peek } = memoryBriefStore(MON(7, 30));
    const c = clock(TUE(6, 0));
    const { send } = scriptedSend([false], c.now);
    const out = await new BriefScheduler({ store, now: c.now, send }).sendNow();
    assert.equal(out.sent, false);
    assert.equal(peek(), MON(7, 30));
  });
});

// ---------------------------------------------------------------------------
// BRIEF_KINDS + BRIEF_LINE_RENDERERS — exhaustive by construction
// ---------------------------------------------------------------------------

describe("BRIEF_KINDS and BRIEF_LINE_RENDERERS", () => {
  test("BRIEF_KINDS is every NOTIFICATION_EVENT_TYPES value not on PAGE_KINDS", () => {
    const pages = new Set<string>(PAGE_KINDS);
    const expected = Object.values(E).filter((v) => !pages.has(v)).sort();
    assert.deepEqual([...BRIEF_KINDS].sort(), expected);
    assert.ok(BRIEF_KINDS.includes(E.CYCLE_COMPLETED as never));
    assert.ok(!(BRIEF_KINDS as readonly string[]).includes(E.HOLDBACK_REVERT_FAILED), "a page kind is not a brief kind");
  });

  test("every brief kind has a renderer arm (the map's keys equal BRIEF_KINDS)", () => {
    assert.deepEqual(Object.keys(BRIEF_LINE_RENDERERS).sort(), [...BRIEF_KINDS].sort());
  });

  for (const kind of BRIEF_KINDS) {
    test(`renders a non-empty, title-bearing line for ${kind}`, () => {
      const line = BRIEF_LINE_RENDERERS[kind](item(kind, 1, {}, `${kind} title`));
      assert.equal(typeof line, "string");
      assert.ok(line.trim().length > 0, `${kind} rendered an empty line`);
      assert.match(line, /[A-Za-z]{3,}/, `${kind} line carries no words`);
      assert.equal(renderBriefLine(item(kind, 1, {}, `${kind} title`)), line, "renderBriefLine uses the typed arm");
    });
  }

  test("an on-wire kind outside the vocabulary renders through the generic fallback and is never blank", () => {
    const line = renderBriefLine(item("custom:thing", 5, { a: "1", b: "x" }, "Custom title"));
    assert.ok(line.length > 0);
    assert.ok(line.includes("custom:thing"), "names the kind");
    assert.ok(line.includes("Custom title"), "carries the title");
    assert.ok(line.includes("a=1") && line.includes("b=x"), "carries the facts");
    assert.ok(renderBriefLine(item("bare:kind", 5)).length > 0);
  });

  test("renderers read facts: a merged cycle names its title and short sha", () => {
    const line = renderBriefLine(item(E.CYCLE_COMPLETED, 1, { merged: "true", title: "Add X", commitSha: "deadbeefcafe" }));
    assert.equal(line, "Cycle merged: Add X (deadbee)");
  });

  test("briefItemFromStored tolerates corrupt rows and reads the channel's stored shape", () => {
    assert.equal(briefItemFromStored(null), null);
    assert.equal(briefItemFromStored({ kind: "x" }), null, "no `at`");
    assert.equal(briefItemFromStored({ at: 1 }), null, "no kind");
    const parsed = briefItemFromStored({
      severity: "brief",
      kind: "cycle:completed",
      title: "t",
      facts: [{ label: "merged", value: "true" }],
      links: [],
      dedupKey: "cycle:completed",
      at: 42,
    });
    assert.equal(parsed?.at, 42);
    assert.equal(parsed?.facts[0].value, "true");
  });
});

// ---------------------------------------------------------------------------
// Sources + composition — best-effort, idempotent reads
// ---------------------------------------------------------------------------

describe("readBriefSources / composeBrief", () => {
  test("brief items are read filtered by at > lastSentAt and the list is never drained (a second read sees the same items)", async () => {
    const stored = [item("cycle:completed", 30), item("dlq:entry", 20), item("cycle:completed", 10)];
    let reads = 0;
    const deps = healthyDeps({
      readBriefItems: async () => {
        reads++;
        return stored;
      },
    });
    const a = await readBriefSources({ sinceMs: 10, includeWeekly: false, deps });
    const b = await readBriefSources({ sinceMs: 10, includeWeekly: false, deps });
    assert.equal(a.items.ok, true);
    assert.deepEqual((a.items as { value: BriefItem[] }).value.map((i) => i.at), [30, 20], "at === lastSentAt is excluded");
    assert.deepEqual(b.items, a.items, "idempotent: nothing was consumed between reads");
    assert.equal(reads, 2);
    assert.equal(stored.length, 3, "the source list is untouched");
  });

  test("a failing reader degrades to that section's single n/a line and never blocks the send", async () => {
    const { transport, sent } = fakeTransport();
    const log: DeliveryLogEntry[] = [];
    const res = await sendMorningBrief({
      lastSentAt: MON(7, 30),
      deps: { now: () => TUE(7, 30), transport, appendLog: async (e) => void log.push(e), sources: throwingDeps() },
    });
    assert.equal(res.ok, true);
    assert.equal(sent.length, 1);
    const text = sent[0];
    for (const label of ["Merges", "QA", "Items", "Autopilot", "Usage", "Scorecard", "Events", "Open pages"]) {
      assert.ok(text.includes(`${label}: n/a (boom)`), `missing n/a line for ${label}`);
    }
    assert.equal((text.match(/n\/a \(boom\)/g) ?? []).length, 8, "one n/a line per failed reader");
    assert.deepEqual(log.map((e) => e.kind), ["brief"]);
  });

  test("waiting-on-you items carry the registry-resolved recommended action and a link", async () => {
    const deps = healthyDeps({
      getAttentionFeed: async () => ({
        scanned: 1,
        sourcesOk: true,
        buckets: [],
        items: [
          {
            id: "i1",
            signal: "issues-waiting",
            title: "Decide tier for PR #710",
            url: "https://x/710",
            observedValue: 1,
            threshold: 1,
            thresholdLabel: "1",
            crossedAt: "2026-10-20T00:00:00.000Z",
            dismissed: false,
            bucket: "waiting-on-you",
            rank: 2,
            key: "waiting-on-you:ready-for-human",
            action: {
              key: "waiting-on-you:ready-for-human",
              recommended: { kind: "terminal-skill", command: "/hydra-review", label: "Classify", preconditions: [], consequence: "c" },
              alternatives: [],
              rationale: "r",
              doc: "d",
            },
          },
          {
            id: "i2",
            signal: "issues-waiting",
            title: "Dismissed one",
            url: "https://x/1",
            observedValue: 1,
            threshold: 1,
            thresholdLabel: "1",
            crossedAt: "2026-10-20T00:00:00.000Z",
            dismissed: true,
            bucket: "waiting-on-you",
            rank: 2,
            key: "waiting-on-you:ready-for-human",
            action: {
              key: "waiting-on-you:ready-for-human",
              recommended: { kind: "terminal-skill", command: "/hydra-review", label: "Classify", preconditions: [], consequence: "c" },
              alternatives: [],
              rationale: "r",
              doc: "d",
            },
          },
        ] as any,
      }),
    });
    const sources = await readBriefSources({ sinceMs: 0, includeWeekly: false, deps });
    const model = composeBrief(sources, { now: TUE(7, 30), lastSentAt: null });
    const waiting = model.sections.find((s) => s.heading.startsWith("Waiting on you"))!;
    assert.equal(waiting.heading, "Waiting on you (1)", "dismissed items are excluded");
    assert.deepEqual(waiting.lines, ["Decide tier for PR #710 → /hydra-review"]);
    assert.deepEqual(waiting.links, [{ label: "Decide tier for PR #710", url: "https://x/710" }]);
  });

  test("overnight counts merges since the window and QA verdicts by outcome; pages list bad keys with suppressed counts", async () => {
    const deps = healthyDeps({
      getRecentMerges: async () => [
        { prNumber: 2, title: "new", tier: 3, classLabel: null, mergedAt: new Date(TUE(3, 0)).toISOString(), url: "https://x/2" },
        { prNumber: 1, title: "old", tier: 3, classLabel: null, mergedAt: new Date(MON(3, 0)).toISOString(), url: "https://x/1" },
      ],
      listDispatchOutcomes: async () => ({
        ok: true,
        records: [
          { className: "qa_orch", outcome: "completed" },
          { className: "qa_orch", outcome: "completed" },
          { className: "qa_target", outcome: "failed" },
          { className: "dev_orch", outcome: "merged" },
        ] as any,
      }),
      listDedupStates: async () => [{ dedupKey: "infra:x", state: "bad", firstAt: MON(1, 0), lastSentAt: MON(1, 0), suppressed: 4 }],
    });
    const sources = await readBriefSources({ sinceMs: MON(7, 30), includeWeekly: false, deps });
    const model = composeBrief(sources, { now: TUE(7, 30), lastSentAt: MON(7, 30) });
    const overnight = model.sections.find((s) => s.heading === "Overnight")!;
    assert.deepEqual(overnight.lines, ["Merges: 1", "QA: 2 completed, 1 failed"]);
    assert.deepEqual(overnight.links, [{ label: "#2 new", url: "https://x/2" }]);
    const pages = model.sections.find((s) => s.heading.startsWith("Pages"))!;
    assert.equal(pages.heading, "Pages (1 open)");
    assert.match(pages.lines[0], /^infra:x: still bad since .*, 4 suppressed$/);
  });

  test("the brief is sent even when every section is empty", async () => {
    const { transport, sent } = fakeTransport();
    const res = await sendMorningBrief({
      lastSentAt: null,
      deps: { now: () => TUE(7, 30), transport, appendLog: async () => {}, sources: healthyDeps() },
    });
    assert.equal(res.ok, true);
    assert.equal(sent.length, 1);
    assert.ok(sent[0].includes("Merges: 0"));
    assert.ok(sent[0].includes("no open pages"));
    assert.ok(sent[0].includes("nothing to report"));
    assert.ok(sent[0].includes("since the last 24h"), "absent key reads a 24h window");
  });

  test("Monday appends the weekly summary section; other days do not", async () => {
    const calls: number[] = [];
    const sources = healthyDeps({
      buildWeeklySummary: async () => {
        calls.push(1);
        return { lines: ["Cycles: 3 run — 2 merged", "Fix:Feature ratio: 1:2 (0.5:1)"] };
      },
    });
    const { transport, sent } = fakeTransport();
    await sendMorningBrief({ lastSentAt: null, deps: { now: () => MON(7, 30), transport, appendLog: async () => {}, sources } });
    await sendMorningBrief({ lastSentAt: null, deps: { now: () => TUE(7, 30), transport, appendLog: async () => {}, sources } });
    assert.equal(calls.length, 1, "the weekly reader runs on Monday only");
    assert.ok(sent[0].includes("<b>Weekly summary</b>"));
    assert.ok(sent[0].includes("Cycles: 3 run — 2 merged"));
    assert.ok(!sent[1].includes("Weekly summary"));
  });

  test("every send is logged with kind brief; a transport failure logs failed with its status and reports ok:false", async () => {
    const log: DeliveryLogEntry[] = [];
    const appendLog = async (e: DeliveryLogEntry) => void log.push(e);
    const okRes = await sendMorningBrief({
      lastSentAt: null,
      deps: { now: () => TUE(7, 30), transport: fakeTransport({ ok: true, mode: "plain" }).transport, appendLog, sources: healthyDeps() },
    });
    const badRes = await sendMorningBrief({
      lastSentAt: null,
      deps: { now: () => TUE(7, 31), transport: fakeTransport({ ok: false, status: 502, error: "bad gateway" }).transport, appendLog, sources: healthyDeps() },
    });
    assert.deepEqual([okRes.ok, okRes.outcome], [true, "sent-plain"]);
    assert.deepEqual([badRes.ok, badRes.outcome], [false, "failed"]);
    assert.deepEqual(
      log.map((e) => [e.kind, e.dedupKey, e.outcome, e.status]),
      [
        ["brief", "morning-brief", "sent-plain", undefined],
        ["brief", "morning-brief", "failed", 502],
      ],
    );
  });
});

// ---------------------------------------------------------------------------
// HTML rendering — one escaper, no Markdown, bounded size
// ---------------------------------------------------------------------------

describe("renderBrief (Telegram HTML)", () => {
  test("the brief and the Monday weekly section are Telegram HTML through escapeHtml with no Markdown", async () => {
    const sources = healthyDeps({
      readBriefItems: async () => [item("custom:kind", MON(7, 0), { note: "<b>&</b> *bold* _it_" }, "T <x>")],
      buildWeeklySummary: async () => ({ lines: ["Milestone: a & b <c>"] }),
    });
    const { transport, sent } = fakeTransport();
    await sendMorningBrief({ lastSentAt: null, deps: { now: () => MON(7, 30), transport, appendLog: async () => {}, sources } });
    const text = sent[0];
    assert.ok(text.includes("&lt;b&gt;&amp;&lt;/b&gt; *bold* _it_"), "item facts are escaped, not interpreted");
    assert.ok(text.includes("a &amp; b &lt;c&gt;"), "weekly lines are escaped");
    assert.ok(text.includes("☀️ <b>Hydra Morning Brief — Mon 2026-10-19</b>"));
    // Outside the fixed tags, no raw '<' and no bare '&' survive.
    const stripped = text.replace(/<\/?(b|i|code|a)( href="[^"<>]*")?>/g, "");
    assert.ok(!stripped.includes("<"), "a raw < leaked");
    assert.ok(!/&(?!amp;|lt;|gt;)/.test(stripped), "a bare & leaked");
    assert.ok(!/\*Hydra|_Period/.test(text), "no legacy Markdown markers");
  });

  test("a rendered brief never exceeds 4000 characters; the busiest section is trimmed with a +N more marker", () => {
    const many = Array.from({ length: 400 }, (_, i) => `event line number ${i} with some padding text to make it long enough`);
    const text = renderBrief({
      dateLabel: "Tue 2026-10-20",
      sinceLabel: "x",
      sections: [
        { heading: "A", lines: ["one"] },
        { heading: "Events", lines: many },
      ],
    });
    assert.ok(text.length <= 4000, `rendered ${text.length} chars`);
    assert.match(text, /… \+\d+ more/);
    assert.ok(text.includes("<b>A</b>\n• one"), "the small section is intact");
  });

  test("links render as <a> only for http(s) URLs; anything else is escaped plain text", () => {
    const text = renderBrief({
      dateLabel: "d",
      sinceLabel: "s",
      sections: [{ heading: "L", lines: [], links: [{ label: "ok", url: "https://x/1" }, { label: "bad", url: 'javascript:"x"' }] }],
    });
    assert.ok(text.includes('<a href="https://x/1">ok</a>'));
    assert.ok(text.includes('bad: javascript:"x"'));
    assert.ok(!text.includes("<a href=\"javascript"));
  });
});

// ---------------------------------------------------------------------------
// review:pickup_ready — a Page with the /hydra-review action, resolved on drain
// ---------------------------------------------------------------------------

function memoryStore() {
  const dedup = new Map<string, DedupState>();
  const briefs: Record<string, unknown>[] = [];
  const log: DeliveryLogEntry[] = [];
  const store: OperatorChannelStore = {
    readDedup: async (k) => dedup.get(k) ?? null,
    writeDedup: async (k, s) => void dedup.set(k, { ...s }),
    incrSuppressed: async (k) => {
      const s = dedup.get(k);
      if (s) s.suppressed += 1;
    },
    delDedup: async (k) => void dedup.delete(k),
    appendBrief: async (i) => void briefs.push(i),
    appendLog: async (e) => void log.push(e),
  };
  return { store, dedup, briefs, log };
}

describe("review:pickup_ready reaches the operator as an actionable Page", () => {
  const payload = { count: 3, firstTitle: "Decide tier for PR #710", firstUrl: "https://x/710", firstNumber: 710 };

  test("messageFromEvent stamps the waiting-on-you:ready-for-human action and links the first pickup item", () => {
    const msg = messageFromEvent({ type: E.REVIEW_PICKUP_READY, payload });
    assert.equal(msg.severity, "page");
    assert.equal(msg.dedupKey, "review:pickup_ready");
    assert.deepEqual(msg.action, { name: REVIEW_PICKUP_ACTION });
    assert.equal(REVIEW_PICKUP_ACTION, "waiting-on-you:ready-for-human");
    assert.equal(msg.title, "3 items need your review");
    assert.deepEqual(msg.links, [{ label: "Decide tier for PR #710", url: "https://x/710" }]);
    assert.equal(messageFromEvent({ type: E.REVIEW_PICKUP_READY, payload: { count: 1 } }).title, "1 item needs your review");
  });

  test("the rendered page carries Action: /hydra-review and a link to the first pickup item", async () => {
    const { store } = memoryStore();
    const { transport, sent } = fakeTransport();
    const ch = new OperatorChannel({ store, transport, now: () => TUE(8, 0) });
    const res = await ch.page(messageFromEvent({ type: E.REVIEW_PICKUP_READY, payload }));
    assert.deepEqual(res, { sent: true, kind: "page" });
    assert.ok(sent[0].includes("Action: <code>/hydra-review</code>"), sent[0]);
    assert.ok(sent[0].includes('<a href="https://x/710">Decide tier for PR #710</a>'), sent[0]);
    assert.ok(sent[0].startsWith("🚨 <b>3 items need your review</b>"));
  });

  test("the chore resolves review:pickup_ready when the set drains, so the next empty->non-empty edge is a fresh page", async () => {
    const { store } = memoryStore();
    const { transport, sent } = fakeTransport();
    const c = clock(TUE(8, 0));
    const ch = new OperatorChannel({ store, transport, now: c.now });
    const bus = {
      async publish(_stream: string, ev: any) {
        // Stand in for the notification consumer's recordEvent routing.
        await ch.page(messageFromEvent(ev));
        return "id";
      },
    };
    let notified = false;
    const deps = {
      getNotified: async () => notified,
      setNotified: async () => void (notified = true),
      clearNotified: async () => void (notified = false),
      channel: ch,
    };
    const items = [{ number: 1, title: "A", url: "https://x/1", source: "ready-for-human" as const, sources: ["ready-for-human" as const] }];

    await runReviewPickupNotify(bus, { ...deps, getPickupSet: async () => items }); // fires -> page
    c.set(TUE(9, 0));
    const drained = await runReviewPickupNotify(bus, { ...deps, getPickupSet: async () => [] }); // drains -> resolve
    assert.equal(drained.transitioned, true);
    c.set(TUE(10, 0)); // well inside the 6h reminder window
    await runReviewPickupNotify(bus, { ...deps, getPickupSet: async () => items }); // fires again -> fresh page

    assert.equal(sent.length, 3, "page, recovered, page");
    assert.ok(sent[0].startsWith("🚨"));
    assert.ok(sent[1].startsWith("✅ recovered —"));
    assert.ok(sent[2].startsWith("🚨"), "a fresh page, not a 🔁 still-failing reminder or a suppression");
    assert.equal((await store.readDedup("review:pickup_ready"))?.suppressed, 0, "a fresh episode, nothing suppressed");
  });

  test("the drain edge calls channel.resolve with the review:pickup_ready dedup key exactly once", async () => {
    const resolved: string[] = [];
    let notified = true;
    const out = await runReviewPickupNotify({ publish: async () => "id" }, {
      getPickupSet: async () => [],
      getNotified: async () => notified,
      setNotified: async () => void (notified = true),
      clearNotified: async () => void (notified = false),
      channel: { resolve: async (k: string) => (resolved.push(k), { sent: false as const, reason: "not-bad" as const }) },
    });
    assert.deepEqual(resolved, ["review:pickup_ready"]);
    assert.equal(out.transitioned, true);
    assert.equal(notified, false);
  });
});

// ---------------------------------------------------------------------------
// POST /operator-channel/brief/send
// ---------------------------------------------------------------------------

function findHandler(router: any, method: string, path: string): Function | null {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path && layer.route.methods[method.toLowerCase()]) {
      const stack = layer.route.stack;
      return stack[stack.length - 1].handle;
    }
  }
  return null;
}

function mockRes(): any {
  const res: any = {
    _status: 200,
    _body: null,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(body: any) {
      res._body = body;
      return res;
    },
  };
  return res;
}

describe("POST /operator-channel/brief/send", () => {
  test("returns {sent, outcome, at} from the injected send-now", async () => {
    const router = createOperatorChannelRouter({
      sendBriefNow: async () => ({ sent: true, outcome: "sent-html", at: 123 }),
    });
    const handler = findHandler(router, "POST", "/operator-channel/brief/send");
    assert.ok(handler, "route registered");
    const res = mockRes();
    await handler!({ method: "POST", url: "/operator-channel/brief/send", headers: {}, query: {}, params: {}, body: {} }, res);
    assert.equal(res._status, 200);
    assert.deepEqual(res._body, { sent: true, outcome: "sent-html", at: 123 });
  });

  test("a throwing send-now is isolated to a logged 500 (never-throw route contract)", async () => {
    const router = createOperatorChannelRouter({
      sendBriefNow: async () => {
        throw new Error("boom");
      },
    });
    const res = mockRes();
    await findHandler(router, "POST", "/operator-channel/brief/send")!({ headers: {}, query: {}, params: {}, body: {} }, res);
    assert.equal(res._status, 500);
  });

  test("the retired digest routes are gone", () => {
    const router = createOperatorChannelRouter({ sendBriefNow: async () => ({ sent: false, outcome: "failed", at: 0 }) });
    assert.equal(findHandler(router, "POST", "/digest/send"), null);
    assert.equal(findHandler(router, "POST", "/digest/heartbeat"), null);
  });
});

// Keep the composer's model shape pinned for the renderer contract.
describe("composeBrief model", () => {
  test("sections appear in operator-priority order and the Monday weekly section is last", () => {
    const sources: BriefSources = {
      sinceMs: 0,
      merges: { ok: true, value: [] },
      qa: { ok: true, value: {} },
      waiting: { ok: true, value: [] },
      autopilot: { ok: true, value: { paused: { paused: true, since: MON(1, 0) }, latestRun: { id: "r", status: "ended", startedEpoch: Math.floor(MON(7, 0) / 1000) } } },
      usage: { ok: true, value: { calibrated: true, percentLast5h: 12.4, percentSinceReset: 40.2, emergencyStop: false, weeklyEmergencyStop: true } },
      builderHealth: { ok: true, value: { autonomyRate: { autonomous: 4, total: 5, window: 50 }, stagnation: { signals: { cycleYield: { orch: { state: "breach" }, target: null } }, windowContext: { cycles: 50 } } } },
      items: { ok: true, value: [] },
      pages: { ok: true, value: [] },
      weekly: { ok: true, value: null },
    };
    const model = composeBrief(sources, { now: MON(7, 30), lastSentAt: MON(1, 0) });
    assert.deepEqual(
      model.sections.map((s) => s.heading),
      ["Overnight", "Waiting on you (0)", "Autopilot & quota", "Builder health", "Events since last brief (0)", "Pages (0 open)", "Weekly summary"],
    );
    const ap = model.sections[2].lines;
    assert.match(ap[0], /^Autopilot: PAUSED since .*; last run ended — started 30m ago$/);
    assert.equal(ap[1], "Usage: 5h 12% · weekly 40% 🛑 (caps at 90%)");
    assert.deepEqual(model.sections[3].lines, ["autonomy 4/5 auto-merged (last 50); stagnation 1/1 breached ⚠️, 0 warming (50 cycles)"]);
    assert.deepEqual(model.sections[6].lines, ["no metrics recorded in the last 7 days"]);
    assert.equal(model.dateLabel, "Mon 2026-10-19");
  });
});
