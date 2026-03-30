#!/usr/bin/env node

/**
 * Vault File Watcher
 *
 * Watches the Obsidian vault for changes and indexes modified files
 * into OpenViking using the `ov` CLI.
 *
 * Uses Node.js fs.watch (recursive) instead of inotifywait for zero
 * system dependencies beyond Node.
 */

import { watch } from "node:fs";
import { exec } from "node:child_process";
import { resolve, extname, relative } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const VAULT_PATH = process.env.HYDRA_VAULT_PATH || resolve(process.env.HOME, "obsidian-vault");
const OV_BIN = process.env.OV_BIN || "ov";
const DEBOUNCE_MS = parseInt(process.env.WATCHER_DEBOUNCE_MS) || 2000;

// File extensions to index
const INDEXABLE_EXTS = new Set([".md", ".txt", ".json", ".yaml", ".yml", ".csv"]);

// Directories to skip
const SKIP_DIRS = new Set([".obsidian", ".git", "node_modules", ".trash", "orchestrator/node_modules"]);

const pending = new Map(); // path -> timeout

function shouldIndex(filePath) {
  const rel = relative(VAULT_PATH, filePath);
  for (const skip of SKIP_DIRS) {
    if (rel.startsWith(skip)) return false;
  }
  return INDEXABLE_EXTS.has(extname(filePath));
}

async function indexFile(filePath) {
  const rel = relative(VAULT_PATH, filePath);
  try {
    const { stdout, stderr } = await execAsync(
      `${OV_BIN} add-resource "${filePath}" --wait --timeout 30`,
      { timeout: 60000 }
    );
    console.log(`[VaultWatcher] Indexed: ${rel}`);
    if (stderr) console.error(`[VaultWatcher] stderr: ${stderr}`);
  } catch (err) {
    // If file was deleted, that's fine
    if (err.message.includes("ENOENT") || err.message.includes("not found")) {
      console.log(`[VaultWatcher] Skipped (removed): ${rel}`);
    } else {
      console.error(`[VaultWatcher] Failed to index ${rel}:`, err.message);
    }
  }
}

function onFileChange(eventType, filename) {
  if (!filename) return;

  const fullPath = resolve(VAULT_PATH, filename);
  if (!shouldIndex(fullPath)) return;

  // Debounce: wait for writes to settle
  if (pending.has(fullPath)) {
    clearTimeout(pending.get(fullPath));
  }

  pending.set(
    fullPath,
    setTimeout(() => {
      pending.delete(fullPath);
      indexFile(fullPath);
    }, DEBOUNCE_MS)
  );
}

console.log(`[VaultWatcher] Watching ${VAULT_PATH}`);
console.log(`[VaultWatcher] Indexable extensions: ${[...INDEXABLE_EXTS].join(", ")}`);
console.log(`[VaultWatcher] Skipping: ${[...SKIP_DIRS].join(", ")}`);
console.log(`[VaultWatcher] Debounce: ${DEBOUNCE_MS}ms`);

watch(VAULT_PATH, { recursive: true }, onFileChange);

// Keep alive
process.on("SIGINT", () => {
  console.log("\n[VaultWatcher] Shutting down...");
  process.exit(0);
});
process.on("SIGTERM", () => {
  console.log("[VaultWatcher] Shutting down...");
  process.exit(0);
});
