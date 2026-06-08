/**
 * test/query-seam-check.test.mts — pin the ADR-0022 query-seam-check grammar
 * at the predicate level (no git scan, no process.exit).
 *
 * The CI gate at scripts/ci/query-seam-check.ts flags any `src/api/*.ts`
 * handler segment (split at `router.<method>(` boundaries) that reads
 * `req.query.<field>` (a named-field access) without a `safeParse(req.query...)`
 * / `.parse(req.query...)` in that same segment. A segment that passes the
 * WHOLE `req.query` to safeParse/parse, or to `new URLSearchParams(req.query)`,
 * reads no named field and is clean by construction (ADR-0022 §1/§4).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { fileViolatesQuerySeam } = await import(
  "../scripts/ci/query-seam-check.ts"
);

describe("query-seam-check: single-handler files", () => {
  test("flags a GET handler that reads req.query.count without safeParse", () => {
    const body = `
      export function r() {
        const router = Router();
        router.get("/x", async (req, res) => {
          const count = Number(req.query.count) || 20;
          res.json({ count });
        });
        return router;
      }`;
    assert.equal(fileViolatesQuerySeam(body), true);
  });

  test("does NOT flag a handler that reads off safeParse(req.query).data", () => {
    const body = `
      router.get("/x", async (req, res) => {
        const count = countQuerySchema(20).safeParse(req.query).data?.count ?? 20;
        res.json({ count });
      });`;
    assert.equal(fileViolatesQuerySeam(body), false);
  });

  test("does NOT flag a throwing .parse(req.query) form", () => {
    const body = `
      router.get("/x", async (req, res) => {
        const { window } = ScoutStatsQuerySchema.parse(req.query);
        res.json({ window });
      });`;
    assert.equal(fileViolatesQuerySeam(body), false);
  });

  test("does NOT flag a new URLSearchParams(req.query) whole-query proxy", () => {
    const body = `
      router.get("/reflections", async (req, res) => {
        const qs = new URLSearchParams(req.query as Record<string, string>).toString();
        res.json({ qs });
      });`;
    assert.equal(fileViolatesQuerySeam(body), false);
  });

  test("does NOT flag a safeParse(req.query).data destructure then field read", () => {
    const body = `
      router.get("/x", async (req, res) => {
        const query = ReflectionsQuerySchema.safeParse(req.query).data ?? {};
        res.json({ anchor: query.anchor });
      });`;
    assert.equal(fileViolatesQuerySeam(body), false);
  });
});

describe("query-seam-check: per-handler segmentation", () => {
  test("flags a file where one GET safeParses but a sibling reads a raw named field", () => {
    const body = `
      export function r() {
        const router = Router();
        router.get("/good", async (req, res) => {
          const count = countQuerySchema(20).safeParse(req.query).data?.count ?? 20;
          res.json({ count });
        });
        router.get("/bad", async (req, res) => {
          const limit = req.query.limit;
          res.json({ limit });
        });
        return router;
      }`;
    assert.equal(fileViolatesQuerySeam(body), true);
  });

  test("does NOT flag a file where every query-reading handler validates the whole query", () => {
    const body = `
      router.get("/a", async (req, res) => {
        const a = A.safeParse(req.query).data?.a;
        res.json({ a });
      });
      router.get("/b", async (req, res) => {
        const b = B.parse(req.query).b;
        res.json({ b });
      });`;
    assert.equal(fileViolatesQuerySeam(body), false);
  });

  test("a safeParse(req.query) in one handler does NOT cover a raw named read in a sibling", () => {
    const body = `
      router.get("/a", async (req, res) => {
        const parsed = A.safeParse(req.query);
        res.json(parsed.data);
      });
      router.get("/b", async (req, res) => {
        const raw = req.query.date;
        res.json({ raw });
      });`;
    assert.equal(fileViolatesQuerySeam(body), true);
  });
});

describe("query-seam-check: req.body / req.params are out of scope", () => {
  test("does NOT flag a handler that only reads req.body (no named req.query)", () => {
    const body = `
      router.post("/x", async (req, res) => {
        const { cycleId } = req.body || {};
        res.json({ cycleId });
      });`;
    assert.equal(fileViolatesQuerySeam(body), false);
  });

  test("does NOT flag a handler that reads req.params.<field>", () => {
    const body = `
      router.get("/x/:id", async (req, res) => {
        const id = req.params.id;
        res.json({ id });
      });`;
    assert.equal(fileViolatesQuerySeam(body), false);
  });
});

describe("query-seam-check: files with no router calls", () => {
  test("clean module that never reads a named req.query field is not flagged", () => {
    const body = `export function helper(x: number) { return x + 1; }`;
    assert.equal(fileViolatesQuerySeam(body), false);
  });

  test("a stray req.query.<field> read outside any router method is flagged", () => {
    const body = `export function leak(req: any) { return req.query.field; }`;
    assert.equal(fileViolatesQuerySeam(body), true);
  });

  test("a whole-query helper (route-helpers shape) outside a router is clean", () => {
    const body = `
      export function queryValidated(schema) {
        return (req, res, next) => {
          const parsed = schema.safeParse(req.query ?? {});
          if (!parsed.success) return res.status(400).json(parsed.error);
          next();
        };
      }`;
    assert.equal(fileViolatesQuerySeam(body), false);
  });
});
