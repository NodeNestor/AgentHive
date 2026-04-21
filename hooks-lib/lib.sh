#!/usr/bin/env bash
# Shared hook helpers. Sourced by every hook script mounted into
# the agent container at /opt/agenthive/hooks-lib/lib.sh.
#
# Depends on: gh CLI (authenticated via GITHUB_TOKEN env), jq, curl.
# AgentCore images already include these.

set -euo pipefail

# ── Env contract ─────────────────────────────────────────────────
# Set by the router at container spawn:
#   AGENT_TENANT    — e.g. "nodenestor/byttr"
#   AGENT_ROLE      — "coder" | "tester" | ...
#   AGENT_SCOPE     — e.g. "issue-42" | "pr-87" | "global"
#   AGENT_SESSION_KEY — "<tenant>/<role>/<scope>"
#   AGENT_HIVE_URL  — router URL (reachable from container)
#   AGENT_HIVE_TOKEN — bearer token for router callback API
#   GITHUB_TOKEN    — installation token or PAT

# ── Logging ──────────────────────────────────────────────────────
log_hook() {
  local msg="$*"
  echo "[hook:${AGENT_ROLE}:${AGENT_SCOPE}] $msg" >&2
}

# ── Router callback ──────────────────────────────────────────────
# Report events back to the router (retriggers, budget bumps, etc.).
hive_post() {
  local endpoint="$1"
  local body="$2"
  curl -sSf --max-time 10 \
    -H "Authorization: Bearer ${AGENT_HIVE_TOKEN:-}" \
    -H "Content-Type: application/json" \
    -d "$body" \
    "${AGENT_HIVE_URL%/}${endpoint}" || {
      log_hook "router callback failed: $endpoint"
      return 1
    }
}

# ── Label queries ────────────────────────────────────────────────
# Assumes AGENT_TENANT is "owner/repo" when the role's scope is not
# global.
issues_with_label() {
  local label="$1"
  gh issue list \
    --repo "$AGENT_TENANT" \
    --label "$label" \
    --state open \
    --json number,title,labels \
    --limit 50 || echo "[]"
}

# Issues that have `$1` but lack `$2`.
issues_with_but_without_label() {
  local with="$1"
  local without="$2"
  issues_with_label "$with" | jq -c --arg w "$without" \
    '[.[] | select(any(.labels[]; .name == $w) | not)]'
}

# ── Budget helpers ───────────────────────────────────────────────
budget_scope_key_issue() {
  echo "${AGENT_TENANT}/${AGENT_SCOPE}"
}

# Exit with message if budget exhausted for current scope.
check_issue_budget() {
  local max_attempts="${1:-3}"
  local key
  key="$(budget_scope_key_issue)"
  local resp
  resp="$(curl -sSf --max-time 5 \
    -H "Authorization: Bearer ${AGENT_HIVE_TOKEN:-}" \
    "${AGENT_HIVE_URL%/}/budget?scope=${key}" || echo '{"attempts":0}')"
  local attempts
  attempts="$(echo "$resp" | jq -r '.attempts // 0')"
  if (( attempts >= max_attempts )); then
    echo "Budget exhausted for $key: ${attempts}/${max_attempts} attempts."
    echo "Add label 'ai:blocked' and leave a comment explaining."
    return 1
  fi
  return 0
}

# ── Retrigger rate limit ─────────────────────────────────────────
check_retrigger_rate() {
  local limit="${1:-20}"
  local resp
  resp="$(curl -sSf --max-time 5 \
    -H "Authorization: Bearer ${AGENT_HIVE_TOKEN:-}" \
    "${AGENT_HIVE_URL%/}/retrigger-rate?session=${AGENT_SESSION_KEY}" \
    || echo '{"count":0}')"
  local count
  count="$(echo "$resp" | jq -r '.count // 0')"
  if (( count >= limit )); then
    echo "Retrigger rate exceeded (${count}/h). Stopping to break loop."
    return 1
  fi
  return 0
}

# Report a retrigger to the router (for rate limit accounting).
record_retrigger() {
  hive_post "/retrigger-rate/record" \
    "{\"session\":\"${AGENT_SESSION_KEY}\"}" >/dev/null 2>&1 || true
}

# ── Session health ───────────────────────────────────────────────
# Read estimated tokens in the current Claude Code session.
estimate_session_tokens() {
  local session_file="${HOME}/.claude/projects/"
  # Rough heuristic: 4 bytes per token.
  local bytes
  bytes="$(find "$session_file" -name '*.jsonl' -type f -printf '%s\n' 2>/dev/null | awk '{s+=$1} END {print s+0}')"
  echo $((bytes / 4))
}
