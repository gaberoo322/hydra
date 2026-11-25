import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isEntrypoint } from "../scripts/lib/entrypoint.mjs";
import { isEntrypoint as qaIsEntrypoint } from "../scripts/qa/_lib.ts";

const REPO = resolve(import.meta.dirname, "..");
const MODULE_URL = pathToFileURL(join(REPO, "scripts/lib/entrypoint.mjs")).href;

test("isEntrypoint is true for a script run from a directory with a space and a percent sign", () => {
  const dir = mkdtempSync(join(tmpdir(), "entry point %41-"));
  try {
    const probe = join(dir, "probe.mjs");
    writeFileSync(
      probe,
      `import { isEntrypoint } from ${JSON.stringify(MODULE_URL)};\nconsole.log(String(isEntrypoint(import.meta.url)));\n`,
    );
    const r = spawnSync(process.execPath, [probe], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "true");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isEntrypoint is false when the module is imported rather than run", () => {
  const dir = mkdtempSync(join(tmpdir(), "entry-import-"));
  try {
    writeFileSync(
      join(dir, "child.mjs"),
      `import { isEntrypoint } from ${JSON.stringify(MODULE_URL)};\nexport const v = isEntrypoint(import.meta.url);\n`,
    );
    const main = join(dir, "main.mjs");
    writeFileSync(main, `import { v } from "./child.mjs";\nconsole.log(String(v));\n`);
    const r = spawnSync(process.execPath, [main], { encoding: "utf8" });
    assert.equal(r.stdout.trim(), "false");
    assert.equal(isEntrypoint(MODULE_URL), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isEntrypoint is false when argv[1] is undefined", () => {
  const code = `import { isEntrypoint } from ${JSON.stringify(MODULE_URL)};console.log(String(isEntrypoint("file:///x.mjs")));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
  assert.equal(r.stdout.trim(), "false");
});

test("scripts/qa/_lib.ts re-exports the same predicate semantics", () => {
  assert.equal(qaIsEntrypoint(MODULE_URL), false);
  assert.equal(qaIsEntrypoint(import.meta.url), isEntrypoint(import.meta.url));
});

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|mts|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

test("no script under scripts/ hand-rolls an isMain guard or the template-form entrypoint check", () => {
  const offenders: string[] = [];
  for (const f of walk(join(REPO, "scripts"))) {
    if (/const isMain\b/.test(readFileSync(f, "utf8"))) offenders.push(f);
  }
  assert.deepEqual(offenders, []);
  const lib = readFileSync(join(REPO, "scripts/qa/_lib.ts"), "utf8");
  assert.ok(!lib.includes("file://${"), "_lib.ts must not carry the template-form body");
});
