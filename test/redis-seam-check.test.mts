/**
 * test/redis-seam-check.test.mts — pin the ADR-0009 / ADR-0017 seam-check
 * grammar at the predicate level (no git scan, no process.exit).
 *
 * The CI gate at scripts/ci/redis-seam-check.ts forbids:
 *   - legacy surfaces: redis-keys, redis-adapter, redis/keys, redis/kv
 *   - (ADR-0017) a STATIC `from '.../redis/connection'` import outside
 *     src/redis/* AND the sanctioned src/event-bus.ts owner.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { fileViolatesSeam } = await import("../scripts/ci/redis-seam-check.ts");

describe("redis-seam-check: legacy surfaces", () => {
  test("flags redis/keys and redis/kv imports", () => {
    assert.equal(
      fileViolatesSeam("src/foo.ts", `import { x } from "./redis/keys.ts";`),
      true,
    );
    assert.equal(
      fileViolatesSeam("src/foo.ts", `import { x } from "../redis/kv";`),
      true,
    );
  });

  test("flags legacy redis-keys / redis-adapter", () => {
    assert.equal(
      fileViolatesSeam("src/foo.ts", `import { k } from "./redis-keys.ts";`),
      true,
    );
    assert.equal(
      fileViolatesSeam("src/foo.ts", `import { a } from "../redis-adapter";`),
      true,
    );
  });
});

describe("redis-seam-check: ADR-0017 raw-connection rule", () => {
  test("flags a raw redis/connection import from a non-sanctioned file", () => {
    assert.equal(
      fileViolatesSeam(
        "src/capacity-floor.ts",
        `import { getRedisConnection } from "./redis/connection.ts";`,
      ),
      true,
    );
    assert.equal(
      fileViolatesSeam(
        "src/autopilot/pr-lifecycle-bridge.ts",
        `import { getRedisConnection } from "../redis/connection.ts";`,
      ),
      true,
    );
  });

  test("exempts the sanctioned Event Bus owner", () => {
    assert.equal(
      fileViolatesSeam(
        "src/event-bus.ts",
        `import { getRedisConnection, getRedisSubscriber } from "./redis/connection.ts";`,
      ),
      false,
    );
  });

  test("clean module that uses a typed accessor is not flagged", () => {
    assert.equal(
      fileViolatesSeam(
        "src/capacity-floor.ts",
        `import { boundedJsonList } from "./redis/bounded-list.ts";`,
      ),
      false,
    );
  });
});

describe("redis-seam-check: issue #1121 dynamic-import rule", () => {
  test("flags a dynamic await import of redis/connection from a non-sanctioned file", () => {
    assert.equal(
      fileViolatesSeam(
        "src/aggregators/lessons-explorer.ts",
        `const { getRedisConnection } = await import("../redis/connection.ts");`,
      ),
      true,
    );
  });

  test("flags a dynamic await import of redis/keys from a non-sanctioned file", () => {
    assert.equal(
      fileViolatesSeam(
        "src/aggregators/overnight-summary.ts",
        `const { redisKeys } = await import("../redis/keys.ts");`,
      ),
      true,
    );
  });

  test("flags a dynamic import without await (import('...').then(...))", () => {
    assert.equal(
      fileViolatesSeam(
        "src/foo.ts",
        `import("./redis/connection").then((m) => m.getRedisConnection());`,
      ),
      true,
    );
  });

  test("exempts the sanctioned Event Bus owner from the dynamic rule", () => {
    assert.equal(
      fileViolatesSeam(
        "src/event-bus.ts",
        `const { getRedisConnection } = await import("./redis/connection.ts");`,
      ),
      false,
    );
  });

  test("exempts the redis family itself from the dynamic rule", () => {
    assert.equal(
      fileViolatesSeam(
        "src/redis/some-accessor.ts",
        `const { getRedisConnection } = await import("./connection.ts");`,
      ),
      false,
    );
  });

  test("does NOT flag a dynamic import of an unrelated module", () => {
    assert.equal(
      fileViolatesSeam(
        "src/foo.ts",
        `const { getUsage } = await import("../cost/index.ts");`,
      ),
      false,
    );
  });
});
