#!/usr/bin/env node

/**
 * Backfill — Migrate historical vault data to Redis + OpenViking.
 *
 * Run once: node bin/backfill.mjs
 *
 * Migrates:
 *   1. Backlog items (backlog.md → Redis)
 *   2. Agent memory rules (agent-memory/*.md → Redis)
 *   3. Reality reports (reports/reality-reports/*.json → Redis)
 *   4. Research reports (reports/research/*.json → Redis)
 *   5. All of the above → OpenViking for semantic search
 */

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import Redis from "ioredis";

const execAsync = promisify(exec);

const VAULT_PATH = resolve(process.env.HOME, "obsidian-vault", "hydra");
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const OV_URL = process.env.OPENVIKING_URL || "http://localhost:1933";
const OV_KEY = process.env.OPENVIKING_API_KEY || "1080bb34205409e58aa433512cb5e5d6344560adce963c442543001808181115";
const STAGING_DIR = resolve(process.env.HOME, "hydra", ".ov-staging");

const redis = new Redis(REDIS_URL);

let ovIndexed = 0;

async function indexToOV(title, content) {
  try {
    // Write content to a temp file, then use the API with a file path
    await mkdir(STAGING_DIR, { recursive: true });
    const safeName = title.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
    const filePath = join(STAGING_DIR, `${safeName}.md`);
    await writeFile(filePath, `# ${title}\n\n${content}`);

    const res = await fetch(`${OV_URL}/api/v1/resources`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": OV_KEY,
      },
      body: JSON.stringify({
        path: filePath,
        to: `viking://resources/hydra/${safeName}`,
        wait: true,
        timeout: 30,
      }),
      signal: AbortSignal.timeout(35000),
    });
    if (res.ok) {
      ovIndexed++;
    } else {
      const body = await res.text().catch(() => "");
      console.error(`  [OV] Failed "${title}": ${res.status} ${body.slice(0, 200)}`);
    }
  } catch (err) {
    console.error(`  [OV] Failed "${title}": ${err.message}`);
  }
}

async function indexFileToOV(filePath) {
  try {
    const res = await fetch(`${OV_URL}/api/v1/resources`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": OV_KEY,
      },
      body: JSON.stringify({
        path: filePath,
        wait: true,
        timeout: 30,
      }),
      signal: AbortSignal.timeout(35000),
    });
    if (res.ok) {
      ovIndexed++;
    } else {
      const body = await res.text().catch(() => "");
      console.error(`  [OV] Failed file "${filePath}": ${res.status} ${body.slice(0, 200)}`);
    }
  } catch (err) {
    console.error(`  [OV] Failed file "${filePath}": ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// 1. Backlog
// ---------------------------------------------------------------------------

async function backfillBacklog() {
  const file = join(VAULT_PATH, "backlog.md");
  let raw;
  try { raw = await readFile(file, "utf-8"); } catch { console.log("[Backlog] No backlog.md found, skipping"); return; }

  // Check if Redis already has backlog data
  const existing = await redis.zcard("hydra:backlog:lane:backlog") +
                   await redis.zcard("hydra:backlog:lane:queued") +
                   await redis.zcard("hydra:backlog:lane:inProgress") +
                   await redis.zcard("hydra:backlog:lane:done");
  if (existing > 0) {
    console.log(`[Backlog] Redis already has ${existing} items, skipping backfill`);
    return;
  }

  const lanes = { backlog: [], queued: [], blocked: [], inProgress: [], done: [] };
  let currentLane = null;

  for (const line of raw.split("\n")) {
    const heading = line.match(/^##\s+(.+)/);
    if (heading) {
      const h = heading[1].toLowerCase();
      if (h.startsWith("backlog")) currentLane = "backlog";
      else if (h.startsWith("queued")) currentLane = "queued";
      else if (h.startsWith("blocked")) currentLane = "blocked";
      else if (h.startsWith("in progress")) currentLane = "inProgress";
      else if (h.startsWith("done")) currentLane = "done";
      else currentLane = null;
      continue;
    }
    if (!currentLane) continue;

    const itemMatch = line.match(/^- \[([ x])\]\s+(.+)/);
    if (itemMatch) {
      const checked = itemMatch[1] === "x";
      const content = itemMatch[2];
      const tags = [...content.matchAll(/#(\w+)/g)].map(m => m[1]);
      let meta = {};
      const metaMatch = content.match(/<!--\s*({.*?})\s*-->/);
      if (metaMatch) try { meta = JSON.parse(metaMatch[1]); } catch {}
      const title = content.replace(/<!--.*?-->/g, "").replace(/#\w+/g, "").trim();
      lanes[currentLane].push({ title, checked, tags, meta });
    }
  }

  let counter = 0;
  for (const [lane, items] of Object.entries(lanes)) {
    for (const item of items) {
      counter++;
      const id = `item-${counter}`;
      const record = { id, title: item.title, checked: item.checked, tags: item.tags, meta: item.meta, lane };
      await redis.hset("hydra:backlog:items", id, JSON.stringify(record));
      const score = lane === "done" ? -(Date.now() - counter * 1000) : Date.now() - (items.length - counter) * 1000;
      await redis.zadd(`hydra:backlog:lane:${lane}`, score, id);
    }
  }
  await redis.set("hydra:backlog:counter", counter);

  const total = Object.values(lanes).reduce((s, l) => s + l.length, 0);
  console.log(`[Backlog] Migrated ${total} items to Redis (backlog:${lanes.backlog.length} queued:${lanes.queued.length} blocked:${lanes.blocked.length} inProgress:${lanes.inProgress.length} done:${lanes.done.length})`);
}

// ---------------------------------------------------------------------------
// 2. Agent Memory
// ---------------------------------------------------------------------------

async function backfillAgentMemory() {
  for (const agent of ["planner", "executor", "skeptic"]) {
    const key = `hydra:memory:${agent}:rules`;
    const existing = await redis.llen(key);
    if (existing > 0) {
      console.log(`[Memory] ${agent} already has ${existing} rules in Redis, skipping`);
      continue;
    }

    let content;
    try { content = await readFile(join(VAULT_PATH, "agent-memory", `${agent}.md`), "utf-8"); } catch { continue; }

    const ruleBlocks = content.split(/^(?=### \[)/m).filter(r => r.trim().startsWith("### ["));
    let migrated = 0;

    for (const block of ruleBlocks) {
      const severityMatch = block.match(/### \[(prevent|reinforce)\]/);
      const dateMatch = block.match(/### \[(?:prevent|reinforce)\] (\d{4}-\d{2}-\d{2})/);
      const cycleMatch = block.match(/### \[(?:prevent|reinforce)\] .+? — (.+)/);
      const whenMatch = block.match(/WHEN: (.+)/);
      const checkMatch = block.match(/CHECK: (.+)/);
      const becauseMatch = block.match(/BECAUSE: (.+)/);

      if (whenMatch && checkMatch && becauseMatch) {
        const rule = {
          severity: severityMatch?.[1] || "prevent",
          date: dateMatch?.[1] || "unknown",
          cycleId: cycleMatch?.[1]?.trim() || "unknown",
          when: whenMatch[1],
          check: checkMatch[1],
          because: becauseMatch[1],
        };
        await redis.rpush(key, JSON.stringify(rule));
        migrated++;

        // Index to OpenViking
        await indexToOV(
          `memory:${agent}:${rule.cycleId}`,
          `${agent} prevention rule: WHEN ${rule.when} CHECK ${rule.check} BECAUSE ${rule.because}`
        );
      }
    }

    // Trim to 30 most recent
    await redis.ltrim(key, -30, -1);
    console.log(`[Memory] ${agent}: migrated ${migrated} rules to Redis`);
  }
}

// ---------------------------------------------------------------------------
// 3. Reality Reports
// ---------------------------------------------------------------------------

async function backfillRealityReports() {
  const existing = await redis.zcard("hydra:reports:reality:index");
  if (existing > 0) {
    console.log(`[Reality] Redis already has ${existing} reports, skipping`);
    return;
  }

  const dir = join(VAULT_PATH, "reports", "reality-reports");
  let files;
  try { files = (await readdir(dir)).filter(f => f.endsWith(".json")).sort(); } catch { return; }

  // Keep only the 50 most recent
  const recentFiles = files.slice(-50);
  let migrated = 0;

  for (const file of recentFiles) {
    try {
      const raw = await readFile(join(dir, file), "utf-8");
      const report = JSON.parse(raw);
      const cycleId = report.cycleId || file.replace(".json", "");
      const ts = new Date(report.timestamp || report.completedAt || Date.now()).getTime();

      await redis.set(`hydra:reports:reality:${cycleId}`, raw);
      await redis.zadd("hydra:reports:reality:index", ts, cycleId);
      migrated++;

      // Index summary to OpenViking
      const summary = `Cycle ${cycleId}: ${report.task?.title} — ${report.task?.finalState}. Tests: ${report.grounding?.before?.passed}→${report.grounding?.after?.passed}. Files: ${(report.filesChanged || []).join(", ")}`;
      await indexToOV(`reality-report:${cycleId}`, summary);
    } catch (err) {
      console.error(`  [Reality] Failed to process ${file}: ${err.message}`);
    }
  }

  console.log(`[Reality] Migrated ${migrated} reports to Redis`);
}

// ---------------------------------------------------------------------------
// 4. Research Reports
// ---------------------------------------------------------------------------

async function backfillResearchReports() {
  const existing = await redis.zcard("hydra:reports:research:index");
  if (existing > 0) {
    console.log(`[Research] Redis already has ${existing} reports, skipping`);
    return;
  }

  const dir = join(VAULT_PATH, "reports", "research");
  let files;
  try { files = (await readdir(dir)).filter(f => f.endsWith(".json")).sort(); } catch { return; }

  const recentFiles = files.slice(-20);
  let migrated = 0;

  for (const file of recentFiles) {
    try {
      const raw = await readFile(join(dir, file), "utf-8");
      const report = JSON.parse(raw);
      const researchId = report.researchId || file.replace(".json", "");
      const ts = new Date(report.timestamp || Date.now()).getTime();

      await redis.set(`hydra:reports:research:${researchId}`, raw);
      await redis.zadd("hydra:reports:research:index", ts, researchId);
      migrated++;

      // Index summary to OpenViking
      const opps = (report.opportunities || report.synthesis?.opportunities || [])
        .slice(0, 5).map(o => o.title || o).join(", ");
      await indexToOV(`research:${researchId}`, `Research: ${opps}`);
    } catch (err) {
      console.error(`  [Research] Failed to process ${file}: ${err.message}`);
    }
  }

  console.log(`[Research] Migrated ${migrated} reports to Redis`);
}

// ---------------------------------------------------------------------------
// 5. Index config files to OpenViking
// ---------------------------------------------------------------------------

async function indexConfigFiles() {
  const CONFIG_PATH = resolve(process.env.HOME, "hydra", "config");
  const sections = ["agents", "feedback", "direction", "research"];

  let indexed = 0;
  for (const section of sections) {
    const dir = join(CONFIG_PATH, section);
    let files;
    try { files = (await readdir(dir)).filter(f => f.endsWith(".md")); } catch { continue; }

    for (const file of files) {
      await indexFileToOV(join(dir, file));
      indexed++;
    }
  }

  console.log(`[Config] Indexed ${indexed} config files to OpenViking`);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Hydra Backfill: Vault → Redis + OpenViking ===\n");

  await backfillBacklog();
  await backfillAgentMemory();
  await backfillRealityReports();
  await backfillResearchReports();
  await indexConfigFiles();

  console.log(`\n=== Done. OpenViking: ${ovIndexed} items indexed ===`);
  redis.disconnect();
}

main().catch(err => {
  console.error("Backfill failed:", err);
  redis.disconnect();
  process.exit(1);
});
