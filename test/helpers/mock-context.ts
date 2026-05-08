/**
 * Shared test factory for CycleContext and its sub-interfaces.
 *
 * Produces a complete, type-safe CycleContext so test files avoid TS2345
 * errors from incomplete mocks. Callers override only the fields their
 * test cares about.
 */

import type {
  CycleContext,
  GroundingReport,
  OVSession,
  EventBus,
  Anchor,
  AnchorConfidence,
} from "../../src/cycle-helpers.ts";

// ---------------------------------------------------------------------------
// Sub-factories
// ---------------------------------------------------------------------------

export function createMockGrounding(
  overrides: Partial<GroundingReport> = {},
): GroundingReport {
  return {
    branch: "master",
    headCommit: "abc1234deadbeef",
    recentCommits: [],
    dirtyFiles: [],
    fileTree: "",
    fileCount: 0,
    testReport: {
      ran: true,
      exitCode: 0,
      stdout: "",
      stderr: "",
      passed: 42,
      failed: 0,
      total: 42,
      durationMs: 5000,
    },
    typecheckReport: {
      ran: true,
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 1000,
    },
    failingTests: [],
    recentDiffs: "",
    todoMarkers: [],
    readme: "",
    packageJson: {},
    timestamp: Date.now(),
    groundingDurationMs: 5000,
    ...overrides,
  };
}

export function createMockOVSession(
  overrides: Partial<OVSession> = {},
): OVSession {
  return {
    sessionId: "test-session",
    cycleId: "test-cycle",
    active: false,
    async logPlanner() {},
    async logSkeptic() {},
    async logExecutor() {},
    async logOutcome() {},
    async logVerification() {},
    async markUsed() {},
    async commit() {},
    ...overrides,
  };
}

export function createMockEventBus(): EventBus & { published: any[] } {
  const published: any[] = [];
  return {
    published,
    async publish(_stream: string, event: any) {
      published.push(event);
    },
  };
}

export function createMockAnchor(overrides: Partial<Anchor> = {}): Anchor {
  return {
    type: "priorities",
    reference: "test-anchor-ref",
    whyNow: "Test anchor",
    ...overrides,
  };
}

export function createMockAnchorConfidence(
  overrides: Partial<AnchorConfidence> = {},
): AnchorConfidence {
  return {
    score: 0.75,
    reason: "heuristic",
    tier: "heuristic" as const,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Top-level factory
// ---------------------------------------------------------------------------

export function createMockCycleContext(
  overrides: Partial<CycleContext> = {},
): CycleContext {
  return {
    cycleId: "cycle-test-0000",
    startTime: Date.now(),
    grounding: createMockGrounding(),
    groundingSummary: "Tests: 42 passed, 0 failed. Typecheck clean.",
    ovSession: createMockOVSession(),
    eventBus: createMockEventBus(),
    anchor: createMockAnchor(),
    anchorConfidence: createMockAnchorConfidence(),
    ...overrides,
  };
}
