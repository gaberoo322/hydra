/**
 * source-freshness.test.mts — staleness probe for the OpenViking source index
 * (issue #2267).
 *
 * Covers the pure URI predicate, the injectable search probe (present / absent /
 * error-fail-safe branches), and the lifecycle staleness detector's
 * decision table (cold cache -> no-op, healthy OV -> no-op, reset OV -> clear).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  hasIndexedResourceUri,
  probeOvSourceResourcesPresent,
  OV_RESOURCE_URI_PREFIX,
} from "../src/knowledge-base/source-freshness.ts";

describe("hasIndexedResourceUri", () => {
  test("true when any URI is under viking://resources/", () => {
    assert.equal(
      hasIndexedResourceUri([
        { uri: "viking://temp/06200344/upload/abstract.md" },
        { uri: `${OV_RESOURCE_URI_PREFIX}hydra-memory/hydra-source_src__foo.md` },
      ]),
      true,
    );
  });

  test("false when only temp uploads are present (the stale-OV signal)", () => {
    assert.equal(
      hasIndexedResourceUri([
        { uri: "viking://temp/06200344/upload/abstract.md" },
        { uri: "viking://temp/06200345/upload/report.md" },
      ]),
      false,
    );
  });

  test("false for empty / null / non-array input", () => {
    assert.equal(hasIndexedResourceUri([]), false);
    assert.equal(hasIndexedResourceUri(null), false);
    assert.equal(hasIndexedResourceUri(undefined), false);
  });

  test("tolerates malformed entries (missing / non-string uri) without throwing", () => {
    assert.equal(
      hasIndexedResourceUri([
        {},
        { uri: 42 as any },
        { uri: null as any },
        { uri: `${OV_RESOURCE_URI_PREFIX}ok` },
      ]),
      true,
    );
    assert.equal(hasIndexedResourceUri([{}, { uri: 42 as any }]), false);
  });
});

describe("probeOvSourceResourcesPresent", () => {
  test("present when search returns a viking://resources/ resource", async () => {
    const search = async () => ({
      resources: [{ uri: `${OV_RESOURCE_URI_PREFIX}hydra-memory/x.md` }],
      memories: [],
    });
    assert.equal(await probeOvSourceResourcesPresent(search), true);
  });

  test("present when only memories carry the resources/ URI", async () => {
    const search = async () => ({
      resources: [{ uri: "viking://temp/x.md" }],
      memories: [{ uri: `${OV_RESOURCE_URI_PREFIX}hydra-memory/y.md` }],
    });
    assert.equal(await probeOvSourceResourcesPresent(search), true);
  });

  test("absent when search returns only temp uploads (OV reset signal)", async () => {
    const search = async () => ({
      resources: [{ uri: "viking://temp/x.md" }],
      memories: [],
    });
    assert.equal(await probeOvSourceResourcesPresent(search), false);
  });

  test("absent when search returns nothing at all", async () => {
    const search = async () => ({ resources: [], memories: [] });
    assert.equal(await probeOvSourceResourcesPresent(search), false);
  });

  test("FAILS SAFE: a probe error reports present (never triggers a clear)", async () => {
    const search = async () => {
      throw new Error("OV unreachable");
    };
    assert.equal(await probeOvSourceResourcesPresent(search), true);
  });
});
