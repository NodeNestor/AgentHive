/**
 * HTTP server. Hono + node adapter.
 *
 *   POST /webhook/github           — GitHub webhooks (HMAC-verified)
 *   POST /dispatch                 — direct dispatch (bearer token)
 *   POST /handoff                  — agent-to-agent handoff callback
 *   GET  /budget?scope=...         — hook callback
 *   POST /budget/bump              — hook callback
 *   GET  /retrigger-rate?session=..— hook callback
 *   POST /retrigger-rate/record    — hook callback
 *   GET  /sessions                 — list (auth'd)
 *   GET  /sessions/:key/logs       — tail (auth'd)
 *   POST /sessions/:key/reset      — nuke (auth'd)
 *   GET  /health                   — liveness + loaded example workflows
 */
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { config } from './config.js';
import { log } from './log.js';
import { verifySignature } from './github/webhook.js';
import { ctxFromGithub, dispatch } from './router/dispatcher.js';
import {
  enqueue,
  bumpBudget,
  getBudget,
  listSessions,
  logRetrigger,
  countRetriggersInWindow,
  upsertSession,
} from './db.js';
import { scopeFor, keyToString, stringToKey, type SessionKey } from './router/session-key.js';
import {
  getLogs,
  resetSession,
  ensureSession,
} from './docker/session-container.js';
import { parseSlashCommand } from './github/slash-commands.js';
import { startInboxWorker } from './workers/inbox-worker.js';
import { startWatchdog } from './workers/watchdog.js';
import { startTailLoop, registerTail } from './streams/agent-tailer.js';
import {
  getWorkflow,
  listLocalExampleWorkflows,
  loadWorkflows,
} from './workflows/loader.js';
import { renderTriggerPrompt } from './workflows/render.js';

export const app = new Hono();

function bearerOk(req: Request): boolean {
  const h = req.headers.get('authorization') ?? '';
  return h === `Bearer ${config.DISPATCH_TOKEN}`;
}

// ── Health ────────────────────────────────────────────────────────
app.get('/health', (c) =>
  c.json({
    ok: true,
    hasGithubToken: !!config.GITHUB_TOKEN,
    exampleWorkflows: listLocalExampleWorkflows().map((w) => ({
      name: w.name,
      scope: w.scope,
      image: w.image,
      triggers: w.on.length,
    })),
  }),
);

// ── GitHub webhook ────────────────────────────────────────────────
app.post('/webhook/github', async (c) => {
  const rawBody = await c.req.text();
  const sig = c.req.header('x-hub-signature-256') ?? null;
  if (!verifySignature(rawBody, sig, config.WEBHOOK_SECRET)) {
    log.warn('webhook signature invalid');
    return c.json({ ok: false, error: 'invalid signature' }, 401);
  }
  const eventName = c.req.header('x-github-event') ?? 'unknown';
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ ok: false, error: 'bad json' }, 400);
  }

  // Slash-command fast path.
  if (eventName === 'issue_comment' && (payload as any)?.action === 'created') {
    const body: string = (payload as any)?.comment?.body ?? '';
    if (body.trim().startsWith('/ai')) {
      const cmd = parseSlashCommand(body);
      if (cmd) {
        const handled = await handleSlashCommand(cmd, payload as any);
        if (handled) return c.json({ ok: true, handled: 'slash-command' });
      }
    }
  }

  const ctx = ctxFromGithub(eventName, payload);
  const enqueued = await dispatch(ctx);
  return c.json({ ok: true, enqueued });
});

// ── Direct dispatch ───────────────────────────────────────────────
app.post('/dispatch', async (c) => {
  if (!bearerOk(c.req.raw)) return c.json({ error: 'unauthorized' }, 401);
  const body = (await c.req.json()) as {
    tenant: string;
    workflow: string;
    scope?: string;
    issueNumber?: number;
    prNumber?: number;
    commitSha?: string;
    branch?: string;
    message?: string;
    streamTo?: string;
    priority?: 'urgent' | 'normal' | 'low';
  };

  const wf = await getWorkflow(body.tenant, body.workflow);
  if (!wf) return c.json({ error: `unknown workflow: ${body.workflow}` }, 400);

  const scope =
    body.scope ??
    scopeFor(wf.scope, {
      issueNumber: body.issueNumber,
      prNumber: body.prNumber,
      commitSha: body.commitSha,
      branch: body.branch,
    });
  const keyObj: SessionKey = { tenant: body.tenant, workflow: body.workflow, scope };
  const key = keyToString(keyObj);

  upsertSession({ key, tenant: keyObj.tenant, role: keyObj.workflow, scope: keyObj.scope, state_dir: '' });

  const ctx = {
    event: 'dispatch',
    actor: 'dispatch',
    tenant: body.tenant,
    issueNumber: body.issueNumber,
    prNumber: body.prNumber,
    commitSha: body.commitSha,
    branch: body.branch,
    body: body.message,
  };

  enqueue({
    session_key: key,
    body: body.message ?? renderTriggerPrompt(wf, { ...ctx, labels: wf.labels }),
    priority: body.priority ?? 'normal',
    stream_to: body.streamTo ?? null,
    source: 'dispatch',
  });
  if (body.streamTo) registerTail(keyObj, body.streamTo);
  startTailLoop();
  ensureSession(keyObj).catch((err) => log.warn({ err, key }, 'ensureSession failed'));
  return c.json({ ok: true, sessionKey: key });
});

// ── Hook callbacks ────────────────────────────────────────────────
app.post('/handoff', async (c) => {
  if (!bearerOk(c.req.raw)) return c.json({ error: 'unauthorized' }, 401);
  const body = (await c.req.json()) as {
    from: string;
    to_workflow: string;
    scope?: string;
    message?: string;
  };
  const fromKey = stringToKey(body.from);
  const target: SessionKey = {
    tenant: fromKey.tenant,
    workflow: body.to_workflow,
    scope: body.scope ?? fromKey.scope,
  };
  const key = keyToString(target);
  upsertSession({ key, tenant: target.tenant, role: target.workflow, scope: target.scope, state_dir: '' });
  enqueue({
    session_key: key,
    body: body.message ?? `Handoff from ${body.from}. Pick up from the label board.`,
    source: 'handoff',
  });
  return c.json({ ok: true, to: key });
});

app.get('/budget', (c) => {
  if (!bearerOk(c.req.raw)) return c.json({ error: 'unauthorized' }, 401);
  const scope = c.req.query('scope');
  if (!scope) return c.json({ error: 'missing scope' }, 400);
  return c.json(getBudget(scope));
});

app.post('/budget/bump', async (c) => {
  if (!bearerOk(c.req.raw)) return c.json({ error: 'unauthorized' }, 401);
  const b = (await c.req.json()) as {
    scope: string;
    attempts?: number;
    tokens?: number;
    usd_cents?: number;
  };
  bumpBudget(b.scope, b);
  return c.json(getBudget(b.scope));
});

app.post('/retrigger-rate/record', async (c) => {
  if (!bearerOk(c.req.raw)) return c.json({ error: 'unauthorized' }, 401);
  const { session } = (await c.req.json()) as { session: string };
  logRetrigger(session);
  return c.json({ ok: true });
});

app.get('/retrigger-rate', (c) => {
  if (!bearerOk(c.req.raw)) return c.json({ error: 'unauthorized' }, 401);
  const session = c.req.query('session');
  if (!session) return c.json({ error: 'missing session' }, 400);
  return c.json({ count: countRetriggersInWindow(session, 3600) });
});

// ── Sessions admin ────────────────────────────────────────────────
app.get('/sessions', (c) => {
  if (!bearerOk(c.req.raw)) return c.json({ error: 'unauthorized' }, 401);
  return c.json({ sessions: listSessions() });
});

app.get('/sessions/:key/logs', async (c) => {
  if (!bearerOk(c.req.raw)) return c.json({ error: 'unauthorized' }, 401);
  const key = decodeURIComponent(c.req.param('key'));
  try {
    const keyObj = stringToKey(key);
    const text = await getLogs(keyObj, Number(c.req.query('lines') ?? 200));
    return c.text(text);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.post('/sessions/:key/reset', async (c) => {
  if (!bearerOk(c.req.raw)) return c.json({ error: 'unauthorized' }, 401);
  const key = decodeURIComponent(c.req.param('key'));
  await resetSession(stringToKey(key));
  return c.json({ ok: true });
});

// ── Slash command dispatch ───────────────────────────────────────
async function handleSlashCommand(
  cmd: SlashCommand,
  payload: any,
): Promise<boolean> {
  const tenant = payload?.repository?.full_name;
  if (!tenant) return false;

  const issueNumber = payload?.issue?.number as number | undefined;
  const isPullRequest = !!payload?.issue?.pull_request;
  const streamTo = issueNumber ? `${isPullRequest ? 'pr' : 'issue'}:${issueNumber}` : null;
  const actor = payload?.sender?.login;

  if (cmd.kind === 'workflow') {
    const workflows = await loadWorkflows(tenant);
    const wf = workflows.find((w) => w.slash === cmd.workflow || w.name === cmd.workflow);
    if (!wf) return false;
    if (wf.operators.length > 0 && !wf.operators.includes(actor ?? '')) {
      log.info({ actor, workflow: wf.name }, 'slash blocked — not an operator');
      return false;
    }
    const scope = scopeFor(wf.scope, {
      issueNumber,
      prNumber: isPullRequest ? issueNumber : undefined,
    });
    const key: SessionKey = { tenant, workflow: wf.name, scope };
    const k = keyToString(key);
    upsertSession({ key: k, tenant, role: wf.name, scope, state_dir: '' });
    const ctx = {
      event: 'slash',
      actor,
      tenant,
      issueNumber,
      prNumber: isPullRequest ? issueNumber : undefined,
      body: cmd.message,
      comment: payload?.comment,
      issue: payload?.issue,
      pull_request: payload?.pull_request,
    };
    enqueue({
      session_key: k,
      body: cmd.message
        ? `Operator ${actor} invoked /ai ${cmd.workflow}: ${cmd.message}`
        : renderTriggerPrompt(wf, { ...ctx, labels: wf.labels }),
      stream_to: streamTo,
      source: 'slash-command',
      priority: 'urgent',
    });
    if (streamTo) registerTail(key, streamTo);
    ensureSession(key).catch(() => undefined);
    return true;
  }

  // stop / status / logs / retry are session-level meta messages.
  if (!issueNumber) return false;
  // Can't know which workflow to target without more info — inject
  // the meta message into *all* workflows that use this scope.
  const workflows = await loadWorkflows(tenant);
  let routed = 0;
  for (const wf of workflows) {
    const scopeNeedsIssue = wf.scope === 'issue' && !isPullRequest;
    const scopeNeedsPr = wf.scope === 'pr' && isPullRequest;
    if (!scopeNeedsIssue && !scopeNeedsPr) continue;
    const scope = scopeFor(wf.scope, {
      issueNumber,
      prNumber: isPullRequest ? issueNumber : undefined,
    });
    const key: SessionKey = { tenant, workflow: wf.name, scope };
    const k = keyToString(key);
    upsertSession({ key: k, tenant, role: wf.name, scope, state_dir: '' });
    enqueue({
      session_key: k,
      body: `Operator command: /ai ${cmd.kind}`,
      stream_to: streamTo,
      source: 'slash-command',
      priority: 'urgent',
    });
    if (streamTo) registerTail(key, streamTo);
    routed++;
  }
  return routed > 0;
}

type SlashCommand = ReturnType<typeof parseSlashCommand> & object;

// ── Boot ──────────────────────────────────────────────────────────
export function start(): void {
  startInboxWorker();
  startTailLoop();
  startWatchdog();
  serve({ fetch: app.fetch, port: config.PORT, hostname: config.HOST });
  log.info({ port: config.PORT, host: config.HOST }, 'agenthive listening');
}
