/**
 * Schemas for the OTLP/http-json trace ingest boundary (issue #5177, epic #5171).
 *
 * `POST /api/otel/v1/traces` receives Claude Code's enhanced-telemetry beta
 * export: one `claude_code.llm_request` span per API request, carrying
 * `agent_id`, `parent_agent_id`, `request_id` and the four token counts. This
 * module owns the parse (ADR-0011 Schemas seam) AND the pure span extraction +
 * agent_id normalisation, so the route and the Redis accessor stay thin.
 *
 * Strict where we read (the KeyValue/AnyValue attribute shape), loose
 * elsewhere (resource/scope/events/links/status evolve with the OTel SDK and
 * must not 400 on a version bump).
 */
import { z } from "zod";

/** OTLP AnyValue — only the scalar arms we read are typed; the rest pass as unknown. */
const AnyValueSchema = z
  .object({
    stringValue: z.string().optional(),
    // OTLP/JSON encodes int64 as a decimal string; some SDKs emit a number.
    intValue: z.union([z.string(), z.number()]).optional(),
    doubleValue: z.number().optional(),
    boolValue: z.boolean().optional(),
    bytesValue: z.string().optional(),
    arrayValue: z.unknown().optional(),
    kvlistValue: z.unknown().optional(),
  })
  .strict();

const KeyValueSchema = z
  .object({
    key: z.string(),
    value: AnyValueSchema,
  })
  .strict();

const SpanSchema = z
  .object({
    spanId: z.string().optional(),
    name: z.string().optional(),
    attributes: z.array(KeyValueSchema).optional(),
  })
  .passthrough();

const ScopeSpansSchema = z.object({ spans: z.array(SpanSchema).optional() }).passthrough();

const ResourceSpansSchema = z
  .object({ scopeSpans: z.array(ScopeSpansSchema).optional() })
  .passthrough();

/** Body accepted by `POST /api/otel/v1/traces` (OTLP ExportTraceServiceRequest, JSON). */
export const OtlpTraceExportBodySchema = z
  .object({ resourceSpans: z.array(ResourceSpansSchema).optional() })
  .passthrough();

export type OtlpTraceExportBody = z.infer<typeof OtlpTraceExportBodySchema>;

/** The span name Claude Code gives each API request. */
export const LLM_REQUEST_SPAN_NAME = "claude_code.llm_request";

const BARE_AGENT_ID_RE = /^[0-9a-f]{8,40}$/;
const LABELLED_AGENT_ID_RE = /^a[a-z]+-([0-9a-f]{8,40})$/;

export interface NormalizedAgentId {
  /** Base agent id (bare hex). */
  agentId: string;
  /** True when the input was a labelled variant (e.g. `acompact-<hex>`) folded into its base. */
  labelled: boolean;
}

/**
 * Normalise an OTel `agent_id`. Bare hex passes through; a labelled variant
 * (`acompact-3f2c1b4d5e6f7a80`) folds into its base `a<hex>` and is flagged;
 * anything else returns null (ignored). Pure.
 */
export function normalizeAgentId(raw: string): NormalizedAgentId | null {
  const v = raw.trim();
  if (BARE_AGENT_ID_RE.test(v)) return { agentId: v, labelled: false };
  const m = LABELLED_AGENT_ID_RE.exec(v);
  if (m) return { agentId: `a${m[1]}`, labelled: true };
  return null;
}

/** One `claude_code.llm_request` span reduced to what the ledger records. */
export interface LlmRequestSample {
  agentId: string;
  parentAgentId: string | null;
  labelled: boolean;
  /** `request_id` when present, else the span id — the idempotency key. */
  requestKey: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface ExtractedSpans {
  samples: LlmRequestSample[];
  /** Spans that are not a recordable llm_request (other names, no/invalid agent_id, no key). */
  ignored: number;
}

type Attr = z.infer<typeof KeyValueSchema>;

function attrString(attrs: readonly Attr[], key: string): string | null {
  const a = attrs.find((x) => x.key === key);
  if (!a) return null;
  return typeof a.value.stringValue === "string" ? a.value.stringValue : null;
}

function attrCount(attrs: readonly Attr[], key: string): number {
  const a = attrs.find((x) => x.key === key);
  if (!a) return 0;
  const raw = a.value.intValue ?? a.value.doubleValue ?? a.value.stringValue;
  const n = typeof raw === "number" ? raw : raw === undefined ? 0 : Number(raw);
  const f = Math.floor(n);
  return Number.isFinite(n) && f > 0 && Number.isSafeInteger(f) ? f : 0;
}

/** Walk a parsed export body and reduce it to recordable samples. Pure. */
export function extractLlmRequests(body: OtlpTraceExportBody): ExtractedSpans {
  const samples: LlmRequestSample[] = [];
  let ignored = 0;
  for (const rs of body.resourceSpans ?? []) {
    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        if (span.name !== LLM_REQUEST_SPAN_NAME) {
          ignored++;
          continue;
        }
        const attrs = span.attributes ?? [];
        const rawAgent = attrString(attrs, "agent_id");
        const norm = rawAgent === null ? null : normalizeAgentId(rawAgent);
        const requestKey = attrString(attrs, "request_id") ?? span.spanId ?? null;
        if (norm === null || requestKey === null || requestKey === "") {
          ignored++;
          continue;
        }
        const parentRaw = attrString(attrs, "parent_agent_id");
        const parentNorm = parentRaw === null ? null : normalizeAgentId(parentRaw);
        samples.push({
          agentId: norm.agentId,
          parentAgentId: parentNorm ? parentNorm.agentId : null,
          labelled: norm.labelled,
          requestKey,
          input: attrCount(attrs, "input_tokens"),
          output: attrCount(attrs, "output_tokens"),
          cacheRead: attrCount(attrs, "cache_read_tokens"),
          cacheCreation: attrCount(attrs, "cache_creation_tokens"),
        });
      }
    }
  }
  return { samples, ignored };
}
