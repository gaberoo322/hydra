/**
 * Blocked-item re-escalation chore (every 12h per item).
 *
 * One of the Housekeeping chore family (`src/scheduler/chores/`) — extracted
 * from the former 939-line `src/scheduler/housekeeping.ts` (issue #2090) so each
 * chore's implementation, deps interface, and private helpers concentrate in a
 * single focused file. `src/scheduler/housekeeping.ts` stays the registry +
 * `runChore`/`runHousekeeping` composition owner. Behaviour is unchanged.
 *
 * Each chore was already made deps-injectable in #2067; this file just gives the
 * blocked-escalation chore (and its private `generateUnblockCommands` operator
 * unblock-command builder) its own home.
 */

import { loadBacklog } from "../../backlog/reads.ts";
import { getTargetName } from "../../target-config.ts";
import {
  getBlockedLastEscalation,
  setBlockedLastEscalation,
} from "../../redis/housekeeping.ts";
import type { PublishableBus } from "../../event-bus-seams.ts";

// Generate actionable unblock commands based on the blocked reason.
function generateUnblockCommands(blockedReason: string, title: string): string[] {
  const commands: string[] = [];
  if (/api[_ ]?key|credentials|secret.*missing|token.*expired|env.*not set|missing.*env/i.test(blockedReason)) {
    const envVar = blockedReason.match(/\b([A-Z][A-Z_]{2,})\b/)?.[1] || "THE_MISSING_KEY";
    commands.push(`echo '${envVar}=<value>' >> ~/${getTargetName()}/.env.local`);
  }
  if (/DATABASE_URL|ECONNREFUSED.*5432|connection.*refused/i.test(blockedReason)) {
    commands.push(`cd ~/hydra && docker compose up -d postgres`);
  }
  // Always include the re-queue command
  const escaped = title.replace(/"/g, '\\"').slice(0, 80);
  commands.push(`curl -X POST http://localhost:4000/api/queue -H 'content-type:application/json' -d '{"reference":"${escaped}","reason":"Unblocked by operator","source":"operator"}'`);
  return commands;
}

const BLOCKED_REESCALATE_MS = 12 * 60 * 60 * 1000;

/**
 * External touchpoints of the blocked-escalation chore. Each defaults to the
 * real implementation, so callers (incl. `runHousekeeping`) need only pass the
 * `eventBus`; a unit test stubs just these to exercise the chore in isolation.
 */
export interface BlockedItemEscalationDeps {
  loadBacklog?: typeof loadBacklog;
  getLastEscalation?: typeof getBlockedLastEscalation;
  setLastEscalation?: typeof setBlockedLastEscalation;
  now?: () => number;
}

/**
 * Check for blocked items that need re-escalation. The per-item 12h guard lives
 * inside this body (`BLOCKED_REESCALATE_MS`), so it is safe to call hourly:
 * it iterates the blocked lane and applies its own per-item guard internally.
 */
export async function runBlockedItemEscalation(
  eventBus: PublishableBus,
  deps: BlockedItemEscalationDeps = {},
): Promise<void> {
  const loadBacklogFn = deps.loadBacklog ?? loadBacklog;
  const getLastEscalation = deps.getLastEscalation ?? getBlockedLastEscalation;
  const setLastEscalation = deps.setLastEscalation ?? setBlockedLastEscalation;
  const nowFn = deps.now ?? Date.now;
  try {
    const lanes = await loadBacklogFn();
    // AC5 (issue #140): freeze snapshot so iteration doesn't see mutations
    const blocked = [...(lanes.blocked || [])];
    if (blocked.length === 0) return;

    const now = nowFn();

    for (const item of blocked) {
      const blockedAt = item.meta?.blockedAt ? new Date(item.meta.blockedAt).getTime() : 0;
      if (!blockedAt) continue;
      const age = now - blockedAt;
      if (age < BLOCKED_REESCALATE_MS) continue;

      const lastEsc = await getLastEscalation(String(item.id));
      if (lastEsc && now - parseInt(lastEsc) < BLOCKED_REESCALATE_MS) continue;

      await setLastEscalation(String(item.id), now.toString());
      const ageDays = Math.round(age / (24 * 60 * 60 * 1000));

      const { STREAMS } = await import("../../event-bus-stream-keys.ts");
      await eventBus.publish(STREAMS.NOTIFICATIONS, {
        type: "cycle:operator_blocked",
        source: "scheduler",
        correlationId: `blocked-reescalate-${item.id}`,
        payload: {
          taskId: item.id,
          title: item.title,
          blockedReason: item.meta?.blockedReason || item.description?.slice(0, 100) || "unknown",
          blockedDays: ageDays,
          unblockCommands: generateUnblockCommands(item.meta?.blockedReason || "", item.title),
          reescalation: true,
        },
      });
      console.log(`[Housekeeping] Re-escalated blocked item ${item.id} (${ageDays} days)`);
    }
  } catch (err: any) {
    console.error(`[Housekeeping] Blocked escalation check failed: ${err.message}`);
  }
}
