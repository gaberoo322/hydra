#!/usr/bin/env -S npx tsx
/**
 * Lifecycle-Seam check — direct state-label write ratchet (ADR-0047 D3/D7,
 * issue #5311).
 *
 * Issue lifecycle state labels (`ready-for-agent`, `in-progress`, `needs-qa`,
 * ...) are written through ONE seam: `scripts/lifecycle.ts` over
 * `src/lifecycle/`. Prose discipline alone does not keep that seam closed (the
 * Redis / GitHub / Schema seams proved it), so this is the blocking backstop:
 * it flags
 *
 *   1. a playbook / fragment under `docs/operator-playbooks/` that instructs a
 *      direct state-label write — `gh issue|pr edit ... --add-label|--remove-label
 *      <state>` or a `gh api .../labels` call naming a state; and
 *   2. a `src/` file OUTSIDE `src/lifecycle/` that passes a state label to
 *      `addIssueLabel` / `removeIssueLabel` / `editIssueLabels`.
 *
 * State names come from `src/lifecycle/` (`OPEN_STATES`), never a copy. Today's
 * violators are frozen in `test/fixtures/lifecycle-seam-baseline.json`; the
 * ratchet is shrink-only (enforced by `test/lifecycle-seam-check.test.mts`,
 * which runs in the required `test` job). To shrink after migrating a caller:
 *
 *   npx tsx scripts/ci/lifecycle-seam-check.ts --write-baseline
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { OPEN_STATES } from "../../src/lifecycle/index.ts";
import {
  REPO_ROOT,
  diffBaseline,
  listTrackedFiles,
  loadBaseline,
  isCliEntrypoint,
  runAsCli,
  stripComments,
  type SeamCheckConfig,
} from "./seam-check-lib.ts";

export const LIFECYCLE_SEAM_BASELINE_PATH = join(
  REPO_ROOT,
  "test/fixtures/lifecycle-seam-baseline.json",
);

const PLAYBOOK_PREFIX = "docs/operator-playbooks/";
const LIFECYCLE_DIR_PREFIX = "src/lifecycle/";
const STATE_SET: ReadonlySet<string> = new Set(OPEN_STATES);
const WRITER_NAMES = ["addIssueLabel", "removeIssueLabel", "editIssueLabels"];

function hasStateName(text: string): boolean {
  for (const tok of text.split(/[^A-Za-z0-9_-]+/)) {
    if (STATE_SET.has(tok)) return true;
  }
  return false;
}

/** Playbook arm: a `gh issue|pr edit` label flag or `gh api .../labels` naming a state. */
export function playbookWritesStateLabel(body: string): boolean {
  // Join backslash-continued shell lines into one logical command.
  const logical = body.replace(/\\\r?\n\s*/g, " ").split(/\r?\n/);
  for (const line of logical) {
    if (/\bgh\s+(?:issue|pr)\s+edit\b/.test(line)) {
      const flag = /--(?:add|remove)-label(?:\s+|=)(?:"([^"]*)"|'([^']*)'|(\S+))/g;
      for (const m of line.matchAll(flag)) {
        if (hasStateName(m[1] ?? m[2] ?? m[3] ?? "")) return true;
      }
    }
    if (
      /\bgh\s+api\b/.test(line) &&
      /\/labels\b|labels\[\]|-f\s+labels/.test(line) &&
      hasStateName(line)
    ) {
      return true;
    }
  }
  return false;
}

/** Index of the paren closing the one opened at `open`, or -1. */
function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/** Source arm: a call to a label writer outside `src/lifecycle/` carrying a state label. */
export function sourceWritesStateLabel(body: string): boolean {
  const src = stripComments(body);
  // Same-file `const X = "state"` aliases, so `addIssueLabel(n, X)` is caught.
  const aliases = new Set<string>();
  for (const m of src.matchAll(
    /\bconst\s+([A-Za-z_$][\w$]*)(?:\s*:\s*[^=]+)?\s*=\s*["'`]([^"'`]+)["'`]/g,
  )) {
    if (STATE_SET.has(m[2]!)) aliases.add(m[1]!);
  }
  const callRe = new RegExp(`\\b(?:${WRITER_NAMES.join("|")})\\s*\\(`, "g");
  for (const m of src.matchAll(callRe)) {
    const open = m.index! + m[0].length - 1;
    const close = matchParen(src, open);
    const args = src.slice(open + 1, close === -1 ? undefined : close);
    for (const lit of args.matchAll(/["'`]([^"'`]+)["'`]/g)) {
      if (STATE_SET.has(lit[1]!)) return true;
    }
    for (const id of args.split(/[^A-Za-z0-9_$]+/)) {
      if (id && aliases.has(id)) return true;
    }
  }
  return false;
}

/** Pure per-file predicate shared by the CLI and the regression test. */
export function fileViolatesLifecycleSeam(relPath: string, body: string): boolean {
  if (relPath.startsWith(PLAYBOOK_PREFIX)) return playbookWritesStateLabel(body);
  if (relPath.startsWith("src/") && !relPath.startsWith(LIFECYCLE_DIR_PREFIX)) {
    return sourceWritesStateLabel(body);
  }
  return false;
}

export const LIFECYCLE_SEAM_CONFIG: SeamCheckConfig = {
  name: "lifecycle-seam-check",
  globs: [
    "src/*.ts",
    "src/**/*.ts",
    "docs/operator-playbooks/*.md",
    "docs/operator-playbooks/**/*.md",
  ],
  predicate: fileViolatesLifecycleSeam,
  baselinePath: LIFECYCLE_SEAM_BASELINE_PATH,
  noteSuffix: "Lifecycle seam ratchet (ADR-0047, issue #5311): shrink only.",
  newViolationsHeadline: "NEW direct state-label writes (ADR-0047 lifecycle seam):",
  newViolationsHelp: [
    "These files write an issue lifecycle state label directly.",
    "Route the transition through the lifecycle seam: `scripts/lifecycle.ts`",
    "(over src/lifecycle/) — never `gh issue edit --add-label/--remove-label <state>`",
    "or addIssueLabel/editIssueLabels with a state label outside src/lifecycle/.",
  ],
};

/** Scan the tracked tree and return the sorted violating paths. */
export async function findLifecycleSeamViolations(): Promise<string[]> {
  const out: string[] = [];
  for (const rel of await listTrackedFiles(LIFECYCLE_SEAM_CONFIG.globs)) {
    let body: string;
    try {
      body = await readFile(join(REPO_ROOT, rel), "utf8");
    } catch (err) {
      console.warn(`[lifecycle-seam-check] unreadable ${rel}, skipped:`, err);
      continue;
    }
    if (fileViolatesLifecycleSeam(rel, body)) out.push(rel);
  }
  return out.sort();
}

/** Shrink-only verdict: failure messages (empty = ratchet holds). */
export async function lifecycleSeamFailures(violations: string[]): Promise<string[]> {
  const { newViolations, fixedCallers } = diffBaseline(
    violations,
    await loadBaseline(LIFECYCLE_SEAM_BASELINE_PATH),
  );
  const msgs: string[] = [];
  if (newViolations.length > 0) {
    msgs.push(
      `${LIFECYCLE_SEAM_CONFIG.newViolationsHeadline} ${newViolations.join(", ")}. ` +
        "Write lifecycle state labels through scripts/lifecycle.ts, not directly.",
    );
  }
  if (fixedCallers.length > 0) {
    msgs.push(
      `Baseline is stale; these no longer violate: ${fixedCallers.join(", ")}. ` +
        "Shrink it: npx tsx scripts/ci/lifecycle-seam-check.ts --write-baseline",
    );
  }
  return msgs;
}

if (isCliEntrypoint(import.meta.url)) {
  runAsCli(LIFECYCLE_SEAM_CONFIG);
}
