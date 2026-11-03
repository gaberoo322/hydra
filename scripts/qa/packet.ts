/**
 * scripts/qa/packet.ts — hydra-qa steps 7.0 / 7.0a / 7.0b: the shared review
 * packet, built ONCE (issue #5269, ADR-0046 Decision 7).
 *
 *   node --experimental-strip-types scripts/qa/packet.ts --preflight <file> [--repo owner/name]
 *
 * A pure read: it writes only `mktemp` files and prints
 * `{reviewPacketPath, standardsPacketPath|null, standardsFound, specInputPath|null,
 *   priorFindings, rereviewDiffBase, mergeDanger, degraded[]}`.
 *
 * The review packet text is byte-identical to the bash it replaces: the
 * `Diff (<sha12>…HEAD):` header, the `===== <f> @ HEAD =====` sections, the
 * deleted-file sentinel, the appended re-review context when the engine's
 * `prior-context` phase returns findings, and the informational merge-danger
 * line. The packet NEVER carries the standards text (the Spec axis never sees
 * it). An unreadable standards catalog exits 1 BEFORE anything is written or
 * any reviewer is spawned.
 */

import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_REPO,
  defaultGh,
  defaultGit,
  finish,
  flagValue,
  isEntrypoint,
  productionPhaseRunner,
  usageExit,
  type CmdRunner,
  type PhaseRunner,
} from "./common.ts";
import { compareMergeDanger, parseMergeDangerField } from "../../src/qa/change-shape.ts";
import { detectOneWayDoor } from "../../src/qa/one-way-door.ts";
import { loadCodingStandards, type LoadResult } from "../../src/qa/standards-loader.ts";
import {
  PacketResultSchema,
  PreflightResultSchema,
  type PacketResult,
  type PreflightReady,
} from "../../src/schemas/qa-plumbing-cli.ts";

export const NO_STANDARDS_SENTENCE =
  "No CODING_STANDARDS.md at repo root — judge against the Fowler battery and the remaining Hydra checks only";
export const DELETED_FILE_SENTINEL = "(file deleted or absent at HEAD — see the diff above)";

export interface PacketDeps {
  gh: CmdRunner;
  git: CmdRunner;
  phase: PhaseRunner;
  loadStandards: (repoRoot: string) => Promise<LoadResult>;
  /** Write a temp file and return its path. */
  writeTemp: (label: string, content: string) => string;
  cwd: string;
}

/** `$(…)` strips every trailing newline; the packet text depends on it. */
const stripTrailingNewlines = (s: string): string => s.replace(/\n+$/, "");

export type PacketOutcome =
  | { exitCode: 0; result: PacketResult }
  | { exitCode: 1; result: null; reason: string };

export async function runPacket(pre: PreflightReady, deps: PacketDeps): Promise<PacketOutcome> {
  const { gh, git, phase } = deps;
  const degraded: string[] = [];

  // Standards-axis catalog FIRST: an unreadable catalog is a pre-spawn exit,
  // before a single packet file exists.
  const standards = await deps.loadStandards(deps.cwd);
  if (!standards.ok) {
    console.error(`[hydra-qa] standards catalog read failed: ${standards.message}`);
    return { exitCode: 1, result: null, reason: `standards catalog read failed: ${standards.message}` };
  }

  const range = `${pre.fixedSha}...HEAD`;
  const diff = git(["diff", range]);
  if (!diff.ok) return { exitCode: 1, result: null, reason: `git diff ${range} failed: ${diff.stderr}` };
  const diffText = stripTrailingNewlines(diff.stdout);

  const names = git(["diff", "--name-only", range]);
  if (!names.ok) return { exitCode: 1, result: null, reason: `git diff --name-only ${range} failed: ${names.stderr}` };
  let filesPacket = "";
  for (const f of names.stdout.split("\n")) {
    if (f === "") continue;
    const shown = git(["show", `HEAD:${f}`]);
    const body = shown.ok ? stripTrailingNewlines(shown.stdout) : DELETED_FILE_SENTINEL;
    filesPacket += `===== ${f} @ HEAD =====\n${body}\n\n`;
  }
  let reviewPacket = `Diff (${pre.fixedSha.slice(0, 12)}…HEAD):\n\n${diffText}\n\nFull contents of every changed file at HEAD:\n\n${filesPacket}`;

  // 7.0a Re-review context after a FAIL — the engine's prior-context phase.
  let priorFindings = "";
  let rereviewDiffBase = "";
  const ctx = await phase("prior-context", { pr: pre.pr.number, tier: pre.tier.num });
  if (ctx === null) {
    console.error("[hydra-qa] WARN: prior-context call failed — no re-review context");
    degraded.push("prior-context");
  } else {
    const c = ctx.context as { includeFindings?: boolean; includeDiff?: boolean; baseSha?: string | null } | undefined;
    if (c?.includeFindings === true && typeof ctx.priorFindings === "string") priorFindings = ctx.priorFindings;
    if (c?.includeDiff === true && typeof c.baseSha === "string") rereviewDiffBase = c.baseSha;
  }
  if (priorFindings !== "") {
    reviewPacket +=
      `\n\nRE-REVIEW CONTEXT — the previous QA round FAILed with the findings below. Review the FULL change above as usual. In your report, first state fixed/not-fixed for each prior finding; for anything new, prefer medium+ and say why it wasn't visible before.\n\n${priorFindings}`;
    if (rereviewDiffBase !== "") {
      const since = git(["diff", "--no-renames", rereviewDiffBase, "HEAD"]);
      if (!since.ok) degraded.push("rereview-diff");
      reviewPacket +=
        `\n\nChanges since the prior verdict (${rereviewDiffBase}..HEAD), context only:\n\n${stripTrailingNewlines(since.ok ? since.stdout : "")}`;
    }
  }

  // 7.0b Merge danger check (escalate-only; informational block + optional row).
  let mergeFinding: Record<string, unknown> | null = null;
  let mergeGapLine: string | null = null;
  const bodyRes = gh(["pr", "view", String(pre.pr.number), "--repo", pre.repo, "--json", "body"]);
  let prBody: string | null = null;
  if (bodyRes.ok) {
    try {
      const parsed = JSON.parse(bodyRes.stdout) as { body?: unknown };
      prBody = typeof parsed.body === "string" ? parsed.body : "";
    } catch (err) {
      console.error("[hydra-qa] merge danger: PR body unparseable:", err);
    }
  }
  if (prBody === null) {
    console.error("[hydra-qa] WARN: merge danger check unavailable — skipped");
    degraded.push("merge-danger");
  } else {
    const headNow = git(["rev-parse", "HEAD"]);
    const det = detectOneWayDoor({ paths: pre.changedPaths, diff: diffText });
    const field = parseMergeDangerField(prBody);
    const check = compareMergeDanger(field, det, {
      pr: String(pre.pr.number),
      sha: headNow.ok ? headNow.stdout.trim() : pre.pr.headSha,
    });
    mergeFinding = check.finding as unknown as Record<string, unknown> | null;
    mergeGapLine = check.gapLine ?? null;
    reviewPacket +=
      `\n\nMerge danger check (informational): declared=${field.declared ?? "none"} detector=${det.door} outcome=${check.outcome} classes=${(det.classes ?? []).join(",")}`;
  }

  const standardsText = standards.found ? standards.text : NO_STANDARDS_SENTENCE;
  const result: PacketResult = {
    reviewPacketPath: deps.writeTemp("review-packet", reviewPacket),
    standardsPacketPath: deps.writeTemp("standards-packet", standardsText),
    standardsFound: standards.found,
    specInputPath: pre.spec.input === null ? null : deps.writeTemp("spec-input", JSON.stringify(pre.spec.input)),
    priorFindings,
    rereviewDiffBase,
    mergeDanger: { finding: mergeFinding, gapLine: mergeGapLine },
    degraded,
  };
  return { exitCode: 0, result };
}

export function tempWriter(): (label: string, content: string) => string {
  let dir: string | null = null;
  return (label, content) => {
    dir ??= mkdtempSync(join(tmpdir(), "hydra-qa-packet-"));
    const path = join(dir, `${label}.txt`);
    writeFileSync(path, content);
    return path;
  };
}

if (isEntrypoint(import.meta.url)) {
  const argv = process.argv.slice(2);
  const file = flagValue(argv, "--preflight");
  const repo = flagValue(argv, "--repo", DEFAULT_REPO) as string;
  if (!file) {
    usageExit([{ message: "usage: packet.ts --preflight <file> [--repo owner/name]" }]);
  } else {
    try {
      const pre = PreflightResultSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
      if (!pre.success) usageExit(pre.error.issues);
      else if (!pre.data.ok) usageExit([{ message: "preflight result is not ok:true — nothing to build a packet from" }]);
      else {
        const phase = await productionPhaseRunner(repo);
        const out = await runPacket(pre.data, {
          gh: defaultGh,
          git: defaultGit,
          phase,
          loadStandards: loadCodingStandards,
          writeTemp: tempWriter(),
          cwd: process.cwd(),
        });
        if (out.exitCode !== 0) {
          console.error(`[hydra-qa] packet: ${out.reason}`);
          finish(1);
        } else {
          const parsed = PacketResultSchema.safeParse(out.result);
          if (!parsed.success) usageExit(parsed.error.issues);
          else finish(0, parsed.data);
        }
      }
    } catch (err) {
      console.error("[hydra-qa] packet: no result produced:", err);
      finish(1);
    }
  }
}
