---
updated: 2026-04-07
status: active
owner: architect
tags: [hydra, hydra/direction]
---

# Tech Preferences

## Stack

- **Frontend:** Next.js, React, TypeScript, Tailwind CSS, shadcn/ui, TanStack Query
- **Backend:** Node.js, TypeScript, PostgreSQL
- **Infrastructure:** Docker, Redis Streams, OpenViking
- **AI:** OpenAI Codex CLI (GPT-5.4 frontier, GPT-5.3-Codex, GPT-5.4-mini)
- **Quality:** Promptfoo for evals and red teaming

## Conventions

- TypeScript strict mode everywhere
- Named exports over default exports
- REST over GraphQL
- Co-locate tests with source files

## External Dependency Proof-First

- When blocked work clusters on one operator-owned secret or deploy configuration, prefer a small read-only readiness probe or status proof for that dependency before additional low-risk UI/status/documentation slices.
- The goal is to produce operator-actionable pass/fail evidence that reduces blocker resolution time without introducing state-changing behavior.

## High-Risk Executor Model Routing

When a planned cycle is classified `risk:high`, prefer the frontier model for Executor instead of the default codex executor. This should be limited to rare high-risk implementation slices such as submit-packet derivation, recovery-flow mutation, or venue/economics state changes. Low-risk bounded slices should continue using the default codex executor to preserve current cost efficiency.
