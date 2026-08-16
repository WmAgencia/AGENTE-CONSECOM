-- =============================================================
-- VYNTRA — Migration v27 (Tenant auto-resolve nos triggers)
-- Idempotente.
--
-- O trigger set_tenant_id passa a resolver o tenant automaticamente
-- quando o INSERT vem do backend (service role => auth.uid() é NULL):
--   * tabelas-filhas com lead_id  -> tenant do lead
--   * tabelas com owner_user_id   -> tenant do app_user
-- Isso cobre webhook/agente/send-worker/follow-ups/contatos sem
-- precisar refatorar cada ponto de escrita no código.
--
-- Também blindamos enforce_credit_limit para resolver o tenant a
-- partir do lead (independe da ordem de execução dos triggers
-- BEFORE INSERT em send_runs).
-- =============================================================

CREATE OR REPLACE FUNCTION public.resolve_tenant_from_row(j jsonb) RETURNS UUID
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  tid uuid;
BEGIN
  tid := NULL;
  -- Tabelas-filhas com lead_id: o tenant vem do lead.
  IF (j ? 'lead_id') AND j->>'lead_id' IS NOT NULL THEN
    SELECT tenant_id INTO tid FROM public.leads WHERE id = (j->>'lead_id')::uuid;
  END IF;
  -- Leads/registros com owner_user_id: o tenant vem do app_user.
  IF tid IS NULL AND (j ? 'owner_user_id') AND j->>'owner_user_id' IS NOT NULL THEN
    SELECT tenant_id INTO tid FROM public.app_users WHERE id = (j->>'owner_user_id')::uuid;
  END IF;
  RETURN tid;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_tenant_id() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.tenant_id := COALESCE(
    NEW.tenant_id,
    public.current_tenant_id(),
    public.resolve_tenant_from_row(to_jsonb(NEW))
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_credit_limit() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  tid UUID;
  lim INTEGER;
  used INTEGER;
BEGIN
  tid := COALESCE(
    NEW.tenant_id,
    public.current_tenant_id(),
    public.resolve_tenant_from_row(to_jsonb(NEW))
  );
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
  VALUES (
    COALESCE(NEW.tenant_id, public.current_tenant_id(), public.resolve_tenant_from_row(to_jsonb(NEW))),
    'consumed', NEW.lead_id,
    jsonb_build_object('campaign_id', NEW.campaign_id)
  );
  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';
