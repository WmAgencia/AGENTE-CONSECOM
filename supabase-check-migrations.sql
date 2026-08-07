-- =============================================================
-- Consecom — VERIFICAÇÃO DE MIGRATIONS
-- Rode no Supabase: SQL Editor -> New query
-- Retorna OK / FALTA para cada item esperado.
-- =============================================================

DO $$
DECLARE
  v_count INTEGER;
  v_result JSONB := '[]'::jsonb;
  v_item JSONB;
BEGIN
  -- Tabelas base (schema.sql)
  FOREACH v_item IN ARRAY ARRAY[
    jsonb_build_object('check', 'tabela leads', 'ok', EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='leads')),
    jsonb_build_object('check', 'tabela lead_status_history', 'ok', EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='lead_status_history')),
    jsonb_build_object('check', 'tabela campaigns', 'ok', EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='campaigns')),
    jsonb_build_object('check', 'tabela queue_messages', 'ok', EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='queue_messages')),
    jsonb_build_object('check', 'tabela send_runs', 'ok', EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='send_runs')),
    jsonb_build_object('check', 'tabela consecom_conversations', 'ok', EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='consecom_conversations')),
    jsonb_build_object('check', 'tabela lead_contacts', 'ok', EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='lead_contacts')),
    -- Migration v3
    jsonb_build_object('check', 'v3: tabela capture_sessions', 'ok', EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='capture_sessions')),
    jsonb_build_object('check', 'v3: tabela agent_settings', 'ok', EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='agent_settings')),
    jsonb_build_object('check', 'v3: tabela agent_learning', 'ok', EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='agent_learning')),
    jsonb_build_object('check', 'v3: coluna leads.session_id', 'ok', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='leads' AND column_name='session_id')),
    jsonb_build_object('check', 'v3: coluna leads.campaign_id', 'ok', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='leads' AND column_name='campaign_id')),
    jsonb_build_object('check', 'v3: coluna leads.no_interest_until', 'ok', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='leads' AND column_name='no_interest_until')),
    jsonb_build_object('check', 'v3: coluna leads.closed_reason', 'ok', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='leads' AND column_name='closed_reason')),
    jsonb_build_object('check', 'v3: coluna leads.closed_at', 'ok', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='leads' AND column_name='closed_at')),
    jsonb_build_object('check', 'v3: coluna leads.remarket_at', 'ok', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='leads' AND column_name='remarket_at')),
    jsonb_build_object('check', 'v3: coluna leads.first_msg_sent_at', 'ok', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='leads' AND column_name='first_msg_sent_at')),
    jsonb_build_object('check', 'v3: coluna campaigns.status', 'ok', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='campaigns' AND column_name='status')),
    jsonb_build_object('check', 'v3: coluna campaigns.lead_count', 'ok', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='campaigns' AND column_name='lead_count')),
    jsonb_build_object('check', 'v3: coluna campaigns.success_count', 'ok', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='campaigns' AND column_name='success_count')),
    jsonb_build_object('check', 'v3: coluna campaigns.fail_count', 'ok', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='campaigns' AND column_name='fail_count')),
    -- Migration v4
    jsonb_build_object('check', 'v4: tabela whatsapp_connections', 'ok', EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='whatsapp_connections')),
    jsonb_build_object('check', 'v4: tabela notification_groups', 'ok', EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='notification_groups')),
    jsonb_build_object('check', 'v4: tabela notification_settings', 'ok', EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='notification_settings')),
    -- Migration v5
    jsonb_build_object('check', 'v5: funcao consecom_excluir_leads', 'ok', EXISTS (SELECT 1 FROM information_schema.routines WHERE routine_schema='public' AND routine_name='consecom_excluir_leads')),
    jsonb_build_object('check', 'v5: funcao consecom_cleanup_no_interest', 'ok', EXISTS (SELECT 1 FROM information_schema.routines WHERE routine_schema='public' AND routine_name='consecom_cleanup_no_interest')),
    jsonb_build_object('check', 'v5: funcao set_updated_at', 'ok', EXISTS (SELECT 1 FROM information_schema.routines WHERE routine_schema='public' AND routine_name='set_updated_at')),
    jsonb_build_object('check', 'v5: trigger leads_updated_at', 'ok', EXISTS (SELECT 1 FROM information_schema.triggers WHERE trigger_schema='public' AND trigger_name='leads_updated_at'))
  ] LOOP
    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'check', v_item->>'check',
      'status', CASE WHEN (v_item->>'ok')::boolean THEN 'OK' ELSE 'FALTA' END
    ));
  END LOOP;

  RAISE NOTICE '=== VERIFICAÇÃO DE MIGRATIONS ===';
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_result)
  LOOP
    RAISE NOTICE '%  %', RPAD(v_item->>'status', 6, ' '), v_item->>'check';
  END LOOP;
  RAISE NOTICE '================================';
END $$;

-- RPCs esperadas pelo backend
SELECT
  routine_name AS rpc,
  CASE WHEN routine_name IS NOT NULL THEN 'OK' ELSE 'FALTA' END AS status
FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name IN (
    'consecom_marcar_reuniao',
    'consecom_agent_outcome',
    'consecom_associar_campanha',
    'consecom_fechar_lead',
    'consecom_excluir_leads',
    'consecom_cleanup_no_interest'
  )
ORDER BY routine_name;

-- Storage bucket esperado
SELECT
  id AS bucket,
  CASE WHEN public THEN 'PUBLICO' ELSE 'PRIVADO' END AS acesso
FROM storage.buckets
WHERE id = 'consecom-media';

-- Politicas perigosas (devem NAO existir)
SELECT
  policyname,
  'REMOVER MANUALMENTE SE EXISTIR' AS acao
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'leads'
  AND policyname = 'leads_anon_delete';
