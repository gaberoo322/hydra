/**
 * test/sentry-webhook-schema.test.mts — unit tests for the Sentry webhook
 * payload schema (issue #3199 — schema validation for POST /webhooks/sentry).
 *
 * Tests are pure (no Redis, no Express, no HTTP): they exercise the Zod schema
 * directly, confirming that:
 *   1. A well-formed Sentry payload parses successfully.
 *   2. A malformed payload (not an object) fails with a parseable error.
 *   3. Unknown top-level keys are allowed (.passthrough()).
 *   4. All named fields are optional (partial payloads still parse).
 *   5. The inferred type carries the expected fields.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { SentryWebhookPayloadSchema } from "../src/schemas/webhooks.ts";

describe("SentryWebhookPayloadSchema (issue #3199)", () => {
  test("parses a full well-formed Sentry webhook payload", () => {
    const input = {
      action: "created",
      data: {
        issue: {
          title: "TypeError: Cannot read property 'foo' of undefined",
          level: "error",
          culprit: "src/index.ts in handleRequest",
          web_url: "https://sentry.io/issues/123",
          first_seen: "2026-07-11T00:00:00Z",
          count: 42,
        },
      },
      project: { slug: "hydra-orchestrator" },
    };

    const result = SentryWebhookPayloadSchema.safeParse(input);
    assert.ok(result.success, `Expected parse success, got: ${JSON.stringify((result as any).error?.issues)}`);
    assert.equal(result.data.action, "created");
    assert.equal(result.data.project?.slug, "hydra-orchestrator");
    assert.equal(result.data.data?.issue?.level, "error");
  });

  test("parses a minimal Sentry payload (all optional fields absent)", () => {
    const result = SentryWebhookPayloadSchema.safeParse({});
    assert.ok(result.success, "An empty object must be valid — all fields are optional");
  });

  test("parses a payload with only project_slug (flat form)", () => {
    const input = {
      action: "triggered",
      project_slug: "hydra-target",
      data: { event: { level: "fatal", title: "OOM" } },
    };
    const result = SentryWebhookPayloadSchema.safeParse(input);
    assert.ok(result.success);
    assert.equal(result.data.project_slug, "hydra-target");
  });

  test("allows unknown top-level keys (passthrough)", () => {
    const input = {
      action: "created",
      unknown_field: "should not 400",
      data: {},
    };
    const result = SentryWebhookPayloadSchema.safeParse(input);
    assert.ok(result.success, "Unknown keys must not fail the schema (passthrough)");
  });

  test("fails on a non-object body (string)", () => {
    const result = SentryWebhookPayloadSchema.safeParse("not-an-object");
    assert.ok(!result.success, "A string body must fail the schema");
    assert.ok(result.error.issues.length > 0, "Error must have at least one issue");
  });

  test("fails on a non-object body (null)", () => {
    const result = SentryWebhookPayloadSchema.safeParse(null);
    assert.ok(!result.success, "null body must fail the schema");
  });

  test("fails on a non-object body (array)", () => {
    const result = SentryWebhookPayloadSchema.safeParse([{ action: "created" }]);
    assert.ok(!result.success, "An array body must fail the schema");
  });

  test("preserves action field in parsed data", () => {
    const result = SentryWebhookPayloadSchema.safeParse({ action: "resolved" });
    assert.ok(result.success);
    assert.equal(result.data.action, "resolved");
  });
});
