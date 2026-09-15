/**
 * Pins the fix for issue #4284: `hydra-notify-failure@.service` silently
 * blanked every OnFailure Telegram page because systemd's own
 * specifier/environment substitution pass on `ExecStart=` runs BEFORE bash,
 * and `MSG` is a bash-local variable — so a bare `${MSG}` (or `$MSG`) always
 * resolved to the empty string. The fix escapes it as `$$MSG` (systemd's
 * literal-dollar escape) and tracks the unit under `scripts/systemd/` with
 * credentials sourced from `EnvironmentFile=%h/hydra/.env` instead of an
 * inline `Environment=TELEGRAM_*` literal.
 *
 * Pure `fs` reads only — no systemd invocation, no network call, no Telegram
 * send (per the design-concept artifact for issue-4284: qaTrace "What does
 * the test assert and how?").
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const UNIT_PATH = path.join(
  REPO_ROOT,
  "scripts/systemd/hydra-notify-failure@.service",
);
const DEPLOY_SH_PATH = path.join(REPO_ROOT, "scripts/deploy.sh");

const unitText = readFileSync(UNIT_PATH, "utf8");
const deployText = readFileSync(DEPLOY_SH_PATH, "utf8");

describe("scripts/systemd/hydra-notify-failure@.service (issue #4284)", () => {
  test("escapes the bash-local message as $$MSG, never ${MSG} or bare $MSG", () => {
    assert.match(unitText, /\$\$MSG/, "expected the literal $$MSG escape");
    assert.doesNotMatch(
      unitText,
      /\$\{MSG\}/,
      "${MSG} is blanked to empty by systemd's own substitution pass before bash runs",
    );
    // A bare (non-brace) $MSG immediately preceded by systemd's own two
    // dollar signs is fine ($$MSG IS a bare $MSG once systemd unescapes it);
    // what must never appear is a THIRD, unescaped single-dollar occurrence.
    assert.doesNotMatch(
      unitText,
      /[^$]\$MSG\b/,
      "a lone $MSG (not preceded by the $$ escape) is also blanked by systemd",
    );
  });

  test("keeps the genuine systemd environment variables in ${...} form", () => {
    assert.match(unitText, /\$\{TELEGRAM_BOT_TOKEN\}/);
    assert.match(unitText, /\$\{TELEGRAM_CHAT_ID\}/);
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

  test("keeps the unit's existing shape: Type=oneshot, %i, curl swallowed with || true", () => {
    assert.match(unitText, /^Type=oneshot$/m);
    assert.match(unitText, /%i/);
    assert.match(unitText, /\|\| true/);
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
