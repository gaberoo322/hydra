/**
 * scripts/qa/cohort-baseline.ts — S0 of the two-pass review rollout (issue
 * #5256, ADR-0046 Decisions 6 and 8).
 *
 * A zero-token, READ-ONLY measurement: rounds/PR, first-FAIL rate, tokens per
 * review and the 14-day escaped-defect cohort comparison, folded from GitHub
 * `QA-Verdict:` trailers. It ships no lever — it never comments, labels,
 * writes Redis, calls a model, or acts on `tripped` / `criteriaMet` (S3 reads
 * that output). The only file it may write is
 * `test/fixtures/qa-cohort-baseline.json`, under `--write-baseline`.
 *
 * Layout mirrors scripts/ci/qa-catch-rate.ts: pure exported fold functions
 * (`measureCohort`, never throws) plus an isMain CLI. Trailer grammar is
 * imported from src/qa/verdict-trailer.ts, never re-implemented; nothing here
 * imports src/qa/fold.ts.
 *
 *   npx tsx scripts/qa/cohort-baseline.ts                          # live, stdout
 *   npx tsx scripts/qa/cohort-baseline.ts --write-baseline         # live, refresh fixture
 *   npx tsx scripts/qa/cohort-baseline.ts --from-inputs test/fixtures/qa-cohort-baseline.json
 *
 * Escaped defect (deterministic, never agent-judged): a merged PR that within
 * 14 days gets a revert PR, a fix PR, or a `Post-mortem:` issue naming it.
 */

import {
  isFailVerdict,
  parseQaVerdictTrailers,
  type QaVerdictTrailer,
} from "../../src/qa/verdict-trailer.ts";

export const SCHEMA_VERSION = 1;
/** The #4917 merge — after it every verdict carries a canonical trailer. */
export const DEFAULT_SINCE = "2026-10-06T21:25:53Z";
export const MATURITY_DAYS = 14;
export const MIN_MATURED_PAIR = 30;
export const BASELINE_FIXTURE_PATH = "test/fixtures/qa-cohort-baseline.json";
export const TOKENS_SOURCE = "api/usage/by-issue";

const DAY_MS = 24 * 60 * 60 * 1000;

export type Cohort = "baseline" | "pair";
export type EscapeKind = "revert" | "fix-pr" | "post-mortem";

/** A merged PR row, body-free. */
export interface PrRow {
  number: number;
  mergedAt: string;
  title: string;
  cohort: Cohort;
  trailers: QaVerdictTrailer[];
}

/** A later PR / issue that may cite a measured PR. */
export interface ItemRow {
  number: number;
  kind: "pr" | "issue";
  createdAt: string;
  mergedAt: string | null;
  title: string;
  isRevert: boolean;
  isFix: boolean;
  isPostMortem: boolean;
  mentions: number[];
}

export interface CohortInputs {
  prs: PrRow[];
  items: ItemRow[];
  /** ISO instant; PRs merged within MATURITY_DAYS of it are `pending`. */
  until: string;
  tokens: { qaOrchTokens: number | null; attributedPercent: number | null };
}

export interface EscapeEvidence {
  pr: number;
  kind: EscapeKind;
  by: number;
  high: boolean;
}

export interface CohortStats {
  matured: number;
  escaped: number;
  highEscapes: number;
  rate: number | null;
}

export interface CohortMetrics {
  reviewed: number;
  roundsPerPr: number | null;
  firstFailRate: number | null;
  tokensPerReview: {
    value: number | null;
    source: string;
    attributedPercent: number | null;
  };
  cohorts: { baseline: CohortStats; pair: CohortStats };
  pending: number[];
  escapes: EscapeEvidence[];
  tripped: boolean;
  criteriaMet: boolean;
}

export interface CohortResult {
  metrics: CohortMetrics;
  warnings: string[];
}

const ratio = (n: number, d: number): number | null => (d > 0 ? n / d : null);

/** Word-bounded `#N` tokens in a text (never the digits inside `#12345`). */
export function extractMentions(text: string | null | undefined): number[] {
  if (typeof text !== "string") return [];
  const out = new Set<number>();
  for (const m of text.matchAll(/(?<![\w#])#(\d+)\b/g)) {
    const n = Number.parseInt(m[1] as string, 10);
    if (n > 0) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

export function isRevertTitleOrBody(title: string, body: string | null | undefined): boolean {
  return /^revert\b/i.test(title) || /This reverts commit/.test(body ?? "");
}
export function isFixTitle(title: string): boolean {
  return /^fix(\(|:|!)/.test(title);
}
export function isPostMortemTitle(title: string): boolean {
  return /^Post-mortem:/.test(title);
}

function parseMs(s: unknown): number {
  return typeof s === "string" ? Date.parse(s) : Number.NaN;
}

/** Rounds on one PR: one trailer = one round, PASS collapses into a same-sha PASS-pending-CI. */
export function roundsOf(trailers: QaVerdictTrailer[]): {
  rounds: number;
  firstFail: boolean;
} {
  const seen = new Set<string>();
  const uniq: QaVerdictTrailer[] = [];
  for (const t of trailers) {
    const key = `${t.verdict}|${t.round}|${t.sha}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(t);
  }
  uniq.sort((a, b) => a.round - b.round);
  const pendingShas = new Set<string>();
  let rounds = 0;
  for (const t of uniq) {
    if (t.verdict === "PASS" && pendingShas.has(t.sha)) continue;
    if (t.verdict === "PASS-pending-CI") pendingShas.add(t.sha);
    rounds += 1;
  }
  return {
    rounds,
    firstFail: uniq.length > 0 && isFailVerdict((uniq[0] as QaVerdictTrailer).verdict),
  };
}

function emptyStats(): CohortStats {
  return { matured: 0, escaped: 0, highEscapes: 0, rate: null };
}

/** Pure fold of body-free rows into metrics. NEVER throws; malformed rows warn. */
export function measureCohort(inputs: CohortInputs): CohortResult {
  const warnings: string[] = [];
  const untilMs = parseMs(inputs?.until);
  const rawPrs = Array.isArray(inputs?.prs) ? inputs.prs : [];
  const rawItems = Array.isArray(inputs?.items) ? inputs.items : [];
  if (Number.isNaN(untilMs)) warnings.push("inputs.until missing or unparsable; no PR is matured");

  const prs: PrRow[] = [];
  const seenPr = new Set<number>();
  for (const [i, p] of rawPrs.entries()) {
    const label = `prs[${i}]${p && typeof p.number === "number" ? ` #${p.number}` : ""}`;
    if (!p || !Number.isInteger(p.number) || p.number < 1) {
      warnings.push(`${label}: missing number, skipped`);
    } else if (Number.isNaN(parseMs(p.mergedAt))) {
      warnings.push(`${label}: missing or unparsable mergedAt, skipped`);
    } else if (p.cohort !== "baseline" && p.cohort !== "pair") {
      warnings.push(`${label}: unknown cohort tag ${JSON.stringify(p.cohort)}, skipped`);
    } else if (seenPr.has(p.number)) {
      warnings.push(`${label}: duplicate PR row, skipped`);
    } else {
      seenPr.add(p.number);
      prs.push(p);
    }
  }
  const items: ItemRow[] = [];
  for (const [i, it] of rawItems.entries()) {
    const label = `items[${i}]${it && typeof it.number === "number" ? ` #${it.number}` : ""}`;
    if (!it || !Number.isInteger(it.number) || it.number < 1) {
      warnings.push(`${label}: missing number, skipped`);
    } else if (Number.isNaN(parseMs(it.createdAt))) {
      warnings.push(`${label}: missing or unparsable createdAt, skipped`);
    } else {
      items.push(it);
    }
  }

  const ownTrailers = (p: PrRow): QaVerdictTrailer[] =>
    (Array.isArray(p.trailers) ? p.trailers : []).filter((t) => t.pr === p.number);

  // Reviewed PRs: at least one trailer naming the PR (INV-2: pr= must match).
  let reviewed = 0;
  let roundSum = 0;
  let firstFails = 0;
  for (const p of prs) {
    const own = ownTrailers(p);
    if (own.length === 0) continue;
    const r = roundsOf(own);
    reviewed += 1;
    roundSum += r.rounds;
    if (r.firstFail) firstFails += 1;
  }

  const stats = { baseline: emptyStats(), pair: emptyStats() };
  const pending: number[] = [];
  const escapes: EscapeEvidence[] = [];
  for (const p of prs) {
    if (ownTrailers(p).length === 0) continue; // cohorts are trailer-reviewed PRs only
    const mergedMs = parseMs(p.mergedAt);
    if (Number.isNaN(untilMs) || mergedMs + MATURITY_DAYS * DAY_MS > untilMs) {
      pending.push(p.number);
      continue;
    }
    const s = stats[p.cohort];
    s.matured += 1;
    const hits = new Map<string, EscapeEvidence>();
    for (const it of items) {
      if (it.number === p.number) continue;
      const created = parseMs(it.createdAt);
      if (!(created > mergedMs && created <= mergedMs + MATURITY_DAYS * DAY_MS)) continue;
      if (!Array.isArray(it.mentions) || !it.mentions.includes(p.number)) continue;
      let kind: EscapeKind | null = null;
      if (it.kind === "pr" && it.mergedAt && it.isRevert) kind = "revert";
      else if (it.kind === "pr" && it.mergedAt && it.isFix) kind = "fix-pr";
      else if (it.kind === "issue" && it.isPostMortem) kind = "post-mortem";
      if (kind === null) continue;
      hits.set(`${kind}:${it.number}`, {
        pr: p.number,
        kind,
        by: it.number,
        high: kind !== "fix-pr",
      });
    }
    if (hits.size > 0) {
      s.escaped += 1;
      const list = [...hits.values()].sort((a, b) => a.by - b.by);
      if (list.some((h) => h.high)) s.highEscapes += 1;
      escapes.push(...list);
    }
  }
  for (const c of ["baseline", "pair"] as const) {
    stats[c].rate = ratio(stats[c].escaped, stats[c].matured);
  }
  pending.sort((a, b) => a - b);
  escapes.sort((a, b) => a.pr - b.pr || a.by - b.by);

  const pair = stats.pair;
  const base = stats.baseline;
  const enough = pair.matured >= MIN_MATURED_PAIR;
  const worse = pair.rate !== null && base.rate !== null && pair.rate > base.rate;
  const tripped = enough && (worse || pair.highEscapes > 0);
  const criteriaMet = enough && !tripped;

  const tok = inputs?.tokens ?? { qaOrchTokens: null, attributedPercent: null };
  const attributed = typeof tok.attributedPercent === "number" ? tok.attributedPercent : null;
  let tokenValue: number | null = null;
  if (
    typeof tok.qaOrchTokens === "number" &&
    Number.isFinite(tok.qaOrchTokens) &&
    attributed !== null &&
    attributed > 0 &&
    reviewed > 0
  ) {
    tokenValue = Math.round(tok.qaOrchTokens / reviewed);
  } else {
    warnings.push(
      `tokensPerReview is null: ${
        attributed === null
          ? "usage API unreachable"
          : attributed <= 0
            ? "attributedPercent is 0"
            : "no reviewed PRs or tokens"
      }`,
    );
  }

  return {
    metrics: {
      reviewed,
      roundsPerPr: ratio(roundSum, reviewed),
      firstFailRate: ratio(firstFails, reviewed),
      tokensPerReview: { value: tokenValue, source: TOKENS_SOURCE, attributedPercent: attributed },
      cohorts: { baseline: base, pair },
      pending,
      escapes,
      tripped,
      criteriaMet,
    },
    warnings,
  };
}

/** JSON with recursively sorted object keys — stable across runs. */
export function stableStringify(value: unknown): string {
  const sort = (v: any): any => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, sort(v[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(value), null, 2) + "\n";
}

/**
 * The single cohort-tagging seam (INV-12). The review pair has never reviewed
 * a PR, so every PR is `baseline` today; P2 (#5264) replaces this one
 * function's source when it defines how a pair-reviewed PR is marked.
 */
export function cohortOf(_pr: { number: number }): Cohort {
  return "baseline";
}

// ---------------------------------------------------------------------------
// Harvester (GitHub REST via the GitHub CLI Adapter) — CLI only
// ---------------------------------------------------------------------------

interface RestIssue {
  number: number;
  title: string;
  body: string | null;
  created_at: string;
  pull_request?: { merged_at: string | null };
}

export class HarvestError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function harvest(repo: string, since: string, until: string): Promise<CohortInputs> {
  // Dynamic import keeps the pure fold above free of Redis/logger side effects.
  const { ghJson } = await import("../../src/github/gh.ts");
  const { closedIssues } = await import("../../src/github/pr-refs.ts");
  const opts = { timeout: 300_000, maxBuffer: 256 * 1024 * 1024 };

  const get = async <T>(path: string): Promise<T[]> => {
    const res = await ghJson<T[][]>(["api", path, "--paginate", "--slurp"], opts);
    if (res.ok === false) {
      throw new HarvestError(res.code, `gh api ${path} failed: ${res.code}`);
    }
    return res.data.flat();
  };

  const all = await get<RestIssue>(
    `repos/${repo}/issues?state=all&since=${encodeURIComponent(since)}&per_page=100`,
  );
  const sinceMs = Date.parse(since);
  const untilMs = Date.parse(until);
  const prs: PrRow[] = [];
  const items: ItemRow[] = [];
  const closing = new Set<number>();
  for (const it of all) {
    const mergedAt = it.pull_request?.merged_at ?? null;
    const mentions = extractMentions(`${it.title}\n${it.body ?? ""}`).filter(
      (n) => n !== it.number,
    );
    const isRevert = it.pull_request ? isRevertTitleOrBody(it.title, it.body) : false;
    const isFix = it.pull_request ? isFixTitle(it.title) : false;
    const isPostMortem = !it.pull_request && isPostMortemTitle(it.title);
    if (mentions.length > 0 && (isRevert || isFix || isPostMortem)) {
      items.push({
        number: it.number,
        kind: it.pull_request ? "pr" : "issue",
        createdAt: it.created_at,
        mergedAt,
        title: it.title,
        isRevert,
        isFix,
        isPostMortem,
        mentions,
      });
    }
    if (
      it.pull_request &&
      mergedAt &&
      Date.parse(mergedAt) >= sinceMs &&
      Date.parse(mergedAt) <= untilMs
    ) {
      const comments = await get<{ body: string | null }>(
        `repos/${repo}/issues/${it.number}/comments?per_page=100`,
      );
      const reviews = await get<{ body: string | null }>(
        `repos/${repo}/pulls/${it.number}/reviews?per_page=100`,
      );
      const trailers = [...comments, ...reviews]
        .flatMap((c) => parseQaVerdictTrailers(c.body))
        .filter((t) => t.pr === it.number);
      prs.push({ number: it.number, mergedAt, title: it.title, cohort: cohortOf(it), trailers });
      if (trailers.length > 0) {
        for (const n of closedIssues([{ body: it.body }])) closing.add(n);
      }
    }
  }
  prs.sort((a, b) => a.number - b.number);
  items.sort((a, b) => a.number - b.number);

  let tokens: CohortInputs["tokens"] = { qaOrchTokens: null, attributedPercent: null };
  try {
    const base = "http://localhost:4000";
    const resp = await fetch(`${base}/api/usage/by-issue`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.ok) {
      const j: any = await resp.json();
      let sum = 0;
      for (const row of j.byIssue ?? []) {
        if (closing.has(row.issue)) sum += Number(row.byClass?.qa_orch ?? 0);
      }
      tokens = { qaOrchTokens: sum, attributedPercent: Number(j.attributedPercent ?? 0) };
    } else {
      console.error(
        `[cohort-baseline] usage API returned HTTP ${resp.status}; tokensPerReview will be null`,
      );
    }
  } catch (err) {
    console.error("[cohort-baseline] usage API unreachable; tokensPerReview will be null:", err);
  }
  return { prs, items, until, tokens };
}

const isMain = (() => {
  try {
    return (
      Array.isArray(process.argv) &&
      process.argv[1] !== undefined &&
      import.meta.url === `file://${process.argv[1]}`
    );
  } catch {
    /* intentional: import.meta unavailable outside a module host — not the CLI */
    return false;
  }
})();

if (isMain) {
  const fs = await import("node:fs");
  const arg = (flag: string): string | null => {
    const i = process.argv.indexOf(flag);
    return i === -1 || i === process.argv.length - 1 ? null : (process.argv[i + 1] as string);
  };
  const has = (flag: string): boolean => process.argv.includes(flag);
  const repo = arg("--repo") ?? "gaberoo322/hydra";
  const since = arg("--since") ?? DEFAULT_SINCE;
  const until = arg("--until") ?? new Date().toISOString();
  const fromInputs = arg("--from-inputs");

  let inputs: CohortInputs;
  if (fromInputs !== null) {
    inputs = JSON.parse(fs.readFileSync(fromInputs, "utf8")).inputs as CohortInputs;
  } else {
    try {
      inputs = await harvest(repo, since, until);
    } catch (err) {
      const code = err instanceof HarvestError ? err.code : "harvest-failed";
      console.error(`[cohort-baseline] ${code}: ${(err as Error).message}`);
      process.exit(1);
    }
  }
  const { metrics, warnings } = measureCohort(inputs);
  for (const w of warnings) console.error(`[cohort-baseline] warning: ${w}`);
  const doc = {
    schemaVersion: SCHEMA_VERSION,
    measuredAt: new Date().toISOString(),
    window: { since, until: inputs.until, repo },
    inputs,
    metrics,
  };
  if (has("--write-baseline") && fromInputs === null) {
    fs.writeFileSync(BASELINE_FIXTURE_PATH, stableStringify(doc));
    console.error(`[cohort-baseline] wrote ${BASELINE_FIXTURE_PATH}`);
    process.exit(0);
  } else {
    process.stdout.write(stableStringify(doc), () => process.exit(0));
    // Exit only after stdout flushes; the gh adapter Redis side-channel keeps the loop alive.
  }
}
