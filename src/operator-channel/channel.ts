/**
 * The Operator Channel (ADR-0045, issue #5045) — the single outbound
 * Hydra→operator Telegram path.
 *
 * - {@link OperatorChannel.page}: edge-triggered per dedupKey (send once on bad,
 *   one reminder after 6h while still bad, suppressed repeats counted).
 * - {@link OperatorChannel.resolve}: one "recovered" message, then clears state.
 * - {@link OperatorChannel.brief}: appends a Morning Brief item (Redis list).
 *
 * Redis is best-effort and fails OPEN: every store call runs under a timeout,
 * and a failure is logged and treated as "no state" so the page is still sent.
 * A per-process map bounds repeats while Redis is down. Nothing here throws to
 * a producer for transport or Redis failure — only for a caller bug (a
 * non-page kind passed to `page`, a page kind passed to `brief`).
 */

import { InvalidArgumentError } from "../errors.ts";
import { logger } from "../logger.ts";
import { sendHtmlToTelegram, type TelegramTransportFn } from "../notify.ts";
import { ALERT_TYPES, formatAlertMessage } from "../notification/alert-grammar.ts";
import { NOTIFICATION_EVENT_TYPES as E } from "../event-bus-vocabulary.ts";
import { REGISTRY } from "../operator-actions/registry.ts";
import {
  redisOperatorChannelStore,
  type DedupState,
  type DeliveryLogEntry,
} from "../redis/operator-channel.ts";
import type { OperatorFact, OperatorMessage } from "./message.ts";
import { loadTelegramCredentials } from "./credentials.ts";
import { isPageKind, isPageEvent } from "./page-list.ts";
import { renderMessage, type RenderVariant } from "./render.ts";

export const REMINDER_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const OPERATOR_CHANNEL_REDIS_TIMEOUT_MS = 1500;

/** The persistence the channel needs; production binds `src/redis/operator-channel.ts`. */
export interface OperatorChannelStore {
  readDedup(dedupKey: string): Promise<DedupState | null>;
  writeDedup(dedupKey: string, state: DedupState): Promise<void>;
  incrSuppressed(dedupKey: string): Promise<void>;
  delDedup(dedupKey: string): Promise<void>;
  appendBrief(item: Record<string, unknown>): Promise<void>;
  appendLog(entry: DeliveryLogEntry): Promise<void>;
}

// ---------------------------------------------------------------------------
// Pure dedup reducer
// ---------------------------------------------------------------------------

export type DedupTransition =
  | { send: "page" | "reminder"; next: DedupState; suppressedBefore: number }
  | { send: null; next: DedupState; suppressedBefore: number }
  | { send: "recovered"; next: null; suppressedBefore: number }
  | { send: null; next: null; suppressedBefore: 0 };

/**
 * The edge-trigger state machine as a pure function. `page` on an absent key
 * sends and goes bad; on a bad key it either suppresses (< 6h since last send)
 * or sends one reminder. `resolve` on a bad key sends "recovered" and clears;
 * on an absent key it is a no-op.
 */
export function nextDedupState(
  prev: DedupState | null,
  now: number,
  action: "page" | "resolve",
): DedupTransition {
  if (action === "resolve") {
    if (!prev) return { send: null, next: null, suppressedBefore: 0 };
    return { send: "recovered", next: null, suppressedBefore: prev.suppressed };
  }
  if (!prev) {
    return {
      send: "page",
      next: { state: "bad", firstAt: now, lastSentAt: now, suppressed: 0 },
      suppressedBefore: 0,
    };
  }
  if (now - prev.lastSentAt < REMINDER_INTERVAL_MS) {
    return {
      send: null,
      next: { ...prev, suppressed: prev.suppressed + 1 },
      suppressedBefore: prev.suppressed,
    };
  }
  return {
    send: "reminder",
    next: { ...prev, lastSentAt: now, suppressed: 0 },
    suppressedBefore: prev.suppressed,
  };
}

// ---------------------------------------------------------------------------
// Event -> message mapping
// ---------------------------------------------------------------------------

/** A bus event as the in-process producers hold it. */
export interface ChannelEventInput {
  type?: string;
  payload?: Record<string, unknown>;
}

/**
 * Map a bus event to an {@link OperatorMessage}. Severity is decided by the
 * closed page list, never by the event. `dedupKey` is the event type for the
 * single-instance infra/launch signals, `consumer:dead:<name>` for consumer
 * death and `dlq:<originalStream>:<eventType>` for dead-letter items.
 */
export function messageFromEvent(event: ChannelEventInput): OperatorMessage {
  const kind = event.type || "unknown";
  const payload = event.payload || {};
  let title = ALERT_TYPES.has(kind) ? formatAlertMessage({ type: kind, payload }) : kind;
  const facts: OperatorFact[] = [];
  for (const [label, value] of Object.entries(payload)) {
    if (facts.length >= 8) break;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      facts.push({ label, value: String(value) });
    }
  }
  const links: OperatorMessage["links"] = [];
  let action: OperatorMessage["action"];
  let dedupKey = kind;
  if (kind === E.CONSUMER_DEAD) dedupKey = `consumer:dead:${String(payload.consumer ?? "unknown")}`;
  else if (kind === E.DLQ_ALERT) {
    dedupKey = `dlq:${String(payload.originalStream ?? "unknown")}:${String(payload.eventType ?? "unknown")}`;
  } else if (kind === E.REVIEW_PICKUP_READY) {
    // Issue #5047: the /hydra-review pickup page carries the ADR-0034 §8
    // recommended action for the `waiting-on-you:ready-for-human` line and a
    // link to the first pickup item, so the phone message is actionable.
    const count = Number(payload.count ?? 0);
    title = `${count} item${count === 1 ? "" : "s"} need${count === 1 ? "s" : ""} your review`;
    if (typeof payload.firstUrl === "string" && payload.firstUrl) {
      links.push({ label: String(payload.firstTitle || payload.firstUrl), url: payload.firstUrl });
    }
    action = { name: REVIEW_PICKUP_ACTION };
  }
  return {
    severity: isPageEvent(kind, payload) ? "page" : "brief",
    kind,
    title,
    facts,
    links,
    dedupKey,
    ...(action ? { action } : {}),
  };
}

/** The ADR-0034 §8 registry entry whose recommended command is `/hydra-review`. */
export const REVIEW_PICKUP_ACTION = "waiting-on-you:ready-for-human";

/** Resolve an ADR-0034 §8 registry entry name to its recommended command. */
function resolveActionCommand(name: string): string | undefined {
  const entry = REGISTRY.find((e) => e.key === name && !e.variant);
  if (!entry) {
    logger.error({ name }, "[OperatorChannel] unknown action name — omitting Action line");
    return undefined;
  }
  const a = entry.recommended;
  if (a.kind === "terminal-skill") return a.command;
  if (a.kind === "in-dashboard") return `${a.method} ${a.route}`;
  return a.label;
}

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------

export interface OperatorChannelDeps {
  store?: OperatorChannelStore;
  transport?: TelegramTransportFn;
  now?: () => number;
  /** Redis call timeout; tests shrink it. */
  timeoutMs?: number;
}

export type ChannelResult =
  | { sent: true; kind: "page" | "reminder" | "recovered" }
  | {
      sent: false;
      reason: "suppressed" | "no-credentials" | "transport-failed" | "not-bad";
    };

const UNAVAILABLE = Symbol("store-unavailable");

export class OperatorChannel {
  private readonly store: OperatorChannelStore;
  private readonly transport: TelegramTransportFn;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  /** Last send per dedupKey in THIS process — bounds repeats while Redis is down. */
  private readonly localSent = new Map<string, number>();
  /** Per-dedupKey serialization tail (see {@link serialize}). */
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(deps: OperatorChannelDeps = {}) {
    this.store = deps.store ?? redisOperatorChannelStore;
    this.transport = deps.transport ?? sendHtmlToTelegram;
    this.now = deps.now ?? (() => Date.now());
    this.timeoutMs = deps.timeoutMs ?? OPERATOR_CHANNEL_REDIS_TIMEOUT_MS;
  }

  /** Run a store call under the timeout; log and return UNAVAILABLE on failure. */
  private async bounded<T>(what: string, call: () => Promise<T>): Promise<T | typeof UNAVAILABLE> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof UNAVAILABLE>((resolve) => {
      timer = setTimeout(() => resolve(UNAVAILABLE), this.timeoutMs);
    });
    try {
      const result = await Promise.race([call(), timeout]);
      if (result === UNAVAILABLE) {
        logger.error({ what, timeoutMs: this.timeoutMs }, "[OperatorChannel] store call timed out — failing open");
      }
      return result;
    } catch (err) {
      logger.error({ what, err }, "[OperatorChannel] store call failed — failing open");
      return UNAVAILABLE;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async deliver(
    msg: OperatorMessage,
    kind: "page" | "reminder" | "recovered",
    extraFacts?: OperatorFact[],
  ): Promise<ChannelResult> {
    const text = renderMessage(msg, {
      variant: kind as RenderVariant,
      actionCommand: msg.action ? resolveActionCommand(msg.action.name) : undefined,
      extraFacts,
    });
    const result = await this.transport(text);
    const base = { at: this.now(), kind, dedupKey: msg.dedupKey, title: msg.title };
    // (tsconfig is non-strict, so `ok` does not narrow the union: read via a view.)
    const view = result as { ok: boolean; mode?: string; reason?: string; status?: number };
    let entry: DeliveryLogEntry;
    if (view.ok) {
      entry = { ...base, outcome: view.mode === "plain" ? "sent-plain" : "sent-html" };
    } else if (view.reason === "no-credentials") {
      entry = { ...base, outcome: "skipped-no-credentials" };
    } else {
      entry = { ...base, outcome: "failed", status: view.status };
    }
    await this.bounded("appendLog", () => this.store.appendLog(entry));
    if (view.ok) return { sent: true, kind };
    return { sent: false, reason: view.reason === "no-credentials" ? "no-credentials" : "transport-failed" };
  }

  /**
   * Serialize page()/resolve() per dedupKey so the read-send-write dedup is
   * effectively atomic within this process (concurrent pages for one key cannot
   * both observe "absent" and both send).
   */
  private serialize<T>(dedupKey: string, run: () => Promise<T>): Promise<T> {
    const prior = this.inFlight.get(dedupKey) ?? Promise.resolve();
    const next = prior.then(run, run);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.inFlight.set(dedupKey, tail);
    void tail.then(() => {
      if (this.inFlight.get(dedupKey) === tail) this.inFlight.delete(dedupKey);
    });
    return next;
  }

  /** Send (or suppress) a Page. Throws only for a non-page kind. */
  async page(msg: OperatorMessage): Promise<ChannelResult> {
    if (!isPageKind(msg.kind)) {
      throw new InvalidArgumentError(`"${msg.kind}" is not on the closed page list (ADR-0045 Decision 3)`);
    }
    return this.serialize(msg.dedupKey, () => this.pageUnlocked(msg));
  }

  private async pageUnlocked(msg: OperatorMessage): Promise<ChannelResult> {
    const now = this.now();
    const prev = await this.bounded("readDedup", () => this.store.readDedup(msg.dedupKey));

    if (prev === UNAVAILABLE) {
      // Fail open, but bounded: at most one send per 6h per process while blind.
      const last = this.localSent.get(msg.dedupKey);
      if (last !== undefined && now - last < REMINDER_INTERVAL_MS) {
        return { sent: false, reason: "suppressed" };
      }
      const res = await this.deliver(msg, last === undefined ? "page" : "reminder");
      if (res.sent) this.localSent.set(msg.dedupKey, now);
      return res;
    }

    const t = nextDedupState(prev, now, "page");
    if (t.send === null) {
      await this.bounded("incrSuppressed", () => this.store.incrSuppressed(msg.dedupKey));
      return { sent: false, reason: "suppressed" };
    }
    const extra =
      t.send === "reminder"
        ? [{ label: "suppressed", value: `${t.suppressedBefore} since ${new Date(prev!.firstAt).toISOString()}` }]
        : undefined;
    const res = await this.deliver(msg, t.send, extra);
    if (res.sent && t.next) {
      this.localSent.set(msg.dedupKey, now);
      await this.bounded("writeDedup", () => this.store.writeDedup(msg.dedupKey, t.next as DedupState));
    }
    return res;
  }

  /** Publish one "recovered" message iff the key is bad, then clear it. */
  async resolve(dedupKey: string, title?: string): Promise<ChannelResult> {
    return this.serialize(dedupKey, () => this.resolveUnlocked(dedupKey, title));
  }

  private async resolveUnlocked(dedupKey: string, title?: string): Promise<ChannelResult> {
    const prev = await this.bounded("readDedup", () => this.store.readDedup(dedupKey));
    const wasBad = prev === UNAVAILABLE ? this.localSent.has(dedupKey) : nextDedupState(prev, this.now(), "resolve").send === "recovered";
    if (!wasBad) return { sent: false, reason: "not-bad" };
    const res = await this.deliver(
      { severity: "page", kind: "recovered", title: title ?? dedupKey, facts: [], links: [], dedupKey },
      "recovered",
    );
    // Always clear: a failed "recovered" send must not leave the key bad and
    // suppress a genuine later page (the recovery message is best-effort).
    this.localSent.delete(dedupKey);
    await this.bounded("delDedup", () => this.store.delDedup(dedupKey));
    return res;
  }

  /** Append a Morning Brief item. Throws only when handed a page kind. */
  async brief(item: OperatorMessage): Promise<{ appended: boolean }> {
    const factPayload = Object.fromEntries((item.facts ?? []).map((f) => [f.label, f.value]));
    if (isPageEvent(item.kind, factPayload)) {
      throw new InvalidArgumentError(`"${item.kind}" is a page kind — use page(), not brief()`);
    }
    const out = await this.bounded("appendBrief", () =>
      this.store.appendBrief({ ...item, severity: "brief", at: this.now() }),
    );
    return { appended: out !== UNAVAILABLE };
  }
}

/**
 * Boot-time credential check. Telegram credentials are env-only (the former
 * hard-coded chat-id fallback is gone), so a missing var silently disables every
 * send; surface that loudly once at startup. Returns whether both are present.
 */
export function checkOperatorChannelCredentials(env: Record<string, string | undefined> = process.env): boolean {
  if (loadTelegramCredentials(env)) return true;
  logger.error(
    "[OperatorChannel] Telegram bot token or chat id missing from the service env — all operator pages/digests are DISABLED until set",
  );
  return false;
}

/** The process-wide channel the in-process producers share. */
export const operatorChannel = new OperatorChannel();
