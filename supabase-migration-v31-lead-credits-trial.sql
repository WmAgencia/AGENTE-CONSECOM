-- =============================================================
-- VYNTRA — Migration v31 (Créditos de Leads + Plano TESTE)
-- Projeto Supabase: nzexythhastovjwuedsh
-- Idempotente: pode ser rodado múltiplas vezes.
--
-- 1) Colunas novas em plans: featured, display_order,
--    campaign_equivalence, badge_label.
-- 2) Catálogo de 5 planos (TESTE / INICIAL / PROFISSIONAL /
--    PERFORMANCE / ESCALA) com valores reais e destaque.
-- 3) Tabela trial_redemption (anti-abuso do plano TESTE):
--    hashes de e-mail, telefone, IP e dispositivo + user_id único
--    (ativação atômica) + risco.
-- 4) Tabela security_events (auditoria de segurança p/ painel
--    antifraude do Master).
-- 5) Tabela credit_ledger (histórico de crédito/consumo de leads:
--    acquisition + consumption).
-- =============================================================

-- =============================================================
-- 1) Colunas novas em plans
-- =============================================================

ALTER TABLE public.plans
  ADD COLUMN IF NOT EXISTS featured BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS display_order INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS campaign_equivalence INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS badge_label TEXT;

-- =============================================================
-- 2) Catálogo de planos (R$ / leads / campanhas / destaque)
--    Preços e limites são configuráveis pelo Painel Master;
--    estes valores são apenas o seed inicial.
-- =============================================================

-- TESTE: R$ 9,90 / 250 leads / 1 campanha (uma única vez por usuário).
INSERT INTO public.plans (name, slug, description, price, currency, lead_limit, duration_days, billing_type, active, features, featured, display_order, campaign_equivalence, badge_label)
VALUES (
  'TESTE',
  'teste',
  'Experimente a plataforma por inteiro. 250 leads para você validar o Vyntra.',
  9.90,
  'BRL',
  250,
  30,
  'one_time',
  true,
  '["250 leads"]'::jsonb,
  false,
  1,
  1,
  NULL
)
ON CONFLICT (slug) DO NOTHING;

-- INICIAL: R$ 19,90 / 250 leads / 3 campanhas.
INSERT INTO public.plans (name, slug, description, price, currency, lead_limit, duration_days, billing_type, active, features, featured, display_order, campaign_equivalence, badge_label)
VALUES (
  'INICIAL',
  'inicial',
  'Comece a prospectar com mais volume e estrutura.',
  19.90,
  'BRL',
  250,
  NULL,
  'one_time',
  true,
  '["250 leads","3 campanhas"]'::jsonb,
  false,
  2,
  3,
  NULL
)
ON CONFLICT (slug) DO NOTHING;

-- PROFISSIONAL: R$ 49,90 / 500 leads / 10 campanhas (MAIS ESCOLHIDO).
INSERT INTO public.plans (name, slug, description, price, currency, lead_limit, duration_days, billing_type, active, features, featured, display_order, campaign_equivalence, badge_label)
VALUES (
  'PROFISSIONAL',
  'profissional',
  'O plano favorito dos vendedores que querem resultados de verdade.',
  49.90,
  'BRL',
  500,
  NULL,
  'one_time',
  true,
  '["500 leads","10 campanhas"]'::jsonb,
  true,
  3,
  10,
  'MAIS ESCOLHIDO'
)
ON CONFLICT (slug) DO NOTHING;

-- PERFORMANCE: R$ 89,90 / 1000 leads / 25 campanhas.
INSERT INTO public.plans (name, slug, description, price, currency, lead_limit, duration_days, billing_type, active, features, featured, display_order, campaign_equivalence, badge_label)
VALUES (
  'PERFORMANCE',
  'performance',
  'Máximo desempenho para equipes comerciais em expansão.',
  89.90,
  'BRL',
  1000,
  NULL,
  'one_time',
  true,
  '["1000 leads","25 campanhas"]'::jsonb,
  false,
  4,
  25,
  NULL
)
ON CONFLICT (slug) DO NOTHING;

-- ESCALA: R$ 149,90 / 2000 leads / campanhas ilimitadas.
INSERT INTO public.plans (name, slug, description, price, currency, lead_limit, duration_days, billing_type, active, features, featured, display_order, campaign_equivalence, badge_label)
VALUES (
  'ESCALA',
  'escala',
  'Para quem opera em escala: o máximo de leads e campanhas.',
  149.90,
  'BRL',
  2000,
  NULL,
  'one_time',
  true,
  '["2000 leads","Campanhas ilimitadas"]'::jsonb,
  false,
  5,
  999,
  NULL
)
ON CONFLICT (slug) DO NOTHING;

-- Ordenação padrão do catálogo pelo display_order.
UPDATE public.plans SET display_order = 1  WHERE slug = 'teste'        AND display_order = 0;
UPDATE public.plans SET display_order = 2  WHERE slug = 'inicial'      AND display_order = 0;
UPDATE public.plans SET display_order = 3  WHERE slug = 'profissional' AND display_order = 0;
UPDATE public.plans SET display_order = 4  WHERE slug = 'performance'  AND display_order = 0;
UPDATE public.plans SET display_order = 5  WHERE slug = 'escala'       AND display_order = 0;

-- =============================================================
-- 3) trial_redemption — anti-abuso do plano TESTE
--    user_id UNIQUE garante 1 resgate por conta (ativação atômica).
--    Hashes (SHA-256) bloqueiam tentativas de burla via contas novas:
--    mesmo e-mail, telefone, IP ou dispositivo => rejeitado.
-- =============================================================

CREATE TABLE IF NOT EXISTS public.trial_redemption (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id   UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  plan_id     UUID NOT NULL REFERENCES public.plans(id),
  email_hash  TEXT,
  phone_hash  TEXT,
  ip_hash     TEXT,
  device_hash TEXT,
  status      TEXT NOT NULL DEFAULT 'redeemed'
              CHECK (status IN ('redeemed','expired','void')),
  risk_score  INTEGER NOT NULL DEFAULT 0,
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trial_redemption_user_once UNIQUE (user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS trial_redemption_email_once
  ON public.trial_redemption (email_hash) WHERE email_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS trial_redemption_phone_once
  ON public.trial_redemption (phone_hash) WHERE phone_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS trial_redemption_ip_idx
  ON public.trial_redemption (ip_hash);
CREATE INDEX IF NOT EXISTS trial_redemption_device_idx
  ON public.trial_redemption (device_hash);

ALTER TABLE public.trial_redemption ENABLE ROW LEVEL SECURITY;

-- =============================================================
-- 4) security_events — trilha de segurança para o painel antifraude
-- =============================================================

CREATE TABLE IF NOT EXISTS public.security_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type  TEXT NOT NULL,
  user_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  tenant_id   UUID REFERENCES public.tenants(id) ON DELETE CASCADE,
  ip_hash     TEXT,
  email_hash  TEXT,
  phone_hash  TEXT,
  device_hash TEXT,
  risk_score  INTEGER NOT NULL DEFAULT 0,
  reason      TEXT,
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS security_events_type_idx ON public.security_events (event_type, created_at);
CREATE INDEX IF NOT EXISTS security_events_tenant_idx ON public.security_events (tenant_id);
CREATE INDEX IF NOT EXISTS security_events_ip_idx ON public.security_events (ip_hash);
CREATE INDEX IF NOT EXISTS security_events_email_idx ON public.security_events (email_hash);

ALTER TABLE public.security_events ENABLE ROW LEVEL SECURITY;

-- =============================================================
-- 5) credit_ledger — histórico de aquisição e consumo de leads
--    kind: 'purchase' (+leads) | 'consumption' (-leads)
--          'trial' (+leads do plano TESTE) | 'refund' (+/-)
--    Cada importação/consumo gera uma linha (atômica e auditável).
-- =============================================================

CREATE TABLE IF NOT EXISTS public.credit_ledger (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('purchase','consumption','trial','refund','adjustment')),
  delta       INTEGER NOT NULL,
  plan_id     UUID REFERENCES public.plans(id),
  payment_id  UUID REFERENCES public.payments(id) ON DELETE SET NULL,
  lead_id     UUID REFERENCES public.leads(id) ON DELETE SET NULL,
  note        TEXT,
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS credit_ledger_tenant_idx ON public.credit_ledger (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS credit_ledger_kind_idx ON public.credit_ledger (kind);

ALTER TABLE public.credit_ledger ENABLE ROW LEVEL SECURITY;

-- =============================================================
-- RLS + triggers por tenant
-- =============================================================

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'trial_redemption','security_events','credit_ledger'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT USING (tenant_id = public.current_tenant_id())',
      'tenant_' || t || '_read', t
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT WITH CHECK (tenant_id = public.current_tenant_id())',
      'tenant_' || t || '_insert', t
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE USING (tenant_id = public.current_tenant_id())',
      'tenant_' || t || '_update', t
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE USING (tenant_id = public.current_tenant_id())',
      'tenant_' || t || '_delete', t
    );
  END LOOP;
END $$;

-- security_events é usada pelo backend (service_role); usuários comuns
-- podem ler apenas os eventos do próprio tenant (para o app exibir alertas).
-- trial_redemption: apenas o próprio usuário enxerga o próprio resgate.
CREATE POLICY trial_redemption_own_read ON public.trial_redemption
  FOR SELECT USING (user_id = auth.uid());

-- =============================================================
-- Recarrega o schema cache do PostgREST
-- =============================================================
NOTIFY pgrst, 'reload schema';