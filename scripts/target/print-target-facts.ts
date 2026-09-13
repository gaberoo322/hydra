#!/usr/bin/env -S npx tsx
/**
 * print-target-facts — the single seam through which every `hydra-target-*`
 * (+ `hydra-wire-or-retire`) playbook resolves Target identity + risk-surface
 * facts (issue #4411, item (2) of wayfinder ticket #4324 on map #4313).
 *
 * WHY THIS EXISTS
 * ---------------
 * Before this script, eight prose playbooks hardcoded `gaberoo322/hydra-betting`,
 * `~/hydra-betting`, `~/hydra-betting/web`, `hydra-betting-web.service`,
 * `:3333`, and `decide.py` hardcoded a `web/`-nested risk-carveout tuple
 * (`WIRE_OR_RETIRE_RISK_CARVEOUT`) — all wrong the moment the Target swaps
 * (ADR-0013 Decision 4). Every default already lives in ONE place,
 * `src/target-config.ts` (ADR-0002); this script is the thin composition
 * layer a *playbook's shell* can consume — `npx tsx` from a prose block, not
 * a TypeScript import — plus the risk surface from the Target Manifest
 * (`scripts/target/target-risk-surface.ts`, ADR-0026).
 *
 * TWO OUTPUT MODES
 * ----------------
 *   (default) one JSON object on stdout:
 *     { name, githubRepo, workspace, serviceName, webUrl,
 *       manifest: { ok: true, appSubdir, surface, surfaceRepoRelative }
 *                | { ok: false, errors } }
 *
 *   --sh       shell `export` statements on stdout (consumed via
 *              `eval "$(npx tsx scripts/target/print-target-facts.ts --sh)"`
 *              from the shared `_fragments/target-seam-preamble.md`):
 *                TARGET_NAME, TARGET_GH_REPO, TARGET_WS, TARGET_SERVICE,
 *                TARGET_WEB_URL, TARGET_APP_SUBDIR, TARGET_APP_DIR,
 *                TARGET_RISK_SURFACE_JSON
 *              On a manifest failure this mode prints NOTHING exportable and
 *              exits 1 — the fragment's `eval "$(...)" || exit 1` then aborts
 *              the playbook loudly instead of running with an empty/guessed
 *              carve-out (fail closed, mirrors decide.py's INV-3).
 *
 * NORMALIZATION (decide.py Invariant 2)
 * --------------------------------------
 * The Target Manifest's `riskCritical.surface` entries are appSubdir-stripped
 * (e.g. `src/lib/execution/`), but the module paths `hydra-wire-or-retire`
 * and `decide.py`'s dispatch consumers reason about are repo-relative (e.g.
 * `web/src/lib/execution/`). `surfaceRepoRelative` does that join ONCE, here,
 * in TypeScript — decide.py performs no path logic of its own:
 *
 *     surfaceRepoRelative[i] = appSubdir
 *       ? appSubdir.replace(/\/+$/, "") + "/" + surface[i]
 *       : surface[i]
 *
 * `appSubdir: ""` (the successor Target's declared shape, ADR-0013 amendment)
 * is the identity — `surfaceRepoRelative` then equals `surface` verbatim.
 * Trailing slashes on each `surface` entry are preserved so prefix-matching
 * semantics in the consumer are unchanged.
 *
 * NEVER THROWS
 * ------------
 * Every failure (manifest missing/malformed) is reported as
 * `{ ok: false, errors }` in JSON mode, or a non-exportable `--sh` output +
 * exit 1 — never an uncaught exception. Fail-loud/fail-closed per CLAUDE.md
 * and ADR-0026 decision 7.
 */
import {
  getTargetName,
  getTargetGithubRepo,
  getTargetWorkspace,
  getTargetServiceName,
  getTargetWebUrl,
} from "../../src/target-config.ts";
import { loadRiskSurface, resolveManifestRoot } from "./target-risk-surface.ts";

/** The JSON shape this script emits in default (non-`--sh`) mode. */
export type TargetFacts = {
  name: string;
  githubRepo: string;
  workspace: string;
  serviceName: string;
  webUrl: string;
  manifest:
    | {
        ok: true;
        appSubdir: string;
        surface: string[];
        surfaceRepoRelative: string[];
      }
    | { ok: false; errors: string[] };
};

/**
 * Join an appSubdir-stripped manifest surface path back onto its repo-relative
 * form. `appSubdir === ""` is the identity (successor Target shape); trailing
 * slashes on `entry` are preserved verbatim.
 */
export function toRepoRelative(appSubdir: string, entry: string): string {
  if (!appSubdir) return entry;
  return `${appSubdir.replace(/\/+$/, "")}/${entry}`;
}

/** Compose every Target fact into the {@link TargetFacts} shape. Never throws. */
export function collectTargetFacts(manifestRoot: string = resolveManifestRoot()): TargetFacts {
  const base = {
    name: getTargetName(),
    githubRepo: getTargetGithubRepo(),
    workspace: getTargetWorkspace(),
    serviceName: getTargetServiceName(),
    webUrl: getTargetWebUrl(),
  };

  const risk = loadRiskSurface(manifestRoot);
  if (!risk.ok) {
    return { ...base, manifest: { ok: false, errors: risk.errors } };
  }

  return {
    ...base,
    manifest: {
      ok: true,
      appSubdir: risk.appSubdir,
      surface: risk.surface,
      surfaceRepoRelative: risk.surface.map((e) => toRepoRelative(risk.appSubdir, e)),
    },
  };
}

/** POSIX-safe single-quote shell escaping: `it's` → `'it'\''s'`. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Render the `--sh` mode output: one `export` statement per fact, plus
 * `TARGET_APP_DIR` (workspace joined with appSubdir) and
 * `TARGET_RISK_SURFACE_JSON` (the repo-relative surface, JSON-encoded).
 * Returns `null` when the manifest failed to resolve — the caller then
 * prints nothing exportable and exits 1 (fail closed).
 */
export function renderShell(facts: TargetFacts): string | null {
  if (!facts.manifest.ok) return null;
  const appDir = facts.manifest.appSubdir
    ? `${facts.workspace}/${facts.manifest.appSubdir}`
    : facts.workspace;
  const lines = [
    `export TARGET_NAME=${shQuote(facts.name)}`,
    `export TARGET_GH_REPO=${shQuote(facts.githubRepo)}`,
    `export TARGET_WS=${shQuote(facts.workspace)}`,
    `export TARGET_SERVICE=${shQuote(facts.serviceName)}`,
    `export TARGET_WEB_URL=${shQuote(facts.webUrl)}`,
    `export TARGET_APP_SUBDIR=${shQuote(facts.manifest.appSubdir)}`,
    `export TARGET_APP_DIR=${shQuote(appDir)}`,
    `export TARGET_RISK_SURFACE_JSON=${shQuote(JSON.stringify(facts.manifest.surfaceRepoRelative))}`,
  ];
  return lines.join("\n");
}

async function main(): Promise<number> {
  const shMode = process.argv.slice(2).includes("--sh");
  const facts = collectTargetFacts();

  if (shMode) {
    const rendered = renderShell(facts);
    if (rendered === null) {
      const errors = !facts.manifest.ok ? facts.manifest.errors : [];
      process.stderr.write(
        `print-target-facts: target risk surface unresolved — ${errors.join("; ") || "unknown error"}\n`,
      );
      return 1;
    }
    process.stdout.write(rendered + "\n");
    return 0;
  }

  process.stdout.write(JSON.stringify(facts) + "\n");
  return facts.manifest.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code)).catch((err) => {
    process.stderr.write(`Unexpected error: ${err?.message ?? err}\n${err?.stack ?? ""}\n`);
    process.exit(1);
  });
}
