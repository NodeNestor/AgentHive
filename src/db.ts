/**
 * SQLite storage via sql.js (pure WASM — no native build step).
 * Matches the CrewNest pattern. The entire DB is held in memory and
 * flushed to disk on every mutation. This is fine for our scale
 * (queue + session metadata = thousands of rows, not millions).
 *
 * Tables:
 *   sessions       — one row per tenant/role/scope
 *   inbox          — queued messages per session
 *   comment_stream — stream target → GitHub comment id
 *   budgets        — per-scope attempts / tokens / spend
 *   retriggers     — rate-limit window
 *   config_cache   — .agents/config.yml per repo
 */
import fs from 'node:fs';
import path from 'node:path';
import initSqlJs, { type Database, type SqlJsStatic, type BindParams } from 'sql.js';
import { config } from './config.js';
import { log } from './log.js';

fs.mkdirSync(path.dirname(config.DB_PATH), { recursive: true });

let SQL: SqlJsStatic;
let _db: Database;
let flushPending = false;

async function init(): Promise<void> {
  SQL = await initSqlJs({});
  if (fs.existsSync(config.DB_PATH)) {
    const buf = fs.readFileSync(config.DB_PATH);
    _db = new SQL.Database(new Uint8Array(buf));
  } else {
    _db = new SQL.Database();
  }
  _db.run(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS sessions (
      key           TEXT PRIMARY KEY,
      tenant        TEXT NOT NULL,
      role          TEXT NOT NULL,
      scope         TEXT NOT NULL,
      state_dir     TEXT NOT NULL,
      container_id  TEXT,
      status        TEXT NOT NULL DEFAULT 'idle',
      last_activity INTEGER NOT NULL,
      created_at    INTEGER NOT NULL,
      meta_json     TEXT
    );
    CREATE INDEX IF NOT EXISTS sessions_last_activity_idx ON sessions(last_activity);
    CREATE INDEX IF NOT EXISTS sessions_tenant_idx ON sessions(tenant);

    CREATE TABLE IF NOT EXISTS inbox (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key  TEXT NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
      body         TEXT NOT NULL,
      priority     TEXT NOT NULL DEFAULT 'normal',
      status       TEXT NOT NULL DEFAULT 'pending',
      stream_to    TEXT,
      source       TEXT,
      created_at   INTEGER NOT NULL,
      started_at   INTEGER,
      finished_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS inbox_session_status_idx ON inbox(session_key, status);

    CREATE TABLE IF NOT EXISTS comment_stream (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant       TEXT NOT NULL,
      stream_to    TEXT NOT NULL,
      comment_id   INTEGER,
      body         TEXT,
      updated_at   INTEGER NOT NULL,
      UNIQUE(tenant, stream_to)
    );

    CREATE TABLE IF NOT EXISTS budgets (
      scope_key    TEXT PRIMARY KEY,
      attempts     INTEGER NOT NULL DEFAULT 0,
      tokens       INTEGER NOT NULL DEFAULT 0,
      usd_cents    INTEGER NOT NULL DEFAULT 0,
      updated_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS retriggers (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key  TEXT NOT NULL,
      ts           INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS retriggers_session_ts_idx ON retriggers(session_key, ts);

  `);
  flush();
}

// Debounced flush — coalesces bursts of writes into a single fs write.
function scheduleFlush(): void {
  if (flushPending) return;
  flushPending = true;
  setTimeout(() => {
    try {
      flush();
    } catch (err) {
      log.error({ err }, 'db flush failed');
    } finally {
      flushPending = false;
    }
  }, 50);
}

function flush(): void {
  const buf = _db.export();
  const tmp = `${config.DB_PATH}.tmp`;
  fs.writeFileSync(tmp, Buffer.from(buf));
  fs.renameSync(tmp, config.DB_PATH);
}

// Await init at module load.
await init();

// ── Helpers ───────────────────────────────────────────────────────

function run(sql: string, params: BindParams = []): void {
  _db.run(sql, params);
  scheduleFlush();
}

function all<T = Record<string, unknown>>(sql: string, params: BindParams = []): T[] {
  const stmt = _db.prepare(sql);
  stmt.bind(params);
  const rows: T[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject() as unknown as T);
  stmt.free();
  return rows;
}

function get<T = Record<string, unknown>>(sql: string, params: BindParams = []): T | undefined {
  return all<T>(sql, params)[0];
}

export const rawDb = () => _db;

// ── Types ─────────────────────────────────────────────────────────

export interface SessionRow {
  key: string;
  tenant: string;
  role: string;
  scope: string;
  state_dir: string;
  container_id: string | null;
  status: 'idle' | 'running' | 'reaped';
  last_activity: number;
  created_at: number;
  meta_json: string | null;
}

export interface InboxMessage {
  id: number;
  session_key: string;
  body: string;
  priority: 'urgent' | 'normal' | 'low';
  status: 'pending' | 'processing' | 'done' | 'failed';
  stream_to: string | null;
  source: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

// ── Sessions ──────────────────────────────────────────────────────

export function upsertSession(params: {
  key: string;
  tenant: string;
  role: string;
  scope: string;
  state_dir: string;
}): void {
  const now = Math.floor(Date.now() / 1000);
  run(
    `INSERT INTO sessions (key, tenant, role, scope, state_dir, last_activity, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET last_activity = excluded.last_activity`,
    [params.key, params.tenant, params.role, params.scope, params.state_dir, now, now],
  );
}

export function getSession(key: string): SessionRow | undefined {
  return get<SessionRow>('SELECT * FROM sessions WHERE key = ?', [key]);
}

export function setSessionContainer(key: string, containerId: string | null): void {
  run(
    'UPDATE sessions SET container_id = ?, status = ?, last_activity = ? WHERE key = ?',
    [containerId, containerId ? 'running' : 'idle', Math.floor(Date.now() / 1000), key],
  );
}

export function markSessionActive(key: string): void {
  run('UPDATE sessions SET last_activity = ? WHERE key = ?', [
    Math.floor(Date.now() / 1000),
    key,
  ]);
}

export function listSessions(): SessionRow[] {
  return all<SessionRow>('SELECT * FROM sessions ORDER BY last_activity DESC');
}

export function listSessionsToReap(maxIdleSeconds: number): SessionRow[] {
  const cutoff = Math.floor(Date.now() / 1000) - maxIdleSeconds;
  return all<SessionRow>(
    "SELECT * FROM sessions WHERE status = 'running' AND last_activity < ?",
    [cutoff],
  );
}

// ── Inbox ─────────────────────────────────────────────────────────

export function enqueue(params: {
  session_key: string;
  body: string;
  priority?: 'urgent' | 'normal' | 'low';
  stream_to?: string | null;
  source?: string;
}): number {
  run(
    `INSERT INTO inbox (session_key, body, priority, stream_to, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      params.session_key,
      params.body,
      params.priority ?? 'normal',
      params.stream_to ?? null,
      params.source ?? 'dispatch',
      Math.floor(Date.now() / 1000),
    ],
  );
  const row = get<{ id: number }>('SELECT last_insert_rowid() AS id');
  return row?.id ?? 0;
}

export function nextPendingMessage(sessionKey: string): InboxMessage | undefined {
  return get<InboxMessage>(
    `SELECT * FROM inbox
     WHERE session_key = ? AND status = 'pending'
     ORDER BY
       CASE priority WHEN 'urgent' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
       id ASC
     LIMIT 1`,
    [sessionKey],
  );
}

export function markMessageProcessing(id: number): void {
  run(`UPDATE inbox SET status = 'processing', started_at = ? WHERE id = ?`, [
    Math.floor(Date.now() / 1000),
    id,
  ]);
}

export function markMessageDone(id: number, ok: boolean): void {
  run(`UPDATE inbox SET status = ?, finished_at = ? WHERE id = ?`, [
    ok ? 'done' : 'failed',
    Math.floor(Date.now() / 1000),
    id,
  ]);
}

// ── Comment stream ────────────────────────────────────────────────

export function getStreamComment(
  tenant: string,
  streamTo: string,
): { comment_id: number | null; body: string | null } | undefined {
  return get(
    `SELECT comment_id, body FROM comment_stream WHERE tenant = ? AND stream_to = ?`,
    [tenant, streamTo],
  );
}

export function setStreamComment(
  tenant: string,
  streamTo: string,
  commentId: number | null,
  body: string,
): void {
  run(
    `INSERT INTO comment_stream (tenant, stream_to, comment_id, body, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(tenant, stream_to) DO UPDATE SET
       comment_id = excluded.comment_id,
       body = excluded.body,
       updated_at = excluded.updated_at`,
    [tenant, streamTo, commentId, body, Math.floor(Date.now() / 1000)],
  );
}

// ── Budgets ───────────────────────────────────────────────────────

export function bumpBudget(
  scopeKey: string,
  delta: { attempts?: number; tokens?: number; usd_cents?: number },
): void {
  run(
    `INSERT INTO budgets (scope_key, attempts, tokens, usd_cents, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(scope_key) DO UPDATE SET
       attempts   = attempts   + excluded.attempts,
       tokens     = tokens     + excluded.tokens,
       usd_cents  = usd_cents  + excluded.usd_cents,
       updated_at = excluded.updated_at`,
    [
      scopeKey,
      delta.attempts ?? 0,
      delta.tokens ?? 0,
      delta.usd_cents ?? 0,
      Math.floor(Date.now() / 1000),
    ],
  );
}

export function getBudget(
  scopeKey: string,
): { attempts: number; tokens: number; usd_cents: number } {
  return (
    get<{ attempts: number; tokens: number; usd_cents: number }>(
      `SELECT attempts, tokens, usd_cents FROM budgets WHERE scope_key = ?`,
      [scopeKey],
    ) ?? { attempts: 0, tokens: 0, usd_cents: 0 }
  );
}

// ── Retrigger rate ────────────────────────────────────────────────

export function logRetrigger(sessionKey: string): void {
  run(`INSERT INTO retriggers (session_key, ts) VALUES (?, ?)`, [
    sessionKey,
    Math.floor(Date.now() / 1000),
  ]);
}

export function countRetriggersInWindow(sessionKey: string, windowSeconds: number): number {
  const cutoff = Math.floor(Date.now() / 1000) - windowSeconds;
  const row = get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM retriggers WHERE session_key = ? AND ts > ?`,
    [sessionKey, cutoff],
  );
  return row?.c ?? 0;
}

