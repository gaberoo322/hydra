/**
 * Morning Brief scheduler (ADR-0045 Decision 7, issue #5047).
 *
 * A 60s in-process poller asks the pure `briefDue(localParts(now), lastSentAt)`
 * predicate. The timing state is the Redis key `hydra:operator-channel:brief:
 * last-sent` (epoch ms) — never an in-memory timer value — so an orchestrator
 * restart can neither delay nor duplicate a brief, and a brief missed while the
 * service was down catches up at the first tick after it returns.
 *
 * The brief is sent even when every section is empty. Last-sent is stamped only
 * after the transport reports ok (HTML or the plain-text fallback), so a
 * transport failure is retried (after a short back-off) rather than silently
 * skipped; every send is logged with kind `brief` in the delivery log. Replaces
 * the retired 4h digest `setInterval`, the 24h heartbeat `setInterval` and the
 * weekly digest chore.
 */

import { logger } from "../logger.ts";
import { sendHtmlToTelegram, type TelegramTransportFn } from "../notify.ts";
import {
  getBriefLastSent,
  setBriefLastSent,
  appendLog,
  type DeliveryLogEntry,
  type DeliveryOutcome,
} from "../redis/operator-channel.ts";
import { briefDue, localParts } from "./brief.ts";
import { renderBrief } from "./brief-render.ts";
import { collectBriefSections, type BriefSection, type BriefSourcesDeps } from "./brief-sources.ts";

export const BRIEF_POLL_MS = 60_000;
/** After a failed transport send, wait this long before the poller retries. */
export const BRIEF_RETRY_BACKOFF_MS = 5 * 60_000;

/** The persistence the brief needs; production binds `src/redis/operator-channel.ts`. */
export interface BriefStore {
  getLastSent(): Promise<number | null>;
  setLastSent(at: number): Promise<void>;
  appendLog(entry: DeliveryLogEntry): Promise<void>;
}

export const redisBriefStore: BriefStore = {
  getLastSent: getBriefLastSent,
  setLastSent: setBriefLastSent,
  appendLog,
};

export interface BriefSchedulerDeps {
  store?: BriefStore;
  transport?: TelegramTransportFn;
  now?: () => number;
  /** Section assembler; defaults to {@link collectBriefSections} over `sources`. */
  collect?: (opts: { lastSentAt: number | null; includeWeekly: boolean }) => Promise<BriefSection[]>;
  sources?: BriefSourcesDeps;
  pollMs?: number;
}

export interface BriefSendResult {
  sent: boolean;
  outcome: DeliveryOutcome;
  at: number;
}

export class BriefScheduler {
  private readonly store: BriefStore;
  private readonly transport: TelegramTransportFn;
  private readonly now: () => number;
  private readonly collect: NonNullable<BriefSchedulerDeps["collect"]>;
  private readonly pollMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Overlapping-tick guard (a slow brief must not start a second one). */
  private sending = false;
  private retryNotBefore = 0;
  private warnedNoCredentials = false;

  constructor(deps: BriefSchedulerDeps = {}) {
    this.store = deps.store ?? redisBriefStore;
    this.transport = deps.transport ?? sendHtmlToTelegram;
    this.now = deps.now ?? (() => Date.now());
    this.pollMs = deps.pollMs ?? BRIEF_POLL_MS;
    const sources = { now: this.now, ...(deps.sources ?? {}) };
    this.collect = deps.collect ?? ((opts) => collectBriefSections(opts, sources));
  }

  /**
   * Build and send the brief now. Stamps last-sent iff the transport reports ok
   * (so a send-now counts as today's brief). Never throws.
   */
  async sendNow(): Promise<BriefSendResult> {
    const at = this.now();
    let lastSentAt: number | null = null;
    try {
      lastSentAt = await this.store.getLastSent();
    } catch (err) {
      logger.error({ err }, "[OperatorChannel] brief: last-sent read failed — using the default window");
    }

    let text: string;
    try {
      const sections = await this.collect({
        lastSentAt,
        includeWeekly: localParts(at).weekday === 1,
      });
      text = renderBrief(sections, at);
    } catch (err) {
      // Section readers degrade individually; reaching here is a renderer bug.
      logger.error({ err }, "[OperatorChannel] brief: assembly failed");
      return { sent: false, outcome: "failed", at };
    }

    const result = (await this.transport(text)) as { ok: boolean; mode?: string; reason?: string; status?: number };
    let outcome: DeliveryOutcome;
    if (result.ok) outcome = result.mode === "plain" ? "sent-plain" : "sent-html";
    else if (result.reason === "no-credentials") outcome = "skipped-no-credentials";
    else outcome = "failed";

    if (outcome === "skipped-no-credentials" && this.warnedNoCredentials) {
      return { sent: false, outcome, at };
    }
    if (outcome === "skipped-no-credentials") this.warnedNoCredentials = true;

    const entry: DeliveryLogEntry = {
      at,
      kind: "brief",
      dedupKey: "brief",
      title: "Morning Brief",
      outcome,
      ...(outcome === "failed" ? { status: result.status } : {}),
    };
    try {
      await this.store.appendLog(entry);
    } catch (err) {
      logger.error({ err }, "[OperatorChannel] brief: delivery-log append failed");
    }
    if (result.ok) {
      try {
        await this.store.setLastSent(at);
      } catch (err) {
        logger.error({ err }, "[OperatorChannel] brief: last-sent stamp failed — a duplicate brief is possible");
      }
    }
    return { sent: result.ok, outcome, at };
  }

  /** One poll: send iff due. Safe to call concurrently (overlap-guarded). */
  async tick(): Promise<BriefSendResult | null> {
    if (this.sending) return null;
    const at = this.now();
    if (at < this.retryNotBefore) return null;
    this.sending = true;
    try {
      let lastSentAt: number | null;
      try {
        lastSentAt = await this.store.getLastSent();
      } catch (err) {
        // Without the stamp we cannot tell due from already-sent: skip, don't risk a duplicate.
        logger.error({ err }, "[OperatorChannel] brief: last-sent read failed — skipping this tick");
        return null;
      }
      if (!briefDue(localParts(at), lastSentAt)) return null;
      const res = await this.sendNow();
      if (!res.sent && res.outcome === "failed") this.retryNotBefore = at + BRIEF_RETRY_BACKOFF_MS;
      return res;
    } catch (err) {
      logger.error({ err }, "[OperatorChannel] brief: tick failed");
      return null;
    } finally {
      this.sending = false;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollMs);
    this.timer.unref?.();
    logger.info({ pollMs: this.pollMs }, "[OperatorChannel] Morning Brief scheduler started (07:30 local, Redis-keyed)");
    void this.tick(); // catch up immediately if a brief was missed while down
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/** The process-wide scheduler `src/index.ts` starts and the send-now route uses. */
export const briefScheduler = new BriefScheduler();

export function startBriefScheduler(): void {
  briefScheduler.start();
}

export function stopBriefScheduler(): void {
  briefScheduler.stop();
}

export function sendBriefNow(): Promise<BriefSendResult> {
  return briefScheduler.sendNow();
}
