/**
 * The ORIGIN IDENTITY watchdog check (issues #4939, #5026, #5065, #5140;
 * ported to TypeScript in #5098). The former bash suite's cases, 1:1 by case,
 * over in-memory fake ports (test/_helpers/watchdog-drift-fakes.mts) — no bash,
 * no PATH shims, no real git.
 */

import { WATCHDOG_CHECKS } from "../src/watchdog/checks.ts";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ORIGIN_FETCH_REFSPEC,
  ORIGIN_IDENTITY_LOG_PREFIX,
  ORIGIN_IDENTITY_PAGE_KIND,
  decideOriginIdentity,
  parseSinceMarker,
  runOriginIdentity,
  type OriginIdentityConfig,
} from "../src/watchdog/origin-identity.ts";
import { NOW_S, makeOriginHarness, type OriginHarness } from "./_helpers/watchdog-drift-fakes.mts";

const GOOD = "https://github.com/gaberoo322/hydra.git";
const TARGET = "https://github.com/gaberoo322/claw-street-bets.git";
const root = "/home/gabe/hydra";

const cfg = (over: Partial<OriginIdentityConfig> = {}): OriginIdentityConfig => ({
  root,
  expectedRepo: "gaberoo322/hydra",
  expectedHost: "github.com",
  canonicalEnv: undefined,
  autoRepair: true,
  fetchTimeoutS: 60,
  backoffS: 600,
  ...over,
});
const text = (h: OriginHarness): string => h.logs.join("\n");
const payloadOf = (h: OriginHarness, i = 0): Record<string, unknown> => h.reports[i].payload;

describe("run_origin_identity (#4939)", () => {
  it("is silent for the expected https URL with origin/master present", async () => {
    const h = makeOriginHarness();
    await runOriginIdentity(h.deps, cfg());
    assert.doesNotMatch(text(h), /ALARM/);
    assert.equal(h.reports.length, 0);
    assert.equal(h.pages.length, 0);
    assert.match(text(h), /origin-identity tick processed \(origin=gaberoo322\/hydra, origin_master=present\)/);
    assert.ok(h.logs.every((l) => l.startsWith(ORIGIN_IDENTITY_LOG_PREFIX)));
  });

  it("accepts the ssh form of the expected repo", async () => {
    const h = makeOriginHarness();
    h.state.url = "git@github.com:gaberoo322/hydra.git";
    await runOriginIdentity(h.deps, cfg({ autoRepair: false }));
    // scp-style host is github.com -> no wrong-origin-host; same repo -> no wrong-origin-url.
    assert.equal(h.reports.length, 0);
    assert.doesNotMatch(text(h), /ALARM/);
  });

  it("alarms with exactly ONE channel.report() for a Target-repo origin URL, deduped across ticks", async () => {
    const h = makeOriginHarness();
    h.state.url = TARGET;
    await runOriginIdentity(h.deps, cfg({ autoRepair: false }));
    assert.equal(h.reports.length, 1);
    assert.equal(h.reports[0].kind, "infra:origin_identity_wrong");
    assert.deepEqual(Object.keys(h.reports[0].payload).sort(), ["fetch", "newUrl", "note", "reason", "repair", "signal", "url"]);
    assert.equal(payloadOf(h).signal, "origin-identity");
    assert.equal(payloadOf(h).reason, "wrong-origin-url");
    assert.equal(payloadOf(h).repair, "not-attempted");
    assert.match(text(h), /ALARM ~\/hydra origin identity broken: wrong-origin-url/);
    assert.equal(h.pages.length, 1);
    assert.equal(h.pages[0].kind, ORIGIN_IDENTITY_PAGE_KIND);
    assert.equal(h.pages[0].dedupKey, ORIGIN_IDENTITY_PAGE_KIND, "dedupKey == kind");
    // The since-marker records the outcome; a second tick with the same outcome publishes nothing.
    assert.equal(parseSinceMarker(h.files.since)?.outcome, "alarm");
    await runOriginIdentity(h.deps, cfg({ autoRepair: false }));
    assert.equal(h.reports.length, 1);
    assert.equal(h.pages.length, 1);
  });

  it("never leaks URL credentials into the log line, the event payload or a Page fact", async () => {
    const h = makeOriginHarness();
    h.state.url = "https://octo:ghp_SECRETTOKEN@github.com/gaberoo322/claw-street-bets.git";
    await runOriginIdentity(h.deps, cfg({ autoRepair: false }));
    const everything = JSON.stringify([h.logs, h.reports, h.pages]);
    assert.doesNotMatch(everything, /SECRETTOKEN|octo/);
    assert.match(String(payloadOf(h).url), /https:\/\/github\.com\/gaberoo322\/claw-street-bets\.git/);
  });

  it("redacts userinfo up to the LAST @ (a token containing @ never leaks)", async () => {
    const h = makeOriginHarness();
    h.state.url = "https://user:ghp_ab@cd@github.com/gaberoo322/claw-street-bets.git";
    await runOriginIdentity(h.deps, cfg({ autoRepair: false }));
    assert.doesNotMatch(JSON.stringify([h.logs, h.reports, h.pages]), /ghp_ab|cd@/);
  });

  it("redacts userinfo up to the LAST @ even when the token contains `/` (QA round 4)", async () => {
    const h = makeOriginHarness();
    h.state.url = "https://user:ghp_a/b@github.com/gaberoo322/claw-street-bets.git";
    await runOriginIdentity(h.deps, cfg({ autoRepair: false }));
    assert.doesNotMatch(JSON.stringify([h.logs, h.reports, h.pages]), /ghp_a/);
  });

  it("alarms wrong-origin-host when the host is not the expected one", async () => {
    const h = makeOriginHarness();
    h.state.url = "https://gitlab.example.com/gaberoo322/hydra.git";
    await runOriginIdentity(h.deps, cfg({ autoRepair: false }));
    assert.equal(payloadOf(h).reason, "wrong-origin-host");
    assert.match(text(h), /wrong-origin-host/);
  });

  it("one report() even when delivery fails (store down): since-marker written, no second report next tick (#5390 INV-9)", async () => {
    const h = makeOriginHarness();
    h.state.url = TARGET;
    h.state.failReport = true;
    await runOriginIdentity(h.deps, cfg({ autoRepair: false }));
    assert.equal(h.reports.length, 1);
    assert.notEqual(h.files.since, null, "report() never throws, so the marker is written unconditionally");
    await runOriginIdentity(h.deps, cfg({ autoRepair: false }));
    assert.equal(h.reports.length, 1, "no retry storm: the episode is already marked");
  });

  it("alarms on a correct URL when refs/remotes/origin/master does not resolve", async () => {
    const h = makeOriginHarness();
    h.state.masterPresent = false;
    await runOriginIdentity(h.deps, cfg({ autoRepair: false }));
    assert.equal(payloadOf(h).reason, "origin-master-missing");
    assert.match(text(h), /refs\/remotes\/origin\/master MISSING/);
  });

  it("clears the marker on recovery, resolves the Page, and re-arms dedup", async () => {
    const h = makeOriginHarness();
    h.state.url = TARGET;
    await runOriginIdentity(h.deps, cfg({ autoRepair: false }));
    h.state.url = GOOD;
    await runOriginIdentity(h.deps, cfg({ autoRepair: false }));
    assert.equal(h.files.since, null);
    assert.match(text(h), /origin identity healthy again/);
    assert.deepEqual(h.resolves, [{ key: ORIGIN_IDENTITY_PAGE_KIND, title: "~/hydra origin identity healthy again" }]);
    h.state.url = TARGET;
    await runOriginIdentity(h.deps, cfg({ autoRepair: false }));
    assert.equal(h.reports.length, 2, "a recurrence reports fresh");
  });

  it("logs an INFO line when .git/config mtime moves between ticks", async () => {
    const h = makeOriginHarness();
    h.state.configMtimeS = 1_700_000_000;
    await runOriginIdentity(h.deps, cfg());
    assert.doesNotMatch(text(h), /INFO .git\/config changed/);
    h.state.configMtimeS = 1_700_000_100;
    await runOriginIdentity(h.deps, cfg());
    assert.match(text(h), /INFO \.git\/config changed at 2023-11-14T22:15:00Z/);
  });

  it("fails safe when HYDRA_ROOT has no .git", async () => {
    const h = makeOriginHarness();
    h.state.hasGitDir = false;
    await runOriginIdentity(h.deps, cfg());
    assert.match(text(h), /WARN \/home\/gabe\/hydra\/\.git not found — skipping origin identity check/);
    assert.equal(h.reports.length, 0);
  });

  it("skips the tick on a git tooling failure (exit > 1), but treats an absent key (exit 1) as a finding", async () => {
    const tooling = makeOriginHarness();
    tooling.state.url = { error: 128 };
    await runOriginIdentity(tooling.deps, cfg());
    assert.match(text(tooling), /WARN git config read failed \(rc=128\) — skipping origin identity check/);
    assert.equal(tooling.reports.length, 0);

    const absent = makeOriginHarness();
    absent.state.url = "absent";
    await runOriginIdentity(absent.deps, cfg({ autoRepair: false }));
    assert.equal(payloadOf(absent).reason, "wrong-origin-url+wrong-origin-host");
    assert.match(text(absent), /remote\.origin\.url=<unset>/);
  });

  it("cannot create the state dir: one WARN, nothing else", async () => {
    const h = makeOriginHarness();
    h.state.stateDirOk = false;
    await runOriginIdentity(h.deps, cfg());
    assert.equal(h.logs.length, 1);
    assert.match(text(h), /WARN cannot create state dir/);
  });
});

describe("run_origin_identity auto-repair (#5065)", () => {
  it("rewrites a wrong origin URL to the canonical one, fetches, re-verifies and notifies 'repaired'", async () => {
    const h = makeOriginHarness();
    h.state.url = TARGET;
    h.state.masterPresent = false;
    await runOriginIdentity(h.deps, cfg());
    assert.deepEqual(h.gitCalls, [`set-url ${GOOD}`, "fetch 60000"]);
    assert.equal(payloadOf(h).repair, "repaired");
    assert.equal(payloadOf(h).fetch, "ok");
    assert.equal(payloadOf(h).newUrl, GOOD);
    assert.match(text(h), /REPAIRED ~\/hydra origin identity: wrong-origin-url\+origin-master-missing/);
    assert.equal(h.reports.length, 1, "repaired: one report() carrying the brief disposition");
    assert.equal(h.pages.length, 0, "repaired is the recovery edge: a brief item plus a resolve, never a page");
    assert.equal(h.resolves.length, 1);
    assert.equal(parseSinceMarker(h.files.since)?.outcome, "repaired");
  });

  it("a removed remote (no fetch refspec) gets the default refspec before the fetch", async () => {
    const h = makeOriginHarness();
    h.state.url = TARGET;
    h.state.hasRefspec = false;
    await runOriginIdentity(h.deps, cfg());
    assert.deepEqual(h.gitCalls, [`set-url ${GOOD}`, "set-refspec", "fetch 60000"]);
    assert.equal(ORIGIN_FETCH_REFSPEC, "+refs/heads/*:refs/remotes/origin/*");
  });

  it("fetches a missing origin/master when the URL is already correct (no URL rewrite)", async () => {
    const h = makeOriginHarness();
    h.state.masterPresent = false;
    await runOriginIdentity(h.deps, cfg());
    assert.deepEqual(h.gitCalls, ["fetch 60000"]);
    assert.equal(payloadOf(h).repair, "repaired");
  });

  it("kill switch HYDRA_WATCHDOG_ORIGIN_AUTOREPAIR=0 leaves the repo untouched and alarms as before", async () => {
    const h = makeOriginHarness();
    h.state.url = TARGET;
    await runOriginIdentity(h.deps, cfg({ autoRepair: false }));
    assert.deepEqual(h.gitCalls, []);
    assert.match(text(h), /auto-repair disabled \(HYDRA_WATCHDOG_ORIGIN_AUTOREPAIR=0\)/);
    assert.equal(h.pages.length, 1);
  });

  it("never acts when the canonical URL is set but empty", async () => {
    const h = makeOriginHarness();
    h.state.url = TARGET;
    await runOriginIdentity(h.deps, cfg({ canonicalEnv: "" }));
    assert.deepEqual(h.gitCalls, []);
    assert.match(text(h), /auto-repair skipped \(expected repo or canonical URL is empty\)/);
  });

  it("a set-but-empty canonical URL with an unset origin URL still raises wrong-origin-url", () => {
    const d = decideOriginIdentity({
      url: "",
      masterPresent: true,
      expectedRepo: "gaberoo322/hydra",
      expectedHost: "github.com",
      canonicalEnv: "",
      autoRepair: true,
      hasGitDir: true,
      prev: null,
      nowS: NOW_S,
      backoffS: 600,
    });
    assert.ok(d.reasons.includes("wrong-origin-url"));
  });

  it("an operator-overridden canonical URL (a mirror) is an acceptable identity, host included", () => {
    const d = decideOriginIdentity({
      url: "https://mirror.example.com/org/hydra-mirror.git",
      masterPresent: true,
      expectedRepo: "gaberoo322/hydra",
      expectedHost: "github.com",
      canonicalEnv: "https://mirror.example.com/org/hydra-mirror.git",
      autoRepair: true,
      hasGitDir: true,
      prev: null,
      nowS: NOW_S,
      backoffS: 600,
    });
    assert.deepEqual(d.reasons, []);
  });

  it("a failed repair (the fetch fails) still alarms, reports the failure, and dedups", async () => {
    const h = makeOriginHarness();
    h.state.url = TARGET;
    h.state.fetch = { ok: false, exitCode: 128, timedOut: false, stderr: "fatal: could not read from https://u:TOKEN@host/x" };
    await runOriginIdentity(h.deps, cfg());
    assert.equal(payloadOf(h).repair, "failed");
    assert.match(String(payloadOf(h).note), /auto-repair FAILED: origin fetch failed \(rc=128\)/);
    assert.equal(h.pages.length, 1);
    assert.doesNotMatch(JSON.stringify([h.logs, h.reports]), /TOKEN/);
    const before = h.reports.length;
    await runOriginIdentity(h.deps, cfg());
    assert.equal(h.reports.length, before, "same outcome inside the backoff window publishes nothing");
  });

  it("an alarm that later self-heals republishes once as 'repaired'", async () => {
    const h = makeOriginHarness();
    h.state.url = TARGET;
    await runOriginIdentity(h.deps, cfg({ autoRepair: false }));
    assert.equal(parseSinceMarker(h.files.since)?.outcome, "alarm");
    await runOriginIdentity(h.deps, cfg());
    assert.equal(h.reports.length, 2);
    assert.equal(payloadOf(h, 1).repair, "repaired");
    assert.equal(parseSinceMarker(h.files.since)?.outcome, "repaired");
  });

  it("skips repair when the expected repo is empty", async () => {
    const h = makeOriginHarness();
    await runOriginIdentity(h.deps, cfg({ expectedRepo: "" }));
    assert.deepEqual(h.gitCalls, []);
    assert.match(text(h), /auto-repair skipped \(expected repo or canonical URL is empty\)/);
  });

  it("reports a timed-out fetch and passes the configured timeout", async () => {
    const h = makeOriginHarness();
    h.state.url = TARGET;
    h.state.fetch = { ok: false, exitCode: -1, timedOut: true, stderr: "" };
    await runOriginIdentity(h.deps, cfg({ fetchTimeoutS: 7 }));
    assert.deepEqual(h.gitCalls, [`set-url ${GOOD}`, "fetch 7000"]);
    assert.equal(payloadOf(h).fetch, "failed-rc-124");
    assert.match(String(payloadOf(h).note), /origin fetch timed out after 7s/);
  });

  it("a URL write that git then reports as still wrong is re-verified against real git and fails", async () => {
    const h = makeOriginHarness();
    h.state.url = TARGET;
    h.state.urlAfterSet = TARGET;
    await runOriginIdentity(h.deps, cfg());
    assert.match(String(payloadOf(h).note), /origin URL still wrong after repair/);
  });

  it("a fetch that leaves origin/master missing is re-verified and fails", async () => {
    const h = makeOriginHarness();
    h.state.masterPresent = false;
    h.state.fetchFixesMaster = false;
    await runOriginIdentity(h.deps, cfg());
    assert.match(String(payloadOf(h).note), /refs\/remotes\/origin\/master still missing after fetch/);
  });

  it("could-not-rewrite and could-not-set-refspec are reported as failed repairs", async () => {
    const a = makeOriginHarness();
    a.state.url = TARGET;
    a.state.setUrlOk = false;
    await runOriginIdentity(a.deps, cfg());
    assert.match(String(payloadOf(a).note), /could not rewrite remote\.origin\.url/);
    assert.deepEqual(a.gitCalls, [`set-url ${GOOD}`], "no fetch after a failed rewrite");

    const b = makeOriginHarness();
    b.state.url = TARGET;
    b.state.hasRefspec = false;
    b.state.setRefspecOk = false;
    await runOriginIdentity(b.deps, cfg());
    assert.match(String(payloadOf(b).note), /could not set remote\.origin\.fetch/);
  });

  it("backs off after a failed repair instead of refetching every tick, restamping only lastAttempt after the window", async () => {
    const h = makeOriginHarness();
    h.state.url = TARGET;
    h.files.since = `${NOW_S - 5000} failed ${NOW_S - 100}\n`;
    await runOriginIdentity(h.deps, cfg());
    assert.deepEqual(h.gitCalls, [], "inside the 600s backoff: no repair attempted");
    assert.match(text(h), /backing off 600s after a failed attempt/);

    h.files.since = `${NOW_S - 5000} failed ${NOW_S - 700}\n`;
    h.state.fetch = { ok: false, exitCode: 1, timedOut: false, stderr: "" };
    await runOriginIdentity(h.deps, cfg());
    assert.equal(h.gitCalls.length > 0, true, "past the backoff a fresh attempt runs");
    assert.deepEqual(h.files.written.at(-1), `${NOW_S - 5000} failed ${NOW_S}`, "same-outcome failed restamps lastAttempt only");
    assert.equal(h.reports.length, 0, "no republish for a same-outcome failure");
  });

  it("a legacy bare-epoch marker reads as outcome 'alarm'", () => {
    assert.deepEqual(parseSinceMarker("1700000000\n"), { first: "1700000000", outcome: "alarm", attempt: "" });
    assert.equal(parseSinceMarker(null), null);
    assert.equal(parseSinceMarker("")?.outcome, "alarm");
  });

  it("WATCHDOG_CHECKS runs origin-identity LAST (just after brief-missing) with the 120s bound", () => {
    const last = WATCHDOG_CHECKS.at(-1);
    assert.equal(last?.subcommand, "origin-identity");
    assert.equal(last?.timeoutS, 120);
    assert.equal(last?.logPrefix, ORIGIN_IDENTITY_LOG_PREFIX);
    assert.equal(WATCHDOG_CHECKS.at(-2)?.subcommand, "brief-missing");
  });

  it("no module in src/watchdog imports node:child_process (every effect rides a seam)", () => {
    for (const f of ["origin-identity.ts", "deploy-drift.ts", "skill-mirror.ts", "redis-backup.ts", "drift-gate.ts", "ports.ts"]) {
      const src = readFileSync(join(import.meta.dirname, "..", "src", "watchdog", f), "utf8");
      assert.doesNotMatch(src, /from "node:child_process"/, f);
    }
  });
});
