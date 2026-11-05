/**
 * watchdog/drift-gate.ts — the shared, pure pieces of the two FILE-marker drift
 * checks (deploy drift and skill-mirror drift; issue #5098, epic #5094).
 *
 * Both checks keep their first-seen marker as an epoch-SECONDS file so an
 * in-flight drift episode survives the deploy that lands the TypeScript port
 * (INV-6), and both gate their opt-in action identically: enabled AND the drift
 * has persisted past the grace window AND the scheduler is not deliberately
 * stopped. They deliberately do NOT use `runEpisode` — the marker is cleared
 * AFTER the action so a failed deploy/resync retries next grace window.
 */

/** Epoch-seconds first-seen marker file port. */
export interface DriftMarkerPort {
  /** Raw file text, or `null` when the file is absent/unreadable. */
  read(): string | null;
  /** Best-effort write of epoch seconds. */
  write(epochS: number): void;
  /** Best-effort delete. */
  clear(): void;
}

/** Scheduler stop-reason read (GET /api/scheduler/status, 5s bound); `null` = unreachable/unparseable. */
export interface SchedulerStopPort {
  stopReason(): Promise<string | null>;
}

/**
 * Parse a marker file's text as epoch seconds. A missing file, garbage or a
 * non-digit value reads as `nowS` (so the drift age is 0 and the grace window
 * restarts), exactly like the bash `[[ =~ ^[0-9]+$ ]] || first_seen=now`.
 */
export function parseMarkerSeconds(raw: string | null, nowS: number): number {
  if (raw === null) return nowS;
  const text = raw.trim();
  return /^[0-9]+$/.test(text) ? Number(text) : nowS;
}

/** Drift age in whole seconds; a marker from the future clamps to 0. */
export function driftAgeSeconds(firstSeenS: number, nowS: number): number {
  return Math.max(0, nowS - firstSeenS);
}

export type AutoActionVerdict = "advisory" | "within-grace" | "deliberate-stop" | "act";

/**
 * Pure gate for the opt-in action. Order matches the bash: disabled ->
 * advisory; age < grace -> within-grace; scheduler stopReason=deliberate ->
 * deliberate-stop; else act. `stopReason` is only consulted once the first two
 * gates pass (an unreachable API is `null` and does not block).
 */
export function decideAutoAction(input: {
  enabled: boolean;
  driftAgeS: number;
  graceS: number;
  stopReason: string | null;
}): AutoActionVerdict {
  if (!input.enabled) return "advisory";
  if (input.driftAgeS < input.graceS) return "within-grace";
  if (input.stopReason === "deliberate") return "deliberate-stop";
  return "act";
}

/** Parse a non-negative integer env value, falling back on unset/empty/garbage. */
export function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  return /^[0-9]+$/.test(raw) ? Number(raw) : fallback;
}
