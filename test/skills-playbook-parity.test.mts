import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { renderPlaybook } from "../src/skills/playbook.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLAYBOOKS = join(REPO_ROOT, "docs", "operator-playbooks");

function collectSources(): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else map.set(relative(PLAYBOOKS, full).split(sep).join("/"), readFileSync(full, "utf-8"));
    }
  };
  walk(join(PLAYBOOKS, "_fragments"));
  walk(join(PLAYBOOKS, "_vendor"));
  return map;
}

function firstDiff(a: string, b: string): string {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  const ctx = (s: string) => JSON.stringify(s.slice(Math.max(0, i - 40), i + 40));
  return `first differing offset ${i}: core=${ctx(a)} script=${ctx(b)}`;
}

describe("skills playbook core: live parity with sync-skills.sh", () => {
  let scratch = "";
  let stderr = "";
  const rendered = new Map<string, string>();
  const skips: string[] = [];
  const perPlaybook: Array<{ file: string; name: string }> = [];

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "skills-parity-"));
    const res = spawnSync("bash", [join(REPO_ROOT, "scripts", "sync-skills.sh")], {
      env: { ...process.env, CLAUDE_SKILLS_DIR: scratch },
      encoding: "utf-8",
      cwd: REPO_ROOT,
    });
    stderr = res.stderr ?? "";
    assert.equal(res.status, 0, `sync-skills.sh exited ${res.status}: ${stderr}`);

    const sources = collectSources();
    for (const file of readdirSync(PLAYBOOKS)) {
      if (!file.endsWith(".md") || file === "README.md") continue;
      const text = readFileSync(join(PLAYBOOKS, file), "utf-8");
      const r = renderPlaybook({ fileName: file, text, playbooksDir: PLAYBOOKS, sources });
      if (r.kind === "skill") {
        rendered.set(r.name, r.content);
        perPlaybook.push({ file, name: r.name });
      } else if (r.kind === "skip") {
        skips.push(file.replace(/\.md$/, ""));
      } else {
        assert.fail(`${file}: core errored ${r.code}: ${r.message}`);
      }
    }
  });

  after(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  test("every live playbook renders byte-identical SKILL.md", () => {
    assert.ok(perPlaybook.length > 0, "no playbooks rendered");
    for (const { file, name } of perPlaybook) {
      const target = join(scratch, name, "SKILL.md");
      assert.ok(existsSync(target), `${file}: script wrote no ${name}/SKILL.md`);
      const script = readFileSync(target, "utf-8");
      const core = rendered.get(name) as string;
      assert.ok(core === script, `${file}: core diverges from sync-skills.sh — ${firstDiff(core, script)}`);
    }
  });

  test("the set of generated skills equals the core-rendered set", () => {
    const onDisk = readdirSync(scratch)
      .filter((d) => existsSync(join(scratch, d, "SKILL.md")))
      .sort();
    assert.deepEqual(onDisk, [...rendered.keys()].sort());
  });

  test("core skips match the script's skip stderr lines", () => {
    const scriptSkips = [...stderr.matchAll(/^skip (\S+) /gm)].map((m) => m[1]).sort();
    assert.deepEqual([...skips].sort(), scriptSkips);
  });
});
