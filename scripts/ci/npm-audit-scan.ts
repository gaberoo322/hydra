/**
 * scripts/ci/npm-audit-scan.ts — shared npm-audit evaluator (issue #3650).
 *
 * Single source of truth for the "does a high/critical advisory block?"
 * decision that used to live as inline `node -e` scripts inside ci.yml's
 * `npm-audit-orchestrator` / `npm-audit-dashboard` jobs. Those jobs were
 * REQUIRED branch-protection checks that queried the LIVE advisory DB, so a
 * newly-published CVE against an already-installed dependency reddened them
 * repo-wide with zero code change — freezing every merge and (via the deploy
 * `needs`) every deploy until a human intervened (the "ambient poison pill";
 * two instances on 2026-07-24, GHSA-qwww-vcr4-c8h2 and GHSA-mh99-v99m-4gvg).
 *
 * ADR direction (operator decision 2026-07-25): the audit is DEMOTED from a
 * required gate to an ADVISORY surface — it runs in `advisory-checks.yml`
 * (non-blocking) for at-a-glance PR visibility, and in `audit-nightly.yml`
 * (scheduled) which files a dep-bump issue on a new non-allowlisted
 * high/critical. A fresh CVE now becomes tracked work, never a merge/deploy
 * freeze.
 *
 * `evaluateAudit` is pure (no fs/network) so the security-critical fail-closed
 * logic is unit-tested directly (test/npm-audit-scan.test.mts). It preserves,
 * byte-for-byte, the semantics two independent adversarial reviewers verified
 * on PR #3608:
 *   - only high/critical severities are considered;
 *   - a package blocks only if it carries an advisory (`via` OBJECT with a
 *     url) whose GHSA id is NOT allowlisted;
 *   - pure-transitive entries (all `via` are strings — npm/arborist serializes
 *     metavulns, the only url:null records, as strings) are skipped: their
 *     advisory-bearing parent is a separate top-level entry judged directly,
 *     so a real CVE cannot slip through a transitive alias;
 *   - id extraction is `/GHSA-[a-z0-9-]+/i` with the full url as a fail-closed
 *     fallback (a non-GHSA url never matches an allowlist entry → blocks);
 *   - allowlist membership is exact/case-sensitive against the extracted id.
 */

import { execFileSync } from "node:child_process";

/** One `via` entry: a string (transitive parent name) or an advisory object. */
export interface AuditVia {
  url?: string;
  title?: string;
  source?: string | number;
}

export interface AuditVuln {
  severity?: string;
  range?: string;
  via?: Array<string | AuditVia>;
}

export interface AuditJson {
  vulnerabilities?: Record<string, AuditVuln>;
}

export interface AuditFinding {
  /** Vulnerable package name (the `vulnerabilities` key). */
  name: string;
  /** Advisory GHSA ids — the unwaived ones for a blocking finding. */
  ids: string[];
  severity: string;
  range: string;
}

export interface AuditEvaluation {
  /** High/critical advisories NOT covered by the allowlist. Non-empty ⇒ block. */
  blocking: AuditFinding[];
  /** High/critical advisories fully covered by the allowlist. */
  waived: AuditFinding[];
}

const HIGH_SEVERITIES: ReadonlySet<string> = new Set(["high", "critical"]);

/**
 * Classify an `npm audit --json` result against an allowlist of waived GHSA
 * ids. Pure — no fs/network. Fails closed: anything not provably waived blocks.
 */
export function evaluateAudit(
  audit: AuditJson,
  allowlist: Iterable<string>,
): AuditEvaluation {
  const allow = new Set(
    [...allowlist].map((s) => s.trim()).filter(Boolean),
  );
  const vulns = audit.vulnerabilities || {};
  const blocking: AuditFinding[] = [];
  const waived: AuditFinding[] = [];

  for (const [name, info] of Object.entries(vulns)) {
    const severity = String(info?.severity ?? "");
    if (!HIGH_SEVERITIES.has(severity)) continue;

    const advs = (info.via || []).filter(
      (x): x is AuditVia =>
        typeof x === "object" && x !== null && typeof x.url === "string",
    );
    // Pure-transitive (all via are strings): the advisory-defining parent is a
    // separate top-level entry judged directly. Never blocks on its own.
    if (advs.length === 0) continue;

    const ids = advs.map(
      (x) => (String(x.url).match(/GHSA-[a-z0-9-]+/i) || [String(x.url)])[0],
    );
    const unwaived = ids.filter((id) => !allow.has(id));
    const range = String(info.range ?? "");

    if (unwaived.length) {
      blocking.push({ name, ids: unwaived, severity, range });
    } else {
      waived.push({ name, ids, severity, range });
    }
  }

  return { blocking, waived };
}

/** Render a markdown summary block for a step summary / issue body. */
export function renderSummary(
  label: string,
  evaluation: AuditEvaluation,
  allowlist: readonly string[],
): string {
  const lines: string[] = [];
  lines.push(`## npm audit — ${label} (high+ / critical, prod deps)`);
  lines.push("");
  if (allowlist.length) {
    lines.push(`_Scoped allowlist active: \`${allowlist.join(", ")}\`._`);
    lines.push("");
  }
  if (evaluation.blocking.length === 0 && evaluation.waived.length === 0) {
    lines.push("No high or critical advisories found.");
    return lines.join("\n");
  }
  lines.push("| Package | Severity | Range | Advisories | Status |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const f of evaluation.blocking) {
    lines.push(
      `| ${f.name} | ${f.severity} | ${f.range} | ${f.ids.join(", ")} | ⚠️ needs dep-bump |`,
    );
  }
  for (const f of evaluation.waived) {
    lines.push(
      `| ${f.name} | ${f.severity} | ${f.range} | ${f.ids.join(", ")} | waived |`,
    );
  }
  return lines.join("\n");
}

/**
 * Run `npm audit` in a directory and parse the JSON. Uses --package-lock-only
 * so it needs only the committed lockfile (no `npm ci` / node_modules). npm
 * audit exits non-zero when it finds advisories but still writes JSON to
 * stdout, so a non-zero exit is captured, not thrown.
 */
export function runNpmAudit(dir: string): AuditJson {
  let stdout: string;
  try {
    stdout = execFileSync(
      "npm",
      [
        "audit",
        "--omit=dev",
        "--audit-level=high",
        "--json",
        "--package-lock-only",
      ],
      { cwd: dir, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
  } catch (err: unknown) {
    const e = err as { stdout?: string | Buffer };
    const captured = e?.stdout ? String(e.stdout) : "";
    if (!captured.trim()) throw err; // a real exec failure, not "vulns found"
    stdout = captured;
  }
  return JSON.parse(stdout) as AuditJson;
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--")
          ? argv[++i]
          : "true";
      }
    }
  }
  return out;
}

/**
 * CLI. Flags:
 *   --dir <path>          directory to audit (default ".")
 *   --label <name>        human label for the summary (default = dir)
 *   --allowlist <ids>     comma-separated waived GHSA ids (default "")
 *   --format text|json    text (default): summary to stdout, exit 1 if blocking.
 *                         json: {label,dir,blocking,waived} to stdout, exit 0.
 */
function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const dir = args.dir || ".";
  const label = args.label || dir;
  const allowlist = (args.allowlist || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const format = args.format || "text";

  const audit = runNpmAudit(dir);
  const evaluation = evaluateAudit(audit, allowlist);

  if (format === "json") {
    process.stdout.write(
      JSON.stringify({ label, dir, ...evaluation }) + "\n",
    );
    process.exit(0);
  }

  process.stdout.write(renderSummary(label, evaluation, allowlist) + "\n");
  if (evaluation.blocking.length) {
    const summary = evaluation.blocking
      .map((f) => `${f.name} (${f.ids.join(", ")})`)
      .join("; ");
    process.stderr.write(
      `Non-allowlisted high/critical advisories: ${summary}\n`,
    );
    process.exit(1);
  }
  process.exit(0);
}

// Run as CLI only when invoked directly (not when imported by the test).
if (
  process.argv[1] &&
  (process.argv[1].endsWith("npm-audit-scan.ts") ||
    process.argv[1].endsWith("npm-audit-scan.js"))
) {
  main();
}
