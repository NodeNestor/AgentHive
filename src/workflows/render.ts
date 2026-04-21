/**
 * Template rendering + hook script generation.
 *
 * Templates use `{{dotted.path}}` substitution against a context
 * object. Missing keys render as the empty string. No conditionals,
 * no loops — if you need those, the workflow should shell out to
 * real code in `stop_when`.
 *
 * Hook generation turns a workflow's declarative `block_bash`,
 * `block_edit`, and `stop_when` fields into actual bash scripts
 * that get bind-mounted into the session container.
 */
import type { Workflow } from './schema.js';

// ── Templating ────────────────────────────────────────────────────

const TAG_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

export function resolvePath(ctx: unknown, dotted: string): string {
  const parts = dotted.split('.');
  let cur: unknown = ctx;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return '';
    cur = (cur as Record<string, unknown>)[p];
  }
  if (cur == null) return '';
  if (typeof cur === 'string') return cur;
  return JSON.stringify(cur);
}

export function render(template: string, ctx: unknown): string {
  return template.replace(TAG_RE, (_m, p) => resolvePath(ctx, p));
}

// ── Hook generation ───────────────────────────────────────────────

/**
 * Build a PreToolUse Bash-hook script that rejects commands
 * matching any of the workflow's regex patterns. Returns the raw
 * shell source — caller writes it to disk and chmod +x's it.
 */
export function buildPreBashHook(wf: Workflow): string | null {
  if (wf.tools.block_bash.length === 0) return null;
  const patterns = wf.tools.block_bash
    .map((p) => p.replace(/'/g, "'\\''"))
    .map((p) => `  '${p}'`)
    .join('\n');
  return `#!/usr/bin/env bash
set -euo pipefail
source /opt/agenthive/hooks-lib/lib.sh 2>/dev/null || true

cmd="$(jq -r '.tool_input.command // empty')"
[ -z "$cmd" ] && exit 0

patterns=(
${patterns}
)
for pat in "\${patterns[@]}"; do
  if echo "$cmd" | grep -qE "$pat"; then
    echo "BLOCKED by workflow policy: pattern='$pat'"
    exit 2
  fi
done
exit 0
`;
}

export function buildPreEditHook(wf: Workflow): string | null {
  if (wf.tools.block_edit.length === 0) return null;
  const globs = wf.tools.block_edit
    .map((g) => g.replace(/'/g, "'\\''"))
    .map((g) => `  '${g}'`)
    .join('\n');
  return `#!/usr/bin/env bash
set -euo pipefail
source /opt/agenthive/hooks-lib/lib.sh 2>/dev/null || true

file="$(jq -r '.tool_input.file_path // .tool_input.path // empty')"
[ -z "$file" ] && exit 0

globs=(
${globs}
)
for g in "\${globs[@]}"; do
  case "$file" in
    $g) echo "BLOCKED by workflow policy: path glob='$g' matches $file"; exit 2 ;;
  esac
done
exit 0
`;
}

/**
 * Build the Stop hook. The workflow's `stop_when` is a bash
 * snippet — we wrap it with lib.sh + render {{labels.*}} template
 * references against the workflow's own `labels:` vocabulary.
 *
 * If `stop_when` is absent, emit a no-op that always allows stop.
 */
export function buildStopHook(wf: Workflow): string {
  const body = wf.stop_when
    ? render(wf.stop_when, { labels: wf.labels, workflow: wf })
    : 'exit 0';
  return `#!/usr/bin/env bash
set -euo pipefail
source /opt/agenthive/hooks-lib/lib.sh

# ── Rate limit: break runaway loops ──────────────────────────────
if ! check_retrigger_rate "\${RETRIGGERS_PER_HOUR_LIMIT:-20}"; then
  log_hook "retrigger rate exceeded; allowing stop"
  exit 0
fi

${body}
`;
}

/**
 * Render the system prompt with access to the workflow's own label
 * vocabulary (so prompts can say "add the {{labels.handoff}} label"
 * without hardcoding names).
 */
export function renderSystemPrompt(wf: Workflow): string {
  return render(wf.system_prompt, { labels: wf.labels, workflow: { name: wf.name } });
}

/** Render the trigger prompt against a full event context. */
export function renderTriggerPrompt(wf: Workflow, ctx: unknown): string {
  return render(wf.trigger_prompt, ctx);
}
