/**
 * Regression tests for scripts/ci/post-commit-status.ts (issue #4117).
 *
 * The defect: deep-qa-gate posted its verdict with a bare `gh api --method
 * POST /statuses/{sha}` under `set -euo pipefail`. A transient 5xx during a
 * GitHub outage left the REQUIRED check unposted on PR #4116, with the step
 * logging nothing but `exit 1` — and because deep-qa-gate is required for
 * every PR including non-T4 formalities, that froze the merge queue.
 *
 * These cases pin the two properties that fix it: a transient failure is
 * retried, and a terminal one fails fast while naming itself.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
import {
  parseHttpStatus,
  classifyAttempt,
  postWithRetry,
  statusPostArgs,
  RETRY_DELAYS_MS,
  type Attempt,
} from "../scripts/ci/post-commit-status.ts";

function attempt(over: Partial<Attempt> = {}): Attempt {
  return { ok: false, httpStatus: null, stdout: "", stderr: "", ...over };
}

describe("post-commit-status — parseHttpStatus (#4117)", () => {
  test("reads the status out of a REAL gh error body", () => {
    // Measured verbatim against gh 2.96.0. Note `"status"` is a STRING here,
    // which a naive /"status":\s*(\d+)/ would miss.
    const stdout =
      '{"message":"No commit found for SHA: 0000000000000000000000000000000000000000",' +
      '"documentation_url":"https://docs.github.com/rest/commits/statuses#create-a-commit-status",' +
      '"status":"422"}';
    assert.equal(parseHttpStatus(stdout, ""), 422);
  });

  test("falls back to stderr when the body carries no status", () => {
    assert.equal(parseHttpStatus("", "gh: Something broke (HTTP 503)"), 503);
  });

  test("prefers the body over stderr", () => {
    assert.equal(parseHttpStatus('{"status":"500"}', "gh: x (HTTP 422)"), 500);
  });

  test("returns null when NEITHER names a status — the no-response case", () => {
    // This is the shape gh produces on DNS/TLS/connection failure, and the
    // one a status-code-only rule would silently misread as terminal.
    assert.equal(parseHttpStatus("", "dial tcp: lookup api.github.com: no such host"), null);
    // The second measured stderr form names no HTTP code either.
    assert.equal(
      parseHttpStatus("", "gh: Validation failed: State is not included in the list (Validation Failed)"),
      null,
    );
  });
});

describe("post-commit-status — classifyAttempt (#4117)", () => {
  test("a successful POST is posted", () => {
    assert.equal(classifyAttempt(attempt({ ok: true, httpStatus: 200 })), "posted");
  });

  test("every 5xx is retryable — the outage case this issue is about", () => {
    for (const s of [500, 502, 503, 504]) {
      assert.equal(classifyAttempt(attempt({ httpStatus: s })), "retry", `HTTP ${s}`);
    }
  });

  test("429 is retryable — a rate limit is transient", () => {
    assert.equal(classifyAttempt(attempt({ httpStatus: 429 })), "retry");
  });

  test("no response at all is retryable, not terminal", () => {
    assert.equal(classifyAttempt(attempt({ httpStatus: null })), "retry");
  });

  test("403 fails FAST — it is the #860 permissions bug, not an outage", () => {
    assert.equal(classifyAttempt(attempt({ httpStatus: 403 })), "fatal");
  });

  test("422 and 404 fail fast — retrying a bad payload only buries the reason", () => {
    assert.equal(classifyAttempt(attempt({ httpStatus: 422 })), "fatal");
    assert.equal(classifyAttempt(attempt({ httpStatus: 404 })), "fatal");
  });
});

describe("post-commit-status — postWithRetry (#4117)", () => {
  /** Collect the sleeps so the backoff is observable without real waiting. */
  function harness(sequence: Attempt[]) {
    const slept: number[] = [];
    const logs: string[] = [];
    let i = 0;
    return {
      slept,
      logs,
      deps: {
        post: () => sequence[Math.min(i++, sequence.length - 1)],
        sleep: async (ms: number) => {
          slept.push(ms);
        },
        log: (l: string) => logs.push(l),
        delays: [1, 2, 3],
      },
    };
  }

  test("a transient 5xx followed by success is absorbed — the whole point", () => {
    const h = harness([attempt({ httpStatus: 503 }), attempt({ ok: true, httpStatus: 200 })]);
    return postWithRetry(h.deps).then((r) => {
      assert.equal(r.posted, true);
      assert.equal(r.attempts, 2);
      assert.deepEqual(h.slept, [1], "must back off exactly once between the two attempts");
    });
  });

  test("a 403 stops on the FIRST attempt and never sleeps", async () => {
    const h = harness([attempt({ httpStatus: 403, stdout: '{"status":"403"}' })]);
    const r = await postWithRetry(h.deps);
    assert.equal(r.posted, false);
    assert.equal(r.attempts, 1, "a terminal error must not consume the retry budget");
    assert.deepEqual(h.slept, []);
    assert.match(h.logs.join("\n"), /TERMINAL/);
    assert.match(h.logs.join("\n"), /HTTP 403/);
  });

  test("a sustained outage exhausts the budget and reports it, rather than looping forever", async () => {
    const h = harness([attempt({ httpStatus: 503 })]);
    const r = await postWithRetry(h.deps);
    assert.equal(r.posted, false);
    assert.equal(r.attempts, 4, "delays.length + 1 attempts");
    assert.deepEqual(h.slept, [1, 2, 3], "sleeps between attempts, never after the last");
  });

  test("every failed attempt logs its status and body — the #4116 diagnostic gap", () => {
    // The original step logged nothing but `exit 1`, so a 403, a 422 and a 503
    // were byte-identical in CI and had to be told apart by hand.
    const h = harness([attempt({ httpStatus: 503, stdout: '{"status":"503"}', stderr: "gh: boom (HTTP 503)" })]);
    return postWithRetry(h.deps).then(() => {
      const joined = h.logs.join("\n");
      assert.match(joined, /HTTP 503/);
      assert.match(joined, /"status":"503"/);
      assert.match(joined, /gh: boom/);
    });
  });

  test("a no-response failure is retried like a 5xx", async () => {
    const h = harness([attempt({ httpStatus: null }), attempt({ ok: true, httpStatus: 200 })]);
    const r = await postWithRetry(h.deps);
    assert.equal(r.posted, true);
    assert.match(h.logs.join("\n"), /no response/);
  });

  test("INV-4: retry is bounded in BOTH attempt count and wall-clock", () => {
    // The artifact bounds this twice over because the repo has a SINGLE
    // self-hosted runner: a loop that squats holds it and serialize-blocks
    // every other PR's CI and deploy. So an outage must fail fast, not wait.
    const attempts = RETRY_DELAYS_MS.length + 1;
    const total = RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    assert.ok(attempts <= 4, `${attempts} attempts exceeds the INV-4 bound of 4`);
    assert.ok(total <= 60_000, `backoff totals ${total}ms, over the INV-4 ~60s bound`);
    assert.ok(RETRY_DELAYS_MS.length >= 2, "too few retries to absorb a blip");
    assert.deepEqual(
      [...RETRY_DELAYS_MS].sort((a, b) => a - b),
      RETRY_DELAYS_MS,
      "delays must increase monotonically",
    );
  });
});

describe("post-commit-status — statusPostArgs (#4117)", () => {
  test("builds the same call the workflow used to make inline", () => {
    const args = statusPostArgs("o/r", "abc123", "success", "deep-qa-gate", "All good.");
    assert.deepEqual(args, [
      "api",
      "--method",
      "POST",
      "-H",
      "Accept: application/vnd.github+json",
      "/repos/o/r/statuses/abc123",
      "-f",
      "state=success",
      "-f",
      "context=deep-qa-gate",
      "-f",
      "description=All good.",
    ]);
  });

  test("a description with spaces and punctuation is ONE argv entry, never shell-split", () => {
    // The values go through spawnSync's argv, so no quoting is involved and a
    // description can never be re-interpreted as further flags.
    const args = statusPostArgs("o/r", "s", "failure", "deep-qa-gate", "T4 PR missing a marker; see #740");
    assert.equal(args.at(-1), "description=T4 PR missing a marker; see #740");
    assert.equal(args.filter((a) => a === "-f").length, 3);
  });
});

describe("deep-qa-gate.yml — the status POST stays guarded (#4117)", () => {
  // A drift guard, in the same lane as test/ci-test-job-pipefail-guard.test.mts:
  // the workflow is Verifier Core and cannot host its own tests, so the
  // invariant is pinned from a T3 test that runs inside the required `test`
  // job. Without this, a later edit could restore the bare `gh api` and
  // silently reopen the merge-queue freeze.
  const WORKFLOW = readFileSync(
    join(REPO_ROOT, ".github", "workflows", "deep-qa-gate.yml"),
    "utf8",
  );

  test("the commit-status POST goes through the retrying wrapper", () => {
    assert.match(
      WORKFLOW,
      /scripts\/ci\/post-commit-status\.ts/,
      "deep-qa-gate no longer calls the retry wrapper — a transient 5xx would again leave the " +
        "REQUIRED context unposted with no diagnostic (#4117 / PR #4116)",
    );
  });

  test("no bare `gh api` POST to /statuses/ remains in the workflow", () => {
    // The failure mode is specifically an UNGUARDED post: it dies under
    // `set -euo pipefail` after the step has already printed its verdict.
    const bareStatusPost = /gh api[\s\S]{0,200}?\/statuses\//.exec(WORKFLOW);
    assert.equal(
      bareStatusPost,
      null,
      `a direct \`gh api … /statuses/…\` is back in deep-qa-gate.yml: ${bareStatusPost?.[0]}`,
    );
  });

  test("INV-7: a failed status POST does not short-circuit the CheckRun mirror", () => {
    // The two POSTs must be attempted independently. A bare `cmd` under
    // `set -euo pipefail` would abort the step on failure and skip the mirror
    // entirely, so the exit status is captured and re-raised at the END.
    assert.match(
      WORKFLOW,
      /STATUS_POST_RC=0/,
      "the status POST's exit status is no longer captured — a failure would abort the step " +
        "before the CheckRun mirror is attempted (INV-7)",
    );
    assert.match(WORKFLOW, /\|\| STATUS_POST_RC=\$\?/);
    const capture = WORKFLOW.indexOf("STATUS_POST_RC=0");
    const mirror = WORKFLOW.indexOf("Mirroring deep-qa-gate CheckRun");
    const reraise = WORKFLOW.lastIndexOf('"$STATUS_POST_RC" -ne 0');
    assert.ok(capture < mirror, "the status POST must run before the mirror");
    assert.ok(
      mirror < reraise,
      "the re-raise must come AFTER the CheckRun mirror, or the mirror is skipped on failure",
    );
  });

  test("INV-7: a failed status POST still ends the job red", () => {
    // Independence must not become leniency: without the required context the
    // PR cannot merge, so the job must not exit 0.
    assert.match(WORKFLOW, /exit "\$STATUS_POST_RC"/);
  });

  test("INV-2: the CheckRun mirror stays non-fatal — it is advisory, the status is authoritative", () => {
    // Guards the other direction: the mirror must NOT be hardened into a
    // second way to fail the gate. Its own comment says the commit status is
    // the single required primitive.
    assert.match(
      WORKFLOW,
      /check-runs[\s\S]{0,600}?\|\|\s*echo "WARN: deep-qa-gate CheckRun mirror failed/,
      "the CheckRun mirror lost its `|| echo WARN` fallback — an advisory mirror must never fail the gate",
    );
  });
});
