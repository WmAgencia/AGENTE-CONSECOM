-- =============================================================
-- Consecom — Migração v6 (Funil analítico + Estratégias + Inteligência)
-- Cole no Supabase: Dashboard -> SQL Editor -> New query -> Run
-- Idempotente. Pode ser rodado múltiplas vezes.
-- =============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ===== 1) strategies — estratégias de abordagem versionadas =====
CREATE TABLE IF NOT EXISTS public.strategies (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code            TEXT NOT NULL UNIQUE,                -- ex: strategy_001
  version         INTEGER NOT NULL DEFAULT 1,
  name            TEXT NOT NULL,
  description     TEXT,                                -- estilo de abordagem (injetado no prompt)
  first_message   TEXT,                                -- template da 1ª mensagem (suporta placeholders)
  segment         TEXT,                                -- filtro opcional: nicho/segmento (NULL = todos)
  service         TEXT,                                -- filtro opcional: site | landing | sistema (NULL = todos)
  status          TEXT NOT NULL DEFAULT 'rascunho'
                  CHECK (status IN ('rascunho','ativa','pausada','teste','vencedora','perdedora')),
  approval_status TEXT NOT NULL DEFAULT 'pendente'
                  CHECK (approval_status IN ('pendente','aprovada','rejeitada')),
  parent_id       UUID REFERENCES public.strategies(id) ON DELETE SET NULL, -- versão anterior
  created_by      TEXT,
  approved_by     TEXT,
  approved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS strategies_code_idx   ON public.strategies (code);
CREATE INDEX IF NOT EXISTS strategies_status_idx ON public.strategies (status);

-- ===== 2) campaign_strategies — distribuição de estratégias por campanha (A/B) =====
CREATE TABLE IF NOT EXISTS public.campaign_strategies (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  UUID NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  strategy_id  UUID NOT NULL REFERENCES public.strategies(id) ON DELETE CASCADE,
  weight       INTEGER NOT NULL DEFAULT 1,             -- peso para sorteio A/B
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, strategy_id)
);
CREATE INDEX IF NOT EXISTS campaign_strategies_campaign_idx ON public.campaign_strategies (campaign_id);
CREATE INDEX IF NOT EXISTS campaign_strategies_strategy_idx ON public.campaign_strategies (strategy_id);

-- ===== 3) Colunas analíticas em leads (funil invisível) =====
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS strategy_id          UUID REFERENCES public.strategies(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS score                INTEGER,
  ADD COLUMN IF NOT EXISTS score_factors        JSONB,
  ADD COLUMN IF NOT EXISTS interest_level       TEXT,   -- baixo | medio | alto
  ADD COLUMN IF NOT EXISTS service_interest     TEXT,   -- site | landing | sistema | outro
  ADD COLUMN IF NOT EXISTS has_website          BOOLEAN,
  ADD COLUMN IF NOT EXISTS has_system           BOOLEAN,
  ADD COLUMN IF NOT EXISTS problem_identified   BOOLEAN,
  ADD COLUMN IF NOT EXISTS problem_description  TEXT,
  ADD COLUMN IF NOT EXISTS objection            TEXT,   -- objeção principal registrada
  ADD COLUMN IF NOT EXISTS meeting_outcome      TEXT,   -- agendada | realizada | cancelada
  ADD COLUMN IF NOT EXISTS sale_status          TEXT,   -- venda | nao_vendeu | sem_retorno | outro
  ADD COLUMN IF NOT EXISTS loss_reason          TEXT;

CREATE INDEX IF NOT EXISTS leads_strategy_idx    ON public.leads (strategy_id);
CREATE INDEX IF NOT EXISTS leads_score_idx       ON public.leads (score);
CREATE INDEX IF NOT EXISTS leads_service_interest_idx ON public.leads (service_interest);

-- ===== 4) objections — biblioteca de objeções =====
CREATE TABLE IF NOT EXISTS public.objections (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  text                TEXT NOT NULL,
  category            TEXT NOT NULL DEFAULT 'outros',
  suggested_response  TEXT,
  strategy_id         UUID REFERENCES public.strategies(id) ON DELETE SET NULL,
  frequency           INTEGER NOT NULL DEFAULT 0,     -- contagem agregada (atualizado por análise)
  converted_count     INTEGER NOT NULL DEFAULT 0,     -- nº que viraram reunião depois dessa objeção
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (text, strategy_id)
);
CREATE INDEX IF NOT EXISTS objections_category_idx ON public.objections (category);
CREATE INDEX IF NOT EXISTS objections_text_idx     ON public.objections (text);

-- ===== 5) experiments — testes A/B =====
CREATE TABLE IF NOT EXISTS public.experiments (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT NOT NULL,
  segment               TEXT,
  service               TEXT,
  control_strategy_id   UUID NOT NULL REFERENCES public.strategies(id) ON DELETE CASCADE,
  test_strategy_id      UUID REFERENCES public.strategies(id) ON DELETE CASCADE,
  status                TEXT NOT NULL DEFAULT 'planejado'
                        CHECK (status IN ('planejado','em_andamento','finalizado','cancelado')),
  sample_target         INTEGER NOT NULL DEFAULT 100,
  started_at            TIMESTAMPTZ,
  ended_at              TIMESTAMPTZ,
  decision              TEXT,                          -- vencedora | perdedora | insuficiente
  decided_strategy_id   UUID REFERENCES public.strategies(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS experiments_status_idx ON public.experiments (status);

-- ===== 6) agent_insights — insights automáticos (com aprovação humana) =====
CREATE TABLE IF NOT EXISTS public.agent_insights (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         TEXT NOT NULL,   -- estrategia | mensagem | pergunta | segmento | servico | objecao | gargalo
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  data         JSONB NOT NULL DEFAULT '{}'::jsonb,
  status       TEXT NOT NULL DEFAULT 'nova'
               CHECK (status IN ('nova','aprovada','rejeitada','descartada')),
  strategy_id  UUID REFERENCES public.strategies(id) ON DELETE SET NULL,
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_insights_status_idx ON public.agent_insights (status);
CREATE INDEX IF NOT EXISTS agent_insights_kind_idx   ON public.agent_insights (kind);

-- ===== 7) Triggers de updated_at =====
DROP TRIGGER IF EXISTS strategies_updated ON public.strategies;
CREATE TRIGGER strategies_updated BEFORE UPDATE ON public.strategies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS objections_updated ON public.objections;
CREATE TRIGGER objections_updated BEFORE UPDATE ON public.objections
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS experiments_updated ON public.experiments;
CREATE TRIGGER experiments_updated BEFORE UPDATE ON public.experiments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS agent_insights_updated ON public.agent_insights;
CREATE TRIGGER agent_insights_updated BEFORE UPDATE ON public.agent_insights
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ===== 8) RPC: vincular estratégia a uma campanha (A/B com pesos) =====
CREATE OR REPLACE FUNCTION public.consecom_vincular_estrategia(
  p_campaign_id UUID,
  p_strategy_id UUID,
  p_weight INTEGER DEFAULT 1
) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  INSERT INTO public.campaign_strategies (campaign_id, strategy_id, weight)
  VALUES (p_campaign_id, p_strategy_id, p_weight)
  ON CONFLICT (campaign_id, strategy_id)
  DO UPDATE SET weight = EXCLUDED.weight;
  RETURN jsonb_build_object('ok', true, 'campaign_id', p_campaign_id, 'strategy_id', p_strategy_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.consecom_desvincular_estrategia(
  p_campaign_id UUID,
  p_strategy_id UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  DELETE FROM public.campaign_strategies
  WHERE campaign_id = p_campaign_id AND strategy_id = p_strategy_id;
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ===== 9) RPC: aprovar/rejeitar estratégia (human-in-the-loop) =====
CREATE OR REPLACE FUNCTION public.consecom_aprovar_estrategia(
  p_strategy_id UUID,
  p_approve BOOLEAN,
  p_approver TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  UPDATE public.strategies
  SET approval_status = CASE WHEN p_approve THEN 'aprovada' ELSE 'rejeitada' END,
      status = CASE WHEN p_approve THEN 'ativa' ELSE 'rascunho' END,
      approved_by = p_approver,
      approved_at = now(),
      updated_at = now()
  WHERE id = p_strategy_id;
  RETURN jsonb_build_object('ok', true, 'strategy_id', p_strategy_id, 'approved', p_approve);
END;
$$;

-- ===== 10) RLS =====
ALTER TABLE public.strategies          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_strategies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.objections          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.experiments         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_insights      ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS strategies_auth_all ON public.strategies;
DROP POLICY IF EXISTS campaign_strategies_auth_all ON public.campaign_strategies;
DROP POLICY IF EXISTS objections_auth_all ON public.objections;
DROP POLICY IF EXISTS experiments_auth_all ON public.experiments;
DROP POLICY IF EXISTS agent_insights_auth_all ON public.agent_insights;

CREATE POLICY strategies_auth_all          ON public.strategies          FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY campaign_strategies_auth_all ON public.campaign_strategies FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY objections_auth_all          ON public.objections          FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY experiments_auth_all         ON public.experiments         FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY agent_insights_auth_all      ON public.agent_insights      FOR ALL USING (auth.role() = 'authenticated');

-- ===== 11) Grants =====
GRANT EXECUTE ON FUNCTION public.consecom_vincular_estrategia(UUID, UUID, INTEGER) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.consecom_desvincular_estrategia(UUID, UUID) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.consecom_aprovar_estrategia(UUID, BOOLEAN, TEXT) TO service_role, authenticated;
