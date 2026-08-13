-- Migration v19: Importados -> Campanhas + histórico de prospecção + conexões por lead.
-- Execute no Supabase SQL Editor.
--
-- O modelo reaproveita leads/capture_sessions/campaigns/send_runs existentes.
-- A extensão deve enviar um access token Supabase válido para que owner_user_id
-- seja preenchido e as novas importações fiquem vinculadas à conta correta.

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS owner_user_id TEXT,
  ADD COLUMN IF NOT EXISTS import_state TEXT NOT NULL DEFAULT 'distributed',
  ADD COLUMN IF NOT EXISTS phone_normalized TEXT,
  ADD COLUMN IF NOT EXISTS imported_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS distributed_at TIMESTAMPTZ;

ALTER TABLE public.leads
  DROP CONSTRAINT IF EXISTS leads_import_state_check;
ALTER TABLE public.leads
  ADD CONSTRAINT leads_import_state_check
  CHECK (import_state IN ('imported', 'distributed', 'blocked'));

UPDATE public.leads
SET import_state = CASE
  WHEN campaign_id IS NULL AND session_id IS NOT NULL THEN 'imported'
  ELSE 'distributed'
END
WHERE import_state = 'distributed';

UPDATE public.leads
SET phone_normalized = CASE
  WHEN regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') LIKE '55%'
    THEN regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g')
  WHEN length(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g')) IN (10, 11)
    THEN '55' || regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g')
  ELSE NULL
END
WHERE phone_normalized IS NULL;

CREATE INDEX IF NOT EXISTS leads_owner_idx ON public.leads (owner_user_id);
CREATE INDEX IF NOT EXISTS leads_import_state_idx ON public.leads (import_state);
CREATE INDEX IF NOT EXISTS leads_phone_normalized_idx ON public.leads (phone_normalized);

ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS owner_user_id TEXT,
  ADD COLUMN IF NOT EXISTS connection_ids UUID[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS campaigns_owner_idx ON public.campaigns (owner_user_id);

ALTER TABLE public.send_runs
  ADD COLUMN IF NOT EXISTS connection_id UUID,
  ADD COLUMN IF NOT EXISTS connection_instance TEXT,
  ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
CREATE INDEX IF NOT EXISTS send_runs_connection_idx ON public.send_runs (connection_id);

-- Distribui atomicamente leads importados, rejeita nova prospecção nos últimos
-- seis meses e grava a conexão escolhida por lead em round-robin.
CREATE OR REPLACE FUNCTION public.consecom_distribute_imported_leads(
  p_lead_ids UUID[],
  p_campaign_id UUID,
  p_connection_ids UUID[] DEFAULT '{}'
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  lead_row RECORD;
  connection_row RECORD;
  idx INTEGER := 0;
  accepted INTEGER := 0;
  blocked INTEGER := 0;
  blocked_ids UUID[] := '{}';
  selected_connection UUID;
  selected_instance TEXT;
  recent_exists BOOLEAN;
BEGIN
  IF COALESCE(array_length(p_lead_ids, 1), 0) = 0 THEN
    RAISE EXCEPTION 'Nenhum lead selecionado';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM campaigns
    WHERE id = p_campaign_id
      AND (owner_user_id IS NULL OR owner_user_id = auth.uid()::TEXT)
  ) THEN
    RAISE EXCEPTION 'Campanha não encontrada';
  END IF;

  FOR lead_row IN
    SELECT * FROM leads
    WHERE id = ANY (p_lead_ids)
      AND import_state = 'imported'
      AND (owner_user_id IS NULL OR owner_user_id = auth.uid()::TEXT)
    FOR UPDATE
  LOOP
    SELECT EXISTS (
      SELECT 1
      FROM send_runs sr
      JOIN leads old_lead ON old_lead.id = sr.lead_id
      WHERE old_lead.phone_normalized IS NOT NULL
        AND old_lead.phone_normalized = lead_row.phone_normalized
        AND sr.created_at >= now() - INTERVAL '6 months'
        AND (sr.last_sent_at IS NOT NULL OR old_lead.first_msg_sent_at IS NOT NULL OR sr.status = 'done')
    ) INTO recent_exists;

    IF recent_exists THEN
      UPDATE leads SET import_state = 'blocked', updated_at = now()
      WHERE id = lead_row.id;
      blocked := blocked + 1;
      blocked_ids := array_append(blocked_ids, lead_row.id);
      CONTINUE;
    END IF;

    selected_connection := NULL;
    selected_instance := NULL;
    IF COALESCE(array_length(p_connection_ids, 1), 0) > 0 THEN
      selected_connection := p_connection_ids[(idx % array_length(p_connection_ids, 1)) + 1];
      SELECT instance_name INTO selected_instance
      FROM whatsapp_connections
      WHERE id = selected_connection
        AND (user_id IS NULL OR user_id = auth.uid()::TEXT);
      IF selected_instance IS NULL THEN
        RAISE EXCEPTION 'Conexão selecionada não encontrada';
      END IF;
    END IF;

    UPDATE leads
    SET campaign_id = p_campaign_id,
        import_state = 'distributed',
        status = 'na_fila',
        distributed_at = now(),
        updated_at = now()
    WHERE id = lead_row.id;

    INSERT INTO send_runs (
      campaign_id, lead_id, status, current_position, next_send_at,
      connection_id, connection_instance, owner_user_id
    ) VALUES (
      p_campaign_id, lead_row.id, 'pending', 0, now(),
      selected_connection, selected_instance, lead_row.owner_user_id
    ) ON CONFLICT (campaign_id, lead_id) DO NOTHING;

    idx := idx + 1;
    accepted := accepted + 1;
  END LOOP;

  UPDATE campaigns
  SET lead_count = (
    SELECT count(*) FROM send_runs WHERE campaign_id = p_campaign_id
  ), updated_at = now()
  WHERE id = p_campaign_id;

  RETURN jsonb_build_object(
    'accepted', accepted,
    'blocked', blocked,
    'blocked_ids', blocked_ids
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.consecom_distribute_imported_leads(UUID[], UUID, UUID[]) TO authenticated;

NOTIFY pgrst, 'reload schema';
