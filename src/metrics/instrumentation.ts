// ---------------------------------------------------------------------------
// Hot-path timing instrumentation (issue #2353).
// ---------------------------------------------------------------------------
//
// A zero-cost-when-disabled timing helper for the orchestrator's decision-loop
// hot paths (candidate-feed selection, lane transitions, …). The design
// contract (design-concept for issue #2353) pins these invariants:
//
//   - Zero-cost when disabled: with HYDRA_PERF_INSTRUMENT unset/falsy,
//     `time(label, fn)` calls `fn()` directly — no `performance.now()` reads,
//     no ring-buffer writes — so the default production hot path pays nothing.
//   - Transparent wrapping: `time(label, fn)` returns `fn()` (or its awaited
//     value) unchanged and never swallows or mutates a thrown error.
//   - No new throws on the hot path: a failure inside the timing helper itself
//     (e.g. a ring-buffer write) is swallowed-with-console.error per the
//     repo "fail loud" convention and never propagates into the wrapped path.
//   - Observability-only, no decisions (ADR-0012): this records and exposes
//     latency; it never alerts, files triage, or branches behaviour on a
//     threshold. Regression detection belongs to decide.py.
//   - In-process, not Redis: samples live in a bounded in-memory ring buffer
//     per label; nothing is written to Redis on the hot path, so measuring a
//     path never adds Redis-round-trip latency (no observer-effect inflation).
//     Process-local data resets on restart — acceptable for a trending signal.
//
// The only API surface is `GET /metrics/instrumentation` (src/api/metrics.ts),
// which reads `getInstrumentationSnapshot()`.

/**
 * Max samples retained per label. A small bounded ring keeps memory flat
 * regardless of cycle volume while still giving a stable p50/p95/p99 over a
 * recent window. ~1k * (8 bytes) per label is negligible.
 */
const RING_CAPACITY = 1000;

/** Per-label circular buffer of millisecond durations. */
interface Ring {
  /** Backing store; length grows to at most RING_CAPACITY then wraps. */
  samples: number[];
  /** Next write index (wraps modulo RING_CAPACITY once full). */
  next: number;
  /** Total observations ever recorded (monotonic; not capped by capacity). */
  total: number;
}

const rings = new Map<string, Ring>();

/**
 * Whether instrumentation is enabled. Read once at module load AND re-read on
 * each `time()` call would be wasteful; instead we read the env at call time
 * through this cheap helper so a process can flip the flag without restart in
 * tests (the env read is a single property access, not a hot-path cost beyond
 * the no-op early return it guards).
 *
 * Truthy values: "1", "true", "yes", "on" (case-insensitive). Anything else
 * (including unset) is disabled.
 */
export function isInstrumentationEnabled(): boolean {
  const raw = process.env.HYDRA_PERF_INSTRUMENT;
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Record one duration sample for `label`. Best-effort: any failure is
 * swallowed-with-console.error so a metrics bug can never break a hot path.
 */
function record(label: string, durationMs: number): void {
  try {
    let ring = rings.get(label);
    if (!ring) {
      ring = { samples: [], next: 0, total: 0 };
      rings.set(label, ring);
    }
    if (ring.samples.length < RING_CAPACITY) {
      ring.samples.push(durationMs);
    } else {
      ring.samples[ring.next] = durationMs;
    }
    ring.next = (ring.next + 1) % RING_CAPACITY;
    ring.total += 1;
  } catch (err: any) {
    // Fail loud, never propagate (invariant: no new throws on the hot path).
    console.error(`[instrumentation] record('${label}') failed: ${err?.message || err}`);
  }
}

/**
 * Time the execution of `fn` under `label`.
 *
 * - Disabled (HYDRA_PERF_INSTRUMENT falsy): returns `fn()` directly with zero
 *   overhead — no timing, no ring write.
 * - Enabled: measures wall-clock duration around `fn()` (awaiting a returned
 *   promise) and records it. The original return value is passed through
 *   unchanged; a thrown/rejected error is re-thrown unchanged AFTER recording
 *   the (failed-path) duration, so error timings are observable too.
 *
 * Works for both sync and async `fn` — a thenable return is awaited so the
 * recorded duration spans the full async operation.
 */
export function time<T>(label: string, fn: () => T): T {
  if (!isInstrumentationEnabled()) {
    return fn();
  }
  const start = performance.now();
  let result: T;
  try {
    result = fn();
  } catch (err) {
    record(label, performance.now() - start);
    throw err;
  }
  // Async path: await the promise so the duration spans the whole operation.
  if (result && typeof (result as any).then === "function") {
    return (result as any).then(
      (value: any) => {
        record(label, performance.now() - start);
        return value;
      },
      (err: any) => {
        record(label, performance.now() - start);
        throw err;
      },
    ) as T;
  }
  // Sync path.
  record(label, performance.now() - start);
  return result;
}

/** Percentile (linear interpolation) over an already-sorted ascending array. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return round(sorted[0]);
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return round(sorted[lo]);
  const frac = rank - lo;
  return round(sorted[lo] + (sorted[hi] - sorted[lo]) * frac);
}

/** Round to 3 decimal places (sub-millisecond resolution, no float noise). */
function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

interface LabelStats {
  label: string;
  /** Observations in the current ring window (<= RING_CAPACITY). */
  count: number;
  /** Total observations ever recorded for this label. */
  total: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
}

export interface InstrumentationSnapshot {
  enabled: boolean;
  /** Per-label percentile stats, sorted by label. */
  labels: LabelStats[];
}

/**
 * Compute a point-in-time snapshot of per-label latency percentiles. Pure
 * read — does not mutate or clear the rings. Safe to call from an API route.
 */
export function getInstrumentationSnapshot(): InstrumentationSnapshot {
  const labels: LabelStats[] = [];
  for (const [label, ring] of rings) {
    if (ring.samples.length === 0) continue;
    const sorted = [...ring.samples].sort((a, b) => a - b);
    labels.push({
      label,
      count: sorted.length,
      total: ring.total,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      min: round(sorted[0]),
      max: round(sorted[sorted.length - 1]),
    });
  }
  labels.sort((a, b) => a.label.localeCompare(b.label));
  return { enabled: isInstrumentationEnabled(), labels };
}

/**
 * Clear all recorded samples. Test-only seam — not wired to any route.
 */
export function resetInstrumentation(): void {
  rings.clear();
}
