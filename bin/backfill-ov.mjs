#!/usr/bin/env node

/**
 * Backfill OpenViking only — indexes data already in Redis into OpenViking.
 * Run after backfill.mjs has populated Redis.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const OV_URL = process.env.OPENVIKING_URL || "http://localhost:1933";
const OV_KEY = process.env.OPENVIKING_API_KEY || "1080bb34205409e58aa433512cb5e5d6344560adce963c442543001808181115";
const STAGING_DIR = resolve(process.env.HOME, "hydra", ".ov-staging");

const redis = new Redis(REDIS_URL);
let indexed = 0;
let failed = 0;

async function indexToOV(name, content) {
  await mkdir(STAGING_DIR, { recursive: true });
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
  const filePath = join(STAGING_DIR, `${safeName}.md`);
  await writeFile(filePath, `# ${name}\n\n${content}`);

  const res = await fetch(`${OV_URL}/api/v1/resources`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": OV_KEY },
    body: JSON.stringify({ path: filePath, to: `viking://resources/hydra/${safeName}`, wait: true, timeout: 30 }),
    signal: AbortSignal.timeout(35000),
  });
  if (res.ok) { indexed++; }
  else { failed++; const b = await res.text().catch(() => ""); console.error(`  FAIL "${name}": ${b.slice(0, 150)}`); }
}

async function main() {
  console.log("=== Backfill OpenViking from Redis ===\n");

  // Agent memory rules
  for (const agent of ["planner", "executor", "skeptic"]) {
    const rules = await redis.lrange(`hydra:memory:${agent}:rules`, 0, -1);
    for (const raw of rules) {
      const rule = JSON.parse(raw);
      await indexToOV(
        `memory-${agent}-${rule.cycleId}`,
        `${agent} rule: WHEN ${rule.when} CHECK ${rule.check} BECAUSE ${rule.because}`
      );
    }
    console.log(`[Memory] ${agent}: ${rules.length} rules indexed`);
  }

  // Reality reports (last 50)
  const reportIds = await redis.zrevrange("hydra:reports:reality:index", 0, 49);
  for (const id of reportIds) {
    const raw = await redis.get(`hydra:reports:reality:${id}`);
    if (!raw) continue;
    const report = JSON.parse(raw);
    const summary = `Cycle ${id}: ${report.task?.title} — ${report.task?.finalState}. Tests: ${report.grounding?.before?.passed}→${report.grounding?.after?.passed}. Files: ${(report.filesChanged || []).join(", ")}`;
    await indexToOV(`reality-${id}`, summary);
  }
  console.log(`[Reality] ${reportIds.length} reports indexed`);

  // Research reports
  const researchIds = await redis.zrevrange("hydra:reports:research:index", 0, 19);
  for (const id of researchIds) {
    const raw = await redis.get(`hydra:reports:research:${id}`);
    if (!raw) continue;
    const report = JSON.parse(raw);
    const opps = (report.opportunities || report.synthesis?.opportunities || [])
      .slice(0, 5).map(o => typeof o === "string" ? o : o.title || JSON.stringify(o)).join("; ");
    await indexToOV(`research-${id}`, `Research findings: ${opps}`);
  }
  console.log(`[Research] ${researchIds.length} reports indexed`);

  console.log(`\n=== Done. Indexed: ${indexed}, Failed: ${failed} ===`);
  redis.disconnect();
}

main().catch(err => { console.error(err); redis.disconnect(); process.exit(1); });
