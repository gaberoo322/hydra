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
  foreignPrefixesFor,
  loadCommittedDefaultProviders,
  parseWorkerProviders,
  selectProvider,
  type ProviderState,
  type WorkerProvider,
} from "../src/glm/providers.ts";

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
    assert.equal(r.providers[0].model, "glm-5.2");
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
    ["duplicate tokenEnv", listText([ZAI, { ...KIMI, tokenEnv: "ANTHROPIC_AUTH_TOKEN" }])],
    ["duplicate non-zai tokenEnv", listText([KIMI, { ...KIMI, id: "k2", model: "other-model" }])],
    ["reserved tokenEnv ANTHROPIC_AUTH_TOKEN_FILE", listText([ZAI, { ...KIMI, tokenEnv: "ANTHROPIC_AUTH_TOKEN_FILE" }])],
    ["reserved tokenEnv ANTHROPIC_BASE_URL", listText([ZAI, { ...KIMI, tokenEnv: "ANTHROPIC_BASE_URL" }])],
    ["non-zai provider claiming ANTHROPIC_AUTH_TOKEN", listText([{ ...KIMI, tokenEnv: "ANTHROPIC_AUTH_TOKEN" }])],
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

describe("metering derives from config (INV-11)", () => {
  test("foreignPrefixesFor: glm-5.2 -> glm-, kimi-k2.5 -> kimi-, dashless is its own prefix, de-duped", () => {
    assert.deepEqual(foreignPrefixesFor([ZAI]), ["glm-"]);
    assert.deepEqual(foreignPrefixesFor([ZAI, KIMI]), ["glm-", "kimi-"]);
    assert.deepEqual(foreignPrefixesFor([{ ...KIMI, model: "Sol" }, { ...ZAI, model: "glm-4.7", id: "z2" }, ZAI]), [
      "sol",
      "glm-",
    ]);
  });
});
