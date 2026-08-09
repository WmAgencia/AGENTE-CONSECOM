-- =============================================================
-- Consecom — Migração v8 (Vyntra Prospector — Prospecção Automática)
-- Cole no Supabase: Dashboard -> SQL Editor -> New query -> Run
-- Idempotente. Pode ser rodado múltiplas vezes.
-- =============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ===== 1) Colunas de origem + prospecção automática em leads =====
-- Permite que a extensão registre a origem (Google Maps / Vyntra Prospector),
-- presença digital (Instagram/Facebook encontrados no card do Maps), tags
-- automáticas, filtros usados na prospecção e metadados para campanhas.
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS source            TEXT,   -- ex: google_maps
  ADD COLUMN IF NOT EXISTS source_detail     TEXT,   -- ex: vyntra_prospector
  ADD COLUMN IF NOT EXISTS instagram         TEXT,   -- URL do Instagram (se encontrado)
  ADD COLUMN IF NOT EXISTS facebook          TEXT,   -- URL do Facebook (se encontrado)
  ADD COLUMN IF NOT EXISTS tags              TEXT[]  NOT NULL DEFAULT '{}', -- tags automáticas
  ADD COLUMN IF NOT EXISTS prospect_filters   JSONB,  -- filtros usados na prospecção (snapshot)
  ADD COLUMN IF NOT EXISTS prospected_at     TIMESTAMPTZ; -- data da prospecção automática

-- GIN index para consultas por tag (campanhas futuras, filtros no painel)
CREATE INDEX IF NOT EXISTS leads_tags_gin_idx        ON public.leads USING GIN (tags);
CREATE INDEX IF NOT EXISTS leads_source_idx          ON public.leads (source);
CREATE INDEX IF NOT EXISTS leads_source_detail_idx   ON public.leads (source_detail);

-- ===== 2) Garantir que leads importados pela extensão não precisem de login =====
-- A extensão usa apenas a chave anon (publishable). As políticas anon_insert e
-- anon_select já existem (ver supabase-schema.sql / supabase-migration-v5.sql).
-- Aqui apenas revalidamos que a política anon_insert cobre os novos campos:
-- RLS no Supabase é por-linha (não por-coluna), então nenhuma política extra é
-- necessária enquanto os novos campos aceitarem NULL/default.
-- (noop intencional)

-- ===== 3) Snapshot default para leads novos (tag inicial) =====
-- Garante que leads criados por outros fluxos não quebrem ao ler tags.
-- (já tem DEFAULT '{}' na definição da coluna; este bloco é seguro e idempotente)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'leads'
      AND column_name = 'tags' AND column_default IS NOT NULL
  ) THEN
    ALTER TABLE public.leads ALTER COLUMN tags SET DEFAULT '{}';
  END IF;
END $$;
