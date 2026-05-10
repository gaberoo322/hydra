# One target per orchestrator instance; fleet later via systemd

The orchestrator builds one **Target** at a time. To build another target, run a second orchestrator instance (eventually as a systemd unit per target). Multi-target inside one orchestrator — Redis namespacing per target, shared scheduler, per-target budgets — is rejected.

Today this commits us to de-hardcoding the ~20 `hydra-betting` references in `src/` so `HYDRA_PROJECT_WORKSPACE` is the real switch, plus the hardcoded `gaberoo322/hydra-betting` GitHub URL in `src/digest.ts`, `src/notify.ts`, and `src/proposals.ts`. The fleet model (multiple orchestrator services) is future work, not current scope.

## Considered options

Multi-target inside one orchestrator was considered and rejected: it forces invasive namespacing across Redis keys, schedulers, and budgets for capability we may never use, and systemd already gives cheap fleet semantics. Going from single-swappable to multi-instance is "add another unit file"; going to multi-tenant is a quarter of refactoring.
