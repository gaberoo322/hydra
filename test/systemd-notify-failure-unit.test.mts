/**
 * Pins `hydra-notify-failure@.service` as an Operator Channel CLI caller
 * (ADR-0045 Decision 2, issue #5046; supersedes the #4284 bash-curl shape).
 *
 * The OnFailure template no longer hand-builds a Telegram JSON body with curl.
 * Its ExecStart runs `scripts/operator-notify.ts service-failed --unit %i`
 * under `/usr/bin/node --experimental-strip-types` (a systemd unit's minimal
 * PATH cannot see a global `tsx`, and `npx` would try the network inside a
 * failure handler), so the exit-code policy (exit 143 / SIGTERM never pages),
 * the unit→kind map and the dedup all live in one place. Credentials still
 * arrive only via the non-dash `EnvironmentFile=%h/hydra/.env` (a missing
 * .env must fail the notifier loudly in the journal, never silently).
 *
 * Every tracked unit under scripts/systemd/ that routes failures declares
 * exactly `OnFailure=hydra-notify-failure@%n` so the `%i` the CLI receives is
 * the unit's own name (the CLI strips one trailing `.service` for the host's
 * legacy `@%n.service` spelling).
 *
 * Pure `fs` reads only — no systemd invocation, no network call, no Telegram
 * send.
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const SYSTEMD_DIR = path.join(REPO_ROOT, "scripts/systemd");
const UNIT_PATH = path.join(SYSTEMD_DIR, "hydra-notify-failure@.service");
const DEPLOY_SH_PATH = path.join(REPO_ROOT, "scripts/deploy.sh");

const unitText = readFileSync(UNIT_PATH, "utf8");
const deployText = readFileSync(DEPLOY_SH_PATH, "utf8");

/** Non-comment lines of a unit file. */
function codeLines(text: string): string[] {
  return text.split("\n").filter((l) => !/^\s*[#;]/.test(l));
}

describe("scripts/systemd/hydra-notify-failure@.service (ADR-0045 D2, issue #5046)", () => {
  test("ExecStart calls the Operator Channel CLI under /usr/bin/node --experimental-strip-types", () => {
    assert.match(
      unitText,
      /^ExecStart=\/usr\/bin\/node --experimental-strip-types %h\/hydra\/scripts\/operator-notify\.ts service-failed --unit %i$/m,
      "expected the exact CLI ExecStart line (no npx, no tsx, no bash -c)",
    );
  });

  test("never shells npx / tsx (a unit's minimal PATH cannot resolve the global tsx)", () => {
    for (const line of codeLines(unitText)) {
      assert.doesNotMatch(line, /\bnpx\b/, `npx must not appear on a unit code line: ${line}`);
      assert.doesNotMatch(line, /\btsx\b/, `tsx must not appear on a unit code line: ${line}`);
    }
  });

  test("carries no curl and no Telegram Bot API host (the CLI is the only Telegram sender)", () => {
    assert.doesNotMatch(unitText, /\bcurl\b/);
    assert.doesNotMatch(unitText, /api\.telegram\.org/);
    assert.doesNotMatch(unitText, /\$\$MSG|\$\{MSG\}/, "the hand-built message body is gone");
  });

  test("sources credentials from a non-optional EnvironmentFile=%h/hydra/.env", () => {
    assert.match(
      unitText,
      /^EnvironmentFile=%h\/hydra\/\.env$/m,
      "expected a non-dash-prefixed EnvironmentFile=%h/hydra/.env line",
    );
    // Dash-prefixed (`EnvironmentFile=-%h/hydra/.env`) would silently swallow
    // a missing .env instead of failing loud in the journal.
    assert.doesNotMatch(unitText, /^EnvironmentFile=-/m);
  });

  test("never inlines a literal TELEGRAM_* Environment= line", () => {
    assert.doesNotMatch(unitText, /^Environment=TELEGRAM_/m);
  });

  test("carries no bot-token-shaped literal (digits:20+ token chars)", () => {
    assert.doesNotMatch(unitText, /\d+:[A-Za-z0-9_-]{20,}/);
  });

  test("declares no OnFailure= (no self-recursion on a failed page)", () => {
    assert.doesNotMatch(unitText, /^OnFailure=/m);
  });

  test("bounds the handler: TimeoutStartSec present (the CLI's 20s force-exit is the inner bound)", () => {
    assert.match(unitText, /^TimeoutStartSec=\d+$/m, "expected a TimeoutStartSec= line");
  });

  test("keeps the unit's template shape: Type=oneshot and the %i instance", () => {
    assert.match(unitText, /^Type=oneshot$/m);
    assert.match(unitText, /%i/);
  });
});

describe("scripts/systemd/*: OnFailure= naming is normalised to hydra-notify-failure@%n (issue #5046)", () => {
  test("every OnFailure= line in every tracked unit is exactly OnFailure=hydra-notify-failure@%n", () => {
    const seen: string[] = [];
    for (const name of readdirSync(SYSTEMD_DIR).sort()) {
      const text = readFileSync(path.join(SYSTEMD_DIR, name), "utf8");
      for (const line of codeLines(text)) {
        if (!/^\s*OnFailure=/.test(line)) continue;
        seen.push(`${name}: ${line.trim()}`);
        assert.equal(
          line.trim(),
          "OnFailure=hydra-notify-failure@%n",
          `${name} must route failures as OnFailure=hydra-notify-failure@%n (got '${line.trim()}') — ` +
            "the %i the CLI receives must be the unit's own name, never '<unit>.service.service' or a hand-typed instance",
        );
      }
    }
    assert.ok(seen.length >= 2, `expected at least the autopilot and redis-backup units to declare OnFailure=, saw: ${seen.join("; ")}`);
  });
});

describe("scripts/deploy.sh installs the notify-failure template (issue #4284)", () => {
  test("installs scripts/systemd/hydra-notify-failure@.service to the user unit dir", () => {
    assert.match(
      deployText,
      /install -D -m 0644 scripts\/systemd\/hydra-notify-failure@\.service/,
    );
  });
});
