/**
 * Workflow schema. A workflow is the *entire* definition of one
 * kind of agent job, written as YAML by the consumer. The router
 * has zero built-in agent logic — it just reads these files and
 * runs them.
 *
 * Workflows live in the consumer repo at `.agents/workflows/*.yml`
 * and are fetched on demand (with in-memory TTL) by the router.
 */
import { z } from 'zod';

const TriggerSchema = z.object({
  on: z.string(),                 // e.g. "issues" or "issue_comment"
  types: z.array(z.string()).optional(), // e.g. ["opened", "labeled"]
  if: z.string().optional(),      // small expression — see dispatcher
});

const ToolsSchema = z
  .object({
    allow: z.array(z.string()).default([]),    // Claude --allowed-tools
    disallow: z.array(z.string()).default([]), // Claude --disallowed-tools
    block_bash: z.array(z.string()).default([]),      // regex allowlist of commands to reject
    block_edit: z.array(z.string()).default([]),      // glob list of file paths to refuse
  })
  .default({});

const BudgetSchema = z
  .object({
    max_attempts_per_scope: z.number().int().positive().optional(),
    max_tokens_per_task: z.number().int().positive().optional(),
  })
  .default({});

export const WorkflowSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, 'workflow name must be lowercase slug'),
  description: z.string().optional(),
  enabled: z.boolean().default(true),

  // Routing.
  scope: z.enum(['issue', 'pr', 'commit', 'branch', 'global']),
  image: z.enum(['minimal', 'ubuntu', 'kali']).default('minimal'),
  model: z.string().default('claude-opus-4-7'),
  fallback_model: z.string().optional(),
  idle_timeout_seconds: z.number().int().positive().default(7 * 24 * 3600),
  max_session_tokens: z.number().int().positive().default(150_000),
  requires_desktop: z.boolean().default(false), // noVNC for human observation

  // Triggers — what GitHub events spin this workflow up.
  on: z.array(TriggerSchema).default([]),

  // Prompts. `system_prompt` becomes the CLAUDE.md in the workspace.
  // `trigger_prompt` is templated and injected as the human message
  // when an event fires.
  system_prompt: z.string(),
  trigger_prompt: z.string(),

  // Label vocabulary — consumer picks their own names, referenced
  // from templates and stop_when as {{labels.key}}.
  labels: z.record(z.string(), z.string()).default({}),

  tools: ToolsSchema,
  budget: BudgetSchema,

  // Bash snippet run as a Stop hook. Exit 0 → agent stops; exit 2
  // → block stop, inject stdout as the next user message.
  stop_when: z.string().optional(),

  // Slash-command entry point. Set to `manual` to allow
  // `/ai <workflow-name> <message>` from operators.
  slash: z.string().optional(),

  // Operator allowlist (GitHub usernames). Applies to the `slash`
  // trigger. Empty = anyone with write access on the repo.
  operators: z.array(z.string()).default([]),
});

export type Workflow = z.infer<typeof WorkflowSchema>;
