# Codex Policy for Hydra

This repository is the Hydra orchestrator. Codex should optimize for autonomous, end-to-end engineering work, but must preserve the boundaries below.

## Default Target

- Work on `/home/gabe/hydra` unless the user explicitly says to work on `/home/gabe/hydra-betting`.
- Treat `/home/gabe/hydra-betting` as Hydra's target project, not as part of the orchestrator.
- Do not interfere with active Hydra cycles unless the task is explicitly to diagnose or stop them.

## Secret Boundaries

Never read, print, copy, summarize, stage, or commit:

- `.env`
- `.env.*`
- `**/secrets/*`
- `**/*credential*`
- `**/*.pem`
- `**/*.key`

If a task needs a value from one of those files, ask the operator for the specific value or for permission to use an existing service command that does not expose the secret.

## Destructive Command Boundaries

Do not run these autonomously:

- `rm -rf` outside clearly disposable temp/generated paths.
- `git reset --hard`.
- `git clean -fd` unless limited to a generated workspace and preceded by `git status --short`.
- `git push --force` or `git push -f`.
- Docker volume deletion or database destructive operations.
- Commands that place trades, move funds, rotate credentials, deploy production, or change auth/security policy.

Ask before any of those actions unless the user explicitly requested that exact operation in the current turn.

## Engineering Invariants

- Keep changes narrowly scoped.
- Do not revert unrelated user changes.
- Use existing module patterns before adding abstractions.
- Preserve hard verification, rollback, locking, and spend-cap behavior.
- Fail loud: catches should log or intentionally document why silence is acceptable.
- Ordinary command/test failures should be represented as result objects in grounding, verification, and merge paths where the existing code follows that pattern.

## Verification

For orchestrator code changes, run the strongest practical subset:

- `npm test`
- `npm run typecheck`
- `npm run build`

For dashboard UI changes:

- `cd dashboard && npm run build`
- Use browser/Playwright verification when layout or interaction changes.

Before commit/push/merge:

- Run relevant verification.
- Check `git status --short`.
- Check staged paths with `git diff --cached --name-only`.
- Do not stage secret-looking paths.

## Git Autonomy

If the user asks to commit, ship, merge, push, or run in yolo mode, Codex may commit/push after verification passes. Never force push without explicit current-turn instruction.

## Hydra Runtime

Relevant local endpoints and commands:

- API health: `curl -s http://localhost:4000/api/health`
- Cycle status: `curl -s http://localhost:4000/api/cycle/status`
- Scheduler: `curl -s http://localhost:4000/api/scheduler/status`
- Backlog: `curl -s http://localhost:4000/api/backlog`
- Redis: `docker exec hydra-redis-1 redis-cli`
- Service: `systemctl --user status hydra-orchestrator.service`

If a cycle lock exists, avoid modifying shared target state unless diagnosing the lock.
