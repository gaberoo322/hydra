/**
 * Regression tests for the hydra-target-cleanup deterministic emit planner —
 * the TARGET mirror of hydra-cleanup-emit (demote-only sweep, step 2 of the
 * Target dead-code cleanup plan).
 *
 * What the planner must guarantee (each pinned below):
 *
 *   1. DEMOTE-ONLY: only export findings still referenced within their own
 *      file (classifyExportFix → "demote") are emitted. delete-class findings,
 *      whole-file findings, and unknown-source findings are dropped — the
 *      Target's CLAUDE.md authorises this sweep for demotes only.
 *   2. WIRING GRACE: a finding in a file touched within the last 45 days is
 *      dropped (Hydra builds modules first, wires later — young dead exports
 *      are usually wiring-in-flight). Unknown file age fails closed.
 *   3. ONE ITEM PER FILE: sibling findings in one file batch into a single
 *      backlog item (addToBacklog fuzzy-title dedup would reject per-symbol
 *      titles, and the picker ships one PR per file anyway).
 *   4. FILE-KEYED DEDUP: while an open cleanup-scan item covers a path, no
 *      new item for that path is filed.
 *   5. TITLE/BODY COHERENCE (the #1449/#1005 drift guard carried over): title
 *      and body for an item come from the same (path, symbols) group in one
 *      pass — every emitted title's path and symbols appear in its own body.
 *
 * Pure planner — source text, file age, and the open board are injected — so
 * these run in milliseconds with zero setup.
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  planTargetCleanupEmit,
  renderTargetTitle,
  renderTargetBody,
  identityFromOpenItemTitle,
  buildTargetCleanupShellSpec,
  resolveTargetCleanupInputs,
  gitFileAgeProbe,
  TARGET_EMIT_CAP,
  WIRING_GRACE_DAYS,
  WIRING_GRACE_CEILING_DAYS,
  type FileAgeProbe,
  type TargetPathFacts,
} from "../scripts/ci/hydra-target-cleanup-emit.ts";
import { __resetForTests as resetTargetConfig } from "../src/target-config.ts";
import type { KnipReport } from "../scripts/ci/hydra-cleanup-render.ts";

const EMIT_SOURCE_PATH = fileURLToPath(
  new URL("../scripts/ci/hydra-target-cleanup-emit.ts", import.meta.url),
);

const REPO_ROOT = resolve(import.meta.dirname, "..");

/** A file where both symbols are referenced in-file (demote-class). */
const DEMOTE_SOURCE = [
  "export type AlphaStatus = 'on' | 'off';",
  "export const alphaDefault: AlphaStatus = 'on';",
  "function useAlpha(s: AlphaStatus) { return s ?? alphaDefault; }",
  "useAlpha('on');",
].join("\n");

/** A file where the symbol has no in-file reference (delete-class). */
const DELETE_SOURCE = ["export const orphanConst = 42;", "const other = 1;", "void other;"].join("\n");

function report(issues: Array<{ file: string; exports?: string[]; types?: string[] }>, files: string[] = []): KnipReport {
  return {
    files,
    issues: issues.map((i) => ({
      file: i.file,
      exports: (i.exports ?? []).map((name) => ({ name })),
      types: (i.types ?? []).map((name) => ({ name })),
    })),
  };
}

const SOURCES: Record<string, string> = {
  "src/lib/alpha.ts": DEMOTE_SOURCE,
  "src/lib/orphan.ts": DELETE_SOURCE,
  "src/lib/providers/venue.ts": DEMOTE_SOURCE,
  "src/lib/young.ts": DEMOTE_SOURCE,
};

const readSource = (p: string): string => SOURCES[p] ?? "";

/**
 * Build a {@link FileAgeProbe}. `introDays` defaults to `lastTouchDays` (i.e.
 * "old on both measures, no reset") so every pre-existing scalar-shaped test
 * case ports over unchanged in meaning.
 */
function probe(
  lastTouchDays: number | null,
  introDays: number | null = lastTouchDays,
  resetCommit: FileAgeProbe["resetCommit"] = null,
): FileAgeProbe {
  return { lastTouchDays, introDays, resetCommit };
}

const oldFile = (_p: string): FileAgeProbe => probe(120);

/**
 * The two appSubdir shapes the Target seam produces (issue #4902): a
 * `web/`-nested app dir (the archived Target's shape) and a repo-root app
 * ("" — the CSB shape, where app-relative and repo-relative are identical).
 */
const WEB_SHAPE_FACTS: TargetPathFacts = { appSubdir: "web", appDir: "/example/ws/web" };
const ROOT_SHAPE_FACTS: TargetPathFacts = { appSubdir: "", appDir: "/example/ws" };

function plan(
  r: KnipReport,
  openTitles: string[] = [],
  ages: (p: string) => FileAgeProbe = oldFile,
  facts: TargetPathFacts = WEB_SHAPE_FACTS,
  cap?: number,
) {
  return planTargetCleanupEmit(r, openTitles, readSource, ages, "2026-06-10", facts, cap);
}

describe("hydra-target-cleanup-emit — demote-only filter", () => {
  test("emits demote-class export findings, batched per file", () => {
    const p = plan(report([{ file: "src/lib/alpha.ts", exports: ["alphaDefault"], types: ["AlphaStatus"] }]));
    assert.equal(p.items.length, 1);
    assert.equal(p.items[0].path, "src/lib/alpha.ts");
    assert.deepEqual(p.items[0].symbols, ["alphaDefault", "AlphaStatus"]);
  });

  test("drops delete-class findings (deferred to wire-or-retire)", () => {
    const p = plan(report([{ file: "src/lib/orphan.ts", exports: ["orphanConst"] }]));
    assert.equal(p.items.length, 0);
    assert.equal(p.dropped.length, 1);
    assert.match(p.dropped[0].reason, /delete-class/);
  });

  test("drops whole-file findings (wire-or-retire territory)", () => {
    const p = plan(report([], ["src/lib/alpha.ts"]));
    assert.equal(p.items.length, 0);
    assert.match(p.dropped[0].reason, /whole-file/);
  });

  test("drops findings whose source is unavailable (fail closed)", () => {
    const p = plan(report([{ file: "src/lib/missing.ts", exports: ["ghost"] }]));
    assert.equal(p.items.length, 0);
    assert.match(p.dropped[0].reason, /fail closed/);
  });

  test("drops test-file and .d.ts findings", () => {
    const p = plan(
      report([
        { file: "src/lib/alpha.test.ts", exports: ["helper"] },
        { file: "src/types.d.ts", types: ["Decl"] },
      ]),
    );
    assert.equal(p.items.length, 0);
    assert.equal(p.dropped.length, 2);
    for (const d of p.dropped) assert.match(d.reason, /test-only \/ type-declaration/);
  });

  test("providers paths are emitted (demote is allowed there — rule 1 forbids deletion only)", () => {
    const p = plan(report([{ file: "src/lib/providers/venue.ts", exports: ["alphaDefault"] }]));
    assert.equal(p.items.length, 1);
    assert.equal(p.items[0].path, "src/lib/providers/venue.ts");
  });
});

describe("hydra-target-cleanup-emit — wiring grace period", () => {
  test(`drops findings in files younger than ${WIRING_GRACE_DAYS} days`, () => {
    const p = plan(report([{ file: "src/lib/young.ts", exports: ["alphaDefault"] }]), [], () => probe(10));
    assert.equal(p.items.length, 0);
    assert.match(p.dropped[0].reason, /wiring grace period \(10d old\)/);
  });

  test("a file exactly at the grace boundary is emitted", () => {
    const p = plan(report([{ file: "src/lib/alpha.ts", exports: ["alphaDefault"] }]), [], () => probe(WIRING_GRACE_DAYS));
    assert.equal(p.items.length, 1);
    assert.equal(p.items[0].ageDays, WIRING_GRACE_DAYS);
  });

  test("unknown last-touch age fails closed", () => {
    const p = plan(report([{ file: "src/lib/alpha.ts", exports: ["alphaDefault"] }]), [], () => probe(null));
    assert.equal(p.items.length, 0);
    assert.match(p.dropped[0].reason, /age unknown — fail closed/);
  });
});

describe("hydra-target-cleanup-emit — introduction-anchored deferral ceiling (issue #3727)", () => {
  test(`WIRING_GRACE_CEILING_DAYS (${WIRING_GRACE_CEILING_DAYS}) is strictly greater than WIRING_GRACE_DAYS (${WIRING_GRACE_DAYS})`, () => {
    assert.ok(WIRING_GRACE_CEILING_DAYS > WIRING_GRACE_DAYS);
  });

  test("old-by-introduction but freshly touched by a cleanup/docs/relocation commit is EMITTED", () => {
    // last-touch 9d (a relocation commit reset the clock), intro 100d (old by
    // introduction, past the ceiling) — the exact observed failure this issue
    // reports: a condemned module shielded forever by its own migration commits.
    const p = plan(
      report([{ file: "src/lib/alpha.ts", exports: ["alphaDefault"] }]),
      [],
      () => probe(9, 100, { shortSha: "abc1234", subject: "refactor: relocate module" }),
    );
    assert.equal(p.items.length, 1);
    assert.equal(p.items[0].ageDays, 9);
  });

  test("genuinely young with a real wiring commit in the window is STILL DEFERRED", () => {
    // last-touch 9d, intro 20d (young by BOTH measures) — proves the grace
    // period was not simply deleted by the ceiling.
    const p = plan(report([{ file: "src/lib/alpha.ts", exports: ["alphaDefault"] }]), [], () => probe(9, 20));
    assert.equal(p.items.length, 0);
    assert.match(p.dropped[0].reason, /wiring grace period \(9d old\)/);
    assert.match(p.dropped[0].reason, /introduced 20d ago/);
  });

  test("old on both measures is emitted exactly as today (no regression on the working path)", () => {
    const p = plan(report([{ file: "src/lib/alpha.ts", exports: ["alphaDefault"] }]), [], () => probe(100, 200));
    assert.equal(p.items.length, 1);
    assert.equal(p.items[0].ageDays, 100);
  });

  test("unknown introduction age is treated as WITHIN the ceiling (still defers)", () => {
    const p = plan(report([{ file: "src/lib/alpha.ts", exports: ["alphaDefault"] }]), [], () => probe(9, null));
    assert.equal(p.items.length, 0);
    assert.match(p.dropped[0].reason, /introduction unknown/);
  });

  test("grace-drop reason attributes the resetting commit (short SHA + subject) for audit", () => {
    const p = plan(
      report([{ file: "src/lib/alpha.ts", exports: ["alphaDefault"] }]),
      [],
      () => probe(9, 20, { shortSha: "d8fc713e", subject: "docs: correct header comment" }),
    );
    assert.match(p.dropped[0].reason, /reset by d8fc713e "docs: correct header comment"/);
  });
});

describe("hydra-target-cleanup-emit — dedup and cap", () => {
  test("a path with an open cleanup-scan item is not re-filed", () => {
    const openTitle = renderTargetTitle("src/lib/alpha.ts", ["alphaDefault"]);
    const p = plan(report([{ file: "src/lib/alpha.ts", exports: ["alphaDefault"], types: ["AlphaStatus"] }]), [openTitle]);
    assert.equal(p.items.length, 0);
    assert.equal(p.dropped.length, 2);
    for (const d of p.dropped) assert.match(d.reason, /open cleanup-scan item already covers/);
  });

  test("identityFromOpenItemTitle round-trips rendered titles (single and batched)", () => {
    assert.equal(identityFromOpenItemTitle(renderTargetTitle("src/lib/a.ts", ["x"])), "src/lib/a.ts");
    assert.equal(identityFromOpenItemTitle(renderTargetTitle("src/lib/a.ts", ["x", "y", "z"])), "src/lib/a.ts");
    assert.equal(identityFromOpenItemTitle("feat: unrelated backlog item"), null);
  });

  test("caps emitted items per run, largest demote batch first", () => {
    const issues = Array.from({ length: TARGET_EMIT_CAP + 2 }, (_, i) => ({
      file: `src/lib/file-${String(i).padStart(2, "0")}.ts`,
      exports: i === 0 ? ["alphaDefault", "AlphaStatus"] : ["alphaDefault"],
    }));
    const sources: Record<string, string> = {};
    for (const i of issues) sources[i.file] = DEMOTE_SOURCE;
    const p = planTargetCleanupEmit(
      report(issues),
      [],
      (path) => sources[path] ?? "",
      oldFile,
      "2026-06-10",
      WEB_SHAPE_FACTS,
    );
    assert.equal(p.items.length, TARGET_EMIT_CAP);
    assert.equal(p.items[0].path, "src/lib/file-00.ts"); // 2 demotes ranks first
    assert.equal(p.dropped.filter((d) => /over the per-run cap/.test(d.reason)).length, 2);
  });
});

describe("hydra-target-cleanup-emit — rendering (title/body coherence)", () => {
  test("title and body name the same path and symbols (the drift guard)", () => {
    const p = plan(report([{ file: "src/lib/alpha.ts", exports: ["alphaDefault"], types: ["AlphaStatus"] }]));
    const item = p.items[0];
    assert.match(item.title, /alphaDefault/);
    assert.match(item.title, /src\/lib\/alpha\.ts/);
    assert.match(item.body, /`alphaDefault`/);
    assert.match(item.body, /`AlphaStatus`/);
    assert.match(item.body, /web\/src\/lib\/alpha\.ts/);
  });

  test("body carries the Target policy: demote-only, citation, baseline tightening", () => {
    const p = plan(report([{ file: "src/lib/alpha.ts", exports: ["alphaDefault"] }]));
    const body = p.items[0].body;
    assert.match(body, /demote, do NOT delete/);
    assert.match(body, /scan date 2026-06-10/);
    assert.match(body, /deadcode:update-baseline/);
    assert.match(body, /No file deletions/);
  });

  test("renderTargetTitle keeps cross-file titles word-diverse (fuzzy-dedup guard)", () => {
    // addToBacklog rejects a new title sharing ≥70% of significant words with
    // an existing one. Leading with the symbol keeps two single-symbol items
    // from different files under that threshold.
    const a = renderTargetTitle("src/lib/providers/polymarket-ws/client.ts", ["PolymarketWsStats"]);
    const b = renderTargetTitle("src/lib/providers/polymarket-ws/protocol.ts", ["PolymarketWsMessageType"]);
    const words = (t: string) => new Set(t.toLowerCase().split(/\s+/).filter((w) => w.length > 3));
    const wa = words(a);
    const wb = words(b);
    const overlap = [...wa].filter((w) => wb.has(w)).length;
    assert.ok(
      overlap / Math.max(wa.size, wb.size) < 0.7,
      `cross-file title overlap must stay under the 0.7 fuzzy-dedup threshold (got ${overlap}/${Math.max(wa.size, wb.size)})`,
    );
  });

  test("renderTargetTitle/Body throw on an empty batch (blank-title guard)", () => {
    assert.throws(() => renderTargetTitle("", ["x"]));
    assert.throws(() => renderTargetTitle("src/lib/a.ts", []));
    assert.throws(() => renderTargetBody("src/lib/a.ts", [], 90, "2026-06-10", WEB_SHAPE_FACTS));
  });
});

describe("hydra-target-cleanup-emit — grace-ceiling playbook drift guard (issue #3727)", () => {
  // A sibling advisory workflow cannot block a merge (reference_seam_checks_
  // advisory_only) — the invariant worth pinning lives in a test. Reads the
  // in-repo playbook, NEVER the generated ~/.claude/skills/*/SKILL.md (only
  // one SKILL.md is git-tracked — a generated-artifact assertion reproduces
  // the known worktree-local doc-drift flake class), and never shells into
  // /home/gabe/hydra-betting (the Target checkout is absent on CI runners).

  test("WIRING_GRACE_CEILING_DAYS is strictly greater than WIRING_GRACE_DAYS", () => {
    assert.ok(
      WIRING_GRACE_CEILING_DAYS > WIRING_GRACE_DAYS,
      `ceiling (${WIRING_GRACE_CEILING_DAYS}) must exceed the grace period (${WIRING_GRACE_DAYS}) or the ceiling collapses grace entirely`,
    );
  });

  test("the in-repo playbook names both the grace period and the ceiling", () => {
    const repoRoot = resolve(import.meta.dirname, "..");
    const playbookPath = join(repoRoot, "docs", "operator-playbooks", "hydra-target-cleanup.md");
    const text = readFileSync(playbookPath, "utf-8");
    assert.ok(
      text.includes(String(WIRING_GRACE_DAYS)),
      `playbook must name the ${WIRING_GRACE_DAYS}-day grace period`,
    );
    assert.ok(
      text.includes(String(WIRING_GRACE_CEILING_DAYS)),
      `playbook must name the ${WIRING_GRACE_CEILING_DAYS}-day introduction ceiling`,
    );
  });
});

// ---------------------------------------------------------------------------
// Target resolved through the target-config seam (issue #4902 — the #4553
// wire-or-retire migration applied to the demote runner). Every design-concept
// invariant for the migration is pinned here; the reconciliation gate in the
// required `test` job cites these tests by name.
// ---------------------------------------------------------------------------

describe("hydra-target-cleanup-emit — Target resolved through the target-config seam (#4902)", () => {
  const saved = {
    ws: process.env.HYDRA_PROJECT_WORKSPACE,
    repo: process.env.HYDRA_TARGET_GITHUB_REPO,
    manifestRoot: process.env.TARGET_MANIFEST_ROOT,
  };
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetTargetConfig();
  });

  test("the runner source and every rendered title/body carry no hydra-betting literal", () => {
    const src = readFileSync(EMIT_SOURCE_PATH, "utf-8");
    assert.ok(
      !src.includes("hydra-betting"),
      "the runner must carry no hydra-betting substring (code, comments, usage block)",
    );
    const title = renderTargetTitle("src/lib/alpha.ts", ["alphaDefault"]);
    const body = renderTargetBody(
      "src/lib/alpha.ts",
      ["alphaDefault"],
      90,
      "2026-06-10",
      WEB_SHAPE_FACTS,
    );
    assert.ok(!title.includes("hydra-betting"), "rendered titles must carry no hydra-betting literal");
    assert.ok(!body.includes("hydra-betting"), "rendered bodies must carry no hydra-betting literal");
  });

  test("importing the module resolves nothing at load time (no target-config fallback warning)", () => {
    const res = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings",
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(EMIT_SOURCE_PATH)});`,
      ],
      {
        encoding: "utf-8",
        env: { ...process.env, HYDRA_PROJECT_WORKSPACE: "", HYDRA_TARGET_GITHUB_REPO: "", HYDRA_TARGET_NAME: "" },
      },
    );
    assert.equal(res.status, 0, `import must succeed; stderr: ${res.stderr}`);
    assert.doesNotMatch(res.stderr, /\[target-config\]/, `import must not resolve the Target; stderr: ${res.stderr}`);
  });

  test("the planner and body renderer take the Target facts as explicit arguments (both appSubdir shapes flow through)", () => {
    const webBody = renderTargetBody("src/lib/alpha.ts", ["alphaDefault"], 90, "2026-06-10", WEB_SHAPE_FACTS);
    const rootBody = renderTargetBody("src/lib/alpha.ts", ["alphaDefault"], 90, "2026-06-10", ROOT_SHAPE_FACTS);
    // web/ shape: the joined repo-relative path and the appDir both appear.
    assert.match(webBody, /`web\/src\/lib\/alpha\.ts`/);
    assert.match(webBody, /\/example\/ws\/web\/src\/lib\/alpha\.ts/);
    assert.match(webBody, /`web\/deadcode-baseline\.json`/);
    // repo-root shape ("", the CSB shape): identity join — no web/ anywhere.
    assert.doesNotMatch(rootBody, /web\//);
    assert.match(rootBody, /`src\/lib\/alpha\.ts`/);
    assert.match(rootBody, /\/example\/ws\/src\/lib\/alpha\.ts/);
    assert.match(rootBody, /`deadcode-baseline\.json`/);
    // The planner threads the SAME facts into every rendered body.
    const p = plan(report([{ file: "src/lib/alpha.ts", exports: ["alphaDefault"] }]), [], oldFile, ROOT_SHAPE_FACTS);
    assert.equal(p.items.length, 1);
    assert.match(p.items[0].body, /`src\/lib\/alpha\.ts`/);
  });

  test("renderTargetTitle and identityFromOpenItemTitle are byte-for-byte unchanged (dedup identity preserved)", () => {
    assert.equal(renderTargetTitle("src/lib/a.ts", ["x"]), "cleanup(target): demote `x` in src/lib/a.ts");
    assert.equal(
      renderTargetTitle("src/lib/a.ts", ["x", "y", "z"]),
      "cleanup(target): demote `x` +2 more in src/lib/a.ts",
    );
    assert.equal(identityFromOpenItemTitle("cleanup(target): demote `x` in src/lib/a.ts"), "src/lib/a.ts");
    assert.equal(
      identityFromOpenItemTitle("cleanup(target): demote `x` +2 more in src/lib/a.ts"),
      "src/lib/a.ts",
    );
  });

  test("gitFileAgeProbe probes the workspace at the toRepoRelative-joined path", () => {
    // A throwaway git repo with the file ONLY at the joined web/ location:
    // the probe must find it through the join and miss without it.
    const tmp = mkdtempSync(join(tmpdir(), "target-cleanup-probe-"));
    try {
      mkdirSync(join(tmp, "web", "src", "lib"), { recursive: true });
      writeFileSync(join(tmp, "web", "src", "lib", "foo.ts"), "export const x = 1;\n");
      execFileSync("git", ["-C", tmp, "init", "--quiet"]);
      execFileSync("git", ["-C", tmp, "add", "-A"]);
      execFileSync(
        "git",
        ["-C", tmp, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "--quiet", "-m", "init"],
      );

      const joined = gitFileAgeProbe(tmp, "web")("src/lib/foo.ts");
      assert.equal(joined.lastTouchDays, 0, "joined path must resolve a fresh commit (age 0)");
      assert.equal(joined.introDays, 0);
      assert.match(joined.resetCommit?.shortSha ?? "", /.+/, "reset commit present");

      const unjoined = gitFileAgeProbe(tmp, "")("src/lib/foo.ts");
      assert.equal(unjoined.lastTouchDays, null, "unjoined path has no history — fails closed (null age)");
      assert.equal(unjoined.introDays, null);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("both gh calls use the same resolved targetRepo value", () => {
    const src = readFileSync(EMIT_SOURCE_PATH, "utf-8");
    const repoArgs = src.match(/"--repo",\s*\n\s*([A-Za-z_]+),/g) ?? [];
    assert.equal(repoArgs.length, 2, "exactly two gh --repo call sites");
    for (const m of repoArgs) assert.match(m, /targetRepo,$/);
  });

  test("a manifest failure resolves appSubdir to empty and nothing is emitted against a guessed path", () => {
    // No manifest at the workspace → ok:false → appSubdir "" (fail closed,
    // mirroring resolveWireOrRetireTargetInputs).
    const ws = mkdtempSync(join(tmpdir(), "target-cleanup-nomanifest-"));
    try {
      process.env.HYDRA_PROJECT_WORKSPACE = ws;
      process.env.TARGET_MANIFEST_ROOT = ws;
      process.env.HYDRA_TARGET_GITHUB_REPO = "example-owner/example-target";
      resetTargetConfig();
      const inputs = resolveTargetCleanupInputs();
      assert.equal(inputs.workspace, ws);
      assert.equal(inputs.appSubdir, "");
      assert.equal(inputs.appDir, ws, "degraded appDir collapses to the bare workspace");

      // End-to-end through the CLI spec: the source read and age probe both
      // miss under the degraded facts, so the planner drops everything —
      // nothing is filed against a guessed path or repo.
      const spec = buildTargetCleanupShellSpec(inputs);
      const view = spec.buildPlan(
        report([{ file: "src/lib/alpha.ts", exports: ["alphaDefault"] }]),
        [],
        "2026-06-10",
      );
      assert.equal(view.items.length, 0, "no item may be emitted under degraded Target facts");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("the shell banner renders the resolved appDir, agreeing with the playbook Target banner", () => {
    const playbook = readFileSync(
      join(REPO_ROOT, "docs", "operator-playbooks", "hydra-target-cleanup.md"),
      "utf-8",
    );
    assert.ok(playbook.includes("Target ($TARGET_APP_DIR)"), "playbook Expected-output banner must stay seam-worded");
    const webSpec = buildTargetCleanupShellSpec({
      workspace: "/w",
      appSubdir: "web",
      appDir: "/w/web",
      targetRepo: "o/r",
    });
    assert.equal(webSpec.banner, "Target (/w/web)");
    const rootSpec = buildTargetCleanupShellSpec({
      workspace: "/w",
      appSubdir: "",
      appDir: "/w",
      targetRepo: "o/r",
    });
    assert.equal(rootSpec.banner, "Target (/w)");
  });

  test("the removed TARGET_ROOT/TARGET_WEB/TARGET_REPO constants stay removed", () => {
    const src = readFileSync(EMIT_SOURCE_PATH, "utf-8");
    assert.ok(
      !/export const (TARGET_ROOT|TARGET_WEB|TARGET_REPO)\b/.test(src),
      "TARGET_ROOT/TARGET_WEB/TARGET_REPO must not return as module-load constants",
    );
  });
});
