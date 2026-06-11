/**
 * Schema for POST /api/queue request bodies (issue #562 seed PR).
 *
 * This is the first schema landed under `src/schemas/` — the canonical
 * directory for runtime-validated boundary contracts (see CLAUDE.md).
 *
 * Why zod (and not hand-rolled validation): a `z.object({...})` schema is
 * BOTH a runtime parser AND a TypeScript type source. The parse() result is
 * a tagged union ({ success: true, data } | { success: false, error }) with
 * a stable `error.issues[]` shape that downstream agents and clients can
 * pattern-match on without parsing prose error messages. See ADR-0005
 * (operator-approved runtime deps) and CLAUDE.md for the dep-set discipline.
 */
import { z } from "zod";

/**
 * Body accepted by `POST /api/queue`.
 *
 * - `reference` is required. It's the human-readable handle the operator
 *   or agent wants to enqueue ("Add stream freshness route-quality scoring").
 *   We require >=1 char after trimming so empty / whitespace-only refs
 *   don't slip past the existing `if (!reference)` check.
 * - `reason` is optional free text; defaults to "queued by operator" in
 *   the route handler when omitted.
 * - `context` is optional and shape-free at this boundary — different
 *   callers attach different payloads (operator notes, target-backlog
 *   findings, sweep dedup hints). We accept any JSON-serialisable value
 *   and let the consumer interpret it. Keeping it loose preserves the
 *   pre-zod behaviour while still rejecting non-JSON inputs.
 * - `source` is optional provenance ("hydra-cli", "sweep", "operator").
 *   The `hydra` CLI always injects `source:"hydra-cli"` (bin/hydra
 *   cmd_queue), and downstream consumers READ it — `indexWorkItem`
 *   (src/redis/work-queue.ts) and the `/queue/snapshot` route
 *   (src/api/queue.ts) both surface `item.source`. Before issue #1140
 *   the `.strict()` schema rejected this key with
 *   `schema-validation-failed` (`unrecognized_keys: ["source"]`), so
 *   EVERY `hydra queue add` 400'd. We keep `.strict()` (it is what
 *   catches typo'd keys — the contract-drift class this fix targets) and
 *   instead enumerate `source` as a legitimate optional field rather than
 *   loosening to passthrough (ADR-0011).
 */
export const QueuePostBodySchema = z
  .object({
    reference: z
      .string({ message: "reference must be a string" })
      .trim()
      .min(1, { message: "reference must be a non-empty string" }),
    reason: z.string().optional(),
    context: z.unknown().optional(),
    source: z.string().optional(),
  })
  .strict();
