/**
 * ov-upload.ts — low-level OpenViking upload primitives + add-resource retry
 * policy (extracted from indexer.ts, issue #3044).
 *
 * This module owns the pure "push a text blob into OpenViking" concern that was
 * previously interleaved with the domain-orchestration surface (HashDedupAdapter
 * + source-file indexer + freshness probe) inside the 838-line indexer.ts
 * (consolidated in #2354, then progressively split in #2767 / #2850). It answers
 * a single question with NO Redis dependency and NO domain knowledge of WHICH
 * files to upload or WHEN:
 *
 *   Given a title + content blob, upload it as a temp file and register it as a
 *   `hydra-memory` resource — retrying ONLY the transient OV failures.
 *
 * The one non-trivial concern living here is the add-resource retry policy
 * (issue #2658 / #2250 / #1828): a bounded client-side exponential-backoff-WITH-
 * jitter loop around the `/api/v1/resources` add-resource POST that retries only
 * transient contention (transport/timeout codes, OV server-timeout body, OV
 * point-lock body) and surfaces a genuine rejection on attempt 1. This is the
 * site any future retry/timeout tuning lands, and its test surface
 * (`test/indexer-point-lock-retry.test.mts`) exercises exactly this file.
 *
 * Dependency lane (issue #3044, INV): this leaf imports ONLY from
 *   - `ov-request.ts` — the OpenViking Request Adapter Seam (URL join, auth
 *     headers, timeout, non-2xx/transport classification, JSON/text unwrap),
 *   - `indexer-stats.ts` — the intra-subsystem observability counters (a true
 *     dependency leaf that imports nothing; NOT Redis, NOT domain state),
 *   - Node stdlib (`node:fs/promises`, `node:os`, `node:path`).
 * Zero Redis, zero source-tree enumeration, zero coverage state. `indexer.ts`
 * imports these primitives back and re-exports them so all existing callers
 * (indexer-lifecycle.ts, learning-lifecycle.ts, tests) keep a zero-diff import
 * specifier. Dependency flows ov-upload <- indexer, never the reverse (no
 * circular import).
 *
 * History references preserved from the original indexer.ts Section 1 (#954,
 * #313, #318, #2658, #2250, #1828).
 */

import { writeFile, unlink } from "node:fs/promises";
import { join, sep as pathSep } from "node:path";
import { tmpdir } from "node:os";

// Issue #954: OV HTTP requests route through the OpenViking Request Adapter,
// which owns the URL join + auth headers + timeout + error classification +
// JSON/text unwrap. This module keeps its #313 temp_path unwrap and the
// multipart upload shape — pure domain-free behaviour layered on the transport.
import {
  ovPostJson,
  ovPostForm,
  isOvFailure,
  isOvServerTimeout,
  isOvPointLockConflict,
} from "./ov-request.ts";
import type { OvErrorCode } from "./ov-request.ts";
import { recordIndexerError, recordIndexerRetry } from "./indexer-stats.ts";

// ---------------------------------------------------------------------------
// Add-resource retry policy (issue #2658)
// ---------------------------------------------------------------------------
//
// Under concurrent semantic-indexing writes (startup / large-recompile bursts)
// OpenViking's lock manager cannot grant the point lock on the `hydra-memory`
// resource collection and 500s with an INTERNAL/"Failed to acquire point lock"
// body — a TRANSIENT contention condition on a HEALTHY container, not a payload
// rejection. Before #2658 `indexText` gave up on the first such failure, leaving
// stale embeddings silently (the grounding phase then misses context).
//
// We now wrap the `/api/v1/resources` add-resource POST in a bounded client-side
// exponential-backoff-WITH-JITTER retry loop, reusing the skill-registration.ts
// (#1828/#2250) retry idiom — NOT a global write-path mutex (throughput collapse,
// no cross-process help) and NOT a durable queue (over-engineering for ~6
// best-effort failures/hour). Jitter decorrelates a bulk-index burst so the
// whole burst does not retry in lockstep and re-collide on the same point lock
// (thundering-herd avoidance — the one deliberate deviation from the fixed-set
// skill-registration precedent).
//
// The #1828 do-not-mask guard is preserved: only the transient transport/timeout
// codes, an OV server-side-timeout body, OR an OV point-lock body are retried; a
// genuine 4xx/5xx, UNAUTHENTICATED, or malformed-JSON stays non-retryable and
// surfaces on attempt 1.

/** Per-attempt add-resource timeout (mirrors the historical 60s add-resource budget). */
const ADD_RESOURCE_TIMEOUT_MS = 60_000;

/** Max attempts for the add-resource POST (1 initial + retries). */
const ADD_RESOURCE_MAX_ATTEMPTS = 4;

/** Base backoff between attempts; doubles each retry (250ms, 500ms, 1s, …). */
const ADD_RESOURCE_BACKOFF_BASE_MS = 250;

/**
 * Only the transient transport/timeout codes are retryable on `code` alone (same
 * as skill-registration). An `ov-non-2xx` is layered on top via the body
 * classifiers (server-timeout / point-lock) so a real payload rejection stays
 * non-retryable and surfaces on attempt 1 (#1828 do-not-mask guard).
 */
const RETRYABLE_OV_CODES: ReadonlySet<OvErrorCode> = new Set<OvErrorCode>([
  "ov-timeout",
  "ov-service-down",
]);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Tunables for {@link indexText}'s add-resource retry loop. Production calls
 * `indexText` argument-free (the constants above apply); tests pass a tiny
 * `backoffBaseMs` (and a deterministic `jitter`) so the retry path is exercised
 * without real second-long sleeps or nondeterministic timing.
 */
export interface IndexTextOptions {
  /** Base backoff in ms (doubles each retry). Defaults to {@link ADD_RESOURCE_BACKOFF_BASE_MS}. */
  backoffBaseMs?: number;
  /** Max attempts for the add-resource POST. Defaults to {@link ADD_RESOURCE_MAX_ATTEMPTS}. */
  maxAttempts?: number;
  /**
   * Jitter source in [0,1). Defaults to `Math.random`. Injected by tests to make
   * the backoff deterministic. Multiplied into the computed backoff so a bulk
   * burst decorrelates its retries (thundering-herd avoidance).
   */
  jitter?: () => number;
}

/**
 * Is this add-resource failure worth retrying? True for the transient transport/
 * timeout codes, OR an `ov-non-2xx` whose BODY is OV's own server-side-timeout
 * (#2250) or point-lock-contention (#2658) shape — both transient load
 * conditions, not payload rejections. Every other non-2xx (a real 4xx/5xx,
 * UNAUTHENTICATED, malformed JSON) stays non-retryable, preserving the #1828
 * do-not-mask guard.
 */
function isRetryableAddResource(result: { ok: false; code: OvErrorCode; body?: string }): boolean {
  if (RETRYABLE_OV_CODES.has(result.code)) return true;
  if (result.code !== "ov-non-2xx") return false;
  return isOvServerTimeout(result.body) || isOvPointLockConflict(result.body);
}

// ===========================================================================
// OV upload helpers.
//
// Low-level fetch helpers used by both the config-file watcher and the
// source-file indexer to push content into OpenViking. Pure HTTP — no state
// beyond the per-file dedup map owned by HashDedupAdapter (which lives in
// indexer.ts and composes these primitives), no Redis.
// ===========================================================================

// Translate a config-relative path into the OV virtual-fs URI under
// viking://resources. Without an explicit `to:` target, OV defaults the
// destination to a top-level basename — stripping the directory prefix
// and the file extension — which both clobbers nested layout and
// conflicts with prior orphan entries on every subsequent re-index.
export function indexerTargetUri(rel: string): string {
  return `viking://resources/${rel.split(pathSep).join("/")}`;
}

/**
 * Index an arbitrary text blob by uploading it as a temp file then
 * registering it as a hydra-memory resource. Used for Redis-derived
 * content (reality reports, memory patterns) and source-file payloads.
 */
export async function indexText(
  title: string,
  content: string,
  opts: IndexTextOptions = {},
): Promise<void> {
  const safeName = title.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  const tmpFile = join(tmpdir(), `hydra-indexer-${safeName}-${Date.now()}.md`);
  try {
    await writeFile(tmpFile, `# ${title}\n\n${content}`, "utf-8");

    const { readFile: rf } = await import("node:fs/promises");
    const fileContent = await rf(tmpFile);
    const formData = new FormData();
    formData.append(
      "file",
      new Blob([fileContent], { type: "text/markdown" }),
      `${safeName}.md`
    );

    // Multipart upload through the adapter (drops the JSON Content-Type so
    // FormData sets its own boundary; keeps X-Api-Key; 30000ms timeout).
    const uploadResult = await ovPostForm<any>(
      "/api/v1/resources/temp_upload",
      formData,
      { timeout: 30000 },
    );

    if (!isOvFailure(uploadResult)) {
      // OpenViking wraps responses as {status, result, error, telemetry}.
      // The temp_upload endpoint returns the path under `result.temp_path` —
      // older code read `uploadData.temp_path` directly and silently no-op'd
      // on every call (issue #313 in src/redis/work-queue.ts; same bug here
      // per #318). Read both wrapped and legacy unwrapped shapes for safety.
      const uploadData = uploadResult.data;
      const result = uploadData?.result ?? {};
      const tempPath =
        result.temp_path ?? result.path ?? uploadData.temp_path ?? uploadData.path;

      if (tempPath) {
        // Bounded exponential-backoff-with-jitter retry (issue #2658). Retries
        // ONLY transient failures (transport/timeout codes, or an ov-non-2xx
        // whose body is OV's server-timeout / point-lock shape); a genuine
        // rejection surfaces on attempt 1. Jitter decorrelates a bulk-index
        // burst so it does not re-collide on the same OV point lock.
        const backoffBaseMs = opts.backoffBaseMs ?? ADD_RESOURCE_BACKOFF_BASE_MS;
        const maxAttempts = opts.maxAttempts ?? ADD_RESOURCE_MAX_ATTEMPTS;
        const jitter = opts.jitter ?? Math.random;

        let addSucceeded = false;
        let lastFailure: { code: OvErrorCode; body?: string } | null = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          const addResult = await ovPostJson(
            "/api/v1/resources",
            {
              temp_path: tempPath,
              to: `viking://resources/hydra-memory/${safeName}`,
            },
            { timeout: ADD_RESOURCE_TIMEOUT_MS },
          );
          if (!isOvFailure(addResult)) {
            console.log(`[Learning:Indexer] Indexed text: ${title}`);
            addSucceeded = true;
            break;
          }
          // `isOvFailure` narrows away the optional `body`, so read the failure
          // arm explicitly (present only on ov-non-2xx; undefined otherwise).
          const failure = addResult as { ok: false; code: OvErrorCode; body?: string };
          lastFailure = { code: failure.code, body: failure.body };

          const lastAttempt = attempt === maxAttempts;
          if (!isRetryableAddResource(failure) || lastAttempt) {
            const retryable = isRetryableAddResource(failure);
            // Fail loud (CLAUDE.md): a give-up stays an error line, now naming the
            // attempt budget so an exhausted transient failure is legible.
            console.error(
              `[Learning:Indexer] Failed to add text "${title}": ${failure.code} body=${(failure.body ?? "").slice(
                0,
                200
              )}` + (retryable ? ` (gave up after ${attempt} attempts)` : "")
            );
            break;
          }

          // Exponential backoff WITH jitter before the next attempt. The jitter
          // factor in [0.5, 1.0) decorrelates a lockstep bulk-index burst.
          const base = backoffBaseMs * 2 ** (attempt - 1);
          const backoff = Math.round(base * (0.5 + jitter() * 0.5));
          recordIndexerRetry();
          console.warn(
            `[Learning:Indexer] Transient OV conflict adding "${title}": ${failure.code} — ` +
              `retrying in ${backoff}ms (attempt ${attempt}/${maxAttempts})`
          );
          await sleep(backoff);
        }
        if (!addSucceeded) {
          // Surface the exhausted/non-retryable failure UPSTREAM (issue #2658)
          // so the autopilot can gate on semantic-indexing health instead of it
          // being invisible in a console.error. Best-effort — the counter bump
          // never throws into this best-effort indexing path.
          recordIndexerError();
          void lastFailure; // captured for the logged give-up above
        }
      } else {
        // Fail loud (CLAUDE.md convention): log the full response body so a
        // future API shape change is debuggable from logs alone.
        console.error(
          `[Learning:Indexer] indexText "${title}": no temp_path in upload response — body=${JSON.stringify(
            uploadData
          ).slice(0, 300)}`
        );
      }
    } else {
      console.error(
        `[Learning:Indexer] Failed to upload text "${title}": ${uploadResult.code} body=${(uploadResult.body ?? "").slice(
          0,
          200
        )}`
      );
    }
  } catch (err: any) {
    console.error(
      `[Learning:Indexer] Failed to index text "${title}": ${err.message}`
    );
  } finally {
    await unlink(tmpFile).catch(() => {
      /* intentional: best-effort temp file cleanup */
    });
  }
}
