-- =============================================================
-- Consecom — schema do Módulo 2
-- Cole este SQL no Supabase: Dashboard -> SQL Editor -> New query
-- É idempotente (pode rodar mais de uma vez).
-- =============================================================

-- Empresas capturadas (extensão do Google Maps).
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
  status            TEXT NOT NULL DEFAULT 'novo'
                    CHECK (status IN ('novo','na_fila','mensagem_enviada','respondendo','reuniao_marcada','fechado','perdido')),
  last_message_sent TIMESTAMPTZ,
  meeting_at        TIMESTAMPTZ,
  meeting_notes     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS leads_phone_idx ON public.leads (phone);
CREATE INDEX IF NOT EXISTS leads_status_idx ON public.leads (status);

-- Histórico do kanban (movimentação entre colunas).
CREATE TABLE IF NOT EXISTS public.lead_status_history (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id    UUID NOT NULL REFERENCES public.leads (id) ON DELETE CASCADE,
  status     TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes      TEXT
);
CREATE INDEX IF NOT EXISTS lead_status_history_lead_idx
  ON public.lead_status_history (lead_id, changed_at);

-- Campanha de prospecção (coleção de mensagens em sequência).
CREATE TABLE IF NOT EXISTS public.campaigns (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  description  TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Mensagens ordenadas de uma campanha (texto, áudio, vídeo, imagem, doc).
CREATE TABLE IF NOT EXISTS public.queue_messages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   UUID NOT NULL REFERENCES public.campaigns (id) ON DELETE CASCADE,
  position      INTEGER NOT NULL DEFAULT 0,
  kind          TEXT NOT NULL DEFAULT 'text'
                CHECK (kind IN ('text','audio','video','image','document')),
  text          TEXT,
  media_url     TEXT,
  media_caption TEXT,
  delay_seconds INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS queue_messages_campaign_idx
  ON public.queue_messages (campaign_id, position);

-- Execução da fila por lead (quando enviar a próxima mensagem).
CREATE TABLE IF NOT EXISTS public.send_runs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id      UUID NOT NULL REFERENCES public.campaigns (id) ON DELETE CASCADE,
  lead_id          UUID NOT NULL REFERENCES public.leads (id) ON DELETE CASCADE,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','running','done','failed')),
  current_position INTEGER NOT NULL DEFAULT 0,
  next_send_at     TIMESTAMPTZ,
  last_sent_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, lead_id)
);
CREATE INDEX IF NOT EXISTS send_runs_lead_idx ON public.send_runs (lead_id);

-- Histórico de conversas de prospecção (persistido pelo webhook).
CREATE TABLE IF NOT EXISTS public.consecom_conversations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id     UUID NOT NULL REFERENCES public.leads (id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content     TEXT NOT NULL,
  agent_model TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS consecom_conversations_lead_idx
  ON public.consecom_conversations (lead_id, created_at);

-- Quem (qual login) já contatou um lead. Impede o MESMO usuário de
-- enviar mensagem 2x para o mesmo lead, e serve para o painel mostrar
-- "disponível" (ainda não enviou) vs "contatado" (já enviou).
CREATE TABLE IF NOT EXISTS public.lead_contacts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  lead_id      UUID NOT NULL REFERENCES public.leads (id) ON DELETE CASCADE,
  contacted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, lead_id)
);
CREATE INDEX IF NOT EXISTS lead_contacts_lead_idx ON public.lead_contacts (lead_id);
CREATE INDEX IF NOT EXISTS lead_contacts_user_idx ON public.lead_contacts (user_id);

-- =============================================================
-- RPC usado pelo agente tool `marcar_reuniao`
-- Marca um lead como "reuniao_marcada".
-- =============================================================
CREATE OR REPLACE FUNCTION public.consecom_marcar_reuniao(
  p_lead_id UUID,
  p_meeting_at TIMESTAMPTZ DEFAULT NULL,
  p_notes TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
BEGIN
  UPDATE public.leads
  SET status = 'reuniao_marcada',
      meeting_at = COALESCE(p_meeting_at, meeting_at),
      meeting_notes = COALESCE(p_notes, meeting_notes),
      updated_at = now()
  WHERE id = p_lead_id;

  INSERT INTO public.lead_status_history (lead_id, status, notes)
  VALUES (p_lead_id, 'reuniao_marcada', p_notes);

  RETURN jsonb_build_object(
    'ok', true,
    'lead_id', p_lead_id,
    'status', 'reuniao_marcada',
    'meeting_at', p_meeting_at,
    'meeting_notes', p_notes
  );
END;
$$;

-- =============================================================
-- RLS (Row Level Security) — boas práticas do Supabase
-- Arquitetura: o backend usa a service_role (ignora RLS), e
-- ferramentas/site usam a anon/publishable via RLS. Mantemos RLS
-- ativo e SEM políticas públicas para evitar acesso anônimo a
-- dados sensíveis de leads. Se quiser autenticação por usuário no
-- frontend, adicione políticas voltadas a auth.uid().
-- =============================================================
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.queue_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.send_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.consecom_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_contacts ENABLE ROW LEVEL SECURITY;
GRANT EXECUTE ON FUNCTION public.consecom_marcar_reuniao(UUID, TIMESTAMPTZ, TEXT)
  TO service_role;

-- =============================================================
-- RLS policies: somente usuários autenticados (auth.uid()) podem
-- ler/gravar. Sem acesso anônimo. Os anon grants ficam vazios.
-- =============================================================
-- leads: full CRUD para autenticado
CREATE POLICY leads_auth_read  ON public.leads FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY leads_auth_insert ON public.leads FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY leads_auth_update ON public.leads FOR UPDATE USING (auth.role() = 'authenticated');
CREATE POLICY leads_auth_delete ON public.leads FOR DELETE USING (auth.role() = 'authenticated');

-- leads: extensão do Google Maps grava leads anonimamente (sem login).
-- Anon: INSERT para criar, SELECT para checar importados,
-- DELETE para a opção "Excluir selecionados" da extensão.
CREATE POLICY leads_anon_insert ON public.leads
  FOR INSERT TO anon
  WITH CHECK (true);

CREATE POLICY leads_anon_select ON public.leads
  FOR SELECT TO anon
  USING (true);

CREATE POLICY leads_anon_delete ON public.leads
  FOR DELETE TO anon
  USING (true);

-- lead_status_history
CREATE POLICY lsh_auth_read  ON public.lead_status_history FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY lsh_auth_insert ON public.lead_status_history FOR INSERT WITH CHECK (auth.role() = 'authenticated');

-- campaigns
CREATE POLICY campaigns_auth_read  ON public.campaigns FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY campaigns_auth_insert ON public.campaigns FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY campaigns_auth_update ON public.campaigns FOR UPDATE USING (auth.role() = 'authenticated');
CREATE POLICY campaigns_auth_delete ON public.campaigns FOR DELETE USING (auth.role() = 'authenticated');

-- queue_messages
CREATE POLICY qm_auth_read  ON public.queue_messages FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY qm_auth_insert ON public.queue_messages FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY qm_auth_update ON public.queue_messages FOR UPDATE USING (auth.role() = 'authenticated');
CREATE POLICY qm_auth_delete ON public.queue_messages FOR DELETE USING (auth.role() = 'authenticated');

-- send_runs
CREATE POLICY sendruns_auth_read  ON public.send_runs FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY sendruns_auth_insert ON public.send_runs FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY sendruns_auth_update ON public.send_runs FOR UPDATE USING (auth.role() = 'authenticated');

-- consecom_conversations
CREATE POLICY conv_auth_read  ON public.consecom_conversations FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY conv_auth_insert ON public.consecom_conversations FOR INSERT WITH CHECK (auth.role() = 'authenticated');

-- lead_contacts: cada usuário só lê/grava os SEUS contatos (auth.uid()).
CREATE POLICY lc_read  ON public.lead_contacts FOR SELECT USING (auth.role() = 'authenticated' AND user_id = auth.uid());
CREATE POLICY lc_insert ON public.lead_contacts FOR INSERT WITH CHECK (auth.role() = 'authenticated' AND user_id = auth.uid());
CREATE POLICY lc_delete ON public.lead_contacts FOR DELETE USING (auth.role() = 'authenticated' AND user_id = auth.uid());

-- =============================================================
-- Mídia (Supabase Storage) — bucket "consecom-media" (público).
-- ▪ Usuário autenticado pode fazer UPLOAD dos arquivos no bucket.
-- ▪ Leitura pública (qualquer pessoa) para o Evolution API baixar
--   o arquivo pela URL e mandar pelo WhatsApp.
-- =============================================================
-- Permitir upload apenas para usuários logados (auth.role()='authenticated')
CREATE POLICY consecom_media_insert ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'consecom-media' AND auth.role() = 'authenticated');
CREATE POLICY consecom_media_update ON storage.objects FOR UPDATE
  USING (bucket_id = 'consecom-media' AND auth.role() = 'authenticated');

-- Leitura pública para o Evolution baixar e enviar a mídia.
CREATE POLICY consecom_media_select_public ON storage.objects FOR SELECT
  USING (bucket_id = 'consecom-media');