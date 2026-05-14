#!/usr/bin/env bash
#
# args-parse.sh — Parse slash-arg form for /hydra-autopilot.
#
# /hydra-autopilot accepts both env-var and slash-arg invocation forms.
# This script reads "$@" and translates recognised flags into the
# HYDRA_AUTOPILOT_* env vars consumed by bootstrap.sh. Args win over env
# (explicit > implicit) so an operator can override a systemd-defined
# scope for a one-off run.
#
# Supported flags (all `--key=value` form; equals required):
#   --scope=<all|orch-only|target-only>     → HYDRA_AUTOPILOT_SCOPE
#   --tokens=<N>                            → HYDRA_AUTOPILOT_TOKEN_BUDGET
#   --token-budget=<N>                      (alias of --tokens)
#   --max-sec=<N>                           → HYDRA_AUTOPILOT_MAX_SEC
#   --max-seconds=<N>                       (alias of --max-sec)
#   --idle-turns=<N>                        → HYDRA_AUTOPILOT_IDLE_TURNS
#   --subagent-soft=<N>                     → HYDRA_AUTOPILOT_SUBAGENT_MAX_TOKENS
#   --subagent-hard=<N>                     → HYDRA_AUTOPILOT_SUBAGENT_HARD_MAX_TOKENS
#
# Unknown args (including free-form trailing tokens such as
# `focus=codex-cli-removal`) produce a `[autopilot] WARN: unknown arg <X>`
# line on stderr but do NOT abort — they are passed through to the
# operator log so the model can pick them up as conversational context.
#
# Usage (from bootstrap.sh):
#   source "$(dirname "$0")/args-parse.sh" "$@"
#
# Intentionally idempotent: sourcing twice with the same args is a no-op
# beyond re-exporting the same values.
#
# Issue #410.

# NOTE: Do NOT `set -euo pipefail` here — this file is `source`d into
# bootstrap.sh, and bootstrap.sh already sets those. Adding them here
# would risk surprising the caller if this file is sourced from a
# context that hasn't opted in.

for _ap_arg in "$@"; do
  case "$_ap_arg" in
    --scope=*)
      export HYDRA_AUTOPILOT_SCOPE="${_ap_arg#--scope=}"
      ;;
    --tokens=*)
      export HYDRA_AUTOPILOT_TOKEN_BUDGET="${_ap_arg#--tokens=}"
      ;;
    --token-budget=*)
      export HYDRA_AUTOPILOT_TOKEN_BUDGET="${_ap_arg#--token-budget=}"
      ;;
    --max-sec=*)
      export HYDRA_AUTOPILOT_MAX_SEC="${_ap_arg#--max-sec=}"
      ;;
    --max-seconds=*)
      export HYDRA_AUTOPILOT_MAX_SEC="${_ap_arg#--max-seconds=}"
      ;;
    --idle-turns=*)
      export HYDRA_AUTOPILOT_IDLE_TURNS="${_ap_arg#--idle-turns=}"
      ;;
    --subagent-soft=*)
      export HYDRA_AUTOPILOT_SUBAGENT_MAX_TOKENS="${_ap_arg#--subagent-soft=}"
      ;;
    --subagent-hard=*)
      export HYDRA_AUTOPILOT_SUBAGENT_HARD_MAX_TOKENS="${_ap_arg#--subagent-hard=}"
      ;;
    *)
      # Free-form trailing tokens (e.g. `focus=codex-cli-removal`) are
      # tolerated. Warn so the operator notices typos, but never abort.
      echo "[autopilot] WARN: unknown arg ${_ap_arg}" >&2
      ;;
  esac
done

unset _ap_arg
