/**
 * Session container lifecycle. A session is a long-lived AgentCore
 * container keyed by `<tenant>/<workflow>/<scope>`.
 *
 * The container image is picked from the workflow's `image:` field
 * (`minimal` / `ubuntu` / `kali`). Hooks are *generated* per
 * workflow at spawn time from the YAML fields (`stop_when`,
 * `tools.block_bash`, `tools.block_edit`).
 *
 * Messages are injected via AgentCore's /exec → `tmux send-keys -t
 * agent:0`, so the agent sees each new event as a fresh human
 * message — "like a human typing to a reawakened Claude Code".
 */
import Docker from 'dockerode';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { log } from '../log.js';
import {
  getSession,
  listSessionsToReap,
  setSessionContainer,
  upsertSession,
  markSessionActive,
} from '../db.js';
import { getWorkflow, loadWorkflows } from '../workflows/loader.js';
import {
  buildPreBashHook,
  buildPreEditHook,
  buildStopHook,
  renderSystemPrompt,
} from '../workflows/render.js';
import type { Workflow } from '../workflows/schema.js';
import { keyToContainerName, keyToString, type SessionKey } from '../router/session-key.js';
import { docker, ensureNetwork } from './docker-client.js';
import { claudeCredentialsBind, detectClaudeAuth } from './auth-detect.js';

export interface EnsureResult {
  container: Docker.Container;
  stateDir: string;
  justSpawned: boolean;
  controlApiUrl: string;
}

const TMUX_TARGET = 'agent:0';

function hooksLibDir(): string {
  return process.env.HOOKS_LIB_DIR
    ? path.resolve(process.env.HOOKS_LIB_DIR)
    : fileURLToPath(new URL('../../hooks-lib', import.meta.url));
}

function imageFor(wf: Workflow): string {
  if (process.env.AGENTCORE_IMAGE_OVERRIDE) return process.env.AGENTCORE_IMAGE_OVERRIDE;
  return `${config.AGENTCORE_IMAGE}:${wf.image}`;
}

function ensureStateDir(key: SessionKey): { inRouter: string; onHost: string } {
  const tenantSafe = key.tenant.replace(/\//g, '__');
  const rel = path.join(tenantSafe, key.workflow, key.scope);
  const inRouter = path.join(config.SESSION_STATE_ROOT, rel);
  const hostRoot = process.env.HOST_SESSION_STATE_ROOT ?? config.SESSION_STATE_ROOT;
  const onHost = path.join(hostRoot, rel);

  fs.mkdirSync(path.join(inRouter, 'workspace'), { recursive: true });
  fs.mkdirSync(path.join(inRouter, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(inRouter, 'chrome-profile'), { recursive: true });
  fs.mkdirSync(path.join(inRouter, 'agent-memory'), { recursive: true });
  fs.mkdirSync(path.join(inRouter, 'hooks'), { recursive: true });
  return { inRouter, onHost };
}

async function writeScript(target: string, body: string): Promise<void> {
  await fsp.writeFile(target, body);
  await fsp.chmod(target, 0o755);
}

async function stageWorkflow(wf: Workflow, stateInRouter: string): Promise<void> {
  // Copy the shared hooks library.
  const libSrc = hooksLibDir();
  const libDst = path.join(stateInRouter, 'hooks-lib');
  fs.mkdirSync(libDst, { recursive: true });
  if (fs.existsSync(libSrc)) {
    for (const f of await fsp.readdir(libSrc)) {
      await fsp.copyFile(path.join(libSrc, f), path.join(libDst, f));
      await fsp.chmod(path.join(libDst, f), 0o755);
    }
  }

  // Generate per-workflow hook scripts.
  const hooksDir = path.join(stateInRouter, 'hooks');
  const settingsHooks: Record<string, unknown[]> = {
    PreToolUse: [],
    PostToolUse: [],
    Stop: [],
  };

  const preBash = buildPreBashHook(wf);
  if (preBash) {
    await writeScript(path.join(hooksDir, 'pre-bash.sh'), preBash);
    settingsHooks.PreToolUse!.push({
      matcher: 'Bash',
      hooks: [{ type: 'command', command: '/opt/agenthive/hooks/pre-bash.sh' }],
    });
  }

  const preEdit = buildPreEditHook(wf);
  if (preEdit) {
    await writeScript(path.join(hooksDir, 'pre-edit.sh'), preEdit);
    settingsHooks.PreToolUse!.push({
      matcher: 'Edit|Write|MultiEdit',
      hooks: [{ type: 'command', command: '/opt/agenthive/hooks/pre-edit.sh' }],
    });
  }

  await writeScript(path.join(hooksDir, 'stop.sh'), buildStopHook(wf));
  settingsHooks.Stop!.push({
    matcher: '',
    hooks: [{ type: 'command', command: '/opt/agenthive/hooks/stop.sh' }],
  });

  // Wire into Claude Code's settings.json.
  await fsp.writeFile(
    path.join(stateInRouter, '.claude', 'settings.json'),
    JSON.stringify({ hooks: settingsHooks }, null, 2),
  );

  // System prompt → CLAUDE.md in the workspace.
  await fsp.writeFile(
    path.join(stateInRouter, 'workspace', 'CLAUDE.md'),
    renderSystemPrompt(wf),
  );
}

export async function ensureSession(keyObj: SessionKey): Promise<EnsureResult> {
  const key = keyToString(keyObj);

  // Resolve the workflow fresh each spawn so edits to YAMLs in the
  // tenant repo take effect without restart.
  const wfs = await loadWorkflows(keyObj.tenant);
  const wf = wfs.find((w) => w.name === keyObj.workflow) ??
    (await getWorkflow(keyObj.tenant, keyObj.workflow));
  if (!wf) throw new Error(`unknown workflow: ${keyObj.workflow} for tenant ${keyObj.tenant}`);

  const existing = getSession(key);
  if (existing?.container_id) {
    try {
      const cont = docker().getContainer(existing.container_id);
      const info = await cont.inspect();
      if (info.State.Running) {
        markSessionActive(key);
        const net = info.NetworkSettings.Networks[config.DOCKER_NETWORK];
        const host = net?.IPAddress || info.Config.Hostname || keyToContainerName(keyObj);
        return {
          container: cont,
          stateDir: existing.state_dir,
          justSpawned: false,
          controlApiUrl: `http://${host}:8080`,
        };
      }
      await cont.remove({ force: true }).catch(() => undefined);
    } catch {
      /* fresh spawn below */
    }
  }

  await ensureNetwork(config.DOCKER_NETWORK);
  const { inRouter, onHost } = ensureStateDir(keyObj);
  await stageWorkflow(wf, inRouter);
  upsertSession({
    key,
    tenant: keyObj.tenant,
    role: keyObj.workflow,
    scope: keyObj.scope,
    state_dir: inRouter,
  });

  const auth = detectClaudeAuth();
  const credBind = claudeCredentialsBind(auth);
  if (!credBind && !config.ANTHROPIC_API_KEY) {
    log.warn({ key }, 'no Claude auth — agent will fail on first LLM call');
  }

  const binds: string[] = [
    `${path.join(onHost, 'workspace')}:/workspace/projects`,
    `${path.join(onHost, '.claude')}:/home/agent/.claude`,
    `${path.join(onHost, 'chrome-profile')}:/workspace/chrome-profile`,
    `${path.join(onHost, 'agent-memory')}:/agent-memory`,
    `${path.join(onHost, 'hooks')}:/opt/agenthive/hooks:ro`,
    `${path.join(onHost, 'hooks-lib')}:/opt/agenthive/hooks-lib:ro`,
  ];
  if (credBind) binds.push(`${credBind.source}:${credBind.target}:${credBind.mode}`);

  const envList: string[] = [
    `AGENT_TYPE=claude`,
    `AGENT_ID=${keyToContainerName(keyObj)}`,
    `AGENT_WORKFLOW=${keyObj.workflow}`,
    `AGENT_TENANT=${keyObj.tenant}`,
    `AGENT_SCOPE=${keyObj.scope}`,
    `AGENT_SESSION_KEY=${key}`,
    `AGENT_HIVE_URL=${config.PUBLIC_URL}`,
    `AGENT_HIVE_TOKEN=${config.DISPATCH_TOKEN}`,
    `CLAUDE_MODEL=${wf.model}`,
    `ENABLE_DESKTOP=${wf.requires_desktop ? 'true' : 'false'}`,
    `ENABLE_API=true`,
    `API_AUTH_TOKEN=${config.DISPATCH_TOKEN}`,
    `RETRIGGERS_PER_HOUR_LIMIT=${config.RETRIGGERS_PER_HOUR_LIMIT}`,
    `MAX_ATTEMPTS_PER_SCOPE=${wf.budget.max_attempts_per_scope ?? config.DEFAULT_MAX_ATTEMPTS_PER_ISSUE}`,
  ];
  if (config.ANTHROPIC_API_KEY) envList.push(`ANTHROPIC_API_KEY=${config.ANTHROPIC_API_KEY}`);

  const containerName = keyToContainerName(keyObj);
  try {
    await docker().getContainer(containerName).remove({ force: true });
  } catch {
    /* no such container */
  }

  const image = imageFor(wf);
  log.info({ key, workflow: wf.name, image }, 'spawning session container');

  const container = await docker().createContainer({
    Image: image,
    name: containerName,
    Hostname: containerName.slice(0, 63),
    Env: envList,
    Labels: {
      'agenthive.session': key,
      'agenthive.tenant': keyObj.tenant,
      'agenthive.workflow': keyObj.workflow,
      'agenthive.scope': keyObj.scope,
    },
    HostConfig: {
      Binds: binds,
      NetworkMode: config.DOCKER_NETWORK,
      RestartPolicy: { Name: 'unless-stopped' },
      Memory: config.SESSION_MEMORY_MB * 1024 * 1024,
      NanoCpus: Math.round(config.SESSION_CPU_CORES * 1e9),
      ExtraHosts: ['host.docker.internal:host-gateway'],
    },
    ExposedPorts: { '8080/tcp': {}, '22/tcp': {}, '6080/tcp': {} },
  });

  await container.start();
  setSessionContainer(key, container.id);

  const info = await container.inspect();
  const ip = info.NetworkSettings.Networks[config.DOCKER_NETWORK]?.IPAddress ?? containerName;
  return { container, stateDir: inRouter, justSpawned: true, controlApiUrl: `http://${ip}:8080` };
}

/** Inject a message into the running session's tmux. */
export async function sendMessage(
  keyObj: SessionKey,
  body: string,
): Promise<{ ok: boolean; status: number; text: string }> {
  const ensure = await ensureSession(keyObj);
  if (ensure.justSpawned) {
    await waitForHealth(ensure.controlApiUrl, 45_000).catch(() => undefined);
  }

  const esc = body.replace(/'/g, "'\\''");
  const cmd =
    `su - agent -c "tmux send-keys -t ${TMUX_TARGET} '${esc}' && ` +
    `tmux send-keys -t ${TMUX_TARGET} Enter"`;

  const resp = await fetch(`${ensure.controlApiUrl}/exec`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.DISPATCH_TOKEN}`,
    },
    body: JSON.stringify({ command: cmd, timeout: 10 }),
  });
  const text = await resp.text();
  markSessionActive(keyToString(keyObj));
  return { ok: resp.ok, status: resp.status, text };
}

export async function getLogs(keyObj: SessionKey, lines = 200): Promise<string> {
  const ensure = await ensureSession(keyObj);
  const resp = await fetch(`${ensure.controlApiUrl}/logs?lines=${lines}`, {
    headers: { Authorization: `Bearer ${config.DISPATCH_TOKEN}` },
  });
  return await resp.text();
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`session control API at ${url} did not become healthy`);
}

export async function reapIdleSessions(): Promise<number> {
  let reaped = 0;
  for (const s of listSessionsToReap(config.DEFAULT_IDLE_TIMEOUT_SECONDS)) {
    if (!s.container_id) continue;
    try {
      const c = docker().getContainer(s.container_id);
      await c.stop({ t: 10 }).catch(() => undefined);
      await c.remove({ force: true }).catch(() => undefined);
      setSessionContainer(s.key, null);
      reaped++;
      log.info({ key: s.key }, 'reaped idle session');
    } catch (err) {
      log.warn({ err, key: s.key }, 'failed to reap session');
    }
  }
  return reaped;
}

export async function resetSession(keyObj: SessionKey): Promise<void> {
  const key = keyToString(keyObj);
  const s = getSession(key);
  if (s?.container_id) {
    try {
      await docker().getContainer(s.container_id).remove({ force: true });
    } catch {
      /* gone */
    }
  }
  setSessionContainer(key, null);
  if (s?.state_dir && fs.existsSync(s.state_dir)) {
    await fsp.rm(s.state_dir, { recursive: true, force: true });
  }
}
