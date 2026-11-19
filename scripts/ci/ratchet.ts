/**
 * The Ratchet module (issue #5650, parent epic #5649).
 *
 * One definition of "a baseline that may only tighten": a ratchet declares a
 * policy (what it measures, how its baseline is shaped, which direction is
 * bad) and gets back a never-throwing `verdict()` plus a CLI `main()`. The
 * baseline diff, the shrink-only writer, the growth gate and the advice text
 * live here once instead of being copied into every scan script.
 *
 * Shapes
 *   set      rows are strings, each at most once. On disk: a sorted JSON array.
 *   counted  rows are `{key: n}`. On disk: a sorted JSON object. A second
 *            identical finding is a count of 2, never absorbed by one row.
 *
 * Polarity
 *   ceiling  the baseline tolerates at most n of a key. A violation is a key
 *            whose count rose or that is new. A stale row is one the tree no
 *            longer needs (count fell or the key vanished).
 *   floor    the baseline demands at least n of a key. A violation is a key
 *            whose count fell or that vanished. A stale row is one the tree
 *            now exceeds.
 *
 * CLI contract (main)
 *   --write-baseline   tighten the baseline to the measured tree; refuses to
 *                      loosen it (exit 1) unless --allow-grow is also given.
 *   --allow-grow       permit reviewed growth.
 *   --init / --seed / --shrink-baseline / --update-baseline
 *                      retired spellings: exit 2 naming the replacement.
 *   exit 0 pass, 1 ratchet violation (including refused growth), 2 crash/usage.
 */
import { resolve } from "node:path";
import { GateInvariantError } from "../../src/errors.ts";
import {
  REPO_ROOT,
  isCliEntrypoint,
  loadJsonBaseline,
  writeJsonBaseline,
} from "./seam-check-lib.ts";

export type RatchetShape = "set" | "counted";
export type RatchetPolarity = "ceiling" | "floor";
export type RatchetStale = "fail" | "hint";
export type RatchetEnforcement = "required" | "advisory";

/** What `measure` returns: finding keys (duplicates count) or an explicit `{key: n}` map. */
export type RatchetRows = readonly string[] | Readonly<Record<string, number>>;

/** A narrowing of one run to part of the tree (e.g. `--files`): scoped measure + baseline filter. */
export interface RatchetScope {
  measure(root: string): Promise<RatchetRows>;
  /** Keep only the baseline rows this scope measures. */
  keep(key: string): boolean;
}

export interface RatchetPolicy {
  id: string;
  /** Repo-relative path of the baseline file (an absolute path is used as-is). */
  baseline: string;
  shape: RatchetShape;
  polarity: RatchetPolarity;
  stale: RatchetStale;
  enforcement: RatchetEnforcement;
  /** Measure the tree. May throw: `verdict` returns the cause as `{ok:false}`. */
  measure(root: string): Promise<RatchetRows>;
  /** Extra CLI flags the ratchet handles itself; `scope` turns them into a narrowed run. */
  extra?: { flags: readonly string[]; scope(argv: readonly string[]): RatchetScope | undefined };
}

export interface RatchetVerdict {
  ok: boolean;
  /** Violating keys: over their ceiling / new (ceiling) or under their floor / vanished (floor). */
  added: string[];
  /** Baseline rows the tree no longer needs (ceiling) or now exceeds (floor). */
  stale: string[];
  /** Human-readable next step, or the failure cause when `crashed`. */
  advice: string;
  /** True when measure or the baseline read failed (CLI exit 2, not 1). */
  crashed?: true;
  /** Row totals (sum of counts) for the measured tree and the baseline. */
  measured: number;
  baselineRows: number;
}

export interface Ratchet {
  policy: RatchetPolicy;
  verdict(root?: string, scope?: RatchetScope): Promise<RatchetVerdict>;
  main(argv: readonly string[]): Promise<number>;
}

type Counts = Map<string, number>;

const RETIRED_FLAGS: Readonly<Record<string, string>> = {
  "--init": "--write-baseline --allow-grow (seed)",
  "--seed": "--write-baseline --allow-grow (seed)",
  "--shrink-baseline": "--write-baseline",
  "--update-baseline": "--write-baseline",
};

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toCounts(rows: RatchetRows, shape: RatchetShape): Counts {
  const m: Counts = new Map();
  if (Array.isArray(rows)) {
    for (const k of rows as string[]) m.set(k, (m.get(k) ?? 0) + 1);
  } else {
    for (const [k, n] of Object.entries(rows as Record<string, number>)) {
      if (n > 0) m.set(k, n);
    }
  }
  if (shape === "set") for (const [k] of m) m.set(k, 1);
  return m;
}

function parseBaseline(raw: unknown, policy: RatchetPolicy): Counts {
  const where = `${policy.baseline} (${policy.shape})`;
  if (policy.shape === "set") {
    if (!Array.isArray(raw) || raw.some((k) => typeof k !== "string")) {
      throw new GateInvariantError(`baseline ${where} is not a JSON array of strings`);
    }
    return toCounts(raw as string[], "set");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new GateInvariantError(`baseline ${where} is not a JSON object of {key: n}`);
  }
  for (const [k, n] of Object.entries(raw as Record<string, unknown>)) {
    if (!Number.isInteger(n) || (n as number) < 1) {
      throw new GateInvariantError(`baseline ${where} row ${JSON.stringify(k.slice(0, 80))} is not a positive integer`);
    }
  }
  return toCounts(raw as Record<string, number>, "counted");
}

function serialise(counts: Counts, shape: RatchetShape): unknown {
  const keys = [...counts.keys()].sort();
  if (shape === "set") return keys;
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = counts.get(k) as number;
  return out;
}

function total(counts: Counts): number {
  let n = 0;
  for (const v of counts.values()) n += v;
  return n;
}

function display(key: string): string {
  const s = key.split("\t").join(" | ");
  return s.length > 300 ? `${s.slice(0, 297)}...` : s;
}

interface Diff {
  added: string[];
  stale: string[];
}

/** The single comparison: `bad` is the over-ceiling / under-floor side, `slack` the other. */
function diff(measured: Counts, base: Counts, polarity: RatchetPolarity): Diff {
  const added: string[] = [];
  const stale: string[] = [];
  const keys = new Set([...measured.keys(), ...base.keys()]);
  for (const k of keys) {
    const have = measured.get(k) ?? 0;
    const allowed = base.get(k) ?? 0;
    if (have === allowed) continue;
    const over = have > allowed;
    if (over === (polarity === "ceiling")) added.push(k);
    else stale.push(k);
  }
  return { added: added.sort(), stale: stale.sort() };
}

/** The one advice renderer: exact rows to add/remove and the PR-body Baseline-raise line. */
function renderAdvice(
  policy: RatchetPolicy,
  d: Diff,
  measured: Counts,
  base: Counts,
  ok: boolean,
): string {
  const lines: string[] = [];
  const rowText = (k: string): string =>
    policy.shape === "set"
      ? display(k)
      : `${display(k)} (baseline ${base.get(k) ?? 0}, measured ${measured.get(k) ?? 0})`;
  if (d.added.length > 0) {
    const verb = policy.polarity === "ceiling" ? "over the baseline" : "under the baseline floor";
    lines.push(`[${policy.id}] ${d.added.length} row(s) ${verb} in ${policy.baseline}:`);
    for (const k of d.added) lines.push(`  - ${rowText(k)}`);
    lines.push(
      policy.polarity === "ceiling"
        ? "Fix the code first so the row disappears."
        : "Restore the measured rows first so the floor holds.",
    );
    lines.push(
      `For reviewed growth ONLY, ${policy.shape === "set" ? "add" : "set"} exactly the row(s) above in ${policy.baseline} ` +
        `(by hand, or \`--write-baseline --allow-grow\` when it moves no other row) and add a PR-body line per row: ` +
        `\`Baseline-raise: ${policy.baseline} <row-key above> — <reason>\` (STD-BASELINE-EDIT-ROWS in CODING_STANDARDS.md).`,
    );
  }
  if (d.stale.length > 0) {
    const what =
      policy.shape === "set"
        ? policy.polarity === "ceiling" ? "remove these rows" : "add these rows"
        : "set these rows to the measured count (drop a row at zero)";
    lines.push(
      `[${policy.id}] ${d.stale.length} stale row(s) in ${policy.baseline}` +
        (policy.stale === "fail" && !ok ? " (fails the verdict)" : " (hint)") +
        `:`,
    );
    for (const k of d.stale) lines.push(`  - ${rowText(k)}`);
    lines.push(
      `Tighten: in ${policy.baseline}, ${what} — only the listed rows (\`--write-baseline\` does exactly this and never loosens).`,
    );
  }
  return lines.join("\n");
}

async function computeVerdict(
  policy: RatchetPolicy,
  root: string,
  scope: RatchetScope | undefined,
): Promise<RatchetVerdict & { counts?: { measured: Counts; base: Counts; full: Counts } }> {
  const fail = (advice: string): RatchetVerdict => ({
    ok: false,
    added: [],
    stale: [],
    advice,
    crashed: true,
    measured: 0,
    baselineRows: 0,
  });
  let measured: Counts;
  let full: Counts;
  try {
    measured = toCounts(await (scope ? scope.measure(root) : policy.measure(root)), policy.shape);
  } catch (err) {
    /* intentional: STD-VERIFY-NEVER-THROW — the cause is returned as {ok:false} advice and main() maps it to exit 2 */
    return fail(`[${policy.id}] measure failed (fail closed): ${describeError(err)}`);
  }
  try {
    const raw = await loadJsonBaseline<unknown>(resolve(root, policy.baseline), policy.shape === "set" ? [] : {}, {
      strict: true,
    });
    full = parseBaseline(raw, policy);
  } catch (err) {
    /* intentional: STD-VERIFY-NEVER-THROW — a corrupt baseline is returned as {ok:false} advice, never thrown */
    return fail(`[${policy.id}] baseline read failed (fail closed): ${describeError(err)}`);
  }
  const base: Counts = scope ? new Map([...full].filter(([k]) => scope.keep(k))) : full;
  const d = diff(measured, base, policy.polarity);
  const ok = d.added.length === 0 && !(policy.stale === "fail" && d.stale.length > 0);
  return {
    ok,
    added: d.added,
    stale: d.stale,
    advice: renderAdvice(policy, d, measured, base, ok),
    measured: total(measured),
    baselineRows: total(base),
    counts: { measured, base, full },
  };
}

async function writeBaseline(
  policy: RatchetPolicy,
  root: string,
  allowGrow: boolean,
): Promise<number> {
  const v = await computeVerdict(policy, root, undefined);
  if (v.crashed || !v.counts) {
    console.error(v.advice);
    return 2;
  }
  if (v.added.length > 0 && !allowGrow) {
    console.error(`[${policy.id}] --write-baseline only tightens; refusing to loosen the baseline:`);
    console.error(v.advice);
    return 1;
  }
  await writeJsonBaseline(resolve(root, policy.baseline), serialise(v.counts.measured, policy.shape), {
    allowGrow: true,
  });
  console.log(`[${policy.id}] baseline written: ${v.measured} row(s)`);
  return 0;
}

export function defineRatchet(policy: RatchetPolicy): Ratchet {
  const verdict = async (root: string = REPO_ROOT, scope?: RatchetScope): Promise<RatchetVerdict> => {
    const { counts: _counts, ...v } = await computeVerdict(policy, root, scope);
    return v;
  };

  const main = async (argv: readonly string[]): Promise<number> => {
    try {
      const flagged = Object.keys(RETIRED_FLAGS).find((f) => argv.includes(f));
      if (flagged) {
        console.error(`[${policy.id}] ${flagged} is retired; use ${RETIRED_FLAGS[flagged]}.`);
        return 2;
      }
      const known = new Set(["--write-baseline", "--allow-grow", ...(policy.extra?.flags ?? [])]);
      const unknown = argv.find((a) => a.startsWith("--") && !known.has(a));
      if (unknown) {
        console.error(`[${policy.id}] unknown flag ${unknown}; known: ${[...known].join(", ")}`);
        return 2;
      }
      const scope = policy.extra?.scope(argv);
      if (argv.includes("--write-baseline")) {
        if (scope) {
          console.error(`[${policy.id}] --write-baseline cannot be combined with a narrowed run`);
          return 2;
        }
        return await writeBaseline(policy, REPO_ROOT, argv.includes("--allow-grow"));
      }
      const v = await verdict(REPO_ROOT, scope);
      if (v.crashed) {
        console.error(v.advice);
        return 2;
      }
      if (!v.ok) {
        console.error(v.advice);
        return 1;
      }
      console.log(
        `[${policy.id}] OK (${v.measured} measured / ${v.baselineRows} baselined row(s)` +
          `${v.stale.length > 0 ? `, ${v.stale.length} stale` : ""}).`,
      );
      if (v.advice) console.log(v.advice);
      return 0;
    } catch (err) {
      console.error(`[${policy.id}] crash:`, err);
      return 2;
    }
  };

  return { policy, verdict, main };
}

/** Run `ratchet.main` only when `moduleUrl` is the process entry point (importing never measures or exits). */
export function runIfCli(moduleUrl: string, ratchet: Ratchet): void {
  if (!isCliEntrypoint(moduleUrl)) return;
  ratchet.main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`[${ratchet.policy.id}] crash:`, err);
      process.exit(2);
    },
  );
}
