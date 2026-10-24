import test from "node:test";
import assert from "node:assert/strict";

import {
  CONFIG_SECTIONS,
  readConfigFile,
  writeConfigFile,
  type ConfigFsDeps,
} from "../src/api/config-io.ts";

/** A never-touch-disk fs seam: canned readFile + a captured writeFile. */
function fakeFs(opts: {
  files?: Record<string, string>;
} = {}): ConfigFsDeps & { written: Record<string, string> } {
  const files = opts.files ?? {};
  const written: Record<string, string> = {};
  function enoent(path: string): never {
    const err: any = new Error(`ENOENT: ${path}`);
    err.code = "ENOENT";
    throw err;
  }
  return {
    written,
    readFile: async (path: string) => (path in files ? files[path] : enoent(path)),
    writeFile: async (path: string, data: string) => { written[path] = data; },
  };
}

// --- Config-section registry + file I/O (issue #3104) ---

test("CONFIG_SECTIONS — the four registered sections map to {dir, ext}", () => {
  assert.deepEqual(Object.keys(CONFIG_SECTIONS).sort(), ["agents", "direction", "feedback", "research"]);
  assert.deepEqual(CONFIG_SECTIONS.agents, { dir: "agents", ext: ".md" });
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
