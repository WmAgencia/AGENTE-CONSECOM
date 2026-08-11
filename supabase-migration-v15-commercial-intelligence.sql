-- ===== Migration v15 — Inteligência Comercial (Metas + Faturamento) =====
-- Objetivo: registrar o valor de cada venda fechada e persistir a meta
-- comercial configurada no dashboard, com isolamento por user/workspace.
--
-- Alterações:
--   1. leads.sale_value        -> valor da venda fechada (numeric)
--   2. consecom_fechar_lead    -> aceita p_valor e grava sale_value/sale_status
--   3. commercial_goals        -> meta persistida (faturamento, período, ticket,
--                                 conversão reunião->venda, leads/dia opcional)
--
-- RLS: tabela comercial_goals restrita a `authenticated` com
-- user_id = auth.uid()::text (mesmo padrão de ai_memory_*).
-- Backend grava/ler com service role.
--
-- Idempotente: pode ser aplicado mais de uma vez sem erro.

-- ===== 1) sale_value em leads =====
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS sale_value NUMERIC(14, 2);
CREATE INDEX IF NOT EXISTS leads_sale_value_idx ON public.leads (status, sale_value);

-- ===== 2) consecom_fechar_lead com p_valor =====
-- Mantém a assinatura anterior (UUID, BOOLEAN, TEXT) compatível por
-- sobrecarga: o parâmetro novo (p_valor) tem DEFAULT NULL, então chamadas
-- antigas continuam funcionando. Quando p_fechado=true e p_valor é passado,
-- grava sale_value e sale_status='venda'; senão zera o valor.
CREATE OR REPLACE FUNCTION public.consecom_fechar_lead(
  p_lead_id UUID,
  p_fechado BOOLEAN DEFAULT true,
  p_motivo TEXT DEFAULT NULL,
  p_valor NUMERIC DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_novo_status TEXT;
BEGIN
  v_novo_status := CASE WHEN p_fechado THEN 'fechado' ELSE 'nao_fechado' END;

  UPDATE public.leads
  SET status = v_novo_status,
      closed_reason = p_motivo,
      closed_at = now(),
      sale_value = CASE WHEN p_fechado AND p_valor IS NOT NULL THEN p_valor ELSE NULL END,
      sale_status = CASE WHEN p_fechado AND p_valor IS NOT NULL THEN 'venda'
                         WHEN p_fechado THEN 'nao_vendeu'
                         ELSE NULL END,
      updated_at = now()
  WHERE id = p_lead_id;

  INSERT INTO public.lead_status_history (lead_id, status, notes)
  VALUES (p_lead_id, v_novo_status, p_motivo);

  RETURN jsonb_build_object('ok', true, 'lead_id', p_lead_id,
    'status', v_novo_status, 'sale_value', p_valor);
END;
$$;

GRANT EXECUTE ON FUNCTION public.consecom_fechar_lead(UUID, BOOLEAN, TEXT, NUMERIC) TO service_role;
GRANT EXECUTE ON FUNCTION public.consecom_fechar_lead(UUID, BOOLEAN, TEXT, NUMERIC) TO authenticated;

-- ===== 3) commercial_goals =====
CREATE TABLE IF NOT EXISTS public.commercial_goals (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            TEXT NOT NULL,
  workspace_id       TEXT,
  goal_amount        NUMERIC(14, 2) NOT NULL,   -- meta de faturamento (R$)
  period_days        INTEGER NOT NULL DEFAULT 30 CHECK (period_days IN (30, 60, 90)),
  avg_ticket         NUMERIC(14, 2) NOT NULL,   -- ticket médio (R$)
  meeting_close_rate NUMERIC(5, 2) NOT NULL DEFAULT 50, -- % reunião -> venda
  leads_per_day      NUMERIC(8, 2),             -- opcional
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS commercial_goals_user_idx ON public.commercial_goals (user_id);

DROP TRIGGER IF EXISTS commercial_goals_updated_at ON public.commercial_goals;
CREATE TRIGGER commercial_goals_updated_at BEFORE UPDATE ON public.commercial_goals
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ===== 4) RLS =====
ALTER TABLE public.commercial_goals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS commercial_goals_auth_all ON public.commercial_goals;

CREATE POLICY commercial_goals_auth_all ON public.commercial_goals
  FOR ALL USING (auth.role() = 'authenticated' AND user_id = auth.uid()::text)
  WITH CHECK (auth.role() = 'authenticated' AND user_id = auth.uid()::text);

-- ===== 5) Realtime (dashboard reage à meta salva) =====
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'supabase_realtime'
                   AND schemaname = 'public'
                   AND tablename = 'commercial_goals') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.commercial_goals;
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.commercial_goals TO authenticated;

NOTIFY pgrst, 'reload schema';
