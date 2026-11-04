/**
 * Slot-events stream Redis seam (issue #5349).
 *
 * `scripts/autopilot/hooks/on-subagent-tool-call.sh` XADDs a `subagent_tool_call`
 * entry onto `hydra:autopilot:slot-events` for every tool call inside an
 * autopilot subagent. The external watchdog reads the newest entries here to
 * tell a parent that is waiting on live subagents from a genuinely wedged one.
 * Raw entries only - which events COUNT is policy in src/watchdog/wedge.ts.
 */

import { getRedisConnection } from "./connection.ts";

export const SLOT_EVENTS_STREAM_KEY = "hydra:autopilot:slot-events";

/** Entries read per call; the stream is MAXLEN ~1000 so this covers the recent tail. */
export const SLOT_EVENTS_TAIL_COUNT = 500;

export interface SlotEventEntry {
  id: string;
  fields: Record<string, string>;
}

/** Newest-first tail of the slot-events stream. THROWS on a Redis failure (caller decides fail-open). */
export async function readRecentSlotEvents(count: number = SLOT_EVENTS_TAIL_COUNT): Promise<SlotEventEntry[]> {
  const rows = await getRedisConnection().xrevrange(SLOT_EVENTS_STREAM_KEY, "+", "-", "COUNT", count);
  return rows.map(([id, flat]) => {
    const fields: Record<string, string> = {};
    for (let i = 0; i + 1 < flat.length; i += 2) fields[flat[i]] = flat[i + 1];
    return { id, fields };
  });
}
