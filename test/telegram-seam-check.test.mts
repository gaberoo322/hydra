/**
 * test/telegram-seam-check.test.mts — pin the Operator Channel transport
 * seam-check grammar at the predicate level (no git scan, no process.exit),
 * issue #2201; widened for ADR-0045 Decision 2 (issue #5046); exemption list
 * shrunk to the one transport by issue #5049.
 *
 * The CI gate at scripts/ci/telegram-seam-check.ts forbids the Telegram Bot
 * API host (`api.telegram.org`) on any NON-COMMENT line of any file outside
 * the Operator Channel's transport (`src/operator-channel/transport.ts`) — in
 * `src/`, `scripts/` (TypeScript, shell, Python, mjs) and the tracked systemd
 * units. There is no other carve-out: the check assembles its own signal from
 * parts, so it needs no self-exemption. Comments never count: TypeScript is
 * comment-stripped first, and a `.sh` / `.py` / `.service` / `.timer` line
 * whose first non-blank character is `#` is ignored.
 *
 * The last describe is the live-tree half of the #5049 contract: no file in
 * `src/` or `scripts/` outside `src/operator-channel/` imports the transport.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "../scripts/ci/seam-check-lib.ts";

const { fileViolatesTelegramSeam, TELEGRAM_SEAM_GLOBS, TELEGRAM_SEAM_EXEMPT } = await import(
  "../scripts/ci/telegram-seam-check.ts"
);

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TRANSPORT = "src/operator-channel/transport.ts";

/** Every `.ts` / `.mjs` file under `dir` (recursive), repo-relative with `/` separators. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) {
        if (name !== "node_modules") walk(full);
      } else if (/\.(ts|mjs)$/.test(name)) {
        out.push(relative(REPO_ROOT, full).split("\\").join("/"));
      }
    }
  };
  walk(resolve(REPO_ROOT, dir));
  return out;
}

describe("telegram-seam-check: Telegram host grammar (src/)", () => {
  test("flags a fetch to the Telegram Bot API host outside the adapter", () => {
    assert.equal(
      fileViolatesTelegramSeam(
        "src/digest.ts",
        `const r = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", { method: "POST" });`,
      ),
      true,
    );
  });

  test("flags the host literal even without a fetch( on the same line (any sender shape)", () => {
    assert.equal(
      fileViolatesTelegramSeam(
        "src/some-module.ts",
        `const url = "https://api.telegram.org/bot" + token;\nawait client.post(url);`,
      ),
      true,
    );
  });

  test("does NOT flag an unrelated fetch (Anthropic / OpenViking / generic probe)", () => {
    assert.equal(
      fileViolatesTelegramSeam(
        "src/anthropic/request.ts",
        `res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST" });`,
      ),
      false,
    );
    assert.equal(
      fileViolatesTelegramSeam(
        "src/knowledge-base/ov-request.ts",
        `res = await fetch(url, { method: init.method ?? "GET" });`,
      ),
      false,
    );
    assert.equal(
      fileViolatesTelegramSeam(
        "src/api/health.ts",
        `const r = await fetch("http://localhost:5000/health", { signal });`,
      ),
      false,
    );
  });

  test("does NOT flag a file that routes through the adapter accessor", () => {
    assert.equal(
      fileViolatesTelegramSeam(
        "src/notification-consumer.ts",
        `routeNotificationEvent(event);`,
      ),
      false,
    );
  });

  test("does NOT flag the host named only in a TypeScript comment (comments are stripped)", () => {
    assert.equal(
      fileViolatesTelegramSeam(
        "src/operator-channel/channel.ts",
        `// every send goes through src/operator-channel/transport.ts, the one caller of api.telegram.org\n/* api.telegram.org */\nexport const x = 1;`,
      ),
      false,
    );
  });
});

describe("telegram-seam-check: scripts/ and systemd units (ADR-0045 D2, issue #5046)", () => {
  test("flags a bash curl to the Bot API in a .sh script", () => {
    assert.equal(
      fileViolatesTelegramSeam(
        "scripts/hydra-watchdog.sh",
        `    if curl -sS --max-time 10 -X POST \\\n        "https://api.telegram.org/bot\${TELEGRAM_BOT_TOKEN}/sendMessage" \\\n        --data-urlencode "chat_id=\${TELEGRAM_CHAT_ID}" >/dev/null 2>&1; then`,
      ),
      true,
    );
  });

  test("flags an ExecStart curl to the Bot API in a systemd unit", () => {
    assert.equal(
      fileViolatesTelegramSeam(
        "scripts/systemd/hydra-notify-failure@.service",
        `[Service]\nType=oneshot\nExecStart=/bin/bash -c 'curl -s -X POST "https://api.telegram.org/bot\${TELEGRAM_BOT_TOKEN}/sendMessage"'`,
      ),
      true,
    );
  });

  test("flags the host in a scripts/ TypeScript file outside the carve-outs", () => {
    assert.equal(
      fileViolatesTelegramSeam(
        "scripts/some-tool.ts",
        `await fetch(\`https://api.telegram.org/bot\${token}/sendMessage\`);`,
      ),
      true,
    );
  });

  test("flags a Python script that posts to the Bot API, but not a Python comment", () => {
    assert.equal(
      fileViolatesTelegramSeam(
        "scripts/_seam_fixture_notify.py",
        `import urllib.request\nurllib.request.urlopen("https://api.telegram.org/bot" + token + "/sendMessage", data=body)`,
      ),
      true,
    );
    assert.equal(
      fileViolatesTelegramSeam(
        "scripts/_seam_fixture.py",
        `# pages go through scripts/operator-notify.ts, never api.telegram.org\nprint("ok")`,
      ),
      false,
    );
  });

  test("flags an .mjs script naming the host, with JS comments stripped", () => {
    assert.equal(fileViolatesTelegramSeam("scripts/test/x.mjs", `const u = "https://api.telegram.org/bot";`), true);
    assert.equal(fileViolatesTelegramSeam("scripts/test/x.mjs", `// api.telegram.org\nconst u = 1;`), false);
  });

  test("does NOT flag the host named only in a shell comment line", () => {
    assert.equal(
      fileViolatesTelegramSeam(
        "scripts/hydra-watchdog.sh",
        `# The old out-of-band path curled api.telegram.org directly; it now calls the CLI.\n   # api.telegram.org (indented comment)\ndeliver_page page --kind "$etype"`,
      ),
      false,
    );
  });

  test("does NOT flag the host named only in a unit-file comment line", () => {
    assert.equal(
      fileViolatesTelegramSeam(
        "scripts/systemd/hydra-notify-failure@.service",
        `# Replaces the former curl to api.telegram.org (issue #5046).\nExecStart=/usr/bin/node --experimental-strip-types %h/hydra/scripts/operator-notify.ts service-failed --unit %i`,
      ),
      false,
    );
  });

  test("the scan covers src/, scripts/ (ts + sh) and the systemd units", () => {
    for (const glob of ["src/*.ts", "src/**/*.ts", "scripts/*.ts", "scripts/**/*.ts", "scripts/*.sh", "scripts/**/*.sh", "scripts/*.py", "scripts/**/*.py", "scripts/*.mjs", "scripts/**/*.mjs", "scripts/systemd/*"]) {
      assert.ok(TELEGRAM_SEAM_GLOBS.includes(glob), `glob '${glob}' must be scanned`);
    }
  });
});

describe("telegram-seam-check: the single exemption (issue #5049)", () => {
  test("the exemption list names exactly the Operator Channel transport", () => {
    assert.deepEqual([...TELEGRAM_SEAM_EXEMPT], [TRANSPORT]);
  });

  test("exempts the transport module itself", () => {
    assert.equal(
      fileViolatesTelegramSeam(
        TRANSPORT,
        `const response = await fetch(\`https://api.telegram.org/bot\${deps.token}/sendMessage\`, { method: "POST" });`,
      ),
      false,
    );
  });

  test("the retired src/notify.ts path is no longer exempt", () => {
    assert.equal(
      fileViolatesTelegramSeam(
        "src/notify.ts",
        `const response = await fetch(\`https://api.telegram.org/bot\${TELEGRAM_BOT_TOKEN}/sendMessage\`, { method: "POST" });`,
      ),
      true,
    );
  });

  test("the seam check is NOT exempt — its own source carries the host only in comments / assembled from parts", () => {
    assert.equal(
      fileViolatesTelegramSeam(
        "scripts/ci/telegram-seam-check.ts",
        `const TELEGRAM_TARGET_SIGNALS = ["api.telegram.org"];`,
      ),
      true,
      "a literal on a code line in the check itself would now be a violation",
    );
    const own = readFileSync(resolve(REPO_ROOT, "scripts/ci/telegram-seam-check.ts"), "utf8");
    assert.equal(fileViolatesTelegramSeam("scripts/ci/telegram-seam-check.ts", own), false);
  });

  test("a look-alike path next to the transport is still checked", () => {
    assert.equal(
      fileViolatesTelegramSeam(
        "src/operator-channel/transport-format.ts",
        `const u = "https://api.telegram.org/bot";`,
      ),
      true,
    );
  });

  test("the transport module exists and is the only src/ or scripts/ file naming the host on a code line", () => {
    const offenders: string[] = [];
    for (const rel of [...sourceFiles("src"), ...sourceFiles("scripts")]) {
      const body = readFileSync(resolve(REPO_ROOT, rel), "utf8");
      if (rel === TRANSPORT) {
        assert.match(stripComments(body), /api\.telegram\.org/, "the transport owns the one fetch");
        continue;
      }
      if (fileViolatesTelegramSeam(rel, body)) offenders.push(rel);
    }
    assert.deepEqual(offenders, []);
  });
});

describe("no file outside the Operator Channel imports a Telegram sender or formatter (issue #5049)", () => {
  test("src/ and scripts/ import the transport only from inside src/operator-channel/", () => {
    const offenders: string[] = [];
    for (const rel of [...sourceFiles("src"), ...sourceFiles("scripts")]) {
      if (rel.startsWith("src/operator-channel/")) continue;
      const code = stripComments(readFileSync(resolve(REPO_ROOT, rel), "utf8"));
      if (/from\s+["'][^"']*\/(transport|notify|notify-format|digest|digest-weekly)\.ts["']/.test(code)) {
        offenders.push(rel);
      }
    }
    assert.deepEqual(offenders, []);
  });

  test("the legacy sender / formatter modules are gone", () => {
    for (const rel of ["src/notify.ts", "src/notify-format.ts", "src/digest.ts", "src/digest-weekly.ts"]) {
      assert.throws(() => statSync(resolve(REPO_ROOT, rel)), `${rel} must not exist`);
    }
  });
});
