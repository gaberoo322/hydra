#!/usr/bin/env node

/**
 * Knowledge Indexer
 *
 * Indexes content into OpenViking for semantic search by agents.
 * Replaces vault-watcher.mjs — watches git-tracked configs and
 * subscribes to Redis for new reports/rules to index.
 *
 * Sources:
 *   1. Config files (~/hydra/config/) — watched via fs.watch
 *   2. Reality reports — polled from Redis
 *   3. Agent memory rules — polled from Redis
 *   4. Cycle summaries — polled from Redis
 */

import { watch } from "node:fs";
import { writeFile, unlink } from "node:fs/promises";
import { resolve, extname, relative, join } from "node:path";
import { tmpdir } from "node:os";
import Redis from "ioredis";

const CONFIG_PATH = process.env.HYDRA_CONFIG_PATH || resolve(process.env.HOME, "hydra", "config");
const OV_URL = process.env.OPENVIKING_URL || "http://localhost:1933";
const OV_KEY = process.env.OPENVIKING_API_KEY || "56611b96a5aa35614ceb40814bb9d989d9523a764b386f569e0d1327c78d350c";
// Config path as seen from inside the OV Docker container
const OV_CONFIG_MOUNT = process.env.OV_CONFIG_MOUNT || "/config";
const DEBOUNCE_MS = parseInt(process.env.INDEXER_DEBOUNCE_MS) || 2000;
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const REDIS_POLL_MS = parseInt(process.env.INDEXER_POLL_MS) || 30000; // 30s

const INDEXABLE_EXTS = new Set([".md", ".txt", ".json", ".yaml", ".yml"]);
const SKIP_DIRS = new Set([".git", "node_modules"]);

const pending = new Map();

function shouldIndex(filePath) {
  const rel = relative(CONFIG_PATH, filePath);
  for (const skip of SKIP_DIRS) {
    if (rel.startsWith(skip)) return false;
  }
  return INDEXABLE_EXTS.has(extname(filePath));
}

async function indexFile(filePath) {
  const rel = relative(CONFIG_PATH, filePath);
  // Translate host path to container-mounted path
  const containerPath = join(OV_CONFIG_MOUNT, rel);
  try {
    const res = await fetch(`${OV_URL}/api/v1/resources`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": OV_KEY },
      body: JSON.stringify({ path: containerPath }),
      signal: AbortSignal.timeout(60000),
    });
    if (res.ok) {
      console.log(`[Indexer] Indexed file: ${rel}`);
    } else {
      const err = await res.text();
      if (err.includes("not exist") || err.includes("ENOENT")) {
        console.log(`[Indexer] Skipped (removed): ${rel}`);
      } else {
        console.error(`[Indexer] Failed to index ${rel}: ${err.slice(0, 200)}`);
      }
    }
  } catch (err) {
    console.error(`[Indexer] Failed to index ${rel}:`, err.message);
  }
}

async function indexText(title, content) {
  // Use temp_upload API then reference the temp path
  const safeName = title.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  const tmpFile = join(tmpdir(), `hydra-indexer-${safeName}-${Date.now()}.md`);
  try {
    // Write temp file and upload it
    await writeFile(tmpFile, `# ${title}\n\n${content}`, "utf-8");

    // Upload via temp_upload endpoint
    const fileContent = await import("node:fs/promises").then(fs => fs.readFile(tmpFile));
    const formData = new FormData();
    formData.append("file", new Blob([fileContent], { type: "text/markdown" }), `${safeName}.md`);

    const uploadRes = await fetch(`${OV_URL}/api/v1/resources/temp_upload`, {
      method: "POST",
      headers: { "X-Api-Key": OV_KEY },
      body: formData,
      signal: AbortSignal.timeout(30000),
    });

    if (uploadRes.ok) {
      const uploadData = await uploadRes.json() as any;
      const tempPath = uploadData.temp_path || uploadData.path;

      if (tempPath) {
        // Now add the resource from the temp path
        const addRes = await fetch(`${OV_URL}/api/v1/resources`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Api-Key": OV_KEY },
          body: JSON.stringify({ temp_path: tempPath, to: `viking://resources/hydra-memory/${safeName}` }),
          signal: AbortSignal.timeout(60000),
        });
        if (addRes.ok) {
          console.log(`[Indexer] Indexed text: ${title}`);
        } else {
          console.error(`[Indexer] Failed to add text "${title}": ${(await addRes.text()).slice(0, 200)}`);
        }
      }
    } else {
      console.error(`[Indexer] Failed to upload text "${title}": ${(await uploadRes.text()).slice(0, 200)}`);
    }
  } catch (err) {
    console.error(`[Indexer] Failed to index text "${title}":`, err.message);
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
}

function onFileChange(eventType, filename) {
  if (!filename) return;
  const fullPath = resolve(CONFIG_PATH, filename);
  if (!shouldIndex(fullPath)) return;

  if (pending.has(fullPath)) clearTimeout(pending.get(fullPath));
  pending.set(
    fullPath,
    setTimeout(() => {
      pending.delete(fullPath);
      indexFile(fullPath);
    }, DEBOUNCE_MS)
  );
}

// ---------------------------------------------------------------------------
// Redis polling — index new reports and rules
// ---------------------------------------------------------------------------

let lastReportIndex = 0;
let lastRuleCounts = {};

async function pollRedisContent(redis) {
  try {
    // Index new reality reports
    const reportIds = await redis.zrangebyscore("hydra:reports:reality:index", lastReportIndex + 1, "+inf");
    for (const id of reportIds) {
      const raw = await redis.get(`hydra:reports:reality:${id}`);
      if (raw) {
        const report = JSON.parse(raw);
        const summary = `Cycle ${report.cycleId}: ${report.task?.title} — ${report.task?.finalState}. Tests: ${report.grounding?.before?.passed}→${report.grounding?.after?.passed}`;
        await indexText(`reality-report:${id}`, summary);
      }
    }
    if (reportIds.length > 0) {
      const latest = await redis.zscore("hydra:reports:reality:index", reportIds[reportIds.length - 1]);
      lastReportIndex = parseInt(latest) || lastReportIndex;
    }

    // Index agent memory patterns (migrated from legacy rules)
    for (const agent of ["planner", "executor", "skeptic"]) {
      const key = `hydra:memory:${agent}:patterns`;
      const raw = await redis.get(key);
      if (!raw) continue;
      try {
        const patterns = JSON.parse(raw);
        const patternCount = patterns.length;
        const prev = lastRuleCounts[agent] || 0;
        if (patternCount > prev) {
          for (const p of patterns.slice(prev)) {
            const text = `${agent} pattern [${p.severity}]: ${p.category} (${p.hitCount}x) — ACTION: ${p.action}. Last: ${p.lastCycleId}`;
            await indexText(`memory:${agent}:${p.category}`, text);
          }
          lastRuleCounts[agent] = patternCount;
        }
      } catch { /* intentional: skip unparseable patterns */ }
    }
  } catch (err) {
    console.error(`[Indexer] Redis poll failed:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const redis = new Redis(REDIS_URL);

console.log(`[Indexer] Watching configs: ${CONFIG_PATH}`);
console.log(`[Indexer] Polling Redis every ${REDIS_POLL_MS / 1000}s for reports/rules`);
console.log(`[Indexer] Debounce: ${DEBOUNCE_MS}ms`);

// Watch config files
watch(CONFIG_PATH, { recursive: true }, onFileChange);

// Poll Redis for new content
setInterval(() => pollRedisContent(redis), REDIS_POLL_MS);
// Initial poll
pollRedisContent(redis);

process.on("SIGINT", () => {
  console.log("\n[Indexer] Shutting down...");
  (redis as any).disconnect();
  process.exit(0);
});
process.on("SIGTERM", () => {
  console.log("[Indexer] Shutting down...");
  (redis as any).disconnect();
  process.exit(0);
});
