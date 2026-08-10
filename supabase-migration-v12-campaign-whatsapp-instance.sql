-- =============================================================
-- VYNTRA — Migration v12 (Campanha: WhatsApp de envio por campanha)
-- Projeto Supabase: nzexythhastovjwuedsh
-- Execute no: Dashboard -> SQL Editor -> New query -> Run
-- Idempotente: pode ser rodado múltiplas vezes.
-- =============================================================

-- Contexto: o painel agora suporta múltiplos WhatsApp conectados
-- (whatsapp_connections). Cada campanha pode escolher de QUAL número/instância
-- a sequência deve ser disparada. Sem o campo, o worker sempre envia pela
-- instância padrão (EVOLUTION_INSTANCE_NAME do backend).
--
-- A coluna guarda o instance_name da Evolution (ex.: "consecom-user-abc...").
-- NULL = usa a instância padrão do backend (comportamento atual).

ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS whatsapp_instance TEXT;

-- Notificação do PostgREST (garante coluna nova visível imediatamente)
NOTIFY pgrst, 'reload schema';

-- =============================================================
-- CONFIRMAÇÃO (rode após):
--   SELECT column_name FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='campaigns'
--     AND column_name = 'whatsapp_instance';
-- =============================================================