import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQaVerdictRunner } from "../src/autopilot/turn-snapshot/host-port.ts";

const dir = mkdtempSync(join(tmpdir(), "guard-stub-"));
function stub(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}
function runner(script: string, timeoutMs?: number) {
  return createQaVerdictRunner({ guardFile: process.execPath, guardArgs: [script], guardTimeoutMs: timeoutMs });
}
const json = '{"verdict":"FAIL"}';

describe("createQaVerdictRunner.runQaMergeGuard exit-code contract (#5253)", () => {
  test("exit 0 parses stdout", async () => {
    const s = stub("ok.mjs", `console.log('${json}'); process.exit(0);`);
    assert.deepEqual(await runner(s).runQaMergeGuard!(7), { verdict: "FAIL" });
  });
  test("exit 1 (guard DENY == FAIL case) still parses stdout", async () => {
    const s = stub("deny.mjs", `console.log('${json}'); process.exit(1);`);
    assert.deepEqual(await runner(s).runQaMergeGuard!(7), { verdict: "FAIL" });
  });
  test("exit 2 yields null", async () => {
    const s = stub("two.mjs", `console.log('${json}'); process.exit(2);`);
    assert.equal(await runner(s).runQaMergeGuard!(7), null);
  });
  test("non-JSON stdout yields null", async () => {
    const s = stub("bad.mjs", `console.log('nope'); process.exit(0);`);
    assert.equal(await runner(s).runQaMergeGuard!(7), null);
  });
  test("timeout yields null", async () => {
    const s = stub("slow.mjs", `setTimeout(() => {}, 10000);`);
    assert.equal(await runner(s, 200).runQaMergeGuard!(7), null);
  });
  test("ENOENT yields null", async () => {
    const r = createQaVerdictRunner({ guardFile: join(dir, "does-not-exist"), guardArgs: [] });
    assert.equal(await r.runQaMergeGuard!(7), null);
  });
});
