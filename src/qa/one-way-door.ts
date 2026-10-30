/**
 * src/qa/one-way-door.ts — the one-way-door detector (issue #5257, S1 of #5255).
 *
 * Classifies a PR diff into the four one-way (hard-to-reverse) classes or
 * `unknown`. PURE LEAF: imports nothing, does no fs/network. The data it reads
 * (changed paths + unified diff text) is fetched by someone else (the
 * QaVerdictFetchers adapter, src/qa/fetchers.ts). It is content-based, not
 * path-based, except for classes 3 and 4 where the location IS the effect.
 *
 * ESCALATE-ONLY: the module exposes no option that can suppress a signal, lower
 * a class or narrow a finding; adding a rule can only move a result from
 * two-way to one-way. It is never wired into fold/verdict/fan-out here
 * (that is P1, switch-gated and shadow-first).
 *
 * Verifier Core paths (ci.yml, tier-classifier.ts, untouchable.ts, ...) are
 * deliberately absent from the path lists: the reversibility axis never applies
 * inside Verifier Core (T4 is already maximum depth, ADR-0046 D5).
 */

export type OneWayDoorClass =
  | "persistent-state"
  | "external-side-effect"
  | "breaking-way-back"
  | "out-of-repo-contract";

/** Enum order — `classes` is deduplicated and sorted by this. */
const CLASS_ORDER: readonly OneWayDoorClass[] = [
  "persistent-state",
  "external-side-effect",
  "breaking-way-back",
  "out-of-repo-contract",
];

export interface OneWayDoorSignal {
  ruleId: string;
  /** null only for the OWD-DETECTOR-ERROR signal. */
  class: OneWayDoorClass | null;
  path: string;
  line?: number;
  /** The trimmed matching line (or the error message), capped at 200 chars. */
  evidence: string;
}

export interface OneWayDoorResult {
  /**
   * FAIL-CLOSED READING: `unknown` means "could not tell" and MUST be treated
   * as `one-way` by every caller. Use {@link requiresOneWayDepth} rather than
   * comparing against `'one-way'` alone.
   */
  door: "one-way" | "two-way" | "unknown";
  classes: OneWayDoorClass[];
  signals: OneWayDoorSignal[];
}

export interface OneWayDoorInput {
  /** `git diff --no-renames --name-only` output, one entry per element. */
  paths: readonly string[];
  /** Unified diff text as `gh pr diff` / `git diff` emit. */
  diff: string;
  /** Caller-supplied path prefixes whose change is an external-risk surface. */
  riskCriticalPaths?: readonly string[];
}

interface RuleContext {
  riskCriticalPaths: readonly string[];
}

export interface OneWayDoorRule {
  id: string;
  class: OneWayDoorClass;
  kind: "added-line" | "removed-line" | "path";
  /** `subject` is the line text (line kinds) or the path (path kind). */
  match: (subject: string, path: string, ctx: RuleContext) => boolean;
}

const EVIDENCE_CAP = 200;
/** Lines longer than this are truncated before regex scanning (blow-up guard). */
const SCAN_LINE_CAP = 4000;

const DEPLOY_PATHS: readonly string[] = [
  "scripts/deploy.sh",
  "scripts/deploy-drift-check.ts",
  "scripts/deploy-drift-logic.ts",
  "scripts/hydra-watchdog.sh",
  "scripts/hydra-watchdog.ts",
];
const DEPLOY_PREFIXES: readonly string[] = ["scripts/systemd/", "src/watchdog/"];

const REDIS_DELETE_RE = /\.(?:del|unlink|rename|renamenx|flushdb|flushall)\(/;
const REDIS_CLI_DELETE_RE = /redis-cli\b.*\b(?:del|unlink|flushall|flushdb)\b/i;
const GH_API_DELETE_RE = /\bgh\s+api\b.*(?:-X\s*DELETE|--method[ =]DELETE|--request[ =]DELETE)\b/i;
const GH_RESOURCE_DELETE_RE = /\bgh\s+(?:repo|release|label)\s+delete\b/;
const GH_BULK_EDIT_RE = /(?:\bgh\s+(?:issue|pr)\s+list\b|\bxargs\b).*\bgh\s+(?:issue|pr)\s+(?:edit|close)\b/;
const NODE_MODULES_RE = /\brm\s+-(?:rf|fr)\b.*node_modules|\bln\s+-sfn?\b.*node_modules/;
const CREDENTIAL_ASSIGN_RE = /(?:TOKEN|SECRET|API_KEY|CREDENTIALS?)\w*\s*=/;
const GH_AUTH_RE = /\bgh\s+auth\s+(?:login|refresh|setup-git)\b|\bgh\s+secret\s+set\b/;

function isEnvFile(path: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.startsWith(".env");
}

/**
 * The rule table is DATA with stable ids. The test pins the seed id set as a
 * ratchet: removing an id fails until the test is edited in the same PR.
 */
export const ONE_WAY_DOOR_RULES: readonly OneWayDoorRule[] = [
  {
    id: "OWD-STATE-REDIS-DELETE",
    class: "persistent-state",
    kind: "added-line",
    match: (line, path) =>
      ((path.startsWith("src/redis/") || path.startsWith("scripts/")) && REDIS_DELETE_RE.test(line)) ||
      REDIS_CLI_DELETE_RE.test(line),
  },
  {
    id: "OWD-STATE-KEY-RENAME",
    class: "persistent-state",
    kind: "removed-line",
    match: (line, path) => path === "src/redis/keys.ts" && line.includes("hydra:"),
  },
  {
    id: "OWD-EXTERNAL-GH-DELETE",
    class: "external-side-effect",
    kind: "added-line",
    match: (line) => GH_API_DELETE_RE.test(line) || GH_RESOURCE_DELETE_RE.test(line),
  },
  {
    id: "OWD-EXTERNAL-GH-BULK-EDIT",
    class: "external-side-effect",
    kind: "added-line",
    match: (line) => GH_BULK_EDIT_RE.test(line),
  },
  {
    id: "OWD-EXTERNAL-RISK-SURFACE",
    class: "external-side-effect",
    kind: "path",
    match: (path, _p, ctx) => ctx.riskCriticalPaths.some((prefix) => prefix !== "" && path.startsWith(prefix)),
  },
  {
    id: "OWD-WAYBACK-DEPLOY-PATH",
    class: "breaking-way-back",
    kind: "path",
    match: (path) => DEPLOY_PATHS.includes(path) || DEPLOY_PREFIXES.some((p) => path.startsWith(p)),
  },
  {
    id: "OWD-WAYBACK-NODE-MODULES",
    class: "breaking-way-back",
    kind: "added-line",
    match: (line) => NODE_MODULES_RE.test(line),
  },
  {
    id: "OWD-CONTRACT-SKILL-SURFACE",
    class: "out-of-repo-contract",
    kind: "path",
    match: (path) =>
      path === "scripts/sync-skills.sh" ||
      path.startsWith("scripts/claude-hooks/") ||
      (path.startsWith(".claude/settings") && path.endsWith(".json")),
  },
  {
    id: "OWD-CONTRACT-CREDENTIALS",
    class: "out-of-repo-contract",
    kind: "added-line",
    match: (line, path) =>
      ((path.startsWith("scripts/systemd/") || isEnvFile(path)) && CREDENTIAL_ASSIGN_RE.test(line)) ||
      GH_AUTH_RE.test(line),
  },
];

/** Prose-only paths never run content rules (a doc quoting a command cannot execute it). */
function isProseOnlyPath(path: string): boolean {
  if (path.startsWith(".changelog/")) return true;
  if (path.startsWith("docs/") && !path.startsWith("docs/operator-playbooks/")) return true;
  return !path.includes("/") && path.endsWith(".md");
}

function normalizePath(raw: string): string {
  return raw.trim().replace(/^\.\//, "");
}

interface DiffLine {
  path: string;
  kind: "added" | "removed";
  line: number | undefined;
  text: string;
}

interface ParsedDiff {
  files: string[];
  lines: DiffLine[];
}

/** Decode a quoted C-style path body (octal escapes are UTF-8 bytes). */
function unquoteCStyle(body: string): string {
  const bytes: number[] = [];
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, "\\": 92, '"': 34 };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const oct = /^[0-7]{1,3}/.exec(body.slice(i + 1));
    if (oct) {
      bytes.push(parseInt(oct[0], 8));
      i += oct[0].length;
    } else if (body[i + 1] !== undefined && body[i + 1] in simple) {
      bytes.push(simple[body[i + 1]]);
      i += 1;
    } else {
      bytes.push(92);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Strip the a/ or b/ prefix from a header path, unquoting if quoted. */
function headerPath(raw: string): string {
  const t = raw.trim();
  const q = /^"(.*)"$/.exec(t);
  const body = q ? unquoteCStyle(q[1]) : t.replace(/\t.*$/, "");
  return normalizePath(body.replace(/^[ab]\//, ""));
}

/** Minimal added/removed-line walker keyed on `diff --git` / `+++ b/` headers. */
function walkDiff(diff: string): ParsedDiff {
  const files: string[] = [];
  const lines: DiffLine[] = [];
  let current: string | null = null;
  // Hunk extents come from the @@ counts so the next file's ---/+++ header is
  // never consumed as content of the previous hunk (quoted paths, plain diff -u).
  let oldLeft = 0;
  let newLeft = 0;
  let newLine = 0;
  const addFile = (p: string) => {
    if (p !== "/dev/null" && p !== "" && !files.includes(p)) files.push(p);
  };
  for (const raw of diff.split("\n")) {
    // A line that cannot be hunk content (e.g. the next `diff --git`) ends a
    // hunk whose @@ counts were inconsistent.
    if (raw !== "" && !/^[-+ \\]/.test(raw)) {
      oldLeft = 0;
      newLeft = 0;
    }
    const inHunk = oldLeft > 0 || newLeft > 0;
    if (!inHunk) {
      const header = /^diff --git (?:"a\/.*"|a\/\S+?) ("b\/.*"|b\/.+)$/.exec(raw);
      if (header) {
        current = headerPath(header[1]);
        addFile(current);
        continue;
      }
      if (raw.startsWith("+++ ")) {
        const target = raw.slice(4);
        if (target.trim() !== "/dev/null") {
          current = headerPath(target);
          addFile(current);
        }
        continue;
      }
      if (raw.startsWith("--- ")) continue;
      const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
      if (hunk) {
        oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
        newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
        newLine = Number(hunk[2]);
      }
      continue;
    }
    if (current === null) continue;
    if (raw.startsWith("+")) {
      lines.push({ path: current, kind: "added", line: newLine, text: raw.slice(1) });
      newLine += 1;
      newLeft -= 1;
    } else if (raw.startsWith("-")) {
      lines.push({ path: current, kind: "removed", line: undefined, text: raw.slice(1) });
      oldLeft -= 1;
    } else if (raw.startsWith(" ") || raw === "") {
      newLine += 1;
      oldLeft -= 1;
      newLeft -= 1;
    }
  }
  return { files, lines };
}

function evidenceOf(text: string): string {
  return text.trim().slice(0, EVIDENCE_CAP);
}

function errorResult(message: string): OneWayDoorResult {
  return {
    door: "unknown",
    classes: [],
    signals: [{ ruleId: "OWD-DETECTOR-ERROR", class: null, path: "", evidence: evidenceOf(message) }],
  };
}

/**
 * Classify a PR diff. Total: never throws. `one-way` iff at least one signal
 * fires; `two-way` iff no signal fires on a parseable diff; `unknown`
 * (fail-closed, treat as one-way) when the diff is empty/unparseable or the
 * detector itself errored.
 */
export function detectOneWayDoor(input: OneWayDoorInput): OneWayDoorResult {
  try {
    if (
      input === null ||
      typeof input !== "object" ||
      !Array.isArray(input.paths) ||
      input.paths.some((p) => typeof p !== "string") ||
      typeof input.diff !== "string"
    ) {
      throw new TypeError("one-way-door: input must be {paths: string[], diff: string}");
    }
    const ctx: RuleContext = { riskCriticalPaths: input.riskCriticalPaths ?? [] };
    const parsed = walkDiff(input.diff);
    const allPaths: string[] = [];
    for (const p of [...input.paths.map(normalizePath), ...parsed.files]) {
      if (p !== "" && !allPaths.includes(p)) allPaths.push(p);
    }

    const signals: OneWayDoorSignal[] = [];
    for (const path of allPaths) {
      for (const rule of ONE_WAY_DOOR_RULES) {
        if (rule.kind === "path" && rule.match(path, path, ctx)) {
          signals.push({ ruleId: rule.id, class: rule.class, path, evidence: evidenceOf(path) });
        }
      }
    }
    for (const dl of parsed.lines) {
      if (isProseOnlyPath(dl.path)) continue;
      const scan = dl.text.slice(0, SCAN_LINE_CAP);
      const wanted = dl.kind === "added" ? "added-line" : "removed-line";
      for (const rule of ONE_WAY_DOOR_RULES) {
        if (rule.kind === wanted && rule.match(scan, dl.path, ctx)) {
          const signal: OneWayDoorSignal = {
            ruleId: rule.id,
            class: rule.class,
            path: dl.path,
            evidence: evidenceOf(dl.text),
          };
          if (dl.line !== undefined) signal.line = dl.line;
          signals.push(signal);
        }
      }
    }

    const classSet = new Set(signals.map((s) => s.class));
    const classes = CLASS_ORDER.filter((c) => classSet.has(c));
    if (signals.length > 0) return { door: "one-way", classes, signals };
    // Partial/truncated diff: a non-prose input path the diff never mentions
    // was never scanned, so it cannot be called two-way.
    const unscanned = input.paths
      .map(normalizePath)
      .some((p) => p !== "" && !isProseOnlyPath(p) && !parsed.files.includes(p));
    if (parsed.files.length > 0 && !unscanned) return { door: "two-way", classes: [], signals: [] };
    return { door: "unknown", classes: [], signals: [] };
  } catch (err) {
    console.error("[one-way-door] detector failed; failing closed to unknown:", err);
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

/** True for one-way AND unknown — consumers never compare `door === 'one-way'` alone. */
export function requiresOneWayDepth(result: Pick<OneWayDoorResult, "door">): boolean {
  return result.door === "one-way" || result.door === "unknown";
}
