/**
 * PostgreSQL connection pool + idempotent schema migrations.
 *
 * Behavior:
 *  - Pool is lazily built on first use and shared across the process.
 *  - On boot, `ensureSchema()` is called once; it creates the tables
 *    if they don't exist (idempotent via CREATE TABLE IF NOT EXISTS).
 *  - All DB errors are caught and logged; the caller decides whether to
 *    fall back to in-memory.
 *
 * Safety:
 *  - The DATABASE_URL is read from env and only used to construct the
 *    pool. It is never logged (pino redaction in utils/logger.ts covers
 *    `DATABASE_URL` indirectly via paths).
 */
import pg, { type Pool, type PoolClient } from 'pg';
import { getDatabaseUrl, hasDatabase } from '../config/env.js';
import { getLogger } from '../utils/logger.js';

let pool: Pool | null = null;
let schemaReady = false;

export function getPool(): Pool {
  if (pool) return pool;
  if (!hasDatabase()) {
    throw new Error('DATABASE_URL not configured');
  }
  pool = new pg.Pool({
    connectionString: getDatabaseUrl(),
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 8000,
  });
  return pool;
}

export function isDbEnabled(): boolean {
  return hasDatabase();
}

/**
 * Runs migrations idempotently. Safe to call multiple times.
 * Returns true on success, false if the DB is not configured or fails.
 */
export async function ensureSchema(): Promise<boolean> {
  if (!hasDatabase()) return false;
  if (schemaReady) return true;
  const log = getLogger();

  let client: PoolClient | null = null;
  try {
    client = await getPool().connect();
    await client.query(SCHEMA_SQL);
    schemaReady = true;
    log.info('db: schema ready');
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown db error';
    log.error({ errMessage: message }, 'db: ensureSchema failed');
    return false;
  } finally {
    if (client) client.release();
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS conversations (
  id           TEXT PRIMARY KEY,
  source       TEXT NOT NULL DEFAULT 'http',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_turn_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS messages (
  id              BIGSERIAL PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user','assistant','tool')),
  content         TEXT NOT NULL,
  tool_name       TEXT,
  ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS messages_conversation_id_idx
  ON messages(conversation_id, id);

CREATE TABLE IF NOT EXISTS tool_runs (
  id              BIGSERIAL PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id      BIGINT REFERENCES messages(id) ON DELETE SET NULL,
  tool_name       TEXT NOT NULL,
  args            JSONB,
  result          TEXT,
  ok              BOOLEAN NOT NULL,
  latency_ms      INTEGER NOT NULL DEFAULT 0,
  ts              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tool_runs_conversation_id_idx
  ON tool_runs(conversation_id, ts);
`;
