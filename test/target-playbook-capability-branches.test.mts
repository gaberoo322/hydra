/**
 * Playbook capability-branch drift guard + CLI contract (issue #5498, INV-4/INV-7).
 *
 * INV-4: every fenced bash block in a Target playbook that CONSUMES a
 * `TARGET_CAP_*` export must guard it with `[ -n|-z "$TARGET_CAP_X" ]` in the
 * same block, and a block with a guard must print an explicit `skipped (`
 * arm — an absent capability is never a silent no-op.
 *
 * INV-7: `print-target-facts.ts` (the real CLI, spawned) reports the
 * `capabilities` key in JSON mode and additive `TARGET_CAP_*` exports in
 * `--sh` mode, and the exports survive an `eval` round-trip even when a
 * capability value contains a single quote.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LEDGER_GENERATOR_SCRIPT, LEDGER_RELATIVE_PATH, shQuote } from "../scripts/target/target-capabilities.ts";
import * as emitter from "../scripts/ci/hydra-target-wire-or-retire-emit.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const PLAYBOOKS = [
  "hydra-target-build.md",
  "_fragments/hydra-target-build-anchor-preflight.md",
  "_fragments/hydra-target-build-inline-mode.md",
  "_fragments/hydra-target-build-merge-flow.md",
  "_fragments/target-seam-preamble.md",
  "_fragments/target-self-isolation-preamble.md",
  "hydra-target-qa.md",
  "hydra-target-cleanup.md",
  "hydra-target-discover.md",
  "hydra-target-incident.md",
].map((f) => join(REPO_ROOT, "docs", "operator-playbooks", f));

function bashBlocks(md: string): string[] {
  return [...md.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
}

describe("playbook capability branches (INV-4)", () => {
  test("every bash block consuming a TARGET_CAP_* var guards it and prints a skipped arm", () => {
    const problems: string[] = [];
    for (const file of PLAYBOOKS) {
      bashBlocks(readFileSync(file, "utf8")).forEach((block, i) => {
        const used = new Set(block.match(/\$\{?TARGET_CAP_[A-Z0-9_]+/g)?.map((v) => v.replace(/[${]/g, "")));
        for (const v of used) {
          if (!new RegExp(`\\[ -[nz] "\\$\\{?${v}\\}?" \\]`).test(block)) {
            problems.push(`${file} block ${i}: ${v} used without a [ -n|-z ] guard`);
          }
        }
        if (used.size > 0 && !/skipped \(/.test(block)) {
          problems.push(`${file} block ${i}: capability-guarded block has no explicit "skipped (" arm`);
        }
      });
    }
    assert.deepEqual(problems, []);
  });

  test("health-route probes print the route/HTTP line and never silence a failure", () => {
    for (const f of ["hydra-target-discover.md", "hydra-target-incident.md"]) {
      const md = readFileSync(join(REPO_ROOT, "docs", "operator-playbooks", f), "utf8");
      assert.match(md, /health-route: \$TARGET_CAP_HEALTH_ROUTE -> HTTP \$hcode/, f);
      assert.doesNotMatch(md, /2>\/dev\/null \|\| true.*HEALTH_ROUTE/, f);
    }
    const incident = readFileSync(join(REPO_ROOT, "docs", "operator-playbooks", "hydra-target-incident.md"), "utf8");
    assert.match(incident, /no per-service map on/);
  });

  test("cleanup knip step is a real branch on TARGET_CAP_KNIP_CONFIG", () => {
    const md = readFileSync(join(REPO_ROOT, "docs", "operator-playbooks", "hydra-target-cleanup.md"), "utf8");
    assert.match(md, /if \[ -n "\$TARGET_CAP_KNIP_CONFIG" \]; then\n\s+cd /);
    assert.match(md, /knip: skipped \(Target carries no knip config\)/);
  });
});

describe("ledger convention names have one owner (INV-1)", () => {
  test("the emitter re-exports the capabilities-module constants", () => {
    assert.equal(emitter.LEDGER_RELATIVE_PATH, LEDGER_RELATIVE_PATH);
    assert.equal(emitter.LEDGER_GENERATOR_SCRIPT, LEDGER_GENERATOR_SCRIPT);
    const src = readFileSync(join(REPO_ROOT, "scripts/ci/hydra-target-wire-or-retire-emit.ts"), "utf8");
    assert.doesNotMatch(src, /LEDGER_RELATIVE_PATH\s*=\s*"/);
    assert.doesNotMatch(src, /LEDGER_GENERATOR_SCRIPT\s*=\s*"/);
  });
});

describe("shQuote", () => {
  test("a value containing a single quote survives a real shell round-trip", () => {
    const tricky = `it's "x" $(echo pwned) \`id\``;
    const r = spawnSync("sh", ["-c", `V=${shQuote(tricky)}; printf %s "$V"`], { encoding: "utf8" });
    assert.equal(r.stdout, tricky);
  });
});

describe("print-target-facts CLI (INV-7)", () => {
  let root: string;
  const script = join(REPO_ROOT, "scripts/target/print-target-facts.ts");

  before(() => {
    root = mkdtempSync(join(tmpdir(), "target-cli-"));
    mkdirSync(join(root, ".hydra"), { recursive: true });
    writeFileSync(
      join(root, ".hydra", "manifest.json"),
      JSON.stringify({
        version: 1,
        verify: { install: "i", test: "t", typecheck: "c", build: "b", appSubdir: "" },
        riskCritical: { surface: ["src/"], mutationKillFloor: 60 },
      }),
    );
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { "e2e:smoke": "x" } }));
    writeFileSync(join(root, "knip.json"), "{}");
    // A directory whose name carries a single quote proves eval-safety of the exports.
    mkdirSync(join(root, "docs", "adr"), { recursive: true });
    writeFileSync(join(root, "docs", "adr", "0001-design-language-it's.md"), "x");
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  function run(args: string[]) {
    return spawnSync(process.execPath, ["--experimental-strip-types", script, ...args], {
      encoding: "utf8",
      env: { ...process.env, HYDRA_PROJECT_WORKSPACE: root, TARGET_MANIFEST_ROOT: root },
    });
  }

  test("JSON mode carries a capabilities key", () => {
    const r = run([]);
    assert.equal(r.status, 0, r.stderr);
    const facts = JSON.parse(r.stdout);
    assert.deepEqual(facts.capabilities.e2eSmoke, { ok: true, value: "e2e:smoke" });
    assert.deepEqual(facts.capabilities.knipConfig, { ok: true, value: "knip.json" });
    assert.equal(facts.capabilities.healthRoute.ok, false);
  });

  test("--sh mode appends TARGET_CAP_* exports that eval cleanly", () => {
    const r = run(["--sh"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^export TARGET_NAME=/m, "existing exports preserved");
    const probe = spawnSync(
      "sh",
      ["-c", `${r.stdout}\nprintf '%s|%s|%s' "$TARGET_CAP_E2E_SMOKE" "$TARGET_CAP_HEALTH_ROUTE" "$TARGET_CAP_DESIGN_LANGUAGE_ADR"`],
      { encoding: "utf8" },
    );
    assert.equal(probe.stdout, "e2e:smoke||docs/adr/0001-design-language-it's.md");
  });

  test("manifest failure still reports capabilities (bare-workspace probe) in JSON mode", () => {
    const bad = mkdtempSync(join(tmpdir(), "target-cli-bad-"));
    try {
      writeFileSync(join(bad, "knip.json"), "{}");
      const r = spawnSync(process.execPath, ["--experimental-strip-types", script], {
        encoding: "utf8",
        env: { ...process.env, HYDRA_PROJECT_WORKSPACE: bad, TARGET_MANIFEST_ROOT: bad },
      });
      assert.equal(r.status, 1);
      assert.deepEqual(JSON.parse(r.stdout).capabilities.knipConfig, { ok: true, value: "knip.json" });
    } finally {
      rmSync(bad, { recursive: true, force: true });
    }
  });
});
