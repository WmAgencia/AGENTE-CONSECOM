-- ===== Migration v17 — Backfill: "Limpar lista" + auditoria de leads =====
-- Projeto Supabase: nzexythhastovjwuedsh
-- Execute no: Dashboard -> SQL Editor -> New query -> Run
-- Idempotente: pode ser rodado mais de uma vez sem erro.
--
-- POR QUE: a feature "Limpar lista" em /leads (marketing central: botão que
-- devolvia 502 "clear_failed") depende de duas coisas que NUNCA foram criadas
-- no banco de produção:
--   1) coluna leads.is_active_in_prospecting  -> sem ela, o PATCH do backend
--      falha com 42703 (coluna inexistente) e a rota responde 502.
--   2) tabela consecom_audit_log              -> auditoria das ações de
--      limpeza/exclusão usa essa tabela (best-effort).
-- Sem a coluna, a lista /leads também não esconde os leads limpos (o
-- frontend filtra por is_active_in_prospecting).
--
-- Conteúdo extraído de supabase-CONSOLIDADO.sql (migration v11) + aponta o
-- PostgREST a recarregar o schema cache.

-- ===== 1) leads.is_active_in_prospecting (soft clear) =====
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS is_active_in_prospecting BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS leads_active_prospecting_idx
  ON public.leads (is_active_in_prospecting);

-- ===== 2) consecom_audit_log (auditoria de limpeza/exclusão) =====
CREATE TABLE IF NOT EXISTS public.consecom_audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_ids  JSONB,
  details     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS consecom_audit_log_created_idx
  ON public.consecom_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS consecom_audit_log_action_idx
  ON public.consecom_audit_log (action);

ALTER TABLE public.consecom_audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS consecom_audit_log_auth_read ON public.consecom_audit_log;
CREATE POLICY consecom_audit_log_auth_read ON public.consecom_audit_log
  FOR SELECT USING (auth.role() = 'authenticated');

-- ===== 3) Recarrega o schema cache do PostgREST =====
NOTIFY pgrst, 'reload schema';

-- =============================================================
-- CONFIRMAÇÃO (rode depois):
--   SELECT column_name FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='leads'
--     AND column_name='is_active_in_prospecting';
--   SELECT to_regclass('public.consecom_audit_log');
-- =============================================================