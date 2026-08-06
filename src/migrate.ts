/**
 * Idempotent Supabase schema for Consecom (Module 2).
 *
 * Run:  npx tsx src/migrate.ts
 *
 * Creates:
 *   - leads: companies captured from Google Maps (extension import)
 *   - lead_status_history: kanban movement timeline
 *   - messages: the message queue (multi-step sequence per campaign)
 *   - queues: a prospection campaign holding ordered messages
 *   - queue_runs: per-lead-per-queue scheduling state
 *
 * Safe to run multiple times (IF NOT EXISTS).
 */
import { Client } from 'pg';
import { loadDotenvLocalIfPresent } from './test/load.env.js';

loadDotenvLocalIfPresent();

const SCHEMA_SQL = `
-- === Leads (empresas capturadas) ===
CREATE TABLE IF NOT EXISTS leads (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT,
  phone             TEXT,
  category          TEXT,
  website           TEXT,
  address           TEXT,
  city              TEXT,
  state             TEXT,
  zip_code          TEXT,
  rating            NUMERIC(2,1),
  reviews           INTEGER,
  latitude          DOUBLE PRECISION,
  longitude         DOUBLE PRECISION,
  place_id          TEXT UNIQUE,
  niche             TEXT,                 -- nicho pesquisado na extensão
  status            TEXT NOT NULL DEFAULT 'novo'
                    CHECK (status IN ('novo','na_fila','mensagem_enviada','respondendo','reuniao_marcada','fechado','perdido')),
  last_message_sent TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS leads_phone_idx ON leads(phone);
CREATE INDEX IF NOT EXISTS leads_status_idx ON leads(status);
CREATE INDEX IF NOT EXISTS leads_placard_idx ON leads(placard);

-- -------- Histórico do kanban --------
CREATE TABLE IF NOT EXISTS lead_status_history (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id    UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  status     TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes      TEXT
);
CREATE INDEX IF NOT EXISTS lead_status_history_lead_idx ON lead_status_history(lead_id, changed_at);

-- -------- Fila de mensagens (sequência por campanha) --------
CREATE TABLE IF NOT EXISTS campaigns (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  description  TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS queue_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL DEFAULT 0,
  kind        TEXT NOT NULL DEFAULT 'text'
              CHECK (kind IN ('text','audio','video','image','document')),
  text        TEXT,
  media_url   TEXT,      -- URL do áudio/vídeo/imagem pré-gravado/importado
  media_caption TEXT,
  delay_seconds INTEGER NOT NULL DEFAULT 0,  -- intervalo após a mensagem anterior
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS queue_messages_campaign_idx ON queue_messages(campaign_id, position);

-- -------- Execução da fila por lead --------
CREATE TABLE IF NOT EXISTS send_runs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  lead_id     UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','running','done','failed')),
  current_position INTEGER NOT NULL DEFAULT 0,
  next_send_at TIMESTAMPTZ,
  last_sent_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, lead_id)
);
CREATE INDEX IF NOT EXISTS send_runs_lead_idx ON send_runs(lead_id);
`;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL not set. Aborting.');
    process.exit(1);
  }
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(SCHEMA_SQL);
    console.log('Schema Consecom aplicado com sucesso no Supabase.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Falha ao aplicar o schema:', msg);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

void main();