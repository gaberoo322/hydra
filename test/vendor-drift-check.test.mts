/**
 * scripts/ci/vendor-drift-check.ts — vendored-base staleness + orphaned
 * excision detection (issue #3994, epic #3988).
 *
 * The load-bearing case is `collectSupersedes` finding a NON-ZERO number of
 * entries against the live playbooks. The first implementation used
 * `/^supersedes:\s*$([\s\S]*?)(?=^\S|\Z)/m` and silently returned an empty
 * list — `\Z` is not a JavaScript anchor (it matches a literal "Z"), so the
 * lookahead never fired when the block ended the frontmatter. A checker that
 * collects nothing reports "every entry resolves" and looks perfectly healthy,
 * which is the exact failure class this check exists to catch.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  collectSupersedes,
  headingsOf,
  bodyOf,
  readInstalledPluginSha,
  check,
} from "../scripts/ci/vendor-drift-check.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");

describe("vendor-drift-check — supersedes collection (issue #3994)", () => {
  test("finds every supersedes entry in the LIVE playbooks — a zero count means the parser is broken, not that the repo is clean", () => {
    const found = collectSupersedes(join(REPO_ROOT, "docs", "operator-playbooks"));
    assert.ok(
      found.length > 0,
      "the live repo has composing playbooks WITH supersedes entries — collecting zero means the parser silently failed",
    );
    for (const entry of found) {
      assert.ok(entry.playbook.endsWith(".md"), "each entry names its playbook");
      assert.ok(entry.base.length > 0, "each entry names the base it targets");
      assert.ok(entry.heading.startsWith("#"), `heading should retain its hashes: ${entry.heading}`);
    }
  });

  test("parses a block sequence that ENDS the frontmatter (the case the \\Z regex missed)", () => {
    const dir = mkdtempSync(join(tmpdir(), "vendor-drift-fm-"));
    try {
      writeFileSync(
        join(dir, "ov.md"),
        '---\nname: ov\ncompose_base: _vendor/b.md\nsupersedes:\n  - "### One"\n  - "### Two"\n---\n\nbody\n',
      );
      const found = collectSupersedes(dir);
      assert.equal(found.length, 2, "both entries must be collected when the block is the LAST frontmatter key");
      assert.deepEqual(found.map(f => f.heading), ["### One", "### Two"]);
      assert.equal(found[0].base, "b.md", "the _vendor/ prefix is stripped to a bare filename");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a sibling key after the block ends it — later keys are not swallowed as entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "vendor-drift-sib-"));
    try {
      writeFileSync(
        join(dir, "ov.md"),
        '---\nname: ov\ncompose_base: _vendor/b.md\nsupersedes:\n  - "### One"\nclaude_only: true\n---\n\nbody\n',
      );
      const found = collectSupersedes(dir);
      assert.equal(found.length, 1, "only the real entry is collected");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a playbook without compose_base contributes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "vendor-drift-nc-"));
    try {
      writeFileSync(join(dir, "plain.md"), "---\nname: plain\ndescription: d\n---\n\nbody\n");
      assert.deepEqual(collectSupersedes(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("vendor-drift-check — drift findings (issue #3994)", () => {
  function makeRepo(): { dir: string; vendor: string; playbooks: string; manifest: string } {
    const dir = mkdtempSync(join(tmpdir(), "vendor-drift-repo-"));
    const playbooks = join(dir, "docs", "operator-playbooks");
    const vendor = join(playbooks, "_vendor");
    mkdirSync(vendor, { recursive: true });
    writeFileSync(
      join(vendor, "b.md"),
      "---\nname: b\ndescription: d\n---\n\n### Keep me\n\nkeep\n\n### Excise me\n\ngone\n",
    );
    const manifest = join(vendor, "provenance.json");
    writeFileSync(
      manifest,
      JSON.stringify({
        bases: {
          "b.md": { skill: "b", capturedAt: "2026-01-01", upstreamSha: "abc123def", shaStatus: "verified" },
        },
      }),
    );
    return { dir, vendor, playbooks, manifest };
  }

  test("an unresolved supersedes heading is reported — the guard that stops a refresh un-suppressing an instruction", () => {
    const r = makeRepo();
    try {
      writeFileSync(
        join(r.playbooks, "ov.md"),
        '---\nname: ov\ncompose_base: _vendor/b.md\nsupersedes:\n  - "### Renamed upstream"\n---\n\nbody\n',
      );
      const findings = check({
        vendorDir: r.vendor,
        playbookDir: r.playbooks,
        manifestPath: r.manifest,
        registryPath: join(r.dir, "no-registry.json"),
      });
      const unresolved = findings.filter(f => f.kind === "supersedes-unresolved");
      assert.equal(unresolved.length, 1, "the orphaned excision must be reported");
      assert.match(unresolved[0].detail, /Renamed upstream/);
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  test("a resolving supersedes heading produces NO unresolved finding", () => {
    const r = makeRepo();
    try {
      writeFileSync(
        join(r.playbooks, "ov.md"),
        '---\nname: ov\ncompose_base: _vendor/b.md\nsupersedes:\n  - "### Excise me"\n---\n\nbody\n',
      );
      const findings = check({
        vendorDir: r.vendor,
        playbookDir: r.playbooks,
        manifestPath: r.manifest,
        registryPath: join(r.dir, "no-registry.json"),
      });
      assert.equal(findings.filter(f => f.kind === "supersedes-unresolved").length, 0);
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  test("a vendored base with no provenance entry is reported", () => {
    const r = makeRepo();
    try {
      writeFileSync(join(r.vendor, "orphan.md"), "---\nname: orphan\ndescription: d\n---\n\nbody\n");
      const findings = check({
        vendorDir: r.vendor,
        playbookDir: r.playbooks,
        manifestPath: r.manifest,
        registryPath: join(r.dir, "no-registry.json"),
      });
      assert.equal(findings.filter(f => f.kind === "unmanifested-base").length, 1);
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  test("a missing plugin registry degrades to a skip-with-warning, never a throw", () => {
    const r = makeRepo();
    try {
      const findings = check({
        vendorDir: r.vendor,
        playbookDir: r.playbooks,
        manifestPath: r.manifest,
        registryPath: join(r.dir, "definitely-absent.json"),
      });
      assert.equal(
        findings.filter(f => f.kind === "plugin-not-installed").length,
        1,
        "an absent registry is an expected state (the operator has not installed the plugin), not a failure",
      );
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  test("readInstalledPluginSha returns null for an absent or malformed registry rather than throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "vendor-drift-reg-"));
    try {
      assert.equal(readInstalledPluginSha(join(dir, "nope.json")), null);
      const bad = join(dir, "bad.json");
      writeFileSync(bad, "{ not json");
      assert.equal(readInstalledPluginSha(bad), null);
      const noPlugin = join(dir, "other.json");
      writeFileSync(noPlugin, JSON.stringify({ plugins: { "vercel@x": [{ gitCommitSha: "deadbeef" }] } }));
      assert.equal(readInstalledPluginSha(noPlugin), null, "an unrelated plugin must not be mistaken for the skills plugin");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("vendor-drift-check — helpers (issue #3994)", () => {
  test("headingsOf strips hashes and ignores non-heading lines", () => {
    assert.deepEqual(headingsOf("# A\ntext\n### B c\n#notaheading\n"), ["A", "B c"]);
  });

  test("bodyOf strips frontmatter and returns null when it is malformed", () => {
    assert.equal(bodyOf("---\nname: x\n---\nbody\n"), "body\n");
    assert.equal(bodyOf("no frontmatter here"), null);
  });
});
