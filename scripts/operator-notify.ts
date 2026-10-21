#!/usr/bin/env -S node --experimental-strip-types
/**
 * operator-notify — the Operator Channel CLI for bash and systemd callers
 * (ADR-0045 Decision 2, issue #5046).
 *
 * The watchdog blocks and the `hydra-notify-failure@` OnFailure template reach
 * the operator's phone through this entry point and nothing else, so every
 * runtime shares one message model, one renderer, one dedup state and one
 * credential loader. It imports `src/operator-channel/` DIRECTLY — it never
 * talks to the orchestrator's HTTP service — so a page still goes out while
 * `hydra-orchestrator.service` is stopped, which is exactly when the watchdog
 * and the OnFailure units matter most (Decision 6).
 *
 * Subcommands
 *   page           --kind <PageKind> --dedup-key <k> [--title <t>] [--fact l=v ...] [--link l=url ...]
 *   resolve        --dedup-key <k> [--title <t>]
 *   brief          --kind <k> [--title <t>] [--fact l=v ...] [--link l=url ...]
 *   service-failed --unit <%i>        the OnFailure entry: exit-code policy + unit→kind map
 *   --help
 *
 * Output: one JSON line on stdout `{subcommand, kind, dedupKey, result}`; the
 * structured log goes to stderr (journal). Exit 0 for EVERY delivery outcome
 * (sent / suppressed / skipped-no-credentials / transport-failed — the outcome
 * is in the JSON, the log line and the channel's delivery log) and 2 only for
 * a usage error (unknown subcommand, a missing required flag, a `page` kind
 * that is not on the closed page list, a `brief` kind that is). A delivery
 * failure never fails an OnFailure unit or a watchdog block.
 *
 * Exit-code policy (Decision 4): `service-failed` reads
 * `systemctl --user show <unit>.service -p Result,ExecMainCode,ExecMainStatus,NRestarts`
 * and {@link classifyUnitExit} calls (exited, 143) and (killed, SIGTERM/15)
 * "clean" — a clean exit sends nothing, only a journal line. Every other
 * combination, and an unreadable answer, is "failed": fail toward paging,
 * never toward silence.
 *
 * Severity (Decision 3) is never the producer's: `service-failed` maps the
 * unit base name onto the closed list ({@link UNIT_PAGE_KINDS}) and every other
 * unit becomes a Morning Brief item of kind `service:unit_failed`; `page`
 * rejects any kind `isPageKind()` says no to.
 *
 * Termination (fail open, always terminate): the channel's bounded store calls
 * fail open in 1500ms; the CLI calls `process.exit` after the awaited result;
 * and an unref'd 20s force-exit timer logs and exits if anything (an ioredis
 * reconnect loop, a hung fetch) keeps the loop alive. The notify unit's
 * `TimeoutStartSec=30` and the watchdog's `timeout 25` are the outer bounds.
 *
 * Runtime: `node --experimental-strip-types` (never `npx tsx` — a systemd
 * unit's minimal PATH cannot see the global tsx and npx would try the network
 * inside a failure handler). Tests drive {@link runOperatorNotify} in-process
 * with a fake transport, a rejecting store and an injected `systemctl`.
 */

import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";

import { logger } from "../src/logger.ts";
import {
  OperatorChannel,
  type ChannelResult,
  type OperatorChannelDeps,
  type OperatorFact,
  type OperatorLink,
  type OperatorMessage,
  type PageKind,
  isPageKind,
} from "../src/operator-channel/index.ts";

export const FORCE_EXIT_MS = 20_000;
export const USAGE_EXIT_CODE = 2;

/** Brief kind for every unit the closed list does not name (Decision 3). */
export const UNIT_FAILED_BRIEF_KIND = "service:unit_failed";

/**
 * Unit base name → page kind. Everything else (claw-street-bets-*,
 * hydra-betting-*, …) is a Morning Brief item, never a page.
 */
export const UNIT_PAGE_KINDS: Readonly<Record<string, PageKind>> = {
  "hydra-orchestrator": "service:orchestrator_failed",
  "hydra-autopilot": "service:autopilot_failed",
  "hydra-tunnel": "service:tunnel_failed",
  "hydra-redis-backup": "service:backup_failed",
  "hydra-pg-backup": "service:backup_failed",
};

export const SYSTEMCTL_SHOW_PROPERTIES = "Result,ExecMainCode,ExecMainStatus,NRestarts";

export const USAGE = `operator-notify — Hydra Operator Channel CLI (ADR-0045)

  operator-notify page           --kind <PageKind> --dedup-key <key> [--title <t>] [--fact label=value]... [--link label=url]...
  operator-notify resolve        --dedup-key <key> [--title <t>]
  operator-notify brief          --kind <kind> [--title <t>] [--fact label=value]... [--link label=url]...
  operator-notify service-failed --unit <unit[.service]>
  operator-notify --help

Exit 0 for every delivery outcome (see the JSON line on stdout); exit 2 for a usage error.
`;

// ---------------------------------------------------------------------------
// Pure helpers (exported for the test)
// ---------------------------------------------------------------------------

/** Strip ONE trailing `.service` so `@%n` and `@%n.service` resolve alike. */
export function stripUnitSuffix(unit: string): string {
  return unit.endsWith(".service") ? unit.slice(0, -".service".length) : unit;
}

export interface UnitExitFacts {
  result?: string;
  execMainCode?: string;
  execMainStatus?: string;
  nRestarts?: string;
}

/**
 * Decision 4: a SIGTERM / exit 143 stop is a clean restart, not a failure.
 * `ExecMainCode` is systemd's enum (`exited` = 1, `killed` = 2 — both
 * spellings accepted); `ExecMainStatus` is the exit code or the signal
 * (number or name). Anything else, including an unreadable answer, is `failed`.
 */
export function classifyUnitExit(facts: UnitExitFacts): "clean" | "failed" {
  const code = (facts.execMainCode ?? "").trim().toLowerCase();
  const status = (facts.execMainStatus ?? "").trim().toUpperCase();
  if ((code === "exited" || code === "1") && status === "143") return "clean";
  if ((code === "killed" || code === "2") && (status === "15" || status === "SIGTERM" || status === "TERM")) {
    return "clean";
  }
  return "failed";
}

/** Parse `Key=value` lines as `systemctl show -p` prints them. */
export function parseSystemctlShow(raw: string): UnitExitFacts {
  const out: UnitExitFacts = {};
  for (const line of raw.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === "Result") out.result = value;
    else if (key === "ExecMainCode") out.execMainCode = value;
    else if (key === "ExecMainStatus") out.execMainStatus = value;
    else if (key === "NRestarts") out.nRestarts = value;
  }
  return out;
}

export interface ParsedArgs {
  subcommand: string;
  flags: Record<string, string>;
  facts: OperatorFact[];
  links: OperatorLink[];
  help: boolean;
}

function splitPair(raw: string): { label: string; value: string } {
  const eq = raw.indexOf("=");
  if (eq <= 0) return { label: raw, value: "" };
  return { label: raw.slice(0, eq), value: raw.slice(eq + 1) };
}

/** Minimal flag parser: `--name value` pairs; `--fact`/`--link` repeat. */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { subcommand: "", flags: {}, facts: [], links: [], help: false };
  const rest = [...argv];
  if (rest[0] === "--help" || rest[0] === "-h") {
    parsed.help = true;
    return parsed;
  }
  parsed.subcommand = rest.shift() ?? "";
  while (rest.length > 0) {
    const tok = rest.shift() as string;
    if (tok === "--help" || tok === "-h") {
      parsed.help = true;
      continue;
    }
    if (!tok.startsWith("--")) throw new UsageError(`unexpected argument '${tok}'`);
    const name = tok.slice(2);
    const value = rest.shift();
    if (value === undefined) throw new UsageError(`--${name} needs a value`);
    if (name === "fact") {
      const { label, value: v } = splitPair(value);
      parsed.facts.push({ label, value: v });
    } else if (name === "link") {
      const { label, value: url } = splitPair(value);
      parsed.links.push({ label, url });
    } else {
      parsed.flags[name] = value;
    }
  }
  return parsed;
}

export class UsageError extends Error {
  readonly code = "usage-error";
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

// ---------------------------------------------------------------------------
// Runner (in-process; the test's entry point)
// ---------------------------------------------------------------------------

export interface OperatorNotifyDeps extends OperatorChannelDeps {
  /** `systemctl --user show <unit> -p …` as raw stdout; throws when unreadable. */
  systemctl?: (unitWithSuffix: string) => string;
  /** Where the one JSON result line goes (default: stdout). */
  stdout?: (line: string) => void;
  /** Host name rendered as a fact on every page/brief. */
  host?: string;
}

/** The `result` field of the one JSON line on stdout. */
export type OperatorNotifyResult =
  | ChannelResult
  | { appended: boolean }
  | { skipped: "clean-exit" }
  | { usageError: string };

export interface OperatorNotifyOutcome {
  exitCode: number;
  output: {
    subcommand: string;
    kind: string | null;
    dedupKey: string | null;
    result: OperatorNotifyResult;
  } | null;
}

function defaultSystemctl(unitWithSuffix: string): string {
  return execFileSync("systemctl", ["--user", "show", unitWithSuffix, "-p", SYSTEMCTL_SHOW_PROPERTIES], {
    encoding: "utf8",
    timeout: 5_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function requireFlag(parsed: ParsedArgs, name: string): string {
  const v = parsed.flags[name];
  if (v === undefined || v === "") throw new UsageError(`${parsed.subcommand}: missing --${name}`);
  return v;
}

function withHost(facts: OperatorFact[], host: string): OperatorFact[] {
  return facts.some((f) => f.label === "host") ? facts : [...facts, { label: "host", value: host }];
}

/**
 * Run one invocation. Never throws for a delivery outcome; throws only for a
 * programming error (a UsageError is turned into exit 2 by {@link main}).
 */
export async function runOperatorNotify(argv: string[], deps: OperatorNotifyDeps = {}): Promise<OperatorNotifyOutcome> {
  const emit = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const host = deps.host ?? hostname();
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    return usage(err, emit, argv[0] ?? "");
  }
  if (parsed.help) {
    emit(USAGE.trimEnd());
    return { exitCode: 0, output: null };
  }

  // Constructed lazily so `--help` and usage errors never touch Redis.
  const channel = () => new OperatorChannel({ store: deps.store, transport: deps.transport, now: deps.now, timeoutMs: deps.timeoutMs });

  try {
    switch (parsed.subcommand) {
      case "page": {
        const kind = requireFlag(parsed, "kind");
        const dedupKey = requireFlag(parsed, "dedup-key");
        if (!isPageKind(kind)) {
          throw new UsageError(`page: "${kind}" is not on the closed page list (ADR-0045 Decision 3) — use brief, or add it to src/operator-channel/page-list.ts`);
        }
        const msg: OperatorMessage = {
          severity: "page",
          kind,
          title: parsed.flags.title ?? kind,
          facts: withHost(parsed.facts, host),
          links: parsed.links,
          dedupKey,
        };
        const result = await channel().page(msg);
        return done("page", kind, dedupKey, result, emit);
      }
      case "resolve": {
        const dedupKey = requireFlag(parsed, "dedup-key");
        const result = await channel().resolve(dedupKey, parsed.flags.title);
        return done("resolve", "recovered", dedupKey, result, emit);
      }
      case "brief": {
        const kind = requireFlag(parsed, "kind");
        if (isPageKind(kind)) {
          throw new UsageError(`brief: "${kind}" is a page kind — use page (the CLI never decides severity)`);
        }
        const dedupKey = parsed.flags["dedup-key"] ?? kind;
        const result = await channel().brief({
          severity: "brief",
          kind,
          title: parsed.flags.title ?? kind,
          facts: withHost(parsed.facts, host),
          links: parsed.links,
          dedupKey,
        });
        return done("brief", kind, dedupKey, result, emit);
      }
      case "service-failed": {
        const unitBase = stripUnitSuffix(requireFlag(parsed, "unit"));
        const unitWithSuffix = `${unitBase}.service`;
        const systemctl = deps.systemctl ?? defaultSystemctl;
        let facts: UnitExitFacts = {};
        let readable = true;
        try {
          facts = parseSystemctlShow(systemctl(unitWithSuffix));
        } catch (err) {
          readable = false;
          logger.error({ err, unit: unitWithSuffix }, "[operator-notify] systemctl show failed — classifying as failed (fail toward paging)");
        }
        const dedupKey = `service:${unitBase}`;
        if (readable && classifyUnitExit(facts) === "clean") {
          logger.info(
            { unit: unitWithSuffix, ...facts },
            "[operator-notify] clean SIGTERM / exit 143 stop — not a failure, nothing sent (ADR-0045 Decision 4)",
          );
          return done("service-failed", null, dedupKey, { skipped: "clean-exit" }, emit);
        }
        const renderedFacts: OperatorFact[] = withHost(
          [
            { label: "unit", value: unitWithSuffix },
            { label: "Result", value: readable ? facts.result ?? "?" : "unreadable" },
            { label: "ExecMainCode", value: readable ? facts.execMainCode ?? "?" : "unreadable" },
            { label: "ExecMainStatus", value: readable ? facts.execMainStatus ?? "?" : "unreadable" },
            { label: "NRestarts", value: readable ? facts.nRestarts ?? "?" : "unreadable" },
          ],
          host,
        );
        const pageKind = UNIT_PAGE_KINDS[unitBase];
        if (pageKind) {
          const result = await channel().page({
            severity: "page",
            kind: pageKind,
            title: `Service failed: ${unitBase}`,
            facts: renderedFacts,
            links: [],
            dedupKey,
          });
          return done("service-failed", pageKind, dedupKey, result, emit);
        }
        const result = await channel().brief({
          severity: "brief",
          kind: UNIT_FAILED_BRIEF_KIND,
          title: `Service failed: ${unitBase}`,
          facts: renderedFacts,
          links: [],
          dedupKey,
        });
        return done("service-failed", UNIT_FAILED_BRIEF_KIND, dedupKey, result, emit);
      }
      case "":
        throw new UsageError("missing subcommand");
      default:
        throw new UsageError(`unknown subcommand '${parsed.subcommand}'`);
    }
  } catch (err) {
    if (err instanceof UsageError) return usage(err, emit, parsed.subcommand);
    throw err;
  }
}

function done(
  subcommand: string,
  kind: string | null,
  dedupKey: string | null,
  result: OperatorNotifyResult,
  emit: (line: string) => void,
): OperatorNotifyOutcome {
  const output = { subcommand, kind, dedupKey, result };
  logger.info({ ...output }, "[operator-notify] done");
  emit(JSON.stringify(output));
  return { exitCode: 0, output };
}

function usage(err: unknown, emit: (line: string) => void, subcommand: string): OperatorNotifyOutcome {
  const message = err instanceof Error ? err.message : String(err);
  logger.error({ err, subcommand }, "[operator-notify] usage error");
  const output = { subcommand, kind: null, dedupKey: null, result: { usageError: message } };
  emit(JSON.stringify(output));
  process.stderr.write(`${USAGE}`);
  return { exitCode: USAGE_EXIT_CODE, output };
}

// ---------------------------------------------------------------------------
// CLI entry (guarded on import.meta.url so the test imports without running)
// ---------------------------------------------------------------------------

function isCliEntrypoint(): boolean {
  return Boolean(process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1]));
}

async function main(): Promise<void> {
  const forceExit = setTimeout(() => {
    logger.error({ forceExitMs: FORCE_EXIT_MS }, "[operator-notify] still alive after the force-exit window — exiting 0 (fail open, always terminate)");
    process.exit(0);
  }, FORCE_EXIT_MS);
  forceExit.unref();
  let exitCode = 0;
  try {
    exitCode = (await runOperatorNotify(process.argv.slice(2))).exitCode;
  } catch (err) {
    // A programming error, never a delivery outcome: still exit 0 so an
    // OnFailure unit or a watchdog block is never failed by its notifier.
    logger.error({ err }, "[operator-notify] crashed — exiting 0 (a delivery failure never fails the caller)");
    exitCode = 0;
  }
  process.exit(exitCode);
}

if (isCliEntrypoint()) {
  void main();
}
