/**
 * watchdog/disk.ts — the TMPFS EXHAUSTION check (issue #5327; ADR-0040
 * Decision 2 shape: one pure decide + one run over injected ports).
 *
 * On 2026-10-31 the shared `/tmp` tmpfs (1,048,576 inodes, shared by the CI
 * runners and every agent worktree) hit 100% INODE use with 8.6G of space still
 * free; every temp-file write failed with ENOSPC and nothing alarmed. This
 * check reads `statfs` for each watched mount (default `/tmp` and `/dev/shm`)
 * and grades inode use and block use INDEPENDENTLY — an inode-full mount with
 * space free is critical, not fine.
 *
 * Levels: `warn` at >= warnPct, `critical` at >= criticalPct (defaults 80 / 95,
 * the issue's thresholds). Each (mount, level) is its own Operator Channel
 * dedupKey, so the channel's edge-triggered dedup (ADR-0045 Decision 4: one
 * page when it turns bad, one reminder per 6h, one "recovered" on resolve) IS
 * the episode tracker — the watchdog keeps no marker of its own. A level is
 * resolved only once BOTH dimensions are below `threshold - recoverMarginPct`;
 * inside that band the episode is held (neither paged nor resolved), so a mount
 * hovering at the threshold cannot flap a page every 2-minute tick.
 *
 * Severity: a `critical` mount pages its critical key and HOLDS its warn key
 * (one message per escalation, not two); dropping back into the warn band
 * resolves critical and pages warn if it was never paged.
 *
 * `decideDisk` is pure (no I/O). `runDisk` is the only impure function, over the
 * {@link DiskDeps} ports; the page text names the top inode consumers by name
 * prefix (a bounded `du --inodes -a -d1`, grouped) so the operator sees the
 * leaker without shelling in. Read-only: this check never deletes anything (the tmp-reaper owns that).
 */

import type { OperatorFact, OperatorMessage } from "../operator-channel/message.ts";

export const DISK_LOG_PREFIX = "hydra-disk-watchdog:";
export const DISK_PAGE_KIND = "infra:tmpfs_exhausted";

export const DEFAULT_DISK_PATHS = ["/tmp", "/dev/shm"] as const;
export const DEFAULT_DISK_WARN_PCT = 80;
export const DEFAULT_DISK_CRITICAL_PCT = 95;
/** Hysteresis: a level clears only below `threshold - this`. */
export const DISK_RECOVER_MARGIN_PCT = 5;
/** How many top-level inode consumers a page names. */
export const DISK_TOP_CONSUMERS = 5;

/** The `statfs` numbers the predicate needs (fs.statfsSync field names). */
export interface StatfsReading {
  /** Total data blocks. */
  blocks: number;
  /** Free blocks. */
  bfree: number;
  /** Free blocks available to an unprivileged user. */
  bavail: number;
  /** Block size in bytes. */
  bsize: number;
  /** Total inodes (0 = the filesystem does not report a fixed inode table). */
  files: number;
  /** Free inodes. */
  ffree: number;
}

export interface DiskThresholds {
  warnPct: number;
  criticalPct: number;
  recoverMarginPct: number;
}

export type DiskLevel = "ok" | "warn" | "critical";
/** What to do with one (mount, level) dedupKey this tick. */
export type DiskAction = "page" | "resolve" | "hold";

export interface DiskVerdict {
  path: string;
  /** `null` = statfs unreadable this tick (both actions are `hold`). */
  inodePct: number | null;
  blockPct: number | null;
  level: DiskLevel;
  /** Free space in bytes (available to unprivileged users), `null` when unreadable. */
  freeBytes: number | null;
  actions: { warn: DiskAction; critical: DiskAction };
  /** The journal line (without the prefix). */
  log: string;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Inode use percent, or `null` when the fs has no fixed inode table. */
export function inodeUsePct(r: StatfsReading): number | null {
  if (!(r.files > 0)) return null;
  return round1(((r.files - r.ffree) / r.files) * 100);
}

/** Block use percent as `df` computes Use%: used / (used + available). */
export function blockUsePct(r: StatfsReading): number | null {
  const used = r.blocks - r.bfree;
  const denom = used + r.bavail;
  if (!(r.blocks > 0) || !(denom > 0)) return null;
  return round1((used / denom) * 100);
}

function levelOf(pct: number | null, t: DiskThresholds): DiskLevel {
  if (pct === null) return "ok";
  if (pct >= t.criticalPct) return "critical";
  if (pct >= t.warnPct) return "warn";
  return "ok";
}

const RANK: Record<DiskLevel, number> = { ok: 0, warn: 1, critical: 2 };

/** Page at >= threshold on EITHER dimension; resolve once BOTH are below threshold - margin; else hold. */
function actionFor(inodePct: number | null, blockPct: number | null, threshold: number, margin: number): DiskAction {
  const pcts = [inodePct, blockPct].filter((p): p is number => p !== null);
  if (pcts.some((p) => p >= threshold)) return "page";
  if (pcts.every((p) => p < threshold - margin)) return "resolve";
  return "hold";
}

export function formatBytes(bytes: number): string {
  const units = ["B", "K", "M", "G", "T"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : round1(v)}${units[i]}`;
}

/** Pure verdict for one mount. */
export function decideDisk(path: string, reading: StatfsReading | null, t: DiskThresholds): DiskVerdict {
  if (reading === null) {
    return {
      path,
      inodePct: null,
      blockPct: null,
      level: "ok",
      freeBytes: null,
      actions: { warn: "hold", critical: "hold" },
      log: `WARN statfs ${path} failed — holding any open episode this tick (fail-open)`,
    };
  }
  const inodePct = inodeUsePct(reading);
  const blockPct = blockUsePct(reading);
  const inodeLevel = levelOf(inodePct, t);
  const blockLevel = levelOf(blockPct, t);
  const level = RANK[inodeLevel] >= RANK[blockLevel] ? inodeLevel : blockLevel;
  const freeBytes = reading.bavail * reading.bsize;

  const critical = actionFor(inodePct, blockPct, t.criticalPct, t.recoverMarginPct);
  let warn = actionFor(inodePct, blockPct, t.warnPct, t.recoverMarginPct);
  // One message per escalation: while critical, the warn episode is held.
  if (critical === "page") warn = "hold";

  const used = `inodes ${inodePct ?? "n/a"}% (${reading.files - reading.ffree}/${reading.files}), blocks ${blockPct ?? "n/a"}% (${formatBytes(freeBytes)} free)`;
  const label = level === "ok" ? "ok" : level.toUpperCase();
  return {
    path,
    inodePct,
    blockPct,
    level,
    freeBytes,
    actions: { warn, critical },
    log: `${label} ${path}: ${used}; inode=${inodeLevel} block=${blockLevel} (warn>=${t.warnPct}% critical>=${t.criticalPct}%)`,
  };
}

/** The Operator Channel dedupKey for one (mount, level). */
export function diskDedupKey(path: string, level: "warn" | "critical"): string {
  return `${DISK_PAGE_KIND}:${path}:${level}`;
}

/** The page for one (mount, level), naming the top inode consumers when known. */
export function diskPageMessage(
  v: DiskVerdict,
  level: "warn" | "critical",
  t: DiskThresholds,
  topConsumers: string[] | null,
): OperatorMessage {
  const dims: string[] = [];
  const thr = level === "critical" ? t.criticalPct : t.warnPct;
  if (v.inodePct !== null && v.inodePct >= thr) dims.push(`inodes ${v.inodePct}%`);
  if (v.blockPct !== null && v.blockPct >= thr) dims.push(`space ${v.blockPct}%`);
  const facts: OperatorFact[] = [
    { label: "inodes", value: v.inodePct === null ? "n/a" : `${v.inodePct}%` },
    { label: "space", value: v.blockPct === null ? "n/a" : `${v.blockPct}%` },
    { label: "free", value: v.freeBytes === null ? "n/a" : formatBytes(v.freeBytes) },
    { label: "threshold", value: `${level} >= ${thr}%` },
    {
      label: "top inode users",
      value: topConsumers === null ? "unavailable (du failed or timed out)" : topConsumers.length ? topConsumers.join(", ") : "none",
    },
  ];
  return {
    severity: "page",
    kind: DISK_PAGE_KIND,
    title: `${v.path} ${level}: ${dims.join(", ") || "over threshold"} — temp-file writes fail with ENOSPC at 100%`,
    facts,
    links: [],
    dedupKey: diskDedupKey(v.path, level),
  };
}

export interface DiskDeps {
  /** `statfs(path)`, or `null` when unreadable. */
  statfs(path: string): StatfsReading | null;
  /** Top inode consumers under `path` as `"<path> <count>"` strings, or `null` when the walk failed. */
  topInodeConsumers(path: string, limit: number): Promise<string[] | null>;
  page(msg: OperatorMessage): Promise<unknown>;
  resolve(dedupKey: string, title: string): Promise<unknown>;
  log: (line: string) => void;
}

export interface DiskConfig {
  paths: readonly string[];
  thresholds: DiskThresholds;
}

/** Check every mount: decide, then page / resolve each (mount, level) key through the channel. */
export async function runDisk(deps: DiskDeps, config: DiskConfig): Promise<DiskVerdict[]> {
  const say = (line: string): void => deps.log(`${DISK_LOG_PREFIX} ${line}`);
  const verdicts: DiskVerdict[] = [];
  for (const path of config.paths) {
    const v = decideDisk(path, deps.statfs(path), config.thresholds);
    verdicts.push(v);
    say(v.log);
    let consumers: string[] | null | undefined;
    for (const level of ["critical", "warn"] as const) {
      const action = v.actions[level];
      const key = diskDedupKey(path, level);
      if (action === "page") {
        if (consumers === undefined) consumers = await deps.topInodeConsumers(path, DISK_TOP_CONSUMERS);
        await deps.page(diskPageMessage(v, level, config.thresholds, consumers));
        say(`${level} page submitted for ${path} (dedupKey=${key}; the channel suppresses repeats within the episode)`);
      } else if (action === "resolve") {
        await deps.resolve(key, `${path} ${level} cleared: inodes ${v.inodePct ?? "n/a"}%, space ${v.blockPct ?? "n/a"}%`);
      }
    }
  }
  return verdicts;
}

/** Parse a percent env value; out-of-range / non-numeric falls back. */
export function parsePct(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : fallback;
}

/** Parse a comma-separated path list; empty falls back to the defaults. */
export function parseDiskPaths(raw: string | undefined): string[] {
  const paths = (raw ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  return paths.length ? paths : [...DEFAULT_DISK_PATHS];
}
