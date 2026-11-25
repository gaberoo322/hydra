/**
 * Seed a RELAUNCHED autopilot run's state.json through the real Run Ledger
 * (`run_ledger.py seed --carry-from <prev>`), the same path bootstrap.sh takes
 * across a Pace Gate relaunch (#5717). Returns the seeded document so a decide()
 * regression test can start from exactly what turn 1 of a new run reads.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const LEDGER = join(REPO_ROOT, "scripts", "autopilot", "run_ledger.py");
const GOLDEN = join(REPO_ROOT, "test", "fixtures", "run-ledger", "heredoc-default.json");

/** `prior` is the previous run's document (only the carried rows matter). */
export function seedRelaunchedState(prior: Record<string, unknown>, now: number): any {
  const golden = JSON.parse(readFileSync(GOLDEN, "utf-8"));
  const dir = mkdtempSync(join(tmpdir(), "relaunch-seed-"));
  try {
    const prev = join(dir, "prev.json");
    const path = join(dir, "state.json");
    writeFileSync(prev, JSON.stringify(prior));
    const args = [`now=${now}`, `pid=${golden.pid}`, `run_id=${JSON.stringify(golden.run_id)}`];
    for (const [k, v] of Object.entries(golden.limits)) {
      if (k !== "schema_version") args.push(`${k}=${JSON.stringify(v)}`);
    }
    const r = spawnSync("python3", [LEDGER, "seed", path, "--carry-from", prev, ...args], {
      encoding: "utf-8",
      env: { PATH: process.env.PATH ?? "" },
    });
    if (r.status !== 0) throw new Error(`run_ledger seed exited ${r.status}: ${r.stderr}`);
    return JSON.parse(readFileSync(path, "utf-8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
