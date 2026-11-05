/**
 * watchdog/brief-missing.ts — the MORNING BRIEF MISSING check (issue #5099,
 * epic #5094, slice 5/5; ADR-0040 Decision 2 shape; ADR-0045 Decision 8).
 * Ported from `run_brief_missing` in scripts/hydra-watchdog.sh (#5048).
 *
 * Pages ONCE when no Morning Brief has been delivered for 26h and resolves when
 * one lands again. It lives in the watchdog, not the orchestrator, because
 * every way the brief goes silent (orchestrator down, scheduler stopped,
 * transport failing) is a way the orchestrator could never report it. It reads
 * the brief's ONLY timing state, `hydra:operator-channel:brief:last-sent`.
 *
 * Cold start: when the key was never written, `hydra:autopilot:brief-missing:
 * absent-since` is anchored with SET NX at the first observing tick and the
 * threshold is measured from it (a fresh install gets a full grace, then pages
 * with reason `never-delivered`). The anchor is DELeted when the key appears.
 *
 * A thrown Redis read means Redis is unreachable: WARN and mutate NOTHING (the
 * liveness check owns Redis-down; an unreachable store must never masquerade as
 * a missing brief).
 */

import type { OperatorChannel } from "../operator-channel/channel.ts";
import type { OperatorMessage } from "../operator-channel/message.ts";

export const BRIEF_MISSING_LOG_PREFIX = "hydra-brief-missing-watchdog:";

/** Wrapper bound: a few Redis reads/writes and one channel call. */
export const BRIEF_MISSING_TIMEOUT_S = 90;

export const BRIEF_MISSING_KIND = "brief:missing";
export const DEFAULT_BRIEF_STALE_HOURS = 26;
export const BRIEF_LAST_SENT_KEY_LABEL = "hydra:operator-channel:brief:last-sent";

export interface BriefMissingConfig {
  staleHours: number;
  /** Injectable clock (epoch ms); `null` == use the real clock. */
  nowMs: number | null;
}

export interface BriefMissingStore {
  /** The delivered stamp (epoch ms), or `null` when absent/unparseable. THROWS when Redis is unreachable. */
  readLastSent(): Promise<number | null>;
  anchorExists(): Promise<boolean>;
  /** `SET absent-since <ms> NX`. */
  anchor(nowMs: number): Promise<void>;
  readAnchor(): Promise<number | null>;
  deleteAnchor(): Promise<void>;
  firedExists(): Promise<boolean>;
  markFired(): Promise<void>;
  deleteFired(): Promise<void>;
}

export interface BriefMissingDeps {
  store: BriefMissingStore;
  channel: Pick<OperatorChannel, "page" | "resolve">;
  clock: { nowMs(): number };
  log: (line: string) => void;
}

export type BriefMissingKind = "page" | "still-missing" | "resolve" | "fresh" | "grace";

export interface BriefMissingDecision {
  kind: BriefMissingKind;
  reason: "stale" | "never-delivered";
  referenceMs: number;
  ageMs: number;
}

/** Parse STALE_HOURS: a base-10 non-negative integer (zero-padded "08" is 8, never octal), else the default. */
export function parseBriefStaleHours(raw: string | undefined): number {
  return raw !== undefined && /^[0-9]+$/.test(raw) ? parseInt(raw, 10) : DEFAULT_BRIEF_STALE_HOURS;
}

/**
 * Pure verdict. A positive `lastSentMs` is the reference (`stale` arm); else the
 * cold-start anchor (`never-delivered` arm; no anchor yet measures from now).
 * At or past the threshold: `page` once, `still-missing` when already fired.
 * Below it: `resolve` when the fired marker existed, else `fresh` (stale arm)
 * or `grace` (never-delivered arm).
 */
export function decideBriefMissing(input: {
  lastSentMs: number | null;
  absentSinceMs: number | null;
  fired: boolean;
  nowMs: number;
  thresholdMs: number;
}): BriefMissingDecision {
  const hasStamp = input.lastSentMs !== null && input.lastSentMs > 0;
  const reason = hasStamp ? "stale" : "never-delivered";
  const referenceMs = hasStamp ? (input.lastSentMs as number) : (input.absentSinceMs ?? input.nowMs);
  const ageMs = Math.max(0, input.nowMs - referenceMs);
  if (ageMs >= input.thresholdMs) return { kind: input.fired ? "still-missing" : "page", reason, referenceMs, ageMs };
  if (input.fired) return { kind: "resolve", reason, referenceMs, ageMs };
  return { kind: hasStamp ? "fresh" : "grace", reason, referenceMs, ageMs };
}

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** One watchdog tick of the brief-missing check. Never throws. */
export async function runBriefMissing(deps: BriefMissingDeps, config: BriefMissingConfig): Promise<void> {
  const say = (line: string): void => deps.log(`${BRIEF_MISSING_LOG_PREFIX} ${line}`);
  const nowMs = config.nowMs ?? deps.clock.nowMs();
  const thresholdMs = config.staleHours * 3600 * 1000;
  try {
    // Reachability first: a thrown read is "Redis unreachable", not "brief missing". No state mutation.
    let lastSentMs: number | null;
    try {
      lastSentMs = await deps.store.readLastSent();
    } catch (err) {
      say(
        `WARN Redis unreachable (read of ${BRIEF_LAST_SENT_KEY_LABEL} failed: ${msg(err)}) — cannot evaluate brief freshness this tick; alarm state unchanged (## SERVICE LIVENESS owns Redis-down)`,
      );
      return;
    }

    let absentSinceMs: number | null = null;
    if (lastSentMs !== null && lastSentMs > 0) {
      // Gate the DEL on EXISTS: a healthy tick must not write when nothing is there.
      if (await deps.store.anchorExists()) await deps.store.deleteAnchor();
    } else {
      await deps.store.anchor(nowMs);
      absentSinceMs = (await deps.store.readAnchor()) ?? nowMs;
    }
    const fired = await deps.store.firedExists();

    const d = decideBriefMissing({ lastSentMs, absentSinceMs, fired, nowMs, thresholdMs });
    const ageH = Math.floor(d.ageMs / 3600000);

    if (d.kind === "page" || d.kind === "still-missing") {
      say(
        `WARNING MORNING BRIEF MISSING — ${d.reason}: no brief delivered for ${ageH}h (threshold ${config.staleHours}h; reference_ms=${d.referenceMs}, now_ms=${nowMs}) — issue #5048`,
      );
      if (d.kind === "still-missing") {
        say("still missing — already paged this episode (the fired marker holds the dedup)");
      } else {
        await deps.store.markFired();
        const page: OperatorMessage = {
          severity: "page",
          kind: BRIEF_MISSING_KIND,
          title: `No Morning Brief delivered for ${ageH}h`,
          facts: [
            { label: "reason", value: d.reason },
            { label: "age_h", value: String(ageH) },
            { label: "threshold_h", value: String(config.staleHours) },
            { label: "last_sent_key", value: BRIEF_LAST_SENT_KEY_LABEL },
          ],
          links: [],
          dedupKey: BRIEF_MISSING_KIND,
        };
        try {
          await deps.channel.page(page);
          say(`operator-channel page ok for '${BRIEF_MISSING_KIND}'`);
        } catch (err) {
          say(`WARN operator-channel page FAILED for '${BRIEF_MISSING_KIND}' (best-effort — detection state is unchanged): ${msg(err)}`);
        }
      }
    } else {
      if (d.reason === "stale") {
        say(`morning brief fresh: last delivered ${ageH}h ago (threshold ${config.staleHours}h)`);
      } else {
        say(`morning brief never delivered yet: cold-start grace ${ageH}h of ${config.staleHours}h used (absent-since anchor ${d.referenceMs})`);
      }
      if (d.kind === "resolve") {
        say("morning brief delivered again — clearing the episode (dedup re-armed)");
        try {
          await deps.channel.resolve(BRIEF_MISSING_KIND, "Morning Brief delivered again");
        } catch (err) {
          say(`WARN operator-channel resolve FAILED for '${BRIEF_MISSING_KIND}' (best-effort — detection state is unchanged): ${msg(err)}`);
        }
      }
      await deps.store.deleteFired();
    }

    say(`brief-missing tick processed (threshold=${config.staleHours}h, reason=${d.reason}, now_ms=${nowMs})`);
  } catch (err) {
    say(`WARN brief-missing tick failed: ${msg(err)}`);
  }
}
