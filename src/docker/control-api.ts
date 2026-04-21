/**
 * Thin helpers for AgentCore's control API that do NOT invoke
 * `ensureSession` (which would spawn a replacement if the
 * container is dead). Used by the watchdog — it doesn't want
 * auto-recovery side effects while probing for hangs.
 */
import { config } from '../config.js';
import { docker } from './docker-client.js';
import type { SessionRow } from '../db.js';

function ipOfRunningContainer(containerId: string): Promise<string | null> {
  return docker()
    .getContainer(containerId)
    .inspect()
    .then((info) => {
      if (!info.State.Running) return null;
      const net = info.NetworkSettings.Networks[config.DOCKER_NETWORK];
      return net?.IPAddress || info.Config.Hostname || null;
    })
    .catch(() => null);
}

/** Fetch the current pane tail — or null if container isn't running. */
export async function peekLogs(
  session: SessionRow,
  lines = 50,
): Promise<string | null> {
  if (!session.container_id) return null;
  const ip = await ipOfRunningContainer(session.container_id);
  if (!ip) return null;
  try {
    const r = await fetch(`http://${ip}:8080/logs?lines=${lines}`, {
      headers: { Authorization: `Bearer ${config.DISPATCH_TOKEN}` },
    });
    return r.ok ? await r.text() : null;
  } catch {
    return null;
  }
}

/** Send Ctrl-C to the agent's tmux pane. Returns ok/false. */
export async function interruptTmux(session: SessionRow): Promise<boolean> {
  if (!session.container_id) return false;
  const ip = await ipOfRunningContainer(session.container_id);
  if (!ip) return false;
  try {
    const r = await fetch(`http://${ip}:8080/exec`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.DISPATCH_TOKEN}`,
      },
      body: JSON.stringify({
        command: `su - agent -c "tmux send-keys -t agent:0 C-c"`,
        timeout: 5,
      }),
    });
    return r.ok;
  } catch {
    return false;
  }
}
