/**
 * Schema validation tests for PLANNER_OUTPUT_SCHEMA.
 *
 * Regression: Codex SDK requires `additionalProperties: false` on every
 * object in a structured-output schema. When this was missing on nested
 * objects, every planner call failed silently. This test catches that
 * class of error statically so it never reaches production again.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PLANNER_OUTPUT_SCHEMA } from "../src/planner-prompt.ts";

/**
 * Recursively validate that every object-typed node in a JSON Schema has
 * `additionalProperties: false` — the Codex SDK / OpenAI structured-output
 * requirement that caused a full outage when missing.
 */
function validateAdditionalProperties(schema: any, path = "root"): string[] {
  const errors: string[] = [];

  if (schema.type === "object") {
    if (schema.additionalProperties !== false) {
      errors.push(`${path}: missing additionalProperties: false`);
    }
    if (schema.properties) {
      for (const [key, value] of Object.entries(schema.properties)) {
        errors.push(...validateAdditionalProperties(value as any, `${path}.${key}`));
      }
    }
  }

  if (schema.type === "array" && schema.items) {
    errors.push(...validateAdditionalProperties(schema.items, `${path}[]`));
  }

  return errors;
}

/**
 * Validate that every property listed in `required` actually exists in
 * `properties`, and vice versa (all properties should be required — OpenAI
 * structured output requires this; use `["type", "null"]` for optional).
 */
function validateRequiredAlignment(schema: any, path = "root"): string[] {
  const errors: string[] = [];

  if (schema.type === "object" && schema.properties) {
    const propKeys = Object.keys(schema.properties);
    const required = schema.required || [];

    // Every required key must exist in properties
    for (const key of required) {
      if (!propKeys.includes(key)) {
        errors.push(`${path}: required field "${key}" not in properties`);
      }
    }

    // Every property should be required (OpenAI structured output constraint)
    for (const key of propKeys) {
      if (!required.includes(key)) {
        errors.push(`${path}: property "${key}" not in required array (use ["type", "null"] for optional)`);
      }
    }

    // Recurse into nested objects
    for (const [key, value] of Object.entries(schema.properties)) {
      errors.push(...validateRequiredAlignment(value as any, `${path}.${key}`));
    }
  }

  if (schema.type === "array" && schema.items) {
    errors.push(...validateRequiredAlignment(schema.items, `${path}[]`));
  }

  return errors;
}

describe("PLANNER_OUTPUT_SCHEMA", () => {
  test("is an object schema", () => {
    assert.equal(PLANNER_OUTPUT_SCHEMA.type, "object");
  });

  test("has additionalProperties: false on all object nodes", () => {
    const errors = validateAdditionalProperties(PLANNER_OUTPUT_SCHEMA);
    assert.deepEqual(errors, [], `Schema violations:\n${errors.join("\n")}`);
  });

  test("has required arrays aligned with properties on all object nodes", () => {
    const errors = validateRequiredAlignment(PLANNER_OUTPUT_SCHEMA);
    assert.deepEqual(errors, [], `Required/properties mismatch:\n${errors.join("\n")}`);
  });

  test("has required array at root level", () => {
    assert.ok(Array.isArray(PLANNER_OUTPUT_SCHEMA.required), "root schema must have required array");
    assert.ok(PLANNER_OUTPUT_SCHEMA.required.length > 0, "required array must not be empty");
  });

  test("scopeBoundary is a valid nested object schema", () => {
    const scope = PLANNER_OUTPUT_SCHEMA.properties.scopeBoundary;
    assert.equal(scope.type, "object");
    assert.equal(scope.additionalProperties, false);
    assert.ok(scope.required.includes("in"));
    assert.ok(scope.required.includes("out"));
  });

  test("verificationPlan items are valid nested object schemas", () => {
    const vp = PLANNER_OUTPUT_SCHEMA.properties.verificationPlan;
    assert.equal(vp.type, "array");
    assert.equal(vp.items.type, "object");
    assert.equal(vp.items.additionalProperties, false);
    assert.ok(vp.items.required.includes("command"));
    assert.ok(vp.items.required.includes("expected"));
    assert.ok(vp.items.required.includes("label"));
  });
});
