/**
 * Morning Brief scheduler (ADR-0045 Decision 7, issue #5047).
 *
 * The brief's ONLY timing state is the Redis key
 * `hydra:operator-channel:brief:last-sent` (epoch ms, via
 * `src/redis/operator-channel.ts`). There is no in-memory timer value and no
 * setInterval of its own: the process-wide `morningBriefScheduler` (bound in
 * `brief.ts` to the real send path) is ticked by the existing scheduler
 * heartbeat (`src/scheduler/heartbeat.ts`, wired in `src/index.ts`), and
 * every tick only asks the pure
 * {@link briefDue} predicate. So an orchestrator restart can neither delay nor
 * duplicate a brief, a 07:30 missed while the service was down catches up at
 * the first tick after it is back, and a brief already sent today is never
 * re-sent.
 *
 * Last-sent is stamped ONLY after the transport reports a delivered send
 * (HTML or the plain-text backstop): a transport failure is retried on the
 * next tick rather than silently skipped.
 *
 * "Local" is the process TZ — exactly the clock the retired quiet-hours gate
 * read through `Date#getHours`.
 */

import { logger } from "../logger.ts";
import { redisBriefStore, type DeliveryOutcome } from "../redis/operator-channel.ts";

export const BRIEF_HOUR = 7;
export const BRIEF_MINUTE = 30;

export interface LocalParts {
  hour: number;
  minute: number;
  /** `YYYY-MM-DD` in the process TZ — comparable as a string. */
  dateKey: string;
  /** 0 = Sunday … 6 = Saturday, in the process TZ. */
  weekday: number;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** The local wall-clock parts of `epochMs` in the process TZ. */
export function localParts(epochMs: number): LocalParts {
  const d = new Date(epochMs);
  return {
    hour: d.getHours(),
    minute: d.getMinutes(),
    dateKey: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
    weekday: d.getDay(),
  };
}

/**
 * True iff local time is at or past 07:30 AND no brief has been sent on
 * today's local date (an absent key counts as never sent). Pure.
 */
export function briefDue(now: LocalParts, lastSentAt: number | null): boolean {
  if (now.hour < BRIEF_HOUR || (now.hour === BRIEF_HOUR && now.minute < BRIEF_MINUTE)) return false;
  if (lastSentAt === null) return true;
  return localParts(lastSentAt).dateKey < now.dateKey;
}

/** The `YYYY-MM-DD` local date key of the Monday that starts `epochMs`'s week. */
export function weekMondayDateKey(epochMs: number): string {
  const d = new Date(epochMs);
  const back = (d.getDay() + 6) % 7; // Mon=0 … Sun=6 days since Monday
  return localParts(new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime()).dateKey;
}

/**
 * True iff this brief should carry the weekly summary: it is Monday, OR the
 * last delivered brief pre-dates this week's Monday (every Monday send failed,
 * so the catch-up brief carries the week it would otherwise lose). Pure, same
 * shape as {@link briefDue}; a never-sent brief (null) gets no weekly section
 * outside Monday.
 */
export function weeklyDue(nowMs: number, lastSentAt: number | null): boolean {
  if (localParts(nowMs).weekday === 1) return true;
  if (lastSentAt === null) return false;
  return localParts(lastSentAt).dateKey < weekMondayDateKey(nowMs);
}

/** The persistence the scheduler needs; production binds `redisBriefStore`. */
export interface BriefStore {
  getLastSent(): Promise<number | null>;
  setLastSent(epochMs: number): Promise<void>;
}

/** What the send path reports back; `ok` means the transport delivered it. */
export interface BriefSendOutcome {
  ok: boolean;
  outcome: DeliveryOutcome;
  at: number;
}

export type BriefSendFn = (opts: { lastSentAt: number | null }) => Promise<BriefSendOutcome>;

export interface BriefSchedulerDeps {
  /** The send path (`sendMorningBrief` in production — bound in `brief.ts`). */
  send: BriefSendFn;
  store?: BriefStore;
  now?: () => number;
}

export type BriefTickResult = "sent" | "not-due" | "in-flight" | "failed" | "store-unavailable";

export interface BriefSendNowResult {
  sent: boolean;
  outcome: DeliveryOutcome;
  at: number;
}

export class BriefScheduler {
  private readonly store: BriefStore;
  private readonly now: () => number;
  private readonly send: BriefSendFn;
  /** Prevents overlapping sends from two ticks in one process. */
  private sending = false;

  constructor(deps: BriefSchedulerDeps) {
    this.store = deps.store ?? redisBriefStore;
    this.now = deps.now ?? (() => Date.now());
    this.send = deps.send;
  }

  private async readLastSent(): Promise<number | null | undefined> {
    try {
      return await this.store.getLastSent();
    } catch (err) {
      logger.error({ err }, "[MorningBrief] last-sent read failed — leaving the brief for the next tick");
      return undefined;
    }
  }

  private async deliver(lastSentAt: number | null): Promise<BriefSendNowResult> {
    const res = await this.send({ lastSentAt });
    if (res.ok) {
      try {
        await this.store.setLastSent(res.at);
      } catch (err) {
        logger.error({ err }, "[MorningBrief] last-sent stamp failed after a delivered send — the next tick may re-send");
      }
    }
    return { sent: res.ok, outcome: res.outcome, at: res.at };
  }

  /**
   * One poll: send iff {@link briefDue}. Safe to call from any periodic tick —
   * it is idempotent per local day and serialised within the process.
   */
  async tick(): Promise<BriefTickResult> {
    // The flag guards the whole read -> decide -> send section, so two
    // overlapping ticks can never both observe "absent" and both send.
    if (this.sending) return "in-flight";
    this.sending = true;
    try {
      const lastSentAt = await this.readLastSent();
      if (lastSentAt === undefined) return "store-unavailable";
      if (!briefDue(localParts(this.now()), lastSentAt)) return "not-due";
      const out = await this.deliver(lastSentAt);
      return out.sent ? "sent" : "failed";
    } finally {
      this.sending = false;
    }
  }

  /**
   * Send the brief immediately regardless of the 07:30 gate (the
   * `POST /api/operator-channel/brief/send` route). A delivered send-now
   * stamps last-sent, so it counts as today's brief — the scheduled 07:30
   * send is then skipped rather than near-duplicated.
   */
  async sendNow(): Promise<BriefSendNowResult> {
    if (this.sending) {
      return { sent: false, outcome: "failed", at: this.now() };
    }
    this.sending = true;
    try {
      const lastSentAt = (await this.readLastSent()) ?? null;
      return await this.deliver(lastSentAt);
    } finally {
      this.sending = false;
    }
  }
}
