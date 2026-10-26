/**
 * OTLP trace ingest + per-agent span ledger (issue #5177, epic #5171).
 *
 * Covers: the pure normaliser / span extractor (src/schemas/otel.ts), the Redis
 * accessor round-trip + idempotency + bounds (src/redis/otel-spans.ts), the
 * fail-closed route over a real Express app (src/api.ts mount incl. the 4mb
 * path-scoped body limit), the shadow-only import guard, and the read-only
 * comparison script's pure helpers.
 */
import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";

process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

const { normalizeAgentId, extractLlmRequests, OtlpTraceExportBodySchema } = await import(
  "../src/schemas/otel.ts"
);
const { recordOtelRequest, getOtelAgentTotals, listOtelAgentIds, otelAgentKey, otelAgentRequestsKey, otelIndexKey, INDEX_MAX } =
  await import("../src/redis/otel-spans.ts");
const { createApi } = await import("../src/api.ts");
const { keysMatch } = await import("../src/api/otel.ts");
const { buildRow, transcriptTotalFromContent } = await import("../scripts/cost/otel-ledger-compare.ts");

const AGENT = "a3f2c1b4d5e6f7a80";

function strAttr(key: string, stringValue: string) {
  return { key, value: { stringValue } };
}
function intAttr(key: string, n: number) {
  return { key, value: { intValue: String(n) } };
}

function llmSpan(opts: { agent?: string; parent?: string; request?: string; spanId?: string; counts?: [number, number, number, number] }) {
  const [i, o, cr, cc] = opts.counts ?? [10, 20, 300, 40];
  const attributes = [
    ...(opts.agent ? [strAttr("agent_id", opts.agent)] : []),
    ...(opts.parent ? [strAttr("parent_agent_id", opts.parent)] : []),
    ...(opts.request ? [strAttr("request_id", opts.request)] : []),
    intAttr("input_tokens", i),
    intAttr("output_tokens", o),
    intAttr("cache_read_tokens", cr),
    intAttr("cache_creation_tokens", cc),
  ];
  return { spanId: opts.spanId ?? "s1", name: "claude_code.llm_request", attributes };
}

function exportBody(spans: unknown[]) {
  return { resourceSpans: [{ scopeSpans: [{ spans }] }] };
}

let testRedis: any;
async function cleanOtelKeys() {
  if (!testRedis) testRedis = new Redis(process.env.REDIS_URL as string);
  const keys = await testRedis.keys("hydra:otel:spans:*");
  if (keys.length > 0) await testRedis.del(...keys);
}

after(() => {
  testRedis?.disconnect();
});

describe("normalizeAgentId", () => {
  test("bare hex passes through unlabelled", () => {
    assert.deepEqual(normalizeAgentId(AGENT), { agentId: AGENT, labelled: false });
  });
  test("labelled variant folds into its base a<hex>", () => {
    assert.deepEqual(normalizeAgentId("acompact-3f2c1b4d5e6f7a80"), {
      agentId: "a3f2c1b4d5e6f7a80",
      labelled: true,
    });
  });
  test("neither bare hex nor labelled is ignored", () => {
    assert.equal(normalizeAgentId("main-session"), null);
    assert.equal(normalizeAgentId(""), null);
    assert.equal(normalizeAgentId("ZZZ"), null);
  });
});

describe("extractLlmRequests", () => {
  test("extracts the four categories and parent; ignores other spans and agentless spans", () => {
    const body = OtlpTraceExportBodySchema.parse(
      exportBody([
        llmSpan({ agent: AGENT, parent: "a1111111111111111", request: "req_1" }),
        { name: "claude_code.tool", attributes: [] },
        llmSpan({ request: "req_main" }), // no agent_id: main session
        llmSpan({ agent: "not-an-agent", request: "req_x" }),
      ]),
    );
    const { samples, ignored } = extractLlmRequests(body);
    assert.equal(ignored, 3);
    assert.equal(samples.length, 1);
    assert.deepEqual(samples[0], {
      agentId: AGENT,
      parentAgentId: "a1111111111111111",
      labelled: false,
      requestKey: "req_1",
      input: 10,
      output: 20,
      cacheRead: 300,
      cacheCreation: 40,
    });
  });

  test("falls back to the span id when request_id is absent", () => {
    const body = OtlpTraceExportBodySchema.parse(exportBody([llmSpan({ agent: AGENT, spanId: "span-9" })]));
    assert.equal(extractLlmRequests(body).samples[0].requestKey, "span-9");
  });
});

describe("otel-spans accessor", () => {
  beforeEach(async () => {
    await cleanOtelKeys();
  });
  after(async () => {
    await cleanOtelKeys();
  });

  const base = {
    agentId: AGENT,
    parentAgentId: null,
    labelled: false,
    input: 1,
    output: 2,
    cacheRead: 3,
    cacheCreation: 4,
  };

  test("accumulates totals and is idempotent per request id", async () => {
    assert.equal(await recordOtelRequest({ ...base, requestKey: "r1" }), "accepted");
    assert.equal(await recordOtelRequest({ ...base, requestKey: "r2", labelled: true }), "accepted");
    assert.equal(await recordOtelRequest({ ...base, requestKey: "r1" }), "deduped");
    const t = await getOtelAgentTotals(AGENT);
    assert.ok(t);
    assert.equal(t.input, 2);
    assert.equal(t.output, 4);
    assert.equal(t.cacheRead, 6);
    assert.equal(t.cacheCreation, 8);
    assert.equal(t.requests, 2);
    assert.equal(t.labelledRequests, 1);
    assert.deepEqual(await listOtelAgentIds(), [AGENT]);
  });

  test("every key carries a bounded TTL", async () => {
    await recordOtelRequest({ ...base, requestKey: "r1" });
    for (const k of [otelAgentKey(AGENT), otelAgentRequestsKey(AGENT), otelIndexKey()]) {
      const ttl = await testRedis.ttl(k);
      assert.ok(ttl > 0 && ttl <= 7 * 24 * 3600, `${k} ttl=${ttl}`);
    }
  });

  test("index is trimmed to the newest INDEX_MAX agents", async () => {
    const r = testRedis ?? new Redis(process.env.REDIS_URL as string);
    testRedis = r;
    const seed = r.pipeline();
    for (let i = 0; i < INDEX_MAX; i++) seed.zadd(otelIndexKey(), i + 1, `a${String(i).padStart(10, "0")}`);
    await seed.exec();
    await recordOtelRequest({ ...base, requestKey: "r1" }, INDEX_MAX + 10);
    assert.equal(await r.zcard(otelIndexKey()), INDEX_MAX);
    assert.equal((await listOtelAgentIds())[0], AGENT);
  });
});

describe("POST /api/otel/v1/traces", () => {
  let server: any;
  let baseUrl = "";
  let prevKey: string | undefined;

  before(async () => {
    prevKey = process.env.HYDRA_OTEL_INGEST_KEY;
    const bus: any = { publisher: { ping: async () => "PONG" }, publish: async () => "1-0", readRecent: async () => [] };
    const app = createApi(bus);
    await new Promise<void>((res) => {
      server = app.listen(0, () => res());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  beforeEach(async () => {
    await cleanOtelKeys();
    process.env.HYDRA_OTEL_INGEST_KEY = "secret-key";
  });
  after(async () => {
    server?.close();
    if (prevKey === undefined) delete process.env.HYDRA_OTEL_INGEST_KEY;
    else process.env.HYDRA_OTEL_INGEST_KEY = prevKey;
    await cleanOtelKeys();
  });

  function post(body: unknown, key: string | null = "secret-key") {
    return fetch(`${baseUrl}/api/otel/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key === null ? {} : { "x-hydra-otel-key": key }) },
      body: JSON.stringify(body),
    });
  }

  test("env key unset -> 503 otel-ingest-disabled and writes nothing", async () => {
    delete process.env.HYDRA_OTEL_INGEST_KEY;
    const res = await post(exportBody([llmSpan({ agent: AGENT, request: "r1" })]));
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, "otel-ingest-disabled");
    assert.deepEqual(await listOtelAgentIds(), []);
  });

  test("missing or mismatched header -> 401 otel-ingest-unauthorized, before schema parse", async () => {
    for (const key of [null, "wrong"]) {
      const res = await post({ resourceSpans: "not-an-array" }, key);
      assert.equal(res.status, 401);
      assert.equal((await res.json()).code, "otel-ingest-unauthorized");
    }
    assert.deepEqual(await listOtelAgentIds(), []);
  });

  test("malformed body -> 400 schema-validation-failed and writes nothing", async () => {
    const res = await post({ resourceSpans: "not-an-array" });
    assert.equal(res.status, 400);
    const j = await res.json();
    assert.equal(j.code, "schema-validation-failed");
    assert.ok(Array.isArray(j.issues));
    assert.deepEqual(await listOtelAgentIds(), []);
  });

  test("well-formed body stores per-agent totals; re-export is deduped", async () => {
    const body = exportBody([
      llmSpan({ agent: AGENT, request: "r1" }),
      llmSpan({ agent: "acompact-3f2c1b4d5e6f7a80", request: "r2" }),
      { name: "claude_code.interaction", attributes: [] },
    ]);
    const first = await post(body);
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { ok: true, accepted: 2, ignored: 1, deduped: 0 });
    const again = await post(body);
    assert.deepEqual(await again.json(), { ok: true, accepted: 0, ignored: 1, deduped: 2 });
    const t = await getOtelAgentTotals(AGENT);
    assert.ok(t);
    assert.equal(t.requests, 2);
    assert.equal(t.labelledRequests, 1);
    assert.equal(t.input + t.output + t.cacheRead + t.cacheCreation, 2 * (10 + 20 + 300 + 40));
  });

  test("a body over the 100kb default is not 413'd (path-scoped 4mb limit)", async () => {
    const spans = Array.from({ length: 400 }, (_, i) =>
      llmSpan({ agent: AGENT, request: `bulk-${i}`, spanId: `sp-${i}` }),
    );
    const payload = exportBody(spans);
    assert.ok(JSON.stringify(payload).length > 100 * 1024);
    const res = await post(payload);
    assert.notEqual(res.status, 413);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).accepted, 400);
  });
});

describe("keysMatch", () => {
  test("constant-time compare handles differing lengths without throwing", () => {
    assert.equal(keysMatch("a", "a"), true);
    assert.equal(keysMatch("a", "abc"), false);
  });
});

describe("shadow-only import guard", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|mts)$/.test(name)) out.push(p);
    }
    return out;
  }

  test("only src/api/otel.ts imports the otel-spans accessor under src/; src/cost never does", () => {
    const srcRoot = resolve(import.meta.dirname, "..", "src");
    const importers = walk(srcRoot).filter((f) => /redis\/otel-spans(\.ts)?["']/.test(readFileSync(f, "utf8")));
    assert.deepEqual(
      importers.map((f) => f.slice(srcRoot.length + 1)),
      ["api/otel.ts"],
    );
    assert.ok(!importers.some((f) => f.includes("/src/cost/")));
  });
});

describe("otel-ledger-compare pure helpers", () => {
  test("buildRow computes delta and deltaPct against the transcript total", () => {
    const row = buildRow(
      { agentId: AGENT, input: 10, output: 20, cacheRead: 30, cacheCreation: 40, requests: 3 },
      { skill: "hydra-dev", dispatchId: "wt-1", issueRef: "#5177" },
      80,
    );
    assert.equal(row.spanTotal, 100);
    assert.equal(row.delta, 20);
    assert.equal(row.deltaPct, 25);
    assert.equal(row.skill, "hydra-dev");
  });

  test("buildRow with no transcript leaves delta null", () => {
    const row = buildRow({ agentId: AGENT, input: 1, output: 1, cacheRead: 1, cacheCreation: 1, requests: 1 }, null, null);
    assert.equal(row.delta, null);
    assert.equal(row.deltaPct, null);
    assert.equal(row.skill, null);
  });

  test("transcriptTotalFromContent counts each message.id once (keep-largest)", () => {
    const ts = new Date().toISOString();
    const line = (out: number) =>
      JSON.stringify({
        type: "assistant",
        timestamp: ts,
        message: {
          id: "msg_1",
          model: "claude-sonnet-4-5",
          usage: { input_tokens: 5, output_tokens: out, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 },
        },
      });
    const total = transcriptTotalFromContent([line(3), line(9)].join("\n"));
    assert.equal(total, 5 + 9 + 10);
  });
});
