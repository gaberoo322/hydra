/**
 * watchdog/episode.ts — the ONE streak/dedup episode tracker (issue #5097,
 * epic #5094; ADR-0040 Decision 2 shape: one pure decide + one run over an
 * injected port).
 *
 * The rule used to be copy-pasted in hydra-watchdog.sh. It is signal
 * agnostic: it takes a `{since, fired}` key pair built by a `src/redis/`
 * builder, so other blocks reuse it without edits.
 *
 *   member     -> SET NX since (first tick anchors, no-op after); fire exactly
 *                 once when now-since >= threshold AND the fired marker is
 *                 absent. The fired marker is SET BEFORE delivery so dedup
 *                 holds when delivery fails.
 *   non-member -> `onRecover` ONLY if the fired marker existed, then DEL both.
 *
 * Never mutates on a read failure: a thrown store read skips the signal with a
 * WARN (no extend, no clear).
 */

import type { EpisodeKeyPair } from "../redis/watchdog-episodes.ts";

export type { EpisodeKeyPair };

export type EpisodeKind = "anchor" | "extend" | "fire" | "clear" | "recover" | "noop";

export interface EpisodeDecisionInput {
  /** The anchored first-seen epoch-ms, or `null` when no anchor exists yet. */
  sinceMs: number | null;
  /** Whether the fired marker exists for the current episode. */
  fired: boolean;
  /** Whether the signal's membership test is true this tick. */
  member: boolean;
  nowMs: number;
  thresholdMs: number;
}

export interface EpisodeDecision {
  kind: EpisodeKind;
  /** Sustained duration in ms (negative clamped to 0; 0 for non-members). */
  durationMs: number;
}

/**
 * Pure verdict. A member with no anchor measures from `nowMs` (the bash
 * SET NX made `since == now` on the first tick, so a 0ms threshold fires
 * immediately). `anchor` = member below threshold with no prior anchor,
 * `extend` = member below threshold with an anchor, `fire` = threshold crossed
 * and not yet fired, `noop` = threshold crossed and already fired,
 * `recover` = non-member whose fired marker existed, `clear` = any other
 * non-member (idempotent DEL).
 */
export function decideEpisode(input: EpisodeDecisionInput): EpisodeDecision {
  const { sinceMs, fired, member, nowMs, thresholdMs } = input;
  if (!member) return { kind: fired ? "recover" : "clear", durationMs: 0 };
  const since = sinceMs === null ? nowMs : sinceMs;
  const durationMs = Math.max(0, nowMs - since);
  if (durationMs >= thresholdMs) return { kind: fired ? "noop" : "fire", durationMs };
  return { kind: sinceMs === null ? "anchor" : "extend", durationMs };
}

/** The Redis-shaped port the tracker applies decisions over. */
export interface EpisodeStore {
  /** SET NX the anchor. */
  anchor(keys: EpisodeKeyPair, nowMs: number): Promise<void>;
  readSince(keys: EpisodeKeyPair): Promise<number | null>;
  firedExists(keys: EpisodeKeyPair): Promise<boolean>;
  markFired(keys: EpisodeKeyPair): Promise<void>;
  /** DEL both keys. */
  clear(keys: EpisodeKeyPair): Promise<void>;
}

export interface EpisodeRunInput {
  /** Label used in WARN lines. */
  signal: string;
  member: boolean;
  nowMs: number;
  thresholdMs: number;
}

export interface EpisodeHooks {
  log: (line: string) => void;
  /** Member, below threshold (anchor or extend). */
  onBelowThreshold: (durationMs: number) => void;
  /** Called at the fired absent->present transition, AFTER the fired marker is set. */
  onFire: (durationMs: number) => Promise<void>;
  /** Called at the recovery edge, only when the fired marker existed before the DEL. */
  onRecover: () => Promise<void>;
}

/** Apply {@link decideEpisode} over the store. Never throws; `null` = skipped on a read failure. */
export async function runEpisode(
  store: EpisodeStore,
  keys: EpisodeKeyPair,
  input: EpisodeRunInput,
  hooks: EpisodeHooks,
): Promise<EpisodeDecision | null> {
  const { signal, member, nowMs, thresholdMs } = input;
  const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

  let sinceMs: number | null = null;
  let fired: boolean;
  try {
    if (member) {
      try {
        await store.anchor(keys, nowMs);
      } catch (err) {
        /* intentional: anchor write is best-effort (bash rc_write || true); the read below decides */
        hooks.log(`WARN episode '${signal}' anchor write failed (${msg(err)})`);
      }
      sinceMs = await store.readSince(keys);
    }
    fired = await store.firedExists(keys);
  } catch (err) {
    hooks.log(`WARN episode '${signal}' state read failed (${msg(err)}) — leaving this signal's anchor and fired marker untouched`);
    return null;
  }

  const decision = decideEpisode({ sinceMs, fired, member, nowMs, thresholdMs });

  try {
    switch (decision.kind) {
      case "anchor":
      case "extend":
        hooks.onBelowThreshold(decision.durationMs);
        break;
      case "fire":
        // The fired marker is set BEFORE delivering: dedup holds even if the
        // delivery itself fails (delivery is best-effort per streak).
        try {
          await store.markFired(keys);
        } catch (err) {
          /* intentional: best-effort like the bash rc_write; logged, delivery still proceeds */
          hooks.log(`WARN episode '${signal}' fired-marker write failed (${msg(err)})`);
        }
        await hooks.onFire(decision.durationMs);
        break;
      case "recover":
        await hooks.onRecover();
        await store.clear(keys);
        break;
      case "clear":
        await store.clear(keys);
        break;
      case "noop":
        break;
    }
  } catch (err) {
    hooks.log(`WARN episode '${signal}' ${decision.kind} apply failed (${msg(err)})`);
  }
  return decision;
}
