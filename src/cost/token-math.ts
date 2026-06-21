/**
 * src/cost/token-math.ts — the pure math leaf of the **Cost** Module.
 *
 * Extracted out of `usage-tracker.ts` (issue #1909) so the model-family table,
 * the JSONL-line parser, the quota-weight / cache-hit formulas, and the
 * weekly-reset / session-limit time math live in a focused leaf named after
 * the concept — not buried in 1391 lines of JSONL-scan + snapshot-assembly
 * code. Same axis the env-reader leaf `config.ts` (#1896) and the eligibility
 * fold `eligibility.ts` (#1377) split along.
 *
 * PURE: no IO (no readFile/stat), no Redis, no `process.env` reads, no
 * `Date.now()` — every time/env input enters as a function argument. The
 * import direction is strictly one-way: this leaf imports NOTHING from
 * `src/cost/`; `usage-tracker.ts` imports its math from here. The barrel
 * `src/cost/index.ts` re-exports these symbols at the SAME names, so no
 * external import line changes.
 *
 * Functions moved here are VERBATIM relocations (same body, signature,
 * doc-comment) of the seven pure functions that previously lived in
 * `usage-tracker.ts`: behaviour is byte-for-byte unchanged.
 */

// ---------------------------------------------------------------------------
// Time constant — local to this leaf so `projectResetWindow` stays self-
// contained and the import direction stays one-way (no import back into the
// scan-pipeline module). `usage-tracker.ts` keeps its own scan-window
// constants (`WINDOW_5H_MS`, `WINDOW_24H_MS`, `WINDOW_7D_MS`, …) for the
// rolling-window scan; this is the only one the reset-window math needs.
// ---------------------------------------------------------------------------
const MS_PER_DAY = 86_400_000;
const WINDOW_7D_MS = 7 * MS_PER_DAY;

// ---------------------------------------------------------------------------
// Types — the directly-dependent shapes of the pure math (issue #1909)
// ---------------------------------------------------------------------------

export interface TokenBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  total: number;
}

/**
 * Model families recognised by the per-model rollup. `unknown` is the
 * catch-all for any model string that doesn't match a known prefix
 * (synthetic messages, future model names, GPT carry-overs). Its
 * Quota-Weight contribution uses an implicit weight of 1.0 — there is
 * deliberately no `HYDRA_QUOTA_WEIGHT_UNKNOWN` env var because the
 * CONTEXT.md Quota-Weight formula is opus/sonnet/haiku only; an unknown
 * bucket above zero signals the family table needs a new prefix, which the
 * once-per-scan `console.warn` surfaces.
 */
export type ModelFamily = "opus" | "sonnet" | "haiku" | "unknown";

/**
 * The canonical ordered family list the per-family rollups + Quota-Weight folds
 * iterate. Relocated DOWN into this pure leaf (issue #2279) from
 * `usage-tracker.ts` so both `usage-tracker.ts` (the I/O coordinator) and the
 * extracted `snapshot-assembly.ts` leaf import it one-way from here — the same
 * downward-only import direction this leaf already enforces. `transcript-scan.ts`
 * keeps its own private copy for the scan-side rollup; this is the canonical
 * copy the snapshot-assembly math shares.
 */
export const MODEL_FAMILIES: readonly ModelFamily[] = ["opus", "sonnet", "haiku", "unknown"];

/**
 * Quota-Weight for a family. opus/sonnet/haiku from env-derived weights; unknown
 * is the implicit 1.0 (the CONTEXT.md Quota-Weight formula is three-family —
 * there is deliberately no `HYDRA_QUOTA_WEIGHT_UNKNOWN`). Relocated DOWN into
 * this pure leaf (issue #2279) so the snapshot-assembly fold can import it
 * one-way without a back-import into the coordinator. Pure + total: the weights
 * object is passed in, no env read here.
 */
export function familyWeight(
  family: ModelFamily,
  weights: { opus: number; sonnet: number; haiku: number },
): number {
  switch (family) {
    case "opus":
      return weights.opus;
    case "sonnet":
      return weights.sonnet;
    case "haiku":
      return weights.haiku;
    case "unknown":
      // Implicit 1.0 — no HYDRA_QUOTA_WEIGHT_UNKNOWN env var exists; the
      // formula is three-family. Drift here is surfaced by the
      // once-per-scan console.warn, not absorbed by a tunable.
      return 1;
  }
}

export interface ResetWindow {
  /**
   * Epoch-ms of the most recent anchor + 7d*k that is <= now — the start of
   * the current fixed weekly window.
   */
  currentMs: number;
  /** Epoch-ms of the next reset boundary (currentMs + 7d). */
  nextMs: number;
}

export interface ParsedUsageLine {
  tsMs: number;
  tokens: TokenBreakdown;
  /**
   * Raw `message.model` string verbatim (or "" when absent). The scan loop
   * runs it through `modelToFamily()` to bucket `byModel`; surfacing the raw
   * string keeps the parser pure and lets tests pin classification
   * independently. (issue #691)
   */
  model: string;
}

// ---------------------------------------------------------------------------
// Pure math functions (issue #1909) — moved verbatim from usage-tracker.ts
// ---------------------------------------------------------------------------

/**
 * Project a single seeded **Weekly Reset Anchor** forward (and backward) in
 * 7-day multiples to find the fixed window containing `nowMs`.
 *
 * Returns the most recent boundary `anchorMs + 7d*k <= nowMs` (`currentMs`)
 * and the next one (`nextMs = currentMs + 7d`). Works for anchors in the
 * past OR the future (`k` may be negative). Pure + total: no I/O, no env
 * reads, deterministic in its two args — so it's the unit-testable core of
 * the Anchor math.
 */
export function projectResetWindow(anchorMs: number, nowMs: number): ResetWindow {
  const k = Math.floor((nowMs - anchorMs) / WINDOW_7D_MS);
  const currentMs = anchorMs + k * WINDOW_7D_MS;
  return { currentMs, nextMs: currentMs + WINDOW_7D_MS };
}

/**
 * Classify a model string into a Quota-Weight family by prefix.
 *
 * Pure prefix matcher: `claude-opus*`/`claude-fable*` → opus,
 * `claude-sonnet*` → sonnet, `claude-haiku*` → haiku, anything else →
 * unknown. The `opus` family is the frontier-tier bucket: Fable 5 replaced
 * Opus as the dispatched frontier model (2026-06-10) and burns at the same
 * HYDRA_QUOTA_WEIGHT_OPUS weight — without this mapping every frontier token
 * would fall into `unknown` (uncalibrated weight 1.0). This is intentionally
 * a NEW classifier and NOT `modelToTier` from `attribution.ts` — that
 * function returns legacy tier labels (frontier/codex/mini) keyed on GPT
 * model names and would bucket every real `claude-opus-4-7` string into
 * `unknown`. The no-duplication intent is honoured by keeping this the ONE
 * canonical family classifier. (issue #691)
 */
export function modelToFamily(model: string | null | undefined): ModelFamily {
  const l = String(model ?? "").toLowerCase();
  if (l.startsWith("claude-opus")) return "opus";
  if (l.startsWith("claude-fable")) return "opus";
  if (l.startsWith("claude-sonnet")) return "sonnet";
  if (l.startsWith("claude-haiku")) return "haiku";
  return "unknown";
}

/**
 * The per-token-type weighted token count for one accumulator (issue #873):
 * `input + output + cacheCreation + w_cache*cacheRead`. This is the quota-burn
 * UNIT — it down-weights cache reads to match Anthropic's real meter (cache
 * reads bill at ~0.1x base input) while counting input/output/cacheCreation at
 * full weight. `w_cache = 1.0` (the default) reduces this exactly to `b.total`,
 * so the change is behaviour-neutral until the operator calibrates the env var.
 * Pure + total — the unit-testable core of the weighted-burn math.
 */
export function weightedTokens(b: TokenBreakdown, wCache: number): number {
  return b.input + b.output + b.cacheCreation + wCache * b.cacheRead;
}

/**
 * Parse one JSONL line. Three outcomes:
 *   - `null`     — malformed JSON; caller counts as parseError.
 *   - `"skip"`   — valid JSON but no usage block, no timestamp, or zero
 *                  tokens. The common case: most lines are user messages,
 *                  snapshots, tool results, etc.
 *   - object     — contributes to the rolling windows.
 *
 * Exported so tests can pin the parsing rules without round-tripping
 * through the filesystem.
 */
export function parseUsageLine(line: string): ParsedUsageLine | "skip" | null {
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    /* intentional: non-JSON transcript line → null per the documented contract above */
    return null;
  }
  const ts = obj?.timestamp;
  if (typeof ts !== "string") return "skip";
  const tsMs = Date.parse(ts);
  if (!Number.isFinite(tsMs)) return "skip";

  const usage = obj?.message?.usage;
  if (!usage || typeof usage !== "object") return "skip";

  const input = Number(usage.input_tokens) || 0;
  const output = Number(usage.output_tokens) || 0;
  const cacheRead = Number(usage.cache_read_input_tokens) || 0;
  const cacheCreation = Number(usage.cache_creation_input_tokens) || 0;
  const total = input + output + cacheRead + cacheCreation;
  if (total === 0) return "skip";

  const model = typeof obj?.message?.model === "string" ? obj.message.model : "";

  return {
    tsMs,
    tokens: { input, output, cacheRead, cacheCreation, total },
    model,
  };
}

/**
 * Extract an observed weekly/rate-limit RESET instant (epoch-ms) from one
 * JSONL line, or `null` when the line carries no reset signal.
 *
 * Claude Code has no documented schema for this, so we probe the field names
 * an Anthropic rate-limit payload realistically surfaces, in priority order:
 *
 *   1. `obj.message.usage.resets_at` / `reset_at` — usage block reset hint.
 *   2. `obj.message.rate_limit.resets_at` / a `rate_limit_*` error block.
 *   3. A top-level `obj.resetsAt` / `obj.reset_at` / `obj.usageLimitResetTime`
 *      that some harness builds attach to a limit-notice line.
 *
 * Each candidate is accepted only if it parses to a finite instant (ISO-8601
 * string OR epoch-seconds/ms number). This is intentionally permissive on
 * shape and strict on parse: an unrecognised line is simply `null`, never a
 * throw, so the scan never breaks on transcript-format drift. Exported so the
 * auto-correct rule is unit-testable without the filesystem. (issue #856)
 */
export function parseObservedResetMs(line: string): number | null {
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    /* intentional: non-JSON transcript line → null; the scan must never throw on format drift */
    return null;
  }
  const candidates: unknown[] = [
    obj?.message?.usage?.resets_at,
    obj?.message?.usage?.reset_at,
    obj?.message?.rate_limit?.resets_at,
    obj?.message?.rate_limit?.reset_at,
    obj?.message?.error?.rate_limit?.resets_at,
    obj?.rate_limit?.resets_at,
    obj?.resetsAt,
    obj?.reset_at,
    obj?.usageLimitResetTime,
  ];
  for (const c of candidates) {
    const ms = coerceInstantMs(c);
    if (ms !== null) return ms;
  }
  return null;
}

/**
 * Coerce a candidate reset value to epoch-ms. Accepts an ISO-8601 string or a
 * numeric epoch (seconds if < 1e12, else milliseconds). Returns null on
 * anything non-finite or non-positive. Pure helper for {@link parseObservedResetMs}.
 */
function coerceInstantMs(value: unknown): number | null {
  if (typeof value === "string" && value !== "") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    // Heuristic: a 2026 epoch in seconds is ~1.7e9; in ms it is ~1.7e12.
    return value < 1e12 ? value * 1000 : value;
  }
  return null;
}

/**
 * The Claude Code CLI's session-limit hard-block notice (issue #1089). When the
 * subscription's rolling session window is exhausted, the CLI prints — to the
 * journal, NOT the JSONL transcript — a line of the literal form:
 *
 *   You've hit your session limit · resets 4:40pm (America/Los_Angeles)
 *
 * This regex is deliberately tolerant of the surrounding journal prefix
 * (`Jun 06 14:41:18 host env[123]: …`) and of `am`/`pm` casing, and captures
 * the wall-clock time + IANA timezone so {@link parseSessionLimitReset} can
 * resolve them to a concrete future instant. The phrase "hit your session
 * limit" plus a `resets <time>` clause is the structural fingerprint — a
 * generic rate-limit notice (which carries a JSON `resets_at`, handled by
 * {@link parseObservedResetMs}) does not match.
 */
const SESSION_LIMIT_RE =
  /hit your session limit\s*[·•]?\s*resets\s+(\d{1,2})(?::(\d{2}))?\s*([ap]m)\s*\(([^)]+)\)/i;

/**
 * Resolve a wall-clock `HH:MM am|pm` in a named IANA timezone to the next
 * future epoch-ms relative to `nowMs`. Uses `Intl.DateTimeFormat` (Node stdlib,
 * no deps) to read the timezone's UTC offset at `nowMs`, then walks forward at
 * most one day so a time that already passed today maps to tomorrow. Returns
 * `null` on an unknown timezone or an out-of-range time. Pure helper for
 * {@link parseSessionLimitReset}; `nowMs` is injected so it stays testable.
 */
function resolveWallClockInZone(
  hour12: number,
  minute: number,
  meridiem: "am" | "pm",
  timeZone: string,
  nowMs: number,
): number | null {
  if (hour12 < 1 || hour12 > 12 || minute < 0 || minute > 59) return null;
  // 12am → 0, 12pm → 12, else add 12 for pm.
  let hour24 = hour12 % 12;
  if (meridiem === "pm") hour24 += 12;

  // The offset (minutes) between this timezone and UTC at `nowMs`. We compute
  // it by formatting `nowMs` in the zone and diffing against UTC — robust
  // across DST because the offset is sampled at the relevant instant.
  let offsetMin: number;
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = dtf.formatToParts(new Date(nowMs));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const asUtc = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour") === 24 ? 0 : get("hour"),
      get("minute"),
      get("second"),
    );
    if (!Number.isFinite(asUtc)) return null;
    offsetMin = Math.round((asUtc - nowMs) / 60_000);
  } catch {
    /* intentional: unknown/invalid IANA timezone → Intl throws a RangeError — bail to null */
    return null;
  }

  // Build "today" in the target zone from the same formatted parts, then set
  // the target wall-clock h:m and convert back to UTC via the sampled offset.
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(new Date(nowMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const y = get("year");
  const mo = get("month");
  const d = get("day");
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;

  // candidate(UTC) = local-wall-clock(UTC-naive) - offset.
  let candidate = Date.UTC(y, mo - 1, d, hour24, minute, 0) - offsetMin * 60_000;
  // If the wall-clock time has already passed today, the reset is tomorrow.
  if (candidate <= nowMs) candidate += 24 * 60 * 60 * 1000;
  return Number.isFinite(candidate) ? candidate : null;
}

/**
 * Extract the session-limit reset instant (epoch-ms) from a CLI/journal line,
 * or `null` when the line is not a session-limit notice (issue #1089).
 *
 * Distinct from {@link parseObservedResetMs}: that parses a JSON rate-limit
 * payload from the JSONL transcript; THIS parses the human-readable
 * `You've hit your session limit · resets <time>` line the CLI prints to the
 * journal when the rolling SESSION window is hard-blocked — the exact signal
 * the OAuth 5h meter undershoots (the skew #1089 fixes). `nowMs` is injected so
 * the wall-clock→instant resolution is deterministic and unit-testable.
 *
 * Pure: no IO, no `Date.now()`. Returns `null` (never throws) on a non-matching
 * line or an unresolvable time/timezone, so a journal-format drift degrades to
 * "no block recorded" rather than wedging the reap.
 */
export function parseSessionLimitReset(line: string, nowMs: number): number | null {
  if (typeof line !== "string" || line.length === 0) return null;
  const m = SESSION_LIMIT_RE.exec(line);
  if (!m) return null;
  const hour12 = Number(m[1]);
  const minute = m[2] !== undefined ? Number(m[2]) : 0;
  const meridiem = m[3].toLowerCase() as "am" | "pm";
  const timeZone = m[4].trim();
  if (!Number.isFinite(hour12) || !Number.isFinite(minute) || timeZone === "") return null;
  return resolveWallClockInZone(hour12, minute, meridiem, timeZone, nowMs);
}

/**
 * Cache-hit ratio for one accumulated window.
 *
 * `cacheRead / (cacheRead + cacheCreation + input)` — output tokens are
 * NOT cache-eligible so they never enter the denominator; cacheCreation
 * IS in the denominator so cache-warming cost is counted honestly.
 * Returns 0 when the denominator is 0 (zero-total guard — no NaN, no
 * division by zero). The result is always in the closed interval [0, 1].
 *
 * Exported so tests can pin the formula without round-tripping through
 * the filesystem.
 */
export function cacheHitRatio(b: TokenBreakdown): number {
  const denominator = b.cacheRead + b.cacheCreation + b.input;
  if (denominator === 0) return 0;
  return b.cacheRead / denominator;
}
