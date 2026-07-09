import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";

import {
  getTargetName,
  getTargetWorkspace,
  getTargetServiceName,
  getTargetWorktreePrefix,
  getTargetGithubRepo,
  getTargetCommitUrl,
  getTargetWebUrl,
  __resetForTests,
} from "../src/target-config.ts";

type EnvSnapshot = {
  HYDRA_TARGET_NAME: string | undefined;
  HYDRA_PROJECT_WORKSPACE: string | undefined;
  HYDRA_WORKSPACE: string | undefined;
  HYDRA_TARGET_GITHUB_REPO: string | undefined;
  HYDRA_TARGET_WEB_URL: string | undefined;
  HYDRA_BETTING_URL: string | undefined;
};

let snapshot: EnvSnapshot;
let warnCalls: unknown[][];
let originalWarn: typeof console.warn;

function saveEnv(): EnvSnapshot {
  return {
    HYDRA_TARGET_NAME: process.env.HYDRA_TARGET_NAME,
    HYDRA_PROJECT_WORKSPACE: process.env.HYDRA_PROJECT_WORKSPACE,
    HYDRA_WORKSPACE: process.env.HYDRA_WORKSPACE,
    HYDRA_TARGET_GITHUB_REPO: process.env.HYDRA_TARGET_GITHUB_REPO,
    HYDRA_TARGET_WEB_URL: process.env.HYDRA_TARGET_WEB_URL,
    HYDRA_BETTING_URL: process.env.HYDRA_BETTING_URL,
  };
}

function restoreEnv(snap: EnvSnapshot) {
  for (const key of [
    "HYDRA_TARGET_NAME",
    "HYDRA_PROJECT_WORKSPACE",
    "HYDRA_WORKSPACE",
    "HYDRA_TARGET_GITHUB_REPO",
    "HYDRA_TARGET_WEB_URL",
    "HYDRA_BETTING_URL",
  ] as const) {
    const v = snap[key];
    if (v === undefined) delete process.env[key];
    else process.env[key] = v;
  }
}

function setup() {
  snapshot = saveEnv();
  delete process.env.HYDRA_TARGET_NAME;
  delete process.env.HYDRA_PROJECT_WORKSPACE;
  delete process.env.HYDRA_WORKSPACE;
  delete process.env.HYDRA_TARGET_GITHUB_REPO;
  delete process.env.HYDRA_TARGET_WEB_URL;
  delete process.env.HYDRA_BETTING_URL;
  warnCalls = [];
  originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnCalls.push(args);
  };
  __resetForTests();
}

function teardown() {
  console.warn = originalWarn;
  restoreEnv(snapshot);
  __resetForTests();
}

test("getTargetName reads HYDRA_TARGET_NAME when set", () => {
  setup();
  try {
    process.env.HYDRA_TARGET_NAME = "my-target";
    assert.equal(getTargetName(), "my-target");
    assert.equal(warnCalls.length, 0);
  } finally {
    teardown();
  }
});

test("getTargetName returns hydra-betting and warns once when unset", () => {
  setup();
  try {
    assert.equal(getTargetName(), "hydra-betting");
    assert.equal(getTargetName(), "hydra-betting");
    assert.equal(getTargetName(), "hydra-betting");
    assert.equal(warnCalls.length, 1);
    assert.match(String(warnCalls[0]?.[0] ?? ""), /HYDRA_TARGET_NAME is unset/);
  } finally {
    teardown();
  }
});

test("getTargetName treats empty string as unset", () => {
  setup();
  try {
    process.env.HYDRA_TARGET_NAME = "";
    assert.equal(getTargetName(), "hydra-betting");
    assert.equal(warnCalls.length, 1);
  } finally {
    teardown();
  }
});

test("getTargetWorkspace reads HYDRA_PROJECT_WORKSPACE when set", () => {
  setup();
  try {
    process.env.HYDRA_PROJECT_WORKSPACE = "/srv/projects/foo";
    assert.equal(getTargetWorkspace(), "/srv/projects/foo");
    assert.equal(warnCalls.length, 0);
  } finally {
    teardown();
  }
});

test("getTargetWorkspace reads HYDRA_WORKSPACE legacy alias and warns once", () => {
  setup();
  try {
    process.env.HYDRA_WORKSPACE = "/srv/legacy/bar";
    assert.equal(getTargetWorkspace(), "/srv/legacy/bar");
    assert.equal(getTargetWorkspace(), "/srv/legacy/bar");
    const legacyWarns = warnCalls.filter((c) =>
      /HYDRA_WORKSPACE is deprecated/.test(String(c[0])),
    );
    assert.equal(legacyWarns.length, 1);
  } finally {
    teardown();
  }
});

test("getTargetWorkspace canonical takes precedence over legacy", () => {
  setup();
  try {
    process.env.HYDRA_PROJECT_WORKSPACE = "/srv/canonical";
    process.env.HYDRA_WORKSPACE = "/srv/legacy";
    assert.equal(getTargetWorkspace(), "/srv/canonical");
    assert.equal(warnCalls.length, 0);
  } finally {
    teardown();
  }
});

test("getTargetWorkspace falls back to <homedir>/<targetName> and warns when neither env is set", () => {
  setup();
  try {
    process.env.HYDRA_TARGET_NAME = "thing";
    assert.equal(getTargetWorkspace(), path.resolve(os.homedir(), "thing"));
    const workspaceWarns = warnCalls.filter((c) =>
      /HYDRA_PROJECT_WORKSPACE is unset/.test(String(c[0])),
    );
    assert.equal(workspaceWarns.length, 1);
  } finally {
    teardown();
  }
});

test("getTargetWorkspace homedir-fallback warning fires at most once per process", () => {
  setup();
  try {
    getTargetWorkspace();
    getTargetWorkspace();
    getTargetWorkspace();
    const workspaceWarns = warnCalls.filter((c) =>
      /HYDRA_PROJECT_WORKSPACE is unset/.test(String(c[0])),
    );
    assert.equal(workspaceWarns.length, 1);
  } finally {
    teardown();
  }
});

test("getTargetWorkspace treats empty strings as unset on both env vars", () => {
  setup();
  try {
    process.env.HYDRA_PROJECT_WORKSPACE = "";
    process.env.HYDRA_WORKSPACE = "";
    process.env.HYDRA_TARGET_NAME = "alpha";
    assert.equal(getTargetWorkspace(), path.resolve(os.homedir(), "alpha"));
    const legacyWarns = warnCalls.filter((c) =>
      /HYDRA_WORKSPACE is deprecated/.test(String(c[0])),
    );
    assert.equal(legacyWarns.length, 0);
  } finally {
    teardown();
  }
});

test("getTargetServiceName derives from HYDRA_TARGET_NAME", () => {
  setup();
  try {
    process.env.HYDRA_TARGET_NAME = "weather-app";
    assert.equal(getTargetServiceName(), "weather-app-web.service");
    assert.equal(warnCalls.length, 0);
  } finally {
    teardown();
  }
});

test("getTargetWorktreePrefix derives from HYDRA_TARGET_NAME", () => {
  setup();
  try {
    process.env.HYDRA_TARGET_NAME = "weather-app";
    assert.equal(getTargetWorktreePrefix(), "weather-app-worktree");
  } finally {
    teardown();
  }
});

test("getTargetName warning fires at most once per process across many calls", () => {
  setup();
  try {
    for (let i = 0; i < 10; i++) getTargetName();
    const nameWarns = warnCalls.filter((c) =>
      /HYDRA_TARGET_NAME is unset/.test(String(c[0])),
    );
    assert.equal(nameWarns.length, 1);
  } finally {
    teardown();
  }
});

test("no warnings when both canonical env vars are set", () => {
  setup();
  try {
    process.env.HYDRA_TARGET_NAME = "explicit";
    process.env.HYDRA_PROJECT_WORKSPACE = "/srv/explicit";
    getTargetName();
    getTargetWorkspace();
    getTargetServiceName();
    getTargetWorktreePrefix();
    assert.equal(warnCalls.length, 0);
  } finally {
    teardown();
  }
});

test("getTargetGithubRepo reads HYDRA_TARGET_GITHUB_REPO when set", () => {
  setup();
  try {
    process.env.HYDRA_TARGET_GITHUB_REPO = "acme/widgets";
    assert.equal(getTargetGithubRepo(), "acme/widgets");
    assert.equal(warnCalls.length, 0);
  } finally {
    teardown();
  }
});

test("getTargetGithubRepo returns gaberoo322/hydra-betting and warns once when unset", () => {
  setup();
  try {
    assert.equal(getTargetGithubRepo(), "gaberoo322/hydra-betting");
    assert.equal(getTargetGithubRepo(), "gaberoo322/hydra-betting");
    assert.equal(getTargetGithubRepo(), "gaberoo322/hydra-betting");
    const repoWarns = warnCalls.filter((c) =>
      /HYDRA_TARGET_GITHUB_REPO is unset/.test(String(c[0])),
    );
    assert.equal(repoWarns.length, 1);
  } finally {
    teardown();
  }
});

test("getTargetGithubRepo treats empty string as unset", () => {
  setup();
  try {
    process.env.HYDRA_TARGET_GITHUB_REPO = "";
    assert.equal(getTargetGithubRepo(), "gaberoo322/hydra-betting");
    const repoWarns = warnCalls.filter((c) =>
      /HYDRA_TARGET_GITHUB_REPO is unset/.test(String(c[0])),
    );
    assert.equal(repoWarns.length, 1);
  } finally {
    teardown();
  }
});

test("getTargetCommitUrl builds URL from configured repo and sha", () => {
  setup();
  try {
    process.env.HYDRA_TARGET_GITHUB_REPO = "acme/widgets";
    assert.equal(
      getTargetCommitUrl("deadbeef1234"),
      "https://github.com/acme/widgets/commit/deadbeef1234",
    );
    assert.equal(warnCalls.length, 0);
  } finally {
    teardown();
  }
});

test("getTargetCommitUrl falls back to default repo with a one-time warn when env unset", () => {
  setup();
  try {
    const url = getTargetCommitUrl("abc123");
    assert.equal(url, "https://github.com/gaberoo322/hydra-betting/commit/abc123");
    // Calling again should not produce additional warnings
    getTargetCommitUrl("def456");
    const repoWarns = warnCalls.filter((c) =>
      /HYDRA_TARGET_GITHUB_REPO is unset/.test(String(c[0])),
    );
    assert.equal(repoWarns.length, 1);
  } finally {
    teardown();
  }
});

test("getTargetWebUrl reads HYDRA_TARGET_WEB_URL when set", () => {
  setup();
  try {
    process.env.HYDRA_TARGET_WEB_URL = "https://target.example:8080";
    assert.equal(getTargetWebUrl(), "https://target.example:8080");
    assert.equal(warnCalls.length, 0);
  } finally {
    teardown();
  }
});

test("getTargetWebUrl reads HYDRA_BETTING_URL legacy alias and warns once", () => {
  setup();
  try {
    process.env.HYDRA_BETTING_URL = "http://legacy-betting:3333";
    assert.equal(getTargetWebUrl(), "http://legacy-betting:3333");
    assert.equal(getTargetWebUrl(), "http://legacy-betting:3333");
    const legacyWarns = warnCalls.filter((c) =>
      /HYDRA_BETTING_URL is deprecated/.test(String(c[0])),
    );
    assert.equal(legacyWarns.length, 1);
  } finally {
    teardown();
  }
});

test("getTargetWebUrl canonical takes precedence over legacy", () => {
  setup();
  try {
    process.env.HYDRA_TARGET_WEB_URL = "https://canonical:9000";
    process.env.HYDRA_BETTING_URL = "http://legacy:3333";
    assert.equal(getTargetWebUrl(), "https://canonical:9000");
    assert.equal(warnCalls.length, 0);
  } finally {
    teardown();
  }
});

test("getTargetWebUrl falls back to localhost default without warning when neither env is set", () => {
  setup();
  try {
    assert.equal(getTargetWebUrl(), "http://localhost:3333");
    // The localhost default is the ordinary single-host case, not a migration
    // hazard, so it must NOT warn.
    assert.equal(warnCalls.length, 0);
  } finally {
    teardown();
  }
});

test("getTargetWebUrl treats empty strings as unset on both env vars", () => {
  setup();
  try {
    process.env.HYDRA_TARGET_WEB_URL = "";
    process.env.HYDRA_BETTING_URL = "";
    assert.equal(getTargetWebUrl(), "http://localhost:3333");
    const legacyWarns = warnCalls.filter((c) =>
      /HYDRA_BETTING_URL is deprecated/.test(String(c[0])),
    );
    assert.equal(legacyWarns.length, 0);
  } finally {
    teardown();
  }
});

test("getTargetWebUrl legacy deprecation warning fires at most once per process", () => {
  setup();
  try {
    process.env.HYDRA_BETTING_URL = "http://legacy:3333";
    getTargetWebUrl();
    getTargetWebUrl();
    getTargetWebUrl();
    const legacyWarns = warnCalls.filter((c) =>
      /HYDRA_BETTING_URL is deprecated/.test(String(c[0])),
    );
    assert.equal(legacyWarns.length, 1);
  } finally {
    teardown();
  }
});
