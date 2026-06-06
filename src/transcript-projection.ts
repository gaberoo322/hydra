/**
 * Transcript Projection — the Seam that turns raw Claude Code JSONL conversation
 * lines into the flattened, UI-friendly message list the transcript endpoint
 * emits (issue #987).
 *
 * This is the schema-knowledge counterpart to the **Transcript Store**
 * (`src/transcript-store.ts`, issue #951). The Store owns *layout / IO* — where
 * transcripts live and how to read the files (root resolution, project-dir
 * encoding, path confinement, session-id ↔ path, file iteration). #951 split
 * that out and deliberately left the conversation-record *projection* embedded
 * in the `GET /dispatches/:id/transcript` route handler; this Module completes
 * that split by giving projection its own narrow seam.
 *
 * Scope boundary: this Module owns *interpreting line contents* — content-block
 * normalisation, tool-result stringifying, conversation-record filtering, and
 * offset/limit pagination over the projected message array. It is PURE: no
 * `req`/`res`, no Express, no filesystem, no Redis. It operates only on raw
 * JSONL strings/records, so it is unit-testable without standing up the route.
 *
 * The route (`src/api/dispatches.ts`) is a CALLER of this Interface: it reads a
 * file via the Store, hands the raw body to `parseTranscript`, pages with
 * `paginate`, and responds. The HTTP transport stays in the route; the
 * schema-knowledge stays here.
 */

/**
 * The shape the transcript endpoint emits per message. A flattened,
 * UI-friendly projection of a raw JSONL conversation record.
 */
export interface TranscriptMessage {
  role: "user" | "assistant" | "system";
  /** Normalised content blocks (text/thinking/tool_use/tool_result). */
  blocks: TranscriptBlock[];
  /** ISO timestamp from the raw record, when present. */
  timestamp?: string;
}

export type TranscriptBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "tool_result"; text: string; isError: boolean };

/**
 * Raw JSONL record types that are NOT conversation messages and are filtered
 * out of the message list entirely (they don't count toward `total` either).
 * The conversation set is `type ∈ {user, assistant, system}` minus `isMeta`.
 */
const NON_CONVERSATION_TYPES = new Set([
  "mode",
  "file-history-snapshot",
  "attachment",
  "ai-title",
  "last-prompt",
  "permission-mode",
  "pr-link",
]);

/**
 * Decide whether a parsed JSONL record is a conversation message we render.
 * Exported for tests. A `system` record is conversation IFF it carries content
 * (the harness emits content-less `system` rows like `stop_hook_summary` /
 * `turn_duration` that are noise).
 */
export function isConversationRecord(rec: any): boolean {
  if (!rec || typeof rec !== "object") return false;
  const type = rec.type;
  if (type !== "user" && type !== "assistant" && type !== "system") {
    return false;
  }
  if (rec.isMeta === true) return false;
  if (NON_CONVERSATION_TYPES.has(type)) return false;
  // Content-less system rows (stop_hook_summary, turn_duration, ...) carry no
  // message; they're bookkeeping, not conversation.
  if (type === "system") {
    const hasContent =
      (typeof rec.content === "string" && rec.content.length > 0) ||
      (rec.message && rec.message.content != null);
    if (!hasContent) return false;
  }
  return true;
}

/**
 * Normalise a raw `message.content` (string OR block array) into the flat
 * `TranscriptBlock[]` the UI consumes. Unknown block types degrade to a text
 * block carrying their stringified form rather than being dropped, so nothing
 * silently vanishes. Exported for tests.
 */
export function normaliseContent(content: unknown): TranscriptBlock[] {
  if (content == null) return [];
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return [{ type: "text", text: JSON.stringify(content) }];
  }
  const out: TranscriptBlock[] = [];
  for (const block of content) {
    if (block == null) continue;
    if (typeof block === "string") {
      if (block.length > 0) out.push({ type: "text", text: block });
      continue;
    }
    if (typeof block !== "object") continue;
    const t = (block as any).type;
    if (t === "text") {
      out.push({ type: "text", text: String((block as any).text ?? "") });
    } else if (t === "thinking") {
      out.push({ type: "thinking", text: String((block as any).thinking ?? "") });
    } else if (t === "tool_use") {
      out.push({
        type: "tool_use",
        name: String((block as any).name ?? "(tool)"),
        input: (block as any).input ?? null,
      });
    } else if (t === "tool_result") {
      out.push({
        type: "tool_result",
        text: stringifyToolResult((block as any).content),
        isError: (block as any).is_error === true,
      });
    } else {
      // Unknown block type — keep it visible rather than dropping it.
      out.push({ type: "text", text: JSON.stringify(block) });
    }
  }
  return out;
}

/** Flatten a tool_result `content` (string OR block array) into display text. */
export function stringifyToolResult(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object" && (c as any).type === "text") {
          return String((c as any).text ?? "");
        }
        return JSON.stringify(c);
      })
      .join("\n");
  }
  return JSON.stringify(content);
}

/**
 * Project a single conversation record into a `TranscriptMessage`. Returns
 * `null` for a record that, after filtering, carries no renderable blocks
 * (so an empty assistant turn doesn't show as a blank row). Exported for
 * tests.
 */
export function projectMessage(rec: any): TranscriptMessage | null {
  if (!isConversationRecord(rec)) return null;
  const role: TranscriptMessage["role"] =
    rec.type === "assistant" ? "assistant" : rec.type === "system" ? "system" : "user";
  const rawContent =
    rec.message && rec.message.content !== undefined
      ? rec.message.content
      : rec.content;
  const blocks = normaliseContent(rawContent);
  if (blocks.length === 0) return null;
  const msg: TranscriptMessage = { role, blocks };
  if (typeof rec.timestamp === "string") msg.timestamp = rec.timestamp;
  return msg;
}

/**
 * Parse a raw JSONL transcript body into the full filtered conversation list,
 * oldest-first. A malformed line is SKIPPED (logged via console.error per the
 * fail-loud convention), never thrown — so one bad line can't 500 the request
 * or truncate the rest of the transcript. Pure + synchronous; exported for
 * tests.
 */
export function parseTranscript(body: string): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch (err) {
      console.error(
        `[transcript-projection] skipping malformed JSONL line ${i + 1}: ${(err as Error).message}`,
      );
      continue;
    }
    const msg = projectMessage(rec);
    if (msg) out.push(msg);
  }
  return out;
}

/**
 * Apply oldest-first server-side pagination to the filtered conversation set.
 * `total` is the count of the FULL filtered set (not the raw line count, not
 * the page length) so the client can compute "page N of M". Exported for
 * tests.
 */
export function paginate(
  messages: TranscriptMessage[],
  offset: number,
  limit: number,
): { page: TranscriptMessage[]; total: number } {
  const total = messages.length;
  const start = Math.min(Math.max(0, offset), total);
  const page = messages.slice(start, start + limit);
  return { page, total };
}
