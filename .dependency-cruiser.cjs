/**
 * dependency-cruiser config — import-graph boundary ratchet for the Orchestrator (issue #2205,
 * tool-scout: dependency-hygiene). Run via `npm run dep-boundary-check` (which shells out to
 * `npx dependency-cruiser` — the no-runtime-dependency, pinned-npx lane that ast-grep / comby /
 * probe / promptfoo already use per ADR-0005; dependency-cruiser carries a `prepare: husky`
 * install script so it deliberately stays OFF the package.json devDependencies + lavamoat
 * allow-scripts gate).
 *
 * This config encodes, as formal graph constraints, the same `src/` module boundaries CLAUDE.md
 * documents in prose and that the hand-rolled scripts/ci/*-seam-check.ts ratchets enforce one
 * seam at a time. Unlike a text-regex seam check, dependency-cruiser reads the actual
 * import/require graph, so a boundary name appearing only in a comment or a docstring never
 * false-matches (the false-positive class the regex seam checks live with).
 *
 * ADVISORY by design (issue #2205 risk note): every rule below ships at `severity: "warn"`, and
 * the dep-boundary-check.yml workflow that runs it exits 0 regardless of findings. It surfaces
 * import-boundary drift to reviewers WITHOUT blocking merge — mirroring the ast-grep-lint.yml /
 * comby-check.yml advisory contract. The authoritative hard gate for the Redis seam remains the
 * text-regex scripts/ci/redis-seam-check.ts inside Verifier-Core ci.yml; this config complements
 * it (and generalises it to ALL seams), it does not replace it. Promoting a rule to a hard gate
 * later is a conscious, reviewable change: flip its `severity` to "error" and add a non-zero exit
 * to the wrapper.
 *
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      comment:
        "Circular imports cause subtle `undefined`-at-module-load heisenbugs in TypeScript — " +
        "exactly the kind of init-order bug that makes CI flaky for agents. Advisory: surfaced, " +
        "not blocked.",
      severity: "warn",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-direct-redis-keys-import",
      comment:
        "CLAUDE.md Redis convention: never import src/redis/keys.ts or src/redis/kv.ts from " +
        "outside src/redis/ — all Redis access goes through the typed src/redis/<domain>.ts " +
        "accessors (ADR-0009). The hand-rolled scripts/ci/redis-seam-check.ts is the hard gate; " +
        "this rule is the import-graph-native restatement that also catches re-export aliases a " +
        "text regex would miss.",
      severity: "warn",
      from: { path: "^src/", pathNot: "^src/redis/" },
      to: { path: "^src/redis/(keys|kv)\\.ts$" },
    },
    {
      name: "no-new-redis-outside-redis-dir",
      comment:
        "Only src/redis/connection.ts may construct an ioredis client; everything else uses the " +
        "shared accessor. (The `new Redis()` call-site form is hard-gated by redis-seam-check.ts; " +
        "this rule catches the import edge from any src/ module to the `ioredis` package outside " +
        "src/redis/.)",
      severity: "warn",
      from: { path: "^src/", pathNot: "^src/redis/" },
      to: { dependencyTypes: ["npm"], path: "^ioredis$" },
    },
    {
      name: "no-cross-redis-from-outside-adapters",
      comment:
        "Belt-and-braces for the Redis seam: anything outside src/redis/ that imports the raw " +
        "redis/keys or redis/kv modules is drift — flagged advisory so a reviewer sees it before " +
        "it becomes a new hard-gate violation.",
      severity: "warn",
      from: { path: "^src/", pathNot: "^src/redis/" },
      to: { path: "^src/redis/(keys|kv)$" },
    },
    /*
     * src/cost layer rules (ADR-0042 Decision 3, issue #4783) — the ADVISORY twin of the
     * blocking drift guard test/cost-layers.test.mts, which runs in the required `test` job and
     * is the source of truth. Layers are ordered by purity (ADR-0042 Decision 1): a file may
     * import only from its own layer or a LOWER one, type-only imports included. Each rule
     * below forbids one layer's files from importing any HIGHER layer's files; the outside rule
     * restates the barrel contract (Decision 4: outside src/cost, only L1-L2 files may be
     * imported directly — L3+ goes through index.ts). When a file moves layers or a new file
     * joins src/cost, edit the test's COST_LAYERS const, src/cost/CONTEXT.md's table, and these
     * regexes together. An upward edge is cleared by moving vocabulary DOWN, never by blessing
     * it here (ADR-0042 Decision 5).
     */
    {
      name: "cost-layer-l1-no-upward",
      comment:
        "src/cost L1 (vocabulary + math) must not import from L2 or above — see the blocking " +
        "test/cost-layers.test.mts (ADR-0042 Decision 1).",
      severity: "warn",
      from: { path: "^src/cost/(token-math|token-breakdown|types|oauth-meter-shape)\\.ts$" },
      to: {
        path: "^src/cost/(config|eligibility|snapshot-assembly|oauth-usage|oauth-read-cache|transcript-scan|surrogate|usage-by-issue|usage-tracker|eligibility-usage|cost-by-class|cost-per-merged-pr|class-cost-efficiency|weighted-quota-estimate|index)\\.ts$",
      },
    },
    {
      name: "cost-layer-l2-no-upward",
      comment:
        "src/cost L2 (config) must not import from L3 or above — see the blocking " +
        "test/cost-layers.test.mts (ADR-0042 Decision 1).",
      severity: "warn",
      from: { path: "^src/cost/(config)\\.ts$" },
      to: {
        path: "^src/cost/(eligibility|snapshot-assembly|oauth-usage|oauth-read-cache|transcript-scan|surrogate|usage-by-issue|usage-tracker|eligibility-usage|cost-by-class|cost-per-merged-pr|class-cost-efficiency|weighted-quota-estimate|index)\\.ts$",
      },
    },
    {
      name: "cost-layer-l3-no-upward",
      comment:
        "src/cost L3 (pure folds) must not import from L4 or above — see the blocking " +
        "test/cost-layers.test.mts (ADR-0042 Decision 1).",
      severity: "warn",
      from: { path: "^src/cost/(eligibility|snapshot-assembly)\\.ts$" },
      to: {
        path: "^src/cost/(oauth-usage|oauth-read-cache|transcript-scan|surrogate|usage-by-issue|usage-tracker|eligibility-usage|cost-by-class|cost-per-merged-pr|class-cost-efficiency|weighted-quota-estimate|index)\\.ts$",
      },
    },
    {
      name: "cost-layer-l4-no-upward",
      comment:
        "src/cost L4 (I/O sources) must not import from L5 or above — see the blocking " +
        "test/cost-layers.test.mts (ADR-0042 Decision 1).",
      severity: "warn",
      from: {
        path: "^src/cost/(oauth-usage|oauth-read-cache|transcript-scan|surrogate|usage-by-issue)\\.ts$",
      },
      to: {
        path: "^src/cost/(usage-tracker|eligibility-usage|cost-by-class|cost-per-merged-pr|class-cost-efficiency|weighted-quota-estimate|index)\\.ts$",
      },
    },
    {
      name: "cost-layer-l5-no-upward",
      comment:
        "src/cost L5 (coordinators) must not import from L6 or the barrel — see the blocking " +
        "test/cost-layers.test.mts (ADR-0042 Decision 1).",
      severity: "warn",
      from: { path: "^src/cost/(usage-tracker|eligibility-usage)\\.ts$" },
      to: {
        path: "^src/cost/(cost-by-class|cost-per-merged-pr|class-cost-efficiency|weighted-quota-estimate|index)\\.ts$",
      },
    },
    {
      name: "cost-layer-l6-no-upward",
      comment:
        "src/cost L6 (derived reads) must not import the barrel — see the blocking " +
        "test/cost-layers.test.mts (ADR-0042 Decision 1).",
      severity: "warn",
      from: {
        path: "^src/cost/(cost-by-class|cost-per-merged-pr|class-cost-efficiency|weighted-quota-estimate)\\.ts$",
      },
      to: { path: "^src/cost/(index)\\.ts$" },
    },
    {
      name: "cost-outside-l3plus-needs-barrel",
      comment:
        "ADR-0042 Decision 4 barrel contract: outside src/cost, only L1-L2 files may be " +
        "imported directly; L3 and above go through src/cost/index.ts. test/ is exempt (the " +
        "cruise's includeOnly is ^src/ anyway). The blocking source of truth is " +
        "test/cost-layers.test.mts, which also walks scripts/.",
      severity: "warn",
      from: { path: "^src/", pathNot: "^src/cost/" },
      to: {
        path: "^src/cost/(eligibility|snapshot-assembly|oauth-usage|oauth-read-cache|transcript-scan|surrogate|usage-by-issue|usage-tracker|eligibility-usage|cost-by-class|cost-per-merged-pr|class-cost-efficiency|weighted-quota-estimate)\\.ts$",
      },
    },
  ],
  options: {
    /*
     * Resolve TypeScript imports through the repo tsconfig so the cruise sees the real `.ts`
     * graph (without this, .ts imports resolve to 0 modules — verified against
     * dependency-cruiser@17.4.3). NodeNext + rewriteRelativeImportExtensions means source uses
     * `.ts` import specifiers, which dependency-cruiser's TS resolver handles via the tsConfig.
     */
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    /* Only the orchestrator source tree is in scope; node_modules / dist / dashboard / test are not. */
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(^|/)(node_modules|dist|dashboard|test)/" },
    includeOnly: "^src/",
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"],
    },
  },
};
