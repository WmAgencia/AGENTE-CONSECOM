-- v7: Realtime para todo o projeto (painel + extensão)
--
-- Adiciona as tabelas usadas pelo painel e pela extensão à publicação
-- supabase_realtime, habilitando postgres_changes em tempo real.
-- Idempotente: só adiciona as tabelas que ainda não estão na publicação.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'leads',
    'campaigns',
    'send_runs',
    'queue_messages',
    'consecom_conversations',
    'capture_sessions',
    'agent_settings',
    'agent_learning',
    'lead_status_history',
    'lead_contacts',
    'strategies',
    'campaign_strategies',
    'objections',
    'experiments',
    'agent_insights',
    'whatsapp_connections',
    'notification_groups',
    'notification_settings'
  ]
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t
    ) AND NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;
