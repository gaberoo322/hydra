/**
 * test/backfill-dedup-baseline.test.mts — pins scripts/ci/backfill-dedup-baseline.sh,
 * the one place the shared backfill dedup baseline is built. A fake `gh` on PATH
 * records its argv so the explicit --limit, the server-side closed window and
 * the fail-loud exit are asserted against the real script.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.resolve("scripts/ci/backfill-dedup-baseline.sh");

function fakeGh(body: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "fake-gh-"));
  const log = path.join(dir, "argv.log");
  writeFileSync(path.join(dir, "gh"), `#!/usr/bin/env bash\necho "$*" >> "${log}"\n${body}\n`);
  chmodSync(path.join(dir, "gh"), 0o755);
  return { dir, log };
}

describe("backfill-dedup-baseline.sh", () => {
  test("passes an explicit --limit and a closed:>= window on the gh calls, prints titles newline-separated", () => {
    const { dir, log } = fakeGh(
      'if [[ "$*" == *"--state open"* ]]; then printf "open one\\nopen two\\n"; else printf "closed one\\n"; fi',
    );
    const out = execFileSync("bash", [SCRIPT], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      encoding: "utf8",
    });
    assert.equal(out, "open one\nopen two\nclosed one\n");
    const calls = readFileSync(log, "utf8").trim().split("\n");
    assert.equal(calls.length, 2);
    for (const c of calls) assert.match(c, /--limit 1000\b/);
    assert.match(calls[0], /--state open/);
    assert.match(calls[1], /--state closed/);
    assert.match(calls[1], /--search closed:>=\d{4}-\d{2}-\d{2}/);
  });

  test("exits non-zero with empty stdout when gh fails (never a silently-empty baseline)", () => {
    const { dir } = fakeGh("exit 1");
    const res = spawnSync("bash", [SCRIPT], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      encoding: "utf8",
    });
    assert.notEqual(res.status, 0);
    assert.equal(res.stdout, "");
  });
});
