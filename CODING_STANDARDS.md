# Coding Standards

The Standards reviewer's rule catalog (ADR-0046). Each rule has a stable ID and one `enforced-by:` line: a repo-relative check path, or `reviewer`. Findings cite the rule ID. Default severity is low; a rule says when it is higher. Integrity (grammar, 2,000-word ceiling, dangling references) is enforced by `test/coding-standards-integrity.test.mts`.

## Code

### STD-DEPS-APPROVED

Runtime dependencies are operator-approved only: `express`, `ioredis`, `ws`, `@sentry/node`, `zod`, `pino`. Use the Node stdlib for everything else. Adding a runtime dependency is a blocker unless the PR cites the operator approval (ADR-0005).

enforced-by: scripts/ci/dep-boundary-check.ts

### STD-REDIS-SEAM

Redis is reached only through the typed accessors in `src/redis/<domain>.ts`. Never construct `new Redis()` directly, and never import `redis/keys` or `redis/kv` from outside `src/redis/` (see Redis Adapters in `CONTEXT.md`).

enforced-by: scripts/ci/redis-seam-check.ts

### STD-SCHEMA-SEAM

HTTP request bodies validate through `src/schemas/<domain>.ts` with zod `safeParse`. On failure return 400 `{code:"schema-validation-failed", issues}`. The schema is the source of truth for both the parser and the inferred type (see Schemas in `CONTEXT.md`).

enforced-by: scripts/ci/schema-seam-check.ts

### STD-VERIFY-NEVER-THROW

Merge, grounding and verification code never throws. It returns result objects so callers decide how to report failure.

enforced-by: reviewer

### STD-GROUNDING-READONLY

`grounding.ts` is read-only. Never mutate the workspace from grounding.

enforced-by: reviewer

### STD-API-EVENTBUS-PARAM

API routes live in sub-routers under `src/api/<domain>.ts` as factory functions; `src/api.ts` stays a thin mount point. `eventBus` is a parameter, never a module global.

enforced-by: reviewer

### STD-ERROR-TYPED-CODE

Exceptional `throw` sites prefer a subclass from `src/errors.ts` (for example `InvalidArgumentError`) over a bare `Error`. Callers and tests discriminate on `err.code`, not `err.message`.

enforced-by: reviewer

### STD-CATCH-FAIL-LOUD

Every `catch` either logs with context, rethrows, or carries an `/* intentional: <reason> */` annotation. A silent catch is a finding; in a changed catch it is a blocker.

enforced-by: src/ast-grep-rules/fail-loud-catch.yml

### STD-LOG-PINO-SEAM

Structured logging imports `logger` from `src/logger.ts`. Never call `pino()` directly (ADR-0027).

enforced-by: reviewer

## Tests

### STD-TEST-RUN-THE-CODE

Assert behaviour through the module's interface. A test may read repo text only as input to code it runs, or as a drift-guard (two sources of truth agree), an invariant-lint (a repo-wide rule over source), or a prompt-pin (the prose is the behaviour). A substring, regex, `indexOf`-order, line or call-count assertion over code that can run is forbidden. Scripts count as runnable (sandbox plus a fake `gh` or `redis-cli` on `PATH`). Dashboard JSX source pins are allowed (kind `dashboard-pin`) because there is no DOM harness. When a refactor reddens a grandfathered pin, convert it; do not re-pin it.

enforced-by: reviewer, test/test-source-read-ratchet.test.mts

### STD-TEST-PIN-PHRASE

Prompt-pins assert a required phrase, never an exact sentence, block order or step number.

enforced-by: reviewer

### STD-TEST-NO-TAUTOLOGY

Import the constant; never restate a literal the module defines, and never assert your own setup.

enforced-by: reviewer

### STD-TEST-CAN-FAIL

Every case goes red if the behaviour its title names breaks: no early return before the decisive assertion, and no asserting only stub-supplied values. A fake exposes the failure modes the code handles.

enforced-by: reviewer

### STD-TEST-OWN-FEATURE

A test pins its own feature, never a sibling issue's prose or "added by #NNNN".

enforced-by: reviewer

### STD-TEST-NO-SHARED-TEARDOWN-NESTING

Do not nest new tests inside a `describe` that owns a shared-Redis `after()` teardown: sibling top-level suites then run against a torn-down connection. Add a new top-level `describe` with its own `before` and `after`.

enforced-by: reviewer

### STD-TEST-BEFOREEACH-RESET

State that a case mutates and a sibling case reads is reset in `beforeEach`, never `before`. Reserve `before` and `after` for suite-lifetime setup such as opening and closing a connection.

enforced-by: reviewer

## Design

Diff-level deep-module checking uses the vendored Fowler smell battery (Middle Man, Shotgun Surgery, Speculative Generality, Duplicated Code and the rest); do not restate its smells as repo rules. Whole-codebase design questions (depth of untouched modules, fan-in hubs, cross-group coupling) belong to `architecture_orch`, not the reviewer.

Severity: design findings default to low and become non-blocking follow-ups. The one medium case is STD-DESIGN-NO-REIMPLEMENT where the copy must stay in sync for correctness, meaning drift would make two parts of the system decide the same question differently (a gate, a label predicate, a path rule). Pass-through, a one-adapter seam, Speculative Generality and STD-DESIGN-DEEPEN stay low. Cite a `STD-DESIGN-*` ID or an exact Fowler smell name.

### STD-DESIGN-TWO-ADAPTERS

A new seam (port, injected dependency, interface) needs two adapters, and a test fake counts as one. Otherwise inline it.

enforced-by: reviewer

### STD-DESIGN-NO-REIMPLEMENT

Do not hand-copy a rule or predicate an existing module exports; call it.

enforced-by: reviewer

### STD-DESIGN-DEEPEN

Grow an existing module behind its current interface before adding a sibling module or new exports.

enforced-by: reviewer
