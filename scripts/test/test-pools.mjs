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
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
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
  [/\/dev\/shm\//, "uses /dev/shm (shared between concurrent pools)"],
  [/\b(pkill|pgrep|killall)\b/, "kills or matches processes by name (could reap the sibling pool)"],
  [/\.listen\(\s*\d{2,5}\b|--port[= ]\d{2,5}\b|localhost:\d{4,5}|127\.0\.0\.1:\d{4,5}/, "binds or dials a fixed port"],
  [/(?<!mkdtemp(?:Sync)?\(\s*(?:path\.)?join\(\s*)tmpdir\(\)\s*,\s*["'`][A-Za-z0-9_.-]+["'`]\s*\)/, "uses a constant-name path under tmpdir() (clobbers under concurrency)"],
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
      if (!hit) {
        // Slashless (or unresolved-path) script literal: pull in every same-named
        // script under scripts/ + src/ (any ext), so a spawn by bare name is seen.
        for (const c of byBase.get(lit.slice(lit.lastIndexOf("/") + 1)) ?? []) deps.add(c);
      }
    }
    return deps;
  };
  // Closure scan: Redis markers AND shared-state HAZARDS are judged over the same
  // transitive set (imports + spawned scripts), not only the test's own text. A
  // spawnable script literal (.sh/.py/.mjs) the scan cannot resolve fails toward
  // serial, the safe direction.
  const classify = (start) => {
    const seen = new Set();
    const stack = [start];
    let hazard = null;
    while (stack.length > 0) {
      const f = stack.pop();
      if (seen.has(f)) continue;
      seen.add(f);
      const text = read(f);
      if (REDIS_MARKERS.test(text)) return { redis: true, hazard: null };
      hazard ??= HAZARDS.find(([re]) => re.test(text))?.[1] ?? null;
      for (const m of text.matchAll(PATH_LITERAL_RE)) {
        const lit = m[1];
        if (!/\.(sh|py|mjs)$/.test(lit)) continue;
        const known =
          (byBase.get(lit.slice(lit.lastIndexOf("/") + 1)) ?? []).length > 0 ||
          existsSync(resolve(dirname(f), lit)) ||
          existsSync(resolve(root, lit));
        if (!known) hazard ??= `names a script (${lit}) the scan cannot resolve - treated as unsafe`;
      }
      for (const d of depsOf(f)) stack.push(d);
    }
    return { redis: false, hazard };
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
    const { redis, hazard } = classify(abs);
    if (redis) continue;
    if (hazard) {
      serialPinned[rel] = hazard;
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

// ---------------------------------------------------------------------------
// TAP footer merge (QA round 2: reflection-deposit.sh takes the LAST footer as
// the suite total, so two per-pool footers recorded only one pool's counts).
// Per-pool footers are stripped; ONE summed footer is emitted last.
// ---------------------------------------------------------------------------

const FOOTER_KEYS = ["tests", "suites", "pass", "fail", "cancelled", "skipped", "todo", "duration_ms"];
const FOOTER_RE = /^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) (\d+(?:\.\d+)?)\s*$/;

/** Split TAP text into `{ body, footer }`; footer is `{key: number}` or null. */
export function splitTapFooter(text) {
  const footer = {};
  let found = false;
  const kept = [];
  for (const line of text.split("\n")) {
    const m = FOOTER_RE.exec(line);
    if (m) {
      footer[m[1]] = Number(m[2]);
      found = true;
    } else kept.push(line);
  }
  return { body: kept.join("\n"), footer: found ? footer : null };
}

/** Sum footers (duration_ms is the max — the pools overlap in time). */
export function sumFooters(footers) {
  const out = {};
  for (const f of footers) {
    for (const k of FOOTER_KEYS) {
      if (f[k] === undefined) continue;
      out[k] = k === "duration_ms" ? Math.max(out[k] ?? 0, f[k]) : (out[k] ?? 0) + f[k];
    }
  }
  return out;
}

export function formatFooter(footer) {
  return FOOTER_KEYS.filter((k) => footer[k] !== undefined)
    .map((k) => `# ${k} ${footer[k]}\n`)
    .join("");
}

/** Concatenate per-pool TAP texts into one body followed by one summed footer. */
export function joinTap(parts) {
  const footers = [];
  let out = "";
  for (const p of parts) {
    const { body, footer } = splitTapFooter(p);
    if (footer) footers.push(footer);
    out += body.endsWith("\n") || body === "" ? body : body + "\n";
  }
  return out + (footers.length > 0 ? formatFooter(sumFooters(footers)) : "");
}

/**
 * Run the pool invocations concurrently (issue #5199). Serial pool: stdout piped
 * and forwarded live with its TAP footer withheld. Parallel pool: stdout buffered
 * in a private mkdtemp dir, appended after both exit. One summed footer is
 * written last. Exit is non-zero if either child is; a signal-death of either
 * terminates the sibling's process group and is reported as `{ signal,
 * killedPool }`. All temp state is removed on every path.
 * `children` (optional Set) is filled with live child processes so a launcher
 * signal handler can reap them.
 */
export function runPools({ invocations, env, cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr, children = new Set() }) {
  const pools = [invocations.serial, invocations.parallel].filter((p) => p !== null && p.files.length > 0);
  if (pools.length === 0) pools.push(invocations.serial);
  const killAll = (sig) => {
    for (const c of children) {
      try {
        process.kill(-c.pid, sig);
      } catch {
        /* intentional: the child's group already exited (ESRCH) — nothing left to reap */
      }
    }
  };
  const tmp = mkdtempSync(join(tmpdir(), "hydra-test-pools-"));
  return new Promise((resolveRun) => {
    const results = new Map();
    const footers = [];
    let settled = false;
    const cleanup = () => rmSync(tmp, { recursive: true, force: true });
    const finish = () => {
      if (settled || results.size < pools.length) return;
      settled = true;
      children.clear();
      try {
        for (const dest of invocations.merged) {
          const out = resolve(cwd, dest);
          const parts = pools.map((p) => `${out}.${p.pool}`).filter((x) => existsSync(x));
          writeFileSync(out, joinTap(parts.map((x) => readFileSync(x, "utf8"))));
          for (const x of parts) rmSync(x, { force: true });
        }
        for (const p of pools) {
          const buffered = join(tmp, `${p.pool}.stdout`);
          if (p.pool === "serial" || !existsSync(buffered)) continue;
          const { body, footer } = splitTapFooter(readFileSync(buffered, "utf8"));
          if (footer) footers.push(footer);
          stdout.write(body);
        }
        if (footers.length > 0) stdout.write(formatFooter(sumFooters(footers)));
      } catch (err) {
        stderr.write(`[redis-db-launch] pool output merge failed: ${err.message}\n`);
        results.set("merge", { code: 1, signal: null });
      } finally {
        cleanup();
      }
      const killed = [...results.entries()].find(([, r]) => r.signal);
      if (killed) {
        stderr.write(`[redis-db-launch] INFRA-KILL source: the ${killed[0]} pool child\n`);
        resolveRun({ code: null, signal: killed[1].signal, killedPool: killed[0] });
        return;
      }
      const failed = [...results.values()].find((r) => r.code !== 0);
      resolveRun({ code: failed ? (failed.code ?? 1) : 0, signal: null, killedPool: null });
    };
    for (const p of pools) {
      const isSerial = p.pool === "serial";
      let fd = null;
      let child;
      try {
        fd = isSerial ? null : openSync(join(tmp, `${p.pool}.stdout`), "w");
        child = spawn(p.argv[0], p.argv.slice(1), {
          stdio: ["inherit", isSerial ? "pipe" : fd, "inherit"],
          env,
          cwd,
          detached: true,
        });
      } catch (err) {
        stderr.write(`[redis-db-launch] failed to spawn ${p.argv[0]}: ${err.message}\n`);
        killAll("SIGTERM");
        cleanup();
        settled = true;
        resolveRun({ code: 1, signal: null, killedPool: null });
        return;
      } finally {
        if (fd !== null) closeSync(fd);
      }
      children.add(child);
      stderr.write(`[redis-db-launch] ${p.pool} pool: ${p.files.length} file(s), test child pid ${child.pid}\n`);
      if (isSerial) {
        let pending = "";
        const forward = (line) => {
          const m = FOOTER_RE.exec(line);
          if (m) (footers[0] ??= {})[m[1]] = Number(m[2]);
          else stdout.write(line + "\n");
        };
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          pending += chunk;
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const l of lines) forward(l);
        });
        child.stdout.on("end", () => {
          if (pending !== "") forward(pending);
          pending = "";
        });
      }
      child.on("error", (err) => {
        if (settled) return;
        stderr.write(`[redis-db-launch] failed to spawn ${p.argv[0]}: ${err.message}\n`);
        killAll("SIGTERM");
        cleanup();
        settled = true;
        resolveRun({ code: 1, signal: null, killedPool: null });
      });
      child.on("close", (code, signal) => {
        children.delete(child);
        results.set(p.pool, { code, signal });
        if (signal) killAll("SIGTERM");
        finish();
      });
    }
  });
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
