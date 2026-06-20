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
