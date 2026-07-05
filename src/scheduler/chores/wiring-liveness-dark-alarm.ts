/**
 * Wiring-liveness DARK-OUTCOME ALARM seam (issue #2805; Outcome-Attribution
 * Spine #2628, follow-up to the #2753 dark-outcome DETECTION).
 *
 * #2753 made a dark leading outcome VISIBLE (a per-tick verdict + a warn log). It
 * did NOT alarm: the vision's primary-path metric (forecast-calibration-brier)
 * has been dark for 10+ weeks and no tracked issue ever auto-filed. This module
 * closes that gap — it turns a SUSTAINED dark streak into a filed `needs-triage`
 * issue, with the four safeguards the approved design concept (#2805) pins:
 *
 *   - THRESHOLD (Invariant 2): file ONLY after the outcome has been continuously
 *     dark for >= {@link DEFAULT_DARK_ALARM_MS} (7 days), tracked via a persisted
 *     first-seen-dark timestamp that RESETS the moment the reading goes live again
 *     (stateless recovery, mirroring the output below-floor check). A transient
 *     gap inside the window never files.
 *   - NEVER THROWS (Invariant 3): a gh-CLI Adapter failure (or any Redis/read
 *     error) routes to a logged result object, never an exception, preserving the
 *     housekeeping-run never-abort contract.
 *   - IDEMPOTENT (Invariant 4): a per-outcome Redis dedup marker prevents
 *     re-filing the same issue every hourly tick; the marker clears on recovery.
 *   - PRODUCER IDENTITY (Invariant 6): the filed issue carries the producerHint
 *     and the metric file path (outcome.query), satisfying success-criterion 2.
 *
 * This module owns the ALARM policy + the gh filing side-effect. The pure DARK vs
 * STALE detection stays in `wiring-liveness-outcomes.ts`; the durable streak/marker
 * storage stays in `src/redis/wiring-liveness-dark-outcomes.ts`. `runWiringLiveness`
 * is the thin coordinator that runs detection, then hands the dark verdicts here.
 */

import { ghExec } from "../../github/gh.ts";
import type { OutcomeVerdict } from "./wiring-liveness-outcomes.ts";
import {
  getDarkSince,
  markDarkSince,
  clearDarkStreak,
  isDarkOutcomeFiled,
  markDarkOutcomeFiled,
} from "../../redis/wiring-liveness-dark-outcomes.ts";

/** Repo the needs-triage issue is filed against (matches the rest of the repo). */
const REPO = "gaberoo322/hydra";

/**
 * Sustained-dark threshold (ms) before an alarm files a needs-triage issue.
 * Default 7 days, from the design-concept success criterion ("remains dark for
 * 7+ days"). Injectable via {@link DarkAlarmDeps.darkAlarmMs} so tests pin the
 * boundary deterministically.
 */
export const DEFAULT_DARK_ALARM_MS = 7 * 24 * 60 * 60 * 1000;

/** The dark-arm of {@link OutcomeVerdict} — the only verdict this alarm acts on. */
type DarkVerdict = Extract<OutcomeVerdict, { status: "dark" }>;

/** Per-outcome outcome of one alarm pass, for diagnostics/tests. */
type DarkAlarmOutcome =
  /** Dark, but the streak has not yet reached the threshold — nothing filed. */
  | { name: string; action: "below-threshold"; darkForMs: number }
  /** Dark past threshold, but an issue was already filed this streak — deduped. */
  | { name: string; action: "already-filed"; darkForMs: number }
  /** Dark past threshold and freshly filed — carries the new issue number (0 on parse miss). */
  | { name: string; action: "filed"; darkForMs: number; issueNumber: number }
  /** The gh file attempt failed — logged, never thrown (Invariant 3). */
  | { name: string; action: "file-failed"; darkForMs: number; reason: string };

/** The aggregated result of one dark-alarm pass. */
export interface DarkAlarmResult {
  /** Outcome names for which a NEW needs-triage issue was filed this pass. */
  filed: string[];
  /** Every per-outcome alarm outcome, for diagnostics/tests. */
  outcomes: DarkAlarmOutcome[];
}

/** The success arm of a gh filer result. */
type FilerOk = { ok: true; data: { stdout: string; stderr: string } };
/** The failure arm of a gh filer result. */
type FilerFail = { ok: false; code: string; stderr: string };

/** Injectable gh filer (defaults to the real `ghExec`) so tests avoid a real gh spawn. */
type IssueFiler = (args: string[]) => Promise<FilerOk | FilerFail>;

/**
 * Type guard narrowing a gh filer result to its failure arm. The orchestrator's
 * `strict: false` tsconfig cannot discriminate this union on the boolean `ok`
 * field via a plain `if (!result.ok)` (same limitation the host-probe
 * `isProbeFailure` guard works around), so callers narrow through this guard.
 */
function isFilerFailure(r: FilerOk | FilerFail): r is FilerFail {
  return r.ok === false;
}

/** Type guard narrowing a file-issue result to its failure arm (same #strict:false reason). */
function isFileResultFailure(
  r: { ok: true; issueNumber: number } | { ok: false; reason: string },
): r is { ok: false; reason: string } {
  return r.ok === false;
}

/** External touchpoints of the dark-outcome alarm (all injectable for tests). */
export interface DarkAlarmDeps {
  /** Sustained-dark threshold (ms); defaults to {@link DEFAULT_DARK_ALARM_MS}. */
  darkAlarmMs?: number;
  /** Injectable clock (ms); defaults to `Date.now`. */
  now?: () => number;
  /** Injectable gh filer; defaults to the real {@link ghExec}. */
  fileIssue?: IssueFiler;
  /** Injectable first-seen-dark reader; defaults to {@link getDarkSince}. */
  readDarkSince?: (name: string) => Promise<number | null>;
  /** Injectable first-seen-dark writer (SET NX); defaults to {@link markDarkSince}. */
  writeDarkSince?: (name: string, nowMs: number) => Promise<number>;
  /** Injectable filed-marker reader; defaults to {@link isDarkOutcomeFiled}. */
  readFiled?: (name: string) => Promise<boolean>;
  /** Injectable filed-marker writer; defaults to {@link markDarkOutcomeFiled}. */
  writeFiled?: (name: string) => Promise<void>;
  /** Injectable streak/marker clearer (recovery); defaults to {@link clearDarkStreak}. */
  clearStreak?: (name: string) => Promise<void>;
}

/** Build the (stable, dedup-anchoring) title for a dark-outcome needs-triage issue. */
function buildTitle(name: string): string {
  return `dark leading outcome: ${name} has produced no reading for 7+ days`;
}

/** Build the issue body carrying the producer identity + metric file path (Invariant 6). */
function buildBody(verdict: DarkVerdict, darkForMs: number): string {
  const days = Math.floor(darkForMs / (24 * 60 * 60 * 1000));
  return [
    `The \`kind: leading\` outcome **${verdict.name}** has read \`null\` (no data produced) for **${days}+ days** continuously.`,
    "",
    "A dark leading outcome is silent Outcome-Holdback blindness — every holdback baseline carries `value: null` for it, so the system cannot tell whether its learning improves this metric.",
    "",
    `**Metric file (producer must write here):** \`${verdict.query}\``,
    "",
    `**Producer identity:** ${verdict.producerHint}`,
    "",
    "---",
    "*Auto-filed by the wiring-liveness dark-outcome alarm (issue #2805). This issue is filed once per continuous dark streak; the alarm's dedup marker clears the moment the outcome reads live again.*",
  ].join("\n");
}

/**
 * File a single needs-triage issue for a dark outcome. Never throws — a gh
 * failure returns `{ ok:false, reason }` so the caller records `file-failed`
 * (Invariant 3). Returns the new issue number on success (0 if gh's stdout URL
 * could not be parsed — still a success, just an unknown number).
 */
async function fileNeedsTriage(
  fileIssue: IssueFiler,
  verdict: DarkVerdict,
  darkForMs: number,
): Promise<{ ok: true; issueNumber: number } | { ok: false; reason: string }> {
  const result = await fileIssue([
    "issue",
    "create",
    "--repo",
    REPO,
    "--title",
    buildTitle(verdict.name),
    "--body",
    buildBody(verdict, darkForMs),
    "--label",
    "needs-triage",
  ]);
  if (isFilerFailure(result)) {
    console.error(
      `[Housekeeping] wiring-liveness dark-alarm: gh issue create failed for ${verdict.name} (${result.code})`,
    );
    return { ok: false, reason: result.code };
  }
  const m = result.data.stdout.match(/\/issues\/(\d+)/);
  return { ok: true, issueNumber: m ? parseInt(m[1], 10) : 0 };
}

/**
 * Evaluate the dark verdicts from a detection pass and, for each outcome that has
 * been continuously dark past the threshold and not yet filed this streak, file a
 * `needs-triage` issue. `darkVerdicts` is the dark-arm subset of
 * `evaluateDarkOutcomes().outcomeVerdicts`; `liveOrRecoveredNames` is every
 * outcome that read LIVE this pass, so its streak/marker is cleared (stateless
 * recovery — Invariant 2).
 *
 * Never throws (Invariant 3): every per-outcome Redis/gh error is folded into a
 * `file-failed` outcome + a fail-loud log, so one bad outcome never aborts the
 * pass and the pass never aborts the housekeeping run.
 */
export async function runDarkOutcomeAlarm(
  darkVerdicts: DarkVerdict[],
  liveOrRecoveredNames: string[],
  deps: DarkAlarmDeps = {},
): Promise<DarkAlarmResult> {
  const darkAlarmMs = deps.darkAlarmMs ?? DEFAULT_DARK_ALARM_MS;
  const nowMs = (deps.now ?? Date.now)();
  const fileIssue = deps.fileIssue ?? ghExec;
  const readDarkSince = deps.readDarkSince ?? getDarkSince;
  const writeDarkSince = deps.writeDarkSince ?? markDarkSince;
  const readFiled = deps.readFiled ?? isDarkOutcomeFiled;
  const writeFiled = deps.writeFiled ?? markDarkOutcomeFiled;
  const clearStreak = deps.clearStreak ?? clearDarkStreak;

  const filed: string[] = [];
  const outcomes: DarkAlarmOutcome[] = [];

  // Stateless recovery (Invariant 2): every outcome that read LIVE this pass has
  // its streak anchor + filed marker cleared, so a future dark streak starts
  // fresh and files a fresh issue. Never throws — a clear failure is logged.
  for (const name of liveOrRecoveredNames) {
    try {
      await clearStreak(name);
    } catch (err: any) {
      console.error(
        `[Housekeeping] wiring-liveness dark-alarm: failed to clear recovered streak for ${name}: ${err?.message || err}`,
      );
    }
  }

  for (const verdict of darkVerdicts) {
    try {
      // Anchor (or read the existing anchor for) this dark streak — SET NX so the
      // first dark tick pins the start and subsequent ticks read it back.
      const darkSince = await writeDarkSince(verdict.name, nowMs);
      const darkForMs = nowMs - darkSince;

      if (darkForMs < darkAlarmMs) {
        outcomes.push({ name: verdict.name, action: "below-threshold", darkForMs });
        continue;
      }

      // Past threshold: dedup against the per-streak filed marker (Invariant 4).
      if (await readFiled(verdict.name)) {
        outcomes.push({ name: verdict.name, action: "already-filed", darkForMs });
        continue;
      }

      const fileResult = await fileNeedsTriage(fileIssue, verdict, darkForMs);
      if (isFileResultFailure(fileResult)) {
        // Do NOT set the filed marker on failure — a transient gh outage retries
        // next tick rather than silently never filing.
        outcomes.push({
          name: verdict.name,
          action: "file-failed",
          darkForMs,
          reason: fileResult.reason,
        });
        continue;
      }

      await writeFiled(verdict.name);
      filed.push(verdict.name);
      outcomes.push({
        name: verdict.name,
        action: "filed",
        darkForMs,
        issueNumber: fileResult.issueNumber,
      });
      console.warn(
        `[Housekeeping] wiring-liveness dark-alarm: filed needs-triage issue #${fileResult.issueNumber} for dark leading outcome '${verdict.name}' (dark ${Math.floor(darkForMs / (24 * 60 * 60 * 1000))}d)`,
      );
    } catch (err: any) {
      // Defense in depth: a Redis read/write throw for one outcome must not abort
      // the whole pass. Fail loud, record file-failed, continue.
      console.error(
        `[Housekeeping] wiring-liveness dark-alarm: unexpected error for ${verdict.name}: ${err?.message || err}`,
      );
      outcomes.push({
        name: verdict.name,
        action: "file-failed",
        darkForMs: 0,
        reason: `unexpected: ${err?.message || err}`,
      });
    }
  }

  return { filed, outcomes };
}
