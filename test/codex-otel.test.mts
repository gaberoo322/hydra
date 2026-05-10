import test from "node:test";
import assert from "node:assert/strict";

import {
  buildOtelResourceAttrs,
  mergeOtelResourceAttrs,
  sanitizeAttrValue,
  isOtelEnabled,
  buildCodexOtelEnv,
} from "../src/codex-otel.ts";

test("sanitizeAttrValue strips commas and equals, trims whitespace", () => {
  assert.equal(sanitizeAttrValue("  hello  "), "hello");
  assert.equal(sanitizeAttrValue("foo,bar=baz"), "foo_bar_baz");
  assert.equal(sanitizeAttrValue(""), "");
  assert.equal(sanitizeAttrValue(null), "");
  assert.equal(sanitizeAttrValue(undefined), "");
  assert.equal(sanitizeAttrValue(42), "42");
});

test("sanitizeAttrValue caps long values to 200 chars", () => {
  const long = "x".repeat(500);
  assert.equal(sanitizeAttrValue(long).length, 200);
});

test("buildOtelResourceAttrs emits hydra.* keys with sanitized values", () => {
  const out = buildOtelResourceAttrs({
    cycleId: "cycle-abc-123",
    agentName: "planner",
    taskId: "task-9",
    modelTier: "frontier",
    resolvedModel: "gpt-5.5",
    complexity: "standard",
  });
  assert.match(out, /hydra\.cycle_id=cycle-abc-123/);
  assert.match(out, /hydra\.agent_role=planner/);
  assert.match(out, /hydra\.task_id=task-9/);
  assert.match(out, /hydra\.model_tier=frontier/);
  assert.match(out, /hydra\.model=gpt-5\.5/);
  assert.match(out, /hydra\.complexity=standard/);
});

test("buildOtelResourceAttrs omits empty/null fields", () => {
  const out = buildOtelResourceAttrs({
    cycleId: "abc",
    agentName: null,
    taskId: undefined,
    modelTier: "",
  });
  assert.equal(out, "hydra.cycle_id=abc");
});

test("buildOtelResourceAttrs returns empty string when no attrs present", () => {
  assert.equal(buildOtelResourceAttrs({}), "");
  assert.equal(buildOtelResourceAttrs({ cycleId: null, agentName: null }), "");
});

test("mergeOtelResourceAttrs preserves base attrs and lets hydra override", () => {
  const merged = mergeOtelResourceAttrs(
    "service.name=other,deployment.env=prod",
    "hydra.cycle_id=abc,deployment.env=staging",
  );
  // hydra wins on collision (deployment.env=staging), other base attrs preserved
  assert.match(merged, /service\.name=other/);
  assert.match(merged, /hydra\.cycle_id=abc/);
  assert.match(merged, /deployment\.env=staging/);
  assert.doesNotMatch(merged, /deployment\.env=prod/);
});

test("mergeOtelResourceAttrs handles empty inputs", () => {
  assert.equal(mergeOtelResourceAttrs(undefined, ""), "");
  assert.equal(mergeOtelResourceAttrs("a=1", ""), "a=1");
  assert.equal(mergeOtelResourceAttrs("", "a=1"), "a=1");
  assert.equal(mergeOtelResourceAttrs(undefined, "a=1"), "a=1");
});

test("isOtelEnabled honors HYDRA_OTEL_ENABLED env var", () => {
  const original = process.env.HYDRA_OTEL_ENABLED;
  try {
    delete process.env.HYDRA_OTEL_ENABLED;
    assert.equal(isOtelEnabled(), false);

    process.env.HYDRA_OTEL_ENABLED = "false";
    assert.equal(isOtelEnabled(), false);

    process.env.HYDRA_OTEL_ENABLED = "true";
    assert.equal(isOtelEnabled(), true);

    process.env.HYDRA_OTEL_ENABLED = "1";
    assert.equal(isOtelEnabled(), true);
  } finally {
    if (original === undefined) delete process.env.HYDRA_OTEL_ENABLED;
    else process.env.HYDRA_OTEL_ENABLED = original;
  }
});

test("buildCodexOtelEnv returns null when OTel disabled", () => {
  const original = process.env.HYDRA_OTEL_ENABLED;
  try {
    delete process.env.HYDRA_OTEL_ENABLED;
    const env = buildCodexOtelEnv({ cycleId: "abc", agentName: "planner" });
    assert.equal(env, null);
  } finally {
    if (original === undefined) delete process.env.HYDRA_OTEL_ENABLED;
    else process.env.HYDRA_OTEL_ENABLED = original;
  }
});

test("buildCodexOtelEnv inherits process.env and adds OTEL_RESOURCE_ATTRIBUTES + OTEL_SERVICE_NAME when enabled", () => {
  const originalEnabled = process.env.HYDRA_OTEL_ENABLED;
  const originalAttrs = process.env.OTEL_RESOURCE_ATTRIBUTES;
  const originalService = process.env.OTEL_SERVICE_NAME;
  try {
    process.env.HYDRA_OTEL_ENABLED = "true";
    delete process.env.OTEL_RESOURCE_ATTRIBUTES;
    delete process.env.OTEL_SERVICE_NAME;
    process.env.HYDRA_TEST_MARKER = "marker-value";

    const env = buildCodexOtelEnv({
      cycleId: "cycle-1",
      agentName: "executor",
      taskId: "t-1",
      resolvedModel: "gpt-5.3-codex",
    });
    assert.ok(env, "env should be non-null");
    // Inherits process.env
    assert.equal(env.HYDRA_TEST_MARKER, "marker-value");
    // Hydra resource attrs injected
    assert.match(env.OTEL_RESOURCE_ATTRIBUTES, /hydra\.cycle_id=cycle-1/);
    assert.match(env.OTEL_RESOURCE_ATTRIBUTES, /hydra\.agent_role=executor/);
    // Default service name set
    assert.equal(env.OTEL_SERVICE_NAME, "hydra-codex");
  } finally {
    if (originalEnabled === undefined) delete process.env.HYDRA_OTEL_ENABLED;
    else process.env.HYDRA_OTEL_ENABLED = originalEnabled;
    if (originalAttrs === undefined) delete process.env.OTEL_RESOURCE_ATTRIBUTES;
    else process.env.OTEL_RESOURCE_ATTRIBUTES = originalAttrs;
    if (originalService === undefined) delete process.env.OTEL_SERVICE_NAME;
    else process.env.OTEL_SERVICE_NAME = originalService;
    delete process.env.HYDRA_TEST_MARKER;
  }
});

test("buildCodexOtelEnv preserves operator-set OTEL_SERVICE_NAME", () => {
  const originalEnabled = process.env.HYDRA_OTEL_ENABLED;
  const originalService = process.env.OTEL_SERVICE_NAME;
  try {
    process.env.HYDRA_OTEL_ENABLED = "true";
    process.env.OTEL_SERVICE_NAME = "my-custom-service";
    const env = buildCodexOtelEnv({ cycleId: "abc" });
    assert.ok(env);
    assert.equal(env.OTEL_SERVICE_NAME, "my-custom-service");
  } finally {
    if (originalEnabled === undefined) delete process.env.HYDRA_OTEL_ENABLED;
    else process.env.HYDRA_OTEL_ENABLED = originalEnabled;
    if (originalService === undefined) delete process.env.OTEL_SERVICE_NAME;
    else process.env.OTEL_SERVICE_NAME = originalService;
  }
});

test("buildCodexOtelEnv merges base OTEL_RESOURCE_ATTRIBUTES with hydra attrs", () => {
  const originalEnabled = process.env.HYDRA_OTEL_ENABLED;
  const originalAttrs = process.env.OTEL_RESOURCE_ATTRIBUTES;
  try {
    process.env.HYDRA_OTEL_ENABLED = "true";
    process.env.OTEL_RESOURCE_ATTRIBUTES = "deployment.environment=prod,team=hydra";
    const env = buildCodexOtelEnv({ cycleId: "cycle-x", agentName: "fixer" });
    assert.ok(env);
    assert.match(env.OTEL_RESOURCE_ATTRIBUTES, /deployment\.environment=prod/);
    assert.match(env.OTEL_RESOURCE_ATTRIBUTES, /team=hydra/);
    assert.match(env.OTEL_RESOURCE_ATTRIBUTES, /hydra\.cycle_id=cycle-x/);
    assert.match(env.OTEL_RESOURCE_ATTRIBUTES, /hydra\.agent_role=fixer/);
  } finally {
    if (originalEnabled === undefined) delete process.env.HYDRA_OTEL_ENABLED;
    else process.env.HYDRA_OTEL_ENABLED = originalEnabled;
    if (originalAttrs === undefined) delete process.env.OTEL_RESOURCE_ATTRIBUTES;
    else process.env.OTEL_RESOURCE_ATTRIBUTES = originalAttrs;
  }
});
