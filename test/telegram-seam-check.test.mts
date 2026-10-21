/**
 * test/telegram-seam-check.test.mts — pin the Telegram Notification Adapter
 * seam-check grammar at the predicate level (no git scan, no process.exit),
 * issue #2201; widened for ADR-0045 Decision 2 (issue #5046).
 *
 * The CI gate at scripts/ci/telegram-seam-check.ts forbids the Telegram Bot
 * API host (`api.telegram.org`) on any NON-COMMENT line of any file outside
 * the Operator Channel's transport (`src/notify.ts`) — in `src/`, `scripts/`
 * (TypeScript and shell) and the tracked systemd units. The only other
 * carve-out is the check itself (it carries the literal as its own signal).
 * Comments never count: TypeScript is comment-stripped first, and a `.sh` /
 * `.service` / `.timer` line whose first non-blank character is `#` is
 * ignored.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { fileViolatesTelegramSeam, TELEGRAM_SEAM_GLOBS } = await import(
  "../scripts/ci/telegram-seam-check.ts"
);

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
        `await sendNotification(event);`,
      ),
      false,
    );
  });

  test("does NOT flag the host named only in a TypeScript comment (comments are stripped)", () => {
    assert.equal(
      fileViolatesTelegramSeam(
        "src/operator-channel/channel.ts",
        `// every send goes through src/notify.ts, the one caller of api.telegram.org\n/* api.telegram.org */\nexport const x = 1;`,
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
        "scripts/autopilot/notify.py",
        `import urllib.request\nurllib.request.urlopen("https://api.telegram.org/bot" + token + "/sendMessage", data=body)`,
      ),
      true,
    );
    assert.equal(
      fileViolatesTelegramSeam(
        "scripts/autopilot/decide.py",
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

describe("telegram-seam-check: carve-outs", () => {
  test("exempts the Telegram Notification Adapter Module itself", () => {
    assert.equal(
      fileViolatesTelegramSeam(
        "src/notify.ts",
        `const response = await fetch(\`https://api.telegram.org/bot\${TELEGRAM_BOT_TOKEN}/sendMessage\`, { method: "POST" });`,
      ),
      false,
    );
  });

  test("exempts the seam check itself (it carries the literal as its own signal)", () => {
    assert.equal(
      fileViolatesTelegramSeam(
        "scripts/ci/telegram-seam-check.ts",
        `const TELEGRAM_TARGET_SIGNALS = ["api.telegram.org"];`,
      ),
      false,
    );
  });

  test("exempts exactly those two paths — a look-alike path is still checked", () => {
    assert.equal(
      fileViolatesTelegramSeam(
        "src/notify-format.ts",
        `const u = "https://api.telegram.org/bot";`,
      ),
      true,
    );
  });
});
