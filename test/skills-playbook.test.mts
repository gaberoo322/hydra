import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  parseFrontmatter,
  resolveIncludes,
  composeBase,
  renderSkillMd,
  renderPlaybook,
} from "../src/skills/playbook.ts";

const DIR = "/repo/docs/operator-playbooks";

function sources(entries: Record<string, string>): ReadonlyMap<string, string> {
  return new Map(Object.entries(entries));
}

function pb(fmLines: string[], body: string): string {
  return `---\n${fmLines.join("\n")}\n---\n${body}`;
}

type Fm = Map<string, string | boolean | string[]>;

describe("skills playbook: parseFrontmatter", () => {
  test("returns null without frontmatter", () => {
    assert.equal(parseFrontmatter("# hi\n"), null);
  });

  test("scalars, quotes, booleans, inline lists, comments, last-wins", () => {
    const p = parseFrontmatter(
      pb(
        [
          "# a comment",
          "name: demo",
          'description: "quoted: value"',
          "flag: TRUE",
          "off: false",
          "tools: [\"a\", 'b', c, ]",
          "no colon line",
          "name: second",
        ],
        "body\n",
      ),
    );
    assert.ok(p);
    assert.equal(p.fm.get("name"), "second");
    assert.equal(p.fm.get("description"), "quoted: value");
    assert.equal(p.fm.get("flag"), true);
    assert.equal(p.fm.get("off"), false);
    assert.deepEqual(p.fm.get("tools"), ["a", "b", "c"]);
    assert.equal(p.body, "body\n");
  });

  test("block sequences and empty-valued keys without items", () => {
    const p = parseFrontmatter(
      pb(["supersedes:", '  - "## A: b, c"', "  - plain", "empty:", "next: x"], "b\n"),
    );
    assert.ok(p);
    assert.deepEqual(p.fm.get("supersedes"), ["## A: b, c", "plain"]);
    assert.equal(p.fm.get("empty"), "");
    assert.equal(p.fm.get("next"), "x");
  });

  test("__proto__ key is an ordinary entry", () => {
    const p = parseFrontmatter(pb(["__proto__: x"], "b\n"));
    assert.ok(p);
    assert.equal(p.fm.get("__proto__"), "x");
  });
});

describe("skills playbook: resolveIncludes", () => {
  const ctx = (src: ReadonlyMap<string, string>) => ({
    fileName: "demo.md",
    playbooksDir: DIR,
    sources: src,
    skillName: "demo",
  });

  test("replaces include line, strips one trailing newline, substitutes name", () => {
    const out = resolveIncludes(
      "a\n  @include _fragments/x.md  \nb",
      ctx(sources({ "_fragments/x.md": "[{{SKILL_NAME}}] hi\n\n" })),
    );
    assert.equal(out, "a\n[demo] hi\n\nb");
  });

  test("escape is checked before missing", () => {
    const out = resolveIncludes("@include ../x.md", ctx(sources({})));
    assert.equal((out as { code: string }).code, "include-escape");
  });

  test("absolute in-dir include resolves (os.path.join parity)", () => {
    const out = resolveIncludes(
      `@include ${DIR}/_fragments/x.md`,
      ctx(sources({ "_fragments/x.md": "hi" })),
    );
    assert.equal(out, "hi");
  });

  test("absolute outside include is include-escape, not unresolved", () => {
    const out = resolveIncludes("@include /etc/x", ctx(sources({})));
    assert.equal((out as { code: string }).code, "include-escape");
  });

  test("missing fragment fails loud with the abs path", () => {
    const out = resolveIncludes("@include _fragments/nope.md", ctx(sources({})));
    assert.equal((out as { code: string }).code, "include-unresolved");
    assert.match(
      (out as { message: string }).message,
      /no such fragment at \/repo\/docs\/operator-playbooks\/_fragments\/nope\.md/,
    );
  });

  test("nested include in a fragment is an error", () => {
    const out = resolveIncludes(
      "@include _fragments/x.md",
      ctx(sources({ "_fragments/x.md": "ok\n@include _fragments/y.md\n" })),
    );
    assert.equal((out as { code: string }).code, "include-nested");
  });
});

describe("skills playbook: composeBase", () => {
  const BASE = "---\nname: base\n---\nintro\n\n## Keep\nk\n\n## Drop\nd\n### sub\ns\n\n## After\na\n\n\n";
  const ctx = {
    fileName: "demo.md",
    playbooksDir: DIR,
    sources: sources({ "_vendor/base.md": BASE }),
    skillName: "demo",
  };

  test("plain compose joins base, separator, overlay heading", () => {
    const out = composeBase("overlay\n", new Map(), "_vendor/base.md", ctx);
    assert.equal(
      out,
      "intro\n\n## Keep\nk\n\n## Drop\nd\n### sub\ns\n\n## After\na\n\n---\n\n## Hydra AFK overlay (demo)\n\noverlay\n",
    );
  });

  test("supersedes excises through nested deeper headings", () => {
    const fm: Fm = new Map([["supersedes", ["## Drop"]]]);
    const out = composeBase("o", fm, "_vendor/base.md", ctx) as string;
    assert.match(
      out,
      /<!-- superseded by the demo overlay: '## Drop' excised at compose time \(issue #3990\) -->\n\n## After/,
    );
    assert.ok(!out.includes("### sub"));
  });

  test("supersedes errors: unresolved, ambiguous, repr quoting", () => {
    const un = composeBase("o", new Map([["supersedes", ["Nope's"]]]) as Fm, "_vendor/base.md", ctx) as {
      code: string;
      message: string;
    };
    assert.equal(un.code, "supersedes-unresolved");
    assert.match(un.message, /"Nope's"/);
    const dup = composeBase("o", new Map([["supersedes", ["Twice"]]]) as Fm, "_vendor/dup.md", {
      ...ctx,
      sources: sources({ "_vendor/dup.md": "---\nn: x\n---\n## Twice\na\n## Twice\nb\n" }),
    }) as { code: string; message: string };
    assert.equal(dup.code, "supersedes-ambiguous");
    assert.match(dup.message, /at lines 1, 3/);
  });

  test("seam hoists preface ahead of the base", () => {
    const out = composeBase(
      "pre\n<!-- compose-seam-supersede -->\n\nrest",
      new Map(),
      "_vendor/base.md",
      ctx,
    ) as string;
    assert.ok(out.startsWith("pre\n\n---\n\nintro"));
    assert.ok(out.endsWith("## Hydra AFK overlay (demo)\n\nrest"));
  });

  test("base escape, missing, and no-frontmatter", () => {
    assert.equal((composeBase("o", new Map(), "../x.md", ctx) as { code: string }).code, "compose-base-escape");
    assert.equal(
      (composeBase("o", new Map(), "_vendor/zz.md", ctx) as { code: string }).code,
      "compose-base-unresolved",
    );
    const bad = composeBase("o", new Map(), "_vendor/bad.md", {
      ...ctx,
      sources: sources({ "_vendor/bad.md": "no fm" }),
    });
    assert.equal((bad as { code: string }).code, "compose-base-no-frontmatter");
  });
});

describe("skills playbook: renderSkillMd", () => {
  test("full frontmatter projection with python str semantics", () => {
    const fm: Fm = new Map<string, string | boolean | string[]>([
      ["name", "demo"],
      ["description", "d"],
      ["when_to_use", "w"],
      ["allowed_tools_claude", ""],
      ["disable-model-invocation", true],
      ["arguments", ["a", "b"]],
    ]);
    const r = renderSkillMd({ fm, body: "body\n\n\n", compose: false });
    assert.equal(r.kind, "skill");
    assert.equal(
      (r as { content: string }).content,
      '---\nname: demo\ndescription: d\nwhen_to_use: "w"\nallowed-tools: \ndisable-model-invocation: true\narguments: [a, b]\n---\n\n<!-- DO NOT EDIT. Generated from docs/operator-playbooks/demo.md. Run scripts/sync-skills.sh after editing the playbook. -->\n\nbody\n',
    );
  });

  test("compose strips disable-model-invocation; default allowed-tools", () => {
    const fm: Fm = new Map<string, string | boolean | string[]>([
      ["name", "demo"],
      ["description", "d"],
      ["disable-model-invocation", true],
    ]);
    const c = (renderSkillMd({ fm, body: "b", compose: true }) as { content: string }).content;
    assert.ok(!c.includes("disable-model-invocation"));
    assert.ok(c.includes("allowed-tools: Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*)\n"));
  });

  test("boolean scalar renders as Python True", () => {
    const fm: Fm = new Map<string, string | boolean | string[]>([
      ["name", "demo"],
      ["description", "d"],
      ["arguments", true],
    ]);
    assert.match(
      (renderSkillMd({ fm, body: "b", compose: false }) as { content: string }).content,
      /arguments: True\n/,
    );
  });

  test("skips when name or description is missing", () => {
    const r = renderSkillMd({ fm: new Map([["name", "x"]]) as Fm, body: "b", compose: false });
    assert.deepEqual(r, { kind: "skip", reason: "missing-name-or-description" });
  });
});

describe("skills playbook: renderPlaybook ordering", () => {
  const base = { fileName: "demo.md", playbooksDir: DIR, sources: sources({}) };

  test("no frontmatter skips", () => {
    assert.deepEqual(renderPlaybook({ ...base, text: "x" }), { kind: "skip", reason: "no-frontmatter" });
  });

  test("include error beats supersedes-without-compose and the name skip", () => {
    const r = renderPlaybook({ ...base, text: pb(["supersedes: x"], "@include _fragments/q.md\n") });
    assert.equal(r.kind, "error");
    assert.equal((r as { code: string }).code, "include-unresolved");
  });

  test("supersedes without compose_base errors", () => {
    const r = renderPlaybook({ ...base, text: pb(["name: n", "description: d", "supersedes: x"], "b\n") });
    assert.equal((r as { code: string }).code, "supersedes-without-compose");
  });

  test("end to end compose render", () => {
    const r = renderPlaybook({
      ...base,
      sources: sources({ "_vendor/b.md": "---\nname: b\ndisable-model-invocation: true\n---\nBASE\n" }),
      text: pb(["name: n", "description: d", "compose_base: _vendor/b.md"], "OVER\n"),
    });
    assert.equal(r.kind, "skill");
    assert.ok((r as { content: string }).content.endsWith("BASE\n\n---\n\n## Hydra AFK overlay (n)\n\nOVER\n"));
  });
});
