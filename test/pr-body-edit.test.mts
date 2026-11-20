import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  PR_BODY_REPO,
  defaultPrBodyEditDeps,
  main,
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

describe("pr-body-edit defaultPrBodyEditDeps passes --repo on every gh call (INV-5)", () => {
  test("viewBody and editBody argv both carry --repo <PR_BODY_REPO>", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pr-body-edit-gh-"));
    const log = join(dir, "argv.log");
    const fake = join(dir, "gh");
    writeFileSync(fake, `#!/bin/sh\necho "$@" >> "${log}"\necho '{"body":"x Closes #1"}'\n`);
    chmodSync(fake, 0o755);
    const prev = process.env.HYDRA_GH_BIN;
    process.env.HYDRA_GH_BIN = fake;
    try {
      const deps = defaultPrBodyEditDeps();
      assert.equal(await deps.viewBody(7), "x Closes #1");
      assert.equal(await deps.editBody(7, "b.md"), true);
      const lines = readFileSync(log, "utf8").trim().split("\n");
      assert.deepEqual(lines, [
        `pr view 7 --repo ${PR_BODY_REPO} --json body`,
        `pr edit 7 --repo ${PR_BODY_REPO} --body-file b.md`,
      ]);
    } finally {
      if (prev === undefined) delete process.env.HYDRA_GH_BIN;
      else process.env.HYDRA_GH_BIN = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("readBodyFile returns null for a missing file (sibling: a real file reads back)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pr-body-edit-rd-"));
    try {
      const f = join(dir, "b.md");
      writeFileSync(f, "hello Closes #1");
      const deps = defaultPrBodyEditDeps();
      assert.equal(deps.readBodyFile(f), "hello Closes #1");
      assert.equal(deps.readBodyFile(join(dir, "missing.md")), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pr-body-edit main exit codes and single JSON line (INV-6)", () => {
  test("usage error returns 2 and prints no JSON on stdout", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a: unknown[]) => void logs.push(a.join(" "));
    console.error = () => {};
    try {
      assert.equal(await main([]), 2);
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    assert.deepEqual(logs, []);
  });

  test("a refusal exits 1 with exactly one JSON line on stdout; run as a script", () => {
    const dir = mkdtempSync(join(tmpdir(), "pr-body-edit-main-"));
    try {
      const empty = join(dir, "empty.md");
      writeFileSync(empty, "");
      const script = join(import.meta.dirname, "..", "scripts", "pr-body-edit.ts");
      const r = spawnSync(
        process.execPath,
        ["--experimental-strip-types", script, "9", "--body-file", empty, "--anchor", "5615"],
        { encoding: "utf8", env: { ...process.env, HYDRA_GH_BIN: "/nonexistent-gh" } },
      );
      assert.equal(r.status, 1, r.stderr);
      const lines = r.stdout.trim().split("\n").filter((l) => l.startsWith("{"));
      assert.equal(lines.length, 1);
      const parsed = JSON.parse(lines[0]);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.code, "empty-body");
      assert.equal(parsed.pr, 9);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
