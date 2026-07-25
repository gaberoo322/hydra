/**
 * Regression tests for the operational-command API router
 * (`src/api/operational.ts`, issue #3652).
 *
 * A minimal emergency-stop surface (issue #2183): `POST /kill` writes the kill
 * file that `health.ts` and `service-strip.ts` poll. The router resolves its
 * kill-file path from `HYDRA_ROOT` (falling back to `$HOME/hydra`) at
 * construction time. This suite pins two invariants:
 *
 *   1. The single `/kill` route is registered as a POST (nothing else came
 *      along when the route was re-homed out of `api/misc.ts`).
 *   2. Hitting `/kill` writes an ISO-timestamp kill file at
 *      `<HYDRA_ROOT>/.kill` and returns `{ killed: true, killFile }`.
 *
 * The kill file is written into a throwaway `mkdtemp` directory (via a scoped
 * `HYDRA_ROOT` override) so the test never touches the real `~/hydra/.kill`, and
 * the router is exercised through `req`/`res` mocks — no Redis, no HTTP server,
 * its own trivial lifecycle.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createOperationalRouter } from "../src/api/operational.ts";

function routeTable(router: any): string[] {
  const entries: string[] = [];
  for (const layer of router.stack ?? []) {
    const route = layer.route;
    if (!route) continue;
    for (const method of Object.keys(route.methods ?? {})) {
      entries.push(`${method.toUpperCase()} ${route.path}`);
    }
  }
  return entries;
}

function findHandler(
  router: any,
  method: string,
  path: string,
): Function | null {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path) {
      const methods = layer.route.methods;
      if (methods[method.toLowerCase()]) {
        const stack = layer.route.stack;
        return stack[stack.length - 1].handle;
      }
    }
  }
  return null;
}

function mockReq(): any {
  return { method: "POST", url: "/kill", headers: {}, query: {}, params: {}, body: {} };
}

function mockRes(): any {
  const res: any = {
    _status: 200,
    _body: null,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(body: any) {
      res._body = body;
      return res;
    },
    send(body: any) {
      res._body = body;
      return res;
    },
    setHeader() {
      return res;
    },
    end() {
      return res;
    },
  };
  return res;
}

let tmpDir: string;
let savedHydraRoot: string | undefined;

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hydra-operational-test-"));
  savedHydraRoot = process.env.HYDRA_ROOT;
  // The router resolves KILL_FILE from HYDRA_ROOT at construction time; point it
  // at the throwaway dir so no test ever writes the real ~/hydra/.kill.
  process.env.HYDRA_ROOT = tmpDir;
});

after(async () => {
  if (savedHydraRoot === undefined) delete process.env.HYDRA_ROOT;
  else process.env.HYDRA_ROOT = savedHydraRoot;
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

describe("operational router — route registration (issue #3652)", () => {
  test("registers exactly the one POST /kill route", () => {
    const routes = routeTable(createOperationalRouter());
    assert.deepEqual(routes, ["POST /kill"]);
  });
});

describe("operational router — POST /kill behavior (issue #3652)", () => {
  test("writes an ISO-timestamp kill file at <HYDRA_ROOT>/.kill and returns killed:true", async () => {
    const router = createOperationalRouter();
    const handler = findHandler(router, "POST", "/kill");
    assert.ok(handler, "POST /kill handler should exist");

    const res = mockRes();
    await handler!(mockReq(), res);

    const expectedKillFile = join(tmpDir, ".kill");
    assert.equal(res._status, 200);
    assert.equal(res._body.killed, true);
    assert.equal(res._body.killFile, expectedKillFile);

    assert.ok(existsSync(expectedKillFile), "kill file should be written");
    const contents = await readFile(expectedKillFile, "utf8");
    // Body is `new Date().toISOString()` — a parseable ISO timestamp.
    assert.ok(
      !Number.isNaN(Date.parse(contents)),
      `kill file should hold an ISO timestamp; got ${JSON.stringify(contents)}`,
    );
  });
});
