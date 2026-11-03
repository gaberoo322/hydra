/**
 * TMPFS EXHAUSTION watchdog check (issue #5327): the pure decideDisk over
 * injected statfs numbers, runDisk over fake ports (page / resolve / du), the
 * `du --inodes` parse, and the page kind on the closed list.
 *
 * The 2026-10-31 shape — /tmp at 100% inodes with 8.6G of space free — must be
 * critical: inodes and blocks are graded independently.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";

import {
  DISK_BRIEF_KIND,
  DISK_PAGE_KIND,
  DISK_RECOVER_MARGIN_PCT,
  decideDisk,
  diskDedupKey,
  parseDiskPaths,
  parsePct,
  runDisk,
  type DiskDeps,
  type DiskThresholds,
  type StatfsReading,
} from "../src/watchdog/disk.ts";
import { parseDuInodesOutput } from "../src/host-probe/probe.ts";
import { isPageKind } from "../src/operator-channel/page-list.ts";
import type { OperatorMessage } from "../src/operator-channel/message.ts";

const T: DiskThresholds = { warnPct: 80, criticalPct: 95, recoverMarginPct: DISK_RECOVER_MARGIN_PCT };

const INODES = 1_048_576;
const BLOCKS = 8_009_171; // 4K blocks ≈ 30.5G, the host's /tmp tmpfs

/** A tmpfs reading with the given inode-use and block-use percents. */
function fs(inodePct: number, blockPct: number): StatfsReading {
  const ffree = Math.round(INODES * (1 - inodePct / 100));
  const bfree = Math.round(BLOCKS * (1 - blockPct / 100));
  return { blocks: BLOCKS, bfree, bavail: bfree, bsize: 4096, files: INODES, ffree };
}

describe("decideDisk (pure)", () => {
  test("below threshold: ok, both levels resolve (re-arm)", () => {
    const v = decideDisk("/tmp", fs(22, 5), T);
    assert.equal(v.level, "ok");
    assert.equal(v.inodePct, 22);
    assert.deepEqual(v.actions, { warn: "resolve", critical: "resolve" });
    assert.match(v.log, /^ok \/tmp: inodes 22%/);
  });

  test("warn on inodes: warn briefs (never pages), critical held until the episode ends", () => {
    const v = decideDisk("/tmp", fs(85, 5), T);
    assert.equal(v.level, "warn");
    assert.deepEqual(v.actions, { warn: "brief", critical: "hold" });
  });

  test("warn on blocks alone (inodes fine) also warns — independent dimensions", () => {
    const v = decideDisk("/dev/shm", fs(1, 82), T);
    assert.equal(v.level, "warn");
    assert.equal(v.actions.warn, "brief");
  });

  test("critical: pages critical and HOLDS warn (one message per escalation)", () => {
    const v = decideDisk("/tmp", fs(96, 40), T);
    assert.equal(v.level, "critical");
    assert.deepEqual(v.actions, { warn: "hold", critical: "page" });
  });

  test("the 2026-10-31 shape — 100% inodes with 8.6G free — is critical", () => {
    const freeBlocks = Math.round((8.6 * 1024 ** 3) / 4096);
    const v = decideDisk("/tmp", { blocks: BLOCKS, bfree: freeBlocks, bavail: freeBlocks, bsize: 4096, files: INODES, ffree: 0 }, T);
    assert.equal(v.inodePct, 100);
    assert.ok(v.blockPct !== null && v.blockPct < 80, "space alone would look healthy");
    assert.equal(v.level, "critical");
    assert.equal(v.actions.critical, "page");
    assert.match(v.log, /CRITICAL \/tmp: inodes 100%.*8\.6G free.*inode=critical block=ok/);
  });

  test("recovery uses hysteresis: inside (threshold - margin, threshold) the episode is held", () => {
    const band = decideDisk("/tmp", fs(92, 5), T); // below 95, above 90
    assert.deepEqual(band.actions, { warn: "brief", critical: "hold" });
    const hover = decideDisk("/tmp", fs(77, 5), T); // below 80, above 75
    assert.deepEqual(hover.actions, { warn: "hold", critical: "hold" }, "critical holds until the whole episode ends");
    const clear = decideDisk("/tmp", fs(74, 5), T);
    assert.deepEqual(clear.actions, { warn: "resolve", critical: "resolve" });
  });

  test("unreadable statfs holds every episode (fail-open, never a false recovery)", () => {
    const v = decideDisk("/dev/shm", null, T);
    assert.deepEqual(v.actions, { warn: "hold", critical: "hold" });
    assert.match(v.log, /^WARN statfs \/dev\/shm failed/);
  });

  test("a filesystem with no fixed inode table grades on blocks only", () => {
    const v = decideDisk("/x", { blocks: 100, bfree: 50, bavail: 50, bsize: 4096, files: 0, ffree: 0 }, T);
    assert.equal(v.inodePct, null);
    assert.equal(v.level, "ok");
  });
});

interface Recorded {
  pages: OperatorMessage[];
  resolves: string[];
  briefs: OperatorMessage[];
  clears: string[];
  duCalls: string[];
  lines: string[];
}

function fakeDeps(
  readings: Record<string, StatfsReading | null>,
  du: string[] | null = ["/tmp/vitest-leak 900000"],
  open: Set<string> = new Set(),
  failPageFor: string | null = null,
  storeDown = false,
  reminderDue = false,
): { deps: DiskDeps; rec: Recorded } {
  const rec: Recorded = { pages: [], resolves: [], briefs: [], clears: [], duCalls: [], lines: [] };
  const deps: DiskDeps = {
    statfs: (p) => readings[p] ?? null,
    async topInodeConsumers(p) {
      rec.duCalls.push(p);
      return du;
    },
    async isOpen(key) {
      return storeDown ? null : open.has(key);
    },
    async page(msg) {
      if (failPageFor !== null && msg.dedupKey.includes(`:${failPageFor}:`)) throw new Error("channel down");
      rec.pages.push(msg);
    },
    async reminderDue() {
      return reminderDue;
    },
    async briefOnce(msg) {
      if (open.has(msg.dedupKey)) return; // once per episode, like the real channel
      rec.briefs.push(msg);
      open.add(msg.dedupKey);
    },
    async resolve(key) {
      rec.resolves.push(key);
    },
    async clear(key) {
      rec.clears.push(key);
    },
    log: (l) => rec.lines.push(l),
  };
  return { deps, rec };
}

describe("runDisk (fake ports)", () => {
  test("healthy mounts: no page, no du walk, both keys resolved (a no-op on the channel when not bad)", async () => {
    const { deps, rec } = fakeDeps({ "/tmp": fs(22, 5), "/dev/shm": fs(1, 1) });
    await runDisk(deps, { paths: ["/tmp", "/dev/shm"], thresholds: T });
    assert.equal(rec.pages.length, 0);
    assert.deepEqual(rec.duCalls, []);
    assert.deepEqual(rec.resolves, [diskDedupKey("/tmp", "critical"), diskDedupKey("/dev/shm", "critical")]);
    assert.deepEqual(rec.clears, [diskDedupKey("/tmp", "warn"), diskDedupKey("/dev/shm", "warn")], "warn closes silently");
    assert.ok(rec.lines.every((l) => l.startsWith("hydra-disk-watchdog: ")));
  });

  test("critical inode-full page names the top inode consumers and uses a per-(mount,level) dedupKey", async () => {
    const { deps, rec } = fakeDeps({ "/tmp": fs(100, 70) });
    await runDisk(deps, { paths: ["/tmp"], thresholds: T });
    assert.equal(rec.pages.length, 1);
    const p = rec.pages[0];
    assert.equal(p.kind, DISK_PAGE_KIND);
    assert.equal(p.severity, "page");
    assert.equal(p.dedupKey, "infra:tmpfs_exhausted:/tmp:critical");
    assert.match(p.title, /^\/tmp critical: inodes 100%/);
    const top = p.facts.find((f) => f.label === "top inode users");
    assert.equal(top?.value, "/tmp/vitest-leak 900000");
    assert.deepEqual(rec.duCalls, ["/tmp"], "du runs once per paging mount");
    assert.deepEqual(rec.resolves, [], "the warn key is held while critical");
    assert.deepEqual(rec.briefs, [], "no pressure brief while critical");
  });

  test("a failed du walk still pages, saying the consumers are unavailable", async () => {
    const { deps, rec } = fakeDeps({ "/tmp": fs(97, 5) }, null);
    await runDisk(deps, { paths: ["/tmp"], thresholds: T });
    assert.equal(rec.pages.length, 1);
    assert.equal(rec.pages[0].dedupKey, diskDedupKey("/tmp", "critical"));
    assert.match(rec.pages[0].facts.find((f) => f.label === "top inode users")!.value, /unavailable/);
  });

  test("recovery: back under the margin resolves critical, clears warn silently, pages nothing", async () => {
    const { deps, rec } = fakeDeps({ "/tmp": fs(46, 5) });
    await runDisk(deps, { paths: ["/tmp"], thresholds: T });
    assert.equal(rec.pages.length, 0);
    assert.deepEqual(rec.resolves, [diskDedupKey("/tmp", "critical")]);
    assert.deepEqual(rec.clears, [diskDedupKey("/tmp", "warn")]);
  });
});

describe("runDisk episode semantics", () => {
  test("critical->warn drop with the critical episode open: no warn brief, no page, no critical resolve", async () => {
    const open = new Set([diskDedupKey("/tmp", "critical")]);
    const { deps, rec } = fakeDeps({ "/tmp": fs(85, 5) }, undefined, open);
    await runDisk(deps, { paths: ["/tmp"], thresholds: T });
    assert.deepEqual(rec.pages, []);
    assert.deepEqual(rec.briefs, []);
    assert.deepEqual(rec.resolves, []);
    assert.deepEqual(rec.duCalls, []);
  });

  test("whole episode over (below warn - margin): critical resolves once, the folded warn key is cleared silently", async () => {
    const open = new Set([diskDedupKey("/tmp", "critical"), diskDedupKey("/tmp", "warn")]);
    const { deps, rec } = fakeDeps({ "/tmp": fs(60, 5) }, undefined, open);
    await runDisk(deps, { paths: ["/tmp"], thresholds: T });
    assert.deepEqual(rec.resolves, [diskDedupKey("/tmp", "critical")]);
    assert.deepEqual(rec.clears, [diskDedupKey("/tmp", "warn")]);
  });

  test("warn -> critical -> ok over three ticks: exactly one recovered message", async () => {
    const open = new Set<string>();
    const warnK = diskDedupKey("/tmp", "warn");
    const critK = diskDedupKey("/tmp", "critical");
    const readings: Record<string, StatfsReading | null> = { "/tmp": fs(85, 5) };
    const { deps, rec } = fakeDeps(readings, undefined, open);
    const origPage = deps.page;
    deps.page = async (m) => {
      await origPage(m);
      open.add(m.dedupKey);
    };
    deps.resolve = async (k) => {
      if (open.delete(k)) rec.resolves.push(k);
    };
    deps.clear = async (k) => {
      open.delete(k);
      rec.clears.push(k);
    };
    await runDisk(deps, { paths: ["/tmp"], thresholds: T });
    readings["/tmp"] = fs(100, 5);
    await runDisk(deps, { paths: ["/tmp"], thresholds: T });
    readings["/tmp"] = fs(5, 5);
    await runDisk(deps, { paths: ["/tmp"], thresholds: T });
    assert.deepEqual(rec.briefs.map((p) => p.dedupKey), [warnK], "warn briefed once");
    assert.deepEqual(rec.pages.map((p) => p.dedupKey), [critK], "only critical pages");
    assert.deepEqual(rec.resolves, [critK], "one recovered for the whole episode");
    assert.equal(open.size, 0, "both keys closed");
  });

  test("warn never pages: it briefs infra:tmpfs_pressure once per episode, with no du walk", async () => {
    const { deps, rec } = fakeDeps({ "/tmp": fs(85, 5) });
    await runDisk(deps, { paths: ["/tmp"], thresholds: T });
    await runDisk(deps, { paths: ["/tmp"], thresholds: T }); // second bad tick: same episode
    assert.deepEqual(rec.pages, []);
    assert.equal(rec.briefs.length, 1);
    assert.equal(rec.briefs[0].kind, DISK_BRIEF_KIND);
    assert.equal(rec.briefs[0].severity, "brief");
    assert.equal(rec.briefs[0].dedupKey, diskDedupKey("/tmp", "warn"));
    assert.deepEqual(rec.duCalls, []);
  });

  test("store unreadable (isOpen null): a critical episode still pages (fails open)", async () => {
    const { deps, rec } = fakeDeps({ "/tmp": fs(97, 5) }, undefined, new Set(), null, true);
    await runDisk(deps, { paths: ["/tmp"], thresholds: T });
    assert.equal(rec.pages.length, 1);
    assert.equal(rec.pages[0].dedupKey, diskDedupKey("/tmp", "critical"));
  });

  test("edge-only: an open critical episode is not re-paged on a bad tick (no page, no du)", async () => {
    const open = new Set([diskDedupKey("/tmp", "critical")]);
    const { deps, rec } = fakeDeps({ "/tmp": fs(100, 70) }, undefined, open);
    await runDisk(deps, { paths: ["/tmp"], thresholds: T });
    assert.deepEqual(rec.pages, []);
    assert.deepEqual(rec.duCalls, []);
  });

  test("documented exception: an open critical episode with the 6h reminder due re-pages without du", async () => {
    const open = new Set([diskDedupKey("/tmp", "critical")]);
    const { deps, rec } = fakeDeps({ "/tmp": fs(100, 70) }, undefined, open, null, false, true);
    await runDisk(deps, { paths: ["/tmp"], thresholds: T });
    assert.deepEqual(rec.duCalls, []);
    assert.equal(rec.pages.length, 1);
    assert.match(rec.pages[0].facts.find((f) => f.label === "top inode users")!.value, /not scanned/);
  });

  test("a channel failure on /tmp does not skip /dev/shm", async () => {
    const { deps, rec } = fakeDeps({ "/tmp": fs(100, 70), "/dev/shm": fs(100, 70) }, undefined, new Set(), "/tmp");
    await runDisk(deps, { paths: ["/tmp", "/dev/shm"], thresholds: T });
    assert.equal(rec.pages.length, 1);
    assert.equal(rec.pages[0].dedupKey, diskDedupKey("/dev/shm", "critical"));
    assert.ok(rec.lines.some((l) => /WARN \/tmp: channel\/du step failed/.test(l)));
  });
});

describe("support", () => {
  test("the brief kind is NOT a page kind (warn must never page)", () => {
    assert.equal(isPageKind(DISK_BRIEF_KIND), false);
  });

  test("the page kind is on the closed page list (ADR-0045 Decision 3)", () => {
    assert.ok(isPageKind(DISK_PAGE_KIND));
  });

  test("parseDuInodesOutput: drops the root total, sorts descending, caps at limit", () => {
    const out = "12\t/tmp/a\n900\t/tmp/b/\ngarbage\n50\t/tmp/c\n962\t/tmp\n";
    assert.deepEqual(parseDuInodesOutput(out, "/tmp/", 2), [
      { path: "/tmp/b", inodes: 900 },
      { path: "/tmp/c", inodes: 50 },
    ]);
  });

  test("parseDuInodesOutput: groups sibling temp files by name prefix (a flat leak names its prefix)", () => {
    const out = [
      "1\t/tmp/hydra-pace-1730000000.json",
      "1\t/tmp/hydra-pace-1730000120.json",
      "1\t/tmp/hydra-pace-1730000240.json",
      "2\t/tmp/vitest-9f3a",
      "5\t/tmp",
      "1\t/tmp/hydra-pace-17300", // a maxBuffer-truncated last line still parses
    ].join("\n");
    assert.deepEqual(parseDuInodesOutput(out, "/tmp", 5), [
      { path: "/tmp/hydra-pace-*", inodes: 4 },
      { path: "/tmp/vitest-*", inodes: 2 },
    ]);
  });

  test("env parsing: percents fall back when out of range; paths fall back when empty", () => {
    assert.equal(parsePct(undefined, 80), 80);
    assert.equal(parsePct("90", 80), 90);
    assert.equal(parsePct("0", 80), 80);
    assert.equal(parsePct("101", 80), 80);
    assert.equal(parsePct("abc", 80), 80);
    assert.deepEqual(parseDiskPaths(undefined), ["/tmp", "/dev/shm"]);
    assert.deepEqual(parseDiskPaths(" /tmp , ,/var/tmp"), ["/tmp", "/var/tmp"]);
  });
});
