/**
 * Regression test for issue #5048 (ADR-0045 Decision 8), ported in #5099 — the
 * MORNING BRIEF MISSING check (`src/watchdog/brief-missing.ts`): page ONCE when
 * no Morning Brief has been delivered for 26h, resolve on recovery, and do it
 * INDEPENDENTLY of the scheduler's running state (the brief rides the scheduler
 * heartbeat tick, so a deliberate `POST /scheduler/stop` silences it — the
 * alarm must not share that blind spot).
 *
 * Pinned here:
 *   1. Contract: the Redis key names are unchanged (a deploy mid-episode neither
 *      re-pages nor loses the cold-start anchor), the `brief:missing` kind is on
 *      the closed page list (and in the ADR's Decision 3 list).
 *   2. Behaviour, IN-PROCESS over a fake store + recording channel (no bash, no
 *      Docker, no PATH shim): cold-start grace, stale key -> one page per
 *      episode, dedup, fresh key after a fired episode -> one resolve + re-arm,
 *      the threshold hook, the unparseable-stamp rule, and the Redis-unreachable
 *      fail-safe (no page, no mutation).
 *   3. The pure `decideBriefMissing` verdict table.
 *   4. The check table (`WATCHDOG_CHECKS`) that `hydra-watchdog.ts plan` prints.
 *   5. Port-boundary lints over src/watchdog modules and the service unit.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { BRIEF_LAST_SENT_KEY } from "../src/redis/operator-channel.ts";
import { BRIEF_MISSING_KEY_PREFIX, briefMissingEpisodeKeys } from "../src/redis/watchdog-episodes.ts";
import { PAGE_KINDS, isPageKind } from "../src/operator-channel/page-list.ts";
import type { OperatorMessage } from "../src/operator-channel/message.ts";
import {
  BRIEF_LAST_SENT_KEY_LABEL,
  BRIEF_MISSING_KIND,
  BRIEF_MISSING_LOG_PREFIX,
  decideBriefMissing,
  parseBriefStaleHours,
  runBriefMissing,
  type BriefMissingDeps,
  type BriefMissingStore,
} from "../src/watchdog/brief-missing.ts";
import { WATCHDOG_CHECKS, formatWatchdogPlan } from "../src/watchdog/checks.ts";
import { DEPLOY_DRIFT_LOG_PREFIX } from "../src/watchdog/deploy-drift.ts";
import { ORIGIN_IDENTITY_LOG_PREFIX, ORIGIN_IDENTITY_PAGE_KIND } from "../src/watchdog/origin-identity.ts";
import { REDIS_BACKUP_LOG_PREFIX, REDIS_BACKUP_STALE_KIND } from "../src/watchdog/redis-backup.ts";
import { SKILL_MIRROR_LOG_PREFIX } from "../src/watchdog/skill-mirror.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const ADR = join(REPO_ROOT, "docs", "adr", "0045-operator-channel.md");

const HOUR_MS = 3600 * 1000;
const T0 = 1_760_000_000_000; // a fixed epoch ms; every case ages relative to it

interface Harness {
  deps: BriefMissingDeps;
  state: { lastSent: number | null; anchor: number | null; fired: boolean; unreachable: boolean };
  ops: string[];
  pages: OperatorMessage[];
  resolves: { dedupKey: string; title?: string }[];
  logs: string[];
  text: () => string;
}

function makeHarness(init: Partial<Harness["state"]> = {}): Harness {
  const state = { lastSent: null as number | null, anchor: null as number | null, fired: false, unreachable: false, ...init };
  const ops: string[] = [];
  const pages: OperatorMessage[] = [];
  const resolves: { dedupKey: string; title?: string }[] = [];
  const logs: string[] = [];
  const store: BriefMissingStore = {
    async readLastSent() {
      if (state.unreachable) throw new Error("ECONNREFUSED");
      return state.lastSent;
    },
    async anchorExists() {
      return state.anchor !== null;
    },
    async anchor(nowMs) {
      ops.push("anchor");
      if (state.anchor === null) state.anchor = nowMs;
    },
    async readAnchor() {
      return state.anchor;
    },
    async deleteAnchor() {
      ops.push("deleteAnchor");
      state.anchor = null;
    },
    async firedExists() {
      return state.fired;
    },
    async markFired() {
      ops.push("markFired");
      state.fired = true;
    },
    async deleteFired() {
      ops.push("deleteFired");
      state.fired = false;
    },
  };
  const deps: BriefMissingDeps = {
    store,
    channel: {
      async page(msg: OperatorMessage) {
        pages.push(msg);
        return { sent: true } as never;
      },
      async resolve(dedupKey: string, title?: string) {
        resolves.push({ dedupKey, title });
        return { sent: true } as never;
      },
    },
    clock: { nowMs: () => T0 },
    log: (l) => logs.push(l),
  };
  return { deps, state, ops, pages, resolves, logs, text: () => logs.join("\n") };
}

const cfg = (over: { staleHours?: number; nowMs?: number | null } = {}) => ({ staleHours: 26, nowMs: null, ...over });

describe("brief-missing — contract (issue #5048, ADR-0045 Decision 8)", () => {
  test("the Redis key names are unchanged by the #5099 port (drift guard)", () => {
    assert.equal(BRIEF_LAST_SENT_KEY_LABEL, BRIEF_LAST_SENT_KEY, "reads the TS-owned last-sent key verbatim");
    assert.equal(BRIEF_MISSING_KEY_PREFIX, "hydra:autopilot:brief-missing");
    assert.deepEqual(briefMissingEpisodeKeys(), {
      since: "hydra:autopilot:brief-missing:absent-since",
      fired: "hydra:autopilot:brief-missing:fired",
    });
  });

  test("pages with kind brief:missing, dedupKey == kind, and the kind is on the closed page list + the ADR", async () => {
    assert.equal(BRIEF_MISSING_KIND, "brief:missing");
    assert.ok(isPageKind(BRIEF_MISSING_KIND), "brief:missing must be on PAGE_KINDS (ADR-0045 Decision 3)");
    assert.equal(PAGE_KINDS[PAGE_KINDS.length - 1], BRIEF_MISSING_KIND, "appended at the END of the closed list");
    assert.match(readFileSync(ADR, "utf-8"), /no Morning Brief delivered for 26h/, "the ADR's Decision 3 list names the page type");
    const h = makeHarness({ lastSent: T0 - 30 * HOUR_MS });
    await runBriefMissing(h.deps, cfg());
    assert.equal(h.pages.length, 1);
    assert.equal(h.pages[0].kind, BRIEF_MISSING_KIND);
    assert.equal(h.pages[0].dedupKey, BRIEF_MISSING_KIND);
  });

  test("the block is independent of the orchestrator: module imports no HTTP client and no scheduler read", () => {
    const src = readFileSync(join(REPO_ROOT, "src", "watchdog", "brief-missing.ts"), "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(src, /\bfetch\(|\/api\/|scheduler\/status|node:child_process/);
  });

  test("parseBriefStaleHours: default 26, base-10 (zero-padded '08' is 8), garbage falls back", () => {
    assert.equal(parseBriefStaleHours(undefined), 26);
    assert.equal(parseBriefStaleHours("48"), 48);
    assert.equal(parseBriefStaleHours("08"), 8);
    assert.equal(parseBriefStaleHours("abc"), 26);
    assert.equal(parseBriefStaleHours(""), 26);
  });
});

describe("decideBriefMissing — pure verdict table", () => {
  const thr = 26 * HOUR_MS;
  const base = { absentSinceMs: null, fired: false, nowMs: T0, thresholdMs: thr };

  test("stale stamp: page once, still-missing once fired", () => {
    assert.equal(decideBriefMissing({ ...base, lastSentMs: T0 - 27 * HOUR_MS }).kind, "page");
    assert.equal(decideBriefMissing({ ...base, lastSentMs: T0 - 27 * HOUR_MS, fired: true }).kind, "still-missing");
  });

  test("fresh stamp: fresh, or resolve when the fired marker existed", () => {
    assert.equal(decideBriefMissing({ ...base, lastSentMs: T0 - HOUR_MS }).kind, "fresh");
    assert.equal(decideBriefMissing({ ...base, lastSentMs: T0 - HOUR_MS, fired: true }).kind, "resolve");
  });

  test("no stamp: measures from the anchor (never-delivered); no anchor yet means grace from now", () => {
    assert.deepEqual(decideBriefMissing({ ...base, lastSentMs: null, absentSinceMs: T0 - 27 * HOUR_MS }), {
      kind: "page",
      reason: "never-delivered",
      referenceMs: T0 - 27 * HOUR_MS,
      ageMs: 27 * HOUR_MS,
    });
    assert.equal(decideBriefMissing({ ...base, lastSentMs: null }).kind, "grace");
    assert.equal(decideBriefMissing({ ...base, lastSentMs: null, absentSinceMs: T0 - HOUR_MS }).kind, "grace");
  });

  test("the threshold is inclusive and a future reference clamps age to 0", () => {
    assert.equal(decideBriefMissing({ ...base, lastSentMs: T0 - thr }).kind, "page");
    assert.equal(decideBriefMissing({ ...base, lastSentMs: T0 - thr + 1 }).kind, "fresh");
    assert.equal(decideBriefMissing({ ...base, lastSentMs: T0 + HOUR_MS }).ageMs, 0);
  });
});

describe("brief-missing — detection + delivery over fake ports (issue #5048)", () => {
  test("cold start: an absent key anchors absent-since at the first tick and pages nothing", async () => {
    const h = makeHarness();
    await runBriefMissing(h.deps, cfg());
    assert.match(h.text(), /never delivered yet: cold-start grace 0h of 26h/);
    assert.equal(h.state.anchor, T0, "absent-since anchored at the observing tick");
    assert.equal(h.state.fired, false, "no fired marker inside the grace window");
    assert.equal(h.pages.length, 0);
    assert.ok(h.logs.every((l) => l.startsWith(BRIEF_MISSING_LOG_PREFIX)));
  });

  test("cold start: the anchor older than 26h pages ONCE with reason never-delivered", async () => {
    const h = makeHarness({ anchor: T0 });
    await runBriefMissing(h.deps, cfg({ nowMs: T0 + 27 * HOUR_MS }));
    assert.match(h.text(), /WARNING MORNING BRIEF MISSING — never-delivered: no brief delivered for 27h/);
    assert.equal(h.state.fired, true, "fired marker set");
    assert.equal(h.pages.length, 1);
    assert.equal(h.pages[0].title, "No Morning Brief delivered for 27h");
    assert.deepEqual(h.pages[0].facts, [
      { label: "reason", value: "never-delivered" },
      { label: "age_h", value: "27" },
      { label: "threshold_h", value: "26" },
      { label: "last_sent_key", value: BRIEF_LAST_SENT_KEY },
    ]);
    assert.equal(h.state.anchor, T0, "the anchor is NOT re-stamped by the SET NX on a later tick");
  });

  test("the fired marker is SET before the page (dedup holds when delivery fails)", async () => {
    const h = makeHarness({ lastSent: T0 - 30 * HOUR_MS });
    h.deps.channel.page = async () => {
      assert.equal(h.state.fired, true, "marker set before delivery");
      throw new Error("telegram down");
    };
    await runBriefMissing(h.deps, cfg());
    assert.match(h.text(), /WARN operator-channel page FAILED/);
    assert.equal(h.state.fired, true);
  });

  test("stale key: a last-sent stamp older than 26h pages ONCE with reason stale and clears any anchor", async () => {
    const h = makeHarness({ lastSent: T0 - 30 * HOUR_MS, anchor: T0 - 5 * HOUR_MS });
    await runBriefMissing(h.deps, cfg());
    assert.match(h.text(), /WARNING MORNING BRIEF MISSING — stale: no brief delivered for 30h/);
    assert.equal(h.state.fired, true);
    assert.equal(h.state.anchor, null, "a present key clears any cold-start anchor");
    assert.equal(h.pages.length, 1);
    assert.equal(h.pages[0].facts[0].value, "stale");
  });

  test("dedup: a second consecutive stale tick does not page again", async () => {
    const h = makeHarness({ lastSent: T0 - 30 * HOUR_MS });
    await runBriefMissing(h.deps, cfg());
    await runBriefMissing(h.deps, cfg({ nowMs: T0 + 2 * 60 * 1000 }));
    assert.match(h.text(), /still missing — already paged this episode/);
    assert.equal(h.pages.length, 1, "the fired marker must hold the dedup");
  });

  test("recovery: a fresh stamp after a fired episode resolves ONCE and re-arms", async () => {
    const h = makeHarness({ lastSent: T0 - 30 * HOUR_MS });
    await runBriefMissing(h.deps, cfg());
    assert.equal(h.state.fired, true);

    h.state.lastSent = T0 - HOUR_MS; // the brief lands
    await runBriefMissing(h.deps, cfg());
    assert.match(h.text(), /morning brief delivered again — clearing the episode/);
    assert.match(h.text(), /morning brief fresh: last delivered 1h ago/);
    assert.equal(h.state.fired, false, "recovery must DEL the fired marker");
    assert.deepEqual(h.resolves, [{ dedupKey: "brief:missing", title: "Morning Brief delivered again" }]);

    await runBriefMissing(h.deps, cfg({ nowMs: T0 + 2 * 60 * 1000 }));
    assert.equal(h.resolves.length, 1, "no resolve on a quiet fresh tick");
    assert.equal(h.pages.length, 1);

    await runBriefMissing(h.deps, cfg({ nowMs: T0 + 26 * HOUR_MS }));
    assert.match(h.text(), /WARNING MORNING BRIEF MISSING — stale/);
    assert.equal(h.pages.length, 2, "a recurrence is a fresh episode and re-pages");
  });

  test("a fresh stamp with no prior episode stays quiet", async () => {
    const h = makeHarness({ lastSent: T0 - 2 * HOUR_MS });
    await runBriefMissing(h.deps, cfg());
    assert.doesNotMatch(h.text(), /WARNING/);
    assert.equal(h.pages.length, 0);
    assert.equal(h.resolves.length, 0);
    assert.equal(h.state.fired, false);
  });

  test("a healthy tick issues no DEL of absent-since when the anchor does not exist", async () => {
    const h = makeHarness({ lastSent: T0 - HOUR_MS });
    await runBriefMissing(h.deps, cfg());
    assert.ok(!h.ops.includes("deleteAnchor"), `ops were ${h.ops.join(",")}`);
  });

  test("honours the stale-hours hook", async () => {
    const h = makeHarness({ lastSent: T0 - 30 * HOUR_MS });
    await runBriefMissing(h.deps, cfg({ staleHours: 48 }));
    assert.doesNotMatch(h.text(), /WARNING/, "30h is fresh against a 48h threshold");
    assert.equal(h.pages.length, 0);
    await runBriefMissing(h.deps, cfg({ staleHours: 24 }));
    assert.match(h.text(), /WARNING MORNING BRIEF MISSING — stale/, "30h is stale against a 24h threshold");
    assert.equal(h.pages.length, 1);
  });

  test("an unparseable stamp (store reports null) is treated as absent: cold-start path, never fresh", async () => {
    const h = makeHarness({ lastSent: null });
    await runBriefMissing(h.deps, cfg());
    assert.match(h.text(), /never delivered yet/);
    assert.equal(h.state.anchor, T0);
    assert.equal(h.pages.length, 0);
  });

  test("fail-safe: an unreachable Redis pages nothing and leaves every state untouched", async () => {
    const h = makeHarness({ unreachable: true, anchor: T0 - 100 * HOUR_MS, fired: true });
    await runBriefMissing(h.deps, cfg({ nowMs: T0 + 100 * HOUR_MS }));
    assert.match(h.text(), /WARN Redis unreachable/, "the WARN names the cause");
    assert.doesNotMatch(h.text(), /WARNING MORNING BRIEF MISSING/, "an unreachable store must not masquerade as a missing brief");
    assert.doesNotMatch(h.text(), /tick processed/);
    assert.deepEqual(h.ops, [], "no state mutation");
    assert.equal(h.pages.length + h.resolves.length, 0);
    assert.equal(h.state.fired, true);
  });
});

describe("WATCHDOG_CHECKS — the one check table (issue #5099)", () => {
  test("order and bounds are today's tick order", () => {
    assert.deepEqual(
      WATCHDOG_CHECKS.map((c) => [c.subcommand, c.timeoutS]),
      [
        ["liveness", 300],
        ["wedge", 90],
        ["disk", 90],
        ["deploy-drift", 1200],
        ["redis-backup", 90],
        ["skill-mirror", 300],
        ["claude-hooks", 60],
        ["launch-flow", 90],
        ["brief-missing", 90],
        ["origin-identity", 120],
      ],
    );
  });

  test("log prefixes are unchanged so journal greps keep working", () => {
    assert.equal(DEPLOY_DRIFT_LOG_PREFIX, "hydra-deploy-drift-watchdog:");
    assert.equal(REDIS_BACKUP_LOG_PREFIX, "hydra-redis-backup-freshness-watchdog:");
    assert.equal(SKILL_MIRROR_LOG_PREFIX, "hydra-skill-mirror-drift-watchdog:");
    assert.equal(ORIGIN_IDENTITY_LOG_PREFIX, "hydra-origin-identity-watchdog:");
    assert.equal(BRIEF_MISSING_LOG_PREFIX, "hydra-brief-missing-watchdog:");
    assert.ok(WATCHDOG_CHECKS.every((c) => c.logPrefix.startsWith("hydra-") && c.logPrefix.endsWith("-watchdog:")));
  });

  test("the plan is one tab-separated 'subcommand prefix timeout' line per check", () => {
    const lines = formatWatchdogPlan().split("\n");
    assert.equal(lines.length, WATCHDOG_CHECKS.length);
    for (const [i, line] of lines.entries()) {
      const [sub, prefix, timeout] = line.split("\t");
      assert.equal(sub, WATCHDOG_CHECKS[i].subcommand);
      assert.equal(prefix, WATCHDOG_CHECKS[i].logPrefix);
      assert.equal(Number(timeout), WATCHDOG_CHECKS[i].timeoutS);
    }
  });
});

describe("watchdog page kinds and the service unit (ADR-0045 D2, issue #5046)", () => {
  test("every watchdog page kind is on the closed page list", () => {
    for (const k of [REDIS_BACKUP_STALE_KIND, ORIGIN_IDENTITY_PAGE_KIND, "infra:node_modules_wiped", "infra:watchdog_cli_failed", BRIEF_MISSING_KIND]) {
      assert.ok(isPageKind(k), `${k} must be on the closed page list`);
    }
    assert.match(readFileSync(ADR, "utf-8"), /infra:watchdog_cli_failed/, "ADR-0045 Decision 3 lists the CLI-start alarm");
  });

  test("ported modules page with dedupKey == kind", () => {
    for (const f of ["redis-backup.ts", "origin-identity.ts"]) {
      const src = readFileSync(join(REPO_ROOT, "src", "watchdog", f), "utf-8");
      assert.match(src, /dedupKey: (REDIS_BACKUP_STALE_KIND|ORIGIN_IDENTITY_PAGE_KIND)/, `${f} pages with dedupKey == kind`);
    }
  });

  test("hydra-watchdog.service loads %h/hydra/.env dash-prefixed (the other checks must run without it)", () => {
    const unit = readFileSync(join(REPO_ROOT, "scripts", "systemd", "hydra-watchdog.service"), "utf-8");
    assert.match(unit, /^EnvironmentFile=-%h\/hydra\/\.env$/m, "expected EnvironmentFile=-%h/hydra/.env under [Service]");
    assert.doesNotMatch(unit, /^EnvironmentFile=%h/m, "must stay optional (dash-prefixed): a missing .env never silences the other checks");
    assert.doesNotMatch(unit, /^Environment=TELEGRAM_/m, "never an inline credential");
  });

  test("hydra-watchdog.service puts %h/.local/bin ahead of /usr/bin so `gh` resolves to the maintained binary, not apt's stale one", () => {
    const unit = readFileSync(join(REPO_ROOT, "scripts", "systemd", "hydra-watchdog.service"), "utf-8");
    const m = unit.match(/^Environment=PATH=(.+)$/m);
    assert.ok(m, "expected an explicit Environment=PATH= (systemd's default PATH has no ~/.local/bin)");
    const dirs = m[1].split(":");
    const local = dirs.indexOf("%h/.local/bin");
    const usr = dirs.indexOf("/usr/bin");
    assert.ok(local >= 0, "PATH must include %h/.local/bin");
    assert.ok(usr < 0 || local < usr, "%h/.local/bin must precede /usr/bin");
  });
});

describe("watchdog port boundaries (issues #5097, #5098, #5099)", () => {
  const cli = (): string => readFileSync(join(REPO_ROOT, "scripts", "hydra-watchdog.ts"), "utf-8");
  const read = (f: string): string => readFileSync(join(REPO_ROOT, "src", "watchdog", f), "utf-8");
  const launchModules = (): string[] => ["launch-flow.ts", "episode.ts", "ports.ts"].map(read);

  test("the predicates are imported, never re-typed: no 45-min / 90-min literals in the CLI or src/watchdog (INV-1)", () => {
    for (const src of [cli(), ...launchModules()]) {
      assert.doesNotMatch(src, /2700000|5400000/);
    }
  });

  test("pages go through the Operator Channel module in-process: no operator-notify spawn, no Bot API host, no hand-built XADD", () => {
    for (const src of [cli(), ...launchModules()]) {
      assert.ok(!src.includes("operator-notify"));
      assert.ok(!src.includes("api.telegram.org"));
      assert.doesNotMatch(src, /xadd/i);
    }
    for (const f of ["deploy-drift.ts", "skill-mirror.ts", "redis-backup.ts", "origin-identity.ts", "drift-gate.ts", "brief-missing.ts", "claude-hooks.ts", "checks.ts"]) {
      const src = read(f);
      assert.ok(!src.includes("operator-notify"), f);
      assert.ok(!src.includes("api.telegram.org"), f);
      assert.doesNotMatch(src, /xadd/i, f);
      assert.doesNotMatch(src, /from "node:child_process"/, f);
    }
  });

  test("git-remote-fence.sh is NOT edited: it never parses, normalises, redacts or prints a remote URL (INV-11)", () => {
    const fence = readFileSync(join(REPO_ROOT, "scripts", "claude-hooks", "git-remote-fence.sh"), "utf-8");
    assert.doesNotMatch(fence, /redact|remote-url\.ts/i);
  });
});
