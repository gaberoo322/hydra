import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  scanSource,
  diffKeys,
  findingKey,
  formatFailure,
} from "../scripts/ci/never-throw-scan.ts";

function kinds(src: string): string[] {
  const r = scanSource("x.ts", src);
  assert.equal(r.ok, true);
  return r.ok ? r.findings.map((f) => f.kind) : [];
}

describe("never-throw-scan scanSource", () => {
  it("ignores a file header comment before an import", () => {
    assert.deepEqual(
      kinds(`/** never throws */\nimport x from "y";\nasync function f() { await x(); }`),
      [],
    );
  });

  it("flags an unguarded await in a claiming function", () => {
    assert.deepEqual(kinds(`/** never throws */\nexport async function f() { await g(); }`), [
      "unguarded-await",
    ]);
  });

  it("does not flag awaits inside try/catch", () => {
    assert.deepEqual(
      kinds(`/** never raises */\nasync function f() { try { await g(); } catch (e) { return 1; } }`),
      [],
    );
  });

  it("treats try/finally without catch as unguarded", () => {
    assert.deepEqual(
      kinds(`/** never throws */\nasync function f() { try { await g(); } finally { await h(); } }`),
      ["unguarded-await", "unguarded-await"],
    );
  });

  it("flags awaits and throws in a catch body", () => {
    assert.deepEqual(
      kinds(`/** never throws */\nasync function f() { try { g(); } catch (e) { await h(); throw e; } }`),
      ["unguarded-await", "unguarded-throw"],
    );
  });

  it("flags known-thrower calls incl. member form", () => {
    assert.deepEqual(
      kinds(`/** returns a result object */\nfunction f(s: string) { JSON.parse(s); fs.readFileSync(s); }`),
      ["unguarded-call", "unguarded-call"],
    );
  });

  it("does not attribute nested function bodies to the outer function", () => {
    assert.deepEqual(
      kinds(`/** never throws */\nfunction f() { try { return async () => { await g(); }; } catch { return null; } }`),
      [],
    );
  });

  it("treats await x().catch() as guarded", () => {
    assert.deepEqual(kinds(`/** never throws */\nasync function f() { await g().catch(() => 1); }`), []);
  });

  it("attaches comments on export const arrows and class members", () => {
    assert.deepEqual(kinds(`/** never throws */\nexport const f = async () => { await g(); };`), [
      "unguarded-await",
    ]);
    assert.deepEqual(kinds(`class K { /** never raises */ async m() { await g(); } }`), [
      "unguarded-await",
    ]);
  });

  it("does not scan functions without their own claim", () => {
    assert.deepEqual(kinds(`async function f() { await g(); throw new Error("x"); }`), []);
  });

  it("returns ok:false rather than throwing on a crash input", () => {
    const r = scanSource("x.ts", undefined as unknown as string);
    assert.equal(r.ok, false);
  });
});

describe("never-throw-scan baseline helpers", () => {
  it("keys carry no line numbers", () => {
    const k = findingKey("a.ts", { kind: "unguarded-await", fnName: "f", text: "await g()" });
    assert.equal(k, "unguarded-await\ta.ts\tf\tawait g()");
  });

  it("diffKeys reports added and removed", () => {
    assert.deepEqual(diffKeys(["a", "b"], ["b", "c"]), { added: ["a"], removed: ["c"] });
  });

  it("formatFailure names the fix", () => {
    const out = formatFailure(["unguarded-await\ta.ts\tf\tawait g()"]);
    assert.match(out, /a\.ts f\(\): unguarded-await/);
    assert.match(out, /no annotation escape/);
  });
});
