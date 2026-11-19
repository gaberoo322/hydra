import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanSource, findingKey, neverThrowRatchet } from "../scripts/ci/never-throw-scan.ts";

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

  it("does not attribute an unguarded nested arrow body to the outer function", () => {
    // The nested arrow sits OUTSIDE any try/catch, so only the function
    // boundary check keeps its await/throw from being flagged on `f`.
    assert.deepEqual(
      kinds(`/** never throws */\nfunction f() { const h = async () => { await g(); throw new Error("x"); }; return h; }`),
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

describe("never-throw-scan advisory wiring", () => {
  it("stays advisory: wired only in advisory-checks and never scans the live tree", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const advisory = readFileSync(join(root, ".github/workflows/advisory-checks.yml"), "utf8");
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    assert.match(advisory, /if: always\(\)\n\s+run: npx tsx scripts\/ci\/never-throw-scan\.ts/);
    assert.equal(ci.includes("never-throw-scan"), false);
    const self = readFileSync(fileURLToPath(import.meta.url), "utf8");
    assert.equal(self.includes("scanTracked" + "Files("), false);
  });
});

describe("never-throw-scan baseline", () => {
  it("keys carry no line numbers", () => {
    const k = findingKey("a.ts", { kind: "unguarded-await", fnName: "f", text: "await g()" });
    assert.equal(k, "unguarded-await\ta.ts\tf\tawait g()");
  });

  it("is a counted ceiling ratchet that stays advisory", () => {
    const p = neverThrowRatchet.policy;
    assert.deepEqual([p.shape, p.polarity, p.enforcement], ["counted", "ceiling", "advisory"]);
  });

  it("verdict() reports a second identical finding as added", async () => {
    const dir = mkdtempSync(join(tmpdir(), "never-throw-"));
    try {
      const key = findingKey("a.ts", { kind: "unguarded-await", fnName: "f", text: "await g()" });
      writeFileSync(join(dir, "b.json"), JSON.stringify({ [key]: 1 }));
      const { defineRatchet } = await import("../scripts/ci/ratchet.ts");
      const r = defineRatchet({ ...neverThrowRatchet.policy, baseline: "b.json", measure: async () => [key, key] });
      const v = await r.verdict(dir);
      assert.deepEqual(v.added, [key]);
      assert.match(v.advice, /a\.ts \| f \| await g\(\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
