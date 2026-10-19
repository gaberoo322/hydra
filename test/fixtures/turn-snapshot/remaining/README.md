# Turn Snapshot slice 5B goldens (ADR-0043 D4, #4933)

Every `remaining-*.json` here is the output of the OLD bash collectors
(`collect_redis_queues`, `collect_scout`, `collect_arch_cleanup_boards`,
`collect_hitl_grill`, `collect_retro`, `collect_wayfinder_frontier`,
`collect_tickets`) over one synthetic world, captured before they were deleted.
`test/turn-snapshot-remaining.test.mts` replays each through the TS collectors.

Since the kv wire was retired (ADR-0043 slice 6b, #4934) each file's
`expected.values` holds the collectors' TYPED values (`--format values`),
captured while the replay still matched the bash's kv stdout byte for byte;
the recorded stdout and exported globals were dropped with the kv renderers.
The recipe below reproduces the original bash capture (stdout form) from git
history.

Recipe (`capture/`):

```bash
git show <base-sha>:scripts/autopilot/collect-state.sh > /tmp/collect-state.base.sh
node test/fixtures/turn-snapshot/remaining/capture/capture.mjs \
  test/fixtures/turn-snapshot/remaining/capture/scenarios.mjs \
  test/fixtures/turn-snapshot/remaining \
  /tmp/collect-state.base.sh <base-sha> "$(command -v hydra)"
```

`capture.mjs` puts fake `gh` (serves each scenario's raw `--json` payload and
applies the bash's `--jq` through real `jq`), `docker` (a scripted Redis
keyspace, or a stopped container) and `date` on PATH, runs the real `hydra`
CLI against a local HTTP server, and records stdout, stderr notes, the gh argv
(minus `--jq`), the HTTP paths, the Redis writes and the exported globals.
Base SHA of the committed corpus: `46347d1714f563e41a579cebadc1d102e8efaf4c`.

**jq dialect caveat:** the harness's fake `gh` applies the `--jq` programs with
the C `jq` binary (1.7), while production `gh` embeds gojq. The two can format
numbers differently in edge cases (e.g. `12.0` vs `12`, large/float values in
`"\(x)"` interpolation or raw output). The committed scenarios avoid those
inputs; where they would differ, the TS folds (`jq-compat.ts`) follow gojq,
i.e. production.
