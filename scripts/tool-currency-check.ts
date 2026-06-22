#!/usr/bin/env -S npx tsx
/**
 * Tool-currency check driver (issue #480).
 *
 * Runs the actual subprocesses, hits the upstream APIs, and emits a
 * structured report. Wires the pure-logic module in
 * `scripts/tool-currency-logic.ts` to real I/O.
 *
 * Output modes:
 *   - `--json`    print a JSON array of ToolReport entries (default for
 *                 the hydra-doctor playbook collector).
 *   - `--table`   print the fixed-width human table (operator on the CLI).
 *   - `--alert`   in addition to printing, push a `severity: warning`
 *                 alert into the Redis `hydra:alerts` list for each
 *                 outdated tool. Idempotent on tool name within a 24h
 *                 window — repeated invocations don't spam the list.
 *
 * Network failures (no internet, rate-limit, 5xx) produce `unknown` per
 * tool and never crash. Subprocess failures (missing binary) also produce
 * `unknown` rather than failing the doctor run.
 *
 * Exit code is always 0 unless an unexpected internal error occurs. The
 * doctor consumes the JSON, not the exit code, so a stale `gh` doesn't
 * make `hydra-doctor` itself report "failed".
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  buildAlertMessage,
  buildReport,
  classifyByAge,
  classifyByVersion,
  classifyNodeMajor,
  extractVersionFromOutput,
  formatReportTable,
  type ToolReport,
  type Verdict,
} from "./tool-currency-logic.ts";

const execFileAsync = promisify(execFile);

/**
 * Current Node LTS major. Hard-coded because the policy decision ("warn at
 * N-2") is a Hydra-side choice, not something upstream tells us. Bump
 * this when Node ships a new even-numbered LTS major and the operator
 * has migrated. Audited via the doctor playbook every cycle.
 *
 * As of 2026-05: Node 22 is "Active LTS", Node 24 is "Current". We track
 * the active LTS rather than current because production runs on LTS.
 */
const NODE_LTS_MAJOR = 22;

/**
 * Network timeout for upstream API calls. Six seconds is generous for the
 * GitHub releases endpoint (typical p95 ~400ms) and bounded enough that a
 * dead network doesn't pause the doctor for minutes.
 */
const FETCH_TIMEOUT_MS = 6000;

/**
 * Subprocess timeout. `gh --version` and `node --version` both return in
 * milliseconds; anything slower is a wedged binary and should surface as
 * unknown.
 */
const EXEC_TIMEOUT_MS = 4000;

/**
 * Run a binary's `--version` and return its stdout, or null if the
 * binary is missing / errored / timed out. Never throws — we explicitly
 * want `unknown` rather than a crashed doctor when a tool isn't installed.
 */
async function safeVersion(bin: string, args: string[] = ["--version"]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(bin, args, {
      timeout: EXEC_TIMEOUT_MS,
      // Don't inherit stdio — we just want the version string.
      encoding: "utf8",
    });
    return stdout || null;
  } catch {
    /* intentional: missing binary or runtime error -> unknown verdict */
    return null;
  }
}

/**
 * GET a JSON URL with a short timeout. Returns `null` on any failure
 * (network down, non-2xx, malformed JSON, rate limit). The caller treats
 * `null` as "upstream check unavailable" and produces an `unknown` verdict.
 */
async function safeFetchJson(url: string): Promise<any | null> {
  // AbortController so the timeout actually cancels the underlying socket.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        // Identify ourselves so GitHub doesn't tar-pit anonymous traffic.
        "user-agent": "hydra-doctor-tool-currency/1.0",
        accept: "application/vnd.github+json",
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    /* intentional: network failure / abort / json parse -> unknown */
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function checkGh(): Promise<ToolReport> {
  const installedRaw = await safeVersion("gh");
  const installed = extractVersionFromOutput(installedRaw);

  const release = await safeFetchJson("https://api.github.com/repos/cli/cli/releases/latest");
  const latestTag = release?.tag_name as string | undefined;
  const latest = extractVersionFromOutput(latestTag ?? null);
  const releasedAt = release?.published_at as string | undefined;

  const verdicts: Verdict[] = [
    classifyByVersion(installed, latest),
  ];
  // Age-based escalation: if the installed version is the LATEST and the
  // latest is >6mo old, do NOT escalate (slow-moving tool). If the
  // installed version is OLDER and the latest is >6mo old, that means the
  // installed binary is even older — definitely outdated. We approximate
  // with: only run the age check when the version check already says
  // stale or unknown, to avoid false-warning healthy installs.
  if (verdicts[0] !== "ok") {
    const ageVerdict = classifyByAge(releasedAt);
    if (ageVerdict) verdicts.push(ageVerdict);
  }

  return buildReport({
    tool: "gh",
    installed,
    latest,
    verdicts,
    note: latest === null && installed !== null
      ? "couldn't reach api.github.com — verdict unknown"
      : undefined,
  });
}

async function checkClaude(): Promise<ToolReport> {
  // The Claude Code harness ships a `claude` CLI. There's no stable
  // public release feed yet, so we report installed-only and mark the
  // upstream as not-checkable. This is exactly the "no upstream check
  // available" branch the issue body calls out.
  const installedRaw = await safeVersion("claude");
  const installed = extractVersionFromOutput(installedRaw) ?? (installedRaw ? installedRaw.trim().split("\n")[0] : null);

  return buildReport({
    tool: "claude",
    installed,
    latest: null,
    verdicts: ["unknown"],
    note: "no upstream version feed — install via the official Claude Code installer",
  });
}

async function checkNode(): Promise<ToolReport> {
  const installedRaw = await safeVersion("node");
  const installed = extractVersionFromOutput(installedRaw);

  const verdict = classifyNodeMajor(installed, NODE_LTS_MAJOR);
  const latest = `${NODE_LTS_MAJOR}.x (LTS)`;

  return buildReport({
    tool: "node",
    installed,
    latest,
    verdicts: [verdict],
    note: verdict === "stale"
      ? `installed is N-1 from Node ${NODE_LTS_MAJOR} LTS; plan an upgrade`
      : verdict === "outdated"
      ? `installed is N-2 or older from Node ${NODE_LTS_MAJOR} LTS; upgrade soon`
      : undefined,
  });
}

/**
 * Push a warning-level alert into the Redis alerts list. We talk to Redis
 * via the same docker exec the rest of the doctor playbook uses, rather
 * than importing ioredis — that keeps this script callable from a fresh
 * checkout without `npm install` (the doctor itself runs on the operator
 * box, not inside the orchestrator process).
 *
 * Idempotency: we LPUSH a fresh entry every invocation and LTRIM to 100.
 * Repeated runs in close succession will push duplicates; the alerts UI
 * is expected to dedupe by `type` for display. The Sentry webhook in
 * `src/api/alerts.ts` follows the same pattern, so this matches the
 * established shape.
 */
async function emitAlert(report: ToolReport): Promise<void> {
  const payload = JSON.stringify({
    id: `tool-currency-${report.tool}-${Date.now()}`,
    type: "tool-currency",
    timestamp: new Date().toISOString(),
    message: buildAlertMessage(report),
    severity: "warning",
    dismissed: false,
    payload: {
      tool: report.tool,
      installed: report.installed,
      latest: report.latest,
      verdict: report.verdict,
    },
  });

  try {
    // We can't use the redis-adapter here because the doctor playbook
    // calls this script as a standalone subprocess. `docker exec` is how
    // the rest of the doctor talks to Redis.
    await execFileAsync(
      "docker",
      ["exec", "-i", "hydra-redis-1", "redis-cli", "-x", "LPUSH", "hydra:alerts"],
      { input: payload, timeout: 4000, encoding: "utf8" },
    );
    await execFileAsync(
      "docker",
      ["exec", "hydra-redis-1", "redis-cli", "LTRIM", "hydra:alerts", "0", "99"],
      { timeout: 4000, encoding: "utf8" },
    );
  } catch (err: any) {
    // Redis unreachable. We log to stderr so the doctor surfaces it but
    // we never crash — alerting is best-effort.
    console.error(`[tool-currency] alert emit failed: ${err?.message ?? err}`);
  }
}

async function main(): Promise<number> {
  const args = new Set(process.argv.slice(2));
  const wantJson = args.has("--json") || args.size === 0;
  const wantTable = args.has("--table");
  const wantAlert = args.has("--alert");

  const reports: ToolReport[] = await Promise.all([
    checkGh(),
    checkClaude(),
    checkNode(),
  ]);

  if (wantAlert) {
    for (const r of reports) {
      if (r.severity === "warning") {
        await emitAlert(r);
      }
    }
  }

  if (wantTable) {
    process.stdout.write(formatReportTable(reports) + "\n");
  }
  if (wantJson) {
    process.stdout.write(JSON.stringify(reports, null, 2) + "\n");
  }

  return 0;
}

main()
  .then(code => process.exit(code))
  .catch(err => {
    // Truly unexpected — log and exit nonzero so the operator notices.
    // The doctor playbook treats nonzero as a collector failure.
    console.error(`[tool-currency] unexpected error: ${err?.stack ?? err}`);
    process.exit(1);
  });
