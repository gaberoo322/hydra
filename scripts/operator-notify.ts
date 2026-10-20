#!/usr/bin/env -S node --experimental-strip-types
/**
 * operator-notify — CLI over the Operator Channel (ADR-0045 Decision 6,
 * issue #5046).
 *
 * Bash and systemd senders (the watchdog, the OnFailure notify unit) use the
 * SAME model, renderer, dedup and credentials as in-process producers by
 * importing `src/operator-channel/` directly. It never contacts the
 * orchestrator HTTP API, so a page still goes out while
 * hydra-orchestrator.service is stopped.
 *
 *   operator-notify page   --kind <PageKind> --dedup-key <k> --title <t> [--fact label=value]... [--link label=url]...
 *   operator-notify resolve --dedup-key <k> [--title <t>]
 *   operator-notify brief  --kind <k> --title <t> [--fact label=value]... [--link label=url]...
 *   operator-notify service-failed --unit <%i>
 *
 * Exit codes: 0 for every delivery outcome (the outcome is the one-line JSON on
 * stdout), 2 only for a usage error. A delivery failure never fails the caller.
 * Runs under `node --experimental-strip-types` (no tsx on a unit's PATH).
 */

import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  OperatorChannel,
  isPageKind,
  type OperatorFact,
  type OperatorLink,
  type OperatorMessage,
} from "../src/operator-channel/index.ts";

export const FORCE_EXIT_MS = 20_000;

/** Unit base name -> page kind. Any other unit is a Morning Brief item. */
const UNIT_PAGE_KINDS: Record<string, string> = {
  "hydra-orchestrator": "service:orchestrator_failed",
  "hydra-autopilot": "service:autopilot_failed",
  "hydra-tunnel": "service:tunnel_failed",
  "hydra-redis-backup": "service:backup_failed",
  "hydra-pg-backup": "service:backup_failed",
};

export interface UnitExitInfo {
  result: string;
  execMainCode: string;
  execMainStatus: string;
  nRestarts?: string;
}

/**
 * ADR-0045 Decision 4 exit-code policy. A clean SIGTERM (exited/143 or
 * killed/SIGTERM) is not a failure. Everything else — including an unreadable
 * answer — is 'failed': fail toward paging, never toward silence.
 */
export function classifyUnitExit(info: Partial<UnitExitInfo>): "clean" | "failed" {
  const code = String(info.execMainCode ?? "").trim();
  const status = String(info.execMainStatus ?? "").trim();
  if (code === "1" && status === "143") return "clean";
  if (code === "2" && status === "15") return "clean";
  return "failed";
}

export function parseSystemctlShow(out: string): Partial<UnitExitInfo> {
  const map: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) map[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return {
    result: map.Result,
    execMainCode: map.ExecMainCode,
    execMainStatus: map.ExecMainStatus,
    nRestarts: map.NRestarts,
  };
}

function defaultSystemctl(unit: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "systemctl",
      ["--user", "show", `${unit}.service`, "-p", "Result,ExecMainCode,ExecMainStatus,NRestarts"],
      { timeout: 5000 },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
    );
  });
}

export interface NotifyDeps {
  channel?: Pick<OperatorChannel, "page" | "resolve" | "brief">;
  /** Returns the raw `systemctl show` output for a unit base name. */
  systemctl?: (unit: string) => Promise<string>;
  log?: (line: string) => void;
}

export interface NotifyResult {
  exitCode: number;
  stdout: string;
}

interface Parsed {
  sub: string;
  opts: Record<string, string>;
  facts: OperatorFact[];
  links: OperatorLink[];
}

function parseArgs(argv: string[]): Parsed | string {
  const [sub, ...rest] = argv;
  if (!sub) return "missing subcommand";
  const opts: Record<string, string> = {};
  const facts: OperatorFact[] = [];
  const links: OperatorLink[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) return `unexpected argument "${a}"`;
    const name = a.slice(2);
    const value = rest[++i];
    if (value === undefined) return `--${name} needs a value`;
    if (name === "fact" || name === "link") {
      const eq = value.indexOf("=");
      if (eq <= 0) return `--${name} expects label=value`;
      const label = value.slice(0, eq);
      const v = value.slice(eq + 1);
      if (name === "fact") facts.push({ label, value: v });
      else links.push({ label, url: v });
    } else {
      opts[name] = value;
    }
  }
  return { sub, opts, facts, links };
}

function line(obj: Record<string, unknown>): string {
  return `${JSON.stringify(obj)}\n`;
}

function usage(msg: string, log: (l: string) => void): NotifyResult {
  log(`[operator-notify] usage error: ${msg}`);
  return { exitCode: 2, stdout: "" };
}

export async function runOperatorNotify(argv: string[], deps: NotifyDeps = {}): Promise<NotifyResult> {
  const log = deps.log ?? ((l: string) => process.stderr.write(`${l}\n`));
  const channel = deps.channel ?? new OperatorChannel();
  const parsed = parseArgs(argv);
  if (typeof parsed === "string") return usage(parsed, log);
  const { sub, opts, facts, links } = parsed;

  try {
    if (sub === "page") {
      const { kind, "dedup-key": dedupKey, title } = opts;
      if (!kind || !dedupKey || !title) return usage("page needs --kind, --dedup-key and --title", log);
      if (!isPageKind(kind)) return usage(`"${kind}" is not on the closed page list`, log);
      const msg: OperatorMessage = { severity: "page", kind, title, facts, links, dedupKey };
      const result = await channel.page(msg);
      log(`[operator-notify] page ${kind} ${dedupKey}: ${JSON.stringify(result)}`);
      return { exitCode: 0, stdout: line({ subcommand: sub, kind, dedupKey, result }) };
    }
    if (sub === "resolve") {
      const dedupKey = opts["dedup-key"];
      if (!dedupKey) return usage("resolve needs --dedup-key", log);
      const result = await channel.resolve(dedupKey, opts.title);
      log(`[operator-notify] resolve ${dedupKey}: ${JSON.stringify(result)}`);
      return { exitCode: 0, stdout: line({ subcommand: sub, dedupKey, result }) };
    }
    if (sub === "brief") {
      const { kind, title } = opts;
      if (!kind || !title) return usage("brief needs --kind and --title", log);
      if (isPageKind(kind)) return usage(`"${kind}" is a page kind — use page`, log);
      const dedupKey = opts["dedup-key"] ?? kind;
      const result = await channel.brief({ severity: "brief", kind, title, facts, links, dedupKey });
      log(`[operator-notify] brief ${kind}: ${JSON.stringify(result)}`);
      return { exitCode: 0, stdout: line({ subcommand: sub, kind, dedupKey, result }) };
    }
    if (sub === "service-failed") {
      if (!opts.unit) return usage("service-failed needs --unit", log);
      const unit = opts.unit.replace(/\.service$/, "");
      let info: Partial<UnitExitInfo> = {};
      try {
        info = parseSystemctlShow(await (deps.systemctl ?? defaultSystemctl)(unit));
      } catch (err) {
        log(`[operator-notify] systemctl show ${unit} failed — treating as failed: ${String(err)}`);
      }
      if (classifyUnitExit(info) === "clean") {
        log(`[operator-notify] ${unit} exited cleanly on SIGTERM (code=${info.execMainCode} status=${info.execMainStatus}) — nothing sent`);
        return { exitCode: 0, stdout: line({ subcommand: sub, unit, result: { sent: false, reason: "clean-exit" } }) };
      }
      const unitFacts: OperatorFact[] = [
        { label: "unit", value: unit },
        { label: "result", value: info.result ?? "unknown" },
        { label: "ExecMainCode", value: info.execMainCode ?? "unknown" },
        { label: "ExecMainStatus", value: info.execMainStatus ?? "unknown" },
        { label: "NRestarts", value: info.nRestarts ?? "unknown" },
      ];
      const dedupKey = `service:${unit}`;
      const pageKind = UNIT_PAGE_KINDS[unit];
      if (pageKind) {
        const result = await channel.page({
          severity: "page",
          kind: pageKind,
          title: `Hydra service failed: ${unit}`,
          facts: unitFacts,
          links: [],
          dedupKey,
        });
        log(`[operator-notify] service-failed page ${unit}: ${JSON.stringify(result)}`);
        return { exitCode: 0, stdout: line({ subcommand: sub, kind: pageKind, dedupKey, result }) };
      }
      const result = await channel.brief({
        severity: "brief",
        kind: "service:unit_failed",
        title: `Unit failed: ${unit}`,
        facts: unitFacts,
        links: [],
        dedupKey,
      });
      log(`[operator-notify] service-failed brief ${unit}: ${JSON.stringify(result)}`);
      return { exitCode: 0, stdout: line({ subcommand: sub, kind: "service:unit_failed", dedupKey, result }) };
    }
    return usage(`unknown subcommand "${sub}"`, log);
  } catch (err) {
    // A delivery failure must never fail the OnFailure unit or a watchdog block.
    log(`[operator-notify] ${sub} failed unexpectedly (exit 0, best-effort): ${String(err)}`);
    return { exitCode: 0, stdout: line({ subcommand: sub, result: { sent: false, reason: "error" } }) };
  }
}

function isMain(): boolean {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMain()) {
  const argv = process.argv.slice(2);
  if (argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(
      "usage: operator-notify <page|resolve|brief|service-failed> [--kind k] [--dedup-key k] [--title t] [--fact l=v] [--link l=u] [--unit u]\n",
    );
    process.exit(0);
  }
  // Hard cap: ioredis reconnect loops or a hung fetch must not wedge the caller.
  const timer = setTimeout(() => {
    process.stderr.write(`[operator-notify] force-exit after ${FORCE_EXIT_MS}ms (hung dependency)\n`);
    process.exit(0);
  }, FORCE_EXIT_MS);
  timer.unref();
  runOperatorNotify(argv)
    .then(({ exitCode, stdout }) => {
      if (stdout) process.stdout.write(stdout, () => process.exit(exitCode));
      else process.exit(exitCode);
    })
    .catch((err) => {
      process.stderr.write(`[operator-notify] fatal (exit 0, best-effort): ${String(err)}\n`);
      process.exit(0);
    });
}
