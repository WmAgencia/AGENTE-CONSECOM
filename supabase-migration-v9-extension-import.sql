-- =============================================================
-- VYNTRA — Migration v9 (CORREÇÃO DEFINITIVA DA IMPORTAÇÃO DA EXTENSÃO)
-- Projeto Supabase: nzexythhastovjwuedsh
-- Execute no: Dashboard -> SQL Editor -> New query -> Run
-- Idempotente: pode ser rodado múltiplas vezes.
-- =============================================================

-- 1) COLUNAS V8 (conteúdo do prospector) — se fizerem parte do modelo
--    VYNTRA:
--    - source:        origem do lead (ex: google_maps)
--    - source_detail: sub-origem (ex: vyntra_prospector)
--    - instagram:     URL da presença no Instagram (heurística do card Maps)
--    - facebook:      URL da presença no Facebook (heurística do card Maps)
--    - tags:          tags automáticas (['Google Maps', 'Sem Site', ...])
--    - prospect_filters: snapshot dos filtros usados na prospecção
--    - prospected_at: data/hora da prospecção automática
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS source            TEXT,
  ADD COLUMN IF NOT EXISTS source_detail     TEXT,
  ADD COLUMN IF NOT EXISTS instagram         TEXT,
  ADD COLUMN IF NOT EXISTS facebook          TEXT,
  ADD COLUMN IF NOT EXISTS tags              TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS prospect_filters  JSONB,
  ADD COLUMN IF NOT EXISTS prospected_at     TIMESTAMPTZ;

-- 2) COLUNAS V6 (score / interest) — usadas pelo Vyntra Score
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS strategy_id        UUID REFERENCES public.strategies(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS score              INTEGER,
  ADD COLUMN IF NOT EXISTS score_factors      JSONB,
  ADD COLUMN IF NOT EXISTS interest_level     TEXT,
  ADD COLUMN IF NOT EXISTS service_interest   TEXT,
  ADD COLUMN IF NOT EXISTS has_website        BOOLEAN,
  ADD COLUMN IF NOT EXISTS has_system         BOOLEAN,
  ADD COLUMN IF NOT EXISTS problem_identified BOOLEAN,
  ADD COLUMN IF NOT EXISTS problem_description TEXT,
  ADD COLUMN IF NOT EXISTS objection          TEXT,
  ADD COLUMN IF NOT EXISTS meeting_outcome    TEXT,
  ADD COLUMN IF NOT EXISTS sale_status        TEXT,
  ADD COLUMN IF NOT EXISTS loss_reason        TEXT;

-- 3) ÍNDICES das novas colunas
CREATE INDEX IF NOT EXISTS leads_tags_gin_idx         ON public.leads USING GIN (tags);
CREATE INDEX IF NOT EXISTS leads_source_idx           ON public.leads (source);
CREATE INDEX IF NOT EXISTS leads_source_detail_idx    ON public.leads (source_detail);
CREATE INDEX IF NOT EXISTS leads_strategy_idx         ON public.leads (strategy_id);
CREATE INDEX IF NOT EXISTS leads_score_idx            ON public.leads (score);
CREATE INDEX IF NOT EXISTS leads_service_interest_idx ON public.leads (service_interest);

-- 4) capture_sessions.user_id + policies (extensão cria sessão com anon)
ALTER TABLE public.capture_sessions ADD COLUMN IF NOT EXISTS user_id TEXT;
CREATE INDEX IF NOT EXISTS capture_sessions_user_idx ON public.capture_sessions (user_id);
ALTER TABLE public.capture_sessions ENABLE ROW LEVEL SECURITY;

-- INSERT para anon (extensão Chrome usa apenas a chave anon/publishable).
-- Sem exigir auth.uid() mesmo: a extensão não tem sessão de usuário — apenas a
-- chave publishable. A sessão resultante fica marcada imported_by='extension'.
-- READ/UPDATE/DELETE continuam restritos ao papel authenticated.
DROP POLICY IF EXISTS capture_sessions_anon_insert ON public.capture_sessions;
CREATE POLICY capture_sessions_anon_insert
  ON public.capture_sessions FOR INSERT TO anon
  WITH CHECK (true);

DROP POLICY IF EXISTS capture_sessions_auth_read ON public.capture_sessions;
DROP POLICY IF EXISTS capture_sessions_auth_insert ON public.capture_sessions;
DROP POLICY IF EXISTS capture_sessions_auth_update ON public.capture_sessions;
DROP POLICY IF EXISTS capture_sessions_auth_delete ON public.capture_sessions;
CREATE POLICY capture_sessions_auth_read   ON public.capture_sessions FOR SELECT TO authenticated USING (true);
CREATE POLICY capture_sessions_auth_insert ON public.capture_sessions FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY capture_sessions_auth_update ON public.capture_sessions FOR UPDATE TO authenticated USING (true);
CREATE POLICY capture_sessions_auth_delete ON public.capture_sessions FOR DELETE TO authenticated USING (true);

-- 5) Garantir que leads.place_id tem UNIQUE (necessary p/ on_conflict upsert)
-- Se já existir, é noop. Se NÃO existir, cria.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.leads'::regclass
      AND contype = 'u'
      AND conname = 'leads_place_id_key'
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS leads_place_id_key ON public.leads (place_id);
    ALTER TABLE public.leads ADD CONSTRAINT leads_place_id_key UNIQUE USING INDEX leads_place_id_key;
  END IF;
END $$;

-- 6) Atualiza schema cache PostgREST (garante que o REST veja as colunas novas)
NOTIFY pgrst, 'reload schema';

-- =============================================================
-- CONFIRMAÇÃO (rode após): a query abaixo deve listar as colunas novas.
--   SELECT column_name FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='leads'
--     AND column_name IN ('source','instagram','facebook','tags','has_website')
-- =============================================================