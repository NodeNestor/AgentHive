#!/usr/bin/env bash
# hooks-lib/lib.sh — sourced by every hook script the router stages
# into an AgentCore session container at /opt/agenthive/hooks-lib/.
#
# Uses curl + jq (both shipped in every AgentCore variant). Does NOT
# require the `gh` CLI — small enough that we don't add another
# runtime dep just for label queries.
#
# Env contract set by the router at container spawn:
#   AGENT_TENANT        owner/repo
#   AGENT_WORKFLOW      workflow name
#   AGENT_SCOPE         "issue-42" | "pr-87" | "global" | ...
#   AGENT_SESSION_KEY   <tenant>/<workflow>/<scope>
#   AGENT_HIVE_URL      router base URL reachable from the container
#   AGENT_HIVE_TOKEN    bearer token the router accepts
#   GITHUB_TOKEN        PAT for api.github.com calls
#
# Optional back-compat:
#   AGENT_ROLE          older name for AGENT_WORKFLOW

set -euo pipefail

# Canonical alias: code (theirs or ours) may reference either name.
: "${AGENT_WORKFLOW:=${AGENT_ROLE:-unknown}}"
: "${AGENT_ROLE:=$AGENT_WORKFLOW}"
export AGENT_WORKFLOW AGENT_ROLE

GH_API="https://api.github.com"

# ── Logging ──────────────────────────────────────────────────────
log_hook() {
  echo "[hook:${AGENT_WORKFLOW}:${AGENT_SCOPE:-?}] $*" >&2
}

# ── GitHub REST helpers (curl-based, no gh CLI dependency) ───────
# Returns a JSON array of open issues matching the given label.
# Echoes "[]" on auth/network failure so callers using jq don't choke.
gh_issues_with_label() {
  local label="$1"
  [ -z "${GITHUB_TOKEN:-}" ] && { echo "[]"; return; }
  curl -sSf --max-time 10 \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "${GH_API}/repos/${AGENT_TENANT}/issues?state=open&labels=$(printf '%s' "$label" | jq -sRr @uri)&per_page=50" \
    2>/dev/null || echo "[]"
}

# JSON array of open PRs.
gh_prs_open() {
  [ -z "${GITHUB_TOKEN:-}" ] && { echo "[]"; return; }
  curl -sSf --max-time 10 \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "${GH_API}/repos/${AGENT_TENANT}/pulls?state=open&per_page=30" \
    2>/dev/null || echo "[]"
}

# Issues matching $with but lacking $without (both label names).
# Label presence on an issue is keyed on `.labels[].name`.
issues_with_but_without_label() {
  local with="$1" without="$2"
  gh_issues_with_label "$with" \
    | jq -c --arg w "$without" \
      '[.[] | select([.labels[]?.name] | index($w) | not)]'
}

# Convenience used by reference workflows.
issues_with_label() {
  gh_issues_with_label "$1"
}

# ── Router callback ──────────────────────────────────────────────
hive_post() {
  local endpoint="$1" body="$2"
  curl -sSf --max-time 10 \
    -H "Authorization: Bearer ${AGENT_HIVE_TOKEN:-}" \
    -H "Content-Type: application/json" \
    -d "$body" \
    "${AGENT_HIVE_URL%/}${endpoint}" \
    2>/dev/null || { log_hook "router callback failed: $endpoint"; return 1; }
}

# ── Budget / rate limit (implemented in the router) ──────────────
budget_scope_key_issue() {
  echo "${AGENT_TENANT}/${AGENT_SCOPE}"
}

check_issue_budget() {
  local max="${1:-3}"
  local key resp attempts
  key="$(budget_scope_key_issue)"
  resp="$(curl -sSf --max-time 5 \
    -H "Authorization: Bearer ${AGENT_HIVE_TOKEN:-}" \
    "${AGENT_HIVE_URL%/}/budget?scope=${key}" 2>/dev/null || echo '{"attempts":0}')"
  attempts="$(echo "$resp" | jq -r '.attempts // 0')"
  if [ "$attempts" -ge "$max" ]; then
    echo "Budget exhausted for $key: ${attempts}/${max} attempts."
    echo "Mark scope blocked and escalate."
    return 1
  fi
  return 0
}

check_retrigger_rate() {
  local limit="${1:-20}"
  local resp count
  resp="$(curl -sSf --max-time 5 \
    -H "Authorization: Bearer ${AGENT_HIVE_TOKEN:-}" \
    "${AGENT_HIVE_URL%/}/retrigger-rate?session=${AGENT_SESSION_KEY}" \
    2>/dev/null || echo '{"count":0}')"
  count="$(echo "$resp" | jq -r '.count // 0')"
  if [ "$count" -ge "$limit" ]; then
    echo "Retrigger rate exceeded (${count}/h). Stopping to break the loop."
    return 1
  fi
  return 0
}

record_retrigger() {
  hive_post "/retrigger-rate/record" \
    "{\"session\":\"${AGENT_SESSION_KEY}\"}" >/dev/null 2>&1 || true
}

# ── Session health ───────────────────────────────────────────────
estimate_session_tokens() {
  local dir="${HOME:-/root}/.claude/projects"
  local bytes
  bytes="$(find "$dir" -name '*.jsonl' -type f -printf '%s\n' 2>/dev/null | awk '{s+=$1} END {print s+0}')"
  echo "$((bytes / 4))"
}
