#!/usr/bin/env -S npx tsx
/**
 * Telegram-Seam check — Operator Channel transport closure ratchet (issue
 * #2201; ADR-0045 Decision 2, issues #5046 / #5049).
 *
 * The **Operator Channel** transport (`src/operator-channel/transport.ts`)
 * owns the Telegram Bot API request boundary: the base URL
 * (`https://api.telegram.org/bot<token>/`), the credential resolution (via the
 * single loader in `src/operator-channel/credentials.ts`), the Bot API error
 * modes (token absent, non-200 response, entity-parse 400 with the plain-text
 * resend, network failure) and the JSON wire shape (`chat_id` / `text` /
 * `parse_mode`) — all behind one `fetch` primitive exposed as
 * `sendHtmlToTelegram` / `createTelegramTransport`. Its callers — the channel
 * (`channel.ts`), the Morning Brief (`brief.ts`) and, through them, the
 * notification consumer, the watchdog and the systemd `OnFailure` units via
 * `scripts/operator-notify.ts` — inject or import that transport and know
 * nothing of the URL, the auth, or the wire shape. It is the SEVENTH boundary
 * Seam, a SIBLING to the **Anthropic Request Adapter** (`src/anthropic/request.ts`,
 * issue #1959) and the **OAuth Usage Adapter** (`src/cost/oauth-usage.ts`,
 * issue #1083) — all over `fetch()`. (The FOURTH Seam, the OpenViking Request
 * Adapter, was the fetch()-Seam precedent; retired with the knowledge plane,
 * ADR-0033. The ordinals are historical and are not renumbered.)
 *
 * This is the CI backstop that freezes the drift, exactly as
 * `anthropic-seam-check.ts` (issue #1959) / `openviking-seam-check.ts` (#954) /
 * `host-probe-seam-check.ts` (#939) / `github-seam-check.ts` (#899) /
 * `redis-seam-check.ts` (ADR-0009) do for their boundaries: it forbids the
 * Telegram Bot API host on any non-comment line of any file outside the
 * transport, enforced via a shrink-only baseline ratchet. With it in place,
 * every Telegram Bot API request in the repo is owned by the one transport.
 *
 * A violation is detected as the unambiguous Telegram signal — the Bot API
 * host (`api.telegram.org`) — on a NON-COMMENT line.
 *
 * This is a thin Adapter over the shared baseline-ratchet engine in
 * `seam-check-lib.ts` (issue #950) and runs as a sequential step in the
 * consolidated `.github/workflows/seam-checks.yml` (issue #1654), NOT inside
 * `ci.yml`: `ci.yml` is exact-match Verifier Core (Tier-4); a sibling step keeps
 * this PR Tier-3 and auto-mergeable, mirroring the anthropic-seam precedent.
 *
 * ADR-0045 Decision 2 (issue #5046) widened the scan from `src/**\/*.ts` to
 * `src/`, `scripts/` (TypeScript, shell, Python, mjs) and the tracked systemd
 * units, and the predicate from "a `fetch(` naming the host" to "the host on
 * any NON-COMMENT line": bash and systemd callers must go through the Operator
 * Channel CLI (`scripts/operator-notify.ts`), so a `curl` to the Bot API is
 * exactly as much a violation as a `fetch`. Comments never count (TypeScript
 * is comment-stripped first; a `.sh` / `.py` / `.service` / `.timer` line
 * whose first non-blank character is `#` is ignored).
 *
 * Issue #5049 shrank the exemption list to ONE entry — the transport. This
 * check no longer exempts itself: it assembles the host signal from parts
 * (`TELEGRAM_HOST` below) so its own source never carries the literal on a
 * code line, and the retired `src/notify.ts` carve-out went with the file.
 *
 * Usage:
 *   npx tsx scripts/ci/telegram-seam-check.ts
 *   npm run telegram-seam-check
 *
 * Update flow when intentionally migrating a caller behind the transport:
 *   1. Remove the raw Telegram call; TypeScript routes through the Operator
 *      Channel (src/operator-channel/), bash and systemd through
 *      scripts/operator-notify.ts.
 *   2. Run with `--write-baseline` to regenerate the baseline file.
 *   3. Commit the smaller baseline alongside the migration.
 */

import { join } from "node:path";
import { REPO_ROOT, isCliEntrypoint, runAsCli, stripComments } from "./seam-check-lib.ts";

const BASELINE_PATH = join(REPO_ROOT, "scripts/ci/telegram-seam-baseline.json");

/**
 * The ONLY file allowed to name the Telegram Bot API host on a code line:
 * the Operator Channel's transport, which owns the one `fetch` (ADR-0045
 * Decision 2). Kept as a single-element list so the exemption surface is
 * visibly one path — widening it is a deliberate, reviewable edit.
 */
export const TELEGRAM_SEAM_EXEMPT: readonly string[] = ["src/operator-channel/transport.ts"];

/**
 * The Telegram Bot API host — the unambiguous "this targets the Bot API"
 * signal. Assembled from parts so this file never carries the literal on a
 * code line and therefore needs no self carve-out (issue #5049). Kept narrow
 * on purpose so unrelated calls (Anthropic, OAuth-usage, health probes) do
 * NOT trip the ratchet — they are not the Telegram Bot API boundary.
 */
const TELEGRAM_HOST = ["api", "telegram", "org"].join(".");

const TELEGRAM_TARGET_SIGNALS = [TELEGRAM_HOST];

/** The scanned surface: src/, scripts/ (ts, mjs, sh, py) and the tracked systemd units. */
export const TELEGRAM_SEAM_GLOBS: readonly string[] = [
  "src/*.ts",
  "src/**/*.ts",
  "scripts/*.ts",
  "scripts/**/*.ts",
  "scripts/*.sh",
  "scripts/**/*.sh",
  "scripts/*.py",
  "scripts/**/*.py",
  "scripts/*.mjs",
  "scripts/**/*.mjs",
  "scripts/systemd/*",
];

/** Non-comment lines of a shell / Python script or systemd unit (leading-`#` lines dropped). */
function shellCodeLines(body: string): string[] {
  return body.split("\n").filter((line) => !/^\s*#/.test(line));
}

/**
 * Pure predicate: does `body` (the file contents at repo-relative `relPath`)
 * name the Telegram Bot API host on a non-comment line, in violation of the
 * Operator Channel transport Seam? Exported so the regression test can pin
 * the grammar without shelling out to git. `relPath` decides the carve-out and
 * the comment grammar (`.ts` / `.mjs` → stripComments; anything else → leading-`#`).
 */
export function fileViolatesTelegramSeam(relPath: string, body: string): boolean {
  if (TELEGRAM_SEAM_EXEMPT.includes(relPath)) return false;
  const lines = /\.(ts|mjs)$/.test(relPath) ? stripComments(body).split("\n") : shellCodeLines(body);
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
    "Operator Channel transport closure ratchet (issue #2201; widened to scripts/ + systemd units by ADR-0045 D2, issue #5046; single exemption src/operator-channel/transport.ts since issue #5049): shrink only.",
  newViolationsHeadline:
    "NEW telegram-seam violations (Operator Channel transport, ADR-0045 D2):",
  newViolationsHelp: [
    "These files name the Telegram Bot API host outside the Operator Channel.",
    "TypeScript: import src/operator-channel/ (operatorChannel.page / brief) —",
    "the transport in src/operator-channel/transport.ts owns the one fetch.",
    "Bash and systemd units: call scripts/operator-notify.ts",
    "(page / resolve / brief / service-failed).",
  ],
};

// Only run as a CLI — importing the module (e.g. from the regression test)
// must not trigger the git scan or process.exit.
if (isCliEntrypoint(import.meta.url)) {
  runAsCli(CONFIG);
}
