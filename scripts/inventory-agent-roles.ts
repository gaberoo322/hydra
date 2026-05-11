#!/usr/bin/env -S npx tsx
/**
 * inventory-agent-roles.ts — One-shot enumeration of agent roles in Redis.
 *
 * Issue #303: cost-attribution shows 38-48% of runs classified as "unknown"
 * because `agentRoleToTier()` only knows a hand-rolled list of roles. This
 * helper scans `hydra:cycle:*:agents` lists across recent cycles and prints
 * a frequency table so we can confirm exactly which role strings the system
 * is emitting.
 *
 * Usage:
 *   npx tsx scripts/inventory-agent-roles.ts          # last 100 cycles
 *   npx tsx scripts/inventory-agent-roles.ts --limit 200
 *   npx tsx scripts/inventory-agent-roles.ts --json   # machine-readable
 *
 * Output (default): a sorted table of {role, count, sample-cycle, has-model}.
 *
 * Read-only. No mutations.
 */

import { findKeys, listRange } from "../src/redis-adapter.ts";
import { agentRoleToTier } from "../src/cost-attribution.ts";

interface RoleRow {
  role: string;
  count: number;
  withModel: number;
  withoutModel: number;
  sampleCycle: string;
  sampleModel: string | null;
  inferredTier: string;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  let limit = 100;
  let asJson = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit") {
      limit = parseInt(argv[++i] || "100", 10);
    } else if (a === "--json") {
      asJson = true;
    } else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: inventory-agent-roles.ts [--limit N] [--json]\n",
      );
      return 0;
    }
  }

  const keys = await findKeys("hydra:cycle:*:agents");
  // Cycle IDs are date-stamped (cycle-YYYY-MM-DD-HHMM); lexicographic sort
  // is chronological so the tail is the most recent.
  keys.sort();
  const window = keys.slice(-limit);

  const byRole = new Map<string, RoleRow>();

  for (const key of window) {
    const cycleId = key.replace(/^hydra:cycle:/, "").replace(/:agents$/, "");
    const entries = await listRange(key, 0, -1);
    for (const raw of entries) {
      let parsed: any;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      const role = String(parsed?.agent ?? "<missing>");
      const model: string | undefined = parsed?.model;
      const row = byRole.get(role) || {
        role,
        count: 0,
        withModel: 0,
        withoutModel: 0,
        sampleCycle: cycleId,
        sampleModel: model ?? null,
        inferredTier: agentRoleToTier(role),
      };
      row.count += 1;
      if (model) row.withModel += 1;
      else row.withoutModel += 1;
      // Prefer a sample with a model attached for diagnostics
      if (!row.sampleModel && model) {
        row.sampleModel = model;
        row.sampleCycle = cycleId;
      }
      byRole.set(role, row);
    }
  }

  const rows = [...byRole.values()].sort((a, b) => b.count - a.count);
  const totalRuns = rows.reduce((s, r) => s + r.count, 0);
  const unmapped = rows.filter((r) => r.inferredTier === "unknown");

  if (asJson) {
    process.stdout.write(
      JSON.stringify(
        {
          windowCycles: window.length,
          totalRuns,
          unmappedRunsPct:
            totalRuns > 0
              ? Math.round(
                  (unmapped.reduce((s, r) => s + r.count, 0) / totalRuns) * 10000,
                ) / 100
              : 0,
          rows,
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }

  process.stdout.write(
    `Scanned ${window.length} cycles, ${totalRuns} agent runs.\n\n`,
  );
  process.stdout.write(
    "role".padEnd(28) +
      "count".padStart(8) +
      "with-model".padStart(12) +
      "tier (role->)".padStart(16) +
      "  sample-model\n",
  );
  process.stdout.write("-".repeat(80) + "\n");
  for (const r of rows) {
    process.stdout.write(
      r.role.padEnd(28) +
        String(r.count).padStart(8) +
        String(r.withModel).padStart(12) +
        r.inferredTier.padStart(16) +
        "  " +
        (r.sampleModel ?? "(none)") +
        "\n",
    );
  }
  if (unmapped.length > 0) {
    const pct =
      totalRuns > 0
        ? Math.round(
            (unmapped.reduce((s, r) => s + r.count, 0) / totalRuns) * 10000,
          ) / 100
        : 0;
    process.stdout.write(
      `\nUnmapped roles (agentRoleToTier => "unknown"): ${unmapped
        .map((r) => `${r.role}(${r.count})`)
        .join(", ")} — ${pct}% of runs.\n`,
    );
  } else {
    process.stdout.write("\nAll roles map to a known tier.\n");
  }
  return 0;
}

main()
  .then((code) => {
    // Force-close any open Redis connections so the script exits promptly.
    setTimeout(() => process.exit(code), 50).unref();
  })
  .catch((err) => {
    console.error("[inventory-agent-roles] fatal:", err);
    process.exit(1);
  });
