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
      name: "no-reaching-into-backlog-internal-helpers",
      comment:
        "src/backlog/internal.ts is the Module's PRIVATE helper surface — its own header states " +
        '"Nothing in this file is exported outside src/backlog/. Callers reach the Module through ' +
        'the role-keyed surface files (reads/items/lanes/claims/wip/reaper)." Anything outside ' +
        "src/backlog/ importing internal.ts directly is a seam breach (and lane mutations must go " +
        "through src/backlog/lanes.ts → moveItemToLane per CLAUDE.md, never internal.ts).",
      severity: "warn",
      from: { path: "^src/", pathNot: "^src/backlog/" },
      to: { path: "^src/backlog/internal\\.ts$" },
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
