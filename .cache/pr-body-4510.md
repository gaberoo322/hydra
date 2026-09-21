## Summary

`collect-state.sh`'s `collect_slot_events` used to `docker exec hydra-redis-1 redis-cli XREAD ...` directly against `hydra:autopilot:slot-events`, then pipe the plain-text reply through a ~30-line hand-rolled Python regex parser (`re.match(r'^\d+-\d+$', ...)`) to reconstruct `{id, fields}` — a second, drift-prone implementation of the exact wire format `src/event-bus.ts` already parses structurally off ioredis's typed XREAD reply, with zero test coverage on the bash side.

This PR adds a thin HTTP seam and points the collector at it, mirroring the `collect_orch_board` / `collect_retro` pattern already used elsewhere in the same file:

- `EventBus.readRaw(stream, lastId, count)` (`src/event-bus.ts`) — a **plain** `XREAD` (never `XREADGROUP`) that never throws; degrades to `{ events: [], lastId: null }` on any Redis error or empty reply. This is the only place that re-derives `{id, fields}` from a raw XREAD reply; `flatFieldsToRecord()` is the pure fold, exported for tests.
- `GET /autopilot/slot-events?last_id=<id>&count=<n>` (`src/api/autopilot-slot-events.ts`, mounted in `src/api.ts`) — always answers `200` with `{ events, last_id }` (snake_case, matching the existing bash-emitted shape byte-for-byte), backed by a strict zod query schema (`last_id` default `"0"`, `count` default `100`, capped at `1000`).
- `collect_slot_events` (`scripts/autopilot/collect-state.sh`) now calls `hydra raw GET "/autopilot/slot-events?last_id=...&count=..."` and pipes the response straight through as `slot_events_json=<json>` — no `python3`/regex stage, no direct Redis access from this script at all.
- Docs: `docs/operator-playbooks/_fragments/hydra-autopilot-ops-reference.md` updated to describe the new HTTP-seam read path.

### Recovery note

This anchor (#4510) previously stalled 7 times. The 6th attempt's work was committed and pushed by autopilot recovery to `worktree-agent-acdae090b5ed69d61` (1 commit, `547e931a7`, +272/-47) after its parent session was killed mid-flight, per issue #4510's recovery comment. That commit was **on-artifact** — it matches this issue's approved design-concept exactly (plain XREAD, `readRaw()` on `EventBus`, snake_case `last_id`, byte-identical `slot_events_json=` output) — so this PR merges it in verbatim (`git merge`) rather than re-implementing, and adds one thing it was missing: route-level test coverage for the new endpoint itself (`test/autopilot-slot-events.test.mts`), plus verification (`typecheck`, `typecheck:test`, `test:file`, full `npm test`), none of which had been run against the recovered commit.

## Design-concept reconciliation

Artifact: `ae38911d38730afb0d692b711783a43f374d30c431b033543fb971f0d2e797fc`

- INV-1: "The producer side of hydra:autopilot:slot-events stays exactly as ADR-0017 sanctioned it (on-subagent-stop.sh's flat-field XADD via publishRaw() is untouched) — this concept is consumer-side only." — verified by: `file-contains: scripts/autopilot/hooks/on-subagent-stop.sh :: XADD "$STREAM_KEY" MAXLEN '~' "$MAXLEN_CAP" '*'`
- INV-2: "The new read is a PLAIN XREAD (not XREADGROUP): decide.py owns the cursor itself via state.slot_events_last_id, and this read must not create or advance a consumer-group position, so it cannot collide with the now-pixel bridge's independent 'now-pixel-bridge' group." — verified by: `test: test/event-bus.test.mts :: "readRaw: folds a typical XREAD reply into {events, lastId}"`
- INV-3: "The endpoint is best-effort per the existing collect_slot_events contract: a Redis outage or empty stream must still yield the empty shape {"events": [], "last_id": null} with HTTP 200, never a 5xx that would abort the autopilot turn." — verified by: `test: test/autopilot-slot-events.test.mts :: "an empty/never-throwing readRaw() result still answers 200 with the empty shape — a Redis outage must never abort the autopilot turn (invariant #3)"`
- INV-4: "The new EventBus method is the ONLY place that re-derives {id, fields} from the raw XREAD reply — cascade-telemetry.ts and candidate-exclusions.ts's fromEvent() parsers keep consuming already-typed fields and are not touched." — verified by: `file-contains: src/redis/cascade-telemetry.ts :: export function cascadeRecordFromEvent(`
- INV-5: "collect_slot_events's emitted key (slot_events_json=<json>) and JSON shape stay byte-identical to today's output so decide.py's consumer needs zero changes." — verified by: `test: test/autopilot-slot-events.test.mts :: "happy path: returns 200 with snake_case {events, last_id} — byte-identical to the old bash+regex shape (design-concept invariant #5)"`
- INV-6: "No consumer-group state, WATCH, or MAXLEN write is introduced by this read path — it is read-only against the stream." — verified by: `test: test/autopilot-slot-events.test.mts :: "plain read, never a consumer-group read: the route forwards only (stream, last_id, count) to readRaw() — no group name argument exists to pass (invariant #2 / #6)"`

## Verification

- `npm run typecheck` — clean
- `npm run typecheck:test` — clean (0 known type errors, baseline 0)
- `npm run test:file -- test/event-bus.test.mts` — 44/44 pass
- `npm run test:file -- test/autopilot-slot-events.test.mts` — 7/7 pass
- `npm test` (full suite) — 8342 pass, 0 fail, 4 skipped (pre-existing/unrelated skips), exit 0. The advisory SUITE-COUNT GATE printed its known non-blocking reporting-artifact warning (#4137/#4292) for 14 unrelated files; none of the files this PR touches are in that list, and the run still exits 0.
- Regenerated `test/fixtures/suite-count-baseline.json` for the new `test/autopilot-slot-events.test.mts` file (`node scripts/test/suite-count-check.mjs --update-baseline`).

Closes #4510
