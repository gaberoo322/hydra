// Golden capture for ADR-0043 slice 5B (#4933): runs the OLD bash collectors
// (collect_redis_queues, collect_scout, collect_arch_cleanup_boards,
// collect_hitl_grill, collect_retro, collect_wayfinder_frontier,
// collect_tickets) from a copy of collect-state.sh at the slice's base SHA,
// with fake `gh` / `docker` / `date` binaries on PATH and the real `hydra`
// CLI against a local HTTP server, and records stdout, the stderr-note set,
// the gh argv list (minus `--jq <expr>`), the data-plane paths read, the
// Redis writes and the exported globals. See README.md for the recipe.
//
//   node capture.mjs <scenarios.mjs> <out-dir> <collect-state.base.sh> <base-sha> <hydra-cli>
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [scenarioFile, outDir, baseScript, baseSha, hydraCli] = process.argv.slice(2);
const { scenarios } = await import(pathToFileURL(resolve(scenarioFile)).href);

const FN = {
  "redis-queues": "collect_redis_queues",
  scout: "collect_scout",
  "arch-cleanup-boards": "collect_arch_cleanup_boards",
  "hitl-grill": "collect_hitl_grill",
  retro: "collect_retro",
  "wayfinder-frontier": "collect_wayfinder_frontier",
  tickets: "collect_tickets",
};

const NOT_FOUND_HTML = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>Error</title>\n</head>\n<body>\n<pre>Cannot GET</pre>\n</body>\n</html>\n";

// gh: strip `--jq <expr>`, log the argv, serve the scripted raw JSON, apply the jq like gh does.
const FAKE_GH = (T) => `#!${process.execPath}
const fs = require("fs");
const { spawnSync } = require("child_process");
const T = ${JSON.stringify(T)};
const args = process.argv.slice(2);
let jq = null;
const rest = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--jq") jq = args[++i];
  else rest.push(args[i]);
}
fs.appendFileSync(T + "/gh.calls", JSON.stringify(rest) + "\\n");
const fx = JSON.parse(fs.readFileSync(T + "/gh.json", "utf8"));
const after = (flag) => { const i = rest.indexOf(flag); return i >= 0 ? rest[i + 1] : null; };
let key;
if (rest[0] === "api" && rest[1] === "graphql") key = "graphql:" + String(after("-F")).replace(/^n=/, "");
else key = "issue-list:" + (after("--label") ?? "-") + ":" + after("--json");
const r = fx[key];
if (r === undefined || r.exitCode) {
  process.stderr.write("gh: scripted failure for " + key + "\\n");
  process.exit(r === undefined ? 1 : r.exitCode);
}
let out = typeof r.raw === "string" ? r.raw : JSON.stringify(r.json);
if (jq !== null) {
  const res = spawnSync("jq", ["-c", "-r", jq], { input: out, encoding: "utf8" });
  if (res.status !== 0) { process.stderr.write(res.stderr); process.exit(1); }
  out = res.stdout;
}
process.stdout.write(out);
`;

// docker exec hydra-redis-1 redis-cli <CMD> …: a scripted keyspace (or a stopped container).
const FAKE_DOCKER = (T) => `#!${process.execPath}
const fs = require("fs");
const T = ${JSON.stringify(T)};
const a = process.argv.slice(2);
const st = JSON.parse(fs.readFileSync(T + "/redis.json", "utf8"));
if (st.down) { process.stderr.write("Error response from daemon: container hydra-redis-1 is not running\\n"); process.exit(1); }
const [cmd, key, ...rest] = a.slice(3);
const out = (s) => process.stdout.write(s + "\\n");
if (cmd === "LLEN") out(String((st.lists ?? {})[key] ?? 0));
else if (cmd === "GET") out((st.strings ?? {})[key] ?? "");
else if (cmd === "HGET") out(((st.hashes ?? {})[key] ?? {})[rest[0]] ?? "");
else if (cmd === "SET") { fs.appendFileSync(T + "/redis.writes", JSON.stringify([cmd, key, ...rest]) + "\\n"); out("OK"); }
else { process.stderr.write("unscripted redis-cli " + cmd + "\\n"); process.exit(1); }
`;

const FAKE_DATE = (date) => `#!/usr/bin/bash
if [ "$*" = "-u +%Y-%m-%d" ]; then echo ${JSON.stringify(date)}; else exec /usr/bin/date "$@"; fi
`;

function lines(path) {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((l) => l !== "") : [];
}

async function runOne(sc) {
  const T = mkdtempSync(join(tmpdir(), "ts5b-cap-"));
  const calls = [];
  const server = createServer((req, res) => {
    const path = req.url.replace(/^\/api/, "");
    calls.push(path);
    const r = sc.http?.[path];
    if (r === undefined) {
      res.writeHead(404, { "content-type": "text/html" });
      res.end(NOT_FOUND_HTML);
      return;
    }
    if (r.network) {
      req.socket.destroy();
      return;
    }
    res.writeHead(r.status ?? 200, { "content-type": "application/json" });
    res.end(r.body ?? "");
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const port = server.address().port;
  try {
    mkdirSync(join(T, "autopilot"), { recursive: true });
    mkdirSync(join(T, "bin"), { recursive: true });
    copyFileSync(baseScript, join(T, "autopilot", "collect-state.sh"));
    copyFileSync(hydraCli, join(T, "bin", "hydra"));
    writeFileSync(join(T, "bin", "gh"), FAKE_GH(T));
    writeFileSync(join(T, "bin", "docker"), FAKE_DOCKER(T));
    writeFileSync(join(T, "bin", "date"), FAKE_DATE(sc.date ?? "2026-10-07"));
    for (const b of ["hydra", "gh", "docker", "date"]) chmodSync(join(T, "bin", b), 0o755);
    writeFileSync(join(T, "gh.json"), JSON.stringify(sc.gh ?? {}));
    writeFileSync(join(T, "redis.json"), JSON.stringify(sc.redis ?? {}));
    const env = {
      PATH: `${join(T, "bin")}:/usr/bin:/bin`,
      HOME: T,
      HYDRA_BASE_URL: `http://127.0.0.1:${port}`,
      OBD_IN: sc.orchBoardDegraded ?? "0",
      EXPORTS: join(T, "exports"),
      ...(sc.env ?? {}),
    };
    const fns = sc.collectors.map((c) => FN[c]);
    const prog =
      'src="$1"; shift; source "$src"; ORCH_BOARD_DEGRADED="$OBD_IN"; for f in "$@"; do "$f"; done; ' +
      'if [ -n "${ARCH_WORK_QUEUE+x}" ]; then printf "ARCH_WORK_QUEUE=%s\\nORCH_BOARD_DEGRADED=%s\\n" "$ARCH_WORK_QUEUE" "$ORCH_BOARD_DEGRADED" > "$EXPORTS"; fi';
    const child = spawn("/usr/bin/bash", ["-c", prog, "argv0", join(T, "autopilot", "collect-state.sh"), ...fns], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    await new Promise((ok) => child.on("close", ok));
    const golden = {
      name: sc.name,
      source: "synthetic fixture (ADR-0043 D4 — every read path incl. failures)",
      capturedFrom: `scripts/autopilot/collect-state.sh @ ${baseSha} (${fns.join(" + ")})`,
      collectors: sc.collectors,
      date: sc.date ?? "2026-10-07",
      orchBoardDegraded: sc.orchBoardDegraded ?? "0",
      env: sc.env ?? {},
      gh: sc.gh ?? {},
      redis: sc.redis ?? {},
      http: sc.http ?? {},
      expected: {
        stdout,
        stderrNotes: stderr.split("\n").filter((l) => l !== ""),
        ghCalls: lines(join(T, "gh.calls")).map((l) => JSON.parse(l)),
        httpCalls: calls,
        redisWrites: lines(join(T, "redis.writes")).map((l) => JSON.parse(l)),
        exports: existsSync(join(T, "exports")) ? readFileSync(join(T, "exports"), "utf8") : null,
      },
    };
    writeFileSync(join(outDir, `remaining-${sc.name}.json`), JSON.stringify(golden, null, 2) + "\n");
    return golden;
  } finally {
    server.close();
    rmSync(T, { recursive: true, force: true });
  }
}

mkdirSync(outDir, { recursive: true });
for (const sc of scenarios) {
  const g = await runOne(sc);
  console.log(`${sc.name}: ${JSON.stringify(g.expected.stdout)} ${g.expected.stderrNotes.length ? JSON.stringify(g.expected.stderrNotes) : ""}`);
}
