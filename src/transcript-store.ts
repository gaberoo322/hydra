/**
 * Transcript Store — the single Seam over Claude Code's on-disk session
 * transcript layout (issue #951).
 *
 * The harness writes each Claude Code session to a line-delimited JSONL file:
 *
 *   <root>/<encoded-projectDir>/<sessionId>.jsonl
 *
 * where `<root>` is `~/.claude/projects` (relocatable via the
 * `HYDRA_CLAUDE_PROJECTS_ROOT` env override — the documented test/relocation
 * seam), `<encoded-projectDir>` replaces every non-`[A-Za-z0-9]` char in the
 * absolute project cwd with `-` (e.g. `/home/gabe/hydra` → `-home-gabe-hydra`),
 * and `<sessionId>` is a harness-assigned UUID. Resumed sessions can append a
 * second shard one level deeper (`<root>/<projectDir>/<sessionId>/subagents/*.jsonl`).
 *
 * This is a single piece of external-harness knowledge that was previously
 * re-derived in `src/cost/usage-tracker.ts` and `src/api/dispatches.ts` with
 * DIVERGENT implementations — most notably the root resolution: the usage
 * tracker honored `HYDRA_CLAUDE_PROJECTS_ROOT`, the dispatches transcript-read
 * endpoint hard-coded `~/.claude/projects` and silently ignored the override.
 * Relocate the root and the two readers would disagree — a latent bug. This
 * Module makes that divergence impossible by construction: there is one root
 * resolver, one project-dir encoder, one path-traversal confinement guard, one
 * session-id ↔ path resolver, and one JSONL file iterator. Every reader is a
 * caller of this Interface.
 *
 * Scope boundary: this Module owns *locating and streaming* transcripts — where
 * they live and how to read the files. It does NOT interpret line contents: the
 * cost-domain `parseUsageLine` / token-breakdown semantics stay in
 * `src/cost/usage-tracker.ts`, and the conversation-record projection
 * (`parseTranscript` / `projectMessage`) stays in `src/api/dispatches.ts`. The
 * Store hands back file paths and raw lines; callers interpret them.
 *
 * READ-ONLY — every function here only resolves paths or reads/lists files;
 * none mutates the transcript tree (grounding.ts discipline).
 *
 * Sibling boundary Seams: **Redis Adapters** (`src/redis/*`, storage),
 * **Schemas** (`src/schemas/*`, HTTP input), the **GitHub CLI Adapter**
 * (`src/github/*`, `gh`/`git`) and the **Host-Probe Adapter**
 * (`src/host-probe/*`, `df`/`free`/`systemctl`). The Transcript Store is the
 * filesystem-transcript boundary in that family.
 */
import { readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { homedir } from "node:os";

/**
 * The transcript root — the single source of truth for the
 * `HYDRA_CLAUDE_PROJECTS_ROOT` override. Defaults to `~/.claude/projects`.
 *
 * Every reader resolves the root here, so a relocated transcript tree is
 * followed identically by all of them — the env-override divergence that
 * motivated this Seam (issue #951) is impossible by construction.
 */
export function projectsRoot(): string {
  return process.env.HYDRA_CLAUDE_PROJECTS_ROOT || join(homedir(), ".claude", "projects");
}

/**
 * Encode an absolute project dir into the harness's directory name: every char
 * that isn't `[A-Za-z0-9]` becomes `-` (e.g. `/home/gabe/hydra` →
 * `-home-gabe-hydra`). Mirrors the harness's own encoding.
 */
export function encodeProjectDir(projectDir: string): string {
  return projectDir.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * Derive a transcript's `sessionId` from its file path. The Claude Code layout
 * names each transcript `<sessionId>.jsonl`, so the filename stem is the
 * sessionId (and the join key into the subagent-dispatch registry).
 */
export function sessionIdFromPath(filePath: string): string {
  return basename(filePath, ".jsonl");
}

/**
 * A `sessionId` is the JSONL filename stem — a harness-assigned UUID. We only
 * ever compose a filesystem path from a validated session id, never from raw
 * client input, so this is the first path-traversal guard: anything that isn't
 * a UUID-shaped token is rejected before it touches the filesystem.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuidShaped(value: string): boolean {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

/**
 * Assert a resolved path stays within `root`. Returns the resolved path on
 * success, or `null` if it escapes — defence in depth on top of the UUID
 * check. This is the one authoritative path-traversal confinement guard; every
 * candidate transcript path passes through it before a read.
 */
export function confineToRoot(root: string, candidate: string): string | null {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (
    resolvedCandidate === resolvedRoot ||
    resolvedCandidate.startsWith(resolvedRoot + sep)
  ) {
    return resolvedCandidate;
  }
  return null;
}

/**
 * Injectable filesystem seam for {@link resolveTranscriptPath}, so tests can
 * pin resolution without standing up a real `~/.claude/projects` tree. `root`
 * defaults to {@link projectsRoot}; `statExists` / `listProjectDirs` default to
 * real `fs` reads.
 */
export interface ResolveDeps {
  root?: string;
  stat?: (p: string) => Promise<boolean>;
  listProjectDirs?: (root: string) => Promise<string[]>;
}

/**
 * Resolve the on-disk JSONL path for a session, or `null` if not found.
 *
 * Strategy:
 *   1. If `projectDir` is known, try `<root>/<encode(projectDir)>/<id>.jsonl`
 *      directly (one stat, no scan).
 *   2. Otherwise (or if step 1 misses), scan one level of project directories
 *      for `<id>.jsonl`.
 *
 * All candidate paths are confined to the transcript root via
 * {@link confineToRoot}. READ-ONLY — only `stat`/`readdir`, never a write.
 * A non-UUID-shaped `sessionId` is rejected up front (`null`).
 */
export async function resolveTranscriptPath(
  sessionId: string,
  projectDir: string | undefined,
  deps: ResolveDeps = {},
): Promise<string | null> {
  if (!isUuidShaped(sessionId)) return null;
  const root = deps.root ?? projectsRoot();
  const id = sessionId.trim();

  const statExists =
    deps.stat ??
    (async (p: string) => {
      try {
        await stat(p);
        return true;
      } catch {
        /* intentional: missing file is the normal not-available path */
        return false;
      }
    });

  // Step 1 — deterministic path from a known projectDir.
  if (projectDir) {
    const direct = confineToRoot(
      root,
      join(root, encodeProjectDir(projectDir), `${id}.jsonl`),
    );
    if (direct && (await statExists(direct))) return direct;
  }

  // Step 2 — scan the project dirs for the session file.
  const listDirs =
    deps.listProjectDirs ??
    (async (r: string) => {
      try {
        const entries = await readdir(r, { withFileTypes: true });
        return entries.filter((e) => e.isDirectory()).map((e) => e.name);
      } catch (err) {
        console.error(`[transcript-store] failed to list transcript root ${r}:`, err);
        return [];
      }
    });

  const dirs = await listDirs(root);
  for (const dir of dirs) {
    const candidate = confineToRoot(root, join(root, dir, `${id}.jsonl`));
    if (candidate && (await statExists(candidate))) return candidate;
  }
  return null;
}

/**
 * Walk the projects tree under `root` and return every `.jsonl` file. Walks
 * arbitrarily deep — two levels is enough for today's layout
 * (`<root>/<projectDir>/*.jsonl` and
 * `<root>/<projectDir>/<sessionId>/subagents/*.jsonl`), but a deeper walk lets
 * the format evolve without callers caring.
 *
 * A missing or unreadable directory is silently skipped (the homedir layout is
 * operator-controlled; a missing `~/.claude/projects` must not crash a reader
 * on first boot). `root` defaults to {@link projectsRoot}.
 */
export async function listTranscriptFiles(root: string = projectsRoot()): Promise<string[]> {
  const out: string[] = [];
  await walk(root, out);
  return out;
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    /* intentional: a missing/unreadable transcript dir is skipped, not fatal —
       the operator-controlled ~/.claude/projects may not exist on first boot */
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push(full);
    }
  }
}
