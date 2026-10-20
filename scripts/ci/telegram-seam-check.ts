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
 * Widened by issue #5046 (ADR-0045 Decision 6) to also scan `scripts/` (TS and
 * shell) and `scripts/systemd/*`, and from "a fetch() line" to "any non-comment
 * mention of the Bot API host".
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
import { REPO_ROOT, isCliEntrypoint, runAsCli, stripComments } from "./seam-check-lib.ts";

const BASELINE_PATH = join(REPO_ROOT, "scripts/ci/telegram-seam-baseline.json");

/**
 * Files exempt from the closure: the seam itself (its `fetch` IS the one owned
 * call) and this check (its own signal literal).
 */
const CARVE_OUTS = new Set(["src/notify.ts", "scripts/ci/telegram-seam-check.ts"]);

/** The Telegram Bot API host — the unambiguous "talks to Telegram" signal. */
const TELEGRAM_HOST = "api.telegram.org";

/**
 * Pure predicate: does `body` (the file at repo-relative `relPath`) reference
 * the Telegram Bot API host on a non-comment line? Widened by issue #5046 from
 * "a `fetch(` on a src/ line" to ANY non-comment mention across src/, scripts/
 * and systemd units, so a bash `curl` or a unit `ExecStart=` cannot become a
 * second sender: the Operator Channel (via `src/notify.ts`) is the only code
 * that may talk to the Bot API. TS files are comment-stripped; `.sh` /
 * `.service` / `.timer` lines whose first non-blank character is `#` are ignored.
 */
export function fileViolatesTelegramSeam(relPath: string, body: string): boolean {
  if (CARVE_OUTS.has(relPath)) return false;
  if (/\.m?ts$/.test(relPath)) return stripComments(body).includes(TELEGRAM_HOST);
  return body.split("\n").some((line) => !/^\s*#/.test(line) && line.includes(TELEGRAM_HOST));
}

const CONFIG = {
  name: "telegram-seam-check",
  globs: [
    "src/*.ts",
    "src/**/*.ts",
    "scripts/*.ts",
    "scripts/**/*.ts",
    "scripts/*.sh",
    "scripts/**/*.sh",
    "scripts/systemd/*",
  ],
  predicate: fileViolatesTelegramSeam,
  baselinePath: BASELINE_PATH,
  noteSuffix:
    "Telegram Notification Adapter closure ratchet (issue #2201): shrink only.",
  newViolationsHeadline:
    "NEW telegram-seam violations (Telegram Notification Adapter, issue #2201):",
  newViolationsHelp: [
    "These files reference the Telegram Bot API outside the Telegram",
    "Notification Adapter. From bash/systemd use scripts/operator-notify.ts;",
    "from src/ route the message through the seam:",
    "sendToTelegram / sendNotification (src/notify.ts), injecting the sender",
    "as a dep where the caller already takes one (e.g. DigestAccumulatorDeps.send).",
  ],
};

// Only run as a CLI — importing the module (e.g. from the regression test)
// must not trigger the git scan or process.exit.
if (isCliEntrypoint(import.meta.url)) {
  runAsCli(CONFIG);
}
