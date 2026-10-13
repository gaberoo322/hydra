import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { planCorpus, type CorpusInput } from "../src/skills/plan.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = "/pb";

function pb(name: string, extraFm = "", body = "Body.\n", desc = "A skill"): string {
  return `---\nname: ${name}\ndescription: ${desc}\n${extraFm}---\n${body}`;
}

function corpus(
  playbooks: Array<{ fileName: string; text: string }>,
  sources: Array<[string, string]> = [],
): CorpusInput {
  return { playbooksDir: DIR, playbooks, sources: new Map(sources) };
}

describe("planCorpus (pure whole-corpus plan)", () => {
  test("emits a SKILL.md write at a skills-dir-relative path", () => {
    const plan = planCorpus(corpus([{ fileName: "a.md", text: pb("a") }]));
    assert.deepEqual(plan.errors, []);
    assert.deepEqual(plan.writes.map((w) => w.path), ["a/SKILL.md"]);
    assert.match(plan.writes[0].content, /^---\nname: a\n/);
  });

  test("settings.json is copied verbatim only when present, keyed by frontmatter name", () => {
    const withSettings = planCorpus(
      corpus([{ fileName: "file.md", text: pb("real") }], [["real.settings.json", '{"hooks":{}}\n']]),
    );
    assert.deepEqual(withSettings.writes.map((w) => w.path), ["real/SKILL.md", "real/.claude/settings.json"]);
    assert.equal(withSettings.writes[1].content, '{"hooks":{}}\n');
    const without = planCorpus(corpus([{ fileName: "file.md", text: pb("real") }], [["file.settings.json", "{}"]]));
    assert.deepEqual(without.writes.map((w) => w.path), ["real/SKILL.md"]);
  });

  test("reference file: {{SKILL_NAME}} substituted, trailing newlines stripped, basename used", () => {
    const plan = planCorpus(
      corpus(
        [{ fileName: "a.md", text: pb("a", "reference_files:\n  - _fragments/flow.md\n") }],
        [["_fragments/flow.md", "tag {{SKILL_NAME}} and {{SKILL_NAME}}\n\n"]],
      ),
    );
    assert.deepEqual(plan.errors, []);
    assert.deepEqual(plan.writes.map((w) => w.path), ["a/SKILL.md", "a/flow.md"]);
    assert.equal(plan.writes[1].content, "tag a and a");
  });

  test("scalar reference_files is one entry", () => {
    const plan = planCorpus(
      corpus([{ fileName: "a.md", text: pb("a", "reference_files: _fragments/x.md\n") }], [["_fragments/x.md", "x\n"]]),
    );
    assert.deepEqual(plan.writes.map((w) => w.path), ["a/SKILL.md", "a/x.md"]);
  });

  test("both skip reasons surface in skips, with no writes", () => {
    const plan = planCorpus(
      corpus([
        { fileName: "nofm.md", text: "just text\n" },
        { fileName: "noname.md", text: "---\ndescription: d\n---\nbody\n" },
      ]),
    );
    assert.deepEqual(plan.writes, []);
    assert.deepEqual(plan.skips, [
      { playbook: "nofm", reason: "no-frontmatter" },
      { playbook: "noname", reason: "missing-name-or-description" },
    ]);
  });

  test("errors aggregate across two independently broken playbooks", () => {
    const plan = planCorpus(
      corpus([
        { fileName: "bad1.md", text: pb("bad1", "", "@include _fragments/missing1.md\n") },
        { fileName: "bad2.md", text: pb("bad2", "", "@include _fragments/missing2.md\n") },
        { fileName: "good.md", text: pb("good") },
      ]),
    );
    assert.deepEqual(plan.errors.map((e) => e.playbook), ["bad1", "bad2"]);
    assert.match(plan.errors[0].message, /missing1\.md/);
    assert.match(plan.errors[1].message, /missing2\.md/);
    assert.deepEqual(plan.writes.map((w) => w.path), ["good/SKILL.md"]);
  });

  test("every bad reference of one playbook is reported, escape before missing", () => {
    const plan = planCorpus(
      corpus([
        {
          fileName: "a.md",
          text: pb("a", "reference_files:\n  - ../../etc/passwd\n  - _fragments/nope.md\n  - _fragments/ok.md\n"),
        },
      ], [["_fragments/ok.md", "ok"]]),
    );
    assert.deepEqual(plan.errors.map((e) => e.code), ["reference-escape", "reference-unresolved"]);
    assert.match(plan.errors[0].message, /escapes operator-playbooks\/: \.\.\/\.\.\/etc\/passwd \(in a\)/);
    assert.match(plan.errors[1].message, /unresolved reference_files _fragments\/nope\.md \(in a\): no such fragment at \/pb\/_fragments\/nope\.md/);
    assert.deepEqual(plan.writes, []);
  });

  test("duplicate write paths are a fail-loud error naming both playbooks", () => {
    const plan = planCorpus(
      corpus([
        { fileName: "one.md", text: pb("same") },
        { fileName: "two.md", text: pb("same") },
      ]),
    );
    assert.equal(plan.errors.length, 1);
    assert.equal(plan.errors[0].code, "duplicate-write-path");
    assert.match(plan.errors[0].message, /same\/SKILL\.md/);
    assert.match(plan.errors[0].message, /one/);
    assert.match(plan.errors[0].message, /two/);
  });

  test("deterministic: sorted playbook order, deep-equal across calls", () => {
    const input = corpus([
      { fileName: "z.md", text: pb("z") },
      { fileName: "a.md", text: pb("a") },
    ]);
    const first = planCorpus(input);
    assert.deepEqual(first.writes.map((w) => w.path), ["a/SKILL.md", "z/SKILL.md"]);
    assert.deepEqual(planCorpus(input), first);
  });
});

describe("skills plan CLI (spawned)", () => {
  let root = "";
  const cli = join(REPO_ROOT, "src", "skills", "cli.ts");
  const run = (args: string[]) =>
    spawnSync("node", ["--experimental-strip-types", cli, ...args], { encoding: "utf-8" });

  before(() => {
    root = mkdtempSync(join(tmpdir(), "skills-cli-"));
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("exit 1 lists every error on stderr and prints nothing on stdout", () => {
    const d = join(root, "bad");
    mkdirSync(d);
    writeFileSync(join(d, "b1.md"), pb("b1", "", "@include _fragments/m1.md\n"));
    writeFileSync(join(d, "b2.md"), pb("b2", "", "@include _fragments/m2.md\n"));
    const res = run(["--playbooks-dir", d]);
    assert.equal(res.status, 1);
    assert.equal(res.stdout, "");
    assert.match(res.stderr, /m1\.md/);
    assert.match(res.stderr, /m2\.md/);
  });

  test("exit 0 prints one JSON document {writes, skips} with no errors key", () => {
    const d = join(root, "good");
    mkdirSync(d);
    writeFileSync(join(d, "g.md"), pb("g"));
    writeFileSync(join(d, "README.md"), "not a playbook\n");
    writeFileSync(join(d, "nofm.md"), "plain\n");
    const res = run(["--playbooks-dir", d]);
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.deepEqual(Object.keys(out).sort(), ["skips", "writes"]);
    assert.deepEqual(out.writes.map((w: { path: string }) => w.path), ["g/SKILL.md"]);
    assert.deepEqual(out.skips, [{ playbook: "nofm", reason: "no-frontmatter" }]);
  });

  test("usage error and unreadable dir exit 2 with stderr", () => {
    const missing = run([]);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /--playbooks-dir is required/);
    const bad = run(["--playbooks-dir", join(root, "does-not-exist")]);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /cannot read playbooks dir/);
  });
});
