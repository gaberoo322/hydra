/**
 * Digest Notifications
 *
 * Replaces per-event Telegram messages with periodic summaries.
 * Sends a digest every 4 hours during daytime (7am-10pm).
 *
 * Collects events in memory, then formats a summary covering:
 * - Cycles completed since last digest (merged, failed, abandoned)
 * - Research cycles run
 * - Test count changes
 * - Backlog/queue state
 * - Action items (empty backlog, stale priorities, errors needing attention)
 *
 * # Pure core vs. orchestration (issue #1181)
 *
 * The pure assembly grammar (`buildDigestMessage`, `buildDailyHeartbeat`,
 * `buildWeeklySummary`, `formatCriticalAlert`, `formatBuilderHealthLines`)
 * lives in `./digest-format.ts` — no timers, no Telegram calls, no module
 * state, and fully testable.
 *
 * # Injectable accumulator seam (issue #1487)
 *
 * The remaining side-effecting surface — event batching, critical-event
 * bypass, quiet-hours skip, and timer lifecycle — is encapsulated in the
 * `DigestAccumulator` class below. Its constructor takes injected deps
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
import { NOTIFICATION_EVENT_TYPES as E } from "./event-bus.ts";
import { getCapacitySnapshot, DEFAULT_WINDOW_CYCLES } from "./capacity-floor.ts";
import { getBuilderHealthScorecard } from "./aggregators/builder-health.ts";
import {
  buildDigestMessage,
  buildDailyHeartbeat,
  buildWeeklySummary,
  formatCriticalAlert,
  formatBuilderHealthLines,
} from "./digest-format.ts";

// Re-export the pure-core formatters so existing importers of ./digest.ts that
// reach for these (e.g. formatBuilderHealthLines, previously exported here;
// buildWeeklySummary, consumed by src/scheduler/housekeeping.ts) keep working
// without churn.
export { formatBuilderHealthLines, buildWeeklySummary };

const DIGEST_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const QUIET_START_HOUR = 22; // 10pm
const QUIET_END_HOUR = 7; // 7am

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
 * critical-bypass; `payload` rides along into the digest grammar.
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
}

/**
 * Owns the digest's mutable state (pending events, last-digest marker, timer
 * handles) and the side-effecting behavior over it: batching, critical-event
 * bypass, quiet-hours skip, and timer lifecycle. Construct with injected deps
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

  constructor(deps: DigestAccumulatorDeps = {}) {
    this.now = deps.now ?? (() => new Date());
    this.send = deps.send ?? sendToTelegram;
    this.getCapacity =
      deps.getCapacity ?? (() => getCapacitySnapshot(DEFAULT_WINDOW_CYCLES));
    this.getBuilderHealth = deps.getBuilderHealth ?? getBuilderHealthScorecard;
  }

  private isQuietHours(): boolean {
    const hour = this.now().getHours();
    return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
  }

  /**
   * Record an event for the next digest. Does NOT send immediately.
   * Critical alerts (rollback failures, scheduler stops) still send immediately.
   */
  recordEvent(event: DigestEvent): void {
    const type = event.type || "unknown";

    // Critical events bypass digest and send immediately. Members reference the
    // typed NOTIFICATION_EVENT_TYPES vocabulary (issue #1182) so a misspelled
    // event type here is a compile error.
    const critical: string[] = [
      E.CYCLE_ROLLBACK_FAILED,
      E.SCHEDULER_STOPPED,
      E.SCHEDULER_PAUSED_REPETITION,
      E.SCHEDULER_BACKLOG_EMPTY,
    ];
    if (critical.includes(type)) {
      void this.sendImmediate(formatCriticalAlert(event));
      return;
    }

    this.pendingEvents.push({
      type,
      payload: event.payload || {},
      timestamp: this.now().toISOString(),
    });
  }

  /**
   * Format and send the digest. Skips during quiet hours and when there are no
   * pending events.
   */
  async sendDigest(): Promise<void> {
    if (this.isQuietHours()) {
      console.log("[Digest] Quiet hours — skipping digest");
      return;
    }

    if (this.pendingEvents.length === 0) {
      console.log("[Digest] No events since last digest — skipping");
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
      console.error(`[Digest] capacity-floor snapshot failed (non-fatal): ${err.message}`);
    }

    // Issue #732: Builder-Health Scorecard for the digest. The aggregator
    // never throws by contract; this try/catch is belt-and-braces so a
    // surprise still ships the digest.
    let builderHealth = null;
    try {
      builderHealth = await this.getBuilderHealth();
    } catch (err: any) {
      console.error(`[Digest] builder-health scorecard failed (non-fatal): ${err.message}`);
    }

    const message = buildDigestMessage(events, capacitySnapshot, builderHealth);
    await this.send(message);
    console.log(`[Digest] Sent digest (${events.length} events)`);
  }

  private async sendImmediate(message: string): Promise<void> {
    if (this.isQuietHours()) {
      console.log("[Digest] Critical alert during quiet hours — sending anyway");
    }
    await this.send(message);
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
        console.error(`[Digest] daily heartbeat failed (non-fatal): ${err?.message || err}`),
      );
    }, HEARTBEAT_INTERVAL_MS);
    console.log(
      `[Digest] Started — summaries every ${DIGEST_INTERVAL_MS / 3600_000}h, quiet ${QUIET_START_HOUR}:00-${QUIET_END_HOUR}:00; ` +
        `daily heartbeat every ${HEARTBEAT_INTERVAL_MS / 3600_000}h`,
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
    console.log("[Digest] Sent daily heartbeat");
  }
}

// The single production accumulator. The exported functions below delegate to
// it so callers keep their existing import paths (`interfaceImpact: none`).
const defaultAccumulator = new DigestAccumulator();

/**
 * Record an event for the next digest. Does NOT send immediately.
 * Critical alerts (rollback failures, scheduler stops) still send immediately.
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
