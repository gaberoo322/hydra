import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";

import {
  getTargetName,
  getTargetWorkspace,
  getTargetServiceName,
  getTargetWorktreePrefix,
  __resetForTests,
} from "../src/target-config.ts";

type EnvSnapshot = {
  HYDRA_TARGET_NAME: string | undefined;
  HYDRA_PROJECT_WORKSPACE: string | undefined;
  HYDRA_WORKSPACE: string | undefined;
};

let snapshot: EnvSnapshot;
let warnCalls: unknown[][];
let originalWarn: typeof console.warn;

function saveEnv(): EnvSnapshot {
  return {
    HYDRA_TARGET_NAME: process.env.HYDRA_TARGET_NAME,
    HYDRA_PROJECT_WORKSPACE: process.env.HYDRA_PROJECT_WORKSPACE,
    HYDRA_WORKSPACE: process.env.HYDRA_WORKSPACE,
  };
}

function restoreEnv(snap: EnvSnapshot) {
  for (const key of [
    "HYDRA_TARGET_NAME",
    "HYDRA_PROJECT_WORKSPACE",
    "HYDRA_WORKSPACE",
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
