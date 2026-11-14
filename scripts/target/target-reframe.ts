/**
 * scripts/target/target-reframe.ts — the Target build's STOP-AND-REFRAME board
 * write, owned in one place (the grounding preflights in hydra-target-build
 * Steps 3.1 / 3.2 call it instead of repeating the relabel + event block).
 *
 * Contract (ADR-0031 Decisions 4/5/6): the Target board is GitHub Issues on
 * `$TARGET_GH_REPO`, driven by labels over REST. A reframe clears the build's
 * `in-progress` claim and the `ready-for-agent` label and stamps `reframe`,
 * then publishes a `target:reframe-save` event. Both writes are fail-soft: a
 * failed `gh` or `hydra` call warns and the script still exits 0, because a
 * grounding preflight must never turn a stop into a build failure.
 *
 * The pure core (`buildReframePlan`) decides what to write; `runReframe` does
 * the two spawns, so tests drive the decision directly and the wrapper through
 * PATH stubs.
 *
 * Usage:
 *   printf '%b' "$HITS" | npx tsx scripts/target/target-reframe.ts \
 *     --repo "$TARGET_GH_REPO" --anchor "$ANCHOR_NUM" --anchor-ref "$ANCHOR_REF" \
 *     --reason "<why>" --hits-stdin
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

export interface ReframeInput {
  repo: string;
  /** The Target issue number; empty/undefined for a failing-test / priorities anchor. */
  anchorNum?: string;
  anchorRef?: string;
  reason: string;
  /** Raw hit text; newlines are flattened to `;` in the event payload. */
  hits: string;
}

export interface ReframePlan {
  /** `gh` argv for the relabel, or null when there is no board issue to relabel. */
  ghArgs: string[] | null;
  event: { type: "target:reframe-save"; payload: { anchorRef: string; reason: string; hits: string } };
}

export function buildReframePlan(input: ReframeInput): ReframePlan {
  const anchorNum = (input.anchorNum ?? "").trim();
  return {
    ghArgs: anchorNum
      ? [
          "issue", "edit", anchorNum, "--repo", input.repo,
          "--remove-label", "in-progress", "--remove-label", "ready-for-agent", "--add-label", "reframe",
        ]
      : null,
    event: {
      type: "target:reframe-save",
      payload: {
        anchorRef: input.anchorRef?.trim() || "unknown",
        reason: input.reason,
        hits: input.hits.replace(/\n/g, ";"),
      },
    },
  };
}

/** Run the plan. Never throws and never returns non-zero: every failure is a warning. */
export function runReframe(plan: ReframePlan): number {
  if (plan.ghArgs) {
    const gh = spawnSync("gh", plan.ghArgs, { encoding: "utf8" });
    if (gh.error || gh.status !== 0) {
      console.error(`warn: reframe relabel failed (non-fatal): ${gh.error?.message ?? gh.stderr?.trim() ?? ""}`);
    }
  }
  const pub = spawnSync("hydra", ["raw", "POST", "/events/publish", JSON.stringify(plan.event)], {
    encoding: "utf8",
  });
  if (pub.error || pub.status !== 0) {
    console.error(`warn: event publish failed (non-fatal): ${pub.error?.message ?? pub.stderr?.trim() ?? ""}`);
  }
  return 0;
}

export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const hits = args["hits-stdin"] === true ? readFileSync(0, "utf8") : String(args.hits ?? "");
  const plan = buildReframePlan({
    repo: String(args.repo ?? ""),
    anchorNum: typeof args.anchor === "string" ? args.anchor : "",
    anchorRef: typeof args["anchor-ref"] === "string" ? args["anchor-ref"] : "",
    reason: String(args.reason ?? ""),
    hits,
  });
  return runReframe(plan);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
