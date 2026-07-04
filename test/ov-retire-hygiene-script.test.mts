/**
 * Regression tests for scripts/ov-retire-hygiene.sh (issue #2729, epic #2720).
 *
 * When a RETIRE merges, the OpenViking (OV) semantic index must stop surfacing
 * the retired module as live knowledge — otherwise an agent grounding a future
 * cycle gets a high-confidence hit on code that no longer exists. This script is
 * the post-merge hygiene step wired into the RETIRE recipe: it purges the
 * retired path's OV resource entry (DELETE /api/v1/fs) then re-queries the
 * concept (POST /api/v1/search/find) to confirm the index no longer returns it.
 *
 * These tests pin the contract by reading the script as text and asserting the
 * structural properties of the relevant code paths. They do NOT spawn the script
 * against a live OV container (that would require a running hydra-openviking-1
 * with the embedding backend healthy — the script's own OV-unreachable guard
 * covers that case, and CI has no OV instance). The `bash -n` syntax check plus
 * these structural assertions are the mechanical acceptance-criteria verifier.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT_PATH = join(REPO_ROOT, "scripts/ov-retire-hygiene.sh");

function readScript(): string {
  return readFileSync(SCRIPT_PATH, "utf-8");
}

describe("scripts/ov-retire-hygiene.sh — structure & contract (issue #2729)", () => {
  test("the script parses under `bash -n` (no syntax errors)", () => {
    // A broken shell script that ships is worse than none — CI has no OV to
    // catch a runtime error, so pin syntax validity here.
    execFileSync("bash", ["-n", SCRIPT_PATH], { stdio: "pipe" });
  });

  test("the script is executable", () => {
    const mode = statSync(SCRIPT_PATH).mode;
    // owner-execute bit (0o100) must be set so the RETIRE recipe can `bash …`
    // OR `./scripts/ov-retire-hygiene.sh` it unattended.
    assert.ok(mode & 0o100, "ov-retire-hygiene.sh must have the owner-execute bit set");
  });

  test("uses `set -euo pipefail` (fail loud, no silent partial runs)", () => {
    assert.match(
      readScript(),
      /set -euo pipefail/,
      "the script must fail loud per the repo fail-loud convention",
    );
  });

  test("purges the retired URI via DELETE /api/v1/fs with recursive=true", () => {
    const text = readScript();
    assert.match(
      text,
      /DELETE "\$OV_URL\/api\/v1\/fs\?uri=\$\{TARGET_URI\}&recursive=true"/,
      "must DELETE the retired URI recursively (the semantic-queue purge)",
    );
  });

  test("maps a repo-relative --path to viking://resources/<path> (indexerTargetUri convention)", () => {
    const text = readScript();
    assert.match(
      text,
      /TARGET_URI="viking:\/\/resources\/\$\{NORM_PATH\}"/,
      "must map --path to viking://resources/<path>, matching src/knowledge-base/indexer.ts::indexerTargetUri",
    );
  });

  test("verifies the purge by re-querying the concept via POST /api/v1/search/find", () => {
    const text = readScript();
    // The load-bearing path is /api/v1/search/find (NOT the prefix-less form —
    // see the #2586 note in src/knowledge-base/ov-search.ts).
    assert.match(
      text,
      /\/api\/v1\/search\/find/,
      "verification must query the live OV search endpoint",
    );
    assert.match(
      text,
      /LIVE_HITS=/,
      "must extract search-result URIs that still fall under the retired path (live hits)",
    );
  });

  test("exits 2 when a live index entry survives the purge (operator signal)", () => {
    const text = readScript();
    // A distinct exit code (2) distinguishes 'purge ran but an entry survived'
    // from a usage/precondition error (1), so the RETIRE recipe / operator can
    // route the two differently.
    const match = text.match(/if \[ -n "\$LIVE_HITS" \]; then[\s\S]*?exit 2/);
    assert.ok(match, "the LIVE_HITS-remaining branch must exit 2, not 0/1");
  });

  test("guards OV unreachable — exits 1 without touching the repo", () => {
    const text = readScript();
    // The OV-unreachable branch must fail before any DELETE so an offline
    // container never leaves the index half-purged, and never mutates the repo.
    const match = text.match(
      /OpenViking unreachable at \$OV_URL[\s\S]*?exit 1/,
    );
    assert.ok(match, "an unreachable OV must exit 1 (precondition failure) before the purge");
  });

  test("supports a --dry-run that makes no changes", () => {
    const text = readScript();
    assert.match(text, /--dry-run\)\s*DRY_RUN=1/, "must accept --dry-run");
    assert.match(
      text,
      /\[dry-run\] would DELETE/,
      "dry-run must print the DELETE it WOULD do instead of running it",
    );
  });

  test("reads OV url + key from env with the documented defaults", () => {
    const text = readScript();
    assert.match(
      text,
      /OV_URL="\$\{OPENVIKING_URL:-http:\/\/localhost:1933\}"/,
      "OPENVIKING_URL default must match ov-config.ts (localhost:1933)",
    );
    assert.match(
      text,
      /OV_KEY="\$\{OPENVIKING_API_KEY:-/,
      "OPENVIKING_API_KEY must be env-overridable with a default",
    );
  });

  test("requires one of --path or --uri (usage error otherwise)", () => {
    const text = readScript();
    assert.match(
      text,
      /if \[ -z "\$RETIRE_PATH" \] && \[ -z "\$EXPLICIT_URI" \]; then/,
      "must require --path or --uri before doing anything",
    );
  });
});

describe("docs/operator-playbooks/hydra-wire-or-retire.md — RETIRE recipe wires the OV hygiene step (issue #2729)", () => {
  const PLAYBOOK_PATH = join(REPO_ROOT, "docs/operator-playbooks/hydra-wire-or-retire.md");

  function readPlaybook(): string {
    return readFileSync(PLAYBOOK_PATH, "utf-8");
  }

  test("the RETIRE template references the hygiene script as a post-merge step", () => {
    const text = readPlaybook();
    assert.match(
      text,
      /scripts\/ov-retire-hygiene\.sh/,
      "the RETIRE recipe must invoke scripts/ov-retire-hygiene.sh",
    );
    assert.match(
      text,
      /issue #2729/,
      "the OV hygiene step must cite issue #2729 so its provenance is traceable",
    );
  });

  test("the OV hygiene step is documented as POST-MERGE, not a pre-merge/poller step", () => {
    const text = readPlaybook();
    // The issue is explicit: wire the trigger into the RETIRE recipe as a
    // post-merge step rather than a poller.
    assert.match(
      text,
      /POST-MERGE/,
      "the hygiene step must be labelled POST-MERGE so it runs after the module is gone from main",
    );
    assert.match(
      text,
      /NOT a poller/,
      "the step must state it is one-shot, not a poller (per issue #2729)",
    );
  });

  test("the OV hygiene step is an acceptance criterion with a mechanical verifier", () => {
    const text = readPlaybook();
    assert.match(
      text,
      /OV index purged POST-MERGE — verified by:/,
      "the RETIRE acceptance criteria must include the OV-purge criterion with a verified-by assertion",
    );
  });
});
