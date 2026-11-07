/**
 * watchdog/origin-identity.ts — the ORIGIN IDENTITY check (issue #5098, epic
 * #5094, slice 4/5; ADR-0040 Decision 2 shape). Ported from `run_origin_identity`
 * in scripts/hydra-watchdog.sh (#4939 alarm, #5065 auto-repair, #5026 host,
 * #5140 post-publish marker).
 *
 * Every ~/hydra worktree shares one .git/config, so a Target dispatch can rewrite
 * `remote.origin.url` and a pruning fetch then delete refs/remotes/origin/master.
 * This check alarms (and, by default, self-heals) when the normalised origin is
 * not the expected repo, the host is wrong, or origin/master does not resolve.
 *
 * Dedup is by OUTCOME TRANSITION (alarm | repaired | failed) against a FILE
 * marker `<first> <outcome> <lastAttempt>`, written once report() has returned
 * (it never throws). It deliberately does NOT use `runEpisode` (outcome-transition
 * dedup, not a duration threshold).
 *
 * MUTATION FENCE: every repair is `git -C <root> ...` through the typed
 * src/github/git.ts helpers, limited to `config remote.origin.url`,
 * `config remote.origin.fetch` (only when absent) and `fetch --quiet origin`.
 * After a repair both checks are re-verified against real git.
 */

import { NOTIFICATION_EVENT_TYPES as E } from "../event-bus-vocabulary.ts";
import type { FetchOriginResult, GitConfigRead } from "../github/git.ts";
import { normaliseRemoteRepo, redactUrlUserinfo, redactUrlUserinfoText, remoteHost } from "../github/remote-url.ts";
import type { OperatorChannel } from "../operator-channel/channel.ts";

export const ORIGIN_IDENTITY_LOG_PREFIX = "hydra-origin-identity-watchdog:";

/** Wrapper bound (INV-14): 60s fetch + 5s kill + channel. */
export const ORIGIN_IDENTITY_TIMEOUT_S = 120;

export const ORIGIN_IDENTITY_PAGE_KIND = E.INFRA_ORIGIN_IDENTITY_WRONG;

export const DEFAULT_ORIGIN_HOST = "github.com";
export const DEFAULT_ORIGIN_FETCH_TIMEOUT_S = 60;
export const DEFAULT_ORIGIN_REPAIR_BACKOFF_S = 600;
export const ORIGIN_FETCH_REFSPEC = "+refs/heads/*:refs/remotes/origin/*";

export type OriginOutcome = "alarm" | "repaired" | "failed";

export interface OriginIdentityConfig {
  root: string;
  /** Expected `owner/repo`. An explicit empty value is honoured (repair then refuses to act). */
  expectedRepo: string;
  expectedHost: string;
  /** `HYDRA_WATCHDOG_CANONICAL_ORIGIN_URL` as set (`undefined` = unset; `""` = set-but-empty). */
  canonicalEnv: string | undefined;
  /** `HYDRA_WATCHDOG_ORIGIN_AUTOREPAIR !== "0"`. */
  autoRepair: boolean;
  fetchTimeoutS: number;
  backoffS: number;
}

/** The since-marker: `<first> <outcome> <lastAttempt>`; a legacy bare epoch reads as outcome `alarm`. */
export interface SinceMarker {
  first: string;
  outcome: string;
  attempt: string;
}

/** Parse the marker file text (`null` = no file). A present-but-outcome-less file reads as `alarm`. */
export function parseSinceMarker(raw: string | null): SinceMarker | null {
  if (raw === null) return null;
  const [first = "", outcome = "", attempt = ""] = raw.split("\n")[0].trim().split(/\s+/);
  return { first, outcome: outcome || "alarm", attempt };
}

export interface OriginIdentityDeps {
  files: {
    /** Creates the state dir; `false` = cannot. */
    ensureStateDir(): boolean;
    /** `.git/config` mtime in epoch seconds, or `null` when absent. */
    configMtimeS(root: string): number | null;
    readMtimeMarker(): string | null;
    writeMtimeMarker(mtimeS: number): void;
    /** Raw since-marker text, or `null` when the file does not exist. */
    readSince(): string | null;
    writeSince(line: string): void;
    clearSince(): void;
    /** Whether `<root>/.git` exists (a dir or a worktree gitfile). */
    hasGitDir(root: string): boolean;
  };
  git: {
    readOriginUrl(root: string): Promise<GitConfigRead>;
    masterResolves(root: string): Promise<boolean>;
    setOriginUrl(root: string, url: string): Promise<boolean>;
    hasFetchRefspec(root: string): Promise<boolean>;
    setFetchRefspec(root: string): Promise<boolean>;
    fetchOrigin(root: string, timeoutMs: number): Promise<FetchOriginResult>;
  };
  channel: Pick<OperatorChannel, "report" | "resolve">;
  clock: { nowMs(): number };
  log: (line: string) => void;
}

/** What to do about the findings, before any git call. */
export type RepairPlan =
  | { kind: "skip"; outcome: "alarm"; note: string }
  | { kind: "backoff"; outcome: "failed"; note: string }
  | { kind: "attempt"; rewriteUrl: boolean };

export interface OriginDecision {
  norm: string;
  wantNorm: string;
  canonical: string;
  canonNorm: string;
  host: string;
  reasons: string[];
  plan: RepairPlan;
}

/**
 * Pure verdict + repair plan. Canonical-URL acceptance and the set-but-empty
 * canonical guard are verbatim from the bash: an empty `canonNorm` never counts
 * as an acceptable identity (it would match an unset origin URL and mask
 * wrong-origin-url, #5026 QA round 2).
 */
export function decideOriginIdentity(input: {
  url: string;
  masterPresent: boolean;
  expectedRepo: string;
  expectedHost: string;
  canonicalEnv: string | undefined;
  autoRepair: boolean;
  hasGitDir: boolean;
  prev: SinceMarker | null;
  nowS: number;
  backoffS: number;
}): OriginDecision {
  const norm = normaliseRemoteRepo(input.url);
  const wantNorm = input.expectedRepo.toLowerCase();
  const canonical =
    input.canonicalEnv !== undefined
      ? input.canonicalEnv
      : input.expectedRepo !== ""
        ? `https://github.com/${input.expectedRepo}.git`
        : "";
  const canonNorm = canonical !== "" ? normaliseRemoteRepo(canonical) : "";
  const host = remoteHost(input.url);
  const wantHost = input.expectedHost.toLowerCase();

  const matchesCanonical = canonNorm !== "" && norm === canonNorm;
  const reasons: string[] = [];
  if (wantNorm === "" || (norm !== wantNorm && !matchesCanonical)) reasons.push("wrong-origin-url");
  if (host !== wantHost && ((input.canonicalEnv ?? "") === "" || !matchesCanonical)) reasons.push("wrong-origin-host");
  if (!input.masterPresent) reasons.push("origin-master-missing");

  let plan: RepairPlan;
  if (!input.autoRepair) {
    plan = { kind: "skip", outcome: "alarm", note: "auto-repair disabled (HYDRA_WATCHDOG_ORIGIN_AUTOREPAIR=0)" };
  } else if (wantNorm === "" || canonical === "") {
    plan = { kind: "skip", outcome: "alarm", note: "auto-repair skipped (expected repo or canonical URL is empty)" };
  } else if (!input.hasGitDir) {
    plan = { kind: "skip", outcome: "alarm", note: `auto-repair skipped (no gitdir under ${"<root>"})` };
  } else if (
    input.prev?.outcome === "failed" &&
    /^[0-9]+$/.test(input.prev.attempt) &&
    input.nowS - Number(input.prev.attempt) < input.backoffS
  ) {
    plan = { kind: "backoff", outcome: "failed", note: `auto-repair FAILED: backing off ${input.backoffS}s after a failed attempt` };
  } else {
    plan = { kind: "attempt", rewriteUrl: reasons.includes("wrong-origin-url") || reasons.includes("wrong-origin-host") };
  }
  return { norm, wantNorm, canonical, canonNorm, host, reasons, plan };
}

/** Drop everything outside the bash `tr -dc` sets used on the payload fields. */
const cleanUrl = (s: string): string => s.replace(/[^a-zA-Z0-9_.:/@<>-]/g, "");
const cleanNote = (s: string): string => s.replace(/[^a-zA-Z0-9_.:/@<>()=, -]/g, "");

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** One watchdog tick of the origin-identity check. Never throws. */
export async function runOriginIdentity(deps: OriginIdentityDeps, config: OriginIdentityConfig): Promise<void> {
  const say = (line: string): void => deps.log(`${ORIGIN_IDENTITY_LOG_PREFIX} ${line}`);
  try {
    await tick(deps, config, say);
  } catch (err) {
    say(`WARN origin-identity tick failed: ${msg(err)}`);
  }
}

async function tick(deps: OriginIdentityDeps, config: OriginIdentityConfig, say: (line: string) => void): Promise<void> {
  const { root } = config;
  if (!deps.files.ensureStateDir()) {
    say("WARN cannot create state dir — skipping origin identity check");
    return;
  }

  // --- Forensic breadcrumb (read-only stat) ---
  const mtimeS = deps.files.configMtimeS(root);
  if (mtimeS !== null) {
    const prevMt = deps.files.readMtimeMarker();
    if (prevMt !== null && prevMt !== "" && prevMt !== String(mtimeS)) {
      say(`INFO .git/config changed at ${new Date(mtimeS * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")}`);
    }
    deps.files.writeMtimeMarker(mtimeS);
  }

  // --- Observed origin URL ---
  if (!deps.files.hasGitDir(root)) {
    say(`WARN ${root}/.git not found — skipping origin identity check`);
    return;
  }
  const read = await deps.git.readOriginUrl(root);
  if (read.kind === "error") {
    say(`WARN git config read failed (rc=${read.exitCode}) — skipping origin identity check`);
    return;
  }
  // `git config --get` exit 1 = key absent: a finding (no origin), url is "".
  const url = read.kind === "value" ? read.value : "";
  const masterPresent = await deps.git.masterResolves(root);

  const nowS = Math.floor(deps.clock.nowMs() / 1000);
  const prevRaw = deps.files.readSince();
  const prev = parseSinceMarker(prevRaw);
  const decision = decideOriginIdentity({
    url,
    masterPresent,
    expectedRepo: config.expectedRepo,
    expectedHost: config.expectedHost,
    canonicalEnv: config.canonicalEnv,
    autoRepair: config.autoRepair,
    hasGitDir: true,
    prev,
    nowS,
    backoffS: config.backoffS,
  });

  if (decision.reasons.length === 0) {
    if (prevRaw !== null) {
      say(`origin identity healthy again (origin=${decision.norm}, origin/master resolves) — dedup re-armed`);
      await deliverResolve(deps, say, "~/hydra origin identity healthy again");
    }
    deps.files.clearSince();
    say(`origin-identity tick processed (origin=${decision.norm}, origin_master=present)`);
    return;
  }

  const reasonStr = decision.reasons.join("+");
  const shownUrl = redactUrlUserinfo(url === "" ? "<unset>" : url);

  // --- Auto-repair (#5065): only $HYDRA_ROOT, only remote.origin.*, only fetch ---
  let outcome: OriginOutcome = decision.plan.kind === "backoff" ? "failed" : "alarm";
  let repairNote = decision.plan.kind === "attempt" ? "" : decision.plan.note.replace("<root>", root);
  let fetchResult = "skipped";
  let newUrl = url;
  let attempted = false;

  if (decision.plan.kind === "attempt") {
    attempted = true;
    outcome = "repaired";
    if (decision.plan.rewriteUrl) {
      if (await deps.git.setOriginUrl(root, decision.canonical)) {
        newUrl = decision.canonical;
        // A remote removed outright has no fetch refspec; a bare fetch would never recreate refs/remotes/origin/*.
        if (!(await deps.git.hasFetchRefspec(root)) && !(await deps.git.setFetchRefspec(root))) {
          outcome = "failed";
          repairNote = "could not set remote.origin.fetch";
        }
      } else {
        outcome = "failed";
        repairNote = "could not rewrite remote.origin.url";
      }
    }
    if (outcome === "repaired") {
      const fetched = await deps.git.fetchOrigin(root, config.fetchTimeoutS * 1000);
      if (fetched.ok) {
        fetchResult = "ok";
      } else {
        const rc = fetched.timedOut ? 124 : fetched.exitCode;
        fetchResult = `failed-rc-${rc}`;
        outcome = "failed";
        repairNote = fetched.timedOut
          ? `origin fetch timed out after ${config.fetchTimeoutS}s`
          : `origin fetch failed (rc=${rc})`;
        const head = fetched.stderr.split("\n").slice(0, 3).join("\n");
        if (head.trim() !== "") {
          say(`WARN fetch stderr: ${redactUrlUserinfoText(head).replace(/\n/g, " ")}`);
        }
      }
    }
    if (outcome === "repaired") {
      // Re-verify against real git, never against injected inputs.
      const post = await deps.git.readOriginUrl(root);
      const postUrl = post.kind === "value" ? post.value : "";
      const postNorm = normaliseRemoteRepo(postUrl);
      if (postNorm !== decision.wantNorm && (decision.canonNorm === "" || postNorm !== decision.canonNorm)) {
        outcome = "failed";
        repairNote = "origin URL still wrong after repair";
      } else if (!(await deps.git.masterResolves(root))) {
        outcome = "failed";
        repairNote = "refs/remotes/origin/master still missing after fetch";
      } else {
        newUrl = postUrl;
      }
    }
    if (outcome === "failed") repairNote = `auto-repair FAILED: ${repairNote}`;
  }
  const shownNew = redactUrlUserinfo(newUrl === "" ? "<unset>" : newUrl);

  if (outcome === "repaired") {
    say(
      `REPAIRED ~/hydra origin identity: ${reasonStr} — remote.origin.url ${shownUrl} -> ${shownNew}; fetch ${fetchResult}; refs/remotes/origin/master present (issue #5065 auto-repair; check the .git/config INFO breadcrumb for the writer)`,
    );
  } else {
    say(
      `ALARM ~/hydra origin identity broken: ${reasonStr} — remote.origin.url=${shownUrl} (expected ${config.expectedRepo}); refs/remotes/origin/master ${masterPresent ? "present" : "MISSING"}; ${repairNote} (issues #4939/#5065; restore from an operator shell)`,
    );
  }

  // Dedup by outcome transition. A same-outcome 'failed' with a fresh attempt restamps only lastAttempt.
  const prevOutcome = prev?.outcome ?? "";
  if (prevOutcome === outcome && attempted && outcome === "failed") {
    deps.files.writeSince(`${prev?.first || nowS} ${outcome} ${nowS}`);
  }
  if (prevOutcome === outcome) return;

  const urlClean = cleanUrl(shownUrl);
  const newClean = cleanUrl(shownNew);
  const noteClean = cleanNote(repairNote);
  const repairField = outcome === "repaired" ? "repaired" : outcome === "failed" ? "failed" : "not-attempted";

  // One report() per outcome transition (ADR-0045 Decision 3, issue #5390): the
  // per-kind table decides page vs brief (a self-healed identity is a brief item)
  // and writes the dashboard alert. report() never throws and fails open when
  // Redis is down (Decision 6), so the since-marker is written unconditionally
  // once it has returned.
  await deps.channel.report(E.INFRA_ORIGIN_IDENTITY_WRONG, {
    signal: "origin-identity",
    reason: reasonStr,
    url: urlClean,
    repair: repairField,
    newUrl: newClean,
    fetch: fetchResult,
    note: noteClean,
  });
  deps.files.writeSince(`${nowS} ${outcome} ${nowS}`);
  say(`operator-channel report ok for '${ORIGIN_IDENTITY_PAGE_KIND}' repair=${repairField}`);

  // A self-healed identity needs no operator action, so `repaired` is this
  // check's recovery edge: close the open page episode.
  if (outcome === "repaired") {
    await deliverResolve(deps, say, `~/hydra origin identity repaired: ${reasonStr}`);
  }
}

async function deliverResolve(deps: OriginIdentityDeps, say: (line: string) => void, title: string): Promise<void> {
  try {
    await deps.channel.resolve(ORIGIN_IDENTITY_PAGE_KIND, title);
    say(`operator-channel resolve ok for '${ORIGIN_IDENTITY_PAGE_KIND}'`);
  } catch (err) {
    say(`WARN operator-channel resolve FAILED for '${ORIGIN_IDENTITY_PAGE_KIND}' (best-effort — detection state is unchanged): ${msg(err)}`);
  }
}
