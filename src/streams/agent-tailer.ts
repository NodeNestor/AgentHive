/**
 * Agent output tailer. Polls AgentCore `/logs` for each running
 * session, diffs against the last snapshot, and:
 *
 *   1. Streams new output into the GitHub comment-updater.
 *   2. Watches for signal tags the agent can emit:
 *        <agenthive:continue/>           — self-retrigger
 *        <agenthive:handoff workflow="tester" scope="pr-87"/>
 *                                         — start another workflow
 *        <agenthive:done/>                — touch activity
 *        <agenthive:blocked reason="..."/>— log + notify
 */
import { getLogs } from '../docker/session-container.js';
import { log } from '../log.js';
import { enqueue, getSession, markSessionActive } from '../db.js';
import { keyToString, stringToKey, type SessionKey } from '../router/session-key.js';
import { updateStreamComment } from '../github/comment-stream.js';

interface TailState {
  lastSeen: string;
  streamTo: string | null;
}

const state = new Map<string, TailState>();

export function registerTail(keyObj: SessionKey, streamTo: string | null): void {
  state.set(keyToString(keyObj), { lastSeen: '', streamTo });
}

export function unregisterTail(keyObj: SessionKey): void {
  state.delete(keyToString(keyObj));
}

const TAG_RE = /<agenthive:(continue|handoff|done|blocked)(?:\s+([^/>]*))?\/>/g;

function parseTagAttrs(s: string | undefined): Record<string, string> {
  if (!s) return {};
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/(\w+)\s*=\s*"([^"]*)"/g)) {
    out[m[1]!] = m[2]!;
  }
  return out;
}

async function handleTags(keyObj: SessionKey, newText: string): Promise<void> {
  for (const m of newText.matchAll(TAG_RE)) {
    const tag = m[1]!;
    const attrs = parseTagAttrs(m[2]);
    const sessionKey = keyToString(keyObj);
    log.info({ sessionKey, tag, attrs }, 'agent signal tag');

    switch (tag) {
      case 'continue':
        enqueue({
          session_key: sessionKey,
          body: 'Continue. The Stop hook will tell you what remains.',
          source: 'self-signal',
        });
        break;
      case 'handoff': {
        const target = attrs['workflow'] ?? attrs['role']; // tolerate old tag name
        const scope = attrs['scope'] ?? keyObj.scope;
        if (!target) break;
        const tk: SessionKey = { tenant: keyObj.tenant, workflow: target, scope };
        enqueue({
          session_key: keyToString(tk),
          body:
            attrs['message'] ??
            `Handoff from ${keyObj.workflow}/${keyObj.scope}. Check labels and proceed.`,
          source: 'handoff',
        });
        break;
      }
      case 'done':
        markSessionActive(sessionKey);
        break;
      case 'blocked':
        log.warn({ sessionKey, reason: attrs['reason'] }, 'agent declared blocked');
        break;
    }
  }
}

async function pollOne(keyObj: SessionKey, st: TailState): Promise<void> {
  let raw: string;
  try {
    raw = await getLogs(keyObj, 200);
  } catch (err) {
    log.debug({ err, key: keyToString(keyObj) }, 'tail poll failed');
    return;
  }
  let delta = raw;
  if (st.lastSeen && raw.includes(st.lastSeen)) {
    delta = raw.slice(raw.indexOf(st.lastSeen) + st.lastSeen.length);
  } else if (st.lastSeen) {
    delta = raw.slice(Math.floor(raw.length / 2));
  }
  st.lastSeen = raw;
  if (!delta.trim()) return;

  await handleTags(keyObj, delta);

  if (st.streamTo) {
    updateStreamComment(keyObj.tenant, st.streamTo, raw).catch((err) =>
      log.warn({ err }, 'comment-stream update failed'),
    );
  }
}

let loopHandle: NodeJS.Timeout | null = null;

export function startTailLoop(intervalMs = 5000): void {
  if (loopHandle) return;
  loopHandle = setInterval(async () => {
    for (const [sessionKey, st] of state) {
      const row = getSession(sessionKey);
      if (!row?.container_id || row.status !== 'running') continue;
      await pollOne(stringToKey(sessionKey), st);
    }
  }, intervalMs);
}

export function stopTailLoop(): void {
  if (loopHandle) {
    clearInterval(loopHandle);
    loopHandle = null;
  }
}
