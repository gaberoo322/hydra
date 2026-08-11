# ADR-0033: The OpenViking knowledge plane is retired

Status: Accepted
Date: 2026-08-11
Deciders: Operator + Hydra (grilling session 2026-08-11, which locked the ten decisions transcribed here)
Related: #3947 (PR1 — stop consuming), #3950 (PR2 — delete the module cluster), #3854 / #3912 (TEI embed-parity work, closed moot), #3746 (gaming-PC / TEI bring-up, closed moot), #3543 / #3544 (the TEI cutover this retires), #3542 (the `/vlm` shim this retires), #2717 (retrieval ledger), #1440 / #2647 (the `cyclesWithContext` metric), #804 (honest OV search attribution), ADR-0005 (runtime deps are operator-approved — the cost discipline this upholds), ADR-0031 (the tracking migration that removed OV's largest corpus)

## Context

OpenViking (OV) was the Orchestrator's **knowledge plane**: a self-hosted semantic-search stack — a VikingDB vector store, an `openviking` API service, and a dense-embedding backend — that indexed reflections, research reports, config, and skill catalogs so subagents could retrieve "what do we already know about X" by meaning rather than by string match.

It cost three long-running containers (`vikingdb` 4G, `tei-embed` 6G, `openviking` 8G — 18G of declared memory limits and 8 CPUs), a bespoke HTTP request Seam, a CI seam ratchet, a WoL/gaming-PC dependency, an in-repo `/vlm` shim that existed **only** to serve OV's `ov.conf` `vlm.api_base`, and a standing queue of maintenance work (embed-parity gating, image-digest pinning, config-parser fallbacks) that repeatedly reached the operator.

Against that cost, measured usage had collapsed to near-zero: **4 searches in roughly 7 hours** at the time of the decision. Two structural causes, neither reversible:

1. **ADR-0031 moved tracking to GitHub Issues**, removing the largest corpus OV indexed and replacing "search the vault semantically" with `gh issue list` / `gh search`.
2. **The search-lane doctrine had already absorbed OV's niche.** `CLAUDE.md` names three lanes — ast-search for EXACT syntax, probe-search for FUZZY relevance, OV for SEMANTIC similarity. In practice probe-search (tree-sitter + BM25, zero indexing) answered the fuzzy-recall questions agents actually asked, at no standing infrastructure cost.

The session-memory tier documented in `docs/reference.md` was already dead on arrival: its module (`ov-session.ts`) had been deleted and no `.commit()` caller remained. The documentation described a capability that no longer existed.

The consuming edge was **fail-soft by construction**, which is what made retirement cheap to verify: the dispatch-side fetch was `curl -sf --max-time 5 … ; [ -n "$KB_CONTENT" ] && …` — an explicit graceful no-op — and `getContext()` degrades per-block and never throws. Removing the knowledge-base block could therefore not break a dispatch; it could only shrink a prompt.

## Decision

**Retire the knowledge plane outright. Do not port it to a successor backend.**

The capability is killed, not migrated. This is the load-bearing choice: the alternative — keep the seam and swap OV for another vector store — preserves every structural cost (a service to run, a corpus to index, a staleness question to answer, a probe to alarm on) in exchange for a capability whose measured demand was ~4 queries per 7 hours.

Ten decisions from the grilling session, transcribed:

1. **This is a retirement, not a replacement.** Graphify was the prompt that started the session but is a *separate, decoupled* evaluation carrying no successor obligation. Filed as its own tool-scout issue.
2. **Kill the capability, not just the backend.** The `/openviking/search` route, the `knowledge-base` context block, the #2717 retrieval ledger, the #1440 `cyclesWithContext` metric, and the OV health rules all go. No seam is left standing for a future backend to slot into — a future semantic-search proposal starts from the doctrine, not from a vacant socket.
3. **Full cascade.** OV code, the `/vlm` shim, the Wake-on-LAN / gaming-PC path, all three compose services and their volumes, the TEI embed-parity work (#3854, #3912), the OV scripts, and the CI seam ratchet.
4. **Three PRs, outside-in, with a soak between.** PR1 stops consuming (nothing else references OV), PR2 deletes the now-unreferenced modules, PR3 removes infra and docs. Outside-in means `tsc` is a **complete oracle** for PR2: if a deletion is incomplete, typecheck reddens.
5. **`repo-graph.ts` survives and moves.** It is a pure read-only adapter over `scanArchitecture()` with zero OV dependency, wired into the `hydra-architecture-scan` skill through a hardcoded absolute path. It relocated to `src/aggregators/repo-graph.ts` with the playbook path updated in the same PR.
6. **PR1 and PR3 by hand; PR2 dispatched.**
7. **Write this ADR, and cut the search doctrine from three lanes to two** with the third *explicitly named as retired* — a silently-shortened list reads as an oversight and invites re-proposal.
8. **The soak is a break-detector, not a quality gate** — mechanical abort criteria only (a failed dispatch, a red probe), not "did prompts get worse".
9. **Full teardown including volumes** (`docker compose down -v`), in one pass rather than leaving orphaned data behind a disabled service.
10. **File the Graphify tool-scout issue now**, decoupled from this retirement.

## Consequences

**What is gone.** Semantic search over accumulated knowledge. There is no in-repo way to ask "what do we already know about X" by meaning. Agents route such questions to `probe-search` (fuzzy, whole-block, ranked) or `gh search` over issues.

**What is smaller.** 11,063 lines deleted in PR2 alone; three containers and three named volumes; four HTTP routes; three health probes and their rules; one boundary Seam and its CI ratchet; the `/vlm` shim.

**The Seam count changes.** The OpenViking Request Adapter was the **fourth** boundary Seam and is cited by name as the sibling precedent in `src/errors.ts`, `src/anthropic/request.ts`, and `src/cost/oauth-usage.ts`. Those cross-references are rewritten to cite the surviving Seams; the ordinal numbering is preserved as *historical* ("the fifth Seam" stays the fifth) so existing prose and issue references keep resolving. Do not renumber.

**Deliberate comment residue.** The deleted call sites leave `// … was removed with OpenViking` markers in `src/health/*`, `src/api/*`, `src/learning/composition.ts`, and `src/scheduler/status-projection.ts`. These are kept on purpose: each marks a spot where a field, probe, or rule *used* to exist, so a future reader does not re-derive it as missing. They are not oversights.

**Reversibility.** Low. The corpus is destroyed with the volumes (decision 9). Restoring semantic search means standing up a new backend and re-indexing from source — which is the correct cost to pay if the capability is ever re-justified, and is exactly why decision 2 refuses to leave a seam behind.

**Risk accepted.** If agent output quality degrades in a way traceable to missing semantic recall, the signal will be indirect and slow (worse plans, more rework), not a red probe. The soak in decision 8 does not detect this and was never meant to. This is an explicit bet that probe-search plus GitHub Issues covers the demand.

## Alternatives considered

- **Swap the backend, keep the seam.** Rejected — see the Decision preamble. Preserves the entire structural cost for near-zero measured demand.
- **Leave OV running but stop consuming it.** Rejected: the containers, the image pins, the parity gates, and the operator escalations are the cost, and they persist whether or not anything queries. A dark service that still pages you is the worst of both.
- **Keep the `/vlm` shim.** Rejected: it had exactly one consumer (OV's `ov.conf`). `src/claude-cli/exec.ts` survives — the GLM drainer uses it.
- **Adopt Graphify as a drop-in successor now.** Rejected as a *coupled* decision (decision 1). Graphify has no embeddings and is a structural/graph tool, not a semantic-similarity store — adopting it to fill this hole would be solving a different problem under this one's name. Evaluated separately on its own merits.
