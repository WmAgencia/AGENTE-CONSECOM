-- =============================================================
-- Consecom — Migração v5 (Segurança + consistência)
-- Cole no Supabase: Dashboard -> SQL Editor -> New query
-- Idempotente.
-- =============================================================

-- 1) Garante pgcrypto para gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 2) SEGURANÇA CRÍTICA: remove a política de DELETE anônimo.
-- A política leads_anon_delete permitia que QUALQUER pessoa
-- (sem autenticação) com o supabase URL apagasse TODOS os leads.
-- A exclusão de leads agora só pode ser feita por:
--   (a) usuários autenticados (auth.role() = 'authenticated')
--   (b) backend via service_role (bypassa RLS)
-- A extensão Chrome não precisa mais de DELETE anônimo; se
-- precisar excluir, a operação passa pelo backend.
DROP POLICY IF EXISTS leads_anon_delete ON public.leads;

-- 3) Mesma proteção para outras tabelas sensíveis.
DROP POLICY IF EXISTS qm_auth_delete ON public.queue_messages;
CREATE POLICY qm_service_delete ON public.queue_messages
  FOR DELETE USING (auth.role() = 'service_role');

-- 4) Limpa políticas que permitiam INSERT anônimo em tabelas
-- que NÃO devem ser populadas pela extensão. Mantém apenas
-- leads (importação) e capture_sessions (sessão de captura).
DROP POLICY IF EXISTS agent_learning_anon_insert ON public.agent_learning;

-- 5) RPC para exclusão via backend (service_role). A extensão
-- chama este RPC em vez de DELETE direto na tabela.
CREATE OR REPLACE FUNCTION public.consecom_excluir_leads(
  p_lead_ids UUID[],
  p_requester_token TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  -- Aceita service_role ou usuário autenticado.
  IF auth.role() NOT IN ('service_role', 'authenticated') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
  END IF;

  DELETE FROM public.leads WHERE id = ANY (p_lead_ids);

  RETURN jsonb_build_object(
    'ok', true,
    'deleted', array_length(p_lead_ids, 1)
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.consecom_excluir_leads(UUID[], TEXT)
  TO service_role, authenticated;

-- 6) Garante que as tabelas críticas têm updated_at automático.
DROP TRIGGER IF EXISTS leads_updated_at ON public.leads;
CREATE TRIGGER leads_updated_at BEFORE UPDATE ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS campaigns_updated_at ON public.campaigns;
CREATE TRIGGER campaigns_updated_at BEFORE UPDATE ON public.campaigns
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 7) Função utilitária: cleanup automático de no_interest_until
-- expirado (executar via cron diário).
CREATE OR REPLACE FUNCTION public.consecom_cleanup_no_interest()
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE public.leads
  SET status = 'novo',
      no_interest_until = NULL,
      updated_at = now()
  WHERE status = 'sem_interesse'
    AND no_interest_until IS NOT NULL
    AND no_interest_until < now();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
GRANT EXECUTE ON FUNCTION public.consecom_cleanup_no_interest() TO service_role;
