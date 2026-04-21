/**
 * Inbox worker. Polls pending messages per session and injects them
 * into the corresponding live agent via `sendMessage`. This is how
 * new webhooks "stream in" to an already-awake Claude Code — as if
 * a human typed them into the same interactive session.
 */
import {
  listSessions,
  markMessageDone,
  markMessageProcessing,
  nextPendingMessage,
} from '../db.js';
import { sendMessage } from '../docker/session-container.js';
import { registerTail, startTailLoop } from '../streams/agent-tailer.js';
import { stringToKey } from '../router/session-key.js';
import { log } from '../log.js';

let running = false;
let handle: NodeJS.Timeout | null = null;

export function startInboxWorker(intervalMs = 2000): void {
  if (handle) return;
  handle = setInterval(pump, intervalMs);
}

export function stopInboxWorker(): void {
  if (handle) {
    clearInterval(handle);
    handle = null;
  }
}

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (const s of listSessions()) {
      const msg = nextPendingMessage(s.key);
      if (!msg) continue;
      markMessageProcessing(msg.id);
      try {
        const keyObj = stringToKey(s.key);
        if (msg.stream_to) registerTail(keyObj, msg.stream_to);
        const r = await sendMessage(keyObj, msg.body);
        markMessageDone(msg.id, r.ok);
        if (!r.ok) log.warn({ s: s.key, r }, 'sendMessage failed');
      } catch (err) {
        log.error({ err, sessionKey: s.key }, 'inbox pump failed');
        markMessageDone(msg.id, false);
      }
    }
  } finally {
    running = false;
  }
  startTailLoop();
}
