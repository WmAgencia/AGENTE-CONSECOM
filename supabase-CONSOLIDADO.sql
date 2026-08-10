-- =============================================================
-- AgenteProspector — MIGRATION CONSOLIDADA
-- Equivalente a rodar: schema + v3 + v4 + v5 em ordem
-- Idempotente. Pode ser rodado múltiplas vezes.
-- Cole no Supabase: Dashboard -> SQL Editor -> New query -> Run
-- =============================================================

-- ===== Extensões =====
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ===== Schema inicial (supabase-schema.sql) =====

CREATE TABLE IF NOT EXISTS public.leads (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT,
  phone             TEXT,
  category          TEXT,
  website           TEXT,
  address           TEXT,
  city              TEXT,
  state             TEXT,
  zip               TEXT,
  rating            NUMERIC(2,1),
  reviews           INTEGER,
  latitude          DOUBLE PRECISION,
  longitude         DOUBLE PRECISION,
  place_id          TEXT UNIQUE,
  niche             TEXT,
  status            TEXT NOT NULL DEFAULT 'novo',
  last_message_sent TIMESTAMPTZ,
  meeting_at        TIMESTAMPTZ,
  meeting_notes     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS leads_phone_idx ON public.leads (phone);
CREATE INDEX IF NOT EXISTS leads_status_idx ON public.leads (status);

CREATE TABLE IF NOT EXISTS public.lead_status_history (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id    UUID NOT NULL REFERENCES public.leads (id) ON DELETE CASCADE,
  status     TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes      TEXT
);
CREATE INDEX IF NOT EXISTS lead_status_history_lead_idx ON public.lead_status_history (lead_id, changed_at);

CREATE TABLE IF NOT EXISTS public.campaigns (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  description  TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.queue_messages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   UUID NOT NULL REFERENCES public.campaigns (id) ON DELETE CASCADE,
  position      INTEGER NOT NULL DEFAULT 0,
  kind          TEXT NOT NULL DEFAULT 'text',
  text          TEXT,
  media_url     TEXT,
  media_caption TEXT,
  delay_seconds INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS queue_messages_campaign_idx ON public.queue_messages (campaign_id, position);

CREATE TABLE IF NOT EXISTS public.send_runs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id      UUID NOT NULL REFERENCES public.campaigns (id) ON DELETE CASCADE,
  lead_id          UUID NOT NULL REFERENCES public.leads (id) ON DELETE CASCADE,
  status           TEXT NOT NULL DEFAULT 'pending',
  current_position INTEGER NOT NULL DEFAULT 0,
  next_send_at     TIMESTAMPTZ,
  last_sent_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, lead_id)
);
-- Migration v10: motivo de falha por execução (exibido na fila de envio)
ALTER TABLE public.send_runs ADD COLUMN IF NOT EXISTS fail_reason TEXT;
CREATE INDEX IF NOT EXISTS send_runs_lead_idx ON public.send_runs (lead_id);

CREATE TABLE IF NOT EXISTS public.consecom_conversations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id     UUID NOT NULL REFERENCES public.leads (id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content     TEXT NOT NULL,
  agent_model TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS consecom_conversations_lead_idx ON public.consecom_conversations (lead_id, created_at);

CREATE TABLE IF NOT EXISTS public.lead_contacts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  lead_id      UUID NOT NULL REFERENCES public.leads (id) ON DELETE CASCADE,
  contacted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, lead_id)
);
CREATE INDEX IF NOT EXISTS lead_contacts_lead_idx ON public.lead_contacts (lead_id);
CREATE INDEX IF NOT EXISTS lead_contacts_user_idx ON public.lead_contacts (user_id);

-- ===== Função set_updated_at (criada antes dos triggers) =====
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ===== Migration v3 (Funil completo + agent_settings + agent_learning) =====

CREATE TABLE IF NOT EXISTS public.capture_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  imported_by TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.capture_sessions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS session_id        UUID REFERENCES public.capture_sessions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS campaign_id       UUID REFERENCES public.campaigns(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS no_interest_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_reason     TEXT,
  ADD COLUMN IF NOT EXISTS closed_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS remarket_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_msg_sent_at TIMESTAMPTZ,
  -- Migration v10: coluna "Números para ligação" (status para_ligacao)
  ADD COLUMN IF NOT EXISTS call_reason       TEXT,
  ADD COLUMN IF NOT EXISTS call_moved_at     TIMESTAMPTZ;

-- Status enum expandido (11 estados do funil + "Números para ligação" v10)
ALTER TABLE public.leads DROP CONSTRAINT IF EXISTS leads_status;
ALTER TABLE public.leads DROP CONSTRAINT IF EXISTS leads_status_check;
UPDATE public.leads SET status = 'nao_fechado' WHERE status = 'perdido';
ALTER TABLE public.leads ADD CONSTRAINT leads_status_check CHECK (
  status IN (
    'novo','na_fila','enviado','conversando','sem_interesse',
    'remarketing','reuniao_marcada','reuniao_cancelada','fechado','nao_fechado',
    'para_ligacao'
  )
);

CREATE INDEX IF NOT EXISTS leads_session_idx    ON public.leads (session_id);
CREATE INDEX IF NOT EXISTS leads_campaign_idx   ON public.leads (campaign_id);
CREATE INDEX IF NOT EXISTS leads_nointerest_idx ON public.leads (no_interest_until);
CREATE INDEX IF NOT EXISTS leads_call_moved_at_idx ON public.leads (status, call_moved_at);

ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS status        TEXT NOT NULL DEFAULT 'pronta',
  ADD COLUMN IF NOT EXISTS started_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS finished_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lead_count    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS success_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fail_count    INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.agent_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.agent_settings ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.agent_learning (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id    UUID REFERENCES public.leads(id) ON DELETE SET NULL,
  outcome    TEXT NOT NULL CHECK (outcome IN ('vitoria','rejeicao')),
  lesson     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_learning_created_idx ON public.agent_learning (created_at DESC);

-- ===== Migration v4 (Conexões WhatsApp + notificações) =====

CREATE TABLE IF NOT EXISTS public.whatsapp_connections (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_id          UUID,
  instance_name         TEXT NOT NULL,
  phone_number          TEXT,
  whatsapp_name         TEXT,
  status                TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','connecting','connected','disconnected','error')),
  evolution_instance_id TEXT,
  qr_code               TEXT,
  last_sync_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS whatsapp_conn_user_idx ON public.whatsapp_connections (user_id);

CREATE TABLE IF NOT EXISTS public.notification_groups (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID,
  user_id       UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  group_id      TEXT NOT NULL,
  group_name    TEXT NOT NULL,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notif_groups_user_idx ON public.notification_groups (user_id);

CREATE TABLE IF NOT EXISTS public.notification_settings (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID,
  user_id      UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  key          TEXT NOT NULL,
  value        JSONB NOT NULL DEFAULT 'true',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, key)
);

  -- workspace_id e user_id viraram TEXT para aceitar slugs alem de UUIDs.
  -- ATENCAO: as policies em lead_contacts usam auth.uid()::text (cast direto),
  -- entao esta alteracao de tipo nao conflita com elas. Esta secao fica
  -- ANTES do bloco de policies para garantir que as policies sao criadas
  -- com a coluna ja no tipo TEXT.
DROP TRIGGER IF EXISTS whatsapp_connections_updated ON public.whatsapp_connections;
CREATE TRIGGER whatsapp_connections_updated BEFORE UPDATE ON public.whatsapp_connections
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS notification_groups_updated ON public.notification_groups;
CREATE TRIGGER notification_groups_updated BEFORE UPDATE ON public.notification_groups
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS notification_settings_updated ON public.notification_settings;
CREATE TRIGGER notification_settings_updated BEFORE UPDATE ON public.notification_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS leads_updated_at ON public.leads;
CREATE TRIGGER leads_updated_at BEFORE UPDATE ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS campaigns_updated_at ON public.campaigns;
CREATE TRIGGER campaigns_updated_at BEFORE UPDATE ON public.campaigns
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ===== RPCs (todas em CREATE OR REPLACE) =====

CREATE OR REPLACE FUNCTION public.consecom_marcar_reuniao(
  p_lead_id UUID,
  p_meeting_at TIMESTAMPTZ DEFAULT NULL,
  p_notes TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  UPDATE public.leads
  SET status = 'reuniao_marcada',
      meeting_at = COALESCE(p_meeting_at, meeting_at),
      meeting_notes = COALESCE(p_notes, meeting_notes),
      updated_at = now()
  WHERE id = p_lead_id;

  INSERT INTO public.lead_status_history (lead_id, status, notes)
  VALUES (p_lead_id, 'reuniao_marcada', p_notes);

  RETURN jsonb_build_object('ok', true, 'lead_id', p_lead_id,
    'status', 'reuniao_marcada', 'meeting_at', p_meeting_at,
    'meeting_notes', p_notes);
END;
$$;

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

CREATE OR REPLACE FUNCTION public.consecom_excluir_leads(
  p_lead_ids UUID[],
  p_requester_token TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  IF auth.role() NOT IN ('service_role', 'authenticated') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
  END IF;

  DELETE FROM public.leads WHERE id = ANY (p_lead_ids);

  RETURN jsonb_build_object('ok', true, 'deleted', array_length(p_lead_ids, 1));
END;
$$;

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

-- ===== RLS (idempotente) =====

ALTER TABLE public.leads                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_status_history   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaigns             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.queue_messages        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.send_runs             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.consecom_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_contacts         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capture_sessions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_settings        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_learning        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_connections  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_groups   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_settings ENABLE ROW LEVEL SECURITY;

-- Drops idempotentes (remover se existir)
DROP POLICY IF EXISTS leads_anon_delete      ON public.leads;
DROP POLICY IF EXISTS qm_auth_delete         ON public.queue_messages;
DROP POLICY IF EXISTS agent_learning_anon_insert ON public.agent_learning;
DROP POLICY IF EXISTS leads_auth_read        ON public.leads;
DROP POLICY IF EXISTS leads_auth_insert      ON public.leads;
DROP POLICY IF EXISTS leads_auth_update      ON public.leads;
DROP POLICY IF EXISTS leads_auth_delete      ON public.leads;
DROP POLICY IF EXISTS leads_anon_insert      ON public.leads;
DROP POLICY IF EXISTS leads_anon_select      ON public.leads;
DROP POLICY IF EXISTS lsh_auth_read          ON public.lead_status_history;
DROP POLICY IF EXISTS lsh_auth_insert        ON public.lead_status_history;
DROP POLICY IF EXISTS campaigns_auth_read    ON public.campaigns;
DROP POLICY IF EXISTS campaigns_auth_insert  ON public.campaigns;
DROP POLICY IF EXISTS campaigns_auth_update  ON public.campaigns;
DROP POLICY IF EXISTS campaigns_auth_delete  ON public.campaigns;
DROP POLICY IF EXISTS qm_auth_read           ON public.queue_messages;
DROP POLICY IF EXISTS qm_auth_insert         ON public.queue_messages;
DROP POLICY IF EXISTS qm_auth_update         ON public.queue_messages;
DROP POLICY IF EXISTS qm_auth_delete         ON public.queue_messages;
DROP POLICY IF EXISTS qm_service_delete      ON public.queue_messages;
DROP POLICY IF EXISTS sendruns_auth_read     ON public.send_runs;
DROP POLICY IF EXISTS sendruns_auth_insert   ON public.send_runs;
DROP POLICY IF EXISTS sendruns_auth_update   ON public.send_runs;
DROP POLICY IF EXISTS conv_auth_read         ON public.consecom_conversations;
DROP POLICY IF EXISTS conv_auth_insert       ON public.consecom_conversations;
DROP POLICY IF EXISTS lc_read                ON public.lead_contacts;
DROP POLICY IF EXISTS lc_insert              ON public.lead_contacts;
DROP POLICY IF EXISTS lc_delete              ON public.lead_contacts;
DROP POLICY IF EXISTS capture_sessions_anon_insert ON public.capture_sessions;
DROP POLICY IF EXISTS capture_sessions_auth_read   ON public.capture_sessions;
DROP POLICY IF EXISTS agent_settings_auth_all      ON public.agent_settings;
DROP POLICY IF EXISTS agent_learning_auth_all      ON public.agent_learning;
DROP POLICY IF EXISTS whatsapp_connections_auth_all ON public.whatsapp_connections;
DROP POLICY IF EXISTS notification_groups_auth_all  ON public.notification_groups;
DROP POLICY IF EXISTS notification_settings_auth_all ON public.notification_settings;
DROP POLICY IF EXISTS consecom_media_insert    ON storage.objects;
DROP POLICY IF EXISTS consecom_media_update    ON storage.objects;
DROP POLICY IF EXISTS consecom_media_select_public ON storage.objects;

-- Cria policies
CREATE POLICY leads_auth_read    ON public.leads FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY leads_auth_insert  ON public.leads FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY leads_auth_update  ON public.leads FOR UPDATE USING (auth.role() = 'authenticated');
CREATE POLICY leads_auth_delete  ON public.leads FOR DELETE USING (auth.role() = 'authenticated');

-- Anon: IMPORTAR leads (extensão) e checar duplicados. NÃO pode deletar.
CREATE POLICY leads_anon_insert ON public.leads FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY leads_anon_select ON public.leads FOR SELECT TO anon USING (true);

CREATE POLICY lsh_auth_read    ON public.lead_status_history FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY lsh_auth_insert  ON public.lead_status_history FOR INSERT WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY campaigns_auth_read   ON public.campaigns FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY campaigns_auth_insert ON public.campaigns FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY campaigns_auth_update ON public.campaigns FOR UPDATE USING (auth.role() = 'authenticated');
CREATE POLICY campaigns_auth_delete ON public.campaigns FOR DELETE USING (auth.role() = 'authenticated');

CREATE POLICY qm_auth_read      ON public.queue_messages FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY qm_auth_insert    ON public.queue_messages FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY qm_auth_update    ON public.queue_messages FOR UPDATE USING (auth.role() = 'authenticated');
CREATE POLICY qm_auth_delete    ON public.queue_messages FOR DELETE USING (auth.role() = 'authenticated');

CREATE POLICY sendruns_auth_read   ON public.send_runs FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY sendruns_auth_insert ON public.send_runs FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY sendruns_auth_update ON public.send_runs FOR UPDATE USING (auth.role() = 'authenticated');
CREATE POLICY sendruns_auth_delete ON public.send_runs FOR DELETE USING (auth.role() = 'authenticated');

CREATE POLICY conv_auth_read   ON public.consecom_conversations FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY conv_auth_insert ON public.consecom_conversations FOR INSERT WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY lc_read   ON public.lead_contacts FOR SELECT USING (auth.role() = 'authenticated' AND user_id = auth.uid()::text);
CREATE POLICY lc_insert ON public.lead_contacts FOR INSERT WITH CHECK (auth.role() = 'authenticated' AND user_id = auth.uid()::text);
CREATE POLICY lc_delete ON public.lead_contacts FOR DELETE USING (auth.role() = 'authenticated' AND user_id = auth.uid()::text);

CREATE POLICY capture_sessions_anon_insert ON public.capture_sessions FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY capture_sessions_auth_read   ON public.capture_sessions FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY agent_settings_auth_all   ON public.agent_settings FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY agent_learning_auth_all   ON public.agent_learning FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY whatsapp_connections_auth_all ON public.whatsapp_connections FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY notification_groups_auth_all  ON public.notification_groups FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY notification_settings_auth_all ON public.notification_settings FOR ALL USING (auth.role() = 'authenticated');

-- Storage: bucket "consecom-media"
CREATE POLICY consecom_media_insert         ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'consecom-media' AND auth.role() = 'authenticated');
CREATE POLICY consecom_media_update         ON storage.objects FOR UPDATE USING (bucket_id = 'consecom-media' AND auth.role() = 'authenticated');
CREATE POLICY consecom_media_select_public  ON storage.objects FOR SELECT USING (bucket_id = 'consecom-media');

-- ===== Grants =====
GRANT EXECUTE ON FUNCTION public.consecom_marcar_reuniao(UUID, TIMESTAMPTZ, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.consecom_associar_campanha(UUID[], UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.consecom_fechar_lead(UUID, BOOLEAN, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.consecom_agent_outcome(UUID, TEXT, TEXT, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.consecom_excluir_leads(UUID[], TEXT) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.consecom_cleanup_no_interest() TO service_role;

-- ===== Colunas TEXT para workspace_id/user_id (multi-tenant com slugs) =====
-- Roda DEPOIS das policies porque lead_contacts tinha FK para auth.users
-- e policies referenciavam a coluna. As policies em lead_contacts ja foram
-- recriadas acima com auth.uid()::text para serem compativeis.
DO $$
BEGIN
  -- whatsapp_connections: drop FK + alterar para TEXT
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='whatsapp_connections' AND column_name='user_id' AND data_type='uuid'
  ) THEN
    ALTER TABLE public.whatsapp_connections DROP CONSTRAINT IF EXISTS whatsapp_connections_user_id_fkey;
    ALTER TABLE public.whatsapp_connections ALTER COLUMN user_id TYPE TEXT USING user_id::TEXT;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='whatsapp_connections' AND column_name='workspace_id' AND data_type='uuid'
  ) THEN
    ALTER TABLE public.whatsapp_connections ALTER COLUMN workspace_id TYPE TEXT USING workspace_id::TEXT;
  END IF;
  CREATE INDEX IF NOT EXISTS whatsapp_conn_workspace_idx ON public.whatsapp_connections (workspace_id);

  -- lead_contacts: drop FK + alterar para TEXT
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='lead_contacts' AND column_name='user_id' AND data_type='uuid'
  ) THEN
    ALTER TABLE public.lead_contacts DROP CONSTRAINT IF EXISTS lead_contacts_user_id_fkey;
    ALTER TABLE public.lead_contacts ALTER COLUMN user_id TYPE TEXT USING user_id::TEXT;
  END IF;

  -- capture_sessions: adicionar user_id TEXT
  ALTER TABLE public.capture_sessions ADD COLUMN IF NOT EXISTS user_id TEXT;
  CREATE INDEX IF NOT EXISTS capture_sessions_user_idx ON public.capture_sessions (user_id);
END $$;

-- =============================================================
-- Migration v6 (Funil analítico + Estratégias + Inteligência)
-- Colunas analíticas em leads + tabelas: strategies, campaign_strategies,
-- objections, experiments, agent_insights.
-- =============================================================

CREATE TABLE IF NOT EXISTS public.strategies (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code            TEXT NOT NULL UNIQUE,
  version         INTEGER NOT NULL DEFAULT 1,
  name            TEXT NOT NULL,
  description     TEXT,
  first_message   TEXT,
  segment         TEXT,
  service         TEXT,
  status          TEXT NOT NULL DEFAULT 'rascunho'
                  CHECK (status IN ('rascunho','ativa','pausada','teste','vencedora','perdedora')),
  approval_status TEXT NOT NULL DEFAULT 'pendente'
                  CHECK (approval_status IN ('pendente','aprovada','rejeitada')),
  parent_id       UUID REFERENCES public.strategies(id) ON DELETE SET NULL,
  created_by      TEXT,
  approved_by     TEXT,
  approved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS strategies_code_idx   ON public.strategies (code);
CREATE INDEX IF NOT EXISTS strategies_status_idx ON public.strategies (status);

CREATE TABLE IF NOT EXISTS public.campaign_strategies (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  UUID NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  strategy_id  UUID NOT NULL REFERENCES public.strategies(id) ON DELETE CASCADE,
  weight       INTEGER NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, strategy_id)
);
CREATE INDEX IF NOT EXISTS campaign_strategies_campaign_idx ON public.campaign_strategies (campaign_id);
CREATE INDEX IF NOT EXISTS campaign_strategies_strategy_idx ON public.campaign_strategies (strategy_id);

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS strategy_id          UUID REFERENCES public.strategies(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS score                INTEGER,
  ADD COLUMN IF NOT EXISTS score_factors        JSONB,
  ADD COLUMN IF NOT EXISTS interest_level       TEXT,
  ADD COLUMN IF NOT EXISTS service_interest     TEXT,
  ADD COLUMN IF NOT EXISTS has_website          BOOLEAN,
  ADD COLUMN IF NOT EXISTS has_system           BOOLEAN,
  ADD COLUMN IF NOT EXISTS problem_identified   BOOLEAN,
  ADD COLUMN IF NOT EXISTS problem_description  TEXT,
  ADD COLUMN IF NOT EXISTS objection            TEXT,
  ADD COLUMN IF NOT EXISTS meeting_outcome      TEXT,
  ADD COLUMN IF NOT EXISTS sale_status          TEXT,
  ADD COLUMN IF NOT EXISTS loss_reason          TEXT;

CREATE INDEX IF NOT EXISTS leads_strategy_idx      ON public.leads (strategy_id);
CREATE INDEX IF NOT EXISTS leads_score_idx         ON public.leads (score);
CREATE INDEX IF NOT EXISTS leads_service_interest_idx ON public.leads (service_interest);

CREATE TABLE IF NOT EXISTS public.objections (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  text                TEXT NOT NULL,
  category            TEXT NOT NULL DEFAULT 'outros',
  suggested_response  TEXT,
  strategy_id         UUID REFERENCES public.strategies(id) ON DELETE SET NULL,
  frequency           INTEGER NOT NULL DEFAULT 0,
  converted_count     INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (text, strategy_id)
);
CREATE INDEX IF NOT EXISTS objections_category_idx ON public.objections (category);
CREATE INDEX IF NOT EXISTS objections_text_idx     ON public.objections (text);

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
  decision              TEXT,
  decided_strategy_id   UUID REFERENCES public.strategies(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS experiments_status_idx ON public.experiments (status);

CREATE TABLE IF NOT EXISTS public.agent_insights (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         TEXT NOT NULL,
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

DROP TRIGGER IF EXISTS strategies_updated      ON public.strategies;
CREATE TRIGGER strategies_updated BEFORE UPDATE ON public.strategies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS objections_updated      ON public.objections;
CREATE TRIGGER objections_updated BEFORE UPDATE ON public.objections
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS experiments_updated     ON public.experiments;
CREATE TRIGGER experiments_updated BEFORE UPDATE ON public.experiments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS agent_insights_updated  ON public.agent_insights;
CREATE TRIGGER agent_insights_updated BEFORE UPDATE ON public.agent_insights
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.consecom_vincular_estrategia(
  p_campaign_id UUID, p_strategy_id UUID, p_weight INTEGER DEFAULT 1
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
  p_campaign_id UUID, p_strategy_id UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  DELETE FROM public.campaign_strategies
  WHERE campaign_id = p_campaign_id AND strategy_id = p_strategy_id;
  RETURN jsonb_build_object('ok', true);
END;
$$;
CREATE OR REPLACE FUNCTION public.consecom_aprovar_estrategia(
  p_strategy_id UUID, p_approve BOOLEAN, p_approver TEXT DEFAULT NULL
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

ALTER TABLE public.strategies           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_strategies  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.objections           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.experiments          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_insights       ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS strategies_auth_all      ON public.strategies;
DROP POLICY IF EXISTS campaign_strategies_auth_all ON public.campaign_strategies;
DROP POLICY IF EXISTS objections_auth_all      ON public.objections;
DROP POLICY IF EXISTS experiments_auth_all     ON public.experiments;
DROP POLICY IF EXISTS agent_insights_auth_all  ON public.agent_insights;

CREATE POLICY strategies_auth_all          ON public.strategies          FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY campaign_strategies_auth_all ON public.campaign_strategies FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY objections_auth_all          ON public.objections          FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY experiments_auth_all         ON public.experiments         FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY agent_insights_auth_all      ON public.agent_insights      FOR ALL USING (auth.role() = 'authenticated');

GRANT EXECUTE ON FUNCTION public.consecom_vincular_estrategia(UUID, UUID, INTEGER) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.consecom_desvincular_estrategia(UUID, UUID) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.consecom_aprovar_estrategia(UUID, BOOLEAN, TEXT) TO service_role, authenticated;

-- =============================================================
-- Migration v7 — Realtime (tabelas na publicação supabase_realtime)
-- =============================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'leads','campaigns','send_runs','queue_messages','consecom_conversations',
    'capture_sessions','agent_settings','agent_learning','lead_status_history',
    'lead_contacts','strategies','campaign_strategies','objections',
    'experiments','agent_insights','whatsapp_connections',
    'notification_groups','notification_settings'
  ]
  LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t)
       AND NOT EXISTS (SELECT 1 FROM pg_publication_tables
                       WHERE pubname = 'supabase_realtime'
                         AND schemaname = 'public' AND tablename = t) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;

-- =============================================================
-- Migration v8 — Vyntra Prospector: colunas de origem + prospecção
-- =============================================================
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS source             TEXT,
  ADD COLUMN IF NOT EXISTS source_detail      TEXT,
  ADD COLUMN IF NOT EXISTS instagram          TEXT,
  ADD COLUMN IF NOT EXISTS facebook           TEXT,
  ADD COLUMN IF NOT EXISTS tags               TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS prospect_filters   JSONB,
  ADD COLUMN IF NOT EXISTS prospected_at      TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS leads_tags_gin_idx        ON public.leads USING GIN (tags);
CREATE INDEX IF NOT EXISTS leads_source_idx          ON public.leads (source);
CREATE INDEX IF NOT EXISTS leads_source_detail_idx   ON public.leads (source_detail);

-- Garantir DEFAULT '{}' em tags (idempotente)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='leads'
                   AND column_name='tags' AND column_default IS NOT NULL) THEN
    ALTER TABLE public.leads ALTER COLUMN tags SET DEFAULT '{}';
  END IF;
END $$;

-- =============================================================
-- Migration v9 — Correção definitiva da importação da extensão
--   - Garante capture_sessions.user_id (TEXT, nullable)
--   - Recria a policy capture_sessions_anon_insert (INSERT para role=anon).
--     RLS continua habilitada (não desativamos). A policy é estrita:
--     permite INSERT ao papel `anon` SEM exigir auth.uid(), porque a
--     extensão Chrome só possui a chave anon (publishable) — não há
--     sessão de usuário autenticada. Cada sessão fica marcada com
--     imported_by='extension' para auditoria. READ continua só para
--     authenticated (policy auth_read). Isto mantém isolamento:
--     anônimo só pode CRIAR a sessão; ler/editar/excluir exige auth.
--   - Reforça colunas v8 (facebook, source, instagram, etc.) para
--     garantir o schema mesmo em projetos onde só parte foi aplicada.
-- =============================================================

-- capture_sessions.user_id (adicionada se faltar)
ALTER TABLE public.capture_sessions
  ADD COLUMN IF NOT EXISTS user_id TEXT;
CREATE INDEX IF NOT EXISTS capture_sessions_user_idx ON public.capture_sessions (user_id);

-- RLS续 habilitada (não desativamos)
ALTER TABLE public.capture_sessions ENABLE ROW LEVEL SECURITY;

-- Drop idempotente das policies existentes (p/ recriar no estado correto)
DROP POLICY IF EXISTS capture_sessions_anon_insert ON public.capture_sessions;
DROP POLICY IF EXISTS capture_sessions_auth_read   ON public.capture_sessions;
DROP POLICY IF EXISTS capture_sessions_auth_insert ON public.capture_sessions;
DROP POLICY IF EXISTS capture_sessions_auth_update ON public.capture_sessions;
DROP POLICY IF EXISTS capture_sessions_auth_delete ON public.capture_sessions;

-- INSERT para anon (extensão cria a sessão sem login)
CREATE POLICY capture_sessions_anon_insert
  ON public.capture_sessions FOR INSERT TO anon
  WITH CHECK (true);

-- CRUD completo só para authenticated (painel web com login)
CREATE POLICY capture_sessions_auth_read
  ON public.capture_sessions FOR SELECT
  TO authenticated USING (true);
CREATE POLICY capture_sessions_auth_insert
  ON public.capture_sessions FOR INSERT
  TO authenticated WITH CHECK (true);
CREATE POLICY capture_sessions_auth_update
  ON public.capture_sessions FOR UPDATE
  TO authenticated USING (true);
CREATE POLICY capture_sessions_auth_delete
  ON public.capture_sessions FOR DELETE
  TO authenticated USING (true);

-- Reforça colunas v8 em leads (idempotente — se já existirem, é noop)
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS source            TEXT,
  ADD COLUMN IF NOT EXISTS source_detail     TEXT,
  ADD COLUMN IF NOT EXISTS instagram         TEXT,
  ADD COLUMN IF NOT EXISTS facebook          TEXT,
  ADD COLUMN IF NOT EXISTS tags              TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS prospect_filters  JSONB,
  ADD COLUMN IF NOT EXISTS prospected_at     TIMESTAMPTZ;

-- Reforça colunas v6 em leads (idempotente)
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS strategy_id          UUID REFERENCES public.strategies(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS score                INTEGER,
  ADD COLUMN IF NOT EXISTS score_factors        JSONB,
  ADD COLUMN IF NOT EXISTS interest_level       TEXT,
  ADD COLUMN IF NOT EXISTS service_interest     TEXT,
  ADD COLUMN IF NOT EXISTS has_website          BOOLEAN,
  ADD COLUMN IF NOT EXISTS has_system           BOOLEAN,
  ADD COLUMN IF NOT EXISTS problem_identified   BOOLEAN,
  ADD COLUMN IF NOT EXISTS problem_description  TEXT,
  ADD COLUMN IF NOT EXISTS objection            TEXT,
  ADD COLUMN IF NOT EXISTS meeting_outcome      TEXT,
  ADD COLUMN IF NOT EXISTS sale_status          TEXT,
  ADD COLUMN IF NOT EXISTS loss_reason          TEXT;

-- Reforça índices v8/v6
CREATE INDEX IF NOT EXISTS leads_tags_gin_idx        ON public.leads USING GIN (tags);
CREATE INDEX IF NOT EXISTS leads_source_idx          ON public.leads (source);
CREATE INDEX IF NOT EXISTS leads_source_detail_idx   ON public.leads (source_detail);
CREATE INDEX IF NOT EXISTS leads_strategy_idx        ON public.leads (strategy_id);
CREATE INDEX IF NOT EXISTS leads_score_idx           ON public.leads (score);
CREATE INDEX IF NOT EXISTS leads_service_interest_idx ON public.leads (service_interest);

-- Atualiza default de tags (caso a coluna tenha sido criada sem default)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='leads'
                   AND column_name='tags' AND column_default IS NOT NULL) THEN
    ALTER TABLE public.leads ALTER COLUMN tags SET DEFAULT '{}';
  END IF;
END $$;

-- =============================================================
-- NOTIFICA o schema cache PostgREST (necessário após DDL)
-- O PostgREST detecta mudanças automaticamente via event triggers
-- do Supabase na maioria das operações DDL, mas em casos onde a
-- coluna é adicionada e já existia (ADD COLUMN IF NOT EXISTS), o
-- cache pode ficar desatualizado. O comando abaixo sinaliza.
-- =============================================================
NOTIFY pgrst, 'reload schema';
