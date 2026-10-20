/**
 * Morning Brief timing (ADR-0045 Decision 7, issue #5047) — the pure predicate.
 *
 * The brief goes out at 07:30 local, timed by a Redis last-sent key rather than
 * an in-memory timer, so a restart neither delays nor duplicates it and a
 * missed brief catches up at the first tick after the service returns.
 * "Local" is the process TZ — exactly what the retired quiet-hours gate read
 * via `Date#getHours`.
 */

export const BRIEF_HOUR = 7;
export const BRIEF_MINUTE = 30;

/** The local wall-clock parts the due predicate needs. */
export interface LocalParts {
  hour: number;
  minute: number;
  /** Local calendar date as `YYYY-MM-DD` (lexicographically ordered). */
  dateKey: string;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
}

export function localParts(epochMs: number): LocalParts {
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    hour: d.getHours(),
    minute: d.getMinutes(),
    dateKey: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    weekday: d.getDay(),
  };
}

/**
 * True iff local time is at or past 07:30 AND the local calendar date of
 * `lastSentAt` is before today's (or there is no `lastSentAt`).
 */
export function briefDue(now: LocalParts, lastSentAt: number | null): boolean {
  const pastTime = now.hour > BRIEF_HOUR || (now.hour === BRIEF_HOUR && now.minute >= BRIEF_MINUTE);
  if (!pastTime) return false;
  if (lastSentAt === null) return true;
  return localParts(lastSentAt).dateKey < now.dateKey;
}
