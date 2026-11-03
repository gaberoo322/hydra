#!/usr/bin/env node
/**
 * scripts/test/test-pools.mjs — serial/parallel pool classification for the
 * full-suite run (issue #5199, amends ADR-0038).
 *
 * The suite runs `--test-concurrency=1` because every Redis-touching file
 * shares the run's ONE Redis DB (see redis-db-launch.mjs). Files that provably
 * never reach Redis (nor share another global resource) can run concurrently
 * without any isolation change. This module owns that classification:
 *
 *   - `scanPools(root)` — conservative static scan: a test file is PURE only if
 *     neither it nor anything it transitively imports / spawns (relative
 *     imports, plus `scripts/`/`src/` paths named in string literals) mentions
 *     a Redis marker. Misclassification toward "touches Redis" is always safe.
 *   - `test/fixtures/test-pools.json` — the committed manifest
 *     `{ parallel: [...], serialPinned: { file: reason } }`, regenerated with
 *     `node scripts/test/test-pools.mjs --update` (same ratchet convention as
 *     the suite-count baseline) and drift-guarded by test/test-pools.test.mts.
 *   - `splitPools(files, manifest)` — INV-2 default-serial: a file is parallel
 *     only if listed in `parallel` and not in `serialPinned`; anything the
 *     manifest does not name (incl. every new test file) runs serial.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..");
export const MANIFEST_PATH = join(REPO_ROOT, "test", "fixtures", "test-pools.json");

/** Markers meaning "this source reaches the per-run Redis DB". */
export const REDIS_MARKERS =
  /ioredis|REDIS_URL|new Redis\(|redis-cli|HYDRA_REDIS_DB|\brc_write\b|\brc_read\b|\/redis\/|_helpers\/redis-db/;

/** Other shared-global-state hazards that stay serial even when Redis-free. */
const HAZARDS = [
  [/git\s+worktree|["'`]worktree["'`]\s*,\s*["'`](add|remove|prune)/, "runs `git worktree` operations against a shared repo (index.lock contention)"],
  [/["'`]\/tmp\/[A-Za-z0-9_.-]+/, "uses a fixed /tmp path (clobbers under concurrency)"],
];

const SOURCE_EXTS = [".ts", ".mts", ".js", ".mjs", ".sh", ".py", ".json"];
const IMPORT_RE = /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)["'`](\.{1,2}\/[^"'`]+)["'`]/g;
const PATH_LITERAL_RE = /["'`]([A-Za-z0-9_./-]+\.(?:ts|mts|mjs|js|sh|py))["'`]/g;

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    /* intentional: absent directory (e.g. no hooks dir) contributes no files */
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === ".git" || e.startsWith(".")) continue;
    const p = join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      /* intentional: dangling symlink / racing delete — skip the entry */
      continue;
    }
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function resolveRelative(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [base, ...SOURCE_EXTS.map((x) => base + x), ...SOURCE_EXTS.map((x) => join(base, "index" + x))];
  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).isFile()) return c;
    } catch {
      /* intentional: unreadable candidate — try the next */
    }
  }
  return null;
}

/** Scan test/*.test.mts under `root`; returns the manifest shape. */
export function scanPools(root = REPO_ROOT) {
  const byBase = new Map();
  for (const sub of ["scripts", "src"]) {
    for (const f of walk(join(root, sub), [])) {
      const b = f.slice(f.lastIndexOf("/") + 1);
      if (!byBase.has(b)) byBase.set(b, []);
      byBase.get(b).push(f);
    }
  }
  const textCache = new Map();
  const read = (f) => {
    if (!textCache.has(f)) {
      try {
        textCache.set(f, readFileSync(f, "utf8"));
      } catch {
        /* intentional: unreadable dependency is treated as empty; the test file itself is read below */
        textCache.set(f, "");
      }
    }
    return textCache.get(f);
  };
  const depsOf = (f) => {
    const text = read(f);
    const deps = new Set();
    for (const m of text.matchAll(IMPORT_RE)) {
      const r = resolveRelative(f, m[1]);
      if (r) deps.add(r);
    }
    for (const m of text.matchAll(PATH_LITERAL_RE)) {
      const lit = m[1];
      const asRel = lit.includes("/") ? [resolve(dirname(f), lit), resolve(root, lit)] : [];
      let hit = false;
      for (const c of asRel) {
        if (existsSync(c) && statSync(c).isFile()) {
          deps.add(c);
          hit = true;
        }
      }
      if (!hit && /\.(sh|py)$/.test(lit)) {
        for (const c of byBase.get(lit.slice(lit.lastIndexOf("/") + 1)) ?? []) deps.add(c);
      }
    }
    return deps;
  };
  const reachMemo = new Map();
  const reachesRedis = (start) => {
    const seen = new Set();
    const stack = [start];
    while (stack.length > 0) {
      const f = stack.pop();
      if (seen.has(f)) continue;
      seen.add(f);
      if (reachMemo.get(f) === true || REDIS_MARKERS.test(read(f))) {
        reachMemo.set(start, true);
        return true;
      }
      for (const d of depsOf(f)) stack.push(d);
    }
    reachMemo.set(start, false);
    return false;
  };

  const testDir = join(root, "test");
  const files = readdirSync(testDir)
    .filter((f) => f.endsWith(".test.mts"))
    .sort();
  const parallel = [];
  const serialPinned = {};
  for (const name of files) {
    const abs = join(testDir, name);
    const rel = `test/${name}`;
    if (reachesRedis(abs)) continue;
    const text = read(abs);
    const hazard = HAZARDS.find(([re]) => re.test(text));
    if (hazard) {
      serialPinned[rel] = hazard[1];
      continue;
    }
    parallel.push(rel);
  }
  return { parallel, serialPinned };
}

export function loadManifest(path = MANIFEST_PATH) {
  const m = JSON.parse(readFileSync(path, "utf8"));
  return { parallel: m.parallel ?? [], serialPinned: m.serialPinned ?? {} };
}

/**
 * INV-2: split a test file list into pools. Default-serial — only a file named
 * in `parallel` and absent from `serialPinned` goes parallel. Order preserved.
 */
export function splitPools(files, manifest) {
  const par = new Set(manifest.parallel);
  const pinned = new Set(Object.keys(manifest.serialPinned));
  const parallel = [];
  const serial = [];
  for (const f of files) {
    const norm = f.replace(/^\.\//, "");
    (par.has(norm) && !pinned.has(norm) ? parallel : serial).push(f);
  }
  return { serial, parallel };
}

/** Default parallel-pool concurrency (INV-8): never os.availableParallelism(). */
export const DEFAULT_PARALLEL_CONCURRENCY = 4;

export function parallelConcurrency(env = process.env) {
  const n = Number.parseInt(env.HYDRA_TEST_PARALLEL_CONCURRENCY ?? "", 10);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_PARALLEL_CONCURRENCY;
}

const DEST_FLAG = "--test-reporter-destination=";

/**
 * Build the per-pool `node --test` argv lists from the ORIGINAL launcher argv
 * (command + flags + shell-expanded test files). INV-5: node truncates a
 * reporter destination file on open, so every non-stdout/stderr destination is
 * rewritten to `<path>.<pool>` per child; `merged` lists the original paths the
 * launcher must rebuild by concatenating the per-pool files after both exit.
 * INV-9: concurrency flags are set here, not in package.json.
 * Returns `parallel: null` when no file qualifies (single serial child).
 */
export function buildPoolInvocations(args, manifest, concurrency = DEFAULT_PARALLEL_CONCURRENCY) {
  const isTestFile = (a) => /\.test\.mts$/.test(a);
  const files = args.filter(isTestFile);
  const base = args.filter((a) => !isTestFile(a));
  const { serial, parallel } = splitPools(files, manifest);
  const merged = [];
  const make = (pool, poolFiles, conc) => {
    const flags = base.map((a) => {
      if (!a.startsWith(DEST_FLAG)) return a;
      const dest = a.slice(DEST_FLAG.length);
      if (dest === "stdout" || dest === "stderr") return a;
      if (!merged.includes(dest)) merged.push(dest);
      return `${DEST_FLAG}${dest}.${pool}`;
    });
    return { pool, argv: [...flags, `--test-concurrency=${conc}`, ...poolFiles], files: poolFiles };
  };
  const serialInv = make("serial", serial, 1);
  const parallelInv = parallel.length > 0 ? make("parallel", parallel, concurrency) : null;
  return { serial: serialInv, parallel: parallelInv, merged };
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const scanned = scanPools();
  if (process.argv.includes("--update")) {
    writeFileSync(MANIFEST_PATH, JSON.stringify(scanned, null, 2) + "\n");
    console.error(
      `[test-pools] wrote ${relative(REPO_ROOT, MANIFEST_PATH)}: ${scanned.parallel.length} parallel, ` +
        `${Object.keys(scanned.serialPinned).length} serial-pinned`,
    );
  } else {
    process.stdout.write(JSON.stringify(scanned, null, 2) + "\n");
  }
}
