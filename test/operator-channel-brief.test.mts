/**
 * Morning Brief tests (ADR-0045 Decision 7, issue #5047).
 *
 * Stub-only: an in-memory store, an injected clock and a capturing transport —
 * no Redis, no `gh`, no Telegram. Covers the pure `briefDue` predicate, the
 * restart-proof scheduler (two instances over one store), the exhaustive
 * line-renderer map, the HTML renderer and the section assembler's
 * best-effort degradation.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { briefDue, localParts } from "../src/operator-channel/brief.ts";
import {
  BRIEF_KINDS,
  BRIEF_LINE_RENDERERS,
  renderBriefLine,
} from "../src/operator-channel/brief-lines.ts";
import { renderBrief } from "../src/operator-channel/brief-render.ts";
import {
  BriefScheduler,
  BRIEF_RETRY_BACKOFF_MS,
  type BriefStore,
} from "../src/operator-channel/brief-scheduler.ts";
import { collectBriefSections } from "../src/operator-channel/brief-sources.ts";
import { PAGE_KINDS } from "../src/operator-channel/page-list.ts";
import { NOTIFICATION_EVENT_TYPES } from "../src/event-bus-vocabulary.ts";
import type { DeliveryLogEntry } from "../src/redis/operator-channel.ts";

/** Local-time epoch ms (the brief reads the process TZ). */
const at = (y: number, mo: number, d: number, h: number, mi: number) =>
  new Date(y, mo - 1, d, h, mi, 0, 0).getTime();

function memoryStore(initial: number | null = null) {
  const state = { lastSent: initial, log: [] as DeliveryLogEntry[] };
  const store: BriefStore = {
    getLastSent: async () => state.lastSent,
    setLastSent: async (t) => {
      state.lastSent = t;
    },
    appendLog: async (e) => {
      state.log.push(e);
    },
  };
  return { state, store };
}

function makeScheduler(opts: {
  store: BriefStore;
  clock: { t: number };
  transport?: (text: string) => Promise<any>;
  sent?: string[];
}) {
  const sent = opts.sent ?? [];
  return new BriefScheduler({
    store: opts.store,
    now: () => opts.clock.t,
    transport:
      opts.transport ??
      (async (text: string) => {
        sent.push(text);
        return { ok: true, mode: "html" };
      }),
    // All sections empty: the brief must still be sent.
    collect: async () => [],
  });
}

describe("briefDue — pure predicate", () => {
  const day = (h: number, m: number) => localParts(at(2026, 10, 20, h, m));

  test("false before 07:30, true from 07:30 when never sent", () => {
    assert.equal(briefDue(day(7, 29), null), false);
    assert.equal(briefDue(day(7, 30), null), true);
    assert.equal(briefDue(day(23, 59), null), true);
  });

  test("a brief already sent today is never re-sent", () => {
    assert.equal(briefDue(day(9, 0), at(2026, 10, 20, 7, 31)), false);
    assert.equal(briefDue(day(23, 0), at(2026, 10, 20, 0, 5)), false);
  });

  test("a stamp from an earlier local date catches up at the first tick after 07:30", () => {
    assert.equal(briefDue(day(12, 0), at(2026, 10, 19, 7, 31)), true);
    assert.equal(briefDue(day(7, 29), at(2026, 10, 19, 7, 31)), false);
  });
});

describe("BriefScheduler — Redis-keyed timing", () => {
  test("ticks at 07:29/07:30/07:31 send exactly once; a second instance over the same store does not duplicate", async () => {
    const { store, state } = memoryStore();
    const clock = { t: at(2026, 10, 20, 7, 29) };
    const sent: string[] = [];
    const a = makeScheduler({ store, clock, sent });
    assert.equal(await a.tick(), null, "07:29 is not due");
    clock.t = at(2026, 10, 20, 7, 30);
    const r = await a.tick();
    assert.equal(r?.sent, true);
    clock.t = at(2026, 10, 20, 7, 31);
    assert.equal(await a.tick(), null, "already sent today");

    // "Restart": a brand-new scheduler over the same store.
    const b = makeScheduler({ store, clock, sent });
    clock.t = at(2026, 10, 20, 7, 32);
    assert.equal(await b.tick(), null, "a restart does not duplicate");
    assert.equal(sent.length, 1);
    assert.equal(state.lastSent, at(2026, 10, 20, 7, 30));
  });

  test("a store holding yesterday's stamp, started at 12:00, sends immediately (catch-up)", async () => {
    const { store } = memoryStore(at(2026, 10, 19, 7, 31));
    const clock = { t: at(2026, 10, 20, 12, 0) };
    const sent: string[] = [];
    const s = makeScheduler({ store, clock, sent });
    const r = await s.tick();
    assert.equal(r?.sent, true);
    assert.equal(sent.length, 1);
  });

  test("is sent even when every section is empty, and logged with kind 'brief'", async () => {
    const { store, state } = memoryStore();
    const clock = { t: at(2026, 10, 20, 8, 0) };
    const sent: string[] = [];
    await makeScheduler({ store, clock, sent }).tick();
    assert.equal(sent.length, 1);
    assert.match(sent[0], /Hydra Morning Brief/);
    assert.equal(state.log.length, 1);
    assert.equal(state.log[0].kind, "brief");
    assert.equal(state.log[0].outcome, "sent-html");
  });

  test("last-sent is stamped only after the transport reports ok; a failure is retried after the back-off", async () => {
    const { store, state } = memoryStore();
    const clock = { t: at(2026, 10, 20, 8, 0) };
    let ok = false;
    let calls = 0;
    const s = makeScheduler({
      store,
      clock,
      transport: async () => {
        calls++;
        return ok ? { ok: true, mode: "plain" } : { ok: false, reason: "http", status: 500 };
      },
    });
    const first = await s.tick();
    assert.equal(first?.sent, false);
    assert.equal(state.lastSent, null, "a failed send must not stamp last-sent");
    assert.equal(state.log[0].outcome, "failed");

    clock.t += 60_000;
    assert.equal(await s.tick(), null, "inside the retry back-off");
    assert.equal(calls, 1);

    ok = true;
    clock.t += BRIEF_RETRY_BACKOFF_MS;
    const retry = await s.tick();
    assert.equal(retry?.sent, true);
    assert.equal(retry?.outcome, "sent-plain");
    assert.equal(state.lastSent, clock.t);
  });

  test("sendNow stamps last-sent, so it counts as today's brief", async () => {
    const { store, state } = memoryStore();
    const clock = { t: at(2026, 10, 20, 6, 0) };
    const s = makeScheduler({ store, clock });
    const r = await s.sendNow();
    assert.equal(r.sent, true);
    assert.equal(state.lastSent, clock.t);
    clock.t = at(2026, 10, 20, 7, 30);
    assert.equal(await s.tick(), null, "the 07:30 tick does not send a near-duplicate");
  });

  test("an unreadable last-sent stamp skips the tick rather than risking a duplicate", async () => {
    const clock = { t: at(2026, 10, 20, 8, 0) };
    const sent: string[] = [];
    const s = makeScheduler({
      store: {
        getLastSent: async () => {
          throw new Error("redis down");
        },
        setLastSent: async () => {},
        appendLog: async () => {},
      },
      clock,
      sent,
    });
    assert.equal(await s.tick(), null);
    assert.equal(sent.length, 0);
  });
});

describe("BRIEF_KINDS — every brief-severity type renders a line", () => {
  test("BRIEF_KINDS is the vocabulary minus the closed page list", () => {
    const expected = Object.values(NOTIFICATION_EVENT_TYPES)
      .filter((k) => !(PAGE_KINDS as readonly string[]).includes(k))
      .sort();
    assert.deepEqual([...BRIEF_KINDS].sort(), expected);
    assert.ok(BRIEF_KINDS.length > 0);
  });

  test("the renderer map has exactly one arm per brief kind", () => {
    assert.deepEqual(Object.keys(BRIEF_LINE_RENDERERS).sort(), [...BRIEF_KINDS].sort());
  });

  for (const kind of BRIEF_KINDS) {
    test(`${kind} renders a non-empty line, even with no facts`, () => {
      const line = renderBriefLine({ kind, title: kind, facts: [], at: 1 });
      assert.equal(typeof line, "string");
      assert.ok(line.trim().length > 0, `${kind} rendered blank`);
    });
  }

  test("an on-wire kind outside the vocabulary renders through the generic fallback, never blank", () => {
    const line = renderBriefLine({
      kind: "custom:thing",
      title: "Something happened",
      facts: [{ label: "n", value: "3" }],
      at: 1,
    });
    assert.match(line, /custom:thing/);
    assert.match(line, /Something happened/);
    assert.match(line, /n=3/);
    assert.ok(renderBriefLine({ kind: "x:y", title: "", facts: [], at: 1 }).trim().length > 0);
  });
});

describe("renderBrief — Telegram HTML", () => {
  test("escapes through the single escaper and links items; no Markdown markers", () => {
    const html = renderBrief(
      [
        {
          title: "Overnight <b>",
          lines: ["#1 fix a < b & c", "plain"],
          urls: ["https://example.com/pr/1", undefined],
        },
      ],
      at(2026, 10, 20, 7, 30),
    );
    assert.match(html, /<b>Hydra Morning Brief<\/b>/);
    assert.match(html, /<b>Overnight &lt;b&gt;<\/b>/);
    assert.match(html, /<a href="https:\/\/example.com\/pr\/1">#1 fix a &lt; b &amp; c<\/a>/);
    assert.doesNotMatch(html, /\*[A-Za-z]/);
  });

  test("never exceeds the Telegram limit; dropped lines are counted", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i} ${"x".repeat(60)}`);
    const html = renderBrief([{ title: "Big", lines }], at(2026, 10, 20, 7, 30));
    assert.ok(html.length <= 4000, `length ${html.length}`);
    assert.match(html, /… \+\d+ more lines/);
  });
});

describe("collectBriefSections — best-effort sections", () => {
  const now = at(2026, 10, 19, 7, 30); // a Monday
  const base = {
    now: () => now,
    readBriefItems: async () => [],
    listDedupStates: async () => [],
    getRecentMerges: async () => [],
    listDispatchOutcomes: async () => ({ ok: true as const, records: [] }),
    getAttentionFeed: async () => ({ items: [], buckets: [], scanned: 0, sourcesOk: true }),
    getAutopilotPaused: async () => ({ paused: false }),
    listRecentAutopilotRunIds: async () => [],
    getAutopilotRun: async () => ({}),
    getUsage: async () => ({ calibrated: false }),
    getBuilderHealthScorecard: async () => null,
    buildWeeklySummary: async () => ({ lines: ["Cycles: 3 run"] }),
  };

  test("a failing reader degrades to that section's n/a line and never blocks the others", async () => {
    const sections = await collectBriefSections(
      { lastSentAt: null, includeWeekly: false },
      {
        ...base,
        getRecentMerges: async () => {
          throw new Error("gh down");
        },
        getUsage: async () => {
          throw new Error("meter down");
        },
      } as any,
    );
    const overnight = sections.find((s) => s.title === "Overnight")!;
    assert.deepEqual(overnight.lines, ["n/a (gh down)"]);
    const autopilot = sections.find((s) => s.title === "Autopilot and quota")!;
    assert.ok(autopilot.lines.some((l) => l.startsWith("Usage: n/a (meter down)")));
    assert.ok(sections.length >= 6, "every other section still present");
  });

  test("the weekly summary is appended only when requested (Mondays)", async () => {
    const without = await collectBriefSections({ lastSentAt: null, includeWeekly: false }, base as any);
    assert.equal(without.some((s) => s.title === "Weekly summary"), false);
    const withWeekly = await collectBriefSections({ lastSentAt: null, includeWeekly: true }, base as any);
    assert.deepEqual(withWeekly.at(-1)?.lines, ["Cycles: 3 run"]);
  });

  test("events are filtered by at > lastSentAt and the stored list is never mutated", async () => {
    const stored = [
      { kind: "autopilot-paused", title: "autopilot-paused", facts: [], at: now - 1000, severity: "brief" },
      { kind: "autopilot-resumed", title: "autopilot-resumed", facts: [], at: now - 5000, severity: "brief" },
      { kind: "model-fallback", title: "model-fallback", facts: [], at: now - 10_000, severity: "brief" },
    ];
    const snapshot = JSON.stringify(stored);
    const deps = { ...base, readBriefItems: async () => stored } as any;
    const first = await collectBriefSections({ lastSentAt: now - 6000, includeWeekly: false }, deps);
    const events = first.find((s) => s.title === "Events since the last brief")!;
    assert.deepEqual(events.lines, ["Autopilot resumed", "Autopilot paused"]);
    // Idempotent: a second read over the same list yields the same evidence.
    const second = await collectBriefSections({ lastSentAt: now - 6000, includeWeekly: false }, deps);
    assert.deepEqual(second.find((s) => s.title === "Events since the last brief")!.lines, events.lines);
    assert.equal(JSON.stringify(stored), snapshot);
  });

  test("no last-sent stamp falls back to a 24h window", async () => {
    const stored = [
      { kind: "autopilot-paused", title: "p", facts: [], at: now - 23 * 3600_000 },
      { kind: "autopilot-resumed", title: "r", facts: [], at: now - 25 * 3600_000 },
    ];
    const sections = await collectBriefSections(
      { lastSentAt: null, includeWeekly: false },
      { ...base, readBriefItems: async () => stored } as any,
    );
    assert.deepEqual(sections.find((s) => s.title === "Events since the last brief")!.lines, ["Autopilot paused"]);
  });

  test("pages section lists currently-bad dedup keys with suppressed counts", async () => {
    const sections = await collectBriefSections(
      { lastSentAt: null, includeWeekly: false },
      {
        ...base,
        listDedupStates: async () => [
          { dedupKey: "consumer:dead:notify", state: "bad", firstAt: 1_700_000_000_000, lastSentAt: 1_700_000_000_000, suppressed: 4 },
        ],
      } as any,
    );
    const pages = sections.find((s) => s.title === "Pages")!;
    assert.match(pages.lines[0], /consumer:dead:notify.*4 suppressed/);
  });
});
