/**
 * learning/knowledge-indexer.ts — background indexer wiring
 *
 * Extracted from learning.ts (issue #219). Watches the operator config
 * directory for changes, polls Redis for new reality reports + memory
 * patterns, and uploads source code via the source-indexer module.
 *
 * Public API: startKnowledgeIndexer() — fire-and-forget setup.
 *
 * Behavior preserved 1:1 from the previous learning.ts implementation.
 */

import { watch } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { indexFile, indexText } from "./ov-upload.ts";
import {
  SOURCE_PATHS,
  runSourceInitialPass,
  makeSourceWatcher,
  setWatchedPaths,
} from "./source-indexer.ts";
import {
  getReportIdsByScore,
  getRealityReport,
  getReportScore,
  getMemoryPatterns,
} from "../redis-adapter.ts";

const CONFIG_PATH = process.env.HYDRA_CONFIG_PATH || resolve(process.env.HOME!, "hydra", "config");
const INDEXABLE_EXTS = new Set([".md", ".txt", ".json", ".yaml", ".yml"]);
const SKIP_DIRS = new Set([".git", "node_modules"]);
const DEBOUNCE_MS = parseInt(process.env.INDEXER_DEBOUNCE_MS as any) || 2000;
const REDIS_POLL_MS = parseInt(process.env.INDEXER_POLL_MS as any) || 30000;

const indexerPending = new Map<string, ReturnType<typeof setTimeout>>();
let lastReportIndex = 0;
let lastRuleCounts: Record<string, number> = {};

function shouldIndex(filePath: string): boolean {
  const rel = relative(CONFIG_PATH, filePath);
  for (const skip of SKIP_DIRS) {
    if (rel.startsWith(skip)) return false;
  }
  return INDEXABLE_EXTS.has(extname(filePath));
}

function onFileChange(_eventType: string, filename: string | null) {
  if (!filename) return;
  const fullPath = resolve(CONFIG_PATH, filename);
  if (!shouldIndex(fullPath)) return;

  if (indexerPending.has(fullPath)) clearTimeout(indexerPending.get(fullPath)!);
  indexerPending.set(
    fullPath,
    setTimeout(() => {
      indexerPending.delete(fullPath);
      indexFile(fullPath);
    }, DEBOUNCE_MS)
  );
}

async function pollRedisContent() {
  try {
    const reportIds = await getReportIdsByScore(lastReportIndex);
    for (const id of reportIds) {
      const raw = await getRealityReport(id);
      if (raw) {
        const report = JSON.parse(raw);
        const summary = `Cycle ${report.cycleId}: ${report.task?.title} — ${report.task?.finalState}. Tests: ${report.grounding?.before?.passed}→${report.grounding?.after?.passed}`;
        await indexText(`reality-report:${id}`, summary);
      }
    }
    if (reportIds.length > 0) {
      const latest = await getReportScore(reportIds[reportIds.length - 1]);
      lastReportIndex = parseInt(latest as string) || lastReportIndex;
    }

    for (const agent of ["planner", "executor", "skeptic"]) {
      const raw = await getMemoryPatterns(agent);
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
  } catch (err: any) {
    console.error(`[Learning:Indexer] Redis poll failed: ${err.message}`);
  }
}

let indexerInterval: ReturnType<typeof setInterval> | null = null;

export function startKnowledgeIndexer() {
  console.log(`[Learning:Indexer] Watching configs: ${CONFIG_PATH}`);
  console.log(`[Learning:Indexer] Polling Redis every ${REDIS_POLL_MS / 1000}s`);

  setWatchedPaths([CONFIG_PATH, ...SOURCE_PATHS.map(s => `${s.root}(${s.ext})`)]);

  // Watch config files
  try {
    watch(CONFIG_PATH, { recursive: true }, onFileChange);
  } catch (err: any) {
    console.error(`[Learning:Indexer] fs.watch failed: ${err.message}`);
  }

  // Issue #210: Watch source paths (src/, docs/, test/) so agents can
  // semantically retrieve actual implementation context. The watcher
  // shares indexerPending with the config watcher so debounce dedup
  // is global across both surfaces.
  for (const source of SOURCE_PATHS) {
    try {
      watch(source.root, { recursive: true }, makeSourceWatcher(source, indexerPending, DEBOUNCE_MS));
      console.log(`[Learning:Indexer] Watching source: ${source.root} (${source.ext})`);
    } catch (err: any) {
      // ENOENT for missing dir is non-fatal (e.g. docs/ may not exist).
      if (err.code === "ENOENT") {
        console.log(`[Learning:Indexer] Source path missing, skipping: ${source.root}`);
      } else {
        console.error(`[Learning:Indexer] fs.watch failed for ${source.root}: ${err.message}`);
      }
    }
  }

  // Initial-index pass: upload recently-modified source files in the
  // background so agents have code-level context after a restart.
  runSourceInitialPass()
    .then(({ scanned, indexed, skipped }) => {
      console.log(`[Learning:Indexer] Initial source pass: scanned=${scanned} indexed=${indexed} skipped=${skipped}`);
    })
    .catch((err: any) => console.error(`[Learning:Indexer] Initial source pass failed: ${err.message}`));

  // Poll Redis for new content
  indexerInterval = setInterval(() => pollRedisContent(), REDIS_POLL_MS);
  pollRedisContent();
}

// Suppress unused-var lint without exporting; runtime keeps interval alive.
void indexerInterval;
