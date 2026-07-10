import test from "node:test";
import assert from "node:assert/strict";

import {
  parseEnvFile,
  maskValue,
  makeEnvAuthGuard,
  CONFIG_SECTIONS,
  listConfigSection,
  readConfigFile,
  writeConfigFile,
  readEnvFile,
  upsertEnvVar,
  deleteEnvVar,
  type ConfigFsDeps,
} from "../src/api/config-io.ts";

/** A never-touch-disk fs seam: canned readdir/readFile + a captured writeFile. */
function fakeFs(opts: {
  files?: Record<string, string>;
  dirs?: Record<string, string[]>;
} = {}): ConfigFsDeps & { written: Record<string, string> } {
  const files = opts.files ?? {};
  const dirs = opts.dirs ?? {};
  const written: Record<string, string> = {};
  function enoent(path: string): never {
    const err: any = new Error(`ENOENT: ${path}`);
    err.code = "ENOENT";
    throw err;
  }
  return {
    written,
    readdir: async (path: string) => (path in dirs ? dirs[path] : enoent(path)),
    readFile: async (path: string) => (path in files ? files[path] : enoent(path)),
    writeFile: async (path: string, data: string) => { written[path] = data; },
  };
}

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

// --- Config-section registry + file I/O (issue #3104) ---

test("CONFIG_SECTIONS — the four registered sections map to {dir, ext}", () => {
  assert.deepEqual(Object.keys(CONFIG_SECTIONS).sort(), ["agents", "direction", "feedback", "research"]);
  assert.deepEqual(CONFIG_SECTIONS.agents, { dir: "agents", ext: ".md" });
});

test("listConfigSection — filters by extension and strips it", async () => {
  const fs = fakeFs({ dirs: { "/cfg/agents": ["a.md", "b.md", "notes.txt", ".keep"] } });
  const out = await listConfigSection("/cfg", CONFIG_SECTIONS.agents, fs);
  assert.deepEqual(out, ["a", "b"]);
});

test("listConfigSection — a missing directory (ENOENT) yields []", async () => {
  const fs = fakeFs({ dirs: {} });
  assert.deepEqual(await listConfigSection("/cfg", CONFIG_SECTIONS.feedback, fs), []);
});

test("listConfigSection — a non-ENOENT readdir error propagates", async () => {
  const fs = fakeFs();
  fs.readdir = async () => { const e: any = new Error("EACCES"); e.code = "EACCES"; throw e; };
  await assert.rejects(() => listConfigSection("/cfg", CONFIG_SECTIONS.agents, fs), /EACCES/);
});

test("readConfigFile — returns file contents on hit", async () => {
  const fs = fakeFs({ files: { "/cfg/direction/vision.md": "# Vision" } });
  assert.equal(await readConfigFile("/cfg", CONFIG_SECTIONS.direction, "vision", fs), "# Vision");
});

test("readConfigFile — a missing file (ENOENT) returns null", async () => {
  const fs = fakeFs({ files: {} });
  assert.equal(await readConfigFile("/cfg", CONFIG_SECTIONS.direction, "absent", fs), null);
});

test("writeConfigFile — writes to the joined path and returns it", async () => {
  const fs = fakeFs();
  const path = await writeConfigFile("/cfg", CONFIG_SECTIONS.research, "note", "body", fs);
  assert.equal(path, "/cfg/research/note.md");
  assert.equal(fs.written["/cfg/research/note.md"], "body");
});

// --- Env-file I/O (issue #3104) ---

test("readEnvFile — returns raw contents on hit", async () => {
  const fs = fakeFs({ files: { "/p/.env": "FOO=bar" } });
  assert.equal(await readEnvFile("/p/.env", fs), "FOO=bar");
});

test("readEnvFile — a missing file (ENOENT) returns empty string", async () => {
  const fs = fakeFs({ files: {} });
  assert.equal(await readEnvFile("/p/.env", fs), "");
});

test("upsertEnvVar — replaces an existing KEY= line in place (updated)", async () => {
  const fs = fakeFs({ files: { "/p/.env": "A=1\nFOO=old\nB=2" } });
  const action = await upsertEnvVar("/p/.env", "FOO", "new", fs);
  assert.equal(action, "updated");
  assert.equal(fs.written["/p/.env"], "A=1\nFOO=new\nB=2");
});

test("upsertEnvVar — matches a 'KEY =' (spaced) assignment line", async () => {
  const fs = fakeFs({ files: { "/p/.env": "FOO = old" } });
  const action = await upsertEnvVar("/p/.env", "FOO", "new", fs);
  assert.equal(action, "updated");
  assert.equal(fs.written["/p/.env"], "FOO=new");
});

test("upsertEnvVar — appends with a blank-line separator when the file is non-empty (added)", async () => {
  const fs = fakeFs({ files: { "/p/.env": "A=1" } });
  const action = await upsertEnvVar("/p/.env", "NEW", "x", fs);
  assert.equal(action, "added");
  assert.equal(fs.written["/p/.env"], "A=1\n\nNEW=x");
});

test("upsertEnvVar — a missing file initializes as empty then appends", async () => {
  const fs = fakeFs({ files: {} });
  const action = await upsertEnvVar("/p/.env", "NEW", "x", fs);
  assert.equal(action, "added");
  // Empty raw splits to [""], which is a trailing "" so no extra blank added.
  assert.equal(fs.written["/p/.env"], "\nNEW=x");
});

test("upsertEnvVar — quotes and escapes values containing space/hash/quote/newline", async () => {
  const fs = fakeFs({ files: { "/p/.env": "" } });
  await upsertEnvVar("/p/.env", "K", 'a "b" #c', fs);
  assert.equal(fs.written["/p/.env"], '\nK="a \\"b\\" #c"');
});

test("upsertEnvVar — a plain value is written unquoted", async () => {
  const fs = fakeFs({ files: { "/p/.env": "" } });
  await upsertEnvVar("/p/.env", "K", "plainvalue", fs);
  assert.equal(fs.written["/p/.env"], "\nK=plainvalue");
});

test("deleteEnvVar — removes a matching line and reports true", async () => {
  const fs = fakeFs({ files: { "/p/.env": "A=1\nFOO=x\nB=2" } });
  const removed = await deleteEnvVar("/p/.env", "FOO", fs);
  assert.equal(removed, true);
  assert.equal(fs.written["/p/.env"], "A=1\nB=2");
});

test("deleteEnvVar — a spaced 'KEY =' line is also removed", async () => {
  const fs = fakeFs({ files: { "/p/.env": "FOO = x\nB=2" } });
  assert.equal(await deleteEnvVar("/p/.env", "FOO", fs), true);
  assert.equal(fs.written["/p/.env"], "B=2");
});

test("deleteEnvVar — no matching line returns false and does not write", async () => {
  const fs = fakeFs({ files: { "/p/.env": "A=1\nB=2" } });
  assert.equal(await deleteEnvVar("/p/.env", "MISSING", fs), false);
  assert.equal("/p/.env" in fs.written, false);
});

test("deleteEnvVar — a missing file propagates ENOENT (byte-preserves the inline 500 path)", async () => {
  const fs = fakeFs({ files: {} });
  await assert.rejects(() => deleteEnvVar("/p/.env", "FOO", fs), /ENOENT/);
});
