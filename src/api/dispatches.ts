/**
 * Dispatch-registry sub-router (issue #692, PRD #690).
 *
 * Exposes the write surface the SessionStart hook
 * (`scripts/hooks/session-start-capture.sh`) calls to register an
 * Agent-tool subagent session into the subagent-dispatch registry:
 *
 *   POST  /api/dispatches/subagent
 *   PATCH /api/dispatches/subagent/:sessionId/current-step
 *
 * Plus the operator-facing transcript read surface (issue #695, PRD #690):
 *
 *   GET   /api/dispatches/:dispatchId/transcript?offset=0&limit=200
 *
 * Both write bodies parse through `src/schemas/dispatches.ts` (ADR-0011
 * Schemas seam). On parse failure they return HTTP 400
 * `{ code: "schema-validation-failed", issues }` so the hook (and any other
 * caller) can pattern-match on a stable error shape.
 *
 * Per CLAUDE.md: this file is a thin route factory; all Redis access goes
 * through the typed `src/redis/dispatches.ts` accessor (ADR-0009). The
 * transcript read additionally touches the filesystem — the harness writes
 * each session's conversation to a line-delimited JSONL under
 * `~/.claude/projects`. That read is on-demand and READ-ONLY (grounding.ts
 * discipline): the route never mutates anything, and the resolved path is
 * confined to `~/.claude/projects` so a client-supplied dispatchId can't
 * traverse out of the transcript root.
 */
import { Router } from "express";
import { promises as fs } from "node:fs";
import {
  registerSubagentDispatch,
  setSubagentDispatchStep,
  getSubagentDispatch,
  type SubagentDispatch,
} from "../redis/dispatches.ts";
import {
  SubagentDispatchPostBodySchema,
  SubagentDispatchStepPatchBodySchema,
  TranscriptQuerySchema,
} from "../schemas/dispatches.ts";
import {
  projectsRoot,
  encodeProjectDir,
  isUuidShaped,
  confineToRoot,
  resolveTranscriptPath,
} from "../transcript-store.ts";

// ===========================================================================
// Transcript reading (issue #695).
//
// Where transcripts live and how to locate one — the `~/.claude/projects`
// root, the `<encoded-projectDir>/<sessionId>.jsonl` layout, the path-traversal
// confinement guard, and the session-id → path resolution — is owned by the
// **Transcript Store** Seam (`src/transcript-store.ts`, issue #951). This
// router is a CALLER of that Interface; it owns only the conversation-record
// projection of the raw JSONL lines (`parseTranscript` / `projectMessage`),
// not the filesystem contract. The store-owned symbols are re-exported below
// for existing test imports (`dispatches-transcript.test.mts`) — the single
// implementation lives in the store.
// ===========================================================================

export {
  encodeProjectDir,
  isUuidShaped,
  confineToRoot,
  resolveTranscriptPath,
} from "../transcript-store.ts";

/**
 * Root under which all transcript JSONL lives; reads are confined here.
 * Delegates to the **Transcript Store** Seam so the `HYDRA_CLAUDE_PROJECTS_ROOT`
 * override is honored identically to the usage tracker (the divergence this
 * Seam removed — issue #951). Kept on this surface for existing callers/tests.
 */
export function transcriptRoot(): string {
  return projectsRoot();
}

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
function stringifyToolResult(content: unknown): string {
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
        `[api/dispatches] skipping malformed JSONL line ${i + 1}: ${(err as Error).message}`,
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

/** Metadata block echoed on every transcript response (known or not-available). */
export function sessionMetadataFrom(dispatch: SubagentDispatch) {
  return {
    skill: dispatch.skill,
    dispatchId: dispatch.dispatchId,
    runId: dispatch.runId ?? null,
    startedAt: dispatch.startedAt,
    projectDir: dispatch.projectDir ?? null,
  };
}

export function createDispatchesRouter() {
  const router = Router();

  // POST /dispatches/subagent — register a subagent session.
  router.post("/dispatches/subagent", async (req, res) => {
    try {
      const parsed = SubagentDispatchPostBodySchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          code: "schema-validation-failed",
          issues: parsed.error.issues,
        });
      }
      const body = parsed.data;

      // startedAt is optional on the wire — stamp capture time when omitted so
      // the index score is always meaningful.
      const startedAt = body.startedAt || new Date().toISOString();
      const dispatch: SubagentDispatch = {
        sessionId: body.sessionId,
        skill: body.skill,
        dispatchId: body.dispatchId,
        startedAt,
      };
      if (body.runId !== undefined) dispatch.runId = body.runId;
      if (body.projectDir !== undefined) dispatch.projectDir = body.projectDir;
      if (body.currentStep !== undefined) dispatch.currentStep = body.currentStep;
      if (body.issueRef !== undefined) dispatch.issueRef = body.issueRef;
      if (body.prRef !== undefined) dispatch.prRef = body.prRef;

      await registerSubagentDispatch(dispatch);
      res.json({ registered: true, dispatch });
    } catch (err: any) {
      console.error("[api/dispatches] POST /dispatches/subagent failed:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // PATCH /dispatches/subagent/:sessionId/current-step — update the step.
  router.patch("/dispatches/subagent/:sessionId/current-step", async (req, res) => {
    try {
      const sessionId = (req.params.sessionId || "").trim();
      if (!sessionId) {
        return res.status(400).json({
          code: "schema-validation-failed",
          issues: [{ path: ["sessionId"], message: "sessionId path param is required" }],
        });
      }
      const parsed = SubagentDispatchStepPatchBodySchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          code: "schema-validation-failed",
          issues: parsed.error.issues,
        });
      }

      await setSubagentDispatchStep(sessionId, parsed.data.currentStep);
      const updated = await getSubagentDispatch(sessionId);
      res.json({ updated: true, dispatch: updated });
    } catch (err: any) {
      console.error(
        "[api/dispatches] PATCH /dispatches/subagent/:sessionId/current-step failed:",
        err,
      );
      res.status(500).json({ error: err.message });
    }
  });

  // GET /dispatches/:dispatchId/transcript — render a subagent session's
  // JSONL conversation (issue #695).
  //
  // The `:dispatchId` path param carries the harness sessionId (in the unified
  // active-dispatch row, `id === sessionId` for source === "subagent"; see
  // src/aggregators/active-dispatches.ts). Resolution:
  //   - Unknown dispatchId            → 404
  //   - Known dispatch, missing JSONL → 200 + transcriptStatus:"not-available"
  //   - Known dispatch, intact JSONL  → 200 + paginated messages
  // A malformed JSONL line is skipped, never 500.
  router.get("/dispatches/:dispatchId/transcript", async (req, res) => {
    const dispatchId = (req.params.dispatchId || "").trim();
    try {
      const parsedQuery = TranscriptQuerySchema.safeParse(req.query ?? {});
      if (!parsedQuery.success) {
        return res.status(400).json({
          code: "schema-validation-failed",
          issues: parsedQuery.error.issues,
        });
      }
      const { offset, limit } = parsedQuery.data;

      const dispatch = await getSubagentDispatch(dispatchId);
      if (!dispatch) {
        return res.status(404).json({
          code: "dispatch-not-found",
          dispatchId,
        });
      }

      const sessionMetadata = sessionMetadataFrom(dispatch);

      // dispatchId === sessionId for the subagent source. Resolve the JSONL.
      const path = await resolveTranscriptPath(
        dispatch.sessionId,
        dispatch.projectDir,
      );
      if (!path) {
        // Known dispatch but the transcript file is gone (cleanup / >30d) or
        // never materialised. NOT a 500 — render metadata, empty messages.
        return res.json({
          transcriptStatus: "not-available",
          messages: [],
          total: 0,
          offset,
          limit,
          sessionMetadata,
        });
      }

      let raw: string;
      try {
        raw = await fs.readFile(path, "utf8");
      } catch (err) {
        // The file vanished between resolve and read, or is unreadable. Treat
        // as not-available rather than 500 — same contract as a missing file.
        console.error(
          `[api/dispatches] transcript read failed for ${dispatchId} at ${path}:`,
          err,
        );
        return res.json({
          transcriptStatus: "not-available",
          messages: [],
          total: 0,
          offset,
          limit,
          sessionMetadata,
        });
      }

      const all = parseTranscript(raw);
      const { page, total } = paginate(all, offset, limit);
      return res.json({
        transcriptStatus: "available",
        messages: page,
        total,
        offset,
        limit,
        sessionMetadata,
      });
    } catch (err: any) {
      console.error(
        `[api/dispatches] GET /dispatches/${dispatchId}/transcript failed:`,
        err,
      );
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
