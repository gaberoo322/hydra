import test from "node:test";
import assert from "node:assert/strict";

import { parseEnvFile, maskValue, makeEnvAuthGuard } from "../src/api/config-io.ts";

test("parseEnvFile — splits key=value pairs and trims", () => {
  const rows = parseEnvFile("FOO=bar\nBAZ = qux");
  assert.deepEqual(rows, [
    { key: "FOO", value: "bar", line: "FOO=bar" },
    { key: "BAZ", value: "qux", line: "BAZ = qux" },
  ]);
});

test("parseEnvFile — skips blank, comment, and non-assignment lines", () => {
  const rows = parseEnvFile("\n# a comment\nFOO=bar\njust-a-word\n");
  assert.deepEqual(rows.map(r => r.key), ["FOO"]);
});

test("parseEnvFile — preserves embedded '=' signs after the first", () => {
  const rows = parseEnvFile("TOKEN=a=b=c");
  assert.equal(rows[0].value, "a=b=c");
});

test("parseEnvFile — strips a single layer of matching surrounding quotes", () => {
  assert.equal(parseEnvFile('A="hello world"')[0].value, "hello world");
  assert.equal(parseEnvFile("B='single'")[0].value, "single");
  // Mismatched quotes are NOT stripped.
  assert.equal(parseEnvFile("C=\"unclosed")[0].value, '"unclosed');
});

test("maskValue — values of length <= 6 are all bullets", () => {
  assert.equal(maskValue(""), "••••••");
  assert.equal(maskValue("abc"), "••••••");
  assert.equal(maskValue("abcdef"), "••••••");
});

test("maskValue — longer values keep a 3-char prefix and suffix", () => {
  assert.equal(maskValue("abcdefg"), "abc•defg".slice(0, 3) + "•" + "efg");
  // Explicit: 7-char "abcdefg" -> "abc" + 1 bullet + "efg".
  assert.equal(maskValue("abcdefg"), "abc•efg");
  // Bullet run is capped at 20.
  const long = "x".repeat(100);
  const masked = maskValue(long);
  assert.equal(masked.startsWith("xxx"), true);
  assert.equal(masked.endsWith("xxx"), true);
  assert.equal((masked.match(/•/g) || []).length, 20);
});

// --- makeEnvAuthGuard — stateless guard, no Express router mount required. ---

function fakeReqRes(authHeader?: string) {
  const req: any = { headers: authHeader ? { authorization: authHeader } : {} };
  const res: any = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  return { req, res };
}

test("makeEnvAuthGuard — calls next() on a matching Bearer token", () => {
  const guard = makeEnvAuthGuard("s3cret");
  const { req, res } = fakeReqRes("Bearer s3cret");
  let called = false;
  guard(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(res.statusCode, 0);
});

test("makeEnvAuthGuard — 401 on a mismatched token", () => {
  const guard = makeEnvAuthGuard("s3cret");
  const { req, res } = fakeReqRes("Bearer wrong");
  let called = false;
  guard(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: "Unauthorized" });
});

test("makeEnvAuthGuard — 401 when no secret is configured (deny by default)", () => {
  const guard = makeEnvAuthGuard("");
  const { req, res } = fakeReqRes("Bearer anything");
  let called = false;
  guard(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 401);
});

test("makeEnvAuthGuard — 401 on a missing Authorization header", () => {
  const guard = makeEnvAuthGuard("s3cret");
  const { req, res } = fakeReqRes();
  let called = false;
  guard(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 401);
});
