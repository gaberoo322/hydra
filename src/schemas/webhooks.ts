/**
 * Boundary schema for the POST /webhooks/sentry external webhook endpoint
 * (issue #3199).
 *
 * Follows the `src/schemas/` zod convention (CLAUDE.md / ADR-0011 / issue #562):
 * the schema is both the runtime parser and the inferred TypeScript type, and a
 * `safeParse()` failure returns HTTP 400 with the structured
 * `{ code: "schema-validation-failed", issues }` shape.
 *
 * The schema captures the MINIMAL subset of the Sentry webhook payload that the
 * /webhooks/sentry handler reads. All nested fields are optional (Sentry's
 * schema varies by event type and SDK version), so the schema functions as a
 * structural guard rather than a strict allowlist — unknown top-level keys are
 * permitted because the handler only reads the named fields.
 *
 * The `action` field is optional because Sentry does not always include it
 * (some event types emit only `data`). An absent `action` must reach the
 * handler so it can apply the "skip non-created/triggered" guard at the app
 * layer; the schema guard only rejects payloads that are not objects at all
 * (e.g. a plain string body).
 */
import { z } from "zod";

/**
 * Minimal Sentry issue shape read by the webhook handler.
 * All fields optional — the handler gracefully defaults any that are absent.
 */
const SentryIssueSchema = z.object({
  title: z.string().optional(),
  message: z.string().optional(),
  web_url: z.string().optional(),
  url: z.string().optional(),
  culprit: z.string().optional(),
  level: z.string().optional(),
  first_seen: z.string().optional(),
  firstSeen: z.string().optional(),
  count: z.number().optional(),
}).passthrough();

/**
 * Top-level Sentry webhook payload. Uses `.passthrough()` to allow unknown
 * keys (Sentry's schema varies; the handler reads only the named fields).
 */
export const SentryWebhookPayloadSchema = z
  .object({
    action: z.string().optional(),
    data: z
      .object({
        issue: SentryIssueSchema.optional(),
        event: SentryIssueSchema.optional(),
      })
      .passthrough()
      .optional(),
    project: z
      .object({
        slug: z.string().optional(),
      })
      .passthrough()
      .optional(),
    project_slug: z.string().optional(),
  })
  .passthrough();
