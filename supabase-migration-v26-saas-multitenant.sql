-- =============================================================
-- VYNTRA — Migration v26 (SaaS Multitenant)
-- Projeto Supabase: nzexythhastovjwuedsh
-- Idempotente: pode ser rodado múltiplas vezes.
--
-- 1) Tabelas SaaS: tenants, app_users, plans, subscriptions,
--    payments, payment_gateways, coupons, coupon_redemptions,
--    marketing_settings, source_requests, usage.
-- 2) Coluna tenant_id em todas as tabelas de dados do tenant.
-- 3) Tenant Default + backfill dos dados existentes.
-- 4) app_users a partir de auth.users (usuários atuais = MASTER
--    no tenant Default, preservando o acesso administrativo atual).
-- 5) Trigger que atribui tenant_id automaticamente no INSERT
--    (a partir do usuário autenticado) e policy por tenant.
-- 6) Trigger de crédito em send_runs (limite de leads por plano).
-- 7) Seed do plano "Inicial" (R$ 9,90 / 250 leads / uso único).
-- 8) RLS: removidas políticas antigas ("qualquer autenticado vê
--    tudo") e criadas políticas por tenant em todas as tabelas.
-- =============================================================

-- =============================================================
-- Tabelas SaaS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.tenants (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  slug       TEXT UNIQUE,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.app_users (
  id         UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id  UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  full_name  TEXT,
  role       TEXT NOT NULL DEFAULT 'USER' CHECK (role IN ('USER','MASTER')),
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS app_users_tenant_idx ON public.app_users (tenant_id);

CREATE TABLE IF NOT EXISTS public.plans (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  slug         TEXT UNIQUE NOT NULL,
  description  TEXT,
  price        NUMERIC(10,2) NOT NULL DEFAULT 0,
  currency     TEXT NOT NULL DEFAULT 'BRL',
  lead_limit   INTEGER NOT NULL DEFAULT 0,
  duration_days INTEGER,
  billing_type TEXT NOT NULL DEFAULT 'one_time' CHECK (billing_type IN ('one_time','recurring')),
  active       BOOLEAN NOT NULL DEFAULT true,
  features     JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.subscriptions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  plan_id              UUID NOT NULL REFERENCES public.plans(id),
  status               TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('active','pending','past_due','cancelled','expired')),
  current_period_start TIMESTAMPTZ,
  current_period_end   TIMESTAMPTZ,
  leads_used           INTEGER NOT NULL DEFAULT 0,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subscriptions_tenant_idx ON public.subscriptions (tenant_id);

CREATE TABLE IF NOT EXISTS public.payments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  subscription_id     UUID REFERENCES public.subscriptions(id) ON DELETE SET NULL,
  plan_id             UUID REFERENCES public.plans(id),
  gateway             TEXT NOT NULL DEFAULT 'sandbox',
  gateway_payment_id  TEXT,
  gateway_preference_id TEXT,
  amount              NUMERIC(10,2) NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'BRL',
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','rejected','refunded','cancelled')),
  coupon_code         TEXT,
  discount_amount     NUMERIC(10,2) NOT NULL DEFAULT 0,
  webhook_id          TEXT UNIQUE,
  idempotency_key     TEXT UNIQUE,
  paid_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payments_tenant_idx ON public.payments (tenant_id);

CREATE TABLE IF NOT EXISTS public.payment_gateways (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL UNIQUE,
  provider   TEXT NOT NULL,
  enabled    BOOLEAN NOT NULL DEFAULT false,
  sandbox    BOOLEAN NOT NULL DEFAULT true,
  config     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.coupons (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                TEXT NOT NULL UNIQUE,
  discount_type       TEXT NOT NULL CHECK (discount_type IN ('percentage','fixed')),
  discount_value      NUMERIC(10,2) NOT NULL,
  valid_from          TIMESTAMPTZ,
  valid_until         TIMESTAMPTZ,
  usage_limit         INTEGER,
  usage_count         INTEGER NOT NULL DEFAULT 0,
  active              BOOLEAN NOT NULL DEFAULT true,
  applicable_plan_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.coupon_redemptions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  coupon_id   UUID NOT NULL REFERENCES public.coupons(id),
  payment_id  UUID REFERENCES public.payments(id) ON DELETE SET NULL,
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coupon_redemptions_tenant_idx ON public.coupon_redemptions (tenant_id);

CREATE TABLE IF NOT EXISTS public.marketing_settings (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meta_pixel_id     TEXT,
  meta_pixel_active BOOLEAN NOT NULL DEFAULT false,
  tiktok_pixel_id   TEXT,
  tiktok_pixel_active BOOLEAN NOT NULL DEFAULT false,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO public.marketing_settings (id) VALUES ('00000000-0000-0000-0000-000000000001')
  ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.source_requests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID REFERENCES public.tenants(id) ON DELETE SET NULL,
  url          TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'recebida'
               CHECK (status IN ('recebida','em_analise','aprovada','rejeitada','implementada')),
  notes        TEXT,
  requested_by TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.usage (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  lead_id    UUID REFERENCES public.leads(id) ON DELETE SET NULL,
  detail     JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_tenant_idx ON public.usage (tenant_id, created_at);

-- =============================================================
-- Funções utilitárias (após as tabelas existirem)
-- =============================================================

-- Retorna o tenant_id do usuário autenticado atual (auth.uid()).
-- Retorna NULL para anon/sem usuário (RLS bloqueia o acesso).
CREATE OR REPLACE FUNCTION public.current_tenant_id() RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT tenant_id FROM public.app_users WHERE id = auth.uid();
$$;

-- Atribui tenant_id em INSERTs (usa o informado ou o do usuário).
CREATE OR REPLACE FUNCTION public.set_tenant_id() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.tenant_id := COALESCE(NEW.tenant_id, public.current_tenant_id());
  RETURN NEW;
END;
$$;

-- Cria tenant + app_users automaticamente para todo novo signup.
CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  tid UUID;
BEGIN
  INSERT INTO public.tenants (name, slug)
  VALUES (COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email), 't-' || replace(NEW.id::text, '-', ''))
  RETURNING id INTO tid;
  INSERT INTO public.app_users (id, tenant_id, email, full_name, role)
  VALUES (
    NEW.id,
    tid,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', ''),
    'USER'
  );
  RETURN NEW;
END;
$$;

-- =============================================================
-- Coluna tenant_id nas tabelas de dados do tenant
-- =============================================================

ALTER TABLE public.leads                  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
ALTER TABLE public.lead_status_history     ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
ALTER TABLE public.campaigns               ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
ALTER TABLE public.queue_messages          ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
ALTER TABLE public.send_runs               ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
ALTER TABLE public.consecom_conversations  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
ALTER TABLE public.lead_contacts           ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
ALTER TABLE public.whatsapp_connections    ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
ALTER TABLE public.notification_groups     ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
ALTER TABLE public.notification_settings   ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
ALTER TABLE public.commercial_goals        ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
ALTER TABLE public.strategies              ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
ALTER TABLE public.campaign_strategies     ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
ALTER TABLE public.follow_ups              ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
ALTER TABLE public.ai_memory_conversations ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
ALTER TABLE public.ai_memory_imports       ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
ALTER TABLE public.ai_memory_learnings     ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
ALTER TABLE public.agent_settings          ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
ALTER TABLE public.agent_learning          ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
ALTER TABLE public.agent_insights          ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
ALTER TABLE public.capture_sessions        ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
ALTER TABLE public.experiments             ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
ALTER TABLE public.objections              ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
ALTER TABLE public.consecom_audit_log      ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);

CREATE INDEX IF NOT EXISTS leads_tenant_idx               ON public.leads (tenant_id);
CREATE INDEX IF NOT EXISTS campaigns_tenant_idx           ON public.campaigns (tenant_id);
CREATE INDEX IF NOT EXISTS send_runs_tenant_idx           ON public.send_runs (tenant_id);
CREATE INDEX IF NOT EXISTS whatsapp_connections_tenant_idx ON public.whatsapp_connections (tenant_id);
CREATE INDEX IF NOT EXISTS follow_ups_tenant_idx          ON public.follow_ups (tenant_id);
CREATE INDEX IF NOT EXISTS lead_contacts_tenant_idx       ON public.lead_contacts (tenant_id);
CREATE INDEX IF NOT EXISTS consecom_conversations_tenant_idx ON public.consecom_conversations (tenant_id);

-- =============================================================
-- Tenant Default + backfill dos dados existentes
-- =============================================================

INSERT INTO public.tenants (id, name, slug, status)
VALUES ('00000000-0000-0000-0000-000000000001', 'Vyntra Default', 'vyntra-default', 'active')
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE
  t TEXT;
  tid UUID := '00000000-0000-0000-0000-000000000001';
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'leads','lead_status_history','campaigns','queue_messages','send_runs',
    'consecom_conversations','lead_contacts','whatsapp_connections',
    'notification_groups','notification_settings','commercial_goals',
    'strategies','campaign_strategies','follow_ups','ai_memory_conversations',
    'ai_memory_imports','ai_memory_learnings','agent_settings','agent_learning',
    'agent_insights','capture_sessions','experiments','objections',
    'consecom_audit_log'
  ] LOOP
    EXECUTE format('UPDATE public.%I SET tenant_id = $1 WHERE tenant_id IS NULL', t) USING tid;
  END LOOP;
END $$;

-- =============================================================
-- app_users a partir de auth.users (usuários atuais)
-- =============================================================

INSERT INTO public.app_users (id, tenant_id, email, full_name, role, status)
SELECT
  u.id,
  '00000000-0000-0000-0000-000000000001',
  u.email,
  COALESCE(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', ''),
  'MASTER',
  'active'
FROM auth.users u
ON CONFLICT (id) DO NOTHING;

-- =============================================================
-- Trigger de signup (novos usuários ganham tenant próprio)
-- =============================================================

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- =============================================================
-- RLS + triggers de tenant nas tabelas de dados
-- Remove TODAS as políticas antigas (inclusive anon) e cria
-- políticas por tenant + trigger que seta tenant_id no INSERT.
-- =============================================================

DO $$
DECLARE
  r RECORD;
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'leads','lead_status_history','campaigns','queue_messages','send_runs',
    'consecom_conversations','lead_contacts','whatsapp_connections',
    'notification_groups','notification_settings','commercial_goals',
    'strategies','campaign_strategies','follow_ups','ai_memory_conversations',
    'ai_memory_imports','ai_memory_learnings','agent_settings','agent_learning',
    'agent_insights','capture_sessions','experiments','objections',
    'consecom_audit_log','tenants','app_users','subscriptions','payments',
    'coupon_redemptions','source_requests','usage'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    FOR r IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = t LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.policyname, t);
    END LOOP;
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'tenant_' || t || '_read', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'tenant_' || t || '_insert', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'tenant_' || t || '_update', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'tenant_' || t || '_delete', t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', 'trg_' || t || '_tenant', t);
  END LOOP;
END $$;

-- Tabelas de dados do tenant: RLS completa por tenant.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'leads','lead_status_history','campaigns','queue_messages','send_runs',
    'consecom_conversations','lead_contacts','whatsapp_connections',
    'notification_groups','notification_settings','commercial_goals',
    'strategies','campaign_strategies','follow_ups','ai_memory_conversations',
    'ai_memory_imports','ai_memory_learnings','agent_settings','agent_learning',
    'agent_insights','capture_sessions','experiments','objections',
    'consecom_audit_log','subscriptions','payments','coupon_redemptions','usage'
  ] LOOP
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
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.set_tenant_id()',
      'trg_' || t || '_tenant', t
    );
  END LOOP;
END $$;

-- app_users: cada usuário lê/atualiza apenas o próprio registro.
CREATE POLICY app_users_own_read   ON public.app_users FOR SELECT USING (id = auth.uid());
CREATE POLICY app_users_own_update ON public.app_users FOR UPDATE USING (id = auth.uid());

-- tenants: usuário lê apenas o próprio tenant.
CREATE POLICY tenants_own_read ON public.tenants FOR SELECT USING (id = public.current_tenant_id());

-- plans: catálogo público para autenticados (sem escrita direta).
CREATE POLICY plans_auth_read ON public.plans FOR SELECT USING (auth.role() = 'authenticated');

-- coupons: leitura para autenticados (validação real acontece no backend).
CREATE POLICY coupons_auth_read ON public.coupons FOR SELECT USING (auth.role() = 'authenticated');

-- marketing_settings: leitura para autenticados (IDs de pixel não são secretos).
CREATE POLICY marketing_settings_auth_read ON public.marketing_settings
  FOR SELECT USING (auth.role() = 'authenticated');

-- source_requests: anon pode ENVIAR uma URL (landing pública) e autenticado
-- lê as próprias solicitações do tenant.
CREATE POLICY source_requests_anon_insert ON public.source_requests
  FOR INSERT TO anon WITH CHECK (tenant_id IS NULL);
CREATE POLICY source_requests_tenant_read ON public.source_requests
  FOR SELECT USING (tenant_id = public.current_tenant_id());
CREATE POLICY source_requests_tenant_insert ON public.source_requests
  FOR INSERT WITH CHECK (tenant_id = public.current_tenant_id());

-- payment_gateways: NENHUMA política de leitura para usuários (só service_role).
ALTER TABLE public.payment_gateways ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='payment_gateways' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.payment_gateways', r.policyname);
  END LOOP;
END $$;

-- =============================================================
-- Trigger de crédito em send_runs (consumo de leads por plano)
-- =============================================================

CREATE OR REPLACE FUNCTION public.enforce_credit_limit() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  tid UUID;
  lim INTEGER;
  used INTEGER;
BEGIN
  tid := COALESCE(NEW.tenant_id, public.current_tenant_id());
  SELECT p.lead_limit INTO lim
  FROM public.plans p
  JOIN public.subscriptions s ON s.plan_id = p.id
  WHERE s.tenant_id = tid AND s.status = 'active'
  ORDER BY s.created_at DESC
  LIMIT 1;
  -- Sem assinatura ativa => sem limite (compatibilidade com dados atuais).
  IF lim IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT COUNT(DISTINCT sr.lead_id) INTO used
  FROM public.send_runs sr
  WHERE sr.tenant_id = tid;
  IF used >= lim THEN
    RAISE EXCEPTION 'credit_exhausted: limite de % leads do plano atingido para o tenant', lim;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_lead_consumed() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO public.usage (tenant_id, kind, lead_id, detail)
  VALUES (COALESCE(NEW.tenant_id, public.current_tenant_id()), 'consumed', NEW.lead_id,
          jsonb_build_object('campaign_id', NEW.campaign_id));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_send_runs_credit ON public.send_runs;
CREATE TRIGGER trg_send_runs_credit
  BEFORE INSERT ON public.send_runs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_credit_limit();

DROP TRIGGER IF EXISTS trg_send_runs_usage ON public.send_runs;
CREATE TRIGGER trg_send_runs_usage
  AFTER INSERT ON public.send_runs
  FOR EACH ROW EXECUTE FUNCTION public.log_lead_consumed();

-- =============================================================
-- Seed do plano inicial (R$ 9,90 / 250 leads / uso único).
-- Os demais planos são criados/editados pelo painel Master.
-- =============================================================

INSERT INTO public.plans (name, slug, description, price, currency, lead_limit, duration_days, billing_type, active, features)
VALUES (
  'Inicial',
  'inicial',
  'Plano de entrada — 250 leads. Uso único.',
  9.90,
  'BRL',
  250,
  NULL,
  'one_time',
  true,
  '["250 leads"]'::jsonb
)
ON CONFLICT (slug) DO NOTHING;

-- =============================================================
-- Recarrega o schema cache do PostgREST
-- =============================================================
NOTIFY pgrst, 'reload schema';