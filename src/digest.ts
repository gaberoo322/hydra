/**
 * Digest Notifications
 *
 * Replaces per-event Telegram messages with periodic summaries.
 * Sends a digest every 4 hours during daytime (7am-10pm).
 *
 * Collects events in memory, then formats a summary covering:
 * - Cycles completed since last digest (merged, failed)
 * - Research cycles run
 * - Test count changes
 * - Backlog/queue state
 * - Action items (empty backlog, stale priorities, errors needing attention)
 *
 * # Pure core vs. orchestration (issue #1181)
 *
 * The pure assembly grammar (`buildDigestMessage`,
 * `formatBuilderHealthLines`) lives in `./digest-format.ts` — no timers, no
 * Telegram calls, no dynamic imports, no module state, and fully testable. The
 * two async fan-out assemblers that fetch their own data live in their own
 * named leaves: `buildDailyHeartbeat` in `./digest-fanout.ts` (issue #2215) and
 * `buildWeeklySummary` in `./digest-weekly.ts` (issue #3394). This module
 * imports each from its leaf and re-exports `buildWeeklySummary` so downstream
 * callers (e.g. `scheduler/chores/weekly-digest.ts`,
 * `scheduler/housekeeping.ts`) need no import changes.
 *
 * # Injectable accumulator seam (issue #1487)
 *
 * The remaining side-effecting surface — event batching, page routing to the Operator Channel,
 * quiet-hours skip, and timer lifecycle — is encapsulated in the
 * `DigestAccumulator` class below. The flush-threshold *policy* itself (the
 * "should we send a digest now?" decision) is lifted out of the class into the
 * pure `shouldSendDigest` predicate (issue #2212), so the accumulator owns only mutable timer/ring state while the
 * policy is independently testable. Its constructor takes injected deps
 * (`now`, `send`, `getCapacity`, `getBuilderHealth`) that default to the real
 * `new Date()` clock / `sendToTelegram` / capacity + builder-health readers,
 * so a unit test can construct a *fresh* accumulator per case with an injected
 * clock and a capturing sender — no module-level state to reset. The five
 * exported functions (`recordEvent`, `startDigest`, `stopDigest`,
 * `sendDigestNow`, `sendDailyHeartbeatNow`) are thin delegators to one default
 * singleton instance, so existing importers need no import-path changes
 * (`interfaceImpact: none`).
 */

import { sendToTelegram, type TelegramSendFn } from "./notify.ts";
import { getCapacitySnapshot, DEFAULT_WINDOW_CYCLES } from "./capacity-floor.ts";
import { getBuilderHealthScorecard } from "./aggregators/builder-health.ts";
import { buildDigestMessage, formatBuilderHealthLines } from "./digest-format.ts";
import {
  operatorChannel,
  messageFromEvent,
  isPageEvent,
  type OperatorChannel,
} from "./operator-channel/index.ts";
import { buildDailyHeartbeat } from "./digest-fanout.ts";
import { buildWeeklySummary } from "./digest-weekly.ts";
import { logger } from "./logger.ts";

// Re-export the pure-core formatters so existing importers of ./digest.ts that
// reach for these (e.g. formatBuilderHealthLines, previously exported here;
// buildWeeklySummary, consumed by src/scheduler/housekeeping.ts) keep working
// without churn.
export { formatBuilderHealthLines, buildWeeklySummary };

const DIGEST_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const QUIET_START_HOUR = 22; // 10pm
const QUIET_END_HOUR = 7; // 7am

/**
 * The verdict of the flush-threshold policy (issue #2212). `send` is the
 * decision; `reason` is a machine-readable tag explaining why — `"send"` when
 * a digest should fire, otherwise the gate that suppressed it.
 */
export interface DigestFlushVerdict {
  send: boolean;
  reason: "send" | "quiet-hours" | "no-events";
}

/**
 * The flush-threshold policy for the batched digest (issue #2212): given the
 * number of accumulated events and the current local hour, decide whether a
 * digest should fire now.
 *
 * This is a **pure predicate** — no clock, no module state, no side effects —
 * so the "when does a digest fire?" decision has a single named home and is
 * testable in isolation: `shouldSendDigest(5, 23)` returns
 * `{ send: false, reason: "quiet-hours" }` with no timer setup, no captured
 * sender, and no full {@link DigestAccumulator} instance.
 *
 * Gate order matches the original inline guards in `sendDigest()`: quiet hours
 * is checked before the empty-batch gate, so a quiet-hours skip reports
 * `"quiet-hours"` even when there are no pending events.
 *
 * Adding a third gate (e.g. "never send when autopilot is paused") is a one-line
 * change here, not an audit of `sendDigest()`'s body.
 */
export function shouldSendDigest(
  pendingCount: number,
  nowHour: number,
): DigestFlushVerdict {
  if (nowHour >= QUIET_START_HOUR || nowHour < QUIET_END_HOUR) {
    return { send: false, reason: "quiet-hours" };
  }
  if (pendingCount === 0) {
    return { send: false, reason: "no-events" };
  }
  return { send: true, reason: "send" };
}

// Daily heartbeat: a guaranteed once-per-day proof-of-life push. Unlike the
// event-gated 4h alert digest above (which stays SILENT when nothing has gone
// wrong), the heartbeat ALWAYS sends — so a dark/AFK operator can distinguish
// "healthy and quiet" from "crashed and not reporting", and gets a daily
// rollup of liveness, subscription-usage %, throughput, and queue depth.
const HEARTBEAT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * A single accumulated event, recorded for the next digest.
 */
interface PendingEvent {
  type: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

/**
 * An inbound event handed to `recordEvent`. `type` discriminates batching vs.
 * page routing; `payload` rides along into the digest grammar.
 */
interface DigestEvent {
  type?: string;
  payload?: Record<string, unknown>;
}

/**
 * Injectable dependencies for {@link DigestAccumulator}. All optional — each
 * defaults to the real side-effecting implementation, so production code
 * constructs the accumulator with `new DigestAccumulator()` and tests inject a
 * deterministic clock + a capturing sender.
 */
export interface DigestAccumulatorDeps {
  /** Wall-clock source. Defaults to `() => new Date()`. */
  now?: () => Date;
  /** Telegram sender. Defaults to `sendToTelegram`. */
  send?: TelegramSendFn;
  /** Capacity-split snapshot reader. Defaults to `getCapacitySnapshot`. */
  getCapacity?: () => Promise<unknown>;
  /** Builder-health scorecard reader. Defaults to `getBuilderHealthScorecard`. */
  getBuilderHealth?: () => Promise<unknown>;
  /** Operator Channel receiving page-kind events and brief items. Defaults to the singleton. */
  channel?: Pick<OperatorChannel, "page" | "brief">;
}

/**
 * Owns the digest's mutable state (pending events, last-digest marker, timer
 * handles) and the side-effecting behavior over it: batching, page routing,
 * quiet-hours skip, and timer lifecycle. Construct with injected deps
 * for testability; production uses the {@link defaultAccumulator} singleton.
 */
export class DigestAccumulator {
  private pendingEvents: PendingEvent[] = [];
  private lastDigestAt: string | null = null;
  private digestTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  private readonly now: () => Date;
  private readonly send: TelegramSendFn;
  private readonly getCapacity: () => Promise<unknown>;
  private readonly getBuilderHealth: () => Promise<unknown>;
  private readonly channel: Pick<OperatorChannel, "page" | "brief">;

  constructor(deps: DigestAccumulatorDeps = {}) {
    this.now = deps.now ?? (() => new Date());
    this.send = deps.send ?? sendToTelegram;
    this.getCapacity =
      deps.getCapacity ?? (() => getCapacitySnapshot(DEFAULT_WINDOW_CYCLES));
    this.getBuilderHealth = deps.getBuilderHealth ?? getBuilderHealthScorecard;
    this.channel = deps.channel ?? operatorChannel;
  }

  /**
   * Record an event for the next digest. Does NOT send a digest immediately.
   * A page-kind event (the closed list in `operator-channel/page-list.ts`,
   * ADR-0045) goes straight to the Operator Channel and is not buffered. Every
   * other event is buffered for the legacy digest AND appended as a Morning
   * Brief item; appending never blocks or fails the legacy path.
   */
  recordEvent(event: DigestEvent): void {
    const type = event.type || "unknown";

    if (isPageEvent(type, event.payload)) {
      this.channel.page(messageFromEvent(event)).catch((err) =>
        logger.error({ err, type }, "[Digest] operator-channel page failed (non-fatal)"),
      );
      return;
    }

    this.pendingEvents.push({
      type,
      payload: event.payload || {},
      timestamp: this.now().toISOString(),
    });
    this.channel.brief(messageFromEvent(event)).catch((err) =>
      logger.error({ err, type }, "[Digest] operator-channel brief append failed (non-fatal)"),
    );
  }

  /**
   * Format and send the digest. Skips during quiet hours and when there are no
   * pending events.
   */
  async sendDigest(): Promise<void> {
    // The flush-threshold policy (issue #2212): one named predicate decides
    // whether a digest fires; this method is a thin caller over its verdict.
    const verdict = shouldSendDigest(
      this.pendingEvents.length,
      this.now().getHours(),
    );
    if (!verdict.send) {
      if (verdict.reason === "quiet-hours") {
        logger.info("[Digest] Quiet hours — skipping digest");
      } else {
        logger.info("[Digest] No events since last digest — skipping");
      }
      return;
    }

    const events = [...this.pendingEvents];
    this.pendingEvents = [];
    this.lastDigestAt = this.now().toISOString();

    // Issue #245: capacity-split snapshot for the digest. Failures are
    // non-fatal — digest still ships if Redis is unavailable.
    let capacitySnapshot = null;
    try {
      capacitySnapshot = await this.getCapacity();
    } catch (err: any) {
      logger.error({ err }, "[Digest] capacity-floor snapshot failed (non-fatal)");
    }

    // Issue #732: Builder-Health Scorecard for the digest. The aggregator
    // never throws by contract; this try/catch is belt-and-braces so a
    // surprise still ships the digest.
    let builderHealth = null;
    try {
      builderHealth = await this.getBuilderHealth();
    } catch (err: any) {
      logger.error({ err }, "[Digest] builder-health scorecard failed (non-fatal)");
    }

    const message = buildDigestMessage(events, capacitySnapshot, builderHealth);
    await this.send(message);
    logger.info({ eventCount: events.length }, "[Digest] Sent digest");
  }

  /**
   * Start the digest + heartbeat timers. Call once at startup.
   */
  start(): void {
    this.digestTimer = setInterval(() => this.sendDigest(), DIGEST_INTERVAL_MS);
    // Guaranteed daily proof-of-life. Fires unconditionally (no quiet-hours /
    // no empty-skip gate) so the operator always gets one push per day.
    this.heartbeatTimer = setInterval(() => {
      this.sendDailyHeartbeat().catch((err) =>
        logger.error({ err }, "[Digest] daily heartbeat failed (non-fatal)"),
      );
    }, HEARTBEAT_INTERVAL_MS);
    logger.info(
      {
        summaryIntervalHours: DIGEST_INTERVAL_MS / 3600_000,
        quietStartHour: QUIET_START_HOUR,
        quietEndHour: QUIET_END_HOUR,
        heartbeatIntervalHours: HEARTBEAT_INTERVAL_MS / 3600_000,
      },
      "[Digest] Started — periodic summaries + daily heartbeat",
    );
  }

  stop(): void {
    if (this.digestTimer) {
      clearInterval(this.digestTimer);
      this.digestTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Build and send the daily heartbeat. ALWAYS sends — no quiet-hours gate and
   * no empty-skip — because the whole point is a guaranteed daily proof-of-life.
   */
  async sendDailyHeartbeat(): Promise<void> {
    const message = await buildDailyHeartbeat();
    await this.send(message);
    logger.info("[Digest] Sent daily heartbeat");
  }
}

// The single production accumulator. The exported functions below delegate to
// it so callers keep their existing import paths (`interfaceImpact: none`).
const defaultAccumulator = new DigestAccumulator();

/**
 * Record an event for the next digest. Page-kind events are routed to the
 * Operator Channel instead (ADR-0045).
 */
export function recordEvent(event: DigestEvent): void {
  defaultAccumulator.recordEvent(event);
}

/**
 * Start the digest timer. Call once at startup.
 */
export function startDigest(): void {
  defaultAccumulator.start();
}

export function stopDigest(): void {
  defaultAccumulator.stop();
}

/**
 * Force send a digest now (for manual trigger via API).
 */
export async function sendDigestNow(): Promise<void> {
  await defaultAccumulator.sendDigest();
}

/**
 * Force-send the daily heartbeat now (manual trigger via API). Lets the
 * operator verify Telegram delivery on demand without waiting 24h.
 */
export async function sendDailyHeartbeatNow(): Promise<void> {
  await defaultAccumulator.sendDailyHeartbeat();
}
