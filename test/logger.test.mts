/**
 * Tests for src/logger.ts — the pino structured-logger seam (ADR-0027, #3160).
 *
 * These assert the invariants committed in the design-concept artifact
 * (hash c44a9d78):
 *   - one valid JSON object per line
 *   - err.code preserved as an addressable field (#756)
 *   - deterministic time/pid under the test-determinism override
 *   - LOG_LEVEL selects the level (default info)
 *   - destination is a stream (stderr in production; injectable sync stream in tests)
 *
 * No Redis / scheduler handles are opened here, so this is a self-contained
 * top-level suite with its own lifecycle.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import pino from "pino";

import { createLogger, loggerOptions } from "../src/logger.ts";

/**
 * Capture the serialized JSON lines a logger writes by pointing it at an
 * in-memory sync destination.
 */
function capture(fn: (log: ReturnType<typeof createLogger>) => void): Record<string, unknown>[] {
  const lines: string[] = [];
  const dest = {
    write(chunk: string) {
      // pino writes one JSON object per line, newline-terminated.
      for (const l of chunk.split("\n")) if (l.trim()) lines.push(l);
      return true;
    },
  };
  const log = createLogger(dest as unknown as pino.DestinationStream);
  fn(log);
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("logger (pino structured logger seam)", () => {
  test("emits one valid JSON object per line", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      const objs = capture((log) => {
        log.info({ cycleId: "run-abc" }, "line one");
        log.warn({ cycleId: "run-def" }, "line two");
      });
      assert.equal(objs.length, 2);
      assert.equal(objs[0]!.msg, "line one");
      assert.equal(objs[0]!.cycleId, "run-abc");
      assert.equal(objs[1]!.msg, "line two");
      assert.equal(objs[1]!.cycleId, "run-def");
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  test("preserves typed err.code as an addressable field (#756)", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      const [obj] = capture((log) => {
        log.error(
          { err: { message: "redis timeout", code: "redis-seam-error" } },
          "backoff triggered",
        );
      });
      const err = obj!.err as Record<string, unknown>;
      assert.equal(err.code, "redis-seam-error");
      assert.equal(err.message, "redis timeout");
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  test("pins time and pid deterministically under the test override", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      const [obj] = capture((log) => log.info("deterministic"));
      assert.equal(obj!.time, 0);
      assert.equal(obj!.pid, 0);
      assert.equal(obj!.hostname, "test");
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  test("HYDRA_LOG_DETERMINISTIC=1 enables determinism outside NODE_ENV=test", () => {
    const prevEnv = process.env.NODE_ENV;
    const prevDet = process.env.HYDRA_LOG_DETERMINISTIC;
    process.env.NODE_ENV = "production";
    process.env.HYDRA_LOG_DETERMINISTIC = "1";
    try {
      const [obj] = capture((log) => log.info("det"));
      assert.equal(obj!.time, 0);
      assert.equal(obj!.pid, 0);
    } finally {
      process.env.NODE_ENV = prevEnv;
      if (prevDet === undefined) delete process.env.HYDRA_LOG_DETERMINISTIC;
      else process.env.HYDRA_LOG_DETERMINISTIC = prevDet;
    }
  });

  test("LOG_LEVEL selects the level, default info", () => {
    const prevEnv = process.env.NODE_ENV;
    const prevLevel = process.env.LOG_LEVEL;
    process.env.NODE_ENV = "test";
    try {
      delete process.env.LOG_LEVEL;
      assert.equal(loggerOptions().level, "info");

      process.env.LOG_LEVEL = "debug";
      assert.equal(loggerOptions().level, "debug");
    } finally {
      process.env.NODE_ENV = prevEnv;
      if (prevLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = prevLevel;
    }
  });

  test("level below the configured threshold is filtered out", () => {
    const prevEnv = process.env.NODE_ENV;
    const prevLevel = process.env.LOG_LEVEL;
    process.env.NODE_ENV = "test";
    process.env.LOG_LEVEL = "warn";
    try {
      const objs = capture((log) => {
        log.info("suppressed");
        log.warn("kept");
      });
      assert.equal(objs.length, 1);
      assert.equal(objs[0]!.msg, "kept");
    } finally {
      process.env.NODE_ENV = prevEnv;
      if (prevLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = prevLevel;
    }
  });

  test("childLogger-style bindings appear on every line", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      const objs = capture((log) => {
        const child = log.child({ class: "dev_orch" });
        child.info("a");
        child.info("b");
      });
      assert.equal(objs.length, 2);
      assert.equal(objs[0]!.class, "dev_orch");
      assert.equal(objs[1]!.class, "dev_orch");
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
