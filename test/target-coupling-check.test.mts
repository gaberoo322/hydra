import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyFile,
  isCommentLine,
  laneFor,
  violationKey,
  pickDistinctiveDependencies,
  HISTORICAL_EXEMPT_RE,
  LANES,
  type Violation,
} from "../scripts/ci/target-coupling-check.ts";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../..");

// Acceptance criterion (issue #731): the check FAILS on a newly-introduced
// hardcoded `hydra-betting` reference in src/. The fatal-vs-advisory split keys
// off whether the match is in code or a comment, so these tests pin that down.
//
// Issue #4412 extends the same classifier to two more lanes (`playbooks`,
// `autopilot`) via the `LANES` table; the lane-specific cases below plant
// in-memory fixture bodies only — nothing is written under src/, docs/, or
// scripts/ for the test.

function names(vs: Violation[]): string[] {
  return vs.map(v => `${v.severity}:${v.token}`);
}

test("catches a hardcoded repo slug in code as a fatal name leak", () => {
  const vs = classifyFile("src/fake.ts", 'const repo = "gaberoo322/hydra-betting";');
  assert.ok(
    vs.some(v => v.severity === "name" && v.token === "gaberoo322/hydra-betting"),
    `expected a fatal name leak, got ${JSON.stringify(names(vs))}`,
  );
});

test("does not double-count the embedded target name inside the repo slug", () => {
  const vs = classifyFile("src/fake.ts", 'const repo = "gaberoo322/hydra-betting";');
  const nameLeaks = vs.filter(v => v.severity === "name");
  assert.equal(nameLeaks.length, 1, `expected exactly one name leak, got ${JSON.stringify(names(vs))}`);
  assert.equal(nameLeaks[0].token, "gaberoo322/hydra-betting");
});

test("catches a bare target name in code", () => {
  const vs = classifyFile("src/fake.ts", 'const t = "hydra-betting";');
  assert.ok(vs.some(v => v.severity === "name" && v.token === "hydra-betting"));
});

test("downgrades a target name in a comment to advisory (non-fatal)", () => {
  const vs = classifyFile("src/fake.ts", " * proxied from hydra-betting today");
  assert.ok(vs.length > 0, "expected the comment mention to be flagged");
  assert.ok(
    vs.every(v => v.severity === "name-comment"),
    `comment mentions must be advisory, got ${JSON.stringify(names(vs))}`,
  );
});

test("flags domain vocab in code as fatal vocab-code", () => {
  const vs = classifyFile("src/fake.ts", 'if (d.includes("kalshi") || d.includes("polymarket")) {}');
  assert.ok(vs.some(v => v.severity === "vocab-code" && v.token === "kalshi"));
  assert.ok(vs.some(v => v.severity === "vocab-code" && v.token === "polymarket"));
});

test("downgrades domain vocab in a comment to advisory", () => {
  const vs = classifyFile("src/fake.ts", "// supports bankroll tracking");
  assert.ok(vs.length > 0);
  assert.ok(vs.every(v => v.severity === "vocab-comment"));
});

test("clean target-agnostic code produces no violations", () => {
  const vs = classifyFile(
    "src/fake.ts",
    "const repo = getTargetGithubRepo();\nconst name = getTargetName();\nconst svc = getTargetServiceName();",
  );
  assert.equal(vs.length, 0, `expected no violations, got ${JSON.stringify(names(vs))}`);
});

test("whole-word matching ignores substrings of unrelated identifiers", () => {
  // `bankroll` is a denylist entry; `bankrolling` is a different identifier.
  const vs = classifyFile("src/fake.ts", "const x = bankrolling + 1;");
  assert.ok(!vs.some(v => v.token === "bankroll"), `false positive on substring: ${JSON.stringify(names(vs))}`);
});

test("isCommentLine recognises //, * and /* prefixes after trimming", () => {
  assert.equal(isCommentLine("  // a line comment"), true);
  assert.equal(isCommentLine(" * jsdoc continuation"), true);
  assert.equal(isCommentLine("/* block open"), true);
  assert.equal(isCommentLine('const x = "// not a comment";'), false);
});

test("violationKey is line-independent (file + token + severity)", () => {
  const a: Violation = { lane: "src", file: "src/x.ts", line: 1, token: "hydra-betting", severity: "name", excerpt: "" };
  const b: Violation = { lane: "src", file: "src/x.ts", line: 99, token: "hydra-betting", severity: "name", excerpt: "" };
  assert.equal(violationKey(a), violationKey(b));
});

test("pickDistinctiveDependencies filters out generic framework deps", () => {
  const deps = ["next", "react", "react-dom", "drizzle-orm", "tailwindcss", "@types/node", "kalshi-api", "some-venue-sdk"];
  const distinctive = pickDistinctiveDependencies(deps);
  // Framework noise dropped...
  for (const generic of ["next", "react", "react-dom", "@types/node"]) {
    assert.ok(!distinctive.includes(generic), `${generic} should be filtered out`);
  }
  // ...target-distinctive packages surface automatically (no allowlist needed).
  assert.ok(distinctive.includes("kalshi-api"));
  assert.ok(distinctive.includes("some-venue-sdk"));
});

// ---------------------------------------------------------------------------
// Issue #4412 — lane table: src / playbooks / autopilot.
// ---------------------------------------------------------------------------

test("LANES table declares exactly src, playbooks and autopilot with their globs", () => {
  assert.deepEqual(LANES.map(l => l.id), ["src", "playbooks", "autopilot"]);
  const byId = new Map(LANES.map(l => [l.id, l]));
  assert.deepEqual(byId.get("src")!.globs, ["src/*.ts", "src/**/*.ts"]);
  assert.deepEqual(byId.get("playbooks")!.globs, [
    "docs/operator-playbooks/*.md",
    "docs/operator-playbooks/**/*.md",
  ]);
  assert.deepEqual(byId.get("autopilot")!.globs, [
    "scripts/autopilot/*.py",
    "scripts/autopilot/*.sh",
    "scripts/autopilot/**/*.py",
    "scripts/autopilot/**/*.sh",
  ]);
  // Every lane names the seam it points authors at.
  for (const lane of LANES) {
    assert.ok(lane.seamHint.length > 0, `${lane.id} lane has no seam hint`);
  }
});

test(".claude/skills is never a lane (skills are regenerated playbook artifacts)", () => {
  for (const lane of LANES) {
    for (const glob of lane.globs) {
      assert.ok(!glob.startsWith(".claude"), `${lane.id} lane scans ${glob}`);
    }
  }
});

test("laneFor infers the lane from the path and falls back to src", () => {
  assert.equal(laneFor("docs/operator-playbooks/hydra-dev.md"), "playbooks");
  assert.equal(laneFor("docs/operator-playbooks/_fragments/target-seam-preamble.md"), "playbooks");
  assert.equal(laneFor("scripts/autopilot/decide.py"), "autopilot");
  assert.equal(laneFor("scripts/autopilot/hooks/on-subagent-tool-call.sh"), "autopilot");
  assert.equal(laneFor("src/fake.ts"), "src");
  assert.equal(laneFor("src/scheduler/heartbeat.ts"), "src");
  // Unknown trees fall back to src so pre-existing fixture calls keep meaning.
  assert.equal(laneFor("somewhere/else.ts"), "src");
});

test("classifyFile stamps the inferred lane and accepts an explicit lane override", () => {
  const inferred = classifyFile("docs/operator-playbooks/fake.md", "cd ~/hydra-betting");
  assert.ok(inferred.length > 0);
  assert.ok(inferred.every(v => v.lane === "playbooks"));

  // Explicit lane wins over path inference (same body, src rules → TS comment
  // heuristic makes a `//` line advisory).
  const overridden = classifyFile("docs/operator-playbooks/fake.md", "// see hydra-betting", "src");
  assert.ok(overridden.length > 0);
  assert.ok(overridden.every(v => v.lane === "src" && v.severity === "name-comment"));
});

test("playbooks lane: a bare prose target mention is fatal-class (name)", () => {
  // Acceptance criterion 2 (issue #4412): planting `~/hydra-betting` in a
  // playbook line WITHOUT `Historical:` fails the check.
  const vs = classifyFile(
    "docs/operator-playbooks/fake.md",
    "Run the build from ~/hydra-betting/web before opening the PR.",
  );
  assert.ok(
    vs.some(v => v.lane === "playbooks" && v.severity === "name" && v.token === "hydra-betting"),
    `expected a fatal playbooks name leak, got ${JSON.stringify(names(vs))}`,
  );
});

test("playbooks lane: prose and fenced code are both fatal (no comment context)", () => {
  const body = [
    "Some prose that mentions kalshi markets.",
    "```bash",
    'gh pr list --repo gaberoo322/hydra-betting',
    "```",
    "<!-- an html comment naming polymarket -->",
  ].join("\n");
  const vs = classifyFile("docs/operator-playbooks/fake.md", body);
  assert.ok(vs.length >= 3, `expected three matches, got ${JSON.stringify(names(vs))}`);
  assert.ok(
    vs.every(v => v.severity === "name" || v.severity === "vocab-code"),
    `every playbook match must be fatal-class, got ${JSON.stringify(names(vs))}`,
  );
  assert.equal(isCommentLine("<!-- an html comment -->", "playbooks"), false);
  assert.equal(isCommentLine("// not a comment in markdown", "playbooks"), false);
});

test("playbooks lane: a `> Historical:` provenance line produces zero violations", () => {
  // Acceptance criterion 2 (issue #4412): with the prefix, the check passes.
  const vs = classifyFile(
    "docs/operator-playbooks/fake.md",
    "> Historical: step 1 shipped as hydra-betting PR #93 — kept for provenance only.",
  );
  assert.equal(vs.length, 0, `Historical: line must be skipped, got ${JSON.stringify(names(vs))}`);
});

test("playbooks lane: the Historical allow tolerates bare, blockquote, nested-blockquote and list-item forms", () => {
  for (const line of [
    "Historical: hydra-betting PR #93",
    "> Historical: hydra-betting PR #93",
    ">> Historical: hydra-betting PR #93",
    "  > Historical: hydra-betting PR #93",
    "- Historical: hydra-betting PR #93",
    "* Historical: hydra-betting PR #93",
    "> - Historical: hydra-betting PR #93",
  ]) {
    assert.ok(HISTORICAL_EXEMPT_RE.test(line), `regex should exempt ${JSON.stringify(line)}`);
    assert.equal(classifyFile("docs/operator-playbooks/fake.md", line).length, 0, `should skip ${JSON.stringify(line)}`);
  }
  // `Historical:` not at the head of the line is NOT the allow.
  for (const line of [
    "See the Historical: note on hydra-betting",
    "`Historical:` hydra-betting",
    "Historically hydra-betting was the target",
  ]) {
    assert.ok(!HISTORICAL_EXEMPT_RE.test(line), `regex must not exempt ${JSON.stringify(line)}`);
    assert.ok(classifyFile("docs/operator-playbooks/fake.md", line).length > 0, `should flag ${JSON.stringify(line)}`);
  }
});

test("playbooks lane: the Historical allow is line-level, never file-level", () => {
  const body = [
    "> Historical: this shipped as hydra-betting PR #93.",
    "",
    "Now run the build from ~/hydra-betting/web.",
  ].join("\n");
  const vs = classifyFile("docs/operator-playbooks/fake.md", body);
  assert.equal(vs.length, 1, `only the non-Historical line should match, got ${JSON.stringify(vs)}`);
  assert.equal(vs[0].line, 3);
  assert.equal(vs[0].severity, "name");
});

test("Historical: allow never applies in the src or autopilot lanes", () => {
  // In code lanes a `Historical:`-prefixed string literal is still a real leak.
  const py = classifyFile("scripts/autopilot/reap.py", 'note = "Historical: hydra-betting"');
  assert.ok(py.some(v => v.lane === "autopilot" && v.severity === "name"), `autopilot: ${JSON.stringify(names(py))}`);
  const ts = classifyFile("src/fake.ts", 'const note = "Historical: hydra-betting";');
  assert.ok(ts.some(v => v.lane === "src" && v.severity === "name"), `src: ${JSON.stringify(names(ts))}`);
  // And a bare `Historical:` prose line in a code lane is only advisory when
  // it is a real comment — never silently skipped.
  const pyComment = classifyFile("scripts/autopilot/reap.py", "# Historical: hydra-betting");
  assert.ok(pyComment.length > 0 && pyComment.every(v => v.severity === "name-comment"));
});

test("autopilot lane: a domain-vocab path string in decide.py is fatal vocab-code", () => {
  // Acceptance criterion 3 (issue #4412).
  const vs = classifyFile(
    "scripts/autopilot/decide.py",
    'WIRE_OR_RETIRE_RISK_CARVEOUT = ("web/src/lib/kalshi/", "web/src/lib/execution/")',
  );
  assert.ok(
    vs.some(v => v.lane === "autopilot" && v.severity === "vocab-code" && v.token === "kalshi"),
    `expected fatal vocab-code, got ${JSON.stringify(names(vs))}`,
  );
});

test("autopilot lane: a hardcoded env fallback in a shell script is a fatal name leak", () => {
  // The shell `:-` default operator abuts the slug with a `-`, which the
  // whole-word lookbehind treats as an identifier character — so the slug
  // regex does not anchor and the embedded bare `hydra-betting` fires instead.
  // Either way the line is a FATAL name leak (that is what the ratchet needs);
  // this pins the outcome, not the token the pre-existing matcher picks.
  const vs = classifyFile(
    "scripts/autopilot/collect-state.sh",
    'TARGET_GH_REPO="${HYDRA_TARGET_GITHUB_REPO:-gaberoo322/hydra-betting}"',
  );
  const fatal = vs.filter(v => v.lane === "autopilot" && v.severity === "name");
  assert.equal(fatal.length, 1, `expected exactly one fatal name leak, got ${JSON.stringify(names(vs))}`);
  assert.equal(fatal[0].token, "hydra-betting");

  // With ordinary whitespace around it the slug itself is reported, once.
  const plain = classifyFile("scripts/autopilot/reap_ghrefs.py", 'TARGET_REPO = os.environ.get("HYDRA_TARGET_GITHUB_REPO", "gaberoo322/hydra-betting")');
  const plainFatal = plain.filter(v => v.severity === "name");
  assert.equal(plainFatal.length, 1, "repo slug must not double-count its embedded name");
  assert.equal(plainFatal[0].token, "gaberoo322/hydra-betting");
});

test("autopilot lane: a `#` comment mention is advisory (name-comment / vocab-comment)", () => {
  const sh = classifyFile(
    "scripts/autopilot/collect-state.sh",
    "# Target repo (gaberoo322/hydra-betting). Parity with the orch block above.",
  );
  assert.ok(sh.length > 0);
  assert.ok(sh.every(v => v.lane === "autopilot" && v.severity === "name-comment"), JSON.stringify(names(sh)));

  const py = classifyFile("scripts/autopilot/decide.py", "    # kalshi carve-out handled below");
  assert.ok(py.length > 0);
  assert.ok(py.every(v => v.severity === "vocab-comment"), JSON.stringify(names(py)));

  // Shebang lines are `#`-prefixed too.
  assert.equal(isCommentLine("#!/usr/bin/env bash", "autopilot"), true);
  assert.equal(isCommentLine("  # indented", "autopilot"), true);
  assert.equal(isCommentLine('x = "# not a comment"', "autopilot"), false);
  // TS comment markers mean nothing in a .py/.sh file.
  assert.equal(isCommentLine("// not a python comment", "autopilot"), false);
});

test("autopilot lane: docstring and heredoc bodies classify as code (stricter-is-safer)", () => {
  const docstring = classifyFile(
    "scripts/autopilot/reap_stall.py",
    ['"""', "Reap a stalled dev_target slot on hydra-betting.", '"""'].join("\n"),
  );
  assert.ok(docstring.some(v => v.severity === "name"), `docstring: ${JSON.stringify(names(docstring))}`);

  const heredoc = classifyFile(
    "scripts/autopilot/collect-state.sh",
    ["cat <<'EOF'", "board: gaberoo322/hydra-betting", "EOF"].join("\n"),
  );
  assert.ok(heredoc.some(v => v.severity === "name"), `heredoc: ${JSON.stringify(names(heredoc))}`);
});

test("token lists are shared verbatim across lanes and claw-street-bets is not denylisted", () => {
  // HARD literals + vocab match identically in every lane.
  for (const [file, lane] of [
    ["src/fake.ts", "src"],
    ["docs/operator-playbooks/fake.md", "playbooks"],
    ["scripts/autopilot/fake.py", "autopilot"],
  ] as const) {
    const vs = classifyFile(file, "x gaberoo322/hydra-betting y polymarket z bankroll", lane);
    const tokens = vs.map(v => v.token).sort();
    assert.deepEqual(tokens, ["bankroll", "gaberoo322/hydra-betting", "polymarket"], `${lane}: ${JSON.stringify(tokens)}`);
    assert.ok(vs.every(v => v.lane === lane));
    // The successor Target's identity is NOT on the denylist — the seam, not a
    // longer denylist, is the fix (ADR-0013 CSB amendment).
    const csb = classifyFile(file, "repo = gaberoo322/claw-street-bets; name = claw-street-bets", lane);
    assert.equal(csb.length, 0, `${lane}: claw-street-bets must not be denylisted`);
  }
});

test("violationKey is lane-prefixed uniformly: lane::file::token::severity", () => {
  const src: Violation = { lane: "src", file: "src/x.ts", line: 1, token: "hydra-betting", severity: "name", excerpt: "" };
  const pb: Violation = { lane: "playbooks", file: "docs/operator-playbooks/x.md", line: 1, token: "kalshi", severity: "vocab-code", excerpt: "" };
  const ap: Violation = { lane: "autopilot", file: "scripts/autopilot/x.sh", line: 7, token: "hydra-betting", severity: "name-comment", excerpt: "" };
  assert.equal(violationKey(src), "src::src/x.ts::hydra-betting::name");
  assert.equal(violationKey(pb), "playbooks::docs/operator-playbooks/x.md::kalshi::vocab-code");
  assert.equal(violationKey(ap), "autopilot::scripts/autopilot/x.sh::hydra-betting::name-comment");
  // Same file+token+severity under a different lane is a different key.
  assert.notEqual(violationKey(src), violationKey({ ...src, lane: "autopilot" }));
});

test("baseline is one flat sorted list of lane-prefixed keys and stays 'Target state: empty'", () => {
  const raw = readFileSync(join(REPO_ROOT, "scripts/ci/target-coupling-baseline.json"), "utf8");
  const parsed = JSON.parse(raw) as { violations: string[]; note: string };
  assert.ok(Array.isArray(parsed.violations));
  assert.deepEqual(parsed.violations, [...parsed.violations].sort(), "baseline must be sorted");
  assert.equal(new Set(parsed.violations).size, parsed.violations.length, "baseline must be deduplicated");
  const laneIds = new Set(LANES.map(l => l.id));
  for (const key of parsed.violations) {
    const parts = key.split("::");
    assert.equal(parts.length, 4, `key ${key} must be lane::file::token::severity`);
    assert.ok(laneIds.has(parts[0] as (typeof LANES)[number]["id"]), `key ${key} names an unknown lane`);
  }
  assert.match(parsed.note, /Target state: empty/);
});

test("no workflow file is created for the coupling check (advisory-checks.yml is the only host)", () => {
  // INV-11 (issue #4412): the check already runs from advisory-checks.yml; a
  // second workflow would double-run the same script.
  assert.equal(existsSync(join(REPO_ROOT, ".github/workflows/target-coupling-check.yml")), false);
  const advisory = readFileSync(join(REPO_ROOT, ".github/workflows/advisory-checks.yml"), "utf8");
  assert.ok(advisory.includes("npx tsx scripts/ci/target-coupling-check.ts"));
  assert.ok(advisory.includes("npx tsx scripts/ci/target-coupling-check.ts --self-test"));
});
