#!/usr/bin/env -S npx tsx
/**
 * OpenViking embedding-parity A/B check (issue #3543, epic #3541).
 *
 * The TEI cutover swaps OpenViking's dense-embedding backend from the local
 * Ollama (`ollama-embed`) serving `nomic-embed-text` to a local HF Text
 * Embeddings Inference container (`tei-embed`) serving the same
 * `nomic-embed-text` model at 768 dimensions. The two runtimes load the same
 * model, but a subtly different tokenizer / pooling / normalisation path could
 * shift the produced vectors enough to invalidate the *already-indexed*
 * OpenViking corpus (search compares a fresh query embedding against stored
 * doc embeddings — a backend drift silently degrades recall).
 *
 * This tool is the CUTOVER GATE. It:
 *   1. samples ~200 documents from the OpenViking workspace,
 *   2. embeds each sample through BOTH backends (old Ollama-nomic and new
 *      TEI-nomic) via their OpenAI-compatible `/v1/embeddings`,
 *   3. computes the per-doc cosine similarity between the two vectors, and
 *   4. reports the MEAN per-doc cosine.
 *
 * The decision rule (issue #3543):
 *   - mean cosine >= 0.99  → PARITY. Cut over in place, NO reindex.
 *   - mean cosine <  0.99  → DRIFT. Exit non-zero; the follow-up slice is a
 *     one-time drop+recreate full reindex (indexing-only, zero metered $).
 *
 * DESIGN — pure core + thin I/O driver (mirrors scripts/deploy-drift-logic.ts
 * / scripts/deploy-drift-check.ts). The math and the verdict classification
 * are exported pure functions (`cosineSimilarity`, `summarizeParity`,
 * `DEFAULT_PARITY_THRESHOLD`) so the whole decision surface is unit-testable
 * (test/ov-embed-parity-check.test.mts) without a network, a container, or a
 * live OpenViking. The embedding HTTP calls and the workspace sampling live in
 * the `main()` driver below and are only exercised at runtime.
 *
 * Read-only by contract: this NEVER writes to OpenViking, the vector DB, or
 * the workspace — it only reads a document sample and calls two embedding
 * endpoints. It is a pre-cutover measurement, not a mutation.
 *
 * Env (all optional — sensible localhost/compose defaults):
 *   OV_PARITY_OLLAMA_BASE   old backend /v1 base   (default Ollama-embed)
 *   OV_PARITY_TEI_BASE      new backend /v1 base   (default TEI-embed)
 *   OV_PARITY_MODEL         model name both serve  (default nomic-embed-text)
 *   OV_PARITY_SAMPLE_SIZE   docs to sample         (default 200)
 *   OV_PARITY_THRESHOLD     cutover gate           (default 0.99)
 *   OV_PARITY_WORKSPACE     dir to sample docs from (default OpenViking mount,
 *                           which does NOT exist on a fresh checkout — see
 *                           "Getting a real corpus sample" below)
 *
 * Getting a real corpus sample:
 *   The OpenViking corpus lives inside the `hydra_openviking-data` docker
 *   volume, which the host cannot read directly (root-owned bind path under
 *   /var/lib/docker/volumes/... -> Permission denied). To sample real docs,
 *   stage a copy out via a throwaway container and point OV_PARITY_WORKSPACE
 *   at the staged copy, e.g.:
 *
 *     STAGE=$(mktemp -d)
 *     docker run --rm -v hydra_openviking-data:/src -v "$STAGE":/dst \
 *       alpine cp -r /src/. /dst/
 *     OV_PARITY_WORKSPACE="$STAGE" npx tsx scripts/ov-embed-parity-check.ts
 *
 *   Without this, a default-args run has no workspace to sample from — see
 *   the `workspace-missing` verdict reason below, which is NOT itself a
 *   parity result and must not be read as one.
 *
 * Exit code:
 *   0  → parity met (mean cosine >= threshold) — safe to cut over, no reindex.
 *   1  → parity NOT met (mean cosine < threshold) — reindex required.
 *   2  → could not run the check (no sample, an endpoint unreachable, a
 *        dimension mismatch). A non-runnable check is NOT a green light.
 *        The JSON output's `reason` field discriminates *why*:
 *          - "workspace-missing"   the configured OV_PARITY_WORKSPACE does not
 *            exist / is not a directory — a configuration problem, not a
 *            measured parity failure.
 *          - "no-paired-cosines"   the workspace existed but no doc embedded
 *            successfully on both backends (empty sample or an endpoint down).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/** Cutover gate: at or above this mean per-doc cosine we cut over with no reindex. */
export const DEFAULT_PARITY_THRESHOLD = 0.99;

/** Default number of workspace docs to A/B embed. */
export const DEFAULT_SAMPLE_SIZE = 200;

export type ParityVerdict = "parity" | "drift" | "not-runnable";

/**
 * Discriminates *why* a `not-runnable` verdict was produced. Only set when
 * `verdict === "not-runnable"`. A missing/misconfigured workspace is a
 * configuration problem, not a measured parity result, and must never be
 * indistinguishable from a genuine "sampled but nothing paired" outcome
 * (issue #3854).
 */
export type NotRunnableReason = "workspace-missing" | "no-paired-cosines";

export interface ParitySummary {
  verdict: ParityVerdict;
  /** Mean per-doc cosine across all successfully-paired samples (0 when none). */
  meanCosine: number;
  /** Min per-doc cosine observed (surfaces the worst outlier). */
  minCosine: number;
  /** Number of docs that produced a cosine on both backends. */
  pairedCount: number;
  /** The threshold the mean was compared against. */
  threshold: number;
  /** One-line human summary. */
  message: string;
  /** Only present when verdict is "not-runnable" — see NotRunnableReason. */
  reason?: NotRunnableReason;
}

/**
 * Cosine similarity of two equal-length numeric vectors.
 *
 * Returns a value in [-1, 1]. Returns `null` — never throws — when the inputs
 * cannot yield a meaningful cosine: mismatched lengths (a dimension drift,
 * which is itself a cutover blocker), an empty vector, or a zero-magnitude
 * vector (all-zeros embedding). Callers treat `null` as an unpaired sample.
 *
 * A tiny epsilon guards the denominator so a near-zero (but not exactly zero)
 * magnitude cannot produce Infinity/NaN.
 */
export function cosineSimilarity(
  a: ReadonlyArray<number>,
  b: ReadonlyArray<number>,
): number | null {
  if (a.length === 0 || b.length === 0) return null;
  if (a.length !== b.length) return null; // dimension mismatch — unpairable

  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    dot += x * y;
    magA += x * x;
    magB += y * y;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom < 1e-12) return null; // zero-magnitude vector — no direction to compare
  const cos = dot / denom;
  // Clamp tiny FP overshoot so the result stays in [-1, 1].
  if (cos > 1) return 1;
  if (cos < -1) return -1;
  return cos;
}

/**
 * Classify a set of per-doc cosines into the cutover verdict.
 *
 * Pure: the driver collects the cosines (one per sampled doc that embedded on
 * both backends) and hands them here. Every branch is unit-testable without a
 * network or a live backend.
 *
 *   - `not-runnable` — no paired cosines at all (empty sample, an endpoint
 *     down, or every pair failed on a dimension mismatch). This is NOT parity:
 *     a check that could not measure anything must not green-light a cutover.
 *   - `parity` — mean cosine >= threshold. Cut over in place, no reindex.
 *   - `drift`  — mean cosine <  threshold. Reindex required.
 */
export function summarizeParity(
  cosines: ReadonlyArray<number>,
  threshold: number = DEFAULT_PARITY_THRESHOLD,
): ParitySummary {
  if (cosines.length === 0) {
    return {
      verdict: "not-runnable",
      meanCosine: 0,
      minCosine: 0,
      pairedCount: 0,
      threshold,
      reason: "no-paired-cosines",
      message:
        "embed parity: NOT RUNNABLE — no doc embedded on both backends " +
        "(empty sample or an endpoint unreachable); cannot green-light a cutover",
    };
  }

  let sum = 0;
  let min = Infinity;
  for (const c of cosines) {
    sum += c;
    if (c < min) min = c;
  }
  const mean = sum / cosines.length;

  if (mean >= threshold) {
    return {
      verdict: "parity",
      meanCosine: mean,
      minCosine: min,
      pairedCount: cosines.length,
      threshold,
      message:
        `embed parity: PARITY — mean cosine ${mean.toFixed(5)} >= ${threshold} ` +
        `over ${cosines.length} docs (min ${min.toFixed(5)}); cut over in place, NO reindex`,
    };
  }

  return {
    verdict: "drift",
    meanCosine: mean,
    minCosine: min,
    pairedCount: cosines.length,
    threshold,
    message:
      `embed parity: DRIFT — mean cosine ${mean.toFixed(5)} < ${threshold} ` +
      `over ${cosines.length} docs (min ${min.toFixed(5)}); a drop+recreate full reindex is required`,
  };
}

/**
 * Does `workspace` exist and resolve to a readable directory? Pure(ish) sync
 * fs check — deterministic and unit-testable against real temp paths without
 * any network or container dependency.
 *
 * Returns false for a missing path, a non-directory (e.g. a stray file at
 * that path), or a path that throws on stat (permission denied) — all three
 * are "cannot sample from here", which the caller reports as `workspace-missing`
 * rather than silently falling through to an empty-sample `not-runnable`.
 */
export function checkWorkspace(workspace: string): boolean {
  try {
    return existsSync(workspace) && statSync(workspace).isDirectory();
  } catch {
    /* intentional: unreadable path (e.g. permission denied) -> not usable */
    return false;
  }
}

/**
 * Build the `not-runnable` verdict for a missing/misconfigured workspace.
 * Distinct from the generic empty-cosines `not-runnable` in `summarizeParity`
 * (issue #3854): the message names the exact path so the next operator does
 * not have to rediscover that `OV_PARITY_WORKSPACE` needs pointing at a real
 * corpus sample (see the file header for how to stage one).
 */
export function notRunnableForMissingWorkspace(
  workspace: string,
  threshold: number = DEFAULT_PARITY_THRESHOLD,
): ParitySummary {
  return {
    verdict: "not-runnable",
    meanCosine: 0,
    minCosine: 0,
    pairedCount: 0,
    threshold,
    reason: "workspace-missing",
    message:
      `embed parity: NOT RUNNABLE — workspace not found or not a directory: ` +
      `${workspace}; this is a configuration problem, not a measured parity ` +
      `result. Set OV_PARITY_WORKSPACE to a real corpus sample (see this ` +
      `script's header comment for how to stage one from the ` +
      `hydra_openviking-data docker volume).`,
  };
}

/** Map a verdict to the process exit code (see file header). */
export function exitCodeFor(verdict: ParityVerdict): number {
  switch (verdict) {
    case "parity":
      return 0;
    case "drift":
      return 1;
    case "not-runnable":
      return 2;
  }
}

// ---------------------------------------------------------------------------
// I/O driver (runtime only — not exercised by the unit test, which targets the
// pure functions above). Everything below fails soft: an unreachable endpoint
// or a bad sample yields a `not-runnable` verdict (exit 2), never a crash.
// ---------------------------------------------------------------------------

const OLLAMA_BASE =
  process.env.OV_PARITY_OLLAMA_BASE || "http://localhost:11434/v1";
const TEI_BASE = process.env.OV_PARITY_TEI_BASE || "http://localhost:8080/v1";
const MODEL = process.env.OV_PARITY_MODEL || "nomic-embed-text";
const SAMPLE_SIZE = Number(process.env.OV_PARITY_SAMPLE_SIZE || DEFAULT_SAMPLE_SIZE);
const THRESHOLD = Number(process.env.OV_PARITY_THRESHOLD || DEFAULT_PARITY_THRESHOLD);
const WORKSPACE = resolve(
  process.env.OV_PARITY_WORKSPACE ||
    join(process.env.HOME || "/home/gabe", "hydra", "workspace"),
);

const EMBED_TIMEOUT_MS = 15000;

/**
 * POST one input to an OpenAI-compatible `/v1/embeddings` and return the dense
 * vector. Returns null on any failure (endpoint down, non-2xx, malformed body)
 * so the caller can skip the sample rather than crash the whole run.
 */
async function embedOne(base: string, input: string): Promise<number[] | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), EMBED_TIMEOUT_MS);
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, input }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const body: any = await res.json();
    const vec = body?.data?.[0]?.embedding;
    return Array.isArray(vec) && vec.every((n: unknown) => typeof n === "number")
      ? (vec as number[])
      : null;
  } catch {
    /* intentional: endpoint unreachable / abort / parse -> skip this sample */
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Read up to `limit` document texts from the workspace tree. Best-effort: any
 * unreadable file is skipped, and a missing/empty workspace yields []. Only
 * plain-text-ish files are sampled; oversized files are truncated to keep the
 * embed request bounded.
 */
function sampleDocs(workspace: string, limit: number): string[] {
  const MAX_CHARS = 8000;
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (out.length >= limit) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      /* intentional: unreadable dir -> skip */
      return;
    }
    for (const name of entries) {
      if (out.length >= limit) return;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        /* intentional: unreadable entry -> skip */
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile() && st.size > 0) {
        try {
          const text = readFileSync(full, "utf8").trim();
          if (text.length > 0) out.push(text.slice(0, MAX_CHARS));
        } catch {
          /* intentional: binary / unreadable -> skip */
        }
      }
    }
  };
  walk(workspace);
  return out;
}

async function main(): Promise<number> {
  if (!checkWorkspace(WORKSPACE)) {
    // Distinct from the generic empty-sample not-runnable below: this is a
    // configuration problem (missing/misconfigured OV_PARITY_WORKSPACE), not
    // a measured parity result, and the JSON's `reason` field says so.
    const summary = notRunnableForMissingWorkspace(WORKSPACE, THRESHOLD);
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return exitCodeFor(summary.verdict);
  }

  const docs = sampleDocs(WORKSPACE, SAMPLE_SIZE);
  if (docs.length === 0) {
    const summary = summarizeParity([], THRESHOLD);
    process.stdout.write(
      JSON.stringify(
        { ...summary, note: `no documents sampled from ${WORKSPACE}` },
        null,
        2,
      ) + "\n",
    );
    return exitCodeFor(summary.verdict);
  }

  const cosines: number[] = [];
  for (const doc of docs) {
    const [va, vb] = await Promise.all([
      embedOne(OLLAMA_BASE, doc),
      embedOne(TEI_BASE, doc),
    ]);
    if (!va || !vb) continue;
    const cos = cosineSimilarity(va, vb);
    if (cos !== null) cosines.push(cos);
  }

  const summary = summarizeParity(cosines, THRESHOLD);
  process.stdout.write(
    JSON.stringify(
      { ...summary, sampled: docs.length, ollamaBase: OLLAMA_BASE, teiBase: TEI_BASE },
      null,
      2,
    ) + "\n",
  );
  return exitCodeFor(summary.verdict);
}

// Only run the driver when invoked directly (not when imported by the test).
if (
  process.argv[1] &&
  (process.argv[1].endsWith("ov-embed-parity-check.ts") ||
    process.argv[1].endsWith("ov-embed-parity-check"))
) {
  main()
    .then(code => process.exit(code))
    .catch(err => {
      console.error(`[ov-embed-parity] unexpected error: ${err?.stack ?? err}`);
      process.exit(2);
    });
}
