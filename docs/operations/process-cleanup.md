# Process cleanup (issue #226)

The orchestrator runs `npm test`, `tsc`, `npm run build`, and `node --test`
many times per cycle. The original spawn pattern
(`execFileAsync({ shell: true, timeout })`) only signalled the immediate
`/bin/sh -c <cmd>` child when the timeout fired; tsx, npm-exec, node, and
esbuild grandchildren survived and accumulated. We saw two stale process
trees totalling 9 procs from days-old autopilot cycles before adding the
fix described here.

The fix has two layers.

## Layer 1 — in-process: `src/exec-with-timeout.ts`

`execWithGroupCleanup(cmd, args, opts)` spawns the child with
`detached: true`, which makes it a process-group leader. On timeout the
helper signals the entire group via the negative PID:

1. `process.kill(-pid, "SIGTERM")` — polite shutdown signal to every
   member of the group.
2. After `killGraceMs` (default 5 s), `process.kill(-pid, "SIGKILL")` —
   forceful escalation for anything that ignored SIGTERM.

The helper returns a result object instead of throwing, so callers see
`{ stdout, stderr, exitCode, durationMs, timedOut, signal }`. This is a
strict superset of the `{ stdout, stderr }` shape the legacy callers
destructured.

Migrated callers:

- `src/verification.ts` `runStep` — the per-step runner inside
  `runVerification` (npm test / typecheck / build invocations).
- `src/jit.ts` (line ~250) — the `node --test <generatedTestFile>`
  invocation that runs newly generated regression tests.

Other `execFileAsync` call sites in `src/post-merge.ts`,
`src/pipeline-steps.ts`, and `src/research-loop.ts` were intentionally
left alone: they spawn short git/systemctl invocations whose grandchildren
do not contain test runners or esbuild.

### Verifying

A regression test (`test/exec-with-timeout.test.mts`) reproduces the
exact failure pattern: a parent shell that backgrounds a long-running
grandchild, plus a child that traps SIGTERM. Both PIDs are written to a
file the test reads. After `execWithGroupCleanup` reports `timedOut`,
the test asserts every recorded PID is dead within the grace window. If
this test ever fails, the fix has regressed.

## Layer 2 — system-level: `scripts/reap-stale-test-procs.sh`

We do not control every spawn on this host — Codex CLI subagents and
operator shells can leak the same way in failure modes the orchestrator
cannot fix in-process. The reaper script:

1. Walks all running processes and selects ones whose command line matches
   `tsx`, `esbuild --service`, `npm exec`, or `node --test` /
   `node --experimental-strip-types --test`.
2. Filters to those older than `--max-age` minutes (default 30).
3. Drops candidates whose ancestor tree still contains a live Hydra
   orchestrator, Claude Code, Codex, or `hydra` CLI process — those are
   in-flight, not leaked.
4. SIGKILLs the entire process group of each remaining candidate.

Default mode is `--dry-run` for safety. The systemd service always passes
`--apply`. Output goes to journalctl.

```bash
# Dry run — show what would be killed
~/hydra/scripts/reap-stale-test-procs.sh --dry-run

# Actually kill
~/hydra/scripts/reap-stale-test-procs.sh --apply

# Custom age cutoff
~/hydra/scripts/reap-stale-test-procs.sh --apply --max-age 60
```

### Installing the systemd timer

The PR ships unit files but does not install them — operator needs to copy
them into `~/.config/systemd/user/` and enable manually. This avoids the
PR mutating systemd state on the deploy runner.

```bash
cp scripts/systemd/hydra-test-proc-reaper.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now hydra-test-proc-reaper.timer

# Verify
systemctl --user list-timers hydra-test-proc-reaper.timer
journalctl --user -u hydra-test-proc-reaper.service -f
```

The timer fires hourly with a 2-minute random delay so it does not
collide with the existing `hydra-test-container-cleanup.timer` start
moment.

## Verifying cleanly after a leak

If you ever see stale tsx/esbuild trees in production again:

1. Capture them: `pgrep -af 'tsx|esbuild --service' | sort -k1n`.
2. Run the reaper in dry-run to confirm it would catch them:
   `~/hydra/scripts/reap-stale-test-procs.sh --dry-run`.
3. If yes — issue #226 layer 2 covers it; the timer should reap on the
   next firing.
4. If no — the matching rules need to grow. File a follow-up referencing
   issue #226 with the exact `pgrep` output.
