/**
 * Target capability probes (issue #5498, parent #5492).
 *
 * Hermetic: probes a fake Target tree in a temp dir — one that offers every
 * capability, one that offers none — and pins the seam's JSON/--sh contract,
 * the never-throws rule, and the playbook-literal fence (INV-5).
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CAPABILITY_PROBES,
  probeTargetCapabilities,
  renderCapabilityShell,
} from "../scripts/target/target-capabilities.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");

let tmp: string;
let full: string;
let bare: string;

function write(root: string, rel: string, content = "x"): void {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
}

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "target-caps-"));
  full = join(tmp, "full");
  bare = join(tmp, "bare");
  mkdirSync(full);
  mkdirSync(bare);
  write(
    full,
    "package.json",
    JSON.stringify({
      scripts: {
        "e2e:smoke": "playwright test",
        "deadcode:check": "x",
        "deadcode:update-baseline": "x",
        "deadcode:ledger": "x",
      },
    }),
  );
  write(full, "e2e/route-smoke.spec.ts");
  write(full, "docs/adr/0005-design-language.md");
  write(full, "deadcode-baseline.json");
  write(full, "docs/agents/wiring-status.md");
  write(full, "src/app/api/health/route.ts");
  write(full, "CLAUDE.md");
  write(full, "docs/agents/domain.md");
  write(full, "CONTEXT.md");
  write(bare, "package.json", JSON.stringify({ scripts: { test: "x" } }));
});

after(() => rmSync(tmp, { recursive: true, force: true }));

describe("probeTargetCapabilities", () => {
  test("a Target that has everything reports every capability present", () => {
    const caps = probeTargetCapabilities({ workspace: full, appDir: full });
    for (const p of CAPABILITY_PROBES) {
      assert.equal(caps[p.key].ok, true, `${p.key} should be present`);
    }
    assert.deepEqual(caps.e2eSmoke, { ok: true, value: "e2e:smoke" });
    assert.deepEqual(caps.healthRoute, { ok: true, value: "/api/health" });
    assert.deepEqual(caps.deadcodeBaseline, { ok: true, value: "deadcode-baseline.json" });
    assert.deepEqual(caps.wiringLedger, { ok: true, value: "docs/agents/wiring-status.md" });
  });

  test("a Target that has nothing reports every capability absent with a reason", () => {
    const caps = probeTargetCapabilities({ workspace: bare, appDir: bare });
    for (const p of CAPABILITY_PROBES) {
      const c = caps[p.key];
      assert.equal(c.ok, false, `${p.key} should be absent`);
      assert.ok(!c.ok && c.reason.length > 0, `${p.key} carries a reason`);
    }
  });

  test("probing a nonexistent workspace never throws and reports everything absent", () => {
    const caps = probeTargetCapabilities({ workspace: join(tmp, "nope"), appDir: join(tmp, "nope") });
    assert.ok(Object.values(caps).every((c) => c.ok === false));
  });

  test("a nested appSubdir resolves package scripts and the baseline against the app dir", () => {
    const nested = join(tmp, "nested");
    write(nested, "web/package.json", JSON.stringify({ scripts: { "deadcode:check": "x" } }));
    write(nested, "web/deadcode-baseline.json");
    const caps = probeTargetCapabilities({ workspace: nested, appDir: join(nested, "web") });
    assert.deepEqual(caps.deadcodeCheck, { ok: true, value: "deadcode:check" });
    assert.deepEqual(caps.deadcodeBaseline, { ok: true, value: "web/deadcode-baseline.json" });
  });
});

describe("renderCapabilityShell", () => {
  test("present capabilities export their value; absent ones export the empty string", () => {
    const sh = renderCapabilityShell(probeTargetCapabilities({ workspace: bare, appDir: bare }));
    assert.match(sh, /^export TARGET_CAP_E2E_SMOKE=''$/m);
    const shFull = renderCapabilityShell(probeTargetCapabilities({ workspace: full, appDir: full }));
    assert.match(shFull, /^export TARGET_CAP_HEALTH_ROUTE='\/api\/health'$/m);
  });

  test("TARGET_CAPABILITIES_JSON round-trips through shell quoting", () => {
    const caps = probeTargetCapabilities({ workspace: full, appDir: full });
    const line = renderCapabilityShell(caps)
      .split("\n")
      .find((l) => l.startsWith("export TARGET_CAPABILITIES_JSON="))!;
    const json = line.slice("export TARGET_CAPABILITIES_JSON='".length, -1);
    assert.deepEqual(JSON.parse(json), caps);
  });
});

describe("playbook literal fence (INV-5)", () => {
  const FORBIDDEN = [
    /\bweb\//,
    /src\/lib\/providers/,
    /\/api\/health\/full/,
    /e2e:smoke/,
    /deadcode:ledger/,
    /0005-design-language/,
  ];
  const files = [
    "hydra-target-qa.md",
    "hydra-target-cleanup.md",
    "hydra-target-discover.md",
    "hydra-target-incident.md",
    "_fragments/target-seam-preamble.md",
  ].map((f) => join(REPO_ROOT, "docs", "operator-playbooks", f));

  test("no previous-Target layout literal survives in the four playbooks or the preamble", () => {
    const hits: string[] = [];
    for (const f of files) {
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          for (const re of FORBIDDEN) if (re.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 80)}`);
        });
    }
    assert.deepEqual(hits, []);
  });

});
