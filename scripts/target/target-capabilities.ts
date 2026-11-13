/**
 * target-capabilities — what the active Target actually OFFERS (issue #5498,
 * parent #5492).
 *
 * `print-target-facts.ts` reports Target IDENTITY (name, repo, workspace, …).
 * Several Target playbooks additionally assumed the previous Target's LAYOUT
 * (an e2e smoke script, a dead-code ledger, a "full" health route, …) and
 * failed or silently no-op'd against the successor. This module probes the
 * Target workspace for those conventions and reports each one as
 * `{ ok: true, value }` or `{ ok: false, reason }`, so a playbook branches on
 * `[ -n "$TARGET_CAP_*" ]` and prints an explicit, logged skip when absent.
 *
 * ONE PLACE FOR CONVENTION NAMES
 * ------------------------------
 * {@link CAPABILITY_PROBES} is the only place the conventional script names,
 * file names and route paths are spelled (design-concept INV-1 / INV-5). It
 * reads only the Target's own files (its package manifest and the file tree);
 * it introduces no Target-identity default and `src/target-config.ts` is
 * untouched (ADR-0002).
 *
 * NEVER THROWS
 * ------------
 * Every filesystem failure is "no positive evidence" → `{ ok: false, reason }`.
 * An absent capability is never a reason for the seam to fail (INV-3).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** One probed capability: present with a value, or absent with a reason. */
export type Capability = { ok: true; value: string } | { ok: false; reason: string };

/** Where a probe looks. Both are absolute directories; `appDir` may equal `workspace`. */
export interface ProbeRoots {
  workspace: string;
  appDir: string;
}

/** Read-only probe helpers handed to each table entry. */
interface ProbeContext extends ProbeRoots {
  /** The app package.json `scripts` map, or `null` when unreadable/malformed. */
  scripts: Record<string, unknown> | null;
}

interface CapabilityProbe {
  /** Key in the JSON `capabilities` object. */
  key: string;
  /** Name of the `--sh` export (empty string when absent). */
  shVar: string;
  probe: (ctx: ProbeContext) => Capability;
}

const present = (value: string): Capability => ({ ok: true, value });
const absent = (reason: string): Capability => ({ ok: false, reason });

function scriptProbe(script: string, purpose: string): (ctx: ProbeContext) => Capability {
  return (ctx) => {
    const v = ctx.scripts?.[script];
    return typeof v === "string" && v.trim()
      ? present(script)
      : absent(`Target package.json declares no ${purpose} script`);
  };
}

function firstExisting(
  dirs: string[],
  names: string[],
): string | null {
  for (const dir of dirs) {
    for (const name of names) {
      if (existsSync(join(dir, name))) return join(dir, name);
    }
  }
  return null;
}

function relTo(base: string, abs: string): string {
  return abs.startsWith(base + "/") ? abs.slice(base.length + 1) : abs;
}

/** Health route candidates, most specific first: [route file, served route]. */
const HEALTH_ROUTES: Array<[string, string]> = [
  ["src/app/api/health/full/route.ts", "/api/health/full"],
  ["app/api/health/full/route.ts", "/api/health/full"],
  ["src/app/api/health/route.ts", "/api/health"],
  ["app/api/health/route.ts", "/api/health"],
];

/**
 * THE probe table — the only place convention names are spelled. Order is the
 * order of the JSON keys and `--sh` exports.
 */
export const CAPABILITY_PROBES: readonly CapabilityProbe[] = [
  {
    key: "e2eSmoke",
    shVar: "TARGET_CAP_E2E_SMOKE",
    probe: scriptProbe("e2e:smoke", "end-to-end smoke"),
  },
  {
    key: "routeSmokeSpec",
    shVar: "TARGET_CAP_ROUTE_SMOKE_SPEC",
    probe: (ctx) => {
      const hit = firstExisting([ctx.appDir], ["e2e/route-smoke.spec.ts"]);
      return hit ? present(relTo(ctx.workspace, hit)) : absent("Target carries no route-smoke spec");
    },
  },
  {
    key: "designLanguageAdr",
    shVar: "TARGET_CAP_DESIGN_LANGUAGE_ADR",
    probe: (ctx) => {
      const dir = join(ctx.workspace, "docs", "adr");
      try {
        const hit = readdirSync(dir).find((f) => /design-language.*\.md$/.test(f));
        return hit ? present(`docs/adr/${hit}`) : absent("Target has no design-language ADR");
      } catch {
        /* intentional: an unreadable ADR directory is "no positive evidence" */
        return absent("Target has no docs/adr directory");
      }
    },
  },
  {
    key: "deadcodeCheck",
    shVar: "TARGET_CAP_DEADCODE_CHECK",
    probe: scriptProbe("deadcode:check", "dead-code check"),
  },
  {
    key: "deadcodeUpdate",
    shVar: "TARGET_CAP_DEADCODE_UPDATE",
    probe: scriptProbe("deadcode:update-baseline", "dead-code baseline-update"),
  },
  {
    key: "deadcodeBaseline",
    shVar: "TARGET_CAP_DEADCODE_BASELINE",
    probe: (ctx) => {
      const hit = firstExisting([ctx.appDir], ["deadcode-baseline.json"]);
      return hit ? present(relTo(ctx.workspace, hit)) : absent("Target has no dead-code baseline file");
    },
  },
  {
    key: "wiringLedger",
    shVar: "TARGET_CAP_WIRING_LEDGER",
    probe: (ctx) => {
      const path = join(ctx.workspace, "docs", "agents", "wiring-status.md");
      return existsSync(path) ? present("docs/agents/wiring-status.md") : absent("Target has no wiring-status ledger");
    },
  },
  {
    key: "wiringLedgerGenerator",
    shVar: "TARGET_CAP_WIRING_LEDGER_GENERATOR",
    probe: scriptProbe("deadcode:ledger", "wiring-ledger generator"),
  },
  {
    key: "healthRoute",
    shVar: "TARGET_CAP_HEALTH_ROUTE",
    probe: (ctx) => {
      for (const [file, route] of HEALTH_ROUTES) {
        if (existsSync(join(ctx.appDir, file))) return present(route);
      }
      return absent("Target serves no discoverable health route");
    },
  },
  {
    key: "agentInstructions",
    shVar: "TARGET_CAP_AGENT_INSTRUCTIONS",
    probe: (ctx) => {
      const hit = firstExisting([ctx.workspace, ctx.appDir], ["CLAUDE.md", "AGENTS.md"]);
      return hit ? present(relTo(ctx.workspace, hit)) : absent("Target carries no agent-instruction file");
    },
  },
  {
    key: "domainDocs",
    shVar: "TARGET_CAP_DOMAIN_DOCS",
    probe: (ctx) => {
      const hit = firstExisting([ctx.workspace], ["docs/agents/domain.md"]);
      return hit ? present(relTo(ctx.workspace, hit)) : absent("Target carries no docs/agents/domain.md");
    },
  },
  {
    key: "contextDoc",
    shVar: "TARGET_CAP_CONTEXT_DOC",
    probe: (ctx) => {
      const hit = firstExisting([ctx.workspace], ["CONTEXT.md"]);
      return hit ? present(relTo(ctx.workspace, hit)) : absent("Target carries no CONTEXT.md");
    },
  },
];

/** The `capabilities` object: one {@link Capability} per probe key. */
export type TargetCapabilities = Record<string, Capability>;

function readScripts(appDir: string): Record<string, unknown> | null {
  try {
    const pkg = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    return pkg && typeof pkg.scripts === "object" && pkg.scripts ? pkg.scripts : null;
  } catch {
    /* intentional: a missing/malformed package.json is "no positive evidence" for every script probe */
    return null;
  }
}

/** Probe every capability against the Target roots. Never throws. */
export function probeTargetCapabilities(roots: ProbeRoots): TargetCapabilities {
  const ctx: ProbeContext = { ...roots, scripts: readScripts(roots.appDir) };
  const out: TargetCapabilities = {};
  for (const p of CAPABILITY_PROBES) {
    try {
      out[p.key] = p.probe(ctx);
    } catch {
      /* intentional: a probe failure is reported as absent, never as a seam failure (INV-3) */
      out[p.key] = absent("probe failed");
    }
  }
  return out;
}

/** POSIX-safe single-quote shell escaping. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Render the additive `--sh` exports: one `TARGET_CAP_*` per probe (empty
 * string when absent) plus `TARGET_CAPABILITIES_JSON`, the single
 * machine-readable form (reasons included).
 */
export function renderCapabilityShell(caps: TargetCapabilities): string {
  const lines = CAPABILITY_PROBES.map((p) => {
    const c = caps[p.key];
    return `export ${p.shVar}=${shQuote(c && c.ok ? c.value : "")}`;
  });
  lines.push(`export TARGET_CAPABILITIES_JSON=${shQuote(JSON.stringify(caps))}`);
  return lines.join("\n");
}
