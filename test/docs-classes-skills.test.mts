/**
 * The classes & skills families and their /docs surface (issue #4592 —
 * docs-epic 6/13; design concept issue-4592 invariants INV-9..INV-23).
 *
 * Two kinds of pin live here:
 *  - DATA pins — the committed inventories (docs/generated/classes.json +
 *    skills.json) and their source (scripts/autopilot/classes.json) agree on
 *    shape, derivation, and the home rule;
 *  - SURFACE pins — the playbook tables became data pointers and the
 *    dashboard views render derived rows only (source scans of the JSX, since
 *    a root node:test run has no browser and no marked — the marked-free
 *    pipeline core in dashboard/vite-plugins/docs-core.js IS imported for the
 *    functional name-index/judgment-walk checks).
 *
 * Pure filesystem — no Redis, no network, no running service, one top-level
 * describe with its own lifecycle.
 */

import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { buildNameIndex, buildViews } from "../dashboard/vite-plugins/docs-core.js";
import { BRAIN_SKILL, deriveSkillStage } from "../scripts/docs/inventories/skills.ts";
import type { ClassRow, SkillRow } from "../scripts/docs/inventories/envelope.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const readJson = (p: string) => JSON.parse(read(p));

const PLAYBOOK = read("docs/operator-playbooks/hydra-autopilot.md");
const TAXONOMY = readJson("scripts/autopilot/classes.json") as { classes: Array<Record<string, any>> };
const classesGen = readJson("docs/generated/classes.json") as { family: string; generatedFrom: string[]; rows: ClassRow[] };
const skillsGen = readJson("docs/generated/skills.json") as { family: string; rows: SkillRow[] };
const corpus = readJson("docs/generated/corpus.json") as { rows: Array<{ path: string; tier: string; route: string }> };

/** The section starting at `marker`, ending just before the next heading that ends `endRe`. */
function section(source: string, marker: string, endRe: RegExp) {
  const at = source.indexOf(marker);
  ok(at !== -1, `section ${marker} not found`);
  const rest = source.slice(at + marker.length);
  const end = rest.search(endRe);
  return end === -1 ? source.slice(at) : source.slice(at, at + marker.length + end);
}

describe("docs classes + skills families and surface (#4592)", () => {
  it("playbook: taxonomy + model tables replaced by data pointers (#4592 INV-9)", () => {
    const taxonomy = section(PLAYBOOK, "## Class taxonomy", /\n## /);
    const routing = section(PLAYBOOK, "### Per-class model routing", /\n## /);
    // The two tables are gone: no pipe-table rows remain in either section
    // (scoped to these sections — the Signal-wiring and self-isolation tables
    // elsewhere in the playbook are different, sanctioned tables).
    for (const [name, text] of [["Class taxonomy", taxonomy], ["Per-class model routing", routing]]) {
      const rows = text.split("\n").filter((l) => /^\s*\|/.test(l));
      deepStrictEqual(rows, [], `${name} still renders a pipe table`);
    }
    // Each is replaced by a pointer naming the rendered + the source file
    for (const text of [taxonomy, routing]) {
      ok(text.includes("scripts/autopilot/classes.json"), "pointer to the source file");
      ok(text.includes("docs/generated/classes.json"), "pointer to the generated file");
    }
    // The sanctioned prose survives: the ADR-0030 one-lineage note, the
    // CONTEXT POINTER, and the pipeline/signal slot semantics.
    ok(taxonomy.includes("One-lineage stage bindings"), "ADR-0030 one-lineage note kept");
    ok(taxonomy.includes("CONTEXT POINTER"), "CONTEXT POINTER kept");
    ok(taxonomy.includes("Pipeline slots: at most one subagent per slot"), "slot semantics kept");
    ok(routing.includes("`model` column"), "routing section points at the model column");
  });

  it("playbook: dispatch-time model + wayfinder skill are jq reads of classes.json, no literal ticket-type pairs (#4592 INV-10)", () => {
    // The model lookup: a concrete jq read of the slot's model column
    ok(PLAYBOOK.includes('jq -r --arg c "$SLOT"'), "model jq read present");
    ok(PLAYBOOK.includes(".model // empty"), "model jq read selects the model column");
    ok(PLAYBOOK.includes("scripts/autopilot/classes.json"), "jq read targets classes.json");
    // The wayfinder lookup: skill_by_ticket_type keyed by the ticket type
    ok(PLAYBOOK.includes('jq -r --arg t "$TICKET_TYPE"'), "wayfinder jq read present");
    ok(PLAYBOOK.includes(".skill_by_ticket_type[$t] // empty"), "wayfinder jq read selects the sbtt column");
    // No literal ticket-type -> skill pairs anywhere in the playbook
    for (const re of [
      /`research`\s*(?:→|->)\s*\*{0,2}hydra-issue-research/,
      /`task`\s*(?:→|->)\s*\*{0,2}hydra-dev/,
      /\bresearch\s*→\s*\*{0,2}hydra-issue-research/,
      /\btask\s*→\s*\*{0,2}hydra-dev\b/,
    ]) {
      ok(!re.test(PLAYBOOK), `literal ticket-type pair remains: ${re.source}`);
    }
  });

  it("classes.json notes carry the model rationale from the deleted routing table (#4592 INV-11)", () => {
    const rows = TAXONOMY.classes;
    ok(rows.length >= 20, "the full alphabet is present");
    for (const row of rows) {
      match(row.notes ?? "", new RegExp(`Model ${row.model}\\b`), `${row.name} notes carry its model rationale`);
    }
    // Spot-check the rationales the deleted table's rows carried
    const byName = new Map(rows.map((r) => [r.name, r]));
    match(byName.get("dev_orch").notes, /GLM beachhead evidence/);
    match(byName.get("dev_target").notes, /money-critical authoring/);
    match(byName.get("qa_target").notes, /last judgment before auto-merge/);
    match(byName.get("wire_or_retire_target").notes, /Model inherit: judgment work/);
  });

  it("classes inventory: every taxonomy column, source path+line, order index, home rule (#4592 INV-13)", () => {
    strictEqual(classesGen.family, "classes");
    deepStrictEqual(classesGen.generatedFrom, ["scripts/autopilot/classes.json"]);
    const columns = [
      "order", "name", "kind", "skill", "stage", "model", "skill_by_ticket_type",
      "costClass", "learningAgent", "cooldownSeconds", "scope", "provenanceLabel",
      "notes", "home", "secondaryHome", "source",
    ];
    const rows = classesGen.rows;
    deepStrictEqual(rows.map((r) => r.name), TAXONOMY.classes.map((c) => c.name), "row set + order mirror the taxonomy");
    rows.forEach((row, i) => {
      for (const col of columns) ok(col in row, `${row.name}.${col} present`);
      strictEqual(row.order, i, `${row.name} order is the file-order index`);
      strictEqual(row.home, "/now", `${row.name} home rule`);
      strictEqual(row.secondaryHome, "/runs", `${row.name} secondary home rule`);
      strictEqual(row.source.path, "scripts/autopilot/classes.json", `${row.name} source path`);
      ok(Number.isInteger(row.source.line) && row.source.line > 0, `${row.name} source line`);
      const tax = TAXONOMY.classes.find((c) => c.name === row.name);
      strictEqual(row.skill, tax.skill, `${row.name} skill mirrors the taxonomy`);
      strictEqual(row.stage, tax.stage, `${row.name} stage mirrors the taxonomy`);
      strictEqual(row.model, tax.model, `${row.name} model mirrors the taxonomy`);
      deepStrictEqual(row.skill_by_ticket_type, tax.skill_by_ticket_type ?? null, `${row.name} sbtt mirrors`);
    });
  });

  it("skills extractor: one row per playbook, composedFrom targets exist on disk, no fragments (#4592 INV-14)", () => {
    strictEqual(skillsGen.family, "skills");
    const rows = skillsGen.rows;
    const playbooks = readdirSync(join(ROOT, "docs/operator-playbooks"))
      .filter((f) => f.endsWith(".md") && f !== "README.md" && !f.startsWith("_"))
      .map((f) => f.replace(/\.md$/, ""))
      .sort();
    deepStrictEqual([...rows.map((r) => r.name)].sort(), playbooks, "exactly one row per playbook");
    for (const row of rows) {
      ok(existsSync(join(ROOT, row.path)), `${row.path} exists on disk`);
      ok(!row.name.startsWith("_"), "no vendored base rows");
      ok(!/fragment/i.test(row.name), "no fragment rows");
      strictEqual(row.name, row.path.slice(row.path.lastIndexOf("/") + 1, -".md".length), "name == basename");
      for (const target of row.composedFrom) {
        ok(existsSync(join(ROOT, target)), `${row.name} composedFrom ${target} exists on disk`);
      }
      strictEqual(row.route, `/docs/skill/${row.name}`, `${row.name} route derived from the name`);
    }
    deepStrictEqual(rows.map((r) => r.name), [...rows.map((r) => r.name)].sort(), "rows sorted by name");
  });

  it("skill stage is derived from the class table, exactly one brain, every dispatched skill has a playbook (#4592 INV-15)", () => {
    const rows = skillsGen.rows;
    const brain = rows.filter((r) => r.stage === "brain");
    strictEqual(brain.length, 1, "exactly one brain skill");
    strictEqual(brain[0].name, BRAIN_SKILL);
    const byName = new Map(rows.map((r) => [r.name, r]));
    // Every class's skill and sbtt value resolves to a playbook row
    for (const c of classesGen.rows) {
      ok(byName.has(c.skill), `class ${c.name} dispatches ${c.skill} which has a playbook`);
      for (const target of Object.values(c.skill_by_ticket_type ?? {})) {
        ok(byName.has(target), `class ${c.name} routes to ${target} which has a playbook`);
      }
    }
    // The derivation itself, recomputed through the extractor's own function
    for (const row of rows) {
      strictEqual(row.stage, deriveSkillStage(row.name, classesGen.rows), `${row.name} stage is the derived stage`);
    }
    // dispatchedBy is the inverse projection of the class table (default and
    // ticket-type entries both fire, mirroring dispatchingClasses)
    const dispatchers = (name: string): Array<{ class: string; via: string }> => {
      const out = [];
      for (const c of classesGen.rows) {
        if (c.skill === name) out.push({ class: c.name, via: "default" });
        for (const [type, target] of Object.entries(c.skill_by_ticket_type ?? {})) {
          if (target === name) out.push({ class: c.name, via: type });
        }
      }
      return out;
    };
    for (const row of rows) deepStrictEqual(row.dispatchedBy, dispatchers(row.name), `${row.name} dispatchedBy mirrors the class table`);
  });

  it("no new test pins research_orch's skill or the research playbooks' stage by literal (#4592 INV-16)", () => {
    // #4636 order-independence: this slice must not pin by literal what PR
    // #4798 may change. Literals are assembled from fragments so this scan
    // never matches its own source.
    const RCLASS = "research_" + "orch";
    const RSKILLS = ["hydra-" + "research", "hydra-" + "issue-" + "research"];
    for (const file of [
      "test/docs-classes-skills.test.mts",
      "test/taxonomy-classes.test.mts",
      "test/generated-inventories-drift.test.mts",
    ]) {
      for (const line of read(file).split("\n")) {
        for (const skill of RSKILLS) {
          ok(!(line.includes(RCLASS) && line.includes(skill)), `${file} pins ${RCLASS}'s skill by literal`);
          ok(!(line.includes(skill) && /\bstage\b/.test(line)), `${file} pins a research playbook's stage by literal`);
        }
      }
    }
  });

  it("catalogue: /docs/cat/classes groups by stage, no hand-listed names, one Catalogues tree entry (#4592 INV-19)", () => {
    const jsx = read("dashboard/src/pages/docs/ClassesSkills.jsx");
    const tree = read("dashboard/src/pages/docs/tree.js");
    // Grouping is by the stage column's VALUES (one hand-authored constant),
    // never a list of class or skill names
    ok(jsx.includes("STAGE_ORDER"), "stage order constant drives the grouping");
    for (const c of classesGen.rows) {
      ok(!new RegExp(`\\b${c.name}\\b`).test(jsx), `class ${c.name} hand-listed in the catalogue`);
    }
    for (const s of skillsGen.rows) {
      ok(!new RegExp(`\\b${s.name}\\b`).test(jsx), `skill ${s.name} hand-listed in the catalogue`);
    }
    // The nav tree gains exactly ONE Catalogues entry — never one per skill
    strictEqual((tree.match(/key: "cat\/classes"/g) ?? []).length, 1, "one cat/classes tree entry");
    ok(!/key:\s*["'`]skill\//.test(tree), "no per-skill tree entries");
    ok(/#4592/.test(tree), "the one-entry rule is recorded at the entry");
  });

  it("skill view: card first, class table only for the brain skill, playbook body under the source tag (#4592 INV-20)", () => {
    const docs = read("dashboard/src/pages/docs/Docs.jsx");
    const at = docs.indexOf("function skillView");
    ok(at !== -1, "skillView factory present");
    const fn = docs.slice(at, docs.indexOf("\nfunction ", at + 1));
    ok(fn.indexOf("SkillCard") !== -1 && fn.indexOf("ClassTable") !== -1, "card + class table render");
    ok(fn.indexOf("SkillCard") < fn.indexOf("ClassTable"), "the generated card comes first");
    ok(fn.indexOf("ClassTable") < fn.indexOf("skill-source-tag"), "class table precedes the playbook body");
    ok(/row\.stage === "brain"/.test(fn), "class table only for the brain skill");
    ok(fn.includes('data-testid="skill-source-tag"'), "visible source tag over the playbook body");
    ok(fn.includes("MarkdownBody"), "playbook body renders via the #4591 build-time pipeline");
    ok(fn.includes("notBuiltView"), "an unknown name renders the explicit not-built state");
  });

  it("live state lives on /now and /runs on every class-showing view, no view-time fetch (#4592 INV-21)", () => {
    for (const row of classesGen.rows) {
      strictEqual(row.home, "/now", `${row.name} home`);
      strictEqual(row.secondaryHome, "/runs", `${row.name} secondary home`);
    }
    const cat = read("dashboard/src/pages/docs/ClassesSkills.jsx");
    const docs = read("dashboard/src/pages/docs/Docs.jsx");
    ok(/live:\s*classLiveHomes\(classes\)/.test(cat), "catalogue live rail uses the home rule");
    ok(/live:\s*showsClasses \? classLiveHomes\(classes\) : \[\]/.test(docs), "skill view live rail exactly when it shows a class");
    // Views read build-time data only — no view-time fetch of any kind
    for (const [file, src] of [["ClassesSkills.jsx", cat], ["Docs.jsx", docs]]) {
      ok(!/\bfetch\s*\(/.test(src) && !/axios|useSWR|useQuery/.test(src), `${file} fetches at view time`);
    }
  });

  it("name index: skill + class entries precede heading entries, playbook headings not indexed (#4592 INV-22)", () => {
    const playbookRow = corpus.rows.find((r) => r.tier === "playbook");
    ok(playbookRow, "corpus carries playbook rows");
    const outlines = new Map([
      [playbookRow.path, { headings: [{ depth: 2, text: "Playbook only heading", slug: "playbook-only-heading", section: "playbook-only-heading" }] }],
      ["README.md", { headings: [{ depth: 2, text: "README indexed heading", slug: "readme-indexed-heading", section: "readme-indexed-heading" }] }],
    ]);
    const hosts = new Map([["README.md#readme-indexed-heading", ""]]);
    const views = buildViews(corpus.rows, outlines);
    const entries = buildNameIndex({
      views,
      outlines,
      hosts,
      rows: corpus.rows,
      glossaryTerms: [],
      routeRows: [],
      skillRows: skillsGen.rows,
      classRows: classesGen.rows,
    });
    strictEqual(entries.length, skillsGen.rows.length + classesGen.rows.length + 1, "skills + classes + the README heading");
    skillsGen.rows.forEach((s, i) => {
      strictEqual(entries[i].kind, "skill");
      strictEqual(entries[i].name, s.name);
      strictEqual(entries[i].href, s.route);
    });
    classesGen.rows.forEach((c, i) => {
      const e = entries[skillsGen.rows.length + i];
      strictEqual(e.kind, "class");
      strictEqual(e.href, `/docs/cat/classes#${encodeURIComponent(c.name)}`);
    });
    const heading = entries[entries.length - 1];
    strictEqual(heading.name, "README indexed heading", "heading entries follow");
    ok(!entries.some((e) => e.name === "Playbook only heading"), "playbook headings are never indexed");
  });

  it("judgment walk: search autopilot finds the brain skill, every class skill resolves, every skill route is built (#4592 INV-23)", () => {
    const views = buildViews(corpus.rows, new Map());
    const viewKeys = new Set(views.map((v) => v.key));
    const entries = buildNameIndex({
      views,
      outlines: new Map(),
      hosts: new Map(),
      rows: corpus.rows,
      glossaryTerms: [],
      routeRows: [],
      skillRows: skillsGen.rows,
      classRows: classesGen.rows,
    });
    // The #4545 walk: searching "autopilot" — the FIRST hit is the brain skill
    const hits = entries.filter((e) => /autopilot/i.test(e.name) && !e.historical);
    strictEqual(hits.length, 1, "exactly one name match");
    strictEqual(hits[0].name, BRAIN_SKILL);
    strictEqual(hits[0].kind, "skill");
    strictEqual(hits[0].href, `/docs/skill/${BRAIN_SKILL}`);
    const brain = skillsGen.rows.find((r) => r.name === BRAIN_SKILL);
    strictEqual(brain.stage, "brain", "the found row has stage brain");
    // Every class's skill and sbtt value resolves to a skills row
    const byName = new Map(skillsGen.rows.map((r) => [r.name, r]));
    for (const c of classesGen.rows) {
      ok(byName.has(c.skill), `${c.name} -> ${c.skill} resolves`);
      for (const target of Object.values(c.skill_by_ticket_type ?? {})) {
        ok(byName.has(target), `${c.name} sbtt -> ${target} resolves`);
      }
    }
    // Every skill row's route is a view the build actually renders
    for (const s of skillsGen.rows) {
      ok(viewKeys.has(s.route.replace(/^\/docs\//, "")), `${s.name} route ${s.route} is a built view`);
    }
  });
});
