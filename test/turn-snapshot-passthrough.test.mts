/**
 * Turn Snapshot — HTTP-passthrough collectors (ADR-0043 slice 5, #4933).
 *
 * All at the TS interface: no `hydra`, `systemctl`, `python3` or network.
 *
 * 1. GOLDEN (ADR-0043 Decision 4): every file under
 *    test/fixtures/turn-snapshot/passthrough/ was captured by running the OLD
 *    bash collectors (collect_health, collect_direction_drift,
 *    collect_scout_alerts, collect_realm_share, collect_usage_eligibility,
 *    collect_emergency_brake, collect_class_stats, collect_capacity,
 *    collect_scheduler, collect_recommendations, collect_slot_events) at the
 *    slice's base SHA through the real `hydra` CLI against a local HTTP server
 *    serving the fixture — failure paths (HTTP 500, transport error, HTML
 *    body, 404, unparseable/mis-shaped payloads) included. Each is replayed
 *    through the real CLI `main` (`--format values`) + the production hydra
 *    HTTP client over a fake transport: the TYPED values (`expected.values`,
 *    captured while the retired kv wire still matched the bash byte for
 *    byte, #4934), the stderr-note set exactly, and the set of data-plane
 *    paths read.
 *
 * 2. PORTED behavioural cases: the three slot_events_json cases that lived in
 *    test/autopilot-hooks.test.mts (#4510), 1:1 at the collector interface.
 *
 * 3. Interface cases for the new seams (HTTP client semantics, Python
 *    formatting, env precedence, fail-open runner).
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { main, parseArgs, type CliDeps } from "../scripts/autopilot/turn-snapshot.ts";
import {
  collectDirectionDrift,
  collectSlotEvents,
  jqUri,
  PASSTHROUGH_COLLECTORS,
  runPassthroughCollectors,
  SLOT_EVENTS_FALLBACK,
  stallBand,
  type PassthroughDeps,
  type PassthroughEnv,
} from "../src/autopilot/turn-snapshot/passthrough.ts";
import { createTurnSnapshotHydra, type HydraTransport, type TurnSnapshotHydra } from "../src/autopilot/turn-snapshot/hydra-http.ts";
import type { TurnSnapshotHost } from "../src/autopilot/turn-snapshot/host-port.ts";
import type { TurnSnapshotGithub } from "../src/autopilot/turn-snapshot/github-port.ts";
import { pyFormatFixed, pyNumberRepr, pyReprValue } from "../src/autopilot/turn-snapshot/py-format.ts";
import { withGoldenValues } from "./_helpers/turn-snapshot-golden.mts";

const GOLDEN_DIR = resolve(import.meta.dirname, "fixtures", "turn-snapshot", "passthrough");
const BASE = "http://golden.invalid";
const ROOT = "/golden";

interface GoldenHttp {
  status?: number;
  body?: string;
  network?: string;
}

interface Golden {
  name: string;
  collectors: string[];
  env: Record<string, string>;
  http: Record<string, GoldenHttp>;
  systemctl: { stdout: string; exitCode: number };
  files: Record<string, string>;
  taxonomy: string | null;
  /** `values`: `--format values` output, `{ <collector>: <typed value> }`. */
  expected: { values: Record<string, unknown>; stderrNotes: string[]; httpCalls: string[] };
}

/** The 404 page the capture server answered unscripted paths with (an Express-style HTML body). */
const NOT_FOUND_HTML = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>Error</title>\n</head>\n<body>\n<pre>Cannot GET</pre>\n</body>\n</html>\n";

/** A gh port that must never be touched by a passthrough run. */
const UNUSED_GITHUB = new Proxy({} as TurnSnapshotGithub, {
  get: () => () => {
    throw new Error("the gh port is not a passthrough dependency");
  },
});

function goldenDeps(g: Golden, calls: string[]): PassthroughDeps {
  const transport: HydraTransport = async (url) => {
    assert.ok(url.startsWith(`${BASE}/api`), `unexpected base: ${url}`);
    const path = url.slice(`${BASE}/api`.length);
    calls.push(path);
    const r = g.http[path];
    if (r === undefined) return { status: 404, body: NOT_FOUND_HTML };
    if (r.network) throw new Error("socket hang up");
    return { status: r.status ?? 200, body: r.body ?? "" };
  };
  const host: TurnSnapshotHost = {
    failedServiceUnits: async () => ({ ok: g.systemctl.exitCode === 0, stdout: g.systemctl.stdout }),
    readFile: async (path) => {
      if (path === `${ROOT}/autopilot/classes.json`) return g.taxonomy === null ? null : Buffer.from(g.taxonomy);
      const rel = path.startsWith(`${ROOT}/`) ? path.slice(ROOT.length + 1) : null;
      const content = rel === null ? undefined : g.files[rel];
      return content === undefined ? null : Buffer.from(content);
    },
  };
  return {
    hydra: createTurnSnapshotHydra({ baseUrl: BASE, transport }),
    host,
    env: { HOME: `${ROOT}/home`, HYDRA_CONFIG_PATH: `${ROOT}/config`, HYDRA_TARGET_REPO: `${ROOT}/target`, ...g.env },
    taxonomyPath: `${ROOT}/autopilot/classes.json`,
    targetWorkspace: () => assert.fail("HYDRA_TARGET_REPO is set in every golden"),
  };
}

function cliDeps(passthrough: PassthroughDeps): CliDeps {
  return { github: UNUSED_GITHUB, hydra: passthrough.hydra as TurnSnapshotHydra, now: () => 0, sleep: async () => {}, env: {}, passthrough };
}

const goldenFiles = readdirSync(GOLDEN_DIR).filter((f) => f.endsWith(".json")).sort();
const loadGolden = (f: string) => withGoldenValues("passthrough", f, JSON.parse(readFileSync(join(GOLDEN_DIR, f), "utf-8")) as Golden);

// ---------------------------------------------------------------------------
// 1. Golden files
// ---------------------------------------------------------------------------

describe("Turn Snapshot passthrough — golden files from the bash collectors (ADR-0043 D4)", () => {
  test("the golden corpus is present and covers every collector (guards a vacuous pass)", () => {
    assert.ok(goldenFiles.length >= 100, `expected the captured corpus, found ${goldenFiles.length} files`);
    const covered = new Set(goldenFiles.flatMap((f) => loadGolden(f).collectors));
    assert.deepEqual([...covered].sort(), Object.keys(PASSTHROUGH_COLLECTORS).sort());
  });

  for (const file of goldenFiles) {
    const g = loadGolden(file);
    test(`golden: ${g.name}`, async () => {
      const calls: string[] = [];
      let stdout = "";
      let stderr = "";
      const code = await main(["--collectors", g.collectors.join(","), "--format", "values"], cliDeps(goldenDeps(g, calls)), {
        stdout: (t) => (stdout += t),
        stderr: (t) => (stderr += t),
      });
      assert.equal(code, 0);
      assert.deepEqual(JSON.parse(stdout), g.expected.values, "the typed values must match the golden");
      assert.deepEqual(stderr.split("\n").filter((l) => l !== ""), g.expected.stderrNotes);
      // The TS collectors read concurrently, so the order differs; the set may not.
      assert.deepEqual([...calls].sort(), [...g.expected.httpCalls].sort());
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Ported from test/autopilot-hooks.test.mts §5 (issue #4510)
// ---------------------------------------------------------------------------

function slotDeps(env: PassthroughEnv, reply: (path: string) => { status: number; body: string } | Error, paths: string[]): PassthroughDeps {
  const hydra: TurnSnapshotHydra = createTurnSnapshotHydra({
    baseUrl: BASE,
    transport: async (url) => {
      const path = url.slice(`${BASE}/api`.length);
      paths.push(path);
      const r = reply(path);
      if (r instanceof Error) throw r;
      return r;
    },
  });
  const host: TurnSnapshotHost = { failedServiceUnits: async () => ({ ok: true, stdout: "" }), readFile: async () => null };
  return { hydra, host, env, taxonomyPath: "/nonexistent", targetWorkspace: () => "/nonexistent" };
}

async function slotEventsValue(deps: PassthroughDeps): Promise<unknown> {
  return (await runPassthroughCollectors(["slot-events"], deps)).values["slot-events"];
}

describe("Turn Snapshot slot-events — slot_events_json (ported from autopilot-hooks, issue #4510)", () => {
  test("GETs /autopilot/slot-events with the cursor/count forwarded and pipes the response straight through", async () => {
    const payload = JSON.stringify({
      events: [{ id: "12345-0", fields: { event: "subagent_stop", slot: "dev_orch" } }],
      last_id: "12345-0",
    });
    const paths: string[] = [];
    const value = await slotEventsValue(
      slotDeps({ HYDRA_AUTOPILOT_SLOT_EVENTS_LAST_ID: "100-0", HYDRA_AUTOPILOT_SLOT_EVENTS_COUNT: "50" }, () => ({ status: 200, body: payload }), paths),
    );
    assert.deepEqual(value, { ok: true, value: payload });
    assert.deepEqual(paths, ["/autopilot/slot-events?last_id=100-0&count=50"], "must GET with the last_id/count query forwarded verbatim");
  });

  test("a failed HTTP read is a degraded value (the snapshot then carries the empty shape) — best-effort, never throws", async () => {
    const value = await slotEventsValue(
      slotDeps({ HYDRA_AUTOPILOT_SLOT_EVENTS_LAST_ID: "0", HYDRA_AUTOPILOT_SLOT_EVENTS_COUNT: "100" }, () => ({ status: 500, body: "{}" }), []),
    );
    assert.equal((value as { ok: boolean }).ok, false);
    assert.equal(SLOT_EVENTS_FALLBACK, '{"events": [], "last_id": null}');
  });

  test("URL-encodes the last_id cursor before interpolating it into the GET path", async () => {
    const paths: string[] = [];
    await slotEventsValue(
      slotDeps(
        { HYDRA_AUTOPILOT_SLOT_EVENTS_LAST_ID: "a b+c", HYDRA_AUTOPILOT_SLOT_EVENTS_COUNT: "10" },
        () => ({ status: 200, body: '{"events": [], "last_id": null}' }),
        paths,
      ),
    );
    assert.deepEqual(paths, ["/autopilot/slot-events?last_id=a%20b%2Bc&count=10"], "the cursor must be percent-encoded (jq @uri)");
  });
});

// ---------------------------------------------------------------------------
// 3. Interface cases
// ---------------------------------------------------------------------------

describe("Turn Snapshot hydra HTTP client — `hydra raw GET` semantics", () => {
  async function read(status: number, body: string, baseUrl?: string) {
    const urls: string[] = [];
    const client = createTurnSnapshotHydra({ baseUrl, transport: async (u) => (urls.push(u), { status, body }) });
    return { res: await client.get("/x?y=1"), urls };
  }

  test("2xx returns the body verbatim; the base defaults to localhost:4000 when unset or empty", async () => {
    assert.deepEqual((await read(200, " {\"a\":1}\n")).res, { kind: "ok", body: " {\"a\":1}\n" });
    assert.deepEqual((await read(204, "")).urls, ["http://localhost:4000/api/x?y=1"]);
    assert.deepEqual((await read(200, "", "")).urls, ["http://localhost:4000/api/x?y=1"]);
    assert.deepEqual((await read(200, "", "http://h:1")).urls, ["http://h:1/api/x?y=1"]);
  });

  test("non-2xx and HTML-looking bodies fail; a JSON body mentioning <html later does not", async () => {
    assert.equal((await read(500, "{}")).res.kind, "failed");
    assert.equal((await read(302, "")).res.kind, "failed");
    for (const html of ["<!DOCTYPE html>", "<!doctype html>", "<html>", "<HTML>"]) {
      assert.deepEqual((await read(200, html)).res, { kind: "failed", reason: "html-body" });
    }
    assert.equal((await read(200, '{"x":"<html>"}')).res.kind, "ok");
  });

  test("an empty 2xx body is an ok read of \"\" (`_get` exits 0 printing nothing), not a failure (#4933 review)", async () => {
    assert.deepEqual((await read(200, "")).res, { kind: "ok", body: "" });
    // ...so the body passthrough carries the empty body, exactly as `hydra raw GET … || echo default` did,
    const deps = slotDeps({}, () => ({ status: 200, body: "" }), []);
    assert.deepEqual((await runPassthroughCollectors(["usage-eligibility"], deps)).values["usage-eligibility"], { ok: true, value: "" });
    // ...while slot-events (a `$(...)` capture tested with `[ -n ]`) degrades.
    assert.equal((await runPassthroughCollectors(["slot-events"], deps)).values["slot-events"]?.ok, false);
  });

  test("a transport error is a failed read, never a throw", async () => {
    const client = createTurnSnapshotHydra({ transport: async () => Promise.reject(new Error("ECONNREFUSED")) });
    assert.deepEqual(await client.get("/health"), { kind: "failed", reason: "transport: ECONNREFUSED" });
  });
});

describe("Turn Snapshot py-format — Python formatting parity", () => {
  test("format(x, '.Nf') rounds the exact double half-to-even", () => {
    assert.equal(pyFormatFixed(0.125, 2), "0.12");
    assert.equal(pyFormatFixed(0.375, 2), "0.38");
    assert.equal(pyFormatFixed(1 / 32, 4), "0.0312");
    assert.equal(pyFormatFixed(0.675, 2), "0.68"); // 0.675 is 0.67500000000000004441 — not a tie
    assert.equal(pyFormatFixed(1, 4), "1.0000");
    assert.equal(pyFormatFixed(-0.001, 2), "-0.00");
    assert.equal(pyFormatFixed(-0, 2), "-0.00");
    assert.equal(pyFormatFixed(2.5, 0), "2");
    assert.equal(pyFormatFixed(123456.789, 2), "123456.79");
  });

  test("repr of JSON numbers and containers", () => {
    assert.equal(pyNumberRepr(20), "20");
    assert.equal(pyNumberRepr(0.1), "0.1");
    assert.equal(pyNumberRepr(1e-7), "1e-07");
    assert.equal(pyNumberRepr(0.0001), "0.0001");
    assert.equal(pyNumberRepr(1e21), "1e+21");
    assert.equal(pyNumberRepr(1.5e300), "1.5e+300");
    assert.equal(pyNumberRepr(-2.5), "-2.5");
    assert.equal(pyReprValue({ a: [true, null, "it's", 2.5] }), `{'a': [True, None, "it's", 2.5]}`);
  });

  test("jq @uri keeps only A-Za-z0-9-_.~", () => {
    assert.equal(jqUri("a b/c!*'()~-_.:é"), "a%20b%2Fc%21%2A%27%28%29~-_.%3A%C3%A9");
  });

  test("scheduler stall bands: <5 ok, 5–7 alert, >=8 hard-stop (booleans compare as ints)", () => {
    assert.deepEqual([0, 4.9, 5, 7.5, 8, 100, true].map(stallBand), ["ok", "ok", "alert", "alert", "hard-stop", "hard-stop", "ok"]);
  });
});

describe("Turn Snapshot direction-drift — env precedence", () => {
  function driftDeps(env: PassthroughEnv, files: Record<string, string>, workspace = "/ws"): PassthroughDeps {
    return {
      hydra: createTurnSnapshotHydra({ transport: async () => assert.fail("no HTTP read") }),
      host: {
        failedServiceUnits: async () => ({ ok: true, stdout: "" }),
        readFile: async (p) => (files[p] === undefined ? null : Buffer.from(files[p] as string)),
      },
      env,
      taxonomyPath: "/x",
      targetWorkspace: () => workspace,
    };
  }

  test("HYDRA_TARGET_REPO unset or empty → the Target workspace from the config seam", async () => {
    const files = { "/ws/direction/roadmap.md": "new", "/cfg/direction/roadmap.md": "old" };
    assert.equal((await collectDirectionDrift(driftDeps({ HYDRA_CONFIG_PATH: "/cfg" }, files))).value, true);
    assert.equal((await collectDirectionDrift(driftDeps({ HYDRA_CONFIG_PATH: "/cfg", HYDRA_TARGET_REPO: "" }, files))).value, true);
    assert.equal((await collectDirectionDrift(driftDeps({ HYDRA_CONFIG_PATH: "/cfg", HYDRA_TARGET_REPO: "/elsewhere" }, files))).value, false);
  });

  test("HYDRA_CONFIG_PATH unset → $HOME/hydra/config", async () => {
    const files = { "/t/direction/priorities.md": "a", "/home/u/hydra/config/direction/priorities.md": "b" };
    assert.equal((await collectDirectionDrift(driftDeps({ HOME: "/home/u", HYDRA_TARGET_REPO: "/t" }, files))).value, true);
  });
});

describe("Turn Snapshot passthrough — CLI and fail-open runner", () => {
  test("a collector that throws returns its full fallback plus a note; the others still read", async () => {
    const deps = slotDeps({}, () => ({ status: 200, body: '{"engaged":true}' }), []);
    const broken: PassthroughDeps = { ...deps, host: { ...deps.host, failedServiceUnits: async () => Promise.reject(new Error("boom")) } };
    const run = await runPassthroughCollectors(["health", "emergency-brake"], broken);
    assert.deepEqual(run.values, {
      health: { service: { ok: false, reason: "all-reads-failed" }, failedServices: 0 },
      "emergency-brake": { ok: true, value: '{"engaged":true}' },
    });
    assert.deepEqual(run.degraded, [{ collector: "health", field: "health", reason: "collector-crashed" }]);
    assert.deepEqual(run.notes, ["orch turn-snapshot health collector crashed (boom) — emitting its fail-open fallback (issue #4933)"]);
  });

  test("passthrough collectors are known to --collectors and combine with the other collectors", () => {
    assert.ok(!("error" in parseArgs(["--collectors", "health,slot-events", "--format", "values"])));
    assert.ok(!("error" in parseArgs(["--collectors", "pr-gate,health", "--format", "values"])));
    assert.match((parseArgs(["--collectors", "health,nope", "--format", "values"]) as { error: string }).error, /unknown collector/);
  });

  test("passthrough deps missing → usage error (exit 2), nothing on stdout", async () => {
    let stdout = "";
    const code = await main(["--collectors", "health", "--format", "values"], { github: UNUSED_GITHUB, now: () => 0, sleep: async () => {}, env: {} }, {
      stdout: (t) => (stdout += t),
      stderr: () => {},
    });
    assert.equal(code, 2);
    assert.equal(stdout, "");
  });

  test("every registry fallback equals the bash all-reads-failed goldens", () => {
    // The degraded REASON names which read failed (http-404 there, all-reads-failed for a crash); the values must agree.
    const noReasons = (v: unknown): unknown =>
      JSON.parse(JSON.stringify(v), (k, x) => (k === "reason" && typeof x === "string" ? "<reason>" : x));
    const fb = (names: string[]) => noReasons(Object.fromEntries(names.map((n) => [n, PASSTHROUGH_COLLECTORS[n as keyof typeof PASSTHROUGH_COLLECTORS].fallbackValue])));
    const tailNames = ["scout-alerts", "realm-share", "usage-eligibility", "emergency-brake", "class-stats", "capacity", "scheduler", "recommendations", "slot-events"];
    assert.deepEqual(fb(["health", "direction-drift"]), noReasons(loadGolden("passthrough-group-head-all-failed.json").expected.values));
    assert.deepEqual(fb(tailNames), noReasons(loadGolden("passthrough-group-tail-all-failed.json").expected.values));
  });
});
