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
 *       manifest: { ok: true, appSubdir, surface, surfaceRepoRelative, verify }
 *                | { ok: false, errors } }
 *
 *   --sh       shell `export` statements on stdout (consumed via
 *              `eval "$(npx tsx scripts/target/print-target-facts.ts --sh)"`
 *              from the shared `_fragments/target-seam-preamble.md`):
 *                TARGET_NAME, TARGET_GH_REPO, TARGET_WS, TARGET_SERVICE,
 *                TARGET_WEB_URL, TARGET_APP_SUBDIR, TARGET_APP_DIR,
 *                TARGET_RISK_SURFACE_JSON, and the manifest's verify commands
 *                TARGET_VERIFY_INSTALL / _TEST / _TYPECHECK / _BUILD / _LINT
 *                (`_LINT` is the empty string when the manifest declares no
 *                lint gate)
 *              On a manifest failure this mode prints NOTHING exportable and
 *              exits 1 — the fragment's `eval "$(...)" || exit 1` then aborts
 *              the playbook loudly instead of running with an empty/guessed
 *              carve-out (fail closed, mirrors decide.py's INV-3).
 *
 *   --manifest-root <dir>
 *              read `<dir>/.hydra/manifest.json` instead of the workspace's
 *              copy (precedence over `TARGET_MANIFEST_ROOT`). A Target build
 *              passes its worktree, so the verify commands and appSubdir come
 *              from the branch it is building while `TARGET_WS` stays the main
 *              checkout. The flag without a value exits 1 with nothing on
 *              stdout (fail closed).
 *
 * CAPABILITIES (issue #5498)
 * ---------------------------
 * The CLI additionally reports what the Target OFFERS (smoke script, dead-code
 * scripts/baseline, wiring ledger, health route, agent/domain docs) via
 * `target-capabilities.ts` — a `capabilities` key in JSON mode and additive
 * `TARGET_CAP_*` + `TARGET_CAPABILITIES_JSON` exports in `--sh` mode (empty
 * string = absent). `collectTargetFacts()` itself is unchanged; capabilities
 * are composed only at the CLI boundary ({@link main}).
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
import { loadManifest } from "../../src/target/manifest.ts";
import { resolveManifestRoot } from "./target-risk-surface.ts";
import {
  probeTargetCapabilities,
  renderCapabilityShell,
  shQuote,
  type TargetCapabilities,
} from "./target-capabilities.ts";

/** The Target Manifest's verify commands; `lint` is "" when the manifest declares none. */
export type TargetVerifyCommands = {
  install: string;
  test: string;
  typecheck: string;
  build: string;
  lint: string;
};

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
        verify: TargetVerifyCommands;
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

  const loaded = loadManifest(manifestRoot);
  if (loaded.ok === false) {
    return { ...base, manifest: { ok: false, errors: loaded.errors } };
  }

  const { verify, riskCritical } = loaded.manifest;
  return {
    ...base,
    manifest: {
      ok: true,
      appSubdir: verify.appSubdir,
      surface: [...riskCritical.surface],
      surfaceRepoRelative: riskCritical.surface.map((e) => toRepoRelative(verify.appSubdir, e)),
      verify: {
        install: verify.install,
        test: verify.test,
        typecheck: verify.typecheck,
        build: verify.build,
        lint: verify.lint ?? "",
      },
    },
  };
}

/**
 * Render the `--sh` mode output: one `export` statement per fact, plus
 * `TARGET_APP_DIR` (workspace joined with appSubdir),
 * `TARGET_RISK_SURFACE_JSON` (the repo-relative surface, JSON-encoded) and one
 * `TARGET_VERIFY_*` export per manifest verify command.
 * Returns `null` when the manifest failed to resolve — the caller then
 * prints nothing exportable and exits 1 (fail closed).
 */
export function renderShell(facts: TargetFacts): string | null {
  if (facts.manifest.ok === false) return null;
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
    `export TARGET_VERIFY_INSTALL=${shQuote(facts.manifest.verify.install)}`,
    `export TARGET_VERIFY_TEST=${shQuote(facts.manifest.verify.test)}`,
    `export TARGET_VERIFY_TYPECHECK=${shQuote(facts.manifest.verify.typecheck)}`,
    `export TARGET_VERIFY_BUILD=${shQuote(facts.manifest.verify.build)}`,
    `export TARGET_VERIFY_LINT=${shQuote(facts.manifest.verify.lint)}`,
  ];
  return lines.join("\n");
}

/**
 * The `--manifest-root <dir>` value: `undefined` when the flag is absent, `null`
 * when it is present without a value (a usage error the caller fails closed on).
 */
export function parseManifestRootFlag(argv: readonly string[]): string | null | undefined {
  const at = argv.indexOf("--manifest-root");
  if (at === -1) return undefined;
  const value = argv[at + 1];
  if (value === undefined || value.startsWith("--") || value.trim() === "") return null;
  return value;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const shMode = argv.includes("--sh");
  const manifestRoot = parseManifestRootFlag(argv);
  if (manifestRoot === null) {
    process.stderr.write("print-target-facts: --manifest-root needs a directory\n");
    return 1;
  }
  const facts = collectTargetFacts(manifestRoot ?? resolveManifestRoot());
  const appDir =
    facts.manifest.ok && facts.manifest.appSubdir
      ? `${facts.workspace}/${facts.manifest.appSubdir}`
      : facts.workspace;
  // Manifest failure degrades to probing the bare workspace (positive-evidence-only).
  const capabilities: TargetCapabilities = probeTargetCapabilities({ workspace: facts.workspace, appDir });

  if (shMode) {
    const rendered = renderShell(facts);
    if (rendered === null) {
      const errors = facts.manifest.ok === false ? facts.manifest.errors : [];
      process.stderr.write(
        `print-target-facts: target risk surface unresolved — ${errors.join("; ") || "unknown error"}\n`,
      );
      return 1;
    }
    const capShell = "\n" + renderCapabilityShell(capabilities);
    process.stdout.write(rendered + capShell + "\n");
    return 0;
  }

  process.stdout.write(JSON.stringify({ ...facts, capabilities }) + "\n");
  return facts.manifest.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code)).catch((err) => {
    process.stderr.write(`Unexpected error: ${err?.message ?? err}\n${err?.stack ?? ""}\n`);
    process.exit(1);
  });
}
