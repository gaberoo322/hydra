#!/usr/bin/env node
/**
 * scripts/test/test-durations.mjs — rank test files by wall time (issue #5275).
 *
 * Read-only (INV-8): reads the NDJSON capture the suite-count reporter writes
 * during any `npm test` (default `.suite-count-capture.ndjson`) plus the pool
 * manifest; never runs tests and never writes a file. Per-file `duration_ms`
 * is summed over the file's top-level rows, so with `--test-force-exit`
 * truncation (#4137) totals are a lower bound.
 *
 *   node scripts/test/test-durations.mjs [--top N] [--pool serial|parallel] [--capture <path>]
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadManifest, REPO_ROOT, splitPools } from "./test-pools.mjs";

/** Sum duration_ms per file and label each file's pool from the manifest. */
export function aggregateDurations(rows, manifest, baselineFiles = []) {
  const sums = new Map();
  for (const r of rows) {
    if (!r || typeof r.file !== "string" || typeof r.duration_ms !== "number") continue;
    sums.set(r.file, (sums.get(r.file) ?? 0) + r.duration_ms);
  }
  const files = [...sums.keys()];
  const { parallel } = splitPools(files, manifest);
  const par = new Set(parallel);
  const entries = files
    .map((file) => ({ file, pool: par.has(file) ? "parallel" : "serial", ms: sums.get(file) }))
    .sort((a, b) => b.ms - a.ms || a.file.localeCompare(b.file));
  const totals = { serial: { files: 0, ms: 0 }, parallel: { files: 0, ms: 0 } };
  for (const e of entries) {
    totals[e.pool].files += 1;
    totals[e.pool].ms += e.ms;
  }
  const zeroRows = baselineFiles.filter((f) => !sums.has(f)).length;
  return { entries, totals, zeroRows };
}

export function parseNdjson(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* intentional: a torn trailing line from a force-exit truncation is skipped */
    }
  }
  return rows;
}

export function renderReport({ entries, totals, zeroRows = 0 }, { top = 25, pool = null } = {}) {
  const shown = entries.filter((e) => pool === null || e.pool === pool).slice(0, top);
  const lines = [`Top ${shown.length} test files by wall time${pool ? ` (${pool} pool)` : ""}:`];
  for (const e of shown) lines.push(`${String(Math.round(e.ms)).padStart(8)} ms  ${e.pool.padEnd(8)}  ${e.file}`);
  lines.push("");
  for (const p of ["serial", "parallel"]) {
    lines.push(`${p.padEnd(8)} pool: ${totals[p].files} file(s), ${Math.round(totals[p].ms)} ms summed`);
  }
  lines.push(`${zeroRows} baselined test file(s) with zero capture rows (not run, or truncated by --test-force-exit)`);
  return lines.join("\n") + "\n";
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const argv = process.argv.slice(2);
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const top = Number.parseInt(opt("--top") ?? "25", 10);
  const pool = opt("--pool") ?? null;
  if (pool !== null && pool !== "serial" && pool !== "parallel") {
    process.stderr.write(`[test-durations] --pool must be serial or parallel (got ${pool})\n`);
    process.exit(2);
  }
  const capture = opt("--capture") ?? join(REPO_ROOT, ".suite-count-capture.ndjson");
  if (!existsSync(capture)) {
    process.stdout.write(`[test-durations] no capture at ${capture}; run \`npm test\` first (nothing to report).\n`);
  } else {
    const baselinePath = join(REPO_ROOT, "test", "fixtures", "suite-count-baseline.json");
    const baselineFiles = existsSync(baselinePath) ? Object.keys(JSON.parse(readFileSync(baselinePath, "utf8"))) : [];
    const agg = aggregateDurations(parseNdjson(readFileSync(capture, "utf8")), loadManifest(), baselineFiles);
    process.stdout.write(renderReport(agg, { top: Number.isInteger(top) && top > 0 ? top : 25, pool }));
  }
}
