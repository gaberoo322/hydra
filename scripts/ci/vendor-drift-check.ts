#!/usr/bin/env npx tsx
/**
 * vendor-drift-check — is a vendored upstream Pocock base stale, and would a
 * refresh silently un-suppress an instruction? (issue #3994, epic #3988)
 *
 * ## Why this exists
 *
 * `docs/operator-playbooks/_vendor/*.md` are captured copies of upstream skills
 * that composing playbooks ride on (ADR-0030 Decision 4 / Option C). Upstream
 * moves; the captures do not. Drift here is SILENT — the composed skill keeps
 * generating cleanly from a stale base, and nothing reports it. That is not
 * hypothetical: upstream renamed `diagnose` -> `diagnosing-bugs` and
 * `writing-great-skills` -> `writing-for-agents` and the local copies never
 * moved, unnoticed for weeks.
 *
 * ## The second, sharper hazard
 *
 * A composing playbook declares `supersedes:` entries naming base headings to
 * EXCISE (issue #3990). If a refreshed base renames one of those headings, the
 * entry stops resolving. `sync-skills.sh` fails loud on that — by design — but
 * only once someone runs it. This checker surfaces it BEFORE a refresh lands,
 * so an automated re-vendor never quietly reintroduces the #3818 duplicate
 * instruction it was suppressing.
 *
 * ## Honest about what it does not know
 *
 * Every base currently carries `shaStatus: "unverified"` — the captures predate
 * provenance stamping and were taken from a pre-plugin `npx skills add --copy`
 * install, so the upstream commit is genuinely unknown. This tool reports that
 * as "needs a baseline re-vendor", NOT as "current". Fabricating a SHA (e.g.
 * stamping upstream HEAD) would assert a provenance nobody verified, and the
 * captures are already known to lag HEAD.
 *
 * ADVISORY. Exits 0 on drift; the caller decides what to do. It exits non-zero
 * only when it cannot do its job (malformed manifest), never merely because
 * upstream moved — an advisory check that reddens the queue on ambient upstream
 * activity trains everyone to ignore it.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const VENDOR_DIR = join(REPO_ROOT, "docs/operator-playbooks/_vendor");
const PLAYBOOK_DIR = join(REPO_ROOT, "docs/operator-playbooks");
const MANIFEST = join(VENDOR_DIR, "provenance.json");
const PLUGIN_REGISTRY = join(homedir(), ".claude/plugins/installed_plugins.json");
/** Plugin key prefix in the registry; the suffix is `@<marketplace>`. */
const PLUGIN_NAME = "mattpocock-skills";

export interface BaseProvenance {
  skill: string;
  capturedAt: string;
  upstreamSha: string | null;
  shaStatus: "verified" | "unverified";
  note?: string;
}

export interface Manifest {
  bases: Record<string, BaseProvenance>;
}

export interface Finding {
  /** Machine-readable kind so a caller can route without parsing prose. */
  kind:
    | "plugin-not-installed"
    | "unverified-provenance"
    | "sha-drift"
    | "content-drift"
    | "manifest-orphan"
    | "unmanifested-base"
    | "supersedes-unresolved";
  base?: string;
  detail: string;
}

/** Parse the plugin registry, returning the installed SHA or null. Pure-ish. */
export function readInstalledPluginSha(registryPath: string): string | null {
  if (!existsSync(registryPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(registryPath, "utf-8"));
  } catch (err) {
    console.error(`[vendor-drift] plugin registry is not valid JSON: ${(err as Error).message}`);
    return null;
  }
  const plugins = (parsed as { plugins?: Record<string, unknown> })?.plugins;
  if (!plugins) return null;
  for (const [key, value] of Object.entries(plugins)) {
    if (!key.startsWith(`${PLUGIN_NAME}@`)) continue;
    const installs = Array.isArray(value) ? value : [];
    const sha = (installs[0] as { gitCommitSha?: string } | undefined)?.gitCommitSha;
    return sha ?? null;
  }
  return null;
}

/**
 * Every `supersedes:` entry across composing playbooks, paired with the base it
 * targets. Used to check that a refresh would not orphan an excision.
 */
export function collectSupersedes(
  playbookDir: string,
): Array<{ playbook: string; base: string; heading: string }> {
  const out: Array<{ playbook: string; base: string; heading: string }> = [];
  for (const file of readdirSync(playbookDir)) {
    if (!file.endsWith(".md")) continue;
    const text = readFileSync(join(playbookDir, file), "utf-8");
    const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
    if (!fm) continue;
    const baseMatch = fm[1].match(/^compose_base:\s*(.+)$/m);
    if (!baseMatch) continue;
    const base = baseMatch[1].trim().replace(/^_vendor\//, "");
    // Block-sequence entries under `supersedes:`, parsed line-by-line to match
    // how sync-skills.sh reads them. Deliberately NOT a regex: the obvious
    // `/^supersedes:\s*$([\s\S]*?)(?=^\S|\Z)/m` is wrong — `\Z` is not a JS
    // anchor (it matches a literal "Z"), so the lookahead never fires when the
    // block ends the frontmatter, and the collector silently returns nothing.
    // A drift checker that finds no entries looks exactly like one where every
    // entry resolves, which is the failure class this whole check exists for.
    const lines = fm[1].split("\n");
    let inBlock = false;
    for (const raw of lines) {
      if (/^supersedes:\s*$/.test(raw)) {
        inBlock = true;
        continue;
      }
      if (!inBlock) continue;
      const item = raw.trim();
      if (item.startsWith("- ")) {
        out.push({
          playbook: file,
          base,
          heading: item.slice(2).trim().replace(/^["']|["']$/g, ""),
        });
        continue;
      }
      // Any non-item line ends the block (a sibling key, or a blank line).
      inBlock = false;
    }
  }
  return out;
}

/** Headings present in a markdown body, normalised (no leading #'s). */
export function headingsOf(markdown: string): string[] {
  return markdown
    .split("\n")
    .filter((l) => /^#{1,6}\s+/.test(l))
    .map((l) => l.replace(/^#+\s*/, "").trim());
}

/** The body of a SKILL.md (frontmatter stripped). Returns null if malformed. */
export function bodyOf(text: string): string | null {
  const m = text.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return m ? m[1] : null;
}

export function check(opts: {
  vendorDir: string;
  playbookDir: string;
  manifestPath: string;
  registryPath: string;
  /** Resolved plugin skill dir, when the plugin is installed. */
  pluginSkillsDir?: string | null;
}): Finding[] {
  const findings: Finding[] = [];

  const manifest = JSON.parse(readFileSync(opts.manifestPath, "utf-8")) as Manifest;
  if (!manifest.bases || typeof manifest.bases !== "object") {
    throw new Error(`${opts.manifestPath}: missing a 'bases' object`);
  }

  // Manifest <-> filesystem agreement. A base with no entry has no provenance
  // at all, which is the state #3994 exists to end.
  const onDisk = readdirSync(opts.vendorDir).filter(
    (f) => f.endsWith(".md") && f !== "README.md",
  );
  for (const file of onDisk) {
    if (!manifest.bases[file]) {
      findings.push({
        kind: "unmanifested-base",
        base: file,
        detail: `${file} is vendored but has no provenance entry — add one so its staleness is knowable.`,
      });
    }
  }
  for (const file of Object.keys(manifest.bases)) {
    if (!onDisk.includes(file)) {
      findings.push({
        kind: "manifest-orphan",
        base: file,
        detail: `provenance names ${file}, which is not in ${opts.vendorDir} — delete the entry with the file.`,
      });
    }
  }

  const installedSha = readInstalledPluginSha(opts.registryPath);
  if (installedSha === null) {
    findings.push({
      kind: "plugin-not-installed",
      detail:
        `the ${PLUGIN_NAME} plugin is not in the registry, so no SHA comparison is possible. ` +
        `This is expected until the operator installs it; the check degrades to reporting ` +
        `provenance status only, and never fails on it.`,
    });
  }

  for (const [file, prov] of Object.entries(manifest.bases)) {
    if (!onDisk.includes(file)) continue;

    if (prov.shaStatus === "unverified" || prov.upstreamSha === null) {
      findings.push({
        kind: "unverified-provenance",
        base: file,
        detail:
          `${file} (skill '${prov.skill}', captured ${prov.capturedAt}) has no verified upstream ` +
          `commit — staleness cannot be measured. A re-vendor from the installed plugin ` +
          `establishes the baseline.`,
      });
    } else if (installedSha !== null && prov.upstreamSha !== installedSha) {
      findings.push({
        kind: "sha-drift",
        base: file,
        detail:
          `${file} was captured at ${prov.upstreamSha.slice(0, 8)} but the installed plugin is ` +
          `at ${installedSha.slice(0, 8)} — upstream has moved since capture.`,
      });
    }

    // Content comparison, when the plugin's copy is reachable. Byte-faithful
    // captures are what make this exact.
    if (opts.pluginSkillsDir) {
      const upstreamPath = join(opts.pluginSkillsDir, prov.skill, "SKILL.md");
      if (existsSync(upstreamPath)) {
        const vendoredBody = bodyOf(readFileSync(join(opts.vendorDir, file), "utf-8"));
        const upstreamBody = bodyOf(readFileSync(upstreamPath, "utf-8"));
        if (vendoredBody !== null && upstreamBody !== null && vendoredBody !== upstreamBody) {
          findings.push({
            kind: "content-drift",
            base: file,
            detail: `${file} body differs from the installed ${prov.skill} skill — re-vendor to pick up upstream's changes.`,
          });
        }
      }
    }
  }

  // Would a refresh orphan an excision? This is the guard that keeps an
  // automated re-vendor from silently un-suppressing a base instruction.
  for (const entry of collectSupersedes(opts.playbookDir)) {
    const basePath = join(opts.vendorDir, entry.base);
    if (!existsSync(basePath)) continue;
    const body = bodyOf(readFileSync(basePath, "utf-8"));
    if (body === null) continue;
    const want = entry.heading.replace(/^#+\s*/, "").trim();
    const matches = headingsOf(body).filter((h) => h === want);
    if (matches.length !== 1) {
      findings.push({
        kind: "supersedes-unresolved",
        base: entry.base,
        detail:
          `${entry.playbook} supersedes ${JSON.stringify(entry.heading)}, which matches ` +
          `${matches.length} headings in ${entry.base} (expected exactly 1). A refresh that ` +
          `renamed it would un-suppress the instruction the overlay meant to remove.`,
      });
    }
  }

  return findings;
}

function main(): void {
  const asJson = process.argv.includes("--json");

  let findings: Finding[];
  try {
    findings = check({
      vendorDir: VENDOR_DIR,
      playbookDir: PLAYBOOK_DIR,
      manifestPath: MANIFEST,
      registryPath: PLUGIN_REGISTRY,
      pluginSkillsDir: null,
    });
  } catch (err) {
    // A malformed manifest means the check cannot do its job — that IS a
    // failure, distinct from "upstream moved".
    console.error(`[vendor-drift] cannot run: ${(err as Error).message}`);
    process.exit(2);
  }

  if (asJson) {
    console.log(JSON.stringify({ findings }, null, 2));
    return;
  }

  if (findings.length === 0) {
    console.log("[vendor-drift] OK — every vendored base is current and every supersedes entry resolves.");
    return;
  }
  console.log(`[vendor-drift] ${findings.length} finding(s) — ADVISORY, not a merge gate:`);
  for (const f of findings) {
    console.log(`  [${f.kind}]${f.base ? ` ${f.base}:` : ""} ${f.detail}`);
  }
  const actionable = findings.filter(
    (f) => f.kind === "sha-drift" || f.kind === "content-drift" || f.kind === "supersedes-unresolved",
  );
  if (actionable.length > 0) {
    console.log(
      `\n[vendor-drift] ${actionable.length} finding(s) need a re-vendor. Refresh the base, ` +
        `re-run scripts/sync-skills.sh, and resolve any supersedes entry that stopped matching.`,
    );
  }
}

if (import.meta.filename === process.argv[1]) main();
