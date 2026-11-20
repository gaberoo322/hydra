import test, { describe } from "node:test";
import assert from "node:assert/strict";
import {
  parsePrBodyEditArgs,
  runPrBodyEdit,
  type PrBodyEditDeps,
} from "../scripts/pr-body-edit.ts";

function makeDeps(over: Partial<PrBodyEditDeps> & { body?: string | null; live?: string | null } = {}) {
  const calls = { edit: 0, view: 0 };
  const deps: PrBodyEditDeps = {
    readBodyFile: () => (over.body === undefined ? "Summary\n\nCloses #5615\n" : over.body),
    viewBody: async () => {
      calls.view++;
      return over.live === undefined ? "old\n\nCloses #5615\n" : over.live;
    },
    editBody:
      over.editBody ??
      (async () => {
        calls.edit++;
        return true;
      }),
    reconcile: over.reconcile ?? (async () => ({ outcome: "skip", why: "test" })),
  };
  return { deps, calls };
}

describe("pr-body-edit args", () => {
  test("parses pr, body file and anchor forms", () => {
    assert.deepEqual(parsePrBodyEditArgs(["5635", "--body-file", "b.md", "--anchor", "issue-5615"]), {
      kind: "edit",
      pr: 5635,
      bodyFile: "b.md",
      anchor: 5615,
    });
  });
  test("usage errors on missing pieces", () => {
    assert.equal(parsePrBodyEditArgs(["--body-file", "b.md"]).kind, "error");
    assert.equal(parsePrBodyEditArgs(["5635"]).kind, "error");
    assert.equal(parsePrBodyEditArgs(["5635", "--body-file", "b", "--anchor", "x"]).kind, "error");
  });
});

describe("pr-body-edit refusals leave the live body unchanged", () => {
  for (const body of [null, "", "  \n\t\n"]) {
    test(`empty-body for ${JSON.stringify(body)}`, async () => {
      const { deps, calls } = makeDeps({ body });
      const r = await runPrBodyEdit({ pr: 1, bodyFile: "f", anchor: 5615 }, deps);
      assert.equal(r.ok === false && r.code, "empty-body");
      assert.equal(calls.edit, 0);
    });
  }

  test("closing-ref-missing when the new body dropped Closes", async () => {
    const { deps, calls } = makeDeps({ body: "no ref here" });
    const r = await runPrBodyEdit({ pr: 1, bodyFile: "f", anchor: 5615 }, deps);
    assert.equal(r.ok === false && r.code, "closing-ref-missing");
    assert.equal(calls.edit, 0);
  });

  test("closing-ref-missing when the new body names a different issue", async () => {
    const { deps, calls } = makeDeps({ body: "Closes #9" });
    const r = await runPrBodyEdit({ pr: 1, bodyFile: "f", anchor: 5615 }, deps);
    assert.equal(r.ok === false && r.code, "closing-ref-missing");
    assert.equal(calls.edit, 0);
  });

  test("anchor-unresolvable with no flag and no live closing ref", async () => {
    const { deps, calls } = makeDeps({ live: "" });
    const r = await runPrBodyEdit({ pr: 1, bodyFile: "f", anchor: null }, deps);
    assert.equal(r.ok === false && r.code, "anchor-unresolvable");
    assert.equal(calls.edit, 0);
  });

  test("gh-failed when the live body cannot be read", async () => {
    const { deps, calls } = makeDeps({ live: null });
    const r = await runPrBodyEdit({ pr: 1, bodyFile: "f", anchor: null }, deps);
    assert.equal(r.ok === false && r.code, "gh-failed");
    assert.equal(calls.edit, 0);
  });

  test("reconcile-violation refuses; a skip outcome never blocks", async () => {
    const bad = makeDeps({
      reconcile: async () => ({ outcome: "violation", anchorRef: 5615, message: "nope" }),
    });
    const r = await runPrBodyEdit({ pr: 1, bodyFile: "f", anchor: 5615 }, bad.deps);
    assert.equal(r.ok === false && r.code, "reconcile-violation");
    assert.equal(bad.calls.edit, 0);
    const skip = makeDeps();
    assert.equal((await runPrBodyEdit({ pr: 1, bodyFile: "f", anchor: 5615 }, skip.deps)).ok, true);
  });

  test("gh-failed when the edit itself fails", async () => {
    const { deps } = makeDeps({ editBody: async () => false });
    const r = await runPrBodyEdit({ pr: 1, bodyFile: "f", anchor: 5615 }, deps);
    assert.equal(r.ok === false && r.code, "gh-failed");
  });
});

describe("pr-body-edit success", () => {
  test("explicit anchor wins and the edit runs once", async () => {
    const { deps, calls } = makeDeps();
    const r = await runPrBodyEdit({ pr: 5635, bodyFile: "f", anchor: 5615 }, deps);
    assert.equal(r.ok && r.anchor, 5615);
    assert.equal(calls.edit, 1);
    assert.equal(calls.view, 0);
  });

  test("anchor falls back to the live body's closing ref and is echoed", async () => {
    const { deps, calls } = makeDeps();
    const r = await runPrBodyEdit({ pr: 5635, bodyFile: "f", anchor: null }, deps);
    assert.equal(r.ok && r.anchor, 5615);
    assert.equal(calls.view, 1);
    assert.equal(calls.edit, 1);
  });
});
