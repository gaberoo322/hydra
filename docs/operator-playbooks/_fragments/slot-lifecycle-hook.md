## Slot lifecycle events

When this skill runs as a dispatched subagent whose transcript carries a hydra-dispatch sentinel, the project PostToolUse hook `scripts/autopilot/hooks/on-subagent-tool-call.sh` (registered in `.claude/settings.json`, pinned by `test/subagent-dispatch-registration.test.mts`) emits each tool call to the slot-event stream. An operator session, or a child without a sentinel, emits nothing. The hook always exits 0. This skill never calls it and has nothing to configure.
