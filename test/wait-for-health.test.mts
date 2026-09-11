/**
 * Behavioural tests for scripts/ci/wait-for-health.sh (issue #4238).
 *
 * The helper replaces the `sleep 5` + single un-retried curl that used to be
 * scripts/deploy.sh's post-restart health gate. That fixed window false-redded
 * ~7.5% of master deploys — the service was healthy seconds later, but the job
 * had already exited 1, and because the version stamp sits strictly behind the
 * gate (#3655/#3733) each false red also left prod deployed but untagged.
 *
 * These cases run the REAL script against an ephemeral node:http server so the
 * exit-code contract is exercised end to end, not regex-pinned:
 *
 *   - healthy only after a delay  -> exit 0 within the deadline (the false red
 *                                    this issue removes), with the elapsed /
 *                                    probe-count line and, when the delay
 *                                    exceeded the legacy 5s window, a ::notice::
 *   - healthy immediately         -> exit 0, no ::notice:: (fast is silent)
 *   - never healthy               -> exit 1 at the deadline, last-probe line on
 *                                    stdout: 200 with redis:false, 200 with
 *                                    status:killed, and a closed port
 *
 * The child is spawned ASYNCHRONOUSLY (`spawn`, not `spawnSync`): the server
 * that answers its probes lives in this same process, and a blocking spawn
 * would freeze the event loop the server needs. The helper is deliberately
 * host-agnostic (bash/curl/grep/date only) so exactly this test is possible.
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const HELPER = join(REPO_ROOT, "scripts", "ci", "wait-for-health.sh");

/**
 * Hard ceiling on one helper run. This bounds a HANG, not a slow run — every
 * case below sets a deadline of a few seconds via HYDRA_DEPLOY_HEALTH_TIMEOUT_S,
 * so a healthy child exits long before this; the ceiling only exists so a
 * wedged child fails the suite instead of hanging it (cf. test/_helpers/
 * watchdog-timeouts.mts for the same argument on the watchdog suites).
 */
const SPAWN_CEILING_MS = 60_000;

type RunResult = { status: number | null; stdout: string; stderr: string; timedOut: boolean };

/** Run the helper against `url` with a short deadline / interval. */
function runHelper(url: string, env: Record<string, string>): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("bash", [HELPER, url], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, SPAWN_CEILING_MS);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolvePromise({ status, stdout, stderr, timedOut });
    });
  });
}

/** An ephemeral HTTP server whose reply is decided per request by `respond`. */
type Responder = () => { code: number; body: string };

async function startServer(respond: Responder): Promise<{ server: Server; url: string; hits: () => number }> {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits += 1;
    const { code, body } = respond();
    res.writeHead(code, { "content-type": "application/json" });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("ephemeral server did not bind a TCP port");
  return { server, url: `http://127.0.0.1:${addr.port}/api/health`, hits: () => hits };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((r) => server.close(() => r()));
}

const HEALTHY = JSON.stringify({ status: "ok", redis: true, uptime: 1 });
const HEALTHY_LINE_RE = /==> healthy after (\d+)s \((\d+) probes\)/;

function assertNotTimedOut(r: RunResult, what: string): void {
  assert.equal(
    r.timedOut,
    false,
    `${what} hit the ${SPAWN_CEILING_MS}ms ceiling — a HANG, not an assertion failure. stdout=${r.stdout} stderr=${r.stderr}`,
  );
}

/** Drop whole-line `#` comments so "must NOT appear" checks read executable shell only. */
function shellCodeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

describe("scripts/ci/wait-for-health.sh — bounded post-deploy health poll (#4238)", () => {
  const openServers: Server[] = [];
  afterEach(async () => {
    while (openServers.length > 0) {
      const s = openServers.pop()!;
      await closeServer(s);
    }
  });

  test("the helper exists, is executable, and is bash/curl/grep/date only (no jq, node, systemctl, journalctl)", () => {
    assert.ok(existsSync(HELPER), "scripts/ci/wait-for-health.sh missing");
    const mode = statSync(HELPER).mode & 0o111;
    assert.notEqual(mode, 0, "wait-for-health.sh must be executable");
    // Host-agnostic by design (INV-7): the deploy-side diagnostics (journalctl)
    // live in deploy.sh so this script can run against a local test server.
    const code = shellCodeOnly(readFileSync(HELPER, "utf-8"));
    for (const forbidden of [/\bjq\b/, /\bnode\b/, /\bsystemctl\b/, /\bjournalctl\b/]) {
      assert.doesNotMatch(code, forbidden, `helper must not shell out to ${forbidden}`);
    }
    assert.match(code, /curl /);
    assert.match(code, /grep -q '"status":"ok"'/);
    assert.match(code, /grep -q '"redis":true'/);
  });

  test("a service that becomes healthy only after a delay exits 0 within the deadline, reporting elapsed + probes and a ::notice:: past the legacy 5s window", async () => {
    // The exact false red this issue removes: the old gate probed ONCE at T+5s
    // and exited 1 if that probe missed. Here the service answers 503 for the
    // first 6s (longer than the legacy window), then turns healthy.
    const start = Date.now();
    const { server, url, hits } = await startServer(() =>
      Date.now() - start < 6_000
        ? { code: 503, body: JSON.stringify({ status: "starting", redis: false }) }
        : { code: 200, body: HEALTHY },
    );
    openServers.push(server);

    const r = await runHelper(url, {
      HYDRA_DEPLOY_HEALTH_TIMEOUT_S: "20",
      HYDRA_DEPLOY_HEALTH_INTERVAL_S: "1",
    });
    assertNotTimedOut(r, "delayed-healthy run");
    assert.equal(r.status, 0, `expected exit 0 (late is not red), got ${r.status}; stdout=${r.stdout} stderr=${r.stderr}`);
    const m = HEALTHY_LINE_RE.exec(r.stdout);
    assert.ok(m, `missing healthy line in stdout: ${r.stdout}`);
    assert.ok(Number(m[1]) >= 5, `elapsed should reflect the ~6s delay, got ${m[1]}s`);
    assert.ok(Number(m[2]) >= 2, `should have taken more than one probe, got ${m[2]}`);
    assert.ok(hits() >= 2, `server should have seen multiple probes, saw ${hits()}`);
    // INV-6: lateness is surfaced as a ::notice:: annotation — a diagnostic on
    // stdout, never a non-zero exit code.
    assert.match(r.stdout, /::notice::Service became healthy after \d+s/);
  });

  test("a service that is healthy on the first probe exits 0 immediately with no ::notice::", async () => {
    const { server, url, hits } = await startServer(() => ({ code: 200, body: HEALTHY }));
    openServers.push(server);

    const r = await runHelper(url, {
      HYDRA_DEPLOY_HEALTH_TIMEOUT_S: "10",
      HYDRA_DEPLOY_HEALTH_INTERVAL_S: "1",
    });
    assertNotTimedOut(r, "immediately-healthy run");
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stdout, /==> healthy after \ds \(1 probes\)/);
    assert.doesNotMatch(r.stdout, /::notice::/, "a fast boot must not emit the lateness notice");
    assert.equal(hits(), 1, "the loop must exit on the FIRST healthy probe, not keep polling");
  });

  test("a 200 whose body reports redis:false forever exits 1 at the deadline with the last-probe line", async () => {
    // INV-4: healthy requires BOTH status:ok AND redis:true — the same predicate
    // the watchdog's Check 1 enforces. A curl --retry one-liner could never
    // re-probe on this (it is a 200), which is why the poll is a bash loop.
    const { server, url, hits } = await startServer(() => ({
      code: 200,
      body: JSON.stringify({ status: "ok", redis: false }),
    }));
    openServers.push(server);

    const r = await runHelper(url, {
      HYDRA_DEPLOY_HEALTH_TIMEOUT_S: "3",
      HYDRA_DEPLOY_HEALTH_INTERVAL_S: "1",
    });
    assertNotTimedOut(r, "redis:false run");
    assert.equal(r.status, 1, `expected exit 1 at the deadline, got ${r.status}; stdout=${r.stdout}`);
    assert.match(r.stdout, /==> not healthy after \d+s \(\d+ probes; deadline 3s\)/);
    assert.match(r.stdout, /==> last probe: curl exit 0; body head: .*"redis":false/);
    assert.ok(hits() >= 2, `should have re-probed until the deadline, saw ${hits()} probes`);
  });

  test("a 200 whose body reports status:killed (with redis:true) exits 1 at the deadline", async () => {
    const { server, url } = await startServer(() => ({
      code: 200,
      body: JSON.stringify({ status: "killed", redis: true }),
    }));
    openServers.push(server);

    const r = await runHelper(url, {
      HYDRA_DEPLOY_HEALTH_TIMEOUT_S: "2",
      HYDRA_DEPLOY_HEALTH_INTERVAL_S: "1",
    });
    assertNotTimedOut(r, "status:killed run");
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}; stdout=${r.stdout}`);
    assert.match(r.stdout, /==> last probe: curl exit 0; body head: .*"status":"killed"/);
  });

  test("a closed port (connection refused) exits 1 at the deadline and reports curl's exit code", async () => {
    // Bind then close so the port is known-free: the classic never-listened case.
    const { server, url } = await startServer(() => ({ code: 200, body: HEALTHY }));
    await closeServer(server);

    const r = await runHelper(url, {
      HYDRA_DEPLOY_HEALTH_TIMEOUT_S: "2",
      HYDRA_DEPLOY_HEALTH_INTERVAL_S: "1",
    });
    assertNotTimedOut(r, "closed-port run");
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}; stdout=${r.stdout}`);
    assert.match(r.stdout, /==> not healthy after \d+s/);
    // curl 7 = "Failed to connect"; the body head carries curl's own error text
    // because -sS routes it into the captured output for the diagnostic line.
    assert.match(r.stdout, /==> last probe: curl exit [1-9]\d*; body head: /);
  });
});
