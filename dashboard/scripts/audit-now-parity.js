#!/usr/bin/env node
/**
 * audit-now-parity.js — assert /now-pixel uses every API endpoint /now
 * uses.
 *
 * Slice 7 of /now-pixel (#642, #649). The point is to give us a hard
 * check before flipping the atomic swap (PR 2): if /now-pixel forgot
 * a signal /now had, the audit fires and CI blocks the merge.
 *
 * How it works:
 *   - Recursively scans the JSX trees rooted at dashboard/src/pages/Now.jsx
 *     and dashboard/src/pages/now-pixel/NowPixel.jsx.
 *   - Greps for `useApi("/...")` and `apiFetch("/...")` calls.
 *   - For WS frames, both pages use the shared `useWebSocket` hook, so
 *     we treat that as a single "ws" endpoint that's covered as long
 *     as both pages call `useWebSocket()` somewhere downstream.
 *   - Compares the endpoint sets. /now-pixel ⊇ /now or the script
 *     exits with code 1 and prints the gap.
 *
 * Usage:
 *   node dashboard/scripts/audit-now-parity.js
 *
 * The CI hook is test/now-parity-audit.test.mts which invokes this
 * script and asserts a zero exit code.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const pagesRoot = path.join(repoRoot, "dashboard/src/pages");

const NOW_CLASSIC_ENTRY = path.join(pagesRoot, "Now.jsx");
const NOW_PIXEL_ENTRY = path.join(pagesRoot, "now-pixel/NowPixel.jsx");

// Match useApi("/foo/bar") and apiFetch("/foo/bar") — handles backticks +
// double quotes. Query strings on the path (e.g. `?sinceMinutes=60`) are
// stripped so /now/alerts?... matches /now/alerts.
const API_CALL_RE = /(?:useApi|apiFetch)\s*\(\s*[`"']([^`"'?]+)/g;

// Match useWebSocket presence (any reference resolves the WS dependency).
const WS_HOOK_RE = /\buseWebSocket\b/;

/**
 * Walk JSX imports from a root file. We only follow relative imports
 * pointing at .jsx, .js, or .ts/.tsx files under the same project tree.
 */
async function walkImports(root) {
  const visited = new Set();
  const queue = [root];
  const files = [];
  while (queue.length) {
    const f = queue.shift();
    if (visited.has(f)) continue;
    visited.add(f);
    let src;
    try {
      src = await fs.readFile(f, "utf8");
    } catch {
      continue;
    }
    files.push({ file: f, src });
    const dir = path.dirname(f);
    const importRe = /import\s+(?:[^"';]+from\s+)?["']([^"']+)["']/g;
    let m;
    while ((m = importRe.exec(src)) !== null) {
      const spec = m[1];
      if (!spec.startsWith(".") && !spec.startsWith("/")) continue;
      for (const ext of [".jsx", ".js", ".ts", ".tsx"]) {
        const candidate = path.resolve(dir, spec + (spec.endsWith(ext) ? "" : ext));
        try {
          await fs.access(candidate);
          if (!visited.has(candidate)) queue.push(candidate);
          break;
        } catch {
          /* try next ext */
        }
      }
    }
  }
  return files;
}

function collectEndpoints(files) {
  const endpoints = new Set();
  let hasWs = false;
  for (const { src } of files) {
    if (WS_HOOK_RE.test(src)) hasWs = true;
    let m;
    while ((m = API_CALL_RE.exec(src)) !== null) {
      endpoints.add(m[1]);
    }
  }
  if (hasWs) endpoints.add("ws://");
  return endpoints;
}

export async function auditNowParity() {
  const [classicFiles, pixelFiles] = await Promise.all([
    walkImports(NOW_CLASSIC_ENTRY),
    walkImports(NOW_PIXEL_ENTRY),
  ]);
  const classicEndpoints = collectEndpoints(classicFiles);
  const pixelEndpoints = collectEndpoints(pixelFiles);

  const missing = [];
  for (const ep of classicEndpoints) {
    if (!pixelEndpoints.has(ep)) missing.push(ep);
  }

  return {
    classicEndpoints: [...classicEndpoints].sort(),
    pixelEndpoints: [...pixelEndpoints].sort(),
    missing,
    parityOk: missing.length === 0,
  };
}

const invokedDirectly =
  import.meta.url.startsWith("file:") &&
  process.argv[1] &&
  import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;

if (invokedDirectly) {
  auditNowParity().then(
    (result) => {
      process.stdout.write(
        `audit-now-parity: classic=${result.classicEndpoints.length} pixel=${result.pixelEndpoints.length}\n`,
      );
      process.stdout.write(
        `  classic: ${result.classicEndpoints.join(", ")}\n`,
      );
      process.stdout.write(
        `  pixel:   ${result.pixelEndpoints.join(", ")}\n`,
      );
      if (result.parityOk) {
        process.stdout.write("audit-now-parity: OK\n");
        process.exit(0);
      } else {
        process.stderr.write(
          `audit-now-parity: PARITY GAP — /now-pixel is missing ${result.missing.length} endpoint(s): ${result.missing.join(", ")}\n`,
        );
        process.exit(1);
      }
    },
    (err) => {
      process.stderr.write(`audit-now-parity: failed: ${err.message}\n`);
      process.exit(2);
    },
  );
}
