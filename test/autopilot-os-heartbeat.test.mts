/**
 * Regression tests for the OS-heartbeat reader (issue #1091).
 *
 * The wedge / stalled-dispatch false-positive fix cross-checks the
 * continuously-written OS heartbeat (`/tmp/hydra-autopilot-heartbeat.txt`)
 * against the per-turn heartbeat. This module is the shared, pure read seam.
 * Tests cover:
 *   - parseHeartbeatEpoch — the first-token epoch parse + reject paths.
 *   - osHeartbeatAgeS — age math via an injected epoch reader (no disk).
 *   - isOsHeartbeatStale — the fail-open decision (null → stale).
 *   - readOsHeartbeatEpoch — the real file reader against tmp fixtures,
 *     including the mtime fallback and the missing-file → null path.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync, utimesSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseHeartbeatEpoch,
  osHeartbeatAgeS,
  isOsHeartbeatStale,
  readOsHeartbeatEpoch,
} from "../src/autopilot/os-heartbeat.ts";

describe("parseHeartbeatEpoch (#1091)", () => {
  test("extracts the first whitespace token as epoch", () => {
    // The real heartbeat.py line format: <epoch> <pid> <run_id> turn=N ...
    assert.equal(
      parseHeartbeatEpoch("1717718400 12345 run-abc turn=3 dispatches=2"),
      1717718400,
    );
  });

  test("tolerates leading/trailing whitespace", () => {
    assert.equal(parseHeartbeatEpoch("  1717718400  pid "), 1717718400);
  });

  test("floors a fractional epoch", () => {
    assert.equal(parseHeartbeatEpoch("1717718400.9 pid"), 1717718400);
  });

  test("rejects a non-numeric first token", () => {
    assert.equal(parseHeartbeatEpoch("notanepoch 123"), null);
  });

  test("rejects zero / negative epoch", () => {
    assert.equal(parseHeartbeatEpoch("0 pid"), null);
    assert.equal(parseHeartbeatEpoch("-5 pid"), null);
  });

  test("rejects empty / whitespace-only line", () => {
    assert.equal(parseHeartbeatEpoch(""), null);
    assert.equal(parseHeartbeatEpoch("   "), null);
  });
});

describe("osHeartbeatAgeS (#1091)", () => {
  test("computes age from injected epoch reader", () => {
    const now = 1_000_000;
    assert.equal(osHeartbeatAgeS(now, () => now - 120), 120);
  });

  test("clamps negative age (clock skew) to 0", () => {
    const now = 1_000_000;
    assert.equal(osHeartbeatAgeS(now, () => now + 30), 0);
  });

  test("returns null when the epoch is unreadable", () => {
    assert.equal(osHeartbeatAgeS(1_000_000, () => null), null);
  });
});

describe("isOsHeartbeatStale (#1091)", () => {
  test("fresh heartbeat (age <= threshold) is NOT stale", () => {
    assert.equal(isOsHeartbeatStale(100, 600), false);
    assert.equal(isOsHeartbeatStale(600, 600), false);
  });

  test("aged heartbeat (age > threshold) is stale", () => {
    assert.equal(isOsHeartbeatStale(601, 600), true);
  });

  test("null age fails OPEN — treated as stale", () => {
    assert.equal(isOsHeartbeatStale(null, 600), true);
  });
});

describe("readOsHeartbeatEpoch — real file reader (#1091)", () => {
  test("prefers the epoch token written into the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "hydra-hb-"));
    const path = join(dir, "heartbeat.txt");
    try {
      writeFileSync(path, "1717718400 12345 run-abc turn=3\n");
      assert.equal(readOsHeartbeatEpoch(path), 1717718400);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("falls back to file mtime when the line has no epoch token", () => {
    const dir = mkdtempSync(join(tmpdir(), "hydra-hb-"));
    const path = join(dir, "heartbeat.txt");
    try {
      writeFileSync(path, "garbage-no-epoch line\n");
      // Pin mtime to a known epoch.
      const mtime = 1717000000;
      utimesSync(path, mtime, mtime);
      assert.equal(readOsHeartbeatEpoch(path), mtime);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns null when the file is absent", () => {
    const path = join(tmpdir(), `hydra-hb-missing-${Date.now()}.txt`);
    assert.equal(readOsHeartbeatEpoch(path), null);
  });
});
