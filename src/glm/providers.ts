/**
 * src/glm/providers.ts — the GLM dev-drainer's ordered WORKER PROVIDER list
 * (issue #4841; ADR-0032 as amended).
 *
 * The drainer authors on an ordered list of Anthropic-compatible backends and
 * falls through to the next one when the first is quota-blocked. This module
 * is the single home of the list's policy:
 *
 *   - the zod schema ({@link parseWorkerProviders}) — pure `safeParse`, the
 *     source of truth for both the parser and the inferred type;
 *   - the model fence ({@link checkProviderModel}) — ADR-0032 invariant 4
 *     generalised: a model is launchable iff it EXACTLY equals a configured
 *     provider's model AND is neither an Anthropic slot alias nor `claude-*`
 *     (those bypass `ANTHROPIC_BASE_URL` and bill Anthropic, issue #3758);
 *   - first-unblocked selection ({@link selectProvider});
 *   - the metering prefix derivation ({@link foreignPrefixesFor}).
 *
 * Everything here is pure and never throws, except the two clearly-named file
 * loaders at the bottom, which are the I/O edge and still return result
 * objects. The committed `config/glm/providers.json` is the ONLY default: an
 * unreadable or invalid list fails closed (`glm-provider-config-invalid`),
 * never a silent built-in fallback.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** Anthropic slot aliases — passing one routes first-party (issue #3758). */
export const ANTHROPIC_SLOT_ALIASES: readonly string[] = Object.freeze([
  "sonnet",
  "opus",
  "haiku",
  "fable",
]);

/** The provider id whose quota-block file keeps the legacy (unsuffixed) name. */
export const LEGACY_PROVIDER_ID = "zai";

/** True when `model` would route to Anthropic rather than a worker provider. */
export function isFirstPartyModelName(model: string): boolean {
  const n = model.trim().toLowerCase();
  return ANTHROPIC_SLOT_ALIASES.includes(n) || /^claude-/i.test(n);
}

/**
 * Env names a provider's `tokenEnv` may never be: they are stripped from, or
 * overwritten in, the launched child's env (`buildGlmEnv`), so naming one would
 * strip the selected provider's own credential or alias another channel.
 * (`ANTHROPIC_AUTH_TOKEN` is additionally allowed for the legacy `zai` id only.)
 */
const RESERVED_TOKEN_ENV_NAMES: readonly string[] = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN_FILE",
  "ANTHROPIC_BASE_URL",
  "API_TIMEOUT_MS",
]);

const quotaResetSchema = z.discriminatedUnion("format", [
  z.object({
    format: z.literal("zai-wallclock"),
    tzOffset: z.string().regex(/^[+-]\d{4}$/, "tzOffset must be [+-]HHMM"),
  }),
  z.object({ format: z.literal("fallback-only") }),
]);

const providerSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "id must be lowercase [a-z0-9-] (it names state files)"),
  baseUrl: z.string().url(),
  model: z
    .string()
    .trim()
    .min(1)
    .refine((m) => !isFirstPartyModelName(m), {
      message:
        "model must be an explicit non-Claude name — a Claude alias or claude-* routes first-party (issue #3758)",
    }),
  tokenEnv: z
    .string()
    .regex(/^[A-Z_][A-Z0-9_]*$/, "tokenEnv must be an environment variable NAME")
    .refine((n) => n !== "ANTHROPIC_API_KEY", {
      message: "tokenEnv must never be ANTHROPIC_API_KEY (ADR-0032 invariant 4)",
    }),
  quotaReset: quotaResetSchema,
  dailyCap: z.number().int().positive().optional(),
});

const providersFileSchema = z.object({
  providers: z.array(providerSchema).min(1),
});

/** One worker provider (inferred from the schema — the schema is the type). */
export type WorkerProvider = z.infer<typeof providerSchema>;

export type WorkerProvidersResult =
  | { ok: true; providers: WorkerProvider[] }
  | { ok: false; code: "glm-provider-config-invalid"; issues: string[] };

function invalid(issues: string[]): WorkerProvidersResult {
  return { ok: false, code: "glm-provider-config-invalid", issues };
}

/** Narrow a providers result to its failure arm (`strict: false` does not narrow booleans). */
export function isProvidersFailure(
  r: WorkerProvidersResult,
): r is Extract<WorkerProvidersResult, { ok: false }> {
  return r.ok === false;
}

/** Parse the providers file text. Pure; never throws. */
export function parseWorkerProviders(text: string): WorkerProvidersResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return invalid([`not valid JSON: ${err instanceof Error ? err.message : String(err)}`]);
  }
  const parsed = providersFileSchema.safeParse(json);
  if (!parsed.success) {
    return invalid(parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`));
  }
  const providers = parsed.data.providers;
  const issues: string[] = [];
  const ids = new Set<string>();
  const models = new Set<string>();
  const tokenEnvs = new Set<string>();
  for (const p of providers) {
    if (ids.has(p.id)) issues.push(`duplicate provider id "${p.id}"`);
    ids.add(p.id);
    const m = p.model.trim().toLowerCase();
    if (models.has(m)) issues.push(`duplicate provider model "${p.model}"`);
    models.add(m);
    if (tokenEnvs.has(p.tokenEnv)) {
      issues.push(`duplicate provider tokenEnv "${p.tokenEnv}" (one credential per provider, INV-9)`);
    }
    tokenEnvs.add(p.tokenEnv);
    if (RESERVED_TOKEN_ENV_NAMES.includes(p.tokenEnv)) {
      issues.push(`provider "${p.id}": tokenEnv "${p.tokenEnv}" is a reserved/stripped env name`);
    } else if (p.tokenEnv === "ANTHROPIC_AUTH_TOKEN" && p.id !== LEGACY_PROVIDER_ID) {
      issues.push(
        `provider "${p.id}": tokenEnv "ANTHROPIC_AUTH_TOKEN" is reserved for the "${LEGACY_PROVIDER_ID}" provider`,
      );
    }
  }
  if (issues.length > 0) return invalid(issues);
  return { ok: true, providers };
}

export type ModelCheck =
  | { ok: true }
  | {
      ok: false;
      code: "glm-model-would-route-first-party" | "glm-model-not-configured";
      message: string;
    };

/**
 * The generalised routing fence. Returns a result — never throws. A Claude
 * alias / `claude-*` is `glm-model-would-route-first-party`; any other model
 * that is not EXACTLY a configured provider's model is
 * `glm-model-not-configured`.
 */
export function checkProviderModel(
  model: string,
  providers: readonly WorkerProvider[],
): ModelCheck {
  const normalized = model.trim().toLowerCase();
  if (normalized === "" || isFirstPartyModelName(normalized)) {
    const alias = ANTHROPIC_SLOT_ALIASES.includes(normalized)
      ? ` "${normalized}" is an Anthropic slot alias.`
      : "";
    return {
      ok: false,
      code: "glm-model-would-route-first-party",
      message:
        `Refusing to run the GLM drainer with model "${model}": the base-URL override ` +
        `does NOT redirect a Claude model name — the CLI resolves it locally and calls ` +
        `Anthropic, burning the quota this lane exists to relieve (issue #3758).${alias} ` +
        `Pass an explicit configured worker model.`,
    };
  }
  if (providers.some((p) => p.model.trim().toLowerCase() === normalized)) return { ok: true };
  return {
    ok: false,
    code: "glm-model-not-configured",
    message:
      `Refusing to run the GLM drainer with model "${model}": it does not exactly match ` +
      `any configured worker provider's model (${providers.map((p) => p.model).join(", ") || "none"}).`,
  };
}

/** One provider's gate-time state. */
export interface ProviderState {
  provider: WorkerProvider;
  /** Active quota-block instant (epoch s), or `null`. */
  blockedUntil: number | null;
  /** Today's PR count for this provider (only meaningful with `dailyCap`). */
  capCount: number;
}

export type ProviderSelection =
  | { kind: "selected"; provider: WorkerProvider }
  | { kind: "none"; reason: "quota-blocked" | "cap-exhausted"; states: ProviderState[] };

/** Is this provider at its own optional daily cap? */
export function providerAtCap(s: ProviderState): boolean {
  return s.provider.dailyCap !== undefined && s.capCount >= s.provider.dailyCap;
}

/**
 * First-unblocked selection: walk the list in order, take the first provider
 * that is neither quota-blocked nor at its own dailyCap. When none is
 * selectable the verdict is `cap-exhausted` iff every unselectable provider is
 * cap-blocked (none quota-blocked), else `quota-blocked`. Pure.
 */
export function selectProvider(states: readonly ProviderState[], nowSec: number): ProviderSelection {
  const quotaBlocked = (s: ProviderState) => s.blockedUntil !== null && s.blockedUntil > nowSec;
  for (const s of states) {
    if (!quotaBlocked(s) && !providerAtCap(s)) return { kind: "selected", provider: s.provider };
  }
  const anyQuota = states.some(quotaBlocked);
  return { kind: "none", reason: anyQuota ? "quota-blocked" : "cap-exhausted", states: [...states] };
}

/**
 * The metering prefix of each provider's model: the lowercased name up to and
 * including its first `-` (`glm-5.2` -> `glm-`); a dashless model is its own
 * prefix. De-duplicated, order-preserving. Pure.
 */
export function foreignPrefixesFor(providers: readonly WorkerProvider[]): string[] {
  const out: string[] = [];
  for (const p of providers) {
    const m = p.model.trim().toLowerCase();
    const dash = m.indexOf("-");
    const prefix = dash === -1 ? m : m.slice(0, dash + 1);
    if (prefix !== "" && !out.includes(prefix)) out.push(prefix);
  }
  return out;
}

// ---------------------------------------------------------------------------
// I/O edge — file loaders (still result objects, never throw)
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Repo-relative path of the committed default list. */
export const PROVIDERS_RELATIVE_PATH = "config/glm/providers.json";

/** Absolute path of the committed default list. */
export const DEFAULT_PROVIDERS_PATH = resolve(REPO_ROOT, PROVIDERS_RELATIVE_PATH);

/** Read + parse a providers file. An unreadable file is `glm-provider-config-invalid`. */
export function loadWorkerProvidersFromFile(
  path: string,
  read: (p: string) => string = (p) => readFileSync(p, "utf8"),
): WorkerProvidersResult {
  let text: string;
  try {
    text = read(path);
  } catch (err) {
    return invalid([`unreadable providers file ${path}: ${err instanceof Error ? err.message : String(err)}`]);
  }
  return parseWorkerProviders(text);
}

/**
 * The committed default list (`config/glm/providers.json`) — the only default.
 * Used by callers that were not handed a list (hand-built deps, the legacy
 * one-argument runner signatures). Fails closed like any other load.
 */
export function loadCommittedDefaultProviders(): WorkerProvidersResult {
  return loadWorkerProvidersFromFile(DEFAULT_PROVIDERS_PATH);
}
