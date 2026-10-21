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
 * #1959) and the **OAuth Usage Adapter** (`src/cost/oauth-usage.ts`, issue
 * #1083) — all over `fetch()`. (The FOURTH Seam, the OpenViking Request
 * Adapter, was the fetch()-Seam precedent; retired with the knowledge plane,
 * ADR-0033. The ordinals are historical and are not renumbered.)
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
 * ADR-0045 Decision 2 (issue #5046) widened the scan from `src/**\/*.ts` to
 * `src/`, `scripts/` (TypeScript AND shell) and the tracked systemd units,
 * and the predicate from "a `fetch(` naming the host" to "the host on any
 * NON-COMMENT line": bash and systemd callers must go through the Operator
 * Channel CLI (`scripts/operator-notify.ts`), so a `curl` to the Bot API is
 * exactly as much a violation as a `fetch`. Comments never count (TypeScript
 * is comment-stripped first; a `.sh` / `.service` / `.timer` line whose first
 * non-blank character is `#` is ignored). Two carve-outs only: the transport
 * (`src/notify.ts`) and this file (it carries the literal as its own signal).
 *
 * Usage:
 *   npx tsx scripts/ci/telegram-seam-check.ts
 *   npm run telegram-seam-check
 *
 * Update flow when intentionally migrating a caller behind the adapter:
 *   1. Remove the raw Telegram call; TypeScript routes through the Operator
 *      Channel (src/operator-channel/), bash and systemd through
 *      scripts/operator-notify.ts.
 *   2. Run with `--write-baseline` to regenerate the baseline file.
 *   3. Commit the smaller baseline alongside the migration.
 */

import { join } from "node:path";
import { REPO_ROOT, isCliEntrypoint, runAsCli, stripComments } from "./seam-check-lib.ts";

const BASELINE_PATH = join(REPO_ROOT, "scripts/ci/telegram-seam-baseline.json");

/** The Telegram Notification Adapter Module itself — IS the seam (exempt). */
const TELEGRAM_NOTIFY_MODULE = "src/notify.ts";

/** This check — carries the host literal as its own detection signal (exempt). */
const TELEGRAM_SEAM_CHECK_SELF = "scripts/ci/telegram-seam-check.ts";

/**
 * Unambiguous "this targets the Telegram Bot API" signals. Kept narrow on
 * purpose so unrelated calls (Anthropic, OpenViking, OAuth-usage, health
 * probes) do NOT trip the ratchet — they are not the Telegram Bot API boundary.
 */
const TELEGRAM_TARGET_SIGNALS = [
  "api.telegram.org", // the Telegram Bot API host
];

/** The scanned surface: src/, scripts/ (ts + sh) and the tracked systemd units. */
export const TELEGRAM_SEAM_GLOBS: readonly string[] = [
  "src/*.ts",
  "src/**/*.ts",
  "scripts/*.ts",
  "scripts/**/*.ts",
  "scripts/*.sh",
  "scripts/**/*.sh",
  "scripts/systemd/*",
];

/** Non-comment lines of a shell script or systemd unit (leading-`#` lines dropped). */
function shellCodeLines(body: string): string[] {
  return body.split("\n").filter((line) => !/^\s*#/.test(line));
}

/**
 * Pure predicate: does `body` (the file contents at repo-relative `relPath`)
 * name the Telegram Bot API host on a non-comment line, in violation of the
 * Telegram Notification Adapter Seam? Exported so the regression test can pin
 * the grammar without shelling out to git. `relPath` decides the carve-out and
 * the comment grammar (`.ts` → stripComments; anything else → leading-`#`).
 */
export function fileViolatesTelegramSeam(relPath: string, body: string): boolean {
  if (relPath === TELEGRAM_NOTIFY_MODULE || relPath === TELEGRAM_SEAM_CHECK_SELF) return false;
  const lines = relPath.endsWith(".ts") ? stripComments(body).split("\n") : shellCodeLines(body);
  for (const line of lines) {
    if (TELEGRAM_TARGET_SIGNALS.some((sig) => line.includes(sig))) return true;
  }
  return false;
}

const CONFIG = {
  name: "telegram-seam-check",
  globs: [...TELEGRAM_SEAM_GLOBS],
  predicate: fileViolatesTelegramSeam,
  baselinePath: BASELINE_PATH,
  noteSuffix:
    "Telegram Notification Adapter closure ratchet (issue #2201; widened to scripts/ + systemd units by ADR-0045 D2, issue #5046): shrink only.",
  newViolationsHeadline:
    "NEW telegram-seam violations (Telegram Notification Adapter / Operator Channel, ADR-0045 D2):",
  newViolationsHelp: [
    "These files name the Telegram Bot API host outside the Operator Channel.",
    "TypeScript: import src/operator-channel/ (operatorChannel.page / brief) —",
    "the transport in src/notify.ts owns the one fetch. Bash and systemd units:",
    "call scripts/operator-notify.ts (page / resolve / brief / service-failed).",
  ],
};

// Only run as a CLI — importing the module (e.g. from the regression test)
// must not trigger the git scan or process.exit.
if (isCliEntrypoint(import.meta.url)) {
  runAsCli(CONFIG);
}
