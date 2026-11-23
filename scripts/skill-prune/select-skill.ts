/**
 * scripts/skill-prune/select-skill.ts — the hydra-skill-prune pick, as code.
 *
 *   select          print the ONE playbook to prune: the largest over-baseline
 *                   body-word delta first (freshest accretion), else the
 *                   least-recently-pruned per the rotation ledger, else the
 *                   alphabetically first hydra-*.md (missing ledger).
 *   stamp <name>    record `<name>` as pruned now in the rotation ledger.
 *
 * Ledger: `${HYDRA_STATE_DIR:-/tmp}/hydra-skill-prune-rotation.json`, a map of
 * playbook name -> last-pruned epoch seconds. Playbook names are the bare
 * `hydra-*.md` file basenames, e.g. `hydra-dev.md`.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { measureSkillSources } from "./../ci/skill-size-ratchet.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASELINE_PATH = join(REPO_ROOT, "scripts/ci/skill-size-baseline.json");
const PLAYBOOK_PREFIX = "docs/operator-playbooks/";

export type Ledger = Record<string, number>;

export function ledgerPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HYDRA_STATE_DIR || "/tmp", "hydra-skill-prune-rotation.json");
}

/** Top-level hydra-*.md playbook names (not fragments) in a measured map. */
function candidates(measured: Record<string, unknown>): string[] {
  return Object.keys(measured)
    .filter((p) => p.startsWith(PLAYBOOK_PREFIX) && !p.slice(PLAYBOOK_PREFIX.length).includes("/"))
    .map((p) => basename(p))
    .filter((n) => n.startsWith("hydra-"))
    .sort();
}

/**
 * Pure pick. `current` / `baseline` are body word counts keyed by repo-relative
 * playbook path; `ledger` maps playbook name -> last-pruned epoch.
 */
export function pickSkill(
  current: Record<string, number>,
  baseline: Record<string, number>,
  ledger: Ledger,
): string | null {
  const names = candidates(current);
  if (names.length === 0) return null;

  let best: string | null = null;
  let bestDelta = 0;
  for (const name of names) {
    const key = PLAYBOOK_PREFIX + name;
    const delta = current[key] - (baseline[key] ?? 0);
    if (delta > bestDelta) {
      best = name;
      bestDelta = delta;
    }
  }
  if (best !== null) return best;

  // Steady state: least-recently-pruned; never-pruned counts as epoch 0, and
  // the alphabetical sort makes ties (and a missing ledger) pick the first.
  let oldest = names[0];
  for (const name of names) {
    if ((ledger[name] ?? 0) < (ledger[oldest] ?? 0)) oldest = name;
  }
  return oldest;
}

export async function readLedger(path: string): Promise<Ledger> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`malformed rotation ledger at ${path}: expected an object`);
  }
  return parsed as Ledger;
}

export async function stampSkill(name: string, path: string, nowEpoch = Math.floor(Date.now() / 1000)): Promise<void> {
  const ledger = await readLedger(path);
  ledger[name] = nowEpoch;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(ledger, null, 2) + "\n");
}

async function main(argv: string[]): Promise<number> {
  const [cmd, arg] = argv;
  if (cmd === "select") {
    const measured = await measureSkillSources();
    // Counted rows: `<path>` -> body words (a `/description` key is never looked up: pickSkill iterates measured paths).
    const baseline = JSON.parse(await readFile(BASELINE_PATH, "utf8")) as Record<string, number>;
    const current: Record<string, number> = {};
    for (const [k, v] of Object.entries(measured)) current[k] = v.body;
    const pick = pickSkill(current, baseline, await readLedger(ledgerPath()));
    if (pick === null) {
      console.error("[skill-prune] no hydra-*.md playbook found");
      return 1;
    }
    console.log(pick);
    return 0;
  }
  if (cmd === "stamp" && arg) {
    await stampSkill(basename(arg), ledgerPath());
    return 0;
  }
  console.error("usage: select-skill.ts select | stamp <playbook-name>");
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error("[skill-prune] select-skill failed:", err);
      process.exit(1);
    },
  );
}
