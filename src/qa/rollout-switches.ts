/**
 * QA rollout switches (S3, #5259; ADR-0046 Decision 6).
 *
 * Reads `config/orchestrator/qa-rollout.json` (`two-way-pair: off|shadow|on`,
 * `reviewer-commits: off|A|A+B`). Missing file / key / malformed value means
 * `off`. A cohort trip (or an unreadable trip source) forces BOTH switches off
 * at read time. The trip rule itself lives in scripts/qa/cohort-baseline.ts;
 * this reader only consumes the committed `metrics.tripped` boolean.
 *
 * Never throws: callers get result objects. Tier/door blind by design.
 */
import { readFile as fsReadFile } from "node:fs/promises";
import { join } from "node:path";

export const QA_ROLLOUT_CONFIG_PATH = "config/orchestrator/qa-rollout.json";
/** Re-declared (src/ cannot import scripts/); the test pins it equal to BASELINE_FIXTURE_PATH. */
export const COHORT_BASELINE_PATH = "test/fixtures/qa-cohort-baseline.json";

export const TWO_WAY_PAIR_VALUES = ["off", "shadow", "on"] as const;
export const REVIEWER_COMMITS_VALUES = ["off", "A", "A+B"] as const;

export type TwoWayPairValue = (typeof TWO_WAY_PAIR_VALUES)[number];
export type ReviewerCommitsValue = (typeof REVIEWER_COMMITS_VALUES)[number];
export type TripState = "tripped" | "not-tripped" | "unknown";

export interface RolloutSwitches {
  configured: { "two-way-pair": TwoWayPairValue; "reviewer-commits": ReviewerCommitsValue };
  effective: { "two-way-pair": TwoWayPairValue; "reviewer-commits": ReviewerCommitsValue };
  trip: { state: TripState };
  /** Machine-readable reasons a value fell back to off or was overridden. */
  reasons: string[];
}

function narrow<T extends string>(
  obj: Record<string, unknown> | null,
  key: string,
  allowed: readonly T[],
  reasons: string[],
): T {
  if (obj === null || !(key in obj)) {
    if (obj !== null) reasons.push(`key-missing:${key}`);
    return "off" as T;
  }
  const v = obj[key];
  if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T;
  reasons.push(`value-malformed:${key}`);
  return "off" as T;
}

/** Pure and total over unknown input. */
export function resolveRolloutSwitches(raw: unknown, trip: TripState): RolloutSwitches {
  const reasons: string[] = [];
  let obj: Record<string, unknown> | null = null;
  if (raw === undefined) {
    reasons.push("config-missing");
  } else if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    obj = raw as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      if (k !== "two-way-pair" && k !== "reviewer-commits") reasons.push(`key-unknown:${k}`);
    }
  } else {
    reasons.push("config-malformed");
  }
  const configured = {
    "two-way-pair": narrow(obj, "two-way-pair", TWO_WAY_PAIR_VALUES, reasons),
    "reviewer-commits": narrow(obj, "reviewer-commits", REVIEWER_COMMITS_VALUES, reasons),
  };
  if (trip === "tripped") reasons.push("cohort-tripped");
  if (trip === "unknown") reasons.push("trip-unreadable");
  const effective =
    trip === "not-tripped"
      ? { ...configured }
      : { "two-way-pair": "off" as TwoWayPairValue, "reviewer-commits": "off" as ReviewerCommitsValue };
  return { configured, effective, trip: { state: trip }, reasons };
}

function tripFromBaseline(text: string): TripState {
  try {
    const doc = JSON.parse(text) as { metrics?: { tripped?: unknown } };
    const t = doc?.metrics?.tripped;
    if (t === true) return "tripped";
    if (t === false) return "not-tripped";
    return "unknown";
  } catch {
    /* intentional: unparsable baseline is the "unknown" trip state, which forces off */
    return "unknown";
  }
}

export interface RolloutDeps {
  readFile?: (path: string) => Promise<string>;
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT";
}

export async function loadRolloutSwitches(
  repoRoot: string,
  deps: RolloutDeps = {},
): Promise<RolloutSwitches> {
  const read = deps.readFile ?? ((p: string) => fsReadFile(p, "utf8"));
  let readFailed = false;

  let raw: unknown = undefined;
  const cfgPath = join(repoRoot, QA_ROLLOUT_CONFIG_PATH);
  try {
    const text = await read(cfgPath);
    try {
      raw = JSON.parse(text);
    } catch {
      /* intentional: unparsable config resolves to config-malformed => off */
      raw = "malformed";
    }
  } catch (err) {
    if (!isEnoent(err)) {
      console.error(`[rollout-switches] failed to read ${cfgPath}:`, err);
      readFailed = true;
    }
  }

  let trip: TripState = "unknown";
  const basePath = join(repoRoot, COHORT_BASELINE_PATH);
  try {
    trip = tripFromBaseline(await read(basePath));
  } catch (err) {
    if (!isEnoent(err)) console.error(`[rollout-switches] failed to read ${basePath}:`, err);
  }

  const res = resolveRolloutSwitches(raw, trip);
  if (readFailed) {
    res.reasons = res.reasons.filter((r) => r !== "config-missing").concat("config-read-failed");
  }
  return res;
}
