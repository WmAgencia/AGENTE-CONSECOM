-- =============================================================
-- Consecom — Migração v3 (fluxo completo de prospecção)
-- Cole no Supabase: Dashboard -> SQL Editor -> New query
-- Idempotente.
-- =============================================================

-- 1) Sessão de captura (uma por importação da extensão)
CREATE TABLE IF NOT EXISTS public.capture_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  imported_by TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.capture_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY capture_sessions_anon_insert ON public.capture_sessions
  FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY capture_sessions_auth_read ON public.capture_sessions
  FOR SELECT USING (auth.role() = 'authenticated');

-- 2) Colunas novas em leads
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS session_id      UUID REFERENCES public.capture_sessions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS campaign_id     UUID REFERENCES public.campaigns(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS no_interest_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_reason    TEXT,
  ADD COLUMN IF NOT EXISTS closed_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS remarket_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_msg_sent_at TIMESTAMPTZ;

-- status expandido: novos estados do funil
ALTER TABLE public.leads DROP CONSTRAINT IF EXISTS leads_status_check;
UPDATE public.leads SET status = 'nao_fechado' WHERE status = 'perdido';
ALTER TABLE public.leads ADD CONSTRAINT leads_status CHECK (
  status IN (
    'novo',            -- capturado, ainda não foi para campanha (Guia Leads)
    'na_fila',         -- associado a campanha, aguardando disparo
    'enviado',         -- mensagem inicial enviada, sem resposta ainda
    'conversando',     -- respondeu / IA conversando
    'sem_interesse',   -- disse não ter interesse (no_interest_until = +6 meses)
    'remarketing',     -- não respondeu; re-envio automático configurado
    'reuniao_marcada',
    'reuniao_cancelada',
    'fechado',         -- cliente fechado (finalizado)
    'nao_fechado'      -- não fechou (finalizado), com motivo
  )
);

CREATE INDEX IF NOT EXISTS leads_session_idx   ON public.leads (session_id);
CREATE INDEX IF NOT EXISTS leads_campaign_idx  ON public.leads (campaign_id);
CREATE INDEX IF NOT EXISTS leads_nointerest_idx ON public.leads (no_interest_until);

-- 3) Fila global de campanhas (uma dispara por vez)
ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS status  TEXT NOT NULL DEFAULT 'pronta'
    CHECK (status IN ('pronta','em_progresso','finalizada','cancelada')),
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lead_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS success_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fail_count INTEGER NOT NULL DEFAULT 0;

-- 4) Configuração do agente / remarketing (chave-valor)
CREATE TABLE IF NOT EXISTS public.agent_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.agent_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_settings_auth_all ON public.agent_settings
  FOR ALL USING (auth.role() = 'authenticated');

-- 5) RPC: associar leads a uma campanha (dois em um — novo ou existente)
CREATE OR REPLACE FUNCTION public.consecom_associar_campanha(
  p_lead_ids UUID[],
  p_campaign_id UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  UPDATE public.leads
  SET campaign_id = p_campaign_id,
      status = 'na_fila',
      updated_at = now()
  WHERE id = ANY (p_lead_ids) AND status = 'novo';
  INSERT INTO public.send_runs (campaign_id, lead_id, status, current_position)
  SELECT p_campaign_id, id, 'pending', 0
  FROM public.leads
  WHERE id = ANY (p_lead_ids);
  RETURN jsonb_build_object('ok', true, 'count', array_length(p_lead_ids, 1));
END;
$$;
GRANT EXECUTE ON FUNCTION public.consecom_associar_campanha(UUID[], UUID) TO service_role;

-- 6) RPC: fechar lead (finalizado) com motivo
CREATE OR REPLACE FUNCTION public.consecom_fechar_lead(
  p_lead_id UUID,
  p_fechado BOOLEAN DEFAULT true,
  p_motivo TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  UPDATE public.leads
  SET status = CASE WHEN p_fechado THEN 'fechado' ELSE 'nao_fechado' END,
      closed_reason = p_motivo,
      closed_at = now(),
      updated_at = now()
  WHERE id = p_lead_id;
  INSERT INTO public.lead_status_history (lead_id, status, notes)
  VALUES (p_lead_id, CASE WHEN p_fechado THEN 'fechado' ELSE 'nao_fechado' END, p_motivo);
  RETURN jsonb_build_object('ok', true, 'lead_id', p_lead_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.consecom_fechar_lead(UUID, BOOLEAN, TEXT) TO service_role;

-- 7) RPC do agente: registrar desfecho (sem_interesse / reunião cancelada)
CREATE OR REPLACE FUNCTION public.consecom_agent_outcome(
  p_lead_id UUID DEFAULT NULL,
  p_phone TEXT DEFAULT NULL,
  p_outcome TEXT DEFAULT NULL,
  p_motive TEXT DEFAULT NULL,
  p_no_interest_months INTEGER DEFAULT 6
) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_lead_id UUID;
BEGIN
  IF p_lead_id IS NOT NULL THEN
    v_lead_id := p_lead_id;
  ELSIF p_phone IS NOT NULL THEN
    SELECT id INTO v_lead_id FROM public.leads WHERE phone = p_phone LIMIT 1;
  END IF;

  IF v_lead_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'lead_not_found');
  END IF;

  IF p_outcome = 'sem_interesse' THEN
    UPDATE public.leads
    SET status = 'sem_interesse',
        no_interest_until = now() + (p_no_interest_months || ' months')::interval,
        closed_reason = p_motive,
        updated_at = now()
    WHERE id = v_lead_id;
    INSERT INTO public.lead_status_history (lead_id, status, notes)
    VALUES (v_lead_id, 'sem_interesse', p_motive);
    RETURN jsonb_build_object('ok', true, 'lead_id', v_lead_id, 'outcome', 'sem_interesse');
  ELSIF p_outcome = 'reuniao_cancelada' THEN
    UPDATE public.leads
    SET status = 'reuniao_cancelada',
        closed_reason = p_motive,
        updated_at = now()
    WHERE id = v_lead_id;
    INSERT INTO public.lead_status_history (lead_id, status, notes)
    VALUES (v_lead_id, 'reuniao_cancelada', p_motive);
    RETURN jsonb_build_object('ok', true, 'lead_id', v_lead_id, 'outcome', 'reuniao_cancelada');
  END IF;

  RETURN jsonb_build_object('ok', false, 'error', 'invalid_outcome');
END;
$$;
GRANT EXECUTE ON FUNCTION public.consecom_agent_outcome(UUID, TEXT, TEXT, TEXT, INTEGER) TO service_role;

-- 8) Autotreino: lições aprendidas com vitórias/rejeições reais
CREATE TABLE IF NOT EXISTS public.agent_learning (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id    UUID REFERENCES public.leads(id) ON DELETE SET NULL,
  outcome    TEXT NOT NULL CHECK (outcome IN ('vitoria','rejeicao')),
  lesson     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.agent_learning ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_learning_anon_insert ON public.agent_learning
  FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY agent_learning_auth_all ON public.agent_learning
  FOR ALL USING (auth.role() = 'authenticated');
CREATE INDEX IF NOT EXISTS agent_learning_created_idx ON public.agent_learning (created_at DESC);