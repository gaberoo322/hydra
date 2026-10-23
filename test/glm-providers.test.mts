/**
 * test/glm-providers.test.mts — the GLM drainer's ordered worker-provider list
 * (issue #4841; ADR-0032 as amended).
 *
 * Pure schema/fence/selection cases, then the gate / runner / finish / metering
 * seams over fakes. The default (committed single z.ai) config is the
 * characterisation anchor: the existing glm-* suites pin its behaviour; this
 * file pins what is NEW — fallback, per-provider blocks, the model fence per
 * provider, the #4593 429-on-resume regression and attribution.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEFAULT_PROVIDERS_PATH,
  checkProviderModel,
  foreignPrefixesFor,
  loadCommittedDefaultProviders,
  parseWorkerProviders,
  selectProvider,
  type ProviderState,
  type WorkerProvider,
} from "../src/glm/providers.ts";
import {
  GLM_MODEL,
  assertGlmModel,
  buildDrainerArgs,
  buildGlmEnv,
} from "../src/glm/drainer-runner.ts";
import {
  providerCapFilePath,
  quotaBlockFilePath,
  runGate,
  type GateDeps,
} from "../src/glm/gate.ts";
import { loadDrainerConfig } from "../src/glm/drainer-config.ts";
import { runFinish, type FinishDeps, type FinishInput } from "../src/glm/finish.ts";
import { isForeignProviderModel } from "../src/cost/token-math.ts";
import { parseTranscriptFile } from "../src/cost/transcript-fold.ts";

const ZAI: WorkerProvider = {
  id: "zai",
  baseUrl: "https://api.z.ai/api/anthropic",
  model: "glm-5.2",
  tokenEnv: "ANTHROPIC_AUTH_TOKEN",
  quotaReset: { format: "zai-wallclock", tzOffset: "+0800" },
};
const KIMI: WorkerProvider = {
  id: "kimi",
  baseUrl: "https://api.kimi.example/anthropic",
  model: "kimi-k2.5",
  tokenEnv: "KIMI_API_KEY",
  quotaReset: { format: "fallback-only" },
};

const NOW_MS = Date.parse("2026-10-22T12:00:00Z");
const NOW_SEC = Math.floor(NOW_MS / 1000);
const CAP_DIR = "/cap";

function listText(providers: unknown[]): string {
  return JSON.stringify({ providers });
}

describe("parseWorkerProviders — zod schema (INV-2)", () => {
  test("the committed default is exactly one z.ai entry", () => {
    const r = loadCommittedDefaultProviders();
    assert.equal(r.ok, true);
    if (r.ok !== true) return;
    assert.deepEqual(r.providers, [ZAI]);
    assert.equal(r.providers[0].model, GLM_MODEL);
    assert.equal(DEFAULT_PROVIDERS_PATH.endsWith("config/glm/providers.json"), true);
    JSON.parse(readFileSync(DEFAULT_PROVIDERS_PATH, "utf8")); // valid JSON
  });

  test("accepts an ordered two-provider list", () => {
    const r = parseWorkerProviders(listText([ZAI, KIMI]));
    assert.equal(r.ok, true);
    if (r.ok === true) assert.deepEqual(r.providers.map((p) => p.id), ["zai", "kimi"]);
  });

  const bad: Array<[string, string]> = [
    ["not JSON", "{nope"],
    ["empty list", listText([])],
    ["duplicate ids", listText([ZAI, { ...KIMI, id: "zai" }])],
    ["duplicate models", listText([ZAI, { ...KIMI, model: "GLM-5.2" }])],
    ["ANTHROPIC_API_KEY as tokenEnv", listText([{ ...ZAI, tokenEnv: "ANTHROPIC_API_KEY" }])],
    ["a lowercase tokenEnv (a value, not a name)", listText([{ ...ZAI, tokenEnv: "sk-abc" }])],
    ["a bad tz offset", listText([{ ...ZAI, quotaReset: { format: "zai-wallclock", tzOffset: "UTC+8" } }])],
    ["a non-url baseUrl", listText([{ ...ZAI, baseUrl: "not a url" }])],
    ["an id that cannot name a file", listText([{ ...ZAI, id: "../x" }])],
  ];
  for (const [name, text] of bad) {
    test(`rejects ${name} with glm-provider-config-invalid`, () => {
      const r = parseWorkerProviders(text);
      assert.equal(r.ok, false);
      if (r.ok === false) {
        assert.equal(r.code, "glm-provider-config-invalid");
        assert.ok(r.issues.length > 0);
      }
    });
  }

  for (const model of ["sonnet", "opus", "haiku", "fable", "Fable", "claude-opus-4-7", "CLAUDE-sonnet-5"]) {
    test(`a Claude model "${model}" is rejected at config load (INV-3)`, () => {
      const r = parseWorkerProviders(listText([{ ...KIMI, model }]));
      assert.equal(r.ok, false);
    });
  }
});

describe("model fence per provider (INV-3, issue #3758)", () => {
  const providers = [ZAI, KIMI];
  for (const p of providers) {
    test(`${p.id}: its exact model launches; every Claude alias/claude-* is refused with no argv`, () => {
      assert.equal(checkProviderModel(p.model, providers).ok, true);
      for (const alias of ["sonnet", "opus", "haiku", "fable", "claude-sonnet-5"]) {
        const built = buildDrainerArgs({ prompt: "p", model: alias, providers });
        assert.equal(built.ok, false, alias);
        if (built.ok === false) assert.equal(built.code, "glm-model-would-route-first-party");
      }
      const ok = buildDrainerArgs({ prompt: "p", model: p.model, providers });
      assert.equal(ok.ok, true);
      if (ok.ok === true) assert.equal(ok.args[ok.args.indexOf("--model") + 1], p.model);
    });
  }

  test("a non-Claude model that no provider configures is glm-model-not-configured", () => {
    const r = assertGlmModel("glm-4.7", providers);
    assert.equal(r.ok, false);
    if (r.ok === false) assert.equal(r.code, "glm-model-not-configured");
    assert.equal(assertGlmModel("GPT-6", providers).ok, false);
  });

  test("the one-argument legacy form still accepts any glm-* name", () => {
    assert.equal(assertGlmModel("glm-4.7").ok, true);
  });
});

describe("buildGlmEnv — one token per child, never leaked (INV-9)", () => {
  const base = { PATH: "/usr/bin", ANTHROPIC_AUTH_TOKEN: "zai-secret", KIMI_API_KEY: "kimi-secret" };

  test("provider 2 gets its own base URL + token and the sibling's variable is stripped", () => {
    const r = buildGlmEnv(base, KIMI, [ZAI, KIMI]);
    assert.equal(r.ok, true);
    if (r.ok !== true) return;
    assert.equal(r.env.ANTHROPIC_BASE_URL, KIMI.baseUrl);
    assert.equal(r.env.ANTHROPIC_AUTH_TOKEN, "kimi-secret");
    assert.equal("KIMI_API_KEY" in r.env, false, "the selected provider's own variable is folded into ANTHROPIC_AUTH_TOKEN");
  });

  test("provider 1 child never holds provider 2's credential", () => {
    const r = buildGlmEnv(base, ZAI, [ZAI, KIMI]);
    assert.equal(r.ok, true);
    if (r.ok !== true) return;
    assert.equal(r.env.ANTHROPIC_AUTH_TOKEN, "zai-secret");
    assert.equal("KIMI_API_KEY" in r.env, false);
  });

  test("a missing token names the variable, never a value, and fails closed", () => {
    const r = buildGlmEnv({ PATH: "/x" }, KIMI, [ZAI, KIMI]);
    assert.equal(r.ok, false);
    if (r.ok === false) {
      assert.equal(r.code, "glm-auth-token-missing");
      assert.match(r.message, /KIMI_API_KEY/);
    }
  });
});

describe("selectProvider — first-unblocked (INV-6)", () => {
  const st = (provider: WorkerProvider, blockedUntil: number | null, capCount = 0): ProviderState => ({
    provider,
    blockedUntil,
    capCount,
  });

  test("picks the first provider when nothing is blocked", () => {
    const r = selectProvider([st(ZAI, null), st(KIMI, null)], NOW_SEC);
    assert.equal(r.kind === "selected" && r.provider.id, "zai");
  });

  test("falls through to provider 2 when provider 1 is quota-blocked", () => {
    const r = selectProvider([st(ZAI, NOW_SEC + 600), st(KIMI, null)], NOW_SEC);
    assert.equal(r.kind === "selected" && r.provider.id, "kimi");
  });

  test("an expired block does not count", () => {
    const r = selectProvider([st(ZAI, NOW_SEC - 1), st(KIMI, null)], NOW_SEC);
    assert.equal(r.kind === "selected" && r.provider.id, "zai");
  });

  test("a provider at its own dailyCap is skipped", () => {
    const capped = { ...ZAI, dailyCap: 3 };
    const r = selectProvider([st(capped, null, 3), st(KIMI, null)], NOW_SEC);
    assert.equal(r.kind === "selected" && r.provider.id, "kimi");
  });

  test("all quota-blocked -> quota-blocked; all cap-blocked -> cap-exhausted", () => {
    const a = selectProvider([st(ZAI, NOW_SEC + 5), st(KIMI, NOW_SEC + 9)], NOW_SEC);
    assert.equal(a.kind === "none" && a.reason, "quota-blocked");
    const capZ = { ...ZAI, dailyCap: 1 };
    const capK = { ...KIMI, dailyCap: 1 };
    const b = selectProvider([st(capZ, null, 1), st(capK, null, 1)], NOW_SEC);
    assert.equal(b.kind === "none" && b.reason, "cap-exhausted");
    const c = selectProvider([st(ZAI, NOW_SEC + 5), st(capK, null, 1)], NOW_SEC);
    assert.equal(c.kind === "none" && c.reason, "quota-blocked");
  });
});

function gateDeps(
  providers: GateDeps["providers"],
  files: Record<string, string> = {},
): { deps: GateDeps; unlinked: string[]; heartbeats: () => number } {
  const unlinked: string[] = [];
  let hb = 0;
  const deps: GateDeps = {
    config: { ...loadDrainerConfig({}), capDir: CAP_DIR, dailyCap: 5 },
    now: () => NOW_MS,
    getAutopilotPaused: async () => ({ paused: false }),
    readFileIfExists: (p) => (p in files ? files[p] : null),
    unlink: (p) => {
      unlinked.push(p);
    },
    setGlmDrainerHeartbeat: async () => {
      hb += 1;
      return { ok: true };
    },
    providers,
  };
  return { deps, unlinked, heartbeats: () => hb };
}

const TWO = parseWorkerProviders(listText([ZAI, KIMI]));

describe("runGate — per-provider quota blocks (INV-4/5/6)", () => {
  test("block file names: legacy for zai, suffixed for every other id (INV-5)", () => {
    assert.equal(quotaBlockFilePath(CAP_DIR), "/cap/hydra-glm-drainer-quota-blocked-until");
    assert.equal(quotaBlockFilePath(CAP_DIR, "zai"), "/cap/hydra-glm-drainer-quota-blocked-until");
    assert.equal(quotaBlockFilePath(CAP_DIR, "kimi"), "/cap/hydra-glm-drainer-quota-blocked-until-kimi");
    assert.match(providerCapFilePath(CAP_DIR, NOW_MS, "kimi"), /daily-cap-2026-10-22-kimi$/);
  });

  test("provider 1 quota-blocked: the gate passes with provider 2 and writes the heartbeat", async () => {
    const h = gateDeps(TWO, { [quotaBlockFilePath(CAP_DIR, "zai")]: `${NOW_SEC + 3600}\n` });
    const line = await runGate(h.deps);
    assert.deepEqual(line, { able: true, heartbeat: "written", provider: "kimi" });
    assert.equal(h.heartbeats(), 1);
  });

  test("every provider blocked: quota-blocked, detail lists each unblock instant", async () => {
    const h = gateDeps(TWO, {
      [quotaBlockFilePath(CAP_DIR, "zai")]: `${NOW_SEC + 3600}\n`,
      [quotaBlockFilePath(CAP_DIR, "kimi")]: `${NOW_SEC + 7200}\n`,
    });
    const line = await runGate(h.deps);
    assert.equal(line.able, false);
    if (line.able === false) {
      assert.equal(line.reason, "quota-blocked");
      assert.match(line.detail ?? "", /zai: quota until 2026-10-22T13:00:00Z; kimi: quota until 2026-10-22T14:00:00Z/);
    }
    assert.equal(h.heartbeats(), 0, "a skip writes no heartbeat");
  });

  test("a stale block file is deleted per provider and does not block", async () => {
    const h = gateDeps(TWO, { [quotaBlockFilePath(CAP_DIR, "kimi")]: `${NOW_SEC - 10}\n` });
    const line = await runGate(h.deps);
    assert.equal(line.able, true);
    assert.deepEqual(h.unlinked, [quotaBlockFilePath(CAP_DIR, "kimi")]);
  });

  test("a provider's own dailyCap diverts to the next provider", async () => {
    const capped = parseWorkerProviders(listText([{ ...ZAI, dailyCap: 2 }, KIMI]));
    const h = gateDeps(capped, { [providerCapFilePath(CAP_DIR, NOW_MS, "zai")]: "2\n" });
    const line = await runGate(h.deps);
    assert.equal(line.able && line.provider, "kimi");
  });

  test("an invalid provider list fails closed: provider-config-invalid, no heartbeat, never a default (INV-4)", async () => {
    const bad = parseWorkerProviders("{nope");
    const h = gateDeps(bad);
    const line = await runGate(h.deps);
    assert.equal(line.able, false);
    if (line.able === false) assert.equal(line.reason, "provider-config-invalid");
    assert.equal(h.heartbeats(), 0);
  });

  test("hand-built deps without a list read as the committed single-z.ai default", async () => {
    const h = gateDeps(undefined);
    assert.deepEqual(await runGate(h.deps), { able: true, heartbeat: "written", provider: "zai" });
  });
});

describe("runFinish — provider attribution + per-provider 429 (INV-7/8/10)", () => {
  const WT = "/repo/wts/agent-glm-77-1";
  const BODY = `${WT}/.glm-drainer-pr-body.md`;
  const BRANCH = "worktree-agent-glm-77-1790000000";
  const OUT_429 = JSON.stringify({
    ok: true,
    code: null,
    timedOut: true,
    stdout: "API Error: Request rejected (429) — rate limited",
    stderr: "",
  });

  function finishHarness(commits: number, prBody: string | null) {
    const calls: string[] = [];
    const files = new Map<string, string>();
    if (prBody !== null) files.set(BODY, prBody);
    const deps: FinishDeps = {
      config: { ...loadDrainerConfig({}), capDir: CAP_DIR },
      repoRoot: "/repo",
      now: () => NOW_MS,
      log: () => {},
      editIssueLabels: async (issue, labels) => {
        calls.push(`label:${issue}:a=${(labels.add ?? []).join("+")}`);
        return { ok: true };
      },
      viewIssueTitle: async () => "Fake title",
      createPr: async () => ({ ok: true, url: "https://github.com/x/y/pull/9" }),
      listOpenPrs: async () => ({ ok: true, rows: [] }),
      runGit: async (args) => {
        if (args[0] === "rev-list") return { ok: true, stdout: String(commits), stderr: "" };
        if (args[0] === "diff") return { ok: true, stdout: "src/glm/finish.ts", stderr: "" };
        return { ok: true, stdout: "", stderr: "" };
      },
      removeWorktree: async () => ({ ok: true }),
      pushBranchUpstream: async () => ({ ok: true }),
      deleteRemoteBranch: async () => ({ ok: true }),
      remoteBranchExists: async () => true,
      preflight: async (o) => ({ ok: true, checkedPaths: o.changedPaths.length }),
      readFileIfExists: (p) => files.get(p) ?? null,
      writeFile: (p, c) => {
        calls.push(`write:${p}`);
        files.set(p, c);
      },
      unlinkIfExists: (p) => {
        files.delete(p);
      },
      appendToFile: (p, t) => {
        calls.push(`append:${p}`);
        files.set(p, (files.get(p) ?? "") + t);
      },
    };
    return { deps, calls, files };
  }

  const input = (provider?: WorkerProvider, authorRaw = "{\"ok\":true,\"code\":0,\"stdout\":\"\",\"stderr\":\"\"}"): FinishInput => ({
    issue: 77,
    worktree: WT,
    branch: BRANCH,
    authorRaw,
    authorExitCode: 0,
    provider,
  });

  test("the PR body gets worker-provider / worker-model trailers before preflight", async () => {
    const h = finishHarness(1, "body\n");
    const r = await runFinish(h.deps, input(KIMI));
    assert.equal(r.action, "open-pr");
    const body = h.files.get(BODY) as string;
    assert.match(body, /^worker-provider: kimi$/m);
    assert.match(body, /^worker-model: kimi-k2\.5$/m);
  });

  test("no provider -> no trailers (legacy single-lane parity)", async () => {
    const h = finishHarness(1, "body\n");
    await runFinish(h.deps, input(undefined));
    assert.equal(h.files.get(BODY), "body\n");
  });

  test("a 429 writes the SELECTED provider's block file, not the legacy one", async () => {
    const h = finishHarness(0, null);
    const r = await runFinish(h.deps, input(KIMI, OUT_429));
    assert.equal(r.action, "release-nothing-produced");
    assert.equal(h.files.get(quotaBlockFilePath(CAP_DIR, "kimi")), `${NOW_SEC + 3600}\n`);
    assert.equal(h.files.has(quotaBlockFilePath(CAP_DIR, "zai")), false);
  });

  test("#4593 regression: a 429 on a resumed branch with commits ahead (keep-partial) records the block AFTER the release", async () => {
    const h = finishHarness(2, null);
    const r = await runFinish(h.deps, input(ZAI, OUT_429));
    assert.equal(r.action, "keep-partial-for-resume");
    const releaseIdx = h.calls.findIndex((c) => c.startsWith("label:77:"));
    const writeIdx = h.calls.indexOf(`write:${quotaBlockFilePath(CAP_DIR, "zai")}`);
    assert.ok(releaseIdx >= 0 && writeIdx > releaseIdx, h.calls.join("\n"));
    assert.equal(r.quotaBlockedUntil, NOW_SEC + 3600);
  });

  test("zai-wallclock reads the reset clause in the provider's offset; the env override still wins (INV-8)", async () => {
    const stdout = "Request rejected (429) reset at 2026-10-23 08:00:00";
    const raw = JSON.stringify({ ok: true, code: 1, stdout, stderr: "" });
    const a = finishHarness(0, null);
    await runFinish(a.deps, input(ZAI, raw));
    // 08:00 at +0800 == 2026-10-23T00:00:00Z
    assert.equal(a.files.get(quotaBlockFilePath(CAP_DIR, "zai")), `${Date.parse("2026-10-23T00:00:00Z") / 1000}\n`);
    const b = finishHarness(0, null);
    b.deps.config = { ...b.deps.config, quotaResetTzOverride: "+0000" };
    await runFinish(b.deps, input(ZAI, raw));
    assert.equal(b.files.get(quotaBlockFilePath(CAP_DIR, "zai")), `${Date.parse("2026-10-23T08:00:00Z") / 1000}\n`);
  });

  test("fallback-only providers always take the 60-minute fallback", async () => {
    const raw = JSON.stringify({ ok: true, code: 1, stdout: "Request rejected (429) reset at 2026-10-23 08:00:00", stderr: "" });
    const h = finishHarness(0, null);
    await runFinish(h.deps, input(KIMI, raw));
    assert.equal(h.files.get(quotaBlockFilePath(CAP_DIR, "kimi")), `${NOW_SEC + 3600}\n`);
  });
});

describe("metering derives from config (INV-11)", () => {
  test("foreignPrefixesFor: glm-5.2 -> glm-, kimi-k2.5 -> kimi-, dashless is its own prefix, de-duped", () => {
    assert.deepEqual(foreignPrefixesFor([ZAI]), ["glm-"]);
    assert.deepEqual(foreignPrefixesFor([ZAI, KIMI]), ["glm-", "kimi-"]);
    assert.deepEqual(foreignPrefixesFor([{ ...KIMI, model: "Sol" }, { ...ZAI, model: "glm-4.7", id: "z2" }, ZAI]), [
      "sol",
      "glm-",
    ]);
  });

  test("isForeignProviderModel takes injected prefixes; the default stays glm-", () => {
    assert.equal(isForeignProviderModel("kimi-k2.5"), false);
    assert.equal(isForeignProviderModel("kimi-k2.5", ["glm-", "kimi-"]), true);
    assert.equal(isForeignProviderModel("glm-5.2"), true);
    assert.equal(isForeignProviderModel("claude-opus-4-7", ["glm-", "kimi-"]), false);
  });

  test("parseTranscriptFile counts a configured provider's tokens as foreign, only when its prefix is passed", () => {
    const ts = new Date(NOW_MS).toISOString();
    const line = JSON.stringify({
      type: "assistant",
      timestamp: ts,
      message: {
        id: "m1",
        model: "kimi-k2.5",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });
    const attribute = () => ({ skill: null, dispatchKind: null }) as never;
    const without = parseTranscriptFile(line, NOW_MS - 1000, attribute);
    assert.deepEqual(without.foreignModels, []);
    const withKimi = parseTranscriptFile(line, NOW_MS - 1000, attribute, { foreignPrefixes: ["glm-", "kimi-"] });
    assert.deepEqual(withKimi.foreignModels, ["kimi-k2.5"]);
  });
});
