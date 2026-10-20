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
import { readFileSync, readdirSync } from "node:fs";
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

/** Non-comment lines only: comments may legitimately mention curl / the host. */
const unitCode = unitText
  .split("\n")
  .filter((l) => !/^\s*#/.test(l))
  .join("\n");

describe("scripts/systemd/hydra-notify-failure@.service (issues #4284, #5046)", () => {
  test("ExecStart is the Operator Channel CLI under node strip-types", () => {
    assert.match(
      unitText,
      /^ExecStart=\/usr\/bin\/node --experimental-strip-types %h\/hydra\/scripts\/operator-notify\.ts service-failed --unit %i$/m,
    );
  });

  test("no longer curls or talks to the Bot API directly", () => {
    assert.doesNotMatch(unitCode, /curl/);
    assert.doesNotMatch(unitCode, /api\.telegram\.org/);
    assert.doesNotMatch(unitCode, /\$\$MSG|\$\{TELEGRAM_/);
  });

  test("sources credentials from a non-optional EnvironmentFile=%h/hydra/.env", () => {
    assert.match(unitText, /^EnvironmentFile=%h\/hydra\/\.env$/m);
    assert.doesNotMatch(unitText, /^EnvironmentFile=-/m);
  });

  test("never inlines a literal TELEGRAM_* Environment= line or a token-shaped literal", () => {
    assert.doesNotMatch(unitText, /^Environment=TELEGRAM_/m);
    assert.doesNotMatch(unitText, /\d+:[A-Za-z0-9_-]{20,}/);
  });

  test("declares no OnFailure= (no self-recursion) and bounds the run with TimeoutStartSec", () => {
    assert.doesNotMatch(unitText, /^OnFailure=/m);
    assert.match(unitText, /^TimeoutStartSec=\d+$/m);
    assert.match(unitText, /^Type=oneshot$/m);
  });
});

describe("tracked units normalise OnFailure= to hydra-notify-failure@%n (issue #5046)", () => {
  const dir = path.join(REPO_ROOT, "scripts/systemd");
  const lines = readdirSync(dir).flatMap((f) =>
    readFileSync(path.join(dir, f), "utf8")
      .split("\n")
      .filter((l) => /^OnFailure=/.test(l))
      .map((l) => ({ f, l })),
  );

  test("at least the autopilot and redis-backup units declare OnFailure=", () => {
    const files = new Set(lines.map((x) => x.f));
    assert.ok(files.has("hydra-autopilot.service"));
    assert.ok(files.has("hydra-redis-backup.service"));
  });

  test("every OnFailure= line is exactly OnFailure=hydra-notify-failure@%n", () => {
    for (const { f, l } of lines) assert.equal(l, "OnFailure=hydra-notify-failure@%n", f);
  });

  test("the watchdog unit loads .env optionally (dash-prefixed) for the CLI credentials", () => {
    const wd = readFileSync(path.join(dir, "hydra-watchdog.service"), "utf8");
    assert.match(wd, /^EnvironmentFile=-%h\/hydra\/\.env$/m);
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
