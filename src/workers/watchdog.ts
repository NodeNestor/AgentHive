/**
 * Watchdog worker. The Stop-hook retrigger loop handles agents
 * that finish a turn cleanly but aren't done. This worker handles
 * the other failure mode — an agent *wedged* inside a tool call,
 * whose Stop event never fires so the retrigger never runs.
 *
 * Mechanism: poll each running session's tmux pane tail, hash the
 * last 2KB, and track how long it's been unchanged. Past
 * `WATCHDOG_STUCK_SECONDS`, escalate:
 *
 *   Poke 1 → polite status-check message via the inbox
 *   Poke 2 → Ctrl-C into the tmux (aborts hung tool call) + message
 *   Poke 3 → ask the agent to emit <agenthive:blocked/> and stop
 *
 * Pokes are rate-limited so we don't hammer a recovering agent.
 * If pane content changes at any point, counters reset.
 */
import crypto from 'node:crypto';
import { config } from '../config.js';
import { log } from '../log.js';
import { listSessions, enqueue, type SessionRow } from '../db.js';
import { peekLogs, interruptTmux } from '../docker/control-api.js';

interface PokeState {
  lastHash: string;
  lastChangeAt: number;   // unix seconds
  pokeCount: number;
  lastPokeAt: number;
}

const state = new Map<string, PokeState>();
const MIN_POKE_INTERVAL = 120;    // seconds between pokes, regardless of stuck time

let handle: NodeJS.Timeout | null = null;

export function startWatchdog(): void {
  if (handle) return;
  handle = setInterval(tick, config.WATCHDOG_INTERVAL_SECONDS * 1000);
  log.info(
    {
      stuck: config.WATCHDOG_STUCK_SECONDS,
      maxPokes: config.WATCHDOG_MAX_POKES,
      interval: config.WATCHDOG_INTERVAL_SECONDS,
    },
    'watchdog started',
  );
}

export function stopWatchdog(): void {
  if (handle) {
    clearInterval(handle);
    handle = null;
  }
}

function hashOf(s: string): string {
  return crypto.createHash('sha1').update(s.slice(-2048)).digest('hex');
}

async function checkOne(s: SessionRow, now: number): Promise<void> {
  if (!s.container_id || s.status !== 'running') {
    // Not ours to worry about; drop any stale state.
    state.delete(s.key);
    return;
  }

  const tail = await peekLogs(s, 50);
  if (tail == null) {
    // Container not responding — might be crashed. Leave it to
    // Docker's restart policy + next webhook to recover.
    state.delete(s.key);
    return;
  }
  const hash = hashOf(tail);

  let st = state.get(s.key);
  if (!st) {
    st = { lastHash: hash, lastChangeAt: now, pokeCount: 0, lastPokeAt: 0 };
    state.set(s.key, st);
    return;
  }
  if (hash !== st.lastHash) {
    st.lastHash = hash;
    st.lastChangeAt = now;
    st.pokeCount = 0; // progress resets escalation
    return;
  }

  const stuckFor = now - st.lastChangeAt;
  if (stuckFor < config.WATCHDOG_STUCK_SECONDS) return;
  if (now - st.lastPokeAt < MIN_POKE_INTERVAL) return;

  st.pokeCount++;
  st.lastPokeAt = now;
  const stuckMin = Math.floor(stuckFor / 60);

  log.warn(
    { key: s.key, stuckFor, poke: st.pokeCount, max: config.WATCHDOG_MAX_POKES },
    'watchdog: session appears stuck',
  );

  if (st.pokeCount === 1) {
    enqueue({
      session_key: s.key,
      body:
        `[watchdog] No output for ${stuckMin} minutes. What are you ` +
        `working on? If a tool call is hung, explain; if you can't ` +
        `make progress, emit <agenthive:blocked reason="..."/> and stop.`,
      priority: 'urgent',
      source: 'watchdog',
    });
    return;
  }

  if (st.pokeCount <= config.WATCHDOG_MAX_POKES) {
    const interrupted = await interruptTmux(s);
    enqueue({
      session_key: s.key,
      body:
        `[watchdog] ${stuckMin} minutes without output; ` +
        (interrupted ? 'Ctrl-C sent into your tmux to abort the hung tool. ' : '') +
        `Status report and a decision, please (poke ${st.pokeCount}/${config.WATCHDOG_MAX_POKES}).`,
      priority: 'urgent',
      source: 'watchdog',
    });
    return;
  }

  // Escalation exhausted. Tell the agent to give up cleanly.
  log.error({ key: s.key, stuckFor }, 'watchdog: giving up, asking agent to mark blocked');
  enqueue({
    session_key: s.key,
    body:
      `[watchdog] ${config.WATCHDOG_MAX_POKES} pokes with no progress. ` +
      `Emit <agenthive:blocked reason="watchdog-escalated"/> and stop. ` +
      `A human will take it from here.`,
    priority: 'urgent',
    source: 'watchdog',
  });
  state.delete(s.key); // allow another round if the agent revives
}

async function tick(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  for (const s of listSessions()) {
    try {
      await checkOne(s, now);
    } catch (err) {
      log.error({ err, key: s.key }, 'watchdog tick failed');
    }
  }
}
