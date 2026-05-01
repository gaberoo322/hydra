/**
 * Pattern Detector
 *
 * Runs after every cycle and checks for systemic issues across recent cycles.
 * Only alerts when a pattern crosses a threshold — no alert fatigue from
 * one-off failures.
 *
 * Patterns detected:
 *   - Low merge rate (< 50% over last 10 cycles)
 *   - Consecutive failures (3+ in a row)
 *   - Agent timeouts recurring (3+ in last 10)
 *   - Same anchor failing repeatedly
 *   - Regressions recurring
 *   - Test count declining
 *
 * Deduplication: each pattern has a cooldown — won't re-alert for the same
 * issue within the cooldown window.
 */

import { getPatternCooldown, setPatternCooldown, pushAlert } from "./redis-adapter.ts";

const WINDOW = 10; // look at last N cycles
const COOLDOWN_MS = 60 * 60 * 1000; // 1 hour between same alert type

/**
 * Run pattern detection after a cycle completes.
 * Called from control-loop.mjs after recordCycleMetrics().
 *
 * @param {object} eventBus - For publishing notifications
 * @param {string} cycleId - Current cycle ID
 */
export async function detectPatterns(eventBus, cycleId) {
  try {
    const { getMetricsTrend } = await import("./metrics.ts");
    const trend = await getMetricsTrend(WINDOW);
    if (trend.length < 3) return; // not enough data

    const alerts = [];

    // 1. Low merge rate
    const merged = trend.filter(m => parseInt(m.tasksMerged) > 0).length;
    const mergeRate = Math.round(merged / trend.length * 100);
    if (mergeRate < 50) {
      alerts.push({
        pattern: "low_merge_rate",
        severity: "error",
        message: `Merge rate is ${mergeRate}% over last ${trend.length} cycles (${merged}/${trend.length} merged). Something is systematically failing.`,
      });
    }

    // 2. Consecutive failures (last 3+ cycles all non-merged)
    let consecutive = 0;
    for (let i = trend.length - 1; i >= 0; i--) {
      if (parseInt(trend[i].tasksMerged) > 0) break;
      consecutive++;
    }
    if (consecutive >= 3) {
      alerts.push({
        pattern: "consecutive_failures",
        severity: "error",
        message: `${consecutive} consecutive cycles without a merge. Last merged: ${trend.find(m => parseInt(m.tasksMerged) > 0)?.cycleId || "unknown"}.`,
      });
    }

    // 3. Recurring regressions
    const regressions = trend.filter(m => m.regressionIntroduced === "true" || m.regressionIntroduced === true).length;
    if (regressions >= 2) {
      alerts.push({
        pattern: "recurring_regressions",
        severity: "error",
        message: `${regressions} regressions in last ${trend.length} cycles. The executor is introducing test failures that get auto-reverted.`,
      });
    }

    // 4. Same anchor type failing repeatedly
    const failedAnchors = trend
      .filter(m => parseInt(m.tasksFailed) > 0 || parseInt(m.tasksAbandoned) > 0)
      .map(m => m.anchorReference)
      .filter(Boolean);
    const anchorCounts: Record<string, number> = {};
    for (const a of failedAnchors) {
      anchorCounts[a] = (anchorCounts[a] || 0) + 1;
    }
    for (const [anchor, count] of Object.entries(anchorCounts)) {
      if (count >= 3) {
        alerts.push({
          pattern: "anchor_stuck",
          severity: "warning",
          message: `Anchor "${anchor}" has failed ${count} times in last ${trend.length} cycles. The system may be stuck on this work item.`,
        });
      }
    }

    // 5. Test count declining — compare the HIGH WATER MARK in the window to the latest.
    // Small dips are normal (some cycles don't add tests). Only alert on sustained loss.
    const recent = trend.slice(-10);
    if (recent.length >= 5) {
      const highWater = Math.max(...recent.map(m => parseInt(m.testsAfter) || 0));
      const last = parseInt(recent[recent.length - 1].testsAfter) || 0;
      if (highWater > 0 && last < highWater - 20) {
        alerts.push({
          pattern: "test_decline",
          severity: "warning",
          message: `Test count dropped ${highWater - last} below peak: ${highWater} → ${last} over last ${recent.length} cycles.`,
        });
      }
    }

    // 6. High abandonment rate (tasks proposed but never executed)
    const abandoned = trend.filter(m => parseInt(m.tasksAbandoned) > 0).length;
    if (abandoned >= 4) {
      alerts.push({
        pattern: "high_abandonment",
        severity: "warning",
        message: `${abandoned}/${trend.length} cycles abandoned. The planner may be proposing work the skeptic keeps rejecting, or drift detection is too aggressive.`,
      });
    }

    // 7. File-level rework — same source files touched in 3+ of last N cycles
    const fileCounts: Record<string, number> = {};
    for (const m of trend) {
      let files = m.filesChangedList;
      if (typeof files === "string") {
        try { files = JSON.parse(files); } catch { files = []; }
      }
      if (!Array.isArray(files)) continue;
      for (const f of files) {
        if (typeof f !== "string" || f.includes(".test.")) continue;
        fileCounts[f] = (fileCounts[f] || 0) + 1;
      }
    }
    const hotFiles = Object.entries(fileCounts)
      .filter(([, count]) => count >= 3)
      .sort((a, b) => b[1] - a[1]);
    if (hotFiles.length > 0) {
      const top3 = hotFiles.slice(0, 3).map(([file, count]) => `${file} (${count}x)`).join(", ");
      alerts.push({
        pattern: "file_rework",
        severity: "warning",
        message: `Rework detected: ${hotFiles.length} file(s) touched in 3+ of last ${trend.length} cycles. Hotspots: ${top3}. Consider architectural review.`,
      });
    }

    // 8. Rollback clustering — 3+ rollbacks in recent window
    const rollbacks = trend.filter(m => m.rolledBack === true || m.rolledBack === "true").length;
    if (rollbacks >= 3) {
      alerts.push({
        pattern: "rollback_cluster",
        severity: "error",
        message: `${rollbacks} rollbacks in last ${trend.length} cycles. The executor is repeatedly introducing regressions. Consider pausing and investigating.`,
      });
    }

    // 9. Disk space check — alert if NVMe drops below 20GB free
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);
      const { stdout: dfOut } = await execFileAsync("df", ["--output=avail", "-B1", "/"]);
      const availBytes = parseInt(dfOut.trim().split("\n").pop() || "0");
      const availGB = availBytes / (1024 ** 3);
      if (availGB < 20) {
        alerts.push({
          pattern: "disk_low",
          severity: "error",
          message: `NVMe has only ${availGB.toFixed(1)}GB free (floor: 20GB). Move large files to /mnt/hydra-ssd or clean up.`,
        });
      }
    } catch {}

    // Publish alerts (with cooldown dedup)
    for (const alert of alerts) {
      // Check cooldown
      const lastAlerted = await getPatternCooldown(alert.pattern);
      if (lastAlerted && Date.now() - parseInt(lastAlerted) < COOLDOWN_MS) {
        continue; // skip — already alerted recently
      }

      // Record cooldown
      await setPatternCooldown(alert.pattern, Date.now().toString());

      // Store alert
      const fullAlert = {
        id: `pattern-${alert.pattern}-${Date.now()}`,
        type: `pattern:${alert.pattern}`,
        timestamp: new Date().toISOString(),
        message: alert.message,
        severity: alert.severity,
        dismissed: false,
        payload: { pattern: alert.pattern, cycleId, window: WINDOW },
      };
      await pushAlert(JSON.stringify(fullAlert), 100);

      // Also publish to notification stream for WebSocket broadcast
      const { STREAMS } = await import("./event-bus.ts");
      await eventBus.publish(STREAMS.NOTIFICATIONS, {
        type: `pattern:${alert.pattern}`,
        source: "pattern-detector",
        correlationId: cycleId,
        payload: { message: alert.message, severity: alert.severity },
      });

      console.log(`[PatternDetector] ALERT: ${alert.message}`);
    }
  } catch (err) {
    console.error(`[PatternDetector] Failed: ${err.message}`);
  }
}
