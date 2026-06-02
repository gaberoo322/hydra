/**
 * test/schema-seam-check.test.mts — pin the ADR-0011 schema-seam-check grammar
 * at the predicate level (no git scan, no process.exit).
 *
 * The CI gate at scripts/ci/schema-seam-check.ts flags any `src/api/*.ts`
 * handler segment (split at `router.<method>(` boundaries) that reads
 * `req.body` without a `safeParse(req.body...)` in that same segment. It
 * targets `req.body` ONLY — `req.query` validation does not satisfy the rule
 * and a raw `req.query` read does not trip it.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { fileViolatesSchemaSeam } = await import(
  "../scripts/ci/schema-seam-check.ts"
);

describe("schema-seam-check: single-handler files", () => {
  test("flags a handler that reads req.body without safeParse", () => {
    const body = `
      export function r() {
        const router = Router();
        router.post("/x", async (req, res) => {
          const { cycleId } = req.body || {};
          res.json({ cycleId });
        });
        return router;
      }`;
    assert.equal(fileViolatesSchemaSeam(body), true);
  });

  test("does NOT flag a handler that safeParses req.body", () => {
    const body = `
      export function r() {
        const router = Router();
        router.post("/x", async (req, res) => {
          const parsed = Schema.safeParse(req.body ?? {});
          if (!parsed.success) return res.status(400).json({ code: "schema-validation-failed", issues: parsed.error.issues });
          res.json(parsed.data);
        });
        return router;
      }`;
    assert.equal(fileViolatesSchemaSeam(body), false);
  });

  test("accepts the `req.body || {}` safeParse form too", () => {
    const body = `
      router.post("/x", async (req, res) => {
        const parsed = Schema.safeParse(req.body || {});
        if (!parsed.success) return res.status(400).json(parsed.error);
        res.json(parsed.data);
      });`;
    assert.equal(fileViolatesSchemaSeam(body), false);
  });
});

describe("schema-seam-check: per-handler segmentation", () => {
  test("flags a file where one handler safeParses but a sibling reads raw", () => {
    const body = `
      export function r() {
        const router = Router();
        router.post("/good", async (req, res) => {
          const parsed = Schema.safeParse(req.body ?? {});
          if (!parsed.success) return res.status(400).json(parsed.error);
          res.json(parsed.data);
        });
        router.post("/bad", async (req, res) => {
          const payload = req.body;
          res.json(payload);
        });
        return router;
      }`;
    assert.equal(fileViolatesSchemaSeam(body), true);
  });

  test("does NOT flag a file where every body-reading handler safeParses", () => {
    const body = `
      router.post("/a", async (req, res) => {
        const parsed = A.safeParse(req.body ?? {});
        res.json(parsed);
      });
      router.post("/b", async (req, res) => {
        const parsed = B.safeParse(req.body ?? {});
        res.json(parsed);
      });`;
    assert.equal(fileViolatesSchemaSeam(body), false);
  });
});

describe("schema-seam-check: req.query is out of scope", () => {
  test("does NOT flag a handler that only reads req.query (no req.body)", () => {
    const body = `
      router.get("/x", async (req, res) => {
        const parsed = QuerySchema.safeParse(req.query ?? {});
        res.json(parsed);
      });`;
    assert.equal(fileViolatesSchemaSeam(body), false);
  });

  test("does NOT flag a file whose POST safeParses req.body even if a GET safeParses req.query (now-page.ts shape)", () => {
    const body = `
      router.get("/now/alerts", async (req, res) => {
        const parsed = QuerySchema.safeParse(req.query ?? {});
        res.json(parsed);
      });
      router.post("/now/recommendations/mute-class", async (req, res) => {
        const parsed = BodySchema.safeParse(req.body ?? {});
        res.json(parsed);
      });`;
    assert.equal(fileViolatesSchemaSeam(body), false);
  });

  test("a req.query safeParse does NOT satisfy a req.body read in the same handler", () => {
    const body = `
      router.post("/x", async (req, res) => {
        const q = QuerySchema.safeParse(req.query ?? {});
        const payload = req.body;
        res.json({ q, payload });
      });`;
    assert.equal(fileViolatesSchemaSeam(body), true);
  });
});

describe("schema-seam-check: files with no router calls", () => {
  test("clean module that never reads req.body is not flagged", () => {
    const body = `export function helper(x: number) { return x + 1; }`;
    assert.equal(fileViolatesSchemaSeam(body), false);
  });

  test("a stray req.body read outside any router method is flagged", () => {
    const body = `export function leak(req: any) { return req.body.field; }`;
    assert.equal(fileViolatesSchemaSeam(body), true);
  });
});
