/**
 * test/telegram-seam-check.test.mts — pin the Telegram Notification Adapter
 * seam-check grammar at the predicate level (no git scan, no process.exit),
 * issue #2201.
 *
 * The CI gate at scripts/ci/telegram-seam-check.ts forbids a raw Telegram
 * `fetch(...)` from any file outside `src/notify.ts` (the adapter Module
 * itself). A "Telegram fetch" is a `fetch(` whose line carries the unambiguous
 * Telegram signal (the `api.telegram.org` host). Unrelated fetches (Anthropic,
 * OpenViking, health probes) must NOT trip it. Seventh boundary Seam, sibling to
 * anthropic-seam-check / openviking-seam-check.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { fileViolatesTelegramSeam } = await import(
  "../scripts/ci/telegram-seam-check.ts"
);

describe("telegram-seam-check: Telegram fetch grammar", () => {
  test("flags a fetch to the Telegram Bot API host outside the adapter", () => {
    assert.equal(
      fileViolatesTelegramSeam(
        "src/digest.ts",
        `const r = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", { method: "POST" });`,
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
});

describe("telegram-seam-check: widened closure (issue #5046)", () => {
  test("flags a bash curl to the Bot API in scripts/", () => {
    assert.equal(
      fileViolatesTelegramSeam(
        "scripts/hydra-watchdog.sh",
        `  curl -sS -X POST "https://api.telegram.org/bot$TOKEN/sendMessage"`,
      ),
      true,
    );
  });

  test("flags a systemd unit ExecStart curl", () => {
    assert.equal(
      fileViolatesTelegramSeam(
        "scripts/systemd/hydra-notify-failure@.service",
        `ExecStart=/bin/bash -c 'curl https://api.telegram.org/bot1/sendMessage'`,
      ),
      true,
    );
  });

  test("ignores the host in a commented shell line", () => {
    assert.equal(
      fileViolatesTelegramSeam(
        "scripts/hydra-watchdog.sh",
        "  # historically curl-ed https://api.telegram.org directly\necho ok",
      ),
      false,
    );
  });

  test("ignores the host in a TS comment but flags it in code", () => {
    assert.equal(fileViolatesTelegramSeam("scripts/x.ts", `// api.telegram.org`), false);
    assert.equal(fileViolatesTelegramSeam("scripts/x.ts", `const u = "https://api.telegram.org/bot";`), true);
  });

  test("carves out the check's own signal literal", () => {
    assert.equal(
      fileViolatesTelegramSeam("scripts/ci/telegram-seam-check.ts", `const TELEGRAM_HOST = "api.telegram.org";`),
      false,
    );
  });
});

describe("telegram-seam-check: carve-out", () => {
  test("exempts the Telegram Notification Adapter Module itself", () => {
    assert.equal(
      fileViolatesTelegramSeam(
        "src/notify.ts",
        `const response = await fetch(\`https://api.telegram.org/bot\${TELEGRAM_BOT_TOKEN}/sendMessage\`, { method: "POST" });`,
      ),
      false,
    );
  });
});
