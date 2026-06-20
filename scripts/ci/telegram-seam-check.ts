#!/usr/bin/env -S npx tsx
/**
 * Telegram-Seam check — Telegram Notification Adapter closure ratchet (issue #2201).
 *
 * The **Telegram Notification Adapter** Seam (`src/notify.ts`) owns the Telegram
 * Bot API request boundary: the base URL (`https://api.telegram.org/bot<token>/`),
 * the `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` env resolution, the Bot API error
 * modes (token absent, non-200 response, network failure), and the JSON wire shape
 * (`chat_id` / `text` / `parse_mode`) — all behind one `fetch` primitive that the
 * `sendToTelegram` / `sendNotification` Interface exposes. Its callers
 * (`notification-consumer.ts`, `digest.ts` via the `DigestAccumulatorDeps.send`
 * dep slot, the weekly-digest chore) inject or import that sender and know nothing
 * of the URL, the auth, or the wire shape. It is the SEVENTH boundary Seam, a
 * SIBLING to the **Anthropic Request Adapter** (`src/anthropic/request.ts`, issue
 * #1959) and the **OpenViking Request Adapter**
 * (`src/knowledge-base/ov-request.ts`, issue #954) — all over `fetch()`.
 *
 * This is the CI backstop that freezes the drift, exactly as
 * `anthropic-seam-check.ts` (issue #1959) / `openviking-seam-check.ts` (#954) /
 * `host-probe-seam-check.ts` (#939) / `github-seam-check.ts` (#899) /
 * `redis-seam-check.ts` (ADR-0009) do for their boundaries: it forbids a raw
 * Telegram `fetch(...)` from any file outside `src/notify.ts`, enforced via a
 * shrink-only baseline ratchet. With it in place, every Telegram Bot API request
 * in `src/` is owned by the one adapter primitive.
 *
 * A "Telegram fetch" is detected as a `fetch(...)` whose target text carries the
 * unambiguous Telegram signal — the Telegram Bot API host (`api.telegram.org`).
 *
 * This is a thin Adapter over the shared baseline-ratchet engine in
 * `seam-check-lib.ts` (issue #950) and runs as a sequential step in the
 * consolidated `.github/workflows/seam-checks.yml` (issue #1654), NOT inside
 * `ci.yml`: `ci.yml` is exact-match Verifier Core (Tier-4); a sibling step keeps
 * this PR Tier-3 and auto-mergeable, mirroring the anthropic-seam precedent.
 *
 * It deliberately scans `src/**\/*.ts` only — matching the
 * anthropic/openviking/host-probe precedent's `src/**\/*.ts`-only scan.
 *
 * Usage:
 *   npx tsx scripts/ci/telegram-seam-check.ts
 *   npm run telegram-seam-check
 *
 * Update flow when intentionally migrating a caller behind the adapter:
 *   1. Remove the raw Telegram `fetch(...)`; route it through src/notify.ts
 *      (sendToTelegram / sendNotification), injecting the sender as a dep where
 *      the caller already takes one (e.g. DigestAccumulatorDeps.send).
 *   2. Run with `--write-baseline` to regenerate the baseline file.
 *   3. Commit the smaller baseline alongside the migration.
 */

import { join } from "node:path";
import { REPO_ROOT, isCliEntrypoint, runAsCli } from "./seam-check-lib.ts";

const BASELINE_PATH = join(REPO_ROOT, "scripts/ci/telegram-seam-baseline.json");

/** The Telegram Notification Adapter Module itself — IS the seam (exempt). */
const TELEGRAM_NOTIFY_MODULE = "src/notify.ts";

/**
 * Unambiguous "this fetch targets the Telegram Bot API" signals. A `fetch(` whose
 * line contains any of these is a Telegram request. Kept narrow on purpose so
 * unrelated `fetch` calls (Anthropic, OpenViking, OAuth-usage, health probes) do
 * NOT trip the ratchet — they are not the Telegram Bot API boundary.
 */
const TELEGRAM_TARGET_SIGNALS = [
  "api.telegram.org", // the Telegram Bot API host
];

/** Matches a `fetch(` call (whitespace-tolerant). */
const FETCH_CALL = /\bfetch\s*\(/;

/**
 * Pure predicate: does `body` (the file contents at repo-relative `relPath`)
 * contain a raw Telegram `fetch(...)` in violation of the Telegram Notification
 * Adapter Seam? Exported so the regression test can pin the grammar without
 * shelling out to git. `relPath` decides the carve-out; pass a `src/...` path.
 *
 * The adapter Module itself (`src/notify.ts`) is the Seam (exempt — its `fetch`
 * IS the one owned call). A file violates when it both calls `fetch(` AND carries
 * a Telegram target signal on the same line.
 */
export function fileViolatesTelegramSeam(relPath: string, body: string): boolean {
  if (relPath === TELEGRAM_NOTIFY_MODULE) return false;
  for (const line of body.split("\n")) {
    if (!FETCH_CALL.test(line)) continue;
    if (TELEGRAM_TARGET_SIGNALS.some((sig) => line.includes(sig))) return true;
  }
  return false;
}

const CONFIG = {
  name: "telegram-seam-check",
  globs: ["src/*.ts", "src/**/*.ts"],
  predicate: fileViolatesTelegramSeam,
  baselinePath: BASELINE_PATH,
  noteSuffix:
    "Telegram Notification Adapter closure ratchet (issue #2201): shrink only.",
  newViolationsHeadline:
    "NEW telegram-seam violations (Telegram Notification Adapter, issue #2201):",
  newViolationsHelp: [
    "These files call fetch() against the Telegram Bot API outside the",
    "Telegram Notification Adapter. Route the message through the seam:",
    "sendToTelegram / sendNotification (src/notify.ts), injecting the sender",
    "as a dep where the caller already takes one (e.g. DigestAccumulatorDeps.send).",
  ],
};

// Only run as a CLI — importing the module (e.g. from the regression test)
// must not trigger the git scan or process.exit.
if (isCliEntrypoint(import.meta.url)) {
  runAsCli(CONFIG);
}
