/**
 * src/skills/cli.ts — the ONLY impure file in src/skills/ (issue #4719,
 * ADR-0041 Decision 1/2). Reads the playbook corpus, calls `planCorpus`, prints
 * the plan. It performs NO writes — tmp-file + mv stays in bash.
 *
 *   node --experimental-strip-types src/skills/cli.ts --playbooks-dir <dir>
 *
 * Exit contract:
 *   0 — stdout is exactly one JSON document `{writes, skips}`
 *   1 — plan errors: every message on stderr (one per line), NOTHING on stdout
 *   2 — usage error / unreadable playbooks dir: message on stderr
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseCliArgs } from "../cli-args.ts";
import { planCorpus, type CorpusInput } from "./plan.ts";

const USAGE = "usage: node --experimental-strip-types src/skills/cli.ts --playbooks-dir <dir>";

/** Read every regular file under `dir` into `out`, keyed by posix path relative to `root`. */
function walk(root: string, dir: string, out: Map<string, string>): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return; // optional subtree
    throw err;
  }
  for (const entry of entries.sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(root, full, out);
    else out.set(full.slice(root.length + 1).split("\\").join("/"), readFileSync(full, "utf-8"));
  }
}

/** Production corpus reader — shared with the parity test. Throws on unreadable dir. */
export function readCorpus(playbooksDir: string): CorpusInput {
  const dir = resolve(playbooksDir);
  const playbooks: CorpusInput["playbooks"] = [];
  const sources = new Map<string, string>();
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (!statSync(full).isFile()) continue;
    if (entry.endsWith(".md")) {
      if (entry === "README.md") continue;
      playbooks.push({ fileName: entry, text: readFileSync(full, "utf-8") });
    } else if (entry.endsWith(".settings.json")) {
      sources.set(entry, readFileSync(full, "utf-8"));
    }
  }
  walk(dir, join(dir, "_fragments"), sources);
  walk(dir, join(dir, "_vendor"), sources);
  return { playbooksDir: dir, playbooks, sources };
}

export function main(argv: readonly string[]): number {
  const parsed = parseCliArgs(argv, { "playbooks-dir": { type: "string" } } as const);
  if (parsed.ok === false) {
    process.stderr.write(`skills-cli: ${(parsed as { error: string }).error}\n${USAGE}\n`);
    return 2;
  }
  const dirArg = (parsed as { values: { "playbooks-dir"?: string } }).values["playbooks-dir"];
  if (!dirArg) {
    process.stderr.write(`skills-cli: --playbooks-dir is required\n${USAGE}\n`);
    return 2;
  }
  let input: CorpusInput;
  try {
    input = readCorpus(dirArg);
  } catch (err) {
    process.stderr.write(`skills-cli: cannot read playbooks dir ${dirArg}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  const plan = planCorpus(input);
  if (plan.errors.length > 0) {
    process.stderr.write(plan.errors.map((e) => e.message).join("\n") + "\n");
    return 1;
  }
  process.stdout.write(JSON.stringify({ writes: plan.writes, skips: plan.skips }) + "\n");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
