/**
 * test/skill-prune-select.test.mts — pins the hydra-skill-prune pick
 * (scripts/skill-prune/select-skill.ts): largest-over-baseline first, else
 * least-recently-pruned, else alphabetically first; plus the ledger stamp.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const { pickSkill, stampSkill, readLedger, ledgerPath } = await import("../scripts/skill-prune/select-skill.ts");

const P = (n: string) => `docs/operator-playbooks/${n}`;
const baseline = { [P("hydra-a.md")]: 100, [P("hydra-b.md")]: 100, [P("hydra-c.md")]: 100 };

describe("skill-prune select", () => {
  test("picks the largest over-baseline delta", () => {
    const current = { [P("hydra-a.md")]: 110, [P("hydra-b.md")]: 150, [P("hydra-c.md")]: 100 };
    assert.equal(pickSkill(current, baseline, {}), "hydra-b.md");
  });

  test("steady state picks the least-recently-pruned playbook", () => {
    assert.equal(pickSkill(baseline, baseline, { "hydra-a.md": 30, "hydra-b.md": 10, "hydra-c.md": 20 }), "hydra-b.md");
  });

  test("missing ledger starts at the alphabetically first playbook; fragments are never picked", () => {
    const current = { ...baseline, [P("_fragments/aaa.md")]: 5, [P("README.md")]: 5 };
    assert.equal(pickSkill(current, baseline, {}), "hydra-a.md");
  });

  test("stamp writes the epoch under HYDRA_STATE_DIR and later picks move on", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "skill-prune-"));
    const file = ledgerPath({ HYDRA_STATE_DIR: dir });
    assert.equal(file, path.join(dir, "hydra-skill-prune-rotation.json"));
    await stampSkill("hydra-a.md", file, 1234);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { "hydra-a.md": 1234 });
    assert.equal(pickSkill(baseline, baseline, await readLedger(file)), "hydra-b.md");
  });
});
