/**
 * scripts/qa/packet.ts — hydra-qa steps 7.0 / 7.0a / 7.0b in ONE call (issue
 * #5269, ADR-0046 Decision 7).
 *
 *   node --experimental-strip-types scripts/qa/packet.ts --preflight <file> [--repo owner/name]
 *
 * A PURE READ of the repo and the PR: it writes only temp files and prints
 * `{reviewPacketPath, standardsPacketPath, standardsFound, specInputPath,
 * priorFindings, rereviewDiffBase, mergeDanger, degraded[]}`. The review packet
 * text is byte-identical to the playbook bash it replaces (the `Diff
 * (<sha12>…HEAD):` header, the `===== <f> @ HEAD =====` sections, the
 * deleted-file sentinel, the appended re-review context and the informational
 * Merge-danger line). The packet NEVER carries the standards text — that goes
 * only to the Standards prompts (the Spec axis must not see it). An unreadable
 * standards catalog exits 1 BEFORE anything is written, so no reviewer is
 * spawned on a packet missing its rule set.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_REPO,
  UsageError,
  createProductionPorts,
  flagValue,
  isEntrypoint,
  isRecord,
  runCli,
  tryParse,
  DEFAULT_API_BASE,
  type PlumbingPorts,
} from "./_lib.ts";
import {
  PacketResultSchema,
  PreflightResultSchema,
  type PacketResult,
  type PreflightResult,
} from "../../src/schemas/qa-plumbing-cli.ts";
import { compareMergeDanger, parseMergeDangerField } from "../../src/qa/change-shape.ts";
import { detectOneWayDoor } from "../../src/qa/one-way-door.ts";
import { loadCodingStandards, type LoadResult } from "../../src/qa/standards-loader.ts";

export const NO_STANDARDS_SENTINEL =
  "No CODING_STANDARDS.md at repo root — judge against the Fowler battery and the remaining Hydra checks only";
const DELETED_SENTINEL = "(file deleted or absent at HEAD — see the diff above)";

/** What bash command substitution does to a captured stdout: drop trailing newlines. */
const chomp = (s: string): string => s.replace(/\n+$/, "");

export interface PacketDeps {
  loadStandards: (root: string) => Promise<LoadResult>;
  /** Where the packet files go; a fresh temp dir by default. */
  outDir?: string;
}

export function readPreflight(path: string): PreflightResult {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    console.error(`[qa-plumbing] cannot read preflight file ${path}:`, err);
    throw new UsageError(`cannot read --preflight file ${path}`);
  }
  const parsed = PreflightResultSchema.safeParse(tryParse(raw));
  if (!parsed.success) {
    throw new UsageError(`--preflight is not a valid preflight result: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  }
  return parsed.data;
}

export async function runPacket(
  pre: PreflightResult,
  repo: string,
  ports: PlumbingPorts,
  deps: PacketDeps,
): Promise<PacketResult> {
  if (!pre.ok || pre.pr === null || pre.fixedSha === null) {
    throw new UsageError(`preflight stage '${pre.stage}' has no review to build a packet for`);
  }
  const { fixedSha } = pre;
  const prNumber = pre.pr.number;
  const degraded: string[] = [];

  // Standards-axis only (ADR-0046 Decision 3). Load FIRST: a failed read must
  // exit before any packet file exists (S5's pre-spawn exit, preserved).
  const standards = await deps.loadStandards(process.cwd());
  if (!standards.ok) {
    throw new Error(`standards catalog read failed: ${standards.message}`);
  }

  // 7.0 the shared review packet, captured ONCE.
  const diff = await ports.git(["diff", `${fixedSha}...HEAD`]);
  if (!diff.ok) throw new Error(`git diff failed: ${diff.stderr}`);
  const diffText = chomp(diff.stdout);
  const names = await ports.git(["diff", "--name-only", `${fixedSha}...HEAD`]);
  if (!names.ok) throw new Error(`git diff --name-only failed: ${names.stderr}`);
  let changedFilesPacket = "";
  for (const f of names.stdout.split("\n")) {
    if (f === "") continue;
    const shown = await ports.git(["show", `HEAD:${f}`]);
    const body = shown.ok ? chomp(shown.stdout) : DELETED_SENTINEL;
    changedFilesPacket += `===== ${f} @ HEAD =====\n${body}\n\n`;
  }
  let packet = `Diff (${fixedSha.slice(0, 12)}…HEAD):\n\n${diffText}\n\nFull contents of every changed file at HEAD:\n\n${changedFilesPacket}`;

  // 7.0a re-review context after a FAIL — every failure means no context.
  let priorFindings = "";
  let rereviewDiffBase = "";
  try {
    const ctx = await ports.phase("prior-context", { pr: prNumber, tier: pre.tier.num });
    const c = isRecord(ctx.context) ? ctx.context : {};
    if (c.includeFindings === true && typeof ctx.priorFindings === "string") priorFindings = ctx.priorFindings;
    if (c.includeDiff === true && typeof c.baseSha === "string") rereviewDiffBase = c.baseSha;
  } catch (err) {
    console.error("[hydra-qa] WARN: prior-context call failed — no re-review context:", err);
    degraded.push("prior-context");
  }
  if (priorFindings !== "") {
    packet += `\n\nRE-REVIEW CONTEXT — the previous QA round FAILed with the findings below. Review the FULL change above as usual. In your report, first state fixed/not-fixed for each prior finding; for anything new, prefer medium+ and say why it wasn't visible before.\n\n${priorFindings}`;
    if (rereviewDiffBase !== "") {
      const since = await ports.git(["diff", "--no-renames", rereviewDiffBase, "HEAD"]);
      packet += `\n\nChanges since the prior verdict (${rereviewDiffBase}..HEAD), context only:\n\n${since.ok ? chomp(since.stdout) : ""}`;
    }
  } else {
    rereviewDiffBase = "";
  }

  // 7.0b merge danger (#5258, escalate-only): declared field vs the detector.
  let mdFinding: unknown = null;
  let mdGap: string | null = null;
  try {
    const bodyRes = await ports.gh(["pr", "view", String(prNumber), "--repo", repo, "--json", "body", "--jq", ".body"]);
    const pathsRes = await ports.git(["diff", "--no-renames", "--name-only", `${fixedSha}...HEAD`]);
    const head = await ports.git(["rev-parse", "HEAD"]);
    if (!bodyRes.ok || !pathsRes.ok) throw new Error("merge-danger inputs unreadable");
    const paths = pathsRes.stdout.split("\n").filter((l) => l !== "");
    const det = detectOneWayDoor({ paths, diff: diffText });
    const field = parseMergeDangerField(bodyRes.stdout);
    const check = compareMergeDanger(field, det, { pr: String(prNumber), sha: head.ok ? head.stdout.trim() : "" });
    mdFinding = check.finding ?? null;
    mdGap = check.gapLine ?? null;
    packet += `\n\nMerge danger check (informational): declared=${field.declared ?? "none"} detector=${det.door} outcome=${check.outcome} classes=${(det.classes ?? []).join(",")}`;
  } catch (err) {
    console.error("[hydra-qa] WARN: merge danger check unavailable — skipped:", err);
    degraded.push("merge-danger");
  }

  // Write the files — the only side effect.
  const dir = deps.outDir ?? mkdtempSync(join(tmpdir(), "qa-packet-"));
  const reviewPacketPath = join(dir, "review-packet.txt");
  writeFileSync(reviewPacketPath, packet);
  const standardsFound = standards.found === true;
  const standardsPacketPath = join(dir, "standards-packet.txt");
  writeFileSync(standardsPacketPath, standardsFound ? (standards as { text: string }).text : NO_STANDARDS_SENTINEL);
  let specInputPath: string | null = null;
  if (pre.spec.input !== null && pre.spec.input !== undefined) {
    specInputPath = join(dir, "spec-input.json");
    writeFileSync(specInputPath, JSON.stringify(pre.spec.input));
  }
  return {
    reviewPacketPath,
    standardsPacketPath,
    standardsFound,
    specInputPath,
    priorFindings,
    rereviewDiffBase,
    mergeDanger: { finding: mdFinding, gapLine: mdGap },
    degraded,
  };
}

if (isEntrypoint(import.meta.url)) {
  await runCli("qa-packet", async () => {
    const argv = process.argv.slice(2);
    const file = flagValue(argv, "--preflight");
    if (file === undefined) throw new UsageError("usage: packet.ts --preflight <file> [--repo owner/name]");
    const repo = flagValue(argv, "--repo") ?? DEFAULT_REPO;
    const pre = readPreflight(file);
    const ports = await createProductionPorts(repo, process.env.HYDRA_API_BASE || DEFAULT_API_BASE);
    return PacketResultSchema.parse(await runPacket(pre, repo, ports, { loadStandards: loadCodingStandards }));
  });
}
