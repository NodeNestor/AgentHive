/**
 * Dispatcher. GitHub webhook (or direct dispatch) → tenant's
 * workflow YAMLs → match triggers → render prompts → enqueue.
 *
 * The router has zero opinion about what workflows do. It just
 * matches `on:` entries against the event and runs whatever prompt
 * the workflow declares.
 *
 * Trigger expression grammar (`if:` field):
 *   label == "ai:queued"
 *   body starts_with "/ai code"
 *   state == "success" and environment == "staging"
 *
 * Resolved against the EventContext built from the webhook payload.
 */
import { loadWorkflows } from '../workflows/loader.js';
import { renderTriggerPrompt } from '../workflows/render.js';
import type { Workflow } from '../workflows/schema.js';
import { enqueue, upsertSession } from '../db.js';
import { keyToString, scopeFor, type SessionKey } from './session-key.js';
import { ensureSession } from '../docker/session-container.js';
import { registerTail, startTailLoop } from '../streams/agent-tailer.js';
import { log } from '../log.js';

export interface EventContext {
  // Flat event identifiers.
  event: string; // "issues", "pull_request", "issue_comment", ...
  action?: string; // "opened", "labeled", "synchronize", ...
  tenant: string; // "owner/repo" or "owner"
  actor: string;

  // Event-specific fields exposed to templates + `if:` expressions.
  label?: string;
  state?: string;
  environment?: string;
  body?: string;
  url?: string;
  deploymentUrl?: string;

  issueNumber?: number;
  prNumber?: number;
  commitSha?: string;
  branch?: string;

  // Nested objects for template resolution — e.g. {{issue.title}}.
  issue?: Record<string, unknown>;
  pull_request?: Record<string, unknown>;
  comment?: Record<string, unknown>;
  deployment?: Record<string, unknown>;
  deployment_status?: Record<string, unknown>;

  raw: unknown;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function evalCondition(cond: string, ctx: Record<string, any>): boolean {
  if (!cond) return true;
  const js = cond
    .replace(/\bstarts_with\b/gi, '.startsWith')
    .replace(/\bends_with\b/gi, '.endsWith')
    .replace(/\band\b/gi, '&&')
    .replace(/\bor\b/gi, '||');
  try {
    const keys = Object.keys(ctx);
    const vals = Object.values(ctx);
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const fn = new Function(...keys, `return (${js});`);
    return Boolean(fn(...vals));
  } catch (err) {
    log.warn({ err, cond }, 'trigger condition eval failed');
    return false;
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function triggerMatches(wf: Workflow, ctx: EventContext): boolean {
  for (const t of wf.on) {
    if (t.on !== ctx.event) continue;
    if (t.types && t.types.length > 0) {
      if (!ctx.action || !t.types.includes(ctx.action)) continue;
    }
    if (!t.if) return true;
    if (evalCondition(t.if, ctx as unknown as Record<string, unknown>)) return true;
  }
  return false;
}

function streamTargetFor(ctx: EventContext, wf: Workflow): string | null {
  if (wf.scope === 'pr' && ctx.prNumber) return `pr:${ctx.prNumber}`;
  if (wf.scope === 'issue' && ctx.issueNumber) return `issue:${ctx.issueNumber}`;
  if (wf.scope === 'commit' && ctx.commitSha) return `commit:${ctx.commitSha}`;
  if (ctx.prNumber) return `pr:${ctx.prNumber}`;
  if (ctx.issueNumber) return `issue:${ctx.issueNumber}`;
  return null;
}

export async function dispatch(ctx: EventContext): Promise<string[]> {
  const workflows = await loadWorkflows(ctx.tenant);
  const enqueued: string[] = [];

  for (const wf of workflows) {
    if (!triggerMatches(wf, ctx)) continue;

    let scope: string;
    try {
      scope = scopeFor(wf.scope, {
        issueNumber: ctx.issueNumber,
        prNumber: ctx.prNumber,
        commitSha: ctx.commitSha,
        branch: ctx.branch,
      });
    } catch (err) {
      log.debug({ err, workflow: wf.name }, 'cannot compute scope; skipping');
      continue;
    }

    const keyObj: SessionKey = { tenant: ctx.tenant, workflow: wf.name, scope };
    const key = keyToString(keyObj);

    upsertSession({
      key,
      tenant: keyObj.tenant,
      role: keyObj.workflow,        // column name is 'role' but we store workflow
      scope: keyObj.scope,
      state_dir: '',
    });

    const streamTo = streamTargetFor(ctx, wf);
    const body = renderTriggerPrompt(wf, { ...ctx, labels: wf.labels });
    enqueue({
      session_key: key,
      body,
      priority: 'normal',
      stream_to: streamTo,
      source: 'github-webhook',
    });
    if (streamTo) registerTail(keyObj, streamTo);
    enqueued.push(key);

    ensureSession(keyObj).catch((err) => log.warn({ err, key }, 'ensureSession failed'));
  }

  if (enqueued.length > 0) startTailLoop();
  return enqueued;
}

/** Parse a GitHub webhook payload into the event context used for matching. */
export function ctxFromGithub(eventName: string, payload: any): EventContext {
  const action = payload?.action;
  const repo = payload?.repository?.full_name;
  const actor = payload?.sender?.login ?? 'unknown';

  const ctx: EventContext = {
    event: eventName,
    action,
    tenant: repo ?? payload?.organization?.login ?? 'unknown',
    actor,
    raw: payload,
  };

  if (payload?.label?.name) ctx.label = payload.label.name;
  if (payload?.issue) {
    ctx.issue = payload.issue;
    if (payload.issue.number) ctx.issueNumber = payload.issue.number;
    if (payload.issue.pull_request) ctx.prNumber = payload.issue.number;
  }
  if (payload?.pull_request) {
    ctx.pull_request = payload.pull_request;
    if (payload.pull_request.number) ctx.prNumber = payload.pull_request.number;
  }
  if (payload?.comment) {
    ctx.comment = payload.comment;
    ctx.body = payload.comment.body;
  }
  if (payload?.deployment_status) {
    ctx.deployment_status = payload.deployment_status;
    ctx.state = payload.deployment_status.state;
    ctx.url = payload.deployment_status.target_url;
    ctx.deploymentUrl = payload.deployment_status.target_url;
  }
  if (payload?.deployment) {
    ctx.deployment = payload.deployment;
    ctx.environment = payload.deployment.environment;
  }
  if (payload?.after) ctx.commitSha = payload.after;
  if (payload?.ref?.startsWith?.('refs/heads/')) ctx.branch = payload.ref.slice(11);
  if (!ctx.state && payload?.state) ctx.state = payload.state;

  return ctx;
}
