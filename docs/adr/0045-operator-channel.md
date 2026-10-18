---
status: accepted
---

# ADR-0045: The Operator Channel is one outbound-only Telegram module with a closed page list and a daily Morning Brief

Hydra reaches the operator's phone from several unrelated places: the weekly digest, the review-pickup chore, the watchdog scripts and systemd `OnFailure` units. Each had its own formatting, its own chat-id handling and its own idea of what deserves a message. A formatting error dropped whole messages (#5040), a hard-coded chat id lived in a script, and the volume drifted toward noise.

This ADR records the design chosen in issue #5041 as normative for the slices that implement it (#5044–#5049). Nothing here describes code that exists on the day it is accepted.

## Decision

### Decision 1 — The channel is outbound only

Nothing reads Telegram updates, webhooks or callback queries. No inline buttons, no commands. The orchestrator API is unauthenticated, so an inbound control surface needs its own auth design first and is a separate decision. The model stays extensible for actions later, but this ADR adds none. It does not widen the escalation list in ADR-0005: a **Page** is how an existing Operator-Required Intervention reaches the phone, not a new category.

### Decision 2 — One channel for every runtime

Every Hydra→operator Telegram message goes through the **Operator Channel** module. TypeScript callers call the module; bash and systemd callers call its CLI (`scripts/operator-notify.ts`). No other file talks to `api.telegram.org`. The existing Telegram seam check widens from `src/` to `src/` and `scripts/` to enforce this.

### Decision 3 — Severity is a closed page list in code

The channel, not the producer, decides severity. A **Page** is an event on one closed list:
- infra alarms (node_modules wiped, origin identity, redis-backup stale, launch-flow failure, GLM-sterile);
- the notification consumer is dead;
- an Outcome Holdback revert failed;
- orchestrator, autopilot, tunnel or backup service failures;
- the `/hydra-review` pickup set going non-empty.

Every other event is a **Morning Brief** item. Target-project service failures and successful holdback reverts go to the brief. Adding a page type is an edit to the list in code plus this ADR's list; producers cannot self-promote.

### Decision 4 — Pages are edge-triggered per dedupKey

Each page carries a `dedupKey`. One message is sent when the condition turns bad. While it stays bad, at most one reminder is sent per 6 hours. One "recovered" message is sent when it resolves. A systemd exit 143 / SIGTERM never pages. Suppressed counts appear in the brief.

### Decision 5 — Telegram HTML through one escaper, with a plain-text backstop

Messages are rendered as Telegram HTML through a single escaper (three characters: `&`, `<`, `>`). On an entity-parse 400 the channel resends the same message as plain text (the #5040 fix). A formatting error can never drop a message.

### Decision 6 — Direct send; Redis is best-effort and fails open

A page is sent directly from the module; there is no outbox. Dedup state and the delivery log live in Redis through a `src/redis/` accessor, but if Redis or the orchestrator is unavailable the page is sent anyway. A page is never lost exactly when the watchdog or `OnFailure` units matter most.

### Decision 7 — The Morning Brief

The brief is sent once per local day at 07:30, timed by a Redis last-sent key so it survives restarts and catches up after downtime. It is sent even when empty. It carries overnight merges and QA outcomes, waiting-on-you items with the recommended action and link (the same actions as the ADR-0034 §8 registry), autopilot and quota state, a builder-health line, and non-page events. Monday's brief appends the weekly summary. It replaces the 4-hourly digest, the heartbeat message and the standalone weekly digest. Every brief-severity event type has a rendered brief line, and every notification event type has at least one live producer; both are enforced by tests, and event types that fail the producer audit are deleted along with their formatter arms.

### Decision 8 — Credentials in one loader; delivery health is visible

The bot token and chat id are read by exactly one loader. There is no hard-coded chat id. Delivery health is shown as a card on the existing `/health` page (last page, last brief, 24h failed and suppressed counts) via one read-only route, and the watchdog raises an alarm when no brief was delivered for 26 hours. No new dashboard page is added (ADR-0034).

## Consequences

- Adding a page type is deliberately a code and ADR edit.
- Telegram delivery code outside the channel fails the widened seam check.

## Alternatives considered

- **Inbound commands or inline buttons.** Rejected: needs its own auth design (Decision 1).
- **Redis outbox drained by the orchestrator, with or without a direct-send fallback.** Rejected: loses pages when the orchestrator or Redis is down, or keeps two delivery paths honest for little gain.
- **Producer-chosen severity.** Rejected: drifts into noise.
- **MarkdownV2 or plain text.** Rejected: MarkdownV2 has 18 reserved characters, the classic 400 source; plain text loses links.
- **Keeping the 4h digest, adding an evening brief or a per-merge feed.** Rejected: pages plus one daily brief is the lowest-noise shape.
- **A dedicated delivery-log dashboard page.** Rejected: would need an ADR-0034 amendment.
