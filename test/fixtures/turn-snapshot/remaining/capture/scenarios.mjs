// Scenarios for capture.mjs (ADR-0043 slice 5B, #4933). Each scenario is the
// raw world one or more of the old bash collectors read: the scripted `gh`
// responses (raw API JSON, BEFORE the bash's `--jq` — keyed
// `issue-list:<label|->:<json fields>` / `graphql:<map number>`), the Redis
// keyspace (or `down`), the data-plane HTTP routes, and env.

const DATE = "2026-10-07";
const TOKENS_KEY = `hydra:metrics:tokens:by-skill:daily:${DATE}`;
const WQ = "hydra:anchors:work-queue";
const RQ = "hydra:anchors:reframe-queue";
const PF = "hydra:anchors:prior-failures";
const WALK = "hydra:scout:last-calendar-walk";
const ARCH = "hydra:architecture:last-run";

const BOARD = "issue-list:-:number,labels";
const ENH = "issue-list:enhancement:number";
const HITL = "issue-list:hitl-grill:number";
const MAPS = "issue-list:wayfinder:map:number,labels";
const TICKETS = "issue-list:needs-tickets:number,assignees";

const iss = (number, ...labels) => ({ number, labels: labels.map((name) => ({ id: `L_${name}`, name })) });
const nums = (n) => Array.from({ length: n }, (_, i) => ({ number: i + 1 }));
const board = (spec) => {
  const out = [];
  let n = 1;
  for (const [labels, count] of spec) for (let i = 0; i < count; i++) out.push(iss(n++, ...labels));
  return out;
};
const ok = (json) => ({ json });
const FAIL = { exitCode: 1 };

// ---------------------------------------------------------------- group A
const redisHealthy = { lists: { [WQ]: 3, [RQ]: 0, [PF]: 7 }, strings: { [WALK]: "2026-09-18T20:26:04.715Z", [ARCH]: "2026-10-06T10:00:00Z" }, hashes: { [TOKENS_KEY]: { "hydra-tool-scout": "12345" } } };

const groupA = [
  { name: "redis-queues-healthy", collectors: ["redis-queues"], redis: redisHealthy },
  { name: "redis-queues-empty-keyspace", collectors: ["redis-queues"], redis: {} },
  { name: "redis-queues-redis-down", collectors: ["redis-queues"], redis: { down: true } },

  { name: "scout-healthy-no-rate", collectors: ["scout"], redis: redisHealthy, gh: { [ENH]: ok(nums(5)) } },
  { name: "scout-rate-set", collectors: ["scout"], redis: redisHealthy, gh: { [ENH]: ok(nums(25)) }, env: { HYDRA_TOKEN_USD_RATE: "3" } },
  { name: "scout-rate-exponent", collectors: ["scout"], redis: redisHealthy, gh: { [ENH]: ok([]) }, env: { HYDRA_TOKEN_USD_RATE: "1.5e1" } },
  { name: "scout-rate-non-numeric", collectors: ["scout"], redis: redisHealthy, gh: { [ENH]: ok([]) }, env: { HYDRA_TOKEN_USD_RATE: "abc" } },
  { name: "scout-rate-numeric-prefix", collectors: ["scout"], redis: redisHealthy, gh: { [ENH]: ok([]) }, env: { HYDRA_TOKEN_USD_RATE: "2.5usd" } },
  { name: "scout-rate-zero", collectors: ["scout"], redis: redisHealthy, gh: { [ENH]: ok([]) }, env: { HYDRA_TOKEN_USD_RATE: "0" } },
  { name: "scout-rate-negative", collectors: ["scout"], redis: redisHealthy, gh: { [ENH]: ok([]) }, env: { HYDRA_TOKEN_USD_RATE: "-4" } },
  {
    name: "scout-half-even-tie",
    collectors: ["scout"],
    redis: { hashes: { [TOKENS_KEY]: { "hydra-tool-scout": "1000000" } } },
    gh: { [ENH]: ok([]) },
    env: { HYDRA_TOKEN_USD_RATE: "0.0078125" },
  },
  {
    name: "scout-quoted-values",
    collectors: ["scout"],
    redis: { strings: { [WALK]: '"2026-09-01T00:00:00Z"' }, hashes: { [TOKENS_KEY]: { "hydra-tool-scout": '"500"' } } },
    gh: { [ENH]: ok(nums(1)) },
    env: { HYDRA_TOKEN_USD_RATE: "2" },
  },
  { name: "scout-tokens-non-numeric", collectors: ["scout"], redis: { hashes: { [TOKENS_KEY]: { "hydra-tool-scout": "12abc" } } }, gh: { [ENH]: ok([]) }, env: { HYDRA_TOKEN_USD_RATE: "2" } },
  { name: "scout-tokens-leading-zeros", collectors: ["scout"], redis: { hashes: { [TOKENS_KEY]: { "hydra-tool-scout": "007" } } }, gh: { [ENH]: ok([]) }, env: { HYDRA_TOKEN_USD_RATE: "1" } },
  { name: "scout-keyspace-empty", collectors: ["scout"], redis: {}, gh: { [ENH]: ok([]) } },
  { name: "scout-redis-down", collectors: ["scout"], redis: { down: true }, gh: { [ENH]: ok(nums(3)) }, env: { HYDRA_TOKEN_USD_RATE: "3" } },
  { name: "scout-gh-error", collectors: ["scout"], redis: redisHealthy, gh: { [ENH]: FAIL } },
  { name: "scout-gh-unparseable", collectors: ["scout"], redis: redisHealthy, gh: { [ENH]: { raw: "not json" } } },
  { name: "scout-gh-object-payload", collectors: ["scout"], redis: redisHealthy, gh: { [ENH]: ok({ a: 1, b: 2 }) } },
  { name: "scout-other-date", collectors: ["scout"], date: "2026-01-02", redis: { hashes: { "hydra:metrics:tokens:by-skill:daily:2026-01-02": { "hydra-tool-scout": "42" } } }, gh: { [ENH]: ok([]) } },

  {
    name: "arch-mixed-board",
    collectors: ["arch-cleanup-boards"],
    redis: { ...redisHealthy, lists: { [WQ]: 0 } },
    gh: {
      [BOARD]: ok(
        board([
          [["ready-for-agent"], 2],
          [["ready-for-agent", "target-backlog"], 3],
          [["needs-research"], 1],
          [["needs-triage", "architecture-scan"], 2],
          [["cleanup-scan"], 4],
          [["skill-prune"], 1],
          [["enhancement"], 5],
          [["bug"], 2],
        ]),
      ),
    },
  },
  { name: "arch-idle-board", collectors: ["arch-cleanup-boards"], redis: { lists: { [WQ]: 0 } }, gh: { [BOARD]: ok([]) } },
  { name: "arch-idle-but-work-queue", collectors: ["arch-cleanup-boards"], redis: { lists: { [WQ]: 2 } }, gh: { [BOARD]: ok([]) } },
  { name: "arch-target-backlog-only-is-idle", collectors: ["arch-cleanup-boards"], redis: {}, gh: { [BOARD]: ok(board([[["ready-for-agent", "target-backlog"], 4]])) } },
  {
    name: "arch-saturated-at-caps",
    collectors: ["arch-cleanup-boards"],
    redis: {},
    gh: { [BOARD]: ok(board([[["architecture-scan"], 6], [["enhancement"], 20], [["cleanup-scan"], 10], [["skill-prune"], 3]])) },
  },
  {
    name: "arch-saturated-over-caps",
    collectors: ["arch-cleanup-boards"],
    redis: {},
    gh: { [BOARD]: ok(board([[["architecture-scan"], 7], [["cleanup-scan"], 11], [["skill-prune"], 4]])) },
  },
  { name: "arch-enhancement-over-cap", collectors: ["arch-cleanup-boards"], redis: {}, gh: { [BOARD]: ok(board([[["enhancement"], 21]])) } },
  { name: "arch-gh-error-degraded", collectors: ["arch-cleanup-boards"], redis: redisHealthy, gh: { [BOARD]: FAIL } },
  { name: "arch-gh-unparseable-degraded", collectors: ["arch-cleanup-boards"], redis: redisHealthy, gh: { [BOARD]: { raw: "not json" } } },
  { name: "arch-labels-null-degraded", collectors: ["arch-cleanup-boards"], redis: {}, gh: { [BOARD]: ok([{ number: 1, labels: null }]) } },
  { name: "arch-label-without-name", collectors: ["arch-cleanup-boards"], redis: {}, gh: { [BOARD]: ok([{ number: 1, labels: [{ id: "x" }] }, iss(2, "needs-triage")]) } },
  { name: "arch-object-payload", collectors: ["arch-cleanup-boards"], redis: {}, gh: { [BOARD]: ok({ a: iss(1, "ready-for-agent"), b: iss(2, "cleanup-scan") }) } },
  { name: "arch-upstream-degraded", collectors: ["arch-cleanup-boards"], orchBoardDegraded: "1", redis: {}, gh: { [BOARD]: ok([]) } },
  { name: "arch-upstream-degraded-not-1", collectors: ["arch-cleanup-boards"], orchBoardDegraded: "true", redis: {}, gh: { [BOARD]: ok([]) } },
  { name: "arch-redis-down", collectors: ["arch-cleanup-boards"], redis: { down: true }, gh: { [BOARD]: ok([]) } },

  { name: "hitl-grill-below-cap", collectors: ["hitl-grill"], gh: { [HITL]: ok(nums(9)) } },
  { name: "hitl-grill-at-cap", collectors: ["hitl-grill"], gh: { [HITL]: ok(nums(10)) } },
  { name: "hitl-grill-over-cap", collectors: ["hitl-grill"], gh: { [HITL]: ok(nums(11)) } },
  { name: "hitl-grill-empty-inbox", collectors: ["hitl-grill"], gh: { [HITL]: ok([]) } },
  { name: "hitl-grill-gh-error", collectors: ["hitl-grill"], gh: { [HITL]: FAIL } },
  { name: "hitl-grill-gh-unparseable", collectors: ["hitl-grill"], gh: { [HITL]: { raw: "gh: error (rate limit)" } } },
  { name: "hitl-grill-null-payload", collectors: ["hitl-grill"], gh: { [HITL]: ok(null) } },

  {
    name: "group-a-healthy",
    collectors: ["redis-queues", "scout", "arch-cleanup-boards", "hitl-grill"],
    redis: redisHealthy,
    gh: { [ENH]: ok(nums(4)), [BOARD]: ok(board([[["ready-for-agent"], 1], [["enhancement"], 4]])), [HITL]: ok(nums(2)) },
    env: { HYDRA_TOKEN_USD_RATE: "3" },
  },
  {
    name: "group-a-all-failed",
    collectors: ["redis-queues", "scout", "arch-cleanup-boards", "hitl-grill"],
    redis: { down: true },
    gh: {},
  },
];

// ---------------------------------------------------------------- group B
const runs = (...rs) => ({ status: 200, body: JSON.stringify({ runs: rs }) });
const RUNS = "/autopilot/runs?limit=14";
const bundle = (b) => ({ status: 200, body: JSON.stringify(b) });
const CLEAN = { runFound: true, dispatches: [{ flagged: false }], reflections: [], stuckSignals: [], recommendations: [] };
const retro = (name, bundleResp, runsResp = runs({ run_id: "r-running", status: "running" }, { run_id: "r1", status: "ended" })) => ({
  name,
  collectors: ["retro"],
  http: { [RUNS]: runsResp, ...(bundleResp === undefined ? {} : { "/autopilot/runs/r1/retro": bundleResp }) },
});

const groupBRetro = [
  retro("retro-clean-run-not-drillable", bundle(CLEAN)),
  retro("retro-flagged-dispatch", bundle({ ...CLEAN, dispatches: [{ flagged: false }, { flagged: true }] })),
  retro("retro-reflections", bundle({ ...CLEAN, reflections: [{ a: 1 }] })),
  retro("retro-stuck-signals", bundle({ ...CLEAN, stuckSignals: ["x"] })),
  retro("retro-recommendations", bundle({ ...CLEAN, recommendations: [{}] })),
  retro("retro-run-flagged", bundle({ ...CLEAN, runFlagged: true })),
  retro("retro-run-flagged-truthy-not-true", bundle({ ...CLEAN, runFlagged: 1 })),
  retro("retro-run-not-found", bundle({ ...CLEAN, runFound: false })),
  retro("retro-run-found-missing", bundle({ dispatches: [], reflections: [] })),
  retro("retro-run-found-truthy-not-true", bundle({ ...CLEAN, runFound: 1 })),
  retro("retro-bundle-http-500", { status: 500, body: '{"error":"boom"}' }),
  retro("retro-bundle-not-json", { status: 200, body: "nope" }),
  retro("retro-bundle-list", bundle([1, 2])),
  retro("retro-bundle-network-error", { network: true }),
  retro("retro-bundle-404", undefined),
  retro("retro-dispatches-not-list", bundle({ ...CLEAN, dispatches: { flagged: true } })),
  retro("retro-dispatch-non-dict", bundle({ ...CLEAN, dispatches: ["flagged", 1] })),
  retro("retro-null-lists", bundle({ runFound: true, dispatches: null, reflections: null, stuckSignals: null, recommendations: null })),
  retro("retro-all-running", undefined, runs({ run_id: "a", status: "running" }, { run_id: "b", status: "RUNNING" })),
  retro("retro-empty-status-not-completed", undefined, runs({ run_id: "a", status: "" })),
  retro("retro-null-status-counts-completed", bundle(CLEAN), runs({ run_id: "r1", status: null })),
  retro("retro-missing-status-not-completed", undefined, runs({ run_id: "r1" })),
  retro("retro-first-completed-no-run-id", undefined, runs({ status: "ended" }, { run_id: "r1", status: "ended" })),
  retro("retro-numeric-run-id", undefined, runs({ run_id: 7, status: "killed" })),
  retro("retro-runs-http-500", undefined, { status: 500, body: "{}" }),
  retro("retro-runs-network-error", undefined, { network: true }),
  retro("retro-runs-not-json", undefined, { status: 200, body: "garbage" }),
  retro("retro-runs-list-payload", undefined, { status: 200, body: "[]" }),
  retro("retro-runs-no-runs-key", undefined, { status: 200, body: "{}" }),
  retro("retro-runs-non-dict-entries", bundle(CLEAN), runs("x", 3, { run_id: "r1", status: "completed" })),
];

const map = (...nodes) => ({ json: { data: { repository: { issue: { subIssues: { nodes } } } } } });
const sub = (number, { state = "OPEN", labels = ["wayfinder:task"], assigned = 0, blockedBy = [] } = {}) => ({
  number,
  state,
  labels: { nodes: labels.map((name) => ({ name })) },
  assignees: { totalCount: assigned },
  blockedBy: { nodes: blockedBy.map(([n, s]) => ({ number: n, state: s })) },
});
const wf = (name, gh) => ({ name, collectors: ["wayfinder-frontier"], gh });

const groupBWayfinder = [
  wf("wayfinder-no-maps", { [MAPS]: ok([]) }),
  wf("wayfinder-maps-gh-error", { [MAPS]: FAIL }),
  wf("wayfinder-one-map-research-pick", { [MAPS]: ok([iss(10, "wayfinder:map")]), "graphql:10": map(sub(11, { labels: ["wayfinder:research"] })) }),
  wf("wayfinder-one-map-task-pick", { [MAPS]: ok([iss(10, "wayfinder:map")]), "graphql:10": map(sub(11, { labels: ["bug", "wayfinder:task"] })) }),
  wf("wayfinder-inflight-blocks-pick", { [MAPS]: ok([iss(10, "wayfinder:map")]), "graphql:10": map(sub(11, { assigned: 1 }), sub(12)) }),
  wf("wayfinder-blocked-ticket-skipped", {
    [MAPS]: ok([iss(10, "wayfinder:map")]),
    "graphql:10": map(sub(11, { blockedBy: [[5, "OPEN"]] }), sub(12, { blockedBy: [[6, "CLOSED"]] })),
  }),
  wf("wayfinder-hitl-types-ignored", {
    [MAPS]: ok([iss(10, "wayfinder:map")]),
    "graphql:10": map(sub(11, { labels: ["wayfinder:grilling"], assigned: 1 }), sub(12, { labels: ["wayfinder:prototype"] })),
  }),
  wf("wayfinder-closed-tickets-ignored", { [MAPS]: ok([iss(10, "wayfinder:map")]), "graphql:10": map(sub(11, { state: "CLOSED", assigned: 1 }), sub(12, { state: "CLOSED" })) }),
  wf("wayfinder-destination-pending-excluded", {
    [MAPS]: ok([iss(10, "wayfinder:map", "wayfinder:destination-pending"), iss(20, "wayfinder:map")]),
    "graphql:10": map(sub(11)),
    "graphql:20": map(sub(21, { labels: ["wayfinder:research"] })),
  }),
  wf("wayfinder-maps-sorted-first-pick-wins", {
    [MAPS]: ok([iss(30, "wayfinder:map"), iss(20, "wayfinder:map")]),
    "graphql:20": map(sub(21)),
    "graphql:30": map(sub(31, { labels: ["wayfinder:research"] })),
  }),
  wf("wayfinder-global-inflight-sums-every-map", {
    [MAPS]: ok([iss(10, "wayfinder:map"), iss(20, "wayfinder:map"), iss(30, "wayfinder:map")]),
    "graphql:10": map(sub(11, { assigned: 1 }), sub(12, { assigned: 2 })),
    "graphql:20": map(sub(21)),
    "graphql:30": map(sub(31, { assigned: 1 })),
  }),
  wf("wayfinder-graphql-error-one-map", {
    [MAPS]: ok([iss(10, "wayfinder:map"), iss(20, "wayfinder:map")]),
    "graphql:10": FAIL,
    "graphql:20": map(sub(21, { assigned: 1 })),
  }),
  wf("wayfinder-graphql-null-issue", {
    [MAPS]: ok([iss(10, "wayfinder:map"), iss(20, "wayfinder:map")]),
    "graphql:10": { json: { data: { repository: { issue: null } } } },
    "graphql:20": map(sub(21)),
  }),
  wf("wayfinder-map-no-subissues", { [MAPS]: ok([iss(10, "wayfinder:map")]), "graphql:10": map() }),
  wf("wayfinder-labels-null-node", { [MAPS]: ok([iss(10, "wayfinder:map")]), "graphql:10": map({ number: 11, state: "OPEN", labels: null, assignees: { totalCount: 0 } }) }),
  wf("wayfinder-blockedby-missing", {
    [MAPS]: ok([iss(10, "wayfinder:map")]),
    "graphql:10": map({ number: 11, state: "OPEN", labels: { nodes: [{ name: "wayfinder:task" }] }, assignees: { totalCount: 0 } }),
  }),
  wf("wayfinder-assignees-missing-not-inflight", {
    [MAPS]: ok([iss(10, "wayfinder:map")]),
    "graphql:10": map({ number: 11, state: "OPEN", labels: { nodes: [{ name: "wayfinder:task" }] }, blockedBy: { nodes: [] } }),
  }),
  wf("wayfinder-maps-labels-null", { [MAPS]: ok([{ number: 10, labels: null }]) }),
  wf("wayfinder-maps-string-number", { [MAPS]: ok([{ number: "12", labels: [] }]), "graphql:12": map(sub(13)) }),
  wf("wayfinder-maps-bad-number-stops-loop", {
    [MAPS]: ok([{ number: 5, labels: [] }, { number: null, labels: [] }, { number: 9, labels: [] }]),
    "graphql:5": map(sub(6, { assigned: 1 })),
    "graphql:9": map(sub(10)),
  }),
];

const tk = (name, gh) => ({ name, collectors: ["tickets"], gh });
const asg = (number, n) => ({ number, assignees: Array.from({ length: n }, (_, i) => ({ login: `u${i}` })) });
const groupBTickets = [
  tk("tickets-oldest-unassigned", { [TICKETS]: ok([asg(40, 0), asg(12, 1), asg(30, 0)]) }),
  tk("tickets-all-assigned", { [TICKETS]: ok([asg(40, 1), asg(12, 2)]) }),
  tk("tickets-empty-lane", { [TICKETS]: ok([]) }),
  tk("tickets-gh-error", { [TICKETS]: FAIL }),
  tk("tickets-gh-unparseable", { [TICKETS]: { raw: "nope" } }),
  tk("tickets-assignees-null-counts-unassigned", { [TICKETS]: ok([{ number: 8, assignees: null }]) }),
  tk("tickets-string-number-accepted", { [TICKETS]: ok([{ number: "77", assignees: [] }]) }),
  tk("tickets-float-number-rejected", { [TICKETS]: ok([{ number: 7.5, assignees: [] }]) }),
];

const groupB = [
  ...groupBRetro,
  ...groupBWayfinder,
  ...groupBTickets,
  {
    name: "group-b-healthy",
    collectors: ["retro", "wayfinder-frontier", "tickets"],
    http: { [RUNS]: runs({ run_id: "r1", status: "ended" }), "/autopilot/runs/r1/retro": bundle(CLEAN) },
    gh: { [MAPS]: ok([iss(10, "wayfinder:map")]), "graphql:10": map(sub(11)), [TICKETS]: ok([asg(3, 0)]) },
  },
  { name: "group-b-all-failed", collectors: ["retro", "wayfinder-frontier", "tickets"], http: {}, gh: {} },
];

export const scenarios = [...groupA, ...groupB];
