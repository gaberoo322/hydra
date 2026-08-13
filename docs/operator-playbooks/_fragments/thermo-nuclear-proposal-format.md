# Proposal document format

Each Phase 2 deep-dive produces a proposal document at `.thermonuclear/proposals/<slug>.md`. The document is **free-form** — write the shape that fits the proposal. The only requirements are the four content rules below and the file:line citation discipline.

## Slug

Derive from the code-judo move. Kebab-case, action-led, under 60 characters.

- Good: `retire-watchdog-fold-into-autopilot`
- Good: `collapse-cost-planes-into-single-accounting`
- Bad: `proposal-3` (no information)
- Bad: `improve-cost-accounting` (vague — what's the move?)

## Required content rules

These four must appear in every proposal. Order them however the proposal reads best — usually code-judo move first, alternatives last.

### 1. Code-judo move

The central reframing in **one paragraph**, top of the document. The thing the skill was hired to find. Should be readable in 15 seconds and let the operator decide whether to keep reading.

Bad: "We should consider refactoring the watchdog."
Good: "Retire `scripts/hydra-orchestrator-watchdog.sh` and fold its three health checks into the autopilot's tick loop, which already pings `/api/health` every cycle. The systemd `watchdog.timer` becomes a backstop that only fires when the autopilot itself is unresponsive — flipping the semantic from 'detect a failure' to 'detect autopilot wedge'."

### 2. What gets deleted

Explicit list of files / services / abstractions / concepts the proposal removes. Bullet list. Include line counts where meaningful.

```
- scripts/hydra-orchestrator-watchdog.sh (94 lines)
- systemd unit: hydra-orchestrator-watchdog.timer + .service
- The concept of "watchdog cadence" separate from "autopilot cadence"
- The watchdog's deliberate-stop reconciliation flag (src/scheduler.ts:142-178)
```

If this section comes up empty after grilling, the proposal is rearrangement, not deletion. The skill must surface this at the top of the document as a self-honest signal:

> ⚠️ **This proposal is rearrangement, not deletion.** The operator may still want to action it, but it doesn't meet the thermo-nuclear bar.

Do not reject the proposal — the operator may still find it useful. Just flag honestly.

### 3. Cited ADRs

Two sub-lists:

- **Supporting** — ADRs whose decisions this proposal builds on. Cite by number + slug.
- **Contradicting** — ADRs this proposal asks to revisit. For each, state explicitly what the ADR currently says and why this proposal asks for a revision.

If no ADRs are relevant, say so explicitly: `No ADRs touch this proposal — consider whether the resulting decision merits a new ADR.`

### 4. Alternatives considered

At least one paragraph. List rejected approaches with **why** they were rejected. If the agent can't name any alternative, the proposal is under-cooked — keep thinking.

Bad: "I considered other options but they were worse."
Good: "Considered: (a) keep watchdog separate but reduce its cadence to 15min. Rejected because the duplicated semantic ('what does 'unresponsive' mean?') remains, just at a slower rate. (b) Replace watchdog with a Prometheus alert pipeline. Rejected because it adds a new external dependency for a problem the autopilot already mostly solves."

## Confidence markers

Inline `Confident:` / `Judgement:` tags throughout the proposal:

- `Confident:` precedes statements verifiable by anyone in seconds — file:line grep, file size, ADR text, CI workflow contents.
- `Judgement:` precedes statements that depend on a model of how the system *should* behave.

Example:

> `Confident:` the watchdog and the autopilot heartbeat both read `/api/health` every cycle (`scripts/hydra-orchestrator-watchdog.sh:34`, `src/autopilot/tick.ts:97`). `Judgement:` the watchdog's "deliberate-stop" reconciliation could collapse into the autopilot's stop-flag check without losing recovery from genuine self-stops.

This is the single most important content discipline. It lets the operator dismiss overconfident-but-wrong proposals less, and sharpens uncertain ones faster.

## File:line citation rule

Every concrete claim cites `file:path:line` or the equivalent operational identifier:

- Code: `src/autopilot/tick.ts:97`
- Systemd: `~/.config/systemd/user/hydra-orchestrator-watchdog.timer`
- CI: `.github/workflows/ci.yml:34`
- Docker / container: container name + image tag
- External service: hostname + endpoint path

No vibes. If the proposal can't cite, it can't claim.

## Optional sections (use as needed)

The agent decides whether to include any of these, based on what the proposal needs:

- **Migration path** — for proposals with non-trivial sequencing
- **Risks** — for high-blast-radius moves
- **Runtime cost implications** — for moves that change service count, polling cadence, or storage layout
- **Patch sketch** — for proposals small enough to outline as code

Don't include these as boilerplate. Include them when they answer a question the operator would otherwise ask.

## What this document is NOT

- Not a PRD — `hydra-prd` does that
- Not an ADR — but it may be the source material for one. If the operator decides this proposal is ADR-worthy, they paste the relevant content into `docs/adr/NNNN-...md` and shape it from there.
- Not an issue body — but small proposals may convert cleanly into one. The operator does that conversion manually.
- Not a transcript — grilling resolutions fold into the proposal text. The proposal speaks in conclusions, not deliberation.
