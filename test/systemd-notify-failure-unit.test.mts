/**
 * Pins scripts/systemd/hydra-notify-failure@.service (issue #4284).
 *
 * The fleet-wide OnFailure= notifier was host-local and interpolated its
 * bash-local message as `${MSG}`. systemd performs its own `${VAR}`
 * substitution over ExecStart= before bash runs and blanks unknown variables,
 * so every Telegram page went out with an empty body. The unit is now tracked
 * and installed by scripts/deploy.sh; these tests pin the escape, the
 * credential source, and the install wiring by reading the files as text.
 * No systemd invocation, no network, no Telegram send.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const UNIT_PATH = join(ROOT, "scripts/systemd/hydra-notify-failure@.service");
const DEPLOY_PATH = join(ROOT, "scripts/deploy.sh");

const unit = readFileSync(UNIT_PATH, "utf8");
const deploy = readFileSync(DEPLOY_PATH, "utf8");

/** Non-comment lines only — comments may explain the bug without tripping pins. */
const directiveLines = unit
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("#"));
const directives = directiveLines.join("\n");

/** The full ExecStart= value, including its backslash-continued lines. */
function execStart(): string {
  const start = directiveLines.findIndex((l) => l.startsWith("ExecStart="));
  assert.notEqual(start, -1, "unit must declare ExecStart=");
  const out: string[] = [];
  for (let i = start; i < directiveLines.length; i++) {
    out.push(directiveLines[i]);
    if (!directiveLines[i].trimEnd().endsWith("\\")) break;
  }
  return out.join("\n");
}

describe("hydra-notify-failure@.service unit text", () => {
  test("payload interpolates the bash-local message as $$MSG, never ${MSG} or bare $MSG", () => {
    const exec = execStart();
    assert.ok(exec.includes('\\"text\\":\\"$$MSG\\"'), "payload text must be $$MSG");
    assert.ok(!unit.includes("${MSG}"), "the unit must never contain ${MSG}");
    // A `$MSG` not preceded by another `$` is a bare reference systemd would blank.
    assert.doesNotMatch(exec, /(?<!\$)\$MSG/, "no bare $MSG in ExecStart");
  });

  test("only systemd-provided TELEGRAM vars use the ${...} form in ExecStart", () => {
    const braced = [...execStart().matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]);
    assert.deepEqual(
      [...new Set(braced)].sort(),
      ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"],
    );
  });

  test("credentials come only from a non-optional EnvironmentFile=%h/hydra/.env", () => {
    const envFiles = directiveLines.filter((l) => l.startsWith("EnvironmentFile="));
    assert.deepEqual(envFiles, ["EnvironmentFile=%h/hydra/.env"]);
    assert.doesNotMatch(directives, /^EnvironmentFile=-/m, "EnvironmentFile must not be dash-prefixed");
  });

  test("the tracked unit carries no inline TELEGRAM Environment= and no token-shaped literal", () => {
    assert.doesNotMatch(directives, /^Environment=TELEGRAM_/m);
    assert.doesNotMatch(unit, /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/, "no bot-token-shaped literal");
    assert.doesNotMatch(unit, /chat_id\\?"\s*:\s*\\?"-?\d+/, "no literal chat id");
  });

  test("the notifier declares no OnFailure= (no self-recursion)", () => {
    assert.doesNotMatch(directives, /^OnFailure=/m);
  });

  test("the unit keeps its oneshot shape: Type=oneshot, %i in the message, curl failure swallowed", () => {
    assert.match(directives, /^Type=oneshot$/m);
    const exec = execStart();
    assert.match(exec, /MSG="[^"]*%i[^"]*"/, "message must name the failed unit via %i");
    assert.match(exec, /curl -s -X POST/);
    assert.match(exec, /\|\| true'$/, "curl failure must be swallowed with || true");
  });
});

describe("scripts/deploy.sh installs the notifier unit", () => {
  test("deploy.sh installs the tracked unit with install -D -m 0644 before a daemon-reload", () => {
    const installLine =
      'install -D -m 0644 scripts/systemd/hydra-notify-failure@.service "$HOME/.config/systemd/user/hydra-notify-failure@.service"';
    const installIdx = deploy.indexOf(installLine);
    assert.notEqual(installIdx, -1, "deploy.sh must install the notifier unit");
    const reloadIdx = deploy.indexOf("systemctl --user daemon-reload", installIdx);
    assert.notEqual(reloadIdx, -1, "a daemon-reload must follow the install");
  });

  test("deploy.sh never starts or enables the notifier template directly", () => {
    assert.doesNotMatch(deploy, /systemctl[^\n]*(start|restart|enable)[^\n]*hydra-notify-failure/);
  });

  test("sibling units referencing the notifier use the preserved template name", () => {
    const autopilot = readFileSync(join(ROOT, "scripts/systemd/hydra-autopilot.service"), "utf8");
    assert.match(autopilot, /^OnFailure=hydra-notify-failure@%n\.service$/m);
  });
});
