/**
 * Local smoke tests. Runs modules in isolation — no Docker, no
 * network. Call: `node tests/smoke.mjs` (uses tsx via the scripts
 * entry).
 *
 *   cd tests && tsx smoke.mjs
 *
 * Each test logs PASS/FAIL. Exits non-zero on any failure.
 */
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';

process.env.WEBHOOK_SECRET = 'test-webhook-secret-123';
process.env.DISPATCH_TOKEN = 'test-dispatch-token-456';
process.env.DB_PATH = './data/test.sqlite';
process.env.LOG_LEVEL = 'error';

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(async () => {
      await fn();
      console.log(`\x1b[32mPASS\x1b[0m ${name}`);
      passed++;
    })
    .catch((err) => {
      console.log(`\x1b[31mFAIL\x1b[0m ${name}: ${err.message}`);
      if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
      failed++;
    });
}

// ── Imports happen after env is set so config parses correctly. ──
const { verifySignature } = await import('../src/github/webhook.js');
const { parseSlashCommand } = await import('../src/github/slash-commands.js');
const { keyToString, stringToKey, scopeFor, keyToContainerName } = await import(
  '../src/router/session-key.js'
);
const { render, renderSystemPrompt, renderTriggerPrompt, buildStopHook, buildPreBashHook, buildPreEditHook } =
  await import('../src/workflows/render.js');
const { WorkflowSchema } = await import('../src/workflows/schema.js');
const { detectClaudeAuth, claudeCredentialsBind } = await import(
  '../src/docker/auth-detect.js'
);
const { ctxFromGithub } = await import('../src/router/dispatcher.js');

// ── HMAC ─────────────────────────────────────────────────────────
await test('HMAC: valid signature passes', () => {
  const body = '{"hello":"world"}';
  const sig =
    'sha256=' +
    crypto.createHmac('sha256', 'test-webhook-secret-123').update(body).digest('hex');
  assert.equal(verifySignature(body, sig, 'test-webhook-secret-123'), true);
});
await test('HMAC: tampered body fails', () => {
  const body = '{"hello":"world"}';
  const sig =
    'sha256=' +
    crypto.createHmac('sha256', 'test-webhook-secret-123').update(body).digest('hex');
  assert.equal(verifySignature('{"hello":"WORLD"}', sig, 'test-webhook-secret-123'), false);
});
await test('HMAC: wrong secret fails', () => {
  const body = '{"a":1}';
  const sig =
    'sha256=' + crypto.createHmac('sha256', 'correct').update(body).digest('hex');
  assert.equal(verifySignature(body, sig, 'wrong'), false);
});
await test('HMAC: missing signature fails', () => {
  assert.equal(verifySignature('{}', null, 'whatever'), false);
});

// ── Slash commands ───────────────────────────────────────────────
await test('slash: /ai code fix the bug', () => {
  const r = parseSlashCommand('/ai code fix the bug');
  assert.deepEqual(r, { kind: 'workflow', workflow: 'code', message: 'fix the bug' });
});
await test('slash: /ai test with url', () => {
  const r = parseSlashCommand('/ai test https://example.com more text');
  assert.equal(r.kind, 'workflow');
  assert.equal(r.workflow, 'test');
  assert.equal(r.message, 'https://example.com more text');
});
await test('slash: /ai stop', () => {
  assert.deepEqual(parseSlashCommand('/ai stop'), { kind: 'stop' });
});
await test('slash: plain text returns null', () => {
  assert.equal(parseSlashCommand('hello world'), null);
});
await test('slash: /ai alone returns null', () => {
  assert.equal(parseSlashCommand('/ai'), null);
});

// ── Session keys ─────────────────────────────────────────────────
await test('session-key: round trip', () => {
  const k = { tenant: 'OWNER/repo-name', workflow: 'Coder-Bot', scope: 'issue-42' };
  const s = keyToString(k);
  const back = stringToKey(s);
  assert.equal(back.workflow, 'coder-bot');
  assert.equal(back.scope, 'issue-42');
});
await test('session-key: tenant with slash preserved', () => {
  const k = { tenant: 'nodenestor/agenthive', workflow: 'coder', scope: 'issue-7' };
  const s = keyToString(k);
  assert.equal(s, 'nodenestor/agenthive/coder/issue-7');
});
await test('session-key: scopeFor issue', () => {
  assert.equal(scopeFor('issue', { issueNumber: 42 }), 'issue-42');
});
await test('session-key: scopeFor pr requires prNumber', () => {
  assert.throws(() => scopeFor('pr', {}), /prNumber/);
});
await test('session-key: scopeFor commit truncates sha', () => {
  assert.equal(
    scopeFor('commit', { commitSha: 'abcdef1234567890abcd' }),
    'commit-abcdef123456',
  );
});
await test('session-key: scopeFor global', () => {
  assert.equal(scopeFor('global', {}), 'global');
});
await test('session-key: container name is Docker-safe', () => {
  const k = { tenant: 'Foo/Bar.Baz', workflow: 'web-dev', scope: 'issue-123' };
  const n = keyToContainerName(k);
  assert.match(n, /^agent-[a-zA-Z0-9_.-]+$/);
  assert.ok(n.length <= 64);
});

// ── Templates ────────────────────────────────────────────────────
await test('template: simple path', () => {
  assert.equal(render('hello {{name}}', { name: 'world' }), 'hello world');
});
await test('template: nested path', () => {
  assert.equal(render('#{{issue.number}}', { issue: { number: 42 } }), '#42');
});
await test('template: missing path = empty', () => {
  assert.equal(render('x={{missing.thing}};', {}), 'x=;');
});
await test('template: json serialization of non-string', () => {
  assert.equal(render('{{x}}', { x: { a: 1 } }), '{"a":1}');
});
await test('template: multiple tags', () => {
  const s = render('{{a}} and {{b.c}}', { a: 'A', b: { c: 'C' } });
  assert.equal(s, 'A and C');
});

// ── Workflow schema ──────────────────────────────────────────────
await test('workflow schema: minimal valid', () => {
  const wf = WorkflowSchema.parse({
    name: 'test',
    scope: 'issue',
    system_prompt: 'x',
    trigger_prompt: 'y',
  });
  assert.equal(wf.name, 'test');
  assert.equal(wf.image, 'minimal');
  assert.equal(wf.model, 'claude-opus-4-7');
  assert.equal(wf.open, false);
});
await test('workflow schema: rejects bad name', () => {
  assert.throws(() =>
    WorkflowSchema.parse({
      name: 'BadName With Spaces',
      scope: 'issue',
      system_prompt: 'x',
      trigger_prompt: 'y',
    }),
  );
});
await test('workflow schema: rejects unknown scope', () => {
  assert.throws(() =>
    WorkflowSchema.parse({
      name: 'x',
      scope: 'nonsense',
      system_prompt: 'x',
      trigger_prompt: 'y',
    }),
  );
});

// ── Hook generation ──────────────────────────────────────────────
const wfForHooks = WorkflowSchema.parse({
  name: 'sample',
  scope: 'issue',
  system_prompt: 'You are {{labels.role}}.',
  trigger_prompt: 'issue {{issue.number}}',
  labels: { queued: 'ai:queued', role: 'coder' },
  tools: {
    allow: ['Bash'],
    block_bash: ['git push.*--force', '--no-verify'],
    block_edit: ['*.env', '*.github/workflows/*'],
  },
  stop_when: `
    queued=$(issues_with_label '{{labels.queued}}')
    if [ "$(echo "$queued" | jq 'length')" -gt 0 ]; then
      echo "work queued"
      exit 2
    fi
    exit 0
  `,
});
await test('render: system prompt resolves labels', () => {
  const s = renderSystemPrompt(wfForHooks);
  assert.equal(s, 'You are coder.');
});
await test('render: trigger prompt resolves event', () => {
  const s = renderTriggerPrompt(wfForHooks, { issue: { number: 99 } });
  assert.equal(s, 'issue 99');
});
await test('render: stop hook has rate-limit wrapper + body', () => {
  const s = buildStopHook(wfForHooks);
  assert.match(s, /check_retrigger_rate/);
  assert.match(s, /ai:queued/); // label was resolved
  assert.match(s, /#!\/usr\/bin\/env bash/);
});
await test('render: pre-bash hook has patterns', () => {
  const s = buildPreBashHook(wfForHooks);
  assert.match(s, /git push.*--force/);
  assert.match(s, /--no-verify/);
  assert.match(s, /BLOCKED/);
});
await test('render: pre-bash hook null when no patterns', () => {
  const wf = WorkflowSchema.parse({
    name: 'x',
    scope: 'issue',
    system_prompt: 'x',
    trigger_prompt: 'y',
  });
  assert.equal(buildPreBashHook(wf), null);
});
await test('render: pre-edit hook has globs', () => {
  const s = buildPreEditHook(wfForHooks);
  assert.match(s, /\*\.env/);
  assert.match(s, /workflows/);
});

// ── Auth detect ──────────────────────────────────────────────────
await test('auth-detect: windows path gets translated', () => {
  const det = detectClaudeAuth({
    override: 'C:\\Users\\somebody\\.claude',
  });
  if (det.platform === 'win32') {
    assert.match(det.hostPath, /^\/\/c\/Users\/somebody/);
  }
});
await test('auth-detect: explicit override respected', () => {
  const det = detectClaudeAuth({ override: '/tmp/fake-that-does-not-exist' });
  assert.equal(det.source, 'override');
});
await test('auth-detect: null bind when no path', () => {
  assert.equal(
    claudeCredentialsBind({ hostPath: null, source: 'none', hasCredentials: false, platform: 'linux', windowsTranslated: false }),
    null,
  );
});

// ── Event context parsing ────────────────────────────────────────
await test('ctxFromGithub: issues.labeled extracts label + number', () => {
  const ctx = ctxFromGithub('issues', {
    action: 'labeled',
    repository: { full_name: 'foo/bar' },
    sender: { login: 'alice' },
    label: { name: 'ai:queued' },
    issue: { number: 42, title: 't', body: 'b', author_association: 'OWNER' },
  });
  assert.equal(ctx.event, 'issues');
  assert.equal(ctx.action, 'labeled');
  assert.equal(ctx.label, 'ai:queued');
  assert.equal(ctx.issueNumber, 42);
  assert.equal(ctx.tenant, 'foo/bar');
  assert.equal(ctx.actor, 'alice');
  assert.equal(ctx.association, 'OWNER');
  assert.equal(ctx.isTrustedActor, true);
});
await test('ctxFromGithub: stranger is not trusted', () => {
  const ctx = ctxFromGithub('issue_comment', {
    action: 'created',
    repository: { full_name: 'foo/bar' },
    sender: { login: 'rando' },
    comment: { body: '/ai code', author_association: 'NONE' },
    issue: { number: 1, pull_request: null },
  });
  assert.equal(ctx.isTrustedActor, false);
});
await test('ctxFromGithub: PR synchronize fields', () => {
  const ctx = ctxFromGithub('pull_request', {
    action: 'synchronize',
    repository: { full_name: 'foo/bar' },
    sender: { login: 'alice' },
    pull_request: { number: 7, author_association: 'MEMBER' },
  });
  assert.equal(ctx.prNumber, 7);
  assert.equal(ctx.isTrustedActor, true);
});
await test('ctxFromGithub: deployment_status', () => {
  const ctx = ctxFromGithub('deployment_status', {
    action: 'created',
    repository: { full_name: 'foo/bar' },
    sender: { login: 'bot' },
    deployment: { environment: 'staging' },
    deployment_status: { state: 'success', target_url: 'https://preview.example/' },
  });
  assert.equal(ctx.state, 'success');
  assert.equal(ctx.environment, 'staging');
  assert.equal(ctx.deploymentUrl, 'https://preview.example/');
});

// ── Done ─────────────────────────────────────────────────────────
await Promise.resolve();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
